import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import { normalizePluginConfigDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import type { NormalizedPluginManifest } from '../../src/types.js';
import {
  patchPluginConfigStore,
  readPluginConfigStore,
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
        region: { type: 'string' },
        token: { type: 'string', sensitive: true },
      },
      additionalProperties: false,
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
  });

  it('rejects a known invalid object value as an invalidValues store projection', async () => {
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
      state: 'invalid',
      invalidCode: 'invalidValues',
      values: {},
    });
    await expect(resolveEffectivePluginConfig({
      sourceId: user.sourceId,
      sourceIdentity,
      manifest,
      cwd: user.cwd,
      env: user.env,
    })).rejects.toThrow('invalidValues');
  });
});
