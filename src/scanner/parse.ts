/**
 * Shared TypeScript AST parsing.
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * Parsing the IOSense app costs about 4 seconds and produces roughly
 * 7 million AST nodes. Phase 2 (scanning), Phase 3 (AST analysis) and
 * Phase 4 (risk detection) all need that same tree. Parsing three times
 * would be three times the cost for identical data, so everything funnels
 * through here.
 *
 * WHY createSourceFile AND NOT createProgram
 * ------------------------------------------
 * `ts.createProgram` builds a full type-checked program: it resolves every
 * import, loads all of node_modules' .d.ts files, and runs the type checker.
 * That gives you semantic information (what type is this expression?) but
 * costs minutes and gigabytes on a project this size.
 *
 * `ts.createSourceFile` only parses SYNTAX - one file, no imports resolved,
 * no type checking. It is dramatically faster, and it is enough to answer
 * the questions we actually ask: "is setInterval called here?", "does this
 * class have an ngOnDestroy?", "what does it subscribe to?".
 *
 * If a later phase genuinely needs type information, it can build a Program
 * for a small subset of files rather than the whole app.
 */

import * as fs from 'node:fs';

import * as ts from 'typescript';

/** A file that has been read and parsed into an AST. */
export interface ParsedSourceFile {
  absolutePath: string;
  /** Project-relative, forward slashes. */
  relativePath: string;
  /** Raw file contents. Kept because node.getText() needs it. */
  text: string;
  /** The parsed syntax tree. */
  sourceFile: ts.SourceFile;
  bytes: number;
  lines: number;
}

export interface ParseFailure {
  absolutePath: string;
  relativePath: string;
  reason: string;
}

/**
 * Read and parse one file.
 *
 * `setParentNodes: true` (the 4th argument) makes every node carry a
 * `.parent` pointer. That costs a little memory but is essential for leak
 * analysis: when we find a `setInterval` call we need to walk UP the tree
 * to discover which method and which class it lives in.
 */
export function parseSourceFile(
  absolutePath: string,
  relativePath: string,
): ParsedSourceFile | ParseFailure {
  let text: string;
  try {
    text = fs.readFileSync(absolutePath, 'utf8');
  } catch (err) {
    return {
      absolutePath,
      relativePath,
      reason: `could not read file: ${(err as Error).message}`,
    };
  }

  try {
    const sourceFile = ts.createSourceFile(
      absolutePath,
      text,
      ts.ScriptTarget.ES2022,
      /* setParentNodes */ true,
      // .ts vs .tsx changes how "<" is parsed. Angular projects are .ts,
      // but being explicit avoids a surprise if a .tsx ever appears.
      absolutePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    return {
      absolutePath,
      relativePath,
      text,
      sourceFile,
      bytes: Buffer.byteLength(text, 'utf8'),
      lines: countLines(text),
    };
  } catch (err) {
    return {
      absolutePath,
      relativePath,
      reason: `could not parse: ${(err as Error).message}`,
    };
  }
}

/** Type guard distinguishing a successful parse from a failure. */
export function isParseFailure(
  result: ParsedSourceFile | ParseFailure,
): result is ParseFailure {
  return (result as ParseFailure).reason !== undefined;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) n++;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Small AST helpers, reused across phases                             */
/* ------------------------------------------------------------------ */

/** 1-based line number of a node. Editors count from 1; the API from 0. */
export function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * Every module specifier this file imports from.
 *
 * Covers `import x from 'y'` and `export * from 'y'`, but deliberately not
 * dynamic `import('y')` - those are lazy boundaries and get handled
 * separately, because their meaning for leak analysis is different.
 */
export function collectImportSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        specifiers.add(moduleSpecifier.text);
      }
    }
  }

  return [...specifiers].sort();
}

/**
 * Read a property off an object literal, when its value is a simple
 * literal we can trust.
 *
 * We deliberately return undefined for computed values. If a decorator says
 * `selector: SELECTORS.dashboard`, we do NOT guess - reporting an unknown
 * selector is honest, inventing one is not.
 */
export function readLiteralProperty(
  obj: ts.ObjectLiteralExpression,
  propertyName: string,
): string | boolean | undefined {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;

    const name = prop.name;
    const key = ts.isIdentifier(name)
      ? name.text
      : ts.isStringLiteral(name)
        ? name.text
        : undefined;
    if (key !== propertyName) continue;

    const value = prop.initializer;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      return value.text;
    }
    if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
    // Anything else (identifier, call, spread) is not statically known.
    return undefined;
  }
  return undefined;
}

/** The first argument of a decorator, when it is an object literal. */
export function decoratorArgument(
  decorator: ts.Decorator,
): ts.ObjectLiteralExpression | undefined {
  const expr = decorator.expression;
  if (!ts.isCallExpression(expr)) return undefined;
  const first = expr.arguments[0];
  if (first && ts.isObjectLiteralExpression(first)) return first;
  return undefined;
}

/** The decorator's name, e.g. "Component" from `@Component({...})`. */
export function decoratorName(decorator: ts.Decorator): string | undefined {
  const expr = decorator.expression;
  const target = ts.isCallExpression(expr) ? expr.expression : expr;
  if (ts.isIdentifier(target)) return target.text;
  // Handles `@core.Component(...)`
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}
