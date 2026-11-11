/**
 * The markdown spec adapter (ADR 0023, task T3.2): a folder of markdown documents as `Operation[]`, read through
 * the shared containment helper.
 *
 * @see docs/adr/0023-spec-provider-seam.md
 */
export {
  MAX_SPEC_BYTES,
  type MarkdownSpecOptions,
  markdownSpecProvider,
} from './provider.js';
export { OPERATION_ID, SpecDocError } from './front-matter.js';
