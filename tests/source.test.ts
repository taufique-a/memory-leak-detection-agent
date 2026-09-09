/**
 * Choosing and checking the source folder.
 *
 * WHY THIS STEP EXISTS
 * --------------------
 * The project path used to be typed by hand. This machine has ELEVEN
 * folders called IOSense across several drives, and pointing the tool at
 * the wrong one produces a completely successful investigation of code you
 * do not care about - the hardest kind of mistake to notice, because
 * nothing fails.
 *
 * The other half is telling somebody WHY a folder will not work. "Invalid
 * project" is useless; "no package.json here, but there is one in IOSense"
 * is the answer.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { browseFolder, findProjectsUnder } from '../src/project/browse';
import { validateSource } from '../src/project/validate';
import { parseCompileArgs } from '../src/commands/compile';

let root: string;

function make(relative: string, contents = ''): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
}

function makeDir(relative: string): void {
  fs.mkdirSync(path.join(root, relative), { recursive: true });
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-source-'));

  /* ---- a complete, usable Angular project ---- */
  make(
    'good/package.json',
    JSON.stringify({
      name: 'good-app',
      scripts: { build: 'ng build', start: 'ng serve', lint: 'ng lint' },
      dependencies: { '@angular/core': '15.2.10' },
    }),
  );
  make(
    'good/angular.json',
    JSON.stringify({
      version: 1,
      projects: {
        app: {
          root: '',
          sourceRoot: 'src',
          architect: { build: { options: { outputPath: 'dist/app' } } },
        },
      },
    }),
  );
  make('good/src/main.ts', 'export const a = 1;\n');
  makeDir('good/node_modules');
  makeDir('good/.git');

  /* ---- the parent, a very common mis-pick ---- */
  makeDir('parent');
  make('parent/inner/package.json', JSON.stringify({ name: 'inner' }));

  /* ---- a node project that is not Angular ---- */
  make('notangular/package.json', JSON.stringify({ name: 'plain', scripts: { build: 'tsc' } }));
  makeDir('notangular/node_modules');

  /* ---- Angular, but nothing installed ---- */
  make(
    'uninstalled/package.json',
    JSON.stringify({ name: 'u', dependencies: { '@angular/core': '15.2.10' } }),
  );

  /* ---- broken package.json ---- */
  make('broken/package.json', '{ this is not json');
});

afterAll(() => {
  if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
});

const statusOf = (folder: string, name: string): string | undefined =>
  validateSource(folder).checks.find((c) => c.name === name)?.status;

describe('a folder that works', () => {
  it('passes every blocking check', () => {
    const v = validateSource(path.join(root, 'good'));
    expect(v.usable).toBe(true);
    for (const check of v.checks) {
      if (check.blocking) expect(check.status).toBe('pass');
    }
  });

  it('reports what it found, so the answer is checkable', () => {
    const v = validateSource(path.join(root, 'good'));
    expect(v.packageName).toBe('good-app');
    expect(v.angularVersion).toBe('15.2.10');
    expect(v.buildScript).toBe('build');
    expect(v.outputPath).toBe('dist/app');
    expect(v.scripts).toEqual(expect.arrayContaining(['build', 'start', 'lint']));
  });

  it('says it has not been compiled when it has not', () => {
    const v = validateSource(path.join(root, 'good'));
    expect(v.compiled).toBe(false);
    expect(statusOf(path.join(root, 'good'), 'Compiled output')).toBe('warn');
  });
});

