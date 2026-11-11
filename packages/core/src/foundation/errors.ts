/** The infrastructure failure kinds a caller must handle; the verdict `failed` is never one of them. */
export type ErrorKind =
  | 'app_unreachable'
  | 'profile_expired'
  | 'setup_failed'
  | 'flow_invalid'
  | 'system1_unreachable'
  | 'system1_not_allowed'
  | 'hooks_untrusted'
  | 'env_not_allowed'
  | 'env_not_trusted'
  | 'scope_violation'
  | 'destructive_blocked'
  | 'ledger_replay'
  | 'ledger_mismatch'
  | 'ledger_overflow'
  | 'ledger_exists'
  | 'budget_exceeded'
  | 'internal';

/** Thrown for a bad flow file, flow name or template. */
export class FlowError extends Error {}

/** A run-level failure that is not the app's fault (unreachable app, expired session, failed setup). */
export class RunError extends Error {
  constructor(
    readonly kind: ErrorKind,
    readonly hint: string,
  ) {
    super(hint);
  }
}

export type StepErrorKind = 'not_found' | 'ambiguous' | 'action_failed';

/** A step that could not run: its target was not found, was ambiguous, or the action failed. */
export class StepError extends Error {
  constructor(
    readonly kind: StepErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Marks a branch the type system proves unreachable; reaching it at runtime means a value bypassed its
 * schema, so it is an `internal` error rather than a silent default.
 *
 * @throws {RunError} `internal`, always.
 */
export function assertNever(value: never, what: string): never {
  throw new RunError(
    'internal',
    `Unexpected ${what}: ${JSON.stringify(value)}`,
  );
}
