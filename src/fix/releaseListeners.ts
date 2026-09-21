/**
 * Releasing DOM event listeners.
 *
 * addEventListener/removeEventListener match on function IDENTITY, not on
 * event name alone - so the fix that actually works is exactly the one the
 * analyzer already recommends by hand: give the handler a stable home (a
 * class field) if it does not already have one, then remove it with the
 * same reference.
 *
 * WHAT THIS REFUSES, PER LISTENER (not per class)
 * ------------------------------------------------
 * Each addEventListener call is judged on its own. One call this cannot
 * reason about does not block the others - unlike the subscribe() fixer,
 * there is no shared field whose completeness this could misrepresent;
 * removeEventListener calls are independent statements, and the leak
 * verification step re-runs the real analyzer afterwards regardless, so an
 * honestly partial fix here is never reported as more than it is.
 *
 * Refused, per call, when:
 *   - the event name is not a plain string literal (a dynamic name cannot
 *     be trusted to still evaluate the same way at removal time)
 *   - the handler is a `function` expression (rebinds `this`), or a bare
 *     identifier that is not a member of this class (a local variable or
 *     parameter would not be in scope inside ngOnDestroy)
 *   - an inline arrow handler closes over a local variable this cannot
 *     safely re-declare as a class field initializer
 *   - the target (the thing addEventListener is called on) or the options
 *     argument is not a simple, side-effect-free expression - re-evaluating
 *     a call or a computed index at removal time could reach a different
 *     object than the one that was actually listening
 *   - the call sits inside a nested `function` callback
 */

import * as ts from 'typescript';

export interface ListenerFix {
  /** `this.foo` / `window` / etc - repeated verbatim in the remove call. */
  targetText: string;
  eventName: string;
  /** True when the target is a fresh lookup that may be gone by now, so removal uses `?.`. */
  optionalTarget?: boolean;
  /** The exact expression removeEventListener should be given. */
  handlerText: string;
  /**
   * Present when an inline arrow had to be hoisted into a new field.
   *
   * `handlerNode` is the ORIGINAL inline-arrow argument at the call site,
   * which the caller must replace with `this.<name>` - otherwise the
   * registration keeps creating a fresh, un-removable function every time,
   * and the generated removeEventListener call would silently remove
   * nothing at runtime.
   */
  newField?: { name: string; arrowText: string; handlerNode: ts.Expression };
  /** The literal/simple options expression, repeated verbatim, if any. */
  optionsText?: string;
}

const SAFE_GLOBALS = new Set([
  'console', 'window', 'document', 'Math', 'JSON', 'Array', 'Object', 'String', 'Number',
  'Boolean', 'Date', 'RegExp', 'Promise', 'Map', 'Set', 'Error', 'isNaN', 'parseInt',
  'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'undefined',
]);

/** An identifier / `this` / property-access chain only - safe to repeat verbatim. */
function isSimpleRepeatableExpression(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node)) return isSimpleRepeatableExpression(node.expression);
  if (ts.isNonNullExpression(node)) return isSimpleRepeatableExpression(node.expression);
  if (node.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isIdentifier(node)) return true;
  if (ts.isPropertyAccessExpression(node)) return isSimpleRepeatableExpression(node.expression);
  return false;
}

function isThisRooted(node: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) {
    return isThisRooted(node.expression);
  }
  if (node.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isPropertyAccessExpression(node)) return isThisRooted(node.expression);
  return false;
}

/** Does an expression contain a call or `new` anywhere inside it? */
function containsCall(node: ts.Node): boolean {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    if (!found) found = containsCall(child);
  });
  return found;
}

/** True when every free identifier in an arrow body is safe to keep as a field initializer. */
function capturesOnlySafeNames(arrow: ts.ArrowFunction): boolean {
  const params = new Set<string>();
  for (const p of arrow.parameters) if (ts.isIdentifier(p.name)) params.add(p.name.text);

  let unsafe = false;
  const walk = (node: ts.Node): void => {
    if (unsafe) return;
    // this.x.y - the whole chain is fine, and its parts are not free identifiers.
    if (ts.isPropertyAccessExpression(node) && isThisRooted(node)) return;
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      // The property NAME in a.b is not itself a variable reference.
      if (ts.isPropertyAccessExpression(parent) && parent.name === node) return;
      if (!params.has(node.text) && !SAFE_GLOBALS.has(node.text)) unsafe = true;
      return;
    }
    ts.forEachChild(node, walk);
  };
  walk(arrow.body);
  return !unsafe;
}

/** A bare identifier that names a member of this class - safe to reference from ngOnDestroy. */
function isOwnMember(target: ts.ClassDeclaration, name: string): boolean {
  return target.members.some((m) => m.name !== undefined && ts.isIdentifier(m.name) && m.name.text === name);
}

/**
 * The target's first name must exist inside ngOnDestroy: `this`, a global such
 * as window/document, or a member of this class. A local variable (for example
 * `const el = document.querySelector(...)` in ngAfterViewInit) is out of scope
 * there, and copying it into ngOnDestroy would not compile.
 */
