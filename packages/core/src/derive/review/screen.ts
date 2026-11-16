import type { Assertion, Flow } from '../../flow/index.js';
import { ApprovalError } from '../../provenance/index.js';
import { exceedsShown, mdCode } from '../escape.js';
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
 * `raw` as an escaped code span, refused when `mdCode` would cut it: a reviewer never approves text they were not
 * shown in full.
 *
 * @throws {ApprovalError} `screen_truncated`.
 */
function code(raw: string): string {
  if (exceedsShown(raw))
    throw new ApprovalError(
      'screen_truncated',
      'A value of the flow is longer than the review screen shows (500 characters); shorten it to approve.',
    );
  return mdCode(raw);
}

const json = (v: unknown): string => code(JSON.stringify(v) ?? 'null');

const SHOWN = new Set([
  'name',
  'goal',
  'tags',
  'profile',
  'start',
  'inputs',
  'setup',
  'teardown',
  'derived',
  'recorded',
  'steps',
  'assertions',
]);

/** The top-level fields of the flow other than its assertions, in a fixed order; a field added later is shown as JSON. */
function flowLines(flow: Flow): string[] {
  const { file: _f, parsedSteps: _p, sourceSha256: _s, ...doc } = flow;
  const inputs = Object.entries(flow.inputs);
  const recorded = Object.entries(flow.recorded ?? {});
  return [
    `Goal: ${code(flow.goal)}`,
    `Profile: ${code(flow.profile)}`,
    `Start: ${code(flow.start)}`,
    `Tags: ${flow.tags.length === 0 ? 'none' : flow.tags.map(code).join(', ')}`,
    `Inputs (${inputs.length}):`,
    ...inputs.map(([k, v]) =>
      'value' in v
        ? `  ${code(k)}: the value ${code(v.value)}`
        : `  ${code(k)}: from the environment variable ${code(v.env)}`,
    ),
    `Setup: ${flow.setup === undefined ? 'none' : code(flow.setup)}`,
    `Teardown: ${flow.teardown === undefined ? 'none' : code(flow.teardown)}`,
    `Derived: ${flow.derived === true ? 'yes' : 'no'}`,
    `Recorded (${recorded.length}):`,
    ...recorded.map(([k, v]) => `  ${code(k)}: ${json(v)}`),
    ...Object.entries(doc)
      .filter(([k]) => !SHOWN.has(k))
      .map(([k, v]) => `${code(k)}: ${json(v)}`),
    `Steps (${flow.steps.length}):`,
    ...flow.steps.map((s, i) => `  ${i + 1}. ${json(s)}`),
  ];
}

/**
 * The review screen (ADR 0020 section f): every top-level field the flow content hash covers, and the other signed
 * fields, each spec, page or flow text as an escaped code span (`mdCode`: invisible, control and line-break code
 * points shown as `⟨U+XXXX⟩`), so nothing in a quote can hide text, add a line or imitate the nonce prompt that
 * follows the screen. The operator shown for each assertion is the one the verifier will apply.
 *
 * @throws {ApprovalError} `screen_truncated` when a value is longer than `mdCode` shows (500 code points): the
 *   screen never cuts what the reviewer signs.
 */
export function reviewScreen(input: ScreenInput): string {
  const { flow } = input;
  const lines = [
    `REVIEW ${code(flow.name)} (project ${code(input.project)}, revision ${input.revision})`,
    `Flow hash: ${input.flowHash}`,
    ...flowLines(flow),
    'The verifier will check exactly these, each as a positive:',
  ];
  flow.assertions.forEach((a, i) => {
    const n = input.numbers[i];
    lines.push(`  ${i + 1}. ${operatorOf(a)}: ${json(plain(a))}`);
    if (n !== undefined)
      lines.push(`     number: ${code(n.label)} in ${code(n.unit)}`);
    const ref = a.sourceRef;
    if (ref === undefined) lines.push('     source: none');
    else {
      const { quote, ...meta } = ref;
      lines.push(`     source: ${json(meta)}`);
      if (quote !== undefined) lines.push(`     quote: ${code(quote)}`);
    }
  });
  if (input.baseline !== undefined)
    lines.push(
      `Baseline value: ${code(input.baseline.value)}`,
      `Baseline evidence: ${code(input.baseline.evidence)}`,
    );
  lines.push(
    `Confirming replays passed: ${input.replays}`,
    'Custody of a reviewer key is declared by the owner; flowctl cannot check it.',
  );
  return lines.join('\n');
}
