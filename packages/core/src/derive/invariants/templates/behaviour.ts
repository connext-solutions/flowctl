import { defineInvariant } from '../define.js';
import {
  ControlParams,
  FieldParams,
  RoundTripParams,
  refuse,
  valueInput,
  writes,
} from '../params.js';
import { accepted, bindSteps, driveFinding, same } from '../steps.js';

export const ROUND_TRIP_EQUALITY = defineInvariant({
  id: 'round-trip-equality',
  params: RoundTripParams,
  bind: (e, p) => {
    const input = valueInput(e.inputs, p.valueFrom);
    if (typeof input !== 'string') return input;
    return bindSteps(
      e,
      p.page,
      'step that read the value back',
      (s) =>
        (s.action === 'create' || s.action === 'edit') &&
        same(s.field, p.field) &&
        writes(input, s.sent) &&
        s.readBack !== null,
    );
  },
  evaluate: (e, _p, b) =>
    b.steps.flatMap((i) => {
      const s = e.drive?.steps[i];
      return s !== undefined && s.readBack !== s.sent
        ? [driveFinding('round-trip-equality', e, i, 'readBack')]
        : [];
    }),
  expand: () =>
    'a value assertion reads the field the flow typed into: the flow schema cannot read the value back from a fresh load',
});

export const STATE_CHANGE_AFTER_ACTION = defineInvariant({
  id: 'state-change-after-action',
  params: ControlParams,
  bind: (e, p) =>
    bindSteps(
      e,
      p.page,
      'transition step',
      (s) => s.action === 'transition' && same(s.control, p.control),
    ),
  evaluate: (e, _p, b) =>
    b.steps.flatMap((i) => {
      const s = e.drive?.steps[i];
      return s?.request &&
        accepted(s.request.status) &&
        s.before.state === s.after.state
        ? [
            driveFinding(
              'state-change-after-action',
              e,
              i,
              'after',
              s.request.status,
            ),
          ]
        : [];
    }),
  expand: () =>
    'the change is a comparison of two observations: no assertion kind compares them',
});

/** The toast text with the value the step wrote replaced, so two steps with different values compare equal. */
const shape = (toast: string, sent: string | undefined): string =>
  sent === undefined || sent === '' ? toast : toast.split(sent).join('{value}');

export const SUCCESS_TOAST_IMPLIES_2XX = defineInvariant({
  id: 'success-toast-implies-2xx',
  params: ControlParams,
  bind: (e, p) => {
    const bindings = bindSteps(e, p.page, 'step of the control', (s) =>
      same(s.control, p.control),
    );
    if (!bindings.ok) return bindings;
    const hasAccepted = bindings.steps.some((i) => {
      const s = e.drive?.steps[i];
      return s?.request && accepted(s.request.status) && s.toast !== null;
    });
    return hasAccepted
      ? bindings
      : refuse('no_evidence', 'no accepted request showed a toast');
  },
  evaluate: (e, _p, b) => {
    const steps = b.steps.flatMap((i) => {
      const s = e.drive?.steps[i];
      return s === undefined ? [] : [{ i, s }];
    });
    const success = new Set(
      steps.flatMap(({ s }) =>
        s.request && accepted(s.request.status) && s.toast !== null
          ? [shape(s.toast, s.sent)]
          : [],
      ),
    );
    return steps.flatMap(({ i, s }) =>
      s.toast !== null &&
      success.has(shape(s.toast, s.sent)) &&
      !(s.request && accepted(s.request.status))
        ? [
            driveFinding(
              'success-toast-implies-2xx',
              e,
              i,
              'toast',
              s.request?.status,
            ),
          ]
        : [],
    );
  },
  expand: () =>
    'no assertion kind ties a toast to the status of the request that caused it: a network assertion alone does not catch a toast shown on a failure',
});

/**
 * Binds only a probe whose verdict means something (ADR 0020 section g): the client blocked it (an actionable control,
 * a settled window, no request; the drive record refuses `clientBlocked` otherwise) or it sent a request the server
 * answered. A probe that sent nothing and was not seen to block is refused, never passed.
 */
export const CLIENT_BLOCKS_WHAT_SERVER_REJECTS = defineInvariant({
  id: 'client-blocks-what-server-rejects',
  params: FieldParams,
  bind: (e, p) =>
    bindSteps(
      e,
      p.page,
      'probe of the field',
      (s) =>
        s.action === 'probe' &&
        same(s.field, p.field) &&
        (s.clientBlocked || s.request !== null),
    ),
  evaluate: (e, _p, b) =>
    b.steps.flatMap((i) => {
      const s = e.drive?.steps[i];
      return s?.request &&
        !s.clientBlocked &&
        s.request.status >= 400 &&
        s.request.status < 500
        ? [
            driveFinding(
              'client-blocks-what-server-rejects',
              e,
              i,
              'request/status',
              s.request.status,
            ),
          ]
        : [];
    }),
  expand: () =>
    'a blocked client is a network assertion with absent: true, and no evidence holds the URL the blocked form would send to, so the pattern ADR 0020 section g needs would be chosen, not bound',
});
