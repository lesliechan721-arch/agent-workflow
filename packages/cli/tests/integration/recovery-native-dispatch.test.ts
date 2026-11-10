import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { runRecovery } from '../../src/recovery/coordinator.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

describe('native recovery dispatch', () => {
  // Test Value Gate: a concrete Agent failure must not fall back to scattered Skills or block the independent generic writer.
  it('keeps an unavailable Cursor native target separate from a successful generic output', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.layout.fixtureCwd, 'project');
    const source = path.join(isolation.layout.fixtureCwd, 'catalog');
    const pluginRoot = path.join(source, 'plugins', 'demo');
    const content = '---\nname: demo\ndescription: Fixture skill.\n---\nRun the fixture.\n';
    await fs.ensureDir(cwd);
    await git(cwd, ['init', '--quiet']);
    await fs.outputFile(path.join(pluginRoot, 'skills', 'demo', 'SKILL.md'), content);
    await fs.outputFile(path.join(pluginRoot, 'skills', 'demo', 'README.md'), 'Fixture skill.\n');
    await createCatalogSnapshotFixture(source, 'demo', [], 'Fixture.\n', (manifest) => {
      manifest.schemaVersion = 4;
      manifest.platforms = ['cursor', 'generic'];
      manifest.skills = './skills';
    });
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    const receipt = createAwPluginRequirementsReceipt({ name: 'demo', version: '1.0.0' }, plugin.manifest.requires?.aw.capabilities ?? []);
    for (const platform of ['cursor', 'generic']) {
      await fs.outputJson(path.join(pluginRoot, platform, 'skills', 'demo', 'aw-plugin-requirements.json'), receipt);
    }
    const catalogPath = path.join(source, 'catalog-manifest.json');
    await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries: [await createCatalogManifestV7Entry(plugin, pluginRoot)] });
    const config = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] },
    expectedDigest: config.digest, env: isolation.env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env: isolation.env });
    await writeIntentFixture({ scope: 'project', cwd, env: isolation.env }, {
      roots: [{ pluginId: 'local/demo' }], targets: ['cursor', 'generic'],
    });
    await setTargets({ scope: 'user', cwd, env: isolation.env }, ['cursor', 'generic']);
    const result = await runRecovery('sync', [], { scope: 'project', context: 'project', cwd,
      env: isolation.env, cliVersion: '1.0.0', yes: true }, {
      nativeCliRunner: async () => { throw new Error('fixture client unavailable'); },
    });
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'cursor', delivery: { kind: 'native', platform: 'cursor' },
        observation: 'unknown', blockers: expect.any(Array) }),
      expect.objectContaining({ agent: 'generic', delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' },
        execution: 'applied', content: 'satisfied' }),
    ]));
    expect(result.ok).toBe(false);
    expect(await fs.readFile(path.join(cwd, '.agents', 'skills', 'demo', 'SKILL.md'), 'utf8')).toBe(content);
    expect(await fs.pathExists(path.join(cwd, '.cursor', 'skills'))).toBe(false);
  });

  // Test Value Gate: an executed empty set must remain current through read-only status, until its source inputs change.
  it('persists an intentional empty native set without mutations and invalidates changed inputs', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.layout.fixtureCwd, 'empty-project');
    const source = path.join(isolation.layout.fixtureCwd, 'empty-catalog');
    const pluginRoot = path.join(source, 'plugins', 'empty');
    const bin = path.join(isolation.layout.fixtureCwd, 'bin');
    const rendererCalls = path.join(isolation.layout.fixtureCwd, 'empty-renderer-calls');
    await fs.ensureDir(cwd);
    await git(cwd, ['init', '--quiet']);
    await fs.outputFile(path.join(bin, 'cursor-agent'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'),
      `import fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(rendererCalls)}, 'render\\n');\nprocess.stdout.write(JSON.stringify({ version: 3, components: [], omitted: [], unmet: [] }));\n`);
    await createCatalogSnapshotFixture(source, 'empty', [], 'Empty fixture.\n', (manifest) => {
      manifest.schemaVersion = 4;
      manifest.platforms = ['cursor'];
      manifest.artifacts = { configKeys: [] };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    });
    const env = { ...isolation.env, PATH: bin };
    const config = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: source }] },
    expectedDigest: config.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    await writeIntentFixture({ scope: 'project', cwd, env }, { roots: [{ pluginId: 'local/empty' }], targets: ['cursor'] });
    const nativeCliRunner = async ({ args }: { args: string[] }) => {
      if (args.includes('--version')) return { exitCode: 0, stdout: 'Cursor Agent 2026.11.05-86047df', stderr: '' };
      throw new Error('The empty fixture must not execute native mutations.');
    };
    const result = await runRecovery('sync', [], { scope: 'project', context: 'project', cwd, env,
      cliVersion: '1.0.0', yes: true }, { nativeCliRunner });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const target = result.targetResults.find((entry) => entry.agent === 'cursor')!;
    expect(target).toMatchObject({ execution: 'no-op', content: 'satisfied',
      deploymentReceipts: [expect.objectContaining({ effects: [], unmet: [],
        products: [expect.objectContaining({ product: 'cli', version: '2026.11.05-86047df' })] })],
    });
    expect(result.outputsMayHaveChanged).toBe(false);
    expect(await fs.pathExists(path.join(cwd, '.cursor', 'aw-plugins'))).toBe(false);
    const callsAfterExecute = await fs.readFile(rendererCalls, 'utf8');
    const matched = await readRecoveryStatus({ context: 'project', cwd, env, nativeCliRunner, targets: ['cursor'] });
    expect(matched.allSatisfied, JSON.stringify(matched)).toBe(true);
    expect(await fs.readFile(rendererCalls, 'utf8')).toBe(callsAfterExecute);

    await fs.appendFile(path.join(pluginRoot, 'render.mjs'), '// Changed renderer input.\n');
    const changedPlugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    const catalogPath = path.join(source, 'catalog-manifest.json');
    await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries: [await createCatalogManifestV7Entry(changedPlugin, pluginRoot)] });
    await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    const drifted = await readRecoveryStatus({ context: 'project', cwd, env, nativeCliRunner, targets: ['cursor'] });
    expect(drifted.allSatisfied).not.toBe(true);
    expect(drifted.inventory?.flatMap((entry) => entry.targetResults)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agent: 'cursor', content: 'unknown', blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'dynamicExpectationUnconfirmed' }),
      ]) }),
    ]));
    expect(await fs.readFile(rendererCalls, 'utf8')).toBe(callsAfterExecute);
  });
});
