import { dirname, join } from 'node:path';
import { chromium, type Page } from 'playwright';
import {
  ConfigError,
  resolveEnv,
  storageStatePath,
  type LoadedConfig,
} from './config.js';
import { filterState, sessionOrigins } from './run/index.js';
import { ensureDirInside, writeFileNoFollow } from './safe-fs.js';

export interface LoginOptions {
  profile: string;
  env?: string;
  headless?: boolean;
  /** Resolves when the human (or a test) has finished logging in on `page`. */
  waitForUser: (page: Page) => Promise<void>;
  /** Told what the saved session left out (cookie domains and storage origins of other sites, never a value). */
  warn?: (message: string) => void;
}

/**
 * Opens a browser at the env's login page, lets the user log in by hand, and saves the session as
 * the profile's storageState. Credentials never pass through flowctl.
 *
 * @remarks Nothing is saved when the last page the user saw is on another origin than the env's (an identity
 *   provider, another env), or on the env's origin under its `loginUrl`: the window was closed (or Enter pressed)
 *   before the login came back to the app. The session keeps only the cookies and storage of the env's origins
 *   ({@link filterState}, ADR 0024 section 4, issue #50); what it drops is passed to `warn`.
 * @throws {ConfigError} for an unknown profile or env, or when the user never left the login page.
 * @see docs/adr/0011-login-via-profiles.md
 */
export async function login(
  cfg: LoadedConfig,
  o: LoginOptions,
): Promise<string> {
  if (!Object.hasOwn(cfg.profiles, o.profile)) {
    throw new ConfigError(
      `Unknown profile "${o.profile}"; known: ${Object.keys(cfg.profiles).join(', ')}`,
    );
  }
  const env = resolveEnv(cfg, o.env);
  const browser = await chromium.launch({ headless: o.headless ?? false });
  try {
    const context = await browser.newContext({
      baseURL: env.baseUrl,
      locale: cfg.profiles[o.profile]?.locale,
    });
    const page = await context.newPage();
    let lastUrl = '';
    page.on('framenavigated', (f) => {
      if (f === page.mainFrame()) lastUrl = f.url();
    });
    await page.goto(env.loginUrl ?? '/');
    await o.waitForUser(page);
    const origins = sessionOrigins(cfg, env);
    const last = new URL(lastUrl || env.baseUrl, env.baseUrl);
    const loginPath =
      env.loginUrl === undefined
        ? undefined
        : new URL(env.loginUrl, env.baseUrl).pathname;
    if (
      !origins.includes(last.origin) ||
      (loginPath !== undefined && last.pathname.startsWith(loginPath))
    ) {
      throw new ConfigError(
        `The browser was still on the login page (${last.origin}${last.pathname}); nothing was saved. Log in first, then close the window once the app shows.`,
      );
    }
    const path = storageStatePath(cfg, env.name, o.profile);
    const auth = join(cfg.flowsPath, '.auth');
    ensureDirInside(auth, cfg.flowsPath, { mode: 0o700, gitignoreAll: true });
    ensureDirInside(dirname(path), cfg.flowsPath, { mode: 0o700 });
    const { state, dropped } = filterState(
      await context.storageState(),
      origins,
    );
    if (dropped.length > 0)
      o.warn?.(
        `The session keeps only ${origins.join(', ')}; left out: ${dropped.join('; ')}.`,
      );
    writeFileNoFollow(path, JSON.stringify(state, null, 2), 0o600);
    return path;
  } finally {
    await browser.close();
  }
}
