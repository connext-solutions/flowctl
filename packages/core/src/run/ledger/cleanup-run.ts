import { existsSync } from 'node:fs';
import { request } from 'playwright';
import {
  ConfigError,
  type LoadedConfig,
  resolveEnv,
  storageStatePath,
} from '../../config.js';
import { findFlows } from '../../flow/index.js';
import { RunError } from '../../foundation/index.js';
import {
  type ConfirmEntry,
  type CreateConfirm,
  type LedgerLine,
  LedgerFile,
  readConfirmEntries,
  RUN_ID_PATTERN,
  type TrustStore,
} from '../../trust/index.js';
import { confirmReadContext } from '../guards.js';
import { loadState } from '../profiles.js';
import { sessionOrigins } from '../session-state.js';
import {
  CLEANUP_TIMING,
  type CleanupResult,
  type CleanupTarget,
  cleanIds,
  type CleanupTiming,
  type Leftover,
  type Send,
} from './cleanup.js';

/** What a ledger says is still to clean: ids not confirmed deleted, and creates whose answer never came. */
export interface LedgerState {
  targets: { entry: string; id: string; seq: number; name: string }[];
  unconfirmed: { entry: string; name: string }[];
}

/**
 * Reads what is left to clean from a verified ledger's lines: every `id` line without a later `cleanup` line that
 * confirmed it, and every `intent` with neither an `id` nor a `none` line.
 */
export function ledgerState(lines: readonly LedgerLine[]): LedgerState {
  const intents = new Map<number, { entry: string; name: string }>();
  const ids: LedgerState['targets'] = [];
  const answered = new Set<number>();
  const confirmed = new Set<string>();
  for (const l of lines) {
    if (l.kind === 'intent')
      intents.set(l.seq, { entry: l.entry, name: l.name });
    else if (l.kind === 'none') answered.add(l.seq);
    else if (l.kind === 'id') {
      answered.add(l.seq);
      ids.push({
        entry: l.entry,
        id: l.id,
        seq: l.seq,
        name: intents.get(l.seq)?.name ?? '',
      });
    } else if (l.kind === 'cleanup' && l.result === 'confirmed')
      confirmed.add(`${l.entry} ${l.id}`);
  }
  return {
    targets: ids.filter((t) => !confirmed.has(`${t.entry} ${t.id}`)),
    unconfirmed: [...intents]
      .filter(([seq]) => !answered.has(seq))
      .map(([, i]) => i),
  };
}

const isCreate = (e: ConfirmEntry | undefined): e is CreateConfirm =>
  e?.kind === 'create';

/**
 * `flowctl cleanup <run id>` (ADR 0024 section 5 rule 10, amendment 2026-11-12 sections 3, 7 and 8): reads only
 * `<store>/ledgers/<run id>.jsonl` after verifying its chain, removes every id not yet confirmed deleted through the
 * `cleanup` of the stored create entry that minted it, with the session of that entry's flow profile, and appends a
 * `cleanup` line per id. Running it again sends nothing for an id already confirmed. Nothing is ever deleted by name:
 * a create whose answer never came is reported `create_unconfirmed` with its name.
 *
 * @remarks An id whose create entry is no longer valid (revoked, expired, changed) stays leftover (`entry_missing`):
 *   only a signed entry can authorise a cleanup request. The requests are sent from Node with the profile's saved
 *   session (no browser), to the entry's origin only.
 * @throws {ConfigError} when `runId` is not a run id (`r_` and up to 32 lowercase letters or digits).
 * @throws {TrustError} `ledgers_invalid` (with its detail) or `trust_entry_invalid` (no such ledger).
 */
export async function cleanupRun(
  cfg: LoadedConfig,
  runId: string,
  o: { store: TrustStore; timing?: CleanupTiming },
): Promise<CleanupResult> {
  if (!RUN_ID_PATTERN.test(runId))
    throw new ConfigError(
      `"${runId.slice(0, 40)}" is not a run id: it is r_ and 1 to 32 lowercase letters or digits.`,
    );
  const { file, lines } = LedgerFile.open(o.store.dir, runId, null);
  try {
    const state = ledgerState(lines);
    const entries = readConfirmEntries(
      o.store,
      confirmReadContext(cfg),
    ).entries;
    const leftover: Leftover[] = state.unconfirmed.map((u) => ({
      entry: u.entry,
      id: null,
      name: u.name,
      detail: 'create_unconfirmed',
    }));
    const valid: CleanupTarget[] = [];
    for (const t of state.targets) {
      const entry = entries.find((e) => e.id === t.entry);
      if (isCreate(entry)) valid.push({ entry, id: t.id, seq: t.seq });
      else
        leftover.push({
          entry: t.entry,
          id: t.id,
          name: t.name,
          detail: 'entry_missing',
        });
    }
    const nameOf = (entry: string, id: string | null): string | null =>
      state.targets.find((t) => t.entry === entry && t.id === id)?.name ?? null;
    let confirmed = 0;
    for (const key of new Set(
      valid.map((t) => `${t.entry.flow} ${t.entry.env}`),
    )) {
      const group = valid.filter(
        (t) => `${t.entry.flow} ${t.entry.env}` === key,
      );
      const first = group[0];
      if (first === undefined) continue;
      const done = await withSession(cfg, first.entry, (send) =>
        cleanIds(
          group,
          send,
          (t, result) =>
            file.append({
              kind: 'cleanup',
              seq: t.seq,
              entry: t.entry.id,
              id: t.id,
              result,
            }),
          o.timing ?? CLEANUP_TIMING,
        ),
      );
      confirmed += done.confirmed;
      leftover.push(
        ...done.leftover.map((l) => ({ ...l, name: nameOf(l.entry, l.id) })),
      );
    }
    return { confirmed, leftover };
  } finally {
    file.close();
  }
}

/**
 * Runs `work` with a sender that uses the saved session of `entry.flow`'s profile on `entry.env`, limited to the
 * env's origins.
 *
 * @throws {RunError} `profile_expired` when the flow or its session is missing.
 */
async function withSession<T>(
  cfg: LoadedConfig,
  entry: CreateConfirm,
  work: (send: Send) => Promise<T>,
): Promise<T> {
  const env = resolveEnv(cfg, entry.env);
  const [flow] = findFlows(cfg.flowsPath, Object.keys(cfg.profiles), {
    names: [entry.flow],
  });
  const state =
    flow === undefined
      ? undefined
      : storageStatePath(cfg, env.name, flow.profile);
  if (flow === undefined || state === undefined || !existsSync(state))
    throw new RunError(
      'profile_expired',
      `No saved session to clean up the records of flow "${entry.flow}" on env "${env.name}". Run: flowctl login ${flow?.profile ?? '<profile>'} --env ${env.name}, then flowctl cleanup again.`,
    );
  const ctx = await request.newContext({
    baseURL: env.baseUrl,
    storageState: loadState(state, sessionOrigins(cfg, env)),
  });
  const send: Send = async (method, url) => {
    if (new URL(url).origin !== entry.origin) return 'error';
    try {
      const r = await ctx.fetch(url, {
        method,
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      return r.status();
    } catch {
      return 'error';
    }
  };
  try {
    return await work(send);
  } finally {
    await ctx.dispose();
  }
}
