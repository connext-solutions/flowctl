import { join } from 'node:path';
import type { Page } from 'playwright';

/** Every editable text field: inputs, text areas and content-editable elements in any of their forms. */
const FIELDS =
  'input, textarea, [contenteditable]:not([contenteditable=false])';

/**
 * Writes `final.png` of `page` into `dir` and returns its path, or `undefined` when the page cannot be captured.
 *
 * @remarks Password inputs are always masked; when the run has a secret input, every editable field is, since a
 *   secret may sit in any of them (ADR 0030).
 */
export async function finalScreenshot(
  page: Page,
  dir: string,
  hasSecrets: boolean,
): Promise<string | undefined> {
  const path = join(dir, 'final.png');
  const mask = [page.locator(hasSecrets ? FIELDS : 'input[type=password]')];
  return page.screenshot({ path, fullPage: true, mask }).then(
    () => path,
    () => undefined,
  );
}
