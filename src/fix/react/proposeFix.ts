/**
 * Fix proposal for React: adding a missing `useEffect` cleanup.
 *
 * WHY THIS IS ITS OWN MODULE, NOT A BRANCH INSIDE THE ANGULAR ONE
 * -------------------------------------------------------------------
 * `src/fix/propose.ts` inserts cleanup into `ngOnDestroy` - a method every
 * Angular class either has or can have added to it. React has no such
 * method. The correct place is inside the SAME `useEffect` callback that
 * created the resource, as the function it already returns (or would
 * return) to React - a structurally different edit, not a variant of the
 * same one. What IS shared: the output shape (`ProposedFix`), the diff
 * renderer (`buildUnifiedDiff`), and the git-safety/apply machinery, none
 * of which knows or needs to know which framework produced the change.
 *
 * THE ONE RULE THIS FILE WILL NOT BEND ON
 * -------------------------------------------
 * A fix is generated only when there is exactly ONE resource-acquiring
 * call inside the target effect, and it is one of the two shapes below.
 * Anything else - two resources in one effect, an inline arrow handed to
 * `addEventListener` (which cannot be matched by reference to remove it
 * later), a resource whose handle is not captured in a variable - is
 * refused, explained, and left for a person. A partial fix that clears one
 * resource while leaving a second untouched is worse than no fix, because
 * it looks like the problem was solved.
 *
 * CLASS COMPONENTS
 * ----------------
 * A class component's cleanup site is `componentWillUnmount`. The same
 * one-resource rule applies to `componentDidMount`, with one extra
 * requirement: the handle must be stored ON THE INSTANCE (`this.timer =
 * setInterval(...)`, or a listener registered with `this.handler`), because
 * `componentWillUnmount` is a different method and cannot see a local
 * variable from `componentDidMount`. A class that already has a
 * `componentWillUnmount` is refused - merging into existing teardown is a
 * judgement call, not an insertion.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

import type { GenericCorrelatedFinding } from '../../core/correlation/correlateGeneric';
import type { AppEntity } from '../../core/framework/types';
import { isRuntimeEstablished } from '../../types/index';
import { buildUnifiedDiff, type ProposedFix } from '../propose';

export interface ReactFixOptions {
  projectRoot: string;
}

function manualOnly(
  finding: GenericCorrelatedFinding,
  file: string,
  reason: string,
  site = 'a useEffect cleanup',
): ProposedFix {
  return {
    findingId: finding.constructorName,
    file,
    title: `Add ${site} in ${finding.entityName ?? '(unknown)'}`,
    rationale: reason,
    safety: 'manual-only',
    functionalRisks: [
      'Not generated - a person needs to read this effect and decide the correct cleanup themselves.',
    ],
    verificationPlan: [
      'After adding cleanup by hand, re-run the same journey with `memory-agent inspect` and confirm this constructor stops growing.',
    ],
    manualInstructions: [reason],
  };
}

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function isCapitalised(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** Find the function-shaped declaration this entity's name refers to. */
function findComponentFunction(
  sourceFile: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined {
  let found: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

interface EffectCandidate {
  call: ts.CallExpression;
  block: ts.Block;
}

/** Every `useEffect(() => { ... }, deps?)` inside a node whose callback has NO top-level cleanup return. */
function findEffectsWithoutCleanup(root: ts.Node): EffectCandidate[] {
  const found: EffectCandidate[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useEffect' &&
      node.arguments.length > 0
    ) {
      const callback = node.arguments[0];
      if (
        callback !== undefined &&
        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
        ts.isBlock(callback.body)
      ) {
        const hasCleanup = callback.body.statements.some(
          (s) =>
            ts.isReturnStatement(s) &&
            s.expression !== undefined &&
            (ts.isArrowFunction(s.expression) || ts.isFunctionExpression(s.expression)),
        );
        if (!hasCleanup) found.push({ call: node, block: callback.body });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

const ACQUIRE_NAMES = new Set([
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

function recognisedCallName(node: ts.Node): string | undefined {
  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression)) return node.expression.text;
    if (ts.isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  }
  if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) return node.expression.text;
  return undefined;
}

/** Every acquire-shaped call anywhere under `root`, at any depth. */
function countAcquireCalls(root: ts.Node): number {
  let count = 0;
  const visit = (node: ts.Node): void => {
    const name = recognisedCallName(node);
    if (name !== undefined && ACQUIRE_NAMES.has(name)) count++;
    ts.forEachChild(node, visit);
  };
  visit(root);
  return count;
}

type ResourcePlan =
  | { kind: 'timer'; clearCall: string; handleText: string }
  | { kind: 'listener'; targetText: string; eventText: string; handlerText: string };

/**
 * Read exactly one recognised resource-acquiring statement out of an
 * effect's top-level statements - and refuse (return undefined) unless
 * this is the ONLY resource-acquiring call anywhere in the block, at any
 * depth. That second check is what stops a second, unhandled resource
 * from being silently left behind.
 */
function findSingleResource(block: ts.Block, sourceFile: ts.SourceFile): ResourcePlan | undefined {
  let plan: ResourcePlan | undefined;
  let planCount = 0;
  let otherAcquireCount = 0;

  // First pass over the whole block: count every acquire-shaped call so a
  // second, different resource is never silently left uncleaned.
  otherAcquireCount = countAcquireCalls(block);

  for (const stmt of block.statements) {
    // const <id> = setInterval(...) / setTimeout(...)
    if (
      ts.isVariableStatement(stmt) &&
      stmt.declarationList.declarations.length === 1 &&
      ts.isIdentifier(stmt.declarationList.declarations[0]?.name as ts.BindingName)
    ) {
      const decl = stmt.declarationList.declarations[0] as ts.VariableDeclaration;
      const init = decl.initializer;
      if (
        init !== undefined &&
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        (init.expression.text === 'setInterval' || init.expression.text === 'setTimeout')
      ) {
        const clearCall = init.expression.text === 'setInterval' ? 'clearInterval' : 'clearTimeout';
        plan = { kind: 'timer', clearCall, handleText: (decl.name as ts.Identifier).text };
        planCount++;
      }
    }

    // <target>.addEventListener(<event>, <handlerIdentifier>)
    if (ts.isExpressionStatement(stmt) && ts.isCallExpression(stmt.expression)) {
      const call = stmt.expression;
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === 'addEventListener' &&
        call.arguments.length >= 2 &&
        ts.isIdentifier(call.arguments[1] as ts.Expression)
      ) {
        const target = call.expression.expression;
        plan = {
          kind: 'listener',
          targetText: target.getText(sourceFile),
          eventText: (call.arguments[0] as ts.Expression).getText(sourceFile),
          handlerText: (call.arguments[1] as ts.Identifier).text,
        };
        planCount++;
      }
    }
  }

  if (planCount !== 1) return undefined;
  // The one recognised statement IS the only acquire-shaped call in the
  // block (otherAcquireCount counts it too), so this is safe exactly when
  // otherAcquireCount === 1.
  if (otherAcquireCount !== 1) return undefined;
  return plan;
}

function indentOf(sourceFile: ts.SourceFile, node: ts.Node): string {
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
  const lineText = sourceFile.text.split('\n')[line] ?? '';
  const match = /^[ \t]*/.exec(lineText);
  return match?.[0] ?? '  ';
}

/** Does the last statement in this block end its line with a semicolon? Match it; otherwise omit. */
function usesSemicolons(block: ts.Block, sourceFile: ts.SourceFile): boolean {
  const last = block.statements[block.statements.length - 1];
  if (last === undefined) return true;
  const text = last.getText(sourceFile).trimEnd();
  return text.endsWith(';');
}

/** `this.<name>` - the only handle shape `componentWillUnmount` can reach. */
function thisProperty(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  if (
    ts.isPropertyAccessExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ts.isIdentifier(node.name)
  ) {
    return node.getText(sourceFile);
  }
  return undefined;
}

type ClassPlan =
  | { kind: 'timer'; clearCall: string; handleText: string }
  | { kind: 'listener'; targetText: string; eventText: string; handlerText: string }
  | { kind: 'local-handle' };

/**
 * The single resource `componentDidMount` starts, as long as its handle
 * lives on the instance. A timer captured in a local variable is reported
 * as `local-handle` so the refusal can say exactly why.
 */
function findSingleClassResource(body: ts.Block, sourceFile: ts.SourceFile): ClassPlan | undefined {
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

    // this.<handle> = setInterval(...) / setTimeout(...)
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

    // <target>.addEventListener(<event>, this.<handler>)
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

function proposeClassComponentFix(
  finding: GenericCorrelatedFinding,
  entity: AppEntity,
  relativeFile: string,
  text: string,
  sourceFile: ts.SourceFile,
): ProposedFix {
  const site = 'componentWillUnmount';
  let cls: ts.ClassDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (cls !== undefined) return;
    if (ts.isClassDeclaration(node) && node.name?.text === entity.name) {
      cls = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (cls === undefined) {
    return manualOnly(finding, relativeFile, `${entity.name} could not be found in this file as currently written.`, site);
  }

  const methodNamed = (name: string): ts.MethodDeclaration | undefined =>
    (cls as ts.ClassDeclaration).members.find(
      (m): m is ts.MethodDeclaration => ts.isMethodDeclaration(m) && m.name.getText(sourceFile) === name,
    );

  if (methodNamed('componentWillUnmount') !== undefined) {
    return manualOnly(
      finding,
      relativeFile,
      `${entity.name} already has a componentWillUnmount. What it is missing needs a person to read ` +
        'it - adding a second teardown path next to an existing one is not a mechanical change.',
      site,
    );
  }

  const didMount = methodNamed('componentDidMount');
  if (didMount?.body === undefined) {
    return manualOnly(
      finding,
      relativeFile,
      `${entity.name} has no componentDidMount - the growth does not come from the one place this generator knows how to pair with teardown.`,
      site,
    );
  }

  const plan = findSingleClassResource(didMount.body, sourceFile);
  if (plan === undefined) {
    return manualOnly(
      finding,
      relativeFile,
      'componentDidMount does not start exactly one recognised resource (a timer stored on this, or ' +
        'addEventListener with a this.<handler>) - either none was found, or more than one is started ' +
        'and clearing only one would be a partial, misleading fix.',
      site,
    );
  }
  if (plan.kind === 'local-handle') {
    return manualOnly(
      finding,
      relativeFile,
      'componentDidMount keeps its timer handle in a local variable, which componentWillUnmount cannot ' +
        'reach. Storing it on the instance first changes existing code, so that is left for a person.',
      site,
    );
  }

  const semi = usesSemicolons(didMount.body, sourceFile) ? ';' : '';
  const memberIndent = indentOf(sourceFile, didMount);
  const cleanupLine =
    plan.kind === 'timer'
      ? `${plan.clearCall}(${plan.handleText})${semi}`
      : `${plan.targetText}.removeEventListener(${plan.eventText}, ${plan.handlerText})${semi}`;

  const insertPos = didMount.getEnd();
  const insertion = `\n\n${memberIndent}componentWillUnmount() {\n${memberIndent}  ${cleanupLine}\n${memberIndent}}`;
  const newContent = text.slice(0, insertPos) + insertion + text.slice(insertPos);

  return {
    findingId: finding.constructorName,
    file: relativeFile,
    title: `Add the missing componentWillUnmount in ${entity.name}`,
    rationale:
      plan.kind === 'timer'
        ? `${entity.name} starts a timer in componentDidMount and never clears it, so every unmounted ` +
          `instance stays reachable from the timer. Adding \`${plan.clearCall}(${plan.handleText})\` in ` +
          'componentWillUnmount stops it exactly when React unmounts the component.'
        : `${entity.name} adds an event listener in componentDidMount and never removes it, so every ` +
          'unmounted instance stays reachable from the event target. Adding `removeEventListener` in ' +
          'componentWillUnmount, with the same handler reference, releases it.',
    safety: 'additive',
    newContent,
    diff: buildUnifiedDiff(relativeFile, text, newContent),
    functionalRisks: [
      plan.kind === 'timer'
        ? 'None expected: the timer is only cleared once React has unmounted the component.'
        : 'None expected: the listener is only removed once React has unmounted the component.',
    ],
    verificationPlan: [
      'Rebuild, run the project\'s tests, then repeat the same journey with `memory-agent inspect` ' +
        `and confirm ${finding.constructorName} no longer grows across the measured cycles.`,
    ],
  };
}

export function proposeReactFix(
  finding: GenericCorrelatedFinding,
  entity: AppEntity,
  options: ReactFixOptions,
): ProposedFix | undefined {
  const relativeFile = entity.file;
  const absolute = path.join(options.projectRoot, relativeFile);

  if (!isRuntimeEstablished(finding.confidence)) {
    return manualOnly(finding, relativeFile, 'Confidence is below HIGH, so no change is generated.');
  }
  if (entity.frameworkKind !== 'FunctionComponent' && entity.frameworkKind !== 'ClassComponent') {
    return manualOnly(
      finding,
      relativeFile,
      `${entity.frameworkKind} teardown is not generated - only a function component's useEffect ` +
        "cleanup and a class component's componentWillUnmount are.",
    );
  }
  if (!fs.existsSync(absolute)) return undefined;

  let text: string;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch {
    return undefined;
  }

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(absolute, text, ts.ScriptTarget.ES2022, /* setParentNodes */ true, scriptKindFor(absolute));
  } catch {
    return manualOnly(finding, relativeFile, 'The file could not be parsed.');
  }

  if (entity.frameworkKind === 'ClassComponent') {
    return proposeClassComponentFix(finding, entity, relativeFile, text, sourceFile);
  }

  const fn = findComponentFunction(sourceFile, entity.name);
  if (fn === undefined) {
    return manualOnly(finding, relativeFile, `${entity.name} could not be found in this file as currently written.`);
  }

  const effects = findEffectsWithoutCleanup(fn);
  if (effects.length === 0) {
    return manualOnly(
      finding,
      relativeFile,
      'No useEffect without a cleanup return was found in this component - the growth may not ' +
        'come from an effect at all, or the cleanup is written in a shape this generator does not recognise.',
    );
  }
  if (effects.length > 1) {
    return manualOnly(
      finding,
      relativeFile,
      `${effects.length} separate useEffect calls here have no cleanup return. Picking the right ` +
        'one needs a person who knows which effect owns the growth.',
    );
  }

  const target = effects[0] as EffectCandidate;
  const plan = findSingleResource(target.block, sourceFile);
  if (plan === undefined) {
    return manualOnly(
      finding,
      relativeFile,
      'This effect does not contain exactly one recognised resource-acquiring call (a captured ' +
        'timer handle, or addEventListener with a named handler) - either none was found, or more ' +
        'than one resource is started here and clearing only one would be a partial, misleading fix.',
    );
  }

  const semi = usesSemicolons(target.block, sourceFile) ? ';' : '';
  const indent = indentOf(sourceFile, target.block.statements[target.block.statements.length - 1] as ts.Node);
  const cleanupLine =
    plan.kind === 'timer'
      ? `${plan.clearCall}(${plan.handleText})${semi}`
      : `${plan.targetText}.removeEventListener(${plan.eventText}, ${plan.handlerText})${semi}`;

  const insertPos = target.block.getEnd() - 1; // position of the block's closing "}"
  const insertion = `${indent}  return () => { ${cleanupLine} };\n${indent}`;
  const newContent = text.slice(0, insertPos) + insertion + text.slice(insertPos);

  const diff = buildUnifiedDiff(relativeFile, text, newContent);

  return {
    findingId: finding.constructorName,
    file: relativeFile,
    title: `Add the missing useEffect cleanup in ${entity.name}`,
    rationale:
      plan.kind === 'timer'
        ? `${entity.name} starts a timer in useEffect with no cleanup, so it keeps running after the ` +
          `component unmounts. Adding \`${plan.clearCall}(${plan.handleText})\` in the effect's own ` +
          'cleanup function stops it exactly when React tears the effect down.'
        : `${entity.name} adds an event listener in useEffect with no cleanup, so it stays registered ` +
          `after the component unmounts, keeping everything its closure captured reachable. Adding ` +
          `\`removeEventListener\` in the effect's own cleanup function releases it.`,
    safety: 'additive',
    newContent,
    diff,
    functionalRisks: [
      plan.kind === 'timer'
        ? 'None expected: the timer is only ever cleared after the effect it belongs to is torn down.'
        : 'None expected: the listener is only ever removed after the effect it belongs to is torn down.',
    ],
    verificationPlan: [
      'Rebuild, run the project\'s tests, then repeat the same journey with `memory-agent inspect` ' +
        `and confirm ${finding.constructorName} no longer grows across the measured cycles.`,
    ],
  };
}
