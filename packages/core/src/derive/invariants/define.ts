import type { z } from 'zod';
import type { Assertion } from '../../flow/index.js';
import type { Evidence } from './evidence.js';
import { readEvidence, refuse } from './params.js';
import type {
  Binding,
  Expansion,
  InvariantFinding,
  InvariantId,
  InvariantTemplate,
  Refusal,
} from './types.js';

/** What one template says: its id, its strict parameters and the three functions over typed evidence and parameters. */
export interface TemplateSpec<S extends z.ZodType<object>> {
  id: InvariantId;
  params: S;
  bind(evidence: Evidence, params: z.infer<S>): Binding | Refusal;
  evaluate(
    evidence: Evidence,
    params: z.infer<S>,
    binding: Binding,
  ): InvariantFinding[];
  /** The assertion without its `sourceRef`, or the sentence saying why it cannot be written yet. */
  expand(
    evidence: Evidence,
    params: z.infer<S>,
    binding: Binding,
  ): Assertion | string | Refusal;
}

/**
 * Wraps a {@link TemplateSpec} so evidence and parameters are parsed first and a failure is a {@link Refusal}, and so
 * every expansion carries the `sourceRef` `{ kind: 'invariant', ref: id }` the template does not write itself.
 */
export function defineInvariant<S extends z.ZodType<object>>(
  spec: TemplateSpec<S>,
): InvariantTemplate {
  const prepare = (
    evidence: unknown,
    params: unknown,
  ): { e: Evidence; p: z.infer<S>; b: Binding } | Refusal => {
    const e = readEvidence(evidence);
    if ('ok' in e) return e;
    const p = spec.params.safeParse(params);
    if (!p.success)
      return refuse(
        'bad_params',
        'the parameters are not those of the template',
      );
    const b = spec.bind(e, p.data);
    return b.ok ? { e, p: p.data, b } : b;
  };
  return {
    id: spec.id,
    params: spec.params,
    bind(evidence, params) {
      const r = prepare(evidence, params);
      return 'e' in r ? r.b : r;
    },
    evaluate(evidence, params) {
      const r = prepare(evidence, params);
      return 'e' in r
        ? { ok: true, findings: spec.evaluate(r.e, r.p, r.b) }
        : r;
    },
    expand(evidence, params): Expansion | Refusal {
      const r = prepare(evidence, params);
      if (!('e' in r)) return r;
      const out = spec.expand(r.e, r.p, r.b);
      if (typeof out === 'string')
        return { ok: false, reason: 'not_expandable', detail: out };
      if ('ok' in out) return out;
      return {
        ok: true,
        assertion: {
          ...out,
          sourceRef: { kind: 'invariant', ref: spec.id },
        },
      };
    },
  };
}
