import { PLATFORM_TARGETS, resolveSupportedPlatforms, selectPluginConfigProfile } from '@lesliechan721/aw-plugin-core/manifest';
import type { PreferencesObservation } from '../intent/deployment-preferences.js';
import type { NextAction } from '../output/public-result.js';
import type { PlatformTarget, PluginMeta } from '../types.js';
import type { PluginConfigStore } from './plugin-config.js';

export type ConfigLayer = 'common' | PlatformTarget;
type ConfigManifest = Pick<PluginMeta['manifest'], 'platforms' | 'config'>;
type ConfigLayerErrorCode = 'deploymentPreferencesInvalid' | 'deploymentPreferencesUnavailable'
  | 'configPlatformNotEnabled' | 'configCommonLayerUnavailable';

export class ConfigLayerError extends Error {
  constructor(readonly code: ConfigLayerErrorCode, message: string, readonly nextActions: NextAction[], readonly target?: PlatformTarget) {
    super(message);
  }
}

export function resolveActiveConfigPlatforms(pluginId: string, manifest: Pick<ConfigManifest, 'platforms'>,
  preferences: PreferencesObservation): PlatformTarget[] {
  if (preferences.state === 'absent') return [];
  if (preferences.state !== 'valid') {
    throw new ConfigLayerError(preferences.code, 'Deployment preferences could not be read as a valid target selection.',
      [{ kind: 'manual', message: 'Inspect and repair deployment-preferences.json, then retry.' }]);
  }
  const supported = resolveSupportedPlatforms(manifest);
  const { targets, exclusions } = preferences.value;
  return PLATFORM_TARGETS.filter((target) => supported.has(target) && targets.includes(target)
    && !exclusions.some((entry) => entry.plugin === pluginId && entry.target === target));
}

export function resolveConfigurableLayers(pluginId: string, manifest: ConfigManifest,
  preferences: PreferencesObservation): ConfigLayer[] {
  const active = resolveActiveConfigPlatforms(pluginId, manifest, preferences);
  if (!manifest.config) return [];
  const config = manifest.config;
  return (['common', ...active] as const).filter((layer) =>
    Object.keys(selectPluginConfigProfile(config, layer === 'common' ? undefined : layer).fields).length > 0);
}

export function classifyResidualConfigLayers(store: Pick<PluginConfigStore, 'common' | 'platforms'>,
  configurableLayers: readonly ConfigLayer[]): { layer: ConfigLayer; fieldCount: number }[] {
  return (['common', ...PLATFORM_TARGETS] as const).flatMap((layer) => {
    if (configurableLayers.includes(layer)) return [];
    const values = layer === 'common' ? store.common : store.platforms?.[layer];
    const fieldCount = Object.keys(values ?? {}).length;
    return fieldCount ? [{ layer, fieldCount }] : [];
  });
}

export function assertConfigLayerWritable(pluginId: string, manifest: ConfigManifest,
  preferences: PreferencesObservation, platform?: PlatformTarget): void {
  if (resolveConfigurableLayers(pluginId, manifest, preferences).includes(platform ?? 'common')) return;
  if (!platform) throw new ConfigLayerError('configCommonLayerUnavailable', 'This plugin has no common configuration fields.',
    [{ kind: 'manual', message: 'Select an enabled platform with --platform.' }]);
  throw new ConfigLayerError('configPlatformNotEnabled', `The ${platform} configuration layer is unavailable for ${pluginId}.`, [
    { kind: 'manual', message: 'Check supported targets, enable the target, and review this plugin’s exclusions.' },
    { kind: 'command', argv: ['aw', 'plugin', 'config', 'reset', pluginId, '--platform', platform],
      reason: 'Clear the saved layer if it is no longer needed.', requiresConfirmation: true },
  ], platform);
}
