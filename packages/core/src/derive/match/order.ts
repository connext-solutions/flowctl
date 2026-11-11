import type {
  MatchEvidence,
  MatchEvidenceKind,
  MapElement,
  SpecSpan,
} from './types.js';

/** A sort key: compared element by element, numbers before strings, strings by UTF-16 code units. */
export type SortKey = readonly (string | number)[];

/** Orders two {@link SortKey}s; a key that is a prefix of the other comes first. */
export function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y || x === undefined || y === undefined) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'string' && typeof y === 'string') return x < y ? -1 : 1;
    return typeof x === 'number' ? -1 : 1;
  }
  return a.length - b.length;
}

const ELEMENT_ORDER: Readonly<Record<MapElement['kind'], number>> = {
  title: 0,
  path: 1,
  control: 2,
  field: 3,
};

/** The evidence kinds in report order: route evidence first, then labels. */
export const KIND_ORDER: Readonly<Record<MatchEvidenceKind, number>> = {
  'title-equal': 0,
  'path-literal': 1,
  'title-mention': 2,
  'doc-segment': 3,
  label: 4,
};

/** The sort key of a map element: page, kind, form, index. */
export const elementKey = (e: MapElement): SortKey => [
  e.page,
  ELEMENT_ORDER[e.kind],
  e.kind === 'field' ? e.form : -1,
  e.kind === 'field' || e.kind === 'control' ? e.index : -1,
];

/** The sort key of a spec span: its path, then its offsets. */
export const spanKey = (s: SpecSpan): SortKey => [...s.path, s.start, s.end];

/** Orders evidence by kind, spec span, then map element. */
export function compareEvidence(a: MatchEvidence, b: MatchEvidence): number {
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  if (byKind !== 0) return byKind;
  const bySpan = compareKeys(spanKey(a.spec), spanKey(b.spec));
  if (bySpan !== 0) return bySpan;
  return compareKeys(elementKey(a.element), elementKey(b.element));
}
