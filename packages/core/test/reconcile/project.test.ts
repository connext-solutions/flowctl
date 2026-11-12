import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  type LoadedConfig,
  parseConfig,
  runsPath,
} from '../../src/config.js';
import { addRunArtefact } from '../../src/run/index.js';
import type { AppMap } from '../../src/observe/index.js';
import {
  CoverageGapsSchema,
  reconcileGaps,
  reconcileRun,
} from '../../src/reconcile/index.js';
import type { RunResult } from '../../src/result.js';
import { page } from '../derive/build.js';
import { run } from './classify-build.js';
import { put, tmp } from './repo.js';

/** `reconcileRun` and `reconcileGaps` (T6.6): the project-side entry points the CLI calls. */
function project(): { cfg: LoadedConfig; root: string } {
  const root = tmp();
  const cfg = parseConfig(
    {
      defaultEnv: 'local',
      envs: { local: { baseUrl: 'http://127.0.0.1:9', loginUrl: '/login' } },
      profiles: { employee: {} },
    },
    root,
  );
  mkdirSync(runsPath(cfg), { recursive: true });
  return { cfg, root };
}

const saveRun = (cfg: LoadedConfig, r: RunResult): string =>
  put(runsPath(cfg), `${r.runId}/run.json`, JSON.stringify(r));

const failedText = (runId: string, flow = 'submit'): RunResult =>
  run({
    runId,
    flow,
    failed: {
      assertion: { text: 'Đã gửi đơn thành công' },
      got: 'not on the page',
    },
  });

const map = (
  paths: string[],
  observedAt = '2026-11-12T10:00:00.000Z',
): AppMap => ({
  v: 1,
  origin: 'http://127.0.0.1:9',
  observedAt,
  truncated: false,
  pages: paths.map((p) => page(p, p)),
});

const saveMap = (cfg: LoadedConfig, runId: string, m: AppMap): string =>
  put(runsPath(cfg), `${runId}/appmap.json`, JSON.stringify(m));

describe('reconcileRun', () => {
  it('classes the run from its run.json and writes classification.json beside it', async () => {
    const { cfg } = project();
    saveRun(
      cfg,
      run({
        runId: 'r_a1',
        evidence: {
          dir: 'x',
          traces: [],
          console: [],
          network: ['503 GET http://127.0.0.1:9/api/items {}'],
        },
      }),
    );
    const r = await reconcileRun(cfg, 'r_a1');
    expect(r.classification).toMatchObject({
      runId: 'r_a1',
      class: 'environment',
      confidence: 'medium',
    });
    expect(r.file).toBe(join(runsPath(cfg), 'r_a1', 'classification.json'));
    expect(JSON.parse(readFileSync(r.file, 'utf8'))).toEqual(r.classification);
  });

  it('takes the app origin from the run env, so a 5xx of the app is a product bug of medium confidence', async () => {
    const { cfg } = project();
    saveRun(
      cfg,
      run({
        runId: 'r_a2',
        evidence: {
          dir: 'x',
          traces: [],
          console: [],
          network: ['500 POST http://127.0.0.1:9/api/items {}'],
        },
      }),
    );
    const r = await reconcileRun(cfg, 'r_a2');
    expect(r.classification).toMatchObject({
      class: 'product_bug',
      confidence: 'medium',
    });
  });

  it('reads the code index from --code and the operation whose id is the flow name from --spec', async () => {
    const { cfg, root } = project();
    put(root, 'web/i18n/vi.json', '{"done": "Đã gửi đơn"}');
    put(
      root,
      'specs/submit.md',
      '---\nid: submit\ntitle: Gửi đơn\nactor: employee\n---\n\n# Gửi đơn\n\n### Kết quả mong đợi\n\n- Màn hình hiện "Đã gửi đơn thành công".\n',
    );
    saveRun(cfg, failedText('r_b1'));
    const code = join(root, 'web');
    const stale = await reconcileRun(cfg, 'r_b1', { code });
    expect(stale.classification.class).toBe('stale_test');
    expect(stale.operation).toBeNull();
    const drift = await reconcileRun(cfg, 'r_b1', {
      code,
      spec: join(root, 'specs'),
    });
    expect(drift.operation).toBe('submit');
    expect(drift.classification.class).toBe('spec_drift');
    expect(drift.classification.basis[0]?.evidence).toContainEqual(
      expect.objectContaining({ source: 'code', file: 'i18n/vi.json' }),
    );
  });

  it('classifies without spec, with a note, when no operation has the flow name as its id', async () => {
    const { cfg, root } = project();
    put(root, 'specs/other.md', '---\nid: other\ntitle: Khác\n---\n\n# Khác\n');
    saveRun(cfg, failedText('r_b2'));
    const r = await reconcileRun(cfg, 'r_b2', { spec: join(root, 'specs') });
    expect(r.operation).toBeNull();
    expect(r.classification.notes).toContain(
      'no spec operation has the flow name as its id: spec rules not run',
    );
  });

  it('refuses a bad run id, a missing run, a linked run directory and a run.json that is not a run', async () => {
    const { cfg } = project();
    for (const bad of ['../x', 'r_A', 'r_', `r_${'a'.repeat(33)}`, '/tmp/r_a'])
      await expect(reconcileRun(cfg, bad), bad).rejects.toThrow(/run id/);
    await expect(reconcileRun(cfg, 'r_none')).rejects.toThrow(/Cannot read/);
    const elsewhere = tmp();
    put(elsewhere, 'run.json', JSON.stringify(run({ runId: 'r_l1' })));
    symlinkSync(elsewhere, join(runsPath(cfg), 'r_l1'));
    await expect(reconcileRun(cfg, 'r_l1')).rejects.toThrow(/symlink/);
    put(runsPath(cfg), 'r_c1/run.json', '{"runId": "r_c1"}');
    await expect(reconcileRun(cfg, 'r_c1')).rejects.toThrow(
      /not a flowctl run/,
    );
    put(runsPath(cfg), 'r_c3/run.json', JSON.stringify(run({ runId: 'r_c2' })));
    await expect(reconcileRun(cfg, 'r_c3')).rejects.toThrow(
      /not a flowctl run/,
    );
  });

  it('refuses --code and --spec outside the project root, and --appmap outside the flows directory', async () => {
    const { cfg } = project();
    saveRun(cfg, failedText('r_d1'));
    const outside = tmp();
    await expect(reconcileRun(cfg, 'r_d1', { code: outside })).rejects.toThrow(
      /--code .* is not inside the project root/,
    );
    await expect(reconcileRun(cfg, 'r_d1', { spec: outside })).rejects.toThrow(
      /--spec .* is not inside the project root/,
    );
    put(outside, 'appmap.json', JSON.stringify(map(['/'])));
    await expect(
      reconcileRun(cfg, 'r_d1', { appmap: join(outside, 'appmap.json') }),
    ).rejects.toThrow(/--appmap .* is not inside the flows directory/);
  });
});

