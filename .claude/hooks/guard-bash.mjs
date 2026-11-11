/**
 * PreToolUse(Bash): blocks commands that break the repo's rules and asks before destructive ones.
 *
 * @remarks Rules: AGENTS.md (Bun only as package manager, hooks are never skipped), the secrets
 *   policy (the TypeSafe key in `spike/.env` is never printed; load it with `set -a; . spike/.env`)
 *   and session files (`.auth/`) are never read. Heredoc bodies are ignored. Flags are matched with
 *   quoted strings blanked, so a commit message mentioning `-n` passes; paths are matched with quoted
 *   prose (anything with a space) blanked and other quote characters removed, so `spike/.e""nv` still
 *   counts as `spike/.env` while a PR body mentioning `.auth/` does not. Only a path *into* `.auth/`
 *   is denied. Cases: `guard-bash.test.mjs`.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** A quoted string run as code: its prose is never blanked. */
const SHELL_STRING = /\b(sh|bash|zsh)\s+-\w*c\b|\beval\b/;
const SOURCES_ENV = /(^|[;&|]\s*)(\.|source)\s+spike\/\.env\b/;
const DUMPS = /(^|[;&|(]\s*)((env|printenv|export\s+-p|cat|base64|xxd|od|less|more|head|tail|strings|bat)($|[;&|\s<>])|set\s*($|[;&|]))/;

const DENY = [
  [({ flags }) => /\bbun\s+--bun\b/.test(flags), 'Never run under the Bun runtime: Playwright is flaky there (ADR 0018). Use `bun run <script>`.'],
  [({ flags }) => /\bbun\s+test\b/.test(flags), '`bun test` is not the test runner here. Use `bun run test`, `test:unit`, `test:browser`.'],
  [
    ({ flags }) =>
      /\bgit\b[^|;&]*\s--no-verify\b/.test(flags) ||
      /\bgit\b[^|;&]*\bcommit\b[^|;&]*\s-[a-zA-Z]*n[a-zA-Z]*(\s|$)/.test(flags) ||
      /\bgit\b[^|;&]*-c\s*core\.hooksPath/.test(flags),
    'Git hooks are the local gate; do not skip them unless the user asked in this conversation.',
  ],
  [
    ({ flags }) =>
      /\bgit\s+push\b/.test(flags) &&
      (/\s--force(?!-with-lease)(\s|=|$)/.test(flags) || /\s-f(\s|$)/.test(flags) || /\s\+\S/.test(flags)),
    'No force push. Use --force-with-lease on your own branch, never on main.',
  ],
  [
    ({ paths }) => /spike\/\.env\b/.test(paths) && (!SOURCES_ENV.test(paths) || DUMPS.test(paths)),
    'Never print or copy .env files. Load them with `set -a; . spike/.env; set +a` and run the command that needs them.',
  ],
  [
    ({ paths }) => /\b(cat|less|more|head|tail|bat|grep|rg|awk|sed|xxd|strings|cp|scp)\b[^|;&]*(^|[\s/])\.env(?![.\w])/.test(paths),
    'Never print or copy .env files. Load them with `set -a; . spike/.env; set +a`.',
  ],
  [
    ({ paths }) =>
      /\b(echo|printf)\b[^|;&]*\$\{?TYPESAFE_API_KEY/.test(paths) ||
      /\bprintenv\b[^|;&]*(TYPESAFE|KEY|TOKEN|SECRET|PASSWORD)/.test(paths),
    'Never print the TypeSafe key or other secrets.',
  ],
  [({ paths }) => /(^|[\s/=<])\.auth\/\S/.test(paths), 'Session files under .auth/ hold live cookies; never read or copy them.'],
];
const ASK = [
  [({ flags }) => /\bgit\s+reset\s+--hard\b/.test(flags), 'Discards uncommitted work.'],
  [({ flags }) => /\bgit\s+(clean\s+-[a-z]*f|checkout\s+--\s+\.)/.test(flags), 'Deletes or reverts working-tree files.'],
  [
    ({ flags }) =>
      /\brm\b/.test(flags) &&
      (/\s--recursive\b/.test(flags) || /\brm\b[^|;&]*\s-[a-zA-Z]*[rR]/.test(flags)) &&
      (/\s--force\b/.test(flags) || /\brm\b[^|;&]*\s-[a-zA-Z]*f/.test(flags)),
    'Recursive delete.',
  ],
  [({ flags }) => /\bgit\s+push\b[^|;&]*(\s|:)(refs\/heads\/)?main(\s|$)/.test(flags), 'Pushes to main directly; main takes PRs.'],
  [
    ({ flags }) => /\bflowctl\s+trust\b|\bbin\.js\s+trust\b|--trust-hooks\b|\bFLOWCTL_TRUST_HOOKS\s*=/.test(flags),
    "Consents to running a flow's shell hooks on this machine; the user decides after reviewing setup/teardown.",
  ],
];

/**
 * Decides one Bash command.
 *
 * @returns `deny` or `ask` with the reason shown to the agent, or `undefined` to let it run.
 */
export function decide(cmd) {
  const code = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\1(?=\n|$)/g, '<<$1');
  const views = {
    flags: code.replace(/"[^"]*"|'[^']*'/g, '""'),
    paths: (SHELL_STRING.test(code) ? code : code.replace(/"[^"]*\s[^"]*"|'[^']*\s[^']*'/g, '""')).replace(/["']/g, ''),
  };
  const hit = (rules) => rules.find(([test]) => test(views));
  const deny = hit(DENY);
  if (deny) return { decision: 'deny', reason: deny[1] };
  const ask = hit(ASK);
  if (ask) return { decision: 'ask', reason: ask[1] };
  return undefined;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { tool_input: input } = JSON.parse(readFileSync(0, 'utf8'));
  const result = decide(String(input?.command ?? ''));
  if (result)
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: result.decision,
          permissionDecisionReason: result.reason,
        },
      }),
    );
}
