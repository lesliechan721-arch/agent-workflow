import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as commonModule from '../../src/commands/common.js';
import { uninstallCommand, uninstallTargetsOnPlatforms } from '../../src/commands/uninstall.js';
import * as localMarketplaceModule from '../../src/utils/local-marketplace.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { resolveCodexPaths } from '../../src/utils/paths.js';
import { readTrackingManifest, upsertTrackingRecord } from '../../src/utils/tracking.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginStatusReport,
  Scope,
  StatusReport,
} from '../../src/types.js';
import type { ResolvedPluginTarget } from '../../src/commands/common.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{ repoRoot: string; env: NodeJS.ProcessEnv }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-uninstall-command-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);

  return {
    repoRoot,
    env: {
      ...process.env,
      AW_HOME: path.join(root, 'aw-home'),
      AW_CODEX_HOME: path.join(root, 'codex-home'),
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
    },
  };
}

function makePluginStatus(
  pluginName: string,
  overrides: Partial<PluginStatusReport> = {},
): PluginStatusReport {
  return {
    pluginName,
    native: {
      marketplaceRegistered: false,
      pluginAvailable: true,
      pluginInstalled: false,
      version: '0.1.0',
    },
    generatedArtifacts: [],
    driftWarnings: [],
    scopeInitialized: 'no',
    platformRuntimeEvidence: {
      present: false,
    },
    platformNativeFallbackEvidence: {
      present: false,
    },
    scopeManagedEvidence: {
      ledger: false,
      tracking: false,
      sharedNativeRef: false,
    },
    currentCatalog: {
      rootDir: '/synthetic',
      source: 'embedded',
      available: true,
    },
    artifactsInitialized: true,
    repoManagedSessionState: {
      instructions: 'not_applicable',
      rules: 'not_applicable',
      hooks: 'not_applicable',
      agents: 'not_applicable',
      diagnostics: [],
    },
    projectTrust: 'not_applicable',
    ...overrides,
  };
}

function makeStatusReport(
  platform: PlatformName,
  scope: Scope,
  plugins: PluginStatusReport[],
): StatusReport {
  return {
    platform,
    scope,
    initialized: plugins.some((plugin) =>
      plugin.scopeManagedEvidence?.ledger ||
      plugin.scopeManagedEvidence?.tracking ||
      plugin.scopeManagedEvidence?.sharedNativeRef ||
      plugin.platformRuntimeEvidence?.present ||
      plugin.platformNativeFallbackEvidence?.present,
    ),
    plugins,
  };
}

class FakeAdapter implements PlatformAdapter {
  readonly uninstallPluginCalls: string[] = [];
  readonly uninstallExtensionsCalls: string[] = [];
  readonly reinstallExtensionsCalls: string[] = [];
  private statusIndex = 0;

  constructor(
    readonly name: PlatformName,
    private readonly statusSequence: StatusReport[],
    private readonly options: {
      uninstallExtensionsError?: string;
    } = {},
  ) {}

  async detect(_cwd: string): Promise<boolean> {
    return true;
  }

  async installPlugin(): Promise<void> {}

  async uninstallPlugin(plugin: { manifest: { name: string } }): Promise<void> {
    this.uninstallPluginCalls.push(plugin.manifest.name);
  }

  async installExtensions(plugin: { manifest: { name: string } }): Promise<GeneratedArtifact[]> {
    this.reinstallExtensionsCalls.push(plugin.manifest.name);
    return [];
  }

  async uninstallExtensions(plugin: { manifest: { name: string } }): Promise<void> {
    this.uninstallExtensionsCalls.push(plugin.manifest.name);
    if (this.options.uninstallExtensionsError) {
      throw new Error(this.options.uninstallExtensionsError);
    }
  }

  async upgradePlugin(): Promise<void> {}

