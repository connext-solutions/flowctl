import { parseJsonEntries } from './json.js';
import type { LabelRecord } from './types.js';

/** Folder names that hold locale files (compared lower-cased). */
const LOCALE_DIRS = new Set([
  'i18n',
  'l10n',
  'lang',
  'langs',
  'locale',
  'locales',
  'messages',
  'translations',
]);

const LOCALE_CODE = /^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/;

/**
 * Whether `rel` is a locale file: a `.json` file with a locale folder (`i18n`, `locales`, `messages`, …) among its
 * folders. Its locale is the file's base name when that is a locale code (`vi.json`), else the nearest folder
 * below the locale folder named like one (`locales/en-US/common.json`), else `null`.
 *
 * @returns `undefined` when `rel` is not a locale file.
 */
export function localeFileOf(
  rel: string,
): { locale: string | null } | undefined {
  if (!rel.endsWith('.json')) return undefined;
  const parts = rel.split('/');
  const dirs = parts.slice(0, -1);
  const at = dirs.findLastIndex((d) => LOCALE_DIRS.has(d.toLowerCase()));
  if (at < 0) return undefined;
  const base = (parts.at(-1) ?? '').slice(0, -'.json'.length);
  const candidates = [base, ...dirs.slice(at + 1).reverse()];
  return { locale: candidates.find((c) => LOCALE_CODE.test(c)) ?? null };
}

/**
 * The labels of the locale file `rel`: one per string leaf, keyed by its dotted path, with the text as written.
 *
 * @returns `undefined` when `rel` is not a locale file or `text` is not strict JSON.
 */
export function labelsInJson(
  rel: string,
  text: string,
): LabelRecord[] | undefined {
  const file = localeFileOf(rel);
  if (file === undefined) return undefined;
  const entries = parseJsonEntries(text);
  return entries?.map((e) => ({
    file: rel,
    line: e.line,
    key: e.key,
    text: e.text,
    locale: file.locale,
  }));
}
