import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { normalizePluginConfigDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import type { NormalizedPluginManifest } from '../../src/types.js';
import {
  patchPluginConfigStore,
  readPluginConfigStore,
  resolveConfigRead,
  resolveEffectivePluginConfig,
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const sourceIdentity = `sha256:${'7'.repeat(64)}`;
const config = normalizePluginConfigDefinition({
  fields: {
    connection: {
      type: 'object',
      properties: {
        'display-name': { type: 'string' },
        region: { type: 'string' },
        token: { type: 'string', sensitive: true },
      },
      additionalProperties: false,
    },
    labels: {
      type: 'object',
      additionalProperties: { type: 'string' },
      validation: { key: { format: 'identifier' } },
    },
  },
});
const manifest = {
  name: 'object-config',
  version: '1.0.0',
  config,
} as unknown as NormalizedPluginManifest;

function storeOptions(scope: 'user' | 'project') {
  const isolation = getCurrentSourceTestIsolation();
  return {
    sourceId: 'official',
    sourceIdentity,
    pluginName: manifest.name,
    scope,
    cwd: isolation.layout.fixtureCwd,
    env: isolation.env,
  };
}

describe('plugin config Store v3', () => {
  it.each([
    { projectValue: 'project', userValue: 'user', expectedValue: 'user', expectedSource: 'user', label: 'valid' },
    { projectValue: 42, userValue: undefined, expectedValue: 'default', expectedSource: 'default', label: 'invalid' },
  ])('ignores a $label project override for a Codex native refresh key', async ({
    projectValue, userValue, expectedValue, expectedSource,
  }) => {
    const nativeConfig = normalizePluginConfigDefinition({
      fields: { mode: { type: 'string', default: 'default' } },
    });
    const nativeManifest = {
      name: manifest.name,
      version: manifest.version,
      config: nativeConfig,
      artifacts: {
        targets: [{
          id: 'native-skill',
          platform: 'codex',
          target: 'codex.skill',
          delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
          scopes: ['user'],
          states: ['present'],
          refreshKeys: ['mode'],
          skillKey: 'native-skill',
        }],
      },
    } as unknown as NormalizedPluginManifest;
    const user = storeOptions('user');
    const project = storeOptions('project');
    if (userValue !== undefined) {
      await writePluginConfigStore({ ...user, values: { mode: userValue } });
    }
    await writePluginConfigStore({ ...project, values: { mode: projectValue } });

    const effective = await resolveEffectivePluginConfig({
      sourceId: user.sourceId,
      sourceIdentity,
      manifest: nativeManifest,
      targetScope: 'project',
      cwd: user.cwd,
      env: user.env,
    });

    expect(effective.values.mode).toBe(expectedValue);
    expect(effective.sources.mode).toBe(expectedSource);
    expect(effective.issues).toEqual([]);
    expect(effective.unsupportedLayerOverrides).toEqual([{
      type: 'configLayerUnsupported',
      key: 'mode',
      scope: 'project',
      source: 'project',
    }]);
    await expect(resolveConfigRead({
      sourceId: user.sourceId,
      sourceIdentity,
      pluginName: nativeManifest.name,
      plugin: {
        rootDir: user.cwd,
        manifestPath: path.join(user.cwd, '.agents-plugin', 'plugin.json'),
        manifest: nativeManifest,
        sourceId: user.sourceId,
        sourceIdentity,
      },
      scope: 'project',
      cwd: user.cwd,
      env: user.env,
    })).resolves.toMatchObject({
      fields: [{
        key: 'mode',
        writable: false,
        canSet: false,
        canUnset: true,
        effectiveValue: expectedValue,
        sourceLayer: expectedSource,
        storedSourceLayer: 'project',
      }],
    });
    expect((await readPluginConfigStore(project)).values.mode).toBe(projectValue);
  });

  it('atomically overrides an object at its top-level key and unsets to inheritance', async () => {
    const user = storeOptions('user');
    const project = storeOptions('project');
    await writePluginConfigStore({
      ...user,
      values: { connection: { region: 'user', token: 'user-secret' } },
    });
    await writePluginConfigStore({
      ...project,
      values: { connection: { region: 'project' }, unknownFutureKey: true },
    });

    const overridden = await resolveEffectivePluginConfig({
      sourceId: user.sourceId,
      sourceIdentity,
      manifest,
      cwd: user.cwd,
      env: user.env,
    });
    expect(overridden.values.connection).toEqual({ region: 'project' });
    expect(overridden.redactedValues.connection).toEqual({ region: 'project' });
    expect(overridden.ignoredUnknownKeys).toContainEqual({
      scope: 'project',
      source: 'project',
      key: 'unknownFutureKey',
    });

    const userTarget = await resolveEffectivePluginConfig({
      sourceId: user.sourceId,
      sourceIdentity,
      manifest,
      targetScope: 'user',
      cwd: user.cwd,
      env: user.env,
    });
    const projectTarget = await resolveEffectivePluginConfig({
      sourceId: user.sourceId,
      sourceIdentity,
      manifest,
      targetScope: 'project',
      cwd: user.cwd,
      env: user.env,
    });
    expect(userTarget.values.connection).toEqual({ region: 'user', token: 'user-secret' });
    expect(userTarget.ignoredUnknownKeys).toEqual([]);
    expect(projectTarget.values.connection).toEqual({ region: 'project' });

    await patchPluginConfigStore({
      ...project,
      updates: {},
      removeKeys: ['connection', 'unknownFutureKey'],
    });
    await expect(fs.pathExists(resolvePluginConfigStorePath(project))).resolves.toBe(false);

    const inherited = await resolveEffectivePluginConfig({
      sourceId: user.sourceId,
      sourceIdentity,
      manifest,
      cwd: user.cwd,
      env: user.env,
    });
    expect(inherited.values.connection).toEqual({ region: 'user', token: 'user-secret' });
    expect(inherited.redactedValues.connection).toEqual({
      region: 'user',
      token: '[redacted]',
    });

    await fs.outputFile(resolvePluginConfigStorePath(project), '{invalid');
    await expect(resolveEffectivePluginConfig({
      sourceId: user.sourceId,
      sourceIdentity,
      manifest,
      targetScope: 'user',
      cwd: user.cwd,
      env: user.env,
    })).resolves.toMatchObject({
      values: { connection: { region: 'user', token: 'user-secret' } },
    });
    await expect(resolveEffectivePluginConfig({
      sourceId: user.sourceId,
      sourceIdentity,
      manifest,
      targetScope: 'project',
      cwd: user.cwd,
      env: user.env,
    })).rejects.toThrow('invalidJson');
  });

  it('keeps a schema-invalid envelope structurally ready and blocks its effective field', async () => {
    const user = storeOptions('user');
    const filePath = resolvePluginConfigStorePath(user);
    await fs.outputJson(filePath, {
      schemaVersion: 3,
      sourceId: user.sourceId,
      sourceIdentity,
      pluginName: manifest.name,
      values: { connection: { region: 42 } },
    });

    await expect(readPluginConfigStore({ ...user, schema: config.fields })).resolves.toMatchObject({
      state: 'ready',
      values: { connection: { region: 42 } },
    });
    for (const targetScope of ['user', 'project'] as const) {
      await expect(resolveEffectivePluginConfig({
        sourceId: user.sourceId,
        sourceIdentity,
        manifest,
        targetScope,
        cwd: user.cwd,
        env: user.env,
      })).resolves.toMatchObject({
        values: {},
        sources: { connection: 'user' },
        fieldStates: {
          connection: {
            invalidOverride: { source: 'user' },
          },
        },
        issues: [expect.objectContaining({ key: 'connection', source: 'user' })],
      });
    }
  });

  it('validates fixed and key-value objects without mixing their schemas', async () => {
    const user = storeOptions('user');
    await fs.outputJson(resolvePluginConfigStorePath(user), {
      schemaVersion: 3,
      sourceId: user.sourceId,
      sourceIdentity,
      pluginName: manifest.name,
      values: {
        connection: { 'display-name': 'fixed' },
        labels: { dynamic_name: 'dynamic' },
      },
    });

    await expect(readPluginConfigStore({ ...user, schema: config.fields })).resolves.toMatchObject({
      state: 'ready',
      values: {
        connection: { 'display-name': 'fixed' },
        labels: { dynamic_name: 'dynamic' },
      },
    });

    await fs.outputJson(resolvePluginConfigStorePath(user), {
      schemaVersion: 3,
      sourceId: user.sourceId,
      sourceIdentity,
      pluginName: manifest.name,
      values: { labels: { 'bad key': 'dynamic' } },
    });
    await expect(readPluginConfigStore({ ...user, schema: config.fields })).resolves.toMatchObject({
      state: 'ready',
      values: { labels: { 'bad key': 'dynamic' } },
    });
    await expect(resolveEffectivePluginConfig({
      sourceId: user.sourceId,
      sourceIdentity,
      manifest,
      targetScope: 'user',
      cwd: user.cwd,
      env: user.env,
    })).resolves.toMatchObject({
      values: {},
      fieldStates: { labels: { invalidOverride: { source: 'user' } } },
    });
  });

  it('keeps a lower object only as fallback when a project override is invalid', async () => {
    const user = storeOptions('user');
    const project = storeOptions('project');
    await writePluginConfigStore({
      ...user,
      values: { connection: { region: 'user', token: 'user-secret' } },
    });
    await fs.outputJson(resolvePluginConfigStorePath(project), {
      schemaVersion: 3,
      sourceId: project.sourceId,
      sourceIdentity,
      pluginName: manifest.name,
      values: { connection: { region: 42 } },
    });

    const invalid = await resolveEffectivePluginConfig({
      sourceId: user.sourceId,
      sourceIdentity,
      manifest,
      cwd: user.cwd,
      env: user.env,
    });
    expect(invalid.values).not.toHaveProperty('connection');
    expect(invalid.fieldStates.connection).toMatchObject({
      invalidOverride: { source: 'project' },
      fallback: {
        source: 'user',
        value: { region: 'user', token: 'user-secret' },
      },
    });

    await patchPluginConfigStore({ ...project, updates: {}, removeKeys: ['connection'] });
    const restored = await resolveEffectivePluginConfig({
      sourceId: user.sourceId,
      sourceIdentity,
      manifest,
      cwd: user.cwd,
      env: user.env,
    });
    expect(restored.values.connection).toEqual({ region: 'user', token: 'user-secret' });
  });

  it('treats a dangerous dynamic object key as a recoverable field error', async () => {
    const user = storeOptions('user');
    await fs.outputFile(resolvePluginConfigStorePath(user), JSON.stringify({
      schemaVersion: 3,
      sourceId: user.sourceId,
      sourceIdentity,
      pluginName: manifest.name,
      values: { labels: JSON.parse('{"__proto__":"value"}') },
    }));

    const store = await readPluginConfigStore({ ...user, schema: config.fields });
    expect(store.state).toBe('ready');
    const effective = await resolveEffectivePluginConfig({
      sourceId: user.sourceId,
      sourceIdentity,
      manifest,
      targetScope: 'user',
      cwd: user.cwd,
      env: user.env,
    });
    expect(effective.fieldStates.labels?.invalidOverride?.source).toBe('user');
    expect(effective.issues.some((issue) => issue.message.includes('Dangerous config key'))).toBe(true);
  });

  it('canonicalizes values in memory and on the next real write', async () => {
    const user = storeOptions('user');
    const filePath = resolvePluginConfigStorePath(user);
    await fs.outputJson(filePath, {
      schemaVersion: 3,
      sourceId: user.sourceId,
      sourceIdentity,
      pluginName: manifest.name,
      values: { labels: { z: 'last', a: 'first' }, connection: { token: 'secret', region: 'west' } },
    });
    const before = await fs.readFile(filePath, 'utf8');
    const read = await readPluginConfigStore(user);
    expect(Object.keys(read.values)).toEqual(['connection', 'labels']);
    expect(Object.keys(read.values.labels as object)).toEqual(['a', 'z']);
    expect(await fs.readFile(filePath, 'utf8')).toBe(before);

    const reordered = JSON.parse(before);
    reordered.values = {
      connection: { region: 'west', token: 'secret' },
      labels: { a: 'first', z: 'last' },
    };
    await fs.outputFile(filePath, `${JSON.stringify(reordered)}\n`);
    const byteReordered = await readPluginConfigStore(user);
    expect(byteReordered.values).toEqual(read.values);
    expect(byteReordered.rawDigest).not.toBe(read.rawDigest);

    await patchPluginConfigStore({ ...user, updates: { connection: { region: 'east' } } });
    const written = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(Object.keys(written.values)).toEqual(['connection', 'labels']);
    expect(Object.keys(written.values.labels)).toEqual(['a', 'z']);
  });
});
