import { describe, expect, it } from 'vitest';
import {
  fileRoute,
  MAX_ROUTE_SEGMENTS,
  matchRoute,
  parseRoutePattern,
  ROUTE_EXTRACTORS,
  routesInSource,
} from '../../src/reconcile/index.js';

const paths = (rel: string, text: string): [string, number][] =>
  routesInSource(rel, text).routes.map((r) => [r.path, r.line]);

describe('React Router JSX', () => {
  it('joins nested <Route> paths and keeps absolute ones', () => {
    const src = [
      'export const App = () => (',
      '  <Routes>',
      '    <Route path="/" element={<Layout />}>',
      '      <Route index element={<Home />} />',
      "      <Route path='users' element={<Users />}>",
      '        <Route path=":id" element={<User />} />',
      '      </Route>',
      '      <Route path={"/about"} element={<p>Don\'t</p>} />',
      '    </Route>',
      '    <PrivateRoute path="/admin/*" />',
      '  </Routes>',
      ');',
    ].join('\n');
    expect(paths('src/App.tsx', src)).toEqual([
      ['/', 3],
      ['/users', 5],
      ['/users/:id', 6],
      ['/about', 8],
      ['/admin/*', 10],
    ]);
  });

  it('stops at the nesting cap and at an over-long path, and says where', () => {
    const deep = '<Route path="a">'.repeat(MAX_ROUTE_SEGMENTS + 5);
    const found = routesInSource('a.tsx', deep);
    expect(found.routes).toHaveLength(MAX_ROUTE_SEGMENTS);
    expect(found.skipped).toEqual([
      { line: 1, rule: 'route too deep', source: 'react-router-jsx' },
    ]);
    const long = [
      `<Route path="${'x/'.repeat(MAX_ROUTE_SEGMENTS + 1)}">`,
      '  <Route path="child" />',
      '  <Route path="/alone" />',
      '</Route>',
    ].join('\n');
    const kept = routesInSource('a.tsx', long);
    expect(kept.routes.map((r) => r.path)).toEqual(['/alone']);
    expect(kept.skipped).toEqual([
      { line: 1, rule: 'route too long', source: 'react-router-jsx' },
    ]);
  });

  it('ignores a computed path', () => {
    expect(paths('a.jsx', '<Route path={ROUTES.home} />')).toEqual([]);
  });
});

describe('route objects (createBrowserRouter, Vue Router, Angular)', () => {
  it('joins children of createBrowserRouter objects', () => {
    const src = [
      "import { createBrowserRouter } from 'react-router-dom';",
      'export const router = createBrowserRouter([',
      '  {',
      '    children: [',
      "      { path: 'orders/:id', element: <Order /> },",
      '    ],',
      "    path: '/shop',",
      '  },',
      "  { path: '*', element: <NotFound /> },",
      ']);',
    ].join('\n');
    expect(paths('src/router.tsx', src)).toEqual([
      ['/shop', 7],
      ['/shop/orders/:id', 5],
      ['/*', 9],
    ]);
  });

  it('reads Vue Router and Angular route arrays', () => {
    const vue = [
      "import { createRouter } from 'vue-router';",
      "const routes = [{ path: '/settings', children: [{ path: 'profile' }] },",
      "  { path: '/:pathMatch(.*)*' }];",
    ].join('\n');
    expect(paths('src/router/index.ts', vue)).toEqual([
      ['/settings', 2],
      ['/settings/profile', 2],
      ['/:pathMatch(.*)*', 3],
    ]);
    const ng = [
      'const routes: Routes = [',
      "  { path: '', component: HomeComponent },",
      "  { path: 'orders', children: [{ path: ':id', component: X }] },",
      "  { path: '**', component: NotFound },",
      '];',
      '@NgModule({ imports: [RouterModule.forRoot(routes)] })',
    ].join('\n');
    expect(paths('src/app/app-routing.module.ts', ng)).toEqual([
      ['/', 2],
      ['/orders', 3],
      ['/orders/:id', 3],
      ['/**', 4],
    ]);
  });

  it('reads no route objects from a file without a router marker', () => {
    expect(paths('src/files.ts', "const f = { path: '/etc/passwd' };")).toEqual(
      [],
    );
  });
});

describe('file routes', () => {
  it('maps Next.js app and pages routes', () => {
    expect(fileRoute('app/page.tsx')?.path).toBe('/');
    expect(fileRoute('src/app/(shop)/orders/[id]/page.tsx')?.path).toBe(
      '/orders/:id',
    );
    expect(fileRoute('app/docs/[...slug]/page.mdx')?.path).toBe('/docs/*');
    expect(fileRoute('app/_lib/page.tsx')).toBeUndefined();
    expect(fileRoute('app/orders/Row.tsx')).toBeUndefined();
    expect(fileRoute('pages/index.tsx')?.path).toBe('/');
    expect(fileRoute('src/pages/users/[id].jsx')?.source).toBe('next-pages');
    expect(fileRoute('src/pages/users/[id].jsx')?.path).toBe('/users/:id');
    expect(fileRoute('pages/_app.tsx')).toBeUndefined();
  });

  it('maps Remix flat routes', () => {
    expect(fileRoute('app/routes/_index.tsx')?.path).toBe('/');
    expect(fileRoute('app/routes/users.$id.tsx')?.path).toBe('/users/:id');
    expect(fileRoute('app/routes/_auth.login.tsx')?.path).toBe('/login');
    expect(fileRoute('app/routes/files.$.tsx')?.path).toBe('/files/*');
    expect(fileRoute('app/routes/users_.edit/route.tsx')?.path).toBe(
      '/users/edit',
    );
    expect(fileRoute('app/routes/users.$id/Row.tsx')).toBeUndefined();
    expect(fileRoute('app/routes/users.$id.tsx')?.source).toBe('remix');
  });
});

describe('matchRoute', () => {
  const m = (pattern: string, path: string): boolean =>
    matchRoute(parseRoutePattern(pattern), path.split('/').filter(Boolean));

  it('matches params, optional segments and catch-alls exactly', () => {
    expect(m('/users/:id', '/users/42')).toBe(true);
    expect(m('/users/:id', '/users')).toBe(false);
    expect(m('/users/:id', '/users/42/x')).toBe(false);
    expect(m('/users/:id?', '/users')).toBe(true);
    expect(m('/files/*', '/files')).toBe(true);
    expect(m('/files/*', '/files/a/b')).toBe(true);
    expect(m('/:pathMatch(.*)*', '/a/b')).toBe(true);
    expect(m('/Users', '/users')).toBe(false);
  });
});

describe('ROUTE_EXTRACTORS', () => {
  it('lists every extractor by name, in a fixed order', () => {
    expect(ROUTE_EXTRACTORS.map((e) => e.name)).toEqual([
      'react-router-jsx',
      'route-objects',
      'next-app',
      'next-pages',
      'remix',
    ]);
  });
});
