import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeCommandDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import { resolveCommandSourceDirectory } from '../../src/utils/artifact-sources.js';
import { managedCommandProducerIdentity, prepareManagedCommandPackageFiles } from '../../src/utils/managed-command-materialization.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { listManagedCommands } from '../../src/utils/managed-command-store.js';
import { createIsolatedTestEnv, type IsolatedTestEnvironment } from '../helpers/test-isolation.js';

describe('managed command package materialization', () => {
  let isolated: IsolatedTestEnvironment;
  let sourceRoot: string;
  const entry = normalizeCommandDefinition({ key: 'run', runner: 'node', entry: 'entry.mjs' });

  beforeEach(async () => {
    isolated = await createIsolatedTestEnv();
    sourceRoot = path.join(isolated.layout.fixtureCwd, 'plugin', 'tools');
    await fs.outputFile(path.join(sourceRoot, 'entry.mjs'), 'import "./helper.mjs";\n');
    await fs.outputFile(path.join(sourceRoot, 'helper.mjs'), 'export const value = 1;\n');
    await fs.outputFile(path.join(sourceRoot, 'config.json'), '{"mode":"source"}\n');
    await fs.chmod(path.join(sourceRoot, 'entry.mjs'), 0o755);
  });
  afterEach(async () => { await isolated.cleanup(); });

  // Native static payload paths have no activation scope, so their IDs must not depend on the caller's project.
  it('gives static native Skills one shared user identity across both platforms and project activations', async () => {
    const pluginRoot = path.dirname(sourceRoot);
    await fs.outputFile(path.join(pluginRoot, 'skills', 'provider', 'SKILL.md'), '---\nname: provider\ndescription: Shared static fixture.\n---\n');
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3, name: 'static-identity', version: '1.0.0', description: 'Static identity fixture.', skills: './skills',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    });
    const plugin = { ...await readPluginManifest(pluginRoot), sourceId: 'fixture', sourceIdentity: `sha256:${'a'.repeat(64)}` };
    for (const platform of ['codex', 'claude'] as const) {
      const identities = await Promise.all((['user', 'project', 'project'] as const).map((scope, index) => managedCommandProducerIdentity({
        plugin, producer: { kind: 'static-skill', platform, skillKey: 'provider' }, platform, scope,
        cwd: path.join(isolated.layout.fixtureCwd, `project-${index}`),
      })));
      expect(identities[0]).toMatchObject({ kind: 'static-skill', platform, scope: 'user', projectRoot: null });
      expect(identities).toEqual([identities[0], identities[0], identities[0]]);
    }
  });

  // Protects readonly source preparation, complete resources, and absence of real command publication.
  it('prepares final configuration in an isolated complete candidate and preserves source execution modes', async () => {
    const candidate = await prepareManagedCommandPackageFiles({ sourceRoot, files: { 'config.json': '{"mode":"configured"}\n' }, entries: [entry] });
    try {
      expect(await fs.readJson(path.join(candidate.resourceRoot, 'config.json'))).toEqual({ mode: 'configured' });
      expect(await fs.readJson(path.join(sourceRoot, 'config.json'))).toEqual({ mode: 'source' });
      expect(await fs.readFile(path.join(candidate.resourceRoot, 'helper.mjs'), 'utf8')).toContain('value = 1');
      if (process.platform !== 'win32') expect((await fs.stat(path.join(candidate.resourceRoot, 'entry.mjs'))).mode & 0o111).toBe(0o111);
      expect((await listManagedCommands(isolated.env)).commands).toEqual([]);
    } finally { await candidate.cleanup(); }
    expect(await fs.pathExists(candidate.resourceRoot)).toBe(false);
  });

  // Protects the package source executable closure and AW-owned metadata from renderer overlays.
  it('rejects generated entry, executable companion, and protected file replacements', async () => {
    for (const relative of ['entry.mjs', 'helper.mjs', '.aw-command-producer.json', '.aw-runtime-config.json', 'evals/result.json']) {
      await expect(prepareManagedCommandPackageFiles({ sourceRoot, files: { [relative]: '{}' }, entries: [entry] })).rejects.toMatchObject({ code: 'commandResourceInvalid' });
    }
    expect(await fs.readFile(path.join(sourceRoot, 'helper.mjs'), 'utf8')).toBe('export const value = 1;\n');
    await fs.remove(path.join(sourceRoot, 'helper.mjs'));
    await expect(prepareManagedCommandPackageFiles({ sourceRoot, files: {}, entries: [entry] })).rejects.toThrow();
  });

  // Protects context and package preparation from realpath hiding a source-directory symbolic link.
  it('rejects symbolic links at each command source path segment', async () => {
    const bundleRoot = path.dirname(sourceRoot);
    expect(await resolveCommandSourceDirectory({ bundleRoot, pluginRelativePath: './tools' })).toBe(sourceRoot);
    await fs.symlink(sourceRoot, path.join(bundleRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(resolveCommandSourceDirectory({ bundleRoot, pluginRelativePath: './linked' })).rejects.toThrow('commandResourceInvalid');
    await expect(resolveCommandSourceDirectory({ bundleRoot, pluginRelativePath: '../tools' })).rejects.toThrow('commandResourceInvalid');
  });
});
