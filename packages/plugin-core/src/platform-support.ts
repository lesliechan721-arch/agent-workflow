import type {
  PlatformName,
  PlatformTarget,
  PluginManifestSource,
  PluginMeta,
  PortablePlatformTarget,
  SupportedPlatformSet,
} from './types.js';

export const PLATFORM_TARGETS = [
  'codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'gemini', 'copilot', 'grok', 'generic',
] as const satisfies readonly PlatformTarget[];

export const NATIVE_PLATFORM_TARGETS = ['codex', 'claude', 'antigravity', 'cursor', 'opencode', 'pi', 'gemini', 'copilot', 'grok'] as const satisfies readonly PlatformName[];
export const PORTABLE_PLATFORM_TARGETS = ['generic'] as const satisfies readonly PortablePlatformTarget[];

export function isPlatformTarget(value: unknown): value is PlatformTarget {
  return typeof value === 'string' && (PLATFORM_TARGETS as readonly string[]).includes(value);
}

export function isPortablePlatformTarget(value: unknown): value is PortablePlatformTarget {
  return typeof value === 'string' && (PORTABLE_PLATFORM_TARGETS as readonly string[]).includes(value);
}

export function normalizePlatformTargets(value: unknown, fieldName = 'platforms'): PlatformTarget[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${fieldName}: expected a platform target array.`);
  const result: PlatformTarget[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isPlatformTarget(entry)) {
      throw new Error(`Invalid ${fieldName}[${index}]: expected one of ${PLATFORM_TARGETS.join(', ')}.`);
    }
    if (result.includes(entry)) throw new Error(`Invalid ${fieldName}: duplicate platform target ${JSON.stringify(entry)}.`);
    result.push(entry);
  }
  return result;
}

export function normalizeMarketplaceProductToken(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

export function resolveSupportedPlatforms(
  manifest: Pick<PluginManifestSource | PluginMeta['manifest'], 'platforms'>,
): SupportedPlatformSet {
  const targets = manifest.platforms === undefined ? [] : normalizePlatformTargets(manifest.platforms);
  return new Set(targets.length === 0 ? PLATFORM_TARGETS : targets);
}

export function resolveSupportedNativePlatforms(
  manifest: Pick<PluginManifestSource | PluginMeta['manifest'], 'platforms'>,
): ReadonlySet<PlatformName> {
  const supported = resolveSupportedPlatforms(manifest);
  return new Set(NATIVE_PLATFORM_TARGETS.filter((platform) => supported.has(platform)));
}

export function supportsPlatform(
  manifest: Pick<PluginManifestSource | PluginMeta['manifest'], 'platforms'>,
  platform: PlatformTarget,
): boolean {
  return resolveSupportedPlatforms(manifest).has(platform);
}

export function formatSupportedPlatforms(platforms: SupportedPlatformSet): string {
  const ordered = PLATFORM_TARGETS.filter((platform) => platforms.has(platform));
  return ordered.length > 0 ? ordered.join(' + ') : 'none';
}

export function formatManifestPlatformsForError(
  manifest: Pick<PluginManifestSource | PluginMeta['manifest'], 'platforms'>,
): string {
  return `platforms=[${[...resolveSupportedPlatforms(manifest)].join(', ')}]`;
}

export function assertPluginDependencyPlatformCoverage(options: {
  source: string;
  consumer: Pick<PluginManifestSource | PluginMeta['manifest'], 'name' | 'platforms'>;
  dependency: Pick<PluginManifestSource | PluginMeta['manifest'], 'name' | 'platforms'>;
  path?: readonly string[];
}): void {
  const consumerPlatforms = resolveSupportedPlatforms(options.consumer);
  const dependencyPlatforms = resolveSupportedPlatforms(options.dependency);
  const missing = PLATFORM_TARGETS.filter((target) => consumerPlatforms.has(target) && !dependencyPlatforms.has(target));
  if (missing.length === 0) return;
  const dependencyPath = options.path ?? [options.consumer.name, options.dependency.name];
  throw new Error(
    `dependencyPlatformCoverage: source ${JSON.stringify(options.source)}, consumer ${JSON.stringify(options.consumer.name)}, dependency ${JSON.stringify(options.dependency.name)} lacks platforms [${missing.join(', ')}]; path: ${dependencyPath.join(' -> ')}.`,
  );
}
