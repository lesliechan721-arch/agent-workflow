import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { setTargets } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import type { PluginMeta } from '../../src/types.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function configurePortableManifest(manifest: PluginMeta['manifest']): void {
  manifest.platforms = ['cursor'];
  manifest.skills = './skills';
  delete manifest.extensions;
}

async function fixture() {
  const { env, layout } = getCurrentSourceTestIsolation();
  const cwd = path.join(layout.fixtureCwd, 'remove-project');
  const source = path.join(layout.fixtureCwd, 'remove-source');
  await fs.ensureDir(cwd);
  await git(cwd, ['init', '--quiet']);
  for (const name of ['parent', 'dependency']) for (const folder of ['skills', 'cursor/skills']) {
    const skill = path.join(source, 'plugins', name, folder, name);
    await fs.outputFile(path.join(skill, 'SKILL.md'), `---\nname: ${name}\ndescription: Test ${name}\n---\nUse ${name}.\n`);
    await fs.outputFile(path.join(skill, 'README.md'), `Use ${name}.\n`);
  }
  await createDependencyCatalogSnapshotFixture(source, [
    { name: 'parent', dependencies: ['dependency'] }, { name: 'dependency' },
  ].map((plugin) => ({ ...plugin, configureManifest: configurePortableManifest })));
  const entries = [];
  for (const name of ['dependency', 'parent']) {
    const root = path.join(source, 'plugins', name);
    const plugin = await readPluginManifest(root, { mode: 'bundle' });
    await fs.outputJson(path.join(root, 'cursor', 'skills', name, 'aw-plugin-requirements.json'),
      createAwPluginRequirementsReceipt({ name, version: '1.0.0' }, plugin.manifest.requires?.aw.capabilities ?? []));
    entries.push(await createCatalogManifestV7Entry(plugin, root));
  }
  const catalog = path.join(source, 'catalog-manifest.json');
  await fs.writeJson(catalog, { ...await fs.readJson(catalog), entries });
  const config = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  await setTargets({ cwd, env, scope: 'project' }, ['cursor']);
  const invoke = (command: string, plugins: string[], flags: string[] = []) => runCliEntry([
    'plugin', command, ...plugins, '--scope', 'project', '--context', 'project', '--yes', '--json', ...flags,
  ], { cwd, env });
  const output = (name: string) => path.join(cwd, '.cursor', 'skills', name);
  return { invoke, output, cwd, env, source };
}

// These tests protect CLI option forwarding through real dependency output changes.
describe('CLI removal dependency options', () => {
  it.each([false, true])('forwards orphan dependency retention (keep=%s)', async (keep) => {
    const { invoke, output } = await fixture();
    const installed = await invoke('install', ['team/parent']);
    expect(installed.exitCode, installed.stdout + installed.stderr).toBe(0);
    expect(await fs.pathExists(output('dependency'))).toBe(true);

    const removed = await invoke('remove', ['team/parent'], keep ? ['--keep-dependencies'] : []);
    expect(removed.exitCode, removed.stdout + removed.stderr).toBe(0);
    expect(removed.parseJsonStdout()).toMatchObject({ command: 'plugin.remove', status: 'success', data: { requirements: { roots: [] } } });
    expect(await fs.pathExists(output('parent'))).toBe(false);
    expect(await fs.pathExists(output('dependency'))).toBe(keep);
  });

  it.each([
    { selector: 'team/dependency', direct: true },
    { selector: 'dependency', direct: false },
  ])('forwards normal --force past the dependency guard for $selector (direct=$direct)', async ({ selector, direct }) => {
    const { invoke, output } = await fixture();
    const installed = await invoke('install', ['team/parent', ...(direct ? ['team/dependency'] : [])]);
    expect(installed.exitCode, installed.stdout + installed.stderr).toBe(0);

    const blocked = await invoke('remove', [selector]);
    expect(blocked.exitCode, blocked.stdout + blocked.stderr).toBe(3);
    expect(blocked.parseJsonStdout()).toMatchObject({
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'dependencyStillRequired' })]),
    });
    expect(await fs.pathExists(output('dependency'))).toBe(true);

    const forced = await invoke('remove', [selector], ['--force']);
    expect(forced.exitCode, forced.stdout + forced.stderr).toBe(0);
    expect(forced.parseJsonStdout()).toMatchObject({ command: 'plugin.remove', status: 'success', data: {
      requirements: { roots: ['team/parent'] }, changes: { requirements: direct ? 'changed' : 'none' },
    } });
    expect(await fs.pathExists(output('dependency'))).toBe(false);
    expect(await fs.pathExists(output('parent'))).toBe(true);
  });

  it('rejects a dependency short name required from two sources without changing either requirement', async () => {
    const value = await fixture();
    const otherSource = path.join(value.cwd, 'other-source');
    await fs.copy(value.source, otherSource);
    await createDependencyCatalogSnapshotFixture(otherSource, [
      { name: 'parent', dependencies: ['dependency'] }, { name: 'dependency' },
    ].map((plugin) => ({ ...plugin, configureManifest: configurePortableManifest })));
    const config = await readCatalogSourcesConfigSnapshot(value.env);
    await replaceCatalogSourcesConfig({ config: { ...config.config, sources: [
      ...config.config.sources, { id: 'other', type: 'path', primary: false, path: otherSource },
    ] }, expectedDigest: config.digest, env: value.env });
    await syncCatalogSourceGeneration({ sourceId: 'other', cliVersion: '1.0.0', env: value.env });
    const installed = await value.invoke('install', ['team/parent']);
    expect(installed.exitCode, installed.stdout + installed.stderr).toBe(0);
    const requested = await value.invoke('install', ['other/parent'], ['--only', 'requirements']);
    expect(requested.exitCode, requested.stdout + requested.stderr).toBe(0);
    const location = { cwd: value.cwd, env: value.env, scope: 'project' as const };
    const before = await observeIntent(location);

    const removed = await value.invoke('remove', ['dependency'], ['--force']);
    expect(removed.exitCode, removed.stdout + removed.stderr).toBe(3);
    expect(removed.parseJsonStdout()).toMatchObject({ command: 'plugin.remove', status: 'blocked',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'pluginSelectorAmbiguous' })]),
      data: { changes: { requirements: 'none', outputs: 'none' } },
    });
    expect(await observeIntent(location)).toEqual(before);
    expect(await fs.pathExists(value.output('dependency'))).toBe(true);
    expect(await fs.pathExists(value.output('parent'))).toBe(true);
  });
});
