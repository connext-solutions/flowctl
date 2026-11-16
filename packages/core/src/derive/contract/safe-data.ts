import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
} from 'yaml';
import { ConfigError } from '../../foundation/index.js';
import type { ContractLimits } from './types.js';

/**
 * A file that cannot be read as data, with a fixed `reason` (`yaml_invalid`, `alias`, `custom_tag`,
 * `forbidden_key`, `too_deep`, `too_many_nodes`, `string_too_long`, `non_scalar_key`, `empty`). The message never
 * carries the file's text.
 */
export class ContractParseError extends ConfigError {
  constructor(readonly reason: string) {
    super(`the contract file is refused (${reason})`);
  }
}

/** A mapping: keys in document order, and the line of the first key. */
export interface MapNode {
  kind: 'map';
  entries: ReadonlyMap<string, DataNode>;
  line: number;
}

/** A sequence. */
export interface SeqNode {
  kind: 'seq';
  items: readonly DataNode[];
  line: number;
}

/** A scalar as text: `plain` is true for an unquoted scalar (a number, `true`, `null` in JSON), false for a string. */
export interface ScalarNode {
  kind: 'scalar';
  text: string;
  plain: boolean;
  line: number;
}

/** The data of a YAML or JSON file. Mappings are {@link Map}s, so no key can reach a prototype. */
export type DataNode = MapNode | SeqNode | ScalarNode;

/** Keys refused at any depth (ADR 0023 rule 4); `<<` is the YAML merge key, which is off. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype', '<<']);

interface YNode {
  range?: [number, number, number] | null;
  anchor?: string;
  tag?: string;
}

const NEWLINE = 10;
const COMMA = 44;
const HASH = 35;
const DQUOTE = 34;
const SQUOTE = 39;
const BACKSLASH = 92;
const OPENERS = new Set([123, 91]);
const CLOSERS = new Set([125, 93]);
/** What may come before a quote that opens a quoted scalar: the start of a line or a structural character. */
const BEFORE_QUOTE = new Set([58, 45, 63, 91, 123, 44]);
/** Columns of indentation allowed per level of `maxDepth` before a block document is refused as too deep. */
const COLUMNS_PER_LEVEL = 4;
const isBlank = (c: number): boolean => c === 32 || c === 9 || c === NEWLINE;
/** A pretty-printed document has at most two lines per node (a closing line for each container). */
const LINES_PER_NODE = 2;
/** Commas and openers, counted even inside quotes, may exceed `maxNodes` by this factor. */
const RAW_FACTOR = 1;

/**
 * One linear pass over `text` before any parser runs, so that `maxNodes`, `maxDepth` and the file size bound the
 * work of the parse and not only the size of its result: lines and commas are a ceiling on the nodes a document can
 * have, the deepest flow bracket nesting and the widest indentation are a ceiling on its depth. Brackets and commas
 * inside a quoted scalar or a comment are text, not structure, and are not counted, so a pattern or a sentence
 * that holds a lone `[` cannot refuse a file. A text that passes can still be refused later by the exact counts; a
 * text that fails here is never handed to the parser.
 *
 * @throws {ContractParseError} `too_many_nodes` or `too_deep`.
 */
export function prescan(text: string, lim: ContractLimits): void {
  let lines = 0;
  let commas = 0;
  let flow = 0;
  let column = 0;
  let indenting = true;
  let quote = 0;
  let comment = false;
  let before = NEWLINE;
  let raw = 0;
  const maxRaw = lim.maxNodes * RAW_FACTOR;
  const widest = lim.maxDepth * COLUMNS_PER_LEVEL;
  const maxLines = lim.maxNodes * LINES_PER_NODE;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === NEWLINE) {
      if (++lines > maxLines) throw new ContractParseError('too_many_nodes');
      column = 0;
      indenting = true;
      comment = false;
      before = NEWLINE;
      continue;
    }
    if (indenting && (c === 32 || c === 9)) {
      if (++column > widest) throw new ContractParseError('too_deep');
      continue;
    }
    indenting = false;
    if (c === COMMA || OPENERS.has(c)) {
      if (++raw > maxRaw) throw new ContractParseError('too_many_nodes');
    }
    if (comment) continue;
    if (quote !== 0) {
      if (c === BACKSLASH && quote === DQUOTE) i++;
      else if (c === quote) quote = 0;
      continue;
    }
    if (c === 32 || c === 9 || c === 13) continue;
    if (
      (c === DQUOTE || c === SQUOTE) &&
      (BEFORE_QUOTE.has(before) || before === NEWLINE)
    )
      quote = c;
    else if (c === HASH && (i === 0 || isBlank(text.charCodeAt(i - 1))))
      comment = true;
    else if (c === COMMA) {
      if (++commas > lim.maxNodes)
        throw new ContractParseError('too_many_nodes');
    } else if (OPENERS.has(c)) {
      if (++flow > lim.maxDepth) throw new ContractParseError('too_deep');
    } else if (CLOSERS.has(c) && flow > 0) flow--;
    before = c;
  }
}

