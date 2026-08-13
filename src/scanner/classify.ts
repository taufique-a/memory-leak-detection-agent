/**
 * Turns an AST into a list of Angular classes.
 *
 * WHY DECORATORS AND NOT FILENAMES
 * --------------------------------
 * Measured on the real IOSense project:
 *
 *   files named *.component.ts   2976
 *   classes with @Component      2985     <- 9 more
 *   files named *.service.ts      153
 *   classes with @Injectable      181     <- 28 more
 *
 * A filename-based scanner silently misses those. In leak hunting a missed
 * component is a component we never check, so we read the decorator - the
 * thing Angular itself uses to decide what a class is.
 */

import * as ts from 'typescript';

import type { AngularClass, AngularClassKind, LifecycleHook } from '../types/project';
import { LIFECYCLE_HOOKS } from '../types/project';
import { decoratorArgument, decoratorName, lineOf, readLiteralProperty } from './parse';

/** Decorator name -> the kind we record. */
const DECORATOR_KINDS: Readonly<Record<string, AngularClassKind>> = {
  Component: 'Component',
  Directive: 'Directive',
  Injectable: 'Injectable',
  NgModule: 'NgModule',
  Pipe: 'Pipe',
};

const LIFECYCLE_HOOK_SET = new Set<string>(LIFECYCLE_HOOKS);

/**
 * Find every Angular-decorated class in a parsed file.
 *
 * Walks the whole tree rather than only top-level statements, because
 * classes can be nested inside namespaces or conditional blocks.
 */
export function classifyAngularClasses(
  sourceFile: ts.SourceFile,
  relativePath: string,
): AngularClass[] {
  const results: AngularClass[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node)) {
      const angularClass = describeClass(node, sourceFile, relativePath);
      if (angularClass) results.push(angularClass);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return results;
}

function describeClass(
  node: ts.ClassDeclaration,
  sourceFile: ts.SourceFile,
  relativePath: string,
): AngularClass | undefined {
  // `canHaveDecorators` is the modern guard. Reading `node.decorators`
  // directly was deprecated in TypeScript 4.8 and removed in 5.0.
  if (!ts.canHaveDecorators(node)) return undefined;
  const decorators = ts.getDecorators(node);
  if (!decorators || decorators.length === 0) return undefined;

  // Find the Angular decorator, ignoring any others the class may carry.
  let kind: AngularClassKind | undefined;
  let angularDecorator: ts.Decorator | undefined;

  for (const decorator of decorators) {
    const name = decoratorName(decorator);
    if (name === undefined) continue;
    const matched = DECORATOR_KINDS[name];
    if (matched) {
      kind = matched;
      angularDecorator = decorator;
      break;
    }
  }

  if (!kind || !angularDecorator) return undefined;

  // An anonymous `export default class` has no name. Record it rather than
  // dropping it, so counts stay honest.
  const className = node.name?.text ?? '(anonymous)';

  /* ---- decorator metadata ---- */
  const arg = decoratorArgument(angularDecorator);
  let selector: string | undefined;
  let providedIn: string | undefined;
  let standalone = false;

  if (arg) {
    const rawSelector = readLiteralProperty(arg, 'selector');
    if (typeof rawSelector === 'string') selector = rawSelector;

    const rawProvidedIn = readLiteralProperty(arg, 'providedIn');
    if (typeof rawProvidedIn === 'string') providedIn = rawProvidedIn;

    standalone = readLiteralProperty(arg, 'standalone') === true;
  }

  /* ---- implements clause ---- */
  const implementsInterfaces: string[] = [];
  for (const heritage of node.heritageClauses ?? []) {
    if (heritage.token !== ts.SyntaxKind.ImplementsKeyword) continue;
    for (const type of heritage.types) {
      const expr = type.expression;
      if (ts.isIdentifier(expr)) implementsInterfaces.push(expr.text);
      else if (ts.isPropertyAccessExpression(expr)) implementsInterfaces.push(expr.name.text);
    }
  }

  /* ---- methods ---- */
  const methods: string[] = [];
  for (const member of node.members) {
    if (!ts.isMethodDeclaration(member)) continue;
    const name = member.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) methods.push(name.text);
  }

  const lifecycleHooks = methods.filter((m): m is LifecycleHook =>
    LIFECYCLE_HOOK_SET.has(m),
  );

  /**
   * We record these two facts SEPARATELY on purpose.
   *
   * `implements OnDestroy` without the method is a real (and common) bug -
   * TypeScript catches it, but only if strict settings are on. Conversely a
   * class can define ngOnDestroy without declaring the interface, which is
   * perfectly valid and Angular still calls it. Collapsing both into one
   * boolean would lose information Phase 4 needs.
   */
  const hasOnDestroyMethod = methods.includes('ngOnDestroy');
  const declaresOnDestroyInterface = implementsInterfaces.includes('OnDestroy');

  return {
    className,
    kind,
    file: relativePath,
    line: lineOf(sourceFile, node),
    ...(selector !== undefined ? { selector } : {}),
    standalone,
    ...(providedIn !== undefined ? { providedIn } : {}),
    implementsInterfaces,
    methods,
    lifecycleHooks,
    hasOnDestroyMethod,
    declaresOnDestroyInterface,
  };
}
