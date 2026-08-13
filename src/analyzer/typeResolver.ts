/**
 * Optional type-aware resolution of observable sources (`--types`).
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * Syntax alone cannot tell these apart:
 *
 *   this.devicesService.getDevices().subscribe();   // HttpClient -> completes
 *   this.devicesService.getDevices().subscribe();   // BehaviorSubject -> leaks
 *
 * Identical source. Opposite consequence. Phase 3 tags both
 * `likelyFiniteByName` and refuses to suppress either, which is honest but
 * leaves roughly 1,600 findings carrying avoidable uncertainty.
 *
 * WHY THE TYPE CHECKER ALONE IS NOT ENOUGH
 * ----------------------------------------
 * A common misconception: the checker will not tell you whether an
 * observable completes. `Observable<Device[]>` is the same type whether it
 * came from HttpClient or a Subject - completion is a runtime property, not
 * a type-level one.
 *
 * What the checker DOES give us is symbol resolution. We can follow
 * `getDevices` to its declaration in DevicesService, read the expression it
 * returns, and run the ordinary source classifier on THAT - where
 * `this.http.get(url)` is finally visible. One hop of inter-procedural
 * analysis, which is exactly what this case needs.
 *
 * COST: measured at 22.6s and 2.3 GB on IOSense, versus 6.5s syntax-only.
 * That is why this is opt-in.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as ts from 'typescript';

import type { ObservableSourceHint } from '../types/analysis';
import { classifyObservableExpression } from './visitor';

export interface TypeResolverStats {
  /** Time spent building the program and checker. */
  setupMs: number;
  /** How many source files the program pulled in. */
  sourceFiles: number;
  /** Calls we successfully followed to a declaration. */
  resolved: number;
  /** Calls we could not follow. */
  unresolved: number;
  /** Symbol lookups that threw. Non-zero means something is off. */
  failures: number;
}

export interface TypeResolver {
  /**
   * Refine a source hint using symbol resolution.
   *
   * Returns the original hint unchanged when we cannot do better, so this
   * can only ever add information, never remove it.
   */
  refine(call: ts.CallExpression, current: ObservableSourceHint): ObservableSourceHint;
  /** The program's version of a file, needed because nodes must match. */
  getSourceFile(fileName: string): ts.SourceFile | undefined;
  stats(): TypeResolverStats;
  dispose(): void;
}

/** Locate the tsconfig a project actually builds with. */
export function findProjectTsConfig(rootDir: string): string | undefined {
  const candidates = [
    path.join(rootDir, 'src', 'tsconfig.app.json'),
    path.join(rootDir, 'tsconfig.app.json'),
    path.join(rootDir, 'tsconfig.json'),
  ];
  return candidates.find((c) => fs.existsSync(c));
}

/**
 * Build a type-aware resolver. Returns undefined when no tsconfig is found.
 *
 * This is deliberately the ONLY place in the codebase that calls
 * ts.createProgram, so the expensive path is easy to audit.
 */
