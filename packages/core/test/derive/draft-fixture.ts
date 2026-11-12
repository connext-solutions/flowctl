/** Shared fixtures of the drafter tests: a Vietnamese verb table, a small map and draft helpers. */
import {
  draftCase,
  matchOperations,
  type VerbRules,
} from '../../src/derive/index.js';
import type { AppMap } from '../../src/observe/index.js';
import type { Operation } from '../../src/spec/index.js';
import { appMap, page } from './build.js';

/** A small Vietnamese verb table: product data of the test, as a caller in another language would pass it. */
export const VI: VerbRules = {
  open: ['mở', 'vào'],
  click: ['bấm'],
  fill: ['nhập'],
  select: ['chọn'],
  check: ['tích'],
  observe: ['xem', 'kiểm tra'],
};

const requests = page(
  '/requests',
  'Đơn từ',
  ['link:Đơn từ', 'link:Phê duyệt', 'button:Gửi', 'button:Lưu', 'button:Lưu'],
  ['textbox:Lý do *', 'textbox:Số tiền', 'combobox:Nhân viên'],
);
const approvals = page('/approvals', 'Phê duyệt', [
  'link:Đơn từ',
  'link:Phê duyệt',
  'button:Duyệt',
]);
export const map = appMap([approvals, requests]);

/** Drafts `op` against `m` with the Vietnamese verb table. */
export function draft(op: Operation, m: AppMap = map, actor?: string) {
  const report = matchOperations([op], m);
  const entry = report.operations[0];
  if (entry === undefined) throw new Error('no entry');
  return draftCase(op, entry, m, { actor, verbs: VI });
}

/** Drafts `op` against `m` with the given verb table (the English one by default). */
export function draftWith(op: Operation, m: AppMap, verbs?: VerbRules) {
  const entry = matchOperations([op], m).operations[0];
  if (entry === undefined) throw new Error('no entry');
  return draftCase(op, entry, m, {
    actor: 'staff',
    ...(verbs ? { verbs } : {}),
  });
}

/** Each drafted step as `[action, role, name, input]`. */
export const rows = (d: ReturnType<typeof draftWith>) =>
  d.steps.map((s) => [
    s.action,
    s.target?.role ?? null,
    s.target?.name ?? null,
    s.input ?? null,
  ]);
