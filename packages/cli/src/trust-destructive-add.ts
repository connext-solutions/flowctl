import {
  ConfigError,
  confirmLine,
  confirmReadContext,
  defaultKeyDir,
  displayText,
  type Draft,
  entryOf,
  type LoadedConfig,
  loadOwnerKey,
  planDestructive,
  planRenew,
  renewConfirmEntries,
  saveConfirmEntries,
  TrustError,
  type TrustStore,
} from '@flowctl/core';
import type { Values } from './argv.js';
import { paged, screen } from './confirm-screen.js';
import { confirmNonce, openTty, type Tty } from './trust-tty.js';

/** What `trust add destructive` takes besides the flow name or the entry ids. */
export interface DestructiveOptions {
  env?: string;
  fromRun?: string;
  renew: boolean;
  renewEnv?: string;
  days?: string;
}

/** The options of `trust add destructive` among the parsed CLI values. */
export const destructiveOptions = (v: Values): DestructiveOptions => ({
  env: v.env,
  fromRun: v['from-run'],
  renew: v.renew,
  renewEnv: v['renew-env'],
  days: v.days,
});

/**
 * `--days` as a number: digits only, else `NaN`, which the plan refuses (`trust_entry_invalid`), so `1e1`, ` 5` or
 * `0x1e` never pass as a number.
 */
export const daysOf = (d: string | undefined): number | undefined =>
  d === undefined ? undefined : /^[0-9]+$/.test(d) ? Number(d) : NaN;

/** An answer typed at a prompt, or `fallback` for an empty line. */
const answer = (tty: Tty, question: string, fallback: string): string => {
  const typed = tty.ask(`${question} [${displayText(fallback)}]: `).trim();
  return typed === '' ? fallback : typed;
};
const list = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');

/** Asks the owner the attestations of one draft, each with its proposed default; recorded values are escaped. */
export function askDraft(tty: Tty, d: Draft): Draft {
  const w = d.write;
  tty.write(
    `\n${displayText(`${w.method} ${w.template} (bodyKeys [${w.bodyKeys.join(',')}])`)}\n`,
  );
  const kind = answer(tty, 'kind: create, mutate or skip', d.kind);
  if (kind !== 'create' && kind !== 'mutate' && kind !== 'skip')
    throw new TrustError(
      'trust_entry_invalid',
      `"${displayText(kind)}" is not create, mutate or skip; nothing was written.`,
    );
  if (kind === 'skip') return { ...d, kind };
  if (kind === 'mutate')
    return {
      ...d,
      kind,
      ledgerFrom: answer(
        tty,
        'ledgerFrom: the create entry whose records this may change',
        d.ledgerFrom,
      ),
      idPositions: list(
        answer(
          tty,
          'idPositions: path, body:<pointer>, query:<name> (comma-separated)',
          d.idPositions.join(','),
        ),
      ),
    };
  tty.write(
    'You attest the next answers about the endpoint; nothing in a recording proves them.\n',
  );
  const nameField = answer(
    tty,
    'nameField: the body key that holds the QA- name with the run uid',
    d.nameField,
  );
  const status = list(
    answer(
      tty,
      'conflictStatus: what the endpoint answers when the name exists, never updating the row (409, 422)',
      d.conflictStatus.join(','),
    ),
  );
  const conflictStatus = status
    .map((s) => (s === '409' ? 409 : s === '422' ? 422 : 0))
    .filter((s) => s !== 0);
  if (conflictStatus.length !== status.length)
    throw new TrustError(
      'trust_entry_invalid',
      'conflictStatus is 409, 422 or both; nothing was written.',
    );
  return {
    ...d,
    kind,
    nameField,
    naturalKeys: list(
      answer(
        tty,
        'naturalKeys: body keys that identify the record (comma-separated)',
        nameField,
      ),
    ),
    conflictStatus: conflictStatus.filter(
      (s): s is 409 | 422 => s === 409 || s === 422,
    ),
    idFrom: answer(
      tty,
      'idFrom: body:<pointer> or header:Location (the evidence keeps no 2xx body)',
      d.idFrom,
    ),
    cleanup: answer(
      tty,
      'cleanup: the DELETE template that removes one record',
      d.cleanup,
    ),
    verify: answer(
      tty,
      'verify: the GET template that answers 404 once it is gone',
      d.verify,
    ),
  };
}

