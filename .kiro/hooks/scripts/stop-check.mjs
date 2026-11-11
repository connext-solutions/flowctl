/**
 * Kiro Stop adapter: when the working tree has uncommitted changes under `packages/`, `scripts/` or
 * `package.json`, runs `bun run check` before the agent stops, so "done" never means a red lint,
 * typecheck, architecture gate or unit test.
 *
 * @remarks Mirrors `.claude/hooks/stop-check.mjs`. Any dirty file counts, not only this session's
 *   edits. On a re-entrant stop (`stop_hook_active`) it exits 0 to avoid a loop. On failure it writes
 *   the tail of the output to stderr and exits 2 to block the stop. Uses the repo's Node via nvm.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = process.env.KIRO_PROJECT_DIR ?? process.cwd();

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  payload = {};
}
if (payload.stop_hook_active || payload.stopHookActive) process.exit(0);

const changed = execFileSync('git', ['status', '--porcelain', '--', 'packages', 'scripts', 'package.json'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
if (changed === '') process.exit(0);

const run = spawnSync(
  'sh',
  ['-c', '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null && nvm use >/dev/null 2>&1; bun run check'],
  { cwd: root, encoding: 'utf8' },
);
if (run.status !== 0) {
  const out = `${run.stdout}\n${run.stderr}`.trim().split('\n').slice(-40).join('\n');
  process.stderr.write(`bun run check failed; fix it before stopping:\n${out}`);
  process.exit(2);
}
process.exit(0);
