import { z } from 'zod';
import type { Control, PageSnapshot } from '../browser/index.js';
import { maskDeep } from '../flow/index.js';
import { NEXT_ACTION, OP_TEXT, TARGET, VALUE } from './prompts.js';

export const OPS = [
  'CLICK',
  'TYPE_TEXT',
  'SELECT',
  'PRESS_ENTER',
  'SCROLL_DOWN',
  'SCROLL_UP',
  'WAIT',
  'DONE',
  'BLOCKED',
] as const;
export type Op = (typeof OPS)[number];

export const TARGET_OPS = ['CLICK', 'TYPE_TEXT', 'SELECT'] as const;
export type TargetOp = (typeof TARGET_OPS)[number];

export const isTargetOp = (op: Op): op is TargetOp =>
  TARGET_OPS.some((t) => t === op);

/** One `inputs` key System 1 may pick for TYPE_TEXT/SELECT; `preview` is omitted for secrets. */
export interface InputChoice {
  key: string;
  preview?: string;
}

/** One executed action as System 1 sees it in `recent_actions`. */
export interface HistoryEntry {
  op: string;
  control?: string;
  changed: boolean;
}

export interface DecideInput {
  goal: string;
  page: PageSnapshot;
  history: HistoryEntry[];
  ops: Op[];
  inputs: InputChoice[];
  /** Values that must never leave the machine; replaced by `***` in the request. */
  secrets: string[];
}

export interface Decision {
  /** Every offered operation, most likely first (the model's choice first on ties). */
  ranked: { op: Op; p: number }[];
  /** Target answers that were valid, per target operation. */
  targets: Partial<Record<TargetOp, { id: number; p: number }>>;
  input?: { key: string; p: number };
  model: string;
}

export interface BuiltRequest {
  body: Record<string, unknown> & { questions: Record<string, unknown> };
  offered: Op[];
  /** Answer keys of every question, by question name. */
  keys: Record<string, string[]>;
}

export const targetQuestion = (op: TargetOp): string =>
  `${op.toLowerCase()}_target`;

const states = (c: Control) => ({
  role: c.role,
  checked: c.checked,
  selected: c.selected,
  expanded: c.expanded,
});

/**
 * The `/v1/systemone` request for one decision: an `operation` question, one target question per
 * offered target operation, and a `value` question when inputs exist and TYPE_TEXT/SELECT is
 * offered.
 *
 * @remarks Target operations without a matching control are not offered. Every secret value is
 *   replaced by `***` in page text and control values (ADR 0006).
 */
export function buildRequest(d: DecideInput, model: string): BuiltRequest {
  const hide = (v: string): string =>
    d.secrets.reduce((t, s) => (s === '' ? t : t.replaceAll(s, '***')), v);
  const offered = d.ops.filter(
    (op) => !isTargetOp(op) || d.page.controls.some((c) => c.ops.includes(op)),
  );
  const keys: Record<string, string[]> = { operation: offered };
  const questions: Record<string, unknown> = {
    operation: {
      type: 'choice',
      criteria: Object.fromEntries(offered.map((op) => [op, OP_TEXT[op]])),
      instructions: { goal: d.goal, rules: NEXT_ACTION },
    },
  };
  for (const op of TARGET_OPS) {
    if (!offered.includes(op)) continue;
    const candidates = d.page.controls.filter((c) => c.ops.includes(op));
    keys[targetQuestion(op)] = candidates.map((c) => String(c.id));
    questions[targetQuestion(op)] = {
      type: 'choice',
      criteria: Object.fromEntries(
        candidates.map((c) => [
          String(c.id),
          {
            element: `[${c.id}] ${c.name}`,
            current_value: hide(c.value),
            ...states(c),
          },
        ]),
      ),
      instructions: {
        goal: d.goal,
        operation: op,
        rules: [NEXT_ACTION, TARGET],
      },
    };
  }
  if (
    d.inputs.length > 0 &&
    (offered.includes('TYPE_TEXT') || offered.includes('SELECT'))
  ) {
    keys.value = d.inputs.map((i) => i.key);
    questions.value = {
      type: 'choice',
      criteria: Object.fromEntries(
        d.inputs.map((i) => [
          i.key,
          i.preview === undefined
            ? { input: i.key }
            : { input: i.key, value: hide(i.preview) },
        ]),
      ),
      instructions: { goal: d.goal, rules: VALUE },
    };
  }
  const body = {
    model,
    state: {
      page: { url: d.page.url, title: d.page.title, text: hide(d.page.text) },
      elements: d.page.controls.map((c) => ({
        index: String(c.id),
        label: c.name,
        value: hide(c.value),
        operations: c.ops.filter((op) => offered.includes(op)),
        options: c.options,
        ...states(c),
      })),
      recent_actions: d.history.slice(-10).map((h) => ({
        action: h.control ?? h.op,
        kind: h.op,
        page_changed: h.changed,
      })),
    },
    questions,
  };
  return { body: maskDeep(body, d.secrets), offered, keys };
}

