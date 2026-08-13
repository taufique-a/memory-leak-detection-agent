/**
 * The static risk pipeline - Phase 4's orchestrator.
 *
 * ONE PARSE, MANY CONSUMERS
 * -------------------------
 * Parsing IOSense costs ~5 seconds. This pipeline needs the AST for two
 * different jobs: finding resource operations, and extracting the route
 * graph. Running the Phase 3 analyzer and then a separate route pass would
 * cost ~11 seconds for identical trees. So we walk once, parse once, and
 * hand each file to both consumers.
 *
 * PIPELINE
 *   1. read workspace                      (scanner/workspace)
 *   2. walk + parse each .ts file          (scanner/walk, scanner/parse)
 *      a. find resource operations         (analyzer/visitor)
 *      b. extract route arrays             (scanner/routes)
 *   3. link the route graph across files   (scanner/routes)
 *   4. score every unpaired resource       (risk/score)
 *   5. rank, cap and explain
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

import { analyzeSourceFileWith } from '../analyzer';
import { createTypeResolver, type TypeResolver } from '../analyzer/typeResolver';
import { isParseFailure, parseSourceFile } from '../scanner/parse';
import {
  extractRouteArrays,
  linkRouteGraph,
  type RouteArrayDeclaration,
  type RouteGraph,
} from '../scanner/routes';
import { isTestFile, toRelativePosix, walkDirectory } from '../scanner/walk';
import { readWorkspace } from '../scanner/workspace';
import type { ClassAnalysis } from '../types/analysis';
import type { Confidence, Risk } from '../types/index';
import type { Finding, FindingsResult, FindingsSummary } from '../types/finding';
import { AGENT_VERSION } from '../version';
import { scoreFinding } from './score';

export interface RiskOptions {
  onProgress?: (done: number, total: number, label: string) => void;
  /** Use the TypeScript type checker to resolve observable sources. */
  useTypes?: boolean;
  /** Restrict to files whose path contains this fragment. */
  filter?: string;
  /** Include *.spec.ts and mocks. Default false. */
  includeTests?: boolean;
  /** Maximum findings to return. Default 50. 0 means no cap. */
  limit?: number;
}

export class RiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RiskError';
  }
}

/** Extra detail about the run, for the report header. */
export interface RiskRunInfo {
  typesUsed: boolean;
  typeResolverSetupMs?: number;
  typeResolverResolved?: number;
  typeResolverUnresolved?: number;
  typeResolverFailures?: number;
  /** Files the tsconfig program excludes, so type refinement skipped them. */
  filesOutsideProgram?: number;
  routeGraph: {
    routeArrays: number;
    routedComponents: number;
    unresolvedLazyModules: number;
  };
  filesParsed: number;
  /** Findings produced before the limit was applied. */
  findingsBeforeLimit: number;
}

export interface RiskResult extends FindingsResult {
  run: RiskRunInfo;
}

