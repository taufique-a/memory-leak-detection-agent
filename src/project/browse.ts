/**
 * Walking the filesystem to pick a folder.
 *
 * WHY IT IS NEEDED
 * ----------------
 * The project path used to be typed by hand, and on this machine there are
 * eleven checkouts called IOSense across several drives. Typing the wrong
 * one gives a perfectly successful investigation of the wrong code, which
 * is the hardest kind of mistake to notice.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * Directories only. It never reads a file, never returns file contents, and
 * never lists file names beyond the handful of markers that say "this is a
 * project" - so a browse cannot be turned into a way to read the disk.
 *
 * The server this sits behind is loopback-only and token-guarded, and the
 * tool already reads whatever project it is pointed at. Listing folder names
 * is consistent with that; handing back file contents would not be.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface BrowseEntry {
  name: string;
  path: string;
  /** True when this folder looks like a project you could investigate. */
  isProject: boolean;
  /** True when it holds an angular.json. */
  isAngular: boolean;
}

export interface BrowseResult {
  /** The folder being listed, resolved. */
  path: string;
  /** Its parent, or undefined at a drive root. */
  parent?: string;
  /** Sub-folders, projects first then alphabetical. */
  entries: BrowseEntry[];
  /** Drive roots and home, so there is always a way back to the top. */
  roots: string[];
  error?: string;
}

/** Folders that are never worth showing in a picker. */
const SKIP = new Set([
  'node_modules',
  '.git',
  '.angular',
  'dist',
  '.vscode',
  '.idea',
  '$RECYCLE.BIN',
  'System Volume Information',
]);

export function browseFolder(target?: string): BrowseResult {
  const roots = listRoots();

  if (target === undefined || target === '') {
    return { path: '', entries: [], roots };
  }

  const resolved = path.resolve(target);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (err) {
    return {
      path: resolved,
      entries: [],
      roots,
      error: `Cannot open ${resolved}: ${(err as Error).message}`,
    };
  }

  const parent = path.dirname(resolved);

  const folders: BrowseEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;

    const full = path.join(resolved, entry.name);
    folders.push({
      name: entry.name,
      path: full,
      isProject: exists(path.join(full, 'package.json')),
      isAngular: exists(path.join(full, 'angular.json')),
    });
  }

  // Projects first - that is what somebody is looking for - then Angular
  // ones above the rest, then alphabetical.
  folders.sort((a, b) => {
    const score = (e: BrowseEntry): number => (e.isAngular ? 2 : e.isProject ? 1 : 0);
    return score(b) - score(a) || a.name.localeCompare(b.name);
  });

  return {
    path: resolved,
    ...(parent !== resolved ? { parent } : {}),
    entries: folders.slice(0, 500),
    roots,
  };
}

/** Drive letters that exist, plus the home directory. */
function listRoots(): string[] {
  const roots: string[] = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${letter}:\\`;
    if (exists(drive)) roots.push(drive);
  }
  if (roots.length === 0) roots.push(path.parse(process.cwd()).root);

  const home = os.homedir();
  if (home !== '' && exists(home)) roots.push(home);
  return roots;
}

function exists(candidate: string): boolean {
  try {
    fs.accessSync(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find likely projects under a folder, a couple of levels down.
 *
 * Saves the click-by-click descent in the common case where somebody knows
 * roughly where their work lives but not the exact folder.
 */
export function findProjectsUnder(root: string, maxDepth = 2, limit = 40): BrowseEntry[] {
  const found: BrowseEntry[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || found.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (found.length >= limit) return;
      if (!entry.isDirectory()) continue;
      if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;

      const full = path.join(dir, entry.name);
      const isAngular = exists(path.join(full, 'angular.json'));
      if (isAngular || exists(path.join(full, 'package.json'))) {
        found.push({ name: entry.name, path: full, isProject: true, isAngular });
        // A project inside a project is a monorepo package; keep looking.
      }
      walk(full, depth + 1);
    }
  };

  walk(path.resolve(root), 0);
  found.sort((a, b) => Number(b.isAngular) - Number(a.isAngular) || a.path.localeCompare(b.path));
  return found;
}
