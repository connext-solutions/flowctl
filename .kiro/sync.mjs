/**
 * Rebuilds `.kiro/steering/` from the Claude Code sources, so the rules and skills have one home
 * (`.claude/rules/*.md`, `.claude/skills/<name>/SKILL.md`) and Kiro never reads a stale copy.
 *
 * A rule's `paths:` list becomes `inclusion: fileMatch` with one pattern (several become a brace glob);
 * `paths: ["**"]` becomes `inclusion: always`. A skill becomes `skill-<name>.md` with `inclusion: auto`
 * and its own `name` and `description`. Bodies are copied unchanged.
 *
 * @example
 *   node .kiro/sync.mjs           # rewrite .kiro/steering
 *   node .kiro/sync.mjs --check   # exit 1 and list the files that differ or have no source
 */
import { readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const out = join(root, '.kiro', 'steering');
const check = process.argv.includes('--check');

/** Splits a markdown file into its frontmatter lines and the body after the closing `---`. */
const split = (text, file) => {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (m === null) throw new Error(`${file}: no frontmatter`);
  return { head: m[1].split('\n'), body: m[2] };
};

/** The Kiro frontmatter for a Claude rule's `paths:` list. */
const ruleHead = (head, file) => {
  const paths = head.filter((l) => l.startsWith('  - ')).map((l) => l.slice(4).replace(/^"(.*)"$/, '$1'));
  if (paths.length === 0) throw new Error(`${file}: no paths`);
  if (paths.length === 1 && paths[0] === '**') return ['inclusion: always'];
  const pattern = paths.length === 1 ? paths[0] : `{${paths.join(',')}}`;
  return ['inclusion: fileMatch', `fileMatchPattern: '${pattern}'`];
};

const wanted = new Map();
const rules = join(root, '.claude', 'rules');
for (const f of readdirSync(rules).filter((n) => n.endsWith('.md')).sort()) {
  const { head, body } = split(readFileSync(join(rules, f), 'utf8'), f);
  wanted.set(f, `---\n${ruleHead(head, f).join('\n')}\n---\n${body}`);
}
const skills = join(root, '.claude', 'skills');
for (const s of readdirSync(skills).sort()) {
  const file = join(skills, s, 'SKILL.md');
  if (!existsSync(file)) continue;
  const { head, body } = split(readFileSync(file, 'utf8'), file);
  wanted.set(`skill-${s}.md`, `---\ninclusion: auto\n${head.join('\n')}\n---\n${body}`);
}

const present = readdirSync(out).filter((n) => n.endsWith('.md'));
const drift = [
  ...[...wanted].filter(([n, t]) => !present.includes(n) || readFileSync(join(out, n), 'utf8') !== t).map(([n]) => n),
  ...present.filter((n) => !wanted.has(n)).map((n) => `${n} (no source)`),
];
if (check) {
  if (drift.length > 0) {
    process.stderr.write(`.kiro/steering is out of date; run node .kiro/sync.mjs:\n${drift.join('\n')}\n`);
    process.exit(1);
  }
  process.exit(0);
}
for (const [n, t] of wanted) writeFileSync(join(out, n), t);
for (const n of present.filter((p) => !wanted.has(p))) rmSync(join(out, n));
process.stdout.write(drift.length === 0 ? 'up to date\n' : `updated:\n${drift.join('\n')}\n`);
