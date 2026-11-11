import type { ReadFile } from './files.js';
import { judgeCurl, judgePsql } from './net.js';
import { classRead, classWrite, type JudgeCtx, readFile } from './paths.js';
import { shellScript } from './files.js';
import {
  earliest,
  fail,
  type JudgeFail,
  type ShellCommand,
  type ShellWord,
} from './types.js';
import {
  BUILTINS,
  isFileUtility,
  judgeBuiltin,
  judgeFileUtility,
} from './utilities.js';

/** One judged command: its first failure, and the closure script it calls, if any. */
export interface Judged {
  fail: JudgeFail | undefined;
  callee: ReadFile | undefined;
}

const GLOB = new Set(['*', '?', '[', '{']);

/** Commands a hook of a destructive confirmation may not use: they can reach shared data or other hosts. */
const NOT_FOR_CONFIRM = new Set(['curl', 'psql', 'rm', 'mv', 'cp']);

/**
 * Step 1 of the decision order: the quote-state table of ADR 0021 Amendment 2026-11-02 section 1.
 *
 * @remarks The one exemption is a command word whose whole text is an unquoted `[`.
 */
export function expansion(
  w: ShellWord,
  commandWord: boolean,
): JudgeFail | undefined {
  if (commandWord && w.raw === '[') return undefined;
  for (const [k, { c, s }] of w.chars.entries()) {
    const prev = w.chars[k - 1];
    const tilde =
      c === '~' &&
      s === 'U' &&
      (k === 0 || (prev?.s === 'U' && (prev.c === '=' || prev.c === ':')));
    if (
      ((c === '$' || c === '`') && (s === 'U' || s === 'D')) ||
      (GLOB.has(c) && s === 'U') ||
      tilde
    )
      return fail('expansion', w.pos, w.text);
  }
  return undefined;
}

/**
 * Judges one simple command against the allowlist (ADR 0021 Amendment 2026-11-01 section 2.2): a builtin,
 * a listed utility in an allowed shape, or a closure shell script. Returns the earliest failure in source
 * order and, for a script, the file it calls.
 *
 * @remarks A command word with an unquoted `=` is an assignment (`A=./x cmd`, bash's `A+=./x`): the shell
 *   runs the next word, so it is `command_not_allowed` before any other check (section 2.3).
 */
export function judgeCommand(ctx: JudgeCtx, cmd: ShellCommand): Judged {
  const [head] = cmd.words;
  if (head === undefined)
    return { fail: fail('syntax', 0, ''), callee: undefined };
  const targets = cmd.redirs.flatMap((r) =>
    r.kind === 'file' ? [r.target] : [],
  );
  const expanded = earliest(
    [...cmd.words, ...targets].map((w) => expansion(w, w === head)),
  );
  const redirected = earliest(
    cmd.redirs.map((r) =>
      r.kind === 'dup'
        ? undefined
        : r.op === '<'
          ? classRead(ctx, r.target, true)
          : classWrite(ctx, r.target, true),
    ),
  );
  const name = head.text;
  let callee: ReadFile | undefined;
  let own: JudgeFail | undefined;
  if (
    head.chars.some((c) => c.c === '=' && c.s === 'U') ||
    (ctx.purpose === 'confirm' && NOT_FOR_CONFIRM.has(name))
  )
    own = fail('command_not_allowed', head.pos, name);
  else if (BUILTINS.has(name)) own = judgeBuiltin(ctx, cmd);
  else if (isFileUtility(name)) own = judgeFileUtility(ctx, cmd);
  else if (name === 'psql') own = judgePsql(cmd);
  else if (name === 'curl') own = judgeCurl(cmd);
  else if (name.includes('/')) {
    const got = readFile(ctx, head, false);
    if (got === undefined) own = fail('outside_flows_root', head.pos, name);
    else if ('reason' in got) own = got;
    else {
      const kind = shellScript(got.bytes);
      if (kind === undefined) own = fail('not_shell_script', head.pos, name);
      else {
        callee = got;
        if (kind === 'dash' && !ctx.interpreterOk('/bin/dash'))
          own = fail('interpreter_missing', head.pos, name);
      }
    }
  } else own = fail('command_not_allowed', head.pos, name);
  return { fail: earliest([expanded, redirected, own]), callee };
}
