import {
  canonicalId,
  type CreateConfirm,
  parsePointer,
  templateIds,
} from '../../trust/index.js';

/** The value at a JSON Pointer of `doc`, or `undefined`. */
export function valueAt(doc: unknown, pointer: string): unknown {
  const segs = parsePointer(pointer, { noWildcard: true });
  if (typeof segs === 'string') return undefined;
  let at: unknown = doc;
  for (const s of segs) {
    if (Array.isArray(at))
      at = /^(0|[1-9][0-9]*)$/.test(s) ? at[Number(s)] : undefined;
    else if (typeof at === 'object' && at !== null && Object.hasOwn(at, s))
      at = Object.getOwnPropertyDescriptor(at, s)?.value;
    else return undefined;
  }
  return at;
}

/**
 * The id a 201 answer names at the entry's `idFrom` (ADR 0024 amendment 2026-11-12, sections 2 and 5): a JSON string
 * or number at a `body:` pointer, canonical (an array, an object, an absent value or `"0007"` is none); or, for
 * `header:Location`, the one placeholder value of the `cleanup` template in exactly one same-origin `Location`
 * header, matched with the exact matcher of the entries, so its type is the placeholder's.
 *
 * @param headers the answer's headers, every one (`APIResponse.headersArray()`).
 * @param url the request URL a relative `Location` resolves against.
 * @returns the id, or why none can be read (the run then ends `ledger_mismatch`).
 * @internal exported for its unit test.
 */
export function idOf(
  e: CreateConfirm,
  headers: readonly { name: string; value: string }[],
  json: unknown,
  url: string,
): string | { why: string } {
  if (e.idFrom.startsWith('body:')) {
    const id = canonicalId(valueAt(json, e.idFrom.slice(5)));
    return id ?? { why: `the answer holds no int or uuid at ${e.idFrom}` };
  }
  const locations = headers.filter((h) => h.name.toLowerCase() === 'location');
  const [only] = locations;
  if (locations.length !== 1 || only === undefined)
    return { why: 'the answer does not have exactly one Location header' };
  let loc: URL;
  try {
    loc = new URL(only.value, url);
  } catch {
    return { why: 'the Location header does not parse' };
  }
  if (loc.origin !== e.origin)
    return { why: 'the Location header names another origin' };
  const ids = templateIds(loc.pathname, e.cleanup.template);
  const [id] = ids ?? [];
  return ids?.length === 1 && id !== undefined && loc.search === ''
    ? id
    : { why: 'the Location path does not match the cleanup template' };
}
