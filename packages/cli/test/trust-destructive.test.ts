import type { Draft } from '@flowctl/core';
import { describe, expect, it } from 'vitest';
import { askDraft, daysOf } from '../src/trust-destructive-add.js';
import type { Tty } from '../src/trust-tty.js';

/**
 * The prompts of `flowctl trust add destructive` (ADR 0024 amendment 2026-11-13): every recorded value reaches the
 * terminal escaped, and `--days` is digits only.
 */
const draft = (bodyKeys: string[]): Draft => ({
  write: {
    method: 'POST',
    template: '/api/items',
    contentType: 'json',
    bodyKeys,
    queryKeys: [],
    statuses: [201],
    placeholders: 0,
  },
  kind: 'skip',
  id: 'items-create',
  nameField: '/name',
  naturalKeys: ['/name'],
  conflictStatus: [409],
  idFrom: 'body:/id',
  cleanup: '/api/items/{int}',
  verify: '/api/items/{int}',
  ledgerFrom: '',
  idPositions: [],
});

describe('trust add destructive prompts', () => {
  it('escapes a recorded body key holding a terminal escape sequence', () => {
    const shown: string[] = [];
    const tty: Tty = {
      write: (t) => void shown.push(t),
      ask: (p) => {
        shown.push(p);
        return '';
      },
      close: () => undefined,
    };
    expect(askDraft(tty, draft(['/na\u001b]0;pwned\u0007me'])).kind).toBe(
      'skip',
    );
    const text = shown.join('');
    expect(text).toContain('/na');
    const controls = [...text].filter(
      (c) => c !== '\n' && (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f),
    );
    expect(controls).toEqual([]);
  });

  it('reads --days as digits only', () => {
    expect(daysOf(undefined)).toBeUndefined();
    expect(daysOf('30')).toBe(30);
    for (const bad of ['', ' 5', '1e1', '0x1e', '5.0', '-3'])
      expect(daysOf(bad), bad).toBeNaN();
  });
});
