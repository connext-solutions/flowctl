import { parseArgs } from 'node:util';
import {
  type ProjectSetting,
  cleanupRun,
  COMMANDS,
  ConfigError,
  effectiveConfig,
  FlowError,
  type LoadedConfig,
  loadConfig,
  login,
  requireStore,
  requireTrust,
  RunError,
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
  usageError,
  type Values,
} from './argv.js';
import { waitForLogin } from './login-wait.js';
import { observeCmd } from './observe-cmd.js';
import { replayCmd } from './replay-cmd.js';
import { reconcileCmd } from './reconcile-cmd.js';
import { formatCleanup, terminalSafe } from './summary.js';
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
import {
  destructiveOptions,
  trustAddDestructive,
} from './trust-destructive-add.js';
import { trustAddSystem1 } from './trust-system1.js';
import { trustRotateOwner } from './trust-key.js';
import { trustKeyAdd } from './trust-key-add.js';
import { trustKeyNew } from './trust-key-new.js';
import { trustKeyRevoke } from './trust-key-revoke.js';
import { trustAddProductionOrigin, trustSetProject } from './trust-settings.js';
import { MID_ROTATION, openFor } from './open-store.js';
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

/** The store a `storeOnly` handler was given; the registry guarantees it. */
const storeOf = (c: Ctx): TrustStore => {
  if (c.store === undefined)
    throw new TrustError('trust_missing', 'No trust store was checked.');
  return c.store;
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
  replay: ({ cfg, args, values, trusted }) =>
    replayCmd(cfg, args, values, trusted?.store, write),
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
  cleanup: async (c) => {
    const r = await cleanupRun(c.cfg, c.args[0] ?? '', {
      store: trustedOf(c).store,
    });
    write(
      c.values.json
        ? `${JSON.stringify(r, null, 2)}\n`
        : formatCleanup(c.args[0] ?? '', r),
    );
    return r.leftover.length === 0 && r.tornTail !== true ? 0 : 2;
  },
  observe: ({ cfg, values, trusted }) =>
    observeCmd(cfg, values, trusted?.store, write),
  reconcile: ({ cfg, args, values }) => reconcileCmd(cfg, args, values, write),
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
    trustAddProject(c.cfg, storeOf(c), c.args[0], write);
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
  'trust key new': (c) => {
    trustKeyNew(storeOf(c), c.values, write);
    return 0;
  },
  'trust key add': (c) => {
    trustKeyAdd(storeOf(c), c.args[0] ?? '', c.values, write);
    return 0;
  },
  'trust key revoke': (c) => {
    trustKeyRevoke(storeOf(c), c.args[0] ?? '', c.values, write);
    return 0;
  },
  'trust add destructive': (c) => {
    const o = destructiveOptions(c.values);
    trustAddDestructive(c.cfg, trustedOf(c).store, c.args, o, write);
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
