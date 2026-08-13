/**
 * The AST walker: turns a parsed file into a list of resource operations.
 *
 * This module contains NO knowledge about specific libraries - that all
 * lives in resources.ts. Its job is purely mechanical: visit every call and
 * constructor, ask the catalog "is this anything?", and if so record where
 * it is and what happened to its result.
 */

import * as ts from 'typescript';

import type {
  ObservableSourceHint,
  ResourceKind,
  ResourceOperation,
} from '../types/analysis';
import {
  RESOURCE_DEFINITIONS,
  kindsReleasedBy,
  type AcquireMatcher,
  type ResourceDefinition,
} from './resources';
import {
  enclosingClass,
  enclosingMethod,
  handleDisposition,
  isNestedInCallback,
  locationOf,
  snippetOf,
} from './context';

/* ------------------------------------------------------------------ */
/* Lookup tables, built once                                           */
/* ------------------------------------------------------------------ */

interface MethodMatcherEntry {
  definition: ResourceDefinition;
  receiverIncludes?: string;
}

const GLOBAL_ACQUIRES = new Map<string, ResourceDefinition>();
const CONSTRUCT_ACQUIRES = new Map<string, ResourceDefinition>();
const NAMESPACED_ACQUIRES = new Map<string, ResourceDefinition>();
/** Several definitions can share a method name, so this maps to a list. */
const METHOD_ACQUIRES = new Map<string, MethodMatcherEntry[]>();

function indexMatcher(definition: ResourceDefinition, matcher: AcquireMatcher): void {
  switch (matcher.type) {
    case 'global':
      GLOBAL_ACQUIRES.set(matcher.name, definition);
      break;
    case 'construct':
      CONSTRUCT_ACQUIRES.set(matcher.name, definition);
      break;
    case 'namespaced':
      for (const object of matcher.objects) {
        NAMESPACED_ACQUIRES.set(`${object}.${matcher.name}`, definition);
      }
      break;
    case 'method': {
      const list = METHOD_ACQUIRES.get(matcher.name) ?? [];
      list.push({
        definition,
        ...(matcher.receiverIncludes !== undefined
          ? { receiverIncludes: matcher.receiverIncludes }
          : {}),
      });
      METHOD_ACQUIRES.set(matcher.name, list);
      break;
    }
  }
}

for (const definition of RESOURCE_DEFINITIONS) {
  for (const matcher of definition.acquire) indexMatcher(definition, matcher);
}

/** Receivers that mean "the global object", so window.setInterval counts. */
const GLOBAL_RECEIVERS = new Set(['window', 'globalThis', 'self', 'global']);

/* ------------------------------------------------------------------ */
/* RxJS mitigation detection                                           */
/* ------------------------------------------------------------------ */

/**
 * Pipe operators that make a subscription end by itself.
 *
 * Without this, every one of IOSense's thousands of .subscribe() calls
 * would be reported, and the output would be unusable. A subscription that
 * completes on its own is correct code, not a finding.
 */
const SELF_TERMINATING_OPERATORS = new Set([
  'takeUntil',
  'takeUntilDestroyed',
  'take',
  'first',
  'last',
  'single',
  'takeWhile',
]);

/**
 * Given a `.subscribe()` call, look back along the chain for a
 * `.pipe(...)` containing a self-terminating operator.
 *
 * Handles `source.pipe(a, b, takeUntil(x)).subscribe(...)`. Deliberately
 * shallow: we do not follow the observable through variables or across
 * methods, because that needs dataflow analysis. When we cannot see a
 * mitigation we report none, and the pairing stage stays cautious.
 */
export interface SubscribeMitigation {
  /** The operator name, e.g. "takeUntil". */
  operator: string;
  /** For takeUntil, the signal expression, e.g. "this.destroy$". */
  signal?: string;
}

