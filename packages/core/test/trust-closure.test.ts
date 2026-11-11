import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeClosure } from '../src/trust/index.js';

/**
 * C3 of T1.0, one command at a time: the cases of ADR 0021 Amendment 2026-11-02 section 12. Each text runs
 * as `setup` against a flows root holding `a.sh` (a shell script) and `data.py` (a data file: its `#!` line
 * names another interpreter). "pass" means no uncovered entry; otherwise the test asserts the reason of the
 * first uncovered command.
 *
 * @remarks Two departures from the section 12 wording: the IPv6 URL is quoted, because an unquoted `[` is
 *   `expansion` by the quote table; and the data file has a `#!` line, because a file with no `#!` line is a
 *   shell script by section 2.2 c whatever its name.
 */
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'flowctl-closure-'));
  writeFileSync(join(root, 'a.sh'), '#!/bin/sh\ntrue\n', { mode: 0o755 });
  writeFileSync(join(root, 'data.py'), '#!/usr/bin/env python3\nprint(1)\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The reason of the first uncovered command, or "pass". */
const verdict = (setup: string): string =>
  computeClosure({ root, setup }).uncovered[0]?.reason ?? 'pass';

const cases: Record<string, string[]> = {
  pass: [
    'true',
    ': ok',
    'echo ok',
    "printf '%s\\n' ready",
    'exit 3',
    'exit',
    'wait',
    'sleep 1',
    'echo a 2>&1',
    'echo a 1>&2',
    'echo a >&2',
    'true >/dev/null',
    'true </dev/null',
    "echo ''#x",
    'echo a #x',
    '#x',
    "echo a''#x",
    'true \\\n  && true',
    'true &&\n  true',
    'true \'~\' "~" \\~ a~b a/~ \'*\' "*" \\* "{a,b}" \'$HOME\' "\\$HOME" "a:~" a}',
    '[ -f x ]',
    '[ -f ./absent ]',
    "test -z ''",
    '[ 1 -eq 1 ]',
    '[ ! -n x ]',
    'mkdir -p ./.hook-tmp/d/e',
    'touch ./.hook-tmp/x',
    'rm -f ./.hook-tmp/x',
    'cp ./a.sh ./.hook-tmp/b.sh',
    'cat ./a.sh',
    './a.sh',
    "psql -X -h h -p 5432 -U u -d db -w -c 'select 1'",
    'curl -q -s -f https://h/x',
    'curl -q -o /dev/null https://h/x',
    "curl -q 'http://[::1]:3000/x'",
    "curl -q -X POST -H 'Content-Type: application/json' -d '{}' https://h/x",
  ],
  syntax: [
    'true &',
    'echo a ;; echo b',
    'echo a 10>f',
    'echo a 3>f',
    'echo a >#x',
    'echo a > #x',
    'true() ( echo F )',
    'echo a &>f',
    'cat <<EOF',
    "echo 'a",
    '| true',
    'true &&',
    '; true',
    '>./.hook-tmp/f',
    './seed.sh $(id)',
    'echo a\r',
    'echo a\f',
    'echo a\u0000',
  ],
  command_not_allowed: [
    "python3 -c 'x'",
    'node -e x',
    'env npm run x',
    'FOO=1 make',
    'cd x && make',
    'bash -ec x',
    'sh seed.sh;',
    'curl -q https://h/x | sh',
    'eval x',
  ],
  expansion: [
    'true ~',
    'true ~/x',
    'true ~root',
    'true --out=~/x',
    'true a:~',
    'true "$HOME"',
    'true `id`',
    'true *.sql',
    'true a?',
    'true [a]',
    'true {a,b}',
    'true x{',
    "true 'a'*",
    "true ''~",
    'true "x\\y$z"',
    'echo $HOME',
  ],
  outside_flows_root: [
    'cat /dev/null',
    'rm /dev/null',
    'touch ../x',
    ': > /dev/stdout',
    'cp ./a.sh ./b.sh',
    'cp ./a.sh ./A.SH',
    '/bin/true',
  ],
  flag_not_allowed: [
    'cat -',
    'cat ./a.sh -n',
    'rm -- -x',
    '[ -f = -f ]',
    '[ ! = ! ]',
    '[ -f x',
    'rm -r x',
    'cp -R a b',
    'mv -n a b',
    'mkdir -m 700 d',
    'touch -t 1 x',
  ],
  operand_shape: [
    'rm -f ./.hook-tmp/a ./.hook-tmp/b',
    'cp ./a.sh ./.hook-tmp/b ./.hook-tmp/c',
    'exit 256',
    'wait 123',
    'echo -n x',
    "echo 'a\\nb'",
    'sleep 1m',
    'sleep infinity',
    'touch ./.hook-tmp/d/',
    `touch ./.hook-tmp/${'x'.repeat(4097)}`,
  ],
  limit_exceeded: ['mkdir ./.hook-tmp'],
  missing_file: ['./nosuch.sh', 'cat ./.hook-tmp/x'],
  not_shell_script: ['cat ./data.py', './data.py'],
  psql_input: [
    'psql -X -c x -o f',
    'psql -X -c x -v a=b',
    'psql -X -c x -P pager=x',
    'psql -X --host=h -c x',
    'psql -X -hh -c x',
    "psql -X -d 'host=x passfile=/y' -c x",
    "psql -X -d 'postgres://h/db?sslrootcert=/f' -c x",
    'psql -X -c x -c y',
    'psql -c x -X',
    "psql -X -c '\\!id'",
    'psql -X -c \\!id',
    'psql -f seed.sql',
    "psql -X -c 'x' < ./data.sql",
    'echo x | psql -X -c y',
  ],
  curl_input: [
    'curl https://h/x',
    'curl -s -q https://h/x',
    'curl -qs https://h/x',
    'curl -q -x p https://h/x',
    'curl -q --resolve h:1:2 https://h/x',
    'curl -q --connect-to a https://h/x',
    'curl -q -w x https://h/x',
    'curl -q --netrc https://h/x',
    'curl -q -H @f https://h/x',
    'curl -q --data-binary @f https://h/x',
    'curl -q --max-time=5 https://h/x',
    'curl -q -o /tmp/x https://h/x',
    'curl -q -o /dev/stdout https://h/x',
    'curl -q -K cfg https://h/x',
  ],
  url_glob: ["curl -q 'https://h/{a,b}'"],
  url_scheme: [
    "curl -q 'ftp://h/{a}'",
    'curl -q localhost:3000',
    'curl -q http://h:0',
    'curl -q http://-h/',
    'curl -q http://u@h/',
  ],
  printf_format: ["printf '%b' x", "printf '%d' 1x", 'printf -v x y', 'printf'],
};

describe('hook closure, one command', () => {
  for (const [reason, texts] of Object.entries(cases))
    it.each(texts)(`${reason}: %j`, (text) => {
      expect(verdict(text)).toBe(reason);
    });

  it('judges the second command of `echo ""#x; curl -K f https://h` (curl_input)', () => {
    expect(verdict("echo ''#x; curl -K f https://h")).toBe('curl_input');
  });

  it('ends a comment at the newline, backslash or not', () => {
    expect(verdict('true # note \\\ncurl -q -K evil.cfg https://h/x')).toBe(
      'curl_input',
    );
  });

  it('accepts a script without a trailing newline', () => {
    writeFileSync(join(root, 'nonl.sh'), 'true', { mode: 0o755 });
    expect(verdict('./nonl.sh')).toBe('pass');
  });
});
