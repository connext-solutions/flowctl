import {
  ByteBudget,
  type ContainedRoot,
  ContainmentError,
  readContained,
  requirePurpose,
  walkContained,
} from '../../trust/index.js';
import { labelsInJson, localeFileOf } from './labels.js';
import { lex, type Token } from './lexer.js';
import { createCodeIndex, type CodeIndex } from './lookup.js';
import { messagesInSource } from './messages.js';
import { MAX_ROUTE_SEGMENTS, parseRoutePattern } from './route-match.js';
import {
  extractRoutes,
  ROUTE_EXTRACTORS,
  type RouteExtractor,
} from './routes.js';
import { decodeSource, normaliseText } from './text.js';
import {
  CODE_INDEX_LIMITS,
  type CodeIndexLimits,
  type IndexedRoute,
  type IndexSkip,
  type LabelRecord,
  type MessageRecord,
  PRUNED_DIRS,
} from './types.js';

/** How to build a {@link CodeIndex}. */
export interface CodeIndexOptions {
  /** Folders below the root to walk (relative, checked like any contained path); default: the whole root. */
  dirs?: readonly string[];
  /** Bounds; unset ones take {@link CODE_INDEX_LIMITS}. */
  limits?: Partial<CodeIndexLimits>;
  /** Route extractors, in report order; default {@link ROUTE_EXTRACTORS}. */
  routes?: readonly RouteExtractor[];
  /** Folder names never entered; default {@link PRUNED_DIRS}. */
  prune?: ReadonlySet<string>;
}

const SCRIPT = /\.(?:[cm]?[jt]sx?|vue)$/;

const cmp = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

/** Orders records by file (byte order), then line, then `tie`. */
const byPlace =
  <T extends { file: string; line: number }>(tie: (r: T) => string) =>
  (a: T, b: T): number =>
    cmp(a.file, b.file) || a.line - b.line || cmp(tie(a), tie(b));

/** Every file of the walks over `dirs`, by path, with the walks' skipped entries; overlapping folders count once. */
function walkAll(
  root: ContainedRoot,
  opts: CodeIndexOptions,
  lim: CodeIndexLimits,
): { files: Map<string, number>; skipped: IndexSkip[] } {
  const files = new Map<string, number>();
  const skipped = new Map<string, IndexSkip>();
  const subs: (string | undefined)[] =
    opts.dirs === undefined ? [undefined] : [...opts.dirs];
  for (const sub of subs) {
    const walked = walkContained(
      root,
      {
        maxEntries: lim.maxEntries,
        maxBytes: lim.maxBytes,
        maxFileBytes: lim.maxFileBytes,
      },
      sub,
      { prune: opts.prune ?? PRUNED_DIRS },
    );
    for (const f of walked.files) files.set(f.path, f.size);
    for (const s of walked.skipped) skipped.set(`${s.path}\0${s.rule}`, s);
  }
  return { files, skipped: [...skipped.values()] };
}

/** The bytes of `path` decoded, or the rule that left it out. */
function readText(
  root: ContainedRoot,
  path: string,
  maxBytes: number,
): { text: string } | { rule: string } {
  let bytes: Buffer;
  try {
    bytes = readContained(root, path, { maxBytes });
  } catch (e) {
    if (e instanceof ContainmentError && e.kind !== 'too_large')
      return { rule: e.rule };
    if (e instanceof ContainmentError) return { rule: 'file size' };
    throw e;
  }
  const decoded = decodeSource(bytes);
  return decoded.ok ? { text: decoded.text } : { rule: decoded.rule };
}

