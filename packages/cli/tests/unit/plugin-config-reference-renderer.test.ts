import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';
import { normalizePluginConfigDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import type { PluginMeta } from '../../src/types.js';
import { resolveEffectivePluginConfig, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { runArtifactRenderer, resolveArtifactRendererTarget, writeArtifactRendererContext } from '../../src/utils/artifact-renderer.js';
import { createArtifactRuntimeConfigSnapshots } from '../../src/utils/runtime-config.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(transitive = false) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const rootDir = path.join(cwd, 'reference-renderer');
  const manifestPath = path.join(rootDir, '.agents-plugin', 'plugin.json');
  const manifest: PluginMeta['manifest'] = {
    schemaVersion: 3, name: 'reference-renderer', version: '1.0.0', description: 'Reference fixture',
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    config: normalizePluginConfigDefinition({ schemaVersion: 3, fields: {
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
    artifacts: { targets: [{
      id: 'selected-skill', platform: 'codex', target: 'codex.skill', scopes: ['user'], states: ['present'],
      refreshKeys: ['selected'], skillKey: 'selected-skill', delivery: { mode: 'aw-extension' },
      runtimeConfig: { keys: ['selected'], resourceVersion: 'instructions-v2' },
    }] },
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
      config: { mode: 'artifact-render', targetScope: 'user', ...effective }, requestedArtifactIds: ['selected-skill'] }))
      .toThrow('runtimeConfigInvalid');
    const runner = vi.fn();
    await expect(runArtifactRenderer({ plugin, event: 'install', platform: 'codex', scope: 'user', cwd: options.cwd,
      commandEnv: options.env, requestedArtifactIds: ['selected-skill'], runner }))
      .rejects.toThrow(/runtimeConfigInvalid|Invalid AW config/u);
    // A renderer without runtime metadata must reject the same selected-only dependency failure.
    delete plugin.manifest.artifacts!.targets![0]!.runtimeConfig;
    await expect(runArtifactRenderer({ plugin, event: 'install', platform: 'codex', scope: 'user', cwd: options.cwd,
      commandEnv: options.env, requestedArtifactIds: ['selected-skill'], runner }))
      .rejects.toThrow('Invalid AW config');
    expect(runner).not.toHaveBeenCalled();
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
    const runner = vi.fn();
    await expect(runArtifactRenderer({ plugin, event: 'install', platform: 'codex', scope: 'user', cwd: options.cwd,
      commandEnv: options.env, requestedArtifactIds: ['selected-skill'], runner }))
      .rejects.toThrow(/runtimeConfigInvalid|Invalid AW config/u);
    expect(runner).not.toHaveBeenCalled();
  });

  it('keeps a valid dependency source private in the selected renderer projection', async () => {
    const { plugin, options } = await fixture();
    await writePluginConfigStore({ ...options, values: { registry: [{ id: 'remote', enabled: true }], selected: 'built-in' } });
    const target = await resolveArtifactRendererTarget(plugin);
    const written = await writeArtifactRendererContext({ ...options, target, event: 'install', platform: 'codex',
      commandEnv: options.env, requestedArtifactIds: ['selected-skill'] });
    try {
      expect(written.context.config.values).toEqual({ selected: 'built-in' });
      expect(written.context.config.sources).toEqual({ selected: 'user' });
      expect(written.context.config.issues).toEqual([]);
      expect(written.runtimeConfigSnapshots['selected-skill']!.allowedKeys).toEqual(['selected']);
    } finally {
      await fs.remove(written.tempDir);
    }
  });
});
