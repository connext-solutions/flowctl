import { assertCanWrite } from '../admin.js';
import { trustedEnv } from '../envs.js';
import { TrustError } from '../errors.js';
import type { OwnerKey } from '../owner-key.js';
import { TrustStore } from '../store.js';
import { replaceStoreDoc } from '../write.js';
import { crossProblems, entryProblem, type RuleContext } from './rules.js';
import {
  CONFIRM_KIND,
  type ConfirmEntry,
  ConfirmEntrySchema,
  StoredConfirmSchema,
} from './schema.js';

/** What a read of the `destructiveConfirm` section gives. */
export interface ConfirmRead {
  /** The entries that hold now: signed, valid, not expired. */
  entries: ConfirmEntry[];
  /** Entries ignored as `trust_entry_invalid`, each with the first rule it breaks; never partially applied. */
  invalid: { id: string; problem: string }[];
  /** Ids of entries past `expires` (absent, not invalid). */
  expired: string[];
}

/** The part of {@link RuleContext} a caller gives; the envs come from the store. */
export type ReadContext = Omit<RuleContext, 'envs'>;

const envsOf = (store: TrustStore): RuleContext['envs'] => {
  const out: Record<string, { origin: string; class: string }> = {};
  for (const name of Object.keys(store.data.envs)) {
    const e = trustedEnv(store, name);
    if (e !== undefined) out[name] = e;
  }
  return out;
};

const tampered = (why: string): TrustError =>
  new TrustError(
    'trust_tampered',
    `A destructiveConfirm entry ${why}; the store was changed outside flowctl.`,
    'bad_entry',
  );

/**
 * Reads the store's `destructiveConfirm` entries (ADR 0024 section 5), verifying each owner signature over the value
 * as stored, then every rule of the section and its amendments. An entry that breaks a rule is ignored as a whole
 * and listed in `invalid`; an entry whose `expires` date has passed (UTC) is absent.
 *
 * @throws {TrustError} `trust_tampered` (`bad_entry`) when an item is not `{value, sig}` or names no id, and
 *   (`bad_signature`) when a signature does not verify.
 */
export function readConfirmEntries(
  store: TrustStore,
  ctx: ReadContext,
): ConfirmRead {
  const full: RuleContext = { ...ctx, envs: envsOf(store) };
  const today = new Date(ctx.now).toISOString().slice(0, 10);
  const valid: ConfirmEntry[] = [];
  const invalid: ConfirmRead['invalid'] = [];
  const expired: string[] = [];
  for (const raw of store.data.destructiveConfirm) {
    const stored = StoredConfirmSchema.safeParse(raw);
    if (!stored.success) throw tampered('is not {value, sig}');
    const v = stored.data.value;
    const id =
      typeof v === 'object' &&
      v !== null &&
      'id' in v &&
      typeof v.id === 'string'
        ? v.id
        : undefined;
    if (id === undefined) throw tampered('names no id');
    store.assertSigned({ id, kind: CONFIRM_KIND, value: v }, stored.data.sig);
    const parsed = ConfirmEntrySchema.safeParse(v);
    if (!parsed.success) {
      invalid.push({ id, problem: 'its fields do not follow the schema' });
      continue;
    }
    const problem = entryProblem(parsed.data, full);
    if (problem !== undefined) invalid.push({ id, problem });
    else if (parsed.data.expires < today) expired.push(id);
    else valid.push(parsed.data);
  }
  const cross = crossProblems(valid);
  for (const [id, problem] of cross) invalid.push({ id, problem });
  return {
    entries: valid.filter((e) => !cross.has(e.id)),
    invalid,
    expired,
  };
}

/**
 * Signs `entries` and writes them into the store in one atomic replace (what `flowctl trust add destructive` does
 * after the owner confirmed them). They replace every earlier entry of the same flow and env, so a re-confirmed flow
 * keeps no entry of its previous version.
 *
 * @throws {TrustError} `trust_entry_invalid` when an entry breaks a rule (the message names the entry and the rule),
 *   when an id belongs to an entry of another flow or env, or for a store marked `ci`; `trust_tampered` for another
 *   key or a tampered entry; `store_busy` when the store changed meanwhile.
 */
export function saveConfirmEntries(
  store: TrustStore,
  key: OwnerKey,
  entries: readonly ConfirmEntry[],
  ctx: ReadContext,
): void {
  const fresh = TrustStore.open(store.dir);
  assertCanWrite(fresh, key);
  const ours = (e: { flow: string; env: string }): boolean =>
    entries.some((n) => n.flow === e.flow && n.env === e.env);
  const kept = fresh.data.destructiveConfirm.filter((raw) => {
    const s = StoredConfirmSchema.safeParse(raw);
    const v = s.success
      ? ConfirmEntrySchema.safeParse(s.data.value)
      : undefined;
    return v?.success !== true || !ours(v.data);
  });
  const full: RuleContext = { ...ctx, envs: envsOf(fresh) };
  for (const e of entries) {
    const problem = entryProblem(ConfirmEntrySchema.parse(e), full);
    if (problem !== undefined)
      throw new TrustError(
        'trust_entry_invalid',
        `The destructiveConfirm entry ${e.id} is refused: ${problem}. Nothing was written.`,
      );
  }
  const signed = entries.map((value) => ({
    value,
    sig: key.signEntry({ id: value.id, kind: CONFIRM_KIND, value }),
  }));
  const others = readConfirmEntries(fresh, ctx).entries.filter((e) => !ours(e));
  const cross = crossProblems([...others, ...entries]);
  const bad = entries.find((e) => cross.has(e.id));
  if (bad !== undefined)
    throw new TrustError(
      'trust_entry_invalid',
      `The destructiveConfirm entry ${bad.id} is refused: ${cross.get(bad.id) ?? ''}. Nothing was written.`,
    );
  const doc = { ...fresh.data, destructiveConfirm: [...kept, ...signed] };
  replaceStoreDoc(fresh.dir, doc, key);
}

