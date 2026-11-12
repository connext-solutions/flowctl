import { describe, expect, it } from 'vitest';
import { notFoundMessage } from '../../src/browser/index.js';
import { CLASSIFY_LIMITS, classifyFailure } from '../../src/reconcile/index.js';
import { appMap, operation, page } from '../derive/build.js';
import {
  classes,
  fakeIndex,
  notFound,
  run,
  textFailed,
} from './classify-build.js';

describe('classifyFailure: label rules', () => {
  const spec = (literal: string) =>
    operation({
      id: 'op-1',
      steps: [`Bấm "${literal}"`],
      items: [`Hiện "Đã gửi đơn"`],
    });

  it('spec says X, code and page have a folded Y: spec drift, high, with file, line, pointer and spec ref', () => {
    const c = classifyFailure({
      result: notFound({ role: 'button', name: 'Gửi đơn' }),
      spec: spec('Gửi đơn'),
      code: fakeIndex({ labels: ['Gửi Đơn@src/i18n/vi.json:7'] }),
      map: appMap([page('/orders', 'Orders', ['button:Gửi Đơn'])]),
    });
    expect(c).toMatchObject({
      class: 'spec_drift',
      confidence: 'high',
      candidates: [],
    });
    expect(c.basis[0]?.evidence).toEqual([
      { source: 'run', pointer: '/failed/message', text: 'Gửi đơn' },
      {
        source: 'spec',
        operation: 'op-1',
        doc: 'op-1.md',
        pointer: '/steps/0',
        ref: null,
        text: 'Gửi đơn',
      },
      {
        source: 'code',
        record: 'label',
        file: 'src/i18n/vi.json',
        line: 7,
        text: 'Gửi Đơn',
      },
      { source: 'map', pointer: '/pages/0/controls/0/name', text: 'Gửi Đơn' },
    ]);
  });

  it('spec says X, code and page both have a contained Y: spec drift, medium', () => {
    expect(
      classes({
        result: notFound({ role: 'button', name: 'Gửi' }),
        spec: spec('Gửi'),
        code: fakeIndex({ labels: ['Gửi đơn'] }),
        map: appMap([page('/orders', 'Orders', ['button:Gửi đơn'])]),
      }),
    ).toEqual({
      class: 'spec_drift',
      confidence: 'medium',
      rules: ['label-spec-drift'],
    });
  });

  it('two rules of the same class at the top confidence are both the basis', () => {
    const result = textFailed('Đã gửi đơn');
    result.evidence.network.push('500 POST http://127.0.0.1:4000/api/orders');
    const c = classifyFailure({
      result,
      spec: spec('Gửi'),
      code: fakeIndex({ messages: ['Đã gửi đơn'] }),
      origins: ['http://127.0.0.1:4000'],
    });
    expect(c).toMatchObject({
      class: 'product_bug',
      confidence: 'medium',
      candidates: [],
    });
    expect(c.basis.map((h) => h.rule)).toEqual([
      'server-error',
      'label-product-bug',
    ]);
  });

  it('a near text found only by containment on one side is low', () => {
    expect(
      classes({
        result: notFound({ role: 'button', name: 'Gửi' }),
        spec: spec('Gửi'),
        code: fakeIndex({ labels: ['Gửi đơn ngay'] }),
      }),
    ).toEqual({
      class: 'spec_drift',
      confidence: 'low',
      rules: ['label-spec-drift'],
    });
  });

  it('the map compares only controls of the locator role', () => {
    const c = classifyFailure({
      result: notFound({ role: 'button', name: 'Gửi đơn' }),
      spec: spec('Gửi đơn'),
      map: appMap([page('/orders', 'Gửi Đơn', ['link:Gửi Đơn'])]),
    });
    expect(c).toMatchObject({ class: 'unknown', hits: [] });
  });

  it('the test has X, spec, code and page agree on a folded Y: stale test, high', () => {
    expect(
      classes({
        result: notFound({ role: 'button', name: 'Lưu Lại' }),
        spec: spec('Lưu lại'),
        code: fakeIndex({ labels: ['Lưu lại'] }),
        map: appMap([page('/a', 'A', ['button:Lưu lại'])]),
      }),
    ).toEqual({
      class: 'stale_test',
      confidence: 'high',
      rules: ['label-stale'],
    });
  });

  it('without a spec, a contained near text on one side is stale test, low', () => {
    expect(
      classes({
        result: notFound({ role: 'button', name: 'Lưu' }),
        code: fakeIndex({ labels: ['Lưu lại'] }),
      }),
    ).toEqual({
      class: 'stale_test',
      confidence: 'low',
      rules: ['label-stale'],
    });
  });

  it('spec and code state the expected message, the page did not show it: product bug, medium', () => {
    const c = classifyFailure({
      result: textFailed('Đã gửi đơn'),
      spec: spec('Gửi'),
      code: fakeIndex({ messages: ['Đã gửi đơn@src/form.ts:4'] }),
    });
    expect(c).toMatchObject({ class: 'product_bug', confidence: 'medium' });
    expect(c.basis[0]?.evidence).toContainEqual({
      source: 'code',
      record: 'message',
      file: 'src/form.ts',
      line: 4,
      text: 'Đã gửi đơn',
    });
    expect(c.basis[0]?.evidence).toContainEqual(
      expect.objectContaining({ source: 'spec', pointer: '/expected/0/text' }),
    );
  });

  it('no evidence anywhere is unknown, never a guess', () => {
    const c = classifyFailure({
      result: notFound({ role: 'button', name: 'Gửi' }),
      spec: spec('Khác'),
      code: fakeIndex({ labels: ['Huỷ'] }),
      map: appMap([page('/a', 'A', ['button:Huỷ'])]),
    });
    expect(c).toMatchObject({
      class: 'unknown',
      confidence: null,
      hits: [],
      notes: ['no rule found evidence'],
    });
  });

  it('a tie between classes at the top confidence is unknown with both candidates', () => {
    const result = textFailed('Đã gửi đơn');
    result.evidence.network.push('503 GET http://127.0.0.1:4000/api/x');
    const c = classifyFailure({
      result,
      spec: spec('Gửi'),
      code: fakeIndex({ messages: ['Đã gửi đơn'] }),
    });
    expect(c).toMatchObject({ class: 'unknown', confidence: null, basis: [] });
    expect(c.candidates.map((h) => [h.rule, h.class, h.confidence])).toEqual([
      ['gateway-status', 'environment', 'medium'],
      ['label-product-bug', 'product_bug', 'medium'],
    ]);
  });

  it('a higher confidence wins over a lower one of another class', () => {
    const result = notFound({ role: 'button', name: 'Gửi đơn' });
    result.evidence.network.push('503 GET http://127.0.0.1:4000/api/x');
    const c = classifyFailure({
      result,
      spec: spec('Gửi đơn'),
      code: fakeIndex({ labels: ['Gửi Đơn'] }),
      map: appMap([page('/a', 'A', ['button:Gửi Đơn'])]),
    });
    expect(c.class).toBe('spec_drift');
    expect(c.hits.map((h) => h.rule)).toEqual([
      'gateway-status',
      'label-spec-drift',
    ]);
  });
});
