import type { ErrorKind, RunResult } from '../../result.js';
import { clip } from './strings.js';
import type { FailedCall } from './subject.js';
import type { ClassEvidence, ClassifyLimits, RuleHit } from './types.js';

/**
 * Error kinds that say the run never measured the app: infrastructure (the app, the login, System 1, a setup hook,
 * the wall-clock budget) or this machine's set-up of flowctl (trust store, allowed envs, hook consent, a leftover
 * ledger file). The others (`flow_invalid`, `scope_violation`, `destructive_blocked`, `ledger_replay`,
 * `ledger_mismatch`, `ledger_overflow`, `internal`) are not classed: each can be the app, the flow or flowctl.
 */
export const ENVIRONMENT_KINDS: ReadonlySet<ErrorKind> = new Set<ErrorKind>([
  'app_unreachable',
  'profile_expired',
  'setup_failed',
  'system1_unreachable',
  'system1_not_allowed',
  'budget_exceeded',
  'env_not_trusted',
  'env_not_allowed',
  'hooks_untrusted',
  'ledger_exists',
]);

/** Statuses a gateway or proxy answers when the app behind it is down or slow. */
const GATEWAY: ReadonlySet<number> = new Set([502, 503, 504]);

/** Rule `error-kind`: an errored run whose kind is in {@link ENVIRONMENT_KINDS} is `environment`, high. */
export function errorKindRule(
  result: RunResult,
  limits: ClassifyLimits,
): RuleHit | null {
  const e = result.error;
  if (
    result.status !== 'error' ||
    e === undefined ||
    !ENVIRONMENT_KINDS.has(e.kind)
  )
    return null;
  return {
    rule: 'error-kind',
    class: 'environment',
    confidence: 'high',
    why: 'the run ended with an infrastructure or set-up error kind, so it never measured the app',
    evidence: [
      { source: 'run', pointer: '/error/kind', text: e.kind },
      {
        source: 'run',
        pointer: '/error/hint',
        text: clip(e.hint, limits.maxEvidenceText),
      },
    ],
  };
}

const callEvidence = (
  calls: readonly FailedCall[],
  limits: ClassifyLimits,
): ClassEvidence[] =>
  calls.slice(0, limits.maxEvidencePerSource).map((c) => ({
    source: 'run',
    pointer: c.pointer,
    text: clip(`${c.status} ${c.method} ${c.url}`, limits.maxEvidenceText),
  }));

/**
 * The network rules over the failed calls of a failed run: `gateway-status` (502, 503 or 504 on any origin:
 * `environment`, medium), `no-response` (status 0: `environment`, low), `server-error` (another 5xx on one of the
 * app's origins: `product_bug`, medium; low when no origin is known) and `foreign-server-error` (another 5xx on an
 * origin that is not the app's: `environment`, low).
 */
export function networkRules(
  calls: readonly FailedCall[],
  origins: readonly string[] | null,
  limits: ClassifyLimits,
): RuleHit[] {
  const hits: RuleHit[] = [];
  const push = (
    rule: RuleHit['rule'],
    cls: RuleHit['class'],
    confidence: RuleHit['confidence'],
    why: string,
    list: FailedCall[],
  ) => {
    if (list.length > 0)
      hits.push({
        rule,
        class: cls,
        confidence,
        why,
        evidence: callEvidence(list, limits),
      });
  };
  const server = calls.filter(
    (c) => c.status >= 500 && c.status <= 599 && !GATEWAY.has(c.status),
  );
  const own = (c: FailedCall) =>
    origins === null || (c.origin !== null && origins.includes(c.origin));
  push(
    'gateway-status',
    'environment',
    'medium',
    'a call got a gateway status (502, 503 or 504): the app or its proxy was down or slow',
    calls.filter((c) => GATEWAY.has(c.status)),
  );
  push(
    'no-response',
    'environment',
    'low',
    'a call got no response (status 0): the network or the app dropped it, or the page cancelled it',
    calls.filter((c) => c.status === 0),
  );
  push(
    'server-error',
    'product_bug',
    origins === null ? 'low' : 'medium',
    origins === null
      ? 'a call got a server error (5xx); the app origin is not known'
      : 'a call to the app origin got a server error (5xx)',
    server.filter(own),
  );
  push(
    'foreign-server-error',
    'environment',
    'low',
    'a call to an origin that is not the app got a server error (5xx)',
    server.filter((c) => !own(c)),
  );
  return hits;
}
