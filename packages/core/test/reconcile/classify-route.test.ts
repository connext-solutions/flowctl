import { describe, expect, it } from 'vitest';
import { classifyFailure, literalPath } from '../../src/reconcile/index.js';
import { appMap, operation, page } from '../derive/build.js';
import { classes, fakeIndex, urlFailed } from './classify-build.js';

describe('classifyFailure: route rules', () => {
  const got = 'http://127.0.0.1:4000/settings/team-list?tab=1';
  const map = appMap([page('/settings/team-list', 'Teams')]);

  it('expected path in neither code nor map, the page path in both: stale test, medium', () => {
    const c = classifyFailure({
      result: urlFailed('**/settings/teams*', got),
      code: fakeIndex({ routes: ['/settings/team-list@src/router.tsx:12'] }),
      map,
    });
    expect(c).toMatchObject({ class: 'stale_test', confidence: 'medium' });
    expect(c.basis[0]?.evidence).toEqual([
      {
        source: 'run',
        pointer: '/failed/assertion/url',
        text: '/settings/teams',
      },
      { source: 'run', pointer: '/failed/got', text: '/settings/team-list' },
      {
        source: 'code',
        record: 'route',
        file: 'src/router.tsx',
        line: 12,
        text: '/settings/team-list',
      },
      { source: 'map', pointer: '/pages/0/path', text: '/settings/team-list' },
    ]);
  });

  it('the spec quoting the page path raises the stale test to high', () => {
    const spec = operation({ id: 'op', items: ['Mở "/settings/team-list"'] });
    expect(
      classes({
        result: urlFailed('/settings/teams', got),
        code: fakeIndex({ routes: ['/settings/team-list'] }),
        map,
        spec,
      }),
    ).toEqual({
      class: 'stale_test',
      confidence: 'high',
      rules: ['route-stale'],
    });
  });

  it('the spec quoting the expected path the app lacks is spec drift', () => {
    const spec = operation({ id: 'op', steps: ['Mở "/settings/teams?x=1"'] });
    expect(
      classes({
        result: urlFailed('/settings/teams', got),
        code: fakeIndex({ routes: ['/settings/team-list'] }),
        spec,
      }),
    ).toEqual({
      class: 'spec_drift',
      confidence: 'medium',
      rules: ['route-spec-drift'],
    });
  });

  it('spec and code both have the expected path: product bug, medium', () => {
    const spec = operation({ id: 'op', steps: ['Mở "/settings/teams"'] });
    expect(
      classes({
        result: urlFailed('/settings/teams', got),
        code: fakeIndex({ routes: ['/settings/teams', '/settings/team-list'] }),
        spec,
      }),
    ).toEqual({
      class: 'product_bug',
      confidence: 'medium',
      rules: ['route-product-bug'],
    });
  });

  it('needs the code index and a literal path', () => {
    expect(
      classifyFailure({ result: urlFailed('/settings/teams', got), map }).notes,
    ).toContain('no code index: route rules not run');
    expect(
      classifyFailure({
        result: urlFailed('/settings/*/edit', got),
        code: fakeIndex({}),
      }).notes,
    ).toContain('url assertion is not a literal path, or got is not a URL');
  });
});

describe('literalPath', () => {
  it.each([
    ['**/settings/teams*', '/settings/teams'],
    ['/items/new', '/items/new'],
    ['http://127.0.0.1:4000/items*', '/items'],
    ['{{env.base}}/x', null],
    ['/a/*/b', null],
    ['items', null],
  ])('%s → %s', (glob, path) => {
    expect(literalPath(glob)).toBe(path);
  });
});
