import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';
import { normalizePluginConfigDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import type { PluginMeta } from '../../src/types.js';
import { resolveEffectivePluginConfig, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { preparePlatformComponents, resolveArtifactRenderConfig } from '../../src/utils/artifact-renderer.js';
import { selectPlatformRenderConfig } from '../../src/utils/artifact-request.js';
import { getAuthoringPlatformCapabilities } from '../../src/review/platform-profile.js';
import { createArtifactRuntimeConfigSnapshots } from '../../src/utils/runtime-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(transitive = false) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const rootDir = path.join(cwd, 'reference-renderer');
  const manifestPath = path.join(rootDir, '.agents-plugin', 'plugin.json');
  const manifest: PluginMeta['manifest'] = {
    schemaVersion: 4, name: 'reference-renderer', version: '1.0.0', description: 'Reference fixture',
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    config: normalizePluginConfigDefinition({ schemaVersion: 5, fields: {
      registry: { type: 'array', validation: { uniqueBy: 'id' }, items: {
        type: 'object', properties: { id: { type: 'string', required: true,
          ...(transitive ? { valueRef: { field: 'providers', key: 'id', include: ['reserved-provider'] } } : {}),
        }, enabled: { type: 'boolean' } }, additionalProperties: false,
      } },
      selected: { type: 'string', default: 'built-in', valueRef: { field: 'registry', key: 'id', include: ['built-in'] } },
      ...(transitive ? { providers: { type: 'array', validation: { uniqueBy: 'id' }, items: {
        type: 'object', properties: { id: { type: 'string', required: true } }, additionalProperties: false,
      } } } : {}),
    } }),
    scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
    requires: { aw: { capabilities: ['aw.installed-runtime-config.v2'] } },
    artifacts: { configKeys: ['selected'] },
  };
  await fs.outputJson(manifestPath, manifest);
  await fs.outputFile(path.join(rootDir, 'render.mjs'), 'throw new Error("must not run for invalid config");\n');
  const plugin: PluginMeta = { rootDir, manifestPath, manifest, sourceId: 'team',
    sourceIdentity: `sha256:${'1'.repeat(64)}`, catalogLogicalIdentity: 'reference/team' };
  const options = { sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity, logicalIdentity: plugin.catalogLogicalIdentity,
    pluginName: manifest.name, scope: 'user' as const, cwd, env: isolation.env };
  return { plugin, options };
}

describe('config reference dependency failures in renderer and runtime', () => {
  // Test Value Gate: an invalid optional source cannot become a valid missing source after projection.
  it.each([
    ['reserved included key', [{ id: 'built-in' }]],
    ['invalid source item', [{ id: 'remote', enabled: 'invalid' }]],
    ['missing source key', [{ id: 'remote' }, { enabled: true }]],
  ])('blocks a selected-only request with %s, including a static included value', async (_name, registry) => {
    const { plugin, options } = await fixture();
    // Simulate a manual edit, which bypasses the config write candidate validator.
    await writePluginConfigStore({ ...options, values: { registry, selected: 'built-in' } });
    const effective = await resolveEffectivePluginConfig({ ...options, manifest: plugin.manifest, targetScope: 'user' });
    expect(effective.values.selected).toBeUndefined();
    expect(effective.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'registry' }),
      expect.objectContaining({ key: 'selected', code: 'valueRefSource' }),
    ]));
    expect(() => createArtifactRuntimeConfigSnapshots({ ...options, manifest: plugin.manifest, platform: 'codex',
      config: { mode: 'artifact-render', targetScope: 'user', ...effective }, components: [{ id: 'selected-skill', kind: 'skill', name: 'selected-skill', content: { files: {} }, runtimeConfig: { keys: ['selected'] } }] }))
      .toThrow('runtimeConfigInvalid');
    const run = vi.fn();
    await expect(preparePlatformComponents({ plugin, platform: 'codex', renderScope: 'user', kinds: ['skill'],
      capabilities: getAuthoringPlatformCapabilities('codex', 'user'),
      config: { mode: 'artifact-render', targetScope: 'user', ...effective }, cwd: options.cwd,
      commandEnv: options.env, runner: { run } }))
      .rejects.toThrow('Invalid AW config');
    expect(run).not.toHaveBeenCalled();
  });

  it('propagates an invalid transitive source to the selected-only consumer', async () => {
    const { plugin, options } = await fixture(true);
    await writePluginConfigStore({ ...options, values: { selected: 'built-in',
      registry: [{ id: 'reserved-provider' }], providers: [{ id: 'reserved-provider' }] } });
    const effective = await resolveEffectivePluginConfig({ ...options, manifest: plugin.manifest, targetScope: 'user' });
    expect(effective.values.selected).toBeUndefined();
    expect(effective.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'providers', code: 'valueRefReserved' }),
      expect.objectContaining({ key: 'selected', code: 'valueRefSource' }),
    ]));
    const run = vi.fn();
    await expect(preparePlatformComponents({ plugin, platform: 'codex', renderScope: 'user', kinds: ['skill'],
      capabilities: getAuthoringPlatformCapabilities('codex', 'user'),
      config: { mode: 'artifact-render', targetScope: 'user', ...effective }, cwd: options.cwd,
      commandEnv: options.env, runner: { run } }))
      .rejects.toThrow('Invalid AW config');
    expect(run).not.toHaveBeenCalled();
  });

  it('includes verified non-sensitive validation dependencies without widening runtime keys', async () => {
    const { plugin, options } = await fixture();
    await writePluginConfigStore({ ...options, values: { registry: [{ id: 'remote', enabled: true }], selected: 'built-in' } });
    const resolved = await resolveArtifactRenderConfig({ ...options, manifest: plugin.manifest, platform: 'codex' });
    const projected = selectPlatformRenderConfig({ resolved, keys: ['selected'], nonSensitive: true });
    expect(projected.values).toEqual({ selected: 'built-in', registry: [{ id: 'remote', enabled: true }] });
    expect(projected.sources).toEqual({ selected: 'common', registry: 'common' });
    expect(projected.issues).toEqual([]);
    const snapshots = createArtifactRuntimeConfigSnapshots({ ...options, manifest: plugin.manifest,
      platform: 'codex', config: resolved, components: [{ id: 'selected-skill', kind: 'skill', name: 'selected-skill',
        content: { files: {} }, runtimeConfig: { keys: ['selected'] } }],
    });
    expect(snapshots['selected-skill']!.allowedKeys).toEqual(['selected']);
    expect(snapshots['selected-skill']!.effectiveValues).toEqual({ selected: 'built-in' });
  });
});
