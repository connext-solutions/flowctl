/** The three sources of the required revision (ADR 0020 Amendment 2026-11-02 section l); each is absent, not 0, when missing. */
export interface RevisionSources {
  floor?: number;
  latest?: number;
  mergeBase?: number;
}

/**
 * `R = max(flowFloors, latestRevision, mergeBaseRevision)` over the values that exist.
 *
 * @returns `required` (absent when no source has a value) and `rollbackNotChecked`, true if and only if all three
 *   sources are absent.
 */
export function requiredRevision(sources: RevisionSources): {
  required?: number;
  rollbackNotChecked: boolean;
} {
  const values = [sources.floor, sources.latest, sources.mergeBase].filter(
    (v): v is number => v !== undefined,
  );
  if (values.length === 0) return { rollbackNotChecked: true };
  return { required: Math.max(...values), rollbackNotChecked: false };
}
