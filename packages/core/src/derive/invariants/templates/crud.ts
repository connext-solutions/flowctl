import type { DriveStep, Evidence } from '../evidence.js';
import { defineInvariant } from '../define.js';
import { ValueParams, valueInput } from '../params.js';
import { accepted, bindSteps, driveFinding } from '../steps.js';
import type { Binding, InvariantId, Refusal } from '../types.js';

type Params = typeof ValueParams._output;

/**
 * Binds a value invariant: the input must be a `QA-` `{{uid}}` value input and the drive must hold a step of one of
 * `actions` on the page that `pick` keeps.
 */
function bindValue(
  evidence: Evidence,
  p: Params,
  actions: readonly DriveStep['action'][],
  pick: (s: DriveStep) => boolean = () => true,
): Binding | Refusal {
  const input = valueInput(evidence.inputs, p.valueFrom);
  if (typeof input !== 'string') return input;
  return bindSteps(
    evidence,
    p.page,
    `${actions.join(' or ')} step`,
    (s) => actions.includes(s.action) && pick(s),
  );
}

/**
 * The `text` assertion of a value: the input's own template text, copied (ADR 0026 has no input reference inside an
 * assertion), held `within` a region when the parameters name one.
 */
function textAssertion(
  evidence: Evidence,
  p: Params,
): { text: string; within?: NonNullable<Params['within']> } | Refusal {
  const input = valueInput(evidence.inputs, p.valueFrom);
  if (typeof input !== 'string') return input;
  return {
    text: input,
    ...(p.within === undefined ? {} : { within: p.within }),
  };
}

/** A CRUD template: a step with a successful request after which the value's `listed` is not `want` is a finding. */
function crud(
  id: InvariantId,
  action: DriveStep['action'],
  want: boolean,
  notExpandable?: string,
) {
  return defineInvariant({
    id,
    params: ValueParams,
    bind: (e, p) => bindValue(e, p, [action]),
    evaluate: (e, _p, b) =>
      b.steps.flatMap((i) => {
        const s = e.drive?.steps[i];
        return s?.request &&
          accepted(s.request.status) &&
          s.after.listed !== want
          ? [driveFinding(id, e, i, 'after', s.request.status)]
          : [];
      }),
    expand: (e, p) => notExpandable ?? textAssertion(e, p),
  });
}

export const CRUD_CREATE_APPEARS = crud('crud-create-appears', 'create', true);
export const CRUD_EDIT_SHOWS = crud('crud-edit-shows', 'edit', true);
export const CRUD_DELETE_ABSENT = crud(
  'crud-delete-absent',
  'delete',
  false,
  'text absence is not an assertion kind yet: text only says what is present',
);

export const RELOAD_KEEPS_DATA = defineInvariant({
  id: 'reload-keeps-data',
  params: ValueParams,
  bind: (e, p) =>
    bindValue(e, p, ['create', 'edit'], (s) => s.reloaded !== null),
  evaluate: (e, _p, b) =>
    b.steps.flatMap((i) => {
      const s = e.drive?.steps[i];
      return s?.after.listed === true && s.reloaded?.listed === false
        ? [driveFinding('reload-keeps-data', e, i, 'reloaded')]
        : [];
    }),
  expand: (e, p) => textAssertion(e, p),
});
