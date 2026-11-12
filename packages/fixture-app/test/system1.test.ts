import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FAKE_TARGET_WAITS,
  startFakeSystem1,
  type FakeSystem1,
} from '../src/index.js';

let s1: FakeSystem1 | undefined;
afterEach(async () => {
  await s1?.close();
  s1 = undefined;
});

const body = (ops: string[], clicks: Record<string, string>) => ({
  questions: {
    operation: {
      type: 'choice',
      criteria: Object.fromEntries(ops.map((o) => [o, o])),
    },
    click_target: {
      type: 'choice',
      criteria: Object.fromEntries(
        Object.entries(clicks).map(([k, l]) => [k, { element: `[${k}] ${l}` }]),
      ),
    },
  },
});

const post = (url: string, b: unknown, auth = 'Bearer k') =>
  fetch(`${url}/v1/systemone`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' },
    body: JSON.stringify(b),
  });

describe('fake System 1', () => {
  it('answers the scripted moves in order and repeats the last one', async () => {
    s1 = await startFakeSystem1([
      { op: 'CLICK', target: 'Gửi' },
      { op: 'DONE', second: { op: 'CLICK', target: 'Huỷ' } },
    ]);
    const b = body(['CLICK', 'DONE', 'BLOCKED'], { '3': 'Huỷ', '7': 'Gửi' });
    const r1 = await (await post(s1.url, b)).json();
    expect(r1.answers.operation.choice).toBe('CLICK');
    expect(r1.answers.click_target.choice).toBe('7');
    const sum = Object.values<number>(
      r1.answers.operation.probabilities,
    ).reduce((a, x) => a + x, 0);
    expect(sum).toBeCloseTo(1, 5);
    const r2 = await (await post(s1.url, b)).json();
    expect(r2.answers.operation.choice).toBe('DONE');
    expect(r2.answers.click_target.choice).toBe('3');
    expect(r2.answers.operation.probabilities.CLICK).toBeGreaterThan(
      r2.answers.operation.probabilities.BLOCKED,
    );
    const r3 = await (await post(s1.url, b)).json();
    expect(r3.answers.operation.choice).toBe('DONE');
    expect(r3.model).toBe('fake-system1');
    expect(s1.requests).toHaveLength(3);
  });

  it('fails loudly when the script does not fit the request', async () => {
    s1 = await startFakeSystem1([{ op: 'CLICK', target: 'Không có' }]);
    const r = await post(s1.url, body(['CLICK'], { '1': 'Gửi' }));
    expect(r.status).toBe(500);
    expect(await r.text()).toContain('Không có');
  });

  it('answers WAIT while a waitForTarget label is not on the page, then the move (#33)', async () => {
    s1 = await startFakeSystem1([
      { op: 'CLICK', target: 'Duyệt', waitForTarget: true },
      { op: 'DONE' },
    ]);
    const before = body(['CLICK', 'WAIT', 'DONE'], { '1': 'Trang chủ' });
    const after = body(['CLICK', 'WAIT', 'DONE'], {
      '1': 'Trang chủ',
      '4': 'Duyệt',
    });
    for (let i = 0; i < 2; i++) {
      const r = await (await post(s1.url, before)).json();
      expect(r.answers.operation.choice).toBe('WAIT');
    }
    const hit = await (await post(s1.url, after)).json();
    expect(hit.answers.operation.choice).toBe('CLICK');
    expect(hit.answers.click_target.choice).toBe('4');
    const next = await (await post(s1.url, after)).json();
    expect(next.answers.operation.choice).toBe('DONE');
  });

  it('stops waiting for a target after a bounded number of WAITs', async () => {
    s1 = await startFakeSystem1([
      { op: 'CLICK', target: 'Duyệt', waitForTarget: true },
    ]);
    const b = body(['CLICK', 'WAIT'], { '1': 'Trang chủ' });
    let last = 0;
    for (let i = 0; i <= FAKE_TARGET_WAITS; i++)
      last = (await post(s1.url, b)).status;
    expect(last).toBe(500);
  });

  it('can answer with a fixed status and requires a key', async () => {
    s1 = await startFakeSystem1([{ op: 'DONE' }], { status: 503 });
    expect((await post(s1.url, body(['DONE'], {}))).status).toBe(503);
    expect((await post(s1.url, body(['DONE'], {}), '')).status).toBe(401);
  });

  it('keeps each request raw (URL, headers, body text), a character split across chunks included', async () => {
    s1 = await startFakeSystem1([{ op: 'DONE' }]);
    const text = JSON.stringify(body(['DONE'], { 1: 'Đ€ Gửi' }));
    const bytes = Buffer.from(text);
    const cut = bytes.indexOf(Buffer.from('€')) + 1;
    const u = new URL(`${s1.url}/v1/systemone`);
    await new Promise<void>((resolve, reject) => {
      const req = request(
        u,
        {
          method: 'POST',
          headers: { authorization: 'Bearer k' },
        },
        (res) => {
          res.resume();
          res.on('end', resolve);
        },
      );
      req.on('error', reject);
      req.write(bytes.subarray(0, cut));
      setTimeout(() => req.end(bytes.subarray(cut)), 20);
    });
    expect(s1.raw).toHaveLength(1);
    const raw: unknown = JSON.parse(s1.raw[0] ?? '');
    expect(raw).toMatchObject({
      url: '/v1/systemone',
      headers: { authorization: 'Bearer k' },
      body: text,
    });
    expect(s1.requests).toEqual([JSON.parse(text)]);
  });
});
