import { existsSync, readFileSync } from 'node:fs';
import type { Browser, BrowserContext, Page } from 'playwright';
import {
  storageStatePath,
  type LoadedConfig,
  type ResolvedEnv,
} from '../config.js';
import type { Step } from '../flow/index.js';
import { assertNotSymlink } from '../safe-fs.js';
import { limitContext, RUN_CONTEXT } from './context-limits.js';
import type { Evidence } from './evidence.js';
import { RunError, errorMessage } from './outcome.js';
import type { ScopeGuard } from './scope-guard.js';
import {
  filterState,
  sessionOrigins,
  type StorageState,
} from './session-state.js';

/**
 * The profile's saved session limited to `origins` (issue #50): a session saved before the filter existed, or edited
 * by hand, still never logs a run in at another origin.
 *
 * @throws {RunError} `profile_expired` when the file is not a storage state; log in again.
 */
function loadState(path: string, origins: readonly string[]): StorageState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    parsed = undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('cookies' in parsed) ||
    !Array.isArray(parsed.cookies) ||
    !('origins' in parsed) ||
    !Array.isArray(parsed.origins)
  )
    throw new RunError(
      'profile_expired',
      `The saved session ${path} is not a browser session; log in again with flowctl login.`,
    );
  const state: StorageState = {
    cookies: parsed.cookies.filter(isCookie),
    origins: parsed.origins.filter(isOriginState),
  };
  return filterState(state, origins).state;
}

const isCookie = (c: unknown): c is StorageState['cookies'][number] =>
  typeof c === 'object' &&
  c !== null &&
  'domain' in c &&
  typeof c.domain === 'string' &&
  'name' in c &&
  typeof c.name === 'string';

const isOriginState = (o: unknown): o is StorageState['origins'][number] =>
  typeof o === 'object' &&
  o !== null &&
  'origin' in o &&
  typeof o.origin === 'string' &&
  'localStorage' in o &&
  Array.isArray(o.localStorage);

interface ProfileContext {
  context: BrowserContext;
  page: Page;
}

const VIEWPORT = { width: 1280, height: 800 };

/**
 * The browser contexts of one run, one per profile, and which one is active.
 *
 * @remarks Internal to {@link RunSession}; nothing else opens, switches or closes a run's contexts.
 */
export class Profiles {
  private readonly contexts = new Map<string, ProfileContext>();
  private active: string | undefined;
  private guard: ScopeGuard | undefined;
  private narrated = 0;

  constructor(
    private readonly cfg: LoadedConfig,
    private readonly env: ResolvedEnv,
    private readonly browser: Browser,
    private readonly evidence: Evidence,
  ) {}

  /** Sets the scope every context opened from now on is held to; {@link RunSession.begin} calls it first. */
  useGuard(guard: ScopeGuard): void {
    this.guard = guard;
  }

  /**
   * Page of the active profile.
   *
   * @throws {Error} before a profile was opened.
   */
  get page(): Page {
    const current = this.activePage;
    if (current === undefined) {
      throw new Error('RunSession has no active profile; call begin() first');
    }
    return current;
  }

  /** Page of the active profile, or `undefined` before one is open (used when finishing a run). */
  get activePage(): Page | undefined {
    return this.active === undefined
      ? undefined
      : this.contexts.get(this.active)?.page;
  }

  /** Every open profile context, for evidence collection at the end of the run. */
  get all(): [string, ProfileContext][] {
    return [...this.contexts.entries()];
  }

