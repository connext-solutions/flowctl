import {
  startFakeSystem1,
  startFixture,
  type FakeSystem1,
  type Fixture,
} from '@flowctl/fixture-app';
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
import { createServer, type Server } from 'node:http';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cli, fixtureProject } from './helpers.js';

const FLAKY_FLOW = `name: flaky-page
goal: A page that is ready on its first visit and not on the second
profile: employee
start: /page
steps:
  - click: { role: button, name: "Go" }
assertions:
  - text: "Ready"
`;

const RENAMED_FLOW = `name: renamed
goal: Submitting an empty request shows the validation error
profile: employee
start: /requests
steps:
  - click: { role: button, name: "Gửi đơn" }
assertions:
  - text: Vui lòng nhập lý do
`;

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err.push(String(s));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('flowctl replay --repeat with a flaky flow', () => {
  let server: Server;
  let baseUrl: string;
  let visits = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const ready = req.url === '/page' ? ++visits % 2 === 1 : true;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><button>Go</button><p>${ready ? 'Ready' : 'Not yet'}</p>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('no port');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('exits 1 and prints the flaky line when one run passes and one fails', async () => {
    const file = await fixtureProject(baseUrl);
    writeFileSync(join(dirname(file), '.flows', 'flaky-page.yaml'), FLAKY_FLOW);
    visits = 0;
    expect(
      await cli(['replay', 'flaky-page', '--repeat', '2', '--config', file]),
    ).toBe(1);
    const text = out.join('');
    expect(text).toContain('~ flaky-page flaky: passed, failed');
    expect(text).toContain('0 passed, 0 failed, 1 flaky, 0 errors');
  });
});

describe('flowctl replay --heal', () => {
  let fixture: Fixture;
  let system1: FakeSystem1;
  let file: string;

  const savedKey = process.env.TYPESAFE_API_KEY;

  beforeAll(async () => {
    process.env.TYPESAFE_API_KEY = 'test-key';
    fixture = await startFixture();
    system1 = await startFakeSystem1([{ op: 'CLICK', target: 'Gửi' }]);
    file = await fixtureProject(fixture.url, {
      system1: { baseUrl: system1.url, allowedEnvs: ['local'] },
    });
    writeFileSync(join(dirname(file), '.flows', 'renamed.yaml'), RENAMED_FLOW);
  });
  afterAll(async () => {
    if (savedKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = savedKey;
    await system1.close();
    await fixture.close();
  });

  it('fails without --heal and heals the renamed button with it', async () => {
    expect(await cli(['replay', 'renamed', '--config', file])).toBe(1);
    expect(out.join('')).toContain('step 0 not_found');
    expect(system1.requests).toHaveLength(0);
    out.length = 0;
    expect(
      await cli(['replay', 'renamed', '--heal', '--json', '--config', file]),
    ).toBe(0);
    const s: { passed: number; results: { healed: number[] }[] } = JSON.parse(
      out.join(''),
    );
    expect(s.passed).toBe(1);
    expect(s.results[0]?.healed).toEqual([0]);
    expect(system1.requests.length).toBeGreaterThan(0);
  });
});
