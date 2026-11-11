import { type FileTable, lookup, type ReadFile } from './files.js';
import { type JudgeFail, fail, type ShellWord } from './types.js';

/**
 * The scratch directory of the snapshot (ADR 0021 Amendment 2026-11-02 section 2, owner decision taken at
 * its recommended default): empty at the start of each run, the only place a hook may write.
 */
export const SCRATCH = '.hook-tmp';

/** What every judge of one closure pass shares. */
export interface JudgeCtx {
  files: FileTable;
  /** Every closure file from the first pass; `undefined` during that pass. */
  closurePaths: ReadonlySet<string> | undefined;
  /** Whether an interpreter named by a `#!` line exists as a regular executable file. */
  interpreterOk: (path: string) => boolean;
  /** Which allowlist judges: ADR 0021's (`hook`) or the narrower one of a destructive confirmation (`confirm`). */
  purpose: 'hook' | 'confirm';
}

type Lexical =
  | { ok: true; norm: string; devNull: boolean }
  | { ok: false; fail: JudgeFail };

/** True when `text` holds a C0 control character or DEL. */
export const hasControl = (text: string): boolean =>
  [...text].some((c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

/**
 * Step 3 of the path decision order (ADR 0021 Amendment 2026-11-02 section 2): shape, then containment,
 * then normalisation (split on `/`, drop empty and `.` components).
 */
export function lexical(w: ShellWord): Lexical {
  const t = w.text;
  if (t === '/dev/null') return { ok: true, norm: t, devNull: true };
  if (
    t === '' ||
    Buffer.byteLength(t) > 4096 ||
    hasControl(t) ||
    t.normalize('NFC') !== t ||
    t.endsWith('/')
  )
    return { ok: false, fail: fail('operand_shape', w.pos, t) };
  const parts = t.split('/').filter((p) => p !== '' && p !== '.');
  if (t.startsWith('/') || parts.includes('..'))
    return { ok: false, fail: fail('outside_flows_root', w.pos, t) };
  return { ok: true, norm: parts.join('/'), devNull: false };
}

/**
 * Whether `norm` names the scratch directory (`'root'`) or something under it (`'inside'`), comparing its
 * first component case-insensitively: on a case-insensitive filesystem `.HOOK-TMP` is the scratch directory.
 */
function scratch(norm: string): 'root' | 'inside' | undefined {
  const [first = '', ...rest] = norm.split('/');
  if (first.normalize('NFC').toLowerCase() !== SCRATCH) return undefined;
  return rest.length === 0 ? 'root' : 'inside';
}

/** Writes need the exact spelling: a case variant is not the scratch directory on a case-sensitive filesystem. */
const writableScratch = (norm: string): boolean =>
  norm.startsWith(`${SCRATCH}/`);

/**
 * Class R: an existing regular file under the flows root, hashed into `files`; a file that is not a shell
 * script is still hashed and makes the command `not_shell_script`.
 *
 * @param devNull whether the exact word `/dev/null` passes (only as a `<` source).
 */
export function classRead(
  ctx: JudgeCtx,
  w: ShellWord,
  devNull: boolean,
): JudgeFail | undefined {
  const got = readFile(ctx, w, devNull);
  if (got === undefined || 'reason' in got) return got;
  return got.kind === 'script'
    ? undefined
    : fail('not_shell_script', w.pos, w.text);
}

/**
 * Resolves a class R word to its file without judging its kind: callees and `cp`/`cat` operands use it.
 *
 * @returns the file, `undefined` for a passing `/dev/null`, or the failure.
 */
export function readFile(
  ctx: JudgeCtx,
  w: ShellWord,
  devNull: boolean,
): ReadFile | JudgeFail | undefined {
  const l = lexical(w);
  if (!l.ok) return l.fail;
  if (l.devNull)
    return devNull ? undefined : fail('outside_flows_root', w.pos, w.text);
  if (scratch(l.norm) === 'root') return fail('limit_exceeded', w.pos, w.text);
  if (scratch(l.norm) === 'inside') return fail('missing_file', w.pos, w.text);
  const node = lookup(ctx.files.root, l.norm);
  if (node.kind === 'missing') return fail('missing_file', w.pos, w.text);
  if (node.kind === 'symlink') return fail('symlink', w.pos, w.text);
  if (node.kind === 'dir') return fail('limit_exceeded', w.pos, w.text);
  if (node.kind === 'other') return fail('operand_shape', w.pos, w.text);
  const file = ctx.files.read(l.norm, node.st);
  return typeof file === 'string' ? fail(file, w.pos, w.text) : file;
}

/**
 * Class W: a path the hook may write. A closure file (exact normalised spelling) is
 * `writes_closure_file`; anything outside the scratch directory is `outside_flows_root`; the scratch
 * directory itself exists, so writing it is `limit_exceeded`.
 *
 * @remarks The order follows the tests of ADR 0021 Amendment 2026-11-02 section 12 item 2: `./td.sh` written
 *   by `setup` and run by `teardown` is `writes_closure_file`, `./A.SH` beside `./a.sh` is
 *   `outside_flows_root`. Writes under the scratch directory never reach a closure file, because no closure
 *   file is read from there in any letter case ({@link scratch}); so the lower-cased and inode comparisons
 *   of section 2 "Normalisation" have nothing left to catch.
 */
export function classWrite(
  ctx: JudgeCtx,
  w: ShellWord,
  devNull: boolean,
): JudgeFail | undefined {
  const l = lexical(w);
  if (!l.ok) return l.fail;
  if (l.devNull)
    return devNull ? undefined : fail('outside_flows_root', w.pos, w.text);
  if (ctx.closurePaths?.has(l.norm) === true)
    return fail('writes_closure_file', w.pos, w.text);
  if (scratch(l.norm) === 'root') return fail('limit_exceeded', w.pos, w.text);
  if (!writableScratch(l.norm))
    return fail('outside_flows_root', w.pos, w.text);
  return undefined;
}

/**
 * Class T: the path operand of `test` and `[`. Never followed; a symlink anywhere is `symlink`, a missing
 * component means "absent" and passes, an existing regular file is hashed.
 */
export function classTest(ctx: JudgeCtx, w: ShellWord): JudgeFail | undefined {
  const l = lexical(w);
  if (!l.ok) return l.fail;
  if (l.devNull || scratch(l.norm) !== undefined) return undefined;
  const node = lookup(ctx.files.root, l.norm);
  if (node.kind === 'symlink') return fail('symlink', w.pos, w.text);
  if (node.kind === 'other') return fail('operand_shape', w.pos, w.text);
  if (node.kind !== 'file') return undefined;
  const file = ctx.files.read(l.norm, node.st);
  return typeof file === 'string' ? fail(file, w.pos, w.text) : undefined;
}
