import { type Arg, isP } from './js-args.js';
import type { JsToken } from './js-lex.js';
import { Parser } from './js-parser.js';
import { ContractParseError } from './safe-data.js';

export type { Arg } from './js-args.js';

/** One `.name(args)` of a chain; `line` is where the name is. */
export interface Call {
  name: string;
  args: readonly Arg[];
  line: number;
}

/** A chain such as `z.string().min(1)`, without its namespace. */
export interface Chain {
  calls: readonly Call[];
}

/** One key of a schema object: its chain, or `reason` when the entry is not a literal chain. */
export interface Entry {
  key: string;
  line: number;
  chain?: Chain;
  reason?: string;
}

/** A `z.object({...})` or `Joi.object({...})` literal: its variable name (or `schemaN`) and its keys. */
export interface SchemaObject {
  owner: string;
  line: number;
  entries: readonly Entry[];
}

/** The schemas found in a token stream, and the places the scan gave up. */
export interface Found {
  schemas: SchemaObject[];
  skips: { line: number; reason: string }[];
}

/**
 * Finds the schema objects of a token stream by shape only: `ns.object({ key: ns.method(literal).method(...) })`
 * with the namespace `ns` one of `namespaces` (`z`, `Joi`). Nothing is evaluated or resolved: a key whose value
 * is not a literal chain (a variable, a spread, a computed key, an imported schema) is an entry with a `reason`,
 * and a call argument that is not a literal is `other`. Brackets are tracked with a counter capped at
 * `maxDepth`; past it the scan stops with one skip, so a hostile nesting costs a bounded amount of work. A file with
 * more than `maxSchemas` schemas, or a schema with more than `maxKeys` keys, stops the scan with a typed skip.
 * `owners` counts the variable names already used in the file; pass the same map for every namespace of a file.
 *
 * @see docs/adr/0040-contract-readers.md
 */
export function findSchemas(
  tokens: readonly JsToken[],
  namespaces: ReadonlySet<string>,
  caps: { maxDepth: number; maxSchemas: number; maxKeys: number },
  owners: Map<string, number> = new Map(),
  anonymous = 0,
): Found {
  const found: Found = { schemas: [], skips: [] };
  const p = new Parser(tokens, namespaces, caps.maxDepth, caps.maxKeys);
  try {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (
        t?.type !== 'id' ||
        !namespaces.has(t.value) ||
        isP(tokens[i - 1], '.') ||
        !isP(tokens[i + 1], '.') ||
        tokens[i + 2]?.value !== 'object' ||
        !isP(tokens[i + 3], '(') ||
        !isP(tokens[i + 4], '{')
      )
        continue;
      if (anonymous + found.schemas.length >= caps.maxSchemas) {
        found.skips.push({ line: t.line, reason: 'too_many_schemas' });
        break;
      }
      const owner = uniqueOwner(
        ownerOf(tokens, i, anonymous + found.schemas.length),
        owners,
      );
      const first = p.object(i + 4, owner, 0);
      const done = p.extensions(first.next + 2, first.schema);
      found.schemas.push(done.schema);
      i = done.next;
    }
  } catch (e) {
    if (!(e instanceof ContractParseError)) throw e;
    found.skips.push({ line: p.line, reason: e.reason });
  }
  found.skips.push(...p.skips);
  return found;
}

/**
 * `name`, or `name@2`, `name@3` when another schema of the file already has it, so no two owners are alike. One
 * counter per name, so each owner costs one lookup; `@` is not part of an identifier, so a suffixed owner can never
 * equal a plain one.
 */
function uniqueOwner(name: string, counts: Map<string, number>): string {
  const n = (counts.get(name) ?? 0) + 1;
  counts.set(name, n);
  return n === 1 ? name : `${name}@${n}`;
}

/** The variable a schema is assigned to (`const x = z.object(`), else `schemaN`. */
function ownerOf(tokens: readonly JsToken[], i: number, n: number): string {
  const name = tokens[i - 2];
  return isP(tokens[i - 1], '=') && name?.type === 'id'
    ? name.value
    : `schema${n}`;
}
