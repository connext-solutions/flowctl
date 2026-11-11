import type { PageSnapshot } from '../browser/index.js';
import type { LoadedConfig } from '../config.js';
import type { Flow, FlowDoc } from '../flow/index.js';
import { RunError } from '../run/index.js';
import {
  createDriver,
  type CheckedDriver,
  type InputChoice,
  type Op,
} from '../system1/index.js';
import type { ExploreRequest } from './types.js';

const BASE_OPS: Op[] = [
  'CLICK',
  'TYPE_TEXT',
  'SELECT',
  'PRESS_ENTER',
  'WAIT',
  'DONE',
  'BLOCKED',
];

/** The flow a {@link RunSession} runs for an exploration: the request, with no steps yet. */
export const draftFlow = (req: ExploreRequest): Flow => ({
  name: 'exploration',
  goal: req.goal,
  tags: [],
  profile: req.profile,
  setup: req.setup,
  teardown: req.teardown,
  start: req.start,
  inputs: req.inputs ?? {},
  steps: [],
  assertions: req.assertions,
  file: '',
  parsedSteps: [],
});

/** Operations offered on this page: TYPE_TEXT/SELECT only with inputs, scrolling only when possible. */
export const opsFor = (snap: PageSnapshot, hasInputs: boolean): Op[] => [
  ...BASE_OPS.filter(
    (op) => hasInputs || (op !== 'TYPE_TEXT' && op !== 'SELECT'),
  ),
  ...(snap.canScrollDown ? (['SCROLL_DOWN'] as const) : []),
  ...(snap.canScrollUp ? (['SCROLL_UP'] as const) : []),
];

/**
 * The inputs System 1 chooses from: key plus resolved value, but only the key for `{ env }`
 * secrets.
 *
 * @see docs/adr/0006-no-text-generation.md
 */
export const inputChoices = (
  inputs: FlowDoc['inputs'],
  values: Record<string, string>,
): InputChoice[] =>
  Object.entries(inputs).map(([key, src]) =>
    'value' in src ? { key, preview: values[key] } : { key },
  );

/**
 * The System 1 driver of an exploration on `env`, or the refusal that ends the run at once (ADR 0005).
 *
 * @returns the driver from `createDriver`, or its `RunError` (`system1_not_allowed`).
 * @throws {ConfigError} as `createDriver` does: no `system1` section, an unset or malformed key, a bad endpoint.
 */
export function driverOrRefusal(
  cfg: LoadedConfig,
  env: string,
  vars: NodeJS.ProcessEnv | undefined,
): CheckedDriver | RunError {
  try {
    return createDriver(cfg, env, vars);
  } catch (e) {
    if (e instanceof RunError) return e;
    throw e;
  }
}
