import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';
import { getPluginConfigReferenceChoices, normalizePluginConfigDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import type { PluginMeta, ReceiptTargetIdentity } from '../../src/types.js';
import type { RebuildCommandResult } from '../../src/commands/rebuild-command.js';
import { applyPluginConfigWrite, replayConfigRuntimeWrites, resetPluginConfigWithHelper } from '../../src/utils/plugin-config-write.js';
import { resolveEffectivePluginConfig, resolvePluginConfigStorePath, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { analyzePluginConfigMutationImpact } from '../../src/utils/plugin-config-impact.js';
import { createArtifactRuntimeConfigSnapshots } from '../../src/utils/runtime-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture() {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const create = (name: string, fields: Record<string, unknown>, dependencies: string[] = []): PluginMeta => ({
    rootDir: path.join(cwd, name), manifestPath: path.join(cwd, name, '.agents-plugin/plugin.json'),
    sourceId: 'team', sourceIdentity: `sha256:${'a'.repeat(64)}`, catalogLogicalIdentity: 'team/catalog', pluginId: `team/${name}`,
    manifest: { schemaVersion: 3, name, version: '1.0.0', description: 'Config reference fixture', dependencies,
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      config: normalizePluginConfigDefinition({ schemaVersion: 4, fields }) },
  });
  const provider = create('provider', { registry: { type: 'array', default: [], validation: { uniqueBy: 'key' }, items: {
    type: 'object', properties: { key: { type: 'string', required: true }, label: { type: 'string', required: true } }, additionalProperties: false,
  } } });
  provider.manifest.artifacts = { targets: [{ id: 'registry', platform: 'codex', target: 'codex.skill', skillKey: 'provider',
    scopes: ['user', 'project'], states: ['present'], refreshKeys: ['registry'],
    delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' } }] };
  const consumer = create('consumer', {
    selected: { type: 'string', default: 'native', valueRef: { plugin: 'provider', field: 'registry', key: 'key', label: 'label', include: ['native'] } },
    unrelated: { type: 'number', default: 1 },
  }, ['provider']);
  consumer.manifest.artifacts = { targets: [{ id: 'selected', platform: 'codex', target: 'codex.skill', skillKey: 'consumer',
    scopes: ['user', 'project'], states: ['present'], refreshKeys: ['selected'], delivery: { mode: 'aw-extension' },
    runtimeConfig: { keys: ['selected'] } }] };
  const plugins = [provider, consumer];
  for (const plugin of plugins) await fs.outputJson(plugin.manifestPath, plugin.manifest);
  const store = (plugin: PluginMeta, scope: 'user' | 'project' = 'user') => ({
    sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity,
    pluginName: plugin.manifest.name, scope, cwd, env: isolation.env,
  });
  const resolve = (plugin: PluginMeta, scope: 'user' | 'project' = 'user', selectedPlugins = plugins) => resolveEffectivePluginConfig({
    ...store(plugin, scope), manifest: plugin.manifest, targetScope: scope, referencePlugins: selectedPlugins,
  });
  const save = (plugin: PluginMeta, updates: Record<string, unknown>, extra: Record<string, unknown> = {}) => applyPluginConfigWrite({
    plugin, scope: 'user', cwd, env: isolation.env, apply: false, request: { updates }, rebuildRuntime: { referencePlugins: plugins }, ...extra,
  });
  return { cwd, env: isolation.env, provider, consumer, plugins, store, resolve, save };
}

describe('same-source configuration references', () => {
  // Test Value Gate: hook-only project inputs require apply even when shared user renderer inputs do not change.
  it('includes foreign preApply inputs without inventing a shared native renderer update', async () => {
    const f = await fixture();
    f.consumer.manifest.scripts = { preApply: { path: './pre-apply.mjs' } };
    const declaration = f.consumer.manifest.artifacts!.targets![0]!;
    declaration.refreshKeys = ['unrelated'];
    declaration.runtimeConfig = { keys: ['unrelated'] };
    declaration.delivery = { mode: 'codex-native', identity: 'shared', renderProfile: 'user' };
    await writePluginConfigStore({ ...f.store(f.consumer, 'project'), values: { selected: 'remote' } });
    const target: ReceiptTargetIdentity = { pluginName: 'consumer', platform: 'codex', scope: 'project', projectKey: f.cwd };
    const impact = await analyzePluginConfigMutationImpact({ plugin: f.provider, scope: 'user', cwd: f.cwd, env: f.env,
      referencePlugins: f.plugins, visibleTargets: [target], mutation: { kind: 'patch', updates: { registry: [{ key: 'remote', label: 'Remote' }] } } });
    expect(impact.affectedTargets).toEqual([target]);
    expect(impact.noEffectiveChange).toBe(false);
    expect(impact.sharedNativeRenderTargets).toEqual([]);
  });

  // Test Value Gate: a project activation can render shared user content; every writer must confirm it before writes.
  it('uses the foreign native render scope and gates save, reset and replay before writing', async () => {
    const f = await fixture();
    f.provider.manifest.artifacts!.targets![0]!.delivery = { mode: 'aw-extension' };
    f.consumer.manifest.artifacts!.targets![0]!.delivery = { mode: 'codex-native', identity: 'shared', renderProfile: 'user' };
    await writePluginConfigStore({ ...f.store(f.provider), values: { registry: [] } });
    await writePluginConfigStore({ ...f.store(f.provider, 'project'), values: { registry: [] } });
    await writePluginConfigStore({ ...f.store(f.consumer), values: { selected: 'remote' } });
    const targets: ReceiptTargetIdentity[] = [{ pluginName: 'consumer', platform: 'codex', scope: 'project', projectKey: f.cwd }];
    const impact = await analyzePluginConfigMutationImpact({ plugin: f.provider, scope: 'user', cwd: f.cwd, env: f.env,
      referencePlugins: f.plugins, visibleTargets: targets, mutation: { kind: 'patch', updates: { registry: [{ key: 'remote', label: 'Remote' }] } } });
    expect(impact.affectedTargets).toEqual(targets);
    expect(impact.sharedNativeRenderTargets).toEqual([expect.objectContaining({ skillKey: 'consumer', pluginName: 'consumer' })]);
    const file = resolvePluginConfigStorePath(f.store(f.provider));
    const before = await fs.readFile(file);
    const apply = vi.fn(async (_selectors: string[], _options: unknown, runtime: { resolvePreApplyAuthorization?: boolean }) => {
      if (!runtime.resolvePreApplyAuthorization) throw new Error('Unexpected runtime write before confirmation');
      return { overallState: 'succeeded', preApplyAuthorization: [] } as unknown as RebuildCommandResult;
    });
    const runtime = { referencePlugins: f.plugins };
    await expect(f.save(f.provider, { registry: [{ key: 'remote', label: 'Remote' }] }, {
      apply: true, applyTargets: targets, reinstallCommandImpl: apply,
    })).rejects.toMatchObject({ code: 'sharedNativeConfigApplyConfirmationRequired' });
    expect(await fs.readFile(file)).toEqual(before);
    f.provider.manifest.config!.fields.registry!.default = [{ key: 'remote', label: 'Remote' }];
    await expect(resetPluginConfigWithHelper({ plugin: f.provider, pluginName: 'provider', scope: 'user', cwd: f.cwd, env: f.env,
      applyTargets: targets, apply: true, rebuildRuntime: runtime, reinstallCommandImpl: apply,
    })).rejects.toMatchObject({ code: 'sharedNativeConfigApplyConfirmationRequired' });
    expect(await fs.readFile(file)).toEqual(before);
    await writePluginConfigStore({ ...f.store(f.provider), values: { registry: [{ key: 'remote', label: 'Remote' }] } });
    const replayBefore = await fs.readFile(file);
    await expect(replayConfigRuntimeWrites({ plugin: f.provider, scope: 'user', cwd: f.cwd, env: f.env,
      applyTargets: targets, rebuildRuntime: runtime, reinstallCommandImpl: apply,
    })).rejects.toMatchObject({ code: 'sharedNativeConfigApplyConfirmationRequired' });
    expect(await fs.readFile(file)).toEqual(replayBefore);
    expect(apply.mock.calls.every((call) => call[2].resolvePreApplyAuthorization === true)).toBe(true);
  });

  // Test Value Gate: source and layer confusion can accept a key that the installed provider cannot execute.
  it('uses only the same source and provider user-only layer, and keeps the registry out of runtime values', async () => {
    const f = await fixture();
    await writePluginConfigStore({ ...f.store(f.provider), values: { registry: [{ key: 'remote', label: 'Remote' }] } });
    await writePluginConfigStore({ ...f.store(f.provider, 'project'), values: { registry: [{ key: 'project', label: 'Project' }] } });
    await writePluginConfigStore({ ...f.store(f.consumer, 'project'), values: { selected: 'remote' } });
    const foreign = { ...f.provider, sourceId: 'other', manifest: { ...f.provider.manifest,
      config: normalizePluginConfigDefinition({ schemaVersion: 4, fields: { registry: { type: 'string', default: 'wrong' } } }) } };
    const config = await f.resolve(f.consumer, 'project', [foreign, ...f.plugins]);
    expect(config.values.selected).toBe('remote');
    expect(config.referenceEvidence?.[0]?.sources.registry).toBe('user');
    const scalar = f.consumer.manifest.config!.fields.selected!;
    if (scalar.type !== 'string') throw new Error('Invalid fixture');
    expect(getPluginConfigReferenceChoices(f.consumer.manifest.config!, scalar, config.values, config.referenceContext)
      .choices.map((choice) => choice.value)).toEqual(['native', 'remote']);
    const snapshot = createArtifactRuntimeConfigSnapshots({ manifest: f.consumer.manifest, platform: 'codex', scope: 'project',
      config: { mode: 'artifact-render', targetScope: 'project', ...config }, requestedArtifactIds: ['selected'] }).selected!;
    expect(snapshot.effectiveValues).toEqual({ selected: 'remote' });
    await writePluginConfigStore({ ...f.store(f.provider), values: { registry: [{ key: 'broken' }] } });
    const invalid = await f.resolve(f.consumer, 'project');
    expect(invalid.values.selected).toBeUndefined();
    expect(invalid.issues).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'selected', code: 'valueRefSource' })]));
    expect(getPluginConfigReferenceChoices(f.consumer.manifest.config!, scalar, invalid.values, invalid.referenceContext)).toMatchObject({ choices: [], issues: expect.arrayContaining([expect.objectContaining({ code: 'valueRefSource' })]) });
    await writePluginConfigStore({ ...f.store(f.provider), values: { registry: [{ key: 'native', label: 'Reserved collision' }] } });
    await writePluginConfigStore({ ...f.store(f.consumer, 'project'), values: { selected: 'native' } });
    const collision = await f.resolve(f.consumer, 'project');
    expect(collision.values.selected).toBeUndefined();
    expect(collision.issues).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'selected', code: 'valueRefSource',
      message: expect.stringContaining('provider/registry') })]));
    await expect(f.save(f.consumer, { selected: 'native' })).rejects.toMatchObject({ code: 'configReferenceInvalid' });
  });

  // Test Value Gate: configured consumers count even when they have no installation intent.
  it('rejects a new dangling user or current-project reference without changing the provider store', async () => {
    const f = await fixture();
    await f.save(f.provider, { registry: [{ key: 'remote', label: 'Remote' }, { key: 'other', label: 'Other' }] });
    await writePluginConfigStore({ ...f.store(f.consumer), values: { selected: 'remote', unrelated: 'invalid' } });
    await writePluginConfigStore({ ...f.store(f.consumer, 'project'), values: { selected: 'other' } });
    const file = resolvePluginConfigStorePath(f.store(f.provider));
    const before = await fs.readFile(file);
    await expect(f.save(f.provider, { registry: [{ key: 'other', label: 'Other' }] })).rejects.toThrow(/provider.*key "remote".*consumer\/selected.*user.*provider\/registry/u);
    await expect(f.save(f.provider, { registry: [{ key: 'remote', label: 'Remote' }] })).rejects.toThrow(/consumer.*project/u);
    expect(await fs.readFile(file)).toEqual(before);
    await f.save(f.provider, { registry: [{ key: 'remote', label: 'Changed backend' }, { key: 'other', label: 'Other' }, { key: 'new', label: 'New' }] });
    await writePluginConfigStore({ ...f.store(f.consumer), values: { selected: 'native', unrelated: 'invalid' } });
    await writePluginConfigStore({ ...f.store(f.consumer, 'project'), values: { selected: 'native' } });
    await expect(f.save(f.provider, { registry: [] })).resolves.toMatchObject({ configWrite: 'succeeded', apply: { reason: 'notRequested' } });
  });

  // Test Value Gate: adding a reserved source key must not invalidate an existing included selection.
  it('rejects a new source collision while allowing changes beside existing unrelated errors', async () => {
    const f = await fixture();
    await f.save(f.provider, { registry: [{ key: 'remote', label: 'Remote' }] });
    await writePluginConfigStore({ ...f.store(f.consumer), values: { selected: 'native', unrelated: 'invalid' } });
    const file = resolvePluginConfigStorePath(f.store(f.provider));
    const before = await fs.readFile(file);
    await expect(f.save(f.provider, { registry: [{ key: 'remote', label: 'Remote' }, { key: 'native', label: 'Collision' }] }))
      .rejects.toThrow(/provider\/registry.*key "native".*consumer\/selected.*user/u);
    expect(await fs.readFile(file)).toEqual(before);
    await expect(f.save(f.provider, { registry: [{ key: 'remote', label: 'Updated' }, { key: 'new', label: 'New' }] }))
      .resolves.toMatchObject({ configWrite: 'succeeded' });
    await writePluginConfigStore({ ...f.store(f.consumer), values: { selected: 'already-missing', unrelated: 'invalid' } });
    await expect(f.save(f.provider, { registry: [{ key: 'native', label: 'Already invalid consumer' }, { key: 'remote', label: 'Remote' }] }))
      .resolves.toMatchObject({ configWrite: 'succeeded' });
  });

  // Test Value Gate: optional project impact evidence must not prevent a valid user repair.
  it('keeps unreadable project evidence unknown while saving a valid user edit and protecting deletion', async () => {
    const f = await fixture();
    await f.save(f.provider, { registry: [{ key: 'remote', label: 'Remote' }] });
    await writePluginConfigStore({ ...f.store(f.consumer), values: { selected: 'remote' } });
    const projectPath = resolvePluginConfigStorePath(f.store(f.provider, 'project'));
    await fs.outputFile(projectPath, '{broken');
    const before = await fs.readFile(projectPath);
    const saved = await f.save(f.consumer, { unrelated: 2 });
    expect(saved).toMatchObject({ configWrite: 'succeeded', apply: { reason: 'notRequested' } });
    expect(saved.warnings.join(' ')).toMatch(/project.*(?:unavailable|cannot|unknown)/iu);
    expect((await f.resolve(f.consumer)).values).toEqual({ selected: 'remote', unrelated: 2 });
    expect(await fs.readFile(projectPath)).toEqual(before);
    const evidence = () => analyzePluginConfigMutationImpact({ plugin: f.consumer, scope: 'user', cwd: f.cwd, env: f.env,
      referencePlugins: f.plugins, visibleTargets: [], mutation: { kind: 'patch', updates: { unrelated: 3 } } });
    const initialEvidence = await evidence();
    await fs.writeFile(projectPath, '{changed invalid bytes');
    const changedEvidence = await evidence();
    expect(changedEvidence.impactState).toBe('unknown');
    expect(changedEvidence.storeDigest).not.toBe(initialEvidence.storeDigest);
    await expect(f.save(f.provider, { registry: [] })).rejects.toMatchObject({ code: 'configReferenceInUse' });
    const reset = await resetPluginConfigWithHelper({ plugin: f.provider, pluginName: 'provider', scope: 'user', cwd: f.cwd,
      env: f.env, apply: false, rebuildRuntime: { referencePlugins: f.plugins } });
    expect(reset.deleted).toBe(true);
    expect(reset.warnings.join(' ')).toContain('project');
  });

  // Test Value Gate: unreadable consumers must not turn deletion into a false guarantee or prevent repair/reset.
  it('allows additions with an unreadable consumer, blocks deletion, and reports reset damage', async () => {
    const f = await fixture();
    await f.save(f.provider, { registry: [{ key: 'remote', label: 'Remote' }] });
    const consumerPath = resolvePluginConfigStorePath(f.store(f.consumer));
    await fs.outputFile(consumerPath, '{broken');
    await expect(f.save(f.provider, { registry: [{ key: 'remote', label: 'Remote' }, { key: 'new', label: 'New' }] }))
      .resolves.toMatchObject({ configWrite: 'succeeded' });
    await expect(f.save(f.provider, { registry: [] })).rejects.toThrow(/consumer/u);
    const reset = await resetPluginConfigWithHelper({ plugin: f.provider, pluginName: 'provider', scope: 'user', cwd: f.cwd,
      env: f.env, apply: false, rebuildRuntime: { referencePlugins: f.plugins } });
    expect(reset.deleted).toBe(true);
    expect(reset.warnings.join(' ')).toContain('consumer');
  });

  // Test Value Gate: each provider in a valid multi-hop chain needs its own dependency context
  // before deletion checks can distinguish missing candidates from an unreadable consumer.
  it('keeps deletion protection when the provider registry itself references another dependency', async () => {
    const f = await fixture();
    const base: PluginMeta = { ...f.provider, pluginId: 'team/base', rootDir: path.join(f.cwd, 'base'),
      manifestPath: path.join(f.cwd, 'base/.agents-plugin/plugin.json'),
      manifest: { ...f.provider.manifest, name: 'base', artifacts: undefined,
        config: normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
          registry: { type: 'array', default: [{ key: 'remote' }], validation: { uniqueBy: 'key' }, items: {
            type: 'object', properties: { key: { type: 'string', required: true } }, additionalProperties: false,
          } },
        } }) } };
    f.plugins.push(base);
    f.provider.manifest.dependencies = ['base'];
    f.provider.manifest.config = normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
      registry: { type: 'array', default: [], validation: { uniqueBy: 'key' }, items: {
        type: 'object', properties: { key: { type: 'string', required: true,
          valueRef: { plugin: 'base', field: 'registry', key: 'key' } }, label: { type: 'string', required: true } }, additionalProperties: false,
      } },
    } });
    await f.save(f.provider, { registry: [{ key: 'remote', label: 'Remote' }] });
    await fs.outputFile(resolvePluginConfigStorePath(f.store(f.consumer)), '{broken');
    await expect(f.save(f.provider, { registry: [] })).rejects.toThrow(/consumer/u);
    expect((await f.resolve(f.provider)).values.registry).toEqual([{ key: 'remote', label: 'Remote' }]);
  });

  // Test Value Gate: Review approval must expire after a provider, consumer, or associated definition changes.
  it('binds impact evidence to reverse consumers and dependency stores', async () => {
    const f = await fixture();
    await f.save(f.provider, { registry: [{ key: 'remote', label: 'Remote' }] });
    const analyze = () => analyzePluginConfigMutationImpact({ plugin: f.provider, scope: 'user', cwd: f.cwd, env: f.env,
      referencePlugins: f.plugins, visibleTargets: [], mutation: { kind: 'patch', updates: { registry: [{ key: 'new', label: 'New' }] } } });
    const before = await analyze();
    await writePluginConfigStore({ ...f.store(f.consumer), values: { selected: 'remote' } });
    const after = await analyze();
    expect(after.storeDigest).not.toBe(before.storeDigest);
    expect(after.referenceBlockers).not.toEqual([]);
  });

  // Test Value Gate: provider failure must preserve committed config and must not report its consumer as applied.
  it('keeps committed config and skips a dependent target when provider apply fails', async () => {
    const f = await fixture();
    await writePluginConfigStore({ ...f.store(f.consumer), values: { selected: 'remote' } });
    const targets: ReceiptTargetIdentity[] = ['provider', 'consumer'].map((pluginName) => ({ pluginName, platform: 'codex', scope: 'user' }));
    const apply = vi.fn(async (names, options, runtime): Promise<RebuildCommandResult> => {
      const target = { pluginName: names[0]!.split('/').at(-1)!, platform: options.platform, scope: options.scope } as ReceiptTargetIdentity;
      const preview = runtime.resolvePreApplyAuthorization === true;
      return { platforms: ['codex'], plugins: [], warnings: [], rebuildResults: [], receiptTargets: [target],
        overallState: preview ? 'succeeded' : 'failed',
        targetResults: preview ? [] : [{ target, action: 'reinstall', state: 'failed', message: 'provider failed' }],
        ...(preview ? { preApplyAuthorization: [] } : {}) };
    });
    const receipt = await f.save(f.provider, { registry: [{ key: 'remote', label: 'Remote' }] }, {
      apply: true, applyTargets: targets, sharedNativeApplyConfirmed: true, preApplyConfirmed: true,
      reinstallCommandImpl: apply,
    });
    expect(receipt.configWrite).toBe('succeeded');
    expect(receipt.apply).toMatchObject({ state: 'partial', targetResults: [
      { target: { pluginName: 'provider' }, state: 'failed' },
      { target: { pluginName: 'consumer' }, state: 'skipped', errorCode: 'dependencyApplyFailed' },
    ] });
    expect((await f.resolve(f.provider)).values.registry).toEqual([{ key: 'remote', label: 'Remote' }]);
  });
});
