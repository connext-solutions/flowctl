import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  markdownSpecProvider,
  type Operation,
  SpecRegistry,
} from '../src/spec/index.js';
import { openRoot } from '../src/trust/index.js';

const SPEC = fileURLToPath(new URL('../../fixture-app/spec', import.meta.url));
const index: Record<string, { doc: string; sentence: string }> = JSON.parse(
  readFileSync(join(SPEC, 'index.json'), 'utf8'),
);

const load = async (): Promise<{
  registry: SpecRegistry;
  ops: Operation[];
}> => {
  const registry = new SpecRegistry();
  registry.register(markdownSpecProvider(openRoot(SPEC, 'specs')));
  return { registry, ops: await registry.operations('markdown') };
};

describe('markdown SpecProvider on the fixture spec (T3.2 on T3.3)', () => {
  it('reads one valid operation per document, README excluded, in path order', async () => {
    const { ops } = await load();
    expect(ops.map((o) => [o.location.ref, o.id, o.actor])).toEqual([
      ['leave/approve.md', 'leave-approve', 'manager'],
      ['leave/persist.md', 'leave-persist', 'employee'],
      ['leave/submit.md', 'leave-submit', 'employee'],
      ['leave/validation.md', 'leave-validation', 'employee'],
      ['map/pages.md', 'map-pages', 'employee'],
    ]);
    expect(ops.every((o) => o.location.provider === 'markdown')).toBe(true);
    expect(ops.every((o) => o.signatureRef === null)).toBe(true);
  });

  it('finds every sentence a seeded bug contradicts as one whole expected item', async () => {
    const { ops } = await load();
    for (const [bug, { doc, sentence }] of Object.entries(index)) {
      const op = ops.find((o) => o.location.ref === doc);
      expect(
        op?.expected.map((e) => e.text),
        bug,
      ).toContain(sentence);
    }
  });

  it('gives each expected item its own ref, context, lead-in and quoted value', async () => {
    const { ops } = await load();
    const submit = ops.find((o) => o.id === 'leave-submit');
    expect(submit?.title).toBe('Gửi đơn nghỉ');
    expect(submit?.steps).toEqual([
      'Mở màn Đơn từ.',
      'Nhập "Lý do", "Số tiền" và chọn "Nhân viên".',
      'Bấm "Gửi".',
    ]);
    const bytes = readFileSync(join(SPEC, 'leave/submit.md'));
    const revision = createHash('sha256').update(bytes).digest('hex');
    expect(submit?.expected[0]).toEqual({
      text: 'Màn hình hiện thông báo "Đã gửi đơn".',
      value: 'Đã gửi đơn',
      ref: {
        doc: 'leave/submit.md',
        section: 'Kết quả mong đợi',
        lines: [23, 23],
        revision,
      },
      context: {
        operationId: 'leave-submit',
        operationTitle: 'Gửi đơn nghỉ',
        headings: ['Đơn từ', 'Gửi đơn nghỉ', 'Kết quả mong đợi'],
        leadIn: 'Khi gửi thành công:',
      },
    });
    const fail = submit?.expected.at(-1);
    expect(fail?.context.leadIn).toBe('Khi máy chủ báo lỗi:');
    expect(fail?.value).toBeNull();
    expect(
      submit?.expected.find((e) => e.text.includes('201'))?.value,
    ).toBeNull();
    const approve = ops.find((o) => o.id === 'leave-approve');
    expect(approve?.expected.map((e) => e.context.leadIn)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(approve?.expected.at(-1)?.ref.section).toBe('Phân quyền');
  });

  it('resolves every item back to its own text without a model', async () => {
    const { registry, ops } = await load();
    for (const op of ops)
      for (const item of op.expected)
        expect(await registry.resolve('markdown', item.ref)).toEqual({
          quote: item.text,
          revision: item.ref.revision,
        });
  });

  it('returns null for a ref that no longer points at an item', async () => {
    const { registry } = await load();
    const ref = {
      doc: 'leave/submit.md',
      section: 'Kết quả mong đợi',
      lines: [11, 11] as [number, number],
      revision: 'x',
    };
    expect(await registry.resolve('markdown', ref)).toBeNull();
    expect(
      await registry.resolve('markdown', { ...ref, doc: 'leave/none.md' }),
    ).toBeNull();
    expect(
      await registry.signatures('markdown', 'leave/submit.md.sig'),
    ).toBeNull();
  });

  it('filters by id', async () => {
    const { registry } = await load();
    const ops = await registry.operations('markdown', { ids: ['map-pages'] });
    expect(ops.map((o) => o.id)).toEqual(['map-pages']);
  });
});
