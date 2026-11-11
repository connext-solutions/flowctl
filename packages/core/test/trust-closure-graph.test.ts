import {
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Closure,
  computeClosure,
  type HookDigestInput,
  hookConsentDigest,
  TrustError,
} from '../src/trust/index.js';

/**
 * C3 of T1.0 across files: closure scripts, depth, cycles, links, writes to closure files, size limits
 * and the hook consent digest (ADR 0021 Amendment 2026-11-02 sections 2, 7, 8, 12).
 */
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowctl-graph-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const script = (name: string, body: string): void =>
  writeFileSync(join(root, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
const reasons = (c: Closure): string[] => c.uncovered.map((u) => u.reason);
const run = (setup: string, teardown?: string): Closure =>
  computeClosure({ root, setup, teardown });

describe('hook closure across files', () => {
  it('covers psql and a script that calls only cp and curl, and binds both files', () => {
    script('lib.sh', 'true');
    script('seed.sh', 'cp ./lib.sh ./.hook-tmp/lib.sh\ncurl -q https://x/y');
    const c = run("psql -X -h h -c 'select 1' && ./seed.sh");
    expect(c.uncovered).toEqual([]);
    expect(c.consentable).toBe(true);
    expect(c.files.map((f) => [f.path, f.kind])).toEqual([
      ['lib.sh', 'script'],
      ['seed.sh', 'script'],
    ]);
  });

  it('reports an uncovered command inside a script by file and line, never its text', () => {
    script('seed.sh', 'true\npython3 -c x');
    expect(run('./seed.sh').uncovered).toEqual([
      { reason: 'command_not_allowed', in: 'seed.sh', subject: 'line 3' },
    ]);
  });

  it('refuses a symlinked or hard-linked script', () => {
    script('real.sh', 'true');
    symlinkSync(join(root, 'real.sh'), join(root, 'link.sh'));
    linkSync(join(root, 'real.sh'), join(root, 'hard.sh'));
    expect(reasons(run('./link.sh'))).toEqual(['symlink']);
    expect(reasons(run('./hard.sh'))).toEqual(['hardlink']);
  });

  it('refuses a #!/bin/bash script, a BOM and a missing dash', () => {
    writeFileSync(join(root, 'bash.sh'), '#!/bin/bash\ntrue\n');
    writeFileSync(join(root, 'bom.sh'), '\ufefftrue\n');
    writeFileSync(join(root, 'dash.sh'), '#!/bin/dash\ntrue\n');
    expect(reasons(run('./bash.sh'))).toEqual(['not_shell_script']);
    expect(reasons(run('./bom.sh'))).toEqual(['not_shell_script']);
    const c = computeClosure({
      root,
      setup: './dash.sh',
      interpreterOk: () => false,
    });
    expect(reasons(c)).toEqual(['interpreter_missing']);
  });

  it('makes a script with a CR non-consentable', () => {
    writeFileSync(join(root, 'crlf.sh'), 'true\r\n');
    const c = run('./crlf.sh');
    expect(reasons(c)).toEqual(['syntax']);
    expect(c.consentable).toBe(false);
  });

  it('allows a chain of five scripts and refuses six', () => {
    for (let k = 1; k <= 6; k++)
      script(`s${k}.sh`, k < 6 ? `./s${k + 1}.sh` : 'true');
    script('s5.sh', 'true');
    expect(reasons(run('./s1.sh'))).toEqual([]);
    script('s5.sh', './s6.sh');
    expect(reasons(run('./s1.sh'))).toEqual(['limit_exceeded']);
  });

  it('lists a file named twice, or reached twice, once', () => {
    script('b.sh', 'true');
    script('a.sh', './b.sh\n./b.sh');
    expect(run('./a.sh').files.map((f) => f.path)).toEqual(['a.sh', 'b.sh']);
    script('d.sh', 'true');
    script('b.sh', './d.sh');
    script('c.sh', './d.sh');
    script('a.sh', './b.sh\n./c.sh');
    expect(run('./a.sh').files.map((f) => f.path)).toEqual([
      'a.sh',
      'b.sh',
      'c.sh',
      'd.sh',
    ]);
  });

  it('finds a cycle through two scripts and a script calling itself', () => {
    script('a.sh', './b.sh');
    script('b.sh', './a.sh');
    expect(reasons(run('./a.sh'))).toEqual(['cycle']);
    script('self.sh', './self.sh');
    expect(reasons(run('./self.sh'))).toEqual(['cycle']);
  });

  it('uses the longest chain for depth, and prefers cycle over the depth limit', () => {
    for (const [from, to] of [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'e'],
      ['x1', 'x2'],
      ['x2', 'x3'],
      ['x3', 'x4'],
      ['x4', 'a'],
    ])
      script(`${from}.sh`, `./${to}.sh`);
    script('e.sh', 'true');
    expect(reasons(run('./a.sh && ./x1.sh'))).toEqual(['limit_exceeded']);
    script('e.sh', './a.sh');
    expect(reasons(run('./a.sh && ./x1.sh'))).toEqual(['cycle']);
  });

  it('stops after 10000 call-chain steps', () => {
    const layer = (l: number): string[] =>
      [0, 1, 2, 3, 4, 5, 6].map((k) => `./l${l}_${k}.sh`);
    for (let l = 1; l <= 5; l++)
      for (const name of layer(l))
        writeFileSync(
          join(root, name.slice(2)),
          l < 5 ? `${layer(l + 1).join('\n')}\n` : 'true\n',
          { mode: 0o755 },
        );
    expect(reasons(run(layer(1).join('\n')))).toEqual(['limit_exceeded']);
  });

  it('refuses a setup write to a script that teardown runs', () => {
    script('td.sh', 'true');
    expect(reasons(run('printf x > ./td.sh', './td.sh'))).toEqual([
      'writes_closure_file',
    ]);
  });

  it('refuses a file over 256 KiB and makes the hook non-consentable', () => {
    writeFileSync(
      join(root, 'big.sh'),
      `#!/bin/sh\n${'#'.repeat(300 * 1024)}\n`,
    );
    const c = run('cat ./big.sh');
    expect(reasons(c)).toEqual(['limit_exceeded']);
    expect(c.consentable).toBe(false);
  });
});

describe('hook consent digest', () => {
  const base: HookDigestInput = {
    flowsRoot: 'flows',
    setup: './seed.sh',
    teardown: undefined,
    env: ['PGPASSWORD', 'PGHOST'],
    pins: { PGHOST: 'db.local' },
    pgpass: null,
    files: [{ path: 'seed.sh', sha256: 'a'.repeat(64), kind: 'script' }],
  };

  it('is stable, ignores env order and changes with any bound field', () => {
    const d = hookConsentDigest(base);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(hookConsentDigest({ ...base, env: ['PGHOST', 'PGPASSWORD'] })).toBe(
      d,
    );
    const changes: Partial<HookDigestInput>[] = [
      { setup: './seed.sh ' },
      { teardown: 'true' },
      { flowsRoot: 'other' },
      { pins: { PGHOST: 'other' } },
      { pgpass: 'home/.pgpass' },
      { files: [{ path: 'seed.sh', sha256: 'b'.repeat(64), kind: 'script' }] },
    ];
    for (const change of changes)
      expect(hookConsentDigest({ ...base, ...change })).not.toBe(d);
  });

  it('refuses a duplicate env name and a pin outside env', () => {
    expect(() =>
      hookConsentDigest({ ...base, env: ['PGHOST', 'PGHOST'] }),
    ).toThrow(TrustError);
    expect(() => hookConsentDigest({ ...base, pins: { PGUSER: 'u' } })).toThrow(
      TrustError,
    );
  });
});
