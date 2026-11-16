import { TrustError } from './errors.js';
import type { TrustStore } from './store.js';
import { commitLatestRevision } from './write.js';

/** The largest approval revision (ADR 0020 Amendment 2026-11-02 section j, rule 1). */
export const MAX_REVISION = Number.MAX_SAFE_INTEGER;

/** The key of `flowFloors` and `latestRevision`: `<project>/<flow name>`; both names pass `NAME_PATTERN`, which has no `/`. */
export const revisionKey = (project: string, flowName: string): string =>
  `${project}/${flowName}`;

const tampered = (what: string): TrustError =>
  new TrustError(
    'trust_tampered',
    `The trust store holds ${what}; it was changed outside flowctl.`,
    'revision_value',
  );

function read(
  section: Readonly<Record<string, number>>,
  key: string,
  name: string,
): number | undefined {
  const value = section[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > MAX_REVISION)
    throw tampered(`an invalid ${name} value`);
  return value;
}

/**
 * The floor and the latest revision the store holds for (project, flow name), each `undefined` when absent (ADR 0020
 * Amendment 2026-11-02 section l: an absent source is not 0).
 *
 * @throws {TrustError} `trust_tampered` (`revision_value`) for a value that is not an integer in 1..2^53-1.
 */
export function storedRevisions(
  store: Pick<TrustStore, 'data'>,
  project: string,
  flowName: string,
): { floor?: number; latest?: number } {
  const key = revisionKey(project, flowName);
  const floor = read(store.data.flowFloors, key, 'flowFloors');
  const latest = read(store.data.latestRevision, key, 'latestRevision');
  return {
    ...(floor === undefined ? {} : { floor }),
    ...(latest === undefined ? {} : { latest }),
  };
}

const ciRefusal = (): TrustError =>
  new TrustError(
    'trust_entry_invalid',
    'This trust store is marked ci and is read-only; approvals happen on the owner machine.',
  );

/**
 * Raises `latestRevision` of (project, flow name) to `revision`: the one store value `flowctl review` writes
 * (ADR 0020 Amendment 2026-11-02 section k). It signs nothing, so no key is needed, and it only goes up: a lower
 * value is refused, an equal one changes nothing; lowering is the owner-signed `trust forget`.
 *
 * @remarks The `ci` marker and the stored value are judged again on the store as read under the lock
 *   (`commitLatestRevision`), so a store that became `ci` or was raised meanwhile is seen, and any other change made
 *   meanwhile is kept: only this one value changes. The hash-chained log and the anchor record the write like any
 *   other.
 * @throws {TrustError} `trust_entry_invalid` for a `ci` store (provisioned elsewhere), a revision outside 1..2^53-1
 *   or one below the stored value; `trust_tampered` for an invalid stored value; `store_busy`.
 */
export function raiseLatestRevision(
  store: TrustStore,
  project: string,
  flowName: string,
  revision: number,
): void {
  if (store.isCi) throw ciRefusal();
  if (!Number.isInteger(revision) || revision < 1 || revision > MAX_REVISION)
    throw new TrustError(
      'trust_entry_invalid',
      'A revision is an integer from 1 to 9007199254740991.',
    );
  commitLatestRevision(
    store.dir,
    revisionKey(project, flowName),
    revision,
    (fresh) => {
      if (fresh.isCi) throw ciRefusal();
      const current = storedRevisions(fresh, project, flowName).latest;
      if (current !== undefined && revision < current)
        throw new TrustError(
          'trust_entry_invalid',
          `latestRevision only goes up: the store holds ${current}, not lowered to ${revision}.`,
        );
      return current !== revision;
    },
  );
}
