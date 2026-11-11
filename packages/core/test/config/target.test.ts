import { describe, expect, it } from 'vitest';
import {
  BUDGET_CEILINGS,
  type EnvCeiling,
  narrowTarget,
  TargetSchema,
} from '../../src/config/index.js';
import { destructiveWord } from '../../src/browser/index.js';
import { ActionGuard } from '../../src/explore/guard.js';

const ENVS = new Map<string, EnvCeiling>([
  [
    'staging',
    {
      origin: 'https://stg.example.com',
      visitOrigins: ['https://sso.example.com'],
      callOrigins: ['https://api.example.com'],
    },
  ],
  [
    'local',
    { origin: 'http://127.0.0.1:4200', visitOrigins: [], callOrigins: [] },
  ],
]);

const narrow = (raw: Record<string, unknown>) => {
  const warnings: string[] = [];
  const out = narrowTarget(TargetSchema.parse(raw), ENVS, ['admin'], warnings);
  return { ...out, warnings };
};

describe('target: section, per-key matrix (ADR 0024 section 1)', () => {
  it('with nothing set, each env gets its whole ceiling and the budget ceilings', () => {
    const { scopes, target, warnings } = narrow({});
    expect(scopes['staging']).toEqual({
      visit: ['https://stg.example.com', 'https://sso.example.com'],
      call: ['https://stg.example.com', 'https://api.example.com'],
    });
    expect(scopes['local']).toEqual({
      visit: ['http://127.0.0.1:4200'],
      call: ['http://127.0.0.1:4200'],
    });
    expect(target.budgets).toEqual(BUDGET_CEILINGS);
    expect(warnings).toEqual([]);
  });

  it('target.scope.visit and call: a wider origin is dropped with a warning, a listed one narrows', () => {
    const { scopes, warnings } = narrow({
      scope: {
        visit: ['https://stg.example.com', 'https://evil.example'],
        call: ['https://api.example.com', 'https://api.example.com/x'],
      },
    });
    expect(scopes['staging']).toEqual({
      visit: ['https://stg.example.com'],
      call: ['https://api.example.com'],
    });
    expect(scopes['local']).toEqual({ visit: [], call: [] });
    expect(warnings.join('\n')).toContain(
      'target.scope.visit lists https://evil.example',
    );
    expect(warnings.join('\n')).toContain(
      'target.scope.call lists https://api.example.com/x',
    );
  });

  it('target.scope.allow: an entry naming another origin is dropped; deny is kept whole', () => {
    const { target, warnings } = narrow({
      scope: {
        allow: [
          '/hrm/**',
          'https://evil.example/**',
          '//evil.example/x',
          '/\\evil',
          '/\t/evil.example/login',
          '/\n/evil.example',
          ' //evil.example',
        ],
        deny: ['/admin/**'],
      },
    });
    expect(target.scope.allow).toEqual(['/hrm/**']);
    expect(target.scope.deny).toEqual(['/admin/**']);
    expect(warnings).toHaveLength(1);
  });

  it('target.scope.visit: canonical forms of an allowed origin are kept; userinfo, a path or a query is not a bare origin', () => {
    const { scopes, target } = narrow({
      scope: {
        visit: [
          'HTTPS://STG.example.com',
          'https://stg.example.com:443',
          'https://stg.example.com/',
          'https://u@sso.example.com',
          'https://sso.example.com/x',
          'https://sso.example.com?a',
        ],
      },
    });
    expect(scopes['staging']?.visit).toEqual(['https://stg.example.com']);
    expect(target.scope.visit).toEqual(['https://stg.example.com']);
  });

  it('target.scope.visit left out is the whole ceiling; an explicit empty list is nothing, with a warning per env', () => {
    expect(narrow({}).scopes['local']?.visit).toEqual([
      'http://127.0.0.1:4200',
    ]);
    const { scopes, warnings } = narrow({ scope: { visit: [] } });
    expect(scopes['local']?.visit).toEqual([]);
    expect(scopes['staging']?.visit).toEqual([]);
    expect(warnings.filter((w) => w.includes('nothing to visit'))).toHaveLength(
      2,
    );
  });

  it('the effective target keeps no dropped origin', () => {
    const { target } = narrow({
      scope: { call: ['https://api.example.com', 'https://evil.example'] },
    });
    expect(target.scope.call).toEqual(['https://api.example.com']);
  });

  it('target.budgets: a bigger budget is capped, a smaller one kept', () => {
    const { target, warnings } = narrow({
      budgets: { pages: 10_000, wallClockMs: 1000, costUsd: 50 },
    });
    expect(target.budgets).toEqual({
      pages: BUDGET_CEILINGS.pages,
      wallClockMs: 1000,
      costUsd: BUDGET_CEILINGS.costUsd,
    });
    expect(warnings).toHaveLength(2);
  });

  it('target.destructiveWords: added to the core list, never removing one', () => {
    const { target, warnings } = narrow({
      destructiveWords: [' Hủy Đơn ', '', '!!!'],
    });
    expect(target.destructiveWords).toEqual(['hủy đơn']);
    expect(warnings).toHaveLength(1);
    expect(destructiveWord('Hủy đơn này', target.destructiveWords)).toBe(
      'hủy đơn',
    );
    expect(destructiveWord('Hủy đơn này')).toBeUndefined();
    expect(destructiveWord('Xoá', target.destructiveWords)).toBe('xoá');
    expect(() =>
      new ActionGuard('shared', false, target.destructiveWords).check(
        'Hủy đơn',
        'button',
        'system1',
      ),
    ).toThrow(/hủy đơn/);
  });

  it('target.profiles.<n>.login: a recipe on another origin, or for an unknown profile, is ignored', () => {
    const recipe = {
      username: { label: 'Tên đăng nhập' },
      password: { label: 'Mật khẩu' },
      submit: { testId: 'login' },
    };
    const { target, warnings } = narrow({
      profiles: {
        admin: { login: { ...recipe, path: 'https://evil.example/login' } },
        ghost: { login: recipe },
      },
    });
    expect(target.profiles).toEqual({ admin: {} });
    expect(warnings).toHaveLength(2);
    expect(
      narrow({
        profiles: { admin: { login: { ...recipe, path: '/\t/evil.example' } } },
      }).target.profiles,
    ).toEqual({ admin: {} });
    expect(
      narrow({ profiles: { admin: { login: recipe } } }).target.profiles,
    ).toEqual({
      admin: { login: { ...recipe, path: '/login' } },
    });
  });

  it('refuses an unknown key under target, scope and budgets', () => {
    for (const raw of [
      { extra: 1 },
      { scope: { extra: [] } },
      { budgets: { steps: 1 } },
    ])
      expect(() => TargetSchema.parse(raw), JSON.stringify(raw)).toThrow();
  });

  it('refuses a login field given as a selector or a value', () => {
    expect(() =>
      TargetSchema.parse({
        profiles: {
          admin: {
            login: {
              username: { selector: '#u' },
              password: { label: 'p' },
              submit: { label: 's' },
            },
          },
        },
      }),
    ).toThrow();
  });
});
