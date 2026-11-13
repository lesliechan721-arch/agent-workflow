import fs from 'node:fs/promises';
import path from 'node:path';

function exactRows(record, name) {
  if (record.status !== 'observed') throw new Error('native-command-failed');
  const rows = JSON.parse(record.stdout);
  if (!Array.isArray(rows)) throw new Error('plugin-list-not-an-array');
  return rows.filter(row => row && row.name === name);
}

/** Candidate-only initial management observation. No production profile changes. */
export async function probeAntigravityLocalManagement(context, command, renderPackage) {
  const report = { status: 'unverified', candidateOnly: true, commands: [], scopes: [],
    updates: 'not-tested', dynamicConsumerBytes: 'not-tested', productionProfileChanged: false };
  const run = async (id, args, cwd) => {
    const result = await command(id, args, cwd);
    report.commands.push(id);
    if (result.status !== 'observed') throw new Error(`native-command-failed:${id}`);
    return result;
  };
  for (const scope of ['user', 'project']) {
    const name = `aw-local-management-${scope}`;
    const root = path.join(context.root, `management-${scope}`);
    const ctx = { ...context, root, platform: 'antigravity', scope, pluginName: name,
      skillName: 'management-check', bundle: path.join(root, 'package') };
    const item = { scope, status: 'unverified', name, scopeEvidence: 'unverified' };
    report.scopes.push(item);
    let projectDirectory;
    try {
      const rendered = await renderPackage(ctx, 1);
      await run(`${scope}-validate`, ['plugin', 'validate', ctx.bundle], context.project);
      if (scope === 'user') await run('user-install', ['plugin', 'install', ctx.bundle], context.project);
      else {
        projectDirectory = rendered.nativeDirectory;
        const relative = path.relative(context.project, projectDirectory);
        if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
          throw new Error('project-directory-outside-fixture');
        }
        if (await fs.lstat(projectDirectory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
          throw new Error('project-directory-already-exists');
        }
        await fs.mkdir(path.dirname(projectDirectory), { recursive: true });
        await fs.cp(ctx.bundle, projectDirectory, { recursive: true });
        item.publishedDirectory = projectDirectory;
      }
      const target = exactRows(await run(`${scope}-target-list`, ['plugin', 'list', '--json'], context.project), name);
      const neutral = exactRows(await run(`${scope}-neutral-list`, ['plugin', 'list', '--json'], context.neutral), name);
      item.targetRows = target; item.neutralRows = neutral;
      item.scopeEvidence = target.length === 1 && target[0].enabled === true
        && (scope === 'user' ? neutral.length === 1 && neutral[0].enabled === true
          : neutral.length === 0 || neutral.length === 1 && neutral[0].enabled === false) ? 'observed' : 'unverified';
      if (scope === 'user') {
        if (target.length !== 1 || neutral.length !== 1) throw new Error('installed-identity-unconfirmed');
        await run('user-uninstall', ['plugin', 'uninstall', name], context.project);
      } else await fs.rm(projectDirectory, { recursive: true });
      const removedTarget = exactRows(await run(`${scope}-removed-target-list`, ['plugin', 'list', '--json'], context.project), name);
      const removedNeutral = exactRows(await run(`${scope}-removed-neutral-list`, ['plugin', 'list', '--json'], context.neutral), name);
      item.removed = removedTarget.length === 0 && removedNeutral.length === 0;
      item.status = item.scopeEvidence === 'observed' && item.removed ? 'observed' : 'unverified';
    } catch (error) {
      item.reason = error.message;
      // A failed native process stops all further client commands. The owning
      // probe cleans its entire isolated root and keeps the failed result.
      report.reason = error.message;
      return report;
    }
  }
  report.status = report.scopes.every(item => item.status === 'observed') ? 'observed' : 'unverified';
  return report;
}