export function findSubscribeMitigation(
  call: ts.CallExpression,
): SubscribeMitigation | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;

  // Walk back through chained calls: a.pipe(...).pipe(...).subscribe()
  let receiver: ts.Expression = callee.expression;

  for (let depth = 0; depth < 6; depth++) {
    if (!ts.isCallExpression(receiver)) return undefined;
    const receiverCallee = receiver.expression;
    if (!ts.isPropertyAccessExpression(receiverCallee)) return undefined;

    if (receiverCallee.name.text === 'pipe') {
      for (const arg of receiver.arguments) {
        const name = operatorNameOf(arg);
        if (name === undefined || !SELF_TERMINATING_OPERATORS.has(name)) continue;

        // Capture takeUntil's argument so Phase 5 can verify the signal is
        // actually fired. take(1)/first() need no signal - they are
        // self-limiting by construction.
        let signal: string | undefined;
        if (name === 'takeUntil' && ts.isCallExpression(arg)) {
          const signalArg = arg.arguments[0];
          if (signalArg) signal = renderReceiver(signalArg);
        }

        return { operator: name, ...(signal !== undefined ? { signal } : {}) };
      }
    }

    receiver = receiverCallee.expression;
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/* Observable source classification                                    */
/* ------------------------------------------------------------------ */

/** HTTP verbs that indicate a request observable, which completes. */
const HTTP_METHOD_NAMES = new Set(['get', 'post', 'put', 'delete', 'patch', 'request', 'head']);

/**
 * Angular Material observables that are documented to complete.
 * https://material.angular.io - MatDialogRef.afterClosed() completes when
 * the dialog closes, so subscribing without teardown is safe.
 */
const DIALOG_CLOSURE_NAMES = new Set([
  'afterClosed',
  'afterOpened',
  'afterDismissed',
  'beforeClosed',
  'onAction',
]);

/** Names that indicate a stream which never completes. */
const INFINITE_MEMBER_NAMES = new Set([
  'valueChanges',
  'statusChanges',
  'queryParams',
  'params',
  'events',
  'fragment',
  'url',
  'data',
]);

/**
 * Guess the lifetime of the observable behind a `.subscribe()`.
 *
 * Walks back along the call chain collecting every identifier and method
 * name, then pattern-matches. This is naming-based inference, not type
 * analysis - it can be wrong, which is why the result is called a hint and
 * is always presented as one.
 *
 * The distinction it captures is real and important:
 *   this.http.get(url).subscribe()      completes -> harmless
 *   this.someSubject$.subscribe()       never completes -> retains forever
 */
export function classifyObservableSource(call: ts.CallExpression): ObservableSourceHint {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return 'unknown';
  return classifyObservableExpression(callee.expression);
}

/**
 * Classify an expression that evaluates to an Observable.
 *
 * Split out from `classifyObservableSource` so the optional type resolver
 * can reuse it: once the checker resolves `getDevices` to its declaration,
 * we run this same logic on whatever that method RETURNS, where
 * `this.http.get(url)` is finally visible.
 */
export function classifyObservableExpression(source: ts.Expression): ObservableSourceHint {
  const parts: string[] = [];

  const collect = (node: ts.Node, depth: number): void => {
    if (depth > 12) return;
    if (ts.isPropertyAccessExpression(node)) {
      parts.push(node.name.text);
      collect(node.expression, depth + 1);
    } else if (ts.isCallExpression(node)) {
      collect(node.expression, depth + 1);
    } else if (ts.isIdentifier(node)) {
      parts.push(node.text);
    } else if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) {
      collect(node.expression, depth + 1);
    } else if (ts.isElementAccessExpression(node)) {
      collect(node.expression, depth + 1);
    }
  };

  collect(source, 0);

  const lower = parts.map((p) => p.toLowerCase());
  const hasStreamSuffix = parts.some((p) => p.endsWith('$'));

  /* ---- documented-finite sources, checked first ---- */

  // Angular Material documents afterClosed/afterDismissed/afterOpened as
  // completing when the dialog or snackbar closes.
  if (parts.some((p) => DIALOG_CLOSURE_NAMES.has(p))) return 'dialogClosure';

  // An explicit HttpClient receiver, or a bare HTTP verb. Both are safe
  // enough to exclude. A `$` anywhere in the chain vetoes this, because
  // `store.get('k').value$` is a stream, not a request.
  if (!hasStreamSuffix) {
    if (lower.includes('http') || lower.includes('httpclient')) return 'http';
    if (parts.some((p) => HTTP_METHOD_NAMES.has(p))) return 'http';
  }

  /* ---- documented-infinite sources ---- */
  if (hasStreamSuffix || lower.some((p) => p.includes('subject'))) return 'subject';
  if (parts.some((p) => p === 'valueChanges' || p === 'statusChanges')) return 'formControl';
  if (lower.includes('router') || lower.includes('route') || lower.includes('activatedroute')) {
    return 'router';
  }
  if (parts.some((p) => INFINITE_MEMBER_NAMES.has(p))) return 'router';
  if (lower.includes('fromevent') || lower.includes('interval') || lower.includes('timer')) {
    return 'timerOrEvent';
  }

  /**
   * ---- name-shaped guess, recorded but NOT trusted ----
   * `getDevices()`, `updateStar()`, `saveConfig()` are usually one-shot
   * service calls wrapping HttpClient. Usually is not always: the same
   * method could return a cached BehaviorSubject. We record the suspicion
   * so Phase 4 can weight it, and stop short of excluding it.
   */
  const firstCallName = parts[0];
  if (firstCallName !== undefined && looksLikeOneShotOperation(firstCallName)) {
    return 'likelyFiniteByName';
  }

  return 'unknown';
}

