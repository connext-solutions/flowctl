import { createHash } from 'node:crypto';
import type { Assertion, Flow } from '../flow/index.js';
import { canonicalJson } from '../trust/index.js';

const sha256 = (s: string): string =>
  createHash('sha256').update(s).digest('hex');

/**
 * The canonical hash of the whole flow content (ADR 0020 section f): sha256 of `flowctl-flow-content/1` and the
 * canonical JSON of the parsed document, so key order, comments and layout in the file do not matter and any change
 * to a step, an input, an assertion, a `sourceRef`, a hook path or a marker does.
 *
 * @remarks Only the document is hashed, never the loader's extras (`file`, `parsedSteps`, `sourceSha256`). A hook's
 *   bytes are not in it: they are consented separately by closure digest (ADR 0021).
 */
export function flowContentHash(flow: Flow): string {
  const { file: _f, parsedSteps: _p, sourceSha256: _s, ...doc } = flow;
  return sha256(`flowctl-flow-content/1\n${canonicalJson(doc)}`);
}

/** The hash of one assertion, as the approval records it. */
export const assertionHash = (assertion: Assertion): string =>
  sha256(`flowctl-assertion/1\n${canonicalJson(assertion)}`);

/** sha256 of the canonical JSON of `value`: the hash of a redaction-safe replay summary or an AppMap evidence slice. */
export const evidenceHash = (value: unknown): string =>
  sha256(`flowctl-evidence/1\n${canonicalJson(value)}`);
