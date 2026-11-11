import { afterEach, describe, expect, it } from 'vitest';
import {
  CRAWL_BUG_MODES,
  DECOYS,
  startFixture,
  type Fixture,
} from '../src/index.js';

let f: Fixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

const get = (path: string) =>
  fetch(`${f?.url ?? ''}${path}`, {
    headers: { cookie: 'role=employee' },
    redirect: 'manual',
  });

describe('crawl pages (T2.6)', () => {
  it('serves /map with every decoy and clean pages on a clean app', async () => {
    f = await startFixture();
    const map = await (await get('/map')).text();
    for (const d of Object.values(DECOYS).filter((d) => !d.includes(' ')))
      expect(map).toContain(d);
    expect((await get('/map/report')).status).toBe(200);
    expect(await (await get('/map/report')).text()).not.toContain(
      'console.error',
    );
    expect(map).toContain('href="/map/help"');
    expect((await get('/map/help')).status).toBe(200);
  });

  it('switches on each crawl-class bug alone', async () => {
    expect([...CRAWL_BUG_MODES]).toEqual([
      'brokenLink',
      'page500',
      'pageConsoleError',
    ]);
    f = await startFixture('brokenLink');
    const map = await (await get('/map')).text();
    expect(map).toContain('href="/map/missing"');
    expect((await get('/map/missing')).status).toBe(404);
    await f.close();
    f = await startFixture('page500');
    expect((await get('/map/report')).status).toBe(500);
    await f.close();
    f = await startFixture('pageConsoleError');
    expect(await (await get('/map/report')).text()).toContain(
      "console.error('seeded bug",
    );
  });

  it('makes the redirect hop leave the origin and the side-effecting GET wipe data', async () => {
    f = await startFixture();
    const hop = await get(DECOYS.redirectHop);
    expect(hop.status).toBe(302);
    expect(hop.headers.get('location')).toBe('https://evil.example/landing');
    await fetch(`${f.url}/api/requests`, {
      method: 'POST',
      headers: { cookie: 'role=employee', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'x' }),
    });
    expect((await get(DECOYS.sideEffectGet)).status).toBe(200);
    const list = await (await get('/api/requests')).json();
    expect(list.items).toEqual([]);
  });
});
