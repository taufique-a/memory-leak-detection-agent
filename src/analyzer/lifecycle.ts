/**
 * Angular lifecycle correctness analysis.
 *
 * Looks INSIDE ngOnDestroy and checks that the cleanup written there
 * corresponds to what the class actually allocated. See types/lifecycle.ts
 * for the two failure modes this exists to catch.
 */

import * as ts from 'typescript';

import type {
  ClassLifecycle,
  DestroySignal,
  LifecycleIssue,
  StoredHandle,
} from '../types/lifecycle';
import type { ResourceOperation } from '../types/analysis';

/** Analyse lifecycle correctness for every class in a file. */
export function analyzeLifecycles(
  sourceFile: ts.SourceFile,
  relativePath: string,
  operationsByClass: ReadonlyMap<string, ResourceOperation[]>,
): ClassLifecycle[] {
  const results: ClassLifecycle[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      results.push(
        analyzeClass(
          node,
          className,
          sourceFile,
          relativePath,
          operationsByClass.get(className) ?? [],
        ),
      );
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return results;
}

function analyzeClass(
  node: ts.ClassDeclaration,
  className: string,
  sourceFile: ts.SourceFile,
  relativePath: string,
  operations: readonly ResourceOperation[],
): ClassLifecycle {
  const line = lineOf(sourceFile, node);

  /* ---- ngOnDestroy ---- */
  const onDestroy = findMethod(node, 'ngOnDestroy');
  const onDestroyBody = onDestroy?.body;
  const onDestroyStatementCount = onDestroyBody?.statements.length ?? 0;

  /* ---- heritage ---- */
  let baseClassName: string | undefined;
  const implemented: string[] = [];
  for (const heritage of node.heritageClauses ?? []) {
    if (heritage.token === ts.SyntaxKind.ExtendsKeyword) {
      const first = heritage.types[0];
      if (first && ts.isIdentifier(first.expression)) baseClassName = first.expression.text;
    } else if (heritage.token === ts.SyntaxKind.ImplementsKeyword) {
      for (const type of heritage.types) {
        if (ts.isIdentifier(type.expression)) implemented.push(type.expression.text);
      }
    }
  }

  /* ---- decorator metadata ---- */
  const { angularKind, providedIn } = readDecorator(node);

  /* ---- what does ngOnDestroy mention? ---- */
  const onDestroyText = collectReferencedText(onDestroyBody, sourceFile);
  const callsSuperOnDestroy = onDestroyText.calls.has('super.ngOnDestroy');

  /* ---- destroy signals ---- */
  const destroySignals = findDestroySignals(node, sourceFile, onDestroyText);

  /* ---- stored handles ---- */
  const storedHandles = findStoredHandles(operations, onDestroyText);

  const lifecycle: ClassLifecycle = {
    className,
    file: relativePath,
    line,
    ...(angularKind !== undefined ? { angularKind } : {}),
    hasOnDestroyMethod: onDestroy !== undefined,
    declaresOnDestroyInterface: implemented.includes('OnDestroy'),
    ...(onDestroy ? { onDestroyLine: lineOf(sourceFile, onDestroy) } : {}),
    onDestroyIsEmpty: onDestroy !== undefined && onDestroyStatementCount === 0,
    onDestroyStatementCount,
    ...(baseClassName !== undefined ? { baseClassName } : {}),
    callsSuperOnDestroy,
    ...(providedIn !== undefined ? { providedIn } : {}),
    destroySignals,
    storedHandles,
    issues: [],
  };

  lifecycle.issues = deriveIssues(lifecycle, operations, sourceFile, node);
  return lifecycle;
}

/* ------------------------------------------------------------------ */
/* destroy$ detection                                                  */
/* ------------------------------------------------------------------ */

interface ReferencedText {
  /** Every property access rendered as text, e.g. "this.destroy$". */
  properties: Set<string>;
  /** Every call rendered as text, e.g. "this.destroy$.next". */
  calls: Set<string>;
}

/**
 * Find every teardown signal the class relies on, and whether ngOnDestroy
 * actually fires it.
 *
 * THE BUG THIS CATCHES
 *   private destroy$ = new Subject<void>();
 *   ngOnInit() { this.x$.pipe(takeUntil(this.destroy$)).subscribe(); }
 *   ngOnDestroy() { this.chart?.destroy(); }   // destroy$ never fired
 *
 * Every takeUntil in that class is decoration. The subscriptions live
 * forever, and Phase 3 would have reported them as safely handled.
 */
function findDestroySignals(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  onDestroyText: ReferencedText,
): DestroySignal[] {
  const usage = new Map<string, number>();

  // Collect the argument of every takeUntil(...) in the class.
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;

      if (name === 'takeUntil') {
        const arg = n.arguments[0];
        if (arg) {
          const text = renderExpression(arg);
          if (text !== undefined) usage.set(text, (usage.get(text) ?? 0) + 1);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);

  const signals: DestroySignal[] = [];

  for (const [name, count] of usage) {
    /**
     * A signal is "triggered" when ngOnDestroy calls .next() or .complete()
     * on it. Either works: next() emits so takeUntil fires, complete()
     * completes the source which also unsubscribes downstream.
     */
    const triggered =
      onDestroyText.calls.has(`${name}.next`) ||
      onDestroyText.calls.has(`${name}.complete`) ||
      onDestroyText.calls.has(`${name}.unsubscribe`);

    signals.push({
      name,
      usedByTakeUntilCount: count,
      triggeredInOnDestroy: triggered,
    });
  }

  return signals;
}

/* ------------------------------------------------------------------ */
/* Handle tracking                                                     */
/* ------------------------------------------------------------------ */

/**
 * Which instance properties hold resource handles, and does ngOnDestroy
 * even mention them?
 *
 * This is deliberately a MENTION check, not a proof of release. If
 * ngOnDestroy references `this.pollTimer` at all we say nothing; if it
 * never mentions it, that handle is definitely not being cleaned up there.
 * Absence is the reliable direction.
 */
function findStoredHandles(
  operations: readonly ResourceOperation[],
  onDestroyText: ReferencedText,
): StoredHandle[] {
  const handles: StoredHandle[] = [];
  const seen = new Set<string>();

  for (const op of operations) {
    if (op.action !== 'acquire') continue;
    if (op.disposition !== 'thisProperty') continue;
    if (op.storedAs === undefined) continue;
    // Self-terminating acquires do not need a handle-based release.
    if (op.mitigatedBy !== undefined) continue;

    const key = `${op.storedAs}|${op.callText}`;
    if (seen.has(key)) continue;
    seen.add(key);

    handles.push({
      property: op.storedAs,
      acquiredBy: op.callText,
      line: op.line,
      referencedInOnDestroy: onDestroyText.properties.has(op.storedAs),
    });
  }

  return handles;
}

/* ------------------------------------------------------------------ */
/* Issue derivation                                                    */
/* ------------------------------------------------------------------ */

function deriveIssues(
  lifecycle: ClassLifecycle,
  operations: readonly ResourceOperation[],
  sourceFile: ts.SourceFile,
  node: ts.ClassDeclaration,
): LifecycleIssue[] {
  const issues: LifecycleIssue[] = [];
  const hasResources = operations.some((o) => o.action === 'acquire');

  /* ---- 1. the destroy$ trap ---- */
  for (const signal of lifecycle.destroySignals) {
    if (signal.triggeredInOnDestroy) continue;
    issues.push({
      code: 'DESTROY_SUBJECT_NEVER_COMPLETED',
      severity: 'HIGH',
      message:
        `${signal.usedByTakeUntilCount} subscription(s) use takeUntil(${signal.name}), ` +
        `but ${lifecycle.hasOnDestroyMethod ? 'ngOnDestroy never calls' : 'there is no ngOnDestroy to call'} ` +
        `${signal.name}.next() or ${signal.name}.complete(). The takeUntil never fires, so ` +
        `every one of those subscriptions stays active after the component is destroyed. ` +
        `This looks like correct cleanup but does nothing.`,
      line: lifecycle.onDestroyLine ?? lifecycle.line,
    });
  }

  /* ---- 2. stored handles never mentioned in ngOnDestroy ---- */
  const unreferenced = lifecycle.storedHandles.filter((h) => !h.referencedInOnDestroy);
  if (unreferenced.length > 0 && lifecycle.hasOnDestroyMethod) {
    issues.push({
      code: 'HANDLE_NEVER_RELEASED',
      severity: 'HIGH',
      message:
        `ngOnDestroy exists but never mentions ${unreferenced
          .map((h) => h.property)
          .join(', ')}. ` +
        `Those handles hold ${[...new Set(unreferenced.map((h) => h.acquiredBy))].join(', ')} ` +
        `and are not released by the cleanup that was written.`,
      line: lifecycle.onDestroyLine ?? lifecycle.line,
    });
  }

  /* ---- 3. missing / empty ngOnDestroy ---- */
  if (!lifecycle.hasOnDestroyMethod && hasResources && lifecycle.angularKind === 'Component') {
    issues.push({
      code: 'ONDESTROY_MISSING',
      severity: 'MEDIUM',
      message:
        'The component allocates resources but has no ngOnDestroy, so no teardown can run.',
      line: lifecycle.line,
    });
  }

  if (lifecycle.onDestroyIsEmpty) {
    issues.push({
      code: 'ONDESTROY_EMPTY',
      severity: hasResources ? 'HIGH' : 'LOW',
      message:
        'ngOnDestroy is defined but its body is empty. Someone intended to clean up here.',
      line: lifecycle.onDestroyLine ?? lifecycle.line,
    });
  }

  if (lifecycle.declaresOnDestroyInterface && !lifecycle.hasOnDestroyMethod) {
    issues.push({
      code: 'ONDESTROY_DECLARED_NOT_IMPLEMENTED',
      severity: 'MEDIUM',
      message:
        'The class declares `implements OnDestroy` but never defines ngOnDestroy. ' +
        'Cleanup was planned and not written.',
      line: lifecycle.line,
    });
  }

  /* ---- 4. subclass swallows the base class teardown ---- */
  if (
    lifecycle.baseClassName !== undefined &&
    lifecycle.hasOnDestroyMethod &&
    !lifecycle.callsSuperOnDestroy
  ) {
    // If the base class is visible in this file we can be certain.
    const baseInFile = findClassInFile(sourceFile, lifecycle.baseClassName);
    const baseHasOnDestroy =
      baseInFile !== undefined ? findMethod(baseInFile, 'ngOnDestroy') !== undefined : undefined;

    if (baseHasOnDestroy !== false) {
      issues.push({
        code: 'SUPER_ONDESTROY_NOT_CALLED',
        severity: baseHasOnDestroy === true ? 'HIGH' : 'LOW',
        message:
          `ngOnDestroy overrides the one inherited from ${lifecycle.baseClassName} without ` +
          `calling super.ngOnDestroy(). ` +
          (baseHasOnDestroy === true
            ? `${lifecycle.baseClassName} does define ngOnDestroy in this file, so its cleanup never runs.`
            : `${lifecycle.baseClassName} is declared elsewhere and was not inspected - check whether it has cleanup to run.`),
        line: lifecycle.onDestroyLine ?? lifecycle.line,
        ...(baseHasOnDestroy === undefined ? { unverified: true } : {}),
      });
    }
  }

  /* ---- 5. root service with ngOnDestroy ---- */
  if (
    lifecycle.angularKind === 'Injectable' &&
    lifecycle.providedIn === 'root' &&
    lifecycle.hasOnDestroyMethod &&
    lifecycle.onDestroyStatementCount > 0
  ) {
    issues.push({
      code: 'ROOT_SERVICE_ONDESTROY_NEVER_RUNS',
      severity: 'MEDIUM',
      message:
        'This service is providedIn: "root", so Angular keeps one instance for the whole ' +
        'application lifetime. Its ngOnDestroy only runs when the app itself is destroyed - ' +
        'effectively never. Anything it allocates is retained for the session.',
      line: lifecycle.onDestroyLine ?? lifecycle.line,
    });
  }

  // Ignore an unused parameter warning while keeping the signature stable
  // for future checks that need the class node.
  void node;

  return issues;
}

/* ------------------------------------------------------------------ */
/* AST helpers                                                         */
/* ------------------------------------------------------------------ */

function findMethod(
  node: ts.ClassDeclaration,
  name: string,
): ts.MethodDeclaration | undefined {
  for (const member of node.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    const memberName = member.name;
    if ((ts.isIdentifier(memberName) || ts.isStringLiteral(memberName)) && memberName.text === name) {
      return member;
    }
  }
  return undefined;
}

function findClassInFile(
  sourceFile: ts.SourceFile,
  className: string,
): ts.ClassDeclaration | undefined {
  let found: ts.ClassDeclaration | undefined;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isClassDeclaration(n) && n.name?.text === className) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sourceFile);
  return found;
}

