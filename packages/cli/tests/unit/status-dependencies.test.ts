import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CommandAction,
  InstalledLedger,
  PlatformAdapter,
  PluginManifestSource,
  PluginMeta,
  PluginStatusReport,
  StatusReport,
} from '../../src/types.js';

const mockBuildCommandCandidates = vi.fn();
const mockReadInstalledLedger = vi.fn();
const mockResolveCatalogPlugins = vi.fn();
const mockDetectEnvironment = vi.fn();

vi.mock('../../src/commands/discovery.js', () => ({
  buildCommandCandidates: mockBuildCommandCandidates,
}));

vi.mock('../../src/utils/local-marketplace.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/local-marketplace.js')>(
    '../../src/utils/local-marketplace.js',
  );
  return {
    ...actual,
    readInstalledLedger: mockReadInstalledLedger,
  };
});

vi.mock('../../src/utils/plugin-catalog.js', () => ({
  resolveCatalogPlugins: mockResolveCatalogPlugins,
}));

vi.mock('../../src/utils/detect.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/detect.js')>(
    '../../src/utils/detect.js',
  );
  return {
    ...actual,
    detectEnvironment: mockDetectEnvironment,
  };
});

const { statusCommand } = await import('../../src/commands/status.js');

function manifest(
  name: string,
  options: {
    dependencies?: PluginManifestSource['dependencies'];
  } = {},
): PluginMeta {
  return {
    rootDir: `/catalog/${name}`,
    manifestPath: `/catalog/${name}/.agents-plugin/plugin.json`,
    manifest: {
      name,
      version: '1.0.0',
      description: `${name} plugin`,
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
        },
      },
      ...options,
    },
  };
}

function report(
  pluginName: string,
  overrides: Partial<PluginStatusReport> = {},
): PluginStatusReport {
  return {
    pluginName,
    native: {
      marketplaceRegistered: false,
      pluginAvailable: true,
      pluginInstalled: false,
      pluginEnabled: false,
      cacheStatus: 'missing',
    },
    generatedArtifacts: [],
    driftWarnings: [],
    ledgerStateStatus: 'available',
    ledgerStateReason: null,
    scopeInitialized: 'no',
    externalOwnership: {
      present: false,
      checkState: 'known',
    },
    projectTrust: 'not_applicable',
    scopeManagedEvidence: {
      ledger: false,
      tracking: false,
      sharedNativeRef: false,
    },
    repoManagedSessionState: {
      instructions: 'not_applicable',
      rules: 'not_applicable',
      hooks: 'not_applicable',
      agents: 'not_applicable',
      diagnostics: [],
      items: [],
    },
    currentCatalog: {
      rootDir: `/catalog/${pluginName}`,
      source: 'local',
      available: true,
    },
    artifactsInitialized: true,
    ...overrides,
  };
}

function status(plugin: PluginStatusReport): StatusReport {
  return {
    platform: 'codex',
    scope: 'user',
    initialized: true,
    scopeInitialized: plugin.scopeInitialized,
    plugins: [plugin],
  };
}

function candidate(options: {
  plugin: PluginMeta;
  evidenceSources?: string[];
  action?: CommandAction;
}) {
  return {
    id: `status:${options.plugin.manifest.name}:codex:user:user`,
    command: options.action ?? 'status',
    pluginName: options.plugin.manifest.name,
    platform: 'codex',
    scope: 'user',
    executionCwd: '/workspace',
    projectKey: undefined,
    projectRoot: undefined,
    target: {
      pluginName: options.plugin.manifest.name,
      plugin: options.plugin,
      currentPlugin: options.plugin,
      source: 'currentCatalog' as const,
    },
    selectable: true,
    evidence: {
      platform: 'codex',
      scope: 'user',
      executionCwd: '/workspace',
      sources: options.evidenceSources ?? ['ledger'],
      trackingKinds: [],
      trackingIntegrityErrors: [],
      trackingHasHookIdentities: false,
      ledgerManaged: true,
      ledgerStateStatus: 'available' as const,
      ledgerStateReason: null,
      readErrors: [],
    },
    evidenceByPlatformScope: {
      'codex:user': {
        platform: 'codex',
        scope: 'user',
        executionCwd: '/workspace',
        sources: options.evidenceSources ?? ['ledger'],
        trackingKinds: [],
        trackingIntegrityErrors: [],
        trackingHasHookIdentities: false,
        ledgerManaged: true,
        ledgerStateStatus: 'available' as const,
        ledgerStateReason: null,
        readErrors: [],
      },
    },
  };
}