/** Verb prefixes conventionally used for one-shot service operations. */
const ONE_SHOT_PREFIXES = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'remove',
  'update',
  'create',
  'save',
  'fetch',
  'load',
  'send',
  'submit',
  'upload',
  'download',
  'add',
  'search',
  'list',
];

function looksLikeOneShotOperation(name: string): boolean {
  // Require camelCase: "getDevices" yes, "getter" no.
  return ONE_SHOT_PREFIXES.some(
    (prefix) =>
      name.length > prefix.length &&
      name.startsWith(prefix) &&
      name[prefix.length] === name[prefix.length]?.toUpperCase(),
  );
}

/** The operator name from a pipe argument, e.g. "takeUntil" from takeUntil(x). */
function operatorNameOf(arg: ts.Expression): string | undefined {
  if (!ts.isCallExpression(arg)) return undefined;
  const callee = arg.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/* ------------------------------------------------------------------ */
/* The walker                                                          */
/* ------------------------------------------------------------------ */

/**
 * Optionally refine a syntax-derived source hint using type information.
 *
 * Passed in rather than imported so the expensive type-checking path stays
 * entirely opt-in and this module keeps no dependency on it.
 */
export type SourceHintRefiner = (
  call: ts.CallExpression,
  current: ObservableSourceHint,
) => ObservableSourceHint;

export interface VisitOptions {
  refineSource?: SourceHintRefiner;
}

/**
 * Find every resource operation in a parsed file.
 *
 * One pass, visiting every node. Both acquires and releases are collected
 * here; pairing them is a separate concern handled in pairing.ts.
 */
export function findResourceOperations(
  sourceFile: ts.SourceFile,
  relativePath: string,
  options: VisitOptions = {},
): ResourceOperation[] {
  const operations: ResourceOperation[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      inspectCall(node, sourceFile, relativePath, operations, options);
    } else if (ts.isNewExpression(node)) {
      inspectNew(node, sourceFile, relativePath, operations);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return operations;
}

/* ---- call expressions: foo(), x.foo(), NS.foo() ---- */

function inspectCall(
  node: ts.CallExpression,
  sourceFile: ts.SourceFile,
  relativePath: string,
  out: ResourceOperation[],
  options: VisitOptions = {},
): void {
  const callee = node.expression;

  /* --- bare global: setInterval(...) --- */
  if (ts.isIdentifier(callee)) {
    const name = callee.text;

    const acquireDef = GLOBAL_ACQUIRES.get(name);
    if (acquireDef) {
      out.push(buildAcquire(acquireDef.kind, node, node, sourceFile, relativePath, name));
      return;
    }

    // A bare release call, e.g. clearInterval(this.t)
    const releasedKinds = kindsReleasedBy(name);
    if (releasedKinds) {
      out.push(buildRelease(releasedKinds, node, sourceFile, relativePath, name));
    }
    return;
  }

  if (!ts.isPropertyAccessExpression(callee)) return;

  const methodName = callee.name.text;
  const receiverText = renderReceiver(callee.expression);

  /* --- window.setInterval(...) --- */
  if (GLOBAL_RECEIVERS.has(receiverText)) {
    const globalDef = GLOBAL_ACQUIRES.get(methodName);
    if (globalDef) {
      out.push(
        buildAcquire(
          globalDef.kind,
          node,
          node,
          sourceFile,
          relativePath,
          `${receiverText}.${methodName}`,
        ),
      );
      return;
    }
  }

  /* --- namespaced: Highcharts.chart(...), echarts.init(...) --- */
  const namespacedDef = NAMESPACED_ACQUIRES.get(`${receiverText}.${methodName}`);
  if (namespacedDef) {
    out.push(
      buildAcquire(
        namespacedDef.kind,
        node,
        node,
        sourceFile,
        relativePath,
        `${receiverText}.${methodName}`,
      ),
    );
    return;
  }

  /* --- method acquires: x.subscribe(...), dialog.open(...) --- */
  const methodEntries = METHOD_ACQUIRES.get(methodName);
  if (methodEntries) {
    for (const entry of methodEntries) {
      if (
        entry.receiverIncludes !== undefined &&
        !receiverText.toLowerCase().includes(entry.receiverIncludes.toLowerCase())
      ) {
        continue;
      }

      const operation = buildAcquire(
        entry.definition.kind,
        node,
        node,
        sourceFile,
        relativePath,
        `${receiverText}.${methodName}`,
      );

      // RxJS only: does the chain terminate itself, and what is it
      // subscribing to? Both questions decide whether this is a real risk.
      if (entry.definition.kind === 'rxjs.subscription') {
        const mitigation = findSubscribeMitigation(node);
        if (mitigation) {
          operation.mitigatedBy = `${mitigation.operator}()`;
          if (mitigation.signal !== undefined) operation.mitigationSignal = mitigation.signal;
        }

        const syntactic = classifyObservableSource(node);
        // With --types, follow the called method to its declaration and read
        // what it actually returns. Refinement can only add information:
        // the refiner returns the original hint when it cannot do better.
        operation.sourceHint = options.refineSource
          ? options.refineSource(node, syntactic)
          : syntactic;
      }

      if (entry.definition.kind === 'dom.eventListener') {
        // Record the event name so pairing can match a 'resize' listener
        // against a 'resize' removal, rather than assuming any removal
        // covers any addition.
        const eventName = firstStringArgument(node);
        if (eventName !== undefined) operation.detail = eventName;

        // An inline handler can never be removed: removeEventListener
        // matches on function identity and there is no reference to pass.
        const handler = node.arguments[1];
        if (
          handler !== undefined &&
          (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
        ) {
          operation.inlineHandler = true;
        }
      }

      out.push(operation);
      return;
    }
  }

  /* --- releases: x.unsubscribe(), chart.destroy(), x.dispose() --- */
  const releasedKinds = kindsReleasedBy(methodName);
  if (releasedKinds) {
    const operation = buildRelease(
      releasedKinds,
      node,
      sourceFile,
      relativePath,
      `${receiverText}.${methodName}`,
    );
    if (methodName === 'removeEventListener') {
      const eventName = firstStringArgument(node);
      if (eventName !== undefined) operation.detail = eventName;
    }
    out.push(operation);
  }
}

/* ---- new expressions: new WebSocket(), new H.Map() ---- */

function inspectNew(
  node: ts.NewExpression,
  sourceFile: ts.SourceFile,
  relativePath: string,
  out: ResourceOperation[],
): void {
  const target = node.expression;

  if (ts.isIdentifier(target)) {
    const definition = CONSTRUCT_ACQUIRES.get(target.text);
    if (definition) {
      out.push(
        buildAcquire(
          definition.kind,
          node,
          node,
          sourceFile,
          relativePath,
          `new ${target.text}`,
        ),
      );
    }
    return;
  }

  if (ts.isPropertyAccessExpression(target)) {
    const receiverText = renderReceiver(target.expression);
    const key = `${receiverText}.${target.name.text}`;

    // new H.Map(...) - a namespaced constructor
    const namespacedDef = NAMESPACED_ACQUIRES.get(key);
    if (namespacedDef) {
      out.push(
        buildAcquire(namespacedDef.kind, node, node, sourceFile, relativePath, `new ${key}`),
      );
      return;
    }

    // new ns.WebSocket(...) - fall back to the plain constructor name
    const constructDef = CONSTRUCT_ACQUIRES.get(target.name.text);
    if (constructDef) {
      out.push(
        buildAcquire(constructDef.kind, node, node, sourceFile, relativePath, `new ${key}`),
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

function buildAcquire(
  kind: ResourceKind,
  node: ts.Node,
  handleNode: ts.Node,
  sourceFile: ts.SourceFile,
  relativePath: string,
  callText: string,
): ResourceOperation {
  const { line, column } = locationOf(sourceFile, node);
  const method = enclosingMethod(node);
  const cls = enclosingClass(node);
  const { disposition, storedAs } = handleDisposition(handleNode);

  return {
    kind,
    group: groupOf(kind),
    action: 'acquire',
    file: relativePath,
    line,
    column,
    ...(cls?.name ? { className: cls.name.text } : {}),
    ...(method ? { methodName: method.name } : {}),
    ...(method?.lifecycleHook ? { lifecycleHook: method.lifecycleHook } : {}),
    callText,
    snippet: snippetOf(sourceFile, node),
    disposition,
    ...(storedAs !== undefined ? { storedAs } : {}),
    nestedInCallback: isNestedInCallback(node, method?.node),
  };
}

function buildRelease(
  kinds: ResourceKind[],
  node: ts.Node,
  sourceFile: ts.SourceFile,
  relativePath: string,
  callText: string,
): ResourceOperation {
  const { line, column } = locationOf(sourceFile, node);
  const method = enclosingMethod(node);
  const cls = enclosingClass(node);
  // The first kind is only a label; `satisfiesKinds` carries the full truth.
  const primary = kinds[0] as ResourceKind;

  return {
    kind: primary,
    group: groupOf(primary),
    action: 'release',
    file: relativePath,
    line,
    column,
    ...(cls?.name ? { className: cls.name.text } : {}),
    ...(method ? { methodName: method.name } : {}),
    ...(method?.lifecycleHook ? { lifecycleHook: method.lifecycleHook } : {}),
    callText,
    snippet: snippetOf(sourceFile, node),
    disposition: 'unknown',
    nestedInCallback: isNestedInCallback(node, method?.node),
    satisfiesKinds: kinds,
  };
}

/** The group prefix of a kind, e.g. "timer" from "timer.interval". */
function groupOf(kind: ResourceKind): ResourceOperation['group'] {
  const prefix = kind.split('.')[0];
  return (prefix ?? 'dom') as ResourceOperation['group'];
}

/** Render a receiver expression as text, for matching and reporting. */
function renderReceiver(node: ts.Expression): string {
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(node)) {
    return `${renderReceiver(node.expression)}.${node.name.text}`;
  }
  if (ts.isCallExpression(node)) return `${renderReceiver(node.expression)}()`;
  if (ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) {
    return renderReceiver(node.expression);
  }
  if (ts.isElementAccessExpression(node)) return `${renderReceiver(node.expression)}[...]`;
  return '(expr)';
}

/** The first argument, if it is a plain string literal. */
function firstStringArgument(node: ts.CallExpression): string | undefined {
  const first = node.arguments[0];
  if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
    return first.text;
  }
  return undefined;
}
