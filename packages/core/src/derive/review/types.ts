import type { Flow, SourceRef } from '../../flow/index.js';
import type { ReviewerSigner } from '../../trust/index.js';

/**
 * The interactive terminal of a review, injected: the real one reads and writes `/dev/tty` and is built by the CLI
 * (T4.8); a test passes a scripted one. `interactive` is false when there is no terminal, and the review then refuses.
 */
export interface Tty {
  readonly interactive: boolean;
  /** Prints `text` to the terminal. */
  show(text: string): void;
  /** Prints `prompt` and reads one line. */
  ask(prompt: string): Promise<string>;
  /** Prints `prompt` and reads one line with echo off; the answer is never shown, logged or kept. */
  askSecret(prompt: string): Promise<string>;
}

/** What one model-free confirming replay saw: whether it passed, and its redaction-safe summary (ADR 0030) to hash. */
export interface ReplayEvidence {
  passed: boolean;
  summary: unknown;
}

/** Runs the flow model-free, in the review's own process. The real one is built over `replayFlow` by the CLI. */
export interface Replayer {
  replay(flow: Flow): Promise<ReplayEvidence>;
}

/** Re-resolves one `sourceRef` against its source now (ADR 0020 section e); false when it no longer resolves. */
export interface SourceResolver {
  resolve(ref: SourceRef): Promise<boolean>;
}

/**
 * Where the reviewer key comes from, injected. `unlock` takes the passphrase read from the terminal and returns the
 * unlocked signer (the CLI binds `loadReviewerKey(file, passphrase)`); private key bytes never leave the signer.
 */
export interface Signer {
  unlock(passphrase: string): ReviewerSigner;
}

/** The label and unit of a number an assertion checks, signed with its polarity (ADR 0023 amendment 2026-11-12). */
export interface NumberSpec {
  label: string;
  unit: string;
}

/** A baseline the reviewer approves: the value and what the replays and the map showed. */
export interface BaselineInput {
  /** The approved value, as it will be checked. */
  value: string;
  /** Every value the replay evidence and the AppMap showed for the field, collected by the review process. */
  observed: readonly string[];
  /** What the reviewer saw, one short text (it is signed). */
  evidence: string;
}