/**
 * Removes the entry `id` and every `mutate` entry whose `ledgerFrom` names it (`flowctl trust revoke destructive
 * <id>`), in one atomic replace.
 *
 * @returns the ids removed, `id` first.
 * @throws {TrustError} `trust_entry_invalid` when the store has no entry `id` or is marked `ci`; `trust_tampered` for
 *   another key; `store_busy` when the store changed meanwhile.
 */
export function revokeConfirmEntry(
  store: TrustStore,
  key: OwnerKey,
  id: string,
): string[] {
  const fresh = TrustStore.open(store.dir);
  assertCanWrite(fresh, key);
  const valueOf = (raw: unknown): Record<string, unknown> | undefined => {
    const s = StoredConfirmSchema.safeParse(raw);
    const v = s.success ? s.data.value : undefined;
    return typeof v === 'object' && v !== null ? { ...v } : undefined;
  };
  if (!fresh.data.destructiveConfirm.some((r) => valueOf(r)?.['id'] === id))
    throw new TrustError(
      'trust_entry_invalid',
      `The trust store has no destructiveConfirm entry "${id}"; nothing was changed.`,
    );
  const removed = [id];
  const kept = fresh.data.destructiveConfirm.filter((r) => {
    const v = valueOf(r);
    if (v?.['id'] === id) return false;
    if (v?.['kind'] === 'mutate' && v['ledgerFrom'] === id) {
      removed.push(String(v['id']));
      return false;
    }
    return true;
  });
  replaceStoreDoc(fresh.dir, { ...fresh.data, destructiveConfirm: kept }, key);
  return removed;
}

/**
 * Every stored entry whose signature verifies and whose fields follow the schema, whatever the other rules say: an
 * expired entry, or one whose origin is no longer the env's, is here too. `trust add destructive --renew` and
 * `--renew-env` start from these.
 *
 * @throws {TrustError} `trust_tampered` as {@link readConfirmEntries}.
 */
export function storedConfirmEntries(store: TrustStore): ConfirmEntry[] {
  const out: ConfirmEntry[] = [];
  for (const raw of store.data.destructiveConfirm) {
    const stored = StoredConfirmSchema.safeParse(raw);
    if (!stored.success) throw tampered('is not {value, sig}');
    const parsed = ConfirmEntrySchema.safeParse(stored.data.value);
    if (!parsed.success) continue;
    store.assertSigned(
      { id: parsed.data.id, kind: CONFIRM_KIND, value: stored.data.value },
      stored.data.sig,
    );
    out.push(parsed.data);
  }
  return out;
}

/**
 * Writes `updated` in place of the stored entries with the same ids (`--renew`, `--renew-env`: a new `expires`, or a
 * new `origin` and `expires`), signed, in one atomic replace; every other entry is kept as it is.
 *
 * @throws {TrustError} `trust_entry_invalid` when an id is not stored or an updated entry breaks a rule;
 *   `trust_tampered`, `store_busy` as {@link saveConfirmEntries}.
 */
export function renewConfirmEntries(
  store: TrustStore,
  key: OwnerKey,
  updated: readonly ConfirmEntry[],
  ctx: ReadContext,
): void {
  const fresh = TrustStore.open(store.dir);
  assertCanWrite(fresh, key);
  const full: RuleContext = { ...ctx, envs: envsOf(fresh) };
  const ids = new Set(updated.map((e) => e.id));
  const stored = storedConfirmEntries(fresh);
  for (const e of updated) {
    if (!stored.some((s) => s.id === e.id))
      throw new TrustError(
        'trust_entry_invalid',
        `The trust store has no destructiveConfirm entry "${e.id}"; nothing was written.`,
      );
    const problem = entryProblem(ConfirmEntrySchema.parse(e), full);
    if (problem !== undefined)
      throw new TrustError(
        'trust_entry_invalid',
        `The destructiveConfirm entry ${e.id} is refused: ${problem}. Nothing was written.`,
      );
  }
  const kept = fresh.data.destructiveConfirm.filter((raw) => {
    const s = StoredConfirmSchema.safeParse(raw);
    const v = s.success ? s.data.value : undefined;
    return !(
      typeof v === 'object' &&
      v !== null &&
      'id' in v &&
      typeof v.id === 'string' &&
      ids.has(v.id)
    );
  });
  const signed = updated.map((value) => ({
    value,
    sig: key.signEntry({ id: value.id, kind: CONFIRM_KIND, value }),
  }));
  replaceStoreDoc(
    fresh.dir,
    { ...fresh.data, destructiveConfirm: [...kept, ...signed] },
    key,
  );
}
