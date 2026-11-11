import {
  ByteBudget,
  checkRoot,
  type ContainedRoot,
  requirePurpose,
} from '../../trust/index.js';
import { readText, walkAll } from './files.js';
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
import { normaliseText } from './text.js';
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
  /**
   * Folders below the root to walk (relative, checked like any contained path); default: the whole root. Each
   * entry is its own walk, so a build reads at most `dirs.length × maxEntries` directory entries.
   */
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

/** Whether the build reads `rel` (a script or a locale file) or an extractor routes it by its path. */
const wanted =
  (extractors: readonly RouteExtractor[]) =>
  (rel: string): boolean =>
    SCRIPT.test(rel) ||
    localeFileOf(rel) !== undefined ||
    extractors.some((e) => e.fromPath?.(rel) !== undefined);

/**
 * Builds the read-only {@link CodeIndex} of the web app below `root`, a root of purpose `repos` (ADR 0025
 * section 2). Files are listed with `walkContained` (dot folders are not entered; `prune` folders are not entered
 * and are listed in `skipped` as `pruned`; links, hard links, special files, non-NFC names and files over
 * `maxFileBytes` are skipped; any other file that is neither read nor routed by its path, an image or a font, is
 * neither listed nor charged) and read with `readContained` (a file the system refuses to read is `unreadable`);
 * nothing else touches the file system and no process is started (ADR 0035). JavaScript, TypeScript and Vue files
 * are read for routes and validator messages, locale JSON files for labels; a file that is binary, not UTF-8 or
 * not strict JSON is skipped. Texts are normalised as ADR 0020 section d says; a refused text is skipped with its
 * line.
 *
 * @example
 *   const idx = buildCodeIndex(openRoot('/abs/web-app', 'repos'), { dirs: ['src'] });
 *   idx.findLabel('Đã gửi đơn').matches; // [{ file: 'src/i18n/vi.json', line: 11, key: 'request.submitted', … }]
 * @throws {ContainmentError} `path_not_contained` for a root of another purpose, a `dirs` entry that is not a
 *   plain relative path to a real folder inside the root, or a root that changed at any point of the build (rule
 *   `root changed`, checked again after the last read); `not_found` for a missing `dirs` entry; `too_large` past
 *   `maxEntries`, `maxBytes` (walked or read), `maxFiles` or `maxRecords` (records and skipped entries together;
 *   the build is refused, never returned in part).
 * @see docs/adr/0035-code-index.md
 */
export function buildCodeIndex(
  root: ContainedRoot,
  opts: CodeIndexOptions = {},
): CodeIndex {
  requirePurpose(root, 'repos');
  const lim = { ...CODE_INDEX_LIMITS, ...opts.limits };
  const extractors = opts.routes ?? ROUTE_EXTRACTORS;
  const walked = walkAll(
    root,
    {
      dirs: opts.dirs,
      prune: opts.prune ?? PRUNED_DIRS,
      include: wanted(extractors),
    },
    lim,
  );
  const fileBudget = new ByteBudget(lim.maxFiles, 'source files');
  const byteBudget = new ByteBudget(lim.maxBytes, 'bytes read');
  const recordBudget = new ByteBudget(lim.maxRecords, 'index records');
  const skipped: IndexSkip[] = [];
  const skip = (s: IndexSkip): void => {
    recordBudget.take(1);
    skipped.push(s);
  };
  walked.skipped.forEach(skip);
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
    skip({ path: r.file, line: r.line, rule: n.reason });
    return undefined;
  };

  for (const path of [...walked.files.keys()].sort(cmp)) {
    const script = SCRIPT.test(path);
    const locale = !script && localeFileOf(path) !== undefined;
    let text: string | undefined;
    if (script || locale) {
      fileBudget.take(1);
      const read = readText(root, path, lim.maxFileBytes);
      byteBudget.take(read.bytes);
      if ('rule' in read) skip({ path, rule: read.rule });
      else text = read.text;
    }
    if (locale && text !== undefined) {
      const found = labelsInJson(path, text);
      if (found === undefined) skip({ path, rule: 'invalid json' });
      for (const l of found ?? []) {
        const r = normalised(l);
        if (r !== undefined) labels.push(r);
      }
      continue;
    }
    const src = script ? text : undefined;
    let toks: Token[] | undefined;
    const tokens = (): Token[] => (toks ??= lex(src ?? ''));
    const found = extractRoutes(path, src, extractors, tokens);
    for (const s of found.skipped) skip({ path, line: s.line, rule: s.rule });
    for (const r of found.routes) {
      const pattern = r.path.normalize('NFC');
      const segments = parseRoutePattern(pattern);
      if (segments.length > MAX_ROUTE_SEGMENTS) {
        skip({ path, line: r.line, rule: 'route too long' });
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
  checkRoot(root);

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
