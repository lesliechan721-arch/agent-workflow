import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  createEmptyPreferences, observePreferences, resolvePreferencesPath, writePreferences,
} from '../../src/intent/deployment-preferences.js';
import { writeIntent } from '../../src/intent/intent-store.js';
import { previewAgentSettings, readAgentSettings, saveAgentSettings } from '../../src/tui/agent-settings.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture() {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = path.join(isolation.layout.fixtureCwd, 'agent-settings-project');
  const source = path.join(isolation.layout.fixtureCwd, 'agent-settings-catalog');
  await fs.ensureDir(path.join(cwd, '.git'));
  const names = ['a', 'b', 'd'];
  for (const name of names) {
    const root = path.join(source, 'plugins', name);
    await fs.outputFile(path.join(root, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Test ${name}\n---\nUse ${name}.\n`);
    await fs.outputFile(path.join(root, 'skills', name, 'README.md'), `Use ${name}.\n`);
    for (const platform of ['cursor', 'generic']) {
      await fs.copy(path.join(root, 'skills'), path.join(root, platform, 'skills'));
    }
  }
  await createDependencyCatalogSnapshotFixture(source, names.map((name) => ({
    name, ...(name !== 'd' ? { dependencies: ['d'] } : {}),
    configureManifest: (manifest) => {
      manifest.platforms = ['cursor', 'generic'];
      manifest.skills = './skills';
      delete manifest.extensions;
    },
  })));
  const entries = [];
  for (const name of names) {
    const root = path.join(source, 'plugins', name);
    const plugin = await readPluginManifest(root, { mode: 'bundle' });
    const receipt = createAwPluginRequirementsReceipt({ name, version: plugin.manifest.version },
      plugin.manifest.requires?.aw.capabilities ?? []);
    for (const platform of ['cursor', 'generic']) {
      await fs.outputJson(path.join(root, platform, 'skills', name, 'aw-plugin-requirements.json'), receipt);
    }
    entries.push(await createCatalogManifestV7Entry(plugin, root));
  }
  const catalogPath = path.join(source, 'catalog-manifest.json');
  await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries });
  const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
    sources: [{ id: 'team', type: 'path', primary: true, path: source }] },
    expectedDigest: initial.digest, env: isolation.env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  const generated = await fs.readJson(path.join(source, '.aw-generated.json')) as { workspaceIdentity: string };
  const context = { cwd, env: isolation.env };
  const intent = (roots: string[]) => ({ schemaVersion: 3 as const, kind: 'aw-plugin-intents' as const,
    sources: { team: { logicalIdentity: generated.workspaceIdentity } },
    roots: roots.map((name) => ({ pluginId: `team/${name}` })),
  });
  await writeIntent({ ...context, scope: 'user' }, intent(['a', 'd']));
  await writeIntent({ ...context, scope: 'project' }, intent(['a', 'b']));
  const location = { ...context, scope: 'user' as const };
  return { context, location, filePath: await resolvePreferencesPath(location) };
}

describe('TUI Agent settings storage', () => {
  // Test Value Gate: opening settings for the first time must not turn an empty policy into an implicit target or a write.
  it('reads absent preferences as an empty draft and reports roots from both scopes', async () => {
    const value = await fixture();
    const settings = await readAgentSettings(value.context);
    expect(settings).toMatchObject({ revision: 'absent', preferences: createEmptyPreferences(),
      context: 'project', projectRoot: value.context.cwd });
    expect(settings.plugins).toEqual(expect.arrayContaining([
      { pluginId: 'team/a', scopes: ['user', 'project'], supportedTargets: ['cursor', 'generic'] },
      { pluginId: 'team/b', scopes: ['project'], supportedTargets: ['cursor', 'generic'] },
      { pluginId: 'team/d', scopes: ['user'], supportedTargets: ['cursor', 'generic'] },
    ]));
    expect(await fs.pathExists(value.filePath)).toBe(false);
  });

  // Test Value Gate: the global target editor owns targets only, even if its draft has different exclusion data.
  it('saves global targets while preserving saved exclusions', async () => {
    const value = await fixture();
    const exclusions = [{ plugin: 'team/b', target: 'generic' as const }];
    await writePreferences(value.location, { ...createEmptyPreferences(), targets: ['cursor'], exclusions });
    const current = await readAgentSettings(value.context);
    const saved = await saveAgentSettings(value.context, { expectedRevision: current.revision,
      preferences: { ...createEmptyPreferences(), targets: ['generic'] } });
    expect(saved.preferences).toEqual({ ...createEmptyPreferences(), targets: ['generic'], exclusions });
    expect(await fs.readJson(value.filePath)).toEqual(saved.preferences);
    expect(saved.revision).not.toBe(current.revision);
  });

  // Test Value Gate: one plugin editor must preserve global targets and every other plugin's exclusions.
  it('saves only the selected plugin exclusions', async () => {
    const value = await fixture();
    await writePreferences(value.location, { ...createEmptyPreferences(), targets: ['cursor'], exclusions: [
      { plugin: 'team/a', target: 'generic' }, { plugin: 'team/b', target: 'generic' },
    ] });
    const current = await readAgentSettings(value.context);
    const saved = await saveAgentSettings(value.context, { pluginId: 'team/a', expectedRevision: current.revision,
      preferences: { ...createEmptyPreferences(), targets: ['pi'], exclusions: [
        { plugin: 'team/a', target: 'cursor' }, { plugin: 'team/b', target: 'cursor' },
      ] } });
    expect(saved.preferences).toEqual({ ...createEmptyPreferences(), targets: ['cursor'], exclusions: [
      { plugin: 'team/a', target: 'cursor' }, { plugin: 'team/b', target: 'generic' },
    ] });
  });

  // Test Value Gate: a second writer must invalidate an open editor before either save path can change strong state.
  it.each([undefined, 'team/a'])('rejects a stale revision without writing for plugin %s', async (pluginId) => {
    const value = await fixture();
    const stale = await readAgentSettings(value.context);
    await writePreferences(value.location, { ...createEmptyPreferences(), targets: ['cursor'] });
    const bytes = await fs.readFile(value.filePath);
    const before = await fs.stat(value.filePath);
    await expect(saveAgentSettings(value.context, { pluginId, expectedRevision: stale.revision,
      preferences: { ...createEmptyPreferences(), targets: ['generic'],
        exclusions: [{ plugin: 'team/a', target: 'cursor' }] },
    })).rejects.toThrow('operationReviewStale');
    expect(await fs.readFile(value.filePath)).toEqual(bytes);
    const after = await fs.stat(value.filePath);
    expect({ ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({ ino: before.ino, mtimeMs: before.mtimeMs });
  });

  // Test Value Gate: a required dependency cannot be disabled through its own root editor, while placement conflicts remain a deployment issue.
  it('rejects a required dependency exclusion and permits saving targets with a fixed placement conflict', async () => {
    const value = await fixture();
    await writePreferences(value.location, { ...createEmptyPreferences(), targets: ['cursor'] });
    const current = await readAgentSettings(value.context);
    const disabled = { ...current.preferences, exclusions: [{ plugin: 'team/d', target: 'cursor' as const }] };
    const preview = await previewAgentSettings(value.context, disabled, 'team/d');
    expect(preview.blocked).toBe(true);
    expect(preview.reasons.some((reason) => reason.pluginId === 'team/d')).toBe(true);
    const bytes = await fs.readFile(value.filePath);
    await expect(saveAgentSettings(value.context, { pluginId: 'team/d',
      expectedRevision: current.revision, preferences: disabled })).rejects.toThrow('dependencyExcluded');
    expect(await fs.readFile(value.filePath)).toEqual(bytes);
    const conflicted = { ...current.preferences, targets: ['cursor', 'generic'] as const };
    const conflictPreview = await previewAgentSettings(value.context,
      { ...conflicted, targets: [...conflicted.targets] });
    expect(conflictPreview.blocked).toBe(false);
    expect(conflictPreview.conflicts.length).toBeGreaterThan(0);
    const saved = await saveAgentSettings(value.context, { expectedRevision: current.revision,
      preferences: { ...conflicted, targets: [...conflicted.targets] } });
    expect(saved.preferences.targets).toEqual(['cursor', 'generic']);
    expect(await observePreferences(value.location)).toMatchObject({ state: 'valid', value: saved.preferences });
    expect(await fs.pathExists(path.join(value.context.cwd, '.cursor', 'skills'))).toBe(false);
    expect(await fs.pathExists(path.join(value.context.cwd, '.agents', 'skills'))).toBe(false);
  });
});
