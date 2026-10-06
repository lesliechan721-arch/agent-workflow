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
const options = { installedIdentity: identity, declaration: { keys: ['selected'], resourceVersion: 'instructions-v2' },
  definition, values: { selected: 'registered', channels: [{ key: 'registered' }], secret: 'private-token' },
  sources: { selected: 'user', channels: 'user', secret: 'user' } };

// Test Value Gate: a caller cannot bypass keys, identity, revision, or resource path checks.
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
  it.each([false, true])('keeps duplicate artifact IDs in their platform and scope namespace (self group: %s)', async (selfGroup) => {
    const root = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'namespaced-plugin');
    const common = { id: 'shared-id', states: ['present'], refreshKeys: ['selected'], runtimeConfig: {
      keys: ['selected'], resourceVersion: 'namespace-v1', ...(selfGroup ? { artifactIds: ['shared-id'] } : {}),
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
      if (selfGroup) expect(snapshots['shared-id']!.consistencyGroup).toEqual([{ artifactId: 'shared-id', skillKey }]);
    }
  });
  it('projects only allowed keys and shares a deterministic revision across related artifacts', async () => {
    const item = await installed();
    expect(await readRuntimeConfig({ from: item.from, keys: ['selected'], expectedRevision: item.snapshot.revision }))
      .toMatchObject({ effectiveValues: { selected: 'registered' }, resourceVersion: 'instructions-v2', revision: item.snapshot.revision });
    const sibling = createRuntimeConfigSnapshot({ ...options,
      installedIdentity: { ...identity, artifactId: 'tool-b', skillKey: 'tool-b' } });
    expect(sibling.revision).toBe(item.snapshot.revision);
    const movedSource = createRuntimeConfigSnapshot({ ...options,
      installedIdentity: { ...identity, sourceIdentity: `sha256:${'2'.repeat(64)}` } });
    expect(movedSource.revision).not.toBe(item.snapshot.revision);
    expect(() => createRuntimeConfigSnapshot({ ...options, values: { ...options.values, selected: 'dangling' } }))
      .toThrow('runtimeConfigInvalid');
    await expect(readRuntimeConfig({ from: item.from, keys: ['channels'] })).rejects.toMatchObject({ code: 'runtimeConfigKeyDenied' });
    await expect(readRuntimeConfig({ from: item.from, keys: ['secret'] })).rejects.toMatchObject({ code: 'runtimeConfigKeyDenied' });
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'], expectedRevision: 'different' }))
      .rejects.toMatchObject({ code: 'runtimeConfigRevisionMismatch' });
  });

  it('rejects binding tampering, missing resource, unknown version, and an unbound caller', async () => {
    const item = await installed();
    const bindingPath = path.join(item.root, '.aw-runtime-config.json');
    const original = await fs.readJson(bindingPath);
    await fs.writeJson(bindingPath, { ...original, effectiveValues: { selected: 'other' } });
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigBindingInvalid' });
    await fs.writeJson(bindingPath, { ...original, schemaVersion: 9 });
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigVersionUnsupported' });
    await fs.writeJson(bindingPath, original);
    await fs.outputFile(path.join(item.root, 'unbound.mjs'), '// not declared\n');
    await expect(readRuntimeConfig({ from: pathToFileURL(path.join(item.root, 'unbound.mjs')), keys: ['selected'] }))
      .rejects.toMatchObject({ code: 'runtimeConfigIdentityMismatch' });
    await fs.remove(path.join(item.root, 'runtime/instructions.md'));
    await expect(readRuntimeConfig({ from: item.from, keys: ['selected'] })).rejects.toMatchObject({ code: 'runtimeConfigResourceMissing' });
  });

  it.skipIf(process.platform === 'win32')('rejects symlink resources and rejects renderer issued receipts', async () => {
    const item = await installed();
    const resource = path.join(item.root, 'runtime/instructions.md');
    const outside = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'outside.md');
    await fs.outputFile(outside, 'Bounded instructions.\n');
    await fs.remove(resource);
    await fs.symlink(outside, resource);
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
