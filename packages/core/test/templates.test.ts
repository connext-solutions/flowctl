import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { templateName } from '../src/browser/recorder.js';
import {
  FlowError,
  checkTemplates,
  escapeTemplates,
  expand,
  loadFlow,
  untemplateUid,
} from '../src/flow/index.js';
import { prepareRun } from '../src/run/prepare.js';
import type { ResolvedEnv } from '../src/config.js';

const UID = 'ab12cd34';
const ctx = { uid: UID, now: dayjs('2026-10-05T09:00:00'), vars: {} };

const flowYaml = (extra: string, step = 'reload: true'): string =>
  `name: t\ngoal: g\nprofile: employee\nstart: /x\n${extra}steps:\n  - ${step}\nassertions:\n  - text: ok\n`;

function write(body: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'flowctl-')), 't.yaml');
  writeFileSync(file, body);
  return file;
}

describe('template grammar', () => {
  it.each(['{{uid+1}}', '{{uid:FMT}}', '{{today+1d}}', '{{UID}}'])(
    'rejects %s with the offset and the allowed forms',
    (bad) => {
      const text = `ab ${bad}`;
      expect(() => expand(text, ctx)).toThrow(/at character 3 of/);
      expect(() => expand(text, ctx)).toThrow(/allowed: \{\{uid\}\}/);
    },
  );
});

describe('adjacent text round-trips', () => {
  const names = [
    '{ab12cd34}',
    '}ab12cd34{',
    '}{ab12cd34}{',
    '{{ab12cd34}}',
    '{{{ab12cd34',
    '{{x}}',
    '{{{{',
    '{{lbrace}}',
    'a}}b{{c',
    '{',
    '}',
    'ab12cd34ab12cd34',
  ];

  it.each(names)('templateName(%s) expands back to the name', (name) => {
    expect(
      expand(templateName(name, [{ value: UID, template: '{{uid}}' }]), ctx),
    ).toBe(name);
  });

  it('round-trips every short string over { } and a uid-like letter', () => {
    const alphabet = ['{', '}', 'U', 'a'];
    const c = { ...ctx, uid: 'U' };
    const all: string[] = [''];
    for (let i = 0; i < all.length && all[i]!.length < 6; i++)
      for (const ch of alphabet) all.push(all[i] + ch);
    for (const name of all) {
      expect(
        expand(templateName(name, [{ value: 'U', template: '{{uid}}' }]), c),
        name,
      ).toBe(name);
      expect(expand(escapeTemplates(name), c), name).toBe(name);
    }
  });
});

describe('untemplateUid', () => {
  it('turns a literal uid into {{uid}} and keeps written templates', () => {
    expect(
      untemplateUid(
        { url: `/a/${UID}?b={{uid}}&c={{today}}`, n: [`{${UID}}`] },
        UID,
      ),
    ).toEqual({ url: '/a/{{uid}}?b={{uid}}&c={{today}}', n: ['{{{uid}}}'] });
    expect(expand('{{{uid}}}', ctx)).toBe(`{${UID}}`);
  });
});

describe('load-time validation', () => {
  it('names the field and offset of a malformed template in a step', () => {
    const file = write(flowYaml('', 'goto: "/a/{{uid+1}}"'));
    expect(() => loadFlow(file, ['employee'])).toThrow(FlowError);
    expect(() => loadFlow(file, ['employee'])).toThrow(
      /steps\[0\]\.url: malformed template at character 3 of "\/a\/\{\{uid\+1\}\}"/,
    );
  });

  it.each([
    ['start', 'start: "/x{{today+1d}}"\n'],
    ['input', 'start: /x\ninputs:\n  a: { value: "{{UID}}" }\n'],
  ])('rejects a bad template in the %s', (_where, extra) => {
    const body = `name: t\ngoal: g\nprofile: employee\n${extra}steps:\n  - reload: true\nassertions:\n  - text: ok\n`;
    expect(() => loadFlow(write(body), ['employee'])).toThrow(
      /malformed template/,
    );
  });

  it('loads hooks that contain {{...}} because hooks are shell text', () => {
    const file = write(
      flowYaml(
        `setup: "docker inspect -f '{{.State.Running}}' db"\nteardown: "echo {{uid+1}}"\n`,
      ),
    );
    const flow = loadFlow(file, ['employee']);
    expect(flow.setup).toContain('{{.State.Running}}');
    expect(flow.teardown).toBe('echo {{uid+1}}');
  });

  it('still rejects a malformed template in steps when hooks are present', () => {
    const file = write(
      flowYaml('setup: "echo {{x}}"\n', 'goto: "/a/{{uid+1}}"'),
    );
    expect(() => loadFlow(file, ['employee'])).toThrow(/steps\[0\]\.url/);
  });

  it('rejects a bad template in a locator name', () => {
    const file = write(
      flowYaml('', 'click: { role: button, name: "{{uid:FMT}}" }'),
    );
    expect(() => loadFlow(file, ['employee'])).toThrow(
      /steps\[0\]\.target\.name/,
    );
  });

  it('accepts an escaped literal and an env reference not defined yet', () => {
    const file = write(
      flowYaml(
        '',
        'click: { role: button, name: "Tổng {{lbrace}}x}} {{env.org}}" }',
      ),
    );
    expect(loadFlow(file, ['employee']).parsedSteps).toHaveLength(1);
  });

  it('checkTemplates reports the path of a nested value', () => {
    expect(() => checkTemplates({ a: [{ b: '{{nope}}' }] }, 'steps')).toThrow(
      /^steps\.a\[0\]\.b: malformed template/,
    );
  });

  it('prepareRun still throws FlowError for a malformed template', () => {
    const file = write(flowYaml('', 'goto: "/a"'));
    const flow = loadFlow(file, ['employee']);
    const bad = { ...flow, start: '{{today+}}' };
    const env: ResolvedEnv = {
      name: 'local',
      baseUrl: 'http://x',
      loginUrl: '/login',
      vars: {},
    };
    expect(() => prepareRun(bad, env)).toThrow(FlowError);
  });

  it('prepareRun lists the uid and every templated value input for the recorder (#24)', () => {
    const file = write(
      flowYaml(
        'inputs:\n  reason: { value: "Nghỉ {{today+1:DD/MM}} {{uid}}" }\n  plain: { value: "Cố định" }\n  pw: { env: FLOWCTL_TEST_TEMPLATED }\n',
      ),
    );
    process.env.FLOWCTL_TEST_TEMPLATED = 'not-a-template';
    try {
      const flow = loadFlow(file, ['employee']);
      const env: ResolvedEnv = {
        name: 'local',
        baseUrl: 'http://x',
        loginUrl: '/login',
        vars: {},
      };
      const p = prepareRun(flow, env);
      expect(p.templated).toEqual([
        {
          value: p.values.reason,
          template: 'Nghỉ {{today+1:DD/MM}} {{uid}}',
        },
        { value: p.templates.uid, template: '{{uid}}' },
      ]);
    } finally {
      delete process.env.FLOWCTL_TEST_TEMPLATED;
    }
  });
});
