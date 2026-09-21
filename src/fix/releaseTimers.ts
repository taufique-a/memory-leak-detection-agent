/**
 * Releasing setTimeout and requestAnimationFrame handles.
 *
 * A sibling to addCleanup.ts's own setInterval handling, kept as a separate,
 * independent pass rather than a refactor of that one: intervals already
 * have a tested field name and exact generated shape, and touching working,
 * tested code to share a few lines with two brand-new kinds is not worth
 * the risk of a subtle regression there. The two shapes here are
 * structurally identical to each other, so THEY share one function.
 */

import * as ts from 'typescript';

import type { AddOnDestroyFailure } from './addOnDestroy';

export interface TimerCollectorResult {
  /** Handles kept for it in a discarded (bare-statement) form, to push into an array. */
  discarded: ts.CallExpression[];
  /** `this.<property>` names already holding a handle, that nothing clears. */
  stored: string[];
}

/**
 * Find every `globalName(...)` call this class starts and never releases.
 *
 * `clearName` is used only to recognise an EXISTING clear call on a stored
 * handle, so a property that is already being cleared is left alone.
 *
 * Mirrors collectIntervals' shape and refusal rules: a call inside a real
 * `function` callback is refused (that kind is skipped for this class, not
 * the whole fix), and a handle stored somewhere ngOnDestroy cannot reach
 * (a local variable, an argument) is likewise refused rather than guessed
 * at.
 */
export function collectGlobalTimerCalls(
  target: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  classText: string,
  globalName: string,
  clearName: string,
): TimerCollectorResult | AddOnDestroyFailure {
  const discarded: ts.CallExpression[] = [];
  const stored = new Set<string>();
  let refusal: AddOnDestroyFailure | undefined;

  const isTargetGlobal = (node: ts.CallExpression): boolean => {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) return callee.text === globalName;
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === globalName &&
      ts.isIdentifier(callee.expression) &&
      ['window', 'globalThis', 'self'].includes(callee.expression.text)
    );
  };

  /**
   * A setTimeout started from a @HostListener runs once per event and frees
   * itself when it fires. Keeping every handle for ngOnDestroy would make the
   * array grow with each click or key press for as long as the component lives.
   */
  const inHostListener = (node: ts.Node): boolean => {
    for (let n: ts.Node | undefined = node; n !== undefined; n = n.parent) {
      if (ts.isMethodDeclaration(n)) {
        return (ts.getDecorators(n) ?? []).some(
          (d) => ts.isCallExpression(d.expression) && d.expression.expression.getText() === 'HostListener',
        );
      }
    }
    return false;
  };

  const walk = (node: ts.Node, rebindsThis: boolean): void => {
    if (refusal !== undefined) return;

    if (ts.isCallExpression(node) && isTargetGlobal(node)) {
      const parent = node.parent;
      if (ts.isExpressionStatement(parent) && globalName === 'setTimeout' && inHostListener(node)) {
        // left alone on purpose - see inHostListener
      } else if (ts.isExpressionStatement(parent)) {
        if (rebindsThis) {
          refusal = {
            reason:
              `A ${globalName} sits inside a nested function() callback, where \`this\` is ` +
              'not the component, so its handle cannot be kept on the component safely.',
          };
          return;
        }
        discarded.push(node);
      } else if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(parent.left) &&
        parent.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        const property = parent.left.name.text;
        const cleared = new RegExp(`\\b${clearName}\\(\\s*this\\.${property}\\s*\\)`).test(classText);
        if (!cleared && !rebindsThis) stored.add(property);
      } else if (!new RegExp(`\\b${clearName}\\s*\\(`).test(classText)) {
        refusal = {
          reason:
            `A ${globalName} handle is kept somewhere ngOnDestroy cannot reach (a local ` +
            'variable or an argument), so there is no safe place to clear it from.',
        };
        return;
      }
    }

    const rebinds = rebindsThis || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
    ts.forEachChild(node, (child) => walk(child, rebinds));
  };

  for (const member of target.members) walk(member, false);
  if (refusal !== undefined) return refusal;
  return { discarded, stored: [...stored] };
}
