/**
 * Contract readers (T4.10): static reads of the contracts already in the code under test, below a root of purpose
 * `contracts`: OpenAPI documents, zod and Joi schemas, HTML form attributes and i18n message catalogues. They turn
 * files into {@link ContractFact}s and the facts into {@link ConsistencyCheck}s (client against server, message
 * against catalogue, response against schema). Nothing here evaluates, imports or runs what it reads, follows a
 * reference out of the root, or produces a verdict, flow or assertion.
 *
 * @remarks Hand-off for T4.3 (the assertion builder): `readContracts(root, { rootName })` gives the facts;
 *   a `contract` source reference is `{ kind: 'contract', ref: contractRef(fact, rootName), quoteSha256:
 *   valueSha256(fact) }`; at save and at `flowctl check` the same ref goes through `resolveContractRef(root, ref)`, and
 *   a `null` or a different value is a stale reference. A fact has no integer revision; `sourceSha256` of the
 *   resolution is the revision a caller may store.
 * @see docs/adr/0040-contract-readers.md
 * @see docs/adr/0020-assertion-provenance.md
 */
export { checkConsistency } from './consistency.js';
export { readContracts } from './read.js';
export {
  contractRef,
  DEFAULT_ROOT_NAME,
  resolveContractRef,
  type ResolvedContract,
  valueSha256,
} from './ref.js';
export {
  type CheckKind,
  type CheckOutcome,
  type ConsistencyCheck,
  CONTRACT_LIMITS,
  type ContractFact,
  type ContractLimits,
  type ContractOptions,
  type ContractReport,
  type ContractRule,
  type ContractSide,
  type ContractSource,
  DEFAULT_SIDES,
  type SkippedContract,
} from './types.js';
