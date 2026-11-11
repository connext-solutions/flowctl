import type { Browser } from 'playwright';
import type { TraceMode } from '../result.js';
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
  /** The request layer of the destructive-action guard, put to every request of the run (exploration sets it). */
  writes?: RequestGuard;
  /** How much the Playwright trace records: `safe` (the default) or `full` (ADR 0030). */
  trace?: TraceMode;
  /** Record a demo video per profile with a step overlay (ADR 0032); refused for a flow with secret inputs. */
  video?: boolean;
}
