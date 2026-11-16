/** Why an approval or a review step was refused (ADR 0020 Amendment 2026-11-02 sections j and k). */
export type ApprovalErrorCode =
  | 'review_refused_on_ci_store'
  | 'flow_not_on_disk'
  | 'flow_name_mismatch'
  | 'source_unresolved'
  | 'replay_count_invalid'
  | 'replay_failed'
  | 'baseline_required'
  | 'baseline_unsupported'
  | 'baseline_mismatch'
  | 'baseline_pre_approved'
  | 'reviewer_key_invalid'
  | 'revision_overflow'
  | 'approvals_unreadable'
  | 'approvals_too_large'
  | 'approvals_changed'
  | 'screen_truncated'
  | 'payload_invalid'
  | 'latest_revision_unrecorded';

/**
 * A refusal of the approval path. The message never holds a passphrase, key bytes or the text of a spec; a
 * refusal that a trust-store kind already names (`trust_missing`, `tty_required`, `confirmation_mismatch`) is a
 * `TrustError` instead.
 */
export class ApprovalError extends Error {
  override readonly name = 'ApprovalError';
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message);
  }
}
