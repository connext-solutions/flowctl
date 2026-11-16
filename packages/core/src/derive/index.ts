/**
 * Derive (roadmap section 3.4): spec operations joined with the `AppMap`. Today the matcher (T4.1), the case drafter
 * (T4.2), the conflicts file (T4.4), the contract readers (T4.10) and the invariant library (T4.9); not exported from
 * the package yet.
 *
 * @see docs/adr/0034-spec-to-map-matching.md
 * @see docs/adr/0038-case-drafter.md
 * @see docs/adr/0040-contract-readers.md
 * @see docs/adr/0041-invariant-templates.md
 */
export * from './match/index.js';
export * from './draft/index.js';
export { hideInvisible, mdCode } from './escape.js';
export {
  type Conflict,
  type ConflictKind,
  conflictsJson,
  conflictsMarkdown,
  findConflicts,
  writeConflicts,
} from './conflicts.js';
export * from './contract/index.js';
export * from './invariants/index.js';
