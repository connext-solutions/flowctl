import type { CDPSession, Page } from 'playwright';

const sessions = new WeakMap<Page, Promise<CDPSession>>();

/** Drops the cached session of `page` if it is still `s`, and detaches it. */
function drop(page: Page, s: Promise<CDPSession>): void {
  if (sessions.get(page) !== s) return;
  sessions.delete(page);
  void s.then((cdp) => cdp.detach()).catch(() => undefined);
}

/**
 * Runs `work` on the one CDP session flowctl keeps for `page`, opened on first use and detached when the page
 * closes, so a read that runs often (a snapshot per exploration step, a page-text scan per create) does not open and
 * close a session each time.
 *
 * @remarks Chromium only (CDP). A Playwright trace records the `newCDPSession` call (its result is the session, no
 *   page data) and none of the calls sent on the session: Playwright does not attribute them to the context. That is
 *   what keeps CDP reads out of a safe trace (ADR 0030 amendment 2026-11-12); the redaction suite
 *   (`test/redaction/`) checks it on every Playwright upgrade. When `work` throws (a protocol error: the target went
 *   away, a navigation destroyed the context), the session is dropped and detached, and the next call opens a new
 *   one.
 * @throws whatever `work` or opening the session throws.
 */
export async function withPageSession<T>(
  page: Page,
  work: (cdp: CDPSession) => Promise<T>,
): Promise<T> {
  let s = sessions.get(page);
  if (s === undefined) {
    const opened = page.context().newCDPSession(page);
    s = opened;
    sessions.set(page, opened);
    page.once('close', () => drop(page, opened));
  }
  const current = s;
  try {
    return await work(await current);
  } catch (e) {
    drop(page, current);
    throw e;
  }
}
