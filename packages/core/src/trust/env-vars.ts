import { assertCanWrite } from './admin.js';
import { TrustError } from './errors.js';
import type { OwnerKey } from './owner-key.js';
import { TrustStore } from './store.js';
import { replaceStoreDoc } from './write.js';

/** How a variable may be used: a `secret` (passwords, tokens) or a `username` (ADR 0024 section 4). */
export type EnvVarKind = 'secret' | 'username';

/** One allowlisted environment variable of a profile: its name and kind, never its value. */
export interface EnvVarEntry {
  name: string;
  kind: EnvVarKind;
}

/** A profile as the trust store records it, after its owner signature was verified. */
export interface TrustedProfile {
  loginOrigins: string[];
  envVars: EnvVarEntry[];
}

/**
 * A variable name the allowlist accepts: an exact shell name, no pattern. A bare `*` and every wildcard are
 * therefore refused, and the ADR 0025 section 4 exclusions (`*TOKEN*`, `*KEY*`…) only exclude patterns, so a
 * name written in full is allowed.
 */
export const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * The profile `name` of the store, verified against the owner key on this read.
 *
 * @returns the profile, or `undefined` when the store has no entry for it.
 * @throws {TrustError} `trust_tampered` when the entry is not owner-signed.
 */
export function trustedProfile(
  store: TrustStore,
  name: string,
): TrustedProfile | undefined {
  const all = store.data.profiles;
  const p = Object.hasOwn(all, name) ? all[name] : undefined;
  if (p === undefined) return undefined;
  const { sig, ...value } = p;
  store.assertSigned({ id: name, kind: 'profiles', value }, sig ?? '');
  return value;
}

/**
 * The allowlist entry for variable `name` in `profile`, matched case-insensitively on the whole name (ADR 0025
 * section 4, issue #41).
 *
 * @returns the entry, or `undefined` when the profile does not list the name (the caller refuses).
 * @throws {TrustError} `trust_tampered` when the profile entry is not owner-signed.
 */
export function allowedEnvVar(
  store: TrustStore,
  profile: string,
  name: string,
): EnvVarEntry | undefined {
  const wanted = name.toUpperCase();
  return trustedProfile(store, profile)?.envVars.find(
    (v) => v.name.toUpperCase() === wanted,
  );
}

/**
 * Adds one variable to a profile's allowlist (`flowctl trust add profile`), creating the profile entry when
 * absent, and signs the whole profile entry again with the owner key.
 *
 * @remarks The store is read again after the owner answered, so a change written meanwhile is kept.
 * @throws {TrustError} `trust_entry_invalid` for a `ci` store, a name that is not an exact variable name, or a
 *   name already listed (in any case); `trust_tampered` when the key is not the pinned owner key or the
 *   existing profile entry is not owner-signed.
 */
export function addProfileEnvVar(
  store: TrustStore,
  key: OwnerKey,
  profile: string,
  envVar: EnvVarEntry,
): void {
  if (!ENV_VAR_NAME.test(envVar.name))
    throw new TrustError(
      'trust_entry_invalid',
      `"${envVar.name}" is not an exact environment variable name (letters, digits and _, not starting with a digit; no wildcards).`,
    );
  const fresh = TrustStore.open(store.dir);
  assertCanWrite(fresh, key);
  const current = trustedProfile(fresh, profile) ?? {
    loginOrigins: [],
    envVars: [],
  };
  if (allowedEnvVar(fresh, profile, envVar.name) !== undefined)
    throw new TrustError(
      'trust_entry_invalid',
      `Profile "${profile}" already allows ${envVar.name}; nothing was changed.`,
    );
  const value: TrustedProfile = {
    loginOrigins: current.loginOrigins,
    envVars: [...current.envVars, { name: envVar.name, kind: envVar.kind }],
  };
  replaceStoreDoc(
    fresh.dir,
    {
      ...fresh.data,
      profiles: {
        ...fresh.data.profiles,
        [profile]: {
          ...value,
          sig: key.signEntry({ id: profile, kind: 'profiles', value }),
        },
      },
    },
    key,
  );
}
