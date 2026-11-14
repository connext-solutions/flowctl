import { INVISIBLE_CLASS } from '../../spec/index.js';
import { ByteBudget } from '../../trust/index.js';
import {
  type ContractFact,
  type ContractLimits,
  type ContractSide,
  type ContractSource,
  DEFAULT_SIDES,
  type SkippedContract,
} from './types.js';

const UNSAFE = new RegExp(`[${INVISIBLE_CLASS}]`, 'u');

/** Longest ref (ADR 0040) and the room kept for its root name and separators. */
export const MAX_REF = 500;
const ROOT_NAME_ROOM = 66;

/** One JSON Pointer segment: `~` is `~0` and `/` is `~1`. */
export const escapePointer = (segment: string): string =>
  segment.replace(/~/g, '~0').replace(/\//g, '~1');

/** The JSON Pointer of `segments` (`''` for none). */
export const pointerOf = (segments: readonly string[]): string =>
  segments.map((s) => `/${escapePointer(s)}`).join('');

/** Whether `text` has no control, format or other invisible code point (ADR 0020 section d). */
export const isVisible = (text: string): boolean => !UNSAFE.test(text);

/** `text` with every invisible code point written as `\u{hex}`, so a name can be shown in a skip. */
export const printable = (text: string): string =>
  text.replace(
    new RegExp(`[${INVISIBLE_CLASS}]`, 'gu'),
    (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`,
  );

/** The counters shared by every file of one read: facts taken so far. */
export interface Shared {
  facts: ByteBudget;
  limits: ContractLimits;
  sides: Readonly<Record<ContractSource, ContractSide>>;
}

/** Builds the shared counters of a read. */
export const shared = (
  limits: ContractLimits,
  sides: Partial<Record<ContractSource, ContractSide>> = {},
): Shared => ({
  facts: new ByteBudget(limits.maxFacts, 'contract facts'),
  limits,
  sides: { ...DEFAULT_SIDES, ...sides },
});

/** Facts without what the emitter knows. */
export type FactInput = Omit<
  ContractFact,
  'file' | 'source' | 'side' | 'line'
> & {
  line: number;
};

/**
 * Collects the facts and skips of one file of one source. A fact whose pointer was already emitted for the file
 * is an `ambiguous_ref` skip, never a second fact. A fact whose pointer, owner, field or message key is
 * too long or holds an invisible character, or whose reference would pass {@link MAX_REF}, is a skip, never a
 * fact: the pointer becomes part of a reference, which a reviewer reads (ADR 0023 rule 1, ADR 0040).
 *
 * @throws {ContainmentError} `too_large` from the fact budget, which refuses the whole read.
 */
export class Emitter {
  readonly facts: ContractFact[] = [];
  readonly skipped: SkippedContract[] = [];

  /**
   * @param refs the pointers already emitted for `file`; the emitters of one file share it, so a reference is
   *   never emitted twice within one read (the invariant {@link resolveContractRef} relies on).
   */
  constructor(
    readonly file: string,
    readonly source: ContractSource,
    private readonly sh: Shared,
    private readonly refs: Set<string> = new Set(),
  ) {}

  /** Records a skip at `line` (0 for the whole file). */
  skip(reason: string, line: number): void {
    this.skipped.push({ file: printable(this.file), line, reason });
  }

  /** Adds `f` as a fact of this file, or a skip when it cannot be a safe reference. */
  fact(f: FactInput): void {
    const max = this.sh.limits.maxString;
    const names = [f.pointer, f.owner, f.field, f.messageKey ?? ''];
    if (
      f.value.length > max ||
      !isVisible(f.value) ||
      !isVisible(this.file) ||
      names.some((n) => n.length > max || !isVisible(n))
    )
      return this.skip('fact_unsafe', f.line);
    if (this.file.length + f.pointer.length + ROOT_NAME_ROOM > MAX_REF)
      return this.skip('ref_too_long', f.line);
    if (this.refs.has(f.pointer)) return this.skip('ambiguous_ref', f.line);
    this.refs.add(f.pointer);
    this.sh.facts.take(1);
    this.facts.push({
      ...f,
      source: this.source,
      side: this.sh.sides[this.source],
      file: this.file,
    });
  }
}
