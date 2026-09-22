/**
 * `memory-agent discover <project>` - the CLI's own output.
 *
 * The underlying logic (detection, entities, the static-candidate
 * heuristic) already has direct unit coverage elsewhere. What has none
 * until now is the command's own wiring - does the printed report actually
 * include the "worth a look" section, and does it correctly stay silent for
 * plain JavaScript, which has no cleanup hook to be missing.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { run } from '../src/cli';

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'discover-cmd-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

const cleanup: string[] = [];
afterAll(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(files: Record<string, string>): string {
  const root = project(files);
  cleanup.push(root);
  return root;
}

const LEAKY_REACT_FILE = `
  import { useEffect } from 'react';
  export function LeakyWidget() {
    useEffect(() => { setInterval(() => {}, 1000); }, []);
    return <div>leaky</div>;
  }
`;

describe('discover command output', () => {
  let logs: string[];
  let logSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;

  beforeEach(() => {
    logs = [];
    logSpy = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.join(' '));
    });
    errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('prints "worth a look" for a real React component with a resource and no recognised teardown', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'app', dependencies: { react: '^18.2.0' } }),
      'node_modules/react/package.json': JSON.stringify({ name: 'react', version: '18.2.0' }),
      'src/Widget.jsx': LEAKY_REACT_FILE,
    });

    await run(['node', 'cli.js', 'discover', root]);

    const output = logs.join('\n');
    expect(output).toContain('WORTH A LOOK');
    expect(output).toContain('LeakyWidget');
    expect(output).toContain('not confirmed leaks');
  });

  it('stays silent about "worth a look" for plain JavaScript with the identical leaky shape', async () => {
    const root = makeProject({
      'package.json': JSON.stringify({ name: 'app', dependencies: {} }),
      'index.html': '<!doctype html><body></body>',
      // Same resource-acquiring shape as the React fixture above, and no
      // cleanup site - but plain JS has none to be missing.
      'src/widget.js': 'class Widget { constructor() { setInterval(() => {}, 1000); } }',
    });

    await run(['node', 'cli.js', 'discover', root]);

    expect(logs.join('\n')).not.toContain('WORTH A LOOK');
  });
});
