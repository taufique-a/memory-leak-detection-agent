/**
 * Releasing what a class starts, whether or not it already has an ngOnDestroy.
 *
 * addOnDestroy.ts only CREATES the hook, and refuses a class that already
 * has one. That leaves out the most common real leak: an ngOnDestroy that
 * exists, does some teardown, and forgets the subscriptions or the
 * setInterval added later. This covers both shapes, for the two resources
 * whose correct release is unambiguous:
 *
 *   subscriptions   collected into one Subscription, unsubscribed on destroy
 *   setInterval     handle kept, cleared on destroy
 *
 * The refusals are the same as addOnDestroy's and for the same reason: a
 * half-fixed class looks handled while the other half still leaks.
 */

import * as ts from 'typescript';

import {
  applyEdits,
  collectSubscribeCalls,
  ensureImplements,
  ensureNamedImport,
  findClass,
  findImport,
  indentOf,
  isOnDestroyMethod,
  uniqueMemberName,
  type AddOnDestroyFailure,
  type Edit,
} from './addOnDestroy';

export interface AddCleanupResult {
  newContent: string;
  wrappedSubscriptions: number;
  clearedIntervals: number;
  /** True when an existing ngOnDestroy was extended rather than created. */
  extendedExisting: boolean;
  notes: string[];
}

export function addCleanup(
  source: string,
  fileName: string,
  className: string,
): AddCleanupResult | AddOnDestroyFailure {
  const eol = (source.match(/\r\n/g) ?? []).length > (source.match(/(?<!\r)\n/g) ?? []).length
    ? '\r\n'
    : '\n';

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

  const subs = collectSubscribeCalls(target, sourceFile);
  if ('reason' in subs) return subs;

  const intervals = collectIntervals(target, sourceFile);
  if ('reason' in intervals) return intervals;

  if (subs.calls.length === 0 && intervals.discarded.length === 0 && intervals.stored.length === 0) {
    return {
      reason:
        `Nothing in ${className} is left running: every subscribe() is already stored or ` +
        'managed, and every setInterval is already cleared. The leak is something else.',
    };
  }

  const edits: Edit[] = [];
  const notes: string[] = [];
  const firstMember = target.members[0];
  const lastMember = target.members[target.members.length - 1];
  if (firstMember === undefined || lastMember === undefined) {
    return { reason: 'No class members to anchor the change to.' };
  }
  const memberIndent = indentOf(source, firstMember.getStart(sourceFile));

  /* ---- fields ---- */
  const fieldLines: string[] = [];
  const subsField = uniqueMemberName(target, 'subscriptions');
  if (subs.calls.length > 0) {
    const rxjsImport = findImport(sourceFile, 'rxjs');
    if (rxjsImport === undefined) {
      const end = angularImport.getEnd();
      edits.push({ start: end, end, text: `\nimport { Subscription } from 'rxjs';` });
    } else {
      const rxjsEdit = ensureNamedImport(rxjsImport, 'Subscription');
      if (rxjsEdit !== undefined) edits.push(rxjsEdit);
    }
    fieldLines.push(
      `${memberIndent}/** Everything this class subscribes to, released in ngOnDestroy. */`,
      `${memberIndent}private readonly ${subsField} = new Subscription();`,
    );
    for (const call of subs.calls) {
      edits.push({ start: call.getStart(sourceFile), end: call.getStart(sourceFile), text: `this.${subsField}.add(` });
      edits.push({ start: call.getEnd(), end: call.getEnd(), text: ')' });
    }
    if (subs.httpLike > 0) {
      notes.push(
        `${subs.httpLike} of these look like HTTP calls, which complete on their own. ` +
          'Adding them to the Subscription is harmless but unnecessary.',
      );
    }
  }

  const intervalsField = uniqueMemberName(target, 'intervals');
  if (intervals.discarded.length > 0) {
    fieldLines.push(
      `${memberIndent}/** Every setInterval this class starts, cleared in ngOnDestroy. */`,
      `${memberIndent}private readonly ${intervalsField}: ReturnType<typeof setInterval>[] = [];`,
    );
    for (const call of intervals.discarded) {
      edits.push({
        start: call.getStart(sourceFile),
        end: call.getStart(sourceFile),
        text: `this.${intervalsField}.push(`,
      });
      edits.push({ start: call.getEnd(), end: call.getEnd(), text: ')' });
    }
  }

  if (fieldLines.length > 0) {
    edits.push({
      start: firstMember.getFullStart(),
      end: firstMember.getFullStart(),
      text: `\n${fieldLines.join('\n')}\n`,
    });
  }

  /* ---- the teardown statements ---- */
  const statements: string[] = [];
  if (subs.calls.length > 0) statements.push(`this.${subsField}.unsubscribe();`);
  if (intervals.discarded.length > 0) {
    statements.push(`this.${intervalsField}.forEach((id) => clearInterval(id));`);
  }
  for (const property of intervals.stored) statements.push(`clearInterval(this.${property});`);

  if (existing !== undefined && ts.isMethodDeclaration(existing) && existing.body !== undefined) {
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

  return {
    newContent,
    wrappedSubscriptions: subs.calls.length,
    clearedIntervals: intervals.discarded.length + intervals.stored.length,
    extendedExisting: existing !== undefined,
    notes,
  };
}

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
): { discarded: ts.CallExpression[]; stored: string[] } | AddOnDestroyFailure {
  const classText = target.getText(sourceFile);
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

    const rebinds =
      rebindsThis || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
    ts.forEachChild(node, (child) => walk(child, rebinds));
  };

  for (const member of target.members) walk(member, false);
  if (refusal !== undefined) return refusal;
  return { discarded, stored: [...stored] };
}
