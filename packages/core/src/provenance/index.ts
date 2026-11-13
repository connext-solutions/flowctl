/**
 * Provenance of a flow: whether its expected values come from a person, from a generator, or from nowhere known
 * (ADR 0020). Sits above `run/`: `replay.ts` computes the state and hands it to `RunSession` as an option.
 */
export {
  flowFileChanged,
  flowKey,
  handWrittenDigest,
  listedHandWritten,
  type ProvenanceStore,
} from './hand-written.js';
export { provenanceState, type ProvenanceState } from './state.js';
export { labelFlow } from './label.js';
