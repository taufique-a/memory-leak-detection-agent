/**
 * Finding classes and functions in a plain-JavaScript project.
 *
 * WHY NOT REUSE THE ANGULAR SCANNER'S PARSER
 * -------------------------------------------
 * `scanner/parse.ts` hard-codes TS/TSX script kinds because every file an
 * Angular project hands it really is one of those two. A plain-JS project
 * can hand us `.js`, `.mjs`, `.cjs` and `.jsx` too, and `.jsx` in particular
 * needs `ScriptKind.JSX` or the parser rejects ordinary JSX syntax. So this
 * is its own small parse step, not a fork of that one.
 *
 * WHAT THIS DOES AND DOES NOT ESTABLISH
 * ----------------------------------------
 * It finds `class Name`, `function Name`, and `const Name = <function or
 * class expression>` - the shapes a heap snapshot's constructor name can
 * actually come from. It does not infer a role (there is no framework to
 * say "this one is a view"), does not read a route table (there is none),
 * and does not decide that a name is "the" owner of anything - two
 * declarations sharing a name come back as two candidates, exactly like
 * Angular's `OverviewComponent` case, never resolved by picking one.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

import { toRelativePosix, walkDirectory } from '../../scanner/walk';

export interface JsDeclaration {
  name: string;
  /** Project-relative, forward slashes. */
  file: string;
  /** 1-based. */
  line: number;
  kind: 'class' | 'function';
}

export interface JsProjectScan {
  /** Every declaration, keyed by its exact name. */
  byName: Map<string, JsDeclaration[]>;
  /** A crude per-file count of resource-acquiring calls - ordering only. */
  resourceHintsByFile: Map<string, number>;
}

const EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];

function scriptKindFor(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (file.endsWith('.ts')) return ts.ScriptKind.TS;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

/** Test files, build output copied into source, and minified bundles. */
function shouldSkip(relativePath: string): boolean {
  const p = relativePath.toLowerCase();
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
    p.includes('/__tests__/') ||
    p.includes('/__mocks__/') ||
    p.endsWith('.min.js')
  );
}

/**
 * A crude count of resource-acquiring calls in a file's raw text.
 *
 * Text-level, not AST-scoped - the same honesty limit `Entity.resourceCount`
 * already documents for Angular: this orders "worth a look first", it is
 * never evidence of anything on its own.
 */
const RESOURCE_HINT_PATTERN =
  /\b(setInterval|setTimeout|requestAnimationFrame|addEventListener|new\s+WebSocket|new\s+EventSource|new\s+Worker|new\s+SharedWorker|new\s+MutationObserver|new\s+ResizeObserver|new\s+IntersectionObserver|new\s+PerformanceObserver)\b/g;

function countResourceHints(text: string): number {
  return (text.match(RESOURCE_HINT_PATTERN) ?? []).length;
}

/** Record one declaration, however it was written. */
function record(
  byName: Map<string, JsDeclaration[]>,
  name: string,
  kind: JsDeclaration['kind'],
  file: string,
  line: number,
): void {
  const list = byName.get(name) ?? [];
  list.push({ name, file, line, kind });
  byName.set(name, list);
}

function visitFile(sourceFile: ts.SourceFile, file: string, byName: Map<string, JsDeclaration[]>): void {
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name !== undefined) {
      record(byName, node.name.text, 'class', file, lineOf(node));
    } else if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      record(byName, node.name.text, 'function', file, lineOf(node));
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) ||
        ts.isFunctionExpression(node.initializer) ||
        ts.isClassExpression(node.initializer))
    ) {
      const kind: JsDeclaration['kind'] = ts.isClassExpression(node.initializer) ? 'class' : 'function';
      record(byName, node.name.text, kind, file, lineOf(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/** Walk the project once and record every class/function declaration and a per-file resource hint count. */
export function scanJsProject(root: string): JsProjectScan {
  const byName = new Map<string, JsDeclaration[]>();
  const resourceHintsByFile = new Map<string, number>();

  const { files } = walkDirectory(root, { extensions: EXTENSIONS });

  for (const absolutePath of files) {
    const file = toRelativePosix(root, absolutePath);
    if (shouldSkip(file)) continue;

    let text: string;
    try {
      text = fs.readFileSync(absolutePath, 'utf8');
    } catch {
      continue;
    }
    resourceHintsByFile.set(file, countResourceHints(text));

    try {
      const sourceFile = ts.createSourceFile(
        absolutePath,
        text,
        ts.ScriptTarget.ES2022,
        /* setParentNodes */ false,
        scriptKindFor(absolutePath),
      );
      visitFile(sourceFile, file, byName);
    } catch {
      // A file that will not parse contributes no declarations, but its
      // resource-hint count (a plain text match) still stands.
      continue;
    }
  }

  return { byName, resourceHintsByFile };
}

const cache = new Map<string, JsProjectScan>();

/** Cached the same way `getEntityIndex` is: a walk over a large project is not free, and nothing here changes between calls in one investigation. */
export function getJsProjectScan(root: string, refresh = false): JsProjectScan {
  const key = path.resolve(root);
  if (!refresh) {
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
  }
  const scan = scanJsProject(key);
  cache.set(key, scan);
  return scan;
}
