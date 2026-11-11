import { maskSecrets } from '../foundation/index.js';

/**
 * Field names that hold a credential (ADR 0030), compared with `_`, `-`, spaces and case removed: a long word may end
 * the name (`accessToken`, `x-api-key`, `user_password`), a short one must be the whole name (`pin`, `otp`), so
 * `shipping`, `workSession` and `option` are kept.
 */
const CREDENTIAL_END =
  /(password|passwd|passphrase|secret|token|otp|apikey|authorization|cookie|credential|credentials|sessionid|sessiontoken)$/;
const CREDENTIAL_WHOLE = new Set([
  'pin',
  'pincode',
  'otp',
  'otpcode',
  'pwd',
  'sid',
  'session',
]);

const isCredential = (name: string): boolean => {
  const n = name.toLowerCase().replace(/[-_\s]/g, '');
  return CREDENTIAL_WHOLE.has(n) || CREDENTIAL_END.test(n);
};

const MASK = '***';

/**
 * A copy of a request or response body with secret values and every string or number under a credential name
 * replaced by `***`, at any depth below it (`{ token: { access: "…" } }` too). Keys, structure and booleans stay, so
 * the shape of the body is still readable.
 *
 * @param inCredential the value is already under a credential name (the walk's own state).
 */
export function redactBody(
  body: unknown,
  secrets: readonly string[],
  inCredential = false,
): unknown {
  if (body === undefined || body === null) return body;
  if (typeof body === 'string')
    return inCredential ? MASK : redactString(body, secrets);
  if (typeof body === 'number') return inCredential ? MASK : body;
  if (Array.isArray(body))
    return body.map((v) => redactBody(v, secrets, inCredential));
  if (typeof body === 'object')
    return Object.fromEntries(
      Object.entries(body).map(([k, v]) => [
        k,
        redactBody(v, secrets, inCredential || isCredential(k)),
      ]),
    );
  return body;
}

/**
 * A response body as text, redacted: parsed and walked by {@link redactBody} when it is JSON (numbers and nested
 * fields included), else by {@link redactText}. Redact before clipping, so a value cut in half is still masked.
 */
export function redactResponse(
  text: string,
  secrets: readonly string[],
): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object')
      return JSON.stringify(redactBody(parsed, secrets));
  } catch {
    return redactText(text, secrets);
  }
  return redactText(text, secrets);
}

/** A form-encoded body (`a=1&password=x`) with credential fields masked; any other string has secrets masked. */
function redactString(text: string, secrets: readonly string[]): string {
  const masked = maskSecrets(text, secrets);
  if (!/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(masked)) return masked;
  return masked
    .split('&')
    .map((pair) => {
      const at = pair.indexOf('=');
      const key = pair.slice(0, at);
      let name = key;
      try {
        name = decodeURIComponent(key);
      } catch {
        name = key;
      }
      return isCredential(name) ? `${key}=${MASK}` : pair;
    })
    .join('&');
}

/** `"name": value` in JSON text: a string (escaped quotes inside it included, or cut off at the end), or a number. */
const JSON_FIELD =
  /("([^"\\]{1,64})"\s*:\s*)("(?:[^"\\]|\\.)*(?:"|$)|-?\d[\d.eE+-]*)/g;
/** The same in JSON escaped inside a string (`\"name\":\"value\"`), as a log line or an error message carries it. */
const ESCAPED_FIELD =
  /(\\"([^"\\]{1,64})\\"\s*:\s*)(\\"(?:[^"\\]|\\(?!")|\\\\.)*?(?:\\"|$)|-?\d[\d.eE+-]*)/g;
/** A credential name in free text, with the same words as {@link isCredential} and `-`/`_` between parts allowed. */
const NAME = String.raw`(?:[\w-]*?(?:pass[-_]?(?:word|wd|phrase)|secret|token|otp|api[-_]?key|authorization|cookie|credentials?|session[-_]?(?:id|token))|pin(?:[-_]?code)?|otp[-_]?code|pwd|sid|session)`;
/** `Name: value` or `name=value` for a credential name, up to the end of the token (`Bearer x` with its scheme). */
const PAIR = new RegExp(
  String.raw`(?<![\w-])(${NAME})([ \t]*[:=][ \t]*)((?:Bearer|Basic|Token)\s+\S+|"[^"]*"|'[^']*'|[^\s"'&,;]+)`,
  'gi',
);
/** A whole `Cookie:` or `Set-Cookie:` value, every `name=value` of its list. */
const COOKIE = /\b((?:set-)?cookie)([ \t]*:[ \t]*)([^\r\n"]+)/gi;

/**
 * Text bound for evidence or an orchestrator (an assertion's `got`, an error hint, hook output) with secret input
 * values and credential-looking values replaced by `***`.
 *
 * @remarks A credential is a JSON field, a `name=value` or `Name: value` pair whose name is a credential name, an
 *   `Authorization` value with its scheme, and a whole `Cookie` list. The word alone ("the token field") is kept.
 */
export function redactText(text: string, secrets: readonly string[]): string {
  return maskSecrets(text, secrets)
    .replace(COOKIE, (_m, name: string, sep: string) => `${name}${sep}${MASK}`)
    .replace(ESCAPED_FIELD, (m, head: string, name: string) =>
      isCredential(name) ? `${head}\\"${MASK}\\"` : m,
    )
    .replace(JSON_FIELD, (m, head: string, name: string) =>
      isCredential(name) ? `${head}"${MASK}"` : m,
    )
    .replace(PAIR, (m, name: string, sep: string, value: string) => {
      if (value === MASK || value === `"${MASK}"`) return m;
      const q = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
      return `${name}${sep}${q}${MASK}${q}`;
    });
}
