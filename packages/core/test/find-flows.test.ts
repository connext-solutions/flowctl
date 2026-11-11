import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findFlows, findFlowsWithErrors } from '../src/flow/index.js';

const PROFILES = ['employee'];

const flowBody = (name: string, tag: string, start = '/requests'): string =>
  `name: ${name}
goal: Gửi đơn
tags: [${tag}]
profile: employee
start: ${start}
steps:
  - reload: true
assertions:
  - text: "ok"
`;

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'flowctl-find-'));
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(dir, name), body);
  return dir;
}

const OLD = flowBody('old-flow', 'hrm', '/requests/{{uid+1}}');

describe('findFlowsWithErrors', () => {
  it('returns valid flows and one error per invalid file, with the file path', () => {
    const dir = project({
      'good.yaml': flowBody('good', 'hrm'),
      'old-flow.yaml': OLD,
      'broken.yaml': 'name: [unclosed',
    });
    const r = findFlowsWithErrors(dir, PROFILES, {});
    expect(r.flows.map((f) => f.name)).toEqual(['good']);
    expect(r.errors.map((e) => e.file)).toEqual([
      join(dir, 'broken.yaml'),
      join(dir, 'old-flow.yaml'),
    ]);
    expect(r.errors[1]?.message).toContain('{{uid+1}}');
  });

  it('reports invalid files even when a name or tag filter excludes them', () => {
    const dir = project({
      'good.yaml': flowBody('good', 'hrm'),
      'old-flow.yaml': OLD,
    });
    const byName = findFlowsWithErrors(dir, PROFILES, { names: ['good'] });
    expect(byName.flows).toHaveLength(1);
    expect(byName.errors).toHaveLength(1);
    const byTag = findFlowsWithErrors(dir, PROFILES, { tag: 'nope' });
    expect(byTag.flows).toEqual([]);
    expect(byTag.errors).toHaveLength(1);
  });

  it('does not call a requested name missing when its file is invalid', () => {
    const dir = project({ 'old-flow.yaml': OLD });
    expect(
      findFlowsWithErrors(dir, PROFILES, { names: ['old-flow'] }).errors,
    ).toHaveLength(1);
    expect(() =>
      findFlowsWithErrors(dir, PROFILES, { names: ['nope'] }),
    ).toThrow(/Flow not found: nope/);
  });

  it('returns nothing for a missing folder', () => {
    const dir = project({});
    expect(findFlowsWithErrors(join(dir, 'missing'), PROFILES, {})).toEqual({
      flows: [],
      errors: [],
    });
  });

  it('names the file for a YAML syntax error', () => {
    const dir = project({ 'broken.yaml': 'name: [unclosed' });
    const [e] = findFlowsWithErrors(dir, PROFILES, {}).errors;
    expect(e?.message).toContain('broken.yaml');
  });

  it('names the file when the path is a directory (EISDIR)', () => {
    const dir = project({});
    mkdirSync(join(dir, 'x.yaml'));
    const [e] = findFlowsWithErrors(dir, PROFILES, {}).errors;
    expect(e?.message).toContain('x.yaml');
    expect(e?.message).toContain('EISDIR');
  });

  it('leaves findFlows throwing on the first invalid file', () => {
    const dir = project({
      'good.yaml': flowBody('good', 'hrm'),
      'old-flow.yaml': OLD,
    });
    expect(() => findFlows(dir, PROFILES, {})).toThrow(/uid\+1/);
  });
});
