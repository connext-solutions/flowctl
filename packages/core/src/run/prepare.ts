import type { Page } from 'playwright';
import type { ActContext } from '../browser/index.js';
import type { LoadedConfig, ResolvedEnv } from '../config.js';
import {
  deepExpand,
  expand,
  newTemplateContext,
  resolveInputs,
  withoutSourceRef,
  type Assertion,
  type Flow,
  type Step,
  type TemplateContext,
  type TemplatedValue,
} from '../flow/index.js';

/** A flow with its inputs and templates resolved for one run. */
export interface Prepared {
  templates: TemplateContext;
  start: string;
  values: Record<string, string>;
  /** Resolved values of `{ env }` inputs: never sent to a model. */
  secrets: string[];
  /**
   * Values this run expanded from templates, longest first: each `{ value }` input whose text holds a
   * template, then the uid. The recorder turns them back into templates in recorded names (#24).
   */
  templated: TemplatedValue[];
  steps: Step[];
  assertions: Assertion[];
}

/**
 * Resolves inputs and expands templates (`{{uid}}`, `{{today±N}}`, `{{env.X}}`) for one run.
 *
 * @remarks `{ env }` inputs never enter `templated`: they are secrets, and a recorded name must not
 *   be matched against them.
 * @throws {FlowError} when an `{ env }` input is not set.
 */
export function prepareRun(flow: Flow, env: ResolvedEnv): Prepared {
  const templates = newTemplateContext(env.vars);
  const values = resolveInputs(flow.inputs, templates);
  const fromInputs = Object.entries(flow.inputs).flatMap(
    ([key, src]): TemplatedValue[] => {
      const value = values[key] ?? '';
      return 'value' in src && src.value.includes('{{') && value !== ''
        ? [{ value, template: src.value }]
        : [];
    },
  );
  return {
    templates,
    start: expand(flow.start, templates),
    values,
    secrets: Object.entries(flow.inputs).flatMap(([key, src]) =>
      'env' in src ? [values[key] ?? ''] : [],
    ),
    templated: [
      ...fromInputs,
      { value: templates.uid, template: '{{uid}}' },
    ].sort((a, b) => b.value.length - a.value.length),
    steps: deepExpand(flow.parsedSteps, templates),
    assertions: deepExpand(flow.assertions.map(withoutSourceRef), templates),
  };
}

/** What an action needs on `page`: the page, input values, timeouts, templated values (`RunSession.ctx()`). */
export const actContext = (
  cfg: LoadedConfig,
  page: Page,
  p: Prepared,
): ActContext => ({
  page,
  values: p.values,
  exec: {
    testIdAttribute: cfg.testIdAttribute,
    timeout: cfg.stepTimeout,
    flowsRoot: cfg.flowsPath,
    secrets: p.secrets,
  },
  templated: p.templated,
});