/**
 * Builds the read-only {@link CodeIndex} of the web app below `root`, a root of purpose `repos` (ADR 0025
 * section 2). Files are listed with `walkContained` (dot folders and `prune` folders are not entered; links, hard
 * links, special files, non-NFC names and files over `maxFileBytes` are skipped) and read with `readContained`;
 * nothing else touches the file system and no process is started (ADR 0035). JavaScript, TypeScript and Vue files
 * are read for routes and validator messages, locale JSON files for labels; a file that is binary, not UTF-8 or
 * not strict JSON is skipped. Texts are normalised as ADR 0020 section d says; a refused text is skipped with its
 * line.
 *
 * @example
 *   const idx = buildCodeIndex(openRoot('/abs/web-app', 'repos'), { dirs: ['src'] });
 *   idx.findLabel('Đã gửi đơn').matches; // [{ file: 'src/i18n/vi.json', line: 11, key: 'request.submitted', … }]
 * @throws {ContainmentError} `path_not_contained` for a root of another purpose, a `dirs` entry that is not a
 *   plain relative path to a real folder inside the root, or a root that changed; `not_found` for a missing
 *   `dirs` entry; `too_large` past `maxEntries`, `maxBytes`, `maxFiles` or `maxRecords` (the build is refused,
 *   never returned in part).
 * @see docs/adr/0035-code-index.md
 */
export function buildCodeIndex(
  root: ContainedRoot,
  opts: CodeIndexOptions = {},
): CodeIndex {
  requirePurpose(root, 'repos');
  const lim = { ...CODE_INDEX_LIMITS, ...opts.limits };
  const extractors = opts.routes ?? ROUTE_EXTRACTORS;
  const walked = walkAll(root, opts, lim);
  const skipped = walked.skipped;
  const fileBudget = new ByteBudget(lim.maxFiles, 'source files');
  const byteBudget = new ByteBudget(lim.maxBytes, 'bytes read');
  const recordBudget = new ByteBudget(lim.maxRecords, 'index records');
  const routes: IndexedRoute[] = [];
  const labels: LabelRecord[] = [];
  const messages: MessageRecord[] = [];
  const normalised = <T extends { file: string; line: number; text: string }>(
    r: T,
  ): T | undefined => {
    const n = normaliseText(r.text);
    if (n.ok) {
      recordBudget.take(1);
      return { ...r, text: n.text };
    }
    skipped.push({ path: r.file, line: r.line, rule: n.reason });
    return undefined;
  };

  for (const path of [...walked.files.keys()].sort(cmp)) {
    const size = walked.files.get(path) ?? 0;
    const script = SCRIPT.test(path);
    const locale = !script && localeFileOf(path) !== undefined;
    let text: string | undefined;
    if (script || locale) {
      fileBudget.take(1);
      byteBudget.take(size);
      const read = readText(root, path, lim.maxFileBytes);
      if ('rule' in read) skipped.push({ path, rule: read.rule });
      else text = read.text;
    }
    if (locale && text !== undefined) {
      const found = labelsInJson(path, text);
      if (found === undefined) skipped.push({ path, rule: 'invalid json' });
      for (const l of found ?? []) {
        const r = normalised(l);
        if (r !== undefined) labels.push(r);
      }
      continue;
    }
    const src = script ? text : undefined;
    let toks: Token[] | undefined;
    const tokens = (): Token[] => (toks ??= lex(src ?? ''));
    for (const r of extractRoutes(path, src, extractors, tokens)) {
      const pattern = r.path.normalize('NFC');
      const segments = parseRoutePattern(pattern);
      if (segments.length > MAX_ROUTE_SEGMENTS) {
        skipped.push({ path, line: r.line, rule: 'route too long' });
        continue;
      }
      recordBudget.take(1);
      routes.push({
        record: {
          file: path,
          line: r.line,
          path: pattern,
          pattern: r.pattern,
          source: r.source,
        },
        segments,
      });
    }
    if (src !== undefined)
      for (const m of messagesInSource(path, src, tokens)) {
        const r = normalised(m);
        if (r !== undefined) messages.push(r);
      }
  }

  routes.sort((a, b) =>
    byPlace<IndexedRoute['record']>((r) => `${r.path}\0${r.source}`)(
      a.record,
      b.record,
    ),
  );
  labels.sort(byPlace((r) => `${r.key}\0${r.text}`));
  messages.sort(byPlace((r) => `${r.text}\0${r.via}`));
  skipped.sort(
    (a, b) =>
      cmp(a.path, b.path) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      cmp(a.rule, b.rule),
  );
  return createCodeIndex({
    routes,
    labels,
    messages,
    skipped,
    files: fileBudget.total,
    maxMatches: lim.maxMatches,
  });
}
