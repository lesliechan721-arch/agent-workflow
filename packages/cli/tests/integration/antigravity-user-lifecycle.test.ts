import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { buildCatalogWorkspace, initializeCatalogWorkspace } from '@lesliechan721/aw-plugin-core';

import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { createCatalogRuntimeImportResolver } from '../../src/utils/catalog-runtime-projection.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import * as registry from '../../src/platforms/registry.js';
import * as rebuildCommand from '../../src/commands/rebuild-command.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';

describe('public Antigravity User lifecycle', () => {
  // Test Value Gate: the real public preparation, writer, recovery and removal
  // chain must use the copied owner and dynamic bytes. Only the client is fake.
  it('installs, updates, refreshes and removes a dynamic native copy after loss of the AW source', async () => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const cwd = layout.fixtureCwd;
    const workspace = path.join(cwd, 'antigravity-workspace');
    const source = path.join(workspace, '.aw/catalog');
    const pluginRoot = path.join(workspace, 'plugins/demo');
    const manifestPath = path.join(pluginRoot, '.agents-plugin/plugin.json');
    const host = resolvePlatformConfigRoot('antigravity', { cwd, env });
    const installed = path.join(host, 'plugins/demo');
    const oldCopy = path.join(cwd, 'previous-native-copy');
    await fs.ensureDir(workspace);
    await initializeCatalogWorkspace({ workspaceRoot: workspace });
    await fs.outputFile(path.join(pluginRoot, 'README.md'), 'Antigravity fixture.\n');
    const publish = async (revision: number, version: string) => {
      await fs.outputJson(manifestPath, { schemaVersion: 4, name: 'demo', version, description: 'Antigravity fixture.',
        platforms: ['antigravity'], artifacts: { configKeys: [] },
        scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
        marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } } });
      const body = `---\nname: demo\ndescription: Antigravity revision ${revision}.\n---\nRevision ${revision}.\n`;
      await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `import fs from 'node:fs';\nconst context=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));\nconst plan=${JSON.stringify({ version: 3,
        components: [{ id: 'skill:demo', kind: 'skill', name: 'demo', content: { files: {
          'SKILL.md': { text: body }, 'README.md': { text: 'Generated fixture.\n' },
        } } }], omitted: [], unmet: [] })};\nif(!context.allowedOutputKinds.includes('skill'))plan.components=[];\nconsole.log(JSON.stringify(plan));\n`);
      await buildCatalogWorkspace({ workspaceRoot: workspace, force: true, adapter: { async build(options) {
        await bundleLocalPlugin(options.plugin, options.outputRoot, { buildMode: 'staging', commandEnv: env,
          runtimeResolver: createCatalogRuntimeImportResolver(options.plugins) });
      } } });
      await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env, impactConfirmed: true });
    };
    const configured = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ env, expectedDigest: configured.digest,
      config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true, path: source }] } });
    await publish(1, '1.0.0');
    await setTargets({ cwd, env, scope: 'user' }, ['antigravity']);
    installNativeTestQualification({ platforms: ['antigravity'] });
    const getAdapter = registry.getAgentPluginAdapter;
    const adapter = getAdapter('antigravity');
    const executable = path.join(cwd, 'controlled-agy');
    await fs.outputFile(executable, 'controlled native boundary');
    const discovery = vi.spyOn(registry, 'getAgentPluginAdapter').mockImplementation((platform) => platform === 'antigravity' ? { ...adapter,
      async discover(ctx) { return { platform: 'antigravity', availability: 'available', diagnostics: [], installations: [{
        id: 'controlled:antigravity', product: 'cli', version: '1.3.4', availability: 'available', reasonCodes: [],
        entry: { kind: 'cli', executable, configRoot: resolvePlatformConfigRoot('antigravity', ctx) },
      }] }; },
    } : getAdapter(platform));
    onTestFinished(() => discovery.mockRestore());
    const outcomes: unknown[] = [];
    const rebuild = rebuildCommand.runRebuildCommand;
    const diagnostic = vi.spyOn(rebuildCommand, 'runRebuildCommand').mockImplementation(async options => {
      try {
        const result = await rebuild(options);
        outcomes.push({ rebuildResults: result.rebuildResults });
        return result;
      } catch (error) {
        outcomes.push({ error: error instanceof Error ? error.stack : String(error) }); throw error;
      }
    });
    onTestFinished(() => diagnostic.mockRestore());
    let sourceRoot = '';
    let enabled = false;
    const mutations: string[] = [];
    const nativeCliRunner = async (invocation: NativeCliInvocation) => {
      expect(invocation.args[0]).toBe('plugin');
      const action = invocation.args[1]!;
      if (action === 'list') {
        const exists = await fs.pathExists(installed);
        const manifest = exists ? await fs.readJson(path.join(installed, '.antigravity-plugin/plugin.json')) : null;
        return { exitCode: 0, stderr: '', stdout: JSON.stringify(exists ? [{ name: 'demo', enabled, version: manifest.version,
          source: 'antigravity', path: installed, skills: ['demo'] }] : []) };
      }
      mutations.push(action);
      if (action === 'install') {
        sourceRoot = invocation.args[2]!;
        await fs.remove(installed);
        await fs.copy(sourceRoot, installed);
        enabled = true;
      } else if (action === 'uninstall') { await fs.remove(installed); enabled = false; }
      else if (action === 'enable' || action === 'disable') enabled = action === 'enable';
      else throw new Error('Unexpected native mutation.');
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const options = { cwd, env, scope: 'user', context: 'user', cliVersion: '1.0.0', yes: true };
    const apply = async (command: 'install' | 'sync' | 'remove') => {
      const result = await runPublicLifecycle(command, ['local/demo'], options, { nativeCliRunner });
      expect(result.status, JSON.stringify({ result, outcomes })).toBe('success');
      return result;
    };
    await apply('install');
    await fs.copy(installed, oldCopy);
    for (const [revision, version] of [[2, '1.0.1'], [3, '1.0.1']] as const) {
      await publish(revision, version);
      mutations.length = 0;
      await apply('sync');
      expect(mutations).toContain('install');
      expect(mutations).not.toContain('uninstall');
      expect(await fs.readFile(path.join(installed, 'skills/demo/SKILL.md'), 'utf8')).toContain(`Revision ${revision}.`);
      expect((await fs.readJson(path.join(installed, '.antigravity-plugin/plugin.json'))).version).toBe(version);
    }
    // A subsequent ordinary sync repairs the copy even though the AW source
    // already has revision 3 and the native copy's old owner remains valid.
    await fs.remove(installed);
    await fs.copy(oldCopy, installed);
    mutations.length = 0;
    await apply('sync');
    expect(mutations).toContain('install');
    expect(mutations).not.toContain('uninstall');
    expect(await fs.readFile(path.join(installed, 'skills/demo/SKILL.md'), 'utf8')).toContain('Revision 3.');
    const foreign = path.join(host, 'plugins/foreign/keep.txt');
    await fs.outputFile(foreign, 'Foreign data.\n');
    await fs.remove(sourceRoot);
    mutations.length = 0;
    const removed = await apply('remove');
    expect(removed.data?.requirements.roots).toEqual([]);
    expect(mutations, JSON.stringify({ removed, outcomes })).toContain('uninstall');
    expect(await fs.pathExists(installed)).toBe(false);
    expect(await fs.readFile(foreign, 'utf8')).toBe('Foreign data.\n');
  });
});
