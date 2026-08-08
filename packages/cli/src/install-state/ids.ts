import path from 'node:path';

import type {
  HistoricalLifecycleRuntimePathSet,
  PluginLocation,
  ProjectArtifactSharedLocator,
} from './types.js';
import {
  createInstallStateSlug,
  sha256Hex,
  stableStringify,
} from './internal.js';

export function serializePluginLocation(location: PluginLocation): string {
  return stableStringify({
    plugin: location.plugin,
    platform: location.platform,
    scope: location.scope,
    projectKey: location.projectKey ?? null,
  });
}

export function getPluginSlug(pluginName: string): string {
  return createInstallStateSlug(pluginName);
}

export function createRecordId(location: PluginLocation): string {
  return `${getPluginSlug(location.plugin)}.${sha256Hex(serializePluginLocation(location)).slice(0, 12)}`;
}

export function serializeProjectArtifactSharedLocator(
  locator: ProjectArtifactSharedLocator,
): string {
  return stableStringify(locator);
}

export function createSharedIdentityId(locator: ProjectArtifactSharedLocator): string {
  return `${getPluginSlug(locator.plugin)}.${sha256Hex(serializeProjectArtifactSharedLocator(locator)).slice(0, 12)}`;
}

export function createHistoricalLifecycleScopeKey(
  location: PluginLocation,
): string {
  if (location.scope === 'user') {
    return 'user';
  }

  return `project.${sha256Hex(location.projectKey ?? '').slice(0, 16)}`;
}

export function createLifecycleRuntimeId(options: {
  manifestDigest: string;
  bundleFingerprint: string;
  nonce: string;
}): string {
  return sha256Hex([
    options.manifestDigest,
    options.bundleFingerprint,
    options.nonce,
  ].join('\0')).slice(0, 16);
}

export function createHistoricalLifecycleRuntimePathSet(options: {
  location: PluginLocation;
  recordId: string;
  manifestDigest: string;
  bundleFingerprint: string;
  nonce: string;
  runtimeRootBase: string;
  manifestRelativePath?: string;
}): HistoricalLifecycleRuntimePathSet {
  const scopeKey = createHistoricalLifecycleScopeKey(options.location);
  const runtimeId = createLifecycleRuntimeId({
    manifestDigest: options.manifestDigest,
    bundleFingerprint: options.bundleFingerprint,
    nonce: options.nonce,
  });
  const runtimeRoot = options.runtimeRootBase;
  const bundleRoot = path.join(runtimeRoot, 'bundle');
  const manifestPath = path.join(bundleRoot, options.manifestRelativePath ?? 'plugin.json');

  return {
    scopeKey,
    runtimeId,
    runtimeRoot,
    bundleRoot,
    manifestPath,
  };
}
