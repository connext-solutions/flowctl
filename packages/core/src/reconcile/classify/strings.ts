import type { AppMap } from '../../observe/index.js';
import {
  normText,
  type Operation,
  quotedSpans,
  refusal,
  type SpecRef,
} from '../../spec/index.js';
import type { CodeIndex } from '../code/index.js';
import type { ClassEvidence, ClassifyLimits } from './types.js';

/** One string a rule may compare, normalised (ADR 0020 section d) and not refused, with the evidence that cites it. */
export interface Cited {
  text: string;
  evidence: ClassEvidence;
}

/** `text` cut to `max` code points, ending with `…` when cut. */
export function clip(text: string, max: number): string {
  const cps = [...text];
  return cps.length <= max ? text : `${cps.slice(0, max - 1).join('')}…`;
}

/** The normalised form of an untrusted string, or `null` when it is empty, too long or refused. */
function comparable(raw: string, max: number): string | null {
  if (raw.length > max * 2) return null;
  const t = normText(raw);
  if (t === '' || [...t].length > max || refusal(t) !== null) return null;
  return t;
}

/**
 * The quoted literals of the operation's steps and expected items, and each item's `value`, as the spec states
 * them. A step cites the operation's document (`ref: null`); an expected item cites its own `SpecRef`.
 */
export function specLiterals(op: Operation, limits: ClassifyLimits): Cited[] {
  const out: Cited[] = [];
  const add = (raw: string, pointer: string, ref: SpecRef | null) => {
    const text = comparable(raw, limits.maxCompared);
    if (text === null) return;
    out.push({
      text,
      evidence: {
        source: 'spec',
        operation: clip(op.id, limits.maxEvidenceText),
        doc: clip(op.location.ref, limits.maxEvidenceText),
        pointer,
        ref,
        text: clip(text, limits.maxEvidenceText),
      },
    });
  };
  op.steps.forEach((s, i) => {
    for (const q of quotedSpans(s)) add(q.text, `/steps/${i}`, null);
  });
  op.expected.forEach((e, i) => {
    if (e.value !== null && e.value !== undefined)
      add(e.value, `/expected/${i}/value`, e.ref);
    for (const q of quotedSpans(e.text))
      add(q.text, `/expected/${i}/text`, e.ref);
  });
  return out;
}

/**
 * The names a page showed in the crawl: page titles (only when `role` is `null`), and the names of controls and form
 * fields (of that `role` only, when one is given), each with its JSON Pointer into `appmap.json`.
 */
export function mapStrings(
  map: AppMap,
  role: string | null,
  limits: ClassifyLimits,
): Cited[] {
  const out: Cited[] = [];
  const add = (raw: string, pointer: string) => {
    const text = comparable(raw, limits.maxCompared);
    if (text !== null)
      out.push({
        text,
        evidence: {
          source: 'map',
          pointer,
          text: clip(text, limits.maxEvidenceText),
        },
      });
  };
  map.pages.forEach((p, i) => {
    if (role === null) add(p.title, `/pages/${i}/title`);
    p.controls.forEach((c, j) => {
      if (role === null || c.role === role)
        add(c.name, `/pages/${i}/controls/${j}/name`);
    });
    p.forms.forEach((f, j) =>
      f.fields.forEach((d, k) => {
        if (role === null || d.role === role)
          add(d.name, `/pages/${i}/forms/${j}/fields/${k}/name`);
      }),
    );
  });
  return out;
}

type CodeRecord = { file: string; line: number; text: string };

/** Labels and validator messages (already normalised by the index), up to `maxCompared` code points, cited. */
function citeCode(
  labels: readonly CodeRecord[],
  messages: readonly CodeRecord[],
  limits: ClassifyLimits,
): Cited[] {
  const cite = (
    record: 'label' | 'message',
    r: { file: string; line: number; text: string },
  ): Cited => ({
    text: r.text,
    evidence: {
      source: 'code',
      record,
      file: clip(r.file, limits.maxEvidenceText),
      line: r.line,
      text: clip(r.text, limits.maxEvidenceText),
    },
  });
  const fits = (r: { text: string }) =>
    r.text.length <= limits.maxCompared * 2 &&
    [...r.text].length <= limits.maxCompared;
  return [
    ...labels.filter(fits).map((r) => cite('label', r)),
    ...messages.filter(fits).map((r) => cite('message', r)),
  ];
}

/** Every label and validator message of the index, cited. */
export const codeStrings = (code: CodeIndex, limits: ClassifyLimits): Cited[] =>
  citeCode(code.labels, code.messages, limits);

/** The code records whose text equals `text`, through the index lookups (`findLabel`, `findMessage`). */
export const codeExact = (
  code: CodeIndex,
  text: string,
  limits: ClassifyLimits,
): Cited[] =>
  citeCode(
    code.findLabel(text).matches,
    code.findMessage(text).matches,
    limits,
  );
