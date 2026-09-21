/**
 * Releasing everything a class starts and never stops, in one pass.
 *
 * WHY ONE PASS COVERS EVERY RESOURCE KIND
 * ----------------------------------------
 * A class does not leak "a subscription" or "a chart" in isolation - it
 * leaks whatever it happens to start without a matching teardown, and a
 * class with an unmanaged interval often has an unmanaged listener right
 * next to it. Two separate fixes, applied one after another, would either
 * conflict (both trying to create the same ngOnDestroy) or leave the class
 * looking "fixed" after the first one when the second issue is still
 * sitting there. So this walks the class ONCE, for every resource kind the
 * analyzer knows about, and produces ONE consolidated ngOnDestroy - whether
 * that means extending an existing one or creating it from nothing.
 *
 * PER-KIND, NOT ALL-OR-NOTHING
 * -----------------------------
 * If subscriptions can be fixed safely but an interval's handle is stored
 * somewhere ngOnDestroy cannot reach, the subscriptions are still fixed.
 * What is refused stays refused, kind by kind - see releaseTimers.ts and
 * addOnDestroy.ts's collectSubscribeCalls for what "safely" means for each.
 * `wrapped` reports exactly what was addressed, so the caller (propose.ts)
 * can tell a finding of a kind that WAS handled from one that was not, even
 * though both went through the same generated diff.
 */

import * as ts from 'typescript';

import { DEFINITION_BY_KIND } from '../analyzer/resources';
import { decideSubscription, type ProjectKnowledge } from '../knowledge/lifetime';
import type { ResourceKind } from '../types/analysis';
import {
  applyEdits,
  collectSubscribeCalls,
  ensureImplements,
  findDestroySubject,
  findSubscriptionField,
  newImportLine,
  ensureNamedImport,
  findClass,
  findImport,
  indentOf,
  isOnDestroyMethod,
  uniqueMemberName,
  type AddOnDestroyFailure,
  type Edit,
} from './addOnDestroy';
import { collectEventListeners } from './releaseListeners';
import { collectStoredInstances } from './releaseInstances';
import { collectGlobalTimerCalls, type TimerCollectorResult } from './releaseTimers';

/** The 15 kinds whose correct teardown is "call one method on the instance". */
const SIMPLE_DISPOSE_KINDS: ResourceKind[] = [
  'dom.mutationObserver', 'dom.resizeObserver', 'dom.intersectionObserver', 'dom.performanceObserver',
  'net.webSocket', 'net.eventSource', 'thread.worker',
  'chart.highcharts', 'chart.echarts', 'chart.amcharts', 'chart.apex', 'chart.d3Timer',
  'map.here', 'map.leaflet',
  'angular.dialog', 'angular.overlay',
];

export interface AddCleanupResult {
  newContent: string;
  extendedExisting: boolean;
  notes: string[];
  /** How many acquires of each kind this pass actually addressed. */
  wrapped: Partial<Record<ResourceKind, number>>;
  /** Kinds this pass looked at but could not safely address, and why. */
  skipped: Partial<Record<ResourceKind, string>>;
}

