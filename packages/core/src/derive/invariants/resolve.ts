import type { Assertion } from '../../flow/index.js';
import { isInvariantId, expandInvariant } from './registry.js';

/** The result of resolving an assertion: it is what the template writes, or the first reason it is not. */
export type Resolution = { ok: true } | { ok: false; reason: string };

/** `value` with its object keys sorted at every depth, so two equal objects print the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * Whether `assertion` is exactly what the template named by its `sourceRef` writes for `params` and `evidence` (ADR
 * 0020 section d: "the assertion must equal what the template expands to"). Whole equality, so an edited status, an
 * extra `within`, a swapped `ref`, a `quote` or a stale binding fails; every other outcome is a refusal. The unit
 * T4.5 signs.
 */
export function invariantResolves(
  assertion: Assertion,
  params: unknown,
  evidence: unknown,
): Resolution {
  const ref = assertion.sourceRef;
  if (ref === undefined) return { ok: false, reason: 'no_source_ref' };
  if (ref.kind !== 'invariant') return { ok: false, reason: 'not_invariant' };
  if (!isInvariantId(ref.ref))
    return { ok: false, reason: 'unknown_invariant' };
  const keys = Object.keys(ref).sort().join(',');
  if (keys !== 'kind,ref') return { ok: false, reason: 'source_ref_extra' };
  const expansion = expandInvariant(ref.ref, evidence, params);
  if (!expansion.ok) return { ok: false, reason: expansion.reason };
  return canonical(expansion.assertion) === canonical(assertion)
    ? { ok: true }
    : { ok: false, reason: 'differs' };
}
