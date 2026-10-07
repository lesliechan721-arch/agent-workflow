import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { createRuntimeConfigSnapshot, type RuntimeInstalledIdentity, type PluginConfigSchema } from '@lesliechan721/aw-plugin-core';
import { injectInstalledRuntimeConfig, createArtifactRuntimeConfigSnapshots } from '../../src/utils/runtime-config.js';
import { writeDynamicSkillTree } from '../../src/utils/dynamic-skill-tree.js';
import { readRuntimeConfig } from '../../authoring/assets/aw-runtime-config.mjs';
import { createCodexNativeRenderReceipt } from '../../src/utils/codex-native-render-receipt.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { readPluginManifest } from '../../src/utils/manifest.js';

const identity: RuntimeInstalledIdentity = { sourceId: 'team', sourceIdentity: `sha256:${'1'.repeat(64)}`,
  pluginId: 'team/unrelated-plugin', pluginName: 'unrelated-plugin', pluginVersion: '1.0.0',
  platform: 'codex', scope: 'user', configScope: 'user', artifactId: 'tool-a', skillKey: 'tool-a' };
const definition: PluginConfigSchema = { schemaVersion: 3, fields: {
  secret: { type: 'string', sensitive: true },
  channels: { type: 'array', validation: { uniqueBy: 'key' }, items: { type: 'object', properties: {
    key: { type: 'string', required: true },
  } } },
  selected: { type: 'string', valueRef: { field: 'channels', key: 'key', include: ['built-in'] } },
} };
const options = { installedIdentity: identity, declaration: { keys: ['selected'] as [string] },
  definition, values: { selected: 'registered', channels: [{ key: 'registered' }], secret: 'private-token' } };

// Test Value Gate: the installed reader preserves keys, identity and resource path boundaries.
async function installed(native = false) {
  const root = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'installed',
    ...(native ? ['plugin', 'codex', 'skills'] : []), 'tool-a');
  const snapshot = createRuntimeConfigSnapshot(options);
  const tree = { skillKey: 'tool-a', files: {
    'SKILL.md': Buffer.from('---\nname: tool-a\ndescription: Run an unrelated task.\n---\n# Task\n'),
    'scripts/caller.mjs': Buffer.from('export const caller = true;\n'),
    'runtime/instructions.md': Buffer.from('Bounded instructions.\n'),
  } };
  await injectInstalledRuntimeConfig(tree, snapshot, native ? { nativeReceiptPath: '../../../.agents-plugin/aw-codex-native-render.json' } : {});
  await writeDynamicSkillTree(root, tree);
  const canonicalRoot = await fs.realpath(root);
  const from = pathToFileURL(path.join(canonicalRoot, 'scripts/caller.mjs'));
  return { root: canonicalRoot, from, snapshot, tree };
}

