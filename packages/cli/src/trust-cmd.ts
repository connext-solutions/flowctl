import {
  addProfileEnvVar,
  addProject,
  addTrustedEnv,
  defaultKeyDir,
  displayText,
  type EnvVarKind,
  findFlows,
  FlowError,
  type HookPlan,
  type LoadedConfig,
  loadOwnerKey,
  planHookConsent,
  planProject,
  saveHookConsents,
  TrustError,
  type TrustStore,
} from '@flowctl/core';
import { askEnvClass, envCandidates, projectName } from './trust-init.js';
import { confirmNonce, openTty, type Tty } from './trust-tty.js';

/** Options of `flowctl trust hook`: env names and pins chosen by the owner (ADR 0021 Amendment 2026-11-02 s.9). */
export interface HookOptions {
  env: string[];
  pins: string[];
}

/**
 * `flowctl trust hook <name...>`: shows each flow's hook text and every file its closure binds, then signs a
 * consent for each with the owner key (ADR 0021 Amendment 2026-11-01 section 1, ADR 0025 section 5).
 *
 * @throws {TrustError} `tty_required`, `project_not_trusted`, `confirmation_mismatch`,
 *   `key_unlock_failed`, `trust_entry_invalid`.
 * @throws {FlowError} when no flow matches.
 */
export function trustHook(
  cfg: LoadedConfig,
  store: TrustStore,
  names: string[],
  o: HookOptions,
  out: (s: string) => void,
): void {
  const tty = openTty();
  try {
    const flows = findFlows(cfg.flowsPath, Object.keys(cfg.profiles), {
      names,
    });
    if (flows.length === 0)
      throw new FlowError(`No flows matched in ${cfg.flowsPath}`);
    const pins = parsePins(o.pins);
    const env = [...new Set([...o.env, ...Object.keys(pins)])];
    const plans: HookPlan[] = [];
    for (const flow of flows) {
      if (flow.setup === undefined && flow.teardown === undefined) {
        out(`no hooks ${flow.name}\n`);
        continue;
      }
      const plan = planHookConsent(store, {
        projectDir: cfg.root,
        flowsDir: cfg.flowsPath,
        flow: flow.name,
        setup: flow.setup,
        teardown: flow.teardown,
      });
      show(tty, flow.name, plan, env, pins);
      plans.push(plan);
    }
    if (plans.length === 0) return;
    confirmNonce(tty, `consent to the hooks of ${plans.length} flow(s)`);
    const key = loadOwnerKey(
      defaultKeyDir(),
      tty.ask('Owner-key passphrase: ', { echo: false }),
    );
    const ids = saveHookConsents(
      store,
      key,
      plans.map((plan) => ({ plan, env, pins })),
    );
    for (const id of ids) out(`consented ${id}\n`);
  } finally {
    tty.close();
  }
}

/**
 * `flowctl trust add env <env>`: shows the env's origin from the config as a candidate, asks the owner to type
 * its class, and adds it to the store signed with the owner key (ADR 0025 section 3).
 *
 * @throws {TrustError} `tty_required`, `trust_entry_invalid` (unknown env, no class typed, already in the
 *   store, a contradicting class), `confirmation_mismatch`, `key_unlock_failed`.
 */
export function trustAddEnv(
  cfg: LoadedConfig,
  store: TrustStore,
  name: string,
  out: (s: string) => void,
): void {
  const env = envCandidates(cfg).find((c) => c.name === name);
  if (env === undefined)
    throw new TrustError(
      'trust_entry_invalid',
      `The config has no env "${name}"; add it to flowctl.config.yaml first.`,
    );
  const tty = openTty();
  try {
    const cls = askEnvClass(tty, env);
    if (cls === undefined)
      throw new TrustError(
        'trust_entry_invalid',
        `No class was typed for env "${name}"; nothing was changed.`,
      );
    tty.write(`
env ${name}: ${env.origin} ${cls}
`);
    confirmNonce(tty, `add env ${name} to the trust store`);
    const key = loadOwnerKey(
      defaultKeyDir(),
      tty.ask('Owner-key passphrase: ', { echo: false }),
    );
    addTrustedEnv(store, key, name, { origin: env.origin, class: cls });
    out(`added env ${name} (${cls})\n`);
  } finally {
    tty.close();
  }
}

/**
 * `flowctl trust add profile <profile> <NAME> <secret|username>`: allows one environment variable as a flow
 * `{ env }` input of the profile, after the owner confirms it on the terminal, signed with the owner key (ADR
 * 0025 section 4, issue #41). The store keeps the name and kind only, never the value.
 *
 * @throws {TrustError} `trust_entry_invalid` (unknown profile, a kind other than `secret` or `username`, a name
 *   that is not exact or already allowed), `tty_required`, `confirmation_mismatch`, `key_unlock_failed`.
 */
