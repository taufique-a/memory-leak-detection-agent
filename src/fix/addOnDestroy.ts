/**
 * Adding an ngOnDestroy that unsubscribes.
 *
 * WHY THIS IS SEPARATE, AND BIGGER THAN THE OTHER GENERATOR
 * --------------------------------------------------------
 * The existing generator appends two statements to an ngOnDestroy that
 * already exists. It is purely additive and fits in forty lines.
 *
 * This one is what people actually need. Measured against IOSense: 30
 * components have a broken destroy$, and NONE of them has an ngOnDestroy
 * to append to. Every single one came back as "manual fix required", which
 * is a correct answer and a useless one.
 *
 * Creating the hook properly means four coordinated edits:
 *
 *   1. import OnDestroy from @angular/core
 *   2. import Subscription from rxjs
 *   3. add `implements OnDestroy` to the class
 *   4. add the field, wrap each subscribe, add the method
 *
 * Get any one of them wrong and the file does not compile. So this works
 * from the AST rather than from line numbers, applies its edits back to
 * front so earlier offsets stay valid, and RE-PARSES the result before
 * handing it over - a transform that produces a syntax error must never
 * reach the approval step, because a diff that looks right is exactly how
 * a bad edit gets approved.
 *
 * WHAT IT REFUSES
 * ---------------
 * Deliberately narrow. It bails rather than guess when:
 *
 *   - the class already has an ngOnDestroy (the other generator's job)
 *   - a subscribe result is already stored somewhere, so something is
 *     already tracking it and we would be double-handling
 *   - a subscribe sits inside a nested function, where `this` may not be
 *     the component at all
 *   - the file has no @angular/core import, so it is not a component
 *   - there is no class body to put anything in
 */

import * as ts from 'typescript';

export interface AddOnDestroyResult {
  /** The file after the change. */
  newContent: string;
  /** How many subscriptions were wrapped. */
  wrapped: number;
  /** Things the reviewer needs to know about THIS change. */
  notes: string[];
}

export interface AddOnDestroyFailure {
  /** Why no change was generated. Shown to the user verbatim. */
  reason: string;
}

