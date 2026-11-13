import { z } from 'zod';
import { INVISIBLE_CLASS } from '../foundation/index.js';

/** The longest `ref` or `author` a `sourceRef` holds. */
export const MAX_REF_CHARS = 500;

const HIDDEN = new RegExp(`[${INVISIBLE_CLASS}]`, 'u');
const HIDDEN_IN_QUOTE = new RegExp(`(?![\\n\\t])[${INVISIBLE_CLASS}]`, 'u');

/** No invisible or control code point (ADR 0020 section d: `INVISIBLE_CLASS`), so nothing steers or hides text. */
const hasNoControl = (text: string): boolean => !HIDDEN.test(text);

/**
 * A quote is multi-line spec text: it may hold `\n`, `\r\n` (a CRLF spec) and `\t`, but no other invisible or
 * control code point (a lone `\r` included).
 */
const quoteHasNoControl = (text: string): boolean =>
  !HIDDEN_IN_QUOTE.test(text.replace(/\r\n/g, '\n'));

const Label = z
  .string()
  .min(1)
  .max(MAX_REF_CHARS)
  .refine(hasNoControl, 'no control or invisible characters');

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex sha256');

/** The longest quote a `sourceRef` holds (ADR 0020 section d: the default cap). */
export const MAX_QUOTE_CHARS = 500;

/**
 * Where one expected item of an assertion comes from: spec text, a contract symbol, an invariant or a baseline
 * (ADR 0020 section a). It rides on an assertion of a flow marked `derived: true`.
 *
 * @remarks `author` and `review` are metadata the trust store or signed metadata is the source of; a flow file
 *   can carry them, but nothing may trust them there (the provenance state ignores them). `quote` is spec text,
 *   which is untrusted: it is never expanded as a template and never shown to a model as fact (see
 *   {@link withoutSourceRef}). A `spec` reference needs `quote`, `quoteSha256`, `contextSha256` and `revision`.
 * @see docs/adr/0020-assertion-provenance.md
 */
export const SourceRefSchema = z
  .object({
    kind: z.enum(['spec', 'contract', 'invariant', 'baseline']),
    ref: Label,
    quote: z
      .string()
      .max(MAX_QUOTE_CHARS)
      .refine(quoteHasNoControl, 'no control or invisible characters')
      .optional(),
    quoteSha256: Sha256.optional(),
    contextSha256: Sha256.optional(),
    revision: z.number().int().nonnegative().optional(),
    author: Label.optional(),
    review: z.enum(['reviewed', 'unreviewed']).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.kind !== 'spec') return;
    for (const field of [
      'quote',
      'quoteSha256',
      'contextSha256',
      'revision',
    ] as const)
      if (r[field] === undefined)
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: `a spec sourceRef needs ${field}`,
        });
  });
export type SourceRef = z.infer<typeof SourceRefSchema>;

/**
 * Whether a flow claims to be derived: it carries the `derived` marker or any `sourceRef`. A claim is a label,
 * never proof (ADR 0020 section b).
 */
export const claimsDerivation = (flow: {
  derived?: true;
  assertions: readonly { sourceRef?: SourceRef }[];
}): boolean =>
  flow.derived === true ||
  flow.assertions.some((a) => a.sourceRef !== undefined);
