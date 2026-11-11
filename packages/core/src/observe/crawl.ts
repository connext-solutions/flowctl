import dayjs from 'dayjs';
import { chromium, type Browser } from 'playwright';
import { ConfigError, resolveEnv, type LoadedConfig } from '../config.js';
import { envClassFor } from '../explore/index.js';
import { FlowError, type Flow } from '../flow/index.js';
import type { RunResult } from '../result.js';
import {
  RequestGuard,
  RunError,
  RunSession,
  scopeFor,
  toOutcome,
  type Outcome,
} from '../run/index.js';
import type { TrustStore } from '../trust/index.js';
import { PageBudget, type CrawlBudget } from './budget.js';
import { Capture } from './capture.js';
import { loginPath, type LinkRules } from './links.js';
import {
  AppMapSchema,
  PAGE_PATH,
  type AppMap,
  type AppPage,
} from './schema.js';
import { walk } from './walk.js';

/** What {@link observe} takes besides the config. */
export interface ObserveOptions {
  /** The env to crawl; the config's trusted default when left out. */
  env?: string;
  /** The caller's browser; the crawl opens one context in it, through `RunSession`. A headless Chromium when left out. */
  browser?: Browser;
  /** The profile whose saved session the crawl uses; the first profile of the config when left out. */
  profile?: string;
  /** The path the crawl starts at; the path of the env's `baseUrl` when left out. */
  start?: string;
  /** The trust store the run's scope and env class are read from; the owner's default store unless a test injects one. */
  store?: TrustStore;
}

/**
 * What one crawl produced: the map, the run that observed it (its `steps` is the number of pages), where
 * `appmap.json` was written, and what it spent.
 */
