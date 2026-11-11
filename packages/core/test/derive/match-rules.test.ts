import { describe, expect, it } from 'vitest';
import { matchOperations, mdCode, WEIGHTS } from '../../src/derive/index.js';
import { occurrences } from '../../src/spec/index.js';
import { appMap, operation, page } from './build.js';

/** The individual rules of ADR 0034 sections 5 and 6, each pinned by a case that fails without it. */
describe('matcher rules (ADR 0034)', () => {
  it('takes no route evidence from expected items, only their quoted literals', () => {
    const op = operation({ id: 'e', items: ['Trang Phê duyệt mở ra.'] });
    const [m] = matchOperations(
      [op],
      appMap([page('/p', 'Phê duyệt')]),
    ).operations;
    expect(m?.screen).toEqual({ status: 'none' });
  });

  it('gives title-equal and no title-mention for a heading equal to the page title', () => {
    const op = operation({
      id: 'map-pages',
      title: 'Các trang của sơ đồ',
      headings: ['Sơ đồ', 'Các trang của sơ đồ'],
      items: ['Có.'],
    });
    const [m] = matchOperations([op], appMap([page('/x', 'Sơ đồ')])).operations;
    expect(
      m?.screens[0]?.evidence.map((e) => [
        e.kind,
        e.rule,
        e.spec.path,
        e.spec.text,
      ]),
    ).toEqual([
      [
        'title-equal',
        'exact',
        ['expected', 0, 'context', 'headings', 0],
        'Sơ đồ',
      ],
      ['title-mention', 'folded', ['title'], 'sơ đồ'],
    ]);
    expect(m?.screens[0]?.score).toBe(
      WEIGHTS['title-equal'] + WEIGHTS['title-mention'],
    );
  });

  it('counts one label once, whatever its spacing or case in the spec', () => {
    const op = operation({
      id: 'l',
      steps: ['Bấm "Gửi".', 'Bấm " Gửi ".', 'Bấm "gửi".'],
    });
    const [m] = matchOperations(
      [op],
      appMap([page('/f', 'F', ['button:Gửi'])]),
    ).operations;
    expect(m?.literals.map((l) => l.text)).toEqual(['Gửi', 'gửi']);
    expect(m?.screens[0]?.score).toBe(WEIGHTS.label);
  });

  it('cites each folder of the source path at its own offset', () => {
    const op = operation({
      id: 's',
      location: { provider: 'markdown', ref: 'hr/leave/a.md' },
    });
    const [m] = matchOperations(
      [op],
      appMap([page('/leave', 'L'), page('/hr', 'H')]),
    ).operations;
    expect(m?.screen).toEqual({
      status: 'ambiguous',
      pages: ['/hr', '/leave'],
    });
    expect(
      m?.screens.map((s) => s.evidence.map((e) => [e.spec.start, e.spec.text])),
    ).toEqual([[[0, 'hr']], [[3, 'leave']]]);
  });

  it('gives the same report for operations that share id, provider and ref, in any order', () => {
    const a = operation({ id: 'd', headings: ['A'], items: ['x.'] });
    const b = operation({ id: 'd', headings: ['B'], items: ['y.'] });
    const map = appMap([page('/a', 'A'), page('/b', 'B')]);
    expect(matchOperations([a, b], map)).toEqual(matchOperations([b, a], map));
  });

  it('treats an invisible neighbour as no boundary, and shows lone surrogates and fullwidth formulas', () => {
    expect(occurrences('Mở Lab\u200bel', 'Lab')).toEqual([]);
    expect(occurrences('Mở \u200bLab', 'Lab')).toEqual([]);
    expect(mdCode('a\ud800b')).toBe('` a⟨U+D800⟩b `');
    expect(mdCode('＝1+1')).toBe("` '＝1+1 `");
  });
});
