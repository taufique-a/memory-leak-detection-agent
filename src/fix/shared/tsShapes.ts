/**
 * Syntax helpers shared by the fix generators that read a class or
 * function and add one cleanup line - React's and plain JavaScript's.
 *
 * Everything here is a narrow, exact reading of source text: which call
 * acquires a resource, where its handle is stored, how the file is
 * indented. Nothing here decides whether to generate a fix; each generator
 * keeps its own rules for that.
 */

import * as ts from 'typescript';

export const ACQUIRE_NAMES: ReadonlySet<string> = new Set([
  'setInterval',
  'setTimeout',
  'addEventListener',
  'requestAnimationFrame',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'PerformanceObserver',
  'WebSocket',
  'EventSource',
  'Worker',
  'SharedWorker',
]);

export function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

export function recognisedCallName(node: ts.Node): string | undefined {
  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression)) return node.expression.text;
    if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) return node.expression.text;
  return undefined;
}

/** Every acquire-shaped call anywhere under `root`, at any depth. */
export function countAcquireCalls(root: ts.Node): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    const name = recognisedCallName(node);
    if (name !== undefined && ACQUIRE_NAMES.has(name)) count++;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return count;
}

/** `this.<name>` - the only handle shape a different method can reach. */
export function thisProperty(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if (
    ts.isPropertyAccessExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ts.isIdentifier(node.name)
  ) {
    return node.getText(sourceFile);
  }
  return undefined;
}

export function indentOf(sourceFile: ts.SourceFile, node: ts.Node): string {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
  const lineText = sourceFile.text.split('\n')[line] ?? '';
  const match = /^[ \t]*/.exec(lineText);
  return match?.[0] ?? '  ';
}

/** Does the last statement in this block end its line with a semicolon? Match it; otherwise omit. */
export function usesSemicolons(block: ts.Block, sourceFile: ts.SourceFile): boolean {
  const last = block.statements[block.statements.length - 1];
  if (last === undefined) return true;
  return last.getText(sourceFile).trimEnd().endsWith(';');
}

export type InstanceResourcePlan =
  | { kind: 'timer'; clearCall: string; handleText: string }
  | { kind: 'listener'; targetText: string; eventText: string; handlerText: string }
  | { kind: 'local-handle' };

/**
 * The single resource a method body starts, as long as its handle lives on
 * the instance (`this.timer = setInterval(...)`, or addEventListener with a
 * `this.handler`). A timer captured in a local variable comes back as
 * `local-handle` so the refusal can say exactly why. Undefined when there is
 * not exactly one acquire-shaped call in the body, or it has another shape.
 */
export function findSingleInstanceResource(
  body: ts.Block,
  sourceFile: ts.SourceFile,
): InstanceResourcePlan | undefined {
  if (countAcquireCalls(body) !== 1) return undefined;

  for (const stmt of body.statements) {
    if (!ts.isExpressionStatement(stmt)) {
      if (ts.isVariableStatement(stmt)) {
        const init = stmt.declarationList.declarations[0]?.initializer;
        const name = init !== undefined ? recognisedCallName(init) : undefined;
        if (name === 'setInterval' || name === 'setTimeout') return { kind: 'local-handle' };
      }
      continue;
    }
    const expr = stmt.expression;

    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isCallExpression(expr.right) &&
      ts.isIdentifier(expr.right.expression) &&
      (expr.right.expression.text === 'setInterval' || expr.right.expression.text === 'setTimeout')
    ) {
      const handleText = thisProperty(expr.left, sourceFile);
      if (handleText === undefined) return undefined;
      const clearCall = expr.right.expression.text === 'setInterval' ? 'clearInterval' : 'clearTimeout';
      return { kind: 'timer', clearCall, handleText };
    }

    if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === 'addEventListener' &&
      expr.arguments.length >= 2
    ) {
      const handlerText = thisProperty(expr.arguments[1] as ts.Expression, sourceFile);
      if (handlerText === undefined) return undefined;
      return {
        kind: 'listener',
        targetText: expr.expression.expression.getText(sourceFile),
        eventText: (expr.arguments[0] as ts.Expression).getText(sourceFile),
        handlerText,
      };
    }
  }
  return undefined;
}

export function cleanupLineFor(
  plan: Exclude<InstanceResourcePlan, { kind: 'local-handle' }>,
  semi: string,
): string {
  return plan.kind === 'timer'
    ? `${plan.clearCall}(${plan.handleText})${semi}`
    : `${plan.targetText}.removeEventListener(${plan.eventText}, ${plan.handlerText})${semi}`;
}

export function findClass(sourceFile: ts.SourceFile, name: string): ts.ClassDeclaration | undefined {
  let found: ts.ClassDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isClassDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

export function methodNamed(cls: ts.ClassDeclaration, name: string, sourceFile: ts.SourceFile): ts.MethodDeclaration | undefined {
  return cls.members.find(
    (m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && m.name.getText(sourceFile) === name,
  );
}
