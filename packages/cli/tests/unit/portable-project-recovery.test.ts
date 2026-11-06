import path from 'node:path';

import type { PortablePlatformTarget } from '@lesliechan721/aw-plugin-core';
import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createScopeContext } from '../../src/intent/scope-context.js';
import { writeAwSourceBinding } from '../../src/review/source-binding.js';
import { portableJsonDigest, portableSkillTreeDigest } from '../../src/portable/historical-materialization.js';
import { executePortableRecovery, inspectPortableExtraInstalled, inspectPortableRecovery, inspectPortableResidue,
  preparePortableCleanup, preparePortableRecovery } from '../../src/portable/recovery.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const state = vi.hoisted(() => ({ content: 'first', builds: 0, catalogUnavailable: false,
  skills: [{ name: 'alpha', providerPluginId: 'team/root' }] }));
vi.mock('../../src/portable/materializer.js', () => ({
  resolvePortableCatalogBindingInput: async (options: { platform: PortablePlatformTarget; scope: 'user' | 'project' }) => {
    if (state.catalogUnavailable) throw new Error('Catalog unavailable');
    return { source: { kind: 'catalog-snapshot', sourceId: 'team', catalogSourceIdentity: portableJsonDigest('catalog'),
      logicalIdentity: 'team-catalog', snapshotDigest: portableJsonDigest(state.content + JSON.stringify(state.skills)),
      workspaceIdentity: 'workspace', workspaceSourceIdentity: portableJsonDigest('workspace') },
    subject: { plugin: 'root' }, profile: { kind: 'portable', platform: options.platform,
      id: `${options.platform}-${options.scope}`, scope: options.scope,
      inputDigest: portableJsonDigest({ content: state.content, platform: options.platform, scope: options.scope }) } };
  },
}));
vi.mock('../../src/portable/commands.js', () => ({
  materializePortableSkillsToDirectory: async (options: { out: string; platform: PortablePlatformTarget; scope: 'user' | 'project' }) => {
    state.builds += 1;
    await fs.ensureDir(path.join(options.out, 'skills'));
    const selectedSkills = [];
    for (const candidate of state.skills) {
      const skill = path.join(options.out, 'skills', candidate.name);
      await fs.outputFile(path.join(skill, 'SKILL.md'), `---\nname: ${candidate.name}\ndescription: Test\n---\n${state.content} ${options.platform}`);
      await fs.outputFile(path.join(skill, 'README.md'), 'Complete Portable skill.');
      selectedSkills.push({ ...candidate, filesDigest: await portableSkillTreeDigest(skill),
        configDigest: portableJsonDigest({ platform: options.platform, provider: candidate.providerPluginId }) });
    }
    const { resolvePortableCatalogBindingInput } = await import('../../src/portable/materializer.js');
    const binding = await resolvePortableCatalogBindingInput(options as never);
    await writeAwSourceBinding({ rootDir: options.out, ...binding, artifacts: selectedSkills.map((candidate) => ({
      kind: 'portable-skill' as const, plugin: candidate.providerPluginId.split('/')[1]!, skill: candidate.name,
      path: `skills/${candidate.name}`,
    })) });
    const outputDigest = portableJsonDigest(selectedSkills.map((entry) => [entry.name, entry.filesDigest]));
    await fs.writeJson(path.join(options.out, '.aw-materialization.json'), {
      schemaVersion: 1, receiptSchemaVersion: 5, command: 'skill:materialize', platform: options.platform, scope: options.scope,
      plugin: { id: 'team/root', sourceId: 'team', sourceIdentity: binding.source.catalogSourceIdentity },
      dependencies: [...new Set(state.skills.map((entry) => entry.providerPluginId).filter((id) => id !== 'team/root'))],
      config: { pluginConfigDigest: binding.profile.inputDigest }, selectedSkills, outputDigest, materializationDigest: portableJsonDigest({ platform: options.platform, scope: options.scope, skills: selectedSkills.map((entry) => [entry.name, entry.filesDigest]) }),
    });
  },
}));

async function fixture(scope: 'user' | 'project' = 'project', agents: PortablePlatformTarget[] = ['cursor']) {
  const isolated = getCurrentSourceTestIsolation();
  const cwd = path.join(isolated.env.AW_HOME!, 'project');
  await fs.ensureDir(path.join(cwd, '.git'));
  const context = await createScopeContext({ scope, cwd, env: isolated.env });
  return { scope, context, selector: 'team/root', cliVersion: '1.0.0', agents, env: context.env };
}
async function apply(options: Awaited<ReturnType<typeof fixture>>, extra: { authorizeUpdate?: boolean; action?: 'reinstall' } = {}) {
  return withAwHomeMutationLock({ env: options.env, action: async (token) =>
    executePortableRecovery({ prepared: await preparePortableRecovery(options), token, ...extra }) });
}
beforeEach(() => { state.content = 'first'; state.builds = 0; state.catalogUnavailable = false;
  state.skills = [{ name: 'alpha', providerPluginId: 'team/root' }]; });

