import {
  ByteBudget,
  checkRoot,
  type ContainedRoot,
  requirePurpose,
  walkContained,
} from '../../trust/index.js';
import { shared } from './emit.js';
import { extractFile } from './extract.js';
import { kindOf } from './load.js';
import { checkRootName, DEFAULT_ROOT_NAME } from './ref.js';
import {
  CONTRACT_LIMITS,
  type ContractFact,
  type ContractOptions,
  type ContractReport,
  type SkippedContract,
} from './types.js';

const PRUNE: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'vendor',
]);

/**
 * Reads every contract file below `root` and returns its facts and skips in a fixed order (files in byte order of
 * their path, facts in file order), so two reads of the same tree agree.
 *
 * @remarks Files are listed with `walkContained` (dot-prefixed names, links, hard links, FIFOs, non-NFC names and
 *   oversized files are left out and reported in `skipped`; `node_modules` and build folders are not entered) and
 *   read one by one with `readContained`. Only the extensions of the readers are listed, so other files are neither
 *   read nor charged. The read never logs, never touches the environment or the clock.
 * @throws {ContainmentError} `path_not_contained` for a root of another purpose or one that changed (rule `purpose`,
 *   `root changed`) and for a root name that is not allowed; `too_large` when the tree has too many entries, is too
 *   deep, or one of the budgets (bytes, files, facts, references) is passed: the whole read is refused, never
 *   returned in part.
 * @example
 *   const root = openRoot('/abs/contracts', 'contracts');
 *   const { facts } = readContracts(root, { rootName: 'api' });
 *   const checks = checkConsistency({ facts });
 */
export function readContracts(
  root: ContainedRoot,
  opts: ContractOptions = {},
): ContractReport {
  requirePurpose(root, 'contracts');
  checkRootName(opts.rootName ?? DEFAULT_ROOT_NAME);
  const limits = { ...CONTRACT_LIMITS, ...opts.limits };
  const walked = walkContained(
    root,
    {
      maxEntries: limits.maxEntries,
      maxBytes: limits.maxBytes,
      maxFileBytes: limits.maxFileBytes,
    },
    undefined,
    { prune: PRUNE, include: (rel) => kindOf(rel) !== undefined },
  );
  const files = new ByteBudget(limits.maxFiles, 'contract files');
  const bytes = new ByteBudget(limits.maxBytes, 'bytes read');
  const ctx = { root, sh: shared(limits, opts.sides), bytes, trees: new Map() };
  const facts: ContractFact[] = [];
  const skipped: SkippedContract[] = walked.skipped.map((s) => ({
    file: s.path,
    line: 0,
    reason: s.rule,
  }));
  for (const f of walked.files) {
    files.take(1);
    const got = extractFile(ctx, f.path);
    facts.push(...got.facts);
    skipped.push(...got.skipped);
  }
  checkRoot(root);
  return { facts, skipped, files: files.total, bytes: bytes.total };
}
