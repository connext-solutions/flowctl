import { RunError } from '../../foundation/index.js';

/** The most distinct id-shaped tokens a run keeps (ADR 0024 amendment 2026-11-12 "destructive ledger details", s.1). */
export const MAX_SEEN = 100_000;
/** The most ids one run's ledger holds (ledger rule 9). */
export const MAX_IDS = 500;
/** The largest response body scanned whole. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** The largest `innerText` read scanned whole. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const DIGITS = /[0-9]+/g;
const UUID =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/**
 * The id-shaped tokens of `text`, canonical: every maximal run of 1 to 18 ASCII digits, whatever its neighbours,
 * without leading zeros (`007` gives `7`, `000` gives `0`), and every uuid in either case, lower-cased. Longer digit
 * runs are ignored. There is no length floor.
 *
 * @example idTokens('Tổng 007, mã ABCDEF01-0000-0000-0000-000000000000') // ['7', '1', '0', ..., 'abcdef01-…']
 */
export function idTokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DIGITS))
    if (m[0].length <= 18) out.push(m[0].replace(/^0+(?=[0-9])/, ''));
  for (const m of text.matchAll(UUID)) out.push(m[0].toLowerCase());
  return out;
}

/**
 * Every id-shaped token a run has seen (ledger rule 2): a created id enters the ledger only if it is not here.
 *
 * @remarks Bounded: more than {@link MAX_SEEN} distinct tokens, a body over {@link MAX_BODY_BYTES} or a text over
 *   {@link MAX_TEXT_BYTES} end the run `ledger_overflow` (detail `seen` or `body`), since the set could no longer
 *   prove an id new.
 */
export class SeenSet {
  private readonly tokens = new Set<string>();

  /**
   * Adds the tokens of `text`.
   *
   * @param what where it came from, for the hint (`a response body`, `page text`, `a request`).
   * @param limit the byte cap of this source.
   * @throws {RunError} `ledger_overflow` over a cap.
   */
  add(text: string, what: string, limit: number = MAX_BODY_BYTES): void {
    this.fits(Buffer.byteLength(text), what, limit);
    for (const t of idTokens(text)) this.tokens.add(t);
    if (this.tokens.size > MAX_SEEN)
      throw new RunError(
        'ledger_overflow',
        `ledger_overflow (seen): the run saw more than ${MAX_SEEN} distinct ids, so a created id can no longer be proven new; the run stopped and cleans up what it created.`,
      );
  }

  /**
   * Checks a source of `bytes` against its cap before it is read.
   *
   * @throws {RunError} `ledger_overflow` (detail `body`) over the cap.
   */
  fits(bytes: number, what: string, limit: number = MAX_BODY_BYTES): void {
    if (bytes > limit)
      throw new RunError(
        'ledger_overflow',
        `ledger_overflow (body): ${what} is over ${limit} bytes, so it cannot be scanned for ids; the run stopped and cleans up what it created.`,
      );
  }

  /** Whether `id` (canonical) was seen. */
  has(id: string): boolean {
    return this.tokens.has(id);
  }
}