export function assessRisk(projectPath: string, options: RiskOptions = {}): RiskResult {
  const startedAt = Date.now();
  const rootDir = path.resolve(projectPath);

  if (!fs.existsSync(rootDir)) throw new RiskError(`Path does not exist: ${rootDir}`);
  if (!fs.statSync(rootDir).isDirectory()) {
    throw new RiskError(`Path is not a directory: ${rootDir}`);
  }

  const warnings: string[] = [];
  const { workspace } = readWorkspace(rootDir);

  const declaredSourceRoot = workspace.primaryProject?.sourceRoot ?? 'src';
  let scanRoot = path.join(rootDir, declaredSourceRoot);
  if (!fs.existsSync(scanRoot)) {
    warnings.push(`sourceRoot "${declaredSourceRoot}" not found; using the project root.`);
    scanRoot = rootDir;
  }

  /* ---- optional type resolver ---- */
  let resolver: TypeResolver | undefined;
  if (options.useTypes) {
    options.onProgress?.(0, 1, 'building type program (this takes ~25s)');
    resolver = createTypeResolver(rootDir);
    if (resolver === undefined) {
      warnings.push('--types requested but no usable tsconfig was found; using syntax only.');
    }
  }

  /* ---- walk + parse once ---- */
  const walk = walkDirectory(scanRoot, { extensions: ['.ts'] });
  const includeTests = options.includeTests ?? false;

  const classAnalyses: ClassAnalysis[] = [];
  const routeDeclarations: RouteArrayDeclaration[] = [];
  let filesParsed = 0;
  /** Files the tsconfig program does not include, so cannot be refined. */
  let filesOutsideProgram = 0;

  const total = walk.files.length;
  for (let i = 0; i < walk.files.length; i++) {
    const absolutePath = walk.files[i];
    if (absolutePath === undefined) continue;

    const relativePath = toRelativePosix(rootDir, absolutePath);
    if (!includeTests && isTestFile('/' + relativePath)) continue;

    /**
     * When the type checker is active we MUST use the program's own
     * SourceFile. Symbol resolution only works on nodes the checker knows
     * about; a node from an independent createSourceFile call would return
     * undefined for every symbol lookup, silently disabling refinement.
     */
    let sourceFile: ts.SourceFile | undefined = resolver?.getSourceFile(absolutePath);

    /**
     * Whether this file's AST belongs to the type-checker's program.
     *
     * CRITICAL. The program only contains files reachable from the tsconfig
     * entry points - on IOSense that is 4,883 files out of the 5,208 our
     * walk finds. The remaining ~325 (spec files, dead code, anything
     * tsconfig.app.json excludes) get parsed independently, and passing one
     * of THOSE nodes to checker.getSymbolAtLocation crashes inside
     * resolveNameHelper: the checker has no binder state for a node it has
     * never seen.
     *
     * So refinement is enabled per-file, not per-run.
     */
    const nodeBelongsToProgram = sourceFile !== undefined;

    if (sourceFile === undefined) {
      const parsed = parseSourceFile(absolutePath, relativePath);
      if (isParseFailure(parsed)) {
        warnings.push(`${relativePath}: ${parsed.reason}`);
        continue;
      }
      sourceFile = parsed.sourceFile;
      if (resolver !== undefined) filesOutsideProgram++;
    }
    filesParsed++;

    // Routes come from the whole project, regardless of --filter, because a
    // filtered component still needs its route context.
    routeDeclarations.push(...extractRouteArrays(sourceFile, relativePath));

    if (options.filter !== undefined && !relativePath.includes(options.filter)) continue;

    const analysis = analyzeSourceFileWith(sourceFile, relativePath, {
      ...(resolver && nodeBelongsToProgram ? { refineSource: resolver.refine } : {}),
    });
    classAnalyses.push(...analysis.classes);

    if (options.onProgress && (i % 250 === 0 || i === total - 1)) {
      options.onProgress(i + 1, total, 'analyzing');
    }
  }

  /* ---- link routes ---- */
  const sourceRootPrefix = toRelativePosix(rootDir, scanRoot) + '/app';
  const routeGraph: RouteGraph = linkRouteGraph(routeDeclarations, sourceRootPrefix);

  /* ---- score ---- */
  const findings: Finding[] = [];
  for (const cls of classAnalyses) {
    const routed = routeGraph.routedComponents.get(cls.className);
    for (const pairing of cls.pairings) {
      const finding = scoreFinding({
        cls,
        pairing,
        ...(routed !== undefined ? { routed } : {}),
      });
      if (finding) findings.push(finding);
    }
  }

  findings.sort((a, b) => b.score - a.score);
  const findingsBeforeLimit = findings.length;

  const limit = options.limit ?? 50;
  const capped = limit > 0 ? findings.slice(0, limit) : findings;

  const stats = resolver?.stats();
  resolver?.dispose();

  return {
    schemaVersion: 1,
    generatedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    agentVersion: AGENT_VERSION,
    projectRoot: rootDir,
    summary: summarise(findings, findingsBeforeLimit),
    findings: capped,
    limitations: buildLimitations(resolver !== undefined, findingsBeforeLimit, capped.length),
    warnings,
    run: {
      typesUsed: resolver !== undefined,
      ...(stats
        ? {
            typeResolverSetupMs: stats.setupMs,
            typeResolverResolved: stats.resolved,
            typeResolverUnresolved: stats.unresolved,
            typeResolverFailures: stats.failures,
            filesOutsideProgram,
          }
        : {}),
      routeGraph: {
        routeArrays: routeGraph.routeArraysFound,
        routedComponents: routeGraph.routedComponents.size,
        unresolvedLazyModules: routeGraph.unresolvedLazyModules.length,
      },
      filesParsed,
      findingsBeforeLimit,
    },
  };
}

function summarise(findings: Finding[], total: number): FindingsSummary {
  const byRisk: Record<Risk, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  const byConfidence: Record<Confidence, number> = {
    PROVEN: 0,
    LIKELY: 0,
    POSSIBLE: 0,
    UNKNOWN: 0,
  };
  const byKind: Record<string, number> = {};
  let inRoutedComponents = 0;

  for (const f of findings) {
    byRisk[f.risk]++;
    byConfidence[f.confidence]++;
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
    if (f.location.routed) inRoutedComponents++;
  }

  return { total, byRisk, byConfidence, byKind, inRoutedComponents };
}

/**
 * State the limits of this analysis explicitly, in the output.
 *
 * A tool that lists what it cannot know is far more trustworthy than one
 * that presents a confident number and leaves the reader to discover the
 * caveats by being wrong.
 */
function buildLimitations(typesUsed: boolean, total: number, shown: number): string[] {
  const limitations = [
    'This is STATIC analysis. Nothing here has been observed at runtime - no ' +
      'application was launched and no memory was measured. A finding is a reason ' +
      'to investigate, not a confirmed leak.',
    'Confidence never exceeds LIKELY. Reaching PROVEN requires runtime evidence ' +
      'from the investigation phases.',
    'Pairing does not follow dataflow. When a release call exists we report that it ' +
      'exists, not that it covers every acquire.',
  ];

  if (!typesUsed) {
    limitations.push(
      'Observable sources were classified by naming convention. Calls like ' +
        'getDevices() are marked as guesses and scored down, but not excluded. ' +
        'Re-run with --types to resolve them by symbol instead (~25s, ~2.3 GB).',
    );
  } else {
    limitations.push(
      'Type resolution follows one hop: the called method is resolved and its ' +
        'return expression classified. Observables assembled across several ' +
        'methods, or returned from an interface with no visible body, stay unknown.',
    );
  }

  if (shown < total) {
    limitations.push(
      `Showing the top ${shown} of ${total} findings. The rest are in the JSON output.`,
    );
  }

  return limitations;
}
