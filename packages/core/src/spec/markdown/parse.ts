import type { ExpectedItem, Operation } from '../schema.js';
import { SpecDocError, splitFrontMatter } from './front-matter.js';

/** One markdown document, read: its path relative to the `specs` root, its bytes and its revision. */
export interface MarkdownDoc {
  path: string;
  bytes: Uint8Array;
  revision: string;
}

/** Collapses runs of ASCII whitespace, trims, and normalises to NFC. */
const clean = (s: string): string =>
  s
    .normalize('NFC')
    .replace(/[ \t\n\r\f\v]+/g, ' ')
    .trim();

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const BULLET = /^ {0,3}[-*+][ \t]+(.*)$/;
const ORDERED = /^ {0,3}\d{1,9}[.)][ \t]+(.*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const QUOTED = /"([^"]+)"|“([^”]+)”/g;

/** The quoted literal of an item when it has exactly one (`"Đã gửi đơn"` gives `Đã gửi đơn`), else `null`. */
function quotedValue(text: string): string | null {
  const found = [...text.matchAll(QUOTED)].map((m) =>
    clean(m[1] ?? m[2] ?? ''),
  );
  return found.length === 1 && found[0] !== '' ? (found[0] ?? null) : null;
}

/** An expected item as the body reader finds it, before the operation's id and title are known. */
interface RawItem {
  text: string;
  value: string | null;
  section: string | null;
  lines: [number, number];
  headings: string[];
  leadIn: string | null;
}

interface Open {
  kind: 'bullet' | 'step';
  first: number;
  last: number;
  parts: string[];
  leadIn: string | null;
}

/**
 * The lines of a markdown body as an operation's steps and expected items. Ordered list entries (`1. ...`) are
 * steps; unordered entries (`- ...`) are expected items, each with its `ref` (section = innermost heading, the
 * entry's inclusive line range) and its `context` (ancestor headings outermost first, and the lead-in: the
 * paragraph just before the list, or `null`). An entry ends at a blank line; indented lines continue it. Fenced
 * code blocks are skipped. Text is data only: nothing in it is interpreted beyond these line shapes.
 */
function readBody(
  lines: readonly string[],
  from: number,
): { headings: string[]; steps: string[]; items: RawItem[] } {
  const stack: { level: number; text: string }[] = [];
  const firstHeadings: string[] = [];
  const steps: string[] = [];
  const items: RawItem[] = [];
  let paragraph: string[] = [];
  let paraOpen = false;
  let listLeadIn: string | null | undefined;
  let listKind: Open['kind'] | undefined;
  let open: Open | undefined;
  let fence: string | undefined;

  const flush = (): void => {
    if (open === undefined) return;
    const text = clean(open.parts.join(' '));
    if (text !== '' && open.kind === 'step') steps.push(text);
    if (text !== '' && open.kind === 'bullet') {
      const headings = stack.map((h) => h.text);
      items.push({
        text,
        value: quotedValue(text),
        section: headings.at(-1) ?? null,
        lines: [open.first, open.last],
        headings,
        leadIn: open.leadIn,
      });
    }
    open = undefined;
  };
  const endBlock = (): void => {
    flush();
    paragraph = [];
    paraOpen = false;
    listLeadIn = undefined;
  };

  for (let i = from; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const n = i + 1;
    if (fence !== undefined) {
      if (line.trim().startsWith(fence)) fence = undefined;
      continue;
    }
    const fenced = FENCE.exec(line);
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (fenced !== null) {
      endBlock();
      fence = fenced[1] ?? '```';
    } else if (line.trim() === '') {
      flush();
      paraOpen = false;
    } else if (heading !== null) {
      endBlock();
      const level = heading[1]?.length ?? 1;
      while ((stack.at(-1)?.level ?? 0) >= level) stack.pop();
      const text = clean(heading[2] ?? '');
      stack.push({ level, text });
      if (firstHeadings.length === 0) firstHeadings.push(text);
    } else if (bullet !== null || ordered !== null) {
      flush();
      const kind = bullet !== null ? 'bullet' : 'step';
      if (listLeadIn === undefined || listKind !== kind)
        listLeadIn = paragraph.length > 0 ? clean(paragraph.join(' ')) : null;
      listKind = kind;
      open = {
        kind,
        first: n,
        last: n,
        parts: [(bullet ?? ordered)?.[1] ?? ''],
        leadIn: listLeadIn,
      };
      paragraph = [];
      paraOpen = false;
    } else if (open !== undefined && /^[ \t]/.test(line)) {
      open.parts.push(line);
      open.last = n;
    } else {
      flush();
      listLeadIn = undefined;
      if (!paraOpen) paragraph = [];
      paragraph.push(line);
      paraOpen = true;
    }
  }
  flush();
  return { headings: firstHeadings, steps, items };
}

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/**
 * One markdown document as one operation (ADR 0023): `id`, `title`, `actor` and `preconditions` from front matter;
 * without front matter, the id is the path without `.md`, the title the first heading (or that id) and the actor
 * `null`. `location.ref` is the document path; `signatureRef` is passed in by the provider.
 *
 * @throws {SpecDocError} `not_utf8` for bytes that are not UTF-8, `front_matter_invalid` for unsafe front matter.
 */
export function parseMarkdown(
  doc: MarkdownDoc,
  provider: string,
  signatureRef: string | null,
): Operation {
  let text: string;
  try {
    text = decoder.decode(doc.bytes);
  } catch {
    throw new SpecDocError(
      'not_utf8',
      `${doc.path}: the document is not UTF-8`,
    );
  }
  const lines = text.split(/\r?\n/);
  const { meta, body } = splitFrontMatter(doc.path, lines);
  const read = readBody(lines, body);
  const fallbackId = doc.path.replace(/\.md$/, '');
  const id = clean(meta?.id ?? fallbackId);
  const title = clean(meta?.title ?? read.headings[0] ?? fallbackId);
  const expected: ExpectedItem[] = read.items.map((item) => ({
    text: item.text,
    value: item.value,
    ref: {
      doc: doc.path,
      section: item.section,
      lines: item.lines,
      revision: doc.revision,
    },
    context: {
      operationId: id,
      operationTitle: title,
      headings: item.headings,
      leadIn: item.leadIn,
    },
  }));
  return {
    id,
    title,
    actor: meta?.actor === undefined ? null : clean(meta.actor),
    preconditions: (meta?.preconditions ?? []).map(clean),
    steps: read.steps,
    expected,
    location: { provider, ref: doc.path },
    signatureRef,
  };
}
