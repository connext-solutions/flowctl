import dayjs from 'dayjs';
import { type LoadedConfig, resolveEnv } from '../../config.js';
import { findFlows, type Flow } from '../../flow/index.js';
import {
  type ConfirmDigestInput,
  type ConfirmEntry,
  type ConfirmFile,
  confirmFiles,
  type ConfirmPlan,
  type Draft,
  type EntryBase,
  latestExpiry,
  planConfirm,
  proposeDrafts,
  type RecordedWrite,
  recordedWrites,
  storedConfirmEntries,
  TrustError,
  trustedEnv,
  type TrustStore,
  utcDate,
} from '../../trust/index.js';
import { confirmInputFor } from './context.js';
import { readRecordedRun } from './recorded.js';

/** Everything `flowctl trust add destructive` shows the owner before it asks a question. */
export interface DestructivePlan {
  flow: Flow;
  env: { name: string; origin: string; class: string };
  input: ConfirmDigestInput;
  plan: ConfirmPlan;
  /** The flow file first, then every file the digest binds, each with its text. */
  files: ConfirmFile[];
  run: { id: string; env: string; origin: string };
  writes: RecordedWrite[];
  skipped: { request: string; why: string }[];
  drafts: Draft[];
  base: EntryBase;
  /** The entries of this flow and env stored now, which the new ones replace. */
  previous: ConfirmEntry[];
}

const refuse = (why: string): TrustError =>
  new TrustError('trust_entry_invalid', `${why}; nothing was written.`);

/**
 * `days` as the life of new or renewed entries: a whole number from 1 to 90, 30 when left out.
 *
 * @throws {TrustError} `trust_entry_invalid` otherwise (`--days abc` reaches here as `NaN`).
 */
function daysOf(days: number | undefined): number {
  const d = days ?? 30;
  if (!Number.isInteger(d) || d < 1 || d > 90)
    throw refuse('--days is a whole number from 1 to 90');
  return d;
}

/** The store's verified env `name`, or a refusal. */
function envOf(
  store: TrustStore,
  name: string,
): { origin: string; class: string } {
  const e = trustedEnv(store, name);
  if (e === undefined) throw refuse(`The trust store has no env "${name}"`);
  return e;
}

/** The one flow named `name` in the flows directory. */
function flowNamed(cfg: LoadedConfig, name: string): Flow {
  const [flow] = findFlows(cfg.flowsPath, Object.keys(cfg.profiles), {
    names: [name],
  });
  if (flow === undefined)
    throw refuse(`There is no flow "${name}" in ${cfg.flowsPath}`);
  return flow;
}

/** The current confirmation digest of `flow` on `env`, `''` when it is unconfirmable. */
export function currentDigest(
  cfg: LoadedConfig,
  flow: string,
  env: string,
): string {
  return planConfirm(
    confirmInputFor(cfg, flowNamed(cfg, flow), resolveEnv(cfg, env)),
  ).digest;
}

/**
 * Plans `flowctl trust add destructive <flow> --env <env> --from-run <run id>` (ADR 0024 section 5 and the
 * amendment 2026-11-13): the flow's digest on `env` and the files it binds, the writes of the recorded run (a passed
 * run of the same flow on an env the store classes `local`) and the proposed drafts.
 *
 * @param days the life of the new entries, 1 to 90 (default 30).
 * @throws {TrustError} `trust_entry_invalid` for `days` outside 1 to 90, an unknown env or flow, an env classed neither `shared` nor `local`,
 *   an unconfirmable flow (each reason listed), a recorded run of another flow, not on a `local` env or not passed,
 *   a bound file that is not UTF-8 text or changed while it was read, or a recording with no write.
 * @throws {ConfigError} when the run's evidence cannot be read.
 */
