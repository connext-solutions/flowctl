import { ARIA_ROLES } from '../../flow/index.js';
import type { RunResult } from '../../result.js';
import { normText, refusal } from '../../spec/index.js';
import type { ClassifyLimits } from './types.js';

/**
 * What a failed run failed on, read from `run.json`: a role locator that was not found (its name), a `text`
 * assertion (its text), or a `url` assertion (the literal path it expected and the path the page was on). Texts are
 * normalised (ADR 0020 section d) and not refused.
 */
export type Subject =
  | { kind: 'locator'; role: string; text: string; pointer: string }
  | { kind: 'text'; text: string; pointer: string }
  | {
      kind: 'url';
      expected: string;
      got: string;
      pointer: string;
      gotPointer: string;
    };

/** A failed fetch/xhr call of `evidence.network`, parsed from its `<status> <METHOD> <url> …` line. */
export interface FailedCall {
  status: number;
  method: string;
  url: string;
  origin: string | null;
  pointer: string;
}

const NOT_FOUND = /^([a-z]+) "([\s\S]*)" not found$/;
const CALL = /^(\d{1,3}) ([A-Z]{3,7}) (\S+)/;
const ROLES: ReadonlySet<string> = new Set(ARIA_ROLES);
const MAX_LINE = 4000;

/** The text `raw` normalised, or a fixed note saying why it is not compared. */
function usable(
  raw: string,
  what: string,
  limits: ClassifyLimits,
): { text: string } | { note: string } {
  const text = normText(raw);
  if (text === '') return { note: `${what} is empty` };
  if ([...text].length > limits.maxSubject)
    return { note: `${what} is longer than ${limits.maxSubject} code points` };
  const r = refusal(text);
  return r === null ? { text } : { note: `${what} refused: ${r}` };
}

/**
 * The literal path of a `url` assertion glob, or `null`: an origin, or leading `*`, and trailing `*` are dropped;
 * what is left must start with `/` and hold no `*`, `?`, `#` or template.
 *
 * @example literalPath('**\/settings/teams*') // '/settings/teams'
 */
export function literalPath(glob: string): string | null {
  if (glob.length > MAX_LINE || glob.includes('{{')) return null;
  let s = glob.replace(/^\*+/, '').replace(/\*+$/, '');
  const origin = /^[a-z][a-z\d+.-]*:\/\/[^/*]+/i.exec(s);
  if (origin !== null) s = s.slice(origin[0].length);
  if (!s.startsWith('/') || /[*?#]/.test(s)) return null;
  return s;
}

/** The path of an absolute URL, or `null`. */
function pathOf(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/** The failure subject of a failed run, or `null` with a note saying why there is none. */
export function subjectOf(
  result: RunResult,
  limits: ClassifyLimits,
): { subject: Subject | null; notes: string[] } {
  const f = result.failed;
  if (f === undefined)
    return {
      subject: null,
      notes: ['run.json has no failed step or assertion'],
    };
  if ('kind' in f) {
    const m =
      f.kind === 'not_found'
        ? NOT_FOUND.exec(f.message.slice(0, MAX_LINE))
        : null;
    if (m === null || !ROLES.has(m[1] ?? ''))
      return {
        subject: null,
        notes: [`step failure ${f.kind} names no role locator`],
      };
    const u = usable(m[2] ?? '', 'locator name', limits);
    if ('note' in u) return { subject: null, notes: [u.note] };
    return {
      subject: {
        kind: 'locator',
        role: m[1] ?? '',
        text: u.text,
        pointer: '/failed/message',
      },
      notes: [],
    };
  }
  const a = f.assertion;
  if ('text' in a) {
    const u = usable(a.text, 'assertion text', limits);
    if ('note' in u) return { subject: null, notes: [u.note] };
    return {
      subject: {
        kind: 'text',
        text: u.text,
        pointer: '/failed/assertion/text',
      },
      notes: [],
    };
  }
  if ('url' in a) {
    const expected = literalPath(a.url);
    const got = pathOf(f.got.slice(0, MAX_LINE));
    if (expected === null || got === null)
      return {
        subject: null,
        notes: ['url assertion is not a literal path, or got is not a URL'],
      };
    return {
      subject: {
        kind: 'url',
        expected,
        got,
        pointer: '/failed/assertion/url',
        gotPointer: '/failed/got',
      },
      notes: [],
    };
  }
  return {
    subject: null,
    notes: ['failed assertion kind has no text or route rule'],
  };
}

/** The origin of an absolute URL, or `null` (not a URL, or an opaque origin such as `data:`). */
function originOf(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? null : o;
  } catch {
    return null;
  }
}

/** The failed calls of `result.evidence.network` that parse; the `… and N more` line and others are skipped. */
export function failedCalls(result: RunResult): FailedCall[] {
  return result.evidence.network.flatMap((line, i): FailedCall[] => {
    const m = CALL.exec(line.slice(0, MAX_LINE));
    if (m === null) return [];
    const url = m[3] ?? '';
    const origin = originOf(url);
    return [
      {
        status: Number(m[1]),
        method: m[2] ?? '',
        url,
        origin,
        pointer: `/evidence/network/${i}`,
      },
    ];
  });
}