function targetIsReachable(target: ts.ClassDeclaration, expr: ts.Expression): boolean {
  let root: ts.Expression = expr;
  while (ts.isParenthesizedExpression(root) || ts.isNonNullExpression(root) || ts.isPropertyAccessExpression(root)) {
    root = root.expression;
  }
  if (root.kind === ts.SyntaxKind.ThisKeyword) return true;
  return ts.isIdentifier(root) && (SAFE_GLOBALS.has(root.text) || isOwnMember(target, root.text));
}

/**
 * `const box = document.querySelector('#main-panel')` in ngAfterViewInit, then
 * `box.addEventListener(...)`. ngOnDestroy cannot see `box`, but it can look the
 * same fixed selector up again. Only a const bound to a query with a string
 * literal qualifies, so the second lookup reaches the same element.
 */
function resolveLocalTarget(expr: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  if (!ts.isIdentifier(expr)) return undefined;
  let scope: ts.Node | undefined = expr.parent;
  while (scope !== undefined && !ts.isFunctionLike(scope)) scope = scope.parent;
  if (scope === undefined) return undefined;
  let found: string | undefined;
  const visit = (n: ts.Node): void => {
    if (
      found === undefined &&
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === expr.text &&
      ts.isVariableDeclarationList(n.parent) &&
      (n.parent.flags & ts.NodeFlags.Const) !== 0 &&
      n.initializer !== undefined &&
      ts.isCallExpression(n.initializer) &&
      /^document.(querySelector|getElementById)$/.test(n.initializer.expression.getText(sourceFile)) &&
      n.initializer.arguments.length === 1 &&
      ts.isStringLiteralLike(n.initializer.arguments[0] as ts.Expression)
    ) {
      found = n.initializer.getText(sourceFile);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

const safeOptions = (optionsArg: ts.Expression | undefined): boolean =>
  optionsArg === undefined ||
  optionsArg.kind === ts.SyntaxKind.TrueKeyword ||
  optionsArg.kind === ts.SyntaxKind.FalseKeyword ||
  ((isSimpleRepeatableExpression(optionsArg) || ts.isObjectLiteralExpression(optionsArg)) &&
    !containsCall(optionsArg));

export function collectEventListeners(
  target: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  takenNames: Set<string>,
): ListenerFix[] {
  const fixes: ListenerFix[] = [];
  let counter = 0;

  const nextFieldName = (eventName: string): string => {
    const base = `on${eventName.replace(/[^a-zA-Z0-9]/g, '_')}Listener`;
    let name = base;
    counter = 1;
    while (takenNames.has(name)) {
      counter += 1;
      name = `${base}${counter}`;
    }
    takenNames.add(name);
    return name;
  };

  const walk = (node: ts.Node, rebindsThis: boolean): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'addEventListener' &&
      node.arguments.length >= 2 &&
      !rebindsThis
    ) {
      const targetExpr = node.expression.expression;
      const [eventArg, handlerArg, optionsArg] = node.arguments;

      const eventName =
        eventArg !== undefined && (ts.isStringLiteral(eventArg) || ts.isNoSubstitutionTemplateLiteral(eventArg))
          ? eventArg.text
          : undefined;

      const reachable = isSimpleRepeatableExpression(targetExpr) && targetIsReachable(target, targetExpr);
      const lookedUp = reachable ? undefined : resolveLocalTarget(targetExpr, sourceFile);

      if (
        eventName !== undefined &&
        handlerArg !== undefined &&
        (reachable || lookedUp !== undefined) &&
        safeOptions(optionsArg)
      ) {
        const targetText = lookedUp ?? targetExpr.getText(sourceFile);
        const optionalTarget = lookedUp !== undefined;
        const optionsText = optionsArg?.getText(sourceFile);

        if (
          (ts.isPropertyAccessExpression(handlerArg) && isThisRooted(handlerArg)) ||
          (ts.isIdentifier(handlerArg) && isOwnMember(target, handlerArg.text))
        ) {
          fixes.push({
            targetText,
            eventName,
            ...(optionalTarget ? { optionalTarget } : {}),
            handlerText: handlerArg.getText(sourceFile),
            ...(optionsText !== undefined ? { optionsText } : {}),
          });
        } else if (ts.isArrowFunction(handlerArg) && capturesOnlySafeNames(handlerArg)) {
          const name = nextFieldName(eventName);
          fixes.push({
            targetText,
            eventName,
            ...(optionalTarget ? { optionalTarget } : {}),
            handlerText: `this.${name}`,
            newField: { name, arrowText: handlerArg.getText(sourceFile), handlerNode: handlerArg },
            ...(optionsText !== undefined ? { optionsText } : {}),
          });
        }
      }
    }

    const rebinds = rebindsThis || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
    ts.forEachChild(node, (child) => walk(child, rebinds));
  };

  for (const member of target.members) walk(member, false);
  return fixes;
}
