/**
 * The AST analyzer - runs the resource visitor across a whole project.
 *
 * Reuses Phase 2's walk and parse modules rather than reimplementing them.
 * That is why parse.ts was split out: one parse, many consumers.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

import { isParseFailure, parseSourceFile } from '../scanner/parse';
import { isTestFile, toRelativePosix, walkDirectory } from '../scanner/walk';
import { readWorkspace } from '../scanner/workspace';
import type {
  AnalysisResult,
  AnalysisSummary,
  FileAnalysis,
  ResourceOperation,
} from '../types/analysis';
import type { ClassLifecycle } from '../types/lifecycle';
import { AGENT_VERSION } from '../version';
import { analyzeLifecycles } from './lifecycle';
import { buildClassAnalyses } from './pairing';
import { findResourceOperations, type VisitOptions } from './visitor';

export interface AnalyzeOptions {
  onProgress?: (done: number, total: number) => void;
  /** Include *.spec.ts and mocks. Default false - test leaks do not ship. */
  includeTests?: boolean;
  /** Restrict analysis to files whose path contains this substring. */
  filter?: string;
}

export class AnalyzeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzeError';
  }
}

/** Basic facts about a class, used to give operations their context. */
interface ClassFacts {
  line: number;
  angularKind?: string;
  hasOnDestroyMethod: boolean;
  declaresOnDestroyInterface: boolean;
}

/**
 * Collect facts about EVERY class in a file, not just Angular-decorated ones.
 *
 * Phase 2's classifier only reports decorated classes, which is right for an
 * inventory. But resources leak from plain classes too - base classes,
 * helpers, hand-rolled stores - so the analyzer needs the wider set.
 */
function collectClassFacts(sourceFile: ts.SourceFile): Map<string, ClassFacts> {
  const facts = new Map<string, ClassFacts>();

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const methods: string[] = [];
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const name = member.name;
        if (ts.isIdentifier(name) || ts.isStringLiteral(name)) methods.push(name.text);
      }

      const implemented: string[] = [];
      for (const heritage of node.heritageClauses ?? []) {
        if (heritage.token !== ts.SyntaxKind.ImplementsKeyword) continue;
        for (const type of heritage.types) {
          if (ts.isIdentifier(type.expression)) implemented.push(type.expression.text);
        }
      }

      let angularKind: string | undefined;
      if (ts.canHaveDecorators(node)) {
        for (const decorator of ts.getDecorators(node) ?? []) {
          const expr = decorator.expression;
          const target = ts.isCallExpression(expr) ? expr.expression : expr;
          if (ts.isIdentifier(target)) {
            angularKind = target.text;
            break;
          }
        }
      }

      facts.set(node.name.text, {
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        ...(angularKind !== undefined ? { angularKind } : {}),
        hasOnDestroyMethod: methods.includes('ngOnDestroy'),
        declaresOnDestroyInterface: implemented.includes('OnDestroy'),
      });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return facts;
}

/** Analyze one already-parsed file. Exposed for tests and later phases. */
export function analyzeSourceFile(
  sourceFile: ts.SourceFile,
  relativePath: string,
): FileAnalysis {
  return analyzeSourceFileWith(sourceFile, relativePath, {});
}

/**
 * Analyze one file with visitor options - notably the optional type-aware
 * source-hint refiner used by `--types`.
 */
export function analyzeSourceFileWith(
  sourceFile: ts.SourceFile,
  relativePath: string,
  options: VisitOptions,
): FileAnalysis {
  const operations = findResourceOperations(sourceFile, relativePath, options);

  /**
   * ORDER MATTERS HERE.
   *
   * Lifecycle analysis must run BEFORE pairing, because it can invalidate a
   * mitigation. A subscription piped through `takeUntil(this.destroy$)`
   * looks handled - but if ngOnDestroy never fires destroy$, it is not.
   * Pairing decides what is actionable, so it has to see the corrected
   * mitigation state, not the optimistic one.
   */
  const operationsByClass = groupByClass(operations);
  const lifecycles = analyzeLifecycles(sourceFile, relativePath, operationsByClass);
  invalidateBrokenMitigations(lifecycles, operationsByClass);

  const facts = collectClassFacts(sourceFile);
  const { classes, loose } = buildClassAnalyses(operations, facts, relativePath);

  // Attach lifecycle findings to the class they belong to.
  const lifecycleByClass = new Map(lifecycles.map((l) => [l.className, l]));
  for (const cls of classes) {
    const lifecycle = lifecycleByClass.get(cls.className);
    if (lifecycle) cls.lifecycle = lifecycle;
  }

  return {
    file: relativePath,
    classes,
    looseOperations: loose,
    // Classes with lifecycle issues but no resource operations still matter
    // (an empty ngOnDestroy, a root service that cleans up pointlessly).
    lifecycles: lifecycles.filter((l) => l.issues.length > 0),
  };
}

