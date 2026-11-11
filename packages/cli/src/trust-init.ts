import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import {
  assertNoStore,
  createOwnerKey,
  defaultKeyDir,
  defaultStoreDir,
  displayText,
  ENV_CLASSES,
  type EnvClass,
  type InitAnswers,
  initTrust,
  LANGUAGE_PATTERN,
  type LoadedConfig,
  LOCALE_PATTERN,
  TrustError,
  validateInit,
} from '@flowctl/core';
import { confirmNonce, openTty, type Tty } from './trust-tty.js';

/** An env of the repository config, shown to the owner as a candidate only. */
export interface EnvCandidate {
  name: string;
  origin: string;
}

const TRIES = 3;

const isClass = (s: string): s is EnvClass => ENV_CLASSES.some((c) => c === s);

/** The envs of `cfg` with the origin of each `baseUrl`, sorted by name. */
export const envCandidates = (cfg: LoadedConfig): EnvCandidate[] =>
  Object.entries(cfg.envs)
    .map(([name, e]) => ({ name, origin: new URL(e.baseUrl).origin }))
    .sort((a, b) => a.name.localeCompare(b.name));

/**
 * The class the owner types for one env. There is no default: an empty answer leaves the env out, and so
 * does a fourth wrong answer (ADR 0025 section 3, "First use").
 */
export function askEnvClass(tty: Tty, env: EnvCandidate): EnvClass | undefined {
  for (let i = 0; i < TRIES; i++) {
    const a = tty
      .ask(
        `Class of env "${env.name}" (${env.origin}): type production, shared or local (empty = leave it out): `,
      )
      .trim();
    if (a === '') return undefined;
    if (isClass(a)) return a;
    tty.write(`  "${displayText(a)}" is not a class.\n`);
  }
  tty.write(`  env "${env.name}" left out.\n`);
  return undefined;
}

function askValid(
  tty: Tty,
  prompt: string,
  ok: (s: string) => boolean,
): string | undefined {
  for (let i = 0; i < TRIES; i++) {
    const a = tty.ask(prompt).trim();
    if (ok(a)) return a;
    tty.write(`  "${displayText(a)}" is not accepted.\n`);
  }
  return undefined;
}

function askProductionOrigins(
  tty: Tty,
  candidates: EnvCandidate[],
  envs: InitAnswers['envs'],
): string[] {
  const listed = [...new Set(candidates.map((c) => c.origin))];
  tty.write(
    `\nOrigins in the config:\n${listed.map((o) => `  ${o}`).join('\n')}\nAn origin is production only if you type it back exactly.\n`,
  );
  const typed: string[] = [];
  for (let i = 0; i < listed.length + TRIES; i++) {
    const a = tty
      .ask('Production origin (empty when there are no more): ')
      .trim();
    if (a === '') break;
    const clash = Object.entries(envs).find(
      ([, e]) => e.origin === a && e.class !== 'production',
    );
    if (!listed.includes(a))
      tty.write(`  "${displayText(a)}" is not one of the listed origins.\n`);
    else if (clash !== undefined)
      tty.write(
        `  env "${clash[0]}" on ${a} is classed ${clash[1].class}; an origin with a non-production env cannot be production.\n`,
      );
    else if (!typed.includes(a)) typed.push(a);
  }
  return typed;
}

const refuse = (message: string): TrustError =>
  new TrustError('trust_entry_invalid', `${message} Nothing was changed.`);

/**
 * The `trust init` interview (ADR 0025 section 3, "First use"): the config's envs and origins are shown as
 * candidates; the owner types each env's class, the production origins, the default env, the language and
 * the locale. Nothing is taken from the config without being typed.
 *
 * @throws {TrustError} `trust_entry_invalid` when no default env, language or locale was accepted.
 */