export interface Observation {
  map: AppMap;
  run: RunResult;
  file: string;
  budget: CrawlBudget;
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

/** A crawl checked and ready to open: the env, the profile, the start path, the login path and the request layer. */
interface Plan {
  env: ReturnType<typeof resolveEnv>;
  profile: string;
  start: string;
  login: string | undefined;
  writes: RequestGuard;
}

/**
 * Checks what a crawl needs before any browser starts.
 *
 * @throws {ConfigError} for an unknown env, or a `loginUrl` that does not resolve against its `baseUrl`.
 * @throws {RunError} `env_not_trusted` for an env the trust store refused; `scope_violation` for an env the store
 *   classes `production`: a crawl never runs there until the read-only production replay of ADR 0024 section 2a
 *   exists, whose rules (`GET` only, signed path templates) are stricter than the crawl's request layer.
 * @throws {FlowError} for an unknown profile or a start that is not a path.
 * @throws {TrustError} `trust_tampered` when the store entry for the env's origin is not owner-signed.
 */
function plan(cfg: LoadedConfig, opts: ObserveOptions): Plan {
  const env = resolveEnv(cfg, opts.env);
  const profile = opts.profile ?? Object.keys(cfg.profiles)[0] ?? '';
  if (!Object.hasOwn(cfg.profiles, profile))
    throw new FlowError(`unknown profile "${profile}"`);
  const origin = new URL(env.baseUrl).origin;
  const start = opts.start ?? new URL(env.baseUrl).pathname;
  if (!PAGE_PATH.test(start))
    throw new FlowError(
      `start must be a path on ${origin} such as /home, not ${JSON.stringify(start)}`,
    );
  const envClass = envClassFor(origin, opts.store);
  if (envClass === 'production')
    throw new RunError(
      'scope_violation',
      `flowctl observe never crawls a production env (${env.name}): read-only production replay (ADR 0024 section 2a) is not built. Crawl a local or shared env.`,
    );
  let login: string | undefined;
  try {
    login = loginPath(env.loginUrl, env.baseUrl);
  } catch {
    throw new ConfigError(
      `The loginUrl of env "${env.name}" is not a URL on ${origin}; use a path such as /login.`,
    );
  }
  const writes = RequestGuard.forCrawl(envClass, cfg.target.destructiveWords);
  return { env, profile, start, login, writes };
}

/**
 * Crawls the env breadth-first from its start page and returns the {@link AppMap} (roadmap section 3.2, task T2.2):
 * no model, no click, no typing, no form submit. Each page is read once (document status, title, snapshot controls,
 * forms with their field model, same-origin links, and the fetch/xhr calls and console errors seen while it was
 * open), and its links are queued in sorted order, so the same app gives the same map.
 *
 * @remarks The crawl is one `RunSession` with one context: the run's scope guard holds every request, and its request
 *   layer is {@link RequestGuard.forCrawl}, so nothing but reads leaves the browser on any env and every WebSocket is
 *   closed; a request stopped before it was sent is recorded on its page (`refused`) instead of ending the crawl, one
 *   detected only after it was sent ends it. Not guarded: a side-effecting `GET` whose path holds no destructive word,
 *   and an action in a query (a GraphQL mutation in a `GET`). A link is followed only when it stays in the
 *   `visit` scope, is not the login page, opens in the same window, and neither its label nor its path looks
 *   destructive (ADR 0024 section 5). It stops at the page budget ({@link PageBudget}) or the run's wall-clock
 *   budget; either way `truncated` is true. `appmap.json` is written into the run directory, validated against
 *   {@link AppMapSchema}. Without `opts.browser` a headless Chromium is launched once the checks pass, and closed.
 * @throws {ConfigError} for an unknown env or a `loginUrl` that is not a URL.
 * @throws {RunError} `env_not_trusted` for an env the trust store refused, `scope_violation` for a production env,
 *   `internal` when the map could not be written (the run is still finished).
 * @throws {FlowError} for an unknown profile or a start that is not a path.
 * @throws {TrustError} `trust_tampered` when the store entry for the env's origin is not owner-signed.
 * @see docs/adr/0033-read-only-crawl.md
 */
export async function observe(
  cfg: LoadedConfig,
  opts: ObserveOptions,
): Promise<Observation> {
  const p = plan(cfg, opts);
  if (opts.browser !== undefined) return crawlIn(cfg, opts, p, opts.browser);
  const browser = await chromium.launch();
  try {
    return await crawlIn(cfg, opts, p, browser);
  } finally {
    await browser.close();
  }
}

/** {@link observe} in `browser`; the run is finished whatever happens. */
async function crawlIn(
  cfg: LoadedConfig,
  opts: ObserveOptions,
  p: Plan,
  browser: Browser,
): Promise<Observation> {
  const { writes, start } = p;
  const run = RunSession.open(cfg, crawlFlow(p.profile, start), {
    env: p.env.name,
    browser,
    store: opts.store,
    writes,
  });
  const rules: LinkRules = {
    scope: scopeFor(cfg, p.env, opts.store ?? 'default'),
    loginUrl: p.login,
    words: cfg.target.destructiveWords,
  };
  const pages: AppPage[] = [];
  const budget = new PageBudget(cfg);
  let outcome: Outcome = { status: 'passed' };
  let complete = false;
  try {
    await run.begin();
    const capture = new Capture(
      run.evidence,
      run.secrets,
      rules.scope.envOrigin,
    );
    complete = await walk(
      { run, rules, writes, capture, profile: p.profile },
      start,
      budget,
      pages,
    );
  } catch (e) {
    outcome = toOutcome(e);
  }
  let written: { map: AppMap; file: string } | undefined;
  try {
    const map = AppMapSchema.parse({
      v: 1,
      origin: rules.scope.envOrigin,
      observedAt: dayjs().toISOString(),
      truncated: !complete,
      pages,
    });
    written = {
      map,
      file: run.evidence.artefact(
        'appmap.json',
        `${JSON.stringify(map, null, 2)}\n`,
      ),
    };
  } catch (e) {
    outcome = toOutcome(e);
  }
  const result = await run.finish(outcome, pages.length);
  if (written === undefined)
    throw new RunError(
      'internal',
      `The crawl's map could not be written: ${result.error?.hint ?? 'unknown'}. The run is in ${result.evidence.dir}.`,
    );
  return { ...written, run: result, budget: budget.report(result) };
}
