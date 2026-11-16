import { ByteBudget, type ContainmentErrorKind } from '../../trust/index.js';
import { Emitter, isVisible, printable } from './emit.js';
import { htmlFacts } from './html.js';
import { i18nFacts } from './i18n.js';
import { findSchemas } from './js-chain.js';
import { lexJs } from './js-lex.js';
import { readJoiChain } from './joi.js';
import {
  isCatalogue,
  kindOf,
  localeOf,
  readFileText,
  type ReadCtx,
} from './load.js';
import { OpenApiReader } from './openapi.js';
import type { RefLoader } from './openapi-ref.js';
import { ContractParseError, type DataNode, parseData } from './safe-data.js';
import type { ContractFact, SkippedContract } from './types.js';
import { emitSchema } from './validators.js';
import { readZodChain } from './zod.js';

/** The facts and skips of one file, and the SHA-256 of its bytes when it was read. */
export interface Extracted {
  facts: ContractFact[];
  skipped: SkippedContract[];
  sha256?: string;
  refused?: { kind: ContainmentErrorKind; rule: string };
}

const MARKS_VALIDATOR = /\b(?:z|zod|Joi|joi)\s*\.\s*object\b/;
const BLANK = new Set([' ', '\t', '\r']);

/**
 * Whether `text` has a line that starts with an `openapi` or `swagger` key (YAML, optionally quoted). A linear scan
 * over the occurrences of the two words, with no pattern that can backtrack: the work is bounded by the text's
 * length, whatever it holds (a megabyte of blanks costs one pass).
 */
function marksOpenApi(text: string): boolean {
  for (const word of ['openapi', 'swagger']) {
    for (
      let at = text.indexOf(word);
      at >= 0;
      at = text.indexOf(word, at + word.length)
    ) {
      let before = at - 1;
      const quote = text[before];
      if (quote === '"' || quote === "'") before--;
      while (before >= 0 && BLANK.has(text[before] ?? '')) before--;
      if (before >= 0 && text[before] !== '\n') continue;
      let after = at + word.length;
      if (text[after] === quote && (quote === '"' || quote === "'")) after++;
      while (BLANK.has(text[after] ?? '')) after++;
      if (text[after] === ':') return true;
    }
  }
  return false;
}

/**
 * Reads one file of the root into facts: `.html` for form controls, JS and TS for zod and Joi schemas, YAML and
 * JSON for OpenAPI documents (an `openapi:` or `swagger:` key) and, for JSON below a folder named like a message
 * catalogue, i18n keys. A file of another kind, or one that holds none of these, gives nothing. Every refusal is a
 * skip with a fixed reason, never an exception, except the refusals that end the whole read.
 *
 * @throws {ContainmentError} `path_not_contained` (rule `root changed`) and `too_large` (a budget), which refuse the
 *   whole read.
 */
export function extractFile(ctx: ReadCtx, rel: string): Extracted {
  const kind = kindOf(rel);
  if (kind === undefined) return { facts: [], skipped: [] };
  if (!isVisible(rel))
    return {
      facts: [],
      skipped: [{ file: printable(rel), line: 0, reason: 'file_name_unsafe' }],
    };
  const file = readFileText(ctx, rel);
  if (!file.ok)
    return {
      facts: [],
      skipped: [{ file: printable(rel), line: 0, reason: file.reason }],
      ...(file.kind === undefined
        ? {}
        : { refused: { kind: file.kind, rule: file.reason } }),
    };
  const base = { sha256: file.sha256 };
  const lim = ctx.sh.limits;
  if (kind === 'html') {
    const out = new Emitter(rel, 'html', ctx.sh);
    htmlFacts(file.text, out, lim);
    return { ...base, facts: out.facts, skipped: out.skipped };
  }
  if (kind === 'code') {
    if (!MARKS_VALIDATOR.test(file.text))
      return { ...base, facts: [], skipped: [] };
    const refs = new Set<string>();
    const zod = new Emitter(rel, 'zod', ctx.sh, refs);
    const joi = new Emitter(rel, 'joi', ctx.sh, refs);
    let anonymous = 0;
    const owners = new Map<string, number>();
    const caps = {
      maxDepth: lim.maxDepth,
      maxSchemas: lim.maxSchemas,
      maxKeys: lim.maxKeys,
    };
    try {
      const tokens = lexJs(file.text, lim.maxTokens);
      for (const [ns, out, read] of [
        [['z', 'zod'], zod, readZodChain],
        [['Joi', 'joi'], joi, readJoiChain],
      ] as const) {
        const found = findSchemas(tokens, new Set(ns), caps, owners, anonymous);
        anonymous += found.schemas.length;
        for (const s of found.schemas) emitSchema(s, out, read);
        for (const s of found.skips) out.skip(s.reason, s.line);
      }
    } catch (e) {
      if (!(e instanceof ContractParseError)) throw e;
      zod.skip(e.reason, 0);
    }
    return {
      ...base,
      facts: [...zod.facts, ...joi.facts],
      skipped: [...zod.skipped, ...joi.skipped],
    };
  }
  const catalogue = isCatalogue(rel);
  if (
    !catalogue &&
    !marksOpenApi(file.text) &&
    !file.text.includes('"openapi"') &&
    !file.text.includes('"swagger"')
  )
    return { ...base, facts: [], skipped: [] };
  let tree: DataNode;
  try {
    tree = parseData(file.text, lim);
  } catch (e) {
    if (!(e instanceof ContractParseError)) throw e;
    return {
      ...base,
      facts: [],
      skipped: [{ file: printable(rel), line: 0, reason: e.reason }],
    };
  }
  const out = new Emitter(rel, catalogue ? 'i18n' : 'openapi', ctx.sh);
  if (catalogue) i18nFacts(tree, localeOf(rel), out);
  else if (
    tree.kind === 'map' &&
    (tree.entries.has('openapi') || tree.entries.has('swagger'))
  )
    new OpenApiReader(out, {
      file: rel,
      tree,
      load: loaderFor(ctx),
      refs: new ByteBudget(lim.maxRefs, 'references'),
      maxString: lim.maxString,
    }).read();
  return { ...base, facts: out.facts, skipped: out.skipped };
}

/** Reads and parses another file of the root for a `$ref`, once per read. */
function loaderFor(ctx: ReadCtx): RefLoader {
  return (rel) => {
    const cached = ctx.trees.get(rel);
    if (cached !== undefined) return cached;
    const f = readFileText(ctx, rel);
    let result: ReturnType<RefLoader>;
    if (!f.ok) result = { ok: false, reason: `ref_${f.reason}` };
    else
      try {
        result = { ok: true, tree: parseData(f.text, ctx.sh.limits) };
      } catch (e) {
        if (!(e instanceof ContractParseError)) throw e;
        result = { ok: false, reason: `ref_${e.reason}` };
      }
    ctx.trees.set(rel, result);
    return result;
  };
}
