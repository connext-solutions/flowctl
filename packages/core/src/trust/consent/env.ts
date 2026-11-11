/**
 * Why an env list, pin or `.pgpass` file is refused (details of `hook_env_unsafe`, ADR 0021 Amendment
 * 2026-11-02, "Reason vocabulary").
 */
export type HookEnvProblem =
  | 'env_name_refused'
  | 'env_value_unpinned'
  | 'env_value_invalid'
  | 'pgpass_shape';

/** Names passed through without a value (section 9); values are unbound (section 10.4). */
const PASS_THROUGH = new Set([
  'PGPASSWORD',
  'PGCONNECT_TIMEOUT',
  'PGAPPNAME',
  'PGCLIENTENCODING',
]);

const OCTET = '(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])';

/** The pinned names and the shape of their values (section 10.2). */
const PINNED = new Map<string, (v: string) => boolean>([
  ['PGHOST', (v) => /^[A-Za-z0-9][A-Za-z0-9._:,-]*$/.test(v)],
  [
    'PGHOSTADDR',
    (v) =>
      new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`).test(v) ||
      (/^[0-9A-Fa-f:]{2,39}$/.test(v) && v.split(':').length - 1 >= 2),
  ],
  ['PGPORT', (v) => /^[0-9]{1,5}(,[0-9]{1,5})*$/.test(v)],
  ['PGUSER', (v) => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$/.test(v)],
  ['PGDATABASE', (v) => /^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$/.test(v)],
  [
    'PGSSLMODE',
    (v) =>
      [
        'disable',
        'allow',
        'prefer',
        'require',
        'verify-ca',
        'verify-full',
      ].includes(v),
  ],
  ['PGOPTIONS', (v) => v.length <= 256 && /^[\x20-\x7e]*$/.test(v)],
]);

/** Whether `name` is exactly one of the seven pinned names of section 10.2. */
export const isPinnedName = (name: string): boolean => PINNED.has(name);

/** ASCII-only upper-casing, so a non-ASCII letter never folds onto an allowed name. */
const foldName = (name: string): string =>
  name.replace(/[a-z]/g, (c) => c.toUpperCase());

/**
 * Checks the `env` and `pins` of a hook consent (ADR 0021 Amendment 2026-11-02 sections 9 and 10), at
 * `trust hook` and again on every run against the signed entry.
 *
 * @remarks `env` is an allowlist: only the four pass-through names and the seven pinned names may be listed;
 *   a name outside `[A-Za-z_][A-Za-z0-9_]*`, a duplicate or anything else is `env_name_refused`. A name must
 *   already be upper case: this is stricter than the ADR's "fold, then match", so the name stored and passed
 *   to the child is exactly the name the owner saw. A pinned name needs a pin (`env_value_unpinned`) whose
 *   value matches its table row (`env_value_invalid`); a pin whose name is not in `env` is
 *   `env_name_refused`.
 * @returns the first problem with the name it concerns (never a value), or `undefined`.
 */
export function checkHookEnv(
  env: readonly string[],
  pins: Readonly<Record<string, string>>,
): { problem: HookEnvProblem; name: string } | undefined {
  const seen = new Set<string>();
  for (const raw of env) {
    const name = foldName(raw);
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw) ||
      name !== raw ||
      seen.has(name) ||
      !(PASS_THROUGH.has(name) || PINNED.has(name))
    )
      return { problem: 'env_name_refused', name: raw };
    seen.add(name);
  }
  for (const name of Object.keys(pins))
    if (!seen.has(name) || !PINNED.has(name))
      return { problem: 'env_name_refused', name };
  for (const name of seen) {
    const rule = PINNED.get(name);
    if (rule === undefined) continue;
    const value = pins[name];
    if (value === undefined) return { problem: 'env_value_unpinned', name };
    if (!rule(value)) return { problem: 'env_value_invalid', name };
  }
  return undefined;
}

const LOCALE = /^(C|POSIX|C\.UTF-8|(en_[A-Z]{2}|vi_VN)\.(UTF-8|utf8))$/;

/**
 * Whether a parent `LANG` or `LC_*` value may reach a hook: English or Vietnamese in UTF-8, or the C locale
 * (ADR 0021 Amendment 2026-11-02 section 9, owner decision of 2026-11-03). Any other value is dropped.
 */
export const localeAllowed = (value: string): boolean => LOCALE.test(value);

/**
 * Whether `bytes` have the `.pgpass` shape of section 9: at most 4 KiB of UTF-8 with no CR; each LF-separated
 * line empty, a `#` comment, or five non-empty `host:port:database:user:password` fields (only `\:` and `\\`
 * escape) with a host other than `*`.
 */
export function pgpassShapeOk(bytes: Uint8Array): boolean {
  if (bytes.length > 4096 || bytes.includes(0x0d)) return false;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.every((line) => {
    if (line === '' || line.startsWith('#')) return true;
    const fields = splitPgpass(line);
    return (
      fields !== undefined &&
      fields.length === 5 &&
      fields.every((f) => f !== '') &&
      fields[0] !== '*'
    );
  });
}

function splitPgpass(line: string): string[] | undefined {
  const fields: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (c === '\\') {
      const nx = line.charAt(i + 1);
      if (nx !== ':' && nx !== '\\') return undefined;
      cur += nx;
      i++;
    } else if (c === ':') {
      fields.push(cur);
      cur = '';
    } else cur += c;
  }
  fields.push(cur);
  return fields;
}
