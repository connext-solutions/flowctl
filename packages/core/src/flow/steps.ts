import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { FlowError, LocSchema, errorText, type Step } from './schema.js';

const ACTIONS = [
  'click',
  'check',
  'hover',
  'fill',
  'select',
  'press',
  'goto',
  'reload',
  'wait',
  'scroll',
  'upload',
  'drag',
] as const;
type Action = (typeof ACTIONS)[number];

/**
 * An `upload` path as a flow may write it: relative to the directory of `flowctl.config.yaml`, without `..`,
 * so a flow cannot send a file from outside the project (issue #45). The executor checks the expanded,
 * link-resolved path again before it uploads.
 */
const UploadPath = z
  .string()
  .min(1)
  .refine((p) => !isAbsolute(p) && !p.split(/[\\/]/).includes('..'), {
    message: 'an upload path must be relative to the project, without ..',
  });

function parseAction(
  kind: Action,
  v: unknown,
  s: Record<string, unknown>,
): Step {
  switch (kind) {
    case 'click':
    case 'check':
    case 'hover':
      return { kind, target: LocSchema.parse(v) };
    case 'fill':
    case 'select':
      return {
        kind,
        target: LocSchema.parse(v),
        input: z.string().parse(s.input),
      };
    case 'press':
      return { kind, key: z.string().parse(v) };
    case 'goto':
      return { kind, url: z.string().parse(v) };
    case 'reload':
      z.literal(true).parse(v);
      return { kind };
    case 'wait':
      return { kind, ms: z.number().int().nonnegative().parse(v) };
    case 'scroll':
      return { kind, dy: z.number().int().parse(v) };
    case 'upload':
      return {
        kind,
        target: LocSchema.parse(v),
        file: UploadPath.parse(s.file),
      };
    case 'drag':
      return { kind, target: LocSchema.parse(v), to: LocSchema.parse(s.to) };
  }
}

type Switch = Extract<Step, { kind: 'as' }>;

/**
 * The one rule for profile switches: a `goto` right after an `as` without a page is the page that
 * profile opens at, so the two are a single step and the profile never loads its start page first.
 *
 * @returns The joined step, or `undefined` when `s` does not join `prev`. Fields are checked at
 *   run time, so callers may pass steps of any shape.
 * @remarks The joined step keeps the `by` of the `as` entry.
 */
function joined(
  prev: { kind: string } | undefined,
  s: { kind: string },
): Switch | undefined {
  if (prev?.kind !== 'as' || s.kind !== 'goto') return undefined;
  if (!('profile' in prev) || typeof prev.profile !== 'string')
    return undefined;
  if ('goto' in prev && prev.goto !== undefined) return undefined;
  if (!('url' in s) || typeof s.url !== 'string') return undefined;
  const switched: Switch = { kind: 'as', profile: prev.profile, goto: s.url };
  const by = 'by' in prev ? prev.by : undefined;
  return by === 'system1' || by === 'system2' ? { ...switched, by } : switched;
}

/**
 * Joins each `as` step with a `goto` step right after it ({@link joined}).
 *
 * @example joinSwitches([{ kind: 'as', profile: 'm' }, { kind: 'goto', url: '/x' }])
 *   // [{ kind: 'as', profile: 'm', goto: '/x' }]
 */
export function joinSwitches<T extends { kind: string }>(
  steps: (T | Step)[],
): (T | Step)[] {
  return withSources(steps).steps;
}

function withSources<T extends { kind: string }>(
  steps: (T | Step)[],
): { steps: (T | Step)[]; sources: number[] } {
  const out: (T | Step)[] = [];
  const sources: number[] = [];
  steps.forEach((s, i) => {
    const j = joined(out.at(-1), s);
    if (j !== undefined) {
      out[out.length - 1] = j;
      return;
    }
    out.push(s);
    sources.push(i);
  });
  return { steps: out, sources };
}

/**
 * YAML steps → normalised steps, with the YAML index each step starts at.
 *
 * @remarks `- as: p` with `goto` (in the same entry or the next one) becomes one `as` step that
 *   opens the profile at that page.
 * @throws {FlowError} naming the step index (`steps[i]: …`) for an unknown action, a missing
 *   `input`, an invalid locator or an unknown profile.
 */
export function normalizeStepsWithSources(
  raw: Record<string, unknown>[],
  profiles?: string[],
): { steps: Step[]; sources: number[] } {
  const out: Step[] = [];
  raw.forEach((s, i) => {
    const at = `steps[${i}]`;
    try {
      const by =
        s.by === undefined
          ? undefined
          : z.enum(['system1', 'system2']).parse(s.by);
      const push = (step: Step) =>
        out.push(by === undefined ? step : { ...step, by });
      if ('as' in s) {
        const profile = z.string().parse(s.as);
        if (profiles !== undefined && !profiles.includes(profile))
          throw new FlowError(`unknown profile "${profile}"`);
        push(
          'goto' in s
            ? { kind: 'as', profile, goto: z.string().parse(s.goto) }
            : { kind: 'as', profile },
        );
        return;
      }
      const found = ACTIONS.filter((k) => k in s);
      const kind = found[0];
      if (found.length !== 1 || kind === undefined) {
        throw new FlowError(
          `expected exactly one action of ${ACTIONS.join(', ')}`,
        );
      }
      push(parseAction(kind, s[kind], s));
    } catch (e) {
      throw new FlowError(`${at}: ${errorText(e)}`);
    }
  });
  return withSources<Step>(out);
}

/** YAML steps → normalised steps ({@link normalizeStepsWithSources} without the indices). */
export const normalizeSteps = (
  raw: Record<string, unknown>[],
  profiles?: string[],
): Step[] => normalizeStepsWithSources(raw, profiles).steps;

/**
 * Locators that have neither a test id nor an accessible name, e.g. `combobox name=""`.
 *
 * @remarks They still replay while they match exactly one element, but break easily; the run
 *   reports them as `weakLocators` so the app can gain a label or `data-testid` (ADR 0009).
 */
export function weakLocators(steps: Step[]): string[] {
  const weak = new Set<string>();
  for (const s of steps) {
    const locs = 'target' in s ? [s.target, ...('to' in s ? [s.to] : [])] : [];
    for (const loc of locs) {
      if (loc.testId === undefined && (loc.name ?? '') === '') {
        weak.add(`${loc.role ?? '?'} name=""`);
      }
    }
  }
  return [...weak];
}

/** Inverse of {@link normalizeSteps} for one step: the YAML record a recording writes. */
export function serializeStep(s: Step): Record<string, unknown> {
  const by = s.by === undefined ? {} : { by: s.by };
  switch (s.kind) {
    case 'click':
    case 'check':
    case 'hover':
      return { [s.kind]: s.target, ...by };
    case 'fill':
    case 'select':
      return { [s.kind]: s.target, input: s.input, ...by };
    case 'press':
      return { press: s.key, ...by };
    case 'goto':
      return { goto: s.url, ...by };
    case 'reload':
      return { reload: true, ...by };
    case 'wait':
      return { wait: s.ms, ...by };
    case 'scroll':
      return { scroll: s.dy, ...by };
    case 'upload':
      return { upload: s.target, file: s.file, ...by };
    case 'drag':
      return { drag: s.target, to: s.to, ...by };
    case 'as':
      return {
        as: s.profile,
        ...(s.goto === undefined ? {} : { goto: s.goto }),
        ...by,
      };
  }
}
