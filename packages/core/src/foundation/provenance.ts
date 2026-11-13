/**
 * The provenance states a run can be labelled with, strongest first (ADR 0020 section h): `verified` (a signed
 * case approval names the flow), `hand-written` (the owner's trust store lists the flow's path and closure digest),
 * `unverified` (the flow claims a derivation and nothing proves it) and `unclassified` (neither).
 *
 * @remarks Lives in `foundation` so `run/` and the CLI can name a state without importing `provenance/`, which sits
 *   above `run/`. The label never changes a verdict (ADR 0004).
 */
export const PROVENANCE_STATES = [
  'verified',
  'hand-written',
  'unverified',
  'unclassified',
] as const;

export type ProvenanceStateName = (typeof PROVENANCE_STATES)[number];
