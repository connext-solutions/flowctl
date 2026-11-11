/**
 * Inline comments of a source file, found with the TypeScript scanner (`commentRanges`), so a `//` inside a
 * string, a regex literal or a template is never a comment and a comment after code is (issue #38).
 *
 * @remarks Allowed, so not returned: JSDoc (`/** … *\/`, wherever it sits) and the tool directives
 * `oxlint-disable…` and `dup-ok` in a `//` or `/* … *\/` comment. Everything else (`// why`, `/* why *\/`,
 * a trailing `// why` after code) is returned with its 1-based line.
 * @remarks Known limits: any comment that starts with `/**` passes, also a `/** why *\/` inside a function body;
 * and in a `.tsx` file a `//` inside JSX text is reported (the repo has no `.tsx` sources today).
 */
import ts from 'typescript';
import { commentRanges } from './module-specs.mjs';

const DIRECTIVE = /^(?:\/\/|\/\*)\s*(?:oxlint-disable|dup-ok)/;

/** @returns the 1-based line of every inline comment in `text`, in order. */
export const inlineCommentLines = (file, text) => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines = [];
  for (const r of commentRanges(sf, text)) {
    const body = text.slice(r.pos, r.end);
    if (body.startsWith('/**') || DIRECTIVE.test(body)) continue;
    lines.push(sf.getLineAndCharacterOfPosition(r.pos).line + 1);
  }
  return lines.sort((a, b) => a - b);
};
