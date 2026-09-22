/**
 * `memory-agent discover <project>` - what is this application?
 *
 * WHY THIS COMMAND EXISTS
 * -----------------------
 * Every other command already assumes the answer. `scan` assumes Angular,
 * `deps` assumes package.json means what it says, Find & Fix assumes a
 * checkout. This one asks the question directly and shows the working:
 * which framework, which version, what was read to decide, and what could
 * not be established.
 *
 * It is also the first consumer of the adapter registry, so "the seam
 * works" is something you can run rather than something the tests assert
 * in private.
 *
 * WHAT IT CANNOT DO YET
 * ---------------------
 * A URL. Discovery from a running page - the flow the product is heading
 * for - needs the browser session to be handed to the adapter, which is the
 * next phase. Passing a URL today says exactly that instead of guessing
 * from the address.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { defaultRegistry } from '../adapters';
import type { AdapterContext } from '../core/framework/adapter';
import type { Capability, EvidenceSource } from '../core/framework/types';
import { colour, field, heading, info, warn } from '../utils/logger';

function describeEvidence(e: EvidenceSource): string {
  const label: Record<EvidenceSource['kind'], string> = {
    'source-file': 'file',
    'package-manifest': 'declared',
    'installed-package': 'installed',
    'runtime-global': 'running page',
    'dom-marker': 'live DOM',
    'loaded-script': 'loaded script',
  };
  const value = e.value !== undefined ? `  ${colour.dim(e.value)}` : '';
  return `  ${label[e.kind].padEnd(14)} ${e.detail}${value}`;
}

/**
 * The value, or undefined after saying why there is none.
 *
 * The caller cannot reach a value without going through here, which is how
 * "not available" reliably ends up on screen instead of being printed as a
 * zero that reads like a measurement.
 */
function valueOr<T>(what: string, result: Capability<T>): T | undefined {
  if (result.available) return result.value;
  warn(`${what}: not available - ${result.reason}`);
  return undefined;
}

export async function runDiscover(args: string[]): Promise<number> {
  const target = args[0];
  if (target === undefined || args.length > 1 || target.startsWith('-')) {
    console.error('Usage: memory-agent discover <project>');
    return 2;
  }

  if (/^https?:\/\//i.test(target)) {
    console.error(
      'Discovery from a URL is not implemented yet. It needs a browser session to read the\n' +
        'running page, which arrives with the URL-first flow. Pass a project folder for now.',
    );
    return 2;
  }

  const root = path.resolve(target);
  if (!fs.existsSync(root)) {
    console.error(`No such folder: ${root}`);
    return 2;
  }

  const context: AdapterContext = { projectRoot: root };
  const registry = defaultRegistry();
  const outcome = await registry.detect(context);

  console.log('');
  heading('APPLICATION');
  field('Folder', root);
  field('Framework', outcome.framework === 'unknown' ? colour.dim('Unknown') : outcome.adapter?.displayName ?? outcome.framework);
  field('Version', outcome.version.version ?? colour.dim('Unknown'));

  if (outcome.version.version === undefined && outcome.version.reason !== undefined) {
    info(`Version not established: ${outcome.version.reason}`);
  } else if (outcome.version.reason !== undefined) {
    info(outcome.version.reason);
  }

  /* Detection and version often read the same file - node_modules tells us
     both that Angular is here and which Angular. Print each source once. */
  const sources = [...outcome.detection.evidence, ...outcome.version.evidence];
  const seen = new Set<string>();
  const lines = sources
    .map(describeEvidence)
    .filter((line) => (seen.has(line) ? false : (seen.add(line), true)));
  if (lines.length > 0) {
    heading('WHAT THIS IS BASED ON');
    for (const line of lines) console.log(line);
  }

  if (outcome.alsoDetected.length > 0) {
    warn(`Also detected: ${outcome.alsoDetected.join(', ')}. The strongest evidence decided.`);
  }

  /* Every adapter's answer, including "no". This is what makes a wrong
     detection debuggable instead of mysterious. */
  heading('EVERY ADAPTER ASKED');
  for (const d of outcome.considered) {
    const verdict = d.detected ? colour.dim('detected') : colour.dim(d.reason ?? 'not detected');
    field(d.framework, verdict);
  }
  if (outcome.considered.length < 3) {
    info('React and plain JavaScript adapters are not built yet, so those applications report Unknown.');
  }

  const adapter = outcome.adapter;
  if (adapter === undefined) {
    console.log('');
    warn('No framework was identified, so nothing further can be listed.');
    return 1;
  }

  const entities = valueOr('Entities', await adapter.discoverEntities(context));
  const routes = valueOr('Routes', await adapter.discoverRoutes(context));
  const lifecycle = valueOr('Lifecycle', await adapter.analyzeLifecycle(context));

  heading('WHAT CAN BE INVESTIGATED');
  if (entities !== undefined) {
    const views = entities.filter((e) => e.role === 'view');
    field('Entities', String(entities.length));
    field('Views', `${views.length} (${views.filter((v) => v.routed).length} routed)`);
  }
  if (routes !== undefined) {
    field('Routes', String(routes.routes.length));
    field('Lazy boundaries', String(routes.boundaries.length));
    for (const note of routes.notes) info(note);
  }

  if (lifecycle !== undefined) {
    heading(`TEARDOWN, AS THE SOURCE DESCRIBES IT (${lifecycle.hook})`);
    field('Views considered', String(lifecycle.entitiesConsidered));
    field(`With ${lifecycle.hook}`, String(lifecycle.withTeardown));
    field('Without', String(lifecycle.withoutTeardown));
    info(
      'A view with no cleanup hook is not a leak: most of them start nothing. This is a ' +
        'description of the source, not a verdict. Only the browser can produce one.',
    );
  }

  console.log('');
  return 0;
}
