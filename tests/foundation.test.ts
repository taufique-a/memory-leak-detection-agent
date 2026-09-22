/**
 * Phase 1 foundation tests.
 *
 * These are deliberately simple. Their job is NOT to test memory-leak logic
 * (there isn't any yet) - it is to prove the toolchain works end to end:
 *
 *   TypeScript compiles  ->  Jest runs  ->  our modules import  ->  CLI works
 *
 * Once these pass, any future failure is a logic bug, not a setup bug.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { AGENT_NAME, AGENT_VERSION, buildInfo, versionString } from '../src/version';
import {
  CONFIDENCE_LEVELS,
  EVIDENCE_LEVELS,
  INVESTIGATION_STATUSES,
  RISK_LEVELS,
} from '../src/types';
import { run } from '../src/cli';

describe('toolchain', () => {
  it('runs on Node 20 or newer (not the system Node 14)', () => {
    const major = Number(process.version.replace('v', '').split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(20);
  });

  it('can load the TypeScript Compiler API that Phase 3 depends on', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const ts = require('typescript');
    expect(typeof ts.createSourceFile).toBe('function');
    expect(typeof ts.forEachChild).toBe('function');
    expect(ts.SyntaxKind).toBeDefined();
    // TypeScript 7 removed the JS Compiler API. Guard against an accidental
    // upgrade silently destroying the static analyzer.
    expect(Number(ts.versionMajorMinor.split('.')[0])).toBeLessThan(7);
  });
});

describe('version', () => {
  it('formats a readable version string', () => {
    expect(versionString()).toBe(`${AGENT_NAME} v${AGENT_VERSION}`);
  });

  it('stays in sync with package.json', () => {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
      name: string;
      version: string;
    };
    expect(pkg.name).toBe(AGENT_NAME);
    expect(pkg.version).toBe(AGENT_VERSION);
  });

  it('reports real environment info', () => {
    const info = buildInfo();
    expect(info.node).toBe(process.version);
    expect(info.platform).toBe(process.platform);
  });
});

describe('core vocabulary', () => {
  it('exposes the six confidence levels', () => {
    expect(CONFIDENCE_LEVELS).toEqual(['PROVEN', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN', 'INCONCLUSIVE']);
  });

  it('separates evidence level from confidence', () => {
    // The core principle: a static suspicion is not a confirmed leak.
    expect(EVIDENCE_LEVELS).toContain('STATIC_SUSPICION');
    expect(EVIDENCE_LEVELS).toContain('CONFIRMED');
    expect(EVIDENCE_LEVELS.indexOf('STATIC_SUSPICION')).toBeLessThan(
      EVIDENCE_LEVELS.indexOf('CONFIRMED'),
    );
  });

  it('includes an honest UNKNOWN in every scale', () => {
    expect(CONFIDENCE_LEVELS).toContain('UNKNOWN');
    expect(EVIDENCE_LEVELS).toContain('UNKNOWN');
    expect(INVESTIGATION_STATUSES).toContain('UNKNOWN');
  });

  it('defines all nine investigation statuses', () => {
    expect(INVESTIGATION_STATUSES).toHaveLength(9);
    expect(INVESTIGATION_STATUSES).toContain('FAILED_VERIFICATION');
  });

  it('defines four risk levels', () => {
    expect(RISK_LEVELS).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
  });
});

describe('cli', () => {
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('prints the version and exits 0', () => {
    const code = run(['node', 'cli.js', '--version']);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(versionString());
  });

  it('prints help when given no arguments', () => {
    const code = run(['node', 'cli.js']);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalled();
  });

  it('every command in the roadmap is now implemented', () => {
    // This test has been rewritten twice, each time because a command it
    // named had graduated - first 'investigate' (Phase 9), then 'verify'
    // (Phase 16). Every roadmap command now exists, so there is nothing
    // left to report as unbuilt. It asserts that state instead.
    for (const command of [
      'scan',
      'analyze',
      'risk',
      'report',
      'investigate',
      'heap',
      'correlate',
      'fix',
      'verify',
    ]) {
      const code = run(['node', 'cli.js', command]);
      // Each should reject its arguments (1), not report itself as
      // unimplemented (2).
      expect(code).not.toBe(2);
    }
  });

  it('rejects an unknown command with exit code 1', () => {
    const code = run(['node', 'cli.js', 'definitely-not-a-command']);
    expect(code).toBe(1);
  });
});
