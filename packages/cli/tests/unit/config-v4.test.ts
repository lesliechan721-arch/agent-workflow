import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { normalizePluginConfigDefinition, type PluginComponent } from '@lesliechan721/aw-plugin-core/manifest';

import type { PluginMeta } from '../../src/types.js';
import {
  createPluginConfigSchemaIdentity,
  readPluginConfigStore,
  resolveEffectivePluginConfig,
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { applyPluginConfigWrite } from '../../src/utils/plugin-config-write.js';
import { selectPlatformRenderConfig } from '../../src/utils/artifact-request.js';
import { getAuthoringPlatformCapabilities } from '../../src/review/platform-profile.js';
import { createArtifactRuntimeConfigSnapshots } from '../../src/utils/runtime-config.js';
import { createConfigV4Definition } from '../helpers/config-v4-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const sourceIdentity = `sha256:${'4'.repeat(64)}`;

function fixture() {
  const isolation = getCurrentSourceTestIsolation();
  const store = {
    sourceId: 'team', sourceIdentity, logicalIdentity: 'fixture:config-v4',
    pluginName: 'executor-config', scope: 'user' as const,
    cwd: isolation.layout.fixtureCwd, env: isolation.env,
  };
  const plugin: PluginMeta = {
    rootDir: isolation.layout.fixtureCwd,
    manifestPath: path.join(isolation.layout.fixtureCwd, '.agents-plugin/plugin.json'),
    sourceId: store.sourceId, sourceIdentity, catalogLogicalIdentity: store.logicalIdentity,
    manifest: {
      schemaVersion: 4, name: store.pluginName, version: '1.0.0', description: 'Executor config fixture',
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      config: createConfigV4Definition(),
    },
  };
  const save = (updates: Record<string, unknown>, platform?: 'codex' | 'claude') => applyPluginConfigWrite({
    plugin, scope: 'user', platform, cwd: store.cwd, env: store.env, request: { updates }, apply: false,
  });
  return { store, plugin, save };
}

async function subagentRuntimeComponents(plugin: PluginMeta, config: Awaited<ReturnType<typeof resolveEffectivePluginConfig>>): Promise<PluginComponent[]> {
  const { renderArtifactPlan } = await import('../../../../plugins/agent-subagent/scripts/render-artifacts.mjs');
  const capabilities = getAuthoringPlatformCapabilities('codex', 'user');
  capabilities.profileId = 'synthetic-runtime-snapshot';
  capabilities.kinds.skill = { ...capabilities.kinds.skill, status: 'supported', reasonCodes: [] };
  for (const [feature, values] of [['agent.execution', ['isolated-context']], ['agent.prompt-mode', ['host-default']],
    ['skill.runtime-config', ['aw.installed-runtime-config.v2']]] as const) {
    capabilities.features[feature] = { status: 'supported', reasonCodes: [], values: [...values] };
  }
  const plan = await renderArtifactPlan({ schemaVersion: 1, surface: 'agent-plugin', platform: 'codex', scope: 'user',
    plugin: { pluginId: 'team/executor-config', name: plugin.manifest.name, version: plugin.manifest.version },
    config: selectPlatformRenderConfig({ resolved: { ...config, mode: 'artifact-render', targetScope: 'user' },
      keys: plugin.manifest.artifacts!.configKeys, nonSensitive: true }),
    changedConfigKeys: [], allowedOutputKinds: ['skill'], platformCapabilities: capabilities, previousComponents: [],
    resources: [{ kind: 'bundle', name: './skills/spawn-subagent', digest: `sha256:${'0'.repeat(64)}`,
      root: path.resolve(import.meta.dirname, '../../../../plugins/agent-subagent/skills/spawn-subagent') }],
  });
  return plan.components;
}

describe('Config Definition v4 CLI boundaries', () => {
  // Test Value Gate: use the shipped plugin schema, writer and runtime snapshot so
  // convenience fields cannot be accepted in the wrong branch or lost on apply.
  it('saves Agent Subagent backend options and keeps profile values out of installed runtime', async () => {
    const { store, plugin, save } = fixture();
    const source = await fs.readJson(path.resolve(import.meta.dirname, '../../../../plugins/agent-subagent/.agents-plugin/plugin.json'));
    plugin.manifest.config = normalizePluginConfigDefinition(source.config);
    const defaults = await resolveEffectivePluginConfig({ ...store, manifest: plugin.manifest, targetScope: 'user' });
    for (const key of ['simpleTaskProfile', 'generalTaskProfile', 'complexTaskProfile', 'advancedTaskProfile']) {
      expect(defaults.values[key]).toEqual({ executor: 'native' });
    }
    const commands = [
      { key: 'oracle-web', adapter: 'oracle', oracleEngine: 'browser' },
      { key: 'oracle-default', adapter: 'oracle' },
      { key: 'codex-review', adapter: 'codex', codexProfile: 'review profile' },
      { key: 'codex-default', adapter: 'codex' },
      { key: 'codex-app', adapter: 'codex', codexCliSource: 'app', codexBypassHookTrust: true, communication: false, resume: true },
      { key: 'codex-cli', adapter: 'codex', codexCliSource: 'cli', codexBypassHookTrust: false, communication: true, resume: false },
      { key: 'codex-auto', adapter: 'codex', codexCliSource: 'auto', codexBypassHookTrust: true, codexProfile: 'advanced' },
      { key: 'agy', adapter: 'antigravity', communication: false, args: ['--model', 'backend-default'],
        env: { ORDINARY: 'literal' }, envFrom: { TOKEN: 'HOST_TOKEN' } },
      { key: 'custom', adapter: 'custom', mode: 'workspace', command: process.execPath, communication: true },
      ...['codex', 'claude-code', 'antigravity'].flatMap((adapter) =>
        ['default', 'auto', 'full-access'].map((permissionMode) => ({
          key: `${adapter}-${permissionMode}-permission`, adapter, permissionMode, communication: false,
        }))),
    ];
    const generalTaskProfile = { executor: 'oracle-web', reasoningEffort: 'pro' };
    await save({ subagentCommands: commands, generalTaskProfile });
    const config = await resolveEffectivePluginConfig({ ...store, manifest: plugin.manifest, targetScope: 'user' });
    expect(config.values).toMatchObject({ subagentCommands: commands, generalTaskProfile });
    plugin.manifest.artifacts = source.artifacts;
    plugin.manifest.requires = source.requires;
    const snapshots = createArtifactRuntimeConfigSnapshots({ sourceId: store.sourceId, sourceIdentity,
      logicalIdentity: store.logicalIdentity, manifest: plugin.manifest, platform: 'codex', scope: 'user', components: await subagentRuntimeComponents(plugin, config),
      config: { ...config, mode: 'artifact-render', targetScope: 'user' } });
    expect(snapshots['spawn-subagent-skill']!.effectiveValues).toEqual({ subagentCommands: commands, subagentRetentionHours: 24 });
    const file = resolvePluginConfigStorePath(store);
    const before = await fs.readFile(file);
    for (const invalid of [
      { ...commands[0], oracleEngine: 'auto' }, { ...commands[0], adapter: 'codex' },
      { ...commands[2], adapter: 'oracle' }, { ...commands[2], adapter: 'claude-code' },
      ...['', '  ', '\0', 'x'.repeat(4097)].map((codexProfile) => ({ ...commands[2], codexProfile })),
      ...['codex', 'claude-code', 'antigravity', 'oracle', 'custom'].flatMap((adapter) =>
        ['false', 0, null].map((communication) => ({ key: 'invalid', adapter, communication,
          ...(adapter === 'custom' ? { command: process.execPath, mode: 'workspace' } : {}) }))),
      ...['false', 0, null].map((resume) => ({ ...commands[4], resume })),
      ...['cli-path', false, null].map((codexCliSource) => ({ ...commands[4], codexCliSource })),
      ...['false', 0, null].map((codexBypassHookTrust) => ({ ...commands[4], codexBypassHookTrust })),
      ...['claude-code', 'antigravity', 'oracle', 'custom'].flatMap((adapter) => [
        { key: 'foreign', adapter, codexCliSource: 'auto',
          ...(adapter === 'custom' ? { command: process.execPath, mode: 'workspace' } : {}) },
        { key: 'foreign', adapter, codexBypassHookTrust: false,
          ...(adapter === 'custom' ? { command: process.execPath, mode: 'workspace' } : {}) },
      ]),
      ...['codex', 'claude-code', 'antigravity'].flatMap((adapter) =>
        ['skip', '', false, null].map((permissionMode) => ({ key: 'invalid', adapter, permissionMode }))),
      ...['oracle', 'custom'].flatMap((adapter) =>
        ['default', 'auto', 'full-access'].map((permissionMode) => ({ key: 'invalid', adapter, permissionMode,
          ...(adapter === 'custom' ? { command: process.execPath, mode: 'workspace' } : {}) }))),
      { ...commands[7], mode: 'bundle' },
      { ...commands[7], command: process.execPath },
    ]) {
      await expect(save({ subagentCommands: [commands[0], { ...invalid, key: 'invalid' }] })).rejects.toThrow();
      expect(await fs.readFile(file)).toEqual(before);
    }
  });

  // Test Value Gate: persisted retention and installed snapshots control deletion;
  // zero must survive saving, and invalid values must preserve the prior file.
  it('saves Guide retention hours including zero and rejects invalid ranges atomically', async () => {
    const { store, plugin, save } = fixture();
    const source = await fs.readJson(path.resolve(import.meta.dirname, '../../../../plugins/agent-subagent/.agents-plugin/plugin.json'));
    plugin.manifest.config = normalizePluginConfigDefinition(source.config);
    plugin.manifest.artifacts = source.artifacts;
    plugin.manifest.requires = source.requires;
    const maximum = Math.floor(Number.MAX_SAFE_INTEGER / 3_600_000);
    for (const subagentRetentionHours of [maximum, 1, 0]) {
      await save({ subagentRetentionHours });
      const config = await resolveEffectivePluginConfig({ ...store, manifest: plugin.manifest, targetScope: 'user' });
      expect(config.values.subagentRetentionHours).toBe(subagentRetentionHours);
      const snapshots = createArtifactRuntimeConfigSnapshots({ sourceId: store.sourceId, sourceIdentity,
        logicalIdentity: store.logicalIdentity, manifest: plugin.manifest, platform: 'codex', scope: 'user', components: await subagentRuntimeComponents(plugin, config),
        config: { ...config, mode: 'artifact-render', targetScope: 'user' } });
      expect(snapshots['spawn-subagent-skill']!.effectiveValues).toEqual({ subagentCommands: [], subagentRetentionHours });
    }
    const file = resolvePluginConfigStorePath(store);
    const before = await fs.readFile(file);
    for (const subagentRetentionHours of [-1, 0.5, maximum + 1, Number.NaN, Number.POSITIVE_INFINITY, 'invalid', null]) {
      await expect(save({ subagentRetentionHours })).rejects.toThrow();
      expect(await fs.readFile(file)).toEqual(before);
    }
  });

  // Test Value Gate: the store accepts only the finite v4 value shape, before a schema is available.
  it('round trips finite leaf containers and preserves bytes when deeper or mixed containers are rejected', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const options = { sourceId: 'team', sourceIdentity, pluginName: 'store-shape', scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const values = { rows: [{ args: ['', ' a '], env: { EMPTY: '', COUNT: 3 }, flags: [false, true] }],
      object: { args: [], env: {} } };
    await writePluginConfigStore({ ...options, values });
    expect(await readPluginConfigStore(options)).toMatchObject({ state: 'ready', values });
    const file = resolvePluginConfigStorePath(options);
    const before = await fs.readFile(file);
    for (const rows of [
      [{ args: [['nested']] }], [{ env: { nested: {} } }],
      [{ child: { next: { value: 'recursive' } } }], [{ args: ['mixed', 1] }],
      [['nested']], ['mixed', {}], [{ args: [null] }],
    ]) {
      await expect(writePluginConfigStore({ ...options, values: { rows } })).rejects.toThrow('invalidValues');
      expect(await fs.readFile(file)).toEqual(before);
    }
  });

  // Test Value Gate: shared validation must reject headless writes before the atomic commit.
  it('saves raw builtins and custom values while rejecting branch, constant, legacy and profile errors before commit', async () => {
    const { store, plugin, save } = fixture();
    const commands = [
      { key: 'codex-local', title: 'Codex', adapter: 'codex', args: ['', ' a '], env: { EMPTY: '' }, envFrom: { TOKEN: 'HOST_TOKEN' } },
      { key: 'claude-local', title: 'Claude', adapter: 'claude-code' },
      { key: 'oracle-local', title: 'Oracle', adapter: 'oracle', mode: 'bundle' },
      { key: 'custom-local', title: 'Custom', adapter: 'custom', mode: 'workspace', command: process.execPath },
    ];
    const values = { subagentCommands: commands, advisorProfile: { executor: 'codex-local' } };
    const receipt = await save(values);
    expect(receipt).toMatchObject({ configWrite: 'succeeded', overallState: 'succeeded', apply: { state: 'skipped', reason: 'notRequested' } });
    const file = resolvePluginConfigStorePath(store);
    const before = await fs.readFile(file);
    expect(JSON.parse(before.toString())).toMatchObject({ schemaVersion: 6, common: values, platforms: {} });
    expect((await readPluginConfigStore(store)).values).toEqual(values);
    expect((await resolveEffectivePluginConfig({ ...store, manifest: plugin.manifest, targetScope: 'user' })).values).toEqual(values);
    expect(JSON.parse(before.toString()).common.subagentCommands[0]).not.toHaveProperty('mode');

    const builtin = commands[0]!;
    for (const command of [
      { ...builtin, adapter: 'unknown' }, { key: 'codex-local', title: 'Missing adapter' },
      { ...builtin, command: process.execPath }, { ...builtin, entrypoint: '/wrapper.mjs' },
      { ...builtin, mode: 'bundle' }, { ...builtin, supportsReadOnly: true },
      { ...builtin, args: ['mixed', 1] }, { ...builtin, env: { TOKEN: { nested: 'value' } } },
      { ...builtin, adapter: 'custom', command: process.execPath },
    ]) {
      await expect(save({ subagentCommands: [command] })).rejects.toThrow();
      expect(await fs.readFile(file)).toEqual(before);
    }
    for (const advisorProfile of [{}, { executor: 'native' }, { executor: 'unregistered' }]) {
      await expect(save({ advisorProfile })).rejects.toThrow();
      expect(await fs.readFile(file)).toEqual(before);
    }
    await save({ advisorProfile: { model: 'native-model', reasoningEffort: 'medium' } });
    expect((await readPluginConfigStore(store)).values.advisorProfile).toEqual({ model: 'native-model', reasoningEffort: 'medium' });
  });

  // Test Value Gate: whole-layer override and dependency validation protect materialized runtime values.
  it('uses whole-field platform overrides and validates runtime dependency closure without resolving envFrom', async () => {
    const { store, plugin, save } = fixture();
    await save({ subagentCommands: [{ key: 'remote', title: 'User', adapter: 'codex', args: ['--user'], envFrom: { TOKEN: 'HOST_TOKEN' } }],
      advisorProfile: { executor: 'remote' } });
    await save({ subagentCommands: [{ key: 'remote', title: 'Project', adapter: 'oracle', args: [], envFrom: { TOKEN: 'HOST_TOKEN' } }] }, 'codex');
    const config = await resolveEffectivePluginConfig({ ...store, manifest: plugin.manifest, platform: 'codex', targetScope: 'project' });
    expect(config.values.subagentCommands).toEqual([{ key: 'remote', title: 'Project', adapter: 'oracle', args: [], envFrom: { TOKEN: 'HOST_TOKEN' } }]);
    expect(config.sources).toMatchObject({ subagentCommands: 'platform', advisorProfile: 'common' });
    plugin.manifest.artifacts = { configKeys: ['advisorProfile', 'subagentCommands'] };
    plugin.manifest.requires = { aw: { capabilities: ['aw.installed-runtime-config.v2'] } };
    const components: PluginComponent[] = [{ id: 'runtime', kind: 'skill', name: 'runtime', content: { files: {} },
      runtimeConfig: { keys: ['advisorProfile', 'subagentCommands'] } }];
    const runtime = (resolved: typeof config) => createArtifactRuntimeConfigSnapshots({ sourceId: store.sourceId, sourceIdentity,
      logicalIdentity: store.logicalIdentity, manifest: plugin.manifest, platform: 'codex', scope: 'project', components,
      config: { ...resolved, mode: 'artifact-render', targetScope: 'project' },
    });
    expect(runtime(config).runtime!.effectiveValues).toEqual(config.values);
    await writePluginConfigStore({ ...store, platform: 'codex', values: {
      subagentCommands: [{ key: 'remote', title: 'Invalid project', adapter: 'codex', mode: 'bundle' }],
    } });
    const invalid = await resolveEffectivePluginConfig({ ...store, manifest: plugin.manifest, platform: 'codex', targetScope: 'project' });
    expect(invalid.values).not.toHaveProperty('subagentCommands');
    expect(invalid.values).not.toHaveProperty('advisorProfile');
    expect(invalid.issues).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'advisorProfile', code: 'valueRefSource' })]));
    expect(() => runtime(invalid)).toThrow('runtimeConfigInvalid');
  });

  // Test Value Gate: changed branch/const metadata must invalidate prior Review evidence.
  it('binds schema identity to branch properties, constants and presentation metadata', () => {
    const { plugin } = fixture();
    const original = createPluginConfigSchemaIdentity(plugin.manifest);
    for (const change of ['branch', 'const', 'presentation']) {
      const manifest = structuredClone(plugin.manifest);
      const commands = manifest.config!.fields.subagentCommands!;
      if (commands.type !== 'array' || commands.items.type !== 'object' || !commands.items.variants) throw new Error('fixture shape');
      if (change === 'branch') commands.items.variants.cases.custom!.properties.note = { type: 'string' };
      if (change === 'const') commands.items.variants.cases.codex!.properties.mode = { type: 'string', const: 'bundle' };
      if (change === 'presentation') manifest.config!.presentation = { groups: [{ id: 'executors', title: 'Executors', fields: ['subagentCommands'] }] };
      expect(createPluginConfigSchemaIdentity(manifest)).not.toEqual(original);
    }
  });
});
