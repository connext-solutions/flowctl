import type { Assertion } from '../../flow/index.js';
import { TrustError, canonicalJson } from '../../trust/index.js';
import { isInvariantId, expandInvariant } from './registry.js';

/** The result of resolving an assertion: it is what the template writes, or the first reason it is not. */
export type Resolution = { ok: true } | { ok: false; reason: string };

/** The canonical JSON of `value` (`canonicalJson` of `trust/`, the form signatures are computed over), or `undefined` when it has none. */
function canonical(value: unknown): string | undefined {
  try {
    return canonicalJson(value);
  } catch (error) {
    if (error instanceof TrustError) return undefined;
    throw error;
  }
}

/**
 * Whether `assertion` is exactly what the template named by its `sourceRef` writes for `params` and `evidence` (ADR
 * 0020 section d: "the assertion must equal what the template expands to"). Whole equality of their canonical JSON,
 * the form T4.5 signs, so an edited text, a changed or dropped `within`, a swapped `ref`, a `quote` or a
 * stale binding fails; a value with no canonical form fails closed (`not_canonical`); every other outcome is a
 * refusal. The unit T4.5 signs.
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
  const want = canonical(expansion.assertion);
  const got = canonical(assertion);
  if (want === undefined || got === undefined)
    return { ok: false, reason: 'not_canonical' };
  return want === got ? { ok: true } : { ok: false, reason: 'differs' };
}
