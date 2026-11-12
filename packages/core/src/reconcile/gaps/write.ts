import { join } from 'node:path';
import { hideInvisible, mdCode } from '../../derive/index.js';
import {
  assertNotSymlink,
  ensureDirInside,
  writeFileNoFollow,
} from '../../foundation/index.js';
import {
  type CoverageGap,
  type CoverageGaps,
  CoverageGapsSchema,
  type GapKind,
  GAP_KINDS,
  type GapOperation,
  type GapPage,
} from './schema.js';

/** The section heading of each kind in `gaps.md`. */
const HEADINGS: Record<GapKind, string> = {
  route_unvisited: 'Code routes no crawled page matches',
  page_no_route: 'Crawled pages no code route declares',
  operation_no_ui: 'Operations with no screen',
  operation_ambiguous: 'Operations with tied screens',
  page_no_spec: 'Pages no operation matched',
};

const CAVEAT_TEXT = {
  crawl_truncated: 'crawl stopped early',
  paths_redacted: 'a page path is redacted',
} as const;

const pageText = (p: GapPage): string =>
  `${mdCode(p.path)} ${mdCode(p.title)} (status ${p.status}, ${mdCode(p.pointer)})`;

const operationText = (o: GapOperation): string =>
  `${mdCode(o.id)} ${mdCode(o.title)} from ${mdCode(o.provider)} ${mdCode(o.ref)}`;

/** One gap as a markdown list entry; every string from the code, the map or the spec goes through `mdCode`. */
function entry(g: CoverageGap): string {
  const note =
    g.caveats.length === 0
      ? ''
      : ` (${g.caveats.map((c) => CAVEAT_TEXT[c]).join(', ')})`;
  switch (g.kind) {
    case 'route_unvisited':
      return `- ${mdCode(g.route.path)} (${mdCode(g.route.file)} line ${g.route.line}, ${mdCode(g.route.source)})${note}`;
    case 'page_no_route':
    case 'page_no_spec':
      return `- ${pageText(g.page)}${note}`;
    case 'operation_no_ui':
      return `- ${operationText(g.operation)}${note}`;
    case 'operation_ambiguous': {
      const pages = g.pages
        .map((p) =>
          p.pointer === null
            ? mdCode(p.path)
            : `${mdCode(p.path)} (${mdCode(p.pointer)})`,
        )
        .join(', ');
      return `- ${operationText(g.operation)}: ${pages}${note}`;
    }
  }
}

/**
 * The gaps as a markdown file for a person: a header with the crawl, the caveats and the kinds not checked, then
 * one section per checked kind, in {@link GAP_KINDS} order, with one list entry per gap or `None.`.
 *
 * @remarks Every untrusted string (route files and patterns, page paths and titles, operation ids, titles and
 *   refs) is one code span (`mdCode`); entries are list items, never table cells, where a `|` would split a cell.
 */
export function gapsMarkdown(gaps: CoverageGaps): string {
  const crawl =
    gaps.origin === null
      ? 'No app map.'
      : `App map of ${mdCode(gaps.origin)}, observed ${mdCode(gaps.observedAt ?? '')}.`;
  const count = `${gaps.gaps.length} ${gaps.gaps.length === 1 ? 'gap' : 'gaps'}.`;
  const lines = ['# Coverage gaps', '', `${crawl} ${count}`];
  if (gaps.truncated)
    lines.push(
      'The crawl stopped early, so a route or screen reported missing may only be past the page budget.',
    );
  if (gaps.redactedPages > 0)
    lines.push(
      `${gaps.redactedPages === 1 ? '1 page path holds' : `${gaps.redactedPages} page paths hold`} the redaction mask (\`***\`), which can hide the segment a route names.`,
    );
  const skipped = GAP_KINDS.filter((k) => !gaps.checked.includes(k));
  if (skipped.length > 0)
    lines.push(
      `Not checked (an input is missing): ${skipped.length === GAP_KINDS.length ? 'every kind' : skipped.map((k) => HEADINGS[k].toLowerCase()).join('; ')}.`,
    );
  for (const kind of GAP_KINDS.filter((k) => gaps.checked.includes(k))) {
    const own = gaps.gaps.filter((g) => g.kind === kind);
    lines.push('', `## ${HEADINGS[kind]}`, '');
    lines.push(...(own.length === 0 ? ['None.'] : own.map(entry)));
  }
  return `${lines.join('\n')}\n`;
}

/** The gaps as JSON, every invisible or control code point written as a `\u` escape (`hideInvisible`). */
export function gapsJson(gaps: CoverageGaps): string {
  return `${hideInvisible(JSON.stringify(gaps, null, 2))}\n`;
}

/**
 * Checks `gaps` against {@link CoverageGapsSchema}, then writes `gaps.json` and `gaps.md` into `dir`, which must be
 * inside `root`, and returns their paths.
 *
 * @remarks The pair is not atomic: the JSON goes first since tools read it; regenerate both after an error.
 * @throws {ZodError} when `gaps` does not fit the schema; nothing is written.
 * @throws {ConfigError} when `dir` is not inside `root`, a component on the way is a symlink or a file, or
 *   `gaps.json` or `gaps.md` is already a symlink; nothing is written.
 * @throws {NodeJS.ErrnoException} when the file system refuses the write (`EACCES`, `ENOSPC`), unchanged.
 */
export function writeGaps(
  dir: string,
  root: string,
  gaps: CoverageGaps,
): { markdown: string; json: string } {
  const valid = CoverageGapsSchema.parse(gaps);
  const real = ensureDirInside(dir, root);
  const markdown = join(real, 'gaps.md');
  const json = join(real, 'gaps.json');
  assertNotSymlink(json);
  assertNotSymlink(markdown);
  writeFileNoFollow(json, gapsJson(valid));
  writeFileNoFollow(markdown, gapsMarkdown(valid));
  return { markdown, json };
}
