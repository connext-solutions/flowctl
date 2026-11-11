/**
 * Env-input tripwire of T0.13, used by `check-arch.mjs`: finds the places in `packages/*\/src` that read the
 * process environment or that define or consume an `env` input key, so new ones can be refused until T1.14
 * (the trust-store allowlist, ADR 0024 section 7, issue #41) decides which names a flow may read.
 *
 * @remarks Deliberately broader than flow inputs: any new environment read in `packages/*\/src`, cli and mcp
 * configuration included, is owner-gated until T1.14, because a flow input can reach the environment through
 * any of them and a static scan cannot tell which read serves an input.
 *
 * @remarks Found with the TypeScript parser (comments and strings do not count). A finding is
 * `{ construct, line }`; the baseline in `env-input-baseline.mjs` lists the accepted ones per file and
 * construct, with a count and no line numbers.
 * - `process.env`, `Bun.env`, `import.meta.env`: any reference, in any syntax (`process['env']`,
 *   `globalThis.process.env`, `self.process?.env`, `window.Bun.env`, `process?.["env"]`). Aliases, destructuring,
 *   spread and `Object.entries(...)` all contain the reference itself, so they are found at that reference.
 * - `process[<expr>]`, `Bun[<expr>]`, `globalThis[<expr>]` (also `global`, `self`, `window`) and
 *   `import.meta[<expr>]` with a key that is not a literal: `process-dynamic` and so on.
 * - the roots used as a value (`const p = process`, `const { env } = process`, `Reflect.get(process, 'env')`,
 *   `foo(process)`, `{ process }`): `process-value`, `Bun-value`, `globalThis-value`, `import.meta-value`.
 *   A static other member (`process.cwd`, `globalThis.fetch`, `import.meta.url`) and `typeof process` are fine.
 * - an import or load of `node:process`, `process` or `bun` that is not the plain default import named
 *   `process` of the first two: `import { env } from 'bun'`, `import * as B from 'bun'`, `import p = require()`,
 *   `export ... from`, `import()`, and any call named `require` or `getBuiltinModule` (identifier or member:
 *   `module.require`, `import.meta.require`, `process.mainModule.require`, `process.getBuiltinModule`), a call
 *   of `createRequire(...)(...)`, and a call of a name bound in the same file to `createRequire(...)`, to
 *   `require` or to `<x>.require` / `<x>.getBuiltinModule` (`const r = createRequire(u); r('bun')`), when the
 *   first argument is one of those module names as a literal.
 * - an `env` key in the object literal given to `z.object`, `strictObject`, `looseObject`, `extend` or
 *   `safeExtend` in any package (parentheses, `as`, `satisfies` and `!` around the literal are looked through;
 *   quoted and computed-literal keys and a spread of an object literal that holds `env` count).
 * - consumers of an existing input: `'env' in x`, `Object.hasOwn(x, 'env')`, `x.hasOwnProperty('env')`,
 *   `const { env } = x` (also `{ env: e }`, `{ 'env': e }`, `{ ['env']: e }`), `x === 'env'`, `!==`, `==`, `!=`
 *   (literal on either side) and `case 'env':`.
 *
 * @remarks NOT detected. This is a tripwire for mistakes and cheap tricks, not a defence against a hostile
 * change, which can also edit this script or the baseline; the controls are T1.14 and the owner's review.
 * - Code built at run time: `eval('process.env')` and `new Function(...)` (only the existing guarded-risk rule of
 *   `check-arch.mjs` stops those), `(function () { return this })().process`, a module or key name built by
 *   concatenation or a variable (`process.getBuiltinModule(name)`), `Reflect.has(o, 'env')`.
 * - Reading the environment another way: a child process (`printenv`), `/proc/self/environ`,
 *   `process.loadEnvFile`, a dotenv package, a native addon.
 * - Indirect loaders: `(0, require)(...)`, `.call`, `Reflect.apply`, `module['require']`, `module.constructor._load`,
 *   `import { createRequire as cr }`, a loader alias assigned later or in another file, and
 *   `import.meta.resolve` / `require.resolve` (which only resolve a path).
 * - Key checks written another way: assignment destructuring `({ env } = x)`, `o['env']`,
 *   `Object.prototype.hasOwnProperty.call(x, 'env')`, `Object.keys(o).includes('env')`.
 * - Schema builders other than the five named: `.catchall({ env })`, `.merge(...)`, a `.shape` spread.
 * - A schema shape built in a variable and passed to `z.object(shape)`; an `env` key in a schema that is not
 *   zod; a discriminator written as `kind: 'env'`; `.env` read from an object that holds the input (`src.env`
 *   in `flow/templates.ts`).
 * - New call sites of an already-baselined default (`resolveInputs(env = process.env)`, `trustStorePath()`, the
 *   System 1 key lookup): the baseline counts per file and construct, so swapping one read for another of the
 *   same construct in the same file passes.
 * - Files outside `packages/*\/src`: tests, `bin/`, root `lib/` and config files.
 * - The stale-entry check runs only when the checked repo carries `scripts/env-input-baseline.mjs`.
 *
 * @remarks Over-detection, kept on purpose (each needs an owner baseline edit): a parameter or local named
 * `process` or `Bun` whose `.env` is read; a label or `break process`; `import type { env } from 'bun'`;
 * `typeof process.env` in a value position; an ordinary `{ env }` option-bag parameter or `x === 'env'`
 * comparison anywhere in `packages/*\/src`.
 */
