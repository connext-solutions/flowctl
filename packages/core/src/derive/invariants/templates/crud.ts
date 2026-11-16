import type { DriveStep, Evidence } from '../evidence.js';
import { defineInvariant } from '../define.js';
import {
  ValueParams,
  refuse,
  valueInput,
  withinOn,
  writes,
} from '../params.js';
import { accepted, bindSteps, driveFinding } from '../steps.js';
import type { Binding, InvariantId, Refusal } from '../types.js';

type Params = typeof ValueParams._output;

/**
 * Binds a value invariant: the input must be a `QA-` `{{uid}}` value input, a `within` must name a region or control
 * of the page in the map, and the drive must hold a step of one of `actions` on the page that wrote a value of that
 * input (`writes`) and that `pick` keeps.
 */
function bindValue(
  evidence: Evidence,
  p: Params,
  actions: readonly DriveStep['action'][],
  pick: (s: DriveStep) => boolean = () => true,
): Binding | Refusal {
  const input = valueInput(evidence.inputs, p.valueFrom);
  if (typeof input !== 'string') return input;
  if (
    p.within !== undefined &&
    withinOn(evidence, p.page, p.within) === undefined
  )
    return refuse(
      'no_evidence',
      'the within names no region or control of the page',
    );
  return bindSteps(
    evidence,
    p.page,
    `${actions.join(' or ')} step that wrote the input`,
    (s) => actions.includes(s.action) && writes(input, s.sent) && pick(s),
  );
}

/**
 * The `text` assertion of a value: the input's own template text, copied (ADR 0026 has no input reference inside an
 * assertion), held `within` the list region the parameters name. Without a region of the page in the map it refuses:
 * the same text is in the status line after a create or an edit, so an unbounded `text` passes on the toast alone and
 * cannot catch the defect (ADR 0041 section 5).
 */
function textAssertion(
  evidence: Evidence,
  p: Params,
): { text: string; within: NonNullable<Params['within']> } | Refusal {
  const input = valueInput(evidence.inputs, p.valueFrom);
  if (typeof input !== 'string') return input;
  if (
    p.within === undefined ||
    withinOn(evidence, p.page, p.within) !== 'region'
  )
    return refuse(
      'no_evidence',
      'the parameters name no list region of the page',
    );
  return { text: input, within: p.within };
}

/**
 * A CRUD template: a step with a successful request after which the value's `listed` is not `want` is a finding.
 * `pick` narrows the steps it binds; `notExpandable` is the sentence of a template that writes no assertion.
 */
function crud(
  id: InvariantId,
  action: DriveStep['action'],
  want: boolean,
  pick?: (s: DriveStep) => boolean,
  notExpandable?: string,
) {
  return defineInvariant({
    id,
    params: ValueParams,
    bind: (e, p) => bindValue(e, p, [action], pick),
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

/**
 * A delete binds only where its pass means something (ADR 0020 section g): the item was listed before and the click
 * sent a request. A delete of an item that was never shown, or a click that sent nothing, would pass "not listed
 * after" without testing anything, so it refuses.
 */
export const CRUD_DELETE_ABSENT = crud(
  'crud-delete-absent',
  'delete',
  false,
  (s) => s.before.listed && s.request !== null,
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
  expand: () =>
    'a flow assertion cannot force the reload it needs: a text assertion also passes on the list drawn before any reload',
});
