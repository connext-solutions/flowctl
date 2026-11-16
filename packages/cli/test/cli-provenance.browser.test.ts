import { startFixture, type Fixture } from '@flowctl/fixture-app';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { cli, fixtureProject } from './helpers.js';

let fixture: Fixture;
let configFile: string;
let out: string[];

beforeAll(async () => {
  fixture = await startFixture();
  configFile = await fixtureProject(fixture.url);
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(() => {
  out = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('flowctl replay provenance label', () => {
  it('--json carries the provenance label and notes of every result; a text run prints the label', async () => {
    expect(
      await cli([
        'replay',
        'leave-validation',
        '--json',
        '--config',
        configFile,
      ]),
    ).toBe(0);
    const s: {
      results: { provenance?: string; provenanceNotes?: string[] }[];
    } = JSON.parse(out.join(''));
    expect(s.results.length).toBeGreaterThan(0);
    for (const r of s.results) {
      expect(r.provenance).toMatch(/^(unclassified|unverified|hand-written)$/);
      expect(r.provenanceNotes).toContain('freshness_not_checked');
    }
    out.length = 0;
    expect(
      await cli(['replay', 'leave-validation', '--config', configFile]),
    ).toBe(0);
    expect(out.join('')).toContain('unverified provenance');
  });
});
