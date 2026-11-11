/**
 * Module specifiers of a source file, found with the TypeScript parser so that multi-line `import()`,
 * `require`, `createRequire(...)(...)`, `import x = require()`, `import type`, re-exports and several
 * imports on one line are all seen, and comments and unrelated strings are not.
 *
 * @remarks Call forms that count as module loads: `import(...)`, `require(...)`, `require.resolve(...)`,
 * `import.meta.resolve(...)`, `createRequire(...)(...)`, a name bound once to `createRequire(...)` and then
 * called, and the test-runner helpers `vi.mock`, `vi.doMock`, `vi.unmock`, `vi.importActual`,
 * `vi.importMock`, `jest.mock`, `jest.requireActual`. Other calls with string arguments, such as
 * `path.resolve('..', 'x')` or `registry.mock('a')`, are not module loads.
 *
 * @remarks Parentheses, `as`, `satisfies`, `!`, `<T>` assertions and comma expressions around the callee or
 * the argument are looked through. `createRequire` is followed through import aliases
 * (`import { createRequire as cr }`), destructuring and plain assignment; `require` through
 * `const r = require`; `module.require(...)` and `module['require'](...)` count. A load whose argument is
 * not a string literal (a variable, a template with `${}`, a concatenation) comes back as a `dynamic` risk
 * so the caller can say it cannot be checked.
 *
 * @remarks Fail closed: a loader value (`require`, `createRequire`, `module.require`, `process.mainModule`, the
 * result of `createRequire(...)`, or a name bound to one) that is used in any way other than a direct call,
 * a plain alias binding or `.resolve(...)` is an `indirect` risk (`r.call(...)`, `[r][0](...)`, `{ r }`,
 * `c ? r : r`, `() => r`, destructuring). `eval(...)`, `Function(...)`, `new Function(...)` are `eval`
 * risks; `import.meta.glob` and `readdir`/`opendir`/`glob` calls that name a `packages` directory are
 * `enumerate` risks. The caller decides which packages each kind applies to. Parse errors come back as
 * `errors`, because a file that cannot be parsed cannot be checked.
 *
 * @remarks Also treated as specifiers (flagged `indirect: true`; check-arch skips them in test files, where they
 * name data files): `new URL('./x', import.meta.url)`, `new Worker('./x')`, `fork('./x')` and the
 * first path argument of `spawn('node', ['./x'])`. Any member access on a `node:module` binding other than
 * `createRequire`, `import.meta.require`, and every export that carries a loader or `node:module` itself
 * (`export const { createRequire } = ...`, `export * from 'node:module'`, `export default M`) are `indirect`
 * risks. This is a tripwire: the real enforcement is the T0.16 load check over the built output, extended
 * to the layer rules. Specifiers inside comments (`/// <reference
 * path|types>`, JSDoc `@import ... from`, `import("...")` types) and `declare module '...'` are returned as
 * ordinary specifiers.
 */
import ts from 'typescript';

export const SOURCE = /\.(?:[cm]?[jt]sx?)$/i;

/**
 * Decodes every valid ASCII `%XX` sequence on its own and leaves malformed ones (`%zz`, `%`) untouched, so
 * one bad escape cannot disable decoding of the rest. Repeats until stable, at most 10 times.
 */
export const safeDecode = (text) => {
  let out = text;
  for (let i = 0; i < 10; i++) {
    const next = out.replace(/%([0-7][0-9a-f])/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)));
    if (next === out) break;
    out = next;
  }
  return out;
};

const TEST_HELPERS = new Map([
  ['vi', new Set(['mock', 'doMock', 'unmock', 'importActual', 'importMock'])],
  ['jest', new Set(['mock', 'doMock', 'unmock', 'requireActual', 'requireMock'])],
]);

const LITERAL = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
const REQUIRE_HOSTS = new Set(['module', 'globalThis', 'global']);

/** Looks through parentheses, assertions and comma expressions. */
const unwrap = (node) => {
  let n = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(n) ||
      ts.isAsExpression(n) ||
      ts.isSatisfiesExpression(n) ||
      ts.isNonNullExpression(n) ||
      ts.isTypeAssertionExpression(n)
    )
      n = n.expression;
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken) n = n.right;
    else return n;
  }
};

/** Property name of `a.b` or `a['b']`, else undefined. */
const memberName = (node) => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const a = unwrap(node.argumentExpression);
    return LITERAL(a) ? a.text : undefined;
  }
  return undefined;
};

