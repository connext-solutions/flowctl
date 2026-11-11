/**
 * Kiro PreToolUse(fs_write|str_replace|fs_append) adapter: refuses a new `export` whose name is
 * already exported by another source file under `packages/*​/src`, so agents import the existing
 * symbol instead of writing a second one.
 *
 * @remarks Mirrors `.claude/hooks/dup-export.mjs` but reads Kiro's hook stdin shape. Escape hatch:
 *   a `dup-ok: <reason>` comment in the written text. On a hit, emits Kiro's PreToolUse `ask`
 *   decision and exits 2 (block) with the reason on stderr.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = process.env.KIRO_PROJECT_DIR ?? process.cwd();

const raw = readFileSync(0, 'utf8');
let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}
const input = payload.tool_input ?? payload.toolInput ?? payload.input ?? payload;
const file = resolve(String(input?.path ?? input?.file_path ?? input?.targetFile ?? ''));
const body = String(input?.text ?? input?.newStr ?? input?.content ?? input?.new_string ?? '');
if (!file.endsWith('.ts') || !file.startsWith(join(root, 'packages')) || body.includes('dup-ok')) process.exit(0);

const DECL = /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
const names = new Set([...body.matchAll(DECL)].map((m) => m[1]));
if (names.size === 0) process.exit(0);

const hits = [];
for (const pkg of readdirSync(join(root, 'packages'))) {
  const src = join(root, 'packages', pkg, 'src');
  let entries;
  try {
    entries = readdirSync(src, { recursive: true });
  } catch {
    continue;
  }
  for (const rel of entries) {
    const path = join(src, String(rel));
    if (!path.endsWith('.ts') || path === file) continue;
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(DECL))
      if (names.has(m[1])) hits.push(`${m[1]}  ->  ${path.slice(root.length + 1)}:${text.slice(0, m.index).split('\n').length}`);
  }
}
if (hits.length === 0) process.exit(0);

const reason = `Already exported elsewhere:\n${hits.slice(0, 12).join('\n')}\n\nImport it instead. If a separate symbol is really needed, rename it or add a \`// dup-ok: <reason>\` line above the export.`;
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason },
  }),
);
process.stderr.write(reason);
process.exit(2);
