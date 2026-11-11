import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { PageSnapshot } from '../src/browser/index.js';
import { Deadline } from '../src/run/deadline.js';
import { JevDriver } from '../src/system1/jev.js';

const page: PageSnapshot = {
  url: 'http://app.test/requests',
  title: 't',
  text: 't',
  canScrollUp: false,
  canScrollDown: false,
  fingerprint: 'f',
  controls: [{ id: 1, role: 'button', name: 'Gửi', ops: ['CLICK'], value: '' }],
};

const expire = async (d: Deadline): Promise<void> => {
  let fired!: () => void;
  const done = new Promise<void>((resolve) => (fired = resolve));
  d.start(async () => fired());
  await done;
};

describe('Deadline (wall-clock budget, ADR 0024 section 6)', () => {
  it('uses the built-in ceiling when the config sets no budget', () => {
    expect(new Deadline(undefined).ms).toBe(600_000);
  });

  it('fires on its own timer, aborts its signal and turns any outcome into budget_exceeded', async () => {
    const d = new Deadline(20);
    expect(d.overrule({ status: 'passed' })).toEqual({ status: 'passed' });
    await expire(d);
    expect(d.signal.aborted).toBe(true);
    expect(() => d.assertWithin()).toThrow(/wall-clock budget of 20 ms/);
    for (const outcome of [
      { status: 'passed' as const },
      {
        status: 'error' as const,
        error: { kind: 'internal' as const, hint: 'page closed' },
      },
    ])
      expect(d.overrule(outcome).error?.kind).toBe('budget_exceeded');
  });

  it('keeps a scope or destructive-request refusal: a security stop outranks a timeout', async () => {
    const d = new Deadline(10);
    await expire(d);
    for (const kind of ['scope_violation', 'destructive_blocked'] as const)
      expect(
        d.overrule({ status: 'error', error: { kind, hint: 'h' } }).error?.kind,
      ).toBe(kind);
  });

  it('never fires after clear', async () => {
    const d = new Deadline(10);
    let fired = false;
    d.start(async () => {
      fired = true;
    });
    d.clear();
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(false);
    expect(d.signal.aborted).toBe(false);
  });
});

describe('JevDriver.decide with the run signal', () => {
  it('stops a request that hangs as soon as the signal aborts', async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      const started = Date.now();
      const err: unknown = await new JevDriver({
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: 'k',
      })
        .decide(
          {
            goal: 'g',
            page,
            history: [],
            ops: ['CLICK', 'DONE', 'BLOCKED'],
            inputs: [],
            secrets: [],
          },
          AbortSignal.timeout(100),
        )
        .catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'system1_unreachable' });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
  });
});
