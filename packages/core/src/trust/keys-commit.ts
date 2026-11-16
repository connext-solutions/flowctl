import { reviewerKeyId } from './keys-schema.js';
import { TrustStore } from './store.js';

/**
 * Whether the store now holds an entry for `publicKey`, or cannot be read to say. A failure after the owner-signed
 * write (for example the anchor update) leaves the entry committed, so the key files must stay: removing them would
 * orphan a registered key. When unsure the files are kept; an unregistered sealed key file is harmless.
 */
export function entryCommitted(store: TrustStore, publicKey: Buffer): boolean {
  const id = reviewerKeyId(publicKey);
  try {
    return TrustStore.open(store.dir).data.reviewerKeys.some(
      (e) =>
        typeof e === 'object' &&
        e !== null &&
        'kind' in e &&
        'id' in e &&
        e.kind === 'key' &&
        e.id === id,
    );
  } catch {
    return true;
  }
}