/** Collect every property access and call inside a block, as text. */
function collectReferencedText(
  body: ts.Block | undefined,
  sourceFile: ts.SourceFile,
): ReferencedText {
  const properties = new Set<string>();
  const calls = new Set<string>();
  if (!body) return { properties, calls };

  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n)) {
      const text = renderExpression(n);
      if (text !== undefined) properties.add(text);
    }
    if (ts.isCallExpression(n)) {
      const text = renderExpression(n.expression);
      if (text !== undefined) calls.add(text);
    }
    ts.forEachChild(n, visit);
  };
  visit(body);

  void sourceFile;
  return { properties, calls };
}

/**
 * Render an expression as stable text for comparison.
 *
 * Optional chaining is normalised away, so `this.chart?.destroy()` and
 * `this.chart.destroy()` compare equal. They mean the same thing for our
 * purposes and treating them differently would produce false alarms.
 */
function renderExpression(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (node.kind === ts.SyntaxKind.SuperKeyword) return 'super';

  if (ts.isPropertyAccessExpression(node)) {
    const receiver = renderExpression(node.expression);
    return receiver === undefined ? undefined : `${receiver}.${node.name.text}`;
  }
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) {
    return renderExpression(node.expression);
  }
  if (ts.isCallExpression(node)) {
    const callee = renderExpression(node.expression);
    return callee === undefined ? undefined : `${callee}()`;
  }
  return undefined;
}

function readDecorator(node: ts.ClassDeclaration): {
  angularKind?: string;
  providedIn?: string;
} {
  if (!ts.canHaveDecorators(node)) return {};

  for (const decorator of ts.getDecorators(node) ?? []) {
    const expr = decorator.expression;
    const target = ts.isCallExpression(expr) ? expr.expression : expr;
    if (!ts.isIdentifier(target)) continue;

    const angularKind = target.text;
    let providedIn: string | undefined;

    if (ts.isCallExpression(expr)) {
      const arg = expr.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key = ts.isIdentifier(prop.name) ? prop.name.text : undefined;
          if (key === 'providedIn' && ts.isStringLiteral(prop.initializer)) {
            providedIn = prop.initializer.text;
          }
        }
      }
    }

    return {
      angularKind,
      ...(providedIn !== undefined ? { providedIn } : {}),
    };
  }
  return {};
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}
