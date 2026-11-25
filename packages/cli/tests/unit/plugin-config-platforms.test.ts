import path from 'node:path';
import { execFileSync } from 'node:child_process';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { normalizePluginConfigDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import type { PluginMeta } from '../../src/types.js';
import {
  createPluginConfigSchemaIdentity,
  deletePluginConfigStore,
  patchPluginConfigStore,
  readPluginConfigStore,
  resetPluginConfigStore,
  resolveEffectivePluginConfig,
  resolveConfigRead,
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { applyPluginConfigWrite, resetPluginConfigWithHelper } from '../../src/utils/plugin-config-write.js';
import { collectPluginConfigReferenceEvidence } from '../../src/utils/plugin-config-references.js';
import { analyzePluginConfigMutationImpact } from '../../src/utils/plugin-config-impact.js';
import { inventoryCatalogSourceReferences } from '../../src/utils/catalog-source-references.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';

function fixture(config: unknown, name = 'demo', dependencies: string[] = []) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const plugin: PluginMeta = {
    rootDir: path.join(cwd, name),
    manifestPath: path.join(cwd, name, '.agents-plugin/plugin.json'),
    sourceId: 'team',
    sourceIdentity: `sha256:${'a'.repeat(64)}`,
    catalogLogicalIdentity: 'team/catalog',
    pluginId: `team/${name}`,
    manifest: {
      schemaVersion: 4, name, version: '1.0.0', description: 'Platform config fixture', dependencies,
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      config: normalizePluginConfigDefinition(config),
    },
  };
  const store = { pluginName: name, sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
    scope: 'user' as const, cwd, env: isolation.env };
  const resolve = (platform?: 'codex' | 'claude' | 'generic') => resolveEffectivePluginConfig({ ...store,
    manifest: plugin.manifest, targetScope: 'project', platform });
  return { plugin, store, resolve, cwd, env: isolation.env };
}

describe('user common and platform configuration', () => {
  // Test Value Gate: one atomic identity-bound document must preserve unrelated platform values.
  it('saves common and each platform in the same user document from either context', async () => {
    const f = fixture({ schemaVersion: 5, fields: { enabled: { type: 'boolean', default: true } } });
    await writePluginConfigStore({ ...f.store, values: { enabled: true } });
    await patchPluginConfigStore({ ...f.store, scope: 'project', platform: 'codex', updates: { enabled: false } });
    await patchPluginConfigStore({ ...f.store, platform: 'claude', updates: { enabled: true } });
    const file = resolvePluginConfigStorePath(f.store);
    expect(resolvePluginConfigStorePath({ ...f.store, scope: 'project' })).toBe(file);
    expect(await fs.readJson(file)).toEqual({ schemaVersion: 6, sourceId: 'team', pluginName: 'demo',
      binding: { kind: 'source', sourceIdentity: f.store.sourceIdentity }, common: { enabled: true },
      platforms: { claude: { enabled: true }, codex: { enabled: false } } });
    await resetPluginConfigStore({ ...f.store, platform: 'codex' });
    expect((await f.resolve('codex')).values.enabled).toBe(true);
    expect((await readPluginConfigStore({ ...f.store, platform: 'claude' })).values).toEqual({ enabled: true });
    await resetPluginConfigStore(f.store);
    expect((await fs.readJson(file)).common).toEqual({});
    expect((await f.resolve('claude')).sources.enabled).toBe('platform');
  });

  // Test Value Gate: explicit whole-plugin deletion must remove every profile in one document operation.
  it('deletes the complete plugin document while preserving other plugins and historical project files', async () => {
    const f = fixture({ schemaVersion: 5, fields: { enabled: { type: 'boolean', default: true } } });
    await writePluginConfigStore({ ...f.store, values: { enabled: true } });
    await patchPluginConfigStore({ ...f.store, platform: 'codex', updates: { enabled: false } });
    await patchPluginConfigStore({ ...f.store, platform: 'claude', updates: { enabled: true } });
    const other = { ...f.store, pluginName: 'other' };
    await writePluginConfigStore({ ...other, values: { enabled: false } });
    const historical = path.join(f.cwd, '.agent-workflows/plugin-config/team/demo/config.json');
    await fs.outputFile(historical, 'historical project config');
    const otherBefore = await fs.readFile(resolvePluginConfigStorePath(other));

    await expect(deletePluginConfigStore({ ...f.store, scope: 'project' })).resolves.toMatchObject({
      scope: 'user', existed: true, deleted: true, resetDisposition: 'deletedFile',
    });
    expect(await fs.pathExists(resolvePluginConfigStorePath(f.store))).toBe(false);
    expect(await fs.readFile(resolvePluginConfigStorePath(other))).toEqual(otherBefore);
    expect(await fs.readFile(historical, 'utf8')).toBe('historical project config');
    await expect(deletePluginConfigStore(f.store)).resolves.toMatchObject({ existed: false, deleted: false });
  });

  // Test Value Gate: explicit project context must fail before a save when no canonical project exists.
  it('validates project context and keeps pure user reads independent from the calling directory', async () => {
    const f = fixture({ schemaVersion: 5, fields: { enabled: { type: 'boolean', default: true } } });
    const read = { pluginName: 'demo', plugin: f.plugin, scope: 'user' as const, platform: 'codex' as const,
      cwd: f.cwd, env: f.env };
    await expect(resolveConfigRead({ ...read, context: 'project' })).rejects.toThrow('projectRootUnavailable');
    await expect(applyPluginConfigWrite({ plugin: f.plugin, scope: 'user', context: 'project', platform: 'codex',
      cwd: f.cwd, env: f.env, request: { updates: { enabled: false } } })).rejects.toThrow('projectRootUnavailable');
    expect(await fs.pathExists(resolvePluginConfigStorePath(f.store))).toBe(false);
    expect((await resolveEffectivePluginConfig({ ...f.store, manifest: f.plugin.manifest, context: 'user' })).projectRoot).toBe('');
    execFileSync('git', ['init', '-q'], { cwd: f.cwd });
    await setTargets(f.store, ['codex']);
    const saved = await applyPluginConfigWrite({ plugin: f.plugin, scope: 'user', context: 'project', platform: 'codex',
      cwd: f.cwd, env: f.env, request: { updates: { enabled: false } } });
    expect(saved).toMatchObject({ scope: 'user', context: 'project', configWrite: 'succeeded' });
    expect((await resolveEffectivePluginConfig({ ...f.store, manifest: f.plugin.manifest, context: 'project', platform: 'codex' })).projectRoot)
      .toBe(await fs.realpath(f.cwd));
    expect(await fs.pathExists(path.join(f.cwd, '.agent-workflows/plugin-config'))).toBe(false);
  });

  // Test Value Gate: explicit falsy values and whole-array replacement cannot be lost during layer merge.
  it('preserves false, zero and empty arrays and replaces an array as one field', async () => {
    const f = fixture({ schemaVersion: 5, fields: {
      enabled: { type: 'boolean', default: true }, count: { type: 'number', default: 2 },
      rows: { type: 'array', items: { type: 'string' }, default: ['default'] },
    } });
    await writePluginConfigStore({ ...f.store, values: { enabled: true, count: 4, rows: ['a', 'b'] } });
    await writePluginConfigStore({ ...f.store, platform: 'codex', values: { enabled: false, count: 0, rows: [] } });
    expect((await f.resolve('codex')).values).toEqual({ enabled: false, count: 0, rows: [] });
    await patchPluginConfigStore({ ...f.store, platform: 'codex', updates: { rows: ['c'] } });
    expect((await f.resolve('codex')).values.rows).toEqual(['c']);
    expect((await f.resolve('generic')).values.rows).toEqual(['a', 'b']);
  });

  // Test Value Gate: a final common value invalid in a platform must block use, while an explicit valid override repairs it.
  it('validates only the final platform value and never inherits a replaced field default', async () => {
    const f = fixture({ schemaVersion: 5, fields: { mode: { type: 'number', default: 1 } },
      platforms: { codex: { fields: { mode: { type: 'string', choices: { allowCustom: false, presets: [{ id: 'native', title: 'Native', value: 'native' }] } } } } } });
    expect((await f.resolve('codex')).sources.mode).toBe('missing');
    await writePluginConfigStore({ ...f.store, values: { mode: 2 } });
    const invalid = await f.resolve('codex');
    expect(invalid.values).not.toHaveProperty('mode');
    expect(invalid.issues).toEqual([expect.objectContaining({ key: 'mode', source: 'common' })]);
    await writePluginConfigStore({ ...f.store, platform: 'codex', values: { mode: 'native' } });
    expect((await f.resolve('codex')).issues).toEqual([]);
    const read = await resolveConfigRead({ pluginName: 'demo', plugin: f.plugin, scope: 'user', context: 'user',
      platform: 'codex', cwd: f.cwd, env: f.env });
    expect(read.fields.find((entry) => entry.key === 'mode')?.fallback).toMatchObject({ state: 'invalid', sourceLayer: 'common' });
    await patchPluginConfigStore({ ...f.store, platform: 'codex', updates: {}, removeKeys: ['mode'] });
    expect((await f.resolve('codex')).issues[0]?.source).toBe('common');
  });

  // Test Value Gate: ordinary unset must preserve a valid required field; explicit reset remains a recovery action.
  it('allows incremental repair, rejects a new missing requirement, and permits explicit reset', async () => {
    const f = fixture({ schemaVersion: 5, fields: {
      first: { type: 'string', required: true }, second: { type: 'string', required: true },
    } });
    const write = { plugin: f.plugin, scope: 'user' as const, context: 'user' as const, cwd: f.cwd, env: f.env };
    const saved = await applyPluginConfigWrite({ ...write, request: { updates: { first: 'ready' } } });
    expect(saved.effective?.issues).toEqual([expect.objectContaining({ key: 'second', type: 'missing-required' })]);
    const file = resolvePluginConfigStorePath(f.store);
    const before = await fs.readFile(file, 'utf8');
    await expect(applyPluginConfigWrite({ ...write, request: { removeKeys: ['first'] } }))
      .rejects.toThrow('configReferenceInvalid');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    const reset = await resetPluginConfigWithHelper({ ...write, pluginName: f.plugin.manifest.name });
    expect(reset).toMatchObject({ configWrite: 'succeeded', resetDisposition: 'deletedFile' });
    expect(reset.effective?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'first', type: 'missing-required' }),
      expect.objectContaining({ key: 'second', type: 'missing-required' }),
    ]));
    expect(await fs.pathExists(file)).toBe(false);
  });

  // Test Value Gate: unset cannot expose an inherited common value that is invalid in the selected platform schema.
  it('rejects removing the valid platform repair while reset clears only that platform', async () => {
    const f = fixture({ schemaVersion: 5, fields: { mode: { type: 'number' } },
      platforms: { codex: { fields: { mode: { type: 'string' } } } } });
    await setTargets(f.store, ['codex']);
    await writePluginConfigStore({ ...f.store, values: { mode: 2 } });
    await writePluginConfigStore({ ...f.store, platform: 'codex', values: { mode: 'native' } });
    const write = { plugin: f.plugin, pluginName: f.plugin.manifest.name, scope: 'user' as const,
      platform: 'codex' as const, cwd: f.cwd, env: f.env };
    const file = resolvePluginConfigStorePath(f.store);
    const before = await fs.readFile(file, 'utf8');
    await expect(applyPluginConfigWrite({ ...write, request: { removeKeys: ['mode'] } }))
      .rejects.toThrow('configReferenceInvalid');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    const reset = await resetPluginConfigWithHelper(write);
    expect(reset).toMatchObject({ configWrite: 'succeeded', resetDisposition: 'clearedLayer' });
    expect(reset.effective?.issues).toEqual([expect.objectContaining({ key: 'mode', source: 'common' })]);
    expect((await readPluginConfigStore(f.store)).values).toEqual({ mode: 2 });
  });

  // Test Value Gate: historical common keys must never satisfy platform-specific required values.
  it('redacts stale common keys and resolves platform-only and branch-only fields independently', async () => {
    const f = fixture({ schemaVersion: 5, fields: { shared: { type: 'string' },
      profile: { type: 'string', platformOnly: true, required: true } },
    platforms: { codex: { fields: { branch: { type: 'string', required: true } } } } });
    await writePluginConfigStore({ ...f.store, values: { shared: 'keep', profile: 'stale', branch: 'stale' } });
    expect(await f.resolve('codex')).toMatchObject({ values: { shared: 'keep' },
      sources: { shared: 'common', profile: 'missing', branch: 'missing' },
      issues: expect.arrayContaining([{ key: 'profile', type: 'missing-required', source: 'missing',
        message: expect.any(String) }, { key: 'branch', type: 'missing-required', source: 'missing', message: expect.any(String) }]) });
    const common = await resolveConfigRead({ plugin: f.plugin, ...f.store });
    expect(common.fields).toEqual(expect.arrayContaining(['profile', 'branch'].map((key) =>
      expect.objectContaining({ key, effectiveValue: '[redacted]', canSet: false, canUnset: true }))));
    const written = await applyPluginConfigWrite({ plugin: f.plugin, ...f.store, request: { removeKeys: ['profile', 'branch'] } });
    expect(written.staleRemovedKeys).toEqual(['profile', 'branch']);
    expect((await readPluginConfigStore(f.store)).values).toEqual({ shared: 'keep' });
  });

  // A platform branch can make a formerly common field platform-only without blocking legitimate common edits.
  it('does not treat an unchanged platform-only issue as an error in the edited common layer', async () => {
    const f = fixture({ schemaVersion: 5, fields: { model: { type: 'string' } },
      platforms: { codex: { fields: { model: { type: 'string', required: true, platformOnly: true } } } } });
    await setTargets(f.store, ['codex']);
    await expect(applyPluginConfigWrite({ ...f.store, plugin: f.plugin, request: { updates: { model: 'common-model' } } }))
      .resolves.toMatchObject({ configWrite: 'succeeded' });
    expect(await f.resolve('codex')).toMatchObject({ sources: { model: 'missing' },
      issues: [expect.objectContaining({ key: 'model', type: 'missing-required' })] });
    await expect(applyPluginConfigWrite({ ...f.store, plugin: f.plugin, platform: 'codex', request: { updates: { model: 'codex-model' } } }))
      .resolves.toMatchObject({ configWrite: 'succeeded' });
  });

  // Test Value Gate: removing the whole schema must not strand its identity-bound user overrides.
  it('allows explicit historical cleanup even after the plugin drops its config declaration', async () => {
    const f = fixture({ schemaVersion: 5, fields: { oldValue: { type: 'string' } } });
    await writePluginConfigStore({ ...f.store, platform: 'codex', values: { oldValue: 'stale' } });
    delete f.plugin.manifest.config;
    const read = await resolveConfigRead({ ...f.store, plugin: f.plugin, platform: 'codex' });
    expect(read.fields).toEqual([expect.objectContaining({ key: 'oldValue', canSet: false, canUnset: true, effectiveValue: '[redacted]' })]);
    const write = await applyPluginConfigWrite({ ...f.store, plugin: f.plugin, platform: 'codex', request: { removeKeys: ['oldValue'] } });
    expect(write).toMatchObject({ configWrite: 'succeeded', staleRemovedKeys: ['oldValue'] });
    expect((await readPluginConfigStore({ ...f.store, platform: 'codex' })).values).toEqual({});
  });

  // Test Value Gate: explicit project context is a source/preview boundary, never a second value store.
  it('ignores an old project value document and rejects old user formats until reset', async () => {
    const f = fixture({ schemaVersion: 5, fields: { enabled: { type: 'boolean', default: true } } });
    await fs.outputFile(path.join(f.cwd, '.agent-workflows/plugin-config/team/demo/config.json'), '{broken');
    expect((await f.resolve('codex')).values.enabled).toBe(true);
    const file = resolvePluginConfigStorePath(f.store);
    const old = { schemaVersion: 5, sourceId: 'team', pluginName: 'demo',
      binding: { kind: 'source', sourceIdentity: f.store.sourceIdentity }, values: { enabled: false } };
    await fs.outputJson(file, old);
    expect((await readPluginConfigStore(f.store)).invalidCode).toBe('schemaVersionUnsupported');
    await expect(patchPluginConfigStore({ ...f.store, updates: { enabled: true } })).rejects.toThrow('schemaVersionUnsupported');
    expect(await fs.readJson(file)).toEqual(old);
    await resetPluginConfigStore(f.store);
    expect((await f.resolve('codex')).values.enabled).toBe(true);
  });

  // Test Value Gate: source safety inventory must accept the current identity-bound user document and ignore historical project values.
  it('inventories schema 6 user configuration and rejects a mismatched source identity envelope', async () => {
    const f = fixture({ schemaVersion: 5, fields: { enabled: { type: 'boolean' } } });
    await writePluginConfigStore({ ...f.store, platform: 'generic', values: { enabled: true } });
    const oldProjectFile = path.join(f.cwd, '.agent-workflows/plugin-config/team/demo/config.json');
    await fs.outputFile(oldProjectFile, '{broken old project values');
    const inventory = await inventoryCatalogSourceReferences({ cwd: f.cwd, env: f.env, scope: 'project' });
    expect(inventory.errors).toEqual([]);
    expect(inventory.references.filter((entry) => entry.kind === 'namespacedConfig'))
      .toEqual([expect.objectContaining({ sourceId: 'team', pluginName: 'demo', scope: 'user' })]);
    expect(await fs.readFile(oldProjectFile, 'utf8')).toBe('{broken old project values');
    const file = resolvePluginConfigStorePath(f.store);
    await fs.outputJson(file, { ...await fs.readJson(file), sourceId: 'other' });
    const invalid = await inventoryCatalogSourceReferences({ cwd: f.cwd, env: f.env, scope: 'user' });
    expect(invalid.errors.some((error) => error.kind === 'configFileValidation')).toBe(true);
    expect(invalid.references.filter((entry) => entry.kind === 'namespacedConfig')).toEqual([]);
  });
});