/**
 * Parses YAML or JSON text with the safe options of ADR 0023 rule 4, the set `spec/markdown/front-matter.ts`
 * uses: the failsafe schema (every scalar is text, no type coercion), no merge keys, strict, and
 * then (after a {@link prescan} that bounds the work) no anchors, aliases or explicit tags, no key of {@link FORBIDDEN}, bounded depth, nodes and string length.
 * JSON is read as YAML (it is a subset), so duplicate keys in JSON are refused too. Duplicates are found in
 * the conversion with a map, in linear time, because the parser's own check is quadratic in the keys of a mapping.
 *
 * @throws {ContractParseError} for anything unsafe or malformed.
 */
export function parseData(text: string, lim: ContractLimits): DataNode {
  prescan(text, lim);
  const lines = new LineCounter();
  const doc = parseDocument(text, {
    schema: 'failsafe',
    merge: false,
    uniqueKeys: false,
    strict: true,
    prettyErrors: false,
    lineCounter: lines,
  });
  const err = doc.errors[0] ?? doc.warnings[0];
  if (err !== undefined)
    throw new ContractParseError(
      err.code === 'RESOURCE_EXHAUSTION' ? 'too_deep' : 'yaml_invalid',
    );
  if (doc.contents === null) throw new ContractParseError('empty');
  let nodes = 0;
  const lineOf = (n: YNode): number =>
    n.range?.[0] === undefined ? 0 : lines.linePos(n.range[0]).line;
  const convert = (n: unknown, depth: number): DataNode => {
    if (depth > lim.maxDepth) throw new ContractParseError('too_deep');
    if (++nodes > lim.maxNodes) throw new ContractParseError('too_many_nodes');
    if (isAlias(n)) throw new ContractParseError('alias');
    if (!isMap(n) && !isSeq(n) && !isScalar(n))
      throw new ContractParseError('yaml_invalid');
    if (n.anchor !== undefined || n.tag !== undefined)
      throw new ContractParseError(
        n.anchor === undefined ? 'custom_tag' : 'alias',
      );
    const line = lineOf(n);
    if (isScalar(n)) {
      const value = n.value === null || n.value === undefined ? '' : n.value;
      if (typeof value !== 'string')
        throw new ContractParseError('yaml_invalid');
      if (value.length > lim.maxString)
        throw new ContractParseError('string_too_long');
      return { kind: 'scalar', text: value, plain: n.type === 'PLAIN', line };
    }
    if (isSeq(n))
      return {
        kind: 'seq',
        items: n.items.map((item) => convert(item, depth + 1)),
        line,
      };
    const entries = new Map<string, DataNode>();
    for (const pair of n.items) {
      const key = pair.key;
      if (!isScalar(key) || typeof key.value !== 'string')
        throw new ContractParseError('non_scalar_key');
      if (FORBIDDEN.has(key.value) || key.value.length > lim.maxString)
        throw new ContractParseError('forbidden_key');
      if (entries.has(key.value)) throw new ContractParseError('yaml_invalid');
      entries.set(
        key.value,
        pair.value === null
          ? { kind: 'scalar', text: '', plain: true, line: lineOf(key) }
          : convert(pair.value, depth + 1),
      );
    }
    return { kind: 'map', entries, line };
  };
  return convert(doc.contents, 0);
}

/** The mapping under `key`, or `undefined`. */
export const mapAt = (
  n: DataNode | undefined,
  key: string,
): MapNode | undefined => {
  const v = n?.kind === 'map' ? n.entries.get(key) : undefined;
  return v?.kind === 'map' ? v : undefined;
};

/** The scalar text under `key`, or `undefined`. */
export const textAt = (
  n: DataNode | undefined,
  key: string,
): string | undefined => {
  const v = n?.kind === 'map' ? n.entries.get(key) : undefined;
  return v?.kind === 'scalar' ? v.text : undefined;
};

/** The node at the JSON Pointer segments `path` below `root`, or `undefined`. */
export function nodeAt(
  root: DataNode,
  path: readonly string[],
): DataNode | undefined {
  let at: DataNode | undefined = root;
  for (const seg of path) {
    if (at?.kind === 'map') at = at.entries.get(seg);
    else if (at?.kind === 'seq' && /^(?:0|[1-9]\d{0,8})$/.test(seg))
      at = at.items[Number(seg)];
    else return undefined;
  }
  return at;
}
