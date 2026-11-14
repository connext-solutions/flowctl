/** Shared helpers of the contract reader tests: temp-dir contract roots, the real fixture-app contracts in place. */
import { FIXTURE_CONTRACTS_DIR } from '@flowctl/fixture-app';
import {
  type ContractFact,
  type ContractOptions,
  type ContractRule,
  type ContractSource,
  readContracts,
} from '../../src/derive/index.js';
import { type ContainedRoot, openRoot } from '../../src/trust/index.js';
import { put, tmp } from '../reconcile/repo.js';

/** A contracts root holding `files` (path to text), in a fresh temp directory. */
export const rootOf = (
  files: Record<string, string | Buffer>,
): ContainedRoot => {
  const dir = tmp();
  for (const [rel, body] of Object.entries(files)) put(dir, rel, body);
  return openRoot(dir, 'contracts');
};

/** The real fixture-app contracts folder as a root, read in place. */
export const fixtureRoot = (): ContainedRoot =>
  openRoot(FIXTURE_CONTRACTS_DIR, 'contracts');

/** Reads `files` as a contracts root. */
export const readFiles = (
  files: Record<string, string | Buffer>,
  opts?: ContractOptions,
): ReturnType<typeof readContracts> => readContracts(rootOf(files), opts);

/** The facts of `facts` with this field, rule and (optionally) source. */
export const pick = (
  facts: readonly ContractFact[],
  field: string,
  rule: ContractRule,
  source?: ContractSource,
): ContractFact[] =>
  facts.filter(
    (f) =>
      f.field === field &&
      f.rule === rule &&
      (source === undefined || f.source === source),
  );

/** The value of the one fact with this field and rule, or `undefined` when there is none or more than one. */
export const valueOf = (
  facts: readonly ContractFact[],
  field: string,
  rule: ContractRule,
  source?: ContractSource,
): string | undefined => {
  const found = pick(facts, field, rule, source);
  return found.length === 1 ? found[0]?.value : undefined;
};

/** The skip reasons of a report, in order. */
export const reasons = (skipped: readonly { reason: string }[]): string[] =>
  skipped.map((s) => s.reason);
