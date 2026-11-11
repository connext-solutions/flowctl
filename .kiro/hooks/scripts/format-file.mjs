/**
 * Kiro PostToolUse(fs_write|str_replace|fs_append) / PostFileSave adapter: formats the edited
 * TypeScript file with oxfmt and lints it with oxlint, so style problems surface on the edit
 * instead of at commit time.
 *
 * @remarks Mirrors `.claude/hooks/format-file.mjs` but reads Kiro's hook stdin shape. Formatting is
 *   applied silently; lint errors go to stderr. Uses the repo's own binaries in `node_modules/.bin`;
 *   does nothing before `bun install`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = process.env.KIRO_PROJECT_DIR ?? process.cwd();

const raw = readFileSync(0, 'utf8');
let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}
const input = payload.tool_input ?? payload.toolInput ?? payload.input ?? payload;
const file = resolve(String(input?.path ?? input?.file_path ?? input?.targetFile ?? payload.filePath ?? payload.path ?? ''));
const rel = relative(root, file);
if (!/^packages\/[^/]+\/(src|test)\/.+\.ts$/.test(rel) || !existsSync(file)) process.exit(0);

const bin = (name) => join(root, 'node_modules', '.bin', name);
if (!existsSync(bin('oxfmt'))) process.exit(0);
spawnSync(bin('oxfmt'), ['--write', rel], { cwd: root });
const lint = spawnSync(bin('oxlint'), [rel], { cwd: root, encoding: 'utf8' });
if (lint.status !== 0) process.stderr.write(`oxlint on ${rel}:\n${(lint.stdout + lint.stderr).trim()}`);
process.exit(0);