export function isFailure(
  value: AddOnDestroyResult | AddOnDestroyFailure,
): value is AddOnDestroyFailure {
  return 'reason' in value;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/**
 * Generate an ngOnDestroy that unsubscribes everything this class starts.
 *
 * `className` picks the class when a file holds more than one.
 */
export function addOnDestroyWithUnsubscribe(
  source: string,
  fileName: string,
  className: string,
): AddOnDestroyResult | AddOnDestroyFailure {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  const target = findClass(sourceFile, className);
  if (target === undefined) {
    return { reason: `Could not find class ${className} in this file.` };
  }
  if (target.members.some(isOnDestroyMethod)) {
    return {
      reason: `${className} already has an ngOnDestroy. This generator only creates one.`,
    };
  }
  if (target.members.length === 0) {
    return { reason: `${className} has an empty body; there is nothing to clean up.` };
  }

  const angularImport = findImport(sourceFile, '@angular/core');
  if (angularImport === undefined) {
    return {
      reason: 'This file does not import from @angular/core, so it is not an Angular class.',
    };
  }

  /* ---- which subscriptions are ours to manage? ---- */
  const collected = collectSubscribeCalls(target, sourceFile);
  if ('reason' in collected) return collected;
  if (collected.calls.length === 0) {
    return {
      reason:
        `No unmanaged subscribe() call was found in ${className}. Either they are all ` +
        'already stored somewhere, or the leak is something other than a subscription.',
    };
  }

  const notes: string[] = [];
  const edits: Edit[] = [];

  /* ---- 1 & 2. imports ---- */
  const angularEdit = ensureNamedImport(angularImport, 'OnDestroy');
  if (angularEdit !== undefined) edits.push(angularEdit);

  const fieldName = uniqueMemberName(target, 'subscriptions');
  const rxjsImport = findImport(sourceFile, 'rxjs');
  if (rxjsImport === undefined) {
    // No rxjs import at all: add one directly after the Angular import, so
    // it lands with the other framework imports rather than at the top.
    const end = angularImport.getEnd();
    edits.push({
      start: end,
      end,
      text: `\nimport { Subscription } from 'rxjs';`,
    });
  } else {
    const rxjsEdit = ensureNamedImport(rxjsImport, 'Subscription');
    if (rxjsEdit !== undefined) edits.push(rxjsEdit);
  }

  /* ---- 3. implements OnDestroy ---- */
  const implementsEdit = ensureImplements(target, sourceFile);
  if (implementsEdit !== undefined) edits.push(implementsEdit);

  /* ---- 4a. the field ---- */
  const firstMember = target.members[0];
  if (firstMember === undefined) return { reason: 'No class members to anchor the field to.' };
  const indent = indentOf(source, firstMember.getStart(sourceFile));
  edits.push({
    start: firstMember.getFullStart(),
    end: firstMember.getFullStart(),
    text:
      `\n${indent}/** Everything this component subscribes to, released in ngOnDestroy. */\n` +
      `${indent}private readonly ${fieldName} = new Subscription();\n`,
  });

  /* ---- 4b. wrap each subscribe ---- */
  for (const call of collected.calls) {
    edits.push({
      start: call.getStart(sourceFile),
      end: call.getStart(sourceFile),
      text: `this.${fieldName}.add(`,
    });
    edits.push({ start: call.getEnd(), end: call.getEnd(), text: ')' });
  }

  /* ---- 4c. the method ---- */
  const lastMember = target.members[target.members.length - 1];
  if (lastMember === undefined) return { reason: 'No class members to anchor the method to.' };
  const methodIndent = indentOf(source, lastMember.getStart(sourceFile));
  const bodyIndent = methodIndent + '  ';
  edits.push({
    start: lastMember.getEnd(),
    end: lastMember.getEnd(),
    text:
      `\n\n${methodIndent}/**\n` +
      `${methodIndent} * Added by memory-agent.\n` +
      `${methodIndent} *\n` +
      `${methodIndent} * ${collected.calls.length} subscription(s) here were never released, so every\n` +
      `${methodIndent} * visit to this page left the previous ones still running.\n` +
      `${methodIndent} */\n` +
      `${methodIndent}ngOnDestroy(): void {\n` +
      `${bodyIndent}this.${fieldName}.unsubscribe();\n` +
      `${methodIndent}}`,
  });

  const newContent = applyEdits(source, edits);

  /**
   * Re-parse before handing this over.
   *
   * A transform that produces a syntax error must never reach the approval
   * step: the diff would look fine and the file would not compile.
   */
  const check = ts.createSourceFile(fileName, newContent, ts.ScriptTarget.Latest, true);
  const errors = (check as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  if (errors.length > 0) {
    return {
      reason:
        'The generated file did not parse cleanly, so it has been discarded rather than ' +
        'offered. This is a bug in the fixer, not in your code.',
    };
  }

  if (collected.httpLike > 0) {
    notes.push(
      `${collected.httpLike} of these look like HTTP calls, which complete on their own. ` +
        'Adding them to the Subscription is harmless but unnecessary.',
    );
  }

  return { newContent, wrapped: collected.calls.length, notes };
}

/* ------------------------------------------------------------------ */
/* Finding things                                                      */
/* ------------------------------------------------------------------ */

function findClass(sourceFile: ts.SourceFile, className: string): ts.ClassDeclaration | undefined {
  let found: ts.ClassDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) found = node;
    if (found === undefined) ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function isOnDestroyMethod(member: ts.ClassElement): boolean {
  return (
    (ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) &&
    member.name !== undefined &&
    ts.isIdentifier(member.name) &&
    member.name.text === 'ngOnDestroy'
  );
}

function findImport(sourceFile: ts.SourceFile, moduleName: string): ts.ImportDeclaration | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text === moduleName) return statement;
  }
  return undefined;
}

/**
 * Collect the subscribe() calls this class should be managing.
 *
 * Returns a refusal rather than a partial answer when it finds one it
 * cannot reason about - half-fixing a component is worse than not touching
 * it, because the remaining half still leaks and now looks handled.
 */