async function referenceFixture() {
  const registry = { type: 'array', default: [], validation: { uniqueBy: 'id' }, items: { type: 'object',
    properties: { id: { type: 'string', required: true } }, additionalProperties: false } };
  const provider = fixture({ schemaVersion: 5, fields: { registry } }, 'provider');
  const consumer = fixture({ schemaVersion: 5, fields: { selected: { type: 'string',
    valueRef: { plugin: 'provider', field: 'registry', key: 'id' } } } }, 'consumer', ['provider']);
  const plugins = [provider.plugin, consumer.plugin];
  await setTargets(provider.store, ['codex', 'claude']);
  for (const f of [provider, consumer]) await fs.outputJson(f.plugin.manifestPath, f.plugin.manifest);
  await writePluginConfigStore({ ...provider.store, values: { registry: [{ id: 'shared' }] } });
  await writePluginConfigStore({ ...provider.store, platform: 'codex', values: { registry: [{ id: 'codex' }] } });
  await writePluginConfigStore({ ...consumer.store, values: { selected: 'shared' } });
  await writePluginConfigStore({ ...consumer.store, platform: 'codex', values: { selected: 'codex' } });
  const resolve = (platform?: 'codex' | 'claude') => resolveEffectivePluginConfig({ ...consumer.store,
    manifest: consumer.plugin.manifest, platform, referencePlugins: plugins });
  return { provider, consumer, plugins, resolve };
}

