import { redactBody, redactText } from './redact.js';

/** One fetch/xhr call of a run, as the evidence keeps it in memory (bodies as sent; {@link redactEntry} before writing). */
export interface NetEntry {
  profile: string;
  method: string;
  url: string;
  /** 0 when the request failed without a response. */
  status: number;
  requestBody: unknown;
  responseBody?: string;
}

/** Only API traffic counts; document/script/stylesheet loads (e.g. Vite serving .tsx) never do. */
export const API_TYPES = new Set(['fetch', 'xhr']);

/** A request body as the app sent it: parsed JSON when it parses, else the raw text, `undefined` when there is none. */
export function parseBody(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** One request on one line: `<status> <METHOD> <url> <response body>`. Redact the entry first ({@link redactEntry}). */
export const fmtNet = (e: NetEntry): string =>
  `${e.status} ${e.method} ${e.url}${e.responseBody ? ` ${e.responseBody}` : ''}`;

/** A copy of `e` fit to write or return: credential fields and secret values as `***` (ADR 0030). */
export const redactEntry = (
  e: NetEntry,
  secrets: readonly string[],
): NetEntry => ({
  ...e,
  url: redactText(e.url, secrets),
  requestBody: redactBody(e.requestBody, secrets),
  ...(e.responseBody === undefined
    ? {}
    : { responseBody: redactText(e.responseBody, secrets) }),
});
