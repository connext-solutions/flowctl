/**
 * Spec sources (ADR 0023): the normalised `Operation` and the `SpecProvider` seam with explicit registration.
 * The markdown adapter (T3.2) is the first core adapter; core imports no plugin.
 *
 * @see docs/adr/0023-spec-provider-seam.md
 */
export {
  ExpectedContextSchema,
  ExpectedItemSchema,
  OperationSchema,
  SpecRefSchema,
  type ExpectedItem,
  type Operation,
  type SpecRef,
} from './schema.js';
export {
  MAX_SIGNATURE_BYTES,
  SpecRegistry,
  type SpecProvider,
  type SpecQuery,
} from './registry.js';
export {
  MAX_SPEC_BYTES,
  type MarkdownSpecOptions,
  markdownSpecProvider,
  OPERATION_ID,
  SpecDocError,
} from './markdown/index.js';
