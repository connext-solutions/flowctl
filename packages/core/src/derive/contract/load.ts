import { createHash } from 'node:crypto';
import {
  type ByteBudget,
  type ContainedRoot,
  ContainmentError,
  type ContainmentErrorKind,
  readContained,
} from '../../trust/index.js';
import { type Shared } from './emit.js';
import type { DataNode } from './safe-data.js';

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
const WIDE_BOMS: readonly (readonly number[])[] = [
  [0xff, 0xfe],
  [0xfe, 0xff],
  [0x00, 0x00, 0xfe, 0xff],
];

/** What a read of one file needs: the root, the counters of the whole read, and the parsed files `$ref`s used. */
export interface ReadCtx {
  root: ContainedRoot;
  sh: Shared;
  bytes: ByteBudget;
  trees: Map<
    string,
    { ok: true; tree: DataNode } | { ok: false; reason: string }
  >;
}

/** A file's text and the SHA-256 of its bytes (hex), or the fixed reason it was left out. */
export type FileText =
  | { ok: true; text: string; sha256: string }
  | { ok: false; reason: string; kind?: ContainmentErrorKind };

const isSystemError = (e: unknown): boolean =>
  e instanceof Error && 'code' in e && typeof e.code === 'string';

/**
 * Reads `rel` through the containment helper and decodes it as UTF-8 (a BOM is dropped).
 *
 * @remarks A refused read gives the containment rule as its reason (`no symbolic link`, `file size`,
 *   `no hard link`, ...), a file system error `unreadable`, bytes that are not UTF-8 or hold a NUL byte
 *   `not_utf8`. Bytes are charged to the read's budget as they arrive.
 * @throws {ContainmentError} `path_not_contained` with rule `root changed`, and `too_large` from the byte budget:
 *   both refuse the whole read.
 */
export function readFileText(ctx: ReadCtx, rel: string): FileText {
  let bytes: Buffer;
  try {
    bytes = readContained(ctx.root, rel, {
      maxBytes: ctx.sh.limits.maxFileBytes,
    });
  } catch (e) {
    if (e instanceof ContainmentError && e.rule !== 'root changed')
      return { ok: false, reason: e.rule, kind: e.kind };
    if (!(e instanceof ContainmentError) && isSystemError(e))
      return { ok: false, reason: 'unreadable' };
    throw e;
  }
  ctx.bytes.take(bytes.length);
  if (
    bytes.includes(0) ||
    WIDE_BOMS.some((bom) => bom.every((b, k) => bytes[k] === b))
  )
    return { ok: false, reason: 'not_utf8' };
  try {
    return {
      ok: true,
      text: UTF8.decode(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch {
    return { ok: false, reason: 'not_utf8' };
  }
}

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/i;
const HTML_EXT = /\.html?$/i;
const DATA_EXT = /\.(?:ya?ml|json)$/i;
const I18N_DIR = /(?:^|\/)(?:i18n|locales?|lang|messages|translations?)\//i;

/** The reader a file goes to by its name: `data` (YAML or JSON), `code` (JS or TS), `html`, or none. */
export const kindOf = (rel: string): 'data' | 'code' | 'html' | undefined =>
  DATA_EXT.test(rel)
    ? 'data'
    : SOURCE_EXT.test(rel)
      ? 'code'
      : HTML_EXT.test(rel)
        ? 'html'
        : undefined;

/** Whether a JSON file below a folder named like a message catalogue is read as one. */
export const isCatalogue = (rel: string): boolean =>
  /\.json$/i.test(rel) && I18N_DIR.test(rel);
