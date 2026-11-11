import type { Locator, Page } from 'playwright';
import type { Loc } from '../flow/index.js';

/** testId wins; otherwise role + exact accessible name (an empty name matches unnamed elements). */
export function toPlaywright(
  page: Page,
  loc: Loc,
  testIdAttribute: string,
): Locator {
  if (loc.testId !== undefined)
    return page.locator(`[${testIdAttribute}=${JSON.stringify(loc.testId)}]`);
  if (loc.role === undefined) throw new Error('locator needs testId or role');
  return page.getByRole(
    loc.role,
    loc.name === undefined ? {} : { name: loc.name, exact: true },
  );
}

export const describeLoc = (loc: Loc): string =>
  loc.testId !== undefined
    ? `testId=${loc.testId}`
    : `${loc.role ?? '?'} "${loc.name ?? ''}"`;
