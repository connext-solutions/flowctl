/**
 * Reconcile (roadmap section 3.6): match a failed or ambiguous case to the code that explains it. Done so far:
 * the read-only code index (`code/`, T6.1), the failure classifier (`classify/`, T6.2), the coverage gaps between
 * code, crawl and spec (`gaps/`, T6.4), and the entry points on a project's files that `flowctl reconcile` calls
 * (`project/`, T6.6; exported from the package).
 *
 * @see docs/adr/0035-code-index.md
 * @see docs/adr/0036-failure-classifier.md
 * @see docs/adr/0037-coverage-gaps.md
 */
export * from './code/index.js';
export * from './classify/index.js';
export * from './gaps/index.js';
export * from './project/index.js';
