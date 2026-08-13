/**
 * Phase 2 scanner tests.
 *
 * These build a tiny fake Angular project in a temp folder and scan it.
 * Testing against a fixture rather than the real IOSense app means:
 *   - the tests are fast and deterministic
 *   - they still pass if IOSense changes or is unavailable
 *   - we can create the exact edge cases we care about on purpose
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { scanProject, ScanError } from '../src/scanner';
import { classifyAngularClasses } from '../src/scanner/classify';
import { detectRiskyLibraries } from '../src/scanner/libraries';
import { parseSourceFile, isParseFailure } from '../src/scanner/parse';
import { isTestFile, walkDirectory } from '../src/scanner/walk';
import { majorVersion, supportedCleanupIdioms } from '../src/scanner/workspace';

/* ------------------------------------------------------------------ */
/* Fixture helpers                                                     */
/* ------------------------------------------------------------------ */

let fixtureRoot: string;

function write(relativePath: string, contents: string): void {
  const full = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
}

beforeAll(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-agent-fixture-'));

  write(
    'package.json',
    JSON.stringify({
      name: 'fixture-app',
      version: '1.2.3',
      scripts: { build: 'ng build', test: 'jest' },
      dependencies: {
        '@angular/core': '15.2.10',
        rxjs: '^6.3.3',
        // Deliberately duplicated to lock in the precedence bug fix.
        'zone.js': '~0.11.4',
        highcharts: '^11.4.0',
        echarts: '^4.9.0',
      },
      devDependencies: {
        typescript: '^4.8.4',
        jest: '^29.0.0',
        // Stale duplicate - dependencies must win over this.
        'zone.js': '^0.8.26',
      },
    }),
  );

  write(
    'angular.json',
    JSON.stringify({
      version: 1,
      projects: {
        'fixture-app': {
          root: '',
          sourceRoot: 'src',
          projectType: 'application',
          architect: {
            build: {
              builder: '@angular-devkit/build-angular:browser',
              options: { main: 'src/main.ts', tsConfig: 'src/tsconfig.app.json' },
            },
          },
        },
        'fixture-app-e2e': { root: 'e2e', projectType: 'application' },
      },
    }),
  );

  // A component that cleans up properly.
  write(
    'src/app/good/good.component.ts',
    `import { Component, OnInit, OnDestroy } from '@angular/core';
     import { Subscription } from 'rxjs';
     @Component({ selector: 'app-good', template: '' })
     export class GoodComponent implements OnInit, OnDestroy {
       private sub = new Subscription();
       ngOnInit(): void {}
       ngOnDestroy(): void { this.sub.unsubscribe(); }
     }`,
  );

  // A component with no cleanup hook at all.
  write(
    'src/app/leaky/leaky.component.ts',
    `import { Component, OnInit } from '@angular/core';
     @Component({ selector: 'app-leaky', template: '' })
     export class LeakyComponent implements OnInit {
       ngOnInit(): void { setInterval(() => {}, 1000); }
     }`,
  );

  // THE IMPORTANT EDGE CASE: a component whose FILENAME does not say
  // "component". A filename-based scanner misses this entirely.
  write(
    'src/app/oddly-named/widget.ts',
    `import { Component } from '@angular/core';
     @Component({ selector: 'app-widget', template: '', standalone: true })
     export class WidgetComponent {}`,
  );

  // Two components in one file - counting FILES would undercount.
  write(
    'src/app/pair/pair.component.ts',
    `import { Component } from '@angular/core';
     @Component({ selector: 'app-first', template: '' })
     export class FirstComponent {}
     @Component({ selector: 'app-second', template: '' })
     export class SecondComponent {}`,
  );

  // Declares OnDestroy but never writes the method - a real, common bug.
  write(
    'src/app/liar/liar.component.ts',
    `import { Component, OnDestroy } from '@angular/core';
     @Component({ selector: 'app-liar', template: '' })
     export class LiarComponent implements OnDestroy {}`,
  );

  write(
    'src/app/core/data.service.ts',
    `import { Injectable } from '@angular/core';
     @Injectable({ providedIn: 'root' })
     export class DataService {}`,
  );

  write(
    'src/app/app.module.ts',
    `import { NgModule } from '@angular/core';
     @NgModule({ declarations: [] })
     export class AppModule {}`,
  );

  write(
    'src/app/shared/truncate.pipe.ts',
    `import { Pipe, PipeTransform } from '@angular/core';
     @Pipe({ name: 'truncate' })
     export class TruncatePipe implements PipeTransform { transform(v: string) { return v; } }`,
  );

  // A test file - must be counted separately from shipped code.
  write(
    'src/app/good/good.component.spec.ts',
    `import { Component } from '@angular/core';
     @Component({ selector: 'app-test-only', template: '' })
     export class TestOnlyComponent {}`,
  );

  // A plain interface file with no Angular class at all.
  write('src/app/models/user.model.ts', `export interface User { id: string; }`);

  // Must be pruned, never scanned.
  write(
    'node_modules/evil/index.ts',
    `import { Component } from '@angular/core';
     @Component({ selector: 'evil', template: '' })
     export class EvilComponent {}`,
  );
  write(
    '.angular/cache/stale.component.ts',
    `import { Component } from '@angular/core';
     @Component({ selector: 'stale', template: '' })
     export class StaleComponent {}`,
  );
});

