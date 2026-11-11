import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildCodeIndex,
  type CodeIndex,
  fileRoute,
} from '../../src/reconcile/index.js';
import { ContainmentError, openRoot } from '../../src/trust/index.js';
import { put, tmp } from './repo.js';

const ROUTER = [
  "import { createBrowserRouter } from 'react-router-dom';",
  'export const router = createBrowserRouter([',
  "  { path: '/shop/orders', children: [{ path: ':id' }] },",
  "  { path: '/shop/orders/new' },",
  ']);',
].join('\n');

const FORM = [
  "import { z } from 'zod';",
  "export const S = z.string().min(1, 'Vui lòng nhập địa chỉ');",
].join('\n');

/** A small app: a router, a form schema, two locales and a Next.js page. */
function sampleRepo(): string {
  const dir = tmp();
  put(dir, 'src/router.tsx', ROUTER);
  put(dir, 'src/form.ts', FORM);
  put(dir, 'src/i18n/vi.json', '{\n  "order.submit": "Gửi  đơn"\n}\n');
  put(dir, 'src/i18n/en.json', '{ "order": { "submit": "Submit" } }');
  put(dir, 'app/orders/[id]/page.tsx', 'export default () => null;');
  put(dir, 'README.md', '# not indexed');
  return dir;
}

const repo = (dir: string): CodeIndex => buildCodeIndex(openRoot(dir, 'repos'));

describe('buildCodeIndex', () => {
  it('indexes routes, labels and messages with file and line', () => {
    const idx = repo(sampleRepo());
    expect(idx.routes.map((r) => [r.path, r.file, r.line])).toEqual([
      ['/orders/:id', 'app/orders/[id]/page.tsx', 1],
      ['/shop/orders', 'src/router.tsx', 3],
      ['/shop/orders/:id', 'src/router.tsx', 3],
      ['/shop/orders/new', 'src/router.tsx', 4],
    ]);
    expect(idx.labels.map((l) => [l.key, l.text, l.locale, l.line])).toEqual([
      ['order.submit', 'Submit', 'en', 1],
      ['order.submit', 'Gửi đơn', 'vi', 2],
    ]);
    expect(idx.messages).toEqual([
      {
        file: 'src/form.ts',
        line: 2,
        text: 'Vui lòng nhập địa chỉ',
        via: 'min()',
      },
    ]);
    expect(idx.files).toBe(5);
  });

  it('is deterministic whatever order the files were written in', () => {
    const a = sampleRepo();
    const b = tmp();
    put(b, 'app/orders/[id]/page.tsx', 'export default () => null;');
    put(b, 'src/i18n/en.json', '{ "order": { "submit": "Submit" } }');
    put(b, 'README.md', '# not indexed');
    put(b, 'src/i18n/vi.json', '{\n  "order.submit": "Gửi  đơn"\n}\n');
    put(b, 'src/form.ts', FORM);
    put(b, 'src/router.tsx', ROUTER);
    const strip = (i: CodeIndex): unknown =>
      JSON.stringify([i.routes, i.labels, i.messages, i.skipped]);
    expect(strip(repo(b))).toBe(strip(repo(a)));
  });

  it('refuses a root registered for another purpose', () => {
    expect(() => buildCodeIndex(openRoot(sampleRepo(), 'specs'))).toThrow(
      ContainmentError,
    );
  });

  it('walks only the directories it is given', () => {
    const idx = buildCodeIndex(openRoot(sampleRepo(), 'repos'), {
      dirs: ['src/i18n', 'src/i18n'],
    });
    expect(idx.routes).toEqual([]);
    expect(idx.labels).toHaveLength(2);
  });

  it('leaves out generated and vendored folders', () => {
    const dir = sampleRepo();
    put(dir, 'node_modules/x/locales/vi.json', '{"a": "Gửi đơn"}');
    put(dir, 'dist/i18n/vi.json', '{"a": "Gửi đơn"}');
    expect(repo(dir).findLabel('Gửi đơn').matches).toHaveLength(1);
  });
});

