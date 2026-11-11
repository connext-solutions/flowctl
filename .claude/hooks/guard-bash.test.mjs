/**
 * Unit tests for the guard-bash PreToolUse hook: every command here was once let through (#19, #55).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide } from './guard-bash.mjs';

const DENY = [
  'git commit -n -m x',
  'git -c core.hooksPath=/dev/null commit -m x',
  'set -a; . spike/.env; set +a; env',
  'printenv TYPESAFE_API_KEY',
  '< spike/.env cat',
  'base64 spike/.env',
  'cat spike/.e""nv',
  'git push --force --force-with-lease origin x',
  'cat /private/tmp/x/.flows/.auth/local/admin.json',
  'jq . .flows/.auth/staging/a.json',
  'bash -c "cat spike/.env"',
  "sh -c 'cat .flows/.auth/local/a.json'",
];
const ASK = [
  'git push origin HEAD:refs/heads/main',
  'rm -r -f packages',
  'flowctl trust login-flow',
  'node packages/cli/dist/bin.js replay --trust-hooks',
  'FLOWCTL_TRUST_HOOKS=1 node x',
];
const ALLOW = [
  'bun run check',
  'git push --force-with-lease origin fix/x',
  'git commit -m "add -n flag docs"',
  'set -a; . spike/.env; set +a; bun run test:contract',
  'git commit -m "fix(core): write .gitignore in .auth/ and .runs/"',
  'gh pr create --body "sessions in .flows/.auth/ are 0600"',
  'grep -rn ".auth/" packages/core/src',
  'git commit -F - <<EOF\nfix: x\n\nrun with -n to skip\nEOF',
];

describe('guard-bash decide', () => {
  for (const cmd of DENY)
    it(`denies: ${cmd}`, () => assert.equal(decide(cmd)?.decision, 'deny'));
  for (const cmd of ASK)
    it(`asks: ${cmd}`, () => assert.equal(decide(cmd)?.decision, 'ask'));
  for (const cmd of ALLOW)
    it(`allows: ${cmd}`, () => assert.equal(decide(cmd), undefined));
});
