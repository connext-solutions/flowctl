import { describe, expect, it } from 'vitest';
import type { PageSnapshot } from '../src/browser/index.js';
import { decisionEntry } from '../src/explore/decisions.js';
import { maskSecrets } from '../src/foundation/index.js';
import { OPS, buildRequest } from '../src/system1/index.js';

/**
 * Secret masking toward System 1 and in `decisions.jsonl` (issue #13, ADR 0006): a secret typed into a field that is
 * named by its text, put into a query string, shown as an option or a title, or reformatted by an input mask, never
 * leaves in clear.
 */
const SECRET = '0901234567';

const page: PageSnapshot = {
  url: `http://app.test/search?phone=${SECRET}#q=${SECRET}`,
  title: `Kết quả cho ${SECRET}`,
  text: 'Tìm kiếm\n0901 234 567',
  canScrollUp: false,
  canScrollDown: false,
  fingerprint: 'm',
  controls: [
    {
      id: 1,
      role: 'textbox',
      name: SECRET,
      ops: ['CLICK', 'TYPE_TEXT'],
      value: '090-123-4567',
    },
    {
      id: 2,
      role: 'combobox',
      name: 'Số điện thoại',
      ops: ['CLICK', 'SELECT'],
      value: '',
      options: [`(090) 1234 567`, 'Khác'],
    },
  ],
};

describe('maskSecrets', () => {
  it.each(['0901 234 567', '090-123-4567', '(090) 1234 567', '090.123.4567'])(
    'masks %j, the secret reformatted by an input mask',
    (text) => {
      const masked = maskSecrets(`số ${text} đây`, [SECRET]);
      expect(masked).toContain('***');
      expect(masked).not.toMatch(/\d/);
    },
  );

  it('leaves a short secret to exact matching, so "12" does not mask every 1-2', () => {
    expect(maskSecrets('a 1-2 b 12', ['12'])).toBe('a 1-2 b ***');
  });
});

describe('the System 1 request and the decision log', () => {
  it('carries no form of the secret in any field', () => {
    const { body } = buildRequest(
      {
        goal: 'Tìm theo số điện thoại',
        page,
        history: [
          {
            op: 'TYPE_TEXT',
            control: `[1] textbox "${SECRET}"`,
            changed: true,
          },
        ],
        ops: [...OPS],
        inputs: [{ key: 'phone' }],
        secrets: [SECRET],
      },
      'jev-latest',
    );
    const text = JSON.stringify(body);
    for (const form of [
      SECRET,
      '0901 234 567',
      '090-123-4567',
      '(090) 1234 567',
    ])
      expect(text).not.toContain(form);
    expect(text).toContain('Số điện thoại');
  });

  it('masks control labels and the URL in decisions.jsonl', () => {
    const entry = decisionEntry({
      source: 'explore',
      step: 0,
      url: page.url,
      ms: 1,
      outcome: `act TYPE_TEXT [1] textbox "${SECRET}"`,
      decision: {
        ranked: [{ op: 'CLICK', p: 0.9 }],
        targets: { CLICK: { id: 1, p: 0.9 } },
        model: 'm',
      },
      snap: page,
      secrets: [SECRET],
    });
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(JSON.stringify(entry)).toContain('***');
  });
});