describe('file routes as the build runs them', () => {
  it('gives each file one route, from the convention fileRoute names', () => {
    const dir = tmp();
    const files = [
      'app/routes/users.$id.tsx',
      'app/routes/users.$id/route.tsx',
      'app/orders/page.tsx',
      'src/app/(shop)/cart/page.mdx',
      'pages/users/[id].tsx',
      'src/pages/index.jsx',
      'app/routes/x/page.tsx',
    ];
    for (const f of files) put(dir, f, 'export default () => null;');
    const idx = repo(dir);
    expect(idx.routes.map((r) => [r.file, r.path, r.source])).toEqual(
      files
        .flatMap((f) => {
          const r = fileRoute(f);
          return r === undefined ? [] : [[f, r.path, r.source]];
        })
        .sort((a, b) =>
          Buffer.compare(Buffer.from(a[0] ?? ''), Buffer.from(b[0] ?? '')),
        ),
    );
    expect(idx.routes.map((r) => r.source)).toEqual([
      'next-app',
      'remix',
      'remix',
      'next-pages',
      'next-app',
      'next-pages',
    ]);
  });
});

describe('frozen results', () => {
  it('freezes the index, every record and every lookup answer', () => {
    const idx = repo(sampleRepo());
    for (const list of [idx.routes, idx.labels, idx.messages, idx.skipped]) {
      expect(Object.isFrozen(list)).toBe(true);
      for (const r of list) expect(Object.isFrozen(r)).toBe(true);
    }
    const found = idx.findLabel('Gửi đơn');
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found.matches)).toBe(true);
    expect(Object.isFrozen(found.matches[0])).toBe(true);
    expect(Object.isFrozen(idx.findRoute('/orders/1').matches)).toBe(true);
  });
});

describe('lookups', () => {
  it('finds a label by its text after normalisation, exactly', () => {
    const idx = repo(sampleRepo());
    expect(idx.findLabel(' Gửi\nđơn ').matches.map((l) => l.locale)).toEqual([
      'vi',
    ]);
    expect(idx.findLabel('Gửi').matches).toEqual([]);
    expect(idx.findLabel('Gửi\u200b đơn')).toMatchObject({
      matches: [],
      refused: 'hidden or unassigned character',
    });
  });

  it('finds a message by its text', () => {
    const idx = repo(sampleRepo());
    expect(idx.findMessage('Vui lòng nhập địa chỉ').matches).toHaveLength(1);
    expect(idx.findMessage('Vui lòng nhập').matches).toEqual([]);
  });

  it('finds routes for a concrete path, most specific first', () => {
    const idx = repo(sampleRepo());
    expect(
      idx.findRoute('/shop/orders/new').matches.map((r) => r.path),
    ).toEqual(['/shop/orders/new', '/shop/orders/:id']);
    expect(
      idx.findRoute('https://app.test/orders/7?tab=1#x').matches[0]?.path,
    ).toBe('/orders/:id');
    expect(idx.findRoute('/shop/orders/%2e%2e/new').matches).toEqual([]);
    expect(idx.findRoute('/shop//orders/').matches[0]?.path).toBe(
      '/shop/orders',
    );
    expect(idx.findRoute('/nope').matches).toEqual([]);
    expect(idx.findRoute('/a%00b').refused).toBe('path refused');
  });

  it('caps the matches of one query and says so', () => {
    const dir = tmp();
    const rows = Array.from({ length: 30 }, (_, i) => `"k${i}": "Lưu"`);
    put(dir, 'locales/vi.json', `{${rows.join(',')}}`);
    const idx = buildCodeIndex(openRoot(dir, 'repos'), {
      limits: { maxMatches: 5 },
    });
    const found = idx.findLabel('Lưu');
    expect(found.matches).toHaveLength(5);
    expect(found.truncated).toBe(true);
  });
});

describe('fixture-app as a real sample', () => {
  it('indexes its i18n messages with their lines', () => {
    const dir = fileURLToPath(new URL('../../../fixture-app', import.meta.url));
    const idx = buildCodeIndex(openRoot(dir, 'repos'));
    const hit = idx.findLabel('Đã gửi đơn').matches;
    expect(hit).toEqual([
      {
        file: 'contracts/i18n/vi.json',
        line: 11,
        key: 'request.submitted',
        text: 'Đã gửi đơn',
        locale: 'vi',
      },
    ]);
    expect(idx.labels).toHaveLength(10);
    expect(
      idx.skipped.filter((s) => !['file size', 'pruned'].includes(s.rule)),
    ).toEqual([]);
  });
});
