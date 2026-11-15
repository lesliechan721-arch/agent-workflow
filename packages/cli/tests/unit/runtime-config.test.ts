import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { createRuntimeConfigSnapshot, createRuntimeConfigOrigin, createRuntimeConfigBinding, type RuntimeInstalledIdentity, type PluginConfigSchema } from '@lesliechan721/aw-plugin-core';
import { injectInstalledRuntimeConfig, createArtifactRuntimeConfigSnapshots } from '../../src/utils/runtime-config.js';
import { writeDynamicSkillTree } from '../../src/utils/dynamic-skill-tree.js';
import { readRuntimeConfig } from '../../authoring/assets/aw-runtime-config.mjs';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { getPhysicalKey } from '../../src/platforms/identity.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import type { NormalizedPluginManifest } from '../../src/types.js';

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
  await injectInstalledRuntimeConfig(tree, snapshot, native ? {} : { origin: createRuntimeConfigOrigin({
    snapshot, inputDigest: `sha256:${'3'.repeat(64)}`,
  }) });
  await writeDynamicSkillTree(root, tree);
  if (native) {
    const packageRoot = path.dirname(path.dirname(root));
    const physicalIdentity = { sourceIdentity: identity.sourceIdentity, pluginId: identity.pluginId,
      platform: 'codex' as const, route: 'codex-marketplace' as const,
      namespaceRoot: getCurrentSourceTestIsolation().layout.fixtureCwd, resourceKey: 'aw-team-unrelated-plugin' };
    await writeSkillOwnerMarker({ skillRoot: packageRoot, allowedRoot: path.dirname(packageRoot),
      identity: { owner: 'agent-workflows', sourceId: identity.sourceId, sourceIdentity: identity.sourceIdentity,
        pluginId: identity.pluginId, plugin: identity.pluginName, platform: identity.platform, scope: identity.scope,
        physicalKey: getPhysicalKey(physicalIdentity), artifactKey: path.basename(packageRoot) },
      nativeProjection: { physicalIdentity, components: [{ id: identity.artifactId, nativeName: identity.skillKey,
        relativeOutputs: [`skills/${identity.skillKey}/SKILL.md`] }], inputDigest: `sha256:${'4'.repeat(64)}`,
      contentDigest: `sha256:${'5'.repeat(64)}`, preparation: 'complete' },
    });
  }
  const canonicalRoot = await fs.realpath(root);
  const from = pathToFileURL(path.join(canonicalRoot, 'scripts/caller.mjs'));
  return { root: canonicalRoot, from, snapshot, tree };
}

