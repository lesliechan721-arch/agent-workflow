import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { CodexAdapter } from '../../src/adapters/codex.js';
import { initCommand } from '../../src/commands/init.js';
import { installCommand } from '../../src/commands/install.js';
import { statusCommand } from '../../src/commands/status.js';
import { uninstallCommand } from '../../src/commands/uninstall.js';
import { upgradeCommand } from '../../src/commands/upgrade.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  StatusReport,
} from '../../src/types.js';
import { resolveCodexProjectKey, setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';

const tempDirs: string[] = [];

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeWorkspace(): Promise<{ repoRoot: string; awHome: string; embeddedRoot: string; codexHome: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  if (await fs.pathExists(path.join(repoRoot, '.codex'))) {
    await fs.chmod(path.join(repoRoot, '.codex'), 0o700).catch(() => undefined);
  }
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);

  return {
    repoRoot,
    awHome: path.join(root, 'aw-home'),
    embeddedRoot,
    codexHome: path.join(root, 'codex-home'),
  };
}

async function makeWorkspaceWithMutator(
  mutateRepo: (repoRoot: string) => Promise<void>,
): Promise<{ repoRoot: string; awHome: string; embeddedRoot: string; codexHome: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-'));
  tempDirs.push(root);

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  await mutateRepo(repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);

  return {
    repoRoot,
    awHome: path.join(root, 'aw-home'),
    embeddedRoot,
    codexHome: path.join(root, 'codex-home'),
  };
}

interface FakePluginState {
  scopeInitialized?: 'yes' | 'no' | 'unknown';
  currentCatalogAvailable?: boolean;
  nativeInstalled?: boolean;
  marketplaceRegistered?: boolean;
  runtimeEvidence?: boolean;
  nativeFallback?: boolean;
  catalogCompatibility?: 'current' | 'missing' | 'capabilityChanged';
  ledgerStateStatus?: 'available' | 'degraded';
  ledgerStateReason?: 'rebuilt_from_missing_or_invalid' | 'operation_interrupted_after_native_write' | 'operation_interrupted_after_artifact_write' | null;
  externalOwnership?: boolean;
  failInstallExtensionsBeforeWrite?: boolean;
  lockTrackingDirDuringInstall?: boolean;
  artifactKind?: GeneratedArtifact['kind'];
  artifactPath?: string;
}

class FakeAdapter implements PlatformAdapter {
  readonly name: PlatformName;

  constructor(
    name: PlatformName,
    private readonly cwd: string,
    private readonly states: Record<string, FakePluginState>,
  ) {
    this.name = name;
  }

  private getState(pluginName: string): FakePluginState {
    this.states[pluginName] ??= {};
    return this.states[pluginName];
  }

  private getTrackingDir(scope: 'project' | 'user'): string {
    if (this.name === 'claude') {
      return scope === 'project' ? path.join(this.cwd, '.claude') : path.join(this.cwd, '.claude-user');
    }
    return scope === 'project' ? path.join(this.cwd, '.codex') : path.join(this.cwd, '.codex-user');
  }

  async detect(_cwd: string): Promise<boolean> {
    return true;
  }

  async installPlugin(plugin: PluginMeta): Promise<void> {
    const state = this.getState(plugin.manifest.name);
    state.nativeInstalled = true;
    state.marketplaceRegistered = true;
  }

  async uninstallPlugin(plugin: PluginMeta): Promise<void> {
    const state = this.getState(plugin.manifest.name);
    state.nativeInstalled = false;
  }

  async installExtensions(plugin: PluginMeta, scope: 'project' | 'user'): Promise<GeneratedArtifact[]> {
    const state = this.getState(plugin.manifest.name);
    if (state.failInstallExtensionsBeforeWrite) {
      throw new Error('simulated installExtensions failure');
    }

    const trackingDir = this.getTrackingDir(scope);
    const artifactPath = path.join(trackingDir, `${plugin.manifest.name}.${this.name}.txt`);
    await fs.ensureDir(path.dirname(artifactPath));
    await fs.writeFile(artifactPath, `${this.name}:${plugin.manifest.name}`, 'utf8');

    state.artifactPath = artifactPath;
    state.scopeInitialized = 'yes';
    if (state.lockTrackingDirDuringInstall) {
      await fs.chmod(trackingDir, 0o500);
    }

    return [{
      path: artifactPath,
      kind: state.artifactKind ?? 'instruction',
      platform: this.name,
    }];
  }

