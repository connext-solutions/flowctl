import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUG_MODES, CRAWL_BUG_MODES } from '../src/index.js';

const SPEC = fileURLToPath(new URL('../spec', import.meta.url));
const index: Record<string, { doc: string; sentence: string }> = JSON.parse(
  readFileSync(join(SPEC, 'index.json'), 'utf8'),
);

/** The bullets of a doc, each as the whole sentence after `- `. */
const bullets = (doc: string): string[] =>
  readFileSync(join(SPEC, doc), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2));

describe('fixture spec docs (T3.3)', () => {
  it('maps every seeded bug, and nothing else, to one sentence', () => {
    expect(Object.keys(index).sort()).toEqual(
      [...BUG_MODES, ...CRAWL_BUG_MODES].sort(),
    );
  });

  it('points each bug at a verbatim bullet that is one whole sentence', () => {
    for (const [bug, { doc, sentence }] of Object.entries(index)) {
      expect(bullets(doc), bug).toContain(sentence);
      expect(sentence.endsWith('.'), bug).toBe(true);
      expect(sentence.slice(0, -1), bug).not.toMatch(/[.!?]\s/);
    }
  });

  it('keeps every doc in NFC with an id, title and actor', () => {
    for (const doc of new Set(Object.values(index).map((v) => v.doc))) {
      const text = readFileSync(join(SPEC, doc), 'utf8');
      expect(text.normalize('NFC'), doc).toBe(text);
      expect(text, doc).toMatch(
        /^---\nid: [a-z0-9-]+\ntitle: .+\nactor: (employee|manager)\n---\n/,
      );
    }
  });
});
