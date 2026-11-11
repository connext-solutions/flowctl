/**
 * Trust-refusal kinds (ADR 0025 section 8). The CLI maps them to exit codes: `passphrase_too_short` is a
 * usage error (exit 2), every other kind is a trust refusal (exit 3). So far the read + validate path and
 * the owner key are covered; the anchor, bundle and ledger kinds arrive with their chunks.
 *
 * @remarks `key_exists`, `key_missing`, `key_write_failed`, `key_unlock_failed`, `key_params_unsupported` and
 *   `store_busy` (another flowctl command holds the store lock or changed the store meanwhile) are not in the ADR
 *   0025 section 8 table yet; they are flagged for the owner. `anchor_unavailable`, `rotate_unverified`,
 *   `rotate_incomplete`, `replace_unverified` and `store_replaced` are in that table (Amendment 2026-11-02 section 8).
 */
export type TrustErrorKind =
  | 'trust_missing'
  | 'trust_tampered'
  | 'store_writable_in_ci'
  | 'store_unreadable'
  | 'project_not_trusted'
  | 'identity_unverifiable'
  | 'platform_unsupported'
  | 'trust_entry_invalid'
  | 'passphrase_too_short'
  | 'key_exists'
  | 'key_missing'
  | 'key_write_failed'
  | 'key_params_weak'
  | 'key_params_unsupported'
  | 'key_unlock_failed'
  | 'store_exists'
  | 'tty_required'
  | 'confirmation_mismatch'
  | 'store_busy'
  | 'anchor_unavailable'
  | 'rotate_unverified'
  | 'rotate_incomplete'
  | 'replace_unverified'
  | 'store_replaced'
  | 'ledgers_invalid';

/**
 * A refusal from the trust store: a missing, tampered, wrongly-owned or invalid store, or a checkout
 * whose identity does not match a trusted project.
 *
 * @remarks `detail` names the specific sub-reason where the ADR defines a ladder (e.g.
 *   `store_writable_in_ci` → `owner_is_euid`); it is omitted when the kind is self-explanatory.
 * @see docs/adr/0025-trust-store.md
 */
export class TrustError extends Error {
  constructor(
    readonly kind: TrustErrorKind,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}