  async uninstallExtensions(plugin: PluginMeta, scope: 'project' | 'user'): Promise<void> {
    const state = this.getState(plugin.manifest.name);
    const trackingDir = this.getTrackingDir(scope);
    await fs.chmod(trackingDir, 0o700).catch(() => undefined);
    if (state.artifactPath) {
      await fs.remove(state.artifactPath).catch(() => undefined);
    }
    state.scopeInitialized = 'no';
    state.artifactPath = undefined;
  }

  async upgradePlugin(plugin: PluginMeta, scope: 'project' | 'user'): Promise<void> {
    await this.installPlugin(plugin, scope);
    await this.installExtensions(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: 'project' | 'user'): Promise<StatusReport> {
    const state = this.getState(plugin.manifest.name);
    const currentCatalogAvailable = state.currentCatalogAvailable ?? plugin.manifest.name !== 'legacy-plugin';
    const generatedArtifacts = state.artifactPath
      ? [{
          path: state.artifactPath,
          exists: await fs.pathExists(state.artifactPath),
          kind: state.artifactKind ?? 'instruction',
        }]
      : [];

    return {
      platform: this.name,
      scope,
      initialized:
        state.scopeInitialized === 'yes' ||
        state.nativeInstalled === true ||
        state.runtimeEvidence === true ||
        state.nativeFallback === true,
      plugins: [{
        pluginName: plugin.manifest.name,
        native: {
          marketplaceRegistered: state.marketplaceRegistered === true,
          pluginAvailable: currentCatalogAvailable,
          pluginInstalled: state.nativeInstalled === true,
          version: plugin.manifest.version,
        },
        generatedArtifacts,
        driftWarnings: [],
        ledgerStateStatus: state.ledgerStateStatus ?? 'available',
        ledgerStateReason: state.ledgerStateReason ?? null,
        scopeInitialized: state.scopeInitialized ?? 'no',
        catalogCompatibility: state.catalogCompatibility,
        externalOwnership: state.externalOwnership
          ? {
              present: true,
              marketplace: 'third-party',
              details: '同名插件已由外部 marketplace 管理。',
            }
          : undefined,
        platformRuntimeEvidence: {
          present: state.runtimeEvidence === true,
        },
        platformNativeFallbackEvidence: {
          present: state.nativeFallback === true,
        },
        scopeManagedEvidence: {
          ledger: state.scopeInitialized === 'yes',
          tracking: generatedArtifacts.length > 0,
          sharedNativeRef: false,
        },
        currentCatalog: {
          rootDir: '/synthetic',
          source: 'embedded',
          available: currentCatalogAvailable,
          reason: currentCatalogAvailable ? undefined : 'missing from current catalog',
        },
        artifactsInitialized: generatedArtifacts.every((artifact) => artifact.exists),
        repoManagedSessionState: {
          instructions: generatedArtifacts.length > 0 ? 'visible' : 'absent',
          rules: 'not_applicable',
          hooks: 'not_applicable',
          agents: 'not_applicable',
          diagnostics: [],
        },
        projectTrust: 'not_applicable',
      }],
    };
  }
}

async function addInstructionOnlyPlugin(repoRoot: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', 'docs-note');
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.writeJson(
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    {
      name: 'docs-note',
      version: '0.1.0',
      description: 'instruction only test plugin',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
      },
      extensions: {
        instructions: [
          {
            name: 'docs-note',
            title: 'Docs Note',
            content: 'Remember to update docs.',
          },
        ],
      },
    },
    { spaces: 2 },
  );
}

