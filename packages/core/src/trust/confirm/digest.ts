import { createHash } from 'node:crypto';
import { canonicalJson } from '../canonical.js';
import {
  type Closure,
  computeClosure,
  hashFlowFile,
} from '../closure/index.js';

/** What a destructive confirmation binds (ADR 0024 section 5, "Closure and confirmation digest"). */
export interface ConfirmDigestInput {
  /** Absolute path of the flows root. */
  root: string;
  /** The flow file, relative to the flows root. */
  flowFile: string;
  /** The flow's `upload.file` targets, relative to the flows root. */
  uploads: readonly string[];
  setup: string | undefined;
  teardown: string | undefined;
  /** The effective value of every `{{env.NAME}}` the flow references. */
  vars: Readonly<Record<string, string>>;
  /** Whether the flow has an `env:` (or secret) input: such a flow is unconfirmable. */
  envInputs: boolean;
  /** Test seam for the `#!/bin/dash` check; passed to the closure. */
  interpreterOk?: (path: string) => boolean;
}

/** The digest of a flow, with what the owner is shown, or why no confirmation can be written for it. */
export interface ConfirmPlan {
  digest: string;
  flowSha256: string;
  files: { path: string; sha256: string }[];
  hooks: { setup: Closure | undefined; teardown: Closure | undefined };
  /** Why the flow is unconfirmable; empty when an entry may be written. */
  refusals: string[];
}

const bytewise = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

const hookValue = (text: string | undefined, c: Closure | undefined) =>
  text === undefined || c === undefined
    ? null
    : {
        text,
        files: [...c.files]
          .sort((a, b) => bytewise(a.path, b.path))
          .map((f) => ({ path: f.path, sha256: f.sha256, kind: f.kind })),
        uncovered: c.uncovered,
      };

/**
 * The confirmation digest of a flow: sha256 of the canonical JSON
 * `{"v":1,"purpose":"confirm","flow":<sha256 of the flow file>,"files":[{path,sha256}],"hooks":{"setup":…,
 * "teardown":…},"vars":{…}}`, with each hook closure computed under the narrower allowlist of a confirmation.
 *
 * @remarks It shares only the closure function and the file-hashing function with the hook consent digest; its
 *   `purpose` keeps one from standing in for the other. A refusal (an `uncovered` hook, a hook that cannot be shown,
 *   a file that cannot be read safely, an `env:` input) makes the flow unconfirmable: `trust add destructive` writes
 *   nothing, and a stored entry for it never matches, since the digest is empty.
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export function planConfirm(i: ConfirmDigestInput): ConfirmPlan {
  const refusals: string[] = [];
  const flowSha256 = hashFlowFile(i.root, i.flowFile) ?? '';
  if (flowSha256 === '')
    refusals.push(
      `${i.flowFile} cannot be read safely (missing, a link, or over 256 KiB)`,
    );
  const files = [...new Set(i.uploads)].sort(bytewise).map((path) => {
    const sha256 = hashFlowFile(i.root, path) ?? '';
    if (sha256 === '')
      refusals.push(`the upload ${path} cannot be read safely`);
    return { path, sha256 };
  });
  const closure = (text: string | undefined): Closure | undefined =>
    text === undefined
      ? undefined
      : computeClosure({
          root: i.root,
          setup: text,
          interpreterOk: i.interpreterOk,
          purpose: 'confirm',
        });
  const hooks = { setup: closure(i.setup), teardown: closure(i.teardown) };
  for (const [name, c] of Object.entries(hooks)) {
    if (c === undefined) continue;
    if (!c.consentable)
      refusals.push(`the ${name} hook cannot be shown in full`);
    for (const u of c.uncovered)
      refusals.push(
        `the ${name} hook is uncovered (${u.reason} in ${u.in}: ${u.subject.slice(0, 80)})`,
      );
  }
  if (i.envInputs)
    refusals.push(
      'the flow has an env input, whose value the digest cannot bind',
    );
  const doc = {
    v: 1,
    purpose: 'confirm',
    flow: flowSha256,
    files,
    hooks: {
      setup: hookValue(i.setup, hooks.setup),
      teardown: hookValue(i.teardown, hooks.teardown),
    },
    vars: { ...i.vars },
  };
  const digest =
    refusals.length > 0
      ? ''
      : createHash('sha256').update(canonicalJson(doc)).digest('hex');
  return { digest, flowSha256, files, hooks, refusals };
}
