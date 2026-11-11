import type { CDPSession, Locator, Page } from 'playwright';
import { StepError } from '../foundation/index.js';

/** Re-render settle window before checking the field kept its value (a re-mount can wipe the first edit). */
export const FILL_SETTLE_MS = 300;

/**
 * Sends `text` to the focused element through CDP, giving up after `timeout` ms.
 *
 * @throws {StepError} `action_failed` when CDP does not answer in time.
 */
async function insertWithin(
  cdp: CDPSession,
  text: string,
  timeout: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      cdp.send('Input.insertText', { text }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new StepError('action_failed', 'typing the secret timed out'),
            ),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Types a secret into `l` so the value never becomes an action parameter of the Playwright trace: the field is
 * focused and cleared with key presses, the text goes through CDP `Input.insertText`, and the field is checked with
 * a boolean, never by reading its value back (ADR 0030). Re-typed like the executor's `fillVerified` when a re-render empties
 * it.
 *
 * @remarks Chromium only (CDP). Text is inserted at once, so a field that reacts to key events only (an input mask,
 *   a search combobox) may not take it; such a field cannot hold a secret input. A field in a cross-origin frame
 *   gets no text and fails honestly.
 * @throws {StepError} `action_failed` when the field is still empty after 3 attempts or typing times out.
 */
export async function fillSecret(
  page: Page,
  l: Locator,
  value: string,
  timeout: number,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await l.click();
      await l.press('ControlOrMeta+a');
      await l.press('Delete');
      await insertWithin(cdp, value, timeout);
      await page.waitForTimeout(FILL_SETTLE_MS);
      const filled = await l.evaluate((target) => {
        const has = (el: Element | null): boolean | undefined => {
          if (
            el instanceof HTMLInputElement ||
            el instanceof HTMLTextAreaElement
          )
            return el.value !== '';
          if (el instanceof HTMLElement && el.isContentEditable)
            return (el.textContent ?? '') !== '';
          return undefined;
        };
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement)
          active = active.shadowRoot.activeElement;
        return has(target) ?? has(active) ?? false;
      });
      if (filled) return;
    }
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  throw new StepError('action_failed', 'field was still empty after 3 fills');
}
