/**
 * Context extraction: given a node deep in the AST, work out where it sits
 * and what happened to the value it produced.
 *
 * All of this depends on `setParentNodes: true` in parse.ts. Without parent
 * pointers we could only look downward, and every question here is an
 * upward one: which method contains this call? was the result assigned?
 */

import * as ts from 'typescript';

import type { LifecycleHook } from '../types/project';
import { LIFECYCLE_HOOKS } from '../types/project';
import type { HandleDisposition } from '../types/analysis';

const LIFECYCLE_HOOK_SET = new Set<string>(LIFECYCLE_HOOKS);

/* ------------------------------------------------------------------ */
/* Where am I?                                                         */
/* ------------------------------------------------------------------ */

/** The class declaration containing this node, if any. */
export function enclosingClass(node: ts.Node): ts.ClassDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isClassDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}

/** A named function-like scope. */
export interface EnclosingMethod {
  name: string;
  node: ts.Node;
  /** Set when the name is an Angular lifecycle hook. */
  lifecycleHook?: LifecycleHook;
}

/**
 * The nearest NAMED method or function containing this node.
 *
 * We deliberately skip over anonymous arrow functions and callbacks. A
 * `setInterval` inside a `subscribe` callback inside `ngOnInit` should be
 * reported as living in `ngOnInit`, because that is the lifecycle context a
 * developer reasons about. The fact that it was nested is recorded
 * separately by `isNestedInCallback`.
 */
export function enclosingMethod(node: ts.Node): EnclosingMethod | undefined {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isMethodDeclaration(current)) {
      const name = current.name;
      if (ts.isIdentifier(name) || ts.isStringLiteral(name)) {
        const text = name.text;
        return {
          name: text,
          node: current,
          ...(LIFECYCLE_HOOK_SET.has(text)
            ? { lifecycleHook: text as LifecycleHook }
            : {}),
        };
      }
      return { name: '(computed)', node: current };
    }

    if (ts.isConstructorDeclaration(current)) {
      return { name: 'constructor', node: current };
    }

    if (ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) {
      const name = current.name;
      if (ts.isIdentifier(name)) return { name: name.text, node: current };
    }

    if (ts.isFunctionDeclaration(current) && current.name) {
      return { name: current.name.text, node: current };
    }

    /**
     * A property initialiser is a real context worth naming:
     *   private timer = setInterval(...)
     * Reporting that as "no enclosing method" would hide it.
     */
    if (ts.isPropertyDeclaration(current)) {
      const name = current.name;
      if (ts.isIdentifier(name)) {
        return { name: `(property initialiser: ${name.text})`, node: current };
      }
    }

    current = current.parent;
  }

  return undefined;
}

/**
 * Is this node inside a callback, rather than directly in the method body?
 *
 * Walks from the node up to the enclosing method and reports whether we
 * crossed a function boundary. Nested acquires matter because they are
 * harder to release: a subscription created inside another subscription's
 * callback often has no stable place to store its handle.
 */
