import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveClaudeCatalogCompatibility } from '../../src/adapters/claude.js';
import {
  detectClaudeExternalOwnership,
  detectCodexExternalOwnership,
  resolveClaudePlatformNativeFallbackEvidence,
  resolveClaudePlatformRuntimeEvidence,
} from '../../src/adapters/helpers.js';
import {
  hasRepoManagedArtifacts,
  requiresNativePlugin,
  resolveCodexCatalogCompatibility,
} from '../../src/adapters/codex.js';
import type { PluginMeta } from '../../src/types.js';

const tempDirs: string[] = [];

function makePluginMeta(overrides: Partial<PluginMeta['manifest']>): PluginMeta {
  return {
    rootDir: '/tmp/plugin',
    manifestPath: '/tmp/plugin/.agents-plugin/plugin.json',
    manifest: {
      name: 'git-commit',
      version: '0.1.0',
      description: 'test plugin',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
      },
      ...overrides,
    },
  };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('adapter status helpers', () => {
  it('resolves Claude runtime and native fallback evidence with scope-sensitive project matching', async () => {
    const installLocation = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-claude-runtime-'));
    tempDirs.push(installLocation);

    await fs.ensureDir(path.join(installLocation, '.claude-plugin'));
    await fs.ensureDir(path.join(installLocation, 'plugins', 'git-commit'));
    await fs.writeJson(path.join(installLocation, '.claude-plugin', 'marketplace.json'), {
      name: 'aw',
      plugins: [
        {
          name: 'git-commit',
          source: './plugins/git-commit',
        },
      ],
    }, { spaces: 2 });

    const settings = {
      extraKnownMarketplaces: {
        aw: {
          source: installLocation,
        },
      },
      plugins: {
        installed: {
          'git-commit': {
            marketplace: 'aw',
            version: '0.1.0',
            installedAt: '2026-04-25T00:00:00.000Z',
            scope: 'project' as const,
            projectPath: '/repo/project-a',
          },
        },
      },
    };
    const installedPlugins = {
      plugins: {
        'git-commit@aw': [
          {
            name: 'git-commit',
            marketplace: 'aw',
            scope: 'project' as const,
            projectPath: '/repo/project-a',
            version: '0.1.0',
          },
        ],
      },
    };

    await expect(
      resolveClaudePlatformRuntimeEvidence(
        settings,
        installedPlugins,
        {
          installLocation,
        },
        'git-commit',
        'aw',
        'project',
        '/repo/project-a',
      ),
    ).resolves.toMatchObject({
      present: true,
      activeLocalBundle: path.join(installLocation, 'plugins', 'git-commit'),
    });

    expect(
      resolveClaudePlatformNativeFallbackEvidence(
        settings,
        installedPlugins,
        'git-commit',
        'aw',
        'project',
        '/repo/project-b',
      ),
    ).toMatchObject({
      present: false,
    });
  });

  it('detects external ownership and resolves catalog compatibility for Claude/Codex', () => {
    expect(
      detectClaudeExternalOwnership(
        {
          plugins: {
            installed: {
              'git-commit': {
                marketplace: 'third-party',
                version: '1.0.0',
                installedAt: '2026-04-25T00:00:00.000Z',
              },
            },
          },
        },
        { plugins: {} },
        'git-commit',
        'aw',
        'user',
      ),
    ).toMatchObject({
      present: true,
      marketplace: 'third-party',
    });

    expect(
      detectCodexExternalOwnership(
        {
          'git-commit@third-party': {
            enabled: true,
          },
        },
        'git-commit',
        'aw',
      ),
    ).toMatchObject({
      present: true,
      marketplace: 'third-party',
    });

    expect(
      resolveClaudeCatalogCompatibility({
        currentManifestPresent: true,
        currentManagedExtensions: ['instructions', 'permissions'],
        currentScopeManagedEvidence: true,
        platformRuntimeEvidence: false,
        platformNativeFallbackEvidence: false,
        installedCapabilitySnapshot: {
          managedExtensions: ['permissions', 'instructions'],
        },
      }),
    ).toBe('current');
    expect(
      resolveClaudeCatalogCompatibility({
        currentManifestPresent: true,
        currentManagedExtensions: ['instructions'],
        currentScopeManagedEvidence: true,
        platformRuntimeEvidence: false,
        platformNativeFallbackEvidence: false,
        installedCapabilitySnapshot: {
          managedExtensions: ['permissions', 'instructions'],
        },
      }),
    ).toBe('capabilityChanged');
    expect(
      resolveClaudeCatalogCompatibility({
        currentManifestPresent: false,
        currentManagedExtensions: [],
        currentScopeManagedEvidence: false,
        platformRuntimeEvidence: true,
        platformNativeFallbackEvidence: false,
      }),
    ).toBe('missing');

    const nativeOnlyPlugin = makePluginMeta({
      skills: './skills',
    });
    const hybridPlugin = makePluginMeta({
      skills: './skills',
      extensions: {
        instructions: [
          {
            name: 'commit-policy',
            title: '提交规范',
            content: '保持提交规范。',
          },
        ],
      },
    });

    expect(requiresNativePlugin(nativeOnlyPlugin)).toBe(true);
    expect(hasRepoManagedArtifacts(nativeOnlyPlugin)).toBe(false);
    expect(requiresNativePlugin(hybridPlugin)).toBe(true);
    expect(hasRepoManagedArtifacts(hybridPlugin)).toBe(true);

    expect(
      resolveCodexCatalogCompatibility({
        currentManifestPresent: true,
        currentScopeManagedEvidence: true,
        platformNativeFallbackEvidence: false,
        currentCapabilities: {
          requiresNativePlugin: true,
          hasRepoManagedArtifacts: true,
        },
        installedCapabilitySnapshot: {
          requiresNativePlugin: true,
          hasRepoManagedArtifacts: true,
        },
      }),
    ).toBe('current');
    expect(
      resolveCodexCatalogCompatibility({
        currentManifestPresent: true,
        currentScopeManagedEvidence: true,
        platformNativeFallbackEvidence: false,
        currentCapabilities: {
          requiresNativePlugin: false,
          hasRepoManagedArtifacts: true,
        },
        installedCapabilitySnapshot: {
          requiresNativePlugin: true,
          hasRepoManagedArtifacts: true,
        },
      }),
    ).toBe('capabilityChanged');
    expect(
      resolveCodexCatalogCompatibility({
        currentManifestPresent: false,
        currentScopeManagedEvidence: false,
        platformNativeFallbackEvidence: true,
        currentCapabilities: {},
      }),
    ).toBe('missing');
  });
});
