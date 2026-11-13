import type { Browser } from 'playwright';
import type { RunProvenance, TraceMode } from '../result.js';
import type { TrustStore } from '../trust/index.js';
import type { RequestGuard } from './request-guard.js';

/** What `RunSession.open` takes besides the config and the flow. */
export interface RunSessionOptions {
  /** The env to run on; the config's trusted default when left out. */
  env?: string;
  /** The caller's browser; the run opens one context per profile in it. */
  browser: Browser;
  /**
   * The trust store hook consent and the env-input allowlist are read from: the owner's default store unless a test
   * injects one (ADR 0025 section 1). There is no option that skips consent.
   */
  store?: TrustStore;
  /**
   * The request layer of the destructive-action guard, put to every request of the run (an exploration sets its
   * own); left out, the run gets the stricter replay layer (`RequestGuard.forReplay`) for its env's class.
   */
  writes?: RequestGuard;
  /** How much the Playwright trace records: `safe` (the default) or `full` (ADR 0030). */
  trace?: TraceMode;
  /** Record a demo video per profile with a step overlay (ADR 0032); refused for a flow with secret inputs. */
  video?: boolean;
  /**
   * The provenance label of the flow, computed by the caller (`replay.ts`) and only carried here: `run/` sits below
   * `provenance/` and never classifies. It goes to the result and `run.json` and never changes the verdict (ADR 0004,
   * ADR 0020 section h). Required, so a new caller cannot forget it.
   */
  provenance: RunProvenance;
}

/**
 * The label of a run that has no flow file to classify (an exploration draft, a crawl): `unclassified`, which no
 * store entry can change. A fixed value, so these callers state it instead of leaving the option out.
 */
export const DRAFT_PROVENANCE: RunProvenance = {
  state: 'unclassified',
  notes: ['freshness_not_checked', 'rollback_not_checked'],
};
