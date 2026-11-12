import type { AppMap } from '../../observe/index.js';
import type { MapElement } from '../match/index.js';

const CONTROL = /^\/pages\/(0|[1-9]\d*)\/controls\/(0|[1-9]\d*)$/;
const FIELD =
  /^\/pages\/(0|[1-9]\d*)\/forms\/(0|[1-9]\d*)\/fields\/(0|[1-9]\d*)$/;

/** The JSON Pointer of a control or form field of `map` in `appmap.json`, or `null` when its page is not in `map`. */
export function pointerOf(map: AppMap, e: MapElement): string | null {
  const p = map.pages.findIndex((page) => page.path === e.page);
  if (p < 0) return null;
  if (e.kind === 'control') return `/pages/${p}/controls/${e.index}`;
  if (e.kind === 'field')
    return `/pages/${p}/forms/${e.form}/fields/${e.index}`;
  return null;
}

/** The role and name of the control or field at `pointer` in `map` with its page path, or `null` when none is there. */
export function elementAt(
  map: AppMap,
  pointer: string,
): { page: string; role: string; name: string } | null {
  const c = CONTROL.exec(pointer);
  if (c !== null) {
    const page = map.pages[Number(c[1])];
    const el = page?.controls[Number(c[2])];
    return page === undefined || el === undefined
      ? null
      : { page: page.path, role: el.role, name: el.name };
  }
  const f = FIELD.exec(pointer);
  if (f === null) return null;
  const page = map.pages[Number(f[1])];
  const el = page?.forms[Number(f[2])]?.fields[Number(f[3])];
  return page === undefined || el === undefined
    ? null
    : { page: page.path, role: el.role, name: el.name };
}
