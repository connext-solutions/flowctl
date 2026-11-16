import { INVISIBLE_CLASS } from '../../spec/index.js';
import { type Emitter, pointerOf } from './emit.js';
import type { DataNode } from './safe-data.js';

const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, 'u');

/**
 * Reads a message catalogue: every string leaf of a flat or nested JSON object becomes a `message` fact whose field
 * is the dotted key (`request.reason.required`, flat or nested) and whose value is the text, opaque (no ICU or
 * placeholder parsing). Numbers, booleans, `null` and arrays are ignored; a leaf with an invisible character or a
 * value that is not NFC is skipped with a typed reason.
 *
 * @param owner the catalogue's name, its file name without the extension (`vi`).
 */
export function i18nFacts(root: DataNode, owner: string, out: Emitter): void {
  if (root.kind !== 'map') return out.skip('not_a_catalogue', root.line);
  const stack: { node: DataNode; path: string[] }[] = [
    { node: root, path: [] },
  ];
  while (stack.length > 0) {
    const top = stack.pop();
    if (top === undefined) break;
    const { node, path } = top;
    if (node.kind === 'map')
      for (const [key, child] of [...node.entries].reverse())
        stack.push({ node: child, path: [...path, key] });
    else if (node.kind === 'scalar' && !node.plain && path.length > 0) {
      if (INVISIBLE.test(node.text)) out.skip('invisible', node.line);
      else if (node.text.normalize('NFC') !== node.text)
        out.skip('not_nfc', node.line);
      else
        out.fact({
          line: node.line,
          pointer: pointerOf(path),
          owner,
          field: path.join('.'),
          rule: 'message',
          value: node.text,
        });
    }
  }
}
