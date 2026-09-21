/**
 * `memory-agent live` - watch your running app in a real Chrome window.
 *
 * Opens Chrome with DevTools on your app; you browse it yourself. It reads the
 * heap as you go, notes each route you visit, and answers from real snapshots
 * whether the page you left was destroyed and what grew.
 *
 * Instructions arrive on stdin, one per line (the guided UI sends them):
 *
 *   snapshot [label]     take a heap snapshot of the page as it is now
 *   analyse [A B]        compare two snapshots (default: the last two)
 *   goto /route          move to a route of your app without reloading it
 *   stop                 close everything
 *
 * Lines starting `@@LIVE` are for the page to read; the rest is for people.
 */

import * as path from 'node:path';
import * as readline from 'node:readline';

import { LiveSession, type LiveAnalysis, type LiveEvent } from '../live/session';
import { describeBelongs } from '../live/attribute';
import { explainSessionMismatch, readSavedSession } from '../scenario/session';
import { colour, heading, info, warn } from '../utils/logger';

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const machine = (type: string, payload: unknown): void => {
  console.log(`@@LIVE ${type} ${JSON.stringify(payload)}`);
};

function say(a: LiveAnalysis): void {
  heading(`WAS ${a.fromRoute} DESTROYED WHEN YOU MOVED TO ${a.toRoute}?`);
  if (a.destroy.rows.length === 0) console.log('  No component that was only on that page could be checked.');
  for (const r of a.destroy.rows) {
    const verdict = r.status === 'destroyed' ? colour.green('destroyed') : r.status === 'still-alive' ? colour.red('STILL IN MEMORY') : colour.yellow('not in heap');
    console.log(`  ${verdict}  ${r.component}  (${r.before} before, ${r.after} after)  ${colour.dim(r.file)}`);
    if (r.heldBy !== undefined) console.log(colour.dim(`      ${r.heldBy.split('\n')[0] ?? ''}`));
  }
  const notable = a.growth.filter((g) => g.belongs === 'left-page').slice(0, 8);
  if (notable.length > 0) {
    heading('MEMORY THAT GREW AND BELONGS TO THE PAGE YOU LEFT');
    for (const g of notable) console.log(`  +${g.countDelta}  ${g.constructorName}  ${colour.dim(describeBelongs(g.belongs))}`);
  }
  for (const n of a.notes) info(n);
}

export async function runLive(args: string[]): Promise<number> {
  const baseUrl = flag(args, '--base-url');
  if (baseUrl === undefined) {
    console.error('Usage: memory-agent live --base-url <url> [--project <folder>] [--auth <file>] [--out-dir <dir>] [--headless]');
    return 2;
  }
  const project = flag(args, '--project');
  const outDir = flag(args, '--out-dir') ?? path.join('artifacts', 'live', `live-${Date.now().toString(36)}`);
  // MEMORY_AGENT_HEADLESS=1 is for automated tests; a person always wants to see the window.
  const headless = args.includes('--headless') || process.env['MEMORY_AGENT_HEADLESS'] === '1';

  // A saved sign-in is a convenience: if it belongs to another address, do not use it.
  // The window is visible, so signing in by hand always works.
  let auth = flag(args, '--auth');
  if (auth !== undefined) {
    const saved = readSavedSession(path.resolve(auth));
    if (saved === undefined) {
      warn(`No saved sign-in at ${auth}; sign in in the window that opens.`);
      auth = undefined;
    } else {
      const mismatch = explainSessionMismatch({ ...saved, file: auth }, baseUrl);
      if (mismatch !== undefined) {
        warn(`${mismatch}\n  Not using it - sign in in the window that opens.`);
        auth = undefined;
      }
    }
  }

  let stopping: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    stopping = resolve;
  });

  const onEvent = (e: LiveEvent): void => {
    switch (e.type) {
      case 'started':
        machine('started', e);
        console.log(`  Chrome is open on ${e.url}${e.devtools ? ' with DevTools' : ''}. Browse your app; the heap is shown live.`);
        if (e.mcp) console.log('  Snapshots are taken through Chrome DevTools MCP.');
        break;
      case 'sample':
        machine('sample', e.sample);
        break;
      case 'tags':
        machine('tags', e);
        break;
      case 'route':
        machine('route', e);
        console.log(`  Now on ${e.to}${e.from !== '' ? ` (left ${e.from})` : ''}`);
        break;
      case 'snapshot':
        machine('snapshot', { label: e.snapshot.label, route: e.snapshot.route, bytes: e.snapshot.bytes, source: e.snapshot.source, tags: e.snapshot.tags.length });
        console.log(`  Snapshot ${e.snapshot.label} taken on ${e.snapshot.route} (${(e.snapshot.bytes / 1048576).toFixed(0)} MB, ${e.snapshot.tags.length} custom elements on the page).`);
        break;
      case 'analysis': {
        machine('analysis', { file: path.relative(process.cwd(), e.analysis.file).split(path.sep).join('/') });
        say(e.analysis);
        break;
      }
      case 'note':
        console.log(`  ${e.text}`);
        break;
      case 'error':
        machine('error', { text: e.text });
        console.error(`  ${e.text}`);
        break;
      case 'closed':
        console.log('  The Chrome window was closed.');
        stopping?.();
        break;
    }
  };

  heading('LIVE WATCH');
  const live = new LiveSession({
    baseUrl,
    outDir,
    ...(project !== undefined ? { projectRoot: project } : {}),
    ...(auth !== undefined ? { storageStateFile: path.resolve(auth) } : {}),
    headed: !headless,
    devtools: !headless && !args.includes('--no-devtools'),
    onEvent,
  });

  try {
    await live.start();
  } catch (err) {
    console.error(`  Could not start: ${(err as Error).message}`);
    await live.stop();
    return 1;
  }

  const rl = readline.createInterface({ input: process.stdin });
  let working = false;
  rl.on('line', (raw) => {
    const [cmd, ...rest] = raw.trim().split(/\s+/);
    if (cmd === 'stop') {
      stopping?.();
      return;
    }
    if (working) {
      console.log('  Still working on the last instruction; try again in a moment.');
      return;
    }
    if (cmd !== 'snapshot' && cmd !== 'analyse' && cmd !== 'goto') return;
    working = true;
    void (async () => {
      try {
        if (cmd === 'snapshot') await live.snapshot(rest[0]);
        else if (cmd === 'goto') await live.goto(rest[0] ?? '');
        else await live.analyse(rest[0], rest[1]);
      } catch (err) {
        machine('error', { text: (err as Error).message });
        console.error(`  ${(err as Error).message}`);
      } finally {
        working = false;
      }
    })();
  });
  rl.on('close', () => stopping?.());
  process.once('SIGINT', () => stopping?.());

  await closed;
  rl.close();
  await live.stop();
  console.log('  Live watch stopped.');
  return 0;
}
