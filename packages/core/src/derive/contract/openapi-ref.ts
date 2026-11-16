import { posix } from 'node:path';
import type { ByteBudget } from '../../trust/index.js';
import { type DataNode, nodeAt, textAt } from './safe-data.js';

/** Reads and parses another file of the same root for a `$ref`: the tree, or the fixed reason it was refused. */
export type RefLoader = (
  rel: string,
) => { ok: true; tree: DataNode } | { ok: false; reason: string };

/** The file a `$ref` is read from, and what is needed to follow it. */
export interface RefScope {
  file: string;
  tree: DataNode;
  load: RefLoader;
  refs: ByteBudget;
  maxString: number;
}

/** A node a reference points at, with its file and pointer segments, or the reason it was refused. */
export type Resolved =
  | {
      ok: true;
      node: DataNode;
      file: string;
      path: string[];
      sameFile: boolean;
    }
  | { ok: false; reason: string };

/** Most `$ref`s followed in a chain; a cycle runs out of hops. */
export const MAX_HOPS = 32;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/** The JSON Pointer segments of a fragment (`/a/b~1c`), percent- and `~`-decoded, or `undefined` when malformed. */
function fragmentPath(
  fragment: string,
  maxString: number,
): string[] | undefined {
  if (fragment === '') return [];
  if (!fragment.startsWith('/') || fragment.length > maxString)
    return undefined;
  const out: string[] = [];
  for (const raw of fragment.slice(1).split('/')) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return undefined;
    }
    seg = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (FORBIDDEN.has(seg)) return undefined;
    out.push(seg);
  }
  return out;
}

/** The file part of a reference, as a path inside the root, or the reason it is refused. */
function targetFile(
  from: string,
  part: string,
): { ok: true; rel: string } | { ok: false; reason: string } {
  if (
    SCHEME.test(part) ||
    part.startsWith('/') ||
    part.startsWith('\\') ||
    part.includes('\\') ||
    part.includes('\0') ||
    part.startsWith('~') ||
    /%(?:2e|2f|5c)/i.test(part)
  )
    return { ok: false, reason: 'ref_remote_or_absolute' };
  const rel = posix.normalize(posix.join(posix.dirname(from), part));
  return rel.startsWith('..') || rel === '.'
    ? { ok: false, reason: 'ref_outside_root' }
    : { ok: true, rel };
}

/**
 * Follows the `$ref` string `ref` found in `scope.file`: a `#/pointer` inside the same document, or
 * `other.yaml#/pointer` to a file below the same root (read through the containment helper). A reference with a
 * scheme (`http:`, `file:`), an absolute or backslash path, a path that leaves the root, an anchor (`#name`) or
 * a pointer through a prototype name is refused; so is a chain of more than {@link MAX_HOPS} references, which
 * also ends a cycle. Every hop is charged to `scope.refs`.
 *
 * @returns the node the chain ends at; `sameFile` is false when it is in another file, whose pointers are not
 *   this file's.
 * @throws {ContainmentError} `too_large` when the reference budget of the file is used up.
 */
export function resolveRef(ref: string, scope: RefScope): Resolved {
  let current = ref;
  let file = scope.file;
  let tree = scope.tree;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    scope.refs.take(1);
    const hash = current.indexOf('#');
    const filePart = hash < 0 ? current : current.slice(0, hash);
    const path = fragmentPath(
      hash < 0 ? '' : current.slice(hash + 1),
      scope.maxString,
    );
    if (path === undefined) return { ok: false, reason: 'ref_bad_pointer' };
    if (filePart !== '') {
      const target = targetFile(file, filePart);
      if (!target.ok) return target;
      const loaded = scope.load(target.rel);
      if (!loaded.ok) return loaded;
      file = target.rel;
      tree = loaded.tree;
    }
    const node = nodeAt(tree, path);
    if (node === undefined) return { ok: false, reason: 'ref_not_found' };
    const next = textAt(node, '$ref');
    if (next === undefined)
      return { ok: true, node, file, path, sameFile: file === scope.file };
    current = next;
  }
  return { ok: false, reason: 'ref_chain_too_long' };
}