describe('runtime config reader boundary', () => {
  it('keeps duplicate artifact IDs in their platform and scope namespace', async () => {
    const root = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'namespaced-plugin');
    const common = { id: 'shared-id', states: ['present'], refreshKeys: ['selected'], runtimeConfig: {
      keys: ['selected'],
    } };
    await fs.outputJson(path.join(root, '.agents-plugin/plugin.json'), { schemaVersion: 3, name: 'namespaced-plugin', version: '1.0.0',
      description: 'Namespaced artifact IDs', marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } }, config: { fields: { selected: { type: 'string', default: 'local' } } },
      artifacts: { targets: [
        { ...common, platform: 'codex', scopes: ['user'], target: 'codex.skill', delivery: { mode: 'aw-extension' }, skillKey: 'codex-user-tool' },
        { ...common, platform: 'codex', scopes: ['project'], target: 'codex.skill', delivery: { mode: 'aw-extension' }, skillKey: 'codex-project-tool' },
        { ...common, platform: 'claude', scopes: ['user'], target: 'claude.skill', skillKey: 'claude-user-tool' },
      ] },
    });
    await fs.outputFile(path.join(root, 'render.mjs'), 'console.log("{}");\n');
    const plugin = await readPluginManifest(root);
    for (const [platform, scope, skillKey] of [['codex', 'user', 'codex-user-tool'], ['codex', 'project', 'codex-project-tool'], ['claude', 'user', 'claude-user-tool']] as const) {
      const snapshots = createArtifactRuntimeConfigSnapshots({ sourceId: 'team', sourceIdentity: identity.sourceIdentity,
        manifest: plugin.manifest, platform, scope, requestedArtifactIds: ['shared-id'],
        config: { mode: 'artifact-render', targetScope: scope, schema: plugin.manifest.config!.fields,
          values: { selected: 'local' }, sources: { selected: 'default' }, issues: [], stores: {} },
      });
      expect(snapshots['shared-id']!.installedIdentity).toMatchObject({ platform, scope, skillKey });
    }
  });
  it('validates the dependency closure at installation and returns only requested allowed keys', async () => {
    const item = await installed();
    expect(await readRuntimeConfig({ from: item.from, keys: ['selected'] }))
      .toEqual({ installedIdentity: identity, effectiveValues: { selected: 'registered' }, resourceRoot: item.root });
    const binding = await fs.readJson(path.join(item.root, '.aw-runtime-config.json'));
    expect(binding).toEqual({ schemaVersion: 2, kind: 'aw-runtime-config', installedIdentity: identity,
      allowedKeys: ['selected'], effectiveValues: { selected: 'registered' } });
    expect(() => createRuntimeConfigSnapshot({ ...options, values: { ...options.values, selected: 'dangling' } }))
      .toThrow('runtimeConfigInvalid');
    expect(() => createRuntimeConfigSnapshot({ ...options,
      definition: { ...definition, fields: { ...definition.fields, channels: { ...definition.fields.channels!, sensitive: true } } } as PluginConfigSchema,
    })).toThrow('runtimeConfigKeyDenied');
    await expect(readRuntimeConfig({ from: item.from, keys: ['channels'] })).rejects.toMatchObject({ code: 'runtimeConfigKeyDenied' });
    await expect(readRuntimeConfig({ from: item.from, keys: ['secret'] })).rejects.toMatchObject({ code: 'runtimeConfigKeyDenied' });
  });

  it('reads each current resource without hashing unrelated content or copying a field validator', async () => {
    const item = await installed();
    await fs.appendFile(path.join(item.root, 'SKILL.md'), '\nchanged text\n');
    await fs.remove(path.join(item.root, 'runtime/instructions.md'));
    const bindingPath = path.join(item.root, '.aw-runtime-config.json');
    const original = await fs.readJson(bindingPath);
    await fs.writeJson(bindingPath, { ...original, effectiveValues: { selected: 'later-value' } });
    expect(await readRuntimeConfig({ from: item.from, keys: ['selected'] }))
      .toMatchObject({ effectiveValues: { selected: 'later-value' } });
  });

  it('rejects malformed, legacy and unknown bindings with concrete recovery', async () => {
    const item = await installed();
    const bindingPath = path.join(item.root, '.aw-runtime-config.json');
    const original = await fs.readJson(bindingPath);
    await fs.outputFile(bindingPath, '{broken');
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigBindingInvalid' });
    for (const schemaVersion of [1, 9]) {
      await fs.writeJson(bindingPath, { ...original, schemaVersion });
      await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({
        code: 'runtimeConfigVersionUnsupported', message: expect.stringContaining('schemaVersion 2'), recoveryActions: ['sync', 'reinstall'],
      });
    }
    await fs.writeJson(bindingPath, { ...original, revision: 'legacy' });
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigMigrationRequired' });
    await fs.writeJson(bindingPath, { ...original, effectiveValues: { selected: null } });
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigBindingInvalid' });
    await fs.writeJson(bindingPath, { ...original, effectiveValues: { selected: 'registered', secret: 'not-allowed' } });
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigKeyDenied' });
    await fs.writeJson(bindingPath, original);
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'], expectedRevision: 'legacy' }))
      .rejects.toMatchObject({ code: 'runtimeConfigMigrationRequired', message: expect.stringContaining('expectedRevision') });
    await fs.remove(path.join(item.root, 'SKILL.md'));
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigResourceMissing' });
  });

  it.each(['resourceVersion', 'artifactIds'])('gives a migration error for the removed manifest field %s', async (legacyKey) => {
    const root = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'legacy-plugin');
    await fs.outputJson(path.join(root, '.agents-plugin/plugin.json'), { schemaVersion: 3, name: 'legacy-plugin', version: '1.0.0',
      description: 'Old runtime config', marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } }, config: { fields: { selected: { type: 'string' } } },
      artifacts: { targets: [{ id: 'tool-a', platform: 'codex', scopes: ['user'], target: 'codex.skill', delivery: { mode: 'aw-extension' },
        states: ['present'], refreshKeys: ['selected'], skillKey: 'tool-a', runtimeConfig: { keys: ['selected'], [legacyKey]: legacyKey === 'artifactIds' ? ['tool-a'] : 'old-v1' } }] },
    });
    await expect(readPluginManifest(root)).rejects.toThrow(/runtimeConfigMigrationRequired.*aw\.installed-runtime-config\.v2/u);
  });

  it.skipIf(process.platform === 'win32')('rejects unsafe caller paths and renderer issued runtime resources', async () => {
    const item = await installed();
    const outside = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'outside.mjs');
    await fs.outputFile(outside, 'export const outside = true;\n');
    await fs.remove(path.join(item.root, 'scripts/caller.mjs'));
    await fs.symlink(outside, path.join(item.root, 'scripts/caller.mjs'));
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigPathUnsafe' });
    await expect(injectInstalledRuntimeConfig(item.tree, item.snapshot)).rejects.toThrow('runtimeConfigReservedResource');
  });

  it('checks the explicit shared-native receipt locator against its source and artifact identity', async () => {
    const item = await installed(true);
    const receiptPath = path.resolve(item.root, '../../../.agents-plugin/aw-codex-native-render.json');
    const receipt = createCodexNativeRenderReceipt({ logicalPluginId: identity.pluginId, sourceIdentity: identity.sourceIdentity,
      pluginVersion: identity.pluginVersion, rendererDigest: `sha256:${'3'.repeat(64)}`,
      targets: [{ id: identity.artifactId, skillKey: identity.skillKey, configDigest: `sha256:${'4'.repeat(64)}`, artifactDigest: `sha256:${'5'.repeat(64)}` }],
      payloadDigest: `sha256:${'6'.repeat(64)}`,
    });
    await fs.outputJson(receiptPath, receipt);
    expect(await readRuntimeConfig({ from: item.from, keys: ['selected'] })).toMatchObject({ installedIdentity: { scope: 'user', configScope: 'user' } });
    await fs.outputJson(receiptPath, { ...receipt, sourceIdentity: `sha256:${'2'.repeat(64)}` });
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigIdentityMismatch' });
    await fs.remove(receiptPath);
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigResourceMissing' });
  });
});