const ChoiceSchema = z.object({
  choice: z.string(),
  confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});
/**
 * A model name worth keeping: it is written into saved flows (`recorded.system1`) and shown to reviewers,
 * so anything else (control characters, prose, a long string) from the server becomes `unknown` (#59).
 */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,79}$/;

const ResponseSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
  model: z
    .unknown()
    .optional()
    .transform((m) =>
      typeof m === 'string' && MODEL_NAME.test(m) ? m : 'unknown',
    ),
});

/**
 * One answer, checked against the keys the request offered.
 *
 * @remarks Own properties only (`Object.hasOwn`), so a key such as `constructor` or `toString` cannot pass
 *   through the prototype, and the choice must be an offered key (ADR 0006, #58).
 * @throws {Error} for a malformed or inconsistent answer.
 */
function choiceOf(raw: unknown, keys: string[]) {
  const a = ChoiceSchema.parse(raw);
  const values = Object.values(a.probabilities);
  const sum = values.reduce((x, y) => x + y, 0);
  const p = Object.hasOwn(a.probabilities, a.choice)
    ? a.probabilities[a.choice]
    : undefined;
  if (
    p === undefined ||
    !keys.includes(a.choice) ||
    values.length !== keys.length ||
    !keys.every((k) => Object.hasOwn(a.probabilities, k)) ||
    Math.abs(sum - 1) >= 0.02 ||
    p < Math.max(...values) - 1e-6
  )
    throw new Error(`inconsistent answer ${JSON.stringify(a)}`);
  return { choice: a.choice, p, probabilities: a.probabilities };
}

function tryChoice(raw: unknown, keys: string[] | undefined) {
  if (keys === undefined || raw === undefined) return undefined;
  try {
    return choiceOf(raw, keys);
  } catch {
    return undefined;
  }
}

/**
 * Validates a `/v1/systemone` response against the request it answers.
 *
 * @remarks The operation answer must be valid (offered keys only, probabilities summing to 1, the
 *   choice being the most likely). Target and value answers are optional: an invalid one is
 *   dropped, and the caller escalates if it needed it.
 * @throws {Error} on a malformed response or an invalid operation answer.
 */
export function parseDecision(raw: unknown, req: BuiltRequest): Decision {
  const res = ResponseSchema.parse(raw);
  const op = choiceOf(res.answers.operation, req.offered);
  const ranked = req.offered
    .map((o) => ({ op: o, p: op.probabilities[o] ?? 0 }))
    .sort(
      (a, b) =>
        b.p - a.p || (a.op === op.choice ? -1 : b.op === op.choice ? 1 : 0),
    );
  const targets: Decision['targets'] = {};
  for (const t of TARGET_OPS) {
    const c = tryChoice(
      res.answers[targetQuestion(t)],
      req.keys[targetQuestion(t)],
    );
    if (c !== undefined) targets[t] = { id: Number(c.choice), p: c.p };
  }
  const value = tryChoice(res.answers.value, req.keys.value);
  return {
    ranked,
    targets,
    input: value === undefined ? undefined : { key: value.choice, p: value.p },
    model: res.model,
  };
}
