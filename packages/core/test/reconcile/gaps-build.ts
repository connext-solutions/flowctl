import type { CodeIndex, RouteRecord } from '../../src/reconcile/index.js';

const unused = (): never => {
  throw new Error('coverageGaps reads routes only');
};

/** A route record as the code index gives it: full path, declared pattern, extractor, file and line. */
export const route = (
  path: string,
  file: string,
  line: number,
  pattern: string = path,
  source = 'route-objects',
): RouteRecord => ({ path, pattern, source, file, line });

/** A code index holding only `routes`; its lookups are never called by `coverageGaps`. */
export const routesIndex = (routes: RouteRecord[]): CodeIndex => ({
  routes,
  labels: [],
  messages: [],
  skipped: [],
  files: 1,
  findLabel: unused,
  findRoute: unused,
  findMessage: unused,
});
