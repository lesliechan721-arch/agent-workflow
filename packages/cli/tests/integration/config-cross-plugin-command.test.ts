import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import { resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { runSafeCli } from '../helpers/cli-runtime.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { listManagedCommandPackages } from '../../src/utils/managed-command-store.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import type { OperationIntent } from '../../src/tui/controller.js';
import type { PluginConfigWriteReceipt } from '../../src/utils/plugin-config-write.js';

async function createNativeReferenceFixture(preApply = false) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const env = isolation.env;
  const sourceRoot = path.join(cwd, 'cross-config-source');
  const trace = path.join(cwd, 'pre-apply.jsonl');
  for (const name of ['provider', 'consumer']) {
    const pluginRoot = path.join(sourceRoot, 'plugins', name);
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      `const name=${JSON.stringify(name)};`,
      "const files={'SKILL.md':`---\\nname: ${name}\\ndescription: Config reference integration fixture.\\n---\\n# Reference fixture\\n`,'README.md':'# Reference fixture\\n','agents/openai.yaml':'policy:\\n  allow_implicit_invocation: true\\n'};",
      `console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>({id,target:c.platform+'.skill',kind:'skill',state:'present',platform:c.platform,skillKey:name,refreshKeys:${JSON.stringify(name === 'provider' ? ['registry'] : ['selected'])},content:{files}}))}));`,
    ].join('\n'));
    if (preApply && name === 'consumer') await fs.outputFile(path.join(pluginRoot, 'pre-apply.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(0,'utf8'));",
      `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({plugin:c.plugin.name,scope:c.target.scope,values:c.config.values})+'\\n');`,
    ].join('\n'));
  }
  await createDependencyCatalogSnapshotFixture(sourceRoot, [
    { name: 'provider', configureManifest(manifest) {
      manifest.config = { schemaVersion: 4, fields: { registry: { type: 'array', default: [], validation: { uniqueBy: 'key' }, items: {
        type: 'object', properties: { key: { type: 'string', required: true } }, additionalProperties: false,
      } } } };
      manifest.extensions = undefined;
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
      manifest.artifacts = { targets: [
        { id: 'provider-codex', target: 'codex.skill', platform: 'codex', skillKey: 'provider', scopes: ['user', 'project'], states: ['present'],
          refreshKeys: ['registry'], runtimeConfig: { keys: ['registry'] }, delivery: { mode: 'aw-extension' } },
        { id: 'provider-claude', target: 'claude.skill', platform: 'claude', skillKey: 'provider', scopes: ['user', 'project'], states: ['present'], refreshKeys: ['registry'] },
      ] };
    } },
    { name: 'consumer', dependencies: ['provider'], configureManifest(manifest) {
      manifest.config = { schemaVersion: 4, fields: { selected: { type: 'string', default: 'native', valueRef: {
        plugin: 'provider', field: 'registry', key: 'key', include: ['native'],
      } }, ...(preApply ? {
        hookSelection: { type: 'string', default: 'native', valueRef: { plugin: 'provider', field: 'registry', key: 'key', include: ['native'] } },
        extra: { type: 'number', default: 1 },
      } : {}) } };
      manifest.extensions = undefined;
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } },
        ...(preApply ? { preApply: { path: './pre-apply.mjs' } } : {}) };
      manifest.artifacts = { targets: [{ id: 'consumer-codex', target: 'codex.skill', platform: 'codex', skillKey: 'consumer', scopes: ['user', 'project'],
        states: ['present'], refreshKeys: ['selected'], runtimeConfig: { keys: ['selected'] }, delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' } }] };
    } },
  ]);
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: snapshot.digest, env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  const native = await createClaudeNativeTestRuntime(isolation);
  const configPath = path.join(env.AW_CODEX_HOME!, 'config.toml');
  let installed = false;
  let marketplaceRoot = '';
  const writeConfig = () => fs.outputFile(configPath, [
    ...(marketplaceRoot ? ['[marketplaces.aw]', `source = ${JSON.stringify(marketplaceRoot)}`, 'source_type = "local"', ''] : []),
    ...(installed ? ['[plugins."consumer@aw"]', 'enabled = true', ''] : []),
  ].join('\n'));
  const runner = vi.fn(async (invocation: NativeCliInvocation) => {
    if (invocation.command === 'claude') return native.nativeCliRunner(invocation);
    const args = invocation.args;
    if (args.includes('--version')) return { exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' };
    if (args[1] === 'marketplace' && args[2] === 'add') { marketplaceRoot = args[3]!; await writeConfig(); }
    if (args[1] === 'remove') { installed = false; await writeConfig(); }
    if (args[1] === 'add') {
      installed = true; await writeConfig();
    }
    return { exitCode: 0, stdout: args[1] === 'list' ? JSON.stringify({ installed: installed
      ? [{ pluginId: 'consumer@aw', installed: true, enabled: true, version: '1.0.0' }] : [], available: [] }) : '', stderr: '' };
  });
  const run = async (args: string[]) => {
    const output = createCapturedCliIo();
    const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false, nativeCliRunner: runner });
    return { exitCode, payload: JSON.parse(output.readStdout()), stderr: output.readStderr() };
  };

  const installedResult = await run(['install', 'team/consumer', '--platform', 'codex', '--scope', 'project', '--yes']);
  expect(installedResult, JSON.stringify(installedResult)).toMatchObject({exitCode:0});
  const source = (await resolveCatalogOperationContext({ sourceIds: ['team'], env })).catalog.sources[0]!.resolution!;
  const store = (pluginName: string, scope: 'user' | 'project') => ({ sourceId: 'team', sourceIdentity: source.sourceIdentity,
    logicalIdentity: source.logicalIdentity, pluginName, scope, cwd, env });
  const binding = path.join(marketplaceRoot, 'plugins/consumer/codex/skills/consumer/.aw-runtime-config.json');
  return { cwd, env, trace, runner, run, store, binding };
}

