import type { ErrorKind, RunResult } from '../../result.js';
import { clip } from './strings.js';
import type { FailedCall } from './subject.js';
import type { ClassEvidence, ClassifyLimits, RuleHit } from './types.js';

/**
 * How the `error-kind` rule classes each error kind; a `Record` over `ErrorKind`, so a new kind fails the typecheck
 * until it is classed here.
 *
 * - `high`: the run never measured the app: infrastructure (the app, the login, System 1, a setup hook) or this
 *   machine's set-up of flowctl (trust store, allowed envs, hook consent, a leftover ledger file).
 * - `low`: `budget_exceeded`, the wall-clock budget ran out: often the environment, but a slow or hanging app is also
 *   possible.
 * - `null`: not classed, because each can be the app, the flow or flowctl.
 */
const KIND_CLASS: Record<ErrorKind, 'high' | 'low' | null> = {
  app_unreachable: 'high',
  profile_expired: 'high',
  setup_failed: 'high',
  system1_unreachable: 'high',
  system1_not_allowed: 'high',
  env_not_trusted: 'high',
  env_not_allowed: 'high',
  hooks_untrusted: 'high',
  ledger_exists: 'high',
  budget_exceeded: 'low',
  flow_invalid: null,
  scope_violation: null,
  destructive_blocked: null,
  ledger_replay: null,
  ledger_mismatch: null,
  ledger_overflow: null,
  internal: null,
};

/** Statuses a gateway or proxy answers when the app behind it is down or slow. */
const GATEWAY: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * Rule `error-kind`: an errored run whose kind {@link KIND_CLASS} classes is `environment`, at that confidence.
 */
export function errorKindRule(
  result: RunResult,
  limits: ClassifyLimits,
): RuleHit | null {
  const e = result.error;
  if (result.status !== 'error' || e === undefined) return null;
  const confidence = Object.hasOwn(KIND_CLASS, e.kind)
    ? KIND_CLASS[e.kind]
    : null;
  if (confidence === null) return null;
  return {
    rule: 'error-kind',
    class: 'environment',
    confidence,
    why:
      confidence === 'high'
        ? 'the run ended with an infrastructure or set-up error kind, so it never measured the app'
        : 'the run ran out of its wall-clock budget: the environment was slow, or the app was slow or hanging',
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
