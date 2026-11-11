import type { Target } from './target-schema.js';

/**
 * The built-in ceiling of each run budget (ADR 0024 section 6): a larger repo value is capped and a missing one takes
 * the ceiling. The ADR names no numbers; these are flowctl's choice, recorded as an owner decision.
 */
export const BUDGET_CEILINGS = {
  pages: 50,
  wallClockMs: 600_000,
  costUsd: 1,
} as const;

/** What the store trusts for one env: its origin and the extra origins it may visit and call. */
export interface EnvCeiling {
  origin: string;
  visitOrigins: readonly string[];
  callOrigins: readonly string[];
}

/** The scope one env runs with: the origins a page may visit, and the origins its requests may call. */
export interface EnvScope {
  visit: string[];
  call: string[];
}

/**
 * The canonical origin of `s` (lowercase, default port dropped, IDN as ASCII), or `undefined` unless `s` is a bare
 * http(s) origin: no userinfo, path, query or fragment.
 */
const originOf = (s: string): string | undefined => {
  try {
    const u = new URL(s);
    const bare =
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      u.username === '' &&
      u.password === '' &&
      u.pathname === '/' &&
      u.search === '' &&
      u.hash === '' &&
      !s.includes('?') &&
      !s.includes('#');
    return bare ? u.origin : undefined;
  } catch {
    return undefined;
  }
};

/** Any character a URL parser strips or treats as a separator: controls, space, DEL and backslash. */
const UNSAFE_IN_PATH_CLASS = '[\\u0000-\\u0020\\u007f\\\\]';
const UNSAFE_IN_PATH = new RegExp(UNSAFE_IN_PATH_CLASS);
const PROBE = 'https://flowctl.invalid';

/**
 * Whether `p` is a path on the env's own origin, as a browser resolves it: it starts with one `/`, holds no
 * character the URL parser strips (so `/\t/host` cannot become `//host`), and resolves against an origin to that
 * same origin.
 */
const isPath = (p: string): boolean => {
  if (!p.startsWith('/') || UNSAFE_IN_PATH.test(p)) return false;
  try {
    return new URL(p, PROBE).origin === PROBE;
  } catch {
    return false;
  }
};

/**
 * The repo `target:` section narrowed to what the store and the built-in ceilings allow (ADR 0024 section 1,
 * per-key matrix), with a warning for every value dropped or capped:
 * - `scope.visit` and `scope.call` are bare origins (compared canonically); per env they are intersected with the
 *   env origin plus the store's `visitOrigins` (or `callOrigins`). Left out means the whole ceiling; a list, even an
 *   empty one, is a literal intersection, and an env left with nothing gets a warning. The returned `target` keeps
 *   only the entries some env kept, so no reader sees a dropped origin.
 * - `scope.allow` keeps only paths on the env's own origin; `scope.deny` is kept whole (it can only add, and the
 *   built-in deny list of T1.2 is never in the repo, so nothing here can remove it).
 * - `budgets` are min-ed with {@link BUDGET_CEILINGS}; a missing budget is the ceiling.
 * - `destructiveWords` are added to the core list (never removing a word).
 * - `profiles.<n>.login` keeps selectors and a path only: a recipe whose `path` names another origin is dropped.
 *
 * @returns the narrowed section, and per trusted env its scope; an empty `visit` or `call` set means nothing may be
 *   reached (T1.2 refuses every such request).
 */
export function narrowTarget(
  target: Target,
  envs: ReadonlyMap<string, EnvCeiling>,
  profiles: readonly string[],
  warnings: string[],
): { target: Target; scopes: Record<string, EnvScope> } {
  const scopes: Record<string, EnvScope> = {};
  const usedVisit = new Set<string>();
  const usedCall = new Set<string>();
  const pick = (
    repo: readonly string[] | undefined,
    ceiling: readonly string[],
    used: Set<string>,
  ): string[] => {
    if (repo === undefined) return [...ceiling];
    const kept = repo.flatMap((o) => {
      const origin = originOf(o);
      return origin !== undefined && ceiling.includes(origin) ? [origin] : [];
    });
    for (const o of kept) used.add(o);
    return [...new Set(kept)];
  };
  for (const [name, e] of envs)
    scopes[name] = {
      visit: pick(target.scope.visit, [e.origin, ...e.visitOrigins], usedVisit),
      call: pick(target.scope.call, [e.origin, ...e.callOrigins], usedCall),
    };
  for (const [key, list, used] of [
    ['visit', target.scope.visit, usedVisit],
    ['call', target.scope.call, usedCall],
  ] as const) {
    const dropped = (list ?? []).filter((o) => {
      const origin = originOf(o);
      return origin === undefined || !used.has(origin);
    });
    if (dropped.length > 0)
      warnings.push(
        `target.scope.${key} lists ${dropped.join(', ')}, which is not a bare origin such as https://host or is one no trusted env allows (only an env's own origin and the store's ${key}Origins); ignored.`,
      );
    for (const [name, sc] of Object.entries(scopes))
      if (list !== undefined && sc[key].length === 0)
        warnings.push(
          `target.scope.${key} leaves env "${name}" nothing to ${key}; its runs will be refused there. List its origin, or leave target.scope.${key} out.`,
        );
  }
  const allow = target.scope.allow.filter(isPath);
  if (allow.length < target.scope.allow.length)
    warnings.push(
      `target.scope.allow may only list paths on the env's own origin (starting with one /); ${target.scope.allow.filter((p) => !isPath(p)).join(', ')} is ignored.`,
    );
  const budgets = { ...target.budgets };
  for (const key of ['pages', 'wallClockMs', 'costUsd'] as const) {
    const max = BUDGET_CEILINGS[key];
    const v = budgets[key];
    if (v !== undefined && v > max)
      warnings.push(
        `target.budgets.${key} ${v} is above the built-in ceiling; ${max} is used.`,
      );
    budgets[key] = v === undefined ? max : Math.min(v, max);
  }
  const destructiveWords = target.destructiveWords
    .map((w) => w.normalize('NFC').trim().toLowerCase())
    .filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (destructiveWords.length < target.destructiveWords.length)
    warnings.push(
      'target.destructiveWords holds an entry with no letter or digit; it can never match and is ignored.',
    );
  const recipes: Target['profiles'] = {};
  for (const [name, p] of Object.entries(target.profiles)) {
    if (!profiles.includes(name)) {
      warnings.push(
        `target.profiles.${name} names a profile that flowctl.config.yaml does not have; it is ignored.`,
      );
      continue;
    }
    if (p.login !== undefined && !isPath(p.login.path)) {
      warnings.push(
        `target.profiles.${name}.login.path ${p.login.path} names another origin; login origins come only from the trust store, so the recipe is ignored.`,
      );
      recipes[name] = {};
      continue;
    }
    recipes[name] = p;
  }
  return {
    target: {
      scope: {
        ...(target.scope.visit === undefined ? {} : { visit: [...usedVisit] }),
        ...(target.scope.call === undefined ? {} : { call: [...usedCall] }),
        allow,
        deny: target.scope.deny,
      },
      budgets,
      destructiveWords,
      profiles: recipes,
    },
    scopes,
  };
}
