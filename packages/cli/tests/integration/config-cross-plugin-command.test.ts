import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import { resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { normalizePluginCommand } from '@lesliechan721/aw-plugin-core/manifest';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import { runSafeCli } from '../helpers/cli-runtime.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { createCodexNativeTestRuntime } from '../helpers/codex-native-fixture.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import type { OperationIntent } from '../../src/tui/controller.js';
import type { PluginConfigWriteReceipt } from '../../src/utils/plugin-config-write.js';

function isClaudeInvocation(invocation: NativeCliInvocation): boolean {
  return path.basename(invocation.command).replace(/\.(?:cmd|exe)$/iu, '') === 'claude'
    || invocation.args.some((arg) => arg.includes('@anthropic-ai') && arg.includes('claude-code'));
}

async function createNativeReferenceFixture(preApply = false) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  execFileSync('git', ['init', '-q'], { cwd });
  const env = isolation.env;
  const sourceRoot = path.join(cwd, 'cross-config-source');
  const trace = path.join(cwd, 'pre-apply.jsonl');
  const providerRefreshKeys = preApply ? [] : ['registry'];
  for (const name of ['provider', 'consumer']) {
    const pluginRoot = path.join(sourceRoot, 'plugins', name);
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      `const name=${JSON.stringify(name)};`,
      "const files={'SKILL.md':`---\\nname: ${name}\\ndescription: Config reference integration fixture.\\n---\\n# Reference fixture\\n`,'README.md':'# Reference fixture\\n','agents/openai.yaml':'policy:\\n  allow_implicit_invocation: true\\n'};",
      `console.log(JSON.stringify({version:3,components:c.allowedOutputKinds.includes('skill')?[{id:name,kind:'skill',name,content:{files:Object.fromEntries(Object.entries(files).map(([p,text])=>[p,{text}]))},${name === 'consumer' || !preApply ? `runtimeConfig:{keys:${JSON.stringify(name === 'provider' ? ['registry'] : ['selected'])}}` : ''}}]:[],omitted:[],unmet:[]}));`,
    ].join('\n'));
    if (preApply && name === 'consumer') await fs.outputFile(path.join(pluginRoot, 'pre-apply.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(0,'utf8'));",
      `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({plugin:c.plugin.name,scope:c.target.scope,values:c.config.values})+'\\n');`,
    ].join('\n'));
  }
  await createDependencyCatalogSnapshotFixture(sourceRoot, [
    { name: 'provider', requiredCapabilities: ['aw.installed-runtime-config.v2'], configureManifest(manifest) {
      manifest.platforms = ['codex', 'claude'];
      manifest.config = { schemaVersion: 5, fields: { registry: { type: 'array', default: [], validation: { uniqueBy: 'key' }, items: {
        type: 'object', properties: { key: { type: 'string', required: true } }, additionalProperties: false,
      } } } };
      manifest.extensions = undefined;
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
      manifest.artifacts = { configKeys: providerRefreshKeys, scopes: ['user', 'project'] };
    } },
    { name: 'consumer', dependencies: ['provider'], requiredCapabilities: ['aw.installed-runtime-config.v2'], configureManifest(manifest) {
      manifest.platforms = ['codex'];
      manifest.config = { schemaVersion: 5, fields: { selected: { type: 'string', default: 'native', valueRef: {
        plugin: 'provider', field: 'registry', key: 'key', include: ['native'],
      } }, ...(preApply ? {
        hookSelection: { type: 'string', default: 'native', valueRef: { plugin: 'provider', field: 'registry', key: 'key', include: ['native'] } },
        extra: { type: 'number', default: 1 },
      } : {}) } };
      manifest.extensions = undefined;
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } },
        ...(preApply ? { preApply: { path: './pre-apply.mjs' } } : {}) };
      manifest.artifacts = { configKeys: ['selected'], scopes: ['user', 'project'] };
    } },
  ]);
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: snapshot.digest, env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  const native = await createClaudeNativeTestRuntime(isolation);
  const codex = await createCodexNativeTestRuntime(isolation);
  const runner = vi.fn(async (invocation: NativeCliInvocation) => isClaudeInvocation(invocation)
    ? native.nativeCliRunner(invocation) : codex.nativeCliRunner(invocation));
  const run = async (args: string[]) => {
    const output = createCapturedCliIo();
    const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false, nativeCliRunner: runner });
    return { exitCode, payload: JSON.parse(output.readStdout()), stderr: output.readStderr() };
  };

  expect(await run(['target', 'set', 'codex'])).toMatchObject({ exitCode: 0 });
  const installedResult = await run(['plugin', 'install', 'team/consumer', '--scope', 'project', '--yes']);
  expect(installedResult, JSON.stringify(installedResult)).toMatchObject({exitCode:0});
  const source = (await resolveCatalogOperationContext({ sourceIds: ['team'], env })).catalog.sources[0]!.resolution!;
  const store = (pluginName: string, platform?: 'codex') => ({ sourceId: 'team', sourceIdentity: source.sourceIdentity,
    logicalIdentity: source.logicalIdentity, pluginName, scope: 'user' as const, ...(platform ? { platform } : {}), cwd, env });
  const binding = path.join([...codex.marketplaces.values()][0]!, 'plugins/consumer/skills/consumer/.aw-runtime-config.json');
  return { cwd, env, trace, runner, run, store, binding };
}

