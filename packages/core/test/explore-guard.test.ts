import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { destructiveWord } from '../src/browser/index.js';
import {
  ActionGuard,
  DestructiveAction,
  envClassFor,
} from '../src/explore/guard.js';
import { type InitAnswers, initTrust, TrustStore } from '../src/trust/index.js';
import {
  editStore,
  gitRepo,
  testAnchorDir,
  testOwnerKey,
} from './trust-fixture.js';

/** The interim destructive-action matcher and policy (ADR 0024 section 5). */
describe('destructiveWord', () => {
  it.each([
    ['Xoá đơn', 'xoá'],
    ['Xóa', 'xóa'],
    ['Xoá?', 'xoá'],
    ['(Xoá)', 'xoá'],
    ['Delete…', 'delete'],
    ['Duyệt Việc riêng cố định', 'duyệt'],
    ['Từ chối', 'từ chối'],
    ['DeleteAll', 'delete'],
    ['remove-item', 'remove'],
    ['Approve request', 'approve'],
    ['Thanh toán ngay', 'thanh toán'],
  ])('finds the word in %s', (label, word) => {
    expect(destructiveWord(label)).toBe(word);
  });

  it.each([
    'Gửi',
    'Lưu',
    'Resend',
    'Payroll',
    'Tạo mới',
    'Huỷ',
    'Đặt lại',
    'Chối',
    'Gửi duyệt',
    'Trình duyệt',
    'Người phê duyệt',
    'Chờ duyệt',
    'Từ khoá',
  ])('leaves %s alone', (label) => {
    expect(destructiveWord(label)).toBeUndefined();
  });
});

describe('ActionGuard', () => {
  const refused = (
    g: ActionGuard,
    by: 'system1' | 'system2',
    role: string | undefined = 'button',
    label = 'Xoá đơn',
  ): boolean => {
    try {
      g.check(label, role, by);
      return false;
    } catch (e) {
      if (e instanceof DestructiveAction) return true;
      throw e;
    }
  };

  it('never guards a local env', () => {
    expect(refused(new ActionGuard('local', false), 'system1')).toBe(false);
  });

  it('on a shared env stops System 1 always, and the orchestrator unless the request allows it', () => {
    expect(refused(new ActionGuard('shared', true), 'system1')).toBe(true);
    expect(refused(new ActionGuard('shared', false), 'system2')).toBe(true);
    expect(refused(new ActionGuard('shared', true), 'system2')).toBe(false);
  });

  it('refuses everyone on production or an unknown env, even with allowDestructive', () => {
    expect(refused(new ActionGuard('production', true), 'system2')).toBe(true);
    expect(refused(new ActionGuard('unknown', true), 'system2')).toBe(true);
  });

  it('checks only action roles: a field or cell named with the word is not an action', () => {
    const g = new ActionGuard('shared', false);
    expect(refused(g, 'system1', 'textbox', 'Ngày thanh toán')).toBe(false);
    expect(refused(g, 'system1', 'gridcell', 'Từ chối')).toBe(false);
    expect(refused(g, 'system1', 'link', 'Xoá')).toBe(true);
    expect(refused(g, 'system1', undefined, 'Xoá')).toBe(true);
  });
});

describe('envClassFor', () => {
  const store = (
    answers: InitAnswers,
  ): { dir: string; open: () => TrustStore } => {
    const base = mkdtempSync(join(tmpdir(), 'flowctl-envclass-'));
    const root = join(base, 'repo');
    mkdirSync(join(root, '.flows'), { recursive: true });
    const dir = join(base, 'store');
    gitRepo(root);
    initTrust({
      storeDir: dir,
      key: testOwnerKey(),
      project: 'demo',
      projectDir: root,
      flowsDir: join(root, '.flows'),
      answers,
      anchorDir: testAnchorDir(),
    });
    return { dir, open: () => TrustStore.open(dir) };
  };
  const ANSWERS: InitAnswers = {
    envs: {
      stg: { origin: 'https://stg.example.com', class: 'shared' },
      prod: { origin: 'https://erp.example.com', class: 'production' },
      other: { origin: 'https://other.example.com', class: 'shared' },
    },
    productionOrigins: ['https://erp.example.com'],
    defaultEnv: 'stg',
    language: 'vi',
    locale: 'vi-VN',
  };

  it('reads the class, treats any port of a production host as production, and an unlisted origin as unknown', () => {
    const s = store(ANSWERS).open();
    expect(envClassFor('https://stg.example.com', s)).toBe('shared');
    expect(envClassFor('https://erp.example.com:8443', s)).toBe('production');
    expect(envClassFor('http://erp.example.com', s)).toBe('production');
    expect(envClassFor('https://new.example.com', s)).toBe('unknown');
    expect(envClassFor('http://127.0.0.1:4200', undefined)).toBe('local');
  });

  it('verifies only the matching entry, so a bad entry for another env does not stop every run', () => {
    const { dir, open } = store(ANSWERS);
    editStore(dir, (d) => {
      const other = d.envs['other'];
      if (other === undefined) throw new Error('no other env');
      other.class = 'local';
      return d;
    });
    expect(envClassFor('https://stg.example.com', open())).toBe('shared');
    expect(() => envClassFor('https://other.example.com', open())).toThrow();
  });
});
