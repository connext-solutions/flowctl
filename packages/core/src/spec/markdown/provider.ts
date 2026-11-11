import { createHash } from 'node:crypto';
import { ConfigError } from '../../foundation/index.js';
import {
  type ContainedRoot,
  ContainmentError,
  readContained,
  requirePurpose,
  walkContained,
} from '../../trust/index.js';
import {
  MAX_SIGNATURE_BYTES,
  type SpecProvider,
  type SpecQuery,
} from '../registry.js';
import type { Operation, SpecRef } from '../schema.js';
import { SpecDocError } from './front-matter.js';
import { parseMarkdown } from './parse.js';

/** The largest markdown document read, in bytes; a larger one is skipped. */
export const MAX_SPEC_BYTES = 1024 * 1024;

/** Options of {@link markdownSpecProvider}. */
export interface MarkdownSpecOptions {
  /** The registered name, and every operation's `location.provider`; default `markdown`. */
  name?: string;
  /**
   * Called for each document or entry left out, with the reason (`spec_path_not_nfc`, `front_matter_invalid`,
   * `not_utf8`, `file size`, `no symbolic link`, ...). Core never logs; the caller decides what to show.
   */
  onSkip?: (path: string, reason: string) => void;
}

const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/** A `.md` file other than a `README.md` (any case), which describes its folder and is not an operation. */
const isSpecDoc = (path: string): boolean =>
  path.endsWith('.md') &&
  (path.split('/').at(-1) ?? '').toLowerCase() !== 'readme.md';

/** Reads a document, or `null` when it does not exist; other refusals propagate. */
function readOrNull(
  root: ContainedRoot,
  rel: string,
  maxBytes: number,
): Buffer | null {
  try {
    return readContained(root, rel, { maxBytes });
  } catch (e) {
    if (e instanceof ContainmentError && e.kind === 'not_found') return null;
    throw e;
  }
}

/**
 * A {@link SpecProvider} over a folder of markdown documents (ADR 0023, task T3.2): one operation per `.md` file
 * (a `README.md` describes its folder and is not read),
 * read only through the containment helper from a root of purpose `specs`. See `parseMarkdown` for how a
 * document becomes an operation (front matter or headings, ordered entries as steps, unordered entries as
 * expected items with their own `ref` and `context`). The revision of a document is the sha256 of its bytes.
 *
 * A document is left out (and reported to `onSkip`) when its path is not NFC (`spec_path_not_nfc`, ADR 0023
 * Amendment 2026-11-02), when the walk refuses it (a link, a hard link, not a regular file, over
 * {@link MAX_SPEC_BYTES}), or when it is not UTF-8 or its front matter is unsafe. `signatureRef` is
 * `<path>.sig` when that file exists beside it, else `null`.
 *
 * @remarks Not registered anywhere yet: the `specs:` config list belongs to T1.1, which builds this provider
 *   from a store-recorded root and registers it with `SpecRegistry.register`.
 * @example
 *   const specs = new SpecRegistry();
 *   specs.register(markdownSpecProvider(openRoot('/abs/specs', 'specs')));
 *   const ops = await specs.operations('markdown');
 * @throws {ContainmentError} at creation, for a root whose purpose is not `specs`.
 */
export function markdownSpecProvider(
  root: ContainedRoot,
  opts: MarkdownSpecOptions = {},
): SpecProvider {
  requirePurpose(root, 'specs');
  const name = opts.name ?? 'markdown';
  const skip = (path: string, reason: string): void =>
    opts.onSkip?.(path, reason);

  const load = (path: string, sigs: ReadonlySet<string>): Operation | null => {
    const bytes = readOrNull(root, path, MAX_SPEC_BYTES);
    if (bytes === null) return null;
    const sig = `${path}.sig`;
    return parseMarkdown(
      { path, bytes, revision: sha256(bytes) },
      name,
      sigs.has(sig) ? sig : null,
    );
  };

  return {
    name,

    /**
     * Every operation of the root, in path order.
     *
     * @throws {ContainmentError} when the tree passes a walk bound or the root changed.
     * @throws {ConfigError} when two documents declare the same operation id.
     */
    async operations(query?: SpecQuery): Promise<unknown[]> {
      const { files, skipped } = walkContained(root, {
        maxFileBytes: MAX_SPEC_BYTES,
      });
      for (const s of skipped)
        skip(s.path, s.rule === 'not_nfc' ? 'spec_path_not_nfc' : s.rule);
      const paths = new Set(files.map((f) => f.path));
      const seen = new Map<string, string>();
      const ops: Operation[] = [];
      for (const path of paths) {
        if (!isSpecDoc(path)) continue;
        let op: Operation | null;
        try {
          op = load(path, paths);
        } catch (e) {
          if (!(e instanceof SpecDocError || e instanceof ContainmentError))
            throw e;
          skip(path, e instanceof SpecDocError ? e.reason : e.rule);
          continue;
        }
        if (op === null) continue;
        const other = seen.get(op.id);
        if (other !== undefined)
          throw new ConfigError(
            `spec documents ${other} and ${path} both declare the operation id "${op.id}"; give each document its own id`,
          );
        seen.set(op.id, path);
        if (query?.ids === undefined || query.ids.includes(op.id)) ops.push(op);
      }
      return ops;
    },

    /**
     * The current text of the expected item at `ref` (same document, section and line range), or `null` when the
     * document or the item is gone or the document no longer parses.
     *
     * @throws {ContainmentError} `path_not_contained` for a `ref.doc` outside the root or through a link.
     */
    async resolve(
      ref: SpecRef,
    ): Promise<{ quote: string; revision: string } | null> {
      if (!isSpecDoc(ref.doc)) return null;
      let op: Operation | null;
      try {
        op = load(ref.doc, new Set());
      } catch (e) {
        if (e instanceof SpecDocError) return null;
        throw e;
      }
      const item = op?.expected.find(
        (x) =>
          x.ref.section === ref.section &&
          x.ref.lines?.[0] === ref.lines?.[0] &&
          x.ref.lines?.[1] === ref.lines?.[1],
      );
      return item === undefined
        ? null
        : { quote: item.text, revision: item.ref.revision };
    },

    /**
     * The raw bytes of `<doc>.md.sig`, or `null` when there is none.
     *
     * @throws {ContainmentError} `path_not_contained` for a ref outside the root (including `../../x`), `too_large`
     *   with rule `signature_too_large` past {@link MAX_SIGNATURE_BYTES}; the registry reads either as unsigned.
     */
    async signatures(
      signatureRef: string,
    ): Promise<{ bytes: Uint8Array; revision: string } | null> {
      if (!signatureRef.endsWith('.md.sig')) return null;
      let bytes: Buffer | null;
      try {
        bytes = readOrNull(root, signatureRef, MAX_SIGNATURE_BYTES);
      } catch (e) {
        if (e instanceof ContainmentError && e.kind === 'too_large')
          throw new ContainmentError(
            'too_large',
            'signature_too_large',
            e.message,
          );
        throw e;
      }
      return bytes === null
        ? null
        : { bytes: new Uint8Array(bytes), revision: sha256(bytes) };
    },
  };
}
