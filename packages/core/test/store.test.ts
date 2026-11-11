import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { joinSwitches, loadFlow, updateLocators } from '../src/flow/index.js';

describe('updateLocators', () => {
  it('rewrites only the given steps and keeps comments', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flowctl-')), 'f.yaml');
    writeFileSync(
      file,
      [
        '# keep me',
        'name: f',
        'goal: g',
        'profile: employee',
        'start: /a',
        'steps:',
        '  - click: { role: button, name: A }',
        '  - as: manager',
        '    goto: /b',
        '  - click: { role: button, name: B } # old',
        'assertions:',
        '  - text: x',
        '',
      ].join('\n'),
    );
    updateLocators(file, new Map([[2, { role: 'button', name: 'C' }]]));
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# keep me');
    const flow = loadFlow(file, ['employee', 'manager']);
    expect(flow.parsedSteps[0]).toEqual({
      kind: 'click',
      target: { role: 'button', name: 'A' },
    });
    expect(flow.parsedSteps[2]).toEqual({
      kind: 'click',
      target: { role: 'button', name: 'C' },
    });
  });

  it('maps step indices past a profile switch written as two entries', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'flowctl-')), 'f.yaml');
    writeFileSync(
      file,
      [
        'name: f',
        'goal: g',
        'profile: employee',
        'start: /a',
        'steps:',
        '  - as: manager',
        '  - goto: /b',
        '  - click: { role: button, name: B }',
        'assertions:',
        '  - text: x',
        '',
      ].join('\n'),
    );
    updateLocators(file, new Map([[1, { role: 'button', name: 'C' }]]));
    expect(loadFlow(file, ['employee', 'manager']).parsedSteps).toEqual([
      { kind: 'as', profile: 'manager', goto: '/b' },
      { kind: 'click', target: { role: 'button', name: 'C' } },
    ]);
  });
});

describe('joinSwitches', () => {
  it('joins only a well-formed goto into the switch before it', () => {
    expect(
      joinSwitches([
        { kind: 'as', profile: 'm', by: 'system2' },
        { kind: 'goto', url: '/x', by: 'system2' },
        { kind: 'as', profile: 'e' },
        { kind: 'goto' },
      ]),
    ).toEqual([
      { kind: 'as', profile: 'm', goto: '/x', by: 'system2' },
      { kind: 'as', profile: 'e' },
      { kind: 'goto' },
    ]);
  });
});

describe('updateLocators through a symlink (#46)', () => {
  it('replaces the link and leaves its target unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowctl-'));
    const target = join(mkdtempSync(join(tmpdir(), 'flowctl-')), 'target.yaml');
    const body = [
      'name: f',
      'goal: g',
      'profile: employee',
      'start: /a',
      'steps:',
      '  - click: { role: button, name: A }',
      'assertions:',
      '  - text: x',
      '',
    ].join('\n');
    writeFileSync(target, body);
    const file = join(dir, 'f.yaml');
    symlinkSync(target, file);
    updateLocators(file, new Map([[0, { role: 'button', name: 'B' }]]));
    expect(readFileSync(target, 'utf8')).toBe(body);
    expect(lstatSync(file).isSymbolicLink()).toBe(false);
    expect(readFileSync(file, 'utf8')).toContain('name: B');
  });
});
