import { createHash } from 'node:crypto';
import type { Page } from 'playwright';
import { z } from 'zod';
import { withPageSession } from './cdp.js';
import { OVERLAY_TAG } from './overlay.js';
import { snapshotScript } from './snapshot-script.js';

/**
 * Overlays left out of every snapshot, on top of `snapshotIgnore`: React Query Devtools (its toggle button sits
 * outside `.tsqd-parent-container`), the Vite and webpack error overlays, and flowctl's own video overlay.
 */
export const DEV_OVERLAYS = [
  OVERLAY_TAG,
  '.tsqd-parent-container',
  'button[aria-label="Open React Query Devtools"]',
  'vite-error-overlay',
  '#webpack-dev-server-client-overlay',
];

/** Attribute that marks the one element an action is about to touch. */
export const MARK_ATTRIBUTE = 'data-flowctl-target';

const ControlSchema = z.object({
  id: z.number().int(),
  role: z.string(),
  name: z.string(),
  ops: z.array(z.enum(['CLICK', 'TYPE_TEXT', 'SELECT'])),
  value: z.string(),
  checked: z.string().optional(),
  selected: z.string().optional(),
  expanded: z.string().optional(),
  options: z.array(z.string()).optional(),
});
export type Control = z.infer<typeof ControlSchema>;
export type ControlOp = Control['ops'][number];

const RawSnapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  text: z.string(),
  controls: z.array(ControlSchema),
  canScrollUp: z.boolean(),
  canScrollDown: z.boolean(),
});

export interface PageSnapshot extends z.infer<typeof RawSnapshotSchema> {
  /** Changes when the URL, title, visible text or any control changes. */
  fingerprint: string;
}

/**
 * Runs the snapshot script through CDP `Runtime.evaluate` in the page's main world, as `page.evaluate` would: a
 * Playwright trace records a `page.evaluate` result (the page text, every field value, the URL) and no CDP call, so
 * what System 1 is shown stays out of a safe trace (ADR 0030 amendment 2026-11-12, T1.5).
 *
 * @remarks Chromium only (CDP). The safety depends on Playwright not attributing calls on a CDP session to the
 *   context; the redaction suite (`test/redaction/`) guards it on every Playwright upgrade. The session is the
 *   page's cached one ({@link withPageSession}): one per page, not one per snapshot.
 * @throws {Error} when the script throws (with the exception's description) or the page context goes away
 *   mid-evaluation (the caller retries once).
 */
async function evaluateSnapshot(page: Page, ignore: string[]) {
  const r = await withPageSession(page, (cdp) =>
    cdp.send('Runtime.evaluate', {
      expression: snapshotScript([...DEV_OVERLAYS, ...ignore]),
      returnByValue: true,
    }),
  );
  if (r.exceptionDetails !== undefined)
    throw new Error(
      `snapshot failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
    );
  return RawSnapshotSchema.parse(r.result.value);
}

const SETTLE_POLL_MS = 200;

async function evaluateOnce(page: Page, ignore: string[]) {
  return evaluateSnapshot(page, ignore).catch(async () => {
    await page.waitForLoadState('domcontentloaded');
    return evaluateSnapshot(page, ignore);
  });
}

/**
 * What System 1 sees of a page: visible text (≤ 6,000 chars) and up to 250 visible, enabled
 * controls with ids that stay stable for the same element.
 *
 * @remarks Retries once after `domcontentloaded` when a navigation destroys the page context
 *   mid-evaluation. A page with no control yet (an SPA still waiting for its first API calls after
 *   `load`) is re-read after `networkidle` and then every 200 ms for up to `settleMs`; on a real app the
 *   first snapshot otherwise came back empty and System 1 answered BLOCKED.
 * @param ignore `snapshotIgnore` selectors, added to {@link DEV_OVERLAYS}.
 * @param settleMs how long to wait for a first control (0 = never wait).
 */
export async function takeSnapshot(
  page: Page,
  ignore: string[] = [],
  settleMs = 0,
): Promise<PageSnapshot> {
  const deadline = Date.now() + settleMs;
  let raw = await evaluateOnce(page, ignore);
  if (raw.controls.length === 0 && settleMs > 0)
    await page
      .waitForLoadState('networkidle', { timeout: settleMs })
      .catch(() => undefined);
  while (raw.controls.length === 0 && Date.now() < deadline) {
    await page.waitForTimeout(SETTLE_POLL_MS);
    raw = await evaluateOnce(page, ignore);
  }
  const fingerprint = createHash('sha1')
    .update(JSON.stringify([raw.url, raw.title, raw.text, raw.controls]))
    .digest('hex');
  return { ...raw, fingerprint };
}

let marks = 0;

/**
 * Marks control `id` from a snapshot of the current document with a fresh token in
 * {@link MARK_ATTRIBUTE}; the next snapshot clears it.
 *
 * @returns The token, or `undefined` when the element is gone or detached (the page changed).
 */
export async function markControl(
  page: Page,
  id: number,
): Promise<string | undefined> {
  marks += 1;
  const token = `m${marks}`;
  const ok: unknown = await page.evaluate(
    `(() => { const e = window.__flowctl && window.__flowctl.nodes.get(${id}); if (!e || !e.isConnected) return false; e.setAttribute('${MARK_ATTRIBUTE}', '${token}'); return true; })()`,
  );
  return ok === true ? token : undefined;
}

/** One line of an escalation's control table, e.g. `[7] button "Gửi"`. */
export const describeControl = (c: Control): string =>
  `[${c.id}] ${c.role} "${c.name}"${c.value === '' ? '' : ` = "${c.value}"`}`;