export function askInitAnswers(
  tty: Tty,
  candidates: EnvCandidate[],
): InitAnswers {
  const envs: InitAnswers['envs'] = {};
  for (const c of candidates) {
    const cls = askEnvClass(tty, c);
    if (cls !== undefined) envs[c.name] = { origin: c.origin, class: cls };
  }
  const productionOrigins = askProductionOrigins(tty, candidates, envs);
  const usable = Object.keys(envs).filter(
    (n) => envs[n]?.class !== 'production',
  );
  if (usable.length === 0)
    throw refuse(
      'No env was classed shared or local, so the project has no default env.',
    );
  const defaultEnv = askValid(
    tty,
    `Default env (${usable.join(', ')}): `,
    (a) => usable.includes(a),
  );
  if (defaultEnv === undefined) throw refuse('No default env was accepted.');
  const language = askValid(tty, 'Project language (e.g. vi, en): ', (a) =>
    LANGUAGE_PATTERN.test(a),
  );
  if (language === undefined) throw refuse('No language was accepted.');
  const locale = askValid(tty, 'Project locale (e.g. vi-VN, en-US): ', (a) =>
    LOCALE_PATTERN.test(a),
  );
  if (locale === undefined) throw refuse('No locale was accepted.');
  return { envs, productionOrigins, defaultEnv, language, locale };
}

/** The confirmation screen of `trust init`: every value the store will hold. */
export function describeAnswers(a: InitAnswers): string {
  const envs = Object.entries(a.envs).map(
    ([n, e]) => `  env ${n}: ${e.origin} ${e.class}`,
  );
  return [
    '\nThe trust store will hold:',
    ...(envs.length === 0 ? ['  no envs'] : envs),
    `  production origins: ${a.productionOrigins.length === 0 ? '(none)' : a.productionOrigins.join(', ')}`,
    `  default env: ${a.defaultEnv}`,
    `  language: ${a.language}, locale: ${a.locale}`,
    '',
  ].join('\n');
}

/** The project name `trust init` registers: the config directory's name, lowercased to the name pattern. */
export const projectName = (root: string): string =>
  basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * `flowctl trust init`: asks the owner for the env classes and project settings, then creates the owner key
 * (passphrase twice, on `/dev/tty`) and a store registering this project. Interactive only.
 *
 * @throws {TrustError} `anchor_unavailable` with no keychain and no `--anchor-dir`; `trust_tampered` for an
 *   `--anchor-dir` inside a repository; `tty_required`, `store_exists`, `key_exists`, `passphrase_too_short`,
 *   `confirmation_mismatch`, `trust_entry_invalid`.
 */
export function trustInit(
  cfg: LoadedConfig,
  out: (s: string) => void,
  anchorDir?: string,
): void {
  const tty = openTty();
  try {
    const storeDir = defaultStoreDir();
    assertNoStore(storeDir);
    if (existsSync(defaultKeyDir()))
      throw new TrustError(
        'key_exists',
        `An owner key already exists in ${defaultKeyDir()} but there is no store. Remove that directory by hand, then run flowctl trust init again.`,
      );
    const project = projectName(cfg.root);
    tty.write(
      displayText(
        `Trust store:     ${storeDir}\nOwner key:       ${defaultKeyDir()}\nProject:         ${project} (${cfg.root})\nFlows directory: ${cfg.flowsPath}\n\n`,
      ),
    );
    const answers = askInitAnswers(tty, envCandidates(cfg));
    const target = {
      storeDir,
      project,
      projectDir: cfg.root,
      flowsDir: cfg.flowsPath,
      answers,
    };
    validateInit(target);
    tty.write(describeAnswers(answers));
    confirmNonce(tty, 'create the trust store and register this project');
    const pass = tty.ask('New owner-key passphrase (16+ characters): ', {
      echo: false,
    });
    if (tty.ask('Repeat the passphrase: ', { echo: false }) !== pass)
      throw new TrustError(
        'confirmation_mismatch',
        'The passphrases differ; nothing was changed.',
      );
    const key = createOwnerKey(defaultKeyDir(), pass);
    initTrust({ ...target, key, anchorDir });
    out(
      `created trust store ${storeDir}\nowner key fingerprint ${key.fingerprint}\n`,
    );
  } finally {
    tty.close();
  }
}
