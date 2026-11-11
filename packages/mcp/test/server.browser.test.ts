import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type LoadedConfig, MCP_TOOLS, type TrustStore } from '@flowctl/core';
import {
  exploreConfig,
  seedProfiles,
  testStore,
  VARS,
} from '@flowctl/core-testing';
import {
  type FakeMove,
  type FakeSystem1,
  type Fixture,
  startFakeSystem1,
  startFixture,
} from '@flowctl/fixture-app';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { type Browser, chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createServer, PAGE_DATA_NOTE } from '../src/index.js';

/**
 * The MCP server through a real MCP client (ADR 0012, ADR 0027): every tool is guarded by the trust store, an
 * exploration runs with the fake System 1 on fixture-app, saves only after a model-free replay, and page text
 * comes back marked as data.
 */
let fixture: Fixture;
let browser: Browser;
let s1: FakeSystem1 | undefined;
let close: (() => Promise<void>) | undefined;
const saved = { ...process.env };

beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
  Object.assign(process.env, VARS);
});
afterAll(async () => {
  process.env = saved;
  await browser.close();
  await fixture.close();
});
afterEach(async () => {
  await close?.();
  close = undefined;
  await s1?.close();
  s1 = undefined;
});

/**
 * A server for the fixture app. `store` is `trusted` (made from this config), `none`, or `moved`: the store records
 * the env on another origin, as after a pull request that moved `baseUrl`.
 */
async function connect(
  moves: FakeMove[],
  store: 'none' | 'trusted' | 'moved' = 'trusted',
): Promise<{ client: Client; cfg: LoadedConfig }> {
  s1 = await startFakeSystem1(moves);
  const cfg = exploreConfig(fixture.url, s1.url);
  await seedProfiles(cfg, fixture.url);
  const trusted: TrustStore | undefined =
    store === 'trusted'
      ? testStore(cfg)
      : store === 'moved'
        ? testStore({
            ...cfg,
            envs: { local: { baseUrl: 'http://127.0.0.1:1', vars: {} } },
          })
        : undefined;
  const made = createServer({
    cfg,
    openStore: () => trusted,
    browser: () => Promise.resolve(browser),
    version: 'test',
  });
  close = made.close;
  const [a, b] = InMemoryTransport.createLinkedPair();
  await made.server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return { client, cfg };
}

const SUBMIT = {
  goal: 'Gửi đơn nghỉ với lý do có sẵn',
  start: '/requests',
  profile: 'employee',
  inputs: { reason: { value: 'Việc riêng {{uid}}' } },
  assertions: [
    { network: { method: 'POST', url: '/api/requests', status: 201 } },
    { text: 'Đã gửi đơn' },
  ],
};

const Answer = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z.unknown(),
});

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<z.infer<typeof Answer>> {
  return Answer.parse(await client.callTool({ name, arguments: args }));
}

describe('flowctl MCP server', () => {
  it('registers exactly the MCP tools of the command registry', async () => {
    const { client } = await connect([]);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual([...MCP_TOOLS].sort());
  });

  it('refuses every tool with trust_missing when there is no trust store', async () => {
    const { client, cfg } = await connect([], 'none');
    for (const [name, args] of [
      ['flow_run', SUBMIT],
      ['flow_step', { runId: 'x' }],
      ['flow_wait', { runId: 'x' }],
      ['flow_save', { runId: 'x', name: 'a' }],
      ['flow_replay', {}],
    ] as const) {
      const r = await call(client, name, args);
      expect(r.isError, name).toBe(true);
      expect(JSON.stringify(r.content), name).toContain('trust_missing');
    }
    expect(existsSync(join(cfg.flowsPath, '.runs'))).toBe(false);
  });

  it('narrows the config on every call: an env the store records on another origin is refused', async () => {
    const { client, cfg } = await connect([], 'moved');
    const r = await call(client, 'flow_run', SUBMIT);
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('env_not_trusted');
    expect(existsSync(join(cfg.flowsPath, '.runs'))).toBe(false);
  });

  it('explores to a pass, saves after a model-free replay, and replays the saved flow', async () => {
    const { client, cfg } = await connect([
      { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
      { op: 'CLICK', target: 'Gửi' },
      { op: 'DONE' },
    ]);
    const run = await call(client, 'flow_run', SUBMIT);
    expect(run.structuredContent?.['status'], JSON.stringify(run)).toBe(
      'passed',
    );
    const runId = String(run.structuredContent?.['runId']);
    const save = await call(client, 'flow_save', { runId, name: 'mcp-leave' });
    expect(save.structuredContent?.['saved'], JSON.stringify(save)).toBe(true);
    expect(existsSync(join(cfg.flowsPath, 'mcp-leave.yaml'))).toBe(true);
    const replay = await call(client, 'flow_replay', { names: ['mcp-leave'] });
    expect(replay.structuredContent).toMatchObject({ passed: 1, failed: 0 });
    expect(replay.structuredContent?.['videos']).toBeUndefined();
    const demo = await call(client, 'flow_replay', {
      names: ['mcp-leave'],
      video: true,
    });
    expect(demo.structuredContent).toMatchObject({
      passed: 1,
      videos: [
        {
          flow: 'mcp-leave',
          status: 'passed',
          videos: [expect.stringMatching(/video-employee\.webm$/)],
        },
      ],
    });
  });

  it('escalates with page text marked as data, takes orchestrator steps, and finishes with the verdict', async () => {
    const { client } = await connect([{ op: 'BLOCKED' }, { op: 'BLOCKED' }]);
    const run = await call(client, 'flow_run', SUBMIT);
    expect(run.structuredContent).toMatchObject({
      status: 'escalated',
      note: PAGE_DATA_NOTE,
    });
    const runId = String(run.structuredContent?.['runId']);
    const bad = await call(client, 'flow_step', {
      runId,
      steps: [{ kind: 'goto', url: 'file:///etc/passwd' }],
    });
    expect(bad.structuredContent).toMatchObject({
      status: 'escalated',
      escalation: { reason: 'action_failed' },
    });
    const good = await call(client, 'flow_step', {
      runId,
      steps: [{ kind: 'goto', url: '/requests' }],
    });
    expect(good.structuredContent?.['status']).toBe('escalated');
    const done = await call(client, 'flow_step', { runId, finish: true });
    expect(done.structuredContent?.['status']).toBe('failed');
    expect(String(done.structuredContent?.['next'])).toContain('verdict');
  });

  it('answers an unknown run with an error the orchestrator can act on', async () => {
    const { client } = await connect([]);
    const r = await call(client, 'flow_wait', { runId: 'nope' });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('flow_run');
  });
});
