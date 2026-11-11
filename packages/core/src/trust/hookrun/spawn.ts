import { spawn } from 'node:child_process';

/** What a hook run reports: whether it exited 0, and the last 2000 characters of its output. */
export interface HookOutput {
  ok: boolean;
  output: string;
}

const OUTPUT_TAIL = 2000;
/** After the shell exits, how long to wait for its pipes to drain before giving up on them. */
const DRAIN_MS = 100;

/**
 * Runs one hook text with `/bin/sh -c` (absolute) in `cwd`, with exactly `env`, stdin from `/dev/null`, in
 * its own process group; the whole group is killed when the hook ends or times out, so no background process
 * outlives the snapshot (ADR 0021 Amendment 2026-11-01 section 2.7).
 *
 * @remarks Resolves when the shell exits, not when every pipe closes, so a process the hook leaves behind
 *   cannot hold the run.
 */
export function spawnHook(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<HookOutput> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let done = false;
    const add = (d: Buffer): void => {
      output = (output + d.toString()).slice(-OUTPUT_TAIL);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const finish = (ok: boolean, extra = ''): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killGroup();
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ok, output: (output + extra).trim() });
    };
    const timer = setTimeout(
      () => finish(false, `\n[flowctl] hook timed out after ${timeoutMs}ms`),
      timeoutMs,
    );
    child.on('exit', (code) => {
      const ok = code === 0;
      child.on('close', () => finish(ok));
      setTimeout(() => finish(ok), DRAIN_MS);
    });
    child.on('error', (e) => finish(false, e.message));
  });
}
