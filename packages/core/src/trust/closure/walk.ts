import { realpathSync, statSync } from 'node:fs';
import { TrustError } from '../errors.js';
import { FileTable, type ReadFile } from './files.js';
import { judgeCommand } from './judge.js';
import { textAllowed, bytesAllowed } from './lexer.js';
import { type Lexed, lexShell } from './parse.js';
import type { JudgeCtx } from './paths.js';
import type { Closure, Uncovered } from './types.js';

/** ADR 0021 Amendment 2026-11-02 section 7. */
const MAX_DEPTH = 5;
const MAX_STEPS = 10_000;

/** Inputs of {@link computeClosure}. */
export interface ClosureOptions {
  /** The flows root (from the store's `roots`, purpose `flows`); every path is relative to it. */
  root: string;
  setup?: string;
  teardown?: string;
  /** Test seam for the `#!/bin/dash` check (section 8); defaults to `stat` of the real path. */
  interpreterOk?: (path: string) => boolean;
  /**
   * `confirm` judges for a destructive confirmation (ADR 0024 section 5): the narrower allowlist, where `curl`,
   * `psql`, `rm`, `mv` and `cp` are `command_not_allowed`. Default `hook`.
   */
  purpose?: 'hook' | 'confirm';
}

const realInterpreter = (path: string): boolean => {
  try {
    const st = statSync(path);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/**
 * Computes the closure of a hook's `setup` and `teardown` (ADR 0021 Amendment 2026-11-01 section 2,
 * refined by Amendment 2026-11-02): the files it binds, the commands that are `uncovered`, and whether
 * everything can be shown at consent. It is the one closure function the hook, confirm and classify digests
 * share.
 *
 * @remarks Two passes: the first finds every closure file, the second judges writes against that set, so a
 *   write in `setup` to a script `teardown` runs is `writes_closure_file`. The call graph is enumerated per
 *   chain with no "visited" skip (depth is the longest chain); a callee already on the chain is `cycle`; more
 *   than 10 000 chain steps is `limit_exceeded`; `cycle` takes precedence over the walk's `limit_exceeded`.
 * @example computeClosure({ root: '/abs/flows', setup: './seed.sh', teardown: 'rm -f ./.hook-tmp/x' })
 * @throws {TrustError} `trust_entry_invalid` when the flows root cannot be resolved.
 */
export function computeClosure(o: ClosureOptions): Closure {
  const first = pass(o, undefined);
  return pass(o, new Set(first.files.map((f) => f.path)));
}

function pass(
  o: ClosureOptions,
  closurePaths: ReadonlySet<string> | undefined,
): Closure {
  const files = new FileTable(flowsRoot(o.root));
  const ctx: JudgeCtx = {
    files,
    closurePaths,
    interpreterOk: o.interpreterOk ?? realInterpreter,
    purpose: o.purpose ?? 'hook',
  };
  const uncovered: Uncovered[] = [];
  const keys = new Set<string>();
  const add = (u: Uncovered): void => {
    const key = `${u.in}\u0000${u.subject}\u0000${u.reason}`;
    if (keys.has(key)) return;
    keys.add(key);
    uncovered.push(u);
  };
  let consentable = true;
  let steps = 0;
  const cycles: Uncovered[] = [];
  const limits: Uncovered[] = [];
  const lexed = new Map<string, Lexed>();

  const visit = (
    where: string,
    text: Lexed,
    depth: number,
    chain: readonly string[],
  ): void => {
    if (!text.ok) {
      add({
        reason: 'syntax',
        in: where,
        subject: depth > 0 ? 'the script cannot be parsed' : text.detail,
      });
      return;
    }
    const inFile = depth > 0;
    for (const cmd of text.commands) {
      const j = judgeCommand(ctx, cmd);
      if (j.fail !== undefined)
        add({
          reason: j.fail.reason,
          in: where,
          subject: inFile ? `line ${cmd.line}` : j.fail.subject,
        });
      const callee = j.callee;
      if (callee === undefined || steps > MAX_STEPS) continue;
      if (++steps > MAX_STEPS) {
        limits.push({
          reason: 'limit_exceeded',
          in: where,
          subject: 'more than 10000 call-chain steps',
        });
        continue;
      }
      if (chain.includes(callee.id)) {
        cycles.push({ reason: 'cycle', in: where, subject: callee.path });
        continue;
      }
      if (depth + 1 > MAX_DEPTH) {
        limits.push({
          reason: 'limit_exceeded',
          in: where,
          subject: `${callee.path} is deeper than ${MAX_DEPTH}`,
        });
        continue;
      }
      visit(callee.path, lexFile(callee), depth + 1, [...chain, callee.id]);
    }
  };

  const lexFile = (f: ReadFile): Lexed => {
    const known = lexed.get(f.id);
    if (known !== undefined) return known;
    const ok = bytesAllowed(f.bytes);
    if (!ok) consentable = false;
    const result: Lexed = ok
      ? lexShell(f.bytes.toString('utf8'))
      : {
          ok: false,
          detail: 'a byte refused by ADR 0021 Amendment 2026-11-02 section 1',
        };
    lexed.set(f.id, result);
    return result;
  };

  for (const [where, text] of [
    ['setup', o.setup],
    ['teardown', o.teardown],
  ] as const) {
    if (text === undefined) continue;
    if (!textAllowed(text)) {
      consentable = false;
      add({ reason: 'syntax', in: where, subject: 'a refused byte' });
      continue;
    }
    visit(where, lexShell(text), 0, []);
  }
  for (const u of cycles.length > 0 ? cycles : limits) add(u);
  return {
    files: files.list(),
    uncovered,
    consentable: consentable && files.showable,
    unbound: uncovered.length > 0,
  };
}

/** The real path of the flows root. @throws {TrustError} `trust_entry_invalid` when it cannot be resolved. */
function flowsRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch (e) {
    throw new TrustError(
      'trust_entry_invalid',
      `The flows root ${root} cannot be resolved (${e instanceof Error ? e.message : String(e)}); check the flows root registered in the trust store.`,
    );
  }
}
