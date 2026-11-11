import type { LoadedConfig, ResolvedEnv } from '../config.js';
import type { Flow } from '../flow/index.js';
import { RunError } from '../foundation/index.js';
import {
  isLoopback,
  LedgerFile,
  openTrustStore,
  planConfirm,
  readConfirmEntries,
  TrustError,
  trustedEnv,
  type TrustStore,
} from '../trust/index.js';
import {
  confirmInputFor,
  confirmReadContext,
  RunLedger,
} from './ledger/index.js';
import { RequestGuard, type RequestClass } from './request-guard.js';
import { scopeFor } from './scope-for.js';
import { ScopeGuard } from './scope-guard.js';

const hostOf = (origin: string): string | undefined => {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
};

/**
 * The class the guards use for `origin`: `production` when the store lists a production origin on the same
 * host (any scheme or port, ADR 0024 section 2); else the store's class for an env on exactly this origin;
 * else `local` for loopback and `unknown` otherwise.
 *
 * @remarks Only the matching entries are verified, so one bad entry for another env does not stop every
 *   run. The default store is opened only for a non-loopback origin, so tests on a local fixture never
 *   read the owner's store.
 * @throws {TrustError} `trust_tampered` when a matching entry is not owner-signed.
 */
export function envClassFor(
  origin: string,
  store: TrustStore | undefined,
): RequestClass {
  const s = store ?? (isLoopback(origin) ? undefined : openTrustStore());
  if (s !== undefined) {
    const host = hostOf(origin);
    for (const [p, entry] of Object.entries(s.data.productionOrigins))
      if (hostOf(p) === host) {
        s.assertSigned(
          { id: p, kind: 'productionOrigins', value: {} },
          entry.sig,
        );
        return 'production';
      }
    for (const [name, e] of Object.entries(s.data.envs))
      if (e.origin === origin) {
        const verified = trustedEnv(s, name);
        if (verified !== undefined) return verified.class;
      }
  }
  return isLoopback(origin) ? 'local' : 'unknown';
}

export { confirmReadContext } from './ledger/index.js';

/** The run a guard is built for: its id (the ledger's file name) and its `{{uid}}` once prepared. */
export interface GuardRun {
  id: string;
  uid: () => string | undefined;
}

/**
 * The scope guard of a run of `flow` on `env` ({@link scopeFor}), with its request layer: the caller's
 * (`opts.writes`, an exploration's), else the replay layer of {@link RequestGuard.forReplay} for the env's class,
 * which on a `shared` env keeps a run ledger when stored confirmations apply ({@link startLedger}).
 *
 * @throws {RunError} `scope_violation` when the trust store cannot be read for the production hosts, the env's class
 *   or the confirmations; `ledger_exists` when the run's ledger file exists already.
 */
export function guardFor(
  cfg: LoadedConfig,
  env: ResolvedEnv,
  flow: Flow,
  opts: { store?: TrustStore; writes?: RequestGuard },
  run: GuardRun,
): ScopeGuard {
  try {
    const cls = envClassFor(new URL(env.baseUrl).origin, opts.store);
    const writes =
      opts.writes ??
      RequestGuard.forReplay(cls, flow.name, cfg.target.destructiveWords);
    const scope = scopeFor(cfg, env, opts.store ?? 'default');
    if (opts.writes === undefined && cls === 'shared')
      startLedger(cfg, env, flow, writes, opts.store ?? openTrustStore(), run);
    return new ScopeGuard(scope, writes);
  } catch (e) {
    if (!(e instanceof TrustError)) throw e;
    throw new RunError(
      'scope_violation',
      `The trust store refused the run's scope (${e.kind}${e.detail === undefined ? '' : `: ${e.detail}`}): ${e.message}`,
    );
  }
}

/**
 * Gives a replay on a `shared` env its run ledger when the store holds valid `destructiveConfirm` entries for this
 * env and flow whose `hash` is the flow's current confirmation digest (ADR 0024 section 5). Entries for an older
 * version of the flow authorise nothing; the guard's hint then says the flow changed.
 *
 * @remarks The guard's class comes from the origin, the entries from the env's name, so both must agree: the store
 *   must class the env itself `shared`. An env the store classes otherwise (or does not list) gets no ledger, even on
 *   the origin of a shared env, so its writes stay refused.
 *
 * @throws {RunError} `ledger_exists` from creating the ledger file.
 * @throws {TrustError} `ledgers_invalid`, `trust_tampered` from the store.
 */
function startLedger(
  cfg: LoadedConfig,
  env: ResolvedEnv,
  flow: Flow,
  guard: RequestGuard,
  store: TrustStore | undefined,
  run: GuardRun,
): void {
  if (store === undefined || trustedEnv(store, env.name)?.class !== 'shared')
    return;
  const mine = readConfirmEntries(
    store,
    confirmReadContext(cfg),
  ).entries.filter((e) => e.env === env.name && e.flow === flow.name);
  if (mine.length === 0) return;
  const digest = planConfirm(confirmInputFor(cfg, flow, env)).digest;
  const entries = mine.filter((e) => digest !== '' && e.hash === digest);
  if (entries.length === 0) {
    guard.staleConfirmations();
    return;
  }
  guard.useLedger(
    new RunLedger({
      entries,
      file: LedgerFile.create(store.dir, run.id, null),
      uid: run.uid,
      refuse: (method, url, why) => guard.refuseWrite(method, url, why),
    }),
  );
}
