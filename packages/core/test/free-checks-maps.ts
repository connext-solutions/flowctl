import type {
  AppMap,
  AppPage,
  CheckId,
  FreeChecks,
} from '../src/observe/index.js';

/** Test maps for the free checks (T2.4): a page with defaults, a map of pages, and the parts of a finding. */
export const pageAt = (
  path: string,
  extra: Partial<AppPage> = {},
): AppPage => ({
  path,
  title: '',
  status: 200,
  controls: [],
  links: [],
  forms: [],
  calls: [],
  consoleErrors: [],
  refused: [],
  navigationRefused: false,
  ...extra,
});

export const mapOf = (pages: AppPage[], truncated = false): AppMap => ({
  v: 1,
  origin: 'http://127.0.0.1:5173',
  observedAt: '2026-11-12T10:00:00.000Z',
  truncated,
  pages,
});

export const check = (r: FreeChecks, id: CheckId) => {
  const found = r.checks.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no check ${id}`);
  return found;
};

export const ref = (id: CheckId) => ({ kind: 'invariant', ref: id });
export const at = (pointer: string) => ({
  kind: 'observation',
  file: 'appmap.json',
  pointer,
});