function groupByClass(operations: ResourceOperation[]): Map<string, ResourceOperation[]> {
  const map = new Map<string, ResourceOperation[]>();
  for (const op of operations) {
    if (op.className === undefined) continue;
    const list = map.get(op.className) ?? [];
    list.push(op);
    map.set(op.className, list);
  }
  return map;
}

/**
 * Clear mitigations that Phase 5 proved ineffective.
 *
 * Mutates the operations in place - they are the same objects pairing will
 * read a moment later. The reason is preserved on `mitigationBroken` so the
 * report can explain why code that reads as correct cleanup is not.
 */
function invalidateBrokenMitigations(
  lifecycles: ClassLifecycle[],
  operationsByClass: ReadonlyMap<string, ResourceOperation[]>,
): void {
  for (const lifecycle of lifecycles) {
    const deadSignals = new Set(
      lifecycle.destroySignals.filter((s) => !s.triggeredInOnDestroy).map((s) => s.name),
    );
    if (deadSignals.size === 0) continue;

    for (const op of operationsByClass.get(lifecycle.className) ?? []) {
      if (op.mitigationSignal === undefined) continue;
      if (!deadSignals.has(op.mitigationSignal)) continue;

      op.mitigationBroken =
        `takeUntil(${op.mitigationSignal}) never fires: ${op.mitigationSignal} is never ` +
        `completed in ngOnDestroy, so this subscription is not actually torn down.`;
      delete op.mitigatedBy;
    }
  }
}

/** Run the analyzer across a project. Never modifies the target. */
export function analyzeProject(
  projectPath: string,
  options: AnalyzeOptions = {},
): AnalysisResult {
  const startedAt = Date.now();
  const rootDir = path.resolve(projectPath);

  if (!fs.existsSync(rootDir)) {
    throw new AnalyzeError(`Path does not exist: ${rootDir}`);
  }
  if (!fs.statSync(rootDir).isDirectory()) {
    throw new AnalyzeError(`Path is not a directory: ${rootDir}`);
  }

  const warnings: string[] = [];
  const { workspace } = readWorkspace(rootDir);

  const declaredSourceRoot = workspace.primaryProject?.sourceRoot ?? 'src';
  let scanRoot = path.join(rootDir, declaredSourceRoot);
  if (!fs.existsSync(scanRoot)) {
    warnings.push(
      `Declared sourceRoot "${declaredSourceRoot}" not found; analysing the project root.`,
    );
    scanRoot = rootDir;
  }

  const walk = walkDirectory(scanRoot, { extensions: ['.ts'] });
  const includeTests = options.includeTests ?? false;

  const files: FileAnalysis[] = [];
  const total = walk.files.length;

  for (let i = 0; i < walk.files.length; i++) {
    const absolutePath = walk.files[i];
    if (absolutePath === undefined) continue;

    const relativePath = toRelativePosix(rootDir, absolutePath);

    if (!includeTests && isTestFile('/' + relativePath)) continue;
    if (options.filter !== undefined && !relativePath.includes(options.filter)) continue;

    const parsed = parseSourceFile(absolutePath, relativePath);
    if (isParseFailure(parsed)) {
      warnings.push(`${relativePath}: ${parsed.reason}`);
      continue;
    }

    const analysis = analyzeSourceFile(parsed.sourceFile, relativePath);

    // Keep only files that actually contain something. Storing 5000 empty
    // entries would bloat the JSON for no benefit.
    if (analysis.classes.length > 0 || analysis.looseOperations.length > 0) {
      files.push(analysis);
    }

    if (options.onProgress && (i % 250 === 0 || i === total - 1)) {
      options.onProgress(i + 1, total);
    }
  }

  return {
    schemaVersion: 1,
    analyzedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    agentVersion: AGENT_VERSION,
    projectRoot: rootDir,
    summary: summarise(files),
    files,
    warnings,
  };
}

function summarise(files: FileAnalysis[]): AnalysisSummary {
  const summary: AnalysisSummary = {
    filesAnalyzed: files.length,
    classesWithResources: 0,
    totalAcquires: 0,
    totalReleases: 0,
    discardedHandles: 0,
    unpairedKinds: 0,
    byKind: {},
  };

  const count = (op: ResourceOperation): void => {
    if (op.action === 'acquire') {
      summary.totalAcquires++;
      if (op.disposition === 'discarded') summary.discardedHandles++;
      summary.byKind[op.kind] = (summary.byKind[op.kind] ?? 0) + 1;
    } else {
      summary.totalReleases++;
    }
  };

  for (const file of files) {
    for (const cls of file.classes) {
      if (cls.operations.some((o) => o.action === 'acquire')) summary.classesWithResources++;
      for (const op of cls.operations) count(op);
      for (const pairing of cls.pairings) {
        if (pairing.coverage === 'none' || pairing.coverage === 'impossible') {
          summary.unpairedKinds++;
        }
      }
    }
    for (const op of file.looseOperations) count(op);
  }

  return summary;
}
