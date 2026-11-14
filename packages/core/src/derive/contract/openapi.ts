import { type Emitter, pointerOf } from './emit.js';
import { canonicalNumber } from './numbers.js';
import { resolveRef, type RefScope } from './openapi-ref.js';
import { type DataNode, type MapNode, mapAt, textAt } from './safe-data.js';
import type { ContractRule } from './types.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head'];
const NUMERIC: readonly (readonly [string, ContractRule])[] = [
  ['minLength', 'minLength'],
  ['maxLength', 'maxLength'],
  ['minimum', 'min'],
  ['maximum', 'max'],
];
const COMBINATORS = ['oneOf', 'anyOf', 'not'];
const MAX_NAME = 200;

/** The part of a `#/components/schemas/X` reference a link fact names, or the reference itself, shortened. */
const refName = (ref: string): string =>
  ref.startsWith('#/components/schemas/')
    ? ref.slice('#/components/schemas/'.length)
    : ref.slice(0, MAX_NAME);

/**
 * Reads the facts of an OpenAPI document (3.x or 2.0, YAML or JSON) from its parsed data, without following a
 * reference out of the root: for every schema (a component, or inline in an operation) the `type`, `required`,
 * `minLength`, `maxLength`, `minimum`, `maximum`, `pattern` and `enum` of each property, the message key named by
 * `x-message-keys`, `allOf` members as `schema` links; for every operation its parameters, its request body and its
 * responses (`status` and the `schema` each uses). `oneOf`, `anyOf` and `not` are skipped as unsupported, never
 * guessed. A reference to a file outside the root, a remote or absolute one, is a skip.
 *
 * @see docs/adr/0040-contract-readers.md
 */
export class OpenApiReader {
  constructor(
    private readonly out: Emitter,
    private readonly scope: RefScope,
  ) {}

  /** Walks the whole document. */
  read(): void {
    const root = this.scope.tree;
    const schemas = mapAt(mapAt(root, 'components'), 'schemas');
    for (const [name, node] of schemas?.entries ?? [])
      if (node.kind === 'map')
        this.schema(node, name, ['components', 'schemas', name], '', 0);
    for (const [path, item] of mapAt(root, 'paths')?.entries ?? [])
      if (item.kind === 'map')
        for (const m of METHODS) {
          const op = mapAt(item, m);
          if (op !== undefined)
            this.operation(op, `${m.toUpperCase()} ${path}`, [
              'paths',
              path,
              m,
            ]);
        }
  }

  private fact(
    node: DataNode,
    ptr: readonly string[],
    owner: string,
    field: string,
    rule: ContractRule,
    value: string,
    messageKey?: string,
  ): void {
    const f = {
      line: node.line,
      pointer: pointerOf(ptr),
      owner,
      field,
      rule,
      value,
    };
    this.out.fact(messageKey === undefined ? f : { ...f, messageKey });
  }

  private constraints(
    node: MapNode,
    owner: string,
    field: string,
    ptr: readonly string[],
  ): void {
    const keys = mapAt(node, 'x-message-keys');
    const type = node.entries.get('type');
    if (type?.kind === 'scalar')
      this.fact(type, [...ptr, 'type'], owner, field, 'type', type.text);
    for (const [kw, rule] of NUMERIC) {
      const v = node.entries.get(kw);
      if (v?.kind !== 'scalar') continue;
      const n = v.plain ? canonicalNumber(v.text, 'data') : undefined;
      if (n === undefined) this.out.skip('ambiguous_number', v.line);
      else this.fact(v, [...ptr, kw], owner, field, rule, n, textAt(keys, kw));
    }
    const pattern = node.entries.get('pattern');
    if (pattern?.kind === 'scalar')
      this.fact(
        pattern,
        [...ptr, 'pattern'],
        owner,
        field,
        'pattern',
        pattern.text,
        textAt(keys, 'pattern'),
      );
    const en = node.entries.get('enum');
    if (en?.kind === 'seq') {
      const values = en.items.flatMap((i) =>
        i.kind === 'scalar' ? [i.text] : [],
      );
      if (values.length !== en.items.length)
        this.out.skip('enum_not_text', en.line);
      else
        this.fact(
          en,
          [...ptr, 'enum'],
          owner,
          field,
          'enum',
          JSON.stringify([...new Set(values)].sort()),
          textAt(keys, 'enum'),
        );
    }
  }

