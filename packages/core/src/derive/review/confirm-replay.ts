import type { Flow } from '../../flow/index.js';
import { ApprovalError, evidenceHash } from '../../provenance/index.js';
import type { Replayer, SourceResolver } from './types.js';

/**
 * Re-resolves every `sourceRef` of `flow` in this process (ADR 0020 section f: the review does not trust the
 * generator's evidence).
 *
 * @throws {ApprovalError} `source_unresolved` for the first assertion whose reference no longer resolves (the message
 *   names its number, never its quote).
 */
export async function resolveSources(
  flow: Flow,
  resolver: SourceResolver,
): Promise<void> {
  for (const [i, a] of flow.assertions.entries()) {
    if (a.sourceRef === undefined) continue;
    if (!(await resolver.resolve(a.sourceRef)))
      throw new ApprovalError(
        'source_unresolved',
        `The sourceRef of assertion ${i + 1} no longer resolves against its source.`,
      );
  }
}

/** The fewest confirming replays: two, so one flaky pass does not sign (ADR 0042 section 5). */
export const MIN_REPLAYS = 2;
/** The most confirming replays: the record holds at most 8 replay hashes. */
export const MAX_REPLAYS = 8;

/**
 * The number of confirming replays to run: `requested`, two when absent.
 *
 * @throws {ApprovalError} `replay_count_invalid` for anything but an integer from 2 to 8.
 */
export function replayCount(requested: number | undefined): number {
  const n = requested ?? MIN_REPLAYS;
  if (!Number.isInteger(n) || n < MIN_REPLAYS || n > MAX_REPLAYS)
    throw new ApprovalError(
      'replay_count_invalid',
      `An approval runs from ${MIN_REPLAYS} to ${MAX_REPLAYS} confirming replays.`,
    );
  return n;
}

/** What the confirming replays gave: the hash of each summary, and every value the baseline's target showed. */
export interface ReplayProof {
  hashes: string[];
  seen: string[];
}

/**
 * Runs `count` model-free confirming replays and returns the sha256 of each redaction-safe summary, computed here
 * (the generator supplies no hash), with the values each replay reported for the baseline's target.
 *
 * @throws {ApprovalError} `replay_failed` for the first replay that does not pass; `payload_invalid` for a summary
 *   with no canonical JSON form.
 */
export async function confirmReplays(
  flow: Flow,
  replayer: Replayer,
  count: number,
): Promise<ReplayProof> {
  const hashes: string[] = [];
  const seen: string[] = [];
  for (let n = 1; n <= count; n++) {
    const evidence = await replayer.replay(flow);
    if (!evidence.passed)
      throw new ApprovalError(
        'replay_failed',
        `Confirming replay ${n} of ${count} did not pass; nothing was signed.`,
      );
    try {
      hashes.push(evidenceHash(evidence.summary));
    } catch {
      throw new ApprovalError(
        'payload_invalid',
        'A replay summary has no canonical JSON form.',
      );
    }
    seen.push(...(evidence.baselineSeen ?? []));
  }
  return { hashes, seen };
}
