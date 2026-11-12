import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { startFixture } from '../src/index.js';

describe('fixture app', () => {
  it('guards the API, stores requests and resets', async () => {
    const f = await startFixture();
    try {
      expect((await fetch(`${f.url}/api/requests`)).status).toBe(401);
      const h = { cookie: 'role=employee', 'content-type': 'application/json' };
      const created = await fetch(`${f.url}/api/requests`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ reason: 'x', type: 'LEAVE' }),
      });
      expect(created.status).toBe(201);
      expect(
        (await (await fetch(`${f.url}/api/requests`, { headers: h })).json())
          .items,
      ).toHaveLength(1);
      expect(
        (
          await fetch(`${f.url}/api/requests/1/approve`, {
            method: 'PATCH',
            headers: h,
          })
        ).status,
      ).toBe(403);
      await fetch(`${f.url}/api/__reset`, { method: 'POST' });
      expect(
        (await (await fetch(`${f.url}/api/requests`, { headers: h })).json())
          .items,
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  });

  it('redirects pages to /login without a role and injects the bug mode', async () => {
    const f = await startFixture('wrongBody');
    try {
      const anon = await fetch(`${f.url}/requests`, { redirect: 'manual' });
      expect(anon.status).toBe(302);
      expect(anon.headers.get('location')).toBe('/login');
      const html = await (
        await fetch(`${f.url}/requests`, {
          headers: { cookie: 'role=employee' },
        })
      ).text();
      expect(html).toContain('window.BUG="wrongBody"');
    } finally {
      await f.close();
    }
  });

  it('serves the lab page to a signed-in user', async () => {
    const f = await startFixture();
    try {
      const r = await fetch(`${f.url}/lab`, {
        headers: { cookie: 'role=employee' },
      });
      expect(r.status).toBe(200);
      expect(await r.text()).toContain('Lưu nháp');
    } finally {
      await f.close();
    }
  });

  it('echoes a body whose character is split across chunks, and answers 400 to a body that is not JSON', async () => {
    const f = await startFixture();
    try {
      const u = new URL(`${f.url}/api/echo?q=x`);
      const send = (
        parts: Buffer[],
      ): Promise<{ status: number; body: string }> =>
        new Promise((resolve, reject) => {
          const req = request(
            u,
            { method: 'POST', headers: { cookie: 'role=employee' } },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (c: Buffer) => chunks.push(c));
              res.on('end', () =>
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString('utf8'),
                }),
              );
            },
          );
          req.on('error', reject);
          req.write(parts[0]);
          setTimeout(() => req.end(parts[1]), 20);
        });
      const bytes = Buffer.from(JSON.stringify({ matKhau: 'Đ€', ghiChu: 'a' }));
      const cut = bytes.indexOf(Buffer.from('€')) + 1;
      const echoed = await send([bytes.subarray(0, cut), bytes.subarray(cut)]);
      expect(echoed.status).toBe(422);
      expect(JSON.parse(echoed.body)).toEqual({
        daNhan: 'Đ€',
        ghiChu: 'a',
        q: 'x',
      });
      const bad = await send([Buffer.from('{"matKhau":'), Buffer.from('')]);
      expect(bad.status).toBe(400);
    } finally {
      await f.close();
    }
  });
});
