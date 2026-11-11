import {
  destructiveRequest,
  destructiveWord,
  inScope,
  type Scope,
} from '../browser/index.js';
import { PAGE_PATH } from './schema.js';

/** A link as the page script reads it: the resolved `href`, its `target`, whether it downloads, and its label. */
export interface RawLink {
  href: string;
  target: string;
  download: boolean;
  name: string;
}

/** What a crawl may follow: the env's scope, the login path it must never open, and the repo's destructive words. */
export interface LinkRules {
  scope: Scope;
  loginUrl: string | undefined;
  words: readonly string[];
}

/** The links of one page: every same-origin path it offers, and the ones the crawl may open. */
export interface PageLinks {
  links: string[];
  follow: string[];
}

/** Targets that navigate the page the link is on; any other opens a new window, which a crawl never does. */
const SAME_WINDOW = new Set(['', '_self', '_top', '_parent']);

/**
 * The path of `href` when it is an http(s) URL on `origin` (its query and fragment dropped) and the map may store it
 * (`PAGE_PATH`, at most 2,048 characters), else `undefined`.
 *
 * @remarks A page is identified by its path alone (ADR 0033): queries carry record ids and tokens, and a hash route
 *   is the same document, so `/map#/admin` is `/map` and is never opened as a hash route.
 */
export function pagePath(href: string, origin: string): string | undefined {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (u.origin !== origin) return undefined;
  return u.pathname.length <= 2048 && PAGE_PATH.test(u.pathname)
    ? u.pathname
    : undefined;
}

/**
 * Whether a crawl may open `path` on `origin`: in the run's `visit` scope (deny, allow and production rules of
 * {@link inScope}), not the env's login page, and not a path the destructive matcher names (a side-effecting GET).
 */
export function mayOpen(
  path: string,
  origin: string,
  rules: LinkRules,
): boolean {
  if (rules.loginUrl !== undefined && path.startsWith(rules.loginUrl))
    return false;
  const url = `${origin}${path}`;
  return (
    inScope(url, 'visit', rules.scope).ok &&
    destructiveRequest('GET', url, rules.words) === undefined
  );
}

/**
 * The same-origin paths of `raw`, sorted and deduplicated, and those the crawl may follow: in the same window, not a
 * download, {@link mayOpen}, and with no link to that path labelled with a destructive word (ADR 0024 section 5, the
 * label matcher; "Phê duyệt" is not followed even when it only opens a list).
 */
export function pageLinks(
  raw: readonly RawLink[],
  origin: string,
  rules: LinkRules,
): PageLinks {
  const all = new Set<string>();
  const ok = new Set<string>();
  const refused = new Set<string>();
  for (const l of raw) {
    const path = pagePath(l.href, origin);
    if (path === undefined) continue;
    all.add(path);
    const opens =
      SAME_WINDOW.has(l.target) &&
      !l.download &&
      destructiveWord(l.name, rules.words) === undefined &&
      mayOpen(path, origin, rules);
    (opens ? ok : refused).add(path);
  }
  const sorted = (s: Set<string>): string[] => [...s].sort();
  return {
    links: sorted(all),
    follow: sorted(ok).filter((p) => !refused.has(p)),
  };
}
