/**
 * Reasons a simple command is `uncovered` (ADR 0021 Amendment 2026-11-02, "Reason vocabulary"). A failing
 * command gets exactly one: that of its first failing word in source order.
 */
export type UncoveredReason =
  | 'syntax'
  | 'command_not_allowed'
  | 'expansion'
  | 'not_shell_script'
  | 'symlink'
  | 'hardlink'
  | 'outside_flows_root'
  | 'missing_file'
  | 'writes_closure_file'
  | 'limit_exceeded'
  | 'cycle'
  | 'flag_not_allowed'
  | 'operand_shape'
  | 'psql_input'
  | 'curl_input'
  | 'url_scheme'
  | 'url_glob'
  | 'printf_format'
  | 'interpreter_missing';

/**
 * The quote state of one character of a word (ADR 0021 Amendment 2026-11-02 section 1): `U` unquoted,
 * `S` single-quoted, `D` double-quoted, `E` escaped by a backslash.
 */
export type QuoteState = 'U' | 'S' | 'D' | 'E';

/** One word after quote removal; `raw` is its source text, `pos` its place in the command's source. */
export interface ShellWord {
  text: string;
  chars: { c: string; s: QuoteState }[];
  raw: string;
  pos: number;
}

/** A file redirection (`<`, `>`, `>>`), or one of the allowed fd duplications (`2>&1`, `1>&2`, `>&2`). */
export type ShellRedirection =
  | { kind: 'file'; op: '<' | '>' | '>>'; target: ShellWord }
  | { kind: 'dup' };

/** A simple command: its words, its redirections, and whether a pipe feeds its stdin. */
export interface ShellCommand {
  words: ShellWord[];
  redirs: ShellRedirection[];
  stdinFromPipe: boolean;
  line: number;
}

/**
 * The first failure of one command. `pos` orders failures in source order; a per-command check (the
 * operand count) uses `Infinity` so any failing word wins over it.
 */
export interface JudgeFail {
  reason: UncoveredReason;
  pos: number;
  subject: string;
}

/** A file the closure binds: its path relative to the flows root, the sha256 of its bytes, and its kind. */
export interface ClosureFile {
  path: string;
  sha256: string;
  kind: 'script' | 'data';
}

/**
 * One uncovered command: the reason, where it is (`setup`, `teardown` or a closure file's path) and what
 * failed (the word for hook text, `line N` for a file, so no file content is recorded).
 */
export interface Uncovered {
  reason: UncoveredReason;
  in: string;
  subject: string;
}

/**
 * The closure of a hook (ADR 0021 Amendment 2026-11-01 section 2): every file it binds, every uncovered
 * command, whether the owner can be shown everything (no refused byte, no file over 256 KiB), and whether
 * files the hook may read or run are left out of the digest.
 *
 * @remarks `unbound` is true whenever any command is uncovered: the walk does not follow what an uncovered
 *   command reads or runs, and it stops at the step cap, the depth limit and the file limits. The consent
 *   screen must say so and the entry records it (section 2.8).
 */
export interface Closure {
  files: ClosureFile[];
  uncovered: Uncovered[];
  consentable: boolean;
  unbound: boolean;
}

/** Builds a {@link JudgeFail}. */
export const fail = (
  reason: UncoveredReason,
  pos: number,
  subject: string,
): JudgeFail => ({ reason, pos, subject });

/** The earliest failure in source order; at the same position the expansion step comes first. */
export function earliest(
  fails: readonly (JudgeFail | undefined)[],
): JudgeFail | undefined {
  let best: JudgeFail | undefined;
  for (const f of fails) {
    if (f === undefined) continue;
    if (
      best === undefined ||
      f.pos < best.pos ||
      (f.pos === best.pos && f.reason === 'expansion')
    )
      best = f;
  }
  return best;
}