describe('cross-plugin public config apply', () => {
  // Test Value Gate: actual installed producers must be discovered without platform intent, while
  // a typed three-plugin chain, source ownership, unchanged inputs and provider failures remain intact.
  it('refreshes installed consumer packages with and without platform intent and preserves dependency failures', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'package-reference-source');
    const renders = path.join(cwd, 'package-renders.jsonl');
    const scripts = path.join(cwd, 'package-pre-apply.jsonl');
    const fail = path.join(cwd, 'provider-render-fails');
    for (const name of ['provider', 'consumer']) {
      const root = path.join(sourceRoot, 'plugins', name);
      await fs.outputFile(path.join(root, 'commands/tool.mjs'), 'console.log("fixture");\n');
      await fs.outputFile(path.join(root, 'render.mjs'), [
        "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
        `const name=${JSON.stringify(name)};`,
        `if(name==='provider'&&fs.existsSync(${JSON.stringify(fail)}))throw new Error('injected provider failure');`,
        `fs.appendFileSync(${JSON.stringify(renders)},JSON.stringify({plugin:name,ids:c.requestedArtifactIds,config:c.config.values})+'\\n');`,
        "const artifacts=c.requestedArtifactIds.map(id=>id.startsWith('command-package.')?{id,target:'aw.command-package',kind:'commandPackage',state:'present',refreshKeys:['selected'],files:{'config.json':JSON.stringify({selected:c.config.values.selected})}}:",
        "id.startsWith('command-set.')?{id,target:'aw.command-set',kind:'commandSet',state:'present',refreshKeys:['selected'],entries:[{key:'run',runner:'node',entry:'tool.mjs',args:[],cwd:'resource'}]}:",
        `{id,target:'codex.skill',kind:'skill',state:'present',platform:'codex',skillKey:name,refreshKeys:name==='provider'?['registry']:['selected'],content:{files:{'SKILL.md':'---\\nname: '+name+'\\ndescription: Package reference fixture.\\n---\\n# Fixture\\n','README.md':'# Fixture\\n','agents/openai.yaml':'policy:\\n  allow_implicit_invocation: true\\n'}}});`,
        'console.log(JSON.stringify({version:2,artifacts}));',
      ].join('\n'));
      await fs.outputFile(path.join(root, 'pre-apply.mjs'), [
        "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(0,'utf8'));",
        `fs.appendFileSync(${JSON.stringify(scripts)},JSON.stringify({plugin:c.plugin.name,platform:c.target.platform})+'\\n');`,
      ].join('\n'));
    }
    await createDependencyCatalogSnapshotFixture(sourceRoot, ['provider', 'middle', 'consumer'].map((name) => ({
      name, ...(name === 'consumer' ? { dependencies: ['middle'] } : name === 'middle' ? { dependencies: ['provider'] } : {}),
      configureManifest(manifest) {
        manifest.config = { schemaVersion: 4, fields: name === 'provider' ? {
          registry: { type: 'array', default: [], validation: { uniqueBy: 'key' }, items: {
            type: 'object', properties: { key: { type: 'string', required: true } }, additionalProperties: false,
          } },
        } : name === 'middle' ? {
          registry: { type: 'array', default: [], validation: { uniqueBy: 'key' }, items: {
            type: 'object', properties: { key: { type: 'string', required: true,
              valueRef: { plugin: 'provider', field: 'registry', key: 'key' } } }, additionalProperties: false,
          } },
        } : { selected: { type: 'string', default: 'native', valueRef: { plugin: 'middle', field: 'registry', key: 'key', include: ['native'] } } } };
        if (name === 'middle') return;
        manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } }, preApply: { path: './pre-apply.mjs' } };
        manifest.artifacts = { targets: [{ id: name, target: 'codex.skill', platform: 'codex', skillKey: name,
          scopes: ['user'], states: ['present'], refreshKeys: name === 'provider' ? ['registry'] : ['selected'], delivery: { mode: 'aw-extension' } }] };
        if (name === 'consumer') manifest.managedCommands = {
          packages: ['personal', 'uninstalled'].map((key) => ({ key, sourceDir: './commands', scope: 'user', platforms: ['codex'], render: true, refreshKeys: ['selected'] })),
          sets: ['personal', 'uninstalled'].map((key) => ({ set: key, mode: 'dynamic', producer: { kind: 'package', packageKey: key }, refreshKeys: ['selected'] })),
        };
      },
    })));
    const snapshot = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'team', type: 'path', primary: true, path: sourceRoot },
      { id: 'other', type: 'path', primary: false, path: sourceRoot },
    ] }, expectedDigest: snapshot.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    await syncCatalogSourceGeneration({ sourceId: 'other', cliVersion: '1.0.0', env });
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const run = async (args: string[]) => {
      const output = createCapturedCliIo();
      const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false, nativeCliRunner: runner });
      return { exitCode, payload: JSON.parse(output.readStdout()), stderr: output.readStderr() };
    };
    const installed = await run(['command', 'package', 'sync', 'team/consumer', 'personal', '--scope', 'user', '--yes']);
    expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0 });
    const foreign = await run(['command', 'package', 'sync', 'other/consumer', 'personal', '--scope', 'user', '--yes']);
    expect(foreign, JSON.stringify(foreign)).toMatchObject({ exitCode: 0 });
    const source = (await resolveCatalogOperationContext({ sourceIds: ['team'], env })).catalog.sources[0]!.resolution!;
    const setSelected = async (selected: string) => {
      await writePluginConfigStore({ sourceId: 'team', sourceIdentity: source.sourceIdentity,
        logicalIdentity: source.logicalIdentity, pluginName: 'middle', scope: 'user', cwd, env, values: { registry: [{ key: selected }] } });
      await writePluginConfigStore({ sourceId: 'team', sourceIdentity: source.sourceIdentity,
        logicalIdentity: source.logicalIdentity, pluginName: 'consumer', scope: 'user', cwd, env, values: { selected } });
    };
    const packages = () => listManagedCommandPackages(env);
    const resource = (await packages()).packages.find((entry) => entry.producer.sourceId === 'team')!.resourceRoot;
    const foreignRoot = (await packages()).packages.find((entry) => entry.producer.sourceId === 'other')!.resourceRoot;
    const foreignBefore = await fs.readFile(path.join(foreignRoot, '.aw-command-producer.json'));
    const config = path.join(resource, 'config.json');
    await setSelected('remote');
    await fs.outputFile(renders, '');
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({ cwd, env, nativeCliRunner: runner, interactive: false }));
    await dependencies.loadStatus(new AbortController().signal);
    const review = await dependencies.prepareReviewEvidence!({ kind: 'configSave', pluginId: 'team/provider', scope: 'user',
      apply: true, updates: { registry: [{ key: 'remote' }] } }, new AbortController().signal, () => undefined);
    expect(review.config?.commandPackages?.map((entry) => ({ source: entry.producer.sourceId, plugin: entry.producer.pluginName, key: entry.packageKey })))
      .toEqual([{ source: 'team', plugin: 'consumer', key: 'personal' }]);
    expect(review.config?.affectedTargets).toEqual([]);
    expect(review.config?.preApplyAuthorization ?? []).toEqual([]);
    expect(await fs.pathExists(scripts)).toBe(false);
    const repaired = await run(['config', 'set', 'team/provider', 'registry', '--scope', 'user', '--value-json', '[{"key":"remote"}]', '--apply', '--yes']);
    expect(repaired, JSON.stringify(repaired)).toMatchObject({ exitCode: 0, payload: { apply: { state: 'succeeded', targetResults: [],
      commandResults: [{ producer: { pluginName: 'consumer', key: 'personal' }, state: 'completed' }] } } });
    expect(await fs.readJson(config)).toEqual({ selected: 'remote' });
    expect((await packages()).packages.map((entry) => `${entry.producer.sourceId}/${entry.producer.key}`).sort()).toEqual(['other/personal', 'team/personal']);
    expect(await fs.readFile(path.join(foreignRoot, '.aw-command-producer.json'))).toEqual(foreignBefore);
    expect(await fs.readJson(path.join(foreignRoot, 'config.json'))).toEqual({ selected: 'native' });
    expect(await fs.pathExists(scripts)).toBe(false);
    const before = await fs.readFile(path.join(resource, '.aw-command-producer.json'));
    const rendered = await fs.readFile(renders);
    const unchanged = await run(['config', 'set', 'team/provider', 'registry', '--scope', 'user', '--value-json', '[{"key":"remote"},{"key":"other"}]', '--apply', '--yes']);
    expect(unchanged, JSON.stringify(unchanged)).toMatchObject({ exitCode: 0, payload: { apply: { reason: 'noEffectiveConfigChange' } } });
    expect(await fs.readFile(path.join(resource, '.aw-command-producer.json'))).toEqual(before);
    expect(await fs.readFile(renders)).toEqual(rendered);

    const providerPlatform = await run(['install', 'team/provider', '--platform', 'codex', '--scope', 'user', '--yes']);
    expect(providerPlatform, JSON.stringify(providerPlatform)).toMatchObject({ exitCode: 0 });
    await setSelected('next');
    await fs.outputFile(fail, 'fail');
    await fs.outputFile(renders, '');
    const failed = await run(['config', 'set', 'team/provider', 'registry', '--scope', 'user', '--value-json', '[{"key":"remote"},{"key":"other"},{"key":"next"}]', '--apply', '--yes']);
    expect(failed, JSON.stringify(failed)).toMatchObject({ exitCode: 1, payload: { configWrite: 'succeeded', overallState: 'partial', apply: { state: 'partial' } } });
    expect(failed.payload.apply.commandResults).toEqual(expect.arrayContaining([expect.objectContaining({
      producer: expect.objectContaining({ pluginName: 'consumer', key: 'personal' }), state: 'failed',
      errors: [expect.objectContaining({ code: 'dependencyApplyFailed' })],
      recoveryActions: ['aw command package sync team/consumer personal --scope user --yes'],
    })]));
    expect((await fs.readJson(resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'provider', scope: 'user', cwd, env }))).values.registry)
      .toContainEqual({ key: 'next' });
    expect(await fs.readJson(config)).toEqual({ selected: 'remote' });
    expect((await fs.readFile(renders, 'utf8'))).not.toContain('consumer');
    await fs.remove(fail);
    const providerRecovered = await run(['sync', 'team/provider', '--platform', 'codex', '--scope', 'user', '--yes']);
    expect(providerRecovered, JSON.stringify(providerRecovered)).toMatchObject({ exitCode: 0 });
    const packageRecovered = await run(['command', 'package', 'sync', 'team/consumer', 'personal', '--scope', 'user', '--yes']);
    expect(packageRecovered, JSON.stringify(packageRecovered)).toMatchObject({ exitCode: 0 });
    expect(await fs.readJson(config)).toEqual({ selected: 'next' });
    const platform = await run(['install', 'team/consumer', '--platform', 'codex', '--scope', 'user', '--yes']);
    expect(platform, JSON.stringify(platform)).toMatchObject({ exitCode: 0 });
    await setSelected('final');
    await fs.outputFile(renders, '');
    await dependencies.loadStatus(new AbortController().signal);
    const finalRegistry = [{ key: 'remote' }, { key: 'other' }, { key: 'next' }, { key: 'final' }];
    const finalIntent: OperationIntent = { kind: 'configSave', pluginId: 'team/provider', scope: 'user', apply: true,
      updates: { registry: finalRegistry } };
    const combinedReview = await dependencies.prepareReviewEvidence!(finalIntent, new AbortController().signal, () => undefined);
    expect(combinedReview.config?.affectedTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginName: 'provider', platform: 'codex', scope: 'user' }),
      expect.objectContaining({ pluginName: 'consumer', platform: 'codex', scope: 'user' }),
    ]));
    expect(combinedReview.config?.commandPackages?.map((entry) => `${entry.producer.sourceId}/${entry.producer.pluginName}/${entry.packageKey}`).sort())
      .toEqual(['team/consumer/personal', 'team/consumer/uninstalled']);
    expect([...new Set(combinedReview.config?.preApplyAuthorization?.map((entry) => `${entry.pluginId}/${entry.platform}/${entry.scope}`))].sort())
      .toEqual(['team/consumer/codex/user', 'team/provider/codex/user']);
    const recaptured = await dependencies.captureEvidence(finalIntent);
    expect(recaptured).toEqual(combinedReview);
    const combined = await dependencies.executeIntent(finalIntent, combinedReview, new AbortController().signal) as PluginConfigWriteReceipt;
    expect(combined, JSON.stringify(combined)).toMatchObject({ overallState: 'succeeded', apply: { state: 'succeeded' } });
    expect([...new Set(combined.apply.targetResults.filter((entry) => entry.action !== 'keep')
      .map((entry) => `${entry.target.pluginName}/${entry.target.platform}/${entry.target.scope}`))].sort())
      .toEqual(combinedReview.config!.affectedTargets.map((entry) => `${entry.pluginName}/${entry.platform}/${entry.scope}`).sort());
    expect(combined.apply.targetResults.filter((entry) => entry.target.pluginName === 'middle'))
      .toEqual([expect.objectContaining({ action: 'reinstall', state: 'completed' }),
        expect.objectContaining({ action: 'keep', state: 'completed' })]);
    expect(combined.apply.commandResults!.filter((entry) => entry.producer.key === 'personal')).toHaveLength(1);
    const entries = (await fs.readFile(renders, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(entries.filter((entry) => entry.ids.includes('command-package.personal'))).toHaveLength(1);
    expect(await fs.readJson(config)).toEqual({ selected: 'final' });

    // Test Value Gate: retry must bind the actual consumer and intermediate stores, including valid-to-valid changes.
    const store = (pluginName: string) => ({ sourceId: 'team', sourceIdentity: source.sourceIdentity,
      logicalIdentity: source.logicalIdentity, pluginName, scope: 'user' as const, cwd, env });
    await writePluginConfigStore({ ...store('middle'), values: { registry: [{ key: 'final' }, { key: 'next' }] } });
    const retryIntent: OperationIntent = { kind: 'configSave', pluginId: 'team/provider', scope: 'user', retryApply: true, apply: true };
    const reviewRetry = () => dependencies.prepareReviewEvidence!(retryIntent, new AbortController().signal, () => undefined);
    for (const pluginName of ['consumer', 'middle']) {
      await dependencies.loadStatus(new AbortController().signal);
      const reviewed = await reviewRetry();
      expect(await dependencies.captureEvidence(retryIntent)).toEqual(reviewed);
      const artifactBefore = await fs.readFile(config);
      const scriptsBefore = await fs.readFile(scripts);
      const rendersBefore = await fs.readFile(renders);
      await writePluginConfigStore({ ...store(pluginName), values: pluginName === 'consumer'
        ? { selected: 'next' } : { registry: [{ key: 'next' }] } });
      expect((await dependencies.captureEvidence(retryIntent)).config?.storeDigest).not.toBe(reviewed.config?.storeDigest);
      await expect(dependencies.executeIntent(retryIntent, reviewed, new AbortController().signal))
        .rejects.toMatchObject({ code: 'operationReviewStale' });
      expect(await fs.readFile(config)).toEqual(artifactBefore);
      expect(await fs.readFile(scripts)).toEqual(scriptsBefore);
      expect(await fs.readFile(renders)).toEqual(rendersBefore);
      const fresh = await reviewRetry();
      await expect(dependencies.executeIntent(retryIntent, fresh, new AbortController().signal))
        .resolves.toMatchObject({ apply: { state: 'succeeded' } });
      expect(await fs.readJson(config)).toEqual({ selected: 'next' });
    }
  }, 30_000);

  // Test Value Gate: real intent discovery, source binding, script authorization and dependency plans
  // must preserve committed config after one platform fails and allow a later consumer sync to recover.
  it('discovers visible consumers, keeps independent targets running, and recovers through consumer sync', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'cross-config-source');
    const trace = path.join(cwd, 'pre-apply.jsonl');
    for (const name of ['provider', 'consumer']) {
      const pluginRoot = path.join(sourceRoot, 'plugins', name);
      await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
        "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
        `const name=${JSON.stringify(name)};`,
        "const files={'SKILL.md':`---\\nname: ${name}\\ndescription: Config reference integration fixture.\\n---\\n# Reference fixture\\n`,'README.md':'# Reference fixture\\n','agents/openai.yaml':'policy:\\n  allow_implicit_invocation: true\\n'};",
        `console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>({id,target:c.platform+'.skill',kind:'skill',state:'present',platform:c.platform,skillKey:name,refreshKeys:${JSON.stringify(name === 'provider' ? ['registry'] : ['selected'])},content:{files}}))}));`,
      ].join('\n'));
      if (name === 'provider') await fs.outputFile(path.join(pluginRoot, 'pre-apply.mjs'), [
        "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(0,'utf8'));",
        `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({plugin:c.plugin.name,platform:c.target.platform})+'\\n');`,
      ].join('\n'));
    }
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'provider', configureManifest(manifest) {
        manifest.config = { schemaVersion: 4, fields: { registry: { type: 'array', default: [], validation: { uniqueBy: 'key' }, items: {
          type: 'object', properties: { key: { type: 'string', required: true } }, additionalProperties: false,
        } } } };
        manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } }, preApply: { path: './pre-apply.mjs' } };
        manifest.artifacts = { targets: [
          { id: 'provider-codex', target: 'codex.skill', platform: 'codex', skillKey: 'provider', scopes: ['user', 'project'], states: ['present'],
            refreshKeys: ['registry'], runtimeConfig: { keys: ['registry'] }, delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' } },
          { id: 'provider-claude', target: 'claude.skill', platform: 'claude', skillKey: 'provider', scopes: ['user', 'project'], states: ['present'], refreshKeys: ['registry'] },
        ] };
      } },
      { name: 'consumer', dependencies: ['provider'], configureManifest(manifest) {
        manifest.config = { schemaVersion: 4, fields: { selected: { type: 'string', default: 'native', valueRef: {
          plugin: 'provider', field: 'registry', key: 'key', include: ['native'],
        } } } };
        manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
        manifest.artifacts = { targets: [{ id: 'consumer-codex', target: 'codex.skill', platform: 'codex', skillKey: 'consumer', scopes: ['user', 'project'],
          states: ['present'], refreshKeys: ['selected'], runtimeConfig: { keys: ['selected'] }, delivery: { mode: 'aw-extension' } }] };
      } },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: snapshot.digest, env });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
    const native = await createClaudeNativeTestRuntime(isolation);
    const configPath = path.join(env.AW_CODEX_HOME!, 'config.toml');
    let installed = false;
    let marketplaceRoot = '';
    let failProvider = false;
    const writeConfig = () => fs.outputFile(configPath, [
      ...(marketplaceRoot ? ['[marketplaces.aw]', `source = ${JSON.stringify(marketplaceRoot)}`, 'source_type = "local"', ''] : []),
      ...(installed ? ['[plugins."provider@aw"]', 'enabled = true', ''] : []),
    ].join('\n'));
    const runner = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.command === 'claude') return native.nativeCliRunner(invocation);
      const args = invocation.args;
      if (args.includes('--version')) return { exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' };
      if (args[1] === 'marketplace' && args[2] === 'add') { marketplaceRoot = args[3]!; await writeConfig(); }
      if (args[1] === 'remove') { installed = false; await writeConfig(); }
      if (args[1] === 'add') {
        if (failProvider) return { exitCode: 1, stdout: '', stderr: 'injected provider platform failure' };
        installed = true; await writeConfig();
      }
      return { exitCode: 0, stdout: args[1] === 'list' ? JSON.stringify({ installed: installed
        ? [{ pluginId: 'provider@aw', installed: true, enabled: true, version: '1.0.0' }] : [], available: [] }) : '', stderr: '' };
    });
    const run = async (args: string[]) => {
      const output = createCapturedCliIo();
      const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false, nativeCliRunner: runner });
      return { exitCode, payload: JSON.parse(output.readStdout()), stderr: output.readStderr() };
    };
    const initial = await run(['install', 'team/consumer', '--platform', 'codex', '--scope', 'user', '--yes']);
    expect(initial, JSON.stringify(initial)).toMatchObject({ exitCode: 0, payload: { overallState: 'succeeded' } });
    const claude = await run(['install', 'team/provider', '--platform', 'claude', '--scope', 'user', '--yes']);
    expect(claude, JSON.stringify(claude)).toMatchObject({ exitCode: 0 });
    const source = (await resolveCatalogOperationContext({ sourceIds: ['team'], env })).catalog.sources[0]!.resolution!;
    // A manual edit can leave a previously installed consumer invalid until the missing key is added.
    await writePluginConfigStore({ sourceId: 'team', sourceIdentity: source.sourceIdentity, logicalIdentity: source.logicalIdentity,
      pluginName: 'consumer', scope: 'user', cwd, env, values: { selected: 'remote' } });
    const consumerBinding = path.join(env.AW_CODEX_HOME!, 'skills/consumer/.aw-runtime-config.json');
    const before = await fs.readFile(consumerBinding);
    const savedOnly = await run(['config', 'set', 'team/provider', 'registry', '--scope', 'user', '--value-json', '[{"key":"unrelated"}]']);
    expect(savedOnly, JSON.stringify(savedOnly)).toMatchObject({ exitCode: 0, payload: { configWrite: 'succeeded', apply: { reason: 'notRequested' } } });
    expect(await fs.readFile(consumerBinding)).toEqual(before);
    const providerBinding = path.join(marketplaceRoot, 'plugins/provider/codex/skills/provider/.aw-runtime-config.json');
    expect((await fs.readJson(providerBinding)).effectiveValues.registry).toEqual([]);
    await fs.writeFile(trace, '');
    failProvider = true;
    const saved = await run(['config', 'set', 'team/provider', 'registry', '--scope', 'user', '--value-json', '[{"key":"remote"}]', '--apply', '--yes']);
    expect(saved, JSON.stringify(saved)).toMatchObject({ exitCode: 1, payload: { configWrite: 'succeeded', overallState: 'partial', apply: { state: 'partial' } } });
    expect(saved.payload.apply.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ pluginName: 'provider', platform: 'codex' }), state: 'failed' }),
      expect.objectContaining({ target: expect.objectContaining({ pluginName: 'provider', platform: 'claude' }), state: 'completed' }),
      expect.objectContaining({ target: expect.objectContaining({ pluginName: 'consumer', platform: 'codex' }), state: 'skipped', errorCode: 'dependencyApplyFailed',
        message: expect.stringContaining('aw sync team/consumer --scope user --platform codex --yes') }),
    ]));
    expect((await fs.readJson(resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'provider', scope: 'user', cwd, env }))).values.registry).toEqual([{ key: 'remote' }]);
    expect(await fs.readFile(consumerBinding)).toEqual(before);
    expect((await fs.readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).platform).sort()).toEqual(['claude', 'codex']);
    failProvider = false;
    const recovered = await run(['sync', 'team/consumer', '--platform', 'codex', '--scope', 'user', '--yes']);
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ exitCode: 0, payload: { overallState: 'succeeded' } });
    expect((await fs.readJson(consumerBinding)).effectiveValues).toEqual({ selected: 'remote' });
    expect((await fs.readJson(providerBinding)).effectiveValues.registry).toEqual([{ key: 'remote' }]);
  });
  // Test Value Gate: a shared user artifact can be hosted only by project activation; rejection must preserve bytes.
  it('confirms a foreign shared native consumer before writes and uses its user render profile for project activation', async () => {
    const { cwd, env, runner, run, store, binding } = await createNativeReferenceFixture();
    await writePluginConfigStore({ ...store('provider', 'user'), values: { registry: [] } });
    await writePluginConfigStore({ ...store('provider', 'project'), values: { registry: [] } });
    await writePluginConfigStore({ ...store('consumer', 'user'), values: { selected: 'remote' } });
    const configFile = resolvePluginConfigStorePath(store('provider', 'user'));
    const configBefore = await fs.readFile(configFile);
    const artifactBefore = await fs.readFile(binding);
    const rejected = await run(['config', 'set', 'team/provider', 'registry', '--scope', 'user', '--value-json', '[{"key":"remote"}]', '--apply']);
    expect(rejected, JSON.stringify(rejected)).toMatchObject({ exitCode: 1 });
    expect(JSON.stringify(rejected)).toContain('sharedNativeConfigApplyConfirmationRequired');
    expect(await fs.readFile(configFile)).toEqual(configBefore);
    expect(await fs.readFile(binding)).toEqual(artifactBefore);
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({ cwd, env, nativeCliRunner: runner, interactive: false }));
    await dependencies.loadStatus(new AbortController().signal);
    const intent: OperationIntent = { kind: 'configSave', pluginId: 'team/provider', scope: 'user', apply: true,
      updates: { registry: [{ key: 'remote' }] } };
    const review = await dependencies.prepareReviewEvidence!(intent, new AbortController().signal, () => undefined);
    expect(review.config?.affectedTargets).toEqual([expect.objectContaining({ pluginName: 'consumer', platform: 'codex', scope: 'project' })]);
    expect(review.config?.sharedNativeRenderTargets).toEqual([expect.objectContaining({ pluginName: 'consumer', skillKey: 'consumer' })]);
    const changed = await dependencies.executeIntent(intent, review, new AbortController().signal) as PluginConfigWriteReceipt;
    expect(changed, JSON.stringify(changed)).toMatchObject({ configWrite: 'succeeded', apply: { state: 'succeeded' } });
    expect((await fs.readJson(binding)).effectiveValues).toEqual({ selected: 'remote' });
    expect(changed.apply.targetResults).toEqual(expect.arrayContaining([expect.objectContaining({
      target: expect.objectContaining({ pluginName: 'consumer', platform: 'codex', scope: 'project' }), state: 'completed',
    })]));
    await dependencies.loadStatus(new AbortController().signal);
    const retry = await dependencies.prepareReviewEvidence!({ ...intent, updates: undefined, retryApply: true }, new AbortController().signal, () => undefined);
    expect(retry.config?.sharedNativeRenderTargets).toEqual([expect.objectContaining({ pluginName: 'consumer', skillKey: 'consumer' })]);
  }, 30_000);
  // Test Value Gate: foreign hook inputs need write-before authorization, and a native project hook must bind its own profile.
  it('authorizes foreign hook-only changes and rejects stale project preApply inputs without changing shared user content', async () => {
    const { cwd, env, trace, runner, run, store, binding } = await createNativeReferenceFixture(true);
    await writePluginConfigStore({ ...store('provider', 'user'), values: { registry: [] } });
    await writePluginConfigStore({ ...store('consumer', 'project'), values: { hookSelection: 'remote', extra: 1 } });
    const providerFile = resolvePluginConfigStorePath(store('provider', 'user'));
    const providerBefore = await fs.readFile(providerFile);
    const artifactBefore = await fs.readFile(binding);
    await fs.outputFile(trace, '');
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({ cwd, env, nativeCliRunner: runner, interactive: false }));
    await dependencies.loadStatus(new AbortController().signal);
    const configIntent: OperationIntent = { kind: 'configSave', pluginId: 'team/provider', scope: 'user', apply: true,
      updates: { registry: [{ key: 'remote' }] } };
    const review = await dependencies.prepareReviewEvidence!(configIntent, new AbortController().signal, () => undefined);
    expect(review.config?.affectedTargets).toContainEqual(expect.objectContaining({ pluginName: 'consumer', platform: 'codex', scope: 'project' }));
    expect(review.config?.sharedNativeRenderTargets ?? []).toEqual([]);
    expect(review.config?.preApplyAuthorization).toContainEqual(expect.objectContaining({ pluginId: 'team/consumer', scope: 'project' }));
    const rejected = await run(['config', 'set', 'team/provider', 'registry', '--scope', 'user', '--value-json', '[{"key":"remote"}]', '--apply']);
    expect(rejected, JSON.stringify(rejected)).toMatchObject({ exitCode: 1 });
    expect(JSON.stringify(rejected)).toContain('preApplyAuthorizationRequired');
    expect(await fs.readFile(providerFile)).toEqual(providerBefore);
    expect(await fs.readFile(binding)).toEqual(artifactBefore);
    expect(await fs.readFile(trace, 'utf8')).toBe('');
    await expect(dependencies.executeIntent(configIntent, review, new AbortController().signal))
      .resolves.toMatchObject({ apply: { state: 'succeeded' } });
    expect((await fs.readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
      .toContainEqual(expect.objectContaining({ plugin: 'consumer', scope: 'project', values: expect.objectContaining({ hookSelection: 'remote', extra: 1 }) }));
    expect(await fs.readFile(binding)).toEqual(artifactBefore);

    await dependencies.loadStatus(new AbortController().signal);
    const syncIntent: OperationIntent = { kind: 'pluginWrite', action: 'sync', pluginId: 'team/consumer', platform: 'codex', scope: 'project' };
    const syncReview = await dependencies.prepareReviewEvidence!(syncIntent, new AbortController().signal, () => undefined);
    await writePluginConfigStore({ ...store('consumer', 'project'), values: { hookSelection: 'remote', extra: 2 } });
    const fresh = await dependencies.captureEvidence(syncIntent);
    expect(fresh.operationPlan?.planFingerprint).not.toBe(syncReview.operationPlan?.planFingerprint);
    await fs.outputFile(trace, '');
    await expect(dependencies.executeIntent(syncIntent, syncReview, new AbortController().signal))
      .rejects.toMatchObject({ code: 'operationReviewStale' });
    expect(await fs.readFile(trace, 'utf8')).toBe('');
    expect(await fs.readFile(binding)).toEqual(artifactBefore);
    const freshReview = await dependencies.prepareReviewEvidence!(syncIntent, new AbortController().signal, () => undefined);
    await expect(dependencies.executeIntent(syncIntent, freshReview, new AbortController().signal))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    expect((await fs.readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
      .toContainEqual(expect.objectContaining({ plugin: 'consumer', scope: 'project', values: expect.objectContaining({ hookSelection: 'remote', extra: 2 }) }));
    expect((await fs.readJson(binding)).effectiveValues).toEqual({ selected: 'native' });
  }, 30_000);

});
