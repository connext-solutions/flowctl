import { parseArgs } from 'node:util';
import {
  type ProjectSetting,
  COMMANDS,
  ConfigError,
  effectiveConfig,
  exitCodeFor,
  FlowError,
  findFlowsWithErrors,
  type LoadedConfig,
  loadConfig,
  login,
  replayMany,
  requireStore,
  requireTrust,
  resolveEnv,
  RunError,
  summarize,
  type Trusted,
  TrustError,
  type TrustStore,
} from '@flowctl/core';
import {
  ARITY,
  isRunnable,
  OPTIONS,
  resolve,
  type Runnable,
  traceMode,
  videoMode,
  usageError,
  type Values,
} from './argv.js';
import { waitForLogin } from './login-wait.js';
import { formatSummary, invalidFlowResult, terminalSafe } from './summary.js';
import {
  trustAddEnv,
  trustAddProfile,
  trustAddProject,
  trustHook,
} from './trust-cmd.js';
import { trustInit } from './trust-init.js';
import { trustReplace } from './trust-replace.js';
import { trustAddOrigin } from './trust-origin.js';
import { trustRevokeDestructive } from './trust-destructive.js';
import { trustAddSystem1 } from './trust-system1.js';
import { trustRotateOwner } from './trust-key.js';
import { trustAddProductionOrigin, trustSetProject } from './trust-settings.js';
import { USAGE } from './usage.js';

export { USAGE } from './usage.js';

/** What the CLI takes from its caller; the bin passes the owner's default store, a test an injected one. */
export interface CliDeps {
  openStore: () => TrustStore | undefined;
}

interface Ctx {
  cfg: LoadedConfig;
  args: string[];
  values: Values;
  trusted: Trusted | undefined;
  /** The store of a `storeOnly` command, which needs no project entry yet. */
  store?: TrustStore;
}

const write = (t: string): void => {
  process.stdout.write(t);
};

/** The trust store a guarded handler was given; the registry guarantees it for every guarded command. */
const trustedOf = (c: Ctx): Trusted => {
  if (c.trusted === undefined)
    throw new TrustError('trust_missing', 'No trust store was checked.');
  return c.trusted;
};

/** The handler of `trust add default-env | language | locale <value>` for this project. */
const setting =
  (field: ProjectSetting['field']) =>
  (c: Ctx): number => {
    const t = trustedOf(c);
    trustSetProject(
      t.store,
      t.project,
      { field, value: c.args[0] ?? '' },
      write,
    );
    return 0;
  };

const HANDLERS: Record<Runnable, (c: Ctx) => Promise<number> | number> = {
  replay: async ({ cfg, args, values, trusted }) => {
    if (values['trust-hooks'])
      process.stderr.write(
        'flowctl: --trust-hooks is ignored: hooks run only with consent in the trust store (flowctl trust hook <name>; ADR 0025 section 5)\n',
      );
    const repeat = Number(values.repeat);
    if (!Number.isInteger(repeat) || repeat < 1)
      throw new ConfigError('--repeat must be a positive integer');
    const { flows, errors } = findFlowsWithErrors(
      cfg.flowsPath,
      Object.keys(cfg.profiles),
      { names: args, tag: values.tag },
    );
    if (flows.length === 0 && errors.length === 0)
      throw new FlowError(`No flows matched in ${cfg.flowsPath}`);
    const env = resolveEnv(cfg, values.env).name;
    const ran =
      flows.length === 0
        ? summarize([])
        : await replayMany(cfg, flows, {
            env: values.env,
            repeat,
            headed: values.headed,
            heal: values.heal,
            store: trusted?.store,
            trace: traceMode(values.trace),
            video: videoMode(values.video),
            acceptHeals: values['accept-heals'],
          });
    const summary = summarize([
      ...ran.results,
      ...errors.map((e) => invalidFlowResult(e, env)),
    ]);
    write(
      values.json
        ? `${JSON.stringify(summary, null, 2)}\n`
        : formatSummary(summary),
    );
    return exitCodeFor(summary);
  },
  login: async ({ cfg, args, values }) => {
    const path = await login(cfg, {
      warn: (m) => process.stderr.write(`flowctl: ${terminalSafe(m)}\n`),
      profile: args[0] ?? '',
      env: values.env,
      waitForUser: waitForLogin,
    });
    process.stderr.write(`Saved session to ${path}\n`);
    return 0;
  },
  'trust init': ({ cfg, values }) => {
    (values.replace ? trustReplace : trustInit)(
      cfg,
      write,
      values['anchor-dir'],
    );
    return 0;
  },
  'trust hook': (c) => {
    trustHook(
      c.cfg,
      trustedOf(c).store,
      c.args,
      { env: c.values['hook-env'] ?? [], pins: c.values.pin ?? [] },
      write,
    );
    return 0;
  },
  'trust add env': (c) => {
    trustAddEnv(c.cfg, trustedOf(c).store, c.args[0] ?? '', write);
    return 0;
  },
  'trust add default-env': setting('defaultEnv'),
  'trust add language': setting('language'),
  'trust add locale': setting('locale'),
  'trust add production-origin': (c) => {
    trustAddProductionOrigin(trustedOf(c).store, c.args[0] ?? '', write);
    return 0;
  },
  'trust add project': (c) => {
    if (c.store === undefined)
      throw new TrustError('trust_missing', 'No trust store was checked.');
    trustAddProject(c.cfg, c.store, c.args[0], write);
    return 0;
  },
  'trust add origin': (c) => {
    trustAddOrigin(trustedOf(c).store, c.args, write);
    return 0;
  },
  'trust add system1': (c) => {
    trustAddSystem1(trustedOf(c).store, c.args, write);
    return 0;
  },
  'trust key rotate-owner': () => {
    trustRotateOwner(write);
    return 0;
  },
  'trust revoke destructive': (c) => {
    trustRevokeDestructive(c.cfg, trustedOf(c).store, c.args[0] ?? '', write);
    return 0;
  },
  'trust add profile': (c) => {
    const [profile = '', name = '', kind = ''] = c.args;
    trustAddProfile(c.cfg, trustedOf(c).store, { profile, name, kind }, write);
    return 0;
  },
};

