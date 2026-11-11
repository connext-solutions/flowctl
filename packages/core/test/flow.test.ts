import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import {
  FlowError,
  deepExpand,
  escapeTemplates,
  expand,
  findFlows,
  loadFlow,
  normalizeSteps,
  resolveInputs,
  serializeStep,
  type Step,
} from '../src/flow/index.js';

const PROFILES = ['employee', 'manager'];
const ctx = {
  uid: 'ab12cd34',
  now: dayjs('2026-10-05T09:00:00'),
  vars: { org: '/o/x' },
};

const FLOW = `name: leave-request
goal: Gửi đơn rồi duyệt
tags: [hrm, leave]
profile: employee
start: /requests
inputs:
  reason: { value: "Việc riêng {{uid}}" }
  secret: { env: FLOWCTL_TEST_SECRET }
steps:
  - fill: { role: textbox, name: "Lý do" }
    input: reason
  - click: { role: button, name: "Gửi" }
    by: system2
  - as: manager
    goto: /approvals
  - reload: true
assertions:
  - text: "Việc riêng {{uid}}"
  - network: { method: POST, url: /api/requests, status: 201, requestBody: { type: LEAVE } }
`;

function writeFlow(dir: string, name: string, body: string): string {
  const file = join(dir, `${name}.yaml`);
  writeFileSync(file, body);
  return file;
}

describe('normalizeSteps', () => {
  it.each(['/etc/passwd', '../secrets.txt', 'fixtures/../../x'])(
    'refuses an upload path that leaves the project: %s (#45)',
    (file) => {
      expect(() =>
        normalizeSteps([{ upload: { testId: 'f' }, file }], ['employee']),
      ).toThrow(FlowError);
    },
  );

  it('keeps `as` + `goto` as one profile switch and keeps `by`', () => {
    const steps = normalizeSteps(
      [
        { click: { role: 'button', name: 'Gửi' }, by: 'system2' },
        { as: 'manager', goto: '/approvals' },
      ],
      PROFILES,
    );
    expect(steps).toEqual([
      { kind: 'click', target: { role: 'button', name: 'Gửi' }, by: 'system2' },
      { kind: 'as', profile: 'manager', goto: '/approvals' },
    ]);
  });

  it('joins an `as` entry with the `goto` entry right after it', () => {
    expect(
      normalizeSteps(
        [{ as: 'manager' }, { goto: '/approvals' }, { goto: '/x' }],
        PROFILES,
      ),
    ).toEqual([
      { kind: 'as', profile: 'manager', goto: '/approvals' },
      { kind: 'goto', url: '/x' },
    ]);
  });

  it('rejects a step with two actions, naming its index', () => {
    expect(() =>
      normalizeSteps([
        { reload: true },
        { click: { role: 'button' }, press: 'Enter' },
      ]),
    ).toThrow(/steps\[1\]: expected exactly one action/);
  });

  it('requires `input` for fill and select', () => {
    expect(() =>
      normalizeSteps([{ fill: { role: 'textbox', name: 'x' } }]),
    ).toThrow(/steps\[0\]/);
  });

  it('rejects unknown roles and profiles', () => {
    expect(() =>
      normalizeSteps([{ click: { role: 'buton', name: 'x' } }]),
    ).toThrow(FlowError);
    expect(() => normalizeSteps([{ as: 'boss' }], PROFILES)).toThrow(
      /unknown profile "boss"/,
    );
  });
});

