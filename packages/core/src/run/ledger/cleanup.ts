import type { CleanupResult, Leftover } from '../../result.js';
import {
  canonicalId,
  type CreateConfirm,
  parseTemplate,
  templateIds,
} from '../../trust/index.js';

export type { CleanupResult, Leftover } from '../../result.js';

/** One record to remove: the create entry that minted it, its id and the `seq` of its request. */
export interface CleanupTarget {
  entry: CreateConfirm;
  id: string;
  seq: number;
}

/** One answer of a cleanup or verify request: its status, or `error` when no answer came. */
export type Send = (
  method: 'DELETE' | 'GET',
  url: string,
) => Promise<number | 'error'>;

/** What {@link cleanIds} waits with; tests pass a fake. */
export interface CleanupTiming {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Total budget of one cleanup; 120 s by the ADR. */
  budgetMs: number;
}

/** The ADR's timing: 1 s before the one retry, verify after 1 s then 2 s, 120 s in all. */
export const CLEANUP_TIMING: CleanupTiming = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  budgetMs: 120_000,
};

const VERIFY_WAITS = [0, 1000, 2000] as const;

/**
 * The URL of `template` with its one placeholder replaced by `id`, on `origin`, or `undefined` when no URL inside the
 * template can carry `id`.
 *
 * @remarks The id comes from a ledger file, which a person can edit, so it is held to the shape a run mints before it
 *   reaches a URL: canonical (`canonicalId(id) === id`) and of the placeholder's type. The path is joined segment by
 *   segment (no pattern replacement, so `$&` is just text), parsed, and must come back unchanged and match the
 *   template again with the exact matcher of `match.ts`, with `id` as its one value; a traversal (`x/../..`), a query
 *   or a fragment can never leave the template.
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export function cleanupUrl(
  origin: string,
  template: string,
  id: string,
): string | undefined {
  const t = parseTemplate(template);
  if (typeof t === 'string' || canonicalId(id) !== id) return undefined;
  if (t.filter((s) => 'placeholder' in s).length !== 1) return undefined;
  const path = `/${t.map((s) => ('literal' in s ? s.literal : id)).join('/')}`;
  const url = `${origin}${path}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.origin !== origin || parsed.href !== url) return undefined;
  const ids = templateIds(parsed.pathname, template);
  return ids?.length === 1 && ids[0] === id ? url : undefined;
}

const gone = (s: number | 'error'): boolean => s === 404 || s === 410;
const done = (s: number | 'error'): boolean =>
  gone(s) || (typeof s === 'number' && s >= 200 && s < 300);
const retry = (s: number | 'error'): boolean => s === 'error' || s >= 500;

/**
 * Removes `targets`, last created first, through each one's `cleanup` and checks it with `verify` (ADR 0024 section
 * 5 rule 10 and the amendment 2026-11-12, section 7): the cleanup request is sent once, and once more after 1 s on a
 * network error or a 5xx; 2xx, 404 and 410 count as done, any other answer makes the id leftover. Verify is a `GET`,
 * at most 3 attempts (after 1 s, then 2 s); 404 or 410 confirms. Ids not reached within the budget are leftover, and
 * a failing id never stops the others. An id no URL of the templates can carry ({@link cleanupUrl}: a forged ledger
 * line) is leftover `id_invalid` and nothing is sent for it.
 *
 * @param record called once per id, as soon as its result is known (the caller appends the ledger line).
 */
export async function cleanIds(
  targets: readonly CleanupTarget[],
  send: Send,
  record: (t: CleanupTarget, result: 'confirmed' | 'leftover') => void,
  timing: CleanupTiming = CLEANUP_TIMING,
): Promise<CleanupResult> {
  const end = timing.now() + timing.budgetMs;
  const out: CleanupResult = { confirmed: 0, leftover: [] };
  const leftover = (t: CleanupTarget, detail: Leftover['detail']): void => {
    out.leftover.push({ entry: t.entry.id, id: t.id, name: null, detail });
    record(t, 'leftover');
  };
  for (const t of [...targets].reverse()) {
    if (timing.now() >= end) {
      leftover(t, 'timeout');
      continue;
    }
    const origin = t.entry.origin;
    const del = cleanupUrl(origin, t.entry.cleanup.template, t.id);
    const check = cleanupUrl(origin, t.entry.cleanup.verify.template, t.id);
    if (del === undefined || check === undefined) {
      leftover(t, 'id_invalid');
      continue;
    }
    let status = await send('DELETE', del);
    if (retry(status) && timing.now() + 1000 < end) {
      await timing.sleep(1000);
      status = await send('DELETE', del);
    }
    if (!done(status)) {
      leftover(t, 'cleanup_failed');
      continue;
    }
    let confirmed = false;
    for (const wait of VERIFY_WAITS) {
      if (timing.now() + wait >= end) break;
      if (wait > 0) await timing.sleep(wait);
      if (gone(await send('GET', check))) {
        confirmed = true;
        break;
      }
    }
    if (confirmed) {
      out.confirmed++;
      record(t, 'confirmed');
    } else leftover(t, timing.now() >= end ? 'timeout' : 'verify_failed');
  }
  return out;
}