const WRAP = (n) =>
  ts.isParenthesizedExpression(n) ||
  ts.isAsExpression(n) ||
  ts.isSatisfiesExpression(n) ||
  ts.isNonNullExpression(n) ||
  ts.isTypeAssertionExpression(n);
const isComma = (n) => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken;
/** Outermost wrapper (parentheses, assertions, comma tail) around `node`. */
const outer = (node) => {
  let cur = node;
  while (cur.parent !== undefined && (WRAP(cur.parent) || (isComma(cur.parent) && cur.parent.right === cur))) cur = cur.parent;
  return cur;
};
/** Whether `n` is the name part of a declaration or property, not a use of a value. */
const isNamePosition = (n) => {
  const p = n.parent;
  if (p === undefined || ts.isShorthandPropertyAssignment(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isImportClause(p) || ts.isNamespaceImport(p)) return true;
  return p.name === n || p.propertyName === n;
};
const inTypeQuery = (n) => {
  for (let p = n.parent; p !== undefined; p = p.parent) if (ts.isTypeQueryNode(p)) return true;
  return false;
};
const ENUMERATORS = new Set(['readdir', 'readdirSync', 'opendir', 'opendirSync', 'glob', 'globSync']);
const PACKAGES_DIR = /(?:^|[/\\])packages(?:[/\\]|$)/i;
const WINDOW = 1024;
const SPEC_TRIPLE = /^\/\/\/\s*<reference\s+(?:path|types)\s*=\s*(["'])(.+?)\1/;
const SPEC_AT_IMPORT = /^@import\b[^"'`]*?\bfrom\s*(["'])(.+?)\1/;
const SPEC_CALL = /^import\(\s*(["'`])(.+?)\1\s*\)/;
/**
 * Specifiers named in a comment body: a `/// <reference path|types>` line, JSDoc `@import ... from '...'` and
 * `import('...')` types. Each occurrence is matched inside a window of `WINDOW` characters, so the cost is
 * linear in the comment size; a specifier longer than the window is not extracted here (the plugin-name
 * scan covers those with a raw line test).
 */
const commentSpecs = (body) => {
  const out = [];
  const t = SPEC_TRIPLE.exec(body);
  if (t !== null) out.push({ spec: t[2] ?? '', index: 0 });
  for (const [needle, re] of [
    ['@import', SPEC_AT_IMPORT],
    ['import(', SPEC_CALL],
  ]) {
    for (let k = body.indexOf(needle); k !== -1; k = body.indexOf(needle, k + 1)) {
      if (needle === 'import(' && /\w/.test(body[k - 1] ?? '')) continue;
      const m = re.exec(body.slice(k, k + WINDOW));
      if (m !== null) out.push({ spec: m[2] ?? '', index: k });
    }
  }
  return out;
};
const MODULE_NS = /^(?:node:)?module$/;

/**
 * Comment ranges of a file, each position scanned once (a naive per-node scan is quadratic when many
 * nested nodes share a start position in front of a large comment).
 */
export const commentRanges = (sf, text) => {
  const seen = new Set();
  const starts = new Set();
  const ends = new Set();
  const out = [];
  const add = (ranges) => {
    for (const r of ranges ?? []) {
      if (seen.has(r.pos)) continue;
      seen.add(r.pos);
      out.push(r);
    }
  };
  const visit = (node) => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const start = node.getFullStart();
    if (!starts.has(start)) {
      starts.add(start);
      add(ts.getLeadingCommentRanges(text, start));
    }
    const end = node.getEnd();
    if (!ends.has(end)) {
      ends.add(end);
      add(ts.getTrailingCommentRanges(text, end));
    }
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  return out;
};

/**
 * @param file path, used for the script kind
 * @param text file contents
 * @returns `specs` (`{ spec, line }`), `risks` (`{ kind, line }`) and syntax `errors` (`{ message, line }`)
 */
export const scanModule = (file, text) => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const requires = new Set(['require']);
  const creators = new Set(['createRequire']);
  const hosts = new Set(REQUIRE_HOSTS);
  const moduleNs = new Set();
  const isModuleLoad = (n) => {
    const e = unwrap(n instanceof Object && ts.isAwaitExpression(unwrap(n)) ? unwrap(n).expression : n);
    if (!ts.isCallExpression(e)) return false;
    const a = e.arguments[0] === undefined ? undefined : unwrap(e.arguments[0]);
    const c = unwrap(e.expression);
    return a !== undefined && LITERAL(a) && MODULE_NS.test(a.text) && (c.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(c) && requires.has(c.text)));
  };
  const isRequireRef = (n) => {
    const e = unwrap(n);
    if (ts.isIdentifier(e)) return requires.has(e.text);
    if (memberName(e) === 'require' && ts.isMetaProperty(unwrap(e.expression))) return true;
    return memberName(e) === 'require' && ts.isIdentifier(unwrap(e.expression)) && hosts.has(unwrap(e.expression).text);
  };
  const isCreatorRef = (n) => {
    const e = unwrap(n);
    return ts.isIdentifier(e) ? creators.has(e.text) : memberName(e) === 'createRequire';
  };
  const isCreateRequire = (n) => {
    const e = unwrap(n);
    return ts.isCallExpression(e) && isCreatorRef(e.expression);
  };
  let grew = true;
  const bind = (set, name) => {
    if (!set.has(name)) {
      set.add(name);
      grew = true;
    }
  };
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      if (ts.isIdentifier(node.name)) {
        if (isModuleLoad(node.initializer)) bind(moduleNs, node.name.text);
        if (isCreateRequire(node.initializer) || isRequireRef(node.initializer)) bind(requires, node.name.text);
        if (isCreatorRef(node.initializer)) bind(creators, node.name.text);
      }
    } else if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) {
      if ((node.propertyName ?? node.name).getText(sf) === 'createRequire') bind(creators, node.name.text);
    } else if (ts.isImportSpecifier(node) && (node.propertyName ?? node.name).text === 'createRequire') {
      bind(creators, node.name.text);
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /^(?:node:)?module$/.test(node.moduleSpecifier.text)) {
      const c = node.importClause;
      if (c?.name !== undefined) {
        bind(hosts, c.name.text);
        bind(moduleNs, c.name.text);
      }
      if (c?.namedBindings !== undefined && ts.isNamespaceImport(c.namedBindings)) {
        bind(hosts, c.namedBindings.name.text);
        bind(moduleNs, c.namedBindings.name.text);
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = unwrap(node.left);
      if (ts.isIdentifier(l)) {
        if (isCreateRequire(node.right) || isRequireRef(node.right)) bind(requires, l.text);
        if (isCreatorRef(node.right)) bind(creators, l.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  while (grew) {
    grew = false;
    collect(sf);
  }
  const specs = [];
  const risks = [];
  const add = (node, indirect = false) =>
    specs.push({ spec: node.text, raw: node.getText(sf), line: lineOf(node.getStart(sf)), indirect });
  const risk = (kind, node) => risks.push({ kind, line: lineOf(node.getStart(sf)) });
  const loads = (callee) => {
    const c = unwrap(callee);
    if (c.kind === ts.SyntaxKind.ImportKeyword) return true;
    if (ts.isIdentifier(c)) return requires.has(c.text);
    if (isCreateRequire(c)) return true;
    const name = memberName(c);
    if (name === undefined) return false;
    const obj = unwrap(c.expression);
    if (name === 'require' && ts.isIdentifier(obj) && hosts.has(obj.text)) return true;
    if (ts.isIdentifier(obj) && requires.has(obj.text) && name === 'resolve') return true;
    if (ts.isMetaProperty(obj) && (name === 'resolve' || name === 'require')) return true;
    return ts.isIdentifier(obj) && (TEST_HELPERS.get(obj.text)?.has(name) ?? false);
  };
  const loaderUseOk = (v) => {
    const o = outer(v);
    const p = o.parent;
    if (p === undefined) return false;
    if (ts.isCallExpression(p) && p.expression === o) return true;
    if (ts.isVariableDeclaration(p) && p.initializer === o && ts.isIdentifier(p.name)) return true;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === o && ts.isIdentifier(unwrap(p.left)))
      return true;
    return (
      (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) &&
      p.expression === o &&
      memberName(p) === 'resolve' &&
      p.parent !== undefined &&
      ts.isCallExpression(p.parent) &&
      p.parent.expression === p
    );
  };
  const isLoaderValue = (node) => {
    if (ts.isIdentifier(node)) return !isNamePosition(node) && !inTypeQuery(node) && (requires.has(node.text) || creators.has(node.text));
    if (ts.isCallExpression(node)) return isCreateRequire(node);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = memberName(node);
      const obj = unwrap(node.expression);
      if (name === 'createRequire') return true;
      if (name === 'require' && ts.isMetaProperty(obj)) return true;
      return name === 'require' && ts.isIdentifier(obj) && hosts.has(obj.text);
    }
    return false;
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
      if (ts.isStringLiteral(node.moduleSpecifier)) add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const e = node.moduleReference.expression;
      if (ts.isStringLiteral(e)) add(e);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      if (ts.isStringLiteral(node.argument.literal)) add(node.argument.literal);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      add(node.name);
    } else if (ts.isCallExpression(node) && loads(node.expression)) {
      const a = node.arguments[0] === undefined ? undefined : unwrap(node.arguments[0]);
      if (a !== undefined && LITERAL(a)) add(a);
      else if (a !== undefined) risk('dynamic', node);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && (callee.text === 'eval' || callee.text === 'Function')) risk('eval', node);
      const name = ts.isIdentifier(callee) ? callee.text : memberName(callee);
      if (ts.isCallExpression(node) && name !== undefined && ENUMERATORS.has(name)) {
        let hit = false;
        const look = (n) => {
          if (LITERAL(n) && PACKAGES_DIR.test(n.text)) hit = true;
          ts.forEachChild(n, look);
        };
        node.arguments.forEach(look);
        if (hit) risk('enumerate', node);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(callee) && ts.isMetaProperty(callee.expression) && callee.name.text === 'glob')
        risk('enumerate', node);
    }
    if (isLoaderValue(node) && !loaderUseOk(node)) risk('indirect', node);
    const carriesLoader = (e) => {
      const v = unwrap(ts.isAwaitExpression(unwrap(e)) ? unwrap(e).expression : e);
      return (
        isCreateRequire(v) ||
        isRequireRef(v) ||
        isCreatorRef(v) ||
        isModuleLoad(v) ||
        (ts.isIdentifier(v) && (moduleNs.has(v.text) || v.text === 'module'))
      );
    };
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      node.parent?.parent !== undefined &&
      ts.isVariableStatement(node.parent.parent) &&
      node.parent.parent.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      carriesLoader(node.initializer)
    )
      risk('indirect', node);
    if (ts.isExportAssignment(node) && carriesLoader(node.expression)) risk('indirect', node);
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier) && MODULE_NS.test(node.moduleSpecifier.text))
      risk('indirect', node);
    if (ts.isIdentifier(node) && moduleNs.has(node.text) && !isNamePosition(node) && ts.isExportSpecifier(node.parent))
      risk('indirect', node);
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(unwrap(node.expression)) &&
      moduleNs.has(unwrap(node.expression).text) &&
      memberName(node) !== 'createRequire'
    )
      risk('indirect', node);
    if (ts.isNewExpression(node)) {
      const c = unwrap(node.expression);
      const a0 = node.arguments?.[0] === undefined ? undefined : unwrap(node.arguments[0]);
      const base = node.arguments?.[1] === undefined ? undefined : unwrap(node.arguments[1]);
      if (ts.isIdentifier(c) && c.text === 'URL' && a0 !== undefined && LITERAL(a0) && base !== undefined && ts.isPropertyAccessExpression(base) && ts.isMetaProperty(base.expression))
        add(a0, true);
      else if (ts.isIdentifier(c) && c.text === 'Worker' && a0 !== undefined && LITERAL(a0) && a0.text.startsWith('.')) add(a0, true);
    }
    if (ts.isCallExpression(node)) {
      const c = unwrap(node.expression);
      const name = ts.isIdentifier(c) ? c.text : memberName(c);
      const a0 = node.arguments[0] === undefined ? undefined : unwrap(node.arguments[0]);
      const a1 = node.arguments[1] === undefined ? undefined : unwrap(node.arguments[1]);
      if (name === 'fork' && a0 !== undefined && LITERAL(a0) && a0.text.startsWith('.')) add(a0, true);
      if ((name === 'spawn' || name === 'spawnSync') && a1 !== undefined && ts.isArrayLiteralExpression(a1)) {
        const first = a1.elements[0] === undefined ? undefined : unwrap(a1.elements[0]);
        if (first !== undefined && LITERAL(first) && first.text.startsWith('.')) add(first, true);
      }
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'mainModule' && ts.isIdentifier(node.expression) && node.expression.text === 'process')
      risk('indirect', node);
    if (ts.isElementAccessExpression(node) && !LITERAL(unwrap(node.argumentExpression))) {
      const obj = unwrap(node.expression);
      if (ts.isIdentifier(obj) && (hosts.has(obj.text) || obj.text === 'process')) risk('indirect', node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const r of commentRanges(sf, text)) {
    const body = text.slice(r.pos, r.end);
    for (const c of commentSpecs(body)) specs.push({ spec: c.spec, raw: c.spec, line: lineOf(r.pos + c.index) });
  }
  const errors = (sf.parseDiagnostics ?? []).map((d) => ({
    message: ts.flattenDiagnosticMessageText(d.messageText, ' '),
    line: lineOf(d.start ?? 0),
  }));
  return { specs, risks, errors };
};
