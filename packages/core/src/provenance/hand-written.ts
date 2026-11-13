import { createHash } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import type { Flow } from '../flow/index.js';
import {
  TrustError,
  canonicalJson,
  computeClosure,
  hashFlowFile,
} from '../trust/index.js';

/** The part of a trust store the provenance state reads: its `handWritten` section. */
export interface ProvenanceStore {
  readonly data: { readonly handWritten: readonly unknown[] };
}

/**
 * The key of a flow in the store's `handWritten` section: its path relative to the flows root, `/` separators
 * (ADR 0020 section o).
 *
 * @returns `undefined` for a flow with no file (an exploration draft) or a file outside the flows root.
 */
export function flowKey(
  flow: Pick<Flow, 'file'>,
  flowsRoot: string,
): string | undefined {
  if (flow.file === '') return undefined;
  const rel = relative(flowsRoot, flow.file);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/**
 * Whether the flow file on disk is no longer the bytes `loadFlow` parsed into `flow` (the file was rewritten or
 * swapped between load and label). A label bound to the file on disk would then describe bytes the run does not use.
 *
 * @returns `false` for a flow that carries no `sourceSha256` (not read from a file) or has no key.
 */
export function flowFileChanged(flow: Flow, flowsRoot: string): boolean {
  if (flow.sourceSha256 === undefined) return false;
  const key = flowKey(flow, flowsRoot);
  if (key === undefined) return false;
  return hashFlowFile(flowsRoot, key) !== flow.sourceSha256;
}

/**
 * The closure digest of a hand-written flow: the sha256 of the canonical JSON
 * `{"v":1,"purpose":"classify","flow":<sha256 of the flow file>,"files":[{path,sha256,kind}],"hooks":{setup,teardown}}`
 * (ADR 0020 section b). Editing the flow, a hook, or a file a hook calls changes it.
 *
 * @remarks It shares the closure function and the file-hashing function with the hook-consent and confirmation
 *   digests; `purpose` keeps one from standing in for another.
 * @remarks Shape: the ADR 0021 section 2.8 text shows `"hooks":{"setup":<closure>,"teardown":<closure>}`, one closure
 *   per hook. This digest instead binds one closure of both hooks (the merged, sorted `files` list) beside the hook
 *   texts: the shared closure function judges a write in `setup` to a script `teardown` runs only over both hooks
 *   together. It binds the same bytes; it is not byte-for-byte the ADR's shape. Whether T4.16 (`trust add
 *   handwritten`, the writer of these entries) adopts the per-hook shape is an open question: the writer and this
 *   reader must change together.
 * @returns the digest, or `''` when the flow cannot be classified: no key, a file that cannot be read safely, the
 *   file no longer the bytes `loadFlow` parsed ({@link flowFileChanged}), or a hook that is `uncovered` or cannot be
 *   shown in full. `''` never matches a stored entry.
 */
export function handWrittenDigest(flow: Flow, flowsRoot: string): string {
  const key = flowKey(flow, flowsRoot);
  if (key === undefined) return '';
  const flowSha256 = hashFlowFile(flowsRoot, key);
  if (flowSha256 === undefined) return '';
  if (flow.sourceSha256 !== undefined && flow.sourceSha256 !== flowSha256)
    return '';
  try {
    const closure = computeClosure({
      root: flowsRoot,
      setup: flow.setup,
      teardown: flow.teardown,
    });
    if (!closure.consentable || closure.uncovered.length > 0) return '';
    const files = closure.files
      .map((f) => ({ path: f.path, sha256: f.sha256, kind: f.kind }))
      .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
    const doc = {
      v: 1,
      purpose: 'classify',
      flow: flowSha256,
      files,
      hooks: { setup: flow.setup ?? null, teardown: flow.teardown ?? null },
    };
    return createHash('sha256').update(canonicalJson(doc)).digest('hex');
  } catch (e) {
    if (e instanceof TrustError) return '';
    throw e;
  }
}

/**
 * Whether the store's `handWritten` section lists this flow's path and closure digest.
 *
 * @remarks The entries are `unknown` in the store schema until `trust add handwritten` (T4.16) writes them, so they
 *   are read defensively: an entry is `{ path: string, closureDigest: string }` or it matches nothing. **Nothing
 *   here checks an entry's signature, and opening the store does not check one either** (the schema has no entry
 *   shape yet): a listing is only as trustworthy as the store file itself, so the label carries the note
 *   `handwritten_entry_unsigned` (see `provenanceState`).
 */
export function listedHandWritten(
  flow: Flow,
  flowsRoot: string,
  store: ProvenanceStore,
): boolean {
  const key = flowKey(flow, flowsRoot);
  if (key === undefined) return false;
  const digest = handWrittenDigest(flow, flowsRoot);
  if (digest === '') return false;
  return store.data.handWritten.some(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      'path' in e &&
      'closureDigest' in e &&
      e.path === key &&
      e.closureDigest === digest,
  );
}
