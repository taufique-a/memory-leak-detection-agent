/**
 * Is this folder something we can actually investigate?
 *
 * WHY A SEPARATE STEP
 * -------------------
 * Everything downstream assumes the target is a buildable Angular project in
 * a git repository. When it is not, the failure arrives late and disguised:
 * the scanner finds zero components, the fixer refuses because there is no
 * repository, the build fails because nothing is installed. Each of those
 * reads as a bug in the tool.
 *
 * So the folder is checked once, up front, and every problem is named with
 * the thing to do about it.
 *
 * BLOCKING VERSUS WORTH KNOWING
 * -----------------------------
 * A missing package.json means nothing can proceed. A missing lint script
 * means one verification check will skip. Those are not the same, and
 * treating them the same either blocks people for no reason or lets them
 * walk into a wall. Every check says which it is.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { majorVersion, readWorkspace } from '../scanner/workspace';

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface SourceCheck {
  /** Short label, e.g. "Angular project". */
  name: string;
  status: CheckStatus;
  /** What was found, in plain language. */
  detail: string;
  /** What to do about it. Present whenever status is not 'pass'. */
  fix?: string;
  /** True when this alone stops the investigation. */
  blocking: boolean;
}

export interface SourceValidation {
  /** The folder as given, resolved. */
  root: string;
  /** True when nothing blocking failed. */
  usable: boolean;
  checks: SourceCheck[];

  /* ---- facts worth carrying forward ---- */
  packageName?: string;
  angularVersion?: string;
  /** npm scripts the project defines. */
  scripts: string[];
  /** The script that builds it, when there is one. */
  buildScript?: string;
  /** Where compiled output would land, from angular.json. */
  outputPath?: string;
  /** True when compiled output already exists. */
  compiled: boolean;
  /** When that output was last written. */
  compiledAt?: number;
  /** True when the newest source file is newer than the newest build output. */
  compiledOutOfDate?: boolean;
}

