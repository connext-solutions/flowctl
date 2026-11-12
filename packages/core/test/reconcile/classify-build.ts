import {
  classifyFailure,
  type ClassifyInput,
  type CodeIndex,
} from '../../src/reconcile/index.js';
import type {
  LabelRecord,
  MessageRecord,
  RouteRecord,
} from '../../src/reconcile/index.js';
import { notFoundMessage } from '../../src/browser/index.js';
import type { Loc } from '../../src/flow/index.js';
import type { RunResult } from '../../src/result.js';

/** A run result with defaults: a failed run of flow `f` on `local` with no failure detail. */
export function run(over: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'r1',
    flow: 'f',
    env: 'local',
    status: 'failed',
    steps: 3,
    healed: [],
    teardownFailed: false,
    weakLocators: [],
    evidence: { dir: '/tmp/r1', traces: [], network: [], console: [] },
    ms: 10,
    ...over,
  };
}

const exact = <T extends { text: string }>(
  list: readonly T[],
  text: string,
) => ({
  matches: list.filter(
    (r) => r.text === text.normalize('NFC').replace(/\s+/g, ' ').trim(),
  ),
  truncated: false,
  refused: null,
});

/**
 * A hand-built code index: labels as `text@file:line`, messages likewise, routes as `path@file:line`. `findRoute`
 * matches a route path equal to the query, or a `:param` segment against any segment.
 */
export function fakeIndex(o: {
  labels?: string[];
  messages?: string[];
  routes?: string[];
}): CodeIndex {
  const loc = (s: string) => {
    const [text = '', where = 'src/x.json:1'] = s.split('@');
    const [file = '', line = '1'] = where.split(':');
    return { text, file, line: Number(line) };
  };
  const labels: LabelRecord[] = (o.labels ?? []).map((s, i) => ({
    ...loc(s),
    key: `k${i}`,
    locale: 'vi',
  }));
  const messages: MessageRecord[] = (o.messages ?? []).map((s) => ({
    ...loc(s),
    via: 'min()',
  }));
  const routes: RouteRecord[] = (o.routes ?? []).map((s) => {
    const l = loc(s);
    return {
      path: l.text,
      pattern: l.text,
      source: 'fake',
      file: l.file,
      line: l.line,
    };
  });
  const fits = (pattern: string, path: string) => {
    const a = pattern.split('/');
    const b = path.split('/');
    return (
      a.length === b.length &&
      a.every((s, i) => s.startsWith(':') || s === b[i])
    );
  };
  return {
    routes,
    labels,
    messages,
    skipped: [],
    files: 1,
    findLabel: (t) => exact(labels, t),
    findMessage: (t) => exact(messages, t),
    findRoute: (p) => ({
      matches: routes.filter((r) => fits(r.path, p)),
      truncated: false,
      refused: null,
    }),
  };
}

/** A failed run whose step `loc` was not found, with the message the executor writes. */
export const notFound = (loc: Loc): RunResult =>
  run({
    failed: { step: 2, kind: 'not_found', message: notFoundMessage(loc) },
  });

/** A failed run whose `text` assertion did not hold. */
export const textFailed = (text: string): RunResult =>
  run({
    failed: {
      assertion: { text },
      got: 'visible page text does not contain it (120 chars)',
    },
  });

/** A failed run whose `url` assertion did not hold, the page on `got`. */
export const urlFailed = (url: string, got: string): RunResult =>
  run({ failed: { assertion: { url }, got } });

/** The class, confidence and basis rules of a classification. */
export const classes = (i: ClassifyInput) => {
  const c = classifyFailure(i);
  return {
    class: c.class,
    confidence: c.confidence,
    rules: c.basis.map((h) => h.rule),
  };
};