describe('AW Portable recovery', () => {
  // Test Value Gate: two independent consumer profiles must not write the same project directory.
  it('rejects shared project paths before materialization or publishing', async () => {
    const options = await fixture('project', ['antigravity', 'generic']);
    expect((await preparePortableRecovery(options)).blockers).toEqual(['portableOutputConflict']);
    expect(state.builds).toBe(0);
    expect(await fs.pathExists(path.join(options.context.executionCwd, '.agents', 'skills'))).toBe(false);
  });

  // Test Value Gate: status must stay read-only and per-target candidates must never share content or credentials.
  it('inspects without building, writes each concrete target, and then performs a file no-op', async () => {
    const options = await fixture('project', ['cursor', 'pi']);
    expect((await inspectPortableRecovery(options)).blockers).toEqual(['needs-preparation']);
    expect(state.builds).toBe(0);
    expect((await apply(options)).execution).toBe('applied');
    expect(state.builds).toBe(2);
    const cursor = path.join(options.context.executionCwd, '.cursor', 'skills', 'alpha', 'SKILL.md');
    const pi = path.join(options.context.executionCwd, '.pi', 'skills', 'alpha', 'SKILL.md');
    expect(await fs.readFile(cursor, 'utf8')).toContain('cursor');
    expect(await fs.readFile(pi, 'utf8')).toContain('pi');
    const before = (await fs.stat(cursor)).mtimeMs;
    expect((await apply(options)).execution).toBe('no-op');
    expect((await fs.stat(cursor)).mtimeMs).toBe(before);
    expect(await fs.pathExists(path.join(options.context.executionCwd, 'skills-lock.json'))).toBe(false);
  });

  // Test Value Gate: healthy old content and user-damaged content are repairable only through an authorized update.
  it('reports stale and damaged output separately and repairs the selected deployment', async () => {
    const options = await fixture();
    await apply(options);
    state.content = 'second';
    let prepared = await preparePortableRecovery(options);
    expect(prepared.targets).toMatchObject([{ observation: 'drifted', contentState: 'stale', ownership: 'aw' }]);
    await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      expect((await executePortableRecovery({ prepared, token })).blockers).toContain('portableUpdateAuthorizationRequired');
      expect((await executePortableRecovery({ prepared, token, authorizeUpdate: true })).execution).toBe('applied');
    } });
    await fs.remove(path.join(prepared.targets[0]!.physicalPath, 'README.md'));
    prepared = await preparePortableRecovery(options);
    expect(prepared.targets[0]).toMatchObject({ observation: 'drifted', contentState: 'damaged' });
    expect((await apply(options, { authorizeUpdate: true })).execution).toBe('applied');
  });

  // Test Value Gate: updating one deployment removes its obsolete owned Skill while unrelated residual deployments remain.
  it('removes obsolete Skills in the updated deployment without collecting independent residue', async () => {
    const options = await fixture();
    state.skills.push({ name: 'old-root', providerPluginId: 'team/root' }, { name: 'independent', providerPluginId: 'team/independent' });
    await apply(options);
    const root = path.join(options.context.executionCwd, '.cursor', 'skills');
    state.skills = [{ name: 'alpha', providerPluginId: 'team/root' }];
    state.content = 'new';
    const prepared = await preparePortableRecovery(options);
    expect(prepared.targets).toEqual(expect.arrayContaining([expect.objectContaining({ skill: 'old-root', disposition: 'remove' })]));
    expect(prepared.targets.some((target) => target.skill === 'independent')).toBe(false);
    expect((await apply(options, { authorizeUpdate: true })).execution).toBe('applied');
    expect(await fs.pathExists(path.join(root, 'old-root'))).toBe(false);
    expect(await fs.pathExists(path.join(root, 'independent'))).toBe(true);
  });

  // Test Value Gate: removing the final Skill still needs an empty candidate and bounded old-output cleanup.
  it('can update a deployment to an empty Skill set', async () => {
    const options = await fixture();
    await apply(options);
    state.skills = [];
    const prepared = await preparePortableRecovery(options);
    expect(prepared.targets).toMatchObject([{ skill: 'alpha', disposition: 'remove' }]);
    expect((await apply(options, { authorizeUpdate: true })).execution).toBe('applied');
    expect(await fs.pathExists(path.join(options.context.executionCwd, '.cursor', 'skills', 'alpha'))).toBe(false);
  });

  // Test Value Gate: project provider assignment must filter user-provided dependencies after complete materialization validation.
  it('does not create a project copy for a provider assigned to the user', async () => {
    state.skills.push({ name: 'dependency', providerPluginId: 'team/dependency' });
    const options = { ...await fixture(), excludedPluginIds: ['team/dependency'] };
    const prepared = await preparePortableRecovery(options);
    expect(prepared.targets.map((target) => target.providerPluginId)).toEqual(['team/root']);
    expect((await apply(options)).execution).toBe('applied');
    expect(await fs.pathExists(path.join(options.context.executionCwd, '.cursor', 'skills', 'dependency'))).toBe(false);
    const changed = await preparePortableRecovery({ ...options, excludedPluginIds: [] });
    expect(changed.evidenceDigest).not.toBe(prepared.evidenceDigest);
  });

  // Test Value Gate: offline cleanup must work without current Catalog, schema, generation or renderer in both scopes.
  it.each(['user', 'project'] as const)('cleans %s owned output offline and preserves foreign content', async (scope) => {
    const options = await fixture(scope);
    await apply(options);
    const installed = (await inspectPortableRecovery(options)).targets[0]!.physicalPath;
    const foreign = path.join(path.dirname(installed), 'foreign');
    await fs.outputFile(path.join(foreign, 'SKILL.md'), 'hand managed');
    await fs.remove(options.context.generationRoot);
    state.catalogUnavailable = true;
    const builds = state.builds;
    const prepared = await preparePortableCleanup(options);
    expect(prepared.targets).toMatchObject([{ skill: 'alpha', ownership: 'aw', disposition: 'remove' }]);
    expect((await inspectPortableRecovery(prepared.options)).evidenceDigest).toBe(prepared.evidenceDigest);
    await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      expect((await executePortableRecovery({ prepared, token, action: 'cleanup' })).execution).toBe('applied');
    } });
    expect(state.builds).toBe(builds);
    expect(await fs.pathExists(installed)).toBe(false);
    expect(await fs.readFile(path.join(foreign, 'SKILL.md'), 'utf8')).toBe('hand managed');
    expect(await inspectPortableResidue(options)).toEqual({ state: 'absent', targets: [], blockers: [] });
  });

  // Test Value Gate: damaged weak metadata has a narrow force recovery, and marker identity corruption never authorizes removal.
  it('uses force only for complete owned identities and reports unknown marker corruption', async () => {
    const options = await fixture();
    await apply(options);
    const installed = (await inspectPortableRecovery(options)).targets[0]!.physicalPath;
    const markerPath = path.join(installed, SKILL_OWNER_MARKER);
    const marker = await fs.readJson(markerPath);
    delete marker.configDigest;
    await fs.writeJson(markerPath, marker);
    const normal = await preparePortableCleanup(options);
    expect(normal.blockers).toContain('portableOwnerDamaged');
    const forced = await preparePortableCleanup({ ...options, force: true });
    await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      expect((await executePortableRecovery({ prepared: forced, token, action: 'cleanup', force: true })).execution).toBe('applied');
    } });
    await apply(options);
    await fs.writeFile(markerPath, '{broken');
    expect((await inspectPortableResidue(options)).state).toBe('unknown');
    const invalid = await preparePortableCleanup({ ...options, force: true });
    await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      expect((await executePortableRecovery({ prepared: invalid, token, action: 'cleanup', force: true })).execution).toBe('not-run');
    } });
    expect(await fs.pathExists(installed)).toBe(true);
  });

  // Test Value Gate: current marker observation must detect Review drift; owned extras are visible in User and Project scopes.
  it.each(['user', 'project'] as const)('observes %s extras and rejects changed review evidence', async (scope) => {
    const options = await fixture(scope);
    await apply(options);
    expect(await inspectPortableExtraInstalled(options)).toMatchObject({ complete: true,
      targets: [expect.objectContaining({ pluginId: 'team/root', agent: 'cursor', observation: 'verified' })] });
    const prepared = await preparePortableCleanup(options);
    await fs.appendFile(path.join(prepared.targets[0]!.physicalPath, 'README.md'), 'after review');
    await withAwHomeMutationLock({ env: options.env, action: async (token) => {
      expect((await executePortableRecovery({ prepared, token, action: 'cleanup' })).blockers).toEqual(['operationReviewStale']);
    } });
  });
});