describe('templates and inputs', () => {
  it('expands uid and dates with offsets and formats', () => {
    expect(expand('Spike {{uid}}', ctx)).toBe('Spike ab12cd34');
    expect(expand('{{today}}', ctx)).toBe('2026-10-05');
    expect(expand('{{ today+1:DD/MM/YYYY }}', ctx)).toBe('06/10/2026');
    expect(expand('{{today-5}}', ctx)).toBe('2026-09-30');
  });

  it('expands env vars and rejects unknown ones', () => {
    expect(expand('{{env.org}}/hrm', ctx)).toBe('/o/x/hrm');
    expect(expand('{{ env.org }}', ctx)).toBe('/o/x');
    expect(() => expand('{{env.nope}}', ctx)).toThrow(/unknown env var "nope"/);
  });

  it('rejects malformed templates instead of leaving them in the text', () => {
    for (const bad of [
      '{{today+}}',
      '{{today+1:}}',
      '{{todya}}',
      '{{uid',
      '{{env.}}',
      '{{}}',
      '{{ uid {{uid}} }}',
      '{{Uid}}',
    ])
      expect(() => expand(bad, ctx), bad).toThrow(FlowError);
  });

  it('writes a literal brace pair as {{lbrace}} and round-trips any text', () => {
    expect(expand('a {{lbrace}}x}} b', ctx)).toBe('a {{x}} b');
    for (const text of ['Gửi {{uid}}', '{{lbrace}}', '{{{{', 'x}} y', 'plain'])
      expect(expand(escapeTemplates(text), ctx), text).toBe(text);
  });

  it('does not expand templates inside env var values', () => {
    expect(expand('{{env.a}}', { ...ctx, vars: { a: '{{uid}} {{' } })).toBe(
      '{{uid}} {{',
    );
  });

  it('accepts a start page that begins with a template', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flowctl-')), 'org.yaml');
    writeFileSync(
      file,
      'name: org\ngoal: g\nprofile: employee\nstart: "{{env.org}}/hrm"\nsteps:\n  - reload: true\nassertions:\n  - text: x\n',
    );
    expect(loadFlow(file, PROFILES).start).toBe('{{env.org}}/hrm');
  });

  it('expands every string inside nested values', () => {
    expect(
      deepExpand({ a: ['x {{uid}}', 3], b: { c: '{{today}}' } }, ctx),
    ).toEqual({
      a: ['x ab12cd34', 3],
      b: { c: '2026-10-05' },
    });
  });

  it('resolves values and env inputs, failing loudly on a missing env var', () => {
    const inputs = {
      reason: { value: 'R {{uid}}' },
      secret: { env: 'FLOWCTL_TEST_SECRET' },
    };
    expect(resolveInputs(inputs, ctx, { FLOWCTL_TEST_SECRET: 's3' })).toEqual({
      reason: 'R ab12cd34',
      secret: 's3',
    });
    expect(() => resolveInputs(inputs, ctx, {})).toThrow(
      /FLOWCTL_TEST_SECRET is not set/,
    );
  });
});

describe('loadFlow / findFlows', () => {
  it('loads a valid flow with defaults and parsed steps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowctl-flow-'));
    const flow = loadFlow(writeFlow(dir, 'leave-request', FLOW), PROFILES);
    expect(flow.tags).toEqual(['hrm', 'leave']);
    expect(flow.parsedSteps.map((s) => s.kind)).toEqual([
      'fill',
      'click',
      'as',
      'reload',
    ]);
    expect(flow.assertions).toHaveLength(2);
  });

  it('rejects a name that does not match the file name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowctl-flow-'));
    expect(() =>
      loadFlow(writeFlow(dir, 'other-name', FLOW), PROFILES),
    ).toThrow(/must match the file name/);
  });

  it('rejects a step that uses an undeclared input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowctl-flow-'));
    const body = FLOW.replace('input: reason', 'input: missing');
    expect(() =>
      loadFlow(writeFlow(dir, 'leave-request', body), PROFILES),
    ).toThrow(/unknown input "missing"/);
  });

  it('rejects an unknown start profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowctl-flow-'));
    expect(() =>
      loadFlow(writeFlow(dir, 'leave-request', FLOW), ['manager']),
    ).toThrow(/unknown profile "employee"/);
  });

  it('selects flows by name and by tag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowctl-flow-'));
    writeFlow(dir, 'leave-request', FLOW);
    writeFlow(
      dir,
      'other',
      FLOW.replace('name: leave-request', 'name: other').replace(
        '[hrm, leave]',
        '[pm]',
      ),
    );
    expect(findFlows(dir, PROFILES, {}).map((f) => f.name)).toEqual([
      'leave-request',
      'other',
    ]);
    expect(findFlows(dir, PROFILES, { tag: 'pm' }).map((f) => f.name)).toEqual([
      'other',
    ]);
    expect(
      findFlows(dir, PROFILES, { names: ['other'] }).map((f) => f.name),
    ).toEqual(['other']);
    expect(() => findFlows(dir, PROFILES, { names: ['nope'] })).toThrow(
      /Flow not found: nope/,
    );
    expect(findFlows(join(dir, 'missing'), PROFILES, {})).toEqual([]);
  });
});

describe('serializeStep', () => {
  it('writes YAML records that normalise back to the same steps', () => {
    const steps: Step[] = [
      { kind: 'click', target: { role: 'button', name: 'Gửi' } },
      { kind: 'fill', target: { testId: 'r' }, input: 'reason', by: 'system2' },
      {
        kind: 'select',
        target: { role: 'combobox', name: 'Loại' },
        input: 'k',
      },
      { kind: 'check', target: { role: 'checkbox', name: 'x' } },
      { kind: 'hover', target: { testId: 'h' } },
      { kind: 'press', key: 'Enter' },
      { kind: 'scroll', dy: -560 },
      { kind: 'as', profile: 'manager', goto: '/m', by: 'system2' },
      { kind: 'goto', url: '/x' },
      { kind: 'reload' },
      { kind: 'wait', ms: 10 },
      { kind: 'upload', target: { testId: 'f' }, file: 'a.txt' },
      { kind: 'drag', target: { testId: 'a' }, to: { testId: 'b' } },
    ];
    expect(normalizeSteps(steps.map(serializeStep), ['manager'])).toEqual(
      steps,
    );
  });
});
