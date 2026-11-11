/** A string leaf of a JSON document: its dotted key path, its text and the line of the text. */
export interface JsonEntry {
  key: string;
  text: string;
  line: number;
}

/** Most nesting levels of a JSON document the index reads. */
export const MAX_JSON_DEPTH = 32;

class JsonSyntax extends Error {}

/** A JSON string token: no raw control character (U+0000 to U+001F), only the escapes JSON allows. */
const JSON_STRING = new RegExp(
  String.raw`"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"`,
  'y',
);

/**
 * A strict JSON reader that keeps the line of every string leaf; `JSON.parse` loses positions. Iterative over
 * containers (an explicit stack), so a deeply nested document cannot overflow the call stack.
 */
class Reader {
  private i = 0;
  private line = 1;
  readonly entries: JsonEntry[] = [];

  constructor(private readonly src: string) {}

  /** @throws {JsonSyntax} on any syntax error, trailing text, or nesting past {@link MAX_JSON_DEPTH}. */
  read(): void {
    const stack: { kind: '{' | '['; path: string[]; n: number }[] = [];
    let key: string[] = [];
    for (;;) {
      this.space();
      const top = stack.at(-1);
      if (top !== undefined) {
        const close = top.kind === '{' ? '}' : ']';
        if (this.peek() === close && top.n === 0) {
          this.i++;
          stack.pop();
          if (!this.afterValue(stack)) return this.end();
          continue;
        }
        if (top.kind === '{') {
          if (this.peek() !== '"') throw new JsonSyntax();
          const name = this.string().value;
          this.space();
          this.expect(':');
          key = [...top.path, name];
        } else key = [...top.path, String(top.n)];
        top.n++;
        this.space();
      }
      const c = this.peek();
      if (c === '{' || c === '[') {
        if (stack.length >= MAX_JSON_DEPTH) throw new JsonSyntax();
        this.i++;
        stack.push({ kind: c, path: key, n: 0 });
        continue;
      }
      if (c === '"') {
        const { value, line } = this.string();
        if (stack.length > 0)
          this.entries.push({ key: key.join('.'), text: value, line });
      } else this.scalar();
      if (!this.afterValue(stack)) return this.end();
    }
  }

  /** After a value: a `,` (more to come), or closing brackets; `false` when the document is complete. */
  private afterValue(stack: { kind: '{' | '['; n: number }[]): boolean {
    for (;;) {
      const top = stack.at(-1);
      if (top === undefined) return false;
      this.space();
      if (this.peek() === ',') {
        this.i++;
        return true;
      }
      this.expect(top.kind === '{' ? '}' : ']');
      stack.pop();
    }
  }

  private end(): void {
    this.space();
    if (this.i !== this.src.length) throw new JsonSyntax();
  }

  private peek(): string | undefined {
    return this.src[this.i];
  }

  private expect(c: string): void {
    if (this.src[this.i] !== c) throw new JsonSyntax();
    this.i++;
  }

  private space(): void {
    for (;;) {
      const c = this.src[this.i];
      if (c === '\n') this.line++;
      else if (c !== ' ' && c !== '\t' && c !== '\r') return;
      this.i++;
    }
  }

  private scalar(): void {
    const m =
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        this.src.slice(this.i, this.i + 400),
      );
    if (m === null) throw new JsonSyntax();
    this.i += m[0].length;
  }

  private string(): { value: string; line: number } {
    const line = this.line;
    const end = JSON_STRING;
    end.lastIndex = this.i;
    const m = end.exec(this.src);
    if (m === null) throw new JsonSyntax();
    this.i = end.lastIndex;
    const value: unknown = JSON.parse(m[0]);
    if (typeof value !== 'string') throw new JsonSyntax();
    return { value, line };
  }
}

/**
 * The string leaves of a JSON document with their dotted key path (`a.b`, array items by index: `c.0`) and line,
 * in document order; `undefined` when the text is not strict JSON or nests deeper than {@link MAX_JSON_DEPTH}.
 * A string at the top level has no key and is not returned.
 */
export function parseJsonEntries(src: string): JsonEntry[] | undefined {
  const reader = new Reader(src);
  try {
    reader.read();
  } catch (e) {
    if (e instanceof JsonSyntax) return undefined;
    throw e;
  }
  return reader.entries;
}
