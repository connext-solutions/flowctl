import type { AppMap } from '../../observe/index.js';
import type { Operation } from '../../spec/index.js';
import { normText, refusal } from './text.js';
import type { MapElement, RefusedElement, SpecPath } from './types.js';

/** Where a spec string comes from, which decides the rules it takes part in (ADR 0034). */
export type SpecRole = 'title' | 'heading' | 'step' | 'expected';

/** A spec string, normalised, with its path in the operation. */
export interface SpecText {
  role: SpecRole;
  path: SpecPath;
  text: string;
}

/**
 * The strings of `op` the matcher reads: the title, each distinct heading of the expected items' context (a heading
 * equal to the title or to an earlier heading is left out), the steps and the expected items' text.
 */
export function specTexts(op: Operation): SpecText[] {
  const title = normText(op.title);
  const out: SpecText[] = [{ role: 'title', path: ['title'], text: title }];
  const seen = new Set([title]);
  op.expected.forEach((item, i) =>
    item.context.headings.forEach((h, k) => {
      const text = normText(h);
      if (seen.has(text)) return;
      seen.add(text);
      out.push({
        role: 'heading',
        path: ['expected', i, 'context', 'headings', k],
        text,
      });
    }),
  );
  op.steps.forEach((s, i) =>
    out.push({ role: 'step', path: ['steps', i], text: normText(s) }),
  );
  op.expected.forEach((item, i) =>
    out.push({
      role: 'expected',
      path: ['expected', i, 'text'],
      text: normText(item.text),
    }),
  );
  return out;
}

/** A map element with its normalised text. */
export interface Named {
  element: MapElement;
  text: string;
}

/** A page of the map as the matcher reads it. */
export interface PageIndex {
  path: string;
  title: string;
  status: number;
  titleElement: Named | null;
  names: Named[];
}

/** The pages of a map, their matchable elements, and the elements the Unicode rules refuse. */
export interface MapIndex {
  pages: PageIndex[];
  refused: RefusedElement[];
}

/**
 * Indexes `map`: per page, its title and every control and form field name, normalised. An element whose text is
 * refused ({@link refusal}) is left out and listed in `refused`; an empty name is left out silently.
 */
export function indexMap(map: AppMap): MapIndex {
  const refused: RefusedElement[] = [];
  const keep = (element: MapElement): Named | null => {
    const text = normText(element.name);
    if (text === '') return null;
    const reason = refusal(text);
    if (reason === null) return { element, text };
    refused.push({ element, reason });
    return null;
  };
  const pages = map.pages.map((p): PageIndex => {
    const names: Named[] = [];
    p.controls.forEach((c, index) => {
      const n = keep({ kind: 'control', page: p.path, index, ...c });
      if (n !== null) names.push(n);
    });
    p.forms.forEach((f, form) =>
      f.fields.forEach((field, index) => {
        const n = keep({
          kind: 'field',
          page: p.path,
          form,
          index,
          role: field.role,
          name: field.name,
        });
        if (n !== null) names.push(n);
      }),
    );
    return {
      path: p.path,
      title: p.title,
      status: p.status,
      titleElement: keep({ kind: 'title', page: p.path, name: p.title }),
      names,
    };
  });
  return { pages, refused };
}
