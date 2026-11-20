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
export const antigravitySkillQuery = ['-p', '/skills', '--output-format', 'json'];

/** Only the known fixtures leave memory. The response can contain account and local path data. */
export function parseAntigravitySkillInventory(record, expectedNames) {
  if (record.status !== 'observed' || record.exitCode !== 0) throw new Error('skill-inventory-query-failed');
  let report;
  try { report = JSON.parse(record.stdout); } catch { throw new Error('skill-inventory-invalid-json'); }
  const skills = report?.command?.data?.skills;
  if (report?.status !== 'SUCCESS' || report.num_turns !== 0 || report.command?.name !== 'skills'
    || !Array.isArray(skills) || !skills.every(skill => typeof skill?.name === 'string')
    || (report.usage && Object.values(report.usage).some(value => value !== 0))) throw new Error('skill-inventory-unconfirmed');
  const matched = skills.filter(skill => expectedNames.includes(skill.name));
  if (new Set(matched.map(({ name }) => name)).size !== matched.length
    || matched.some(({ model_invocable }) => typeof model_invocable !== 'boolean')) throw new Error('skill-inventory-ambiguous');
  return { status: 'SUCCESS', num_turns: 0,
    skills: matched.map(({ name, model_invocable }) => ({ name, model_invocable })).sort((a, b) => a.name.localeCompare(b.name)) };
}

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
    try {
      if (scope === 'project') {
        const directName = 'aw-local-management-direct';
        const directFile = path.join(context.project, '.agents', 'skills', directName, 'SKILL.md');
        await fs.mkdir(path.dirname(directFile), { recursive: true });
        await fs.writeFile(directFile, `---\nname: ${directName}\ndescription: Isolated directory control\n---\nNo action is required.\n`, { flag: 'wx' });
        const projected = await renderPackage(ctx, 1);
        const projectDirectory = projected.nativeDirectory;
        const pluginRoot = path.join(context.project, '.agents', 'plugins');
        if (path.dirname(projectDirectory) !== pluginRoot) throw new Error('project-directory-outside-fixture');
        item.publishedDirectory = projectDirectory;
        const first = `${path.basename(projectDirectory)}:management-check`;
        const next = `${path.basename(projectDirectory)}:management-updated`;
        const fixtures = [first, next, directName];
        const query = async (id, cwd) => parseAntigravitySkillInventory(await run(id, antigravitySkillQuery, cwd), fixtures);
        const matches = (evidence, names) => JSON.stringify(evidence.skills.map(({ name }) => name).sort()) === JSON.stringify([...names].sort());
        await run('project-validate-1', ['plugin', 'validate', ctx.bundle], context.project);
        await fs.mkdir(pluginRoot, { recursive: true });
        await fs.mkdir(projectDirectory);
        await fs.cp(ctx.bundle, projectDirectory, { recursive: true });
        try {
          item.targetRows = exactRows(await run('project-target-list-1', ['plugin', 'list', '--json'], context.project), name);
          item.neutralRows = exactRows(await run('project-neutral-list-1', ['plugin', 'list', '--json'], context.neutral), name);
          item.skillInventory = { target: await query('project-skills-target', context.project), neutral: await query('project-skills-neutral', context.neutral) };
          ctx.skillName = 'management-updated';
          await renderPackage(ctx, 2);
          await run('project-validate-2', ['plugin', 'validate', ctx.bundle], context.project);
          await fs.rm(projectDirectory, { recursive: true });
          await fs.cp(ctx.bundle, projectDirectory, { recursive: true });
          item.skillInventory.updated = await query('project-skills-updated', context.project);
        } finally {
          await fs.rm(projectDirectory, { recursive: true, force: true });
        }
        item.skillInventory.removed = await query('project-skills-removed', context.project);
        item.scopeEvidence = matches(item.skillInventory.target, [directName, first]) && matches(item.skillInventory.neutral, [])
          && matches(item.skillInventory.updated, [directName, next]) ? 'observed' : 'unverified';
        item.removed = matches(item.skillInventory.removed, [directName]);
        item.status = item.scopeEvidence === 'observed' && item.removed ? 'observed' : 'unverified';
        continue;
      }
      for (const revision of [1, 2, 3]) {
        await renderPackage(ctx, revision);
        const { writeSkillOwnerMarker, readSkillOwnerMarker } = await import('../../packages/cli/dist/src/utils/ownership.js');
        const fixtureOwner = { owner: 'agent-workflows', plugin: name, sourceId: 'qualification', pluginId: `qualification/${name}`,
          sourceIdentity: `sha256:${'a'.repeat(64)}`, physicalKey: `sha256:${digest(Buffer.from(context.root + name))}`,
          artifactKey: name, platform: 'antigravity', scope: 'user' };
        await writeSkillOwnerMarker({ skillRoot: ctx.bundle, allowedRoot: root, identity: fixtureOwner });

        await run(`user-validate-${revision}`, ['plugin', 'validate', ctx.bundle], context.project);
        await run(`user-install-${revision}`, ['plugin', 'install', ctx.bundle], context.project);
        const target = exactRows(await run(`user-target-list-${revision}`, ['plugin', 'list', '--json'], context.project), name);
        const neutral = exactRows(await run(`user-neutral-list-${revision}`, ['plugin', 'list', '--json'], context.neutral), name);
        item.targetRows = target; item.neutralRows = neutral;
        item.scopeEvidence = target.length === 1 && target[0].enabled === true
          && neutral.length === 1 && neutral[0].enabled === true ? 'observed' : 'unverified';
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
        const owner = await readSkillOwnerMarker({ skillRoot: target[0].path, allowedRoot: context.env.HOME, expectedIdentity: fixtureOwner });
        row.ownerMarkerPreserved = owner !== null;
        if (!row.ownerMarkerPreserved) throw new Error('native-owner-marker-unconfirmed');
      }
      report.updates = 'observed-version-change-and-same-version-refresh';
      report.dynamicConsumerBytes = 'observed-at-native-inventory-path';
      await run('user-uninstall', ['plugin', 'uninstall', name], context.project);
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
