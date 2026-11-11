import { realpathSync } from 'node:fs';
import { NAME_PATTERN } from '../foundation/index.js';
import { TrustError } from './errors.js';
import { assertNotInRepository } from './location.js';
import { projectIdentity } from './identity.js';
import type { OwnerKey } from './owner-key.js';
import type { EnvClass, TrustStoreDoc } from './schema.js';
import { createStoreDoc } from './write.js';

/** One env the owner classified at `trust init` or `trust add env`: its origin as shown, and the typed class. */
export interface TrustedEnvAnswer {
  origin: string;
  class: EnvClass;
}

/**
 * What the owner typed at `flowctl trust init` (ADR 0025 section 3, "First use"). Nothing here is copied from
 * the repository config: the config only supplies the candidates the owner was shown.
 */
export interface InitAnswers {
  envs: Record<string, TrustedEnvAnswer>;
  productionOrigins: string[];
  defaultEnv: string;
  language: string;
  locale: string;
}

/** A language code as `trust init` accepts it: two or three lowercase letters. */
export const LANGUAGE_PATTERN = /^[a-z]{2,3}$/;
/** A locale as `trust init` accepts it: `language-REGION`, e.g. `vi-VN`. */
export const LOCALE_PATTERN = /^[a-z]{2,3}-[A-Z]{2}$/;

const invalid = (message: string): TrustError =>
  new TrustError('trust_entry_invalid', message);

/**
 * True when `url` is exactly an `http(s)` origin: scheme, host and optional port, nothing else.
 */
export function isOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === url
    );
  } catch {
    return false;
  }
}

/**
 * Refuses a set of env classes that contradicts itself: two envs on one origin with different classes, or an
 * env on a production origin whose class is not `production` (ADR 0025 section 3).
 *
 * @throws {TrustError} `trust_entry_invalid`.
 */
export function assertEnvsConsistent(
  envs: Record<string, TrustedEnvAnswer>,
  productionOrigins: readonly string[],
): void {
  const byOrigin = new Map<string, string>();
  for (const o of productionOrigins)
    if (!isOrigin(o)) throw invalid(`"${o}" is not an origin.`);
  for (const [name, e] of Object.entries(envs)) {
    if (!NAME_PATTERN.test(name))
      throw invalid(
        `The env name "${name}" must use lowercase letters, digits and dashes.`,
      );
    if (!isOrigin(e.origin))
      throw invalid(
        `The env "${name}" has "${e.origin}", which is not an origin (scheme, host and port only).`,
      );
    const other = byOrigin.get(e.origin);
    if (other !== undefined && envs[other]?.class !== e.class)
      throw invalid(
        `The envs "${other}" and "${name}" share ${e.origin} but have different classes; one origin has one class.`,
      );
    byOrigin.set(e.origin, name);
    if (productionOrigins.includes(e.origin) && e.class !== 'production')
      throw invalid(
        `The env "${name}" is on the production origin ${e.origin}, so its class must be production.`,
      );
  }
}

/**
 * Every check `initTrust` makes before it writes, without writing anything, so the CLI can refuse before it
 * creates the owner key: the project name, the answers, both directories, and a store outside any repository.
 *
 * @throws {TrustError} `trust_entry_invalid` for a bad name, contradicting answers or a missing directory;
 *   `trust_tampered` for a store directory inside a repository; `identity_unverifiable` when the project is not a
 *   git checkout with full history (its root commits are the project identity, ADR 0025 section 1).
 */
export function validateInit(o: {
  storeDir: string;
  project: string;
  projectDir: string;
  flowsDir: string;
  answers: InitAnswers;
}): { root: string; flows: string; identity: string[] } {
  if (!NAME_PATTERN.test(o.project))
    throw invalid(
      `The project name "${o.project}" must use lowercase letters, digits and dashes; rename the directory that holds flowctl.config.yaml.`,
    );
  validate(o.answers);
  assertNotInRepository(o.storeDir);
  const root = realDir(o.projectDir);
  return { root, flows: realDir(o.flowsDir), identity: projectIdentity(root) };
}

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    throw invalid(`The directory ${dir} does not exist; create it first.`);
  }
}

