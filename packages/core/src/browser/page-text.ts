import type { CDPSession, Page } from 'playwright';
import { withPageSession } from './cdp.js';

/** The isolated world the text reads run in, apart from the page's own scripts. */
const WORLD = '__flowctl_text';

const TEXT = `document.body ? document.body.innerText : ''`;

interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}

const frameIds = (t: FrameTree): string[] => [
  t.frame.id,
  ...(t.childFrames ?? []).flatMap(frameIds),
];

/** The body text of every frame `cdp`'s target holds; a frame that cannot be read (gone, not loaded) is left out. */
async function textsOn(cdp: CDPSession): Promise<string[]> {
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const out: string[] = [];
  for (const frameId of frameIds(frameTree)) {
    const text = await cdp
      .send('Page.createIsolatedWorld', { frameId, worldName: WORLD })
      .then(({ executionContextId }) =>
        cdp.send('Runtime.evaluate', {
          expression: TEXT,
          contextId: executionContextId,
          returnByValue: true,
        }),
      )
      .then((r): unknown => r.result.value)
      .catch(() => undefined);
    if (typeof text === 'string') out.push(text);
  }
  return out;
}

/**
 * The `innerText` of the body of every frame of `page`, read through CDP `Runtime.evaluate` in an isolated world, so
 * no page script can change what is read and the text never becomes a call result of the Playwright trace
 * (`frame.evaluate` results are recorded; ADR 0030 amendment 2026-11-12).
 *
 * @remarks Chromium only (CDP). The main target's frames are read on the page's cached session
 *   ({@link withPageSession}); a cross-site frame in its own process is read on a session of its own, opened and
 *   detached here. Each read creates one isolated world per frame. A page or frame that closed meanwhile adds
 *   nothing; the read never throws.
 */
export async function frameTexts(page: Page): Promise<string[]> {
  const main = await withPageSession(page, textsOn).catch(() => []);
  const own: string[] = [];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const cdp = await page
      .context()
      .newCDPSession(f)
      .catch(() => undefined);
    if (cdp === undefined) continue;
    try {
      own.push(...(await textsOn(cdp).catch(() => [])));
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  }
  return [...main, ...own];
}
