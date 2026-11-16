import { basename, dirname, join } from 'node:path';
import {
  NoFollowReadError,
  readFileNoFollow,
  writeFileNoFollow,
} from '../foundation/index.js';
import { ApprovalError } from './errors.js';

/** The most records a `<flow>.approvals.json` holds (ADR 0020 Amendment 2026-11-02 section j, rule 3). */
export const MAX_RECORDS = 256;
/** The largest approvals file read: 256 records of at most a few KiB each. */
export const MAX_APPROVALS_BYTES = 1024 * 1024;

/** `<dir>/<stem>.approvals.json` for the flow file `<dir>/<stem>.yaml` (or `.yml`). */
export const approvalsPath = (flowFile: string): string =>
  join(
    dirname(flowFile),
    `${basename(flowFile).replace(/\.ya?ml$/i, '')}.approvals.json`,
  );

/** What a read of an approvals file found. */
export interface ApprovalsRead {
  /** The array elements, unparsed; empty when the file is absent or unusable. */
  records: unknown[];
  /** More than {@link MAX_RECORDS}: the verifier reads none of them; `review --prune` repairs it. */
  tooLarge: boolean;
  /** Reason codes: `approvals_unreadable`, `approvals_malformed`, `approvals_too_large`. */
  notes: string[];
}

const unusable = (note: string): ApprovalsRead => ({
  records: [],
  tooLarge: false,
  notes: [note],
});

/**
 * Reads `<flow>.approvals.json` without following a symlink, at most 1 MiB. An absent file is no records; a file that
 * is not a JSON array, is too big or cannot be read is no records with a note, never an exception: the flow is then
 * `unverified`, and a pull request cannot make a replay fail by padding or breaking the file.
 */
export function readApprovals(flowFile: string): ApprovalsRead {
  let raw: string;
  try {
    raw = readFileNoFollow(approvalsPath(flowFile), MAX_APPROVALS_BYTES);
  } catch (e) {
    if (e instanceof NoFollowReadError && e.message === 'ENOENT')
      return { records: [], tooLarge: false, notes: [] };
    return unusable('approvals_unreadable');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unusable('approvals_malformed');
  }
  if (!Array.isArray(parsed)) return unusable('approvals_malformed');
  if (parsed.length > MAX_RECORDS)
    return { records: parsed, tooLarge: true, notes: ['approvals_too_large'] };
  return { records: parsed, tooLarge: false, notes: [] };
}

/**
 * Writes the records as the approvals file, replacing it atomically (a symlink at the path is replaced, never
 * followed).
 *
 * @throws {ApprovalError} `approvals_too_large` for more than {@link MAX_RECORDS} records.
 */
export function writeApprovals(
  flowFile: string,
  records: readonly unknown[],
): void {
  if (records.length > MAX_RECORDS)
    throw new ApprovalError(
      'approvals_too_large',
      `An approvals file holds at most ${MAX_RECORDS} records; run review --prune.`,
    );
  writeFileNoFollow(
    approvalsPath(flowFile),
    `${JSON.stringify(records, null, 2)}\n`,
    0o644,
  );
}

const field = (record: unknown, name: string): unknown =>
  typeof record === 'object' && record !== null
    ? Reflect.get(record, name)
    : undefined;

/**
 * `records` with `record` added; an older record of the same key for the same (project, flow name, content hash)
 * is replaced, so approving twice leaves one record of that key (Amendment 2026-11-02 section j, rule 3).
 */
export function upsertRecord(
  records: readonly unknown[],
  record: {
    keyId: string;
    project: string;
    flowName: string;
    flowHash: string;
  },
): unknown[] {
  const same = (r: unknown): boolean =>
    (['keyId', 'project', 'flowName', 'flowHash'] as const).every(
      (k) => field(r, k) === record[k],
    );
  return [...records.filter((r) => !same(r)), record];
}
