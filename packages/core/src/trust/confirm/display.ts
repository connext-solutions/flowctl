import type { ConfirmEntry } from './schema.js';

const list = (xs: readonly string[] | undefined): string =>
  xs === undefined || xs.length === 0 ? '[]' : `[${xs.join(',')}]`;

/**
 * One entry in the fixed line format the owner sees before an entry is written, renewed or revoked (ADR 0024
 * section 5, "What the owner sees when confirming"): `kind method template idFrom|ledgerFrom bodyKeys queryKeys
 * headers nameField prefix cleanup`, with `-` for a field the kind does not have, then the entry id, env, origin
 * and expiry.
 *
 * @example
 * confirmLine(e) // "create POST /api/items body:/id [/name] [] [] /name QA- DELETE /api/items/{int} verify /api/items/{int}  (id items-create, env stg, https://stg.example.com, expires 2026-12-01)"
 */
export function confirmLine(e: ConfirmEntry): string {
  const ref =
    e.kind === 'create'
      ? e.idFrom
      : e.kind === 'mutate'
        ? `ledgerFrom:${e.ledgerFrom}`
        : '-';
  const name = e.kind === 'create' ? e.nameField : '-';
  const prefix = e.kind === 'create' ? e.prefix : '-';
  const cleanup =
    e.kind === 'create'
      ? `${e.cleanup.method} ${e.cleanup.template} verify ${e.cleanup.verify.template}`
      : '-';
  const ids = e.kind === 'mutate' ? ` idPositions ${list(e.idPositions)}` : '';
  return `${e.kind} ${e.method} ${e.template} ${ref} ${list(e.bodyKeys)} ${list(e.queryKeys)} ${list(e.headers)} ${name} ${prefix} ${cleanup}${ids}  (id ${e.id}, env ${e.env}, ${e.origin}, expires ${e.expires})`;
}
