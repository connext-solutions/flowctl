import { TrustError, type TrustStore } from '@flowctl/core';
import type { Runnable } from './argv.js';

/** What {@link openFor} returns for a store left between the steps of an owner-key rotation. */
export const MID_ROTATION = Symbol('mid-rotation');

/**
 * The store a guarded command checks. `trust key rotate-owner` is how a store left between the steps of a rotation is
 * finished or rolled back, so for it alone `rotate_incomplete` means "a store exists" and the handler recovers it.
 *
 * @throws {TrustError} whatever opening the store throws, `rotate_incomplete` for every other command.
 */
export function openFor(
  name: Runnable,
  deps: { openStore: () => TrustStore | undefined },
): TrustStore | undefined | typeof MID_ROTATION {
  try {
    return deps.openStore();
  } catch (e) {
    if (
      name === 'trust key rotate-owner' &&
      e instanceof TrustError &&
      e.kind === 'rotate_incomplete'
    )
      return MID_ROTATION;
    throw e;
  }
}
