import type {
  CheckOutcome,
  ConsistencyCheck,
  ContractFact,
  ContractReport,
  ContractRule,
} from './types.js';

const COMPARABLE: readonly ContractRule[] = [
  'required',
  'minLength',
  'maxLength',
  'min',
  'max',
  'pattern',
  'enum',
];
const KEY = /^[A-Za-z][\w-]*(?:\.[\w-]+)+$/;
const MAX_FACTS = 8;

const byKey = <T>(
  items: readonly T[],
  key: (t: T) => string,
): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    m.set(k, [...(m.get(k) ?? []), it]);
  }
  return m;
};

const values = (facts: readonly ContractFact[]): Set<string> =>
  new Set(facts.map((f) => f.value));

const same = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((v) => b.has(v));

function clientServer(facts: readonly ContractFact[]): ConsistencyCheck[] {
  const out: ConsistencyCheck[] = [];
  for (const [field, group] of byKey(
    facts.filter((f) => f.side !== 'catalogue'),
    (f) => f.field,
  )) {
    const client = group.filter((f) => f.side === 'client');
    const server = group.filter((f) => f.side === 'server');
    if (client.length === 0 || server.length === 0) continue;
    for (const rule of COMPARABLE) {
      const c = client.filter((f) => f.rule === rule);
      const s = server.filter((f) => f.rule === rule);
      if (c.length === 0 && s.length === 0) continue;
      let outcome: CheckOutcome = 'missing';
      let reason = c.length === 0 ? 'absent_on_client' : 'absent_on_server';
      if (c.length > 0 && s.length > 0) {
        const agree = same(values(c), values(s));
        outcome = agree ? 'equal' : 'differs';
        reason = agree ? 'values_agree' : 'values_differ';
      }
      out.push({
        kind: 'client_server',
        field,
        rule,
        outcome,
        reason,
        facts: [...c, ...s].slice(0, MAX_FACTS),
      });
    }
  }
  return out;
}

function messages(facts: readonly ContractFact[]): ConsistencyCheck[] {
  const catalogue = facts.filter((f) => f.source === 'i18n');
  const locales = [...new Set(catalogue.map((f) => f.owner))].sort();
  const out: ConsistencyCheck[] = [];
  for (const f of facts) {
    if (f.messageKey === undefined) continue;
    const base = {
      kind: 'message_i18n' as const,
      field: f.field,
      rule: f.rule,
    };
    if (!KEY.test(f.messageKey))
      out.push({
        ...base,
        outcome: 'unknown',
        reason: 'not_a_key',
        facts: [f],
      });
    else if (locales.length === 0)
      out.push({
        ...base,
        outcome: 'unknown',
        reason: 'no_catalogue',
        facts: [f],
      });
    else
      for (const locale of locales) {
        const hit = catalogue.find(
          (c) => c.owner === locale && c.field === f.messageKey,
        );
        out.push(
          hit === undefined
            ? {
                ...base,
                outcome: 'missing',
                reason: 'key_missing',
                facts: [f],
                locale,
              }
            : {
                ...base,
                outcome: 'equal',
                reason: 'key_found',
                facts: [f, hit],
                locale,
              },
        );
      }
  }
  return out;
}

function responses(facts: readonly ContractFact[]): ConsistencyCheck[] {
  const api = facts.filter((f) => f.source === 'openapi');
  const links = (owner: string, field: string): string[] =>
    api
      .filter(
        (f) => f.owner === owner && f.field === field && f.rule === 'schema',
      )
      .map((f) => f.value);
  const fieldsOf = (schema: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(schema) || seen.size > 32) return new Set();
    seen.add(schema);
    const fields = new Set(
      api
        .filter(
          (f) =>
            f.owner === schema &&
            f.rule !== 'status' &&
            f.rule !== 'required' &&
            !(
              f.rule === 'schema' &&
              (f.field === 'allOf' || f.field.endsWith('.allOf'))
            ),
        )
        .map((f) => f.field),
    );
    for (const parent of api.filter(
      (f) => f.owner === schema && f.field === 'allOf' && f.rule === 'schema',
    ))
      for (const p of fieldsOf(parent.value, seen)) fields.add(p);
    return fields;
  };
  const out: ConsistencyCheck[] = [];
  for (const status of api.filter(
    (f) => f.rule === 'status' && /^[45]\d\d$/.test(f.value),
  )) {
    for (const schema of links(status.owner, status.field)) {
      const names = api.filter(
        (f) => f.owner === schema && f.field === 'field' && f.rule === 'enum',
      );
      for (const fact of names) {
        const request = links(status.owner, 'request')[0];
        const known = request === undefined ? undefined : fieldsOf(request);
        let listed: unknown;
        try {
          listed = JSON.parse(fact.value);
        } catch {
          listed = undefined;
        }
        if (!Array.isArray(listed)) continue;
        for (const name of listed) {
          if (typeof name !== 'string') continue;
          const base = {
            kind: 'response_schema' as const,
            field: name,
            rule: 'enum' as const,
          };
          out.push(
            known === undefined
              ? {
                  ...base,
                  outcome: 'unknown',
                  reason: 'no_request_schema',
                  facts: [fact],
                }
              : known.has(name)
                ? {
                    ...base,
                    outcome: 'equal',
                    reason: 'field_found',
                    facts: [fact],
                  }
                : {
                    ...base,
                    outcome: 'missing',
                    reason: 'field_missing',
                    facts: [fact],
                  },
          );
        }
      }
    }
  }
  return out;
}

/**
 * The consistency checks of ADR 0020 section 3 rule 3, built from the facts of a report and nothing else:
 * - `client_server`: for a field that a client source (HTML, zod) and a server source (OpenAPI, Joi) both name, every
 *   comparable rule (`required`, `minLength`, `maxLength`, `min`, `max`, `pattern`, `enum`) is `equal`, `differs`, or
 *   `missing` on one side;
 * - `message_i18n`: a message key (a fact's `messageKey`) is `equal` to a catalogue key per locale, `missing`, or
 *   `unknown` when it is not a dotted key or no catalogue was read;
 * - `response_schema`: the field names an error response lists in its `field` enum are `equal` to a property of the
 *   operation's request schema (through `allOf`), or `missing`.
 * A side that cannot be judged is `unknown`, never `equal`. A check carries facts and a fixed `reason`; it holds no
 * verdict, flow, step or assertion (invariant 1, ADR 0004).
 *
 * @remarks Fields are joined by name: when several schemas share a field name the values of all of them are compared as
 *   a set, so two schemas that disagree show as `differs`.
 */
export function checkConsistency(
  report: Pick<ContractReport, 'facts'>,
): ConsistencyCheck[] {
  return [
    ...clientServer(report.facts),
    ...messages(report.facts),
    ...responses(report.facts),
  ];
}
