/**
 * Kiro PreToolUse(execute_bash) adapter: reuses the rule table in
 * `.claude/hooks/guard-bash.mjs` (`decide`) and translates Kiro's hook
 * stdin/stdout shape to it.
 *
 * @remarks Kiro passes the tool input on stdin; the command lives under a tool-input
 *   field. We try the common shapes. On a deny/ask verdict we emit Kiro's PreToolUse
 *   decision JSON (`permissionDecision` / `permissionDecisionReason`) and exit 0; a deny
 *   also writes the reason to stderr and exits 2 so the tool is blocked even if the host
 *   ignores the JSON. No verdict exits 0 with no output, letting the command run.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { decide } = await import(resolve(here, '../../../.claude/hooks/guard-bash.mjs'));

const raw = readFileSync(0, 'utf8');
let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

const input = payload.tool_input ?? payload.toolInput ?? payload.input ?? payload;
const command = String(input?.command ?? input?.cmd ?? '');
if (command === '') process.exit(0);

const result = decide(command);
if (!result) process.exit(0);

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: result.decision === 'deny' ? 'ask' : result.decision,
      permissionDecisionReason: result.reason,
    },
  }),
);

if (result.decision === 'deny') {
  process.stderr.write(result.reason);
  process.exit(2);
}
process.exit(0);