describe('reconcileGaps', () => {
  it('uses the appmap.json of the latest run by default and writes gaps.json and gaps.md under <flows>/gaps', async () => {
    const { cfg, root } = project();
    saveMap(cfg, 'r_lq3k2a1b0000', map(['/old']));
    saveMap(cfg, 'r_lq3k2a1c0000', map(['/home', '/orphan']));
    mkdirSync(join(runsPath(cfg), 'r_lq3k2a1d0000'));
    put(
      root,
      'web/src/routes.tsx',
      'import { Route } from \'react-router-dom\';\nexport const r = <><Route path="/home" /><Route path="/never" /></>;\n',
    );
    const r = await reconcileGaps(cfg, { code: join(root, 'web') });
    expect(r.appmap).toBe(join(runsPath(cfg), 'r_lq3k2a1c0000', 'appmap.json'));
    expect(r.gaps.checked).toEqual(['route_unvisited', 'page_no_route']);
    expect(r.gaps.gaps.map((g) => g.kind)).toEqual([
      'route_unvisited',
      'page_no_route',
    ]);
    expect(r.files.json).toBe(join(cfg.flowsPath, 'gaps', 'gaps.json'));
    expect(
      CoverageGapsSchema.parse(JSON.parse(readFileSync(r.files.json, 'utf8'))),
    ).toEqual(r.gaps);
    expect(existsSync(r.files.markdown)).toBe(true);
  });

  it('refuses an --appmap with a ConfigError when the flows directory does not exist', async () => {
    const root = tmp();
    const cfg = parseConfig(
      {
        defaultEnv: 'local',
        envs: { local: { baseUrl: 'http://127.0.0.1:9', loginUrl: '/login' } },
        profiles: { employee: {} },
      },
      root,
    );
    const file = put(root, 'map.json', JSON.stringify(map(['/'])));
    await expect(reconcileGaps(cfg, { appmap: file })).rejects.toThrow(
      ConfigError,
    );
  });

  it('needs an app map, and refuses --out under .runs, .auth or .git, outside the flows directory, or over a file that is not a gaps report', async () => {
    const { cfg } = project();
    await expect(reconcileGaps(cfg)).rejects.toThrow(/needs an app map/);
    saveMap(cfg, 'r_e1', map(['/']));
    const flows = cfg.flowsPath;
    const outside = join(tmpdir(), `flowctl-gaps-${Date.now()}`);
    for (const out of [
      join(flows, '.runs', 'r_e1'),
      join(flows, '.auth'),
      join(flows, 'x', '.git'),
      outside,
      join(flows, '..'),
    ])
      await expect(reconcileGaps(cfg, { out }), out).rejects.toThrow(
        /--out|not inside/,
      );
    expect(existsSync(outside)).toBe(false);
    mkdirSync(join(flows, 'notes'));
    writeFileSync(join(flows, 'notes', 'gaps.json'), '{"keep": true}');
    await expect(
      reconcileGaps(cfg, { out: join(flows, 'notes') }),
    ).rejects.toThrow(/not a gaps report/);
    expect(readFileSync(join(flows, 'notes', 'gaps.json'), 'utf8')).toBe(
      '{"keep": true}',
    );
  });
});

describe('addRunArtefact', () => {
  it('never creates the runs directory, and needs the run directory to hold a run.json', () => {
    const { cfg } = project();
    const flows = cfg.flowsPath;
    const missing = join(flows, 'nope', '.runs');
    expect(() =>
      addRunArtefact(missing, flows, 'r_m1', 'classification.json', '{}'),
    ).toThrow(ConfigError);
    expect(existsSync(join(flows, 'nope'))).toBe(false);
    mkdirSync(join(runsPath(cfg), 'r_m2'));
    expect(() =>
      addRunArtefact(runsPath(cfg), flows, 'r_m2', 'classification.json', '{}'),
    ).toThrow(/run\.json/);
    expect(existsSync(join(runsPath(cfg), 'r_m2', 'classification.json'))).toBe(
      false,
    );
  });
});
