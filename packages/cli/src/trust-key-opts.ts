import {
  type DeclaredCustody,
  type ReviewerKey,
  type ReviewerKeyRequest,
  TrustError,
  validateCustody,
  validateKeyRequest,
} from '@flowctl/core';
import type { Values } from './argv.js';

const required = (name: string, value: string | undefined): string => {
  if (value === undefined)
    throw new TrustError(
      'trust_entry_invalid',
      `--${name} is required for this command.`,
    );
  return value;
};

/**
 * The person, scope and expiry the owner typed for `trust key new|add`, checked before any prompt. `--expires` is a
 * whole number of days, 1 to 365, and has no default.
 *
 * @throws {TrustError} `trust_entry_invalid` for a missing or refused option.
 */
export const keyRequest = (values: Values): ReviewerKeyRequest =>
  validateKeyRequest({
    person: required('person', values.person),
    scope: required('scope', values.scope),
    expires: required('expires', values.expires),
  });

/**
 * The `--custody` the owner declared for `trust key add`: `hardware` or `file` (an encrypted key file), returned as
 * the `declared-*` value the store records. It is an owner declaration; flowctl cannot check the claim.
 *
 * @throws {TrustError} `trust_entry_invalid` when missing or neither value.
 */
export const keyCustody = (values: Values): DeclaredCustody =>
  validateCustody(required('custody', values.custody));

const custodyText = (custody: ReviewerKey['custody']): string =>
  custody.startsWith('declared-')
    ? `${custody} (declared by owner, not verified)`
    : custody;

/** The lines of a confirmation screen that describe a key: who, what it may approve, until when. */
export const keyLines = (
  k: Pick<ReviewerKey, 'person' | 'scope' | 'custody'> & { expires: string },
): string =>
  `Person:    ${k.person}\nScope:     ${k.scope}\nExpires:   ${k.expires}\nCustody:   ${custodyText(k.custody)}\n`;
