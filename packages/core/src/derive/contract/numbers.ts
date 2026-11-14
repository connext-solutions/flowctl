const DATA = /^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,14})?$/;
const JS = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,14})?(?:[eE]\+?\d{1,3})?$/;

/**
 * The one place a number written in a contract becomes a comparable string: `200` and `200.0` give `200`,
 * `1e9` in source code gives `1000000000`. Anything ambiguous or unsafe gives `undefined` (leading zeros, a plus
 * sign, `.5`, `0x10`, digit separators, an exponent in data, more than 15 digits), so two readers can never agree by
 * reading a number differently from the program that consumes it.
 *
 * @param form `data` for YAML, JSON and HTML text (plain decimal, optional minus); `js` for a source-code literal
 *   (no sign: the caller handles a leading `-`; an exponent is allowed).
 */
export function canonicalNumber(
  text: string,
  form: 'data' | 'js',
): string | undefined {
  if (!(form === 'data' ? DATA : JS).test(text)) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER)
    return undefined;
  return String(Object.is(n, -0) ? 0 : n);
}