describe('folders that do not work, and what they say', () => {
  it('a missing folder', () => {
    const v = validateSource(path.join(root, 'nope'));
    expect(v.usable).toBe(false);
    expect(v.checks[0]?.detail).toContain('Nothing exists');
    expect(v.checks[0]?.fix).toContain('browse');
  });

  it('a file rather than a folder', () => {
    const v = validateSource(path.join(root, 'good/package.json'));
    expect(v.usable).toBe(false);
    expect(v.checks[0]?.detail).toContain('is a file, not a folder');
  });

  it('THE COMMON SLIP: the parent of the project', () => {
    /**
     * Choosing io-sense when the project is io-sense/IOSense. Saying "no
     * package.json" and stopping is correct and unhelpful when the answer
     * is one folder down.
     */
    const v = validateSource(path.join(root, 'parent'));
    expect(v.usable).toBe(false);
    const pkg = v.checks.find((c) => c.name === 'package.json');
    expect(pkg?.fix).toContain('inner');
    expect(pkg?.fix).toContain('Did you mean');
  });

  it('unreadable JSON is distinguished from a missing file', () => {
    const v = validateSource(path.join(root, 'broken'));
    const pkg = v.checks.find((c) => c.name === 'package.json');
    expect(pkg?.detail).toContain('could not be read as JSON');
    expect(pkg?.detail).not.toContain('No package.json');
  });

  it('a node project that is not Angular', () => {
    const v = validateSource(path.join(root, 'notangular'));
    expect(v.usable).toBe(false);
    expect(statusOf(path.join(root, 'notangular'), 'Angular')).toBe('fail');
  });

  it('Angular with nothing installed says to run npm install', () => {
    const v = validateSource(path.join(root, 'uninstalled'));
    expect(v.usable).toBe(false);
    const deps = v.checks.find((c) => c.name === 'Dependencies');
    expect(deps?.status).toBe('fail');
    expect(deps?.fix).toContain('npm install');
  });
});

describe('warnings that must NOT block', () => {
  it('no git repository is a warning, not a stop', () => {
    // Reading and measuring work fine without git. Only applying needs it.
    const v = validateSource(path.join(root, 'good'));
    fs.rmSync(path.join(root, 'good/.git'), { recursive: true, force: true });
    const after = validateSource(path.join(root, 'good'));
    fs.mkdirSync(path.join(root, 'good/.git'), { recursive: true });

    expect(v.usable).toBe(true);
    expect(after.usable).toBe(true);
    expect(after.checks.find((c) => c.name === 'Git repository')?.status).toBe('warn');
  });

  it('no build script is a warning, not a stop', () => {
    make('nobuild/package.json', JSON.stringify({ name: 'n', dependencies: { '@angular/core': '15' } }));
    makeDir('nobuild/node_modules');
    const v = validateSource(path.join(root, 'nobuild'));
    expect(v.usable).toBe(true);
    expect(v.checks.find((c) => c.name === 'Build script')?.status).toBe('warn');
    expect(v.buildScript).toBeUndefined();
  });

  it('every non-passing check says what to do about it', () => {
    for (const folder of ['parent', 'notangular', 'uninstalled', 'nobuild']) {
      for (const check of validateSource(path.join(root, folder)).checks) {
        if (check.status !== 'pass') expect(check.fix).toBeTruthy();
      }
    }
  });
});

describe('detecting a stale build', () => {
  it('notices when the source is newer than the output', async () => {
    // A build from before your last edit is worse than none: it looks
    // ready and does not contain the code you are about to investigate.
    make('stale/package.json', JSON.stringify({ name: 's', scripts: { build: 'ng build' }, dependencies: { '@angular/core': '15' } }));
    make('stale/angular.json', JSON.stringify({ version: 1, projects: { app: { root: '', sourceRoot: 'src', architect: { build: { options: { outputPath: 'dist' } } } } } }));
    makeDir('stale/node_modules');
    make('stale/dist/index.html', '<html></html>');

    await new Promise((r) => setTimeout(r, 30));
    make('stale/src/main.ts', 'export const changed = 2;\n');

    const v = validateSource(path.join(root, 'stale'));
    expect(v.compiled).toBe(true);
    expect(v.compiledOutOfDate).toBe(true);
    expect(v.checks.find((c) => c.name === 'Compiled output')?.status).toBe('warn');
  });
});