function collectSubscribeCalls(
  target: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
): { calls: ts.CallExpression[]; httpLike: number } | AddOnDestroyFailure {
  const calls: ts.CallExpression[] = [];
  let httpLike = 0;

  const walk = (node: ts.Node, insideNestedFunction: boolean): AddOnDestroyFailure | undefined => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'subscribe'
    ) {
      if (insideNestedFunction) {
        return {
          reason:
            'A subscribe() sits inside a nested callback, where `this` may not be the ' +
            'component. Adding cleanup around it unattended is not safe.',
        };
      }

      const parent = node.parent;
      // Already stored, returned, or passed somewhere: something else is
      // managing it and wrapping would double-handle.
      const alreadyManaged =
        (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) ||
        ts.isVariableDeclaration(parent) ||
        ts.isReturnStatement(parent) ||
        ts.isPropertyAssignment(parent) ||
        (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression));

      if (!alreadyManaged) {
        calls.push(node);
        const text = node.expression.expression.getText(sourceFile);
        if (/\bhttp\b|HttpClient|\.get\(|\.post\(/i.test(text)) httpLike++;
      }

      /**
       * Keep going INTO the callback.
       *
       * Returning here was a real bug: a subscribe inside another
       * subscribe's handler was never visited, so the class looked fully
       * handled while the inner one still leaked - the worst possible
       * outcome, because the fix makes it look dealt with.
       *
       * Descending marks everything below as nested, which is what makes
       * the whole class get refused rather than half-fixed.
       */
      let nestedFailure: AddOnDestroyFailure | undefined;
      ts.forEachChild(node, (child) => {
        if (nestedFailure !== undefined) return;
        nestedFailure = walk(child, insideNestedFunction);
      });
      return nestedFailure;
    }

    // Arrow functions and function expressions rebind or capture `this`
    // differently; anything below one is out of scope.
    const nested =
      insideNestedFunction ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node);

    let failure: AddOnDestroyFailure | undefined;
    ts.forEachChild(node, (child) => {
      if (failure !== undefined) return;
      failure = walk(child, nested);
    });
    return failure;
  };

  for (const member of target.members) {
    // A method body is fine; the members themselves are not "nested".
    const failure = walk(member, false);
    if (failure !== undefined) return failure;
  }

  return { calls, httpLike };
}

/* ------------------------------------------------------------------ */
/* Edits                                                               */
/* ------------------------------------------------------------------ */

/** Add a name to an existing named import, or nothing if already there. */
function ensureNamedImport(declaration: ts.ImportDeclaration, name: string): Edit | undefined {
  const bindings = declaration.importClause?.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return undefined;

  for (const element of bindings.elements) {
    if (element.name.text === name) return undefined;
  }

  const last = bindings.elements[bindings.elements.length - 1];
  if (last === undefined) return undefined;
  return { start: last.getEnd(), end: last.getEnd(), text: `, ${name}` };
}

/** Add `implements OnDestroy`, or extend an existing implements clause. */
function ensureImplements(
  target: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
): Edit | undefined {
  const clause = target.heritageClauses?.find((c) => c.token === ts.SyntaxKind.ImplementsKeyword);

  if (clause === undefined) {
    // Goes after the name and any type parameters, before the opening brace.
    const anchor = target.heritageClauses?.[target.heritageClauses.length - 1] ?? target.name;
    if (anchor === undefined) return undefined;
    return { start: anchor.getEnd(), end: anchor.getEnd(), text: ' implements OnDestroy' };
  }

  for (const type of clause.types) {
    if (type.expression.getText(sourceFile) === 'OnDestroy') return undefined;
  }
  const last = clause.types[clause.types.length - 1];
  if (last === undefined) return undefined;
  return { start: last.getEnd(), end: last.getEnd(), text: ', OnDestroy' };
}

/** A member name not already taken, so we cannot shadow anything. */
function uniqueMemberName(target: ts.ClassDeclaration, preferred: string): string {
  const taken = new Set<string>();
  for (const member of target.members) {
    if (member.name !== undefined && ts.isIdentifier(member.name)) taken.add(member.name.text);
  }
  if (!taken.has(preferred)) return preferred;
  for (let i = 2; i < 50; i++) {
    const candidate = `${preferred}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${preferred}_memoryAgent`;
}

/** The leading whitespace of the line an offset sits on. */
function indentOf(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, offset));
  return match?.[0] ?? '  ';
}

/**
 * Apply edits back to front.
 *
 * Every offset was computed against the ORIGINAL text, so applying from the
 * end means earlier ones are still valid when their turn comes.
 */
function applyEdits(source: string, edits: Edit[]): string {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  for (const edit of ordered) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}