export function planDestructive(
  cfg: LoadedConfig,
  store: TrustStore,
  o: { flow: string; env: string; fromRun: string; days?: number; now?: Date },
): DestructivePlan {
  const days = daysOf(o.days);
  const flow = flowNamed(cfg, o.flow);
  const env = resolveEnv(cfg, o.env);
  const target = envOf(store, env.name);
  if (target.class !== 'shared' && target.class !== 'local')
    throw refuse(
      `Env "${env.name}" is classed ${target.class}; no destructive confirmation exists there`,
    );
  const input = confirmInputFor(cfg, flow, env);
  const plan = planConfirm(input);
  if (plan.refusals.length > 0)
    throw refuse(
      `Flow "${flow.name}" is unconfirmable: ${plan.refusals.join('; ')}`,
    );
  const files = confirmFiles(input, plan);
  const expected =
    1 +
    new Set(
      [
        ...plan.files,
        ...(plan.hooks.setup?.files ?? []),
        ...(plan.hooks.teardown?.files ?? []),
      ].map((f) => f.path),
    ).size;
  if (files.length !== expected)
    throw refuse(
      'A file the confirmation binds changed while it was read; run the command again',
    );
  const binary = files.find((f) => f.text === undefined);
  if (binary !== undefined)
    throw refuse(
      `${binary.path} is not UTF-8 text, so it cannot be shown or confirmed`,
    );
  const run = readRecordedRun(cfg, o.fromRun);
  if (run.flow !== flow.name)
    throw refuse(
      `Run ${o.fromRun} is a run of "${run.flow}", not of "${flow.name}"`,
    );
  const recordedOn = envOf(store, run.env);
  if (recordedOn.class !== 'local')
    throw refuse(
      `Run ${o.fromRun} ran on env "${run.env}", classed ${recordedOn.class}; entries are derived from a run on a local env`,
    );
  if (run.status !== 'passed')
    throw refuse(
      `Run ${o.fromRun} did not pass (${run.status}); record a passing run first`,
    );
  const { writes, skipped } = recordedWrites(run.calls, recordedOn.origin);
  if (writes.length === 0)
    throw refuse(`Run ${o.fromRun} sent no write to ${recordedOn.origin}`);
  const now = o.now ?? new Date();
  const expires = utcDate(dayjs(now).add(days * 24, 'hour'));
  return {
    flow,
    env: { name: env.name, ...target },
    input,
    plan,
    files,
    run: { id: o.fromRun, env: run.env, origin: recordedOn.origin },
    writes,
    skipped,
    drafts: proposeDrafts(writes, flow.name),
    base: {
      env: env.name,
      origin: target.origin,
      expires: expires > latestExpiry(now) ? latestExpiry(now) : expires,
      flow: flow.name,
      hash: plan.digest,
    },
    previous: storedConfirmEntries(store).filter(
      (e) => e.flow === flow.name && e.env === env.name,
    ),
  };
}

/** One entry a renewal rewrites, before and after. */
export interface Renewal {
  old: ConfirmEntry;
  next: ConfirmEntry;
}

/**
 * Plans `--renew <id>...` (a new `expires`) or `--renew-env <env>` (the store's current origin of the env and a new
 * `expires` for every entry of it on another origin), ADR 0024 amendment 2026-11-12 section 9: only for entries whose
 * flow's current confirmation digest still equals their `hash`.
 *
 * @throws {TrustError} `trust_entry_invalid` for an id the store does not hold, an env with no entry to re-bind or
 *   `days` outside 1 to 90; `renew_digest_changed` naming the entries whose flow changed (nothing is renewed then).
 */
export function planRenew(
  cfg: LoadedConfig,
  store: TrustStore,
  o: { ids?: readonly string[]; env?: string; days?: number; now?: Date },
): Renewal[] {
  const days = daysOf(o.days);
  const stored = storedConfirmEntries(store);
  const now = o.now ?? new Date();
  const expires = utcDate(dayjs(now).add(days * 24, 'hour'));
  let picked: ConfirmEntry[];
  let origin: string | undefined;
  if (o.env !== undefined) {
    origin = envOf(store, o.env).origin;
    picked = stored.filter((e) => e.env === o.env && e.origin !== origin);
    if (picked.length === 0)
      throw refuse(
        `No entry of env "${o.env}" is bound to another origin than ${origin}`,
      );
  } else {
    picked = (o.ids ?? []).map((id) => {
      const e = stored.find((s) => s.id === id);
      if (e === undefined)
        throw refuse(`The trust store has no destructiveConfirm entry "${id}"`);
      return e;
    });
  }
  const changed = picked
    .filter((e) => currentDigest(cfg, e.flow, e.env) !== e.hash)
    .map((e) => e.id);
  if (changed.length > 0)
    throw new TrustError(
      'renew_digest_changed',
      `The flow of ${changed.join(', ')} changed since it was confirmed, so it cannot be renewed; confirm it again with flowctl trust add destructive <flow> --env <env> --from-run <run id>. Nothing was written.`,
    );
  return picked.map((old) => ({
    old,
    next: { ...old, expires, ...(origin === undefined ? {} : { origin }) },
  }));
}
