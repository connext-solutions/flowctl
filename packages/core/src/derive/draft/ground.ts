import type { AppMap } from '../../observe/index.js';
import { normText } from '../../spec/index.js';
import { compareText, type LiteralMatch } from '../match/index.js';
import { elementAt, pointerOf } from './pointer.js';
import { type DraftTarget, type GapReason, NAV_ROLES } from './types.js';

/** A grounded value, or the reason it could not be grounded. */
export type Grounded<T> = { ok: T } | { gap: GapReason };

type Element = LiteralMatch['elements'][number]['element'];
type Actionable = Extract<Element, { kind: 'control' | 'field' }>;

const actionable = (e: Element): e is Actionable =>
  e.kind === 'control' || e.kind === 'field';

const sameName = (a: Actionable, b: Actionable): boolean =>
  a.role === b.role && a.name === b.name;

/**
 * How many distinct elements `found` holds: every control, plus every field whose role and name no control of the list
 * has (a crawl lists a form field among the page's controls too, so the pair is one element).
 *
 * @remarks Fields and controls are paired by role and name only: two same-named fields in two forms of the page, with
 *   the one control a crawl lists for that name, count as one element, so the label is not `ambiguous` there.
 */
function distinct(found: readonly Actionable[]): number {
  const controls = found.filter((e) => e.kind === 'control');
  const fields = found.filter(
    (e) => e.kind === 'field' && !controls.some((c) => sameName(c, e)),
  );
  return controls.length + fields.length;
}

/** The literal's reason when no element of the right role is found: wrong role, other pages, nowhere or refused. */
function missReason(l: LiteralMatch, onScreen: readonly Element[]): GapReason {
  if (l.refused !== null) return 'refused';
  if (onScreen.length > 0) return 'role_mismatch';
  return l.elements.length > 0 ? 'label_not_on_screen' : 'label_not_found';
}

/**
 * The control a quoted label names on `screen` for an action its `roles` can take (`ACTION_ROLES[action]`): the one
 * element of the screen, of one of those roles, that the literal equals; its name and role are the map's, at a
 * pointer that resolves in `map`.
 */
export function groundTarget(
  l: LiteralMatch,
  roles: readonly string[],
  screen: string,
  map: AppMap,
): Grounded<DraftTarget> {
  if (l.refused !== null) return { gap: 'refused' };
  if (l.kind === 'path') return { gap: 'role_mismatch' };
  const onScreen = l.elements
    .map((e) => e.element)
    .filter((e) => e.page === screen);
  const fit = onScreen.filter(actionable).filter((e) => roles.includes(e.role));
  const first = fit[0];
  if (first === undefined) return { gap: missReason(l, onScreen) };
  if (distinct(fit) > 1) return { gap: 'ambiguous' };
  const pointer = pointerOf(map, first);
  const at = pointer === null ? null : elementAt(map, pointer);
  if (pointer === null || at?.role !== first.role || at.name !== first.name)
    return { gap: 'label_not_found' };
  return { ok: { role: first.role, name: first.name, pointer } };
}

/** The name of the navigation control (on any page) a menu path label equals, as the map holds it. */
export function groundVia(l: LiteralMatch): Grounded<string> {
  if (l.refused !== null) return { gap: 'refused' };
  if (l.kind === 'path') return { gap: 'role_mismatch' };
  const nav = l.elements
    .map((e) => e.element)
    .filter(actionable)
    .filter((e) => e.kind === 'control' && NAV_ROLES.includes(e.role));
  const first = nav[0];
  if (first !== undefined) return { ok: first.name };
  return { gap: l.elements.length > 0 ? 'role_mismatch' : 'label_not_found' };
}

/** The page a quoted address names, the address cut at `?` or `#` (ADR 0034 rule 5). */
export function groundPath(l: LiteralMatch): Grounded<string> {
  if (l.refused !== null) return { gap: 'refused' };
  const page = l.elements.find((e) => e.element.kind === 'path')?.element.page;
  return page === undefined ? { gap: 'label_not_found' } : { ok: page };
}

/** The one page whose title equals `label` (ADR 0034 rule 4), or `undefined` when none or several do. */
export function pageTitled(map: AppMap, label: string): string | undefined {
  const text = normText(label);
  const hits = map.pages.filter(
    (p) => compareText(normText(p.title), text) !== null,
  );
  return hits.length === 1 ? hits[0]?.path : undefined;
}
