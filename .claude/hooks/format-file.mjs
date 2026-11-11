/**
 * PostToolUse(Write|Edit): formats the edited TypeScript file with oxfmt and lints it with oxlint, so
 * style problems surface on the edit instead of at commit time.
 *
 * @remarks Lint errors are fed back to Claude as a blocking reason; formatting is applied silently.
 *   Uses the repo's own binaries in `node_modules/.bin`; does nothing before `bun install`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const { tool_input: input } = JSON.parse(readFileSync(0, 'utf8'));
const file = resolve(String(input?.file_path ?? ''));
const rel = relative(root, file);
if (!/^packages\/[^/]+\/(src|test)\/.+\.ts$/.test(rel) || !existsSync(file)) process.exit(0);

const bin = (name) => join(root, 'node_modules', '.bin', name);
if (!existsSync(bin('oxfmt'))) process.exit(0);
spawnSync(bin('oxfmt'), ['--write', rel], { cwd: root });
const lint = spawnSync(bin('oxlint'), [rel], { cwd: root, encoding: 'utf8' });
if (lint.status !== 0)
  process.stdout.write(JSON.stringify({ decision: 'block', reason: `oxlint on ${rel}:\n${(lint.stdout + lint.stderr).trim()}` }));
