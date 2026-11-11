import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  FIXTURES_DIR,
  MAX_STEPS_CAP,
  NAME_PATTERN,
} from '../foundation/index.js';
import { errorText, FlowError, FlowSchema, LocSchema } from '../flow/index.js';
import type { DirectedStep, ExploreRequest } from './types.js';

/** The longest goal or hint an orchestrator may send; it is prompt text for System 1. */
export const MAX_GOAL_CHARS = 4000;
/** The longest `wait` an orchestrator step may ask for. */
export const MAX_WAIT_MS = 30_000;

const SAME_ORIGIN_PATH = /^\/(?![/\\])/;

const Path = z
  .string()
  .refine((s) => SAME_ORIGIN_PATH.test(s) || s.startsWith('{{'), {
    message:
      'must be a path starting with a single / (or a template); flowctl never navigates to another origin or scheme',
  });

const RelativeFile = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !isAbsolute(p) &&
      !p.includes('{{') &&
      p.startsWith(`${FIXTURES_DIR}/`) &&
      !p.split(/[\\/]/).some((part) => part === '' || part.startsWith('.')),
    {
      message: `must be a literal path under ${FIXTURES_DIR}/ in the flows directory, without .., a dot-name or a template`,
    },
  );

const ControlId = z.number().int().nonnegative();
const Pointer = z.enum(['click', 'check', 'hover']);
const Typing = z.enum(['fill', 'select']);

/**
 * Every step an orchestrator may send, as data: a flow step or an action on a control id. Strict objects,
 * bounded numbers, paths only for `goto` / `as.goto`, project-relative files for `upload`. `by` is not
 * accepted: flowctl records who acted.
 */
const DirectedStepSchema = z.union([
  z.object({ kind: Pointer, control: ControlId }).strict(),
  z.object({ kind: Typing, control: ControlId, input: z.string() }).strict(),
  z.object({ kind: Pointer, target: LocSchema }).strict(),
  z.object({ kind: Typing, target: LocSchema, input: z.string() }).strict(),
  z
    .object({ kind: z.literal('press'), key: z.string().min(1).max(40) })
    .strict(),
  z.object({ kind: z.literal('goto'), url: Path }).strict(),
  z.object({ kind: z.literal('reload') }).strict(),
  z
    .object({
      kind: z.literal('wait'),
      ms: z.number().int().min(0).max(MAX_WAIT_MS),
    })
    .strict(),
  z
    .object({
      kind: z.literal('scroll'),
      dy: z.number().int().min(-20_000).max(20_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal('upload'),
      target: LocSchema,
      file: RelativeFile,
    })
    .strict(),
  z
    .object({ kind: z.literal('drag'), target: LocSchema, to: LocSchema })
    .strict(),
  z
    .object({
      kind: z.literal('as'),
      profile: z.string().regex(NAME_PATTERN),
      goto: Path.optional(),
    })
    .strict(),
]);

const ExploreRequestSchema = z
  .object({
    goal: z.string().min(1).max(MAX_GOAL_CHARS),
    start: Path,
    profile: z.string().regex(NAME_PATTERN),
    inputs: FlowSchema.shape.inputs.optional(),
    assertions: FlowSchema.shape.assertions,
    setup: z.string().optional(),
    teardown: z.string().optional(),
    maxSteps: z.number().int().min(1).max(MAX_STEPS_CAP).optional(),
    allowDestructive: z.boolean().optional(),
  })
  .strict();

/**
 * Validates an exploration request at the edge (a script or an MCP client may send anything): assertions
 * through `AssertionSchema`, so an unknown shape is refused instead of being read as another kind.
 *
 * @throws {FlowError} naming the field that is wrong.
 */
export function parseExploreRequest(req: unknown): ExploreRequest {
  const r = ExploreRequestSchema.safeParse(req);
  if (!r.success)
    throw new FlowError(`Invalid exploration request:\n${errorText(r.error)}`);
  return r.data;
}

/**
 * Validates orchestrator steps before any of them runs.
 *
 * @throws {FlowError} naming the step that is wrong (and the field, when the step's shape is unambiguous).
 */
export function parseDirectedSteps(steps: unknown[]): DirectedStep[] {
  return steps.map((s, i) => {
    const r = DirectedStepSchema.safeParse(s);
    if (!r.success)
      throw new FlowError(`Invalid step ${i + 1}:\n${errorText(r.error)}`);
    return r.data;
  });
}

/**
 * The orchestrator's steps for one `Exploration.step` call: validated, and every `as` naming a profile of the
 * config.
 *
 * @throws {FlowError} for an invalid step or an unknown profile.
 */
export function checkDirectedSteps(
  raw: unknown,
  profiles: Record<string, unknown>,
): DirectedStep[] {
  const steps = parseDirectedSteps(Array.isArray(raw) ? raw : [raw]);
  for (const s of steps)
    if (s.kind === 'as' && !Object.hasOwn(profiles, s.profile))
      throw new FlowError(`unknown profile "${s.profile}"`);
  return steps;
}
