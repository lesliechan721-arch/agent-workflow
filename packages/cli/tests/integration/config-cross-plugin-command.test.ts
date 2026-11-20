import path from 'node:path';
import { execFileSync } from 'node:child_process';
import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import { resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { attachSafeOperationError } from '../../src/utils/safe-operation-diagnostic.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import { runSafeCli } from '../helpers/cli-runtime.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { createCodexNativeTestRuntime } from '../helpers/codex-native-fixture.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { listManagedCommandPackages } from '../../src/utils/managed-command-store.js';
import * as managedCommandStore from '../../src/utils/managed-command-store.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController, type OperationIntent } from '../../src/tui/controller.js';
import type { PluginConfigWriteReceipt } from '../../src/utils/plugin-config-write.js';
import { getQualifiedPlatformProfile } from '../../src/platforms/capabilities.js';

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

async function createCommandPackageReferenceFixture(options: {
  foreignSource?: boolean;
  withClaude?: boolean;
  mixedScopes?: boolean;
  preApplyPackageChange?: 'move' | 'edit' | 'unbind' | 'chmod';
  twoBindings?: boolean;
  packagePlatforms?: Array<'codex' | 'claude'>;
  initialSelection?: 'final' | 'next';
  providerModelControl?: boolean;
} = {}) {
  const platforms: Array<'codex' | 'claude'> = options.mixedScopes ? ['claude'] : options.withClaude ? ['codex', 'claude'] : ['codex'];
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const env = isolation.env;
  const sourceRoot = path.join(cwd, 'package-reference-source');
  if (options.mixedScopes) execFileSync('git', ['init', '-q'], { cwd });
  const renders = path.join(cwd, 'package-renders.jsonl');
  const scripts = path.join(cwd, 'package-pre-apply.jsonl');
  const packageToChange = path.join(cwd, 'package-to-change.json');
  const fail = path.join(cwd, 'provider-render-fails');
  const packageKeys = options.mixedScopes ? ['personal', 'workspace'] : ['personal', 'uninstalled'];
  const commandEntries = (options.twoBindings ? ['first', 'second'] : ['run'])
    .map((key) => ({ key, runner: 'node', entry: 'tool.mjs', args: [], cwd: 'resource' }));
  for (const name of ['provider', 'consumer']) {
    const root = path.join(sourceRoot, 'plugins', name);
    const usesHelper = options.preApplyPackageChange === 'chmod' && name === 'consumer';
    const skillRequirement = options.providerModelControl && name === 'provider'
      ? ",requires:[{feature:'skill.invocation.model',values:['false']}]" : '';
    const skillConfig = skillRequirement ? " + JSON.stringify(c.config.values)" : '';
    await fs.outputFile(path.join(root, 'commands/tool.mjs'), usesHelper
      ? "import {execFileSync} from 'node:child_process'; import {fileURLToPath} from 'node:url'; execFileSync(fileURLToPath(new URL('./helper', import.meta.url)));"
      : 'console.log("fixture");\n');
    if (usesHelper) {
      const helper = path.join(root, 'commands/helper');
      await fs.outputFile(helper, '#!/bin/sh\nexit 0\n');
      await fs.chmod(helper, 0o755);
    }
    await fs.outputFile(path.join(root, 'render.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      `const name=${JSON.stringify(name)};`,
      `if(name==='provider'&&fs.existsSync(${JSON.stringify(fail)}))throw new Error('injected provider failure');`,
      `fs.appendFileSync(${JSON.stringify(renders)},JSON.stringify({plugin:name,surface:c.surface,ids:c.requestedArtifactIds,config:c.config.values})+'\\n');`,
      `if(c.surface==='agent-plugin'){const files={'SKILL.md':'---\\nname: '+name+'\\ndescription: Package reference fixture.\\n---\\n# Fixture\\n'${skillConfig},'README.md':'# Fixture\\n'};console.log(JSON.stringify({version:3,components:c.allowedOutputKinds.includes('skill')?[{id:name,kind:'skill',name${skillRequirement},content:{files:Object.fromEntries(Object.entries(files).map(([p,text])=>[p,{text}]))}}]:[],omitted:[],unmet:[]}));}else{`,
      `const artifacts=c.requestedArtifactIds.map(id=>id.startsWith('command-package.')?{id,target:'aw.command-package',kind:'commandPackage',state:'present',refreshKeys:['selected'],files:{'config.json':JSON.stringify({selected:c.config.values.selected${options.mixedScopes ? ',scope:c.scope' : ''}})}}:{id,target:'aw.command-set',kind:'commandSet',state:'present',refreshKeys:['selected'],entries:${JSON.stringify(commandEntries)}});`,
      'console.log(JSON.stringify({version:2,artifacts}));}',
    ].join('\n'));
    await fs.outputFile(path.join(root, 'pre-apply.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(0,'utf8'));",
      `fs.appendFileSync(${JSON.stringify(scripts)},JSON.stringify({plugin:c.plugin.name,platform:c.target.platform})+'\\n');`,
      ...(name === 'consumer' && options.preApplyPackageChange ? [
        `const trigger=${JSON.stringify(packageToChange)}; if(fs.existsSync(trigger)){const {root,binding}=JSON.parse(fs.readFileSync(trigger,'utf8'));`,
        { move: "fs.renameSync(root,root+'.saved');", edit: "fs.writeFileSync(root+'/resource/config.json','external bytes');",
          unbind: 'fs.unlinkSync(binding);', chmod: "fs.chmodSync(root+'/resource/helper',0o644);" }[options.preApplyPackageChange],
        'fs.unlinkSync(trigger);}',
      ] : []),
    ].join('\n'));
  }
  await createDependencyCatalogSnapshotFixture(sourceRoot, ['provider', 'middle', 'consumer'].map((name) => ({
    name, ...(name === 'consumer' ? { dependencies: ['middle'] } : name === 'middle' ? { dependencies: ['provider'] } : {}),
    configureManifest(manifest) {
      manifest.platforms = platforms;
      manifest.config = { schemaVersion: 5, fields: name === 'provider' ? {
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
      manifest.artifacts = { configKeys: name === 'provider' ? ['registry'] : ['selected'], scopes: ['user'] };
      if (name === 'consumer') manifest.managedCommands = {
        packages: packageKeys.map((key) => ({ key, sourceDir: './commands', scope: key === 'workspace' ? 'project' : 'user', platforms: options.packagePlatforms ?? platforms, render: true, refreshKeys: ['selected'] })),
        sets: packageKeys.map((key) => ({ set: key, mode: 'dynamic', producer: { kind: 'package', packageKey: key }, refreshKeys: ['selected'] })),
      };
    },
  })));
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
    { id: 'team', type: 'path', primary: true, path: sourceRoot },
    ...(options.foreignSource ? [{ id: 'other', type: 'path' as const, primary: false, path: sourceRoot }] : []),
  ] }, expectedDigest: snapshot.digest, env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  if (options.foreignSource) {
    await syncCatalogSourceGeneration({ sourceId: 'other', cliVersion: '1.0.0', env });
  }
  const codex = await createCodexNativeTestRuntime(isolation);
  const claude = options.withClaude ? await createClaudeNativeTestRuntime(isolation) : undefined;
  const runner = (invocation: NativeCliInvocation) => claude && isClaudeInvocation(invocation)
    ? claude.nativeCliRunner(invocation) : codex.nativeCliRunner(invocation);
  const run = async (args: string[], signal?: AbortSignal) => {
    const output = createCapturedCliIo();
    const exitCode = await runSafeCli([...args, '--json'], { cwd, env, io: output.io, interactive: false, nativeCliRunner: runner, signal });
    return { exitCode, payload: JSON.parse(output.readStdout()), stderr: output.readStderr() };
  };
  expect(await run(['target', 'set', ...platforms])).toMatchObject({ exitCode: 0 });
  const source = (await resolveCatalogOperationContext({ sourceIds: ['team'], env })).catalog.sources[0]!.resolution!;
  const setSelected = async (selected: string) => {
    await writePluginConfigStore({ sourceId: 'team', sourceIdentity: source.sourceIdentity,
      logicalIdentity: source.logicalIdentity, pluginName: 'middle', scope: 'user', cwd, env, values: { registry: [{ key: selected }] } });
    await writePluginConfigStore({ sourceId: 'team', sourceIdentity: source.sourceIdentity,
      logicalIdentity: source.logicalIdentity, pluginName: 'consumer', scope: 'user', cwd, env, values: { selected } });
  };
  const packages = () => listManagedCommandPackages(env);
  const dependencies = createTuiControllerDependencies(createCliExecutionContext({ cwd, env, nativeCliRunner: runner, interactive: false }));
  if (options.initialSelection) {
    await setSelected(options.initialSelection);
    for (const pluginName of ['provider', 'middle']) {
      await writePluginConfigStore({ sourceId: 'team', sourceIdentity: source.sourceIdentity,
        logicalIdentity: source.logicalIdentity, pluginName, scope: 'user', cwd, env,
        values: { registry: [{ key: 'final' }, { key: 'next' }] } });
    }
  }
  const installed = await run(['command', 'package', 'sync', 'team/consumer', 'personal', '--scope', 'user', '--yes']);
  expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0 });
  const resource = (await packages()).packages.find((entry) => entry.producer.sourceId === 'team')!.resourceRoot;
  const config = path.join(resource, 'config.json');
  return { cwd, env, renders, scripts, fail, source, run, setSelected, packages, resource, config, dependencies, packageToChange };
}

