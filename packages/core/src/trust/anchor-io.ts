import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { TrustError } from './errors.js';
import {
  anchorDirFor,
  readAnchorFile,
  writeAnchorFile,
  type Ran,
} from './anchor-file.js';

/** Where a store keeps its anchor (ADR 0025 Amendment 2026-11-02 section 7), recorded owner-signed in `trust.json`. */
export const AnchorLocationSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('keychain'), locator: z.string().uuid() })
    .strict(),
  z
    .object({ kind: z.literal('secret-service'), locator: z.string().uuid() })
    .strict(),
  z
    .object({
      kind: z.literal('file'),
      locator: z.string().refine((p) => isAbsolute(p), 'must be absolute'),
    })
    .strict(),
]);
export type AnchorLocation = z.infer<typeof AnchorLocationSchema>;

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Point = z.object({ head: Hex64, seq: z.number().int().min(0) }).strict();

const RecordSchema = z
  .object({
    v: z.literal(1),
    storeId: z.string().uuid(),
    ownerFingerprint: Hex64,
    head: Hex64,
    seq: z.number().int().min(0),
    pending: Point.nullable(),
  })
  .strict();

/** The second copy of the chain head: the committed head and, during a write, the head about to be committed. */
export type AnchorRecord = z.infer<typeof RecordSchema>;

const SERVICE = 'flowctl-trust';
const TIMEOUT_MS = 10_000;

/**
 * The absolute binaries of the keychain backends. Fixed paths, never looked up on `PATH`.
 *
 * @internal Tests point these at fake scripts so they never touch the real keychain.
 */
export const ANCHOR_BINARIES = {
  security: '/usr/bin/security',
  secretTool: '/usr/bin/secret-tool',
};

const unreachable = (where: string, why: string): TrustError =>
  new TrustError(
    'trust_tampered',
    `The trust store's anchor (${where}) cannot be read: ${why}. Restore it, or remove the store and run flowctl trust init.`,
    'anchor_unreachable',
  );

const where = (loc: AnchorLocation): string =>
  loc.kind === 'file'
    ? loc.locator
    : `${loc.kind} item ${SERVICE}/${loc.locator}`;

/**
 * Runs a fixed absolute binary with a minimal environment: `PATH`, `HOME` from the passwd entry, and the session bus
 * variables a Secret Service needs (`DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`) when they are set.
 *
 * @remarks The macOS keychain takes the record on argv (`security -w`), so other local users can see it in `ps`.
 *   The record is a second copy of a hash, not a secret.
 */
function run(bin: string, args: string[], input?: string): Ran {
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    HOME: userInfo().homedir,
  };
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  try {
    const out = execFileSync(bin, args, {
      env,
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: TIMEOUT_MS,
    });
    return { ok: true, out };
  } catch (e) {
    const why =
      e instanceof Error && 'status' in e && typeof e.status === 'number'
        ? `${bin} exited ${e.status}`
        : e instanceof Error && 'code' in e && typeof e.code === 'string'
          ? `${bin}: ${e.code}`
          : `${bin} failed`;
    return { ok: false, why };
  }
}

/**
 * Reads the anchor record at `loc`.
 *
 * @throws {TrustError} `trust_tampered` with detail `anchor_unreachable` when it cannot be read or parsed; there is no
 *   fallback to another location (no downgrade).
 */
export function readAnchor(loc: AnchorLocation): AnchorRecord {
  const got: Ran =
    loc.kind === 'keychain'
      ? run(ANCHOR_BINARIES.security, [
          'find-generic-password',
          '-s',
          SERVICE,
          '-a',
          loc.locator,
          '-w',
        ])
      : loc.kind === 'secret-service'
        ? run(ANCHOR_BINARIES.secretTool, [
            'lookup',
            'service',
            SERVICE,
            'account',
            loc.locator,
          ])
        : readAnchorFile(loc.locator);
  if (!got.ok)
    throw unreachable(
      where(loc),
      `${got.why}${loc.kind === 'keychain' ? ' (if the keychain is locked, unlock it and try again)' : ''}`,
    );
  const text = got.out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw unreachable(where(loc), 'it is not JSON');
  }
  const rec = RecordSchema.safeParse(parsed);
  if (!rec.success) throw unreachable(where(loc), 'it is not an anchor record');
  return rec.data;
}