/** Look at a folder and say whether it can be investigated. */
export function validateSource(folder: string): SourceValidation {
  const root = path.resolve(folder);
  const checks: SourceCheck[] = [];

  /* ---- 1. does it exist at all? ---- */
  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(root);
  } catch {
    stat = undefined;
  }

  if (stat === undefined) {
    checks.push({
      name: 'Folder',
      status: 'fail',
      detail: `Nothing exists at ${root}.`,
      fix: 'Check the path, or pick the folder with the browse button.',
      blocking: true,
    });
    return { root, usable: false, checks, scripts: [], compiled: false };
  }
  if (!stat.isDirectory()) {
    checks.push({
      name: 'Folder',
      status: 'fail',
      detail: `${root} is a file, not a folder.`,
      fix: 'Pick the folder that contains package.json.',
      blocking: true,
    });
    return { root, usable: false, checks, scripts: [], compiled: false };
  }
  checks.push({ name: 'Folder', status: 'pass', detail: root, blocking: true });

  /* ---- 2. package.json ---- */
  const packageJsonPath = path.join(root, 'package.json');
  let pkg: { name?: string; scripts?: Record<string, string> } | undefined;
  try {
    pkg = JSON.parse(stripBom(fs.readFileSync(packageJsonPath, 'utf8'))) as typeof pkg;
  } catch {
    pkg = undefined;
  }

  if (pkg === undefined) {
    const exists = fs.existsSync(packageJsonPath);
    checks.push({
      name: 'package.json',
      status: 'fail',
      detail: exists
        ? 'package.json is there but could not be read as JSON.'
        : 'No package.json in this folder.',
      fix: exists
        ? 'Fix the JSON, or check the file is not saved with a byte-order mark.'
        : suggestSubfolder(root) ??
          'Pick the folder that holds package.json - usually the one you run npm from.',
      blocking: true,
    });
    return { root, usable: false, checks, scripts: [], compiled: false };
  }

  const scripts = Object.keys(pkg.scripts ?? {});
  checks.push({
    name: 'package.json',
    status: 'pass',
    detail: `${pkg.name ?? 'unnamed project'}, ${scripts.length} script(s)`,
    blocking: true,
  });

  /* ---- 3. is it Angular, and which version? ---- */
  const { workspace } = readWorkspace(root);
  const ngMajor = majorVersion(workspace.angularVersion);

  if (workspace.angularVersion === undefined) {
    checks.push({
      name: 'Angular',
      status: 'fail',
      detail: 'No @angular/core in the dependencies.',
      fix:
        'This tool analyses Angular applications. For anything else the browser ' +
        'measurement still works, but the code analysis will find nothing.',
      blocking: true,
    });
  } else {
    checks.push({
      name: 'Angular',
      status: 'pass',
      detail: `${workspace.angularVersion}${workspace.primaryProject ? `, project "${workspace.primaryProject.name}"` : ''}`,
      blocking: true,
    });
  }

  /* ---- 4. installed? ---- */
  const nodeModules = path.join(root, 'node_modules');
  const installed = fs.existsSync(nodeModules);
  checks.push({
    name: 'Dependencies',
    status: installed ? 'pass' : 'fail',
    detail: installed ? 'node_modules is present.' : 'node_modules is missing.',
    ...(installed ? {} : { fix: `Run npm install in ${root} first. Nothing can compile without it.` }),
    blocking: true,
  });

  /* ---- 5. can it be built? ---- */
  const buildScript = scripts.includes('build') ? 'build' : undefined;
  checks.push({
    name: 'Build script',
    status: buildScript !== undefined ? 'pass' : 'warn',
    detail:
      buildScript !== undefined
        ? `npm run build -> ${pkg.scripts?.['build'] ?? ''}`
        : 'No "build" script in package.json.',
    ...(buildScript !== undefined
      ? {}
      : {
          fix:
            'Compiling will be skipped. Everything else still works - the browser ' +
            'measurement runs against your served app, not a build.',
        }),
    blocking: false,
  });

  /* ---- 6. git, because fixing needs an undo ---- */
  const isRepo = fs.existsSync(path.join(root, '.git'));
  checks.push({
    name: 'Git repository',
    status: isRepo ? 'pass' : 'warn',
    detail: isRepo ? 'Changes can be reviewed and undone.' : 'This folder is not a git repository.',
    ...(isRepo
      ? {}
      : {
          fix:
            'Reading and measuring still work. Applying a fix does not: the tool will not ' +
            'write to code it cannot help you undo.',
        }),
    blocking: false,
  });

  /* ---- 7. has it been compiled? ---- */
  const outputPath = workspace.primaryProject?.outputPath ?? guessOutputPath(root);
  const output = outputPath === undefined ? undefined : path.join(root, outputPath);
  const compiledAt = output === undefined ? undefined : newestFileTime(output, 2);
  const compiled = compiledAt !== undefined;

  let compiledOutOfDate: boolean | undefined;
  if (compiled && compiledAt !== undefined) {
    const sourceRoot = path.join(root, workspace.primaryProject?.sourceRoot ?? 'src');
    const newestSource = newestFileTime(sourceRoot, 4);
    compiledOutOfDate = newestSource !== undefined && newestSource > compiledAt;
  }

  checks.push({
    name: 'Compiled output',
    status: compiled ? (compiledOutOfDate === true ? 'warn' : 'pass') : 'warn',
    detail: compiled
      ? compiledOutOfDate === true
        ? `${outputPath ?? 'output'} exists but your source is newer.`
        : `${outputPath ?? 'output'}, built ${describeAge(compiledAt)}.`
      : `Nothing built yet${outputPath !== undefined ? ` in ${outputPath}` : ''}.`,
    ...(compiled && compiledOutOfDate !== true
      ? {}
      : { fix: 'Compile it below, or do it yourself and press "check again".' }),
    blocking: false,
  });

  const usable = !checks.some((c) => c.blocking && c.status === 'fail');

  return {
    root,
    usable,
    checks,
    ...(pkg.name !== undefined ? { packageName: pkg.name } : {}),
    ...(workspace.angularVersion !== undefined
      ? { angularVersion: workspace.angularVersion }
      : {}),
    scripts,
    ...(buildScript !== undefined ? { buildScript } : {}),
    ...(outputPath !== undefined ? { outputPath } : {}),
    compiled,
    ...(compiledAt !== undefined ? { compiledAt } : {}),
    ...(compiledOutOfDate !== undefined ? { compiledOutOfDate } : {}),
    ...(ngMajor !== undefined ? {} : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Did they pick the parent of the project by mistake?
 *
 * A very common slip - choosing io-sense when the project is
 * io-sense/IOSense. Saying "no package.json here" and stopping is correct
 * and unhelpful when the answer is one folder down.
 */
function suggestSubfolder(root: string): string | undefined {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const candidates = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(root, name, 'package.json')))
    .slice(0, 3);

  if (candidates.length === 0) return undefined;
  return `No package.json here, but there is one in: ${candidates.join(', ')}. Did you mean one of those?`;
}

/** Where angular.json would put a build, when it does not say. */
function guessOutputPath(root: string): string | undefined {
  for (const candidate of ['dist', 'build', 'www']) {
    if (fs.existsSync(path.join(root, candidate))) return candidate;
  }
  return 'dist';
}

/**
 * Modification time of the newest file under a directory.
 *
 * Depth-limited on purpose: a full walk of a built Angular app is tens of
 * thousands of files, and this only needs to know roughly how fresh the
 * output is.
 */
function newestFileTime(dir: string, maxDepth: number): number | undefined {
  let newest: number | undefined;
  let budget = 3000;

  const walk = (current: string, depth: number): void => {
    if (depth > maxDepth || budget <= 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (budget-- <= 0) return;
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      try {
        const time = fs.statSync(full).mtimeMs;
        if (newest === undefined || time > newest) newest = time;
      } catch {
        /* unreadable file - skip */
      }
    }
  };

  walk(dir, 0);
  return newest;
}

function describeAge(time: number | undefined): string {
  if (time === undefined) return 'at an unknown time';
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
