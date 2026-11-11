import { describe, expect, it } from 'vitest';
import type { PageSnapshot } from '../src/browser/index.js';
import { choose, isLoop } from '../src/explore/policy.js';
import { inputChoices, opsFor } from '../src/explore/request.js';
import type { Decision } from '../src/system1/index.js';

const decision = (over: Partial<Decision> = {}): Decision => ({
  ranked: [
    { op: 'CLICK', p: 0.9 },
    { op: 'DONE', p: 0.05 },
    { op: 'BLOCKED', p: 0.05 },
  ],
  targets: { CLICK: { id: 7, p: 0.9 } },
  model: 'm',
  ...over,
});

describe('choose', () => {
  it('acts on a confident click', () => {
    expect(choose(decision(), 0.5, false)).toEqual({
      kind: 'act',
      action: { op: 'CLICK', control: 7 },
    });
  });

  it('escalates BLOCKED and low confidence', () => {
    expect(
      choose(decision({ ranked: [{ op: 'BLOCKED', p: 0.9 }] }), 0.5, false),
    ).toMatchObject({ kind: 'escalate', reason: 'BLOCKED' });
    expect(
      choose(decision({ ranked: [{ op: 'CLICK', p: 0.3 }] }), 0.5, false),
    ).toMatchObject({ kind: 'escalate', reason: 'low_confidence' });
    expect(
      choose(decision({ targets: { CLICK: { id: 7, p: 0.2 } } }), 0.5, false),
    ).toMatchObject({ kind: 'escalate', reason: 'low_confidence' });
  });

  it('needs an input for TYPE_TEXT', () => {
    const typing = decision({
      ranked: [{ op: 'TYPE_TEXT', p: 0.9 }],
      targets: { TYPE_TEXT: { id: 3, p: 0.9 } },
    });
    expect(choose(typing, 0.5, false)).toMatchObject({
      kind: 'escalate',
      reason: 'low_confidence',
    });
    expect(
      choose({ ...typing, input: { key: 'reason', p: 0.9 } }, 0.5, false),
    ).toEqual({
      kind: 'act',
      action: { op: 'TYPE_TEXT', control: 3, input: 'reason' },
    });
  });

  it('takes the best other operation after a rejected DONE, without the threshold', () => {
    const done = decision({
      ranked: [
        { op: 'DONE', p: 0.9 },
        { op: 'WAIT', p: 0.06 },
        { op: 'CLICK', p: 0.04 },
      ],
    });
    expect(choose(done, 0.5, true)).toEqual({
      kind: 'act',
      action: { op: 'WAIT' },
    });
    expect(
      choose(
        decision({
          ranked: [
            { op: 'DONE', p: 0.9 },
            { op: 'BLOCKED', p: 0.1 },
          ],
        }),
        0.5,
        true,
      ),
    ).toMatchObject({ kind: 'escalate', reason: 'done_rejected' });
  });

  it('keeps the threshold for the target and the input of the runner-up after a rejected DONE (#42)', () => {
    const ranked: Decision['ranked'] = [
      { op: 'DONE', p: 0.97 },
      { op: 'CLICK', p: 0.02 },
    ];
    expect(
      choose(
        decision({ ranked, targets: { CLICK: { id: 13, p: 0.04 } } }),
        0.5,
        true,
      ),
    ).toMatchObject({ kind: 'escalate', reason: 'low_confidence' });
    expect(
      choose(
        decision({ ranked, targets: { CLICK: { id: 13, p: 0.9 } } }),
        0.5,
        true,
      ),
    ).toEqual({ kind: 'act', action: { op: 'CLICK', control: 13 } });
    expect(
      choose(
        decision({
          ranked: [
            { op: 'DONE', p: 0.97 },
            { op: 'TYPE_TEXT', p: 0.02 },
          ],
          targets: { TYPE_TEXT: { id: 4, p: 0.9 } },
          input: { key: 'reason', p: 0.1 },
        }),
        0.5,
        true,
      ),
    ).toMatchObject({ kind: 'escalate', reason: 'low_confidence' });
  });
});

describe('isLoop', () => {
  const same = { op: 'CLICK', control: 'button "Lưu"', changed: false };
  it('is true after three identical actions that changed nothing', () => {
    expect(isLoop([same, same, same])).toBe(true);
    expect(isLoop([same, same])).toBe(false);
    expect(isLoop([same, { ...same, changed: true }, same])).toBe(false);
    expect(isLoop([same, { ...same, control: 'x' }, same])).toBe(false);
    const wait = { op: 'WAIT', control: 'wait', changed: false };
    expect(isLoop([wait, wait, wait])).toBe(false);
  });
});

describe('request helpers', () => {
  const snap = (down: boolean, up: boolean): PageSnapshot => ({
    url: 'u',
    title: 't',
    text: '',
    controls: [],
    canScrollDown: down,
    canScrollUp: up,
    fingerprint: 'f',
  });
  it('offers TYPE_TEXT/SELECT only with inputs, scrolling only when possible', () => {
    expect(opsFor(snap(false, false), false)).toEqual([
      'CLICK',
      'PRESS_ENTER',
      'WAIT',
      'DONE',
      'BLOCKED',
    ]);
    expect(opsFor(snap(true, true), true)).toEqual([
      'CLICK',
      'TYPE_TEXT',
      'SELECT',
      'PRESS_ENTER',
      'WAIT',
      'DONE',
      'BLOCKED',
      'SCROLL_DOWN',
      'SCROLL_UP',
    ]);
  });
  it('previews plain inputs and hides secrets', () => {
    expect(
      inputChoices(
        { reason: { value: 'Việc {{uid}}' }, token: { env: 'TOKEN' } },
        { reason: 'Việc ab12', token: 's3cret' },
      ),
    ).toEqual([{ key: 'reason', preview: 'Việc ab12' }, { key: 'token' }]);
  });
});
