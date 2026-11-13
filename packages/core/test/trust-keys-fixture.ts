import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fixtureConfig } from './helpers.js';

/** A config whose flows directory exists, for a test store. */
export const cfg = () => {
  const c = fixtureConfig('http://127.0.0.1:1');
  mkdirSync(c.flowsPath, { recursive: true });
  return c;
};

/** The raw 32 bytes of a fresh Ed25519 public key. */
export const newPublicKey = (): Buffer => {
  const der = generateKeyPairSync('ed25519').publicKey.export({
    format: 'der',
    type: 'spki',
  });
  return Buffer.from(der.subarray(der.length - 32));
};

/** A fixed clock for entries. */
export const NOW = new Date('2026-01-01T00:00:00.000Z');
/** A valid key request: 30 days for the `flows` scope. */
export const REQ = {
  person: 'Alice Nguyen',
  scope: 'flows' as const,
  days: 30,
};
/** One day in milliseconds. */
export const DAY = 86_400_000;