function validate(a: InitAnswers): void {
  assertEnvsConsistent(a.envs, a.productionOrigins);
  const def = Object.hasOwn(a.envs, a.defaultEnv)
    ? a.envs[a.defaultEnv]
    : undefined;
  if (def === undefined)
    throw invalid(
      `The default env "${a.defaultEnv}" is not one of the envs you classified.`,
    );
  if (def.class === 'production')
    throw invalid(
      `The default env "${a.defaultEnv}" is a production env; choose a shared or local env.`,
    );
  if (!LANGUAGE_PATTERN.test(a.language))
    throw invalid(
      `"${a.language}" is not a language code; type two or three lowercase letters, e.g. vi or en.`,
    );
  if (!LOCALE_PATTERN.test(a.locale))
    throw invalid(
      `"${a.locale}" is not a locale; type language-REGION, e.g. vi-VN or en-US.`,
    );
}

/** The stored, owner-signed form of one env entry. */
export function signEnv(
  key: OwnerKey,
  name: string,
  e: TrustedEnvAnswer,
): TrustStoreDoc['envs'][string] {
  const value = {
    origin: e.origin,
    class: e.class,
    visitOrigins: [],
    callOrigins: [],
  };
  return { ...value, sig: key.signEntry({ id: name, kind: 'envs', value }) };
}

/** The stored, owner-signed marker of one production origin. */
export const signProductionOrigin = (
  key: OwnerKey,
  origin: string,
): { sig: string } => ({
  sig: key.signEntry({ id: origin, kind: 'productionOrigins', value: {} }),
});

/**
 * Creates a store for one project (`flowctl trust init`, ADR 0025 section 3): pins the owner key, and writes
 * the project (with `defaultEnv`, `language`, `locale`), its flows directory, the env classes and the
 * production origins, every entry signed by the owner key.
 *
 * @throws {TrustError} `store_exists`, and every refusal of {@link validateInit}.
 */
export function initTrust(o: {
  storeDir: string;
  key: OwnerKey;
  project: string;
  projectDir: string;
  flowsDir: string;
  answers: InitAnswers;
  /** `trust init --anchor-dir`: where the anchor file goes when no keychain answers. */
  anchorDir?: string;
  /** The store a `trust init --replace` replaces, recorded in the new genesis line. */
  replaces?: { fingerprint: string; head: string };
}): void {
  const { root, flows, identity } = validateInit(o);
  const { key, answers: a } = o;
  const project = {
    root,
    identity,
    defaultEnv: a.defaultEnv,
    language: a.language,
    locale: a.locale,
  };
  const flowsRoot = { purpose: 'flows' as const, path: flows };
  const envs: TrustStoreDoc['envs'] = {};
  for (const [name, e] of Object.entries(a.envs))
    envs[name] = signEnv(key, name, e);
  const productionOrigins: TrustStoreDoc['productionOrigins'] = {};
  for (const origin of a.productionOrigins)
    productionOrigins[origin] = signProductionOrigin(key, origin);
  createStoreDoc(
    o.storeDir,
    {
      v: 1,
      markers: [],
      ownerFingerprint: key.fingerprint,
      ownerPublicKey: key.publicKey.toString('base64'),
      projects: {
        [o.project]: {
          ...project,
          sig: key.signEntry({
            id: o.project,
            kind: 'projects',
            value: project,
          }),
        },
      },
      roots: [
        {
          ...flowsRoot,
          sig: key.signEntry({ id: flows, kind: 'roots', value: flowsRoot }),
        },
      ],
      envs,
      profiles: {},
      productionOrigins,
      destructiveConfirm: [],
      reviewerKeys: [],
      flowFloors: {},
      specFloors: {},
      latestRevision: {},
      handWritten: [],
      resolvers: {},
      hooks: {},
    },
    key,
    o.anchorDir,
    o.replaces,
  );
}
