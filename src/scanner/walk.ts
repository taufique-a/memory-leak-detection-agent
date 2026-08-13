/**
 * Fast recursive file discovery.
 *
 * WHY NOT JUST fs.readdirSync(dir, { recursive: true })?
 * ------------------------------------------------------
 * Node 22 has a recursive readdir, but it descends into EVERYTHING -
 * including node_modules. In the IOSense project node_modules holds
 * hundreds of thousands of files. Walking it would take minutes and
 * produce nothing we want.
 *
 * So we recurse manually and PRUNE: when we meet a directory on the
 * ignore list we do not descend into it at all. Pruning a directory is
 * enormously cheaper than visiting its contents and discarding them.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Directories we never descend into.
 *
 * `.angular` is the Angular CLI build cache - it can contain copies of
 * source files, which would produce phantom duplicate findings.
 */
export const DEFAULT_IGNORED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '.angular',
  '.vscode',
  '.idea',
  'dist',
  'build',
  'out-tsc',
  'coverage',
  'tmp',
  '.nx',
  '.cache',
];

export interface WalkOptions {
  /** File extensions to collect, including the dot. */
  extensions?: readonly string[];
  /** Directory names to prune. */
  ignoredDirs?: readonly string[];
  /** Safety valve against symlink loops or a mistyped root. */
  maxFiles?: number;
}

export interface WalkResult {
  /** Absolute paths of matching files. */
  files: string[];
  /** How many directories we looked inside. */
  directoriesVisited: number;
  /** Directories we skipped, for transparency in the report. */
  directoriesPruned: string[];
  /** True if maxFiles stopped us early - the result is incomplete. */
  truncated: boolean;
}

/**
 * Recursively collect files under `rootDir`.
 *
 * Uses `withFileTypes: true` so we learn file-vs-directory from the single
 * directory read, instead of calling fs.statSync on every entry. On a tree
 * with thousands of files that difference is seconds.
 */
export function walkDirectory(rootDir: string, options: WalkOptions = {}): WalkResult {
  const extensions = options.extensions ?? ['.ts'];
  const ignored = new Set(options.ignoredDirs ?? DEFAULT_IGNORED_DIRS);
  const maxFiles = options.maxFiles ?? 200_000;

  const files: string[] = [];
  const directoriesPruned: string[] = [];
  let directoriesVisited = 0;
  let truncated = false;

  /** Iterative stack rather than recursion - deep trees cannot blow the stack. */
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, or it vanished mid-walk).
      // Skipping is correct; the caller records a warning if it matters.
      continue;
    }
    directoriesVisited++;

    for (const entry of entries) {
      const full = path.join(current, entry.name);

      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) {
          directoriesPruned.push(full);
          continue;
        }
        stack.push(full);
        continue;
      }

      if (!entry.isFile()) continue; // symlinks, sockets, devices

      if (extensions.some((ext) => entry.name.endsWith(ext))) {
        if (files.length >= maxFiles) {
          truncated = true;
          break;
        }
        files.push(full);
      }
    }

    if (truncated) break;
  }

  // Stable ordering makes scan output diffable between runs.
  files.sort();

  return { files, directoriesVisited, directoriesPruned, truncated };
}

/** Convert an absolute path to a project-relative path with forward slashes. */
export function toRelativePosix(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join('/');
}

/**
 * Is this file a test / mock / fixture rather than shipped application code?
 *
 * Leaks in test files do not affect users, so we count them separately and
 * exclude them from risk ranking.
 */
export function isTestFile(relativePath: string): boolean {
  const p = relativePath.toLowerCase();
  return (
    p.endsWith('.spec.ts') ||
    p.endsWith('.test.ts') ||
    p.includes('/__mocks__/') ||
    p.includes('/__tests__/') ||
    p.includes('/test-helpers/') ||
    p.includes('/testing/') ||
    p.endsWith('/setup-jest.ts')
  );
}
