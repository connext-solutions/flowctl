import { describe, expect, it } from 'vitest';
import { buildCodeIndex, classifyFailure } from '../../src/reconcile/index.js';
import { openRoot } from '../../src/trust/index.js';
import { appMap, operation, page } from '../derive/build.js';
import { run } from './classify-build.js';
import { put, tmp } from './repo.js';

const ROUTER = [
  "import { createBrowserRouter } from 'react-router-dom';",
  'export const router = createBrowserRouter([',
  "  { path: '/shop', children: [{ path: 'order-list' }] },",
  "  { path: '*' },",
  ']);',
].join('\n');

const FORM = [
  "import { z } from 'zod';",
  "export const S = z.string().min(1, 'Vui lòng nhập địa chỉ');",
].join('\n');

/** A small app whose submit label and order list route changed. */
function repo(): string {
  const dir = tmp();
  put(dir, 'src/router.tsx', ROUTER);
  put(dir, 'src/form.ts', FORM);
  put(
    dir,
    'src/i18n/vi.json',
    '{\n  "order": {\n    "submit": "Gửi Đơn Hàng"\n  }\n}\n',
  );
  return dir;
}

describe('classifyFailure with a real code index', () => {
  const code = buildCodeIndex(openRoot(repo(), 'repos'));
  const map = appMap([
    page('/shop/order-list', 'Đơn hàng', ['button:Gửi Đơn Hàng']),
  ]);

  it('cites the locale file and line of the near label: stale test', () => {
    const c = classifyFailure({
      result: run({
        failed: {
          step: 1,
          kind: 'not_found',
          message: 'button "Gửi đơn hàng" not found',
        },
      }),
      code,
      map,
      spec: operation({ id: 'op', steps: ['Bấm "Gửi Đơn Hàng"'] }),
    });
    expect(c).toMatchObject({ class: 'stale_test', confidence: 'high' });
    expect(c.basis[0]?.evidence).toContainEqual({
      source: 'code',
      record: 'label',
      file: 'src/i18n/vi.json',
      line: 3,
      text: 'Gửi Đơn Hàng',
    });
  });

  it('cites the router file and line of the route the page was on: stale test', () => {
    const c = classifyFailure({
      result: run({
        failed: {
          assertion: { url: '**/shop/orders*' },
          got: 'http://127.0.0.1:4000/shop/order-list',
        },
      }),
      code,
      map,
    });
    expect(c).toMatchObject({ class: 'stale_test', confidence: 'medium' });
    expect(c.notes).toContain('catch-all route ignored');
    expect(c.basis[0]?.evidence).toContainEqual({
      source: 'code',
      record: 'route',
      file: 'src/router.tsx',
      line: 3,
      text: '/shop/order-list',
    });
  });

  it('a catch-all route is not a route for the expected path: no product bug from it', () => {
    const c = classifyFailure({
      result: run({
        failed: {
          assertion: { url: '/shop/orders' },
          got: 'http://127.0.0.1:4000/shop/order-list',
        },
      }),
      code,
      map,
      spec: operation({ id: 'op', steps: ['Mở "/shop/orders"'] }),
    });
    expect(c).toMatchObject({ class: 'spec_drift', confidence: 'high' });
    expect(c.hits.map((h) => h.rule)).toEqual(['route-spec-drift']);
    expect(c.notes).toContain('catch-all route ignored');
  });

  it('a validator message the spec and the code state, not shown: product bug', () => {
    const c = classifyFailure({
      result: run({
        failed: { assertion: { text: 'Vui lòng nhập địa chỉ' }, got: 'x' },
      }),
      code,
      spec: operation({ id: 'op', items: ['Hiện "Vui lòng nhập địa chỉ"'] }),
    });
    expect(c).toMatchObject({ class: 'product_bug', confidence: 'medium' });
    expect(c.basis[0]?.evidence).toContainEqual(
      expect.objectContaining({
        source: 'code',
        record: 'message',
        file: 'src/form.ts',
        line: 2,
      }),
    );
  });
});
