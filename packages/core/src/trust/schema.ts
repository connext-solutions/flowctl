import { z } from 'zod';
import { NAME_PATTERN } from '../foundation/index.js';

/**
 * The on-disk shape of `trust.json` (ADR 0025 section 2). The schema checks structure and markers; the
 * owner-key signatures (section 3) are verified by the readers in `registry.ts` and `envs.ts`, and the
 * field-level semantics of each section by the guards that read them (ADR 0024, 0020, 0021). Unknown
 * top-level keys are rejected so a tampered file does not pass silently.
 *
 * @remarks `envs` and `profiles` carry a `sig` too: the owner decided on 2026-11-02 to sign the rows
 *   ADR 0025 section 3 left unsigned, because an env class also grants power.
 *
 * @see docs/adr/0025-trust-store.md
 */
const Name = z
  .string()
  .regex(NAME_PATTERN, 'use lowercase letters, digits and dashes');

export const ENV_CLASSES = ['production', 'shared', 'local'] as const;
const EnvClass = z.enum(ENV_CLASSES);
export type EnvClass = z.infer<typeof EnvClass>;

const ProjectEntry = z
  .object({
    root: z.string(),
    identity: z.array(z.string()).default([]),
    defaultEnv: z.string().optional(),
    language: z.string().optional(),
    locale: z.string().optional(),
    sig: z.string().optional(),
  })
  .strict();

const EnvEntry = z
  .object({
    origin: z.string(),
    class: EnvClass,
    visitOrigins: z.array(z.string()).default([]),
    callOrigins: z.array(z.string()).default([]),
    sig: z.string().optional(),
  })
  .strict();

const ProductionOrigin = z.object({ sig: z.string() }).strict();

const EnvVar = z
  .object({ name: z.string(), kind: z.enum(['secret', 'username']) })
  .strict();

const ProfileEntry = z
  .object({
    loginOrigins: z.array(z.string()).default([]),
    envVars: z.array(EnvVar).default([]),
    sig: z.string().optional(),
  })
  .strict();

const Root = z
  .object({
    purpose: z.enum(['flows', 'contracts', 'specs', 'repos', 'issues']),
    path: z.string(),
    name: Name.optional(),
    identity: z.array(z.string()).optional(),
    sig: z.string().optional(),
  })
  .strict();

/**
 * Where the anchor (second head) lives, owner-signed as the scalar singleton `anchor` (ADR 0025 Amendment
 * 2026-11-02 sections 5 and 7).
 */
const AnchorEntry = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('keychain'),
      locator: z.string(),
      sig: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('secret-service'),
      locator: z.string(),
      sig: z.string(),
    })
    .strict(),
  z
    .object({ kind: z.literal('file'), locator: z.string(), sig: z.string() })
    .strict(),
]);

/**
 * Where System 1 may run on this machine (ADR 0025 section 2, `system1`; ADR 0024 section 1), owner-signed as the
 * scalar singleton `system1`: endpoint hosts as exact `host:port`, the variable names its key may come from, and
 * the envs it may run in. The repo config can only choose among them. The cost price table arrives with budgets.
 */
const System1Entry = z
  .object({
    allowedHosts: z.array(z.string()),
    apiKeyEnvs: z.array(z.string()),
    allowedEnvs: z.array(Name),
    sig: z.string(),
  })
  .strict();

export const TrustMarker = z.enum(['ci', 'test']);

/**
 * The read-side view: every section is optional with an empty default so a sparse store opens, and
 * the structure is strict so an unexpected key is a refusal rather than silent data.
 */
export const TrustStoreSchema = z
  .object({
    v: z.literal(1),
    markers: z.array(TrustMarker).default([]),
    projects: z.record(Name, ProjectEntry).default({}),
    envs: z.record(Name, EnvEntry).default({}),
    profiles: z.record(Name, ProfileEntry).default({}),
    productionOrigins: z.record(z.string(), ProductionOrigin).default({}),
    system1: System1Entry.optional(),
    destructiveConfirm: z.array(z.unknown()).default([]),
    reviewerKeys: z.array(z.unknown()).default([]),
    flowFloors: z.record(z.string(), z.number()).default({}),
    specFloors: z.record(z.string(), z.number()).default({}),
    latestRevision: z.record(z.string(), z.number()).default({}),
    handWritten: z.array(z.unknown()).default([]),
    classification: z.enum(['enforce']).optional(),
    resolvers: z.record(z.string(), z.unknown()).default({}),
    roots: z.array(Root).default([]),
    sessionDir: z.string().optional(),
    hooks: z.record(z.string(), z.unknown()).default({}),
    ownerFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    ownerPublicKey: z.string().optional(),
    anchor: AnchorEntry.optional(),
    head: z.string().optional(),
  })
  .strict();

export type TrustStoreDoc = z.infer<typeof TrustStoreSchema>;
