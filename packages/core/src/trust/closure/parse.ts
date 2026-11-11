import { type LexToken, tokenize } from './lexer.js';
import type { ShellCommand } from './types.js';

/** Lexed hook text: its simple commands, or the first syntax problem. */
export type Lexed =
  | { ok: true; commands: ShellCommand[] }
  | { ok: false; detail: string };

type Connector = ';' | '&&' | '||' | '|' | 'NL' | 'start';

/**
 * Splits shell text into simple commands without executing or expanding anything, accepting only the
 * subset of ADR 0021 Amendment 2026-11-02 section 1: `;`, `&&`, `||`, `|`, newline, and the redirections
 * `<`, `>`, `>>` (prefix 0, 1 or 2) and `2>&1`, `1>&2`, `>&2`. Anything else is a syntax problem, as is an
 * empty command, a redirection without a target and a command made only of redirections.
 *
 * @example lexShell('psql -X -c "select 1" && ./seed.sh') // two commands
 */
export function lexShell(src: string): Lexed {
  const tokens = tokenize(src);
  return typeof tokens === 'string'
    ? { ok: false, detail: tokens }
    : parse(tokens);
}

function parse(tokens: LexToken[]): Lexed {
  const commands: ShellCommand[] = [];
  let cur: ShellCommand | undefined;
  let last: Connector = 'start';
  const joins = (): boolean => last === '&&' || last === '||' || last === '|';
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k];
    if (tok === undefined) break;
    if (tok.t === 'op') {
      if (cur === undefined) {
        if (tok.op === 'NL' && joins()) continue;
        if (tok.op !== 'NL')
          return { ok: false, detail: `empty command before ${tok.op}` };
      } else {
        if (cur.words.length === 0)
          return { ok: false, detail: 'redirection without a command' };
        commands.push(cur);
        cur = undefined;
      }
      last = tok.op;
      continue;
    }
    cur ??= {
      words: [],
      redirs: [],
      stdinFromPipe: last === '|',
      line: tok.line,
    };
    if (tok.t === 'word') cur.words.push(tok.word);
    else if (tok.t === 'dup') cur.redirs.push({ kind: 'dup' });
    else {
      const target = tokens[k + 1];
      if (target?.t !== 'word')
        return { ok: false, detail: `${tok.op} without a target` };
      cur.redirs.push({ kind: 'file', op: tok.op, target: target.word });
      k++;
    }
  }
  if (cur === undefined)
    return joins()
      ? { ok: false, detail: `missing command after ${last}` }
      : { ok: true, commands };
  if (cur.words.length === 0)
    return { ok: false, detail: 'redirection without a command' };
  commands.push(cur);
  return { ok: true, commands };
}
