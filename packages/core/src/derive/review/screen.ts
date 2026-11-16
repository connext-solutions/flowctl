import type { Assertion, Flow } from '../../flow/index.js';
import { mdCode, showInvisible } from '../escape.js';
import type { BaselineInput, NumberSpec } from './types.js';

/** What the verifier will check for one assertion, derived from the assertion itself (polarity is `positive`). */
export function operatorOf(a: Assertion): string {
  if ('text' in a) return 'the page shows the text';
  if ('url' in a) return 'the address is';
  if ('value' in a) return 'the field equals';
  if ('noConsoleErrors' in a) return 'the page logs no console error';
  return a.network.absent === true
    ? 'this request is NEVER sent'
    : 'this request is sent';
}

const plain = (a: Assertion): Assertion => {
  const { sourceRef: _s, ...rest } = a;
  return rest;
};

/** The facts the screen shows; every one of them is a field of the signed record. */
export interface ScreenInput {
  flow: Flow;
  project: string;
  flowHash: string;
  revision: number;
  replays: number;
  numbers: readonly (NumberSpec | undefined)[];
  baseline?: BaselineInput;
}

/**
 * The review screen (ADR 0020 section f): built only from fields that are signed, with every spec, page or flow text
 * as an escaped code span (`mdCode`: invisible, control and line-break code points shown as `⟨U+XXXX⟩`, cut at 500
 * code points), so nothing in a quote can hide text, add a line or imitate the nonce prompt that follows the screen.
 * The operator shown for each assertion is the one the verifier will apply.
 */
export function reviewScreen(input: ScreenInput): string {
  const { flow } = input;
  const lines = [
    `REVIEW ${showInvisible(flow.name)} (project ${showInvisible(input.project)}, revision ${input.revision})`,
    `Goal: ${mdCode(flow.goal)}`,
    `Flow hash: ${input.flowHash}`,
    `Steps (${flow.steps.length}):`,
    ...flow.steps.map((s, i) => `  ${i + 1}. ${mdCode(JSON.stringify(s))}`),
    'The verifier will check exactly these, each as a positive:',
  ];
  flow.assertions.forEach((a, i) => {
    const n = input.numbers[i];
    lines.push(
      `  ${i + 1}. ${operatorOf(a)}: ${mdCode(JSON.stringify(plain(a)))}`,
    );
    if (n !== undefined)
      lines.push(`     number: ${mdCode(n.label)} in ${mdCode(n.unit)}`);
    const ref = a.sourceRef;
    if (ref === undefined) lines.push('     source: none');
    else {
      lines.push(`     source: ${ref.kind} ${mdCode(ref.ref)}`);
      if (ref.quote !== undefined)
        lines.push(`     quote: ${mdCode(ref.quote)}`);
    }
  });
  if (input.baseline !== undefined)
    lines.push(
      `Baseline value: ${mdCode(input.baseline.value)}`,
      `Baseline evidence: ${mdCode(input.baseline.evidence)}`,
    );
  lines.push(
    `Confirming replays passed: ${input.replays}`,
    'Custody of a reviewer key is declared by the owner; flowctl cannot check it.',
  );
  return lines.join('\n');
}