describe('configuration references by platform', () => {
  // Test Value Gate: a same-named ID in another profile cannot repair a dangling reference.
  it('resolves provider values from exactly the consumer profile', async () => {
    const f = await referenceFixture();
    expect((await f.resolve('codex')).values.selected).toBe('codex');
    expect((await f.resolve('claude')).values.selected).toBe('shared');
    await writePluginConfigStore({ ...f.consumer.store, platform: 'codex', values: { selected: 'shared' } });
    expect((await f.resolve('codex')).issues.some((issue) => issue.code?.startsWith('valueRef'))).toBe(true);
    expect((await f.resolve('claude')).issues).toEqual([]);
  });

  // Test Value Gate: ordinary saves protect a valid reference even when the consumer has no installed output.
  it('blocks removing a selected provider ID only in its platform and preserves the document', async () => {
    const f = await referenceFixture();
    const file = resolvePluginConfigStorePath(f.provider.store);
    const before = await fs.readFile(file, 'utf8');
    await expect(applyPluginConfigWrite({ plugin: f.provider.plugin, scope: 'user', platform: 'codex',
      cwd: f.provider.cwd, env: f.provider.env, request: { updates: { registry: [] } },
      rebuildRuntime: { referencePlugins: f.plugins } })).rejects.toThrow('configReferenceInUse');
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    const impact = await analyzePluginConfigMutationImpact({ plugin: f.provider.plugin, scope: 'user', platform: 'claude',
      cwd: f.provider.cwd, env: f.provider.env, visibleTargets: [], referencePlugins: f.plugins,
      commandDiscovery: { packages: [], errors: [] }, mutation: { kind: 'patch', updates: { registry: [{ id: 'shared' }, { id: 'new' }] } } });
    expect(impact.referenceBlockers).toEqual([]);
  });

  // Test Value Gate: a stopped platform's saved reference must not lock its provider registry.
  it('preserves historical references but checks them again after enabling their target', async () => {
    const f = await referenceFixture();
    await writePluginConfigStore({ ...f.consumer.store, values: {} });
    await writePluginConfigStore({ ...f.consumer.store, platform: 'claude', values: { selected: 'shared' } });
    const write = { plugin: f.provider.plugin, ...f.provider.store, request: { updates: { registry: [] } },
      rebuildRuntime: { referencePlugins: f.plugins } };
    await setTargets(f.provider.store, ['codex']);
    await expect(applyPluginConfigWrite(write)).resolves.toMatchObject({ configWrite: 'succeeded' });
    expect((await readPluginConfigStore({ ...f.consumer.store, platform: 'claude' })).values).toEqual({ selected: 'shared' });
    expect((await f.resolve('claude')).issues).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'selected', code: expect.stringMatching(/^valueRef/u) })]));
    await writePluginConfigStore({ ...f.provider.store, values: { registry: [{ id: 'shared' }] } });
    await setTargets(f.provider.store, ['codex', 'claude']);
    await expect(applyPluginConfigWrite(write)).rejects.toMatchObject({ code: 'configReferenceInUse' });
  });

  // Test Value Gate: a discarded common registry is not a real source of platform reference candidates.
  it('does not infer that clearing a stale common registry removes platform candidates', async () => {
    const registry = { type: 'array', platformOnly: true, default: [], validation: { uniqueBy: 'id' },
      items: { type: 'object', properties: { id: { type: 'string', required: true } }, additionalProperties: false } };
    const provider = fixture({ schemaVersion: 5, fields: { shared: { type: 'string' }, registry } }, 'provider');
    const consumer = fixture({ schemaVersion: 5, fields: { selected: { type: 'string', platformOnly: true,
      valueRef: { plugin: 'provider', field: 'registry', key: 'id' } } } }, 'consumer', ['provider']);
    await setTargets(provider.store, ['codex']);
    await writePluginConfigStore({ ...provider.store, values: { shared: 'keep', registry: [{ id: 'stale' }] } });
    await fs.outputFile(resolvePluginConfigStorePath(consumer.store), '{broken');
    const receipt = await applyPluginConfigWrite({ ...provider.store, plugin: provider.plugin,
      request: { removeKeys: ['registry'] }, rebuildRuntime: { referencePlugins: [provider.plugin, consumer.plugin] } });
    expect(receipt).toMatchObject({ configWrite: 'succeeded', staleRemovedKeys: ['registry'] });
    expect((await readPluginConfigStore(provider.store)).values).toEqual({ shared: 'keep' });
  });

  // Test Value Gate: stale review detection must bind actual schema/profile identity and all bytes read from provider stores.
  it('binds evidence and schema identity to common and each selected profile', async () => {
    const f = await referenceFixture();
    const evidence = await collectPluginConfigReferenceEvidence({ plugin: f.consumer.plugin, plugins: f.plugins,
      profiles: [{ pluginName: 'consumer', scope: 'user' }, { pluginName: 'consumer', scope: 'user', platform: 'codex' }],
      cwd: f.consumer.cwd, env: f.consumer.env });
    expect(evidence.filter((entry) => entry.plugin === 'provider').map((entry) => entry.platform).sort()).toEqual(['codex', null]);
    expect(evidence.every((entry) => entry.stores.user?.rawDigest?.startsWith('sha256:'))).toBe(true);
    expect(createPluginConfigSchemaIdentity(f.consumer.plugin.manifest)).not.toBe(createPluginConfigSchemaIdentity(f.consumer.plugin.manifest, 'codex'));
  });

  // Test Value Gate: using a complete source set must not permit a requested owner that is actually missing.
  it('rejects reference evidence for an owner outside the selected source', async () => {
    const f = await referenceFixture();
    await expect(collectPluginConfigReferenceEvidence({ plugin: f.consumer.plugin, plugins: f.plugins,
      profiles: [{ pluginName: 'missing', scope: 'user', platform: 'codex' }],
      cwd: f.consumer.cwd, env: f.consumer.env })).rejects.toThrow('configuration owner missing is no longer in the selected source');
  });
});
