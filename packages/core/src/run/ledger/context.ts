import { relative, sep } from 'node:path';
import { BUILT_IN_DENY, pathGlob } from '../../browser/index.js';
import type { LoadedConfig, ResolvedEnv } from '../../config.js';
import type { Flow } from '../../flow/index.js';
import type { ConfirmDigestInput, ReadContext } from '../../trust/index.js';

/**
 * What reading `destructiveConfirm` entries needs from the run layer: now, and the `deny` matcher a `session`
 * template is judged by (the built-in list of `browser/scope.ts` and the repo's `target.scope.deny`, case-folded).
 */
export function confirmReadContext(
  cfg: LoadedConfig,
  now: Date = new Date(),
): ReadContext {
  const deny = [...BUILT_IN_DENY, ...cfg.target.scope.deny].map((p) =>
    pathGlob(p, true),
  );
  return { now, denied: (path) => deny.some((re) => re.test(path)) };
}

const ENV_REF = /\{\{\s*env\.([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * What the confirmation digest of `flow` binds on `env` (ADR 0024 section 5): the flow file relative to the flows
 * root, its `upload.file` targets, its hooks, the effective value on `env` of every `{{env.NAME}}` it references,
 * and whether it has an `env:` input (which makes it unconfirmable). The run layer and `flowctl trust add
 * destructive` compute the digest from this, so both bind the same thing.
 */
export function confirmInputFor(
  cfg: LoadedConfig,
  flow: Flow,
  env: ResolvedEnv,
): ConfirmDigestInput {
  const text = JSON.stringify([
    flow.start,
    flow.inputs,
    flow.steps,
    flow.assertions,
  ]);
  const names = new Set([...text.matchAll(ENV_REF)].map((m) => m[1] ?? ''));
  const vars: Record<string, string> = {};
  for (const n of [...names].sort()) {
    const v = Object.hasOwn(env.vars, n) ? env.vars[n] : undefined;
    if (v !== undefined) vars[n] = v;
  }
  return {
    root: cfg.flowsPath,
    flowFile: relative(cfg.flowsPath, flow.file).split(sep).join('/'),
    uploads: flow.parsedSteps.flatMap((s) =>
      s.kind === 'upload' ? [s.file] : [],
    ),
    setup: flow.setup,
    teardown: flow.teardown,
    vars,
    envInputs: Object.values(flow.inputs).some((i) => !('value' in i)),
  };
}
