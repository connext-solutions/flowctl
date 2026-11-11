import { createHash } from 'node:crypto';
import { z } from 'zod';
import { TrustError } from './errors.js';
import { ZERO } from './log.js';

/**
 * A run id (ADR 0024 amendment 2026-11-12 "destructive ledger details", section 8): `r_` then base 36, at most 32
 * characters after the prefix. It is never a path.
 */
export const RUN_ID_PATTERN = /^r_[0-9a-z]{1,32}$/;

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Seq = z.number().int().min(1);
const Entry = z.string().max(64);

/** One line of a run ledger, without `prev` checked yet (ADR 0025 amendment 2026-11-02 section 4, ADR 0024). */
export const LedgerLineSchema = z.discriminatedUnion('kind', [
  z
    .object({
      v: z.literal(1),
      kind: z.literal('ledger-header'),
      runId: z.string().regex(RUN_ID_PATTERN),
      bundleId: z.string().nullable(),
      prev: Hex64,
    })
    .strict(),
  z
    .object({
      kind: z.literal('intent'),
      seq: Seq,
      entry: Entry,
      name: z.string().max(4096),
      prev: Hex64,
    })
    .strict(),
  z
    .object({
      kind: z.literal('id'),
      seq: Seq,
      entry: Entry,
      id: z.string().max(64),
      prev: Hex64,
    })
    .strict(),
  z
    .object({
      kind: z.literal('none'),
      seq: Seq,
      status: z.number().int(),
      prev: Hex64,
    })
    .strict(),
  z
    .object({
      kind: z.literal('cleanup'),
      seq: Seq,
      entry: Entry,
      id: z.string().max(64),
      result: z.enum(['confirmed', 'leftover']),
      prev: Hex64,
    })
    .strict(),
  z
    .object({
      kind: z.literal('abort'),
      reason: z.string().max(64),
      prev: Hex64,
    })
    .strict(),
]);
export type LedgerLine = z.infer<typeof LedgerLineSchema>;

type WithoutPrev<T> = T extends unknown ? Omit<T, 'prev'> : never;

/** A line to append: everything but `prev`, which the file adds. */
export type NewLedgerLine = WithoutPrev<LedgerLine>;

export const invalid = (detail: string, message: string): TrustError =>
  new TrustError('ledgers_invalid', message, detail);

export const sha = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

/** Parses one line as JSON, or `undefined` when it is not JSON at all. */
function json(r: string): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(r) };
  } catch {
    return undefined;
  }
}

/**
 * Parses and verifies the lines of a ledger file.
 *
 * @remarks A last line without its `\n` that is not JSON is a **torn tail**: an append a crash cut short (each line is
 *   written whole and fsynced, so only the last one can be torn). It is dropped and reported as `torn`, and every line
 *   before it is verified as usual, so one cut write never makes the ids before it unreadable. A last line that is
 *   JSON but breaks the schema or the chain is not torn: that is a change made outside flowctl.
 * @returns the verified lines, the hash of the last one, and whether a torn tail was dropped.
 * @throws {TrustError} `ledgers_invalid` `chain` for a line that does not parse (other than a torn tail), does not
 *   follow the schema or does not carry the hash of the previous line, or a header naming another run; `foreign` for
 *   a missing header or one whose bundle id is not the store's.
 */
export function verifyChain(
  text: string,
  runId: string,
  bundleId: string | null,
  path: string,
): { lines: LedgerLine[]; head: string; torn: boolean } {
  const raw = text.split('\n');
  const terminated = raw.at(-1) === '';
  if (terminated) raw.pop();
  const torn = !terminated && json(raw.at(-1) ?? '') === undefined;
  if (torn) raw.pop();
  let prev = ZERO;
  const lines: LedgerLine[] = [];
  for (const [i, r] of raw.entries()) {
    const j = json(r);
    const parsed =
      j === undefined ? undefined : LedgerLineSchema.safeParse(j.value);
    if (parsed?.success !== true || parsed.data.prev !== prev)
      throw invalid(
        'chain',
        `Line ${i} of ${path} is broken; the ledger was changed outside flowctl.`,
      );
    if (i === 0 && parsed.data.kind !== 'ledger-header')
      throw invalid('foreign', foreignHint(path, runId));
    if (i > 0 && parsed.data.kind === 'ledger-header')
      throw invalid('chain', `Line ${i} of ${path} is a second header.`);
    lines.push(parsed.data);
    prev = sha(r);
  }
  const header = lines[0];
  if (header?.kind !== 'ledger-header')
    throw invalid('foreign', foreignHint(path, runId));
  if (header.runId !== runId)
    throw invalid('chain', `${path} is the ledger of another run.`);
  if (header.bundleId !== bundleId)
    throw invalid('foreign', foreignHint(path, runId));
  return { lines, head: prev, torn };
}

const foreignHint = (path: string, runId: string): string =>
  `${path} was not written for this trust store (another bundle, or no header). Its ids are leftover records: clean them on the environment by hand, then delete ledgers/${runId}.jsonl yourself and retry.`;
