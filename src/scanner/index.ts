/**
 * The Project Scanner - orchestrates discovery, parsing and classification.
 *
 * PIPELINE
 *   1. validate the root looks like an Angular project
 *   2. read angular.json + package.json          (workspace.ts)
 *   3. walk the source root, pruning build dirs  (walk.ts)
 *   4. parse each .ts file into an AST           (parse.ts)
 *   5. extract Angular classes from each AST     (classify.ts)
 *   6. match dependencies against known risks    (libraries.ts)
 *   7. aggregate a summary
 *
 * This function never modifies the target project. It only reads.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { AGENT_VERSION } from '../version';
import type {
  ScanResult,
  ScanSummary,
  SourceFileInfo,
} from '../types/project';
import { classifyAngularClasses } from './classify';
import { detectRiskyLibraries } from './libraries';
import { collectImportSpecifiers, isParseFailure, parseSourceFile } from './parse';
import { isTestFile, toRelativePosix, walkDirectory } from './walk';
import { readWorkspace } from './workspace';

export interface ScanOptions {
  /**
   * Called periodically so a long scan can show progress.
   * Scanning 5000 files takes several seconds; silence looks like a hang.
   */
  onProgress?: (done: number, total: number) => void;
  /** Include *.spec.ts and mocks in the file list. Default true. */
  includeTests?: boolean;
}

/** Thrown when the path given is not usable as a project root. */
export class ScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScanError';
  }
}

export function scanProject(projectPath: string, options: ScanOptions = {}): ScanResult {
  const startedAt = Date.now();
  const rootDir = path.resolve(projectPath);

  /* ---- 1. validate ---- */
  if (!fs.existsSync(rootDir)) {
    throw new ScanError(`Path does not exist: ${rootDir}`);
  }
  if (!fs.statSync(rootDir).isDirectory()) {
    throw new ScanError(`Path is not a directory: ${rootDir}`);
  }

  /* ---- 2. workspace ---- */
  const { workspace, allDependencies, warnings } = readWorkspace(rootDir);

  /* ---- 3. walk ---- */
  // Prefer the sourceRoot declared in angular.json. Fall back to src/, and
  // finally to the whole root - some projects are unconventional and we
  // would rather scan too much than silently scan nothing.
  const declaredSourceRoot = workspace.primaryProject?.sourceRoot ?? 'src';
  let scanRoot = path.join(rootDir, declaredSourceRoot);
  if (!fs.existsSync(scanRoot)) {
    warnings.push(
      `Declared sourceRoot "${declaredSourceRoot}" not found; scanning the project root instead.`,
    );
    scanRoot = rootDir;
  }

  const walk = walkDirectory(scanRoot, { extensions: ['.ts'] });
  if (walk.truncated) {
    warnings.push('File limit reached - the scan is incomplete.');
  }
  if (walk.files.length === 0) {
    warnings.push(`No TypeScript files found under ${scanRoot}.`);
  }

  /* ---- 4 + 5. parse and classify ---- */
  const includeTests = options.includeTests ?? true;
  const files: SourceFileInfo[] = [];
  const total = walk.files.length;

  for (let i = 0; i < walk.files.length; i++) {
    const absolutePath = walk.files[i];
    if (absolutePath === undefined) continue;

    const relativePath = toRelativePosix(rootDir, absolutePath);
    const testFile = isTestFile('/' + relativePath);

    if (!includeTests && testFile) continue;

    const parsed = parseSourceFile(absolutePath, relativePath);
    if (isParseFailure(parsed)) {
      // One bad file must never abort a 5000-file scan.
      warnings.push(`${relativePath}: ${parsed.reason}`);
      continue;
    }

    files.push({
      path: relativePath,
      absolutePath,
      bytes: parsed.bytes,
      lines: parsed.lines,
      isTest: testFile,
      classes: classifyAngularClasses(parsed.sourceFile, relativePath),
      imports: collectImportSpecifiers(parsed.sourceFile),
    });

    // Report every 250 files: often enough to feel alive, rarely enough
    // that terminal writes do not dominate the runtime.
    if (options.onProgress && (i % 250 === 0 || i === total - 1)) {
      options.onProgress(i + 1, total);
    }
  }

  /* ---- 6. libraries ---- */
  const riskyLibraries = detectRiskyLibraries(allDependencies);

  /* ---- 7. summary ---- */
  const summary = summarise(files);

  return {
    schemaVersion: 1,
    scannedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    agentVersion: AGENT_VERSION,
    workspace,
    summary,
    files,
    riskyLibraries,
    warnings,
  };
}

/**
 * Aggregate counts.
 *
 * Note that `componentsWithoutOnDestroy` counts only NON-TEST components.
 * A leak in a spec file does not affect users, and including them would
 * inflate the number that a human is meant to act on.
 */
function summarise(files: SourceFileInfo[]): ScanSummary {
  const summary: ScanSummary = {
    totalFiles: files.length,
    testFiles: 0,
    totalBytes: 0,
    totalLines: 0,
    components: 0,
    directives: 0,
    injectables: 0,
    ngModules: 0,
    pipes: 0,
    standaloneClasses: 0,
    componentsWithOnDestroy: 0,
    componentsWithoutOnDestroy: 0,
  };

  for (const file of files) {
    summary.totalBytes += file.bytes;
    summary.totalLines += file.lines;
    if (file.isTest) summary.testFiles++;

    for (const cls of file.classes) {
      switch (cls.kind) {
        case 'Component':
          summary.components++;
          break;
        case 'Directive':
          summary.directives++;
          break;
        case 'Injectable':
          summary.injectables++;
          break;
        case 'NgModule':
          summary.ngModules++;
          break;
        case 'Pipe':
          summary.pipes++;
          break;
      }

      if (cls.standalone) summary.standaloneClasses++;

      if (cls.kind === 'Component' && !file.isTest) {
        if (cls.hasOnDestroyMethod) summary.componentsWithOnDestroy++;
        else summary.componentsWithoutOnDestroy++;
      }
    }
  }

  return summary;
}

/** Every Angular class in the scan, flattened. Convenience for later phases. */
export function allClasses(result: ScanResult) {
  return result.files.flatMap((f) => f.classes);
}

export { ScanError as ScannerError };