describe('browsing for the folder', () => {
  it('lists sub-folders and marks the projects', () => {
    const result = browseFolder(root);
    const names = result.entries.map((e) => e.name);
    expect(names).toContain('good');
    expect(result.entries.find((e) => e.name === 'good')?.isAngular).toBe(true);
    expect(result.entries.find((e) => e.name === 'parent')?.isProject).toBe(false);
  });

  it('puts Angular projects first, then other projects', () => {
    const entries = browseFolder(root).entries;
    const firstPlain = entries.findIndex((e) => !e.isProject);
    const lastAngular = entries.map((e) => e.isAngular).lastIndexOf(true);
    if (firstPlain !== -1 && lastAngular !== -1) expect(lastAngular).toBeLessThan(firstPlain);
  });

  it('NEVER lists files, only directories', () => {
    // A browse endpoint that returns file names is a way to read the disk.
    for (const entry of browseFolder(path.join(root, 'good')).entries) {
      expect(fs.statSync(entry.path).isDirectory()).toBe(true);
    }
    expect(browseFolder(path.join(root, 'good')).entries.map((e) => e.name)).not.toContain(
      'package.json',
    );
  });

  it('hides node_modules and dot-folders', () => {
    const names = browseFolder(path.join(root, 'good')).entries.map((e) => e.name);
    expect(names).not.toContain('node_modules');
    expect(names).not.toContain('.git');
  });

  it('offers a way back up and a set of roots', () => {
    const result = browseFolder(path.join(root, 'good'));
    expect(result.parent).toBe(root);
    expect(result.roots.length).toBeGreaterThan(0);
  });

  it('reports an unreadable folder instead of throwing', () => {
    const result = browseFolder(path.join(root, 'does-not-exist'));
    expect(result.error).toBeDefined();
    expect(result.entries).toEqual([]);
  });

  it('finds projects a couple of levels down', () => {
    const found = findProjectsUnder(root, 2, 20).map((e) => e.name);
    expect(found).toContain('good');
    expect(found).toContain('inner');
  });
});

describe('compile arguments', () => {
  it('needs a folder', () => {
    expect(parseCompileArgs([])).toContain('Usage');
  });

  it('accepts a build memory in megabytes', () => {
    const args = parseCompileArgs(['E:/app', '--build-memory', '8192']);
    if (typeof args === 'string') throw new Error(args);
    expect(args.buildMemoryMb).toBe(8192);
    expect(args.projectRoot).toBe('E:/app');
  });

  it('rejects a nonsensical memory value', () => {
    expect(parseCompileArgs(['E:/app', '--build-memory', '12'])).toContain('megabytes');
    expect(parseCompileArgs(['E:/app', '--build-memory', 'lots'])).toContain('megabytes');
  });

  it('leaves the heap alone unless asked', () => {
    const args = parseCompileArgs(['E:/app']);
    if (typeof args === 'string') throw new Error(args);
    expect(args.buildMemoryMb).toBeUndefined();
  });
});

describe('a build that runs out of time, not out of correctness', () => {
  /**
   * IOSense's build was still bundling when the fifteen-minute default
   * expired, and the tool announced "the project does not currently
   * compile". It had said no such thing - it had been stopped mid-work.
   *
   * The same mistake as reporting an out-of-memory abort as a broken
   * build, and with the same consequence: advice to throw away code that
   * was never shown to be wrong.
   */
  it('gives the build long enough by default', () => {
    const args = parseCompileArgs(['E:/app']);
    if (typeof args === 'string') throw new Error(args);
    expect(args.timeoutMs).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('lets the limit be raised', () => {
    const args = parseCompileArgs(['E:/app', '--timeout', '3600']);
    if (typeof args === 'string') throw new Error(args);
    expect(args.timeoutMs).toBe(3_600_000);
  });

  it('rejects a nonsensical timeout', () => {
    expect(parseCompileArgs(['E:/app', '--timeout', '2'])).toContain('seconds');
  });
});
