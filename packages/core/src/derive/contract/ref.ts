import { createHash } from 'node:crypto';
import {
  ByteBudget,
  type ContainedRoot,
  ContainmentError,
  requirePurpose,
  splitRelative,
} from '../../trust/index.js';
import { isVisible, MAX_REF, shared } from './emit.js';
import { extractFile } from './extract.js';
import {
  CONTRACT_LIMITS,
  type ContractFact,
  type ContractLimits,
} from './types.js';

const ROOT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The name refs carry when a root has none. */
export const DEFAULT_ROOT_NAME = 'contracts';

/** @throws {ContainmentError} `path_not_contained` (rule `root name`) for a name that is not 1 to 64 letters, digits, `_` or `-`. */
export function checkRootName(name: string): void {
  if (!ROOT_NAME.test(name))
    throw new ContainmentError(
      'path_not_contained',
      'root name',
      'a contracts root name is 1 to 64 letters, digits, "_" or "-"',
    );
}

/**
 * The reference of a fact: `<rootName>:<relative/path>#<JSON Pointer>`, at most 500 characters, no invisible
 * character. It names where the fact was read, so `resolveContractRef` can read it again; it is a label, never a
 * path or a URL (ADR 0023 rule 1).
 *
 * @example contractRef(fact, 'api') // 'api:openapi.yaml#/components/schemas/NewLeaveRequest/properties/reason/maxLength'
 * @throws {ContainmentError} for a root name that is not allowed.
 */
export function contractRef(fact: ContractFact, rootName: string): string {
  checkRootName(rootName);
  return `${rootName}:${fact.file}#${fact.pointer}`;
}

/** What {@link resolveContractRef} read again: the fact, its value and the SHA-256 (hex) of the file's bytes. */
export interface ResolvedContract {
  fact: ContractFact;
  value: string;
  sourceSha256: string;
}

/**
 * Reads the fact `ref` names again from the current file, for the save of a derived assertion and for the freshness
 * check (ADR 0020 section e): `null` when the file, or the fact in it, is gone; the current value otherwise, so a
 * changed value is a different value, never a silent pass.
 *
 * @throws {ContainmentError} `path_not_contained` for a ref that is too long, holds an invisible character, names
 *   another root, or whose path is absolute, has `..`, a backslash, a link or a component the containment rules
 *   refuse; a root of another purpose, or one that changed; `too_large` from a budget or a file over the size cap.
 */
export function resolveContractRef(
  root: ContainedRoot,
  ref: string,
  opts: { rootName?: string; limits?: Partial<ContractLimits> } = {},
): ResolvedContract | null {
  requirePurpose(root, 'contracts');
  const rootName = opts.rootName ?? DEFAULT_ROOT_NAME;
  checkRootName(rootName);
  const refuse = (rule: string): ContainmentError =>
    new ContainmentError(
      'path_not_contained',
      rule,
      `the reference is refused (${rule})`,
    );
  if (ref.length > MAX_REF || !isVisible(ref))
    throw refuse('ref length or characters');
  if (!ref.startsWith(`${rootName}:`)) throw refuse('root name');
  const rest = ref.slice(rootName.length + 1);
  const hash = rest.indexOf('#');
  if (hash < 0) throw refuse('no pointer');
  const file = rest.slice(0, hash);
  splitRelative(file);
  const limits = { ...CONTRACT_LIMITS, ...opts.limits };
  const got = extractFile(
    {
      root,
      sh: shared(limits),
      bytes: new ByteBudget(limits.maxBytes, 'bytes read'),
      trees: new Map(),
    },
    file,
  );
  if (got.refused?.kind === 'not_found') return null;
  if (got.refused !== undefined)
    throw new ContainmentError(
      got.refused.kind,
      got.refused.rule,
      `the reference is refused (${got.refused.rule})`,
    );
  const fact = got.facts.find((f) => contractRef(f, rootName) === ref);
  if (fact === undefined || got.sha256 === undefined) return null;
  return { fact, value: fact.value, sourceSha256: got.sha256 };
}

/** The SHA-256 of a fact's value as UTF-8 (hex): what `quoteSha256` of a `contract` source reference holds. */
export const valueSha256 = (fact: ContractFact): string =>
  createHash('sha256').update(fact.value).digest('hex');
