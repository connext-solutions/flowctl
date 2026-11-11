import type { RouteSegment } from './route-match.js';

/** Where a record was found: a `/`-separated path relative to the root, and a 1-based line. */
export interface SourceLocation {
  file: string;
  line: number;
}

/**
 * A route declaration: `path` is the full pattern after joining parent routes (`/orders/:id`), `pattern` the
 * text as declared (`:id`, or the file path's segment form for a file route), `source` the extractor that found it.
 */
export interface RouteRecord extends SourceLocation {
  path: string;
  pattern: string;
  source: string;
}

/** An i18n label: its dotted key, its text (normalised, ADR 0020 section d) and the file's locale when known. */
export interface LabelRecord extends SourceLocation {
  key: string;
  text: string;
  locale: string | null;
}

/** A validator message literal (normalised), and what carried it: `min()` for a call, `message:` for a property. */
export interface MessageRecord extends SourceLocation {
  text: string;
  via: string;
}

/** A file, or one string in a file (with its line), the index left out, and the rule it failed. */
export interface IndexSkip {
  path: string;
  rule: string;
  line?: number;
}

/** The answer to one lookup: at most `maxMatches` records, and whether more matched; `refused` names a refused query. */
export interface LookupResult<T> {
  readonly matches: readonly T[];
  readonly truncated: boolean;
  readonly refused: string | null;
}

/** Bounds of one index build and its lookups. */
export interface CodeIndexLimits {
  /** Source files read (JavaScript, TypeScript, Vue and locale JSON); more refuses the build. */
  maxFiles: number;
  /** Directory entries of one walk (each `dirs` entry is one walk); more refuses the build. */
  maxEntries: number;
  /** Bytes in a walked tree and bytes read in total; more refuses the build. */
  maxBytes: number;
  /** Size of one file; a larger file is skipped, not read. */
  maxFileBytes: number;
  /** Routes, labels, messages and skipped entries together; more refuses the build. */
  maxRecords: number;
  /** Records one lookup returns. */
  maxMatches: number;
}

/** The default bounds: 5,000 files, 10,000 entries per walk, 64 MiB, 1 MiB per file, 100,000 records, 20 matches. */
export const CODE_INDEX_LIMITS: CodeIndexLimits = {
  maxFiles: 5_000,
  maxEntries: 10_000,
  maxBytes: 64 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  maxRecords: 100_000,
  maxMatches: 20,
};

/**
 * Folder names a build never enters: dependencies, build output and caches; each one met is listed in `skipped`
 * with rule `pruned`. Dot folders are never entered either, and not listed.
 */
export const PRUNED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  'target',
]);

/** A route with its parsed pattern, kept for matching. */
export interface IndexedRoute {
  record: RouteRecord;
  segments: RouteSegment[];
}