describe('cross-plugin public config apply', () => {
  beforeEach(() => { installNativeTestQualification({ platforms: ['codex', 'claude'], discovery: true }); });
  // Test Value Gate: config apply discovers installed packages without platform intent,
  // preserves foreign source packages, and skips unchanged effective inputs.
  it('refreshes only installed consumer packages from the matching source without platform intent', async () => {
    const { renders, scripts, run, setSelected, packages, resource, config, dependencies } =
      await createCommandPackageReferenceFixture({ foreignSource: true });
    const foreign = await run(['command', 'package', 'sync', 'other/consumer', 'personal', '--scope', 'user', '--yes']);
    expect(foreign, JSON.stringify(foreign)).toMatchObject({ exitCode: 0 });
    const foreignRoot = (await packages()).packages.find((entry) => entry.producer.sourceId === 'other')!.resourceRoot;
    const foreignBefore = await fs.readFile(path.join(foreignRoot, '.aw-command-producer.json'));
    await setSelected('remote');
    await fs.outputFile(renders, '');
    await dependencies.loadStatus(new AbortController().signal);
    const review = await dependencies.prepareReviewEvidence!({ kind: 'configSave', pluginId: 'team/provider', scope: 'user',
      apply: true, updates: { registry: [{ key: 'remote' }] } }, new AbortController().signal, () => undefined);
    expect(review.config?.commandPackages?.map((entry) => ({ source: entry.producer.sourceId, plugin: entry.producer.pluginName, key: entry.packageKey })))
      .toEqual([{ source: 'team', plugin: 'consumer', key: 'personal' }]);
    expect(review.config?.affectedTargets).toEqual([]);
    expect(review.config?.preApplyAuthorization ?? []).toEqual([]);
    expect(await fs.pathExists(scripts)).toBe(false);
    const repaired = await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'user', '--value-json', '[{"key":"remote"}]', '--apply', '--yes']);
    expect(repaired, JSON.stringify(repaired)).toMatchObject({
      exitCode: 0, payload: {
        schemaVersion: 2,
        data: {
          apply: {
            state: 'succeeded', targetResults: [],
            commandResults: [{ producer: { pluginName: 'consumer', key: 'personal' }, state: 'completed' }]
          }
        }
      }
    });
    expect(await fs.readJson(config)).toEqual({ selected: 'remote' });
    expect((await packages()).packages.map((entry) => `${entry.producer.sourceId}/${entry.producer.key}`).sort()).toEqual(['other/personal', 'team/personal']);
    expect(await fs.readFile(path.join(foreignRoot, '.aw-command-producer.json'))).toEqual(foreignBefore);
    expect(await fs.readJson(path.join(foreignRoot, 'config.json'))).toEqual({ selected: 'native' });
    expect(await fs.pathExists(scripts)).toBe(false);
    const before = await fs.readFile(path.join(resource, '.aw-command-producer.json'));
    const rendered = await fs.readFile(renders);
    const unchanged = await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'user', '--value-json', '[{"key":"remote"},{"key":"other"}]', '--apply', '--yes']);
    expect(unchanged, JSON.stringify(unchanged)).toMatchObject({
      exitCode: 0, payload: {
        schemaVersion: 2,
        data: { apply: { reason: 'noEffectiveConfigChange' } }
      }
    });
    expect(await fs.readFile(path.join(resource, '.aw-command-producer.json'))).toEqual(before);
    expect(await fs.readFile(renders)).toEqual(rendered);
  }, 30_000);

  // Test Value Gate: a failed provider preserves committed config and consumer
  // output, reports the dependency failure, and recovers through public sync.
  it('preserves consumer packages after provider failure and recovers through sync', async () => {
    const { cwd, env, source, fail, renders, run, setSelected, config } =
      await createCommandPackageReferenceFixture();
    const providerPlatform = await run(['plugin', 'install', 'team/provider', '--scope', 'user', '--yes']);
    expect(providerPlatform, JSON.stringify(providerPlatform)).toMatchObject({ exitCode: 0 });
    await setSelected('next');
    await fs.outputFile(fail, 'fail');
    await fs.outputFile(renders, '');
    const failed = await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'user', '--value-json', '[{"key":"next"}]', '--apply', '--yes']);
    expect(failed, JSON.stringify(failed)).toMatchObject({
      exitCode: 4, payload: {
        schemaVersion: 2,
        status: 'partial',
        data: {
          configWrite: 'succeeded',
          apply: { state: 'partial' }
        }
      }
    });
    expect(failed.payload.data.apply.commandResults).toEqual(expect.arrayContaining([expect.objectContaining({
      producer: expect.objectContaining({ pluginName: 'consumer', key: 'personal' }), state: 'failed',
      errors: [expect.objectContaining({ code: 'dependencyApplyFailed' })],
    })]));
    expect(failed.payload.diagnostics).toContainEqual(expect.objectContaining({
      code: 'dependencyApplyFailed',
      subject: expect.objectContaining({ pluginId: 'team/consumer', scope: 'user' })
    }));
    expect(failed.payload.nextActions).toContainEqual(expect.objectContaining({
      kind: 'command',
      argv: ['aw', 'command', 'package', 'sync', 'team/consumer', 'personal', '--scope', 'user'], requiresConfirmation: true
    }));
    expect((await fs.readJson(resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'provider', scope: 'user', cwd, env }))).common.registry)
      .toContainEqual({ key: 'next' });
    expect(await fs.readJson(config)).toEqual({ selected: 'native' });
    expect((await fs.readFile(renders, 'utf8'))).not.toContain('consumer');
    await fs.remove(fail);
    const providerRecovered = await run(['plugin', 'sync', 'team/provider', '--target', 'codex', '--context', 'user', '--yes']);
    expect(providerRecovered, JSON.stringify(providerRecovered)).toMatchObject({ exitCode: 0 });
    const packageRecovered = await run(['command', 'package', 'sync', 'team/consumer', 'personal', '--scope', 'user', '--yes']);
    expect(packageRecovered, JSON.stringify(packageRecovered)).toMatchObject({ exitCode: 0 });
    expect(await fs.readJson(config)).toEqual({ selected: 'next' });
  }, 30_000);

  const packageChanges = ['move', 'edit', 'unbind', 'chmod'] as const;
  it.each(packageChanges.filter((change) => change !== 'chmod' || process.platform !== 'win32'))('preserves a package after a confirmed preApply %s and refreshes its sibling', async (change) => {
    const { env, run, setSelected, packages, packageToChange } = await createCommandPackageReferenceFixture({ preApplyPackageChange: change });
    const installed = await run(['plugin', 'install', 'team/consumer', '--scope', 'user', '--yes']);
    expect(installed.exitCode, JSON.stringify(installed.payload.diagnostics)).toBe(0);
    const inventory = (await packages()).packages;
    const affected = inventory.find((item) => item.producer.key === 'personal')!;
    const sibling = inventory.find((item) => item.producer.key === 'uninstalled')!;
    const root = path.dirname(affected.resourceRoot);
    const binding = path.join(env.AW_HOME!, 'commands', 'bindings', affected.sets[0]!.commandIds[0]! + '.json');
    const helper = path.join(affected.resourceRoot, 'helper');
    if (change === 'chmod') {
      expect(affected.availability).toBe('ready');
      expect((await fs.stat(helper)).mode & 0o777).toBe(0o755);
    }
    await fs.writeJson(packageToChange, { root, binding });
    await setSelected('next');

    const result = await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'user',
      '--value-json', '[{"key":"next"}]', '--apply', '--yes']);
    expect(await fs.pathExists(packageToChange)).toBe(false);
    expect(result.exitCode, JSON.stringify(result.payload)).toBe(4);
    expect(result.payload.data).toMatchObject({ configWrite: 'succeeded', apply: { state: 'partial' } });
    expect(result.payload.data.apply.commandResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ producer: expect.objectContaining({ key: 'personal' }), state: 'failed', blockerCodes: [
        change === 'move' ? 'configApplyRequiresExistingOutput' : 'operationReviewStale'] }),
      expect.objectContaining({ producer: expect.objectContaining({ key: 'uninstalled' }), state: 'completed' }),
    ]));
    expect(result.payload.nextActions).toContainEqual(expect.objectContaining({
      argv: ['aw', 'command', 'package', 'sync', 'team/consumer', 'personal', '--scope', 'user'], requiresConfirmation: true }));
    if (change === 'move') {
      expect(await fs.pathExists(root)).toBe(false);
      expect(await fs.readJson(path.join(root + '.saved', 'resource', 'config.json'))).toEqual({ selected: 'native' });
    } else if (change === 'edit') {
      expect(await fs.readFile(path.join(affected.resourceRoot, 'config.json'), 'utf8')).toBe('external bytes');
    } else if (change === 'chmod') {
      expect((await fs.stat(helper)).mode & 0o777).toBe(0o644);
      expect(await fs.readFile(helper, 'utf8')).toBe('#!/bin/sh\nexit 0\n');
      expect(await fs.readJson(path.join(affected.resourceRoot, 'config.json'))).toEqual({ selected: 'native' });
    } else {
      expect(await fs.pathExists(binding)).toBe(false);
      expect(await fs.readJson(path.join(affected.resourceRoot, 'config.json'))).toEqual({ selected: 'native' });
    }
    expect(await fs.readJson(path.join(sibling.resourceRoot, 'config.json'))).toEqual({ selected: 'next' });
    if (change === 'chmod') {
      const repaired = await run(['command', 'package', 'sync', 'team/consumer', 'personal', '--scope', 'user', '--yes']);
      expect(repaired.exitCode, JSON.stringify(repaired.payload.diagnostics)).toBe(0);
      expect((await fs.stat(helper)).mode & 0o777).toBe(0o755);
    }
  }, 60_000);

  it.each(['unchanged', 'removed'] as const)('repairs a reviewed missing binding only when the second binding is %s', async (second) => {
    const { env, run, setSelected, packages, packageToChange } = await createCommandPackageReferenceFixture({
      preApplyPackageChange: 'unbind', twoBindings: true });
    const installed = await run(['plugin', 'install', 'team/consumer', '--scope', 'user', '--yes']);
    expect(installed.exitCode, JSON.stringify(installed.payload.diagnostics)).toBe(0);
    const inventory = (await packages()).packages;
    const affected = inventory.find((item) => item.producer.key === 'personal')!;
    const sibling = inventory.find((item) => item.producer.key === 'uninstalled')!;
    const bindings = affected.sets[0]!.commandIds.map((id) => path.join(env.AW_HOME!, 'commands', 'bindings', id + '.json'));
    expect(bindings).toHaveLength(2);
    await fs.unlink(bindings[0]!);
    expect((await packages()).packages.find((item) => item.id === affected.id)?.availability).toBe('unavailable');
    if (second === 'removed') await fs.writeJson(packageToChange, { binding: bindings[1] });
    await setSelected('next');

    const result = await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'user',
      '--value-json', '[{"key":"next"}]', '--apply', '--yes']);
    const changed = second === 'removed';
    expect(await fs.pathExists(packageToChange)).toBe(false);
    expect(result.exitCode, JSON.stringify(result.payload.diagnostics)).toBe(changed ? 4 : 0);
    expect(result.payload.data.configWrite).toBe('succeeded');
    expect(result.payload.data.apply.commandResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ producer: expect.objectContaining({ key: 'personal' }), state: changed ? 'failed' : 'completed',
        blockerCodes: changed ? ['operationReviewStale'] : [] }),
      expect.objectContaining({ producer: expect.objectContaining({ key: 'uninstalled' }), state: 'completed' }),
    ]));
    if (changed) expect(result.payload.nextActions).toContainEqual(expect.objectContaining({
      argv: ['aw', 'command', 'package', 'sync', 'team/consumer', 'personal', '--scope', 'user'], requiresConfirmation: true }));
    for (const binding of bindings) expect(await fs.pathExists(binding)).toBe(!changed);
    expect(await fs.readJson(path.join(affected.resourceRoot, 'config.json'))).toEqual({ selected: changed ? 'native' : 'next' });
    expect(await fs.readJson(path.join(sibling.resourceRoot, 'config.json'))).toEqual({ selected: 'next' });
    if (changed) {
      const repaired = await run(['command', 'package', 'sync', 'team/consumer', 'personal', '--scope', 'user', '--yes']);
      expect(repaired.exitCode, JSON.stringify(repaired.payload.diagnostics)).toBe(0);
    }
    expect((await packages()).packages.find((item) => item.id === affected.id)?.availability).toBe('ready');
  }, 60_000);

  it('reports the shared packages when native provider preflight blocks their owner', async () => {
    const { run, setSelected, fail, config } = await createCommandPackageReferenceFixture({ withClaude: true });
    const installed = await run(['plugin', 'install', 'team/consumer', '--scope', 'user', '--yes']);
    expect(installed.exitCode, JSON.stringify(installed.payload.diagnostics)).toBe(0);
    await setSelected('next');
    await fs.outputFile(fail, 'fail');
    const commits = vi.spyOn(managedCommandStore, 'syncManagedCommandPackage');
    try {
      const result = await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'user',
        '--value-json', '[{"key":"next"}]', '--apply', '--yes']);
      expect(result.exitCode, JSON.stringify(result.payload.diagnostics)).toBe(4);
      const packages = result.payload.data.apply.commandResults;
      expect(packages).toHaveLength(2);
      for (const key of ['personal', 'uninstalled']) expect(packages).toContainEqual(
        expect.objectContaining({ producer: expect.objectContaining({ key }), state: 'failed' }));
      expect(commits).not.toHaveBeenCalled();
      expect(await fs.readJson(config)).toEqual({ selected: 'native' });
    } finally { commits.mockRestore(); }
  }, 60_000);

  it('refreshes an independent Codex package when the provider fails on Claude', async () => {
    const { run, setSelected, fail, config } = await createCommandPackageReferenceFixture({ withClaude: true, packagePlatforms: ['codex'] });
    expect((await run(['target', 'set', 'claude'])).exitCode).toBe(0);
    const provider = await run(['plugin', 'install', 'team/provider', '--scope', 'user', '--yes']);
    expect(provider.exitCode, JSON.stringify(provider.payload.diagnostics)).toBe(0);
    await setSelected('next');
    await fs.outputFile(fail, 'fail');
    const result = await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'user',
      '--value-json', '[{"key":"next"}]', '--apply', '--yes']);
    expect(result.exitCode, JSON.stringify(result.payload.diagnostics)).toBe(4);
    expect(result.payload.data.apply.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'team/provider', platform: 'claude' }), state: 'failed' }));
    expect(result.payload.data.apply.commandResults).toEqual([expect.objectContaining({
      producer: expect.objectContaining({ key: 'personal' }), state: 'completed' })]);
    expect(await fs.readJson(config)).toEqual({ selected: 'next' });
  }, 30_000);

  it.each(['user', 'project'] as const)('refreshes both command scopes with only a %s native installation', async (nativeScope) => {
    const { run, setSelected, packages } = await createCommandPackageReferenceFixture({ mixedScopes: true, withClaude: true });
    const installed = await run(['plugin', 'install', 'team/consumer', '--scope', nativeScope, '--target', 'claude', '--yes']);
    expect(installed.exitCode, JSON.stringify(installed.payload.diagnostics)).toBe(0);
    const projectPackage = await run(['command', 'package', 'sync', 'team/consumer', 'workspace', '--scope', 'project', '--yes']);
    expect(projectPackage.exitCode, JSON.stringify(projectPackage.payload.diagnostics)).toBe(0);
    const locations = (await packages()).packages.map(({ producer, resourceRoot }) => ({ scope: producer.scope, file: path.join(resourceRoot, 'config.json') }));
    expect(locations).toHaveLength(2);
    for (const { file, scope } of locations) expect(await fs.readJson(file)).toEqual({ selected: 'native', scope });
    await setSelected('final');
    const commits = vi.spyOn(managedCommandStore, 'syncManagedCommandPackage');
    try {
      const applied = await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'project',
        '--value-json', '[{"key":"final"}]', '--apply', '--yes']);
      expect(applied.exitCode, JSON.stringify(applied.payload.diagnostics)).toBe(0);
      const commands = applied.payload.data.apply.commandResults;
      expect(commands).toHaveLength(2);
      for (const [key, scope] of [['personal', 'user'], ['workspace', 'project']]) expect(commands).toContainEqual(
        expect.objectContaining({ producer: expect.objectContaining({ key, scope }), state: 'completed' }));
      for (const { file, scope } of locations) expect(await fs.readFile(file, 'utf8')).toBe(JSON.stringify({ selected: 'final', scope }));
      expect(commits.mock.calls.map(([item]) => item.producer.scope).sort()).toEqual(['project', 'user']);
    } finally { commits.mockRestore(); }
  }, 60_000);

  it.each(['ordinary', 'cancelled cleanup'] as const)('reports a shared producer failure on both hosts after %s failure', async (mode) => {
    const { run, setSelected, config, cwd, env } = await createCommandPackageReferenceFixture({ withClaude: true });
    const installed = await run(['plugin', 'install', 'team/consumer', '--scope', 'user', '--yes']);
    expect(installed.exitCode, JSON.stringify(installed.payload.diagnostics)).toBe(0);
    await setSelected('final');
    const controller = new AbortController();
    const commit = managedCommandStore.syncManagedCommandPackage;
    const called: string[] = [];
    const commits = vi.spyOn(managedCommandStore, 'syncManagedCommandPackage').mockImplementation(async (entry) => {
      called.push(entry.producer.key);
      if (mode === 'ordinary' && entry.producer.key !== 'personal') return commit(entry);
      if (mode === 'cancelled cleanup') {
        controller.abort(new DOMException('Interrupted', 'AbortError'));
        throw Object.assign(new Error('Unconfirmed process cleanup'), { code: 'pluginProcessCleanupFailed' });
      }
      throw attachSafeOperationError(new Error('Injected producer failure'), {
        safeMessage: 'The producer failed.', code: 'commandPackageApplyFailed' });
    });
    try {
      const applied = await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'user',
        '--value-json', '[{"key":"final"}]', '--apply', '--yes'], controller.signal);
      expect(applied.exitCode, JSON.stringify(applied.payload)).toBe(mode === 'ordinary' ? 4 : 1);
      expect(applied.payload.data.configWrite).toBe('succeeded');
      expect(applied.payload.data.apply.state).toBe('partial');
      const targets = applied.payload.data.apply.targetResults;
      expect(targets.some((entry: { target: { pluginId: string }; state: string }) =>
        entry.target.pluginId === 'team/provider' && entry.state === 'completed')).toBe(true);
      for (const platform of ['codex', 'claude']) {
        expect(targets).toContainEqual(expect.objectContaining({ target: expect.objectContaining({ pluginId: 'team/consumer', platform }),
          state: expect.stringMatching(/failed|skipped/u) }));
      }
      expect(await fs.readJson(config)).toEqual({ selected: 'native' });
      expect((await fs.readJson(resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'provider', scope: 'user', cwd, env }))).common.registry)
        .toEqual([{ key: 'final' }]);
      const results = applied.payload.data.apply.commandResults;
      expect(results).toHaveLength(2);
      if (mode === 'ordinary') {
        expect(called.sort()).toEqual(['personal', 'uninstalled']);
        expect(results).toContainEqual(expect.objectContaining({ producer: expect.objectContaining({ key: 'personal' }), state: 'failed' }));
        expect(results).toContainEqual(expect.objectContaining({ producer: expect.objectContaining({ key: 'uninstalled' }), state: 'completed' }));
      } else {
        expect(called).toHaveLength(1);
        expect(results.every((entry: { state: string }) => entry.state === 'failed')).toBe(true);
        expect(applied.payload.diagnostics).toContainEqual(expect.objectContaining({ code: 'processCleanupUnconfirmed' }));
      }
    } finally { commits.mockRestore(); }
  }, 60_000);

  it('retains the standalone apply receipt after interruption and can recover', async () => {
    const qualifiedProfile = vi.mocked(getQualifiedPlatformProfile).getMockImplementation()!;
    vi.mocked(getQualifiedPlatformProfile).mockImplementation((platform, host) => {
      const profile = qualifiedProfile(platform, host);
      if (platform === 'codex') profile.features['skill.invocation.model'] = {
        status: 'unverified', reasonCodes: ['capability-unverified'],
      };
      return profile;
    });
    const { run, setSelected, config, cwd, env, source } =
      await createCommandPackageReferenceFixture({ initialSelection: 'next', providerModelControl: true });
    const install = await run(['plugin', 'install', 'team/consumer', '--scope', 'user', '--yes']);
    expect(install.exitCode, JSON.stringify(install.payload.diagnostics)).toBe(0);
    await setSelected('final');
    const configStore = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'consumer', scope: 'user', cwd, env });
    const storeBefore = await fs.readFile(configStore);
    const args = ['plugin', 'config', 'apply', 'team/consumer', '--context', 'user', '--yes'];
    const stopped = new AbortController();
    const commits = vi.spyOn(managedCommandStore, 'syncManagedCommandPackage').mockImplementationOnce(async () => {
      process.emit('SIGINT', 'SIGINT');
      throw new DOMException('Interrupted', 'AbortError');
    }).mockImplementationOnce(async () => {
      process.emit('SIGTERM', 'SIGTERM');
      throw new DOMException('Interrupted', 'AbortError');
    }).mockImplementationOnce(async () => {
      stopped.abort(new DOMException('Interrupted', 'AbortError'));
      throw Object.assign(new Error('Unconfirmed process cleanup'), { code: 'pluginProcessCleanupFailed' });
    });
    try {
      for (const { signal, exitCode, code, setting } of [
        { signal: undefined, exitCode: 130, code: 'operationInterrupted', setting: 'ctrl-c' },
        { signal: undefined, exitCode: 143, code: 'operationInterrupted', setting: 'terminate' },
        { signal: stopped.signal, exitCode: 1, code: 'processCleanupUnconfirmed', setting: 'cleanup' },
      ]) {
        await writePluginConfigStore({ sourceId: 'team', sourceIdentity: source.sourceIdentity,
          logicalIdentity: source.logicalIdentity, pluginName: 'provider', scope: 'user', cwd, env,
          values: { registry: [{ key: 'final' }, { key: 'next' }, { key: setting }] },
        });
        const interrupted = await run(args, signal);
        expect(interrupted).toMatchObject({ exitCode, payload: {
          command: 'plugin.config.apply',
          data: { configWrite: 'notStarted', apply: {
            state: 'partial',
            targetResults: expect.arrayContaining([
              expect.objectContaining({ target: expect.objectContaining({ pluginId: 'team/provider' }), state: 'completed' }),
              expect.objectContaining({ target: expect.objectContaining({ pluginId: 'team/consumer' }), state: 'failed' }),
            ]),
            commandResults: expect.arrayContaining([
              expect.objectContaining({ producer: expect.objectContaining({ key: 'personal' }), state: 'failed' }),
            ]),
          } },
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code }),
            expect.objectContaining({ code: 'skillInvocationPolicyNotGuaranteed',
              subject: { pluginId: 'team/provider', target: 'codex', scope: 'user', field: 'skill.provider' },
              detail: { reasonCode: 'invocationControlUnverified', skillInvocationControls: [
                { feature: 'skill.invocation.model', values: ['false'], reasonCode: 'invocationControlUnverified' },
              ] },
            }),
          ]),
        } });
      }
      expect(commits).toHaveBeenCalledTimes(3);
      expect(await fs.readJson(config)).toEqual({ selected: 'next' });
      expect(await fs.readFile(configStore)).toEqual(storeBefore);
    } finally { commits.mockRestore(); }
    const recovered = await run(args);
    expect(recovered).toMatchObject({ exitCode: 0, payload: { data: {
      configWrite: 'notStarted', apply: { state: 'succeeded' },
    } } });
    expect(await fs.readJson(config)).toEqual({ selected: 'final' });
    expect(await fs.readFile(configStore)).toEqual(storeBefore);
  }, 60_000);

  it('keeps the committed group and delivered targets when direct TUI batch apply is interrupted', async () => {
    const { run, config, cwd, env, dependencies } =
      await createCommandPackageReferenceFixture({ initialSelection: 'next' });
    const installed = await run(['plugin', 'install', 'team/consumer', '--scope', 'user', '--yes']);
    expect(installed.exitCode, JSON.stringify(installed.payload.diagnostics)).toBe(0);
    const value = new TuiController(dependencies);
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'configSaveBatch', pluginId: 'team/consumer', context: 'user', apply: true,
      groups: [
        { updates: { selected: 'native' } },
        { platform: 'codex', updates: { selected: 'next' } },
      ],
    });
    const commits = vi.spyOn(managedCommandStore, 'syncManagedCommandPackage').mockImplementation(async () => {
      throw Object.assign(new Error('Unconfirmed process cleanup'), { code: 'pluginProcessCleanupFailed' });
    });
    try {
      await value.executeOperation(review.reviewToken);
      const result = value.snapshot.result;
      expect(result).toMatchObject({
        state: 'partial',
        effects: { configCommit: 'partial' },
        summary: {
          configGroups: [
            { configSaved: true, applyStatus: 'partial', errorCode: 'processCleanupUnconfirmed' },
            { platform: 'codex', configSaved: false, applyStatus: 'notStarted', notStarted: true },
          ],
          configTargets: expect.arrayContaining([
            expect.objectContaining({ pluginId: 'team/provider', platform: 'codex', state: 'completed' }),
            expect.objectContaining({ pluginId: 'team/consumer', platform: 'codex', state: 'failed' }),
          ]),
          commandResults: expect.arrayContaining([
            expect.objectContaining({ producer: expect.objectContaining({ key: 'personal' }), state: 'failed' }),
          ]),
        },
      });
      expect(commits).toHaveBeenCalledOnce();
      const storedConfig = await fs.readJson(resolvePluginConfigStorePath({
        sourceId: 'team', pluginName: 'consumer', scope: 'user', cwd, env,
      }));
      expect(storedConfig.common.selected).toBe('native');
      expect(storedConfig.platforms?.codex).toBeUndefined();
      expect(await fs.readJson(config)).toEqual({ selected: 'next' });
    } finally {
      commits.mockRestore();
      value.dispose();
    }
  }, 60_000);

  it('updates two hosts and publishes each cross-platform command package once after its provider', async () => {
    const { run, setSelected, config } = await createCommandPackageReferenceFixture({ withClaude: true });
    const installed = await run(['plugin', 'install', 'team/consumer', '--scope', 'user', '--yes']);
    expect(installed.exitCode, JSON.stringify(installed.payload.diagnostics)).toBe(0);
    await setSelected('final');
    const commits = vi.spyOn(managedCommandStore, 'syncManagedCommandPackage');
    try {
      const applied = await run(['plugin', 'config', 'set', 'team/provider', 'registry', '--context', 'user',
        '--value-json', '[{"key":"final"}]', '--apply', '--yes']);
      expect(applied.exitCode, JSON.stringify(applied.payload.diagnostics)).toBe(0);
      expect(applied.payload.data.apply.state).toBe('succeeded');
      expect(commits.mock.calls.map(([entry]) => entry.producer.key).sort()).toEqual(['personal', 'uninstalled']);
      await expect(fs.readJson(config)).resolves.toEqual({ selected: 'final' });
      for (const platform of ['codex', 'claude']) expect(applied.payload.data.apply.targetResults).toEqual(expect.arrayContaining([
        expect.objectContaining({ state: 'completed', target: expect.objectContaining({ pluginId: 'team/consumer', platform }) }),
      ]));
    } finally { commits.mockRestore(); }
  }, 60_000);

  // Test Value Gate: Review and execution include platform targets and command
  // packages once, with the same authorization and dependency results.
  it('applies platform targets and consumer packages from the accepted Review', async () => {
    const { renders, scripts, run, setSelected, config, dependencies } = await createCommandPackageReferenceFixture();
    const platform = await run(['plugin', 'install', 'team/consumer', '--scope', 'user', '--yes']);
    expect(platform, JSON.stringify(platform)).toMatchObject({ exitCode: 0 });
    await setSelected('final');
    await fs.outputFile(renders, '');
    await fs.outputFile(scripts, '');
    const commits = vi.spyOn(managedCommandStore, 'syncManagedCommandPackage');
    try {
      await dependencies.loadStatus(new AbortController().signal);
      expect(await fs.readFile(renders, 'utf8')).toBe('');
      const finalRegistry = [{ key: 'final' }];
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
      expect(commits).not.toHaveBeenCalled();
      expect(await fs.readFile(scripts, 'utf8')).toBe('');
      const combined = await dependencies.executeIntent(finalIntent, combinedReview, new AbortController().signal) as PluginConfigWriteReceipt;
      expect(combined, JSON.stringify(combined)).toMatchObject({ overallState: 'succeeded', apply: { state: 'succeeded' } });
      expect([...new Set(combined.apply.targetResults.filter((entry) => entry.action !== 'keep')
        .map((entry) => `${entry.target.pluginName}/${entry.target.platform}/${entry.target.scope}`))].sort())
        .toEqual(combinedReview.config!.affectedTargets.map((entry) => `${entry.pluginName}/${entry.platform}/${entry.scope}`).sort());
      expect(combined.apply.targetResults.filter((entry) => entry.target.pluginName === 'middle'))
        .toEqual([expect.objectContaining({ action: 'refresh', state: 'completed' })]);
      expect(combined.apply.commandResults!.filter((entry) => entry.producer.key === 'personal')).toHaveLength(1);
      expect(commits.mock.calls.map(([options]) => `${options.producer.pluginName}/${options.producer.key}`).sort())
        .toEqual(['consumer/personal', 'consumer/uninstalled']);
      const hooks = (await fs.readFile(scripts, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(hooks.map((entry) => `${entry.plugin}/${entry.platform}`).sort()).toEqual(['consumer/codex', 'provider/codex']);
      expect(await fs.readJson(config)).toEqual({ selected: 'final' });
    } finally { commits.mockRestore(); }
  }, 30_000);

  // Test Value Gate: changes to either referenced store invalidate accepted
  // retry evidence before writes, while fresh evidence allows recovery.
  it.each(['consumer', 'middle'] as const)(
    'rejects stale retry evidence after the %s store changes and accepts a fresh Review',
    async (pluginName) => {
      const { cwd, env, source, renders, scripts, config, dependencies } =
        await createCommandPackageReferenceFixture({ initialSelection: pluginName === 'consumer' ? 'final' : 'next' });
      const store = (pluginName: string) => ({ sourceId: 'team', sourceIdentity: source.sourceIdentity,
        logicalIdentity: source.logicalIdentity, pluginName, scope: 'user' as const, cwd, env });
      const retryIntent: OperationIntent = { kind: 'configSave', pluginId: 'team/provider', scope: 'user', retryApply: true, apply: true };
      const reviewRetry = () => dependencies.prepareReviewEvidence!(retryIntent, new AbortController().signal, () => undefined);
      await dependencies.loadStatus(new AbortController().signal);
      const reviewed = await reviewRetry();
      expect(await dependencies.captureEvidence(retryIntent)).toEqual(reviewed);
      const artifactBefore = await fs.readFile(config);
      expect(await fs.pathExists(scripts)).toBe(false);
      const rendersBefore = await fs.readFile(renders);
      await writePluginConfigStore({ ...store(pluginName), values: pluginName === 'consumer'
        ? { selected: 'next' } : { registry: [{ key: 'next' }] } });
      expect((await dependencies.captureEvidence(retryIntent)).config?.applyEvidence).not.toEqual(reviewed.config?.applyEvidence);
      await expect(dependencies.executeIntent(retryIntent, reviewed, new AbortController().signal))
        .rejects.toMatchObject({ code: 'operationReviewStale' });
      expect(await fs.readFile(config)).toEqual(artifactBefore);
      expect(await fs.pathExists(scripts)).toBe(false);
      expect(await fs.readFile(renders)).toEqual(rendersBefore);
      const fresh = await reviewRetry();
      await expect(dependencies.executeIntent(retryIntent, fresh, new AbortController().signal))
        .resolves.toMatchObject({ apply: { state: 'succeeded' } });
      expect(await fs.readJson(config)).toEqual({ selected: 'next' });
    }, 30_000,
  );

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
          `console.log(JSON.stringify({version:3,components:c.allowedOutputKinds.includes('skill')?[{id:name,kind:'skill',name,runtimeConfig:{keys:${JSON.stringify(name === 'provider' ? ['registry'] : ['selected'])}},content:{files:Object.fromEntries(Object.entries(files).map(([p,text])=>[p,{text}]))}}]:[],omitted:[],unmet:[]}));`,
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
