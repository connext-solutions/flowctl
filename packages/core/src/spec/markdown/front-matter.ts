import { isMap, isScalar, parseDocument } from 'yaml';
import { z } from 'zod';
import { ConfigError } from '../../foundation/index.js';

/**
 * A document the markdown adapter leaves out, with the reason a caller can report (`front_matter_invalid`,
 * `not_utf8`, ...). It never carries the document's text.
 */
export class SpecDocError extends ConfigError {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** The front-matter block is at most this many bytes and lines, so a bomb is refused before YAML sees it. */
export const MAX_FRONT_MATTER_BYTES = 16 * 1024;
const MAX_FRONT_MATTER_LINES = 200;
const KEYS = new Set(['id', 'title', 'actor', 'preconditions']);

/** An operation id: letters, digits, `.`, `_` and `-`, at most 128 characters, starting with a letter or digit. */
export const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const NonEmpty = z.string().refine((s) => s.trim() !== '', 'must not be empty');

const FrontMatterSchema = z
  .object({
    id: z
      .string()
      .regex(OPERATION_ID, 'must be letters, digits, ".", "_" or "-"'),
    title: NonEmpty,
    actor: NonEmpty.optional(),
    preconditions: z.array(NonEmpty).max(50).optional(),
  })
  .strict();

/** The fields front matter may set. */
export type FrontMatter = z.infer<typeof FrontMatterSchema>;

const invalid = (doc: string, why: string): SpecDocError =>
  new SpecDocError(
    'front_matter_invalid',
    `${doc}: front matter is refused (${why}); allowed are plain "id", "title", "actor" and "preconditions"`,
  );

/**
 * Splits off a front-matter block (`---` on line 1 up to the next `---` line) and parses it with a safe schema
 * (ADR 0023 provider rule 4): the YAML failsafe schema (every scalar is a string, no type coercion), no custom or
 * unknown tags, no anchors or aliases, no merge keys, unique keys, and only the keys of {@link FrontMatter}, so
 * `__proto__`, `constructor` and `prototype` are refused.
 *
 * @param lines the document's lines, without line endings.
 * @returns the parsed fields (or `null` when the document has no front matter) and the index of the first body
 *   line.
 * @throws {SpecDocError} `front_matter_invalid` for an unclosed, oversized or unsafe block.
 */
export function splitFrontMatter(
  doc: string,
  lines: readonly string[],
): { meta: FrontMatter | null; body: number } {
  if (lines[0] !== '---') return { meta: null, body: 0 };
  const end = lines.findIndex((l, i) => i > 0 && l === '---');
  if (end === -1 || end > MAX_FRONT_MATTER_LINES)
    throw invalid(
      doc,
      `no closing "---" within ${MAX_FRONT_MATTER_LINES} lines`,
    );
  const src = lines.slice(1, end).join('\n');
  if (Buffer.byteLength(src) > MAX_FRONT_MATTER_BYTES)
    throw invalid(doc, `more than ${MAX_FRONT_MATTER_BYTES} bytes`);
  const yaml = parseDocument(src, {
    schema: 'failsafe',
    merge: false,
    uniqueKeys: true,
    strict: true,
    prettyErrors: false,
  });
  if (yaml.errors.length > 0 || yaml.warnings.length > 0)
    throw invalid(
      doc,
      (yaml.errors[0] ?? yaml.warnings[0])?.code ?? 'YAML error',
    );
  if (!isMap(yaml.contents)) throw invalid(doc, 'must be a mapping');
  for (const pair of yaml.contents.items) {
    const key = isScalar(pair.key) ? pair.key.value : undefined;
    if (typeof key !== 'string' || !KEYS.has(key))
      throw invalid(doc, `key ${JSON.stringify(String(key))} is not allowed`);
  }
  let raw: unknown;
  try {
    raw = yaml.toJS({ maxAliasCount: 0 });
  } catch {
    throw invalid(doc, 'anchors and aliases are not allowed');
  }
  const parsed = FrontMatterSchema.safeParse(raw);
  if (!parsed.success)
    throw invalid(
      doc,
      `${parsed.error.issues[0]?.path.join('.') ?? ''}: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    );
  return { meta: parsed.data, body: end + 1 };
}
