import { setTimeout as sleep } from 'node:timers/promises';
import type { Page } from 'playwright';
import type { Evidence } from './evidence.js';
import { fmtNet, redactEntry, type NetEntry } from './net-entry.js';
import { redactBody } from './redact.js';
import { MAX_GOT_HITS, clip, listed, requestPaths } from './bounds.js';
import type { Assertion, Loc } from '../flow/index.js';
import { describeLoc, toPlaywright, visibleOnly } from '../browser/index.js';
import type { AssertionFailure } from '../result.js';
import { assertNever } from '../foundation/index.js';

export interface VerifyContext {
  page: Page;
  evidence: Evidence;
  testIdAttribute: string;
  /**
   * The run's origins (its scope's `visit` and `call` sets): a `url` or `network` assertion matches only a URL on one
   * of them, so a page or request elsewhere never satisfies it (issue #47). Left out, any origin matches.
   */
  origins?: readonly string[];
}

/** Whether `url` is on one of `origins`, or `origins` is not given. */
function onRun(url: string, origins: readonly string[] | undefined): boolean {
  if (origins === undefined) return true;
  try {
    return origins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

export interface Verdict {
  passed: boolean;
  failed?: AssertionFailure;
}

interface Check {
  ok: boolean;
  got: string;
}

const POLL_MS = 200;

/**
 * Turns a `url` / `network` glob into a regular expression: `*` matches anything, a leading `/` matches
 * any origin (the verifier then keeps only the run's origins, {@link VerifyContext.origins}), and a query string
 * may follow.
 *
 * @remarks An anchor fragment (`#list`) may follow too, unless the pattern names its own `#`. A
 *   hash route (`#/admin`, `#!/admin`) never matches implicitly, so the pattern `/app` does not pass
 *   on `/app#/admin/delete`; write the route in the pattern instead.
 */
export function globToRegExp(pattern: string): RegExp {
  const full = pattern.startsWith('/') ? `*${pattern}` : pattern;
  const body = full
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const tail = pattern.includes('#') ? '(\\?.*)?' : '(\\?[^#]*)?(#(?![/!]).*)?';
  return new RegExp(`^${body}${tail}$`);
}

export function isSubset(expected: unknown, actual: unknown): boolean {
  if (expected === null || typeof expected !== 'object')
    return Object.is(expected, actual);
  if (actual === null || typeof actual !== 'object') return false;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((v, i) => isSubset(v, actual[i]))
    );
  }
  const fields = new Map(Object.entries(actual));
  return Object.entries(expected).every(([k, v]) => isSubset(v, fields.get(k)));
}

/** `noConsoleErrors` and `network.absent` are checked once at the end: they describe the whole run, not a state to wait for. */
export const isOnce = (a: Assertion): boolean =>
  'noConsoleErrors' in a || ('network' in a && a.network.absent === true);

const describeHits = (hits: NetEntry[], all: readonly NetEntry[]): string =>
  hits.length === 0
    ? `no matching fetch/xhr request; seen: ${requestPaths(all).join(', ') || 'none'}`
    : listed(
        hits.map((e) =>
          clip(
            `${fmtNet(redactEntry(e, []))} body=${JSON.stringify(redactBody(e.requestBody, [])) ?? ''}`,
          ),
        ),
        MAX_GOT_HITS,
        'network.json',
      ).join('; ');

/**
 * Whether the visible text of the page, or of the one visible element `within` names, contains `text`.
 *
 * @remarks `within` must match exactly one visible element, like a step's locator; none or several fail with the
 *   count, so a region that is not there never passes by accident. Page text is read with `evaluate`, whose result
 *   a Playwright trace does not record (unlike `innerText` and `inputValue`), so the page's text stays out of a
 *   safe trace (ADR 0030).
 */
async function checkText(
  text: string,
  within: Loc | undefined,
  ctx: VerifyContext,
): Promise<Check> {
  const region =
    within === undefined
      ? ctx.page.locator('body')
      : visibleOnly(toPlaywright(ctx.page, within, ctx.testIdAttribute));
  if (within !== undefined) {
    const n = await region.count();
    if (n !== 1)
      return {
        ok: false,
        got: `<${describeLoc(within)} matched ${n} elements>`,
      };
  }
  const shown = await region
    .evaluate((e) => (e instanceof HTMLElement ? e.innerText : ''), undefined, {
      timeout: 1000,
    })
    .catch(() => '');
  const where =
    within === undefined ? 'visible page text' : describeLoc(within);
  return {
    ok: shown.includes(text),
    got: `${where} does not contain it (${shown.length} chars)`,
  };
}

async function check(a: Assertion, ctx: VerifyContext): Promise<Check> {
  if ('network' in a) {
    const n = a.network;
    const re = globToRegExp(n.url);
    const seen = ctx.evidence.network.filter((e) => onRun(e.url, ctx.origins));
    const hits = seen.filter(
      (e) => e.method === n.method.toUpperCase() && re.test(e.url),
    );
    if (n.absent === true)
      return {
        ok: hits.length === 0,
        got: describeHits(hits, seen),
      };
    const ok = hits.some(
      (e) =>
        (n.status === undefined || e.status === n.status) &&
        (n.requestBody === undefined || isSubset(n.requestBody, e.requestBody)),
    );
    return { ok, got: describeHits(hits, seen) };
  }
  if ('text' in a) return checkText(a.text, a.within, ctx);
  if ('url' in a) {
    const url = ctx.page.url();
    return {
      ok: globToRegExp(a.url).test(url) && onRun(url, ctx.origins),
      got: url,
    };
  }
  if ('value' in a) {
    const l = visibleOnly(
      toPlaywright(ctx.page, a.value.locator, ctx.testIdAttribute),
    );
    const n = await l.count();
    if (n !== 1)
      return {
        ok: false,
        got: `<${describeLoc(a.value.locator)} matched ${n} elements>`,
      };
    const actual = await l
      .evaluate(
        (e) => {
          if (
            e instanceof HTMLInputElement ||
            e instanceof HTMLTextAreaElement ||
            e instanceof HTMLSelectElement
          )
            return e.value;
          throw new Error('not an input, textarea or select element');
        },
        undefined,
        { timeout: 1000 },
      )
      .catch(
        (e: unknown) =>
          `<${e instanceof Error ? (e.message.split('\n')[0] ?? 'error') : 'error'}>`,
      );
    return { ok: actual === a.value.equals, got: actual };
  }
  if ('noConsoleErrors' in a)
    return {
      ok:
        ctx.evidence.consoleErrors.length === 0 &&
        ctx.evidence.droppedConsoleErrors === 0,
      got: listed(
        ctx.evidence.consoleErrors,
        MAX_GOT_HITS,
        'console.json',
        ctx.evidence.droppedConsoleErrors,
      ).join(' | '),
    };
  return assertNever(a, 'assertion');
}

export async function verify(
  assertions: Assertion[],
  ctx: VerifyContext,
  timeoutMs: number,
): Promise<Verdict> {
  await ctx.evidence.settle();
  const ordered = [
    ...assertions.filter((a) => !isOnce(a)),
    ...assertions.filter(isOnce),
  ];
  for (const a of ordered) {
    const deadline = Date.now() + (isOnce(a) ? 0 : timeoutMs);
    let c = await check(a, ctx);
    while (!c.ok && Date.now() < deadline) {
      await sleep(POLL_MS);
      c = await check(a, ctx);
    }
    if (!c.ok) return { passed: false, failed: { assertion: a, got: c.got } };
  }
  return { passed: true };
}
