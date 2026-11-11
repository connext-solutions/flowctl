import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { TargetSchema } from './config/index.js';

export const CONFIG_FILE = 'flowctl.config.yaml';

export { NAME_PATTERN } from './foundation/index.js';
import { NAME_PATTERN } from './foundation/index.js';
const NameSchema = z
  .string()
  .regex(NAME_PATTERN, 'use lowercase letters, digits and dashes');

const EnvSchema = z
  .object({
    baseUrl: z.url(),
    loginUrl: z.string().optional(),
    vars: z.record(z.string(), z.string()).default({}),
  })
  .strict();

const ProfileSchema = z
  .object({ locale: z.string().default('vi-VN') })
  .strict();

const hasNoCredentials = (value: string): boolean => {
  try {
    const u = new URL(value);
    return u.username === '' && u.password === '';
  } catch {
    return false;
  }
};

const System1Schema = z
  .object({
    baseUrl: z
      .url()
      .refine(
        hasNoCredentials,
        'put no user or password in the URL; the key comes from apiKeyEnv',
      ),
    apiKeyEnv: z.string().default('TYPESAFE_API_KEY'),
    model: z.string().default('jev-latest'),
    confidenceThreshold: z.number().min(0).max(1).default(0.5),
    allowedEnvs: z.array(z.string()).default(['local', 'staging']),
  })
  .strict();

export const ConfigSchema = z
  .object({
    flowsDir: z.string().default('.flows'),
    testIdAttribute: z
      .string()
      .regex(
        /^[A-Za-z][A-Za-z0-9_-]*$/,
        'use an attribute name: a letter, then letters, digits, _ or -',
      )
      .default('data-testid'),
    maxSteps: z.number().int().positive().default(25),
    runsRetention: z.number().int().positive().default(20),
    assertTimeout: z.number().int().positive().default(10_000),
    stepTimeout: z.number().int().positive().default(5_000),
    navigationTimeout: z.number().int().positive().default(30_000),
    hookTimeout: z.number().int().positive().default(120_000),
    snapshotIgnore: z.array(z.string()).default([]),
    system1: System1Schema.optional(),
    target: TargetSchema.default(TargetSchema.parse({})),
    defaultEnv: z.string(),
    envs: z.record(NameSchema, EnvSchema),
    profiles: z.record(NameSchema, ProfileSchema),
  })
  .strict()
  .refine((c) => Object.hasOwn(c.envs, c.defaultEnv), {
    message: 'defaultEnv must be one of the keys of envs',
    path: ['defaultEnv'],
  });

export type Config = z.infer<typeof ConfigSchema>;

/**
 * What the trust store refused in a config, set by the effective configuration (ADR 0024 section 1): the envs that
 * may not run, with why, why there is no default env when there is none, and why System 1 is off when it is.
 */
export interface TrustView {
  refused: Record<string, string>;
  noDefault?: string;
  /** Why System 1 may not be used at all: its endpoint or key variable is outside the store's `system1` section. */
  system1Refused?: string;
  /**
   * Per trusted env, the origins a run may visit and call: the repo `target.scope` lists intersected with the env
   * origin plus the store's `visitOrigins` and `callOrigins` (ADR 0024 sections 1 and 3). Read by the scope guard
   * (T1.2); an empty set means nothing may be reached, never "anything".
   */
  scopes?: Record<string, { visit: string[]; call: string[] }>;
}

/** Parsed config plus where it lives: `root` is the config file's directory, `flowsPath` the absolute flowsDir. */
export interface LoadedConfig extends Config {
  root: string;
  flowsPath: string;
  /** Set once the config was intersected with the trust store; absent for a config read on its own. */
  trustView?: TrustView;
}

export interface ResolvedEnv {
  name: string;
  baseUrl: string;
  loginUrl?: string;
  /** Values for `{{env.NAME}}` in flows, e.g. an org path that differs per env. */
  vars: Record<string, string>;
}

export { ConfigError } from './foundation/index.js';
import { ConfigError, RunError } from './foundation/index.js';

export function parseConfig(raw: unknown, root: string): LoadedConfig {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success)
    throw new ConfigError(
      `Invalid ${CONFIG_FILE}:\n${z.prettifyError(result.error)}`,
    );
  return {
    ...result.data,
    root,
    flowsPath: resolve(root, result.data.flowsDir),
  };
}

/** Walks up from `startDir` to the filesystem root looking for flowctl.config.yaml. */
export function findConfig(startDir: string): string | undefined {
  for (let dir = resolve(startDir); ; dir = dirname(dir)) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

export function loadConfig(path?: string, cwd = process.cwd()): LoadedConfig {
  const file = path === undefined ? findConfig(cwd) : resolve(cwd, path);
  if (file === undefined || !existsSync(file)) {
    throw new ConfigError(
      `No ${CONFIG_FILE} found (searched upward from ${cwd}); pass --config <path>`,
    );
  }
  return parseConfig(parse(readFileSync(file, 'utf8')), dirname(file));
}

/**
 * The env a command runs in: `env`, or the default env.
 *
 * @throws {ConfigError} for an env the config does not name.
 * @throws {RunError} `env_not_trusted` for an env the trust store refused (ADR 0024 section 2), or for no `env`
 *   when there is no trusted default.
 */
export function resolveEnv(cfg: LoadedConfig, env?: string): ResolvedEnv {
  const view = cfg.trustView;
  if (env === undefined && view?.noDefault !== undefined)
    throw new RunError('env_not_trusted', view.noDefault);
  const name = env ?? cfg.defaultEnv;
  const refused =
    view !== undefined && Object.hasOwn(view.refused, name)
      ? view.refused[name]
      : undefined;
  if (refused !== undefined) throw new RunError('env_not_trusted', refused);
  const found = Object.hasOwn(cfg.envs, name) ? cfg.envs[name] : undefined;
  if (found === undefined) {
    throw new ConfigError(
      `Unknown env "${name}"; known: ${Object.keys(cfg.envs).join(', ')}`,
    );
  }
  return { name, ...found };
}

export const storageStatePath = (
  cfg: LoadedConfig,
  env: string,
  profile: string,
): string => join(cfg.flowsPath, '.auth', env, `${profile}.json`);

export const runsPath = (cfg: LoadedConfig): string =>
  join(cfg.flowsPath, '.runs');