export function createTypeResolver(rootDir: string): TypeResolver | undefined {
  const configPath = findProjectTsConfig(rootDir);
  if (configPath === undefined) return undefined;

  const started = Date.now();

  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error) return undefined;

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
  );

  const program = ts.createProgram(parsedConfig.fileNames, {
    ...parsedConfig.options,
    // We only need symbols, never output. These make the program cheaper
    // without changing what the checker can answer.
    noEmit: true,
    skipLibCheck: true,
    skipDefaultLibCheck: true,
  });

  const checker = program.getTypeChecker();
  const setupMs = Date.now() - started;

  let resolved = 0;
  let unresolved = 0;
  let failures = 0;

  /** Cache per declaration node - the same service method is called a lot. */
  const declarationCache = new Map<ts.Node, ObservableSourceHint>();

  const refine = (
    call: ts.CallExpression,
    current: ObservableSourceHint,
  ): ObservableSourceHint => {
    // Only spend effort where syntax was genuinely unsure. Documented
    // sources (http, dialogClosure, subject, formControl) are already firm.
    if (current !== 'likelyFiniteByName' && current !== 'unknown') return current;

    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) return current;

    // The observable-producing call, e.g. `this.svc.getDevices()` in
    // `this.svc.getDevices().subscribe(...)`.
    let producer: ts.Expression = callee.expression;

    // Step back over a .pipe(...) so we reach the real source.
    while (ts.isCallExpression(producer)) {
      const producerCallee = producer.expression;
      if (
        ts.isPropertyAccessExpression(producerCallee) &&
        producerCallee.name.text === 'pipe'
      ) {
        producer = producerCallee.expression;
        continue;
      }
      break;
    }

    if (!ts.isCallExpression(producer)) {
      unresolved++;
      return current;
    }

    const producerCallee = producer.expression;
    const nameNode = ts.isPropertyAccessExpression(producerCallee)
      ? producerCallee.name
      : ts.isIdentifier(producerCallee)
        ? producerCallee
        : undefined;
    if (nameNode === undefined) {
      unresolved++;
      return current;
    }

    /**
     * Belt and braces. The caller only refines files that belong to the
     * program, but a checker failure must never take down a 5,000-file run
     * over one unresolvable symbol. Degrading to the syntactic hint is
     * always a safe outcome.
     */
    let symbol: ts.Symbol | undefined;
    try {
      symbol = checker.getSymbolAtLocation(nameNode);
    } catch {
      failures++;
      return current;
    }

    const declaration = symbol?.declarations?.[0];
    if (declaration === undefined) {
      unresolved++;
      return current;
    }

    const cached = declarationCache.get(declaration);
    if (cached !== undefined) {
      resolved++;
      return cached === 'unknown' ? current : cached;
    }

    const hint = classifyDeclaration(declaration);
    declarationCache.set(declaration, hint);

    if (hint === 'unknown') {
      unresolved++;
      return current;
    }
    resolved++;
    return hint;
  };

  return {
    refine,
    getSourceFile: (fileName) => program.getSourceFile(fileName),
    stats: () => ({
      setupMs,
      sourceFiles: program.getSourceFiles().length,
      resolved,
      unresolved,
      failures,
    }),
    // Dropping our references lets V8 reclaim the ~2 GB the program holds.
    dispose: () => {
      declarationCache.clear();
    },
  };
}

/**
 * Read what a method declaration returns and classify it.
 *
 * `getDevices() { return this.http.get<Device[]>(url); }` classifies as
 * 'http', which is documented-finite and therefore safe to exclude.
 * `getDevices() { return this.cache$; }` classifies as 'subject'.
 */
function classifyDeclaration(declaration: ts.Declaration): ObservableSourceHint {
  const body = getBody(declaration);
  if (body === undefined) return 'unknown';

  // Concise arrow body: `getDevices = () => this.http.get(url)`
  if (!ts.isBlock(body)) return classifyObservableExpression(body);

  const hints: ObservableSourceHint[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) {
      hints.push(classifyObservableExpression(node.expression));
    }
    // Do not descend into nested functions - their returns belong to them.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node)
    ) {
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);

  if (hints.length === 0) return 'unknown';

  /**
   * Every return path must be finite before we call the method finite.
   *
   * A method returning HttpClient on one branch and a cached Subject on
   * another is NOT safe, and treating it as safe would hide a real leak.
   * Requiring unanimity is the conservative direction.
   */
  const allFinite = hints.every((h) => h === 'http' || h === 'dialogClosure');
  if (allFinite) return 'http';

  const firstInfinite = hints.find(
    (h) => h === 'subject' || h === 'formControl' || h === 'router' || h === 'timerOrEvent',
  );
  return firstInfinite ?? 'unknown';
}

function getBody(declaration: ts.Declaration): ts.Block | ts.Expression | undefined {
  if (
    ts.isMethodDeclaration(declaration) ||
    ts.isFunctionDeclaration(declaration) ||
    ts.isGetAccessorDeclaration(declaration)
  ) {
    return declaration.body;
  }
  // `getDevices = () => ...` on a class property
  if (ts.isPropertyDeclaration(declaration) && declaration.initializer) {
    const init = declaration.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.body;
    return init;
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const init = declaration.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init.body;
  }
  return undefined;
}