describe('cross-plugin public config apply', () => {
  beforeEach(() => { installNativeTestDiscovery({ platforms: ['codex', 'claude'] }); });

  // Test Value Gate: applying a provider's common config discovers a dependent package without Intent
  // and leaves the identically named package from another source untouched.
  it('updates only the installed same-source route using the newly valid configuration reference', async () => {
    const { layout, env } = getCurrentSourceTestIsolation();
    const cwd = layout.fixtureCwd;
    const catalog = path.join(cwd, 'catalog');
    const root = path.join(catalog, 'plugins/consumer');
    await fs.outputFile(path.join(root, 'commands/native.mjs'), 'process.exitCode = 0;\n');
    await fs.outputFile(path.join(root, 'commands/remote.mjs'), 'process.exitCode = 0;\n');
    await fs.outputFile(path.join(root, 'render.mjs'), [
      "import fs from 'node:fs';",
      "const c = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, 'utf8'));",
      "const fallback = { runner: 'node', entry: c.config.values.selected + '.mjs' };",
      "console.log(JSON.stringify({version: 2, artifacts: [{id: 'command-routes', target: 'aw.command-routes', kind: 'commandRoutes', refreshKeys: ['selected'], routes: {fallback}}]}));",
    ].join('\n'));
    await createDependencyCatalogSnapshotFixture(catalog, [
      { name: 'provider', configureManifest(manifest) {
        manifest.platforms = ['claude'];
        manifest.config = { schemaVersion: 5, fields: { registry: { type: 'array', default: [],
          validation: { uniqueBy: 'key' }, items: { type: 'object', properties: { key: { type: 'string', required: true } }, additionalProperties: false } } } };
      } },
      { name: 'consumer', dependencies: ['provider'], configureManifest(manifest) {
        manifest.platforms = ['claude'];
        manifest.config = { schemaVersion: 5, fields: { selected: { type: 'string', default: 'native', valueRef: {
          plugin: 'provider', field: 'registry', key: 'key', include: ['native'],
        } } } };
        manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
        manifest.command = normalizePluginCommand({ sourceDir: './commands', mode: 'dynamic', refreshKeys: ['selected'] }, manifest);
      } },
    ]);
    const run = async (args: string[]) => {
      const output = createCapturedCliIo();
      const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false });
      return { exitCode, payload: JSON.parse(output.readStdout()), stderr: output.readStderr() };
    };
    for (const id of ['team', 'other']) {
      expect(await run(['source', 'add', id, '--path', catalog, '--no-auto-check'])).toMatchObject({ exitCode: 0 });
      expect(await run(['source', 'sync', id])).toMatchObject({ exitCode: 0 });
      const sync = await run(['command', 'package', 'sync', id + '/consumer', '--yes']);
      expect(sync, JSON.stringify(sync)).toMatchObject({ exitCode: 0 });
    }
    const show = async (source: string) => (await run(['command', 'show', source + '/consumer'])).payload.data.commands[0];
    const foreign = await show('other');
    const pluginSource = (await resolveCatalogOperationContext({ sourceIds: ['team'], env })).catalog.sources[0]!.resolution!;
    // A previously made pending value becomes valid when the provider supplies its option.
    await writePluginConfigStore({ sourceId: 'team', sourceIdentity: pluginSource.sourceIdentity, logicalIdentity: pluginSource.logicalIdentity,
      pluginName: 'consumer', scope: 'user', cwd, env, values: { selected: 'remote' } });
    const mutation = ['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'user', '--value-json', '[{"key":"remote"}]', '--apply'];
    const review = await run(mutation);
    expect(review, JSON.stringify(review)).toMatchObject({
      exitCode: 3, payload: { data: { confirmation: { effects: expect.arrayContaining([
        expect.objectContaining({ code: 'reviewCommandPackage', subject: { pluginId: 'team/consumer', scope: 'user' } }),
      ]) } } },
    });
    const applied = await run([...mutation, '--yes']);
    expect(applied, JSON.stringify(applied)).toMatchObject({
      exitCode: 0, payload: { data: { apply: { targetResults: [], commandResults: [
        { selector: 'team/consumer', action: 'updated', hasFallback: true, state: 'completed', blockerCodes: [] },
      ] } } },
    });
    expect((await show('team')).routes.fallback.entry).toBe('remote.mjs');
    expect(await show('other')).toEqual(foreign);
    expect(await fs.pathExists(path.join(env.AW_HOME!, 'intent.json'))).toBe(false);
  }, 30_000);

  // Test Value Gate: real intent discovery, source binding, script authorization and dependency plans
  // must preserve committed config after one platform fails and allow a later consumer sync to recover.
  // Windows gets a finite completion window for this sequential multi-command flow.
  it('discovers visible consumers, keeps independent targets running, and recovers through consumer sync', async (test) => {
    const timing = createCommandTestTiming(test);
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'cross-config-source');
    const trace = path.join(cwd, 'pre-apply.jsonl');
    let failProvider = false;
    // Release the Codex child while Claude is in the middle of publishing its registration.
    const claudeWriting = Promise.withResolvers<void>();
    const codexRequestedInventory = Promise.withResolvers<void>();
    const { inventoryCatalogSourceReferences: scan } = await import('../../src/utils/catalog-source-references.js');
    const scoped = await import('../../src/recovery/coordinator.js');
    const execute = scoped.executeCheckedScopedInstall;
    const scopedSpy = vi.spyOn(scoped, 'executeCheckedScopedInstall').mockImplementation(async (plan, execution) => {
      if (!failProvider || execution.runtime.batchInstallPlatform !== 'codex') return execute(plan, execution);
      await claudeWriting.promise;
      const admission = execution.runtime.installAdmission!;
      return execute(plan, { ...execution, runtime: { ...execution.runtime,
        installAdmission: {
          get exclusiveGeneration() { return admission.exclusiveGeneration; },
          run(resources, action, signal) {
            const result = admission.run(resources, action, signal);
            if (resources.some((resource) => resource.kind === 'path' && resource.access === 'read')) codexRequestedInventory.resolve();
            return result;
          },
        },
        inventoryCatalogSourceReferences(request) {
          const result = scan(request);
          // An unprotected scan sees the unfinished file before the native call can complete.
          codexRequestedInventory.resolve(result.then(() => undefined));
          return result;
        },
      } });
    });
    test.onTestFinished(() => scopedSpy.mockRestore());
    const { native, codex } = await timing.measure('fixture', 'catalog-and-clients', async () => {
      for (const name of ['provider', 'consumer']) {
        const pluginRoot = path.join(sourceRoot, 'plugins', name);
        await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
          "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
          `const name=${JSON.stringify(name)};`,
          "const files={'SKILL.md':`---\\nname: ${name}\\ndescription: Config reference integration fixture.\\n---\\n# Reference fixture\\n`,'README.md':'# Reference fixture\\n','agents/openai.yaml':'policy:\\n  allow_implicit_invocation: true\\n'};",
          `const binding = c.platform === 'codex' ? { runtimeConfig: { keys: ${JSON.stringify(name === 'provider' ? ['registry'] : ['selected'])} } } : {};`,
          "if (c.platform === 'claude') files['README.md'] += JSON.stringify(c.config.values.registry);",
          "console.log(JSON.stringify({version:3,components:c.allowedOutputKinds.includes('skill')?[{id:name,kind:'skill',name,...binding,content:{files:Object.fromEntries(Object.entries(files).map(([p,text])=>[p,{text}]))}}]:[],omitted:[],unmet:[]}));",
        ].join('\n'));
        if (name === 'provider') await fs.outputFile(path.join(pluginRoot, 'pre-apply.mjs'), [
          "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(0,'utf8'));",
          `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({plugin:c.plugin.name,platform:c.target.platform})+'\\n');`,
        ].join('\n'));
      }
      await createDependencyCatalogSnapshotFixture(sourceRoot, [
        { name: 'provider', requiredCapabilities: ['aw.installed-runtime-config.v2'], configureManifest(manifest) {
          manifest.platforms = ['codex', 'claude'];
          manifest.config = { schemaVersion: 5, fields: { registry: { type: 'array', default: [], validation: { uniqueBy: 'key' }, items: {
            type: 'object', properties: { key: { type: 'string', required: true } }, additionalProperties: false,
          } } } };
          manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } }, preApply: { path: './pre-apply.mjs' } };
          manifest.artifacts = { configKeys: ['registry'], scopes: ['user', 'project'] };
          } },
        { name: 'consumer', dependencies: ['provider'], requiredCapabilities: ['aw.installed-runtime-config.v2'], configureManifest(manifest) {
          manifest.platforms = ['codex'];
          manifest.config = { schemaVersion: 5, fields: { selected: { type: 'string', default: 'native', valueRef: {
            plugin: 'provider', field: 'registry', key: 'key', include: ['native'],
          } } } };
          manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
          manifest.artifacts = { configKeys: ['selected'], scopes: ['user', 'project'] };
          } },
      ]);
      const snapshot = await readCatalogSourcesConfigSnapshot(env);
      await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: snapshot.digest, env });
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
      const native = await createClaudeNativeTestRuntime(isolation);
      const codex = await createCodexNativeTestRuntime(isolation, { rejectAdd: (id) => failProvider && id.startsWith('provider@') });
      return { native, codex };
    });
    const runner = vi.fn(async (invocation: NativeCliInvocation) => {
      if (failProvider && isClaudeInvocation(invocation) && invocation.args.includes('update')) {
        const before = await fs.readFile(native.installedPath);
        await fs.writeFile(native.installedPath, '{');
        claudeWriting.resolve();
        try {
          await codexRequestedInventory.promise;
        } finally { await fs.writeFile(native.installedPath, before); }
      }
      return isClaudeInvocation(invocation) ? native.nativeCliRunner(invocation) : codex.nativeCliRunner(invocation);
    });
    const run = (args: string[]) => timing.measure('command',
      args.slice(0, args[0] === 'plugin' && args[1] === 'config' ? 3 : 2).join(' '), async (sequence) => {
        const output = createCapturedCliIo();
        const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false,
          nativeCliRunner: runner, onEvent: (event) => timing.commandEvent(sequence, event) });
        return { exitCode, payload: JSON.parse(output.readStdout()), stderr: output.readStderr() };
      });
    expect(await run(['target', 'set', 'codex'])).toMatchObject({ exitCode: 0 });
    const initial = await run(['plugin', 'install', 'team/consumer', '--scope', 'user', '--yes']);
    expect(initial, JSON.stringify(initial)).toMatchObject({
      exitCode: 0, payload: {
        schemaVersion: 2,
        status: 'success'
      }
    });
    expect(await run(['target', 'set', 'codex', 'claude', '--yes'])).toMatchObject({ exitCode: 0 });
    const claude = await run(['plugin', 'install', 'team/provider', '--scope', 'user', '--yes']);
    expect(claude, JSON.stringify(claude)).toMatchObject({ exitCode: 0 });
    const [claudeProvider] = native.packageRoots.values();
    expect(claudeProvider).toBeDefined();
    const renderedRegistry = path.join(claudeProvider!, 'skills/provider/README.md');
    expect(await fs.readFile(renderedRegistry, 'utf8')).toContain('[]');
    const source = (await resolveCatalogOperationContext({ sourceIds: ['team'], env })).catalog.sources[0]!.resolution!;
    // A manual edit can leave a previously installed consumer invalid until the missing key is added.
    await writePluginConfigStore({ sourceId: 'team', sourceIdentity: source.sourceIdentity, logicalIdentity: source.logicalIdentity,
      pluginName: 'consumer', scope: 'user', cwd, env, values: { selected: 'remote' } });
    const consumerBinding = path.join([...codex.marketplaces.values()][0]!, 'plugins/consumer/skills/consumer/.aw-runtime-config.json');
    const before = await fs.readFile(consumerBinding);
    const savedOnly = await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'user', '--value-json', '[{"key":"unrelated"}]']);
    expect(savedOnly, JSON.stringify(savedOnly)).toMatchObject({
      exitCode: 0, payload: {
        schemaVersion: 2,
        data: {
          configWrite: 'succeeded',
          apply: { reason: 'notRequested' }
        }
      }
    });
    expect(await fs.readFile(consumerBinding)).toEqual(before);
    const providerBinding = path.join([...codex.marketplaces.values()][0]!, 'plugins/provider/skills/provider/.aw-runtime-config.json');
    expect((await fs.readJson(providerBinding)).effectiveValues.registry).toEqual([]);
    await fs.writeFile(trace, '');
    failProvider = true;
    const applyCalls = runner.mock.calls.length;
    const saved = await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'user', '--value-json', '[{"key":"remote"}]', '--apply', '--yes']);
    expect(saved, JSON.stringify(saved)).toMatchObject({
      exitCode: 4, payload: {
        schemaVersion: 2,
        status: 'partial',
        data: {
          configWrite: 'succeeded',
          apply: { state: 'partial' }
        }
      }
    });
    expect(saved.payload.data.apply.targetResults.map((entry: { target: { pluginName: string; platform: string } }) =>
      `${entry.target.pluginName}/${entry.target.platform}`).sort()).toEqual(['consumer/codex', 'provider/claude', 'provider/codex']);
    expect(saved.payload.data.apply.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ pluginName: 'provider', platform: 'codex' }), state: 'failed' }),
      expect.objectContaining({ target: expect.objectContaining({ pluginName: 'provider', platform: 'claude' }), state: 'completed' }),
      expect.objectContaining({ target: expect.objectContaining({ pluginName: 'consumer', platform: 'codex' }), state: 'skipped', errorCode: 'dependencyApplyFailed' }),
    ]));
    expect(await fs.readFile(renderedRegistry, 'utf8')).toContain('"remote"');
    const codexAdds = runner.mock.calls.slice(applyCalls).map(([invocation]) => invocation)
      .filter((invocation) => !isClaudeInvocation(invocation) && invocation.args.includes('add'))
      .flatMap((invocation) => invocation.args.filter((arg) => arg.includes('@')));
    expect(codexAdds.map((id) => id.split('@')[0])).toEqual(['provider']);
    expect(saved.payload.diagnostics).toContainEqual(expect.objectContaining({
      code: 'dependencyApplyFailed',
      subject: { pluginId: 'team/consumer', target: 'codex', scope: 'user' }
    }));
    expect(saved.payload.nextActions).toContainEqual(expect.objectContaining({
      kind: 'command',
      argv: ['aw', 'plugin', 'sync', 'team/consumer', '--context', 'user', '--target', 'codex'], requiresConfirmation: true
    }));
    expect((await fs.readJson(resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'provider', scope: 'user', cwd, env }))).common.registry).toEqual([{ key: 'remote' }]);
    expect(await fs.readFile(consumerBinding)).toEqual(before);
    expect((await fs.readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).platform).sort()).toEqual(['claude', 'codex']);
    failProvider = false;
    const recovered = await run(['plugin', 'sync', 'team/consumer', '--target', 'codex', '--context', 'user', '--yes']);
    expect(recovered, JSON.stringify(recovered)).toMatchObject({
      exitCode: 0, payload: {
        schemaVersion: 2,
        status: 'success'
      }
    });
    expect((await fs.readJson(consumerBinding)).effectiveValues).toEqual({ selected: 'remote' });
    expect((await fs.readJson(providerBinding)).effectiveValues.registry).toEqual([{ key: 'remote' }]);
  }, process.platform === 'win32' ? 60_000 : 30_000);
  // Test Value Gate: missing CLI confirmation preserves config and shared output; TUI retry uses independently saved values.
  it('requires CLI confirmation before saving shared native changes and retains TUI project apply', async () => {
    const { cwd, env, runner, run, store, binding } = await createNativeReferenceFixture();
    await writePluginConfigStore({ ...store('provider'), values: { registry: [] } });
    await writePluginConfigStore({ ...store('consumer'), values: { selected: 'remote' } });
    const configFile = resolvePluginConfigStorePath(store('provider'));
    const configBefore = await fs.readFile(configFile);
    const artifactBefore = await fs.readFile(binding);
    const rejected = await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'project', '--value-json', '[{"key":"remote"}]', '--apply']);
    expect(rejected, JSON.stringify(rejected)).toMatchObject({
      exitCode: 3, payload: {
        command: 'plugin.config.set', status: 'blocked',
        data: {
          confirmation: {
            required: true, provided: false, effects: expect.arrayContaining([
              expect.objectContaining({
                code: 'replaceSharedOutput', impact: 'shared',
                subject: expect.objectContaining({ pluginId: 'team/provider', target: 'codex', scope: 'project' })
              }),
            ])
          }
        },
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]),
      }
    });
    expect(await fs.readFile(configFile)).toEqual(configBefore);
    expect(await fs.readFile(binding)).toEqual(artifactBefore);
    expect(await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'project', '--value-json', '[{"key":"remote"}]']))
      .toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'succeeded', apply: { reason: 'notRequested' } } } });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({ cwd, env, nativeCliRunner: runner, interactive: false }));
    await dependencies.loadStatus(new AbortController().signal);
    const intent: OperationIntent = { kind: 'configSave', pluginId: 'team/provider', scope: 'user', context: 'project', apply: true,
      retryApply: true };
    const review = await dependencies.prepareReviewEvidence!(intent, new AbortController().signal, () => undefined);
    expect(review.config?.affectedTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginName: 'provider', platform: 'codex', scope: 'project' }),
      expect.objectContaining({ pluginName: 'consumer', platform: 'codex', scope: 'project' }),
    ]));
    expect(review.config?.sharedNativeRenderUnits).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginName: 'provider', dynamicComponents: true, renderScope: 'user' }),
      expect.objectContaining({ pluginName: 'consumer', dynamicComponents: true, renderScope: 'user' }),
    ]));
    const changed = await dependencies.executeIntent(intent, review, new AbortController().signal) as PluginConfigWriteReceipt;
    expect(changed, JSON.stringify(changed)).toMatchObject({ configWrite: 'notStarted', apply: { state: 'succeeded' } });
    expect((await fs.readJson(binding)).effectiveValues).toEqual({ selected: 'remote' });
    expect(changed.apply.targetResults).toEqual(expect.arrayContaining([expect.objectContaining({
      target: expect.objectContaining({ pluginName: 'consumer', platform: 'codex', scope: 'project' }), state: 'completed',
    })]));
    await dependencies.loadStatus(new AbortController().signal);
    const retry = await dependencies.prepareReviewEvidence!({ ...intent, updates: undefined, retryApply: true }, new AbortController().signal, () => undefined);
    expect(retry.config?.sharedNativeRenderUnits).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginName: 'provider', dynamicComponents: true, renderScope: 'user' }),
      expect.objectContaining({ pluginName: 'consumer', dynamicComponents: true, renderScope: 'user' }),
    ]));
  }, 30_000);
  // Test Value Gate: saved config does not authorize hooks, and a native project hook must bind its platform profile.
  it('authorizes foreign hook-only changes and rejects stale project preApply inputs without changing shared user content', async () => {
    const { cwd, env, trace, runner, run, store, binding } = await createNativeReferenceFixture(true);
    await writePluginConfigStore({ ...store('provider'), values: { registry: [] } });
    await writePluginConfigStore({ ...store('consumer', 'codex'), values: { hookSelection: 'remote', extra: 1 } });
    const providerFile = resolvePluginConfigStorePath(store('provider'));
    const configBefore = await fs.readFile(providerFile);
    const artifactBefore = await fs.readFile(binding);
    await fs.outputFile(trace, '');
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({ cwd, env, nativeCliRunner: runner, interactive: false }));
    await dependencies.loadStatus(new AbortController().signal);
    const configIntent: OperationIntent = { kind: 'configSave', pluginId: 'team/provider', scope: 'user', context: 'project', apply: true,
      updates: { registry: [{ key: 'remote' }] } };
    const review = await dependencies.prepareReviewEvidence!(configIntent, new AbortController().signal, () => undefined);
    expect(review.config?.affectedTargets).toContainEqual(expect.objectContaining({ pluginName: 'consumer', platform: 'codex', scope: 'project' }));
    expect(review.config?.sharedNativeRenderUnits ?? []).toEqual([]);
    expect(review.config?.preApplyAuthorization).toContainEqual(expect.objectContaining({ pluginId: 'team/consumer', scope: 'project' }));
    const rejected = await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'project', '--value-json', '[{"key":"remote"}]', '--apply']);
    expect(rejected, JSON.stringify(rejected)).toMatchObject({
      exitCode: 3, payload: {
        command: 'plugin.config.set', status: 'blocked',
        data: {
          confirmation: {
            required: true, provided: false, effects: expect.arrayContaining([
              expect.objectContaining({
                code: 'runPreApply', impact: 'unknown',
                subject: expect.objectContaining({ pluginId: 'team/consumer', target: 'codex', scope: 'project' })
              }),
            ])
          }
        },
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]),
      }
    });
    expect(await fs.readFile(providerFile)).toEqual(configBefore);
    expect(await fs.readFile(binding)).toEqual(artifactBefore);
    expect(await fs.readFile(trace, 'utf8')).toBe('');
    expect(await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'project', '--value-json', '[{"key":"remote"}]']))
      .toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'succeeded', apply: { reason: 'notRequested' } } } });
    const retryIntent: OperationIntent = { ...configIntent, updates: undefined, retryApply: true };
    const authorized = await dependencies.prepareReviewEvidence!(retryIntent, new AbortController().signal, () => undefined);
    expect(authorized.config?.preApplyAuthorization, JSON.stringify({
      affectedTargets: authorized.config?.affectedTargets,
      sharedNativeRenderUnits: authorized.config?.sharedNativeRenderUnits,
    })).toContainEqual(expect.objectContaining({ pluginId: 'team/consumer', scope: 'project' }));
    await expect(dependencies.executeIntent(retryIntent, authorized, new AbortController().signal))
      .resolves.toMatchObject({ apply: { state: 'succeeded' } });
    expect((await fs.readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
      .toContainEqual(expect.objectContaining({ plugin: 'consumer', scope: 'project', values: expect.objectContaining({ hookSelection: 'remote', extra: 1 }) }));
    expect(await fs.readFile(binding)).toEqual(artifactBefore);

    await dependencies.loadStatus(new AbortController().signal);
    const prepareSync = () => dependencies.prepareScopedTask!({ kind: 'recovery', command: 'sync',
      selectors: ['team/consumer'], targets: ['codex'], scope: 'project' }, new AbortController().signal);
    const syncReview = await prepareSync();
    if (syncReview.kind !== 'recovery') throw new Error('Expected a recovery Review');
    try {
      await writePluginConfigStore({ ...store('consumer', 'codex'), values: { hookSelection: 'remote', extra: 2 } });
      await fs.outputFile(trace, '');
      await expect(dependencies.executeScopedTask!(syncReview)).resolves.toMatchObject({
        kind: 'recovery', receipt: { ok: false, blockers: [expect.objectContaining({ code: 'operationReviewStale' })] },
      });
      expect(await fs.readFile(trace, 'utf8')).toBe('');
      expect(await fs.readFile(binding)).toEqual(artifactBefore);
    } finally { await syncReview.plan.context.dispose(); }
    const freshReview = await prepareSync();
    if (freshReview.kind !== 'recovery') throw new Error('Expected a recovery Review');
    try {
      await expect(dependencies.executeScopedTask!(freshReview))
        .resolves.toMatchObject({ kind: 'recovery', receipt: { ok: true } });
    } finally { await freshReview.plan.context.dispose(); }
    expect((await fs.readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
      .toContainEqual(expect.objectContaining({ plugin: 'consumer', scope: 'project', values: expect.objectContaining({ hookSelection: 'remote', extra: 2 }) }));
    expect((await fs.readJson(binding)).effectiveValues).toEqual({ selected: 'native' });
  }, 30_000);

});
