import { freeChecks } from '../../../observe/index.js';
import { defineInvariant } from '../define.js';
import { NoParams } from '../params.js';
import type { InvariantFinding } from '../types.js';

/**
 * A template that wraps the free check of the same id: `evaluate` reads `freeChecks(map)`, so the verdict cannot
 * differ from `flowctl observe`, and the template only adds `expand` (ADR 0041 section 4).
 */
const free = (
  id: 'no-5xx' | 'no-console-error',
  expand: () => { noConsoleErrors: true } | string,
) =>
  defineInvariant({
    id,
    params: NoParams,
    bind: () => ({ ok: true, steps: [] }),
    evaluate: (evidence): InvariantFinding[] =>
      (
        freeChecks(evidence.map).checks.find((c) => c.id === id)?.findings ?? []
      ).map((f) => ({
        invariant: id,
        page: f.page,
        ...(f.status === undefined ? {} : { status: f.status }),
        ...(f.message === undefined ? {} : { message: f.message }),
        sourceRef: { kind: 'invariant', ref: id },
        observation: {
          kind: 'observation',
          file: 'appmap.json',
          pointer: f.observation.pointer,
        },
      })),
    expand,
  });

export const NO_5XX = free(
  'no-5xx',
  () =>
    'a status class is not an assertion kind yet: network needs an exact status',
);

export const NO_CONSOLE_ERROR = free('no-console-error', () => ({
  noConsoleErrors: true,
}));