/**
 * `flowctl trust add destructive <flow> --env <env> --from-run <run id>` (ADR 0024 section 5 and the amendment
 * 2026-11-13): shows the env, the flow and every file its confirmation digest binds, the effective vars and the writes
 * of a recorded local run (paged, invisible characters escaped), asks the owner the attestations no recording holds
 * (kind, nameField, naturalKeys, conflictStatus, idFrom, cleanup and verify, ledgerFrom, idPositions), each with a
 * proposed default, prints the entries in the fixed line format last, then asks for the nonce and the owner-key
 * passphrase and writes them signed. `--renew <id>...` and `--renew-env <env>` write a new `expires` (and origin)
 * for entries whose flow is unchanged.
 *
 * @throws {TrustError} `trust_entry_invalid` (an unconfirmable flow, a recording that does not fit, an answer that
 *   breaks a rule), `renew_digest_changed`, `tty_required`, `confirmation_mismatch`, `key_unlock_failed`,
 *   `store_busy`, `trust_tampered`.
 * @throws {ConfigError} when the arguments do not name one mode, or the run's evidence cannot be read.
 */
export function trustAddDestructive(
  cfg: LoadedConfig,
  store: TrustStore,
  args: string[],
  o: DestructiveOptions,
  out: (s: string) => void,
): void {
  if (o.renew || o.renewEnv !== undefined)
    return renew(cfg, store, args, o, out);
  const [flow] = args;
  if (
    args.length !== 1 ||
    flow === undefined ||
    o.env === undefined ||
    o.fromRun === undefined
  )
    throw new ConfigError(
      'trust add destructive needs <flow> --env <env> --from-run <run id>, or --renew <id>... or --renew-env <env>',
    );
  const p = planDestructive(cfg, store, {
    flow,
    env: o.env,
    fromRun: o.fromRun,
    days: daysOf(o.days),
  });
  const tty = openTty();
  try {
    paged(tty, screen(p));
    const entries = p.drafts
      .map((d) => entryOf(askDraft(tty, d), p.base))
      .filter((e) => e !== undefined);
    if (entries.length === 0)
      throw new TrustError(
        'trust_entry_invalid',
        'Every write was skipped, so there is no entry to write; nothing was written.',
      );
    tty.write(
      `\nentries to write (they replace every entry of flow ${p.flow.name} on env ${p.env.name}):\n`,
    );
    for (const e of entries) tty.write(`  ${displayText(confirmLine(e))}\n`);
    confirmNonce(
      tty,
      `write ${entries.length} destructive confirmation(s) for ${p.flow.name}`,
    );
    const key = loadOwnerKey(
      defaultKeyDir(),
      tty.ask('Owner-key passphrase: ', { echo: false }),
    );
    const again = planDestructive(cfg, store, {
      flow,
      env: o.env,
      fromRun: o.fromRun,
      days: daysOf(o.days),
    });
    if (again.plan.digest !== p.plan.digest)
      throw new TrustError(
        'trust_entry_invalid',
        `Flow ${p.flow.name} changed while it was shown; nothing was written.`,
      );
    saveConfirmEntries(store, key, entries, confirmReadContext(cfg));
    for (const e of entries)
      out(
        `confirmed ${e.id} (${e.kind} ${e.method} ${e.template}, expires ${e.expires})\n`,
      );
  } finally {
    tty.close();
  }
}

function renew(
  cfg: LoadedConfig,
  store: TrustStore,
  ids: string[],
  o: DestructiveOptions,
  out: (s: string) => void,
): void {
  if (
    o.renew === (o.renewEnv !== undefined) ||
    (o.renew && ids.length === 0) ||
    (!o.renew && ids.length > 0)
  )
    throw new ConfigError(
      'trust add destructive takes --renew <id>... or --renew-env <env>, not both',
    );
  const renewals = planRenew(cfg, store, {
    ids,
    env: o.renewEnv,
    days: daysOf(o.days),
  });
  const tty = openTty();
  try {
    const lines = renewals.flatMap((r) => [
      `  ${confirmLine(r.old)}`,
      `    expires ${r.old.expires} -> ${r.next.expires}${r.old.origin === r.next.origin ? '' : `, origin ${r.old.origin} -> ${r.next.origin}`}`,
    ]);
    paged(
      tty,
      [
        '\nrenew these destructive confirmations (their flows are unchanged):',
        ...lines,
      ].map(displayText),
    );
    confirmNonce(tty, `renew ${renewals.length} destructive confirmation(s)`);
    const key = loadOwnerKey(
      defaultKeyDir(),
      tty.ask('Owner-key passphrase: ', { echo: false }),
    );
    renewConfirmEntries(
      store,
      key,
      renewals.map((r) => r.next),
      confirmReadContext(cfg),
    );
    for (const r of renewals)
      out(`renewed ${r.next.id} (expires ${r.next.expires})\n`);
  } finally {
    tty.close();
  }
}