describe('runtime config reader boundary', () => {
  it('binds snapshots to the actual dynamic component and render scope', () => {
    const manifest: NormalizedPluginManifest = { schemaVersion: 4, name: 'namespaced-plugin', version: '1.0.0',
      description: 'Dynamic component IDs', marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      requires: { aw: { capabilities: ['aw.installed-runtime-config.v2'] } },
      config: { schemaVersion: 5, fields: { selected: { type: 'string', default: 'local' } } },
      artifacts: { configKeys: ['selected'] },
    };
    for (const platform of ['codex', 'claude'] as const) {
      const snapshots = createArtifactRuntimeConfigSnapshots({ sourceId: 'team', sourceIdentity: identity.sourceIdentity,
        manifest, platform, scope: 'project', components: [{ id: 'shared-id', kind: 'skill', name: 'current-name',
          content: { files: {} }, runtimeConfig: { keys: ['selected'] } }],
        config: { mode: 'artifact-render', targetScope: 'project', schema: manifest.config!.fields,
          values: { selected: 'local' }, sources: { selected: 'default' }, issues: [], stores: {} },
      });
      expect(snapshots['shared-id']!.installedIdentity).toMatchObject({ platform, scope: 'project', configScope: 'project', skillKey: 'current-name' });
    }
  });
  it('validates the dependency closure at installation and returns only requested allowed keys', async () => {
    const item = await installed();
    expect(await readRuntimeConfig({ from: item.from, keys: ['selected'] }))
      .toEqual({ installedIdentity: identity, effectiveValues: { selected: 'registered' }, resourceRoot: item.root });
    const binding = await fs.readJson(path.join(item.root, '.aw-runtime-config.json'));
    expect(binding).toEqual({ schemaVersion: 2, kind: 'aw-runtime-config', installedIdentity: identity,
      allowedKeys: ['selected'], effectiveValues: { selected: 'registered' }, originPath: '.aw-runtime-native-receipt.json' });
    expect(() => createRuntimeConfigSnapshot({ ...options, values: { ...options.values, selected: 'dangling' } }))
      .toThrow('runtimeConfigInvalid');
    expect(() => createRuntimeConfigSnapshot({ ...options,
      declaration: { keys: ['secret'] },
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

  it.skipIf(process.platform === 'win32')('rejects unsafe caller paths and renderer issued runtime resources', async () => {
    const item = await installed();
    const outside = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'outside.mjs');
    await fs.outputFile(outside, 'export const outside = true;\n');
    await fs.remove(path.join(item.root, 'scripts/caller.mjs'));
    await fs.symlink(outside, path.join(item.root, 'scripts/caller.mjs'));
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigPathUnsafe' });
    await expect(injectInstalledRuntimeConfig(item.tree, item.snapshot)).rejects.toThrow('runtimeConfigReservedResource');
  });

  it('checks the current package projection independently of the binding source and scope', async () => {
    const item = await installed(true);
    expect(await readRuntimeConfig({ from: item.from, keys: ['selected'] })).toMatchObject({ installedIdentity: identity });
    const bindingPath = path.join(item.root, '.aw-runtime-config.json');
    for (const changed of [
      { ...identity, sourceId: 'other', sourceIdentity: `sha256:${'2'.repeat(64)}`, pluginId: 'other/unrelated-plugin' },
      { ...identity, scope: 'project' as const, configScope: 'project' as const },
      { ...identity, artifactId: 'other-component' },
    ]) {
      await fs.writeJson(bindingPath, createRuntimeConfigBinding(createRuntimeConfigSnapshot({ ...options, installedIdentity: changed })));
      await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigIdentityMismatch' });
    }
    await fs.writeJson(bindingPath, createRuntimeConfigBinding(item.snapshot));
    await fs.remove(path.join(path.dirname(path.dirname(item.root)), '.agent-workflows-owner.json'));
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigIdentityMismatch' });
  });

  it('carries independent current origin through a complete snapshot copy and rejects binding swaps', async () => {
    const item = await installed();
    const originPath = path.join(item.root, '.aw-runtime-native-receipt.json');
    const origin = await fs.readJson(originPath);
    expect(origin).toMatchObject({ schemaVersion: 1, kind: 'aw-runtime-component-origin',
      source: { sourceId: identity.sourceId, sourceIdentity: identity.sourceIdentity, pluginId: identity.pluginId },
      component: { id: identity.artifactId, kind: 'skill', name: identity.skillKey },
    });
    expect(JSON.stringify(origin)).not.toContain('private-token');
    expect(JSON.stringify(origin)).not.toContain('registered');
    const copied = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'snapshot', 'current');
    await fs.copy(item.root, copied);
    const caller = pathToFileURL(path.join(copied, 'scripts/caller.mjs'));
    expect(await readRuntimeConfig({ from: caller, keys: ['selected'] })).toMatchObject({
      installedIdentity: identity, effectiveValues: { selected: 'registered' }, resourceRoot: copied,
    });
    const bindingPath = path.join(copied, '.aw-runtime-config.json');
    for (const installedIdentity of [
      { ...identity, sourceId: 'other', sourceIdentity: `sha256:${'2'.repeat(64)}`, pluginId: 'other/unrelated-plugin' },
      { ...identity, scope: 'project' as const, configScope: 'project' as const },
    ]) {
      const swapped = createRuntimeConfigSnapshot({ ...options, installedIdentity });
      await fs.writeJson(bindingPath, createRuntimeConfigBinding(swapped, { originPath: '.aw-runtime-native-receipt.json' }));
      await expect(readRuntimeConfig({ from: caller, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigIdentityMismatch' });
    }
    await fs.writeJson(bindingPath, createRuntimeConfigBinding(item.snapshot, { originPath: '.aw-runtime-native-receipt.json' }));
    await fs.writeJson(path.join(copied, '.aw-runtime-native-receipt.json'), { schemaVersion: 1, kind: 'aw-codex-native-render', targets: [] });
    await expect(readRuntimeConfig({ from: caller, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigVersionUnsupported' });
  });
});
