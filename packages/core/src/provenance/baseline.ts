import type { Assertion } from '../flow/index.js';

/**
 * The baseline a flow asserts (ADR 0020 section f, ADR 0042): `none` when no assertion's `sourceRef` is of kind
 * `baseline`; `one` with the value that assertion checks (the text of a `text` assertion, the address of a `url`
 * one, the `equals` of a `value` one); `unsupported` for more than one baseline assertion, or one of a kind that
 * checks no single value (`network`, `noConsoleErrors`). A record signs one baseline value, so only `one` can be
 * approved and verified.
 */
export type FlowBaseline =
  | { kind: 'none' }
  | { kind: 'one'; value: string }
  | { kind: 'unsupported' };

const checkedValue = (a: Assertion): string | undefined => {
  if ('text' in a) return a.text;
  if ('url' in a) return a.url;
  if ('value' in a) return a.value.equals;
  return undefined;
};

/** The baseline `flow` asserts; see {@link FlowBaseline}. */
export function flowBaseline(flow: {
  assertions: readonly Assertion[];
}): FlowBaseline {
  const baselines = flow.assertions.filter(
    (a) => a.sourceRef?.kind === 'baseline',
  );
  const [only, ...rest] = baselines;
  if (only === undefined) return { kind: 'none' };
  const value = checkedValue(only);
  if (rest.length > 0 || value === undefined) return { kind: 'unsupported' };
  return { kind: 'one', value };
}