const MID_ROTATION = Symbol('mid-rotation');

/**
 * The store a guarded command checks. `trust key rotate-owner` is how a store left between the steps of a rotation is
 * finished or rolled back, so for it alone `rotate_incomplete` means "a store exists" and the handler recovers it.
 *
 * @throws {TrustError} whatever opening the store throws, `rotate_incomplete` for every other command.
 */
function openFor(
  name: Runnable,
  deps: CliDeps,
): TrustStore | undefined | typeof MID_ROTATION {
  try {
    return deps.openStore();
  } catch (e) {
    if (
      name === 'trust key rotate-owner' &&
      e instanceof TrustError &&
      e.kind === 'rotate_incomplete'
    )
      return MID_ROTATION;
    throw e;
  }
}

/**
 * Parses `argv`, checks the trust store for a guarded command (ADR 0025 section 3), runs the command and
 * returns its exit code. `--help` is the only command handled before parsing.
 *
 * @remarks The guard runs after the config is read (a read-only step) and before anything else, so a guarded
 *   command without a store touches no file.
 */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: OPTIONS,
    });
  } catch (e) {
    process.stderr.write(
      `flowctl: ${e instanceof Error ? e.message : String(e)}\n${USAGE}\n`,
    );
    return 2;
  }
  const { values, positionals } = parsed;
  const { name, args } = resolve(positionals);
  if (!isRunnable(name) || !ARITY[name](args.length))
    return usageError(name, positionals);
  try {
    let cfg = loadConfig(values.config);
    const command: { guarded: boolean; storeOnly?: true } = COMMANDS[name];
    const opened = command.guarded ? openFor(name, deps) : undefined;
    let store: TrustStore | undefined;
    let trusted: Trusted | undefined;
    if (opened === MID_ROTATION) store = undefined;
    else if (command.storeOnly === true) store = requireStore(opened);
    else if (command.guarded)
      trusted = requireTrust(opened, {
        projectDir: cfg.root,
        flowsDir: cfg.flowsPath,
      });
    if (trusted !== undefined) {
      const effective = effectiveConfig(cfg, trusted);
      for (const w of effective.warnings)
        process.stderr.write(`flowctl: warning: ${w}\n`);
      cfg = effective.cfg;
    }
    return await HANDLERS[name]({ cfg, args, values, trusted, store });
  } catch (e) {
    if (e instanceof TrustError) {
      process.stderr.write(`flowctl: ${e.kind}: ${e.message}\n`);
      return e.kind === 'passphrase_too_short' ? 2 : 3;
    }
    if (e instanceof RunError) {
      process.stderr.write(
        `flowctl: ${e.kind}: ${terminalSafe(e.message, Infinity)}\n`,
      );
      return 2;
    }
    if (e instanceof ConfigError || e instanceof FlowError) {
      process.stderr.write(`flowctl: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}