import ts from 'typescript';

const GLOBALS = new Set(['globalThis', 'global', 'self', 'window']);
const ROOTS = new Set(['process', 'Bun', ...GLOBALS]);
const PROCESS_MODULES = new Set(['node:process', 'process', 'bun']);
const PLAIN_DEFAULT_OK = new Set(['node:process', 'process']);
const LOADERS = new Set(['require', 'getBuiltinModule']);
const SCHEMA_FNS = new Set(['object', 'strictObject', 'looseObject', 'extend', 'safeExtend']);
const LITERAL = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
const WRAPPERS = (n) =>
  ts.isParenthesizedExpression(n) ||
  ts.isAsExpression(n) ||
  ts.isSatisfiesExpression(n) ||
  ts.isNonNullExpression(n) ||
  ts.isTypeAssertionExpression(n);

/** Looks through parentheses, assertions and `!` upwards (to the use). */
const up = (node) => {
  let n = node;
  while (n.parent !== undefined && WRAPPERS(n.parent) && n.parent.expression === n) n = n.parent;
  return n;
};
/** Looks through them downwards (to the value). */
const down = (node) => {
  let n = node;
  while (WRAPPERS(n)) n = n.expression;
  return n;
};

/** Member name of an access whose key is a literal, `null` for a computed key. */
const keyOf = (access) => {
  if (ts.isPropertyAccessExpression(access)) return access.name.text;
  const arg = down(access.argumentExpression);
  return LITERAL(arg) ? arg.text : null;
};

/** Whether this identifier is a name being declared or a member name rather than a use of the global. */
const isNameOnly = (id) => {
  const p = id.parent;
  if (ts.isShorthandPropertyAssignment(p)) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return true;
  if (ts.isTypeQueryNode(p) || ts.isQualifiedName(p) || ts.isTypeReferenceNode(p)) return true;
  if (ts.isTypeOfExpression(p)) return true;
  return p.name === id;
};

