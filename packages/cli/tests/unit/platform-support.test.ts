import { describe, expect, it } from 'vitest';

import {
  assertPluginsSupportPlatforms,
  pluginSupportsPlatform,
} from '../../src/commands/common.js';
import type { PlatformName, PluginManifestSource, PluginMeta } from '../../src/types.js';
import {
  formatMarketplaceProductsForError,
  formatSupportedPlatforms,
  resolveSupportedPlatforms,
  supportsPlatform,
} from '../../src/utils/platform-support.js';

function createManifest(products?: string[]): PluginManifestSource {
  return {
    name: 'demo-plugin',
    version: '1.0.0',
    description: 'demo plugin',
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        products,
      },
    },
  };
}

function createPlugin(products?: string[]): PluginMeta {
  return {
    rootDir: '/tmp/demo-plugin',
    manifestPath: '/tmp/demo-plugin/.agents-plugin/plugin.json',
    manifest: createManifest(products),
  };
}

function orderedPlatforms(manifest: PluginManifestSource): PlatformName[] {
  return (['claude', 'codex'] as const).filter((platform) =>
    resolveSupportedPlatforms(manifest).has(platform),
  );
}

describe('platform support helpers', () => {
  it('resolves omitted or empty products as dual-platform support', () => {
    expect(orderedPlatforms(createManifest())).toEqual(['claude', 'codex']);
    expect(orderedPlatforms(createManifest([]))).toEqual(['claude', 'codex']);
  });

  it('resolves CODEX, CLAUDE, and dual-platform declarations', () => {
    expect(orderedPlatforms(createManifest(['CODEX']))).toEqual(['codex']);
    expect(orderedPlatforms(createManifest(['CLAUDE']))).toEqual(['claude']);
    expect(orderedPlatforms(createManifest(['CODEX', 'CLAUDE']))).toEqual(['claude', 'codex']);
  });

  it('keeps token normalization behavior for case and whitespace', () => {
    const manifest = createManifest([' codex ', 'claude']);

    expect(orderedPlatforms(manifest)).toEqual(['claude', 'codex']);
    expect(supportsPlatform(manifest, 'codex')).toBe(true);
    expect(supportsPlatform(manifest, 'claude')).toBe(true);
  });

  it('formats supported platforms in a stable order', () => {
    expect(formatSupportedPlatforms(resolveSupportedPlatforms(createManifest(['CODEX'])))).toBe('codex');
    expect(formatSupportedPlatforms(resolveSupportedPlatforms(createManifest(['CLAUDE'])))).toBe('claude');
    expect(formatSupportedPlatforms(resolveSupportedPlatforms(createManifest()))).toBe('claude + codex');
  });

  it('formats marketplace.policy.products for errors with normalized tokens', () => {
    expect(formatMarketplaceProductsForError(createManifest([' codex ']))).toBe(
      'marketplace.policy.products=[CODEX]',
    );
    expect(formatMarketplaceProductsForError(createManifest(['co-dex']))).toBe(
      'marketplace.policy.products=[CO_DEX]',
    );
    expect(formatMarketplaceProductsForError(createManifest())).toBe(
      'marketplace.policy.products=[]',
    );
  });

  it('keeps pluginSupportsPlatform aligned with the shared helper', () => {
    const plugin = createPlugin(['CODEX']);

    expect(pluginSupportsPlatform(plugin, 'codex')).toBe(supportsPlatform(plugin.manifest, 'codex'));
    expect(pluginSupportsPlatform(plugin, 'claude')).toBe(supportsPlatform(plugin.manifest, 'claude'));
  });

  it('reports unsupported platforms with plugin name, raw products, and resolved support set', () => {
    const plugin = createPlugin(['CODEX']);

    expect(() => assertPluginsSupportPlatforms([plugin], ['claude'])).toThrow(
      '插件不支持目标平台：demo-plugin -> Claude Code (marketplace.policy.products=[CODEX], 实际支持平台=codex, 需要 CLAUDE)',
    );
  });
});