afterAll(() => {
  if (fixtureRoot && fs.existsSync(fixtureRoot)) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* walk                                                                */
/* ------------------------------------------------------------------ */

describe('walkDirectory', () => {
  it('prunes node_modules and .angular instead of descending into them', () => {
    const result = walkDirectory(fixtureRoot, { extensions: ['.ts'] });
    const joined = result.files.join('|');
    expect(joined).not.toContain('node_modules');
    expect(joined).not.toContain('.angular');
    expect(result.directoriesPruned.length).toBeGreaterThan(0);
  });

  it('returns files in a stable sorted order', () => {
    const a = walkDirectory(fixtureRoot, { extensions: ['.ts'] }).files;
    const b = walkDirectory(fixtureRoot, { extensions: ['.ts'] }).files;
    expect(a).toEqual(b);
    expect([...a].sort()).toEqual(a);
  });

  it('respects maxFiles and reports truncation honestly', () => {
    const result = walkDirectory(fixtureRoot, { extensions: ['.ts'], maxFiles: 2 });
    expect(result.truncated).toBe(true);
    expect(result.files.length).toBeLessThanOrEqual(2);
  });
});

describe('isTestFile', () => {
  it.each([
    ['/src/app/x.spec.ts', true],
    ['/src/app/x.test.ts', true],
    ['/src/__mocks__/y.ts', true],
    ['/src/testing/z.ts', true],
    ['/src/app/x.component.ts', false],
    ['/src/app/latest.ts', false],
  ])('%s -> %s', (input, expected) => {
    expect(isTestFile(input)).toBe(expected);
  });
});

/* ------------------------------------------------------------------ */
/* classify                                                            */
/* ------------------------------------------------------------------ */

describe('classifyAngularClasses', () => {
  function classesIn(source: string) {
    const tmp = path.join(fixtureRoot, 'src', 'app', '__tmp.ts');
    fs.writeFileSync(tmp, source, 'utf8');
    const parsed = parseSourceFile(tmp, 'src/app/__tmp.ts');
    if (isParseFailure(parsed)) throw new Error(parsed.reason);
    const classes = classifyAngularClasses(parsed.sourceFile, 'src/app/__tmp.ts');
    fs.rmSync(tmp, { force: true });
    return classes;
  }

  it('reads the selector and standalone flag from the decorator', () => {
    const [cls] = classesIn(
      `import { Component } from '@angular/core';
       @Component({ selector: 'app-x', standalone: true, template: '' })
       export class XComponent {}`,
    );
    expect(cls?.kind).toBe('Component');
    expect(cls?.selector).toBe('app-x');
    expect(cls?.standalone).toBe(true);
  });

  it('refuses to guess a selector that is not a literal', () => {
    // Honesty over convenience: an unknown selector is reported as unknown.
    const [cls] = classesIn(
      `import { Component } from '@angular/core';
       const SEL = 'app-computed';
       @Component({ selector: SEL, template: '' })
       export class ComputedComponent {}`,
    );
    expect(cls?.selector).toBeUndefined();
  });

  it('separates "implements OnDestroy" from "has an ngOnDestroy method"', () => {
    const [cls] = classesIn(
      `import { Component, OnDestroy } from '@angular/core';
       @Component({ selector: 'app-liar', template: '' })
       export class LiarComponent implements OnDestroy {}`,
    );
    expect(cls?.declaresOnDestroyInterface).toBe(true);
    expect(cls?.hasOnDestroyMethod).toBe(false);
  });

  it('records lifecycle hooks that are actually implemented', () => {
    const [cls] = classesIn(
      `import { Component } from '@angular/core';
       @Component({ selector: 'app-h', template: '' })
       export class HComponent {
         ngOnInit() {}
         ngAfterViewInit() {}
         helper() {}
       }`,
    );
    expect(cls?.lifecycleHooks).toEqual(['ngOnInit', 'ngAfterViewInit']);
    expect(cls?.methods).toContain('helper');
  });

  it('reads providedIn from @Injectable', () => {
    const [cls] = classesIn(
      `import { Injectable } from '@angular/core';
       @Injectable({ providedIn: 'root' })
       export class SvcService {}`,
    );
    expect(cls?.kind).toBe('Injectable');
    expect(cls?.providedIn).toBe('root');
  });

  it('ignores classes with no Angular decorator', () => {
    expect(classesIn(`export class Plain {}`)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* libraries                                                           */
/* ------------------------------------------------------------------ */

describe('detectRiskyLibraries', () => {
  it('finds known libraries and reports their real teardown API', () => {
    const found = detectRiskyLibraries({ highcharts: '^11.4.0', echarts: '^4.9.0' });
    expect(found.map((l) => l.name).sort()).toEqual(['echarts', 'highcharts']);
    expect(found.find((l) => l.name === 'highcharts')?.disposalApi).toContain('destroy');
  });

  it('ignores dependencies it knows nothing about', () => {
    expect(detectRiskyLibraries({ lodash: '^4.0.0' })).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* workspace version logic                                             */
/* ------------------------------------------------------------------ */

describe('cleanup idioms', () => {
  it('excludes takeUntilDestroyed on Angular 15, because it does not exist there', () => {
    const idioms = supportedCleanupIdioms({
      rootDir: '',
      hasAngularJson: true,
      projects: [],
      scripts: {},
      testRunner: 'jest',
      hasEslint: true,
      angularVersion: '15.2.10',
    });
    expect(idioms.join(' ')).not.toContain('takeUntilDestroyed');
    expect(idioms.join(' ')).toContain('takeUntil(this.destroy$)');
  });

  it('offers takeUntilDestroyed on Angular 16+', () => {
    const idioms = supportedCleanupIdioms({
      rootDir: '',
      hasAngularJson: true,
      projects: [],
      scripts: {},
      testRunner: 'jest',
      hasEslint: true,
      angularVersion: '17.1.0',
    });
    expect(idioms.join(' ')).toContain('takeUntilDestroyed');
  });

  it('parses major versions from npm ranges', () => {
    expect(majorVersion('15.2.10')).toBe(15);
    expect(majorVersion(undefined)).toBeUndefined();
    expect(majorVersion('not-a-version')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* end-to-end scan                                                     */
/* ------------------------------------------------------------------ */

describe('scanProject', () => {
  it('rejects a path that does not exist', () => {
    expect(() => scanProject(path.join(fixtureRoot, 'nope'))).toThrow(ScanError);
  });

  it('reads workspace metadata', () => {
    const r = scanProject(fixtureRoot);
    expect(r.workspace.packageName).toBe('fixture-app');
    expect(r.workspace.angularVersion).toBe('15.2.10');
    expect(r.workspace.rxjsVersion).toBe('6.3.3');
    expect(r.workspace.testRunner).toBe('jest');
    expect(r.workspace.primaryProject?.name).toBe('fixture-app');
  });

  it('REGRESSION: dependencies win over devDependencies for duplicated packages', () => {
    // IOSense declares zone.js as ~0.11.4 (dependencies) and ^0.8.26
    // (devDependencies). Spreading devDependencies last reported 0.8.26,
    // which is wrong. dependencies is the version that actually ships.
    const r = scanProject(fixtureRoot);
    expect(r.workspace.zoneJsVersion).toBe('0.11.4');
    expect(r.warnings.join(' ')).toContain('zone.js');
    expect(r.warnings.join(' ')).toContain('declared in both');
  });

  it('finds a component whose filename does not contain "component"', () => {
    const r = scanProject(fixtureRoot);
    const widget = r.files
      .flatMap((f) => f.classes)
      .find((c) => c.className === 'WidgetComponent');
    expect(widget).toBeDefined();
    expect(widget?.file).toBe('src/app/oddly-named/widget.ts');
  });

  it('counts CLASSES not FILES, so two components in one file count twice', () => {
    const r = scanProject(fixtureRoot);
    const pair = r.files.find((f) => f.path === 'src/app/pair/pair.component.ts');
    expect(pair?.classes).toHaveLength(2);
  });

  it('never scans node_modules or .angular', () => {
    const r = scanProject(fixtureRoot);
    const names = r.files.flatMap((f) => f.classes).map((c) => c.className);
    expect(names).not.toContain('EvilComponent');
    expect(names).not.toContain('StaleComponent');
  });

  it('excludes test components from the cleanup-coverage counts', () => {
    const r = scanProject(fixtureRoot);
    const total = r.summary.componentsWithOnDestroy + r.summary.componentsWithoutOnDestroy;
    // 6 non-test components: Good, Leaky, Widget, First, Second, Liar.
    // TestOnlyComponent lives in a .spec.ts and must not be counted.
    expect(total).toBe(6);
    expect(r.summary.componentsWithOnDestroy).toBe(1); // only GoodComponent
    expect(r.summary.testFiles).toBe(1);
  });

  it('can exclude test files entirely with includeTests: false', () => {
    const r = scanProject(fixtureRoot, { includeTests: false });
    expect(r.summary.testFiles).toBe(0);
    expect(r.files.some((f) => f.path.endsWith('.spec.ts'))).toBe(false);
  });

  it('detects risky libraries from the fixture package.json', () => {
    const r = scanProject(fixtureRoot);
    expect(r.riskyLibraries.map((l) => l.name).sort()).toEqual(['echarts', 'highcharts']);
  });

  it('records imports per file', () => {
    const r = scanProject(fixtureRoot);
    const good = r.files.find((f) => f.path === 'src/app/good/good.component.ts');
    expect(good?.imports).toContain('@angular/core');
    expect(good?.imports).toContain('rxjs');
  });

  it('produces a self-describing, serialisable result', () => {
    const r = scanProject(fixtureRoot);
    expect(r.schemaVersion).toBe(1);
    expect(typeof r.durationMs).toBe('number');
    expect(() => JSON.parse(JSON.stringify(r))).not.toThrow();
  });
});
