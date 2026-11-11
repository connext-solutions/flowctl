import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decisionEntry } from '../../src/explore/decisions.js';
import { parseConfig } from '../../src/config.js';
import {
  buildRequest,
  createDriver,
  parseDecision,
} from '../../src/system1/index.js';
import { goldenInput, goldenPage } from './golden-input.js';

/**
 * No-behaviour-change proof of the Driver seam (T5.2): the body a driver from `createDriver` puts on the wire is the
 * frozen `__golden__/system1-request.json`, the decision it returns is the one `parseDecision` gives, and the
 * `decisions.jsonl` entry built from it keeps its shape (`decision-entry.json`).
 */
const GOLDEN = JSON.parse(
  readFileSync(
    new URL('../__golden__/system1-request.json', import.meta.url),
    'utf8',
  ),
) as {
  offered: string[];
  body: { questions: Record<string, { criteria: object }> };
};

/** A valid scored answer: `choice` at 0.9 (or 1 alone), the rest sharing what is left. */
const scored = (keys: string[], choice: string) => ({
  choice,
  confidence: keys.length === 1 ? 1 : 0.9,
  probabilities: Object.fromEntries(
    keys.map((k) => [
      k,
      keys.length === 1 ? 1 : k === choice ? 0.9 : 0.1 / (keys.length - 1),
    ]),
  ),
});
const keysOf = (q: string): string[] =>
  Object.keys(GOLDEN.body.questions[q]?.criteria ?? {});
const ANSWER = {
  answers: {
    operation: scored(GOLDEN.offered, 'TYPE_TEXT'),
    click_target: scored(keysOf('click_target'), '1'),
    type_text_target: scored(keysOf('type_text_target'), '2'),
    select_target: scored(keysOf('select_target'), '3'),
    value: scored(keysOf('value'), 'holidayName'),
  },
  model: 'jev-golden',
};

let url = '';
const seen: {
  method?: string;
  path?: string;
  headers?: IncomingHttpHeaders;
  body: string;
}[] = [];
const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    seen.push({
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ANSWER));
  });
});
beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
});
afterAll(async () => {
  await new Promise((done) => server.close(done));
});

const driver = () =>
  createDriver(
    parseConfig(
      {
        defaultEnv: 'local',
        envs: { local: { baseUrl: 'http://local.test' } },
        profiles: {},
        system1: { baseUrl: url, allowedEnvs: ['local'] },
      },
      '/tmp',
    ),
    'local',
    { TYPESAFE_API_KEY: 'golden-key' },
  );

describe('the Driver seam changes nothing on the wire (T5.2)', () => {
  it('sends the frozen request body, byte for byte, to POST /v1/systemone', async () => {
    seen.length = 0;
    await driver().decide(goldenInput);
    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req?.method).toBe('POST');
    expect(req?.path).toBe('/v1/systemone');
    expect(req?.headers?.['content-type']).toBe('application/json');
    expect(req?.headers?.authorization).toBe('Bearer golden-key');
    expect(req?.body).toBe(JSON.stringify(GOLDEN.body));
    expect(req?.body).toBe(
      JSON.stringify(buildRequest(goldenInput, 'jev-latest').body),
    );
  });

  it('returns the decision parseDecision gives for the same answer', async () => {
    const d = await driver().decide(goldenInput);
    expect(d).toEqual(
      parseDecision(ANSWER, buildRequest(goldenInput, 'jev-latest')),
    );
    expect(d.ranked[0]).toEqual({ op: 'TYPE_TEXT', p: 0.9 });
    expect(d.input?.key).toBe('holidayName');
  });

  it('keeps the decisions.jsonl entry shape', async () => {
    const decision = await driver().decide(goldenInput);
    const entry = decisionEntry({
      source: 'explore',
      step: 2,
      url: goldenPage.url,
      ms: 0,
      outcome: 'TYPE_TEXT [2] textbox "Tên ngày nghỉ*" input=holidayName',
      decision,
      snap: goldenPage,
      secrets: goldenInput.secrets,
    });
    expect(entry.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    await expect(
      `${JSON.stringify({ ...entry, at: '<at>' }, null, 2)}\n`,
    ).toMatchFileSnapshot('decision-entry.json');
  });
});
