import { TrustStore } from '../../src/trust/index.js';
import type {
  ApproveOptions,
  ReplayEvidence,
  Tty,
} from '../../src/derive/review/index.js';
import { AT, type World } from '../approval-fixture.js';

export interface ScriptedTty extends Tty {
  shown: string[];
  prompts: string[];
  secretPrompts: string[];
  typed: string[];
}

/** A terminal that answers the nonce prompt with `nonce` (the right one by default) and the passphrase with `pass`. */
export function scriptedTty(
  o: {
    interactive?: boolean;
    nonce?: string;
    pass?: string;
    onSecret?: () => void;
  } = {},
): ScriptedTty {
  const t: ScriptedTty = {
    interactive: o.interactive ?? true,
    shown: [],
    prompts: [],
    secretPrompts: [],
    typed: [],
    show: (text) => void t.shown.push(text),
    ask: (prompt) => {
      t.prompts.push(prompt);
      const answer = o.nonce ?? /Type (\d{6})/.exec(prompt)?.[1] ?? '';
      t.typed.push(answer);
      return Promise.resolve(answer);
    },
    askSecret: (prompt) => {
      t.secretPrompts.push(prompt);
      o.onSecret?.();
      return Promise.resolve(o.pass ?? 'a passphrase of enough length');
    },
  };
  return t;
}

export interface Calls {
  replays: number;
  resolves: number;
  unlocks: string[];
}

/** Options for `approveCase` with passing seams; `calls` counts what was used. */
export function options(
  w: World,
  over: Partial<ApproveOptions> & {
    replay?: ReplayEvidence;
    resolves?: boolean;
  } = {},
): { opts: ApproveOptions; calls: Calls; tty: ScriptedTty } {
  const calls: Calls = { replays: 0, resolves: 0, unlocks: [] };
  const tty = scriptedTty();
  const { replay, resolves, ...rest } = over;
  const opts: ApproveOptions = {
    flow: w.flow,
    project: 'test-project',
    store: TrustStore.open(w.store.dir),
    tty,
    signer: {
      unlock: (p) => {
        calls.unlocks.push(p);
        return w.signer;
      },
    },
    replayer: {
      replay: () => {
        calls.replays += 1;
        return Promise.resolve(
          replay ?? { passed: true, summary: { n: calls.replays } },
        );
      },
    },
    resolver: {
      resolve: () => {
        calls.resolves += 1;
        return Promise.resolve(resolves ?? true);
      },
    },
    appMapEvidence: { map: 'm1' },
    now: AT,
    ...rest,
  };
  return { opts, calls, tty: opts.tty as ScriptedTty };
}
