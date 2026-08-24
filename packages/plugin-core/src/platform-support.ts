import type {
  PlatformName,
  PluginManifestSource,
  PluginMeta,
  SupportedPlatformSet,
} from './types.js';

const DEFAULT_SUPPORTED_PLATFORMS: readonly PlatformName[] = ['claude', 'codex'];
const PRODUCT_TOKEN_TO_PLATFORM: Readonly<Record<string, PlatformName>> = {
  CLAUDE: 'claude',
  CODEX: 'codex',
};

export function normalizeMarketplaceProductToken(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

export function resolveSupportedPlatforms(
  manifest: PluginManifestSource | PluginMeta['manifest'],
): SupportedPlatformSet {
  const products = manifest.marketplace.policy.products;
  if (!products || products.length === 0) {
    return new Set(DEFAULT_SUPPORTED_PLATFORMS);
  }

  const supported = new Set<PlatformName>();
  for (const product of products) {
    const platform = PRODUCT_TOKEN_TO_PLATFORM[normalizeMarketplaceProductToken(product)];
    if (platform) {
      supported.add(platform);
    }
  }

  return supported;
}

export function supportsPlatform(
  manifest: PluginManifestSource | PluginMeta['manifest'],
  platform: PlatformName,
): boolean {
  return resolveSupportedPlatforms(manifest).has(platform);
}

export function formatSupportedPlatforms(platforms: SupportedPlatformSet): string {
  const ordered = DEFAULT_SUPPORTED_PLATFORMS.filter((platform) => platforms.has(platform));
  return ordered.length > 0 ? ordered.join(' + ') : 'none';
}

export function formatMarketplaceProductsForError(
  manifest: PluginManifestSource | PluginMeta['manifest'],
): string {
  const products = manifest.marketplace.policy.products;
  if (!products || products.length === 0) {
    return 'marketplace.policy.products=[]';
  }

  const normalized = [...new Set(products.map((product) => normalizeMarketplaceProductToken(product)))];
  return `marketplace.policy.products=[${normalized.join(', ')}]`;
}