/**
 * Writes the anchor record at `loc`, replacing the previous one.
 *
 * @throws {TrustError} `trust_tampered` with detail `anchor_unreachable` when it cannot be written.
 */
export function writeAnchor(loc: AnchorLocation, rec: AnchorRecord): void {
  const text = JSON.stringify(rec);
  const done: Ran =
    loc.kind === 'keychain'
      ? run(ANCHOR_BINARIES.security, [
          'add-generic-password',
          '-U',
          '-s',
          SERVICE,
          '-a',
          loc.locator,
          '-w',
          text,
        ])
      : loc.kind === 'secret-service'
        ? run(
            ANCHOR_BINARIES.secretTool,
            [
              'store',
              `--label=${SERVICE}`,
              'service',
              SERVICE,
              'account',
              loc.locator,
            ],
            text,
          )
        : writeAnchorFile(loc.locator, text);
  if (!done.ok)
    throw unreachable(where(loc), `it cannot be written: ${done.why}`);
}

/**
 * Deletes the anchor record at `loc`: the old store's after `trust init --replace`, or the new one of a replacement
 * that is started over (Amendment 2026-11-02 section 6).
 *
 * @returns whether it was deleted; a leftover record names a store id no store has and is ignored, so failure is
 *   reported, not thrown.
 */
export function deleteAnchor(loc: AnchorLocation): boolean {
  if (loc.kind === 'file') {
    try {
      rmSync(loc.locator, { force: true });
      return true;
    } catch {
      return false;
    }
  }
  const done =
    loc.kind === 'keychain'
      ? run(ANCHOR_BINARIES.security, [
          'delete-generic-password',
          '-s',
          SERVICE,
          '-a',
          loc.locator,
        ])
      : run(ANCHOR_BINARIES.secretTool, [
          'clear',
          'service',
          SERVICE,
          'account',
          loc.locator,
        ]);
  return done.ok;
}

/**
 * Picks the anchor location for a new store (ADR 0025 Amendment 2026-11-02 section 7): the macOS keychain, else the
 * Linux Secret Service, each only when a probe write and read-back work; else a file in `anchorDir`.
 *
 * @param anchorDir an absolute directory outside the store and every repository (`trust init --anchor-dir`).
 * @throws {TrustError} `anchor_unavailable` when no keychain answers and no `anchorDir` was given (owner decision
 *   2026-11-06: refuse); `trust_entry_invalid` for an `anchorDir` that is relative or inside the store;
 *   `trust_tampered` for an `anchorDir` inside a repository.
 */
export function chooseAnchor(
  storeId: string,
  storeDir: string,
  anchorDir?: string,
): AnchorLocation {
  if (anchorDir !== undefined) {
    if (!isAbsolute(anchorDir))
      throw new TrustError(
        'trust_entry_invalid',
        `--anchor-dir must be an absolute path; got ${anchorDir}.`,
      );
    const dir = anchorDirFor(anchorDir, storeDir);
    return { kind: 'file', locator: join(dir, `${storeId}.anchor`) };
  }
  for (const kind of ['keychain', 'secret-service'] as const) {
    if (
      !existsSync(
        kind === 'keychain'
          ? ANCHOR_BINARIES.security
          : ANCHOR_BINARIES.secretTool,
      )
    )
      continue;
    const loc: AnchorLocation = { kind, locator: storeId };
    try {
      const probe = {
        v: 1 as const,
        storeId,
        ownerFingerprint: '0'.repeat(64),
        head: '0'.repeat(64),
        seq: 0,
        pending: null,
      };
      writeAnchor(loc, probe);
      readAnchor(loc);
      return loc;
    } catch {
      continue;
    }
  }
  throw new TrustError(
    'anchor_unavailable',
    'No keychain answered (macOS keychain or a Linux Secret Service), so flowctl has no second place for the store head. Run: flowctl trust init --anchor-dir <absolute directory outside the store and every repository>',
  );
}
