import type { PluginLocation } from '../types.js';

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizePluginLocation(location: PluginLocation): PluginLocation {
  return {
    plugin: location.plugin,
    platform: location.platform,
    scope: location.scope,
    projectKey: location.scope === 'user' ? null : location.projectKey,
  };
}

export function serializePluginLocation(location: PluginLocation): string {
  const normalized = normalizePluginLocation(location);
  return JSON.stringify([
    normalized.plugin,
    normalized.platform,
    normalized.scope,
    normalized.projectKey,
  ]);
}

export function comparePluginLocations(left: PluginLocation, right: PluginLocation): number {
  const normalizedLeft = normalizePluginLocation(left);
  const normalizedRight = normalizePluginLocation(right);

  return (
    compareStrings(normalizedLeft.plugin, normalizedRight.plugin) ||
    compareStrings(normalizedLeft.platform, normalizedRight.platform) ||
    compareStrings(normalizedLeft.scope, normalizedRight.scope) ||
    compareStrings(normalizedLeft.projectKey ?? '', normalizedRight.projectKey ?? '')
  );
}

export function sortPluginLocations(locations: readonly PluginLocation[]): PluginLocation[] {
  return [...locations]
    .map((location) => normalizePluginLocation(location))
    .sort(comparePluginLocations);
}

export function samePluginLocation(left: PluginLocation, right: PluginLocation): boolean {
  return serializePluginLocation(left) === serializePluginLocation(right);
}
