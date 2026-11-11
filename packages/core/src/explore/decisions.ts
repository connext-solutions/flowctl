import dayjs from 'dayjs';
import type { Control, PageSnapshot } from '../browser/index.js';
import { maskDeep } from '../flow/index.js';
import type { DecisionLogEntry } from '../run/index.js';
import type { Decision } from '../system1/index.js';
import type { Action } from './policy.js';

const TOP_OPS = 5;

const round = (p: number): number => Math.round(p * 1000) / 1000;

/** A control without its value: values can hold typed secrets, labels cannot. */
export const controlLabel = (c: Control | undefined, id: number): string =>
  c === undefined ? `[${id}] (gone)` : `[${c.id}] ${c.role} "${c.name}"`;

/** `CLICK [12] button "Gửi"`, with the input key for TYPE_TEXT/SELECT. */
export function describeAction(a: Action, snap: PageSnapshot): string {
  const control =
    a.control === undefined
      ? ''
      : ` ${controlLabel(
          snap.controls.find((c) => c.id === a.control),
          a.control,
        )}`;
  return `${a.op}${control}${a.input === undefined ? '' : ` input=${a.input}`}`;
}

/**
 * Builds one `decisions.jsonl` entry from a System 1 answer; hand it to `Evidence.decided`.
 *
 * @remarks Only control labels, input keys and probabilities go in, never field values, and every string of the
 *   entry has the run's secrets masked (a control named by the text typed into it, a secret in the URL's query,
 *   issue #13), so the log is safe to attach to a bug report (ADR 0006).
 */
export function decisionEntry(
  e: Omit<DecisionLogEntry, 'at' | 'ranked' | 'targets' | 'input'> & {
    decision: Decision;
    snap: PageSnapshot;
    /** The run's secret input values. */
    secrets: readonly string[];
  },
): DecisionLogEntry {
  const { decision: d, snap, secrets, ...rest } = e;
  const targets: DecisionLogEntry['targets'] = {};
  for (const [op, t] of Object.entries(d.targets))
    targets[op] = {
      control: controlLabel(
        snap.controls.find((c) => c.id === t.id),
        t.id,
      ),
      p: round(t.p),
    };
  return maskDeep(
    {
      at: dayjs().toISOString(),
      ...rest,
      ranked: d.ranked
        .slice(0, TOP_OPS)
        .map((r) => ({ op: r.op, p: round(r.p) })),
      targets,
      input:
        d.input === undefined
          ? undefined
          : { key: d.input.key, p: round(d.input.p) },
    },
    secrets,
  );
}
