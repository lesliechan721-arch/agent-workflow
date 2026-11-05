import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { normalizePluginConfigDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import { buildConfigGroups } from '../../src/tui/model.js';
import type { NormalizedPluginManifest, PluginMeta } from '../../src/types.js';
import {
  createPluginConfigSchemaIdentity,
  patchPluginConfigStore,
  listNamespacedPluginConfigStores,
  readNamespacedPluginConfigStoreIdentity,
  readPluginConfigStore,
  resetPluginConfigStore,
  resolveConfigRead,
  resolveEffectivePluginConfig,
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const sourceIdentity = `sha256:${'7'.repeat(64)}`;
const logicalIdentity = 'catalog.example/config-tests';
const config = normalizePluginConfigDefinition({ fields: {
  connection: { type: 'object', properties: { 'display-name': { type: 'string' }, region: { type: 'string' },
    token: { type: 'string' } }, additionalProperties: false },
  labels: { type: 'object', additionalProperties: { type: 'string' }, validation: { key: { format: 'identifier' } } },
} });
const manifest = { name: 'object-config', version: '1.0.0', config } as unknown as NormalizedPluginManifest;

function fixture() {
  const isolation = getCurrentSourceTestIsolation();
  const store = { sourceId: 'official', sourceIdentity, logicalIdentity, pluginName: manifest.name,
    scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
  const plugin = (currentManifest = manifest): PluginMeta => ({ sourceId: store.sourceId, sourceIdentity,
    catalogLogicalIdentity: logicalIdentity, rootDir: store.cwd,
    manifestPath: path.join(store.cwd, '.agents-plugin/plugin.json'), manifest: currentManifest });
  const resolve = (platform?: 'codex', currentManifest = manifest) => resolveEffectivePluginConfig({ ...store,
    manifest: currentManifest, platform, targetScope: 'project' });
  const read = (platform?: 'codex', currentManifest = manifest) => resolveConfigRead({ ...store,
    plugin: plugin(currentManifest), platform, context: 'user' });
  return { store, plugin, resolve, read };
}

describe('plugin config Store v6 structured values', () => {
  // Test Value Gate: compiled presentation metadata must remain usable without changing the saved document.
  it('reads structured values through compiled definitions and binds presentation to schema evidence', async () => {
    const f = fixture();
    const values = { connection: { 'display-name': 'local', region: 'west' } };
    await writePluginConfigStore({ ...f.store, values });
    const file = resolvePluginConfigStorePath(f.store);
    const before = await fs.readFile(file);
    const v3Config = normalizePluginConfigDefinition({ schemaVersion: 3,
      definitions: { connection: config.fields.connection }, fields: { connection: { $ref: '#/config/definitions/connection' } },
      presentation: { summaries: { compact: { kind: 'join', parts: [{ path: '/display-name' }, { path: '/region' }], separator: '/', missing: 'unset' } },
        fieldViews: { connection: { summary: 'compact' } } },
    });
    const current = { ...manifest, config: v3Config };
    const read = await f.read(undefined, current);
    const field = buildConfigGroups({ schema: v3Config, read, effectiveRawValues: values })[0]!.fields[0]!;
    expect(field.displayValue).toBe('local/west');
    expect(field.summary).toEqual(v3Config.presentation!.summaries!.compact);
    expect((await f.resolve(undefined, current)).values).toEqual(values);
    expect(await fs.readFile(file)).toEqual(before);
    expect(JSON.parse(before.toString()).schemaVersion).toBe(6);
    expect(createPluginConfigSchemaIdentity(current)).not.toBe(createPluginConfigSchemaIdentity(manifest));
    const changed = structuredClone(current);
    changed.config.presentation!.summaries!.compact!.separator = ' | ';
    expect(createPluginConfigSchemaIdentity(changed)).not.toBe(createPluginConfigSchemaIdentity(current));
  });

  // Test Value Gate: project source context must not weaken the source identity binding of user values.
  it('binds both common and platform values to the same source identity in either context', async () => {
    const f = fixture();
    await writePluginConfigStore({ ...f.store, values: { labels: { transport: 'https' } } });
    await writePluginConfigStore({ ...f.store, scope: 'project', platform: 'codex', values: { labels: { native: 'codex' } } });
    for (const scope of ['user', 'project'] as const) {
      await expect(readPluginConfigStore({ ...f.store, scope, sourceIdentity: `sha256:${'8'.repeat(64)}` }))
        .resolves.toMatchObject({ state: 'invalid', invalidCode: 'identityMismatch' });
      await expect(readPluginConfigStore({ ...f.store, scope, logicalIdentity: 'catalog.example/other', platform: 'codex' }))
        .resolves.toMatchObject({ state: 'ready', values: { labels: { native: 'codex' } } });
    }
    await expect(writePluginConfigStore({ ...f.store, sourceIdentity: undefined, pluginName: 'missing-identity',
      scope: 'project', values: { labels: {} } })).rejects.toThrow('sourceChanged');
  });

  // Test Value Gate: incompatible stores remain untouched until the explicit schema-independent recovery action.
  it.each([3, 5])('rejects Store v%s without migration and resets it without Catalog evidence', async (schemaVersion) => {
    const f = fixture();
    const file = resolvePluginConfigStorePath(f.store);
    const old = { schemaVersion, sourceId: f.store.sourceId, sourceIdentity, pluginName: manifest.name, values: { labels: { old: 'value' } } };
    await fs.outputJson(file, old);
    const before = await fs.readFile(file);
    expect((await readPluginConfigStore(f.store)).invalidCode).toBe('schemaVersionUnsupported');
    expect(await fs.readFile(file)).toEqual(before);
    await expect(resetPluginConfigStore({ ...f.store, sourceIdentity: undefined })).resolves.toMatchObject({
      deleted: true, resetDisposition: 'deletedFile',
    });
  });

  // Test Value Gate: an envelope cannot inject state projection or an obsolete identity field into the reader.
  it('rejects extra envelope fields in runtime and inventory readers', async () => {
    const f = fixture();
    await writePluginConfigStore({ ...f.store, values: { labels: { mode: 'strict' } } });
    const file = resolvePluginConfigStorePath(f.store);
    const envelope = await fs.readJson(file);
    await fs.writeJson(file, { ...envelope, sourceIdentity });
    expect((await readPluginConfigStore(f.store)).invalidCode).toBe('schemaVersionUnsupported');
    await expect(readNamespacedPluginConfigStoreIdentity(f.store)).rejects.toThrow('schemaVersionUnsupported');
    await expect(listNamespacedPluginConfigStores(f.store)).rejects.toThrow('schemaVersionUnsupported');
  });

  // Test Value Gate: Native outputs use user platform values independently of project Git visibility.
  it('writes Native platform configuration from project context without a project value file', async () => {
    const f = fixture();
    const current = { ...manifest, config: normalizePluginConfigDefinition({ fields: { mode: { type: 'string', default: 'default' } } }),
      artifacts: { targets: [{ id: 'native-skill', platform: 'codex', target: 'codex.skill', scopes: ['user'],
        states: ['present'], refreshKeys: ['mode'], skillKey: 'native-skill' }] } } as NormalizedPluginManifest;
    await writePluginConfigStore({ ...f.store, values: { mode: 'common' } });
    const receipt = await writePluginConfigStore({ ...f.store, scope: 'project', platform: 'codex',
      env: { ...f.store.env, PATH: path.join(f.store.cwd, 'missing-bin') }, values: { mode: 'native' } });
    expect(receipt).toMatchObject({ scope: 'user', warnings: [] });
    expect((await f.resolve('codex', current)).values.mode).toBe('native');
    expect((await f.resolve('codex', current)).unsupportedLayerOverrides).toEqual([]);
    expect((await f.read('codex', current)).fields[0]).toMatchObject({ canSet: true, canUnset: true,
      sourceLayer: 'platform', storedSourceLayer: 'platform', effectiveValue: 'native' });
    expect(await fs.pathExists(path.join(f.store.cwd, '.agent-workflows/plugin-config'))).toBe(false);
  });

  // Test Value Gate: object overrides replace one top-level value and unset restores the full inherited object.
  it('replaces an object as one field and preserves common values when its platform override is removed', async () => {
    const f = fixture();
    await writePluginConfigStore({ ...f.store, values: { connection: { region: 'common', token: 'secret' } } });
    await writePluginConfigStore({ ...f.store, platform: 'codex', values: { connection: { region: 'native' }, unknownFutureKey: true } });
    const native = await f.resolve('codex');
    expect(native.values.connection).toEqual({ region: 'native' });
    expect(native.ignoredUnknownKeys).toContainEqual({ scope: 'user', source: 'platform', key: 'unknownFutureKey' });
    expect((await f.resolve()).values.connection).toEqual({ region: 'common', token: 'secret' });
    await patchPluginConfigStore({ ...f.store, platform: 'codex', updates: {}, removeKeys: ['connection', 'unknownFutureKey'] });
    expect((await f.resolve('codex')).values.connection).toEqual({ region: 'common', token: 'secret' });
    expect(await fs.pathExists(resolvePluginConfigStorePath(f.store))).toBe(true);
  });

  // Test Value Gate: stored values must not gain an implicit conversion after a schema type change.
  it('keeps strings invalid after number and boolean schema changes until typed values replace them', async () => {
    const f = fixture();
    const current = { ...manifest, config: normalizePluginConfigDefinition({ fields: {
      count: { type: 'number' }, enabled: { type: 'boolean' },
    } }) };
    await writePluginConfigStore({ ...f.store, values: { count: '42', enabled: 'false' } });
    await writePluginConfigStore({ ...f.store, platform: 'codex', values: { count: '7', enabled: 'true' } });
    const before = await fs.readFile(resolvePluginConfigStorePath(f.store));
    for (const platform of [undefined, 'codex'] as const) {
      expect((await f.resolve(platform, current)).values).toEqual({});
      const read = await f.read(platform, current);
      expect(read.fields.every((field) => field.valueState === 'invalid' && field.effectiveValue === null)).toBe(true);
      if (platform) expect(read.fields[0]?.fallback).toMatchObject({ state: 'invalid', sourceLayer: 'common' });
    }
    expect(await fs.readFile(resolvePluginConfigStorePath(f.store))).toEqual(before);
    await writePluginConfigStore({ ...f.store, platform: 'codex', values: { count: 7, enabled: true } });
    expect((await f.resolve('codex', current)).values).toEqual({ count: 7, enabled: true });
    expect((await f.resolve(undefined, current)).values).toEqual({});
  });

  // Test Value Gate: fixed property names and validated dynamic keys need distinct runtime validation.
  it.each(['bad key', '__proto__'])('keeps invalid dynamic key %s recoverable without changing fixed-object rules', async (key) => {
    const f = fixture();
    await writePluginConfigStore({ ...f.store, values: { connection: { 'display-name': 'fixed' },
      labels: Object.fromEntries([[key, 'dynamic']]) } });
    expect((await readPluginConfigStore(f.store)).state).toBe('ready');
    const effective = await f.resolve();
    expect(effective.values.connection).toEqual({ 'display-name': 'fixed' });
    expect(effective.values).not.toHaveProperty('labels');
    expect(effective.fieldStates.labels?.invalidOverride?.source).toBe('common');
    await patchPluginConfigStore({ ...f.store, updates: {}, removeKeys: ['labels'] });
    expect((await f.resolve()).issues).toEqual([]);
  });

  // Test Value Gate: an invalid platform value must not silently use the valid common fallback at runtime.
  it('retains the lower object only as a diagnostic fallback until the invalid override is removed', async () => {
    const f = fixture();
    await writePluginConfigStore({ ...f.store, values: { connection: { region: 'common', token: 'secret' } } });
    await writePluginConfigStore({ ...f.store, platform: 'codex', values: { connection: { region: 42 } } });
    const invalid = await f.resolve('codex');
    expect(invalid.values).not.toHaveProperty('connection');
    expect(invalid.fieldStates.connection).toMatchObject({ invalidOverride: { source: 'platform' },
      fallback: { source: 'common', value: { region: 'common', token: 'secret' } } });
    await patchPluginConfigStore({ ...f.store, platform: 'codex', updates: {}, removeKeys: ['connection'] });
    expect((await f.resolve('codex')).values.connection).toEqual({ region: 'common', token: 'secret' });
  });

  // Test Value Gate: reads preserve raw review evidence while writes canonicalize the actual document once.
  it('canonicalizes values in memory and on the next real write', async () => {
    const f = fixture();
    const file = resolvePluginConfigStorePath(f.store);
    const envelope = { schemaVersion: 6, sourceId: f.store.sourceId, binding: { kind: 'source', sourceIdentity },
      pluginName: manifest.name, common: { labels: { z: 'last', a: 'first' }, connection: { token: 'secret', region: 'west' } }, platforms: {} };
    await fs.outputJson(file, envelope);
    const before = await fs.readFile(file, 'utf8');
    const read = await readPluginConfigStore(f.store);
    expect(Object.keys(read.values)).toEqual(['connection', 'labels']);
    expect(Object.keys(read.values.labels as object)).toEqual(['a', 'z']);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    const reordered = { ...envelope, common: { connection: { region: 'west', token: 'secret' }, labels: { a: 'first', z: 'last' } } };
    await fs.writeFile(file, JSON.stringify(reordered));
    const byteReordered = await readPluginConfigStore(f.store);
    expect(byteReordered.values).toEqual(read.values);
    expect(byteReordered.rawDigest).not.toBe(read.rawDigest);
    await patchPluginConfigStore({ ...f.store, updates: { connection: { region: 'east' } } });
    const written = await fs.readJson(file);
    expect(Object.keys(written.common)).toEqual(['connection', 'labels']);
    expect(Object.keys(written.common.labels)).toEqual(['a', 'z']);
  });
});
