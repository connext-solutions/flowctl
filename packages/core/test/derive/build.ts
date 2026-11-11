import type { AppMap, AppPage } from '../../src/observe/index.js';
import type { Operation } from '../../src/spec/index.js';
import type { MatchReport, SpecPath } from '../../src/derive/index.js';
import { normText } from '../../src/derive/index.js';

/** An operation as the markdown adapter would give it: expected items under `headings`. */
export function operation(
  o: Partial<Operation> & {
    id: string;
    headings?: string[];
    items?: string[];
  },
): Operation {
  const title = o.title ?? o.id;
  return {
    id: o.id,
    title,
    actor: null,
    preconditions: [],
    steps: o.steps ?? [],
    expected: (o.items ?? []).map((text, i) => ({
      text,
      value: null,
      ref: {
        doc: o.location?.ref ?? `${o.id}.md`,
        section: o.headings?.at(-1) ?? null,
        lines: [10 + i, 10 + i],
        revision: 'r1',
      },
      context: {
        operationId: o.id,
        operationTitle: title,
        headings: o.headings ?? [],
        leadIn: null,
      },
    })),
    location: o.location ?? { provider: 'markdown', ref: `${o.id}.md` },
    signatureRef: null,
  };
}

/** A page with controls (`role:name`) and one form of fields (`role:name`). */
export function page(
  path: string,
  title: string,
  controls: string[] = [],
  fields: string[] = [],
): AppPage {
  const name = (s: string): string => s.split(':').slice(1).join(':');
  return {
    path,
    title,
    status: 200,
    controls: controls.map((c) => ({ role: roleOf(c), name: name(c) })),
    links: [],
    forms:
      fields.length === 0
        ? []
        : [
            {
              name: null,
              submit: null,
              fields: fields.map((f) => ({
                role: roleOf(f),
                name: name(f),
                type: null,
                required: false,
              })),
            },
          ],
    calls: [],
    consoleErrors: [],
    refused: [],
  };
}

function roleOf(s: string): 'button' | 'textbox' | 'combobox' | 'link' {
  const role = s.split(':')[0];
  return role === 'textbox' || role === 'combobox' || role === 'link'
    ? role
    : 'button';
}

/** A map of `pages` on a fixed origin. */
export const appMap = (pages: AppPage[]): AppMap => ({
  v: 1,
  origin: 'http://127.0.0.1:4000',
  observedAt: '2026-11-20T00:00:00.000Z',
  truncated: false,
  pages,
});

/** The string at `path` in `op`, or `undefined`. */
export function at(op: Operation, path: SpecPath): unknown {
  let cur: unknown = op;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = Object.entries(cur).find(([k]) => k === String(key))?.[1];
  }
  return cur;
}

/**
 * Checks the matcher invents nothing: every span slices its spec string to its text, and every element is in the
 * map with that name.
 */
export function assertGrounded(
  report: MatchReport,
  ops: readonly Operation[],
  map: AppMap,
): void {
  for (const m of report.operations) {
    const op = ops.find((o) => o.id === m.operation.id);
    if (op === undefined) throw new Error(`no operation ${m.operation.id}`);
    const spans = [
      ...m.screens.flatMap((s) => s.evidence.map((e) => e.spec)),
      ...m.literals.flatMap((l) => l.spans),
    ];
    for (const s of spans) {
      const text = at(op, s.path);
      if (
        typeof text !== 'string' ||
        normText(text).slice(s.start, s.end) !== s.text
      )
        throw new Error(`span ${JSON.stringify(s)} is not in ${op.id}`);
    }
    const elements = [
      ...m.screens.flatMap((s) => s.evidence.map((e) => e.element)),
      ...m.literals.flatMap((l) => l.elements.map((e) => e.element)),
    ];
    for (const e of elements) {
      const p = map.pages.find((x) => x.path === e.page);
      const name =
        e.kind === 'title'
          ? p?.title
          : e.kind === 'path'
            ? p?.path
            : e.kind === 'control'
              ? p?.controls[e.index]?.name
              : p?.forms[e.form]?.fields[e.index]?.name;
      if (name !== e.name)
        throw new Error(`element ${JSON.stringify(e)} is not in the map`);
    }
  }
}