export function addCleanup(
  source: string,
  fileName: string,
  className: string,
  knowledge?: ProjectKnowledge,
): AddCleanupResult | AddOnDestroyFailure {
  const eol = (source.match(/\r\n/g) ?? []).length > (source.match(/(?<!\r)\n/g) ?? []).length ? '\r\n' : '\n';

  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const target = findClass(sourceFile, className);
  if (target === undefined) return { reason: `Could not find class ${className} in this file.` };
  if (target.members.length === 0) {
    return { reason: `${className} has an empty body; there is nothing to clean up.` };
  }

  const angularImport = findImport(sourceFile, '@angular/core');
  if (angularImport === undefined) {
    return { reason: 'This file does not import from @angular/core, so it is not an Angular class.' };
  }

  const existing = target.members.find(isOnDestroyMethod);
  if (existing !== undefined && (!ts.isMethodDeclaration(existing) || existing.body === undefined)) {
    return {
      reason:
        `${className}.ngOnDestroy is not an ordinary method, so there is no body to add ` +
        'cleanup to safely.',
    };
  }

  const classText = target.getText(sourceFile);
  const wrapped: Partial<Record<ResourceKind, number>> = {};
  const skipped: Partial<Record<ResourceKind, string>> = {};
  const notes: string[] = [];
  const edits: Edit[] = [];
  const fieldLines: string[] = [];
  const statements: string[] = [];
  const takenNames = new Set<string>();
  for (const member of target.members) {
    if (member.name !== undefined && ts.isIdentifier(member.name)) takenNames.add(member.name.text);
  }

  const memberIndent = indentOf(source, (target.members[0] as ts.ClassElement).getStart(sourceFile));

  /* ---- 1. subscriptions (unchanged, proven logic) ---- */
  const subs = collectSubscribeCalls(
    target,
    sourceFile,
    knowledge === undefined ? undefined : (call) => decideSubscription(call, sourceFile, knowledge),
  );
  if ('reason' in subs) {
    skipped['rxjs.subscription'] = subs.reason;
  } else if (subs.calls.length === 0 && subs.kept.length > 0) {
    skipped['rxjs.subscription'] =
      'Every subscription here is intentionally left active, so nothing was changed: ' +
      [...new Set(subs.kept.map((k) => k.reason))].join(' ');
  } else if (subs.calls.length > 0) {
    for (const k of subs.kept) notes.push(`Line ${k.line} was left as it is: ${k.reason}`);
    /**
     * Follow the class's own pattern first, then the project's.
     *
     * A class that already keeps a `x = new Subscription()` gets its new
     * subscriptions added to THAT (adding a second collector next to it is
     * how generated code gets noticed and reverted). Otherwise the field is
     * named the way the rest of the project names it (IOSense: "subs").
     */
    const existingField = findSubscriptionField(target);
    /**
     * A project that mostly writes `takeUntil(this.destroy$)` gets exactly
     * that (IOSense: 780 places), not a second style. A class that already
     * keeps its own Subscription collector keeps using it.
     */
    const conv = knowledge?.conventions;
    const destroyName = conv?.destroySubject;
    const takeUntilMode = existingField === undefined && conv?.cleanupStyle === 'take-until' && destroyName !== undefined;
    const existingDestroy = takeUntilMode ? findDestroySubject(target) : undefined;
    const field = takeUntilMode
      ? (existingDestroy ?? uniqueMemberName2(takenNames, destroyName as string))
      : (existingField ?? uniqueMemberName2(takenNames, conv?.subscriptionField ?? 'subscriptions'));
    const rxjsMajor = knowledge?.profile.rxjsMajor;
    // RxJS 5 has no root 'rxjs' export of Subscription; 6 and 7 do.
    const rxjsModule = rxjsMajor !== undefined && rxjsMajor < 6 ? 'rxjs/Subscription' : 'rxjs';
    const rxjsImport = findImport(sourceFile, rxjsModule);
    if (takeUntilMode) {
      if (existingDestroy === undefined) {
        const subjectImport = findImport(sourceFile, 'rxjs');
        if (subjectImport === undefined) {
          const end = angularImport.getEnd();
          edits.push({ start: end, end, text: newImportLine(sourceFile, 'Subject', 'rxjs') });
        } else {
          const e = ensureNamedImport(subjectImport, 'Subject');
          if (e !== undefined) edits.push(e);
        }
        fieldLines.push(
          `${memberIndent}/** Fires when the component is destroyed; subscriptions wait on it. */`,
          `${memberIndent}private readonly ${field} = new Subject<void>();`,
        );
      }
      const operatorsImport = findImport(sourceFile, 'rxjs/operators');
      if (operatorsImport === undefined) {
        const end = angularImport.getEnd();
        edits.push({ start: end, end, text: newImportLine(sourceFile, 'takeUntil', 'rxjs/operators') });
      } else {
        const e = ensureNamedImport(operatorsImport, 'takeUntil');
        if (e !== undefined) edits.push(e);
      }
    } else if (existingField === undefined) {
      if (rxjsImport === undefined) {
        const end = angularImport.getEnd();
        edits.push({ start: end, end, text: newImportLine(sourceFile, 'Subscription', rxjsModule) });
      } else {
        const rxjsEdit = ensureNamedImport(rxjsImport, 'Subscription');
        if (rxjsEdit !== undefined) edits.push(rxjsEdit);
      }
      fieldLines.push(
        `${memberIndent}/** Everything this class subscribes to, released in ngOnDestroy. */`,
        `${memberIndent}private readonly ${field} = new Subscription();`,
      );
    }
    for (const call of subs.calls) {
      if (takeUntilMode) {
        // source$.subscribe(...)  ->  source$.pipe(takeUntil(this.destroy$)).subscribe(...)
        const callee = call.expression as ts.PropertyAccessExpression;
        const at = callee.expression.getEnd();
        edits.push({ start: at, end: at, text: `.pipe(takeUntil(this.${field}))` });
      } else {
        edits.push({ start: call.getStart(sourceFile), end: call.getStart(sourceFile), text: `this.${field}.add(` });
        edits.push({ start: call.getEnd(), end: call.getEnd(), text: ')' });
      }
    }
    // An existing field is usually already released in the existing ngOnDestroy.
    if (takeUntilMode) {
      if (!new RegExp(`\\b${escapeRegExp(field)}\\.next\\(`).test(classText)) statements.push(`this.${field}.next();`);
      if (!new RegExp(`\\b${escapeRegExp(field)}\\.complete\\(`).test(classText)) statements.push(`this.${field}.complete();`);
    } else if (existingField === undefined || !new RegExp(`\\b${escapeRegExp(existingField)}\\.unsubscribe\\(`).test(classText)) {
      statements.push(`this.${field}.unsubscribe();`);
    }
    wrapped['rxjs.subscription'] = subs.calls.length;
    if (subs.httpLike > 0) {
      notes.push(
        `${subs.httpLike} of the subscriptions look like HTTP calls, which complete on their own. ` +
          'Adding them to the Subscription is harmless but unnecessary.',
      );
    }
  }

  /* ---- 2. setInterval (unchanged, proven logic) ---- */
  const intervals = collectIntervals(target, sourceFile, classText);
  if ('reason' in intervals) {
    skipped['timer.interval'] = intervals.reason;
  } else if (intervals.discarded.length > 0 || intervals.stored.length > 0) {
    if (intervals.discarded.length > 0) {
      const field = uniqueMemberName2(takenNames, 'intervals');
      fieldLines.push(
        `${memberIndent}/** Every setInterval this class starts, cleared in ngOnDestroy. */`,
        `${memberIndent}private readonly ${field}: ReturnType<typeof setInterval>[] = [];`,
      );
      for (const call of intervals.discarded) {
        edits.push({ start: call.getStart(sourceFile), end: call.getStart(sourceFile), text: `this.${field}.push(` });
        edits.push({ start: call.getEnd(), end: call.getEnd(), text: ')' });
      }
      statements.push(`this.${field}.forEach((id) => clearInterval(id));`);
    }
    for (const property of intervals.stored) statements.push(`clearInterval(this.${property});`);
    wrapped['timer.interval'] = intervals.discarded.length + intervals.stored.length;
  }

  /* ---- 3. setTimeout ---- */
  const timeouts = collectGlobalTimerCalls(target, sourceFile, classText, 'setTimeout', 'clearTimeout');
  if ('reason' in timeouts) {
    skipped['timer.timeout'] = timeouts.reason;
  } else {
    applyTimerFixes(timeouts, 'timeouts', 'clearTimeout', memberIndent, takenNames, sourceFile, edits, fieldLines, statements);
    if (timeouts.discarded.length > 0 || timeouts.stored.length > 0) {
      wrapped['timer.timeout'] = timeouts.discarded.length + timeouts.stored.length;
    }
  }

  /* ---- 4. requestAnimationFrame ---- */
  const rafs = collectGlobalTimerCalls(target, sourceFile, classText, 'requestAnimationFrame', 'cancelAnimationFrame');
  if ('reason' in rafs) {
    skipped['timer.animationFrame'] = rafs.reason;
  } else {
    applyTimerFixes(rafs, 'animationFrames', 'cancelAnimationFrame', memberIndent, takenNames, sourceFile, edits, fieldLines, statements);
    if (rafs.discarded.length > 0 || rafs.stored.length > 0) {
      wrapped['timer.animationFrame'] = rafs.discarded.length + rafs.stored.length;
    }
  }

  /* ---- 5. DOM event listeners (per-listener, never blocks the class) ---- */
  const listeners = collectEventListeners(target, sourceFile, takenNames);
  for (const fix of listeners) {
    if (fix.newField !== undefined) {
      fieldLines.push(`${memberIndent}private readonly ${fix.newField.name} = ${fix.newField.arrowText};`);
      // Point the registration at the new field too - otherwise it keeps
      // registering a fresh, un-removable function every time, and the
      // removeEventListener below would remove nothing at runtime.
      const node = fix.newField.handlerNode;
      edits.push({ start: node.getStart(sourceFile), end: node.getEnd(), text: fix.handlerText });
    }
    statements.push(
      `${fix.targetText}${fix.optionalTarget === true ? '?.' : '.'}removeEventListener(${quote(fix.eventName)}, ${fix.handlerText}` +
        `${fix.optionsText !== undefined ? `, ${fix.optionsText}` : ''});`,
    );
  }
  if (listeners.length > 0) wrapped['dom.eventListener'] = listeners.length;

  /* ---- 6. charts, maps, sockets, workers, observers, dialogs, overlays ---- */
  const definitions = SIMPLE_DISPOSE_KINDS.map((k) => DEFINITION_BY_KIND.get(k)).filter((d) => d !== undefined);
  const instances = collectStoredInstances(target, sourceFile, classText, definitions);

  for (const fix of instances.stored) {
    const method = DEFINITION_BY_KIND.get(fix.kind)?.releaseMethods[0];
    if (method === undefined) continue;
    statements.push(`${fix.storedAs}?.${method}();`);
    wrapped[fix.kind] = (wrapped[fix.kind] ?? 0) + 1;
  }

  const discardedByKind = new Map<ResourceKind, typeof instances.discarded>();
  for (const fix of instances.discarded) {
    const list = discardedByKind.get(fix.kind) ?? [];
    list.push(fix);
    discardedByKind.set(fix.kind, list);
  }
  for (const [kind, fixes] of discardedByKind) {
    const def = DEFINITION_BY_KIND.get(kind);
    const method = def?.releaseMethods[0];
    if (method === undefined) continue;
    const field = uniqueMemberName2(takenNames, `${baseFieldName(kind)}Instances`);
    fieldLines.push(
      `${memberIndent}/** Every ${def?.label ?? kind} this class creates, released in ngOnDestroy. */`,
      `${memberIndent}private readonly ${field}: Array<{ ${method}: () => void }> = [];`,
    );
    for (const fix of fixes) {
      if (fix.chainedStatement === undefined) {
        edits.push({ start: fix.call.getStart(sourceFile), end: fix.call.getStart(sourceFile), text: `this.${field}.push(` });
        edits.push({ start: fix.call.getEnd(), end: fix.call.getEnd(), text: ')' });
      } else {
        // `new X(cb).configure(...);` -> declare, configure, remember - see
        // releaseInstances.ts's DiscardedInstanceFix for why this needs
        // three edits instead of the simple wrap above.
        const stmtIndent = indentOf(source, fix.chainedStatement.getStart(sourceFile));
        const localName = uniqueMemberName2(takenNames, baseFieldName(kind));
        edits.push({ start: fix.call.getStart(sourceFile), end: fix.call.getStart(sourceFile), text: `const ${localName} = ` });
        edits.push({ start: fix.call.getEnd(), end: fix.call.getEnd(), text: `;\n${stmtIndent}${localName}` });
        edits.push({
          start: fix.chainedStatement.getEnd(),
          end: fix.chainedStatement.getEnd(),
          text: `\n${stmtIndent}this.${field}.push(${localName});`,
        });
      }
    }
    statements.push(`this.${field}.forEach((x) => x.${method}());`);
    wrapped[kind] = (wrapped[kind] ?? 0) + fixes.length;
  }

  /* ---- assemble ---- */
  // Wrapping calls into an existing, already-released collector needs no new teardown line.
  if (statements.length === 0 && Object.keys(wrapped).length === 0) {
    const reasons = Object.values(skipped);
    return {
      reason:
        reasons.length > 0
          ? reasons[0] ?? 'Nothing safe to release was found.'
          : `Nothing in ${className} is left running: everything it acquires is already managed.`,
    };
  }

  const firstMember = target.members[0];
  const lastMember = target.members[target.members.length - 1];
  if (firstMember === undefined || lastMember === undefined) {
    return { reason: 'No class members to anchor the change to.' };
  }

  if (fieldLines.length > 0) {
    edits.push({
      start: firstMember.getFullStart(),
      end: firstMember.getFullStart(),
      text: `\n${fieldLines.join('\n')}\n`,
    });
  }

  if (statements.length === 0) {
    // Only edits to existing code: the class already releases its collector.
  } else if (existing !== undefined && ts.isMethodDeclaration(existing) && existing.body !== undefined) {
    const body = existing.body;
    const firstStatement = body.statements[0];
    const bodyIndent =
      firstStatement !== undefined
        ? indentOf(source, firstStatement.getStart(sourceFile))
        : indentOf(source, existing.getStart(sourceFile)) + '  ';
    const openBrace = body.getStart(sourceFile) + 1;
    edits.push({
      start: openBrace,
      end: openBrace,
      text:
        `\n${bodyIndent}// Added by memory-agent: release what this class started.` +
        statements.map((s) => `\n${bodyIndent}${s}`).join(''),
    });
  } else {
    const angularEdit = ensureNamedImport(angularImport, 'OnDestroy');
    if (angularEdit !== undefined) edits.push(angularEdit);
    const implementsEdit = ensureImplements(target, sourceFile);
    if (implementsEdit !== undefined) edits.push(implementsEdit);

    const methodIndent = indentOf(source, lastMember.getStart(sourceFile));
    const bodyIndent = methodIndent + '  ';
    edits.push({
      start: lastMember.getEnd(),
      end: lastMember.getEnd(),
      text:
        `\n\n${methodIndent}/** Added by memory-agent: release what this class started. */\n` +
        `${methodIndent}ngOnDestroy(): void {\n` +
        statements.map((s) => `${bodyIndent}${s}\n`).join('') +
        `${methodIndent}}`,
    });
  }

  const newContent = applyEdits(
    source,
    eol === '\n' ? edits : edits.map((e) => ({ ...e, text: e.text.split('\n').join(eol) })),
  );

  const check = ts.createSourceFile(fileName, newContent, ts.ScriptTarget.Latest, true);
  const errors = (check as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  if (errors.length > 0) {
    return {
      reason:
        'The generated file did not parse cleanly, so it has been discarded rather than ' +
        'offered. This is a bug in the fixer, not in your code.',
    };
  }

  return { newContent, extendedExisting: existing !== undefined, notes, wrapped, skipped };
}

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/** Member names can contain `$` (destroy$), which is a regex anchor. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueMemberName2(taken: Set<string>, preferred: string): string {
  let name = preferred;
  for (let i = 2; taken.has(name) && i < 50; i++) name = `${preferred}${i}`;
  taken.add(name);
  return name;
}

function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** 'chart.highcharts' -> 'highcharts', 'net.webSocket' -> 'webSocket'. */
function baseFieldName(kind: ResourceKind): string {
  return kind.split('.')[1] ?? kind;
}

function applyTimerFixes(
  result: TimerCollectorResult,
  fieldBase: string,
  clearName: string,
  memberIndent: string,
  taken: Set<string>,
  sourceFile: ts.SourceFile,
  edits: Edit[],
  fieldLines: string[],
  statements: string[],
): void {
  if (result.discarded.length > 0) {
    const field = uniqueMemberName2(taken, fieldBase);
    fieldLines.push(
      `${memberIndent}/** Every ${clearName === 'clearTimeout' ? 'setTimeout' : 'requestAnimationFrame'} handle this class starts, released in ngOnDestroy. */`,
      `${memberIndent}private readonly ${field}: ReturnType<typeof ${clearName === 'clearTimeout' ? 'setTimeout' : 'requestAnimationFrame'}>[] = [];`,
    );
    for (const call of result.discarded) {
      edits.push({ start: call.getStart(sourceFile), end: call.getStart(sourceFile), text: `this.${field}.push(` });
      edits.push({ start: call.getEnd(), end: call.getEnd(), text: ')' });
    }
    statements.push(`this.${field}.forEach((id) => ${clearName}(id));`);
  }
  for (const property of result.stored) statements.push(`${clearName}(this.${property});`);
}

/* ------------------------------------------------------------------ */
/* setInterval - unchanged from the original single-kind generator     */
/* ------------------------------------------------------------------ */

/**
 * Find the setInterval calls nothing ever clears.
 *
 *   setInterval(...);             discarded - the handle is kept for it
 *   this.x = setInterval(...);    stored    - cleared, unless already cleared
 *
 * Arrow functions are fine (they keep the component's `this`); a function
 * expression is not, and neither is a handle kept in a local variable that
 * ngOnDestroy can never reach.
 */
function collectIntervals(
  target: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  classText: string,
): { discarded: ts.CallExpression[]; stored: string[] } | AddOnDestroyFailure {
  const discarded: ts.CallExpression[] = [];
  const stored = new Set<string>();
  let refusal: AddOnDestroyFailure | undefined;

  const isSetInterval = (node: ts.CallExpression): boolean => {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) return callee.text === 'setInterval';
    return (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'setInterval' &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === 'window'
    );
  };

  const walk = (node: ts.Node, rebindsThis: boolean): void => {
    if (refusal !== undefined) return;

    if (ts.isCallExpression(node) && isSetInterval(node)) {
      const parent = node.parent;
      if (ts.isExpressionStatement(parent)) {
        if (rebindsThis) {
          refusal = {
            reason:
              'A setInterval sits inside a function expression, where `this` is not the ' +
              'component, so its handle cannot be kept on the component safely.',
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
        const cleared = new RegExp(`clearInterval\\(\\s*this\\.${property}\\s*\\)`).test(classText);
        if (!cleared && !rebindsThis) stored.add(property);
      } else if (!/clearInterval\s*\(/.test(classText)) {
        refusal = {
          reason:
            'A setInterval handle is kept somewhere ngOnDestroy cannot reach (a local ' +
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