export function trustAddProfile(
  cfg: LoadedConfig,
  store: TrustStore,
  a: { profile: string; name: string; kind: string },
  out: (s: string) => void,
): void {
  if (!Object.hasOwn(cfg.profiles, a.profile))
    throw new TrustError(
      'trust_entry_invalid',
      `The config has no profile "${a.profile}"; add it to flowctl.config.yaml first.`,
    );
  if (a.kind !== 'secret' && a.kind !== 'username')
    throw new TrustError(
      'trust_entry_invalid',
      `The kind must be secret or username, not "${displayText(a.kind)}".`,
    );
  const kind: EnvVarKind = a.kind;
  const tty = openTty();
  try {
    tty.write(
      `\nprofile ${a.profile}: allow ${displayText(a.name)} (${kind}) as a flow env input. Its value is read from the environment of each run and never stored.\n`,
    );
    confirmNonce(tty, `allow ${a.name} for profile ${a.profile}`);
    const key = loadOwnerKey(
      defaultKeyDir(),
      tty.ask('Owner-key passphrase: ', { echo: false }),
    );
    addProfileEnvVar(store, key, a.profile, { name: a.name, kind });
    out(`allowed ${a.name} (${kind}) for profile ${a.profile}\n`);
  } finally {
    tty.close();
  }
}

/**
 * `flowctl trust add project [<name>]`: registers this checkout (the directory holding the config) and its flows
 * directory in the store, with the root commits computed now as its identity, after the owner confirms them on
 * the terminal (ADR 0025 sections 1 and 3). Also records the identity of an entry that predates it.
 *
 * @param name the project name; default the name `trust init` would give this directory.
 * @throws {TrustError} `trust_entry_invalid`, `identity_unverifiable`, `tty_required`, `confirmation_mismatch`,
 *   `key_unlock_failed`.
 */
export function trustAddProject(
  cfg: LoadedConfig,
  store: TrustStore,
  name: string | undefined,
  out: (s: string) => void,
): void {
  const plan = planProject(store, {
    name: name ?? projectName(cfg.root),
    projectDir: cfg.root,
    flowsDir: cfg.flowsPath,
  });
  const tty = openTty();
  try {
    tty.write(
      displayText(
        `\nproject ${plan.name}${plan.upgrade ? ' (record the identity of the existing entry)' : ''}\nroot:   ${plan.root}\nflows:  ${plan.flows}\nroot commits (identity): ${plan.identity.join(', ')}\n`,
      ),
    );
    confirmNonce(tty, `register project ${plan.name}`);
    const key = loadOwnerKey(
      defaultKeyDir(),
      tty.ask('Owner-key passphrase: ', { echo: false }),
    );
    addProject(store, key, plan);
    out(`registered project ${plan.name} (${plan.root})\n`);
  } finally {
    tty.close();
  }
}

function show(
  tty: Tty,
  flow: string,
  plan: HookPlan,
  env: string[],
  pins: Record<string, string>,
): void {
  const { request: r, closure: c } = plan;
  const lines = [
    `\n=== ${flow} (project ${r.project}, flows root ${r.flowsRoot}) ===`,
    'interpreter: /bin/sh -c    cwd: . (a private copy of the files below)',
  ];
  if (r.setup !== undefined) lines.push(`setup:    ${displayText(r.setup)}`);
  if (r.teardown !== undefined)
    lines.push(`teardown: ${displayText(r.teardown)}`);
  lines.push(`env:      ${env.length === 0 ? '(none)' : env.join(', ')}`);
  for (const [k, v] of Object.entries(pins))
    lines.push(`pin:      ${k}=${displayText(v)}`);
  for (const f of plan.files) {
    const size = Buffer.byteLength(f.text);
    lines.push(`--- file ${f.path} (${f.kind}, ${size} bytes) ---`);
    lines.push(displayText(f.text).replace(/\n$/, ''));
    lines.push(`--- end of ${f.path} ---`);
  }
  if (!c.consentable)
    lines.push(
      'NOT CONSENTABLE: a file cannot be shown in full (a refused byte or over 256 KiB).',
    );
  for (const u of c.uncovered)
    lines.push(`UNCOVERED ${u.reason} in ${u.in}: ${displayText(u.subject)}`);
  if (c.unbound)
    lines.push(
      'Files that uncovered commands read or run are not bound by the digest: they can change after consent without flowctl noticing. A store marked ci refuses this hook.',
    );
  tty.write(`${lines.join('\n')}\n`);
}

function parsePins(pins: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pins) {
    const eq = p.indexOf('=');
    if (eq <= 0)
      throw new TrustError(
        'trust_entry_invalid',
        `--pin needs NAME=VALUE; got a value without a name.`,
      );
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}
