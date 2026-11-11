import { normalisePath } from '../../browser/index.js';
import { matchRoute, specificity } from './route-match.js';
import { normaliseText } from './text.js';
import type {
  IndexedRoute,
  IndexSkip,
  LabelRecord,
  LookupResult,
  MessageRecord,
  RouteRecord,
} from './types.js';

/**
 * A read-only index of one web app's source: its route table, i18n labels and validator messages, each with file
 * and line. Built by `buildCodeIndex`; the same tree always gives the same index.
 */
export interface CodeIndex {
  /** Every route, ordered by file (byte order), line and path. */
  readonly routes: readonly RouteRecord[];
  /** Every label, ordered by file, line and key. */
  readonly labels: readonly LabelRecord[];
  /** Every validator message, ordered by file and line. */
  readonly messages: readonly MessageRecord[];
  /** Files and strings left out, with the rule each failed, ordered by path and line. */
  readonly skipped: readonly IndexSkip[];
  /** Source files read. */
  readonly files: number;
  /**
   * Labels whose text equals `text` after normalisation (ADR 0020 section d); never a substring match.
   *
   * @example idx.findLabel('Đã gửi đơn').matches[0] // { file: 'src/i18n/vi.json', line: 11, key: '…', … }
   */
  findLabel(text: string): LookupResult<LabelRecord>;
  /**
   * Routes whose pattern matches the concrete path `path` (a path or an absolute URL; query and fragment are
   * dropped, the path is percent-decoded and its dot segments resolved first), most specific first.
   */
  findRoute(path: string): LookupResult<RouteRecord>;
  /** Validator messages whose text equals `text` after normalisation. */
  findMessage(text: string): LookupResult<MessageRecord>;
}

/** Everything a {@link CodeIndex} is made of, already sorted. */
export interface IndexParts {
  routes: IndexedRoute[];
  labels: LabelRecord[];
  messages: MessageRecord[];
  skipped: IndexSkip[];
  files: number;
  maxMatches: number;
}

const capped = <T>(all: readonly T[], max: number): LookupResult<T> => ({
  matches: all.slice(0, max),
  truncated: all.length > max,
  refused: null,
});

const refused = <T>(reason: string): LookupResult<T> => ({
  matches: [],
  truncated: false,
  refused: reason,
});

/** Records grouped by their (already normalised) text. */
function byText<T extends { text: string }>(
  records: readonly T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of records) {
    const list = map.get(r.text);
    if (list === undefined) map.set(r.text, [r]);
    else list.push(r);
  }
  return map;
}

/** The path of a route query, or `undefined` when it is refused. */
function queryPath(raw: string): string | undefined {
  let path = raw;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
    try {
      path = new URL(raw).pathname;
    } catch {
      return undefined;
    }
  }
  path = path.split(/[?#]/)[0] ?? '';
  return normalisePath(path)?.normalize('NFC');
}

/** Compares two specificity vectors, higher first. */
const bySpecificity = (a: number[], b: number[]): number => {
  for (let i = 0; i < a.length; i++) {
    const d = (b[i] ?? 0) - (a[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/** Builds the lookups over sorted index parts. */
export function createCodeIndex(parts: IndexParts): CodeIndex {
  const labels = byText(parts.labels);
  const messages = byText(parts.messages);
  const routes = parts.routes.map((r) => ({
    ...r,
    rank: specificity(r.segments),
  }));
  const textLookup =
    <T>(map: ReadonlyMap<string, T[]>) =>
    (text: string): LookupResult<T> => {
      const n = normaliseText(text);
      if (!n.ok) return refused(n.reason);
      return capped(map.get(n.text) ?? [], parts.maxMatches);
    };
  return Object.freeze({
    routes: Object.freeze(parts.routes.map((r) => r.record)),
    labels: Object.freeze(parts.labels),
    messages: Object.freeze(parts.messages),
    skipped: Object.freeze(parts.skipped),
    files: parts.files,
    findLabel: textLookup(labels),
    findMessage: textLookup(messages),
    findRoute(path: string): LookupResult<RouteRecord> {
      const p = queryPath(path);
      if (p === undefined) return refused('path refused');
      const segs = p.split('/').filter((s) => s !== '');
      const hits = routes
        .filter((r) => matchRoute(r.segments, segs))
        .sort((a, b) => bySpecificity(a.rank, b.rank))
        .map((r) => r.record);
      return capped(hits, parts.maxMatches);
    },
  });
}
