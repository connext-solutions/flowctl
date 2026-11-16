/**
 * Seeded bugs of the invariant library (task T4.9, ADR 0041), all on the `/items` app and all off by default.
 *
 * @remarks They are not in `BUG_MODES`: no flow assertion catches them, so `seeded-bugs.accuracy.test.ts`, which
 *   needs a flow per mode, does not iterate them. Each is caught by one invariant of `core/src/derive/invariants/`;
 *   the accuracy matrix in core pins which. `no-5xx` and `no-console-error` have no mode here: the crawl-class modes
 *   `call500` and `pageConsoleError` seed them.
 *
 * - `createNotListed`: after a create the page does not reload its list; the item shows only after a page reload.
 * - `editNotShown`: PATCH answers 200 and the name does not change.
 * - `deleteStillListed`: DELETE answers 204 and the item stays.
 * - `reloadLosesData`: the list a page load fetches (`?initial=1`) leaves out every item; a later list keeps them.
 * - `readBackAltered`: the list a page load fetches returns each name with a trailing dot.
 * - `itemApproveNoop`: approve answers 200 and the item is never approved.
 * - `toastOnConflict`: a create answered 409 still shows the success text.
 * - `clientLimitMissing`: the page sends a name longer than the limit instead of blocking it; the server answers 400.
 * @see docs/adr/0041-invariant-templates.md
 */
export const INVARIANT_BUG_MODES = [
  'createNotListed',
  'editNotShown',
  'deleteStillListed',
  'reloadLosesData',
  'readBackAltered',
  'itemApproveNoop',
  'toastOnConflict',
  'clientLimitMissing',
] as const;
export type InvariantBugMode = (typeof INVARIANT_BUG_MODES)[number];

/** The longest item name the server accepts, and the page blocks unless `clientLimitMissing`. */
export const ITEM_NAME_LIMIT = 40;
