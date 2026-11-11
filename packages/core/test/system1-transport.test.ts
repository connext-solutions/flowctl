import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageSnapshot } from '../src/browser/index.js';
import { MAX_ANSWER_BYTES, type DecideInput } from '../src/system1/index.js';
import { JevDriver } from '../src/system1/jev.js';
import { isLoopbackAddress } from '../src/system1/wire.js';

/** The transport rules of ADR 0022 contract 7 and ADR 0024 section 6 (T5.1). */
const page: PageSnapshot = {
  url: 'http://app.test/requests',
  title: 'Đơn từ',
  text: 'Đơn từ',
  canScrollUp: false,
  canScrollDown: false,
  fingerprint: 'f',
  controls: [{ id: 7, role: 'button', name: 'Gửi', ops: ['CLICK'], value: '' }],
};
const input = (): DecideInput => ({
  goal: 'Gửi đơn',
  page,
  history: [],
  ops: ['CLICK', 'DONE', 'BLOCKED'],
  inputs: [],
  secrets: [],
});
const ANSWER = JSON.stringify({
  answers: {
    operation: {
      choice: 'DONE',
      confidence: 0.8,
      probabilities: { CLICK: 0.1, DONE: 0.8, BLOCKED: 0.1 },
    },
  },
  model: 'm',
});

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((done) => s.close(done));
  }
});
async function serve(
  handler: Handler,
): Promise<{ url: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method ?? ''} ${req.url ?? ''}`);
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, hits };
}
const decide = (url: string) =>
  new JevDriver({ baseUrl: url, apiKey: 'k' })
    .decide(input())
    .catch((e: unknown) => e);
const message = (e: unknown): string => (e instanceof Error ? e.message : '');

describe('JevDriver transport', () => {
  it('does not follow a redirect, and sends nothing to its location', async () => {
    const other = await serve((_req, res) => res.end(ANSWER));
    const s1 = await serve((_req, res) => {
      res.writeHead(307, { location: `${other.url}/v1/systemone` });
      res.end();
    });
    const err = await decide(s1.url);
    expect(err).toMatchObject({ kind: 'system1_unreachable' });
    expect(message(err)).toContain('redirect');
    expect(message(err)).not.toContain(other.url);
    expect(other.hits).toEqual([]);
  });

  it('ignores HTTP_PROXY, HTTPS_PROXY and NO_PROXY', async () => {
    const proxy = await serve((_req, res) => res.end(ANSWER));
    const s1 = await serve((_req, res) => res.end(ANSWER));
    vi.stubEnv('HTTP_PROXY', proxy.url);
    vi.stubEnv('http_proxy', proxy.url);
    vi.stubEnv('HTTPS_PROXY', proxy.url);
    vi.stubEnv('NO_PROXY', '');
    const d = await decide(s1.url);
    expect(d).toMatchObject({ model: 'm' });
    expect(s1.hits).toEqual(['POST /v1/systemone']);
    expect(proxy.hits).toEqual([]);
  });

  it('reads a compressed answer, counting the cap after decompression', async () => {
    const small = await serve((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      });
      res.end(gzipSync(ANSWER));
    });
    expect(await decide(small.url)).toMatchObject({ model: 'm' });
    const bomb = gzipSync(Buffer.alloc(MAX_ANSWER_BYTES * 8, 32));
    expect(bomb.byteLength).toBeLessThan(MAX_ANSWER_BYTES);
    const big = await serve((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.end(bomb);
    });
    const err = await decide(big.url);
    expect(err).toMatchObject({ kind: 'system1_unreachable' });
    expect(message(err)).toContain('larger than');
  });

  it('refuses an answer in an encoding it does not read', async () => {
    const s1 = await serve((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'zstd' });
      res.end('x');
    });
    const err = await decide(s1.url);
    expect(err).toMatchObject({ kind: 'system1_unreachable' });
    expect(message(err)).toContain('unknown content encoding');
  });

  it('decides loopback on the connected address, not on a name', () => {
    for (const a of ['127.0.0.1', '127.255.0.9', '::1', '::ffff:127.0.0.1'])
      expect(isLoopbackAddress(a)).toBe(true);
    for (const a of [
      '0.0.0.0',
      '10.0.0.5',
      '::',
      'localhost',
      '::ffff:10.0.0.1',
      undefined,
    ])
      expect(isLoopbackAddress(a)).toBe(false);
  });
});

/** A self-signed certificate for 127.0.0.1, or `undefined` where `openssl` is not installed. */
function selfSigned(): { key: Buffer; cert: Buffer } | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'flowctl-tls-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=127.0.0.1',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
      ],
      { stdio: 'ignore' },
    );
    return {
      key: readFileSync(join(dir, 'k.pem')),
      cert: readFileSync(join(dir, 'c.pem')),
    };
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const tls = selfSigned();

describe.skipIf(tls === undefined)('JevDriver TLS', () => {
  it('refuses a certificate outside the bundled roots even with NODE_TLS_REJECT_UNAUTHORIZED=0', async () => {
    const hits: string[] = [];
    const server = createHttpsServer(tls ?? {}, (req, res) => {
      hits.push(req.url ?? '');
      res.end(ANSWER);
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    const err = await decide(`https://127.0.0.1:${port}`);
    expect(err).toMatchObject({ kind: 'system1_unreachable' });
    expect(message(err)).toContain('bundled with Node');
    expect(hits).toEqual([]);
  });
});
