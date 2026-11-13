import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRAFT_PROVENANCE, RunSession } from '../src/run/index.js';
import { writeFlow } from './helpers.js';
import { crud, LedgerApp } from './ledger-fixture.js';

/**
 * A stated gap of the replay guard (ADR 0024 amendment 2026-11-13, "as implemented"): a message the page sends over
 * a WebSocket in scope is not judged, on a `shared` env too, so realtime apps keep working. This test documents the
 * gap; if the guard ever starts closing sockets in a replay, it fails and the ADR and README must change with it.
 */
let fixture: Fixture;
let browser: Browser;
let ws: Server;
const received: string[] = [];
const sockets: Duplex[] = [];

/** The text of one masked client frame shorter than 126 bytes, as a browser sends it. */
function textOf(frame: Buffer): string {
  const len = (frame[1] ?? 0) & 0x7f;
  const mask = frame.subarray(2, 6);
  const data = frame.subarray(6, 6 + len);
  return Buffer.from(data.map((b, i) => b ^ (mask[i % 4] ?? 0))).toString();
}

beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
  ws = createServer();
  ws.on('upgrade', (req, socket: Duplex) => {
    sockets.push(socket);
    const key = String(req.headers['sec-websocket-key']);
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on('data', (frame: Buffer) => {
      if (((frame[0] ?? 0) & 0x0f) === 1) received.push(textOf(frame));
    });
  });
  await new Promise<void>((r) => ws.listen(0, 'localhost', r));
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
  for (const s of sockets) s.destroy();
  await new Promise((r) => ws.close(r));
});

describe('WebSocket messages in a shared replay', () => {
  it('lets a page-to-server message reach the server unjudged (a stated gap)', async () => {
    const app = new LedgerApp(fixture.url);
    const { cfg, store } = await app.setup();
    const address = ws.address();
    const port =
      typeof address === 'object' && address !== null ? address.port : 0;
    const origin = new URL(fixture.url).origin;
    cfg.trustView = {
      refused: {},
      scopes: {
        local: { visit: [origin], call: [origin, `http://localhost:${port}`] },
      },
    };
    const flow = writeFlow(cfg, {
      ...crud('items-socket', [{ wait: 10 }]),
      assertions: [{ text: 'Mục' }],
    });
    const run = RunSession.open(cfg, flow, {
      browser,
      store,
      provenance: DRAFT_PROVENANCE,
    });
    await run.begin();
    await run.page.evaluate(
      `new Promise((ok) => { const s = new WebSocket('ws://localhost:${port}/socket'); s.onopen = () => { s.send('DELETE item 12'); ok(); }; })`,
    );
    await expect.poll(() => received).toEqual(['DELETE item 12']);
    const r = await run.finish({ status: 'passed' }, 0);
    expect(r.status, JSON.stringify(r.error)).toBe('passed');
  });
});