  async status(): Promise<StatusReport> {
    const index = Math.min(this.statusIndex, this.statusSequence.length - 1);
    this.statusIndex += 1;
    return this.statusSequence[index];
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('uninstall command coverage', () => {
  it('rejects empty uninstall invocations', async () => {
    await expect(
      uninstallCommand([], {
        cwd: '/tmp/repo',
        scope: 'project',
        platform: 'codex',
      }),
    ).rejects.toThrow('uninstall 命令至少需要一个插件名。');
  });

  it('uses default adapters when runtime is omitted and skips missing plugin reports', async () => {
    const { repoRoot } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const target: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      source: 'currentCatalog',
    };

    const codex = new FakeAdapter('codex', [
      makeStatusReport('codex', 'project', []),
    ]);
    vi.spyOn(commonModule, 'createAdapters').mockReturnValue({
      codex,
      claude: new FakeAdapter('claude', [
        makeStatusReport('claude', 'project', []),
      ]),
    });

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
      ),
    ).resolves.toEqual({
      warnings: [],
    });
  });

  it('rejects external ownership, historical misses, and fallback-only cleanup requests', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const currentTarget: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      source: 'currentCatalog',
    };
    const historicalTarget: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: undefined,
      source: 'historical',
    };

    await expect(
      uninstallTargetsOnPlatforms(
        [currentTarget],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', [
              makeStatusReport('codex', 'project', [
                makePluginStatus(plugin.manifest.name, {
                  externalOwnership: {
                    present: true,
                    marketplace: 'third-party',
                    details: 'third-party owns this plugin',
                  },
                }),
              ]),
            ]),
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          env,
        },
      ),
    ).rejects.toThrow('third-party owns this plugin');

    await expect(
      uninstallTargetsOnPlatforms(
        [historicalTarget],
        ['claude'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'claude',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', [makeStatusReport('codex', 'project', [])]),
            claude: new FakeAdapter('claude', [
              makeStatusReport('claude', 'project', [
                makePluginStatus(plugin.manifest.name),
              ]),
            ]),
          },
          env,
        },
      ),
    ).rejects.toThrow(`Unknown plugin "${plugin.manifest.name}".`);

    await expect(
      uninstallTargetsOnPlatforms(
        [historicalTarget],
        ['claude'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'claude',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', [makeStatusReport('codex', 'project', [])]),
            claude: new FakeAdapter('claude', [
              makeStatusReport('claude', 'project', [
                makePluginStatus(plugin.manifest.name, {
                  platformRuntimeEvidence: {
                    present: true,
                  },
                }),
              ]),
            ]),
          },
          env,
        },
      ),
    ).rejects.toThrow('当前只剩原生 loader 仍会读取该插件的证据');

    await expect(
      uninstallTargetsOnPlatforms(
        [historicalTarget],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', [
              makeStatusReport('codex', 'project', [
                makePluginStatus(plugin.manifest.name, {
                  platformNativeFallbackEvidence: {
                    present: true,
                  },
                }),
              ]),
            ]),
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          env,
        },
      ),
    ).rejects.toThrow('当前只剩 Codex user native fallback evidence');
  });

  it('warns when the current scope is unmanaged and preserves available ledgers on successful uninstall', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const target: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      source: 'currentCatalog',
    };

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', [
              makeStatusReport('codex', 'project', [
                makePluginStatus(plugin.manifest.name),
              ]),
            ]),
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          env,
        },
      ),
    ).resolves.toEqual({
      warnings: [`[codex/${plugin.manifest.name}] 当前 scope 未受管，无需卸载。`],
    });

    await localMarketplaceModule.writeInstalledLedger(
      localMarketplaceModule.createAvailableLedger(),
      env,
    );
    const trackingDir = resolveCodexPaths(repoRoot, 'project', env).trackingDir;
    await upsertTrackingRecord(trackingDir, plugin.manifest.name, [
      {
        path: path.join(trackingDir, 'git-commit.rule'),
        kind: 'instruction',
        platform: 'codex',
      },
    ]);

    const codex = new FakeAdapter('codex', [
      makeStatusReport('codex', 'project', [
        makePluginStatus(plugin.manifest.name, {
          scopeInitialized: 'yes',
          scopeManagedEvidence: {
            ledger: true,
            tracking: true,
            sharedNativeRef: false,
          },
        }),
      ]),
      makeStatusReport('codex', 'project', [
        makePluginStatus(plugin.manifest.name, {
          scopeInitialized: 'no',
          driftWarnings: ['post-uninstall drift'],
        }),
      ]),
    ]);

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          env,
        },
      ),
    ).resolves.toEqual({
      warnings: [`[codex/${plugin.manifest.name}] post-uninstall drift`],
    });

    expect(codex.uninstallPluginCalls).toEqual([plugin.manifest.name]);
    expect(codex.uninstallExtensionsCalls).toEqual([plugin.manifest.name]);
    await expect(readTrackingManifest(trackingDir)).resolves.toMatchObject({
      plugins: {},
    });
    await expect(localMarketplaceModule.readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'available',
        reason: null,
      },
    });
  });

  it('restores tracking state, rolls artifacts back, and degrades the ledger when uninstall bookkeeping fails', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const target: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      source: 'currentCatalog',
    };
    const trackingDir = resolveCodexPaths(repoRoot, 'project', env).trackingDir;
    const baselineArtifactPath = path.join(trackingDir, 'git-commit.rule');

    await localMarketplaceModule.writeInstalledLedger(
      localMarketplaceModule.createAvailableLedger(),
      env,
    );
    await upsertTrackingRecord(trackingDir, plugin.manifest.name, [
      {
        path: baselineArtifactPath,
        kind: 'instruction',
        platform: 'codex',
      },
    ]);

    const codex = new FakeAdapter('codex', [
      makeStatusReport('codex', 'project', [
        makePluginStatus(plugin.manifest.name, {
          scopeInitialized: 'yes',
          scopeManagedEvidence: {
            ledger: true,
            tracking: true,
            sharedNativeRef: false,
          },
        }),
      ]),
    ]);

    const writeInstalledLedgerImpl = localMarketplaceModule.writeInstalledLedger;
    vi.spyOn(localMarketplaceModule, 'writeInstalledLedger')
      .mockImplementationOnce(async () => {
        throw new Error('ledger boom');
      })
      .mockImplementation((ledger, nextEnv) => writeInstalledLedgerImpl(ledger, nextEnv));

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          env,
        },
      ),
    ).rejects.toThrow('ledger boom');

    expect(codex.reinstallExtensionsCalls).toEqual([plugin.manifest.name]);
    await expect(readTrackingManifest(trackingDir)).resolves.toMatchObject({
      plugins: {
        'git-commit': {
          artifacts: [
            {
              path: baselineArtifactPath,
            },
          ],
        },
      },
    });
    await expect(localMarketplaceModule.readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'operation_interrupted_after_artifact_write',
      },
    });
  });

  it('rolls artifacts back when uninstallExtensions fails after artifact cleanup started', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const target: ResolvedPluginTarget = {
      pluginName: plugin.manifest.name,
      plugin,
      currentPlugin: plugin,
      source: 'currentCatalog',
    };
    const trackingDir = resolveCodexPaths(repoRoot, 'project', env).trackingDir;
    const baselineArtifactPath = path.join(trackingDir, 'git-commit.rule');

    await localMarketplaceModule.writeInstalledLedger(
      localMarketplaceModule.createAvailableLedger(),
      env,
    );
    await upsertTrackingRecord(trackingDir, plugin.manifest.name, [
      {
        path: baselineArtifactPath,
        kind: 'instruction',
        platform: 'codex',
      },
    ]);

    const codex = new FakeAdapter(
      'codex',
      [
        makeStatusReport('codex', 'project', [
          makePluginStatus(plugin.manifest.name, {
            scopeInitialized: 'yes',
            scopeManagedEvidence: {
              ledger: true,
              tracking: true,
              sharedNativeRef: false,
            },
          }),
        ]),
      ],
      {
        uninstallExtensionsError: 'artifact cleanup boom',
      },
    );

    await expect(
      uninstallTargetsOnPlatforms(
        [target],
        ['codex'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex,
            claude: new FakeAdapter('claude', [makeStatusReport('claude', 'project', [])]),
          },
          env,
        },
      ),
    ).rejects.toThrow('artifact cleanup boom');

    expect(codex.reinstallExtensionsCalls).toEqual([plugin.manifest.name]);
    await expect(readTrackingManifest(trackingDir)).resolves.toMatchObject({
      plugins: {
        'git-commit': {
          artifacts: [
            {
              path: baselineArtifactPath,
            },
          ],
        },
      },
    });
    await expect(localMarketplaceModule.readInstalledLedger(env)).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'operation_interrupted_after_artifact_write',
      },
    });
  });
});
