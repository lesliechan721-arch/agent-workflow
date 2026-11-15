import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

function exactRows(record, name) {
  if (record.status !== 'observed') throw new Error('native-command-failed');
  const rows = JSON.parse(record.stdout);
  if (!Array.isArray(rows)) throw new Error('plugin-list-not-an-array');
  return rows.filter(row => row && row.name === name);
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function consumerEvidence(context, rows, expected) {
  const result = [];
  for (const row of rows) {
    if (typeof row.path !== 'string' || !path.isAbsolute(row.path)) throw new Error('consumer-path-unconfirmed');
    const file = await fs.realpath(path.join(row.path, 'skills/management-check/SKILL.md'));
    const relative = path.relative(context.root, file);
    if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('consumer-outside-fixture');
    const bytes = await fs.readFile(file);
    result.push({ path: file, expectedSha256: digest(expected), actualSha256: digest(bytes), matches: bytes.equals(expected) });
  }
  return result;
}

/** Candidate-only management observation. No production profile changes. */
export async function probeAntigravityLocalManagement(context, command, renderPackage, options = {}) {
  const scopes = options.scopes ?? ['user', 'project'];
  if (!Array.isArray(scopes) || !scopes.length || new Set(scopes).size !== scopes.length
    || scopes.some(scope => !['user', 'project'].includes(scope))) throw new Error('invalid-management-scopes');
  const report = { status: 'unverified', candidateOnly: true, commands: [], scopes: [],
    updates: 'not-tested', dynamicConsumerBytes: 'not-tested', productionProfileChanged: false };
  const run = async (id, args, cwd) => {
    const result = await command(id, args, cwd);
    report.commands.push(id);
    if (result.status !== 'observed') throw new Error(`native-command-failed:${id}`);
    return result;
  };
  for (const scope of scopes) {
    const name = `aw-local-management-${scope}`;
    const root = path.join(context.root, `management-${scope}`);
    const ctx = { ...context, root, platform: 'antigravity', scope, pluginName: name,
      skillName: 'management-check', bundle: path.join(root, name) };
    const item = { scope, status: 'unverified', name, scopeEvidence: 'unverified', revisions: [] };
    report.scopes.push(item);
    let projectDirectory;
    try {
      for (const revision of scope === 'user' ? [1, 2, 3] : [1]) {
        const rendered = await renderPackage(ctx, revision);
        let fixtureOwner;
        if (scope === 'user') {
          const { writeSkillOwnerMarker } = await import('../../packages/cli/dist/src/utils/ownership.js');
          fixtureOwner = { owner: 'agent-workflows', plugin: name, sourceId: 'qualification', pluginId: `qualification/${name}`,
            sourceIdentity: `sha256:${'a'.repeat(64)}`, physicalKey: `sha256:${digest(Buffer.from(context.root + name))}`,
            artifactKey: name, platform: 'antigravity', scope: 'user' };
          await writeSkillOwnerMarker({ skillRoot: ctx.bundle, allowedRoot: root, identity: fixtureOwner });
        }

        await run(`${scope}-validate-${revision}`, ['plugin', 'validate', ctx.bundle], context.project);
        if (scope === 'user') await run(`user-install-${revision}`, ['plugin', 'install', ctx.bundle], context.project);
        else {
          projectDirectory = rendered.nativeDirectory;
          const relative = path.relative(context.project, projectDirectory);
          if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('project-directory-outside-fixture');
          if (await fs.lstat(projectDirectory).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) throw new Error('project-directory-already-exists');
          await fs.mkdir(path.dirname(projectDirectory), { recursive: true });
          await fs.cp(ctx.bundle, projectDirectory, { recursive: true });
          item.publishedDirectory = projectDirectory;
        }
        const target = exactRows(await run(`${scope}-target-list-${revision}`, ['plugin', 'list', '--json'], context.project), name);
        const neutral = exactRows(await run(`${scope}-neutral-list-${revision}`, ['plugin', 'list', '--json'], context.neutral), name);
        item.targetRows = target; item.neutralRows = neutral;
        item.scopeEvidence = target.length === 1 && target[0].enabled === true
          && (scope === 'user' ? neutral.length === 1 && neutral[0].enabled === true
            : neutral.length === 0 || neutral.length === 1 && neutral[0].enabled === false) ? 'observed' : 'unverified';
        if (scope === 'user') {
          if (item.scopeEvidence !== 'observed') throw new Error('installed-identity-or-scope-unconfirmed');
          const version = revision === 1 ? '1.0.1' : '1.0.2';
          if ([...target, ...neutral].some(row => row.version !== version)) throw new Error('installed-version-mismatch');
          const nativeRoot = path.join(context.env.HOME, '.gemini/config/plugins', name);
          if ([...target, ...neutral].some(row => row.source !== 'antigravity' || path.normalize(row.path ?? '') !== nativeRoot)) {
            throw new Error('native-consumer-path-unconfirmed');
          }
          const expected = await fs.readFile(path.join(ctx.bundle, 'skills/management-check/SKILL.md'));
          const consumers = await consumerEvidence(context, [...target, ...neutral], expected);
          const row = { revision, version, consumers };
          item.revisions.push(row);
          if (consumers.some(consumer => !consumer.matches)) throw new Error('native-consumer-content-mismatch');
          item.nativeRootEntries = (await fs.readdir(target[0].path)).sort().slice(0, 40);
          const { readSkillOwnerMarker } = await import('../../packages/cli/dist/src/utils/ownership.js');
          const owner = await readSkillOwnerMarker({ skillRoot: target[0].path, allowedRoot: context.env.HOME, expectedIdentity: fixtureOwner });
          row.ownerMarkerPreserved = owner !== null;
          if (!row.ownerMarkerPreserved) throw new Error('native-owner-marker-unconfirmed');
        }
      }
      if (scope === 'user') {
        report.updates = 'observed-version-change-and-same-version-refresh';
        report.dynamicConsumerBytes = 'observed-at-native-inventory-path';
        await run('user-uninstall', ['plugin', 'uninstall', name], context.project);
      } else {
        // The fixed 1.3.4 changelog defines this exact slash command as a local
        // read-only report without an agent turn. The user approved this query.
        // Preserve raw results until the real response schema is established.
        const skillArgs = ['-p', '/skills', '--output-format', 'json'];
        const target = await run('project-skills-target', skillArgs, context.project);
        const neutral = await run('project-skills-neutral', skillArgs, context.neutral);
        item.skillInventory = { format: 'json', target: target.stdout, neutral: neutral.stdout,
          qualification: 'unverified; raw Skill output has not established effective scope' };
        await fs.rm(projectDirectory, { recursive: true });
        const removed = await run('project-skills-removed', skillArgs, context.project);
        item.skillInventory.removed = removed.stdout;
      }
      const removedTarget = exactRows(await run(`${scope}-removed-target-list`, ['plugin', 'list', '--json'], context.project), name);
      const removedNeutral = exactRows(await run(`${scope}-removed-neutral-list`, ['plugin', 'list', '--json'], context.neutral), name);
      item.removed = removedTarget.length === 0 && removedNeutral.length === 0;
      item.status = item.scopeEvidence === 'observed' && item.removed ? 'observed' : 'unverified';
    } catch (error) {
      item.reason = error.message;
      report.reason = error.message;
      return report;
    }
  }
  report.status = report.scopes.every(item => item.status === 'observed') ? 'observed' : 'unverified';
  return report;
}
