/**
 * `inspect`'s own argument parsing and its no-framework refusal.
 *
 * The full pipeline (real Chrome, real leak, real correlation) is proven in
 * inspectCommand.test.ts. What belongs here is everything that does not
 * need a browser at all: the CLI contract, and the one failure this
 * command must never paper over - a project with no identifiable
 * framework has nothing for it to correlate against.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseInspectArgs, runInspect } from '../src/commands/inspect';

describe('parseInspectArgs', () => {
  it('requires a project path', () => {
    expect(parseInspectArgs(['--scenario', 'x.json'])).toMatch(/requires a project path/);
  });

  it('requires --scenario', () => {
    expect(parseInspectArgs(['some/project'])).toMatch(/requires --scenario/);
  });

  it('rejects an unknown option', () => {
    expect(parseInspectArgs(['proj', '--scenario', 'x.json', '--bogus'])).toMatch(/Unknown option/);
  });

  it('parses a full, valid set of options', () => {
    const parsed = parseInspectArgs(['proj', '--scenario', 'x.json', '--detail', '5', '--json', 'out.json']);
    expect(parsed).toEqual({
      projectPath: 'proj',
      scenarioFile: 'x.json',
      jsonOut: 'out.json',
      detail: 5,
      proposeFixes: false,
    });
  });

  it('parses --propose-fixes', () => {
    const parsed = parseInspectArgs(['proj', '--scenario', 'x.json', '--propose-fixes']);
    if (typeof parsed === 'string') throw new Error(parsed);
    expect(parsed.proposeFixes).toBe(true);
  });
});

describe('runInspect - no browser needed', () => {
  const cleanup: string[] = [];
  afterAll(() => {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses cleanly when no framework can be identified, before touching a browser at all', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-empty-'));
    cleanup.push(root);
    // No package.json, no HTML entry, nothing - genuinely unidentifiable.

    const scenarioFile = path.join(root, 'scenario.json');
    fs.writeFileSync(
      scenarioFile,
      JSON.stringify({
        name: 's',
        baseUrl: 'http://127.0.0.1:1',
        steps: [{ action: 'wait', ms: 0 }],
        iterations: 5,
      }),
    );

    const logSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await runInspect([root, '--scenario', scenarioFile]);
      expect(code).toBe(1);
      expect(logSpy.mock.calls.flat().join(' ')).toContain('No framework could be identified');
    } finally {
      logSpy.mockRestore();
    }
  });
});
