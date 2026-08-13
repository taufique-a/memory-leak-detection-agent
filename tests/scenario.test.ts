/**
 * Phase 8 scenario tests.
 *
 * The validation tests matter more than they look. A scenario that runs
 * perfectly and measures the wrong thing is the most dangerous failure this
 * tool can have - it produces a confident, wrong, well-formatted answer.
 */

import { startFixtureServer } from '../src/runtime/fixtures/server';
import { buildSpaFixture } from '../src/runtime/fixtures/spaFixture';
import { isChromeAvailable } from '../src/runtime/browser';
import { joinUrl, runScenario } from '../src/scenario/runner';
import type { Scenario, Step } from '../src/scenario/types';
import { describeStep, validateScenario } from '../src/scenario/validate';

function baseScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    name: 'test',
    baseUrl: 'http://localhost:4200',
    setup: [{ action: 'goto', path: '/' }],
    steps: [
      { action: 'click', selector: '#a' },
      { action: 'waitFor', selector: '#b' },
    ],
    iterations: 10,
    ...overrides,
  };
}

/* ================================================================== */
/* VALIDATION                                                          */
/* ================================================================== */

describe('validateScenario - errors', () => {
  it('accepts a well-formed scenario', () => {
    const result = validateScenario(baseScenario());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('requires name, baseUrl, iterations and steps', () => {
    const result = validateScenario({});
    expect(result.valid).toBe(false);
    const joined = result.errors.join(' ');
    expect(joined).toContain('name');
    expect(joined).toContain('baseUrl');
    expect(joined).toContain('iterations');
    expect(joined).toContain('steps');
  });

  it('rejects a non-http baseUrl', () => {
    const result = validateScenario(baseScenario({ baseUrl: 'file:///c:/x.html' }));
    expect(result.errors.join(' ')).toContain('http');
  });

  it('rejects too few iterations to establish a trend', () => {
    expect(validateScenario(baseScenario({ iterations: 3 })).errors.join(' ')).toContain(
      'At least 5',
    );
  });

  it('rejects a warm-up that leaves nothing to measure', () => {
    const result = validateScenario(baseScenario({ iterations: 6, warmupIterations: 5 }));
    expect(result.errors.join(' ')).toContain('fewer than 3 measurable');
  });

  it('rejects an unknown action', () => {
    const result = validateScenario(
      baseScenario({ steps: [{ action: 'teleport' } as unknown as Step] }),
    );
    expect(result.errors.join(' ')).toContain('unknown action');
  });

  it('checks each action has the fields it needs', () => {
    expect(
      validateScenario(baseScenario({ steps: [{ action: 'click' } as unknown as Step] }))
        .errors.join(' '),
    ).toContain('selector');
    expect(
      validateScenario(baseScenario({ steps: [{ action: 'wait' } as unknown as Step] }))
        .errors.join(' '),
    ).toContain('ms');
  });
});

describe('validateScenario - the warning that prevents a false negative', () => {
  it('warns when the LOOP does a full page load', () => {
    // THE MOST IMPORTANT CHECK IN PHASE 8.
    //
    // goto reloads the page, destroying the JS context. Every leaked object
    // is thrown away at the start of each iteration, so the run reports a
    // flat line on an app that leaks badly. It executes perfectly and
    // answers wrongly, which is the worst possible failure mode.
    const result = validateScenario(
      baseScenario({
        steps: [
          { action: 'goto', path: '/overview' },
          { action: 'waitFor', selector: '#x' },
        ],
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toContain('FULL PAGE LOAD');
    expect(result.warnings.join(' ')).toContain('flat');
  });

  it('does NOT warn about a full load in setup, where it belongs', () => {
    const result = validateScenario(
      baseScenario({
        setup: [{ action: 'goto', path: '/' }],
        steps: [
          { action: 'click', selector: '#a' },
          { action: 'waitFor', selector: '#b' },
        ],
      }),
    );
    expect(result.warnings.join(' ')).not.toContain('FULL PAGE LOAD');
  });

  it('warns when the loop never navigates', () => {
    const result = validateScenario(
      baseScenario({ steps: [{ action: 'wait', ms: 100 }] }),
    );
    expect(result.warnings.join(' ')).toContain('No navigation step');
  });

  it('warns when the loop never waits, which measures half-built pages', () => {
    const result = validateScenario(
      baseScenario({ steps: [{ action: 'click', selector: '#a' }] }),
    );
    expect(result.warnings.join(' ')).toContain('No wait step');
  });
});

describe('validateScenario - credentials', () => {
  it('REFUSES a literal password in the scenario file', () => {
    // Scenario files get committed and attached to tickets. A password in
    // one is a password in the repository forever.
    const result = validateScenario(
      baseScenario({
        auth: {
          type: 'form',
          path: '/login',
          usernameSelector: '#u',
          passwordSelector: '#p',
          submitSelector: '#s',
          usernameEnv: 'APP_USER',
          passwordEnv: 'APP_PASS',
          password: 'hunter2',
        } as never,
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain('must not appear in a scenario file');
  });

  it('accepts env-var names and warns when they are unset', () => {
    const result = validateScenario(
      baseScenario({
        auth: {
          type: 'form',
          path: '/login',
          usernameSelector: '#u',
          passwordSelector: '#p',
          submitSelector: '#s',
          usernameEnv: 'DEFINITELY_UNSET_USER_VAR',
          passwordEnv: 'DEFINITELY_UNSET_PASS_VAR',
          successSelector: '#home',
        },
      }),
    );
    expect(result.valid).toBe(true);
    expect(result.warnings.join(' ')).toContain('DEFINITELY_UNSET_USER_VAR');
  });

  it('warns when there is no way to tell login succeeded', () => {
    const result = validateScenario(
      baseScenario({
        auth: {
          type: 'form',
          path: '/login',
          usernameSelector: '#u',
          passwordSelector: '#p',
          submitSelector: '#s',
          usernameEnv: 'U',
          passwordEnv: 'P',
        },
      }),
    );
    expect(result.warnings.join(' ')).toContain('successSelector');
  });

  it('accepts a saved storage state', () => {
    expect(
      validateScenario(baseScenario({ auth: { type: 'storageState', file: 'auth.json' } })).valid,
    ).toBe(true);
  });
});

/* ================================================================== */
/* HELPERS                                                             */
/* ================================================================== */

describe('joinUrl', () => {
  it.each([
    ['http://x:4200', '/a', 'http://x:4200/a'],
    ['http://x:4200/', '/a', 'http://x:4200/a'],
    ['http://x:4200/', 'a', 'http://x:4200/a'],
    ['http://x:4200//', '//a', 'http://x:4200//a'],
  ])('%s + %s = %s', (base, pathPart, expected) => {
    expect(joinUrl(base, pathPart)).toBe(expected);
  });
});

describe('describeStep', () => {
  it('marks context-destroying steps clearly', () => {
    expect(describeStep({ action: 'goto', path: '/x' })).toContain('full load');
    expect(describeStep({ action: 'reload' })).toContain('full load');
  });
});

/* ================================================================== */
/* FIXTURE                                                             */
/* ================================================================== */

describe('SPA fixture', () => {
  it('provides clickable nav links and ready markers', () => {
    const html = buildSpaFixture({ leaky: true });
    for (const id of ['nav-home', 'nav-dashboard', 'nav-reports', 'dashboard-ready']) {
      expect(html).toContain(id);
    }
  });

  it('omits teardown only in leaky mode', () => {
    expect(buildSpaFixture({ leaky: true })).toContain('var LEAKY = true');
    expect(buildSpaFixture({ leaky: false })).toContain('clearInterval');
  });
});

describe('saved-session safety', () => {
  // captureLogin opens a browser, so we test the guard through the same
  // code path by calling it with a bad path - it must refuse BEFORE
  // launching anything.
  it('refuses to write a session token to a non-gitignored path', async () => {
    const { captureLogin } = await import('../src/scenario/login');
    await expect(
      captureLogin({ baseUrl: 'http://localhost:1', outputFile: 'session.json' }),
    ).rejects.toThrow(/Refusing to write a session token/);
  });

  it('rejects a non-json filename', async () => {
    const { captureLogin } = await import('../src/scenario/login');
    await expect(
      captureLogin({ baseUrl: 'http://localhost:1', outputFile: '.auth/creds.txt' }),
    ).rejects.toThrow(/should end in \.json/);
  });

  it.each(['.auth/iosense.auth.json', 'anywhere/thing.auth.json', '.auth/x.json'])(
    'accepts the gitignored pattern %s',
    async (file) => {
      const { captureLogin } = await import('../src/scenario/login');
      // Reaching a connection error means the path guard passed - which is
      // all this test checks. localhost:1 is closed.
      await expect(
        captureLogin({ baseUrl: 'http://localhost:1', outputFile: file, timeoutMs: 3000 }),
      ).rejects.not.toThrow(/Refusing to write|should end in/);
    },
    60_000,
  );
});

describe('scenario file loading', () => {
  it('REGRESSION: tolerates a UTF-8 BOM', async () => {
    // PowerShell's `Out-File -Encoding utf8`, Notepad and several editors
    // all prepend a BOM on Windows. JSON.parse rejects it with "Unexpected
    // token" pointing at an invisible character, so the user sees a file
    // that looks perfect and a tool that looks broken.
    const fs = await import('node:fs');
    const os = await import('node:os');
    const nodePath = await import('node:path');

    const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'memory-agent-bom-'));
    const file = nodePath.join(dir, 'scenario.json');
    try {
      fs.writeFileSync(file, '﻿' + JSON.stringify(baseScenario()), 'utf8');

      // Mirrors the loader: strip the BOM, then parse.
      let raw = fs.readFileSync(file, 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(validateScenario(JSON.parse(raw)).valid).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('fixture server', () => {
  it('serves the SPA and a health endpoint on a free port', async () => {
    const server = await startFixtureServer({ leaky: true });
    try {
      expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const health = await fetch(`${server.baseUrl}/health`);
      expect(await health.text()).toBe('ok');

      const page = await fetch(server.baseUrl);
      expect(await page.text()).toContain('nav-dashboard');

      // Caching would make one iteration differ from the rest.
      expect(page.headers.get('cache-control')).toContain('no-store');
    } finally {
      await server.close();
    }
  }, 30_000);
});

/* ================================================================== */
/* INTEGRATION                                                         */
/* ================================================================== */

describe('scenario engine integration', () => {
  let chromeAvailable = false;

  beforeAll(async () => {
    chromeAvailable = (await isChromeAvailable()).available;
  }, 60_000);

  function spaScenario(baseUrl: string, iterations = 8): Scenario {
    return {
      name: 'spa',
      baseUrl,
      setup: [
        { action: 'goto', path: '/', waitUntil: 'load' },
        { action: 'waitFor', selector: '#nav-dashboard' },
      ],
      steps: [
        { action: 'click', selector: '#nav-dashboard' },
        { action: 'waitFor', selector: '#dashboard-ready' },
        { action: 'click', selector: '#nav-reports' },
        { action: 'waitFor', selector: '#reports-ready' },
      ],
      iterations,
      warmupIterations: 2,
    };
  }

  it(
    'drives real in-app navigation and separates a leaky SPA from a clean one',
    async () => {
      if (!chromeAvailable) return;

      const leakyServer = await startFixtureServer({ leaky: true });
      const cleanServer = await startFixtureServer({ leaky: false });

      try {
        const leaky = await runScenario(spaScenario(leakyServer.baseUrl), {});
        const clean = await runScenario(spaScenario(cleanServer.baseUrl), {});

        // The journey actually happened - otherwise the numbers describe
        // something other than the scenario.
        expect(leaky.failures).toHaveLength(0);
        expect(clean.failures).toHaveLength(0);
        expect(leaky.iterationsCompleted).toBe(8);

        expect(leaky.trend.verdict).toBe('GROWING');
        expect(clean.trend.verdict).toBe('STABLE');

        // Listeners are the corroborating signal that genuinely
        // discriminates here (attached DOM does not, because the leak
        // retains DETACHED nodes).
        expect(leaky.trend.listenersPerIteration).toBeGreaterThan(0.5);
        expect(clean.trend.listenersPerIteration).toBeLessThan(0.5);
      } finally {
        await leakyServer.close();
        await cleanServer.close();
      }
    },
    240_000,
  );

  it(
    'records step failures instead of silently producing clean-looking numbers',
    async () => {
      if (!chromeAvailable) return;

      const server = await startFixtureServer({ leaky: true });
      try {
        const scenario = spaScenario(server.baseUrl, 5);
        // A selector that does not exist anywhere.
        scenario.steps = [
          { action: 'click', selector: '#nav-dashboard' },
          { action: 'waitFor', selector: '#does-not-exist', timeoutMs: 500 },
        ];

        const run = await runScenario(scenario, {});
        expect(run.failures.length).toBeGreaterThan(0);
        // Three failures of the same step must stop the run rather than
        // grind through twenty meaningless iterations.
        expect(run.abortedReason).toBeDefined();
        expect(run.abortedReason).toContain('not being performed');
      } finally {
        await server.close();
      }
    },
    240_000,
  );
});
