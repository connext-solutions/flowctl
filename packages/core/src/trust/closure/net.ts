import { hasControl } from './paths.js';
import {
  fail,
  type JudgeFail,
  type ShellCommand,
  type ShellWord,
} from './types.js';

const PSQL_VALUE = new Map<string, RegExp>([
  ['-h', /^[A-Za-z0-9][A-Za-z0-9._:-]*$/],
  ['-p', /^[0-9]{1,5}$/],
  ['-U', /^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$/],
]);
const PSQL_USER = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$/;
const PSQL_DB_URI = /^postgres(ql)?:\/\/[A-Za-z0-9._:@-]*(\/[A-Za-z0-9._-]*)?$/;

/**
 * `psql -X` then connection options in any order and exactly one `-c TEXT` (ADR 0021 Amendment
 * 2026-11-02 section 4). Everything else, a stdin redirect, a pipe into `psql` and any backslash in the
 * raw text of an argument is `psql_input`.
 */
export function judgePsql(cmd: ShellCommand): JudgeFail | undefined {
  const [head, ...args] = cmd.words;
  const refuse = (w: ShellWord | undefined): JudgeFail =>
    fail('psql_input', w?.pos ?? head?.pos ?? 0, w?.text ?? 'psql');
  if (cmd.stdinFromPipe) return refuse(head);
  if (cmd.redirs.some((r) => r.kind === 'file' && r.op === '<'))
    return refuse(head);
  const slash = args.find((a) => a.raw.includes('\\'));
  if (slash !== undefined) return refuse(slash);
  if (args[0]?.text !== '-X') return refuse(args[0]);
  let commands = 0;
  for (let i = 1; i < args.length; i++) {
    const opt = args[i];
    const flag = opt?.text ?? '';
    if (flag === '-w') continue;
    const value = args[i + 1];
    if (value === undefined) return refuse(opt);
    i++;
    if (flag === '-c') commands++;
    else if (flag === '-d') {
      const v = value.text;
      if (/[= ?%&]/.test(v) || !(PSQL_USER.test(v) || PSQL_DB_URI.test(v)))
        return refuse(value);
    } else if (PSQL_VALUE.get(flag)?.test(value.text) !== true)
      return refuse(opt);
  }
  return commands === 1 ? undefined : refuse(head);
}

const NO_VALUE_LONG = new Set([
  '--silent',
  '--show-error',
  '--fail',
  '--location',
  '--include',
  '--head',
]);
const CURL_VALUE: [string[], (v: string) => boolean][] = [
  [
    ['-m', '--max-time', '--connect-timeout', '--retry'],
    (v) => /^[0-9]{1,4}$/.test(v),
  ],
  [['-X', '--request'], (v) => /^[A-Z]{3,10}$/.test(v)],
  [['-H', '--header'], (v) => /^[A-Za-z][A-Za-z0-9-]*:[ -~]*$/.test(v)],
  [
    ['-d', '--data', '--data-raw', '--data-binary', '--json'],
    (v) => !v.startsWith('@'),
  ],
  [
    [
      '-o',
      '--output',
      '-D',
      '--dump-header',
      '-c',
      '--cookie-jar',
      '--stderr',
      '--trace',
      '--trace-ascii',
    ],
    (v) => v === '/dev/null',
  ],
];
const URL_PREFIX =
  /^https?:\/\/([A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:]{2,39}\])(?::([0-9]+))?(?=$|[/?#])/;

/**
 * `curl -q` first, then only the flags of ADR 0021 Amendment 2026-11-02 section 5, and at least one URL
 * operand; every other flag is `curl_input`.
 */
export function judgeCurl(cmd: ShellCommand): JudgeFail | undefined {
  const [head, ...args] = cmd.words;
  if (args[0]?.text !== '-q')
    return fail(
      'curl_input',
      args[0]?.pos ?? head?.pos ?? 0,
      args[0]?.text ?? 'curl',
    );
  let urls = 0;
  for (let i = 1; i < args.length; i++) {
    const w = args[i];
    if (w === undefined) break;
    const t = w.text;
    if (!t.startsWith('-')) {
      const f = judgeUrl(w);
      if (f !== undefined) return f;
      urls++;
      continue;
    }
    if (/^-[sSfLiI]+$/.test(t) || NO_VALUE_LONG.has(t)) continue;
    const rule = CURL_VALUE.find(([names]) => names.includes(t));
    const value = args[i + 1];
    if (rule === undefined || value === undefined || !rule[1](value.text))
      return fail('curl_input', w.pos, t);
    i++;
  }
  return urls > 0 ? undefined : fail('curl_input', head?.pos ?? 0, 'curl');
}

function judgeUrl(w: ShellWord): JudgeFail | undefined {
  const m = URL_PREFIX.exec(w.text);
  const host = m?.[1] ?? '';
  const port = m?.[2];
  const ipv6 = host.startsWith('[');
  if (
    m === null ||
    (ipv6 && host.split(':').length - 1 < 2) ||
    (port !== undefined &&
      (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65_535))
  )
    return fail('url_scheme', w.pos, w.text);
  const rest = w.text.slice(m[0].length);
  if (/\s/.test(rest) || hasControl(rest))
    return fail('url_scheme', w.pos, w.text);
  return /[{}[\]]/.test(rest) ? fail('url_glob', w.pos, w.text) : undefined;
}
