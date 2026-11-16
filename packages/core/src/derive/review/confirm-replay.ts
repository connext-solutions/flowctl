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

/**
 * Runs `count` model-free confirming replays and returns the sha256 of each redaction-safe summary, computed here:
 * the generator supplies no hash.
 *
 * @throws {ApprovalError} `replay_failed` for the first replay that does not pass; `payload_invalid` for a summary
 *   with no canonical JSON form.
 */
export async function confirmReplays(
  flow: Flow,
  replayer: Replayer,
  count: number,
): Promise<string[]> {
  const hashes: string[] = [];
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
  }
  return hashes;
}