  /**
   * Makes `profile` active, then opens `url` unless it reuses an already open context and `url`
   * is undefined. A new context comes from the profile's saved session; with no `url` it opens
   * `start`.
   *
   * @remarks The scope guard and then evidence are attached to a new context before its first navigation, so the
   *   initial load is held to the run's scope (ADR 0024 section 3) and its requests and console errors are captured
   *   (ADR 0010). Every run context is created with {@link RUN_CONTEXT} (no service worker, no download kept) and
   *   limited by {@link limitContext} (no WebRTC, cancelled downloads noted and judged).
   * @throws {RunError} `profile_expired` when no session is saved for this env/profile, or
   *   `app_unreachable` / `profile_expired` from {@link goto}.
   */
  async switchTo(
    profile: string,
    url: string | undefined,
    start: string,
  ): Promise<void> {
    if (this.contexts.has(profile)) {
      this.active = profile;
      if (url !== undefined) await this.goto(url);
      return;
    }
    const state = storageStatePath(this.cfg, this.env.name, profile);
    assertNotSymlink(state);
    if (!existsSync(state)) {
      throw new RunError(
        'profile_expired',
        `No saved session for profile "${profile}" in env "${this.env.name}". Run: flowctl login ${profile} --env ${this.env.name}`,
      );
    }
    const context = await this.browser.newContext({
      baseURL: this.env.baseUrl,
      storageState: loadState(state, sessionOrigins(this.cfg, this.env)),
      locale: this.cfg.profiles[profile]?.locale,
      viewport: VIEWPORT,
      ...RUN_CONTEXT,
      ...this.evidence.video?.contextOptions(),
    });
    const guard = this.guard;
    await guard?.attach(context);
    await this.evidence.attach(context, profile);
    await limitContext(
      context,
      profile,
      (e) => this.evidence.network.push(e),
      guard === undefined ? undefined : (u) => void guard.detect(u, 'visit'),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(this.cfg.stepTimeout);
    page.setDefaultNavigationTimeout(this.cfg.navigationTimeout);
    this.contexts.set(profile, { context, page });
    this.active = profile;
    if (this.guard !== undefined && !(await this.guard.hold(page)))
      this.guard.assertClean();
    await this.goto(url ?? start);
  }

  /**
   * Navigates the active page to `url` (relative to the env's `baseUrl`).
   *
   * @remarks The target must be on the env's origin over http(s): `file:`, `javascript:` or another host are
   *   refused before the browser is asked (issue #45). Every navigation of a run goes through here: the start
   *   page, `goto` and `as.goto`, in replay and in exploration.
   * @throws {RunError} `flow_invalid` for a target outside the env's origin, `scope_violation` for one the run's
   *   scope refuses (a denied path, a path outside `allow`), `app_unreachable` when
   *   navigation fails, `profile_expired` when the app redirects to the env's `loginUrl`.
   */
  async goto(url: string): Promise<void> {
    const origin = new URL(this.env.baseUrl).origin;
    let target: URL | undefined;
    try {
      target = new URL(url, this.env.baseUrl);
    } catch {
      target = undefined;
    }
    if (target?.origin !== origin)
      throw new RunError(
        'flow_invalid',
        `Refused to open "${url}": flowctl navigates only inside ${origin}, the env's baseUrl. Use a path starting with /.`,
      );
    if (this.guard !== undefined && !this.guard.allows(target.href, 'visit')) {
      this.guard.assertClean();
      throw new RunError(
        'scope_violation',
        `Refused to open ${target.pathname}: it is outside the run's scope.`,
      );
    }
    try {
      await this.page.goto(url);
    } catch (e) {
      throw new RunError(
        'app_unreachable',
        `Cannot open ${this.env.baseUrl}${url}: ${errorMessage(e).split('\n')[0] ?? ''}`,
      );
    }
    const loginUrl = this.env.loginUrl;
    if (
      loginUrl !== undefined &&
      new URL(this.page.url()).pathname.startsWith(loginUrl)
    ) {
      throw new RunError(
        'profile_expired',
        `Profile "${this.active ?? '?'}" was redirected to ${loginUrl}. Run: flowctl login ${this.active ?? '<profile>'} --env ${this.env.name}`,
      );
    }
  }

  /** Shows `step` in the demo video's overlay before it runs (ADR 0032); nothing without a video. */
  async narrate(step: Step): Promise<void> {
    const page = this.activePage;
    if (this.evidence.video === undefined || page === undefined) return;
    this.narrated++;
    await this.evidence.video.step(
      page,
      step,
      this.narrated,
      this.cfg.testIdAttribute,
    );
  }

  /**
   * Closes the page of every context, so a pending browser call on it rejects at once; the contexts stay open for
   * evidence. The wall-clock budget calls it when it runs out.
   */
  async closePages(): Promise<void> {
    await Promise.allSettled(
      [...this.contexts.values()].map((c) => c.page.close()),
    );
  }

  /**
   * Closes every context of the run, even when one fails to close; call once, from `RunSession.finish`.
   *
   * @throws the first close error, after all contexts were tried.
   */
  async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const c of this.contexts.values())
      await c.context.close().catch((e: unknown) => errors.push(e));
    await this.evidence.video
      ?.save([...this.contexts].map(([p, c]) => [p, c.page]))
      .catch((e: unknown) => errors.push(e));
    if (errors.length > 0) throw errors[0];
  }
}
