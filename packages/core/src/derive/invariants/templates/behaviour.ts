import type { Assertion } from '../../../flow/index.js';
import { defineInvariant } from '../define.js';
import {
  ControlParams,
  FieldParams,
  RoundTripParams,
  refuse,
  valueInput,
} from '../params.js';
import type { Refusal } from '../types.js';
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
  expand: (e, p): Assertion | Refusal => {
    const input = valueInput(e.inputs, p.valueFrom);
    return typeof input === 'string'
      ? { value: { locator: p.field, equals: input } }
      : input;
  },
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

const GLOB = /[*?[\]{}]/;

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
  expand: (e, _p, b) => {
    const step = b.steps
      .map((i) => e.drive?.steps[i])
      .find((s) => s?.request && accepted(s.request.status));
    if (!step?.request) return refuse('no_evidence', 'no accepted request');
    if (GLOB.test(step.request.path))
      return 'the request path holds a glob character a network assertion would read as a pattern';
    return {
      network: {
        method: step.request.method,
        url: step.request.path,
        status: step.request.status,
      },
    };
  },
});

export const CLIENT_BLOCKS_WHAT_SERVER_REJECTS = defineInvariant({
  id: 'client-blocks-what-server-rejects',
  params: FieldParams,
  bind: (e, p) =>
    bindSteps(
      e,
      p.page,
      'probe of the field',
      (s) => s.action === 'probe' && same(s.field, p.field),
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
    'a status class is not an assertion kind yet: the 4xx is what the probe observed, never a chosen value',
});
