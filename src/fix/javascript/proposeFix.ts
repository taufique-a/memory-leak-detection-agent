/**
 * Fix proposal for plain JavaScript: release one resource in a class's
 * existing teardown method.
 *
 * WHY THIS IS NARROWER THAN THE REACT ONE
 * -----------------------------------------
 * Plain JavaScript has no framework that promises to call a cleanup hook.
 * Adding a brand-new `destroy()` method changes nothing unless whatever
 * removes the object also calls it - and that caller is application logic
 * this generator cannot see. So a change is generated only when a teardown
 * site already exists and is already called by something real:
 *
 *   an existing method named destroy / dispose / teardown / unmount /
 *   cleanup / detach / disconnectedCallback - the cleanup line is appended
 *   to it; or
 *
 *   a custom element (extends HTMLElement) that starts the resource in
 *   connectedCallback and has no disconnectedCallback - the BROWSER calls
 *   disconnectedCallback when the element leaves the document, so adding
 *   one is a complete, deterministic fix.
 *
 * Everything else - a function (no instance to hold a handle), two
 * resources, a local handle, no teardown site - is refused with the reason.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

import type { GenericCorrelatedFinding } from '../../core/correlation/correlateGeneric';
import type { AppEntity } from '../../core/framework/types';
import { isRuntimeEstablished } from '../../types/index';
import { buildUnifiedDiff, type ProposedFix } from '../propose';
import {
  cleanupLineFor,
  countAcquireCalls,
  findClass,
  findSingleInstanceResource,
  indentOf,
  methodNamed,
  scriptKindFor,
  usesSemicolons,
} from '../shared/tsShapes';

export const TEARDOWN_METHOD_NAMES = [
  'destroy',
  'dispose',
  'teardown',
  'unmount',
  'cleanup',
  'detach',
  'disconnectedCallback',
] as const;

export interface PlainJsFixOptions {
  projectRoot: string;
}

function manualOnly(finding: GenericCorrelatedFinding, file: string, entity: string, reason: string): ProposedFix {
  return {
    findingId: finding.constructorName,
    file,
    title: `Release the resource ${entity} holds`,
    rationale: reason,
    safety: 'manual-only',
    functionalRisks: ['Not generated - a person needs to decide where this object is torn down.'],
    verificationPlan: [
      'After adding cleanup by hand, run the memory check again and confirm this constructor stops growing.',
    ],
    manualInstructions: [reason],
  };
}

export function proposePlainJsFix(
  finding: GenericCorrelatedFinding,
  entity: AppEntity,
  options: PlainJsFixOptions,
): ProposedFix | undefined {
  const relativeFile = entity.file;
  const absolute = path.join(options.projectRoot, relativeFile);

  if (!isRuntimeEstablished(finding.confidence)) {
    return manualOnly(finding, relativeFile, entity.name, 'Confidence is below HIGH, so no change is generated.');
  }
  if (entity.frameworkKind !== 'class') {
    return manualOnly(
      finding,
      relativeFile,
      entity.name,
      `${entity.name} is a function, not a class - there is no instance to keep a handle on and no ` +
        'teardown method to put cleanup in.',
    );
  }
  if (!fs.existsSync(absolute)) return undefined;

  const text = fs.readFileSync(absolute, 'utf8');
  const sourceFile = ts.createSourceFile(absolute, text, ts.ScriptTarget.ES2022, true, scriptKindFor(absolute));
  const cls = findClass(sourceFile, entity.name);
  if (cls === undefined) {
    return manualOnly(finding, relativeFile, entity.name, `${entity.name} could not be found in this file as currently written.`);
  }

  const teardownName = TEARDOWN_METHOD_NAMES.find((n) => methodNamed(cls, n, sourceFile)?.body !== undefined);
  const teardown = teardownName !== undefined ? methodNamed(cls, teardownName, sourceFile) : undefined;

  // Exactly one acquire-shaped call in the whole class, outside teardown.
  const acquiring = cls.members.filter((m) => m !== teardown && countAcquireCalls(m) > 0);
  const total = acquiring.reduce((sum, m) => sum + countAcquireCalls(m), 0);
  if (total !== 1 || acquiring.length !== 1) {
    return manualOnly(
      finding,
      relativeFile,
      entity.name,
      total === 0
        ? `${entity.name} starts no recognised resource (timer or listener) - the growth comes from somewhere this generator cannot read.`
        : `${entity.name} starts ${total} resources; clearing only one would be a partial, misleading fix.`,
    );
  }

  const owner = acquiring[0] as ts.ClassElement;
  const body =
    (ts.isMethodDeclaration(owner) || ts.isConstructorDeclaration(owner)) && owner.body !== undefined
      ? owner.body
      : undefined;
  const plan = body !== undefined ? findSingleInstanceResource(body, sourceFile) : undefined;
  if (plan === undefined) {
    return manualOnly(
      finding,
      relativeFile,
      entity.name,
      'The resource is not started in a recognised shape (this.x = setInterval(...), or addEventListener with a this.<handler>).',
    );
  }
  if (plan.kind === 'local-handle') {
    return manualOnly(
      finding,
      relativeFile,
      entity.name,
      'The timer handle is kept in a local variable, which a teardown method cannot reach. Storing it on the instance changes existing code, so that is left for a person.',
    );
  }

  const semi = body !== undefined && usesSemicolons(body, sourceFile) ? ';' : '';
  const cleanupLine = cleanupLineFor(plan, semi);

  let newContent: string;
  let where: string;
  if (teardown?.body !== undefined) {
    const already = teardown.body.getText(sourceFile).replace(/\s+/g, '');
    if (already.includes(cleanupLine.replace(/;$/, '').replace(/\s+/g, ''))) {
      return manualOnly(
        finding,
        relativeFile,
        entity.name,
        `${teardownName}() already releases this resource, yet it still grows - either ${teardownName}() is never called, or something else holds it. That needs a person.`,
      );
    }
    const indent =
      teardown.body.statements.length > 0
        ? indentOf(sourceFile, teardown.body.statements[teardown.body.statements.length - 1] as ts.Node)
        : `${indentOf(sourceFile, teardown)}  `;
    const insertPos = teardown.body.getEnd() - 1;
    const before = text.slice(0, insertPos);
    const needsNewline = !/\n[ \t]*$/.test(before);
    newContent =
      before.replace(/[ \t]*$/, '') +
      (needsNewline ? '\n' : '') +
      `${indent}${cleanupLine}\n${indentOf(sourceFile, teardown)}` +
      text.slice(insertPos);
    where = `its existing ${teardownName}() method`;
  } else {
    const isCustomElement = cls.heritageClauses?.some((h) => /HTMLElement/.test(h.getText(sourceFile))) === true;
    const startsOnConnect = ts.isMethodDeclaration(owner) && owner.name.getText(sourceFile) === 'connectedCallback';
    if (!isCustomElement || !startsOnConnect) {
      return manualOnly(
        finding,
        relativeFile,
        entity.name,
        `${entity.name} has no teardown method (${TEARDOWN_METHOD_NAMES.join(', ')}). Adding one would ` +
          'change nothing unless the code that removes this object also calls it - and that caller is yours to decide.',
      );
    }
    const memberIndent = indentOf(sourceFile, owner);
    const insertPos = owner.getEnd();
    newContent =
      text.slice(0, insertPos) +
      `\n\n${memberIndent}disconnectedCallback() {\n${memberIndent}  ${cleanupLine}\n${memberIndent}}` +
      text.slice(insertPos);
    where = 'a new disconnectedCallback(), which the browser calls when the element leaves the page';
  }

  return {
    findingId: finding.constructorName,
    file: relativeFile,
    title: `Release the ${plan.kind === 'timer' ? 'timer' : 'listener'} in ${entity.name}`,
    rationale:
      `${entity.name} ${plan.kind === 'timer' ? 'starts a timer' : 'adds an event listener'} and never releases it, ` +
      `so every discarded instance stays reachable. Adding \`${cleanupLine.replace(/;$/, '')}\` in ${where} releases it.`,
    safety: 'additive',
    newContent,
    diff: buildUnifiedDiff(relativeFile, text, newContent),
    functionalRisks: [
      teardown !== undefined
        ? `Runs only when ${teardownName}() is called - if nothing calls it, the leak stays, and the re-measurement will say so.`
        : 'Runs only when the element is removed from the page.',
    ],
    verificationPlan: [
      `Rebuild, run the project's tests, then repeat the same memory check and confirm ${finding.constructorName} no longer grows.`,
    ],
  };
}
