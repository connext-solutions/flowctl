import type { Page } from 'playwright';

/** Tag of the overlay's host element; listed in `DEV_OVERLAYS` so no snapshot sees it. */
export const OVERLAY_TAG = 'flowctl-overlay';

/** Colour of the overlay frame per state: running, passed, and failed or error. */
export const OVERLAY_COLORS = {
  run: '#1565c0',
  passed: '#2e7d32',
  failed: '#c62828',
} as const;

/**
 * Page script that draws the narration box (bottom right: a title, the current step) and a fake cursor for a demo
 * video (ADR 0032). Kept as a string so no compiler helper reaches the page.
 *
 * @remarks Everything sits in a closed shadow root under a host on `<html>`, outside `<body>`, with
 *   `aria-hidden`: `body.innerText` (the `text` assertion), Playwright locators (they pierce only open shadow roots)
 *   and the accessibility snapshot never see it, so the overlay can neither make an assertion pass nor be clicked
 *   (`pointer-events: none`). Text goes in with `textContent`, never as HTML. Init scripts run again on every
 *   navigation; {@link narrate} sets the text again after each step.
 * @param title the flow name shown in the box header.
 */
export const overlayScript = (title: string): string => String.raw`((title) => {
  if (Object.prototype.hasOwnProperty.call(window, '__flowctlNarrate')) return;
  const host = document.createElement('${OVERLAY_TAG}');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const root = host.attachShadow({ mode: 'closed' });
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;width:420px;font:13px/1.45 system-ui,sans-serif;background:#fff;color:#111;border:2px solid ${OVERLAY_COLORS.run};border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.2);overflow:hidden';
  const head = document.createElement('div');
  head.style.cssText = 'background:${OVERLAY_COLORS.run};color:#fff;padding:6px 10px;font-weight:700';
  head.textContent = title;
  const body = document.createElement('div');
  body.style.cssText = 'padding:8px 10px';
  const label = document.createElement('b');
  const text = document.createElement('span');
  body.append(label, document.createTextNode(' '), text);
  panel.append(head, body);
  const cursor = document.createElement('div');
  cursor.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:26px;background:#111;filter:drop-shadow(0 0 1px #fff) drop-shadow(0 1px 2px rgba(0,0,0,.5));clip-path:polygon(0 0,0 85%,24% 66%,42% 100%,58% 93%,40% 60%,72% 60%);transform:translate(-40px,-40px);transition:transform 450ms cubic-bezier(.2,.7,.2,1)';
  root.append(panel, cursor);
  const mount = () => {
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
  };
  if (document.documentElement) mount();
  else new MutationObserver((_, o) => { if (document.documentElement) { o.disconnect(); mount(); } }).observe(document, { childList: true });
  Object.defineProperty(window, '__flowctlNarrate', {
    enumerable: false,
    value: {
      step(l, t, color) {
        mount();
        label.textContent = l;
        text.textContent = t;
        panel.style.borderColor = color;
        head.style.background = color;
      },
      cursor(x, y) {
        mount();
        cursor.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
      },
    },
  });
})(${JSON.stringify(title)})`;

/**
 * Calls one method of the overlay the script defined, if the page has it. The arguments go in as JSON literals,
 * so no step text can break out of the call. Never throws.
 */
async function call(
  page: Page,
  method: 'step' | 'cursor',
  args: (string | number)[],
): Promise<void> {
  if (page.isClosed()) return;
  const list = args.map((a) => JSON.stringify(a)).join(',');
  await page
    .evaluate(
      `window.__flowctlNarrate && window.__flowctlNarrate.${method}(${list})`,
    )
    .catch(() => undefined);
}

/** Shows `label text` in the overlay of `page`; does nothing on a page without the overlay. Never throws. */
export const narrate = (
  page: Page,
  label: string,
  text: string,
  color: string = OVERLAY_COLORS.run,
): Promise<void> => call(page, 'step', [label, text, color]);

/** Glides the overlay's fake cursor to (x, y) in the viewport; the real mouse does not move. Never throws. */
export const moveCursor = (page: Page, x: number, y: number): Promise<void> =>
  call(page, 'cursor', [Math.round(x), Math.round(y)]);
