/**
 * The leave-request rules that client and server share (T2.9): the server checks a body with {@link validateLeaveRequest},
 * and the requests page receives {@link LEAVE_REQUEST_RULES} as JSON and checks the same values before it submits.
 * `contracts/openapi.yaml` and the `maxlength` attribute of the reason field repeat the numbers, and the message keys
 * name entries of `contracts/i18n/vi.json`, so contract readers (T4.10) can compare them by static parsing.
 *
 * @remarks `type` is not checked on the server: the `wrongBody` seeded bug sends `OT`, and the flow must catch it by
 *   its `network` requestBody assertion, not by a 400 that aborts a step. The OpenAPI file still declares `LEAVE`
 *   only, which is the contract the client breaks.
 */
export const LEAVE_REQUEST_RULES = {
  reason: {
    required: true,
    maxLength: 200,
    requiredKey: 'request.reason.required',
    maxLengthKey: 'request.reason.tooLong',
  },
  amount: { min: 0, max: 1_000_000_000, key: 'request.amount.invalid' },
} as const;

/** A failed rule: the field and the i18n key of its message. */
export interface RuleFailure {
  field: 'reason' | 'amount';
  key: string;
}

/**
 * The first rule `body` breaks, or `undefined` when it passes.
 *
 * @example validateLeaveRequest(new Map([['reason', '']])) // { field: 'reason', key: 'request.reason.required' }
 */
export function validateLeaveRequest(
  body: ReadonlyMap<string, unknown>,
): RuleFailure | undefined {
  const r = LEAVE_REQUEST_RULES.reason;
  const reason = body.get('reason');
  if (typeof reason !== 'string' || reason === '')
    return { field: 'reason', key: r.requiredKey };
  if ([...reason].length > r.maxLength)
    return { field: 'reason', key: r.maxLengthKey };
  const a = LEAVE_REQUEST_RULES.amount;
  const amount = Number(body.get('amount') ?? 0);
  if (!Number.isInteger(amount) || amount < a.min || amount > a.max)
    return { field: 'amount', key: a.key };
  return undefined;
}
