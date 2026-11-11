import type { BrowserContext } from 'playwright';
import type { LoadedConfig, ResolvedEnv } from '../config.js';

/** A Playwright storage state: what `flowctl login` saves for a profile and a run loads into its context. */
export type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * The origins a profile's session may hold data for: the env's own origin and the origins the trust store lets a
 * run on that env visit or call (ADR 0024 sections 3 and 4).
 */
export function sessionOrigins(cfg: LoadedConfig, env: ResolvedEnv): string[] {
  const own = new URL(env.baseUrl).origin;
  const sets = cfg.trustView?.scopes?.[env.name];
  return [...new Set([own, ...(sets?.visit ?? []), ...(sets?.call ?? [])])];
}

const hostOf = (origin: string): string | undefined => {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

const IP = /^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:.]+\])$/i;

/**
 * Whether a cookie for `domain` (Playwright's form: a leading `.` for a `Domain` cookie, none for a host-only one)
 * is sent to `host`: a host-only cookie only to the exact host, a `Domain` cookie by RFC 6265 domain-match (the host
 * itself or a subdomain of it, never for an IP address), never a naive suffix (`evil-example.com` is not
 * `example.com`).
 */
export function cookieMatches(domain: string, host: string): boolean {
  const d = domain.toLowerCase();
  if (!d.startsWith('.')) return d === host;
  const base = d.slice(1);
  return host === base || (!IP.test(host) && host.endsWith(`.${base}`));
}

/**
 * `state` with only the cookies and storage entries that belong to `origins`, and what was dropped: the cookie
 * domains and the storage origins, never a value (ADR 0024 section 4, issue #50).
 *
 * @remarks A session saved while the login passed through an identity provider, or another env, keeps only the
 *   env's own data, so a run on one env is never logged in at another origin.
 */
export function filterState(
  state: StorageState,
  origins: readonly string[],
): { state: StorageState; dropped: string[] } {
  const hosts = origins.flatMap((o) => hostOf(o) ?? []);
  const keep = new Set(origins);
  const dropped = new Set<string>();
  const cookies = state.cookies.filter((c) => {
    const ok = hosts.some((h) => cookieMatches(c.domain, h));
    if (!ok) dropped.add(`cookie domain ${c.domain}`);
    return ok;
  });
  const kept = state.origins.filter((o) => {
    const ok = keep.has(o.origin);
    if (!ok) dropped.add(`storage of ${o.origin}`);
    return ok;
  });
  return { state: { cookies, origins: kept }, dropped: [...dropped] };
}
