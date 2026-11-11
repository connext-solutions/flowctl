import { describe, expect, it } from 'vitest';
import { freeChecks } from '../src/observe/index.js';
import { at, check, mapOf, pageAt, ref } from './free-checks-maps.js';

/** Free checks (T2.4) about pages and links: broken links, unreachable pages, and refusals that explain a status 0. */
describe('freeChecks on links and reachability', () => {
  it('reports a link whose target page answered 4xx, 5xx or nothing, from each page that links to it', () => {
    const r = freeChecks(
      mapOf([
        pageAt('/', { links: ['/', '/gone', '/hop', '/never', '/ok'] }),
        pageAt('/gone', { status: 404 }),
        pageAt('/hop', {
          status: 0,
          refused: ['scope_violation'],
          navigationRefused: true,
        }),
        pageAt('/ok', { links: ['/dead', '/gone'] }),
        pageAt('/dead', { status: 0 }),
      ]),
    );
    expect(check(r, 'no-broken-link').findings).toEqual([
      {
        check: 'no-broken-link',
        page: '/',
        target: '/gone',
        status: 404,
        sourceRef: ref('no-broken-link'),
        observation: at('/pages/0/links/1'),
      },
      {
        check: 'no-broken-link',
        page: '/ok',
        target: '/dead',
        status: 0,
        sourceRef: ref('no-broken-link'),
        observation: at('/pages/3/links/0'),
      },
      {
        check: 'no-broken-link',
        page: '/ok',
        target: '/gone',
        status: 404,
        sourceRef: ref('no-broken-link'),
        observation: at('/pages/3/links/1'),
      },
    ]);
  });

  it('reports a page that gave no answer, but not one whose navigation the guards refused', () => {
    const r = freeChecks(
      mapOf([
        pageAt('/'),
        pageAt('/dead', { status: 0 }),
        pageAt('/hop', {
          status: 0,
          refused: ['scope_violation'],
          navigationRefused: true,
        }),
        pageAt('/w', {
          status: 0,
          refused: ['destructive_blocked'],
          navigationRefused: true,
        }),
      ]),
    );
    expect(check(r, 'no-unreachable-page').findings).toEqual([
      {
        check: 'no-unreachable-page',
        page: '/dead',
        status: 0,
        sourceRef: ref('no-unreachable-page'),
        observation: at('/pages/1/status'),
      },
    ]);
    expect(check(r, 'no-4xx').findings).toEqual([]);
    expect(check(r, 'no-5xx').findings).toEqual([]);
  });

  it('reports a page that gave no answer while a late refusal of the previous page landed on it', () => {
    const r = freeChecks(
      mapOf([
        pageAt('/', { links: ['/dead'] }),
        pageAt('/dead', { status: 0, refused: ['destructive_blocked'] }),
      ]),
    );
    expect(check(r, 'no-unreachable-page').findings).toEqual([
      {
        check: 'no-unreachable-page',
        page: '/dead',
        status: 0,
        sourceRef: ref('no-unreachable-page'),
        observation: at('/pages/1/status'),
      },
    ]);
    expect(check(r, 'no-broken-link').findings).toEqual([
      {
        check: 'no-broken-link',
        page: '/',
        target: '/dead',
        status: 0,
        sourceRef: ref('no-broken-link'),
        observation: at('/pages/0/links/0'),
      },
    ]);
  });
});
