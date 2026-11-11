/**
 * Names that become file or directory names: flows, envs and profiles.
 */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Thrown for a bad `flowctl.config.yaml` (shape, path containment or name). */
export class ConfigError extends Error {}

/** The most steps one exploration may take: the cap on a request's `maxSteps` and the ceiling of the config's. */
export const MAX_STEPS_CAP = 100;

/**
 * The `flowctl trust` subcommands of ADR 0025 section 3 ("Command dispatch"), built or not. A flow named like
 * one is refused at load, so `trust hook <name>` is never read as another subcommand, and the CLI never
 * suggests `trust hook` for one of them.
 */
export const TRUST_SUBCOMMANDS: readonly string[] = [
  'init',
  'add',
  'link',
  'hook',
  'key',
  'ci',
  'export',
  'verify-bundle',
  'forget',
  'revoke',
];

/** Characters an input mask puts between the characters of a value (`0901 234 567`, `(090) 123-4567`). */
const MASK_SEPARATORS = String.raw`[\s\-./()]*`;
/** A secret this long (in letters and digits) is also matched with separators between its characters. */
const LOOSE_MIN = 6;

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A pattern for `secret` with any {@link MASK_SEPARATORS} between its letters and digits, or `undefined` when the
 * secret has fewer than {@link LOOSE_MIN} of them (a short value would match ordinary text).
 */
function loose(secret: string): RegExp | undefined {
  const core = [...secret].filter((ch) => /[\p{L}\p{N}]/u.test(ch));
  if (core.length < LOOSE_MIN) return undefined;
  return new RegExp(core.map(escapeRegExp).join(MASK_SEPARATORS), 'giu');
}

/**
 * `text` with every secret value replaced by `***`, in the forms it can take in evidence and messages: as
 * typed, JSON-escaped (inside a request body), URL-encoded (inside a query string), and, for a secret of at least
 * six letters or digits, with spaces, dashes, dots, slashes or parentheses between its characters, as an input mask
 * shows it (issue #13). Empty secrets are skipped.
 *
 * @see docs/adr/0006-no-text-generation.md
 */
export function maskSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s === '') continue;
    for (const form of new Set([
      s,
      JSON.stringify(s).slice(1, -1),
      encodeURIComponent(s),
    ]))
      out = out.replaceAll(form, '***');
    const pattern = loose(s);
    if (pattern !== undefined) out = out.replace(pattern, '***');
  }
  return out;
}
