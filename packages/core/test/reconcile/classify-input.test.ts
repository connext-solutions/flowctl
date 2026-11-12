import { describe, expect, it } from 'vitest';
import { notFoundMessage } from '../../src/browser/index.js';
import { CLASSIFY_LIMITS, classifyFailure } from '../../src/reconcile/index.js';
import { fakeIndex, notFound, run } from './classify-build.js';

describe('classifyFailure: what it reads from run.json, and its bounds', () => {
  it.each([
    ['value', { value: { locator: { testId: 'total' }, equals: '5' } }],
    ['network', { network: { method: 'POST', url: '**/orders' } }],
  ] as const)(
    'a failed %s assertion has no text or route rule',
    (_n, assertion) => {
      const c = classifyFailure({
        result: run({ failed: { assertion, got: 'x' } }),
        code: fakeIndex({ labels: ['Gửi'] }),
      });
      expect(c).toMatchObject({ class: 'unknown', hits: [] });
      expect(c.notes).toContain(
        'failed assertion kind has no text or route rule',
      );
    },
  );

  it.each([
    [
      'a refused name',
      notFound({ role: 'button', name: 'Gửi\u200bđơn' }),
      'locator name refused: invisible',
    ],
    [
      'a testId locator',
      notFound({ testId: 'submit' }),
      'step failure not_found names no role locator',
    ],
    [
      'an ambiguous step',
      run({
        failed: {
          step: 1,
          kind: 'ambiguous',
          message: 'button "A" matched 2 elements',
        },
      }),
      'step failure ambiguous names no role locator',
    ],
  ])('%s gives a note and no label rule', (_n, result, note) => {
    const c = classifyFailure({
      result,
      code: fakeIndex({ labels: ['Gửi đơn'] }),
    });
    expect(c.class).toBe('unknown');
    expect(c.notes).toContain(note);
  });

  it.each([
    ['a double quote', 'Say "hi"', 'Say "hi" now'],
    ['a quote and the word not found', 'x" not found', 'x" not found again'],
  ])('reads a locator name holding %s whole', (_n, name, label) => {
    const c = classifyFailure({
      result: notFound({ role: 'button', name }),
      code: fakeIndex({ labels: [label] }),
    });
    expect(c).toMatchObject({ class: 'stale_test' });
    expect(c.basis[0]?.evidence[0]).toEqual({
      source: 'run',
      pointer: '/failed/message',
      text: name,
    });
  });

  it('the executor writes the not_found message in the format the classifier reads', () => {
    expect(notFoundMessage({ role: 'button', name: 'Gửi' })).toBe(
      'button "Gửi" not found',
    );
    expect(notFoundMessage({ testId: 'submit' })).toBe(
      'testId=submit not found',
    );
  });

  it('a step message too long to read, or a name over maxSubject, gives a note and no label rule', () => {
    const long = run({
      failed: {
        step: 1,
        kind: 'not_found',
        message: `button "${'x '.repeat(3000)}" not found`,
      },
    });
    expect(classifyFailure({ result: long }).notes).toEqual([
      'step failure message is too long',
      'no rule found evidence',
    ]);
    const name = 'a'.repeat(CLASSIFY_LIMITS.maxSubject + 1);
    const c = classifyFailure({
      result: notFound({ role: 'button', name }),
      code: fakeIndex({ labels: [name.slice(1)] }),
    });
    expect(c).toMatchObject({ class: 'unknown', hits: [] });
    expect(c.notes).toContain(
      `locator name is longer than ${CLASSIFY_LIMITS.maxSubject} code points`,
    );
  });

  it('cuts untrusted text in evidence and does not change its inputs', () => {
    const long = `Gửi ${'x'.repeat(500)}`;
    const code = fakeIndex({ labels: [long] });
    const input = { result: notFound({ role: 'button', name: 'Gửi' }), code };
    const before = JSON.stringify(input.result);
    const c = classifyFailure(input);
    const text = c.basis[0]?.evidence[1]?.text ?? '';
    expect([...text]).toHaveLength(CLASSIFY_LIMITS.maxEvidenceText);
    expect(text.endsWith('…')).toBe(true);
    expect(JSON.stringify(input.result)).toBe(before);
    expect(classifyFailure(input)).toEqual(c);
  });

  it('bounds the near search on a hostile index: 20,000 labels of 1,000 code points that all contain the text', () => {
    const labels = Array.from(
      { length: 20_000 },
      (_, i) => `${'a '.repeat(490)}${i}`,
    );
    const c = classifyFailure({
      result: notFound({ role: 'button', name: 'a a' }),
      code: fakeIndex({ labels }),
    });
    expect(c.basis[0]?.evidence.length).toBe(1 + CLASSIFY_LIMITS.maxNear);
    expect(c.notes).not.toContain('near search stopped at its budget');
  });

  it('a hostile index of long labels that contain the text only off token boundaries stops at its budget', () => {
    const name = `a ${'aa '.repeat(98)}a`;
    const label = 'aa '.repeat(333);
    const labels = Array.from({ length: 20_000 }, () => label);
    const c = classifyFailure({
      result: notFound({ role: 'button', name }),
      code: fakeIndex({ labels }),
    });
    expect(c).toMatchObject({ class: 'unknown', hits: [] });
    expect(c.notes).toContain('near search stopped at its budget');
  });

  it('the budget counts compared code points: a near label after it is not searched, one before it is', () => {
    const filler = 'x'.repeat(999);
    const limits = { ...CLASSIFY_LIMITS, maxComparedPoints: 10_000 };
    const at = (i: number) => {
      const labels = Array.from({ length: 20 }, () => filler);
      labels[i] = 'Gửi đơn ngay';
      return classifyFailure(
        {
          result: notFound({ role: 'button', name: 'Gửi' }),
          code: fakeIndex({ labels }),
        },
        limits,
      );
    };
    expect(at(5)).toMatchObject({ class: 'stale_test' });
    expect(at(5).notes).toContain('near search stopped at its budget');
    expect(at(15)).toMatchObject({
      class: 'unknown',
      notes: ['near search stopped at its budget', 'no rule found evidence'],
    });
  });
});
