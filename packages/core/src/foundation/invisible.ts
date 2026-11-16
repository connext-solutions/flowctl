/**
 * The code points ADR 0020 section d calls invisible, as the inside of a regex character class (use with the `u`
 * flag): control, format, lone surrogate, line and paragraph separator, private-use, unassigned and
 * default-ignorable code points.
 *
 * @example new RegExp(`[${INVISIBLE_CLASS}]`, 'gu')
 */
export const INVISIBLE_CLASS =
  '\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}\\p{Co}\\p{Cn}\\p{Default_Ignorable_Code_Point}';
