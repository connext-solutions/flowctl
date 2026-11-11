import { describe, expect, it } from 'vitest';
import { AppMapSchema, type AppMap } from '../src/observe/index.js';

const map = (): AppMap => ({
  v: 1,
  origin: 'http://127.0.0.1:5173',
  observedAt: '2026-11-06T10:00:00.000Z',
  truncated: false,
  pages: [
    {
      path: '/requests',
      title: 'Đơn từ',
      status: 200,
      controls: [
        { role: 'textbox', name: 'Lý do' },
        { role: 'button', name: 'Gửi' },
      ],
      links: ['/approvals'],
      forms: [
        {
          name: null,
          submit: 'Gửi',
          fields: [
            {
              role: 'textbox',
              name: 'Lý do',
              type: 'text',
              required: true,
            },
          ],
        },
      ],
      calls: [{ method: 'GET', path: '/api/requests', status: 200 }],
      consoleErrors: [],
      refused: [],
      navigationRefused: false,
    },
  ],
});

describe('AppMap schema (T2.1)', () => {
  it('accepts a map and refuses unknown keys anywhere', () => {
    expect(AppMapSchema.parse(map())).toEqual(map());
    const page = map().pages[0];
    if (page === undefined) throw new Error('no page');
    expect(() =>
      AppMapSchema.parse({ ...map(), pages: [{ ...page, html: '<p>' }] }),
    ).toThrow();
  });

  it('keeps paths only: no origin, query string or fragment in pages, links or calls', () => {
    for (const bad of [
      'http://127.0.0.1:5173/requests',
      '/requests?token=abc',
      '/requests#x',
      'requests',
    ]) {
      const page = map().pages[0];
      if (page === undefined) throw new Error('no page');
      expect(() =>
        AppMapSchema.parse({ ...map(), pages: [{ ...page, path: bad }] }),
      ).toThrow();
      expect(() =>
        AppMapSchema.parse({
          ...map(),
          pages: [
            { ...page, calls: [{ method: 'GET', path: bad, status: 200 }] },
          ],
        }),
      ).toThrow();
    }
  });

  it('lets a call name another origin, but only as an origin', () => {
    const page = map().pages[0];
    if (page === undefined) throw new Error('no page');
    const withCall = (origin: string) => ({
      ...map(),
      pages: [
        {
          ...page,
          calls: [{ method: 'GET', path: '/track', status: 0, origin }],
        },
      ],
    });
    expect(
      AppMapSchema.parse(withCall('https://cdn.example.com')).pages[0]?.calls[0]
        ?.origin,
    ).toBe('https://cdn.example.com');
    for (const bad of ['https://cdn.example.com/track', 'cdn.example.com'])
      expect(() => AppMapSchema.parse(withCall(bad)), bad).toThrow();
  });

  it('allows a page that never answered (status 0) and an origin only, no path', () => {
    const page = map().pages[0];
    if (page === undefined) throw new Error('no page');
    expect(
      AppMapSchema.parse({ ...map(), pages: [{ ...page, status: 0 }] }).pages[0]
        ?.status,
    ).toBe(0);
    expect(() =>
      AppMapSchema.parse({ ...map(), origin: 'http://127.0.0.1:5173/app' }),
    ).toThrow();
  });
});
