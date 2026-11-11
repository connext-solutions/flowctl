import { describe, expect, it } from 'vitest';
import { matchOperations, WEIGHTS } from '../../src/derive/index.js';
import { appMap, assertGrounded, operation, page } from './build.js';

const submit = operation({
  id: 'leave-submit',
  title: 'Gửi đơn nghỉ',
  headings: ['Đơn từ', 'Gửi đơn nghỉ', 'Kết quả mong đợi'],
  steps: [
    'Mở màn Đơn từ.',
    'Nhập "Lý do", "Số tiền" và chọn "Nhân viên".',
    'Bấm "Gửi".',
  ],
  items: [
    'Màn hình hiện thông báo "Đã gửi đơn".',
    'Địa chỉ trang đổi thành "/requests?saved=1".',
  ],
  location: { provider: 'markdown', ref: 'leave/submit.md' },
});

const requests = page(
  '/requests',
  'Đơn từ',
  ['link:Đơn từ', 'link:Phê duyệt', 'textbox:Lý do', 'button:Gửi'],
  ['textbox:Lý do', 'textbox:Số tiền', 'combobox:Nhân viên'],
);
const approvals = page('/approvals', 'Phê duyệt', [
  'link:Đơn từ',
  'link:Phê duyệt',
]);

describe('matchOperations (T4.1)', () => {
  it('joins an operation to its screen by heading, step mention, path literal and labels', () => {
    const map = appMap([approvals, requests]);
    const report = matchOperations([submit], map);
    assertGrounded(report, [submit], map);
    const [m] = report.operations;
    expect(m?.screen).toEqual({ status: 'matched', page: '/requests' });
    expect(m?.screens.map((s) => [s.page, s.score])).toEqual([
      [
        '/requests',
        WEIGHTS['title-equal'] +
          WEIGHTS['title-mention'] +
          WEIGHTS['path-literal'] +
          4 * WEIGHTS.label,
      ],
    ]);
    const kinds = new Set(m?.screens[0]?.evidence.map((e) => e.kind));
    expect([...kinds]).toEqual([
      'title-equal',
      'path-literal',
      'title-mention',
      'label',
    ]);
    expect(m?.literals.map((l) => [l.kind, l.text, l.elements.length])).toEqual(
      [
        ['path', '/requests?saved=1', 1],
        ['label', 'Gửi', 1],
        ['label', 'Lý do', 2],
        ['label', 'Nhân viên', 1],
        ['label', 'Số tiền', 1],
        ['label', 'Đã gửi đơn', 0],
      ],
    );
    expect(m?.unmatchedSteps).toEqual([]);
  });

  it('adds a weak doc-segment hint from the folder of the source', () => {
    const op = operation({
      id: 'map-pages',
      location: { provider: 'markdown', ref: 'map/pages.md' },
    });
    const map = appMap([page('/map', 'Sơ đồ'), page('/other', 'Khác')]);
    const [m] = matchOperations([op], map).operations;
    expect(m?.screen).toEqual({ status: 'matched', page: '/map' });
    expect(m?.screens[0]?.evidence).toEqual([
      {
        kind: 'doc-segment',
        rule: 'exact',
        weight: WEIGHTS['doc-segment'],
        spec: { path: ['location', 'ref'], start: 0, end: 3, text: 'map' },
        element: { kind: 'path', page: '/map', name: '/map' },
      },
    ]);
  });

  it('reports no screen and every step unmatched when the map has no such page', () => {
    const map = appMap([page('/home', 'Trang chủ', ['link:Trang chủ'])]);
    const [m] = matchOperations([submit], map).operations;
    expect(m?.screen).toEqual({ status: 'none' });
    expect(m?.screens).toEqual([]);
    expect(m?.unmatchedSteps).toEqual([
      { step: 0, text: 'Mở màn Đơn từ.', missing: [] },
      {
        step: 1,
        text: 'Nhập "Lý do", "Số tiền" và chọn "Nhân viên".',
        missing: ['Lý do', 'Nhân viên', 'Số tiền'],
      },
      { step: 2, text: 'Bấm "Gửi".', missing: ['Gửi'] },
    ]);
  });

  it('calls two equally good pages ambiguous and picks neither', () => {
    const op = operation({
      id: 'x',
      headings: ['Đơn từ'],
      items: ['Có kết quả.'],
      steps: ['Bấm "Gửi".'],
    });
    const map = appMap([
      page('/b', 'Đơn từ', ['button:Gửi']),
      page('/a', 'Đơn từ', ['button:Gửi']),
    ]);
    const [m] = matchOperations([op], map).operations;
    expect(m?.screen).toEqual({ status: 'ambiguous', pages: ['/a', '/b'] });
    expect(m?.screens.map((s) => s.page)).toEqual(['/a', '/b']);
  });

  it('matches labels across Unicode forms only where ADR 0020 allows it', () => {
    const op = operation({
      id: 'u',
      steps: ['Nhập "Lý do", "Ghi chú", "Ｓố" và bấm "Gửi".', 'Chọn "ﬁle".'],
    });
    const map = appMap([
      page('/f', 'Form', [
        `textbox:${'Lý do'.normalize('NFD')}`,
        'textbox:Ghi chú *',
        'button:Gửi\u200b',
        'button:file',
      ]),
    ]);
    const report = matchOperations([op], map);
    assertGrounded(report, [op], map);
    const [m] = report.operations;
    const lit = (t: string) => m?.literals.find((l) => l.text === t);
    expect(lit('Lý do')?.elements.map((e) => e.rule)).toEqual(['exact']);
    expect(lit('Ghi chú')?.elements.map((e) => e.rule)).toEqual(['folded']);
    expect(lit('Ｓố')).toMatchObject({
      refused: 'compatibility',
      elements: [],
    });
    expect(lit('ﬁle')).toMatchObject({
      refused: 'compatibility',
      elements: [],
    });
    expect(lit('Gửi')?.elements).toEqual([]);
    expect(report.refusedElements).toEqual([
      {
        element: {
          kind: 'control',
          page: '/f',
          index: 2,
          role: 'button',
          name: 'Gửi\u200b',
        },
        reason: 'invisible',
      },
    ]);
    expect(m?.unmatchedSteps.map((s) => [s.step, s.missing])).toEqual([
      [0, ['Gửi', 'Ｓố']],
      [1, ['ﬁle']],
    ]);
  });

  it('mentions a page title only at token boundaries', () => {
    const op = operation({ id: 'm', steps: ['Mở Label rồi mở màn Lab.'] });
    const [m] = matchOperations([op], appMap([page('/lab', 'Lab')])).operations;
    expect(
      m?.screens[0]?.evidence.map((e) => [e.kind, e.spec.start, e.spec.text]),
    ).toEqual([['title-mention', 20, 'Lab']]);
  });

  it('gives the same report whatever the order of operations and pages', () => {
    const other = operation({
      id: 'a-first',
      headings: ['Phê duyệt'],
      items: ['Có kết quả.'],
    });
    const one = matchOperations([submit, other], appMap([approvals, requests]));
    const two = matchOperations([other, submit], appMap([requests, approvals]));
    expect(two).toEqual(one);
    expect(one.operations.map((o) => o.operation.id)).toEqual([
      'a-first',
      'leave-submit',
    ]);
    expect(one.operations[0]?.screen).toEqual({
      status: 'matched',
      page: '/approvals',
    });
  });
});
