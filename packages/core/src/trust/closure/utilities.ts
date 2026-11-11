import { classRead, classTest, classWrite, type JudgeCtx } from './paths.js';
import {
  earliest,
  fail,
  type JudgeFail,
  type ShellCommand,
  type ShellWord,
} from './types.js';

/** The builtins of ADR 0021 Amendment 2026-11-01 section 2.2 a. */
export const BUILTINS = new Set([
  ':',
  'true',
  'false',
  'exit',
  'test',
  '[',
  'echo',
  'printf',
  'wait',
]);

/** Flag letters and operand counts of the file utilities (ADR 0021 Amendment 2026-11-02 section 3). */
const FILE_UTILS: Record<string, { flags: string; min: number; max: number }> =
  {
    cp: { flags: 'fp', min: 2, max: 2 },
    mv: { flags: 'f', min: 2, max: 2 },
    rm: { flags: 'f', min: 1, max: 1 },
    mkdir: { flags: 'p', min: 1, max: 1 },
    touch: { flags: '', min: 1, max: 1 },
    cat: { flags: '', min: 1, max: Number.POSITIVE_INFINITY },
  };

/** Whether `name` is one of the file utilities of section 3, or `sleep`. */
export const isFileUtility = (name: string): boolean =>
  Object.hasOwn(FILE_UTILS, name) || name === 'sleep';

const INT = /^(0|[1-9][0-9]{0,8})$/;
const UNARY_PATH = new Set(['-e', '-f', '-s', '-r', '-w', '-x']);
const NUMERIC = new Set(['-eq', '-ne', '-lt', '-le', '-gt', '-ge']);
const NOT_STR = new Set(['!', '=', '!=', '(', ')']);
const PER_COMMAND = Number.POSITIVE_INFINITY;

/** Judges a builtin's operands (ADR 0021 Amendment 2026-11-02 section 6, and the test grammar of section 2). */
export function judgeBuiltin(
  ctx: JudgeCtx,
  cmd: ShellCommand,
): JudgeFail | undefined {
  const [head, ...args] = cmd.words;
  const name = head?.text ?? '';
  const at = args[0] ?? head;
  const shape = (ok: boolean): JudgeFail | undefined =>
    ok ? undefined : fail('operand_shape', at?.pos ?? 0, at?.text ?? name);
  if (name === 'exit') {
    const v = args[0]?.text;
    return shape(
      args.length === 0 ||
        (args.length === 1 &&
          v !== undefined &&
          /^(0|[1-9][0-9]{0,2})$/.test(v) &&
          Number(v) <= 255),
    );
  }
  if (name === 'wait') return shape(args.length === 0);
  if (name === 'echo')
    return earliest(
      args.map((a, k) =>
        a.raw.includes('\\') || (k === 0 && a.text.startsWith('-'))
          ? fail('operand_shape', a.pos, a.text)
          : undefined,
      ),
    );
  if (name === 'printf') return judgePrintf(args, head);
  if (name === 'test' || name === '[') return judgeTest(ctx, name, args, head);
  return undefined;
}

function judgePrintf(
  args: ShellWord[],
  head: ShellWord | undefined,
): JudgeFail | undefined {
  const [format, ...rest] = args;
  const bad = (w: ShellWord | undefined): JudgeFail =>
    fail('printf_format', w?.pos ?? head?.pos ?? 0, w?.text ?? 'printf');
  if (format === undefined || format.text.startsWith('-')) return bad(format);
  const specs: ('s' | 'd')[] = [];
  const t = format.text;
  for (let i = 0; i < t.length; i++) {
    const c = t.charAt(i);
    if (c !== '%' && c !== '\\') continue;
    const nx = t.charAt(i + 1);
    i++;
    if (c === '%' && (nx === 's' || nx === 'd')) specs.push(nx);
    else if (
      !(c === '%' && nx === '%') &&
      !(c === '\\' && 'nt\\'.includes(nx) && nx !== '')
    )
      return bad(format);
  }
  if (rest.length !== specs.length) return bad(rest[specs.length] ?? format);
  const k = specs.findIndex(
    (s, j) => s === 'd' && !INT.test(rest[j]?.text ?? ''),
  );
  return k === -1 ? undefined : bad(rest[k]);
}

function judgeTest(
  ctx: JudgeCtx,
  name: string,
  args: ShellWord[],
  head: ShellWord | undefined,
): JudgeFail | undefined {
  const refuse = (w: ShellWord | undefined): JudgeFail =>
    fail('flag_not_allowed', w?.pos ?? head?.pos ?? 0, w?.text ?? name);
  let a = args;
  if (name === '[') {
    if (a[a.length - 1]?.text !== ']') return refuse(a[a.length - 1]);
    a = a.slice(0, -1);
  }
  if (a[0]?.text === '!') a = a.slice(1);
  const [x, y, z] = a;
  const str = (w: ShellWord | undefined): boolean =>
    w !== undefined && !w.text.startsWith('-') && !NOT_STR.has(w.text);
  if (
    a.length === 2 &&
    x !== undefined &&
    UNARY_PATH.has(x.text) &&
    y !== undefined
  )
    return classTest(ctx, y);
  if (a.length === 2 && (x?.text === '-z' || x?.text === '-n') && str(y))
    return undefined;
  if (
    a.length === 3 &&
    (y?.text === '=' || y?.text === '!=') &&
    str(x) &&
    str(z)
  )
    return undefined;
  if (
    a.length === 3 &&
    y !== undefined &&
    NUMERIC.has(y.text) &&
    INT.test(x?.text ?? '') &&
    INT.test(z?.text ?? '')
  )
    return undefined;
  return refuse(a[0]);
}

/**
 * Judges `cp`, `mv`, `rm`, `mkdir`, `touch`, `cat` and `sleep`: short flags from the table before the
 * operands, `--` once directly before them, the path class of each operand, and the operand count last.
 */
export function judgeFileUtility(
  ctx: JudgeCtx,
  cmd: ShellCommand,
): JudgeFail | undefined {
  const [head, ...args] = cmd.words;
  const name = head?.text ?? '';
  if (name === 'sleep')
    return args.length === 1 && /^[0-9]{1,3}$/.test(args[0]?.text ?? '')
      ? undefined
      : fail(
          'operand_shape',
          args[0]?.pos ?? PER_COMMAND,
          args[0]?.text ?? name,
        );
  const spec = FILE_UTILS[name];
  if (spec === undefined)
    return fail('command_not_allowed', head?.pos ?? 0, name);
  let i = 0;
  for (; i < args.length; i++) {
    const w = args[i];
    if (w === undefined || !w.text.startsWith('-')) break;
    if (w.text === '--') {
      i++;
      break;
    }
    const letters = w.text.slice(1);
    if (
      !/^[a-zA-Z]+$/.test(letters) ||
      [...letters].some((c) => !spec.flags.includes(c))
    )
      return fail('flag_not_allowed', w.pos, w.text);
  }
  const operands = args.slice(i);
  for (const [k, w] of operands.entries()) {
    if (w.text.startsWith('-')) return fail('flag_not_allowed', w.pos, w.text);
    const f = operandClass(ctx, name, k, w);
    if (f !== undefined) return f;
  }
  if (operands.length < spec.min || operands.length > spec.max)
    return fail('operand_shape', PER_COMMAND, name);
  return undefined;
}

function operandClass(
  ctx: JudgeCtx,
  name: string,
  k: number,
  w: ShellWord,
): JudgeFail | undefined {
  if (name === 'cat' || (name === 'cp' && k === 0))
    return classRead(ctx, w, false);
  return classWrite(ctx, w, false);
}
