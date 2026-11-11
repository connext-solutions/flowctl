import { assertCanWrite } from './admin.js';
import { hostOf, productionOriginFor, trustedEnv } from './envs.js';
import { TrustError } from './errors.js';
import {
  LANGUAGE_PATTERN,
  LOCALE_PATTERN,
  isOrigin,
  signProductionOrigin,
} from './init.js';
import type { OwnerKey } from './owner-key.js';
import { TrustStore } from './store.js';
import { replaceStoreDoc } from './write.js';

const invalid = (message: string): TrustError =>
  new TrustError('trust_entry_invalid', message);

const CI_READ_ONLY =
  'This trust store is marked ci and is read-only; change it on the owner machine and re-provision it.';

/** One per-project setting `trust add default-env`, `language` or `locale` changes. */
export type ProjectSetting =
  | { field: 'defaultEnv'; value: string }
  | { field: 'language'; value: string }
  | { field: 'locale'; value: string };

/**
 * Checks a per-project setting against the store without writing: the project entry is owner-signed, a default env
 * is an owner-classed env that is not `production` (ADR 0024 section 1), a language or locale matches its pattern.
 *
 * @returns the current value, for the confirmation screen (or `undefined` when unset).
 * @throws {TrustError} `trust_entry_invalid` for an unknown project, an env the store does not know, classes
 *   `production` or has on a production host, a bad language or locale, the value already set, or a `ci` store;
 *   `trust_tampered` for an entry that is not owner-signed.
 */
export function checkProjectSetting(
  store: TrustStore,
  project: string,
  s: ProjectSetting,
): string | undefined {
  if (store.isCi) throw invalid(CI_READ_ONLY);
  const all = store.data.projects;
  const p = Object.hasOwn(all, project) ? all[project] : undefined;
  if (p === undefined)
    throw invalid(`The project "${project}" is not in the trust store.`);
  const { sig, ...value } = p;
  store.assertSigned({ id: project, kind: 'projects', value }, sig ?? '');
  if (s.field === 'defaultEnv') {
    const env = trustedEnv(store, s.value);
    if (env === undefined)
      throw invalid(
        `The env "${s.value}" is not classed in the trust store; run flowctl trust add env ${s.value} first.`,
      );
    const prod = productionOriginFor(store, env.origin);
    if (env.class === 'production' || prod !== undefined)
      throw invalid(
        `The env "${s.value}" is ${prod === undefined ? 'a production env' : `on the host of the production origin ${prod}`}; the default env must be shared or local.`,
      );
  }
  if (s.field === 'language' && !LANGUAGE_PATTERN.test(s.value))
    throw invalid(
      `"${s.value}" is not a language code; type two or three lowercase letters, e.g. vi or en.`,
    );
  if (s.field === 'locale' && !LOCALE_PATTERN.test(s.value))
    throw invalid(
      `"${s.value}" is not a locale; type language-REGION, e.g. vi-VN or en-US.`,
    );
  const old = value[s.field];
  if (old === s.value)
    throw invalid(
      `The ${s.field} of ${project} is already ${s.value}; nothing was changed.`,
    );
  return old;
}

/**
 * Sets one per-project setting (`trust add default-env | language | locale`, ADR 0025 section 3) and signs the
 * project entry again with the owner key.
 *
 * @remarks The store is read again after the owner answered and checked again, so a change written meanwhile is
 *   kept and an env reclassed meanwhile is caught.
 * @throws {TrustError} every refusal of {@link checkProjectSetting}; `store_busy`; `trust_tampered` when the key is
 *   not the pinned owner key.
 */
export function setProjectSetting(
  store: TrustStore,
  key: OwnerKey,
  project: string,
  s: ProjectSetting,
): void {
  const fresh = TrustStore.open(store.dir);
  assertCanWrite(fresh, key);
  checkProjectSetting(fresh, project, s);
  const p = fresh.data.projects[project];
  if (p === undefined)
    throw invalid(`The project "${project}" is not in the trust store.`);
  const { sig: _old, ...current } = p;
  const value = { ...current, [s.field]: s.value };
  replaceStoreDoc(
    fresh.dir,
    {
      ...fresh.data,
      projects: {
        ...fresh.data.projects,
        [project]: {
          ...value,
          sig: key.signEntry({ id: project, kind: 'projects', value }),
        },
      },
    },
    key,
  );
}

/**
 * Checks a new production origin against the store without writing: an exact origin whose host no listed production
 * origin covers yet, and no env on that host classed lower than `production`. A production entry covers every scheme
 * and port of its host (ADR 0024 section 2), so an env on another port of the same host would become production
 * without the owner classing it (one origin has one class, ADR 0025 section 3).
 *
 * @throws {TrustError} `trust_entry_invalid` for a value that is not an origin, a host already covered, an env on the
 *   host that is not `production`, or a `ci` store; `trust_tampered` for an entry that is not owner-signed.
 */
export function checkProductionOrigin(store: TrustStore, origin: string): void {
  if (store.isCi) throw invalid(CI_READ_ONLY);
  if (!isOrigin(origin))
    throw invalid(
      `"${origin}" is not an origin: type the scheme, host and port only, e.g. https://erp.example.com.`,
    );
  const covered = productionOriginFor(store, origin);
  if (covered !== undefined)
    throw invalid(
      `${covered} already makes every origin of this host production; nothing was changed.`,
    );
  const host = hostOf(origin);
  for (const name of Object.keys(store.data.envs)) {
    const e = trustedEnv(store, name);
    if (
      e !== undefined &&
      hostOf(e.origin) === host &&
      e.class !== 'production'
    )
      throw invalid(
        `The env "${name}" on ${e.origin} is classed ${e.class}, and a production origin covers every origin of its host. Remove that env from the store first.`,
      );
  }
}

/**
 * Adds a production origin (`trust add production-origin`, ADR 0025 section 3), signed with the owner key. A
 * production origin is guarded on every redirect hop and request (ADR 0024 section 2).
 *
 * @throws {TrustError} every refusal of {@link checkProductionOrigin}; `store_busy`; `trust_tampered` when the key
 *   is not the pinned owner key.
 */
export function addProductionOrigin(
  store: TrustStore,
  key: OwnerKey,
  origin: string,
): void {
  const fresh = TrustStore.open(store.dir);
  assertCanWrite(fresh, key);
  checkProductionOrigin(fresh, origin);
  replaceStoreDoc(
    fresh.dir,
    {
      ...fresh.data,
      productionOrigins: {
        ...fresh.data.productionOrigins,
        [origin]: signProductionOrigin(key, origin),
      },
    },
    key,
  );
}
