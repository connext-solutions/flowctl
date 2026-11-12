/**
 * Reconcile (roadmap section 3.6): match a failed or ambiguous case to the code that explains it. Done so far:
 * the read-only code index (`code/`, T6.1) and the failure classifier (`classify/`, T6.2). Not exported from the
 * package yet.
 *
 * @see docs/adr/0035-code-index.md
 * @see docs/adr/0036-failure-classifier.md
 */
export * from './code/index.js';
export * from './classify/index.js';
