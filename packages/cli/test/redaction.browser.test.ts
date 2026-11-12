import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, runsPath } from '@flowctl/core';
import {
  SECRET_ENV,
  allowEnvVars,
  echoFlow,
  freshSecret,
  leaksIn,
  runOutputs,
  testStore,
  withSecret,
} from '@flowctl/core-testing';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { runCli } from '../src/main.js';
import { fixtureProject } from './helpers.js';

/**
 * A known secret never reaches what `flowctl replay` prints (T1.5, ADR 0030): a fresh secret with non-ASCII
 * characters is the `env:` input of a flow on the fixture's `/echo` page, which echoes it in the page, its URL
 * query, a request body and a refused answer's body; the flow's first failing assertion is on the page URL, so the
 * summary quotes it, and lists the refused call. Captured stdout and stderr of the text and `--json` summaries, and
 * every file the runs wrote, are scanned with `findSecret` (core's `test/redaction/`).
 *
 * @remarks Scope today: no automated form login (T1.4). Trace console events are left out of the file scan (the
 *   `it.fails` case in core's `test/redaction/replay.browser.test.ts`).
 */
let fixture: Fixture;
let file: string;
const secret = freshSecret();

beforeAll(async () => {
  fixture = await startFixture();
  file = await fixtureProject(fixture.url);
  const doc = echoFlow('redaction-cli', 'url');
  writeFileSync(
    join(loadConfig(file).flowsPath, `${doc.name}.yaml`),
    stringify(doc),
  );
});
afterAll(async () => {
  await fixture.close();
});

/** Runs `flowctl replay redaction-cli` with `extra` flags; returns the exit code and what it printed. */
async function replay(
  extra: string[],
): Promise<{ code: number; printed: string }> {
  const printed: string[] = [];
  const capture = (s: unknown): boolean => {
    printed.push(String(s));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
  try {
    const store = allowEnvVars(testStore(loadConfig(file)), 'employee', [
      SECRET_ENV,
    ]);
    const code = await withSecret(secret, () =>
      runCli(['replay', 'redaction-cli', ...extra, '--config', file], {
        openStore: () => store,
      }),
    );
    return { code, printed: printed.join('') };
  } finally {
    vi.restoreAllMocks();
  }
}

describe('flowctl replay with a secret input (T1.5)', () => {
  it.each([[[]], [['--json']]])(
    'prints no form of the secret in the summary (flags %j)',
    async (extra: string[]) => {
      const { code, printed } = await replay(extra);
      expect(code, printed).toBe(1);
      expect(printed).toContain('/echo');
      expect(printed).toContain('***');
      expect(leaksIn([['stdout and stderr', printed]], secret)).toEqual([]);
    },
  );

  it('leaves no form of the secret in any file the runs wrote', () => {
    const files = runOutputs(runsPath(loadConfig(file)));
    expect(files.some(([name]) => name.endsWith('run.json'))).toBe(true);
    expect(leaksIn(files, secret)).toEqual([]);
  });
});
