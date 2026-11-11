import dayjs from 'dayjs';
import type { Browser } from 'playwright';
import { BUDGET_CEILINGS } from '../config/index.js';
import { resolveEnv, type LoadedConfig } from '../config.js';
import { envClassFor } from '../explore/index.js';
import { FlowError, type Flow } from '../flow/index.js';
import type { RunResult } from '../result.js';
import {
  RequestGuard,
  RunSession,
  scopeFor,
  toOutcome,
  type Outcome,
} from '../run/index.js';
import type { TrustStore } from '../trust/index.js';
import { Capture } from './capture.js';
import type { LinkRules } from './links.js';
import { AppMapSchema, type AppMap, type AppPage } from './schema.js';
import { walk } from './walk.js';

/** What {@link observe} takes besides the config. */
export interface ObserveOptions {
  /** The env to crawl; the config's trusted default when left out. */
  env?: string;
  /** The caller's browser; the crawl opens one context in it, through `RunSession`. */
  browser: Browser;
  /** The profile whose saved session the crawl uses; the first profile of the config when left out. */
  profile?: string;
  /** The path the crawl starts at; the path of the env's `baseUrl` when left out. */
  start?: string;
  /** The trust store the run's scope and env class are read from; the owner's default store unless a test injects one. */
  store?: TrustStore;
}

/** What one crawl produced: the map, the run that observed it, and where `appmap.json` was written. */
export interface Observation {
  map: AppMap;
  run: RunResult;
  file: string;
}

/** The flow-less run of a crawl: the profile and start page, no steps, no assertions. */
const crawlFlow = (profile: string, start: string): Flow => ({
  name: 'observe',
  goal: `Observe the app from ${start}`,
  tags: [],
  profile,
  start,
  inputs: {},
  steps: [],
  assertions: [],
  file: '',
  parsedSteps: [],
});

const PATH = /^\/(?!\/)[^?#\s]*$/;

/** The page budget of a crawl: `target.budgets.pages`, at most the built-in ceiling (ADR 0024 section 6). */
export const pageBudget = (cfg: LoadedConfig): number =>
  Math.min(
    cfg.target.budgets.pages ?? BUDGET_CEILINGS.pages,
    BUDGET_CEILINGS.pages,
  );

/**
 * Crawls the env breadth-first from its start page and returns the {@link AppMap} (roadmap section 3.2, task T2.2):
 * no model, no click, no typing, no form submit. Each page is read once (document status, title, snapshot controls,
 * forms with their field model, same-origin links, and the fetch/xhr calls and console errors seen while it was
 * open), and its links are queued in sorted order, so the same app gives the same map.
 *
 * @remarks The crawl is one `RunSession` with one context: the run's scope guard holds every request, and its request
 *   layer is {@link RequestGuard.forCrawl}, so nothing but reads leaves the browser on any env, and a refused request
 *   is recorded on its page (`refused`) instead of ending the crawl. A link is followed only when it stays in the
 *   `visit` scope, is not the login page, opens in the same window, and neither its label nor its path looks
 *   destructive (ADR 0024 section 5). It stops at the page budget ({@link pageBudget}) or the run's wall-clock
 *   budget; either way `truncated` is true. `appmap.json` is written into the run directory, validated against
 *   {@link AppMapSchema}.
 * @throws {ConfigError} for an unknown env.
 * @throws {RunError} `env_not_trusted` for an env the trust store refused.
 * @throws {FlowError} for an unknown profile or a start that is not a path.
 * @see docs/adr/0033-read-only-crawl.md
 */
export async function observe(
  cfg: LoadedConfig,
  opts: ObserveOptions,
): Promise<Observation> {
  const env = resolveEnv(cfg, opts.env);
  const profile = opts.profile ?? Object.keys(cfg.profiles)[0] ?? '';
  if (!Object.hasOwn(cfg.profiles, profile))
    throw new FlowError(`unknown profile "${profile}"`);
  const origin = new URL(env.baseUrl).origin;
  const start = opts.start ?? new URL(env.baseUrl).pathname;
  if (!PATH.test(start))
    throw new FlowError(
      `start must be a path on ${origin} such as /home, not ${JSON.stringify(start)}`,
    );
  const words = cfg.target.destructiveWords;
  const writes = RequestGuard.forCrawl(envClassFor(origin, opts.store), words);
  const run = RunSession.open(cfg, crawlFlow(profile, start), {
    env: env.name,
    browser: opts.browser,
    store: opts.store,
    writes,
  });
  const rules: LinkRules = {
    scope: scopeFor(cfg, env, opts.store ?? 'default'),
    loginUrl: env.loginUrl,
    words,
  };
  const pages: AppPage[] = [];
  let outcome: Outcome = { status: 'passed' };
  let complete = false;
  try {
    await run.begin();
    const capture = new Capture(run.evidence, run.secrets);
    complete = await walk(
      { run, rules, writes, capture },
      start,
      pageBudget(cfg),
      pages,
    );
  } catch (e) {
    outcome = toOutcome(e);
  }
  const map = AppMapSchema.parse({
    v: 1,
    origin,
    observedAt: dayjs().toISOString(),
    truncated: !complete,
    pages,
  });
  const file = run.evidence.artefact(
    'appmap.json',
    `${JSON.stringify(map, null, 2)}\n`,
  );
  return { map, run: await run.finish(outcome, pages.length), file };
}