  private schema(
    node: MapNode,
    owner: string,
    ptr: readonly string[],
    prefix: string,
    depth: number,
  ): void {
    if (depth > 16) return this.out.skip('too_deep', node.line);
    for (const c of COMBINATORS)
      if (node.entries.has(c)) this.out.skip(`unsupported_${c}`, node.line);
    const allOf = node.entries.get('allOf');
    if (allOf?.kind === 'seq')
      allOf.items.forEach((member, i) => {
        if (member.kind !== 'map') return;
        const ref = textAt(member, '$ref');
        if (ref !== undefined)
          this.fact(
            member,
            [...ptr, 'allOf', String(i)],
            owner,
            `${prefix}allOf`,
            'schema',
            refName(ref),
          );
        else
          this.schema(
            member,
            owner,
            [...ptr, 'allOf', String(i)],
            prefix,
            depth + 1,
          );
      });
    for (const [name, prop] of mapAt(node, 'properties')?.entries ?? [])
      if (prop.kind === 'map')
        this.property(
          prop,
          owner,
          [...ptr, 'properties', name],
          `${prefix}${name}`,
          depth,
        );
    const required = node.entries.get('required');
    if (required?.kind === 'seq')
      required.items.forEach((r, i) => {
        if (r.kind === 'scalar')
          this.fact(
            r,
            [...ptr, 'required', String(i)],
            owner,
            `${prefix}${r.text}`,
            'required',
            'true',
          );
      });
  }

  private property(
    node: MapNode,
    owner: string,
    ptr: readonly string[],
    field: string,
    depth: number,
  ): void {
    const ref = textAt(node, '$ref');
    if (ref !== undefined)
      return this.fact(node, ptr, owner, field, 'schema', refName(ref));
    this.constraints(node, owner, field, ptr);
    this.schema(node, owner, ptr, `${field}.`, depth + 1);
    const items = mapAt(node, 'items');
    if (items !== undefined) {
      this.constraints(items, owner, `${field}[]`, [...ptr, 'items']);
      this.schema(items, owner, [...ptr, 'items'], `${field}[].`, depth + 1);
    }
  }

  private operation(op: MapNode, owner: string, ptr: readonly string[]): void {
    const params = op.entries.get('parameters');
    if (params?.kind === 'seq')
      params.items.forEach((p, i) =>
        this.parameter(p, owner, [...ptr, 'parameters', String(i)]),
      );
    const body = this.follow(op.entries.get('requestBody'), [
      ...ptr,
      'requestBody',
    ]);
    if (body !== undefined)
      this.content(body.node, owner, 'request', body.path);
    for (const [status, resp] of mapAt(op, 'responses')?.entries ?? []) {
      const at = [...ptr, 'responses', status];
      this.fact(resp, at, owner, status, 'status', status);
      const r = this.follow(resp, at);
      if (r !== undefined) this.content(r.node, owner, status, r.path);
    }
  }

  private parameter(p: DataNode, owner: string, ptr: readonly string[]): void {
    const r = this.follow(p, ptr);
    const name = textAt(r?.node, 'name');
    if (r === undefined || r.node.kind !== 'map' || name === undefined) return;
    const flag = r.node.entries.get('required');
    if (flag?.kind === 'scalar' && flag.text === 'true' && !flag.plain)
      this.out.skip('quoted_boolean', flag.line);
    else if (flag?.kind === 'scalar' && flag.text === 'true')
      this.fact(
        r.node,
        [...r.path, 'required'],
        owner,
        name,
        'required',
        'true',
      );
    const schema = mapAt(r.node, 'schema');
    if (schema !== undefined)
      this.constraints(schema, owner, name, [...r.path, 'schema']);
  }

  private content(
    node: DataNode,
    owner: string,
    field: string,
    ptr: readonly string[],
  ): void {
    for (const [media, m] of mapAt(node, 'content')?.entries ?? []) {
      const schema = mapAt(m, 'schema');
      if (schema === undefined) continue;
      const at = [...ptr, 'content', media, 'schema'];
      const ref = textAt(schema, '$ref');
      if (ref !== undefined)
        this.fact(schema, at, owner, field, 'schema', refName(ref));
      else {
        const name = `${owner} ${field}`;
        this.fact(schema, at, owner, field, 'schema', name);
        this.schema(schema, name, at, '', 0);
      }
      return;
    }
  }

  /** `node`, or what its `$ref` points at when that is in this file (a foreign file's pointers are not ours). */
  private follow(
    node: DataNode | undefined,
    ptr: readonly string[],
  ): { node: DataNode; path: readonly string[] } | undefined {
    if (node === undefined) return undefined;
    const ref = textAt(node, '$ref');
    if (ref === undefined) return { node, path: ptr };
    const r = resolveRef(ref, this.scope);
    if (!r.ok) {
      this.out.skip(r.reason, node.line);
      return undefined;
    }
    if (!r.sameFile) {
      this.out.skip('ref_other_file', node.line);
      return undefined;
    }
    return { node: r.node, path: r.path };
  }
}