/** Classifies the use of a root global (`process`, `Bun`, `globalThis`, `global`, `import.meta`). */
const classify = (rootName, start) => {
  let root = rootName;
  let cur = up(start);
  for (;;) {
    const parent = cur.parent;
    const access =
      parent !== undefined &&
      (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
      parent.expression === cur;
    if (!access) return `${root}-value`;
    const key = keyOf(parent);
    if (key === null) return `${root}-dynamic`;
    if (key === 'env' && !GLOBALS.has(root)) return `${root}.env`;
    if (GLOBALS.has(root) && ROOTS.has(key)) {
      root = key;
      cur = up(parent);
      continue;
    }
    return undefined;
  }
};

const calleeName = (call) => {
  const c = down(call.expression);
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return undefined;
};
const nameText = (n) => {
  if (n === undefined) return undefined;
  if (ts.isIdentifier(n) || LITERAL(n)) return n.text;
  if (ts.isComputedPropertyName(n) && LITERAL(down(n.expression))) return down(n.expression).text;
  return undefined;
};
const keyName = (p) => nameText(p.name);
const COMPARES = [
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
];
const isEnvLiteral = (x) => LITERAL(down(x)) && down(x).text === 'env';
const isLoaderValue = (init) => {
  const v = down(init);
  if (ts.isCallExpression(v)) return calleeName(v) === 'createRequire';
  if (ts.isIdentifier(v)) return LOADERS.has(v.text);
  return ts.isPropertyAccessExpression(v) && LOADERS.has(v.name.text);
};

/** Whether a property is keyed `env`, directly, by a computed literal, or inside a spread object literal. */
const hasEnvKey = (p) => {
  if (ts.isSpreadAssignment(p)) {
    const e = down(p.expression);
    return ts.isObjectLiteralExpression(e) && e.properties.some(hasEnvKey);
  }
  return keyName(p) === 'env';
};

/**
 * Scans one source text.
 *
 * @returns `{ construct, line }[]`, in source order.
 */
export const scanEnvReads = (file, text) => {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const loaderNames = new Set();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && isLoaderValue(node.initializer))
      loaderNames.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const add = (node, construct) => {
    if (construct !== undefined)
      found.push({ construct, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  };
  const visit = (node) => {
    if (ts.isIdentifier(node) && ROOTS.has(node.text) && !isNameOnly(node)) add(node, classify(node.text, node));
    else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword)
      add(node, classify('import.meta', node));
    else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier;
      const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
      const plain = clause !== undefined && clause.name?.text === 'process' && clause.namedBindings === undefined;
      if (spec !== undefined && LITERAL(spec) && PROCESS_MODULES.has(spec.text) && !(plain && PLAIN_DEFAULT_OK.has(spec.text)))
        add(node, 'process-module-import');
    } else if (
      ts.isExternalModuleReference(node) &&
      LITERAL(node.expression) &&
      PROCESS_MODULES.has(node.expression.text)
    )
      add(node, 'process-module-import');
    else if (ts.isCallExpression(node)) {
      const callee = down(node.expression);
      const arg = node.arguments[0] === undefined ? undefined : down(node.arguments[0]);
      const name = calleeName(node);
      const loader =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        LOADERS.has(name ?? '') ||
        (ts.isIdentifier(callee) && loaderNames.has(callee.text)) ||
        (ts.isCallExpression(callee) && calleeName(callee) === 'createRequire');
      if (loader && arg !== undefined && LITERAL(arg) && PROCESS_MODULES.has(arg.text))
        add(node, 'process-module-import');
      if ((name === 'hasOwn' || name === 'hasOwnProperty') && node.arguments.some((a) => LITERAL(down(a)) && down(a).text === 'env'))
        add(node, "hasOwn 'env'");
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      const left = down(node.left);
      if (LITERAL(left) && left.text === 'env') add(node, "'env' in");
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent) && nameText(node.propertyName ?? node.name) === 'env') {
      add(node, "destructured 'env'");
    } else if (ts.isBinaryExpression(node) && COMPARES.includes(node.operatorToken.kind) && (isEnvLiteral(node.left) || isEnvLiteral(node.right))) {
      add(node, "compared with 'env'");
    } else if (ts.isCaseClause(node) && isEnvLiteral(node.expression)) {
      add(node, "compared with 'env'");
    } else if (ts.isObjectLiteralExpression(node)) {
      const use = up(node);
      if (ts.isCallExpression(use.parent) && use.parent.arguments.includes(use) && SCHEMA_FNS.has(calleeName(use.parent) ?? ''))
        for (const p of node.properties) if (hasEnvKey(p)) add(p, 'schema key env');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};

const keyFor = (file, construct) => `${file}\0${construct}`;
const GUIDE =
  'New env input paths are blocked until T1.14 implements the trust-store allowlist (ADR 0024 section 7, issue #41). ' +
  'Resolve the value through an injected parameter, not the process environment. ' +
  'Adding an entry to scripts/env-input-baseline.mjs needs the owner.';

/**
 * Compares findings with the baseline.
 *
 * @param found `{ file, construct, line }[]` from every scanned file.
 * @param baseline `{ file, construct, count, why }[]`.
 * @param stale when true, a baseline entry with fewer findings than its count is a problem too, so the list
 * cannot keep entries for code that is gone (the caller turns it on only when the repo carries the baseline).
 * @returns `{ file, line, msg }[]`.
 */
export const compareEnvBaseline = (found, baseline, stale) => {
  const problems = [];
  const allowed = new Map();
  for (const b of baseline) {
    const k = keyFor(b.file, b.construct);
    if (allowed.has(k))
      problems.push({ file: b.file, line: 0, msg: `duplicate env baseline entry for ${b.construct}; merge into one count` });
    allowed.set(k, b.count);
  }
  const groups = new Map();
  for (const f of found) {
    const k = keyFor(f.file, f.construct);
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  for (const [k, list] of groups) {
    const max = allowed.get(k) ?? 0;
    if (list.length <= max) continue;
    for (const f of list)
      problems.push({ file: f.file, line: f.line, msg: `${f.construct}: ${list.length} found, baseline allows ${max}. ${GUIDE}` });
  }
  if (stale)
    for (const b of baseline) {
      const n = groups.get(keyFor(b.file, b.construct))?.length ?? 0;
      if (n < b.count)
        problems.push({
          file: b.file,
          line: 0,
          msg: `stale env baseline entry (${b.construct}: baseline ${b.count}, found ${n}); lower or remove it in scripts/env-input-baseline.mjs (the owner approves this too)`,
        });
    }
  return problems;
};