async function addHookOnlyPlugin(repoRoot: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', 'npm-guard');
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.writeJson(
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    {
      name: 'npm-guard',
      version: '0.1.0',
      description: 'hook only test plugin',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'ON_INSTALL',
        },
      },
      extensions: {
        hooks: [
          {
            event: 'command',
            matcher: 'npm *',
            command: 'echo npm hook',
            description: '观察 npm 命令',
          },
        ],
      },
    },
    { spaces: 2 },
  );
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  delete process.env.AW_HOME;
  delete process.env.AW_CODEX_HOME;
  delete process.env.AW_FORCE_CODEX_AVAILABLE;
  delete process.env.AW_FORCE_CLAUDE_AVAILABLE;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('CLI integration', () => {
  it('supports aw init --force and repairs a damaged local marketplace', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    const marketplacePath = path.join(awHome, '.claude-plugin', 'marketplace.json');
    const marketplace = await fs.readJson(marketplacePath);
    marketplace.plugins[0].source = './plugins/broken';
    await fs.writeJson(marketplacePath, marketplace, { spaces: 2 });

    const result = await initCommand({ force: true });

    expect(result.changed).toBe(true);
    await expect(fs.readJson(marketplacePath)).resolves.toMatchObject({
      plugins: [{ source: './plugins/git-commit' }],
    });
  });

  it('keeps status read-only when ~/.aw is stale and falls back to the embedded catalog', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await fs.ensureDir(awHome);
    await fs.writeJson(
      path.join(awHome, 'config.json'),
      {
        version: 1,
        initializedAt: '2026-04-25T00:00:00.000Z',
        sourcePackage: '@yiliang/aw',
        sourceVersion: '0.1.0',
        bundleFingerprint: 'sha256:stale',
      },
      { spaces: 2 },
    );

    await expect(
      statusCommand(['git-commit'], {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      }),
    ).resolves.toMatchObject({
      reports: [
        {
          platform: 'codex',
        },
      ],
    });
    await expect(fs.pathExists(path.join(awHome, 'plugins', 'git-commit'))).resolves.toBe(false);
  });

  it('supports historical status fallback and shows both platforms for status --platform auto', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const result = await statusCommand(
      ['legacy-plugin'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'auto',
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, {
            'legacy-plugin': {
              currentCatalogAvailable: false,
              nativeFallback: true,
              nativeInstalled: true,
            },
          }),
          claude: new FakeAdapter('claude', repoRoot, {
            'legacy-plugin': {
              currentCatalogAvailable: false,
              runtimeEvidence: true,
              nativeInstalled: true,
              marketplaceRegistered: true,
            },
          }),
        },
      },
    );

    expect(result.reports.map((report) => report.platform)).toEqual(['codex', 'claude']);
    expect(result.output).toContain('scopeInitialized=no');
    expect(result.output).toContain('ledgerState=available');
    expect(result.output).toContain('nativeFallbackEvidence=yes');
    expect(result.output).toContain('runtimeEvidence=yes');
    expect(result.output).toContain('projectTrust=not_applicable');
  });

  it('prints catalogCompatibility and degraded ledger reason in status output', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, {
            'git-commit': {
              currentCatalogAvailable: true,
              scopeInitialized: 'yes',
              catalogCompatibility: 'current',
              ledgerStateStatus: 'degraded',
              ledgerStateReason: 'operation_interrupted_after_native_write',
            },
          }),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    expect(result.output).toContain('catalogCompatibility=current');
    expect(result.output).toContain('ledgerState=degraded (operation_interrupted_after_native_write)');
  });

  it('omits catalogCompatibility when the current catalog is available but no compatibility state applies', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, {
            'git-commit': {
              currentCatalogAvailable: true,
              scopeInitialized: 'no',
            },
          }),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    expect(result.output).not.toContain('catalogCompatibility=not_applicable');
    expect(result.output).not.toContain('catalogCompatibility=');
  });

  it('reports Unknown plugin for install misses but keeps status fallback on historical evidence', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    await expect(
      installCommand(
        ['legacy-plugin'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', repoRoot, {}),
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).rejects.toThrow('Unknown plugin "legacy-plugin"');

    await expect(
      statusCommand(
        ['legacy-plugin'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', repoRoot, {
              'legacy-plugin': {
                currentCatalogAvailable: false,
                nativeFallback: true,
                nativeInstalled: true,
              },
            }),
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).resolves.toMatchObject({
      reports: [
        {
          platform: 'codex',
        },
      ],
    });
  });

  it('marks installed.json degraded after native state succeeded but later install failed', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    await expect(
      installCommand(
        ['git-commit'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', repoRoot, {
              'git-commit': {
                currentCatalogAvailable: true,
                failInstallExtensionsBeforeWrite: true,
              },
            }),
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).rejects.toThrow('simulated installExtensions failure');

    await expect(fs.readJson(path.join(awHome, 'installed.json'))).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'operation_interrupted_after_native_write',
      },
    });
  });

  it('marks installed.json degraded with artifact_write when instruction-only codex install fails after artifacts are written', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(addInstructionOnlyPlugin);
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    await expect(
      installCommand(
        ['docs-note'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', repoRoot, {
              'docs-note': {
                currentCatalogAvailable: true,
                lockTrackingDirDuringInstall: true,
              },
            }),
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).rejects.toThrow();

    await fs.chmod(path.join(repoRoot, '.codex'), 0o700).catch(() => undefined);
    await expect(fs.readJson(path.join(awHome, 'installed.json'))).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'operation_interrupted_after_artifact_write',
      },
    });
  });

  it('rejects upgrade --all on degraded ledger and blocks auto platform inference when scopeInitialized is unknown', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const installedLedgerPath = path.join(awHome, 'installed.json');
    const installedLedger = await fs.readJson(installedLedgerPath);
    installedLedger.ledgerState = {
      status: 'degraded',
      degradedAt: '2026-04-25T00:00:00.000Z',
      reason: 'rebuilt_from_missing_or_invalid',
    };
    await fs.writeJson(installedLedgerPath, installedLedger, { spaces: 2 });

    await expect(
      upgradeCommand(
        [],
        {
          all: true,
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', repoRoot, {}),
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).rejects.toThrow('degraded');

    await expect(
      installCommand(
        ['git-commit'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'auto',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', repoRoot, {
              'git-commit': {
                currentCatalogAvailable: true,
                scopeInitialized: 'yes',
              },
            }),
            claude: new FakeAdapter('claude', repoRoot, {
              'git-commit': {
                currentCatalogAvailable: true,
                scopeInitialized: 'unknown',
              },
            }),
          },
        },
      ),
    ).rejects.toThrow('scopeInitialized = unknown');
  });

  it('rejects upgrade --all when managed plugins are missing or capability-changed', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const installedLedgerPath = path.join(awHome, 'installed.json');
    const installedLedger = await fs.readJson(installedLedgerPath);
    installedLedger.ledgerState = {
      status: 'available',
      degradedAt: null,
      reason: null,
    };
    const projectKey = await resolveCodexProjectKey(repoRoot);
    installedLedger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          projectScopes: {
            [projectKey]: {
              managed: true,
              updatedAt: '2026-04-25T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
                hasRepoManagedArtifacts: true,
              },
            },
          },
          sharedNativeRefs: {
            user: false,
            projects: [projectKey],
          },
        },
      },
    };
    await fs.writeJson(installedLedgerPath, installedLedger, { spaces: 2 });

    await expect(
      upgradeCommand(
        [],
        {
          all: true,
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', repoRoot, {
              'git-commit': {
                currentCatalogAvailable: true,
                scopeInitialized: 'yes',
                catalogCompatibility: 'capabilityChanged',
              },
            }),
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).rejects.toThrow('capabilityChanged');

    await expect(
      upgradeCommand(
        [],
        {
          all: true,
          cwd: repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', repoRoot, {
              'git-commit': {
                currentCatalogAvailable: false,
                scopeInitialized: 'yes',
                catalogCompatibility: 'missing',
              },
            }),
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).rejects.toThrow('missing');
  });

  it('keeps Claude user ledger untouched when uninstalling only project scope', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const installedLedgerPath = path.join(awHome, 'installed.json');
    const installedLedger = await fs.readJson(installedLedgerPath);
    installedLedger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        claude: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-25T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              managedExtensions: ['instructions', 'permissions'],
            },
          },
          projectScopes: {
            [repoRoot]: {
              managed: true,
              updatedAt: '2026-04-25T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                managedExtensions: ['instructions', 'permissions'],
              },
            },
          },
        },
      },
    };
    await fs.writeJson(installedLedgerPath, installedLedger, { spaces: 2 });

    await uninstallCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'claude',
      },
      {
        adapters: {
          claude: new FakeAdapter('claude', repoRoot, {
            'git-commit': {
              currentCatalogAvailable: true,
              scopeInitialized: 'yes',
              nativeInstalled: true,
              marketplaceRegistered: true,
            },
          }),
          codex: new FakeAdapter('codex', repoRoot, {}),
        },
      },
    );

    await expect(fs.readJson(installedLedgerPath)).resolves.toMatchObject({
      plugins: {
        'git-commit': {
          platforms: {
            claude: {
              userScope: {
                managed: true,
              },
            },
          },
        },
      },
    });
  });

  it('keeps Codex shared user native state when user uninstall still has project shared refs', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const projectKey = await resolveCodexProjectKey(repoRoot);
    const installedLedgerPath = path.join(awHome, 'installed.json');
    const installedLedger = await fs.readJson(installedLedgerPath);
    installedLedger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          userScope: {
            managed: true,
            updatedAt: '2026-04-25T00:00:00.000Z',
            resolvedVersion: '0.1.0',
            capabilitySnapshot: {
              requiresNativePlugin: true,
              hasRepoManagedArtifacts: true,
            },
          },
          projectScopes: {
            [projectKey]: {
              managed: true,
              updatedAt: '2026-04-25T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
                hasRepoManagedArtifacts: true,
              },
            },
          },
          sharedNativeRefs: {
            user: true,
            projects: [projectKey],
          },
        },
      },
    };
    await fs.writeJson(installedLedgerPath, installedLedger, { spaces: 2 });

    await fs.ensureDir(codexHome);
    await fs.writeFile(
      path.join(codexHome, 'config.toml'),
      [
        '[marketplaces.aw]',
        `source = ${JSON.stringify(awHome)}`,
        'source_type = "local"',
        '',
        '[plugins."git-commit@aw"]',
        'enabled = true',
        '',
      ].join('\n'),
      'utf8',
    );

    await uninstallCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        adapters: {
          codex: new CodexAdapter(repoRoot, process.env),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    await expect(fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')).resolves.toContain('[plugins."git-commit@aw"]');
    await expect(fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')).resolves.toContain('[marketplaces.aw]');
  });

  it('keeps Codex shared user native state when uninstalling project scope', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const projectKey = await resolveCodexProjectKey(repoRoot);
    const installedLedgerPath = path.join(awHome, 'installed.json');
    const installedLedger = await fs.readJson(installedLedgerPath);
    installedLedger.plugins['git-commit'] = {
      lastResolvedVersion: '0.1.0',
      platforms: {
        codex: {
          projectScopes: {
            [projectKey]: {
              managed: true,
              updatedAt: '2026-04-25T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                requiresNativePlugin: true,
                hasRepoManagedArtifacts: true,
              },
            },
          },
          sharedNativeRefs: {
            user: false,
            projects: [projectKey],
          },
        },
      },
    };
    await fs.writeJson(installedLedgerPath, installedLedger, { spaces: 2 });

    await fs.ensureDir(codexHome);
    await fs.writeFile(
      path.join(codexHome, 'config.toml'),
      [
        '[marketplaces.aw]',
        `source = ${JSON.stringify(awHome)}`,
        'source_type = "local"',
        '',
        '[plugins."git-commit@aw"]',
        'enabled = true',
        '',
      ].join('\n'),
      'utf8',
    );

    await uninstallCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        adapters: {
          codex: new CodexAdapter(repoRoot, process.env),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    await expect(fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')).resolves.toContain('[plugins."git-commit@aw"]');
    await expect(fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')).resolves.toContain('[marketplaces.aw]');
  });

  it('preserves remaining Codex hooks when another tracked plugin disappears from the current catalog', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(addHookOnlyPlugin);
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await installCommand(
      ['git-commit', 'npm-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    await expect(fs.readJson(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toMatchObject({
      commands: expect.arrayContaining([
        expect.objectContaining({
          matcher: 'git *',
          command: 'echo git hook',
        }),
        expect.objectContaining({
          matcher: 'npm *',
          command: 'echo npm hook',
        }),
      ]),
    });

    await fs.remove(path.join(repoRoot, 'plugins', 'npm-guard'));
    const nextEmbeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(nextEmbeddedRoot);
    setEmbeddedPluginsRootOverrideForTests(nextEmbeddedRoot);

    await uninstallCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    await expect(fs.readJson(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toEqual({
      commands: [
        {
          matcher: 'npm *',
          command: 'echo npm hook',
          description: '观察 npm 命令',
        },
      ],
    });
    await expect(fs.readJson(path.join(awHome, 'installed.json'))).resolves.toMatchObject({
      plugins: {
        'npm-guard': {
          lastResolvedVersion: '0.1.0',
        },
      },
    });
    await expect(fs.readJson(path.join(awHome, 'installed.json'))).resolves.not.toMatchObject({
      ledgerState: {
        reason: 'operation_interrupted_after_native_write',
      },
    });
  });

  it('anchors Codex project artifacts at the repo root when commands run from a subdirectory', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await fs.ensureDir(path.join(repoRoot, '.git'));
    const subdir = path.join(repoRoot, 'packages', 'feature');
    await fs.ensureDir(subdir);

    await installCommand(
      ['git-commit'],
      {
        cwd: subdir,
        scope: 'project',
        platform: 'codex',
      },
    );

    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'config.toml'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'agents', 'aw-git-commit-commit-reviewer.toml'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'rules', 'aw-git-commit-git-ops.rules'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(subdir, '.codex'))).resolves.toBe(false);

    await expect(
      statusCommand(
        ['git-commit'],
        {
          cwd: subdir,
          scope: 'project',
          platform: 'codex',
        },
      ),
    ).resolves.toMatchObject({
      reports: [
        {
          platform: 'codex',
          plugins: [
            {
              pluginName: 'git-commit',
              scopeInitialized: 'yes',
              artifactsInitialized: true,
            },
          ],
        },
      ],
    });

    await uninstallCommand(
      ['git-commit'],
      {
        cwd: subdir,
        scope: 'project',
        platform: 'codex',
      },
    );

    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'agents', 'aw-git-commit-commit-reviewer.toml'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'rules', 'aw-git-commit-git-ops.rules'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(subdir, '.codex'))).resolves.toBe(false);
  });
});
