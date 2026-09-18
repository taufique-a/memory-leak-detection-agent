/**
 * Releasing a resource whose correct teardown is "call one method on the
 * instance": chart libraries, maps, sockets, workers, DOM observers, and
 * Angular CDK dialogs/overlays.
 *
 * Deliberately driven from `RESOURCE_DEFINITIONS` (the analyzer's own
 * catalog) rather than a second, hand-maintained table - the two would
 * drift, and the day they did, this would generate a call to a method the
 * analyzer no longer recognises as a release for that kind.
 *
 * ONE COLLECTOR FOR FIFTEEN KINDS
 * --------------------------------
 * Every kind here reduces to the same two shapes:
 *
 *   this.thing = Acquire(...);   ...   this.thing?.releaseMethod();
 *   Acquire(...);                ...   this.things.push(Acquire(...));
 *                                      this.things.forEach(x => x.releaseMethod());
 *
 * so one function walks the class once for every kind's acquire matchers
 * and produces either shape, per occurrence - never inventing a shape the
 * catalog does not already describe.
 */

import * as ts from 'typescript';

import type { AcquireMatcher, ResourceDefinition } from '../analyzer/resources';
import type { ResourceKind } from '../types/analysis';

export interface StoredInstanceFix {
  kind: ResourceKind;
  /** `this.foo` (or a longer `this.a.b` chain) already holding the instance. */
  storedAs: string;
}

export interface DiscardedInstanceFix {
  kind: ResourceKind;
  call: ts.CallExpression | ts.NewExpression;
  /**
   * Set when the acquire is immediately chained into exactly one more call
   * in the same bare statement - `new MutationObserver(cb).observe(t, o);`,
   * the way every one of these libraries is actually used in practice.
   * The whole statement, because releasing it means splitting one line
   * into three: declare a local, keep the chained call, remember the
   * local - see addCleanup.ts for the edits that does.
   */
  chainedStatement?: ts.ExpressionStatement;
}

export interface InstanceCollectorResult {
  stored: StoredInstanceFix[];
  discarded: DiscardedInstanceFix[];
}

/** Does this call/new expression match one of a kind's acquire matchers? */
function matches(node: ts.CallExpression | ts.NewExpression, matcher: AcquireMatcher): boolean {
  const callee = node.expression;

  if (matcher.type === 'construct') {
    return ts.isNewExpression(node) && ts.isIdentifier(callee) && callee.text === matcher.name;
  }

  if (matcher.type === 'namespaced') {
    if (!ts.isPropertyAccessExpression(callee)) return false;
    if (callee.name.text !== matcher.name) return false;
    return ts.isIdentifier(callee.expression) && matcher.objects.includes(callee.expression.text);
  }

  if (matcher.type === 'method') {
    if (ts.isNewExpression(node)) return false;
    if (!ts.isPropertyAccessExpression(callee)) return false;
    if (callee.name.text !== matcher.name) return false;
    if (matcher.receiverIncludes === undefined) return true;
    return callee.expression.getText().toLowerCase().includes(matcher.receiverIncludes.toLowerCase());
  }

  return false; // 'global' matchers belong to releaseTimers.ts, not here.
}

/** `this.x.y` (identifiers only, no computed index or call) - or undefined if it is anything more complex. */
function thisPropertyName(node: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const root = node.expression;
  const rootIsThisChain =
    root.kind === ts.SyntaxKind.ThisKeyword || (ts.isPropertyAccessExpression(root) && thisPropertyName(root) !== undefined);
  return rootIsThisChain ? node.getText() : undefined;
}

/** Does the class already call one of this kind's release methods on `storedAs`? */
function alreadyReleased(classText: string, storedAs: string, def: ResourceDefinition): boolean {
  const escaped = storedAs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return def.releaseMethods.some((method) => new RegExp(`${escaped}\\s*\\??\\.\\s*${method}\\s*\\(`).test(classText));
}

export function collectStoredInstances(
  target: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  classText: string,
  definitions: readonly ResourceDefinition[],
): InstanceCollectorResult {
  const stored: StoredInstanceFix[] = [];
  const discarded: DiscardedInstanceFix[] = [];
  const seenStoredNames = new Set<string>();

  const definitionFor = (node: ts.CallExpression | ts.NewExpression): ResourceDefinition | undefined =>
    definitions.find((def) => def.acquire.some((m) => matches(node, m)));

  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const def = definitionFor(node);
      if (def !== undefined) {
        const parent = node.parent;

        if (ts.isExpressionStatement(parent)) {
          discarded.push({ kind: def.kind, call: node });
        } else if (
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node &&
          ts.isCallExpression(parent.parent) &&
          parent.parent.expression === parent &&
          ts.isExpressionStatement(parent.parent.parent)
        ) {
          // new X(cb).configure(...); - exactly one hop of chaining ending
          // in a bare statement. Anything deeper or used for something else
          // is left alone rather than guessed at.
          discarded.push({ kind: def.kind, call: node, chainedStatement: parent.parent.parent });
        } else if (
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          parent.right === node
        ) {
          const storedAs = thisPropertyName(parent.left);
          if (storedAs !== undefined && !seenStoredNames.has(storedAs) && !alreadyReleased(classText, storedAs, def)) {
            seenStoredNames.add(storedAs);
            stored.push({ kind: def.kind, storedAs });
          }
          // Anything else (a local variable, passed to a call, returned) is
          // left alone - there is no reachable place to release it from.
        } else if (ts.isPropertyDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) {
          const storedAs = `this.${parent.name.text}`;
          if (!seenStoredNames.has(storedAs) && !alreadyReleased(classText, storedAs, def)) {
            seenStoredNames.add(storedAs);
            stored.push({ kind: def.kind, storedAs });
          }
        }
      }
    }
    ts.forEachChild(node, walk);
  };

  for (const member of target.members) walk(member);
  return { stored, discarded };
}
