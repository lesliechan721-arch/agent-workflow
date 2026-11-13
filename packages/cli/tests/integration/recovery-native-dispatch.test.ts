import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { buildCatalogWorkspace, initializeCatalogWorkspace } from '@lesliechan721/aw-plugin-core';

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
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import * as registry from '../../src/platforms/registry.js';
import * as rebuildCommand from '../../src/commands/rebuild-command.js';
import * as demandModule from '../../src/recovery/demand.js';
import * as nativeCliModule from '../../src/utils/native-cli.js';
import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { geminiActivationRules, geminiExtensionPaths, geminiPathEnabled, geminiScopePattern, readGeminiActivationSnapshot } from '../../src/platforms/gemini-activation.js';
import type { ReadContext } from '../../src/platforms/contracts.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { bundleLocalPlugin } from '../../src/generators/local-plugin.js';
import { createCatalogRuntimeImportResolver } from '../../src/utils/catalog-runtime-projection.js';

describe('native recovery dispatch', () => {
  // Test Value Gate: Project retirement must use the real recovery preparation
  // after static upgrades and a same-version dynamic package refresh. Shared
  // references and a foreign sibling must keep their own bytes and activation.
  it.each([false, true])('removes a dynamic Gemini Project demand with shared reference=%s', async (shared) => {
    const { env, layout } = getCurrentSourceTestIsolation();
    const home = geminiExtensionPaths({ cwd: layout.fixtureCwd, env }).home;
    const cwd = path.join(home, 'gemini-project');
    const neutral = path.join(home, 'neutral');
    const otherProject = path.join(home, 'other-project');
    const workspace = path.join(layout.fixtureCwd, 'gemini-workspace');
    const source = path.join(workspace, '.aw/catalog');
    const pluginRoot = path.join(workspace, 'plugins/demo');
    const manifestFile = path.join(pluginRoot, '.agents-plugin/plugin.json');
    const config = geminiExtensionPaths({ cwd, env }).file;
    await Promise.all([fs.ensureDir(cwd), fs.ensureDir(neutral), fs.ensureDir(otherProject)]);
    await git(cwd, ['init', '--quiet']);
    await fs.ensureDir(workspace);
    await initializeCatalogWorkspace({ workspaceRoot: workspace });
    const body = (revision: number) => `---\nname: demo\ndescription: Gemini revision ${revision}.\n---\nRevision ${revision}.\n`;
    await fs.outputFile(path.join(pluginRoot, 'skills/demo/SKILL.md'), body(1));
    await fs.outputFile(path.join(pluginRoot, 'skills/demo/README.md'), 'Fixture skill.\n');
    await fs.outputJson(manifestFile, {
      schemaVersion: 4, name: 'demo', version: '1.0.0', description: 'Gemini recovery fixture.',
      platforms: ['gemini'], skills: './skills', marketplace: { category: 'test', strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    });
    await fs.outputFile(path.join(pluginRoot, 'README.md'), 'Gemini recovery fixture.\n');
    const configured = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ env, expectedDigest: configured.digest,
      config: { schemaVersion: 2, sources: [{ id: 'local', type: 'path', primary: true, path: source }] } });
    const activate = async () => {
      await buildCatalogWorkspace({ workspaceRoot: workspace, force: true, adapter: {
        async build(options) {
          await bundleLocalPlugin(options.plugin, options.outputRoot, { buildMode: 'staging', commandEnv: env,
            runtimeResolver: createCatalogRuntimeImportResolver(options.plugins) });
        },
      } });
      await syncCatalogSourceGeneration({ sourceId: 'local', cliVersion: '1.0.0', env });
    };
    await activate();
    await setTargets({ cwd, env, scope: 'user' }, ['gemini']);
    installNativeTestQualification({ platforms: ['gemini'] });
    const getAdapter = registry.getAgentPluginAdapter;
    const adapter = getAdapter('gemini');
    const executable = path.join(layout.fixtureCwd, 'gemini-controlled-client');
    await fs.outputFile(executable, 'controlled native boundary');
    const discovery = vi.spyOn(registry, 'getAgentPluginAdapter').mockImplementation((platform) => platform === 'gemini' ? { ...adapter,
      async discover(ctx: ReadContext) { return { platform: 'gemini' as const, availability: 'available' as const, diagnostics: [], installations: [{
        id: 'controlled:gemini', product: 'cli' as const, version: '0.67.0', availability: 'available' as const, reasonCodes: [],
        entry: { kind: 'cli' as const, executable, configRoot: resolvePlatformConfigRoot('gemini', ctx) },
      }] }; },
    } : getAdapter(platform));
    onTestFinished(() => discovery.mockRestore());
    const nativeErrors: string[] = [];
    const nativeOutcomes: unknown[] = [];
    const runRebuildCommand = rebuildCommand.runRebuildCommand;
    const diagnostic = vi.spyOn(rebuildCommand, 'runRebuildCommand').mockImplementation(async (options) => {
      nativeOutcomes.push({ phase: 'rebuild-enter', command: options.command, preview: options.runtime?.previewOperationPlan === true,
        plugins: options.pluginNames, scope: options.commandOptions.scope, platform: options.commandOptions.platform });
      try {
        const result = await runRebuildCommand(options);
        nativeOutcomes.push({ phase: 'rebuild-return',
          command: options.command, preview: options.runtime?.previewOperationPlan === true,
          overallState: result.overallState, rebuildResults: result.rebuildResults,
          targetResults: result.targetResults, commandResults: result.commandResults, warnings: result.warnings,
          emptyRebuildResults: result.rebuildResults.length === 0, dependencyTargets: result.dependencyPlan?.targets,
          operationPlan: result.operationPlan ? { actions: result.operationPlan.actions,
            deployments: result.operationPlan.deploymentPlans?.map((plan) => ({ binding: plan.binding.id, scope: plan.binding.scope,
              operation: plan.operation, effects: plan.effects })) } : undefined,
        });
        return result;
      }
      catch (error) { nativeErrors.push(error instanceof Error ? error.stack ?? error.message : String(error)); throw error; }
    });
    onTestFinished(() => diagnostic.mockRestore());
    const projectDemand = demandModule.demandNativeProjection;
    const demandDiagnostic = vi.spyOn(demandModule, 'demandNativeProjection').mockImplementation((demand) => {
      try {
        const result = projectDemand(demand);
        nativeOutcomes.push({ phase: 'native-demand', scope: demand.scope, requirements: result });
        return result;
      } catch (error) {
        nativeErrors.push(`Native demand: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        throw error;
      }
    });
    onTestFinished(() => demandDiagnostic.mockRestore());
    const prepareNative = nativeCliModule.prepareNativeCliExecution;
    const admissionDiagnostic = vi.spyOn(nativeCliModule, 'prepareNativeCliExecution').mockImplementation(async (options) => {
      try { await prepareNative(options); }
      catch (error) {
        nativeErrors.push(`Native admission: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        throw error;
      }
    });
    onTestFinished(() => admissionDiagnostic.mockRestore());
    let packageRoot = '';
    const installed = path.join(geminiExtensionPaths({ cwd, env }).root, 'demo');
    const mutations: string[] = [];
    const runner = async (invocation: NativeCliInvocation) => {
      const action = invocation.args[1];
      expect(invocation.args[0]).toBe('extensions');
      expect(['install', 'update', 'uninstall']).toContain(action);
      mutations.push(action!);
      const value: Record<string, { overrides: string[] }> = await fs.pathExists(config) ? await fs.readJson(config) : {};
      if (action === 'uninstall') {
        await fs.remove(installed);
        delete value.demo;
        await fs.outputFile(config, JSON.stringify(Object.fromEntries(Object.entries(value).map(([id, entry]) => [id, { overrides: entry.overrides }])), null, 2));
      } else {
        if (action === 'install') packageRoot = invocation.args[2]!;
        await fs.remove(installed);
        await fs.copy(packageRoot, installed);
        await fs.outputJson(path.join(installed, '.gemini-extension-install.json'), { type: 'local', source: packageRoot });
        if (action === 'install') {
          // The fixture workspaces are below HOME. Fixed User enable removes
          // their rules and appends HOME; AW must restore the reviewed rules.
          value.demo = { overrides: [...(value.demo?.overrides ?? []).filter((rule) => rule === '*' || rule === '!*'), geminiScopePattern(home)] };
          await fs.outputFile(config, JSON.stringify(value, null, 2));
        }
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const nativeCliRunner = async (invocation: NativeCliInvocation) => {
      try { return await runner(invocation); }
      catch (error) {
        nativeErrors.push(`Controlled native ${JSON.stringify(invocation.args)}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        throw error;
      }
    };
    const failureContext = (result: unknown) => JSON.stringify({ result, nativeOutcomes }) + '\n' + nativeErrors.join('\n');
    const options = { cwd, env, scope: 'project' as const, context: 'project' as const, cliVersion: '1.0.0', yes: true, nativeConsent: true };
    const apply = async (command: 'install' | 'sync') => {
      nativeErrors.length = 0; nativeOutcomes.length = 0;
      const result = await runPublicLifecycle(command, ['local/demo'], options, { nativeCliRunner });
      expect(result.status, failureContext(result)).toBe('success');
      return result;
    };
    await apply('install');
    const manifest = await fs.readJson(manifestFile);
    await fs.outputJson(manifestFile, { ...manifest, version: '1.0.1' });
    await fs.outputFile(path.join(pluginRoot, 'skills/demo/SKILL.md'), body(2));
    await activate();
    await apply('sync');
    delete manifest.skills;
    manifest.version = '1.0.1'; manifest.artifacts = { configKeys: [] };
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    await fs.remove(path.join(pluginRoot, 'skills'));
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), `import fs from 'node:fs';\nconst context=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));\nconst plan=${JSON.stringify({ version: 3,
      components: [{ id: 'skill:demo', kind: 'skill', name: 'demo', content: { files: {
        'SKILL.md': { text: body(3) }, 'README.md': { text: 'Generated fixture.\n' },
      } } }], omitted: [], unmet: [] })};\nif(!context.allowedOutputKinds.includes('skill'))plan.components=[];\nconsole.log(JSON.stringify(plan));\n`);
    await fs.outputJson(manifestFile, manifest);
    await activate();
    await apply('sync');
    expect(await fs.readFile(path.join(installed, 'skills/demo/SKILL.md'), 'utf8')).toContain('Revision 3.');
    const foreign = path.join(path.dirname(installed), 'foreign');
    await fs.outputFile(path.join(foreign, 'keep.txt'), 'Foreign data.');
    const before = await fs.readJson(config);
    await fs.outputJson(config, { ...before,
      demo: { ...before.demo, overrides: [...before.demo.overrides, ...(shared ? [geminiScopePattern(otherProject)] : [])] },
      foreign: { overrides: ['*'], retained: 'keep' },
    });
    mutations.length = 0;
    nativeErrors.length = 0; nativeOutcomes.length = 0;
    const removed = await runPublicLifecycle('remove', ['local/demo'], { ...options, nativeConsent: false }, { nativeCliRunner });
    expect(removed.status, failureContext(removed)).toBe('success');
    expect(removed.data?.requirements.roots).toEqual([]);
    expect(mutations).toEqual(shared ? [] : ['uninstall']);
    expect(await fs.pathExists(installed)).toBe(shared);
    expect(await fs.pathExists(packageRoot)).toBe(shared);
    expect(await fs.readFile(path.join(foreign, 'keep.txt'), 'utf8')).toBe('Foreign data.');
    expect((await fs.readJson(config)).foreign).toEqual({ overrides: ['*'], retained: 'keep' });
    if (shared) {
      const rules = geminiActivationRules(await readGeminiActivationSnapshot({ cwd, env }), 'demo');
      expect(geminiPathEnabled(rules, cwd)).toBe(false);
      expect(geminiPathEnabled(rules, neutral)).toBe(false);
      expect(geminiPathEnabled(rules, otherProject)).toBe(true);
    }
  });

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
