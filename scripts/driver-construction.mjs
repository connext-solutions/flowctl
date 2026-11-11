/**
 * Driver construction tripwire of T5.1, used by `check-arch.mjs` (ADR 0022, "Where `allowedEnvs` is enforced"): a
 * System 1 driver is built only by the factory `createDriver` in `FACTORY`, which checks the env and the trust store
 * before it hands one out.
 *
 * @remarks Found with the TypeScript parser, so comments and strings do not count. Outside `FACTORY`, in source files
 * of every package that are not tests:
 * - `new X(...)`, `new (X)(...)`, `Reflect.construct(X, ...)` and `class … extends X` where `X` is a name ending in
 *   `Driver`, fail;
 * - any reference to a driver class name in `DRIVER_CLASSES` fails, except in the file that declares it (an alias,
 *   a re-export or an import would let another module build one).
 * Tests are exempt: a driver built there is refused at run time by every entry point (`assertDriverFor`).
 * Not detected: a name built at run time (`globalThis[name]`), which the run-time registry still refuses.
 */
import ts from 'typescript';

export const FACTORY = 'packages/core/src/system1/client.ts';
/** Driver classes and the one file allowed to declare each. */
export const DRIVER_CLASSES = new Map([['JevDriver', 'packages/core/src/system1/jev.ts']]);
const DRIVER_NAME = /Driver$/;

const unwrap = (node) => {
  let n = node;
  while (n !== undefined && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)))
    n = n.expression;
  return n;
};
const driverName = (node) => {
  const n = unwrap(node);
  return n !== undefined && ts.isIdentifier(n) && DRIVER_NAME.test(n.text) ? n.text : undefined;
};
const isReflectConstruct = (call) => {
  const callee = unwrap(call.expression);
  return (
    callee !== undefined &&
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'Reflect' &&
    callee.name.text === 'construct'
  );
};

/** @returns every violation in `text` as `{ line, msg }`, 1-based lines. */
export const scanDriverConstruction = (file, text) => {
  if (file === FACTORY) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = [];
  const add = (node, msg) => found.push({ line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, msg });
  const visit = (node) => {
    if (ts.isNewExpression(node)) {
      const name = driverName(node.expression);
      if (name !== undefined) add(node, `constructs ${name} outside the driver factory; obtain one from createDriver (ADR 0022)`);
    } else if (ts.isCallExpression(node) && isReflectConstruct(node)) {
      const name = driverName(node.arguments[0]);
      if (name !== undefined) add(node, `constructs ${name} outside the driver factory; obtain one from createDriver (ADR 0022)`);
    } else if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ExtendsKeyword) {
      for (const t of node.types) {
        const name = driverName(t.expression);
        if (name !== undefined) add(t, `extends ${name} outside the driver factory; a subclass could be built anywhere (ADR 0022)`);
      }
    } else if (ts.isIdentifier(node) && DRIVER_CLASSES.has(node.text) && DRIVER_CLASSES.get(node.text) !== file) {
      add(node, `references ${node.text} outside the driver factory; obtain a driver from createDriver (ADR 0022)`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
};
