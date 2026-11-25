import { describe, expect, it } from 'vitest';
import { normalizePluginConfigDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import { createEmptyPreferences, type PreferencesObservation } from '../../src/intent/deployment-preferences.js';
import { assertConfigLayerWritable, classifyResidualConfigLayers, resolveActiveConfigPlatforms, resolveConfigurableLayers } from '../../src/utils/config-platforms.js';

const pluginId = 'team/example';
const manifest = {
  platforms: ['generic', 'claude', 'codex'] as ('generic' | 'claude' | 'codex')[],
  config: normalizePluginConfigDefinition({ schemaVersion: 5, fields: { profile: { type: 'string', platformOnly: true } } }),
};
const selected: PreferencesObservation = {
  state: 'valid', value: { ...createEmptyPreferences(), targets: ['generic', 'pi', 'claude', 'codex'],
    exclusions: [{ plugin: pluginId, target: 'claude' }, { plugin: 'team/other', target: 'codex' }] },
  digest: '', rawDigest: '', rawBytes: Buffer.alloc(0),
};

describe('configurable plugin platforms', () => {
  it('returns the supported and enabled layers in platform order, retaining only residual counts', () => {
    const layers = resolveConfigurableLayers(pluginId, manifest, selected);
    expect(layers).toEqual(['codex', 'generic']);
    expect(classifyResidualConfigLayers({
      common: { profile: 'hidden' }, platforms: { codex: { profile: 'active' }, claude: { profile: 'hidden' }, pi: {} },
    }, layers)).toEqual([{ layer: 'common', fieldCount: 1 }, { layer: 'claude', fieldCount: 1 }]);
    expect(() => assertConfigLayerWritable(pluginId, manifest, selected, 'claude')).toThrow(expect.objectContaining({ code: 'configPlatformNotEnabled' }));
    expect(() => assertConfigLayerWritable(pluginId, manifest, selected)).toThrow(expect.objectContaining({ code: 'configCommonLayerUnavailable' }));
  });

  it('keeps a common layer independently available with absent or empty selection, and fails closed on unreadable selection', () => {
    const common = { config: normalizePluginConfigDefinition({ schemaVersion: 5, fields: { entry: { type: 'string' } } }) };
    for (const preference of [{ state: 'absent' } as const, { ...selected, value: createEmptyPreferences() }]) {
      expect(resolveActiveConfigPlatforms(pluginId, common, preference)).toEqual([]);
      expect(resolveConfigurableLayers(pluginId, common, preference)).toEqual(['common']);
      expect(classifyResidualConfigLayers({ common: { old: 'old' } }, ['common'])).toEqual([]);
    }
    for (const observation of [{ state: 'invalid', code: 'deploymentPreferencesInvalid' }, { state: 'unreadable', code: 'deploymentPreferencesUnavailable' }] as const) {
      expect(() => resolveConfigurableLayers(pluginId, common, observation)).toThrow(expect.objectContaining({ code: observation.code }));
    }
  });
});