export function isNestedInCallback(node: ts.Node, methodNode: ts.Node | undefined): boolean {
  if (!methodNode) return false;
  let current: ts.Node | undefined = node.parent;
  while (current && current !== methodNode) {
    if (
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current) ||
      ts.isFunctionDeclaration(current)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* What happened to the handle?                                        */
/* ------------------------------------------------------------------ */

export interface DispositionResult {
  disposition: HandleDisposition;
  /** The property or variable the handle landed in, when readable. */
  storedAs?: string;
}

/**
 * Work out where the value returned by `call` ended up.
 *
 * THIS IS THE MOST IMPORTANT FUNCTION IN PHASE 3.
 *
 * `setInterval(fn, 1000)` sitting alone on a line is not "probably a leak" -
 * it is a PROOF that the timer can never be cleared, because the id needed
 * to clear it was discarded at the moment of creation. No amount of
 * ngOnDestroy code can fix that call site. Distinguishing this from
 * `this.t = setInterval(...)` is the difference between a confident finding
 * and a guess.
 */
export function handleDisposition(call: ts.Node): DispositionResult {
  // Unwrap syntax that does not change the value: (x), x!, x as T, <T>x
  let node: ts.Node = call;
  let parent: ts.Node | undefined = node.parent;

  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isTypeAssertionExpression(parent))
  ) {
    node = parent;
    parent = parent.parent;
  }

  if (!parent) return { disposition: 'unknown' };

  /* ---- the result is thrown away ---- */
  if (ts.isExpressionStatement(parent)) {
    return { disposition: 'discarded' };
  }

  /* ---- const/let x = call ---- */
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) {
    const name = ts.isIdentifier(parent.name) ? parent.name.text : undefined;
    return {
      disposition: 'localVariable',
      ...(name !== undefined ? { storedAs: name } : {}),
    };
  }

  /* ---- class property initialiser: private t = call ---- */
  if (ts.isPropertyDeclaration(parent) && parent.initializer === node) {
    const name = ts.isIdentifier(parent.name) ? parent.name.text : undefined;
    return {
      disposition: 'thisProperty',
      ...(name !== undefined ? { storedAs: `this.${name}` } : {}),
    };
  }

  /* ---- assignment: this.t = call  /  t = call ---- */
  if (
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node
  ) {
    const target = parent.left;

    if (ts.isPropertyAccessExpression(target)) {
      const receiver = target.expression;
      if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
        return { disposition: 'thisProperty', storedAs: `this.${target.name.text}` };
      }
      // Something like `this.state.timer = ...` - still instance-reachable.
      return { disposition: 'thisProperty', storedAs: describeTarget(target) };
    }

    if (ts.isElementAccessExpression(target)) {
      return { disposition: 'thisProperty', storedAs: describeTarget(target) };
    }

    if (ts.isIdentifier(target)) {
      return { disposition: 'localVariable', storedAs: target.text };
    }

    return { disposition: 'unknown' };
  }

  /* ---- return call ---- */
  if (ts.isReturnStatement(parent)) {
    return { disposition: 'returned' };
  }

  /**
   * ---- concise arrow body: () => call ----
   * The value is returned to whoever invoked the arrow.
   */
  if (ts.isArrowFunction(parent) && parent.body === node) {
    return { disposition: 'returned' };
  }

  /**
   * ---- passed as an argument: this.subs.add(x.subscribe(...)) ----
   * This is the idiomatic correct pattern for subscriptions, so we must not
   * treat it as discarded.
   */
  if (ts.isCallExpression(parent) && parent.arguments.some((a) => a === node)) {
    return { disposition: 'passedToCall', storedAs: describeCallee(parent) };
  }

  /* ---- pushed into an array literal, e.g. subs = [a.subscribe(), ...] ---- */
  if (ts.isArrayLiteralExpression(parent)) {
    return { disposition: 'passedToCall' };
  }

  /* ---- chained onto: call.something ---- */
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
    return { disposition: 'passedToCall', storedAs: parent.name.text };
  }

  return { disposition: 'unknown' };
}

/** Render an assignment target as readable text, e.g. "this.state.timer". */
function describeTarget(node: ts.Expression): string {
  if (ts.isPropertyAccessExpression(node)) {
    const receiver = node.expression;
    if (receiver.kind === ts.SyntaxKind.ThisKeyword) return `this.${node.name.text}`;
    if (ts.isIdentifier(receiver)) return `${receiver.text}.${node.name.text}`;
    if (ts.isPropertyAccessExpression(receiver)) {
      return `${describeTarget(receiver)}.${node.name.text}`;
    }
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node)) {
    return `${describeTarget(node.expression as ts.Expression)}[...]`;
  }
  if (ts.isIdentifier(node)) return node.text;
  return '(expression)';
}

/** The name of the function being called, e.g. "this.subs.add". */
function describeCallee(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return describeTarget(callee);
  return '(call)';
}

/* ------------------------------------------------------------------ */
/* Source location and excerpts                                        */
/* ------------------------------------------------------------------ */

export interface SourceLocation {
  line: number;
  column: number;
}

/** 1-based line and column of a node. */
export function locationOf(sourceFile: ts.SourceFile, node: ts.Node): SourceLocation {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: pos.line + 1, column: pos.character + 1 };
}

/**
 * A single-line excerpt of the statement containing this node.
 *
 * Reports need enough context to be recognisable without dumping whole
 * files, so we take the source line, collapse whitespace and cap the length.
 */
export function snippetOf(sourceFile: ts.SourceFile, node: ts.Node, maxLength = 120): string {
  const start = node.getStart(sourceFile);
  const { line } = sourceFile.getLineAndCharacterOfPosition(start);
  const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0);

  const text = sourceFile.text;
  let lineEnd = text.indexOf('\n', lineStart);
  if (lineEnd === -1) lineEnd = text.length;

  const raw = text.slice(lineStart, lineEnd).replace(/\s+/g, ' ').trim();
  return raw.length > maxLength ? raw.slice(0, maxLength - 1) + '…' : raw;
}
