/**
 * `memory-agent deps <project>` - what package.json tells the agent.
 *
 * Lists every library whose behaviour changes how leaks are judged, the
 * installed version that decides it, resource-holding packages the agent has
 * no rules for, and problems in package.json / node_modules themselves.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { loadProjectKnowledge } from '../knowledge/lifetime';
import { auditDependencies, effectiveVersion, readProjectProfile } from '../knowledge/projectProfile';
import { colour, field, heading, info, warn } from '../utils/logger';

export async function runDeps(args: string[]): Promise<number> {
  const target = args[0];
  if (target === undefined || args.length > 1) {
    console.error('Usage: memory-agent deps <project>');
    return 2;
  }
  const root = path.resolve(target);
  if (!fs.existsSync(path.join(root, 'package.json'))) {
    console.error(`No package.json in ${root}`);
    return 2;
  }

  const profile = readProjectProfile(root);
  const audit = auditDependencies(profile);

  heading('VERSIONS THAT DECIDE BEHAVIOUR');
  for (const name of ['@angular/core', '@angular/router', '@angular/material', 'rxjs', 'zone.js', 'typescript']) {
    const dep = profile.dependencies.get(name);
    if (dep !== undefined) field(name, `${effectiveVersion(dep) ?? '?'}  ${colour.dim(`(declared ${dep.declared})`)}`);
  }

  heading('HOW THIS CHANGES THE AGENT');
  for (const e of audit.effects) info(e);

  const { conventions: c } = loadProjectKnowledge(root);
  heading('HOW THIS PROJECT WRITES ITS CLEANUP (fixes will match it)');
  field('Files read', String(c.filesSampled));
  field('Subscription collector', c.subscriptionField !== undefined ? `${c.subscriptionField} = new Subscription()  (${c.counts.subscriptionFields} places)` : 'none found - fixes use "subscriptions"');
  field('Destroy signal', c.destroySubject !== undefined ? `takeUntil(this.${c.destroySubject})  (${c.counts.takeUntil} places)` : 'none found');
  field('takeUntilDestroyed', c.usesTakeUntilDestroyed ? `used (${c.counts.takeUntilDestroyed} places)` : 'not used');
  field('Dominant style', c.cleanupStyle);
  field('File style', `${c.quote === "'" ? 'single' : 'double'} quotes, ${c.semicolons ? 'with' : 'without'} semicolons`);

  heading(`RESOURCE LIBRARIES THE AGENT KNOWS (${audit.catalogued.length})`);
  for (const c of audit.catalogued) {
    console.log(`  ${c.name.padEnd(34)} ${colour.dim(c.version.padEnd(10))} ${c.disposalApi}`);
  }

  if (audit.uncatalogued.length > 0) {
    heading(`RESOURCE-LOOKING PACKAGES WITH NO RULES (${audit.uncatalogued.length})`);
    for (const u of audit.uncatalogued) console.log(`  ${u.name.padEnd(34)} ${colour.dim(u.version)}`);
    warn('The agent still finds their raw timers, listeners and subscriptions, but does not know their own teardown call.');
  }
  if (audit.problems.length > 0) {
    heading('PROBLEMS IN package.json / node_modules');
    for (const p of audit.problems) warn(p);
  }
  return 0;
}