describe('status dependencies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectEnvironment.mockResolvedValue({
      codex: { available: true, scopes: ['user', 'project'] },
      claude: { available: true, scopes: ['user', 'project'] },
    });
  });

  it('emits stable dependencies JSON and downgrades a healthy parent when the effective dependency is missing', async () => {
    const parent = manifest('parent-plugin', {
      dependencies: {
        plugins: [
          { name: 'child-plugin' },
          { name: 'claude-helper', when: { platforms: ['claude'] } },
        ],
      },
    });
    const child = manifest('child-plugin');
    const claudeHelper = manifest('claude-helper');
    const parentCandidate = candidate({ plugin: parent });

    mockResolveCatalogPlugins.mockResolvedValue({
      catalog: { rootDir: '/catalog', source: 'local' },
      plugins: [parent, child, claudeHelper],
    });
    mockReadInstalledLedger.mockResolvedValue({
      version: 1,
      ledgerState: {
        status: 'available',
        degradedAt: null,
        reason: null,
      },
      plugins: {
        'parent-plugin': {
          lastResolvedVersion: '1.0.0',
          platforms: {
            codex: {
              userScope: {
                managed: true,
                updatedAt: '2026-05-06T00:00:00.000Z',
                resolvedVersion: '1.0.0',
                capabilitySnapshot: {},
                installSource: {
                  kind: 'explicit',
                  explicitlyRequested: true,
                  allowsUnusedCleanup: false,
                },
                dependencyEdges: [],
              },
            },
          },
        },
      },
    } satisfies InstalledLedger);
    mockBuildCommandCandidates.mockImplementation(async (options: { pluginNames?: string[] }) =>
      options.pluginNames ? [parentCandidate] : [parentCandidate],
    );

    const adapters: Record<'codex' | 'claude', PlatformAdapter> = {
      codex: {
        name: 'codex',
        detect: vi.fn(),
        installPlugin: vi.fn(),
        uninstallPlugin: vi.fn(),
        installExtensions: vi.fn(),
        uninstallExtensions: vi.fn(),
        upgradePlugin: vi.fn(),
        status: vi.fn(async () => status(report('parent-plugin', {
          native: {
            marketplaceRegistered: false,
            pluginAvailable: true,
            pluginInstalled: true,
            pluginEnabled: true,
            cacheStatus: 'missing',
          },
          generatedArtifacts: [{ path: '/workspace/.agents/skills/parent', exists: true, kind: 'skill', platform: 'codex' }],
          scopeInitialized: 'yes',
          scopeManagedEvidence: {
            ledger: true,
            tracking: true,
            sharedNativeRef: false,
          },
        }))),
      } as unknown as PlatformAdapter,
      claude: {
        name: 'claude',
        detect: vi.fn(),
        installPlugin: vi.fn(),
        uninstallPlugin: vi.fn(),
        installExtensions: vi.fn(),
        uninstallExtensions: vi.fn(),
        upgradePlugin: vi.fn(),
        status: vi.fn(),
      } as unknown as PlatformAdapter,
    };

    const result = await statusCommand(['parent-plugin'], {
      cwd: '/workspace',
      platform: 'codex',
      scope: 'user',
      json: true,
    }, {
      adapters,
      env: process.env,
    });
    const payload = JSON.parse(result.output) as {
      cells: Array<{ health: string }>;
      reports: Array<{ plugins: PluginStatusReport[] }>;
    };
    const plugin = payload.reports[0]?.plugins[0];

    expect(payload.cells[0]?.health).toBe('needsAttention');
    expect(plugin.dependencies).toMatchObject({
      healthSource: 'currentCatalog',
      declared: [
        { name: 'child-plugin' },
        { name: 'claude-helper', when: { platforms: ['claude'] } },
      ],
      resolved: [
        { declaration: { name: 'child-plugin' }, source: 'currentCatalog' },
      ],
      satisfied: [],
      missing: [
        {
          declaration: { name: 'child-plugin' },
        },
      ],
      dependents: [],
      autoInstalled: false,
      autoRemovable: false,
      catalogDrift: {
        kind: 'snapshotMissing',
        snapshotDependencies: [],
        currentDependencies: ['child-plugin', 'claude-helper'],
      },
    });
    expect(plugin.dependencies?.missing[0]?.reason).toContain('当前可见位置');
  });

  it('keeps ready when only an inactive-platform dependency entry exists', async () => {
    const parent = manifest('platform-parent', {
      dependencies: {
        plugins: [
          { name: 'claude-helper', when: { platforms: ['claude'] } },
        ],
      },
    });
    const claudeHelper = manifest('claude-helper');
    const parentCandidate = candidate({ plugin: parent });

    mockResolveCatalogPlugins.mockResolvedValue({
      catalog: { rootDir: '/catalog', source: 'local' },
      plugins: [parent, claudeHelper],
    });
    mockReadInstalledLedger.mockResolvedValue({
      version: 1,
      ledgerState: {
        status: 'available',
        degradedAt: null,
        reason: null,
      },
      plugins: {
        'platform-parent': {
          lastResolvedVersion: '1.0.0',
          platforms: {
            codex: {
              userScope: {
                managed: true,
                updatedAt: '2026-05-06T00:00:00.000Z',
                resolvedVersion: '1.0.0',
                capabilitySnapshot: {},
                installSource: {
                  kind: 'explicit',
                  explicitlyRequested: true,
                  allowsUnusedCleanup: false,
                },
                dependencyEdges: [],
              },
            },
          },
        },
      },
    } satisfies InstalledLedger);
    mockBuildCommandCandidates.mockImplementation(async (options: { pluginNames?: string[] }) =>
      options.pluginNames ? [parentCandidate] : [parentCandidate],
    );

    const adapters: Record<'codex' | 'claude', PlatformAdapter> = {
      codex: {
        name: 'codex',
        detect: vi.fn(),
        installPlugin: vi.fn(),
        uninstallPlugin: vi.fn(),
        installExtensions: vi.fn(),
        uninstallExtensions: vi.fn(),
        upgradePlugin: vi.fn(),
        status: vi.fn(async () => status(report('platform-parent', {
          native: {
            marketplaceRegistered: false,
            pluginAvailable: true,
            pluginInstalled: true,
            pluginEnabled: true,
            cacheStatus: 'missing',
          },
          generatedArtifacts: [{ path: '/workspace/.agents/skills/platform-parent', exists: true, kind: 'skill', platform: 'codex' }],
          scopeInitialized: 'yes',
          scopeManagedEvidence: {
            ledger: true,
            tracking: true,
            sharedNativeRef: false,
          },
        }))),
      } as unknown as PlatformAdapter,
      claude: {
        name: 'claude',
        detect: vi.fn(),
        installPlugin: vi.fn(),
        uninstallPlugin: vi.fn(),
        installExtensions: vi.fn(),
        uninstallExtensions: vi.fn(),
        upgradePlugin: vi.fn(),
        status: vi.fn(),
      } as unknown as PlatformAdapter,
    };

    const result = await statusCommand(['platform-parent'], {
      cwd: '/workspace',
      platform: 'codex',
      scope: 'user',
      json: true,
    }, {
      adapters,
      env: process.env,
    });
    const payload = JSON.parse(result.output) as {
      cells: Array<{ health: string }>;
      reports: Array<{ plugins: PluginStatusReport[] }>;
    };
    const plugin = payload.reports[0]?.plugins[0];

    expect(payload.cells[0]?.health).toBe('ready');
    expect(plugin.dependencies).toMatchObject({
      declared: [
        { name: 'claude-helper', when: { platforms: ['claude'] } },
      ],
      resolved: [],
      satisfied: [],
      missing: [],
    });
  });
});
