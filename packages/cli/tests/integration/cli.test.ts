import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { ClaudeAdapter } from '../../src/adapters/claude.js';
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
import { upsertCodexMarketplaceFile } from '../../src/utils/codex-config.js';
import { attachGeneratedArtifactsToError } from '../../src/utils/generated-artifacts.js';
import {
  createAvailableLedger,
  readInstalledLedger,
  validateLocalMarketplaceLayout,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import { resolveCatalogPlugins } from '../../src/utils/plugin-catalog.js';
import { readTrackingManifest } from '../../src/utils/tracking.js';
import type {
  NativeCliInvocation,
  NativeCliRunner,
} from '../../src/utils/native-cli.js';
import {
  resolveCodexPaths,
  resolveCodexProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { createDependencyPluginManifest } from '../support/plugin-dependency-fixtures.js';

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
  await removeAppsFromGitCommit(repoRoot);
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
  await removeAppsFromGitCommit(repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);

  return {
    repoRoot,
    awHome: path.join(root, 'aw-home'),
    embeddedRoot,
    codexHome: path.join(root, 'codex-home'),
  };
}

async function removeAppsFromGitCommit(repoRoot: string): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  delete manifest.apps;
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.remove(path.join(repoRoot, 'plugins', 'git-commit', '.app.json'));
}

function createCodexMarketplaceAddRunner(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  calls: NativeCliInvocation[] = [],
): NativeCliRunner {
  return async (invocation) => {
    calls.push(invocation);
    const awHome = invocation.args[3] ?? '';
    await upsertCodexMarketplaceFile(
      resolveCodexPaths(cwd, 'user', env).configTomlPath,
      'aw',
      {
        source: awHome,
        sourceType: 'local',
      },
    );
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
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

  async uninstallExtensions(
    plugin: PluginMeta,
    scope: 'project' | 'user',
    _generatedArtifacts?: GeneratedArtifact[],
  ): Promise<void> {
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

class FailingInstallExtensionsCodexAdapter extends CodexAdapter {
  override async installExtensions(
    plugin: PluginMeta,
    scope: 'project' | 'user',
  ): Promise<GeneratedArtifact[]> {
    const artifacts = await super.installExtensions(plugin, scope);
    throw attachGeneratedArtifactsToError(
      new Error('simulated codex rollback window'),
      artifacts,
    );
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
            event: 'before_tool',
            matcher: 'Bash',
            command: 'echo npm hook',
          },
        ],
      },
    },
    { spaces: 2 },
  );
}

async function addNativeHookOnlyPlugin(
  repoRoot: string,
  pluginName = 'prompt-guard',
): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', pluginName);
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.writeJson(
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    {
      name: pluginName,
      version: '0.1.0',
      description: 'Codex native hook only test plugin',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
          products: ['CODEX'],
        },
      },
      extensions: {
        nativeHooks: {
          codex: [
            {
              event: 'UserPromptSubmit',
              command: `echo ${pluginName} prompt`,
            },
            {
              event: 'Stop',
              command: `echo ${pluginName} stop`,
            },
          ],
        },
      },
    },
    { spaces: 2 },
  );
}

async function addRequiredConfigSchemaToGitCommit(repoRoot: string): Promise<void> {
  const manifestPath = path.join(repoRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.config = {
    schema: {
      token: {
        type: 'string',
        required: true,
        sensitive: true,
      },
    },
  };
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function addDependencyFixturePlugin(
  repoRoot: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', String(manifest.name));
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.writeJson(
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    manifest,
    { spaces: 2 },
  );
}

async function addGitCommitReviewSkill(repoRoot: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', 'git-commit');
  await fs.copy(
    path.join(pluginRoot, 'skills', 'commit'),
    path.join(pluginRoot, 'skills', 'review'),
  );
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath);
  manifest.skillTriggers ??= {};
  manifest.skillTriggers.review = { allowInstallOverride: true };
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function addGitCommitReviewMcp(repoRoot: string): Promise<void> {
  const mcpPath = path.join(repoRoot, 'plugins', 'git-commit', '.mcp.json');
  const mcp = await fs.readJson(mcpPath);
  mcp.mcpServers['git-commit-review'] = {
    command: 'git',
    args: ['log', '--oneline'],
  };
  await fs.writeJson(mcpPath, mcp, { spaces: 2 });
}

async function updateEmbeddedGitCommitManifest(
  embeddedRoot: string,
  update: (manifest: Record<string, unknown>) => void,
): Promise<void> {
  const manifestPath = path.join(embeddedRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  update(manifest);
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function removeEmbeddedGitCommitReviewSkill(embeddedRoot: string): Promise<void> {
  await updateEmbeddedGitCommitManifest(embeddedRoot, (manifest) => {
    const skillTriggers = manifest.skillTriggers as Record<string, unknown> | undefined;
    if (skillTriggers) {
      delete skillTriggers.review;
    }
    manifest.version = '0.2.0';
  });
  await fs.remove(path.join(embeddedRoot, 'plugins', 'git-commit', 'skills', 'review'));
  await fs.remove(path.join(embeddedRoot, 'plugins', 'git-commit', 'codex', 'skills', 'review'));
}

async function removeEmbeddedGitCommitReviewMcp(embeddedRoot: string): Promise<void> {
  const pluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');
  const visit = async (currentDir: string): Promise<void> => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (entry.name !== '.mcp.json') {
        continue;
      }

      const mcp = await fs.readJson(entryPath);
      delete mcp.mcpServers['git-commit-review'];
      await fs.writeJson(entryPath, mcp, { spaces: 2 });
    }
  };

  await visit(pluginRoot);
}

async function addMixedHookPlugin(repoRoot: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', 'mixed-guard');
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.writeJson(
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    {
      name: 'mixed-guard',
      version: '0.1.0',
      description: 'Public and native hook test plugin',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
          products: ['CODEX'],
        },
      },
      extensions: {
        hooks: [
          {
            event: 'before_tool',
            matcher: 'Bash',
            command: 'echo mixed public hook',
          },
        ],
        nativeHooks: {
          codex: [
            {
              event: 'Stop',
              command: 'echo mixed native stop',
            },
          ],
        },
      },
    },
    { spaces: 2 },
  );
}

async function addClaudeNativeHookOnlyPlugin(repoRoot: string): Promise<void> {
  const pluginRoot = path.join(repoRoot, 'plugins', 'claude-compact');
  await fs.ensureDir(path.join(pluginRoot, '.agents-plugin'));
  await fs.writeJson(
    path.join(pluginRoot, '.agents-plugin', 'plugin.json'),
    {
      name: 'claude-compact',
      version: '0.1.0',
      description: 'Claude native hook only test plugin',
      marketplace: {
        category: 'workflow',
        strict: true,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
          products: ['CLAUDE'],
        },
      },
      extensions: {
        nativeHooks: {
          claude: [
            {
              event: 'SessionStart',
              matcher: 'compact',
              command: 'echo claude compact',
            },
          ],
        },
      },
    },
    { spaces: 2 },
  );
}

async function addNativeAndMixedHookPlugins(repoRoot: string): Promise<void> {
  await addNativeHookOnlyPlugin(repoRoot);
  await addMixedHookPlugin(repoRoot);
}

async function seedCodexExternalHooks(repoRoot: string): Promise<void> {
  await fs.ensureDir(path.join(repoRoot, '.codex'));
  await fs.writeJson(
    path.join(repoRoot, '.codex', 'hooks.json'),
    {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'echo external with metadata',
                timeout: 5,
                statusMessage: 'external check',
              },
            ],
          },
          {
            matcher: 'Write',
            hooks: [
              { type: 'command', command: 'echo external command' },
              { type: 'prompt', prompt: 'external prompt' },
            ],
          },
        ],
        Stop: [
          {
            matcher: 'legacy-inert',
            hooks: [{ type: 'command', command: 'echo external stop' }],
          },
        ],
      },
    },
    { spaces: 2 },
  );
}

async function seedCodexExternalMultiHandlerHooks(repoRoot: string): Promise<void> {
  await fs.ensureDir(path.join(repoRoot, '.codex'));
  await fs.writeJson(
    path.join(repoRoot, '.codex', 'hooks.json'),
    {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Write',
            hooks: [
              { type: 'command', command: 'echo external multi first' },
              { type: 'command', command: 'echo external multi second' },
            ],
          },
        ],
        Stop: [
          {
            matcher: 'legacy-inert',
            hooks: [{ type: 'command', command: 'echo external stop' }],
          },
        ],
      },
    },
    { spaces: 2 },
  );
}

async function trustCodexProject(codexHome: string, repoRoot: string): Promise<void> {
  const projectKey = await resolveCodexProjectKey(repoRoot);
  await fs.ensureDir(codexHome);
  await fs.appendFile(
    path.join(codexHome, 'config.toml'),
    ['', `[projects.${JSON.stringify(projectKey)}]`, 'trust_level = "trusted"', ''].join('\n'),
    'utf8',
  );
}

async function addInstructionAndHookOnlyPlugins(repoRoot: string): Promise<void> {
  await addInstructionOnlyPlugin(repoRoot);
  await addHookOnlyPlugin(repoRoot);
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  delete process.env.AW_HOME;
  delete process.env.AW_CLAUDE_HOME;
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

  it('keeps single-platform plugins in the local current catalog after aw init --force', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      async (workspaceRepoRoot) => addNativeHookOnlyPlugin(workspaceRepoRoot, 'prompt-guard'),
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await expect(validateLocalMarketplaceLayout(awHome)).resolves.toBeUndefined();

    const { catalog, plugins } = await resolveCatalogPlugins(undefined, process.env);
    expect(catalog.source).toBe('local');
    expect(plugins.map((plugin) => plugin.manifest.name)).toContain('prompt-guard');

    const claudeMarketplace = await fs.readJson(path.join(awHome, '.claude-plugin', 'marketplace.json'));
    expect(claudeMarketplace.plugins.map((plugin: { name: string }) => plugin.name)).not.toContain('prompt-guard');
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
        verbose: true,
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
        verbose: true,
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

  it('renders daily status summaries without raw diagnostic field names by default', async () => {
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
            },
          }),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    expect(result.output).toContain('插件状态');
    expect(result.output).toContain('git-commit');
    expect(result.output).toContain('状态：');
    expect(result.output).toContain('位置：');
    expect(result.output).not.toContain('catalogCompatibility=');
    expect(result.output).not.toContain('scopeInitialized=');
    expect(result.output).not.toContain('driftWarnings=');
    expect(result.matrix.health).toBe('ready');
  });

  it('keeps stable config issue details in status JSON', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(async (workspaceRoot) => {
      const manifestPath = path.join(workspaceRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
      const manifest = await fs.readJson(manifestPath);
      manifest.config = {
        schema: {
          token: {
            type: 'string',
            required: true,
          },
          workspaceDir: {
            type: 'directory',
            default: './missing-workspace-dir',
          },
        },
      };
      await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    });
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    const result = await statusCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, {
            'git-commit': {
              scopeInitialized: 'yes',
              catalogCompatibility: 'current',
            },
          }),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    const payload = JSON.parse(result.output);
    expect(payload.cells[0]).toMatchObject({
      config: 'invalid-config',
      configIssues: expect.arrayContaining([
        expect.objectContaining({
          type: 'invalid-config',
          key: 'workspaceDir',
          source: 'default',
        }),
        expect.objectContaining({
          type: 'missing-required',
          key: 'token',
          source: 'missing',
        }),
      ]),
    });
    expect(payload.summaries[0].cells[0]).toMatchObject({
      configIssues: expect.arrayContaining([
        expect.objectContaining({ key: 'workspaceDir' }),
        expect.objectContaining({ key: 'token' }),
      ]),
    });
  });

  it('fails install preflight for missing required config without prompting or writing state', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      addRequiredConfigSchemaToGitCommit,
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const states: Record<string, FakePluginState> = {};
    const configureCalls: Array<{
      allowedScopes: string[];
      initialScope: string;
      requiredKeys?: string[];
      currentValues?: Record<string, unknown>;
    }> = [];

    await expect(installCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        interactive: true,
        prompt: {
          configurePlugin: async (options) => {
            configureCalls.push({
              allowedScopes: options.allowedScopes,
              initialScope: options.initialScope,
              requiredKeys: options.requiredKeys,
              currentValues: options.currentValues,
            });
            return {
              selectedScope: 'project',
              updates: { token: 'install-secret' },
              updatedKeys: ['token'],
              cancelled: false,
            };
          },
        },
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, states),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    )).rejects.toThrow(
      'git-commit requires valid AW config before install/upgrade: token. Run `aw config set git-commit token <value> -s user`, or open `aw` to complete setup.',
    );

    expect(Object.values(states)).toEqual([]);
    expect(configureCalls).toEqual([]);
    await expect(fs.readJson(
      path.join(repoRoot, '.agent-workflows', 'plugin-config', 'git-commit', 'config.json'),
    )).rejects.toThrow();
    await expect(fs.pathExists(
      path.join(awHome, 'plugin-config', 'git-commit', 'config.json'),
    )).resolves.toBe(false);
    await expect(fs.pathExists(
      path.join(repoRoot, '.codex', 'config.toml'),
    )).resolves.toBe(false);
  });

  it('auto-installs declared dependencies before the parent plugin and writes dependency metadata', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      async (root) => {
        await addDependencyFixturePlugin(root, createDependencyPluginManifest({
          name: 'workflow-child',
        }));
        await addDependencyFixturePlugin(root, createDependencyPluginManifest({
          name: 'workflow-parent',
          dependencies: [{ name: 'workflow-child' }],
        }));
      },
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const states: Record<string, FakePluginState> = {};
    const result = await installCommand(
      ['workflow-parent'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, states),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    expect(result.receiptActions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        plugin: 'workflow-child',
        type: 'installDependency',
      }),
    ]));

    const ledger = await fs.readJson(path.join(awHome, 'installed.json'));
    expect(ledger.plugins['workflow-child'].platforms.codex.userScope.installSource).toMatchObject({
      kind: 'dependency',
      explicitlyRequested: false,
    });
    expect(ledger.plugins['workflow-parent'].platforms.codex.userScope.dependencyEdges).toEqual([
      expect.objectContaining({
        dependency: expect.objectContaining({
          plugin: 'workflow-child',
          platform: 'codex',
          scope: 'user',
          projectKey: null,
        }),
        declaration: expect.objectContaining({
          name: 'workflow-child',
        }),
      }),
    ]);
  });

  it('fails install preflight when a dependency is missing required config and leaves state untouched', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      async (root) => {
        await addDependencyFixturePlugin(root, {
          ...createDependencyPluginManifest({
            name: 'config-child',
          }),
          config: {
            schema: {
              token: {
                type: 'string',
                required: true,
              },
            },
          },
        });
        await addDependencyFixturePlugin(root, createDependencyPluginManifest({
          name: 'config-parent',
          dependencies: [{ name: 'config-child' }],
        }));
      },
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const states: Record<string, FakePluginState> = {};
    await expect(installCommand(
      ['config-parent'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, states),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    )).rejects.toThrow(
      'config-child requires valid AW config before install/upgrade: token. Run `aw config set config-child token <value> -s user`, or open `aw` to complete setup.',
    );

    expect(Object.values(states)).toEqual([]);
    await expect(fs.readJson(path.join(awHome, 'installed.json'))).resolves.toMatchObject({
      plugins: {},
    });
  });

  it('reports unknown status targets as notInstalled instead of throwing', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const result = await statusCommand(
      ['missing-plugin'],
      {
        cwd: repoRoot,
        platform: 'codex',
        json: true,
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, {}),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    const payload = JSON.parse(result.output) as { health: string; summaries: Array<{ health: string }> };
    expect(payload.health).toBe('notInstalled');
    expect(payload.summaries[0].health).toBe('notInstalled');
  });

  it('lists managed plugin summaries when status has no plugin argument', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await installCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, {}),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    const result = await statusCommand(
      [],
      {
        cwd: repoRoot,
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, {
            'git-commit': {
              scopeInitialized: 'yes',
              nativeInstalled: true,
              marketplaceRegistered: true,
            },
          }),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    expect(result.output).toContain('git-commit');
    expect(result.output).toContain('插件状态');
    expect(result.output).toContain('状态：');
    expect(result.matrix.summaries.map((summary) => summary.pluginName)).toContain('git-commit');
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
        verbose: true,
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

  it('enforces marketplace.policy.products during install platform resolution', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      async (root) => addNativeHookOnlyPlugin(root, 'prompt-guard'),
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    await expect(
      installCommand(
        ['prompt-guard'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'claude',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', repoRoot, {}),
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).rejects.toThrow('插件不支持目标平台');

    await expect(
      installCommand(
        ['prompt-guard'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'both',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', repoRoot, {}),
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).rejects.toThrow('marketplace.policy.products=[CODEX]');

    await expect(
      installCommand(
        ['prompt-guard'],
        {
          cwd: repoRoot,
          scope: 'project',
          platform: 'auto',
        },
        {
          adapters: {
            codex: new FakeAdapter('codex', repoRoot, {
              'prompt-guard': {
                currentCatalogAvailable: true,
              },
            }),
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['prompt-guard'],
    });
  });

  it('shows single-platform current catalog plugins in status while keeping auto scoped to supported platforms', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      async (root) => addNativeHookOnlyPlugin(root, 'prompt-guard'),
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });

    const result = await statusCommand(
      ['prompt-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'auto',
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, {
            'prompt-guard': {
              currentCatalogAvailable: true,
            },
          }),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    expect(result.matrix.summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginName: 'prompt-guard',
      }),
    ]));
    expect(result.matrix.cells).toHaveLength(1);
    expect(result.matrix.cells[0]).toMatchObject({
      pluginName: 'prompt-guard',
      platform: 'codex',
      scope: 'project',
      healthSource: 'currentCatalog',
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
          scope: 'user',
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

  it('rolls back real Codex repo-managed artifacts when install fails before tracking is written', async () => {
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
            codex: new FailingInstallExtensionsCodexAdapter(
              repoRoot,
              createCodexMarketplaceAddRunner(repoRoot),
              process.env,
            ),
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).rejects.toThrow('simulated codex rollback window');

    const projectCodexDir = path.join(repoRoot, '.codex');
    const rulesEntries = await fs.pathExists(path.join(projectCodexDir, 'rules'))
      ? await fs.readdir(path.join(projectCodexDir, 'rules'))
      : [];
    const agentEntries = await fs.pathExists(path.join(projectCodexDir, 'agents'))
      ? await fs.readdir(path.join(projectCodexDir, 'agents'))
      : [];

    await expect(fs.pathExists(path.join(projectCodexDir, 'hooks.json'))).resolves.toBe(false);
    const codexConfigPath = path.join(projectCodexDir, 'config.toml');
    if (await fs.pathExists(codexConfigPath)) {
      await expect(fs.readFile(codexConfigPath, 'utf8')).resolves.not.toContain('git-commit');
    }
    expect(rulesEntries).toEqual([]);
    expect(agentEntries).toEqual([]);
    await expect(fs.readJson(path.join(awHome, 'installed.json'))).resolves.toMatchObject({
      ledgerState: {
        status: 'degraded',
        reason: 'operation_interrupted_after_artifact_write',
      },
    });
  });

  it('prunes stale tracked Codex project skills and MCP servers after a current upgrade without touching foreign content', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      async (workspaceRepoRoot) => {
        await addGitCommitReviewSkill(workspaceRepoRoot);
        await addGitCommitReviewMcp(workspaceRepoRoot);
      },
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await installCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    const foreignSkillRoot = path.join(repoRoot, '.agents', 'skills', 'foreign-review');
    await fs.outputFile(path.join(foreignSkillRoot, 'SKILL.md'), '# Foreign\n', 'utf8');
    const projectCodexPaths = resolveCodexPaths(repoRoot, 'project', process.env);
    const trackingBeforeUpgrade = await readTrackingManifest(projectCodexPaths.trackingDir);
    expect(trackingBeforeUpgrade.plugins['git-commit']?.artifacts.some((artifact) =>
      artifact.kind === 'skill' && artifact.artifactKey === 'review')).toBe(true);
    expect(trackingBeforeUpgrade.plugins['git-commit']?.artifacts.some((artifact) =>
      artifact.kind === 'mcpServer' && artifact.artifactKey === 'git-commit-review')).toBe(true);
    await fs.appendFile(
      projectCodexPaths.configTomlPath,
      '\n[mcp_servers."foreign-review"]\ncommand = "node"\nargs = ["foreign.js"]\n',
      'utf8',
    );

    await removeEmbeddedGitCommitReviewSkill(embeddedRoot);
    await removeEmbeddedGitCommitReviewMcp(embeddedRoot);

    await upgradeCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
    );

    await expect(fs.pathExists(path.join(repoRoot, '.agents', 'skills', 'commit'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(repoRoot, '.agents', 'skills', 'review'))).resolves.toBe(false);
    await expect(fs.pathExists(foreignSkillRoot)).resolves.toBe(true);

    const configToml = await fs.readFile(projectCodexPaths.configTomlPath, 'utf8');
    expect(configToml).toContain('[mcp_servers.git-commit]');
    expect(configToml).not.toContain('[mcp_servers.git-commit-review]');
    expect(configToml).toContain('[mcp_servers."foreign-review"]');

    const trackingManifest = await readTrackingManifest(projectCodexPaths.trackingDir);
    const trackingArtifacts = trackingManifest.plugins['git-commit']?.artifacts ?? [];
    expect(trackingArtifacts.some((artifact) =>
      artifact.kind === 'skill' && artifact.artifactKey === 'review')).toBe(false);
    expect(trackingArtifacts.some((artifact) =>
      artifact.kind === 'mcpServer' && artifact.artifactKey === 'git-commit-review')).toBe(false);
    expect(trackingArtifacts.some((artifact) =>
      artifact.kind === 'skill' && artifact.artifactKey === 'commit')).toBe(true);
    expect(trackingArtifacts.some((artifact) =>
      artifact.kind === 'mcpServer' && artifact.artifactKey === 'git-commit')).toBe(true);
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

  it('keeps capability-changed upgrade --all fatal but skips missing managed plugins', async () => {
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
              installOptions: {
                skillTriggerPreference: 'default',
              },
              installSource: {
                kind: 'explicit',
                explicitlyRequested: true,
                allowsUnusedCleanup: false,
              },
              dependencyEdges: [],
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
    ).resolves.toMatchObject({
      plugins: [],
      skipped: [
        {
          platform: 'codex',
          scope: 'project',
          plugin: 'git-commit',
          code: 'catalogNotCurrent',
        },
      ],
    });
  });

  it('auto-cleans unused dependency chains during uninstall and reports uninstallAutoDependency actions', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    const parentArtifactPath = path.join(repoRoot, '.codex-user', 'cleanup-parent.codex.txt');
    const childArtifactPath = path.join(repoRoot, '.codex-user', 'cleanup-child.codex.txt');
    const grandchildArtifactPath = path.join(repoRoot, '.codex-user', 'cleanup-grandchild.codex.txt');
    await Promise.all([
      fs.outputFile(parentArtifactPath, 'parent', 'utf8'),
      fs.outputFile(childArtifactPath, 'child', 'utf8'),
      fs.outputFile(grandchildArtifactPath, 'grandchild', 'utf8'),
    ]);

    await writeInstalledLedger(
      {
        ...createAvailableLedger(),
        plugins: {
          'cleanup-parent': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-05-06T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {},
                  installSource: {
                    kind: 'explicit',
                    explicitlyRequested: true,
                    allowsUnusedCleanup: false,
                  },
                  dependencyEdges: [{
                    dependency: {
                      plugin: 'cleanup-child',
                      platform: 'codex',
                      scope: 'user',
                      projectKey: null,
                    },
                    declaration: {
                      name: 'cleanup-child',
                    },
                  }],
                },
                sharedNativeRefs: {
                  user: false,
                  projects: [],
                },
              },
            },
          },
          'cleanup-child': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-05-06T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {},
                  installSource: {
                    kind: 'dependency',
                    explicitlyRequested: false,
                    allowsUnusedCleanup: true,
                  },
                  dependencyEdges: [{
                    dependency: {
                      plugin: 'cleanup-grandchild',
                      platform: 'codex',
                      scope: 'user',
                      projectKey: null,
                    },
                    declaration: {
                      name: 'cleanup-grandchild',
                    },
                  }],
                },
                sharedNativeRefs: {
                  user: false,
                  projects: [],
                },
              },
            },
          },
          'cleanup-grandchild': {
            lastResolvedVersion: '0.1.0',
            platforms: {
              codex: {
                userScope: {
                  managed: true,
                  updatedAt: '2026-05-06T00:00:00.000Z',
                  resolvedVersion: '0.1.0',
                  capabilitySnapshot: {},
                  installSource: {
                    kind: 'dependency',
                    explicitlyRequested: false,
                    allowsUnusedCleanup: true,
                  },
                  dependencyEdges: [],
                },
                sharedNativeRefs: {
                  user: false,
                  projects: [],
                },
              },
            },
          },
        },
      },
      process.env,
    );

    const result = await uninstallCommand(
      ['cleanup-parent'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, {
            'cleanup-parent': {
              scopeInitialized: 'yes',
              artifactPath: parentArtifactPath,
            },
            'cleanup-child': {
              scopeInitialized: 'yes',
              artifactPath: childArtifactPath,
            },
            'cleanup-grandchild': {
              scopeInitialized: 'yes',
              artifactPath: grandchildArtifactPath,
            },
          }),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

    expect(result.receiptActions).toEqual([
      {
        type: 'uninstallAutoDependency',
        plugin: 'cleanup-child',
        platform: 'codex',
        scope: 'user',
      },
      {
        type: 'uninstallAutoDependency',
        plugin: 'cleanup-grandchild',
        platform: 'codex',
        scope: 'user',
      },
    ]);
    await expect(readInstalledLedger(process.env)).resolves.toMatchObject({
      plugins: {},
    });
    await expect(fs.pathExists(parentArtifactPath)).resolves.toBe(false);
    await expect(fs.pathExists(childArtifactPath)).resolves.toBe(false);
    await expect(fs.pathExists(grandchildArtifactPath)).resolves.toBe(false);
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
            installSource: {
              kind: 'explicit',
              explicitlyRequested: true,
              allowsUnusedCleanup: false,
            },
            dependencyEdges: [],
          },
          projectScopes: {
            [repoRoot]: {
              managed: true,
              updatedAt: '2026-04-25T00:00:00.000Z',
              resolvedVersion: '0.1.0',
              capabilitySnapshot: {
                managedExtensions: ['instructions', 'permissions'],
              },
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
            installSource: {
              kind: 'explicit',
              explicitlyRequested: true,
              allowsUnusedCleanup: false,
            },
            dependencyEdges: [],
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
              installSource: {
                kind: 'explicit',
                explicitlyRequested: true,
                allowsUnusedCleanup: false,
              },
              dependencyEdges: [],
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
              installSource: {
                kind: 'explicit',
                explicitlyRequested: true,
                allowsUnusedCleanup: false,
              },
              dependencyEdges: [],
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
        verbose: true,
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
        verbose: true,
      },
      {
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot),
      },
    );

    await expect(fs.readJson(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toMatchObject({
      hooks: {
        PreToolUse: expect.arrayContaining([
          expect.objectContaining({
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo git hook' }],
          }),
          expect.objectContaining({
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo npm hook' }],
          }),
      ]),
      },
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
        verbose: true,
      },
    );

    await expect(fs.readJson(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo npm hook' }],
          },
        ],
      },
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

  it('keeps historical Codex hooks when uninstalling an instruction-only plugin after ~/.aw is refreshed', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(addInstructionAndHookOnlyPlugins);
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await installCommand(
      ['docs-note', 'npm-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        verbose: true,
      },
    );

    await fs.remove(path.join(repoRoot, 'plugins', 'npm-guard'));
    const nextEmbeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(nextEmbeddedRoot);
    setEmbeddedPluginsRootOverrideForTests(nextEmbeddedRoot);

    await initCommand({ force: true });

    await uninstallCommand(
      ['docs-note'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        verbose: true,
      },
    );

    await expect(fs.readJson(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo npm hook' }],
          },
        ],
      },
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
        status: 'degraded',
        reason: 'operation_interrupted_after_artifact_write',
      },
    });
  });

  it('installs and uninstalls a Codex nativeHooks-only plugin through the command path', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      addNativeHookOnlyPlugin,
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await expect(
      fs.readJson(path.join(awHome, 'plugins', 'prompt-guard', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      extensions: {
        nativeHooks: {
          codex: [
            { event: 'UserPromptSubmit', command: 'echo prompt-guard prompt' },
            { event: 'Stop', command: 'echo prompt-guard stop' },
          ],
        },
      },
    });

    await installCommand(
      ['prompt-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    await expect(fs.readJson(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toEqual({
      hooks: {
        Stop: [
          {
            hooks: [{ type: 'command', command: 'echo prompt-guard stop' }],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'echo prompt-guard prompt' }],
          },
        ],
      },
    });

    await uninstallCommand(
      ['prompt-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toBe(false);
  });

  it('preserves external Codex shared hook groups while installing and uninstalling public/native mixed hooks', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      addMixedHookPlugin,
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await seedCodexExternalHooks(repoRoot);

    await installCommand(
      ['mixed-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    await expect(fs.readJson(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'echo external with metadata',
                timeout: 5,
                statusMessage: 'external check',
              },
            ],
          },
          {
            matcher: 'Write',
            hooks: [
              { type: 'command', command: 'echo external command' },
              { type: 'prompt', prompt: 'external prompt' },
            ],
          },
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo mixed public hook' }],
          },
        ],
        Stop: [
          {
            matcher: 'legacy-inert',
            hooks: [{ type: 'command', command: 'echo external stop' }],
          },
          {
            hooks: [{ type: 'command', command: 'echo mixed native stop' }],
          },
        ],
      },
    });

    await uninstallCommand(
      ['mixed-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    await expect(fs.readJson(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: 'echo external with metadata',
                timeout: 5,
                statusMessage: 'external check',
              },
            ],
          },
          {
            matcher: 'Write',
            hooks: [
              { type: 'command', command: 'echo external command' },
              { type: 'prompt', prompt: 'external prompt' },
            ],
          },
        ],
        Stop: [
          {
            matcher: 'legacy-inert',
            hooks: [{ type: 'command', command: 'echo external stop' }],
          },
        ],
      },
    });
  });

  it('keeps external multi-handler groups and remaining AW hook groups when uninstalling one Codex hook plugin', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      addNativeAndMixedHookPlugins,
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await seedCodexExternalMultiHandlerHooks(repoRoot);

    await installCommand(
      ['prompt-guard', 'mixed-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    const installedHooks = await fs.readJson(path.join(repoRoot, '.codex', 'hooks.json'));
    expect(installedHooks).toMatchObject({
      hooks: {
        Stop: expect.arrayContaining([
          {
            matcher: 'legacy-inert',
            hooks: [{ type: 'command', command: 'echo external stop' }],
          },
          {
            hooks: [{ type: 'command', command: 'echo prompt-guard stop' }],
          },
          {
            hooks: [{ type: 'command', command: 'echo mixed native stop' }],
          },
        ]),
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'echo prompt-guard prompt' }],
          },
        ],
      },
    });
    expect(installedHooks.hooks.PreToolUse).toEqual([
      {
        matcher: 'Write',
        hooks: [
          { type: 'command', command: 'echo external multi first' },
          { type: 'command', command: 'echo external multi second' },
        ],
      },
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'echo mixed public hook' }],
      },
    ]);

    await uninstallCommand(
      ['prompt-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    const remainingHooks = await fs.readJson(path.join(repoRoot, '.codex', 'hooks.json'));
    expect(remainingHooks.hooks.PreToolUse).toEqual([
      {
        matcher: 'Write',
        hooks: [
          { type: 'command', command: 'echo external multi first' },
          { type: 'command', command: 'echo external multi second' },
        ],
      },
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: 'echo mixed public hook' }],
      },
    ]);
    expect(remainingHooks).toMatchObject({
      hooks: {
        Stop: expect.arrayContaining([
          {
            matcher: 'legacy-inert',
            hooks: [{ type: 'command', command: 'echo external stop' }],
          },
          {
            hooks: [{ type: 'command', command: 'echo mixed native stop' }],
          },
        ]),
      },
    });
    expect(remainingHooks.hooks.Stop).toHaveLength(2);
    expect(remainingHooks.hooks.UserPromptSubmit).toBeUndefined();
  });

  it('uses tracking identities for Codex native hooks after current catalog entries disappear', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      addNativeAndMixedHookPlugins,
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    await seedCodexExternalHooks(repoRoot);
    await trustCodexProject(codexHome, repoRoot);

    await installCommand(
      ['prompt-guard', 'mixed-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    await fs.remove(path.join(repoRoot, 'plugins', 'prompt-guard'));
    const withoutPromptGuard = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(withoutPromptGuard);
    setEmbeddedPluginsRootOverrideForTests(withoutPromptGuard);
    await initCommand({ force: true });

    await upgradeCommand(
      ['mixed-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
    );

    await expect(fs.readJson(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toMatchObject({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: 'command', command: 'echo prompt-guard prompt' }],
          },
        ],
        Stop: expect.arrayContaining([
          expect.objectContaining({
            hooks: [{ type: 'command', command: 'echo prompt-guard stop' }],
          }),
          expect.objectContaining({
            hooks: [{ type: 'command', command: 'echo mixed native stop' }],
          }),
          expect.objectContaining({
            matcher: 'legacy-inert',
            hooks: [{ type: 'command', command: 'echo external stop' }],
          }),
        ]),
      },
    });

    await fs.remove(path.join(repoRoot, 'plugins', 'mixed-guard'));
    const withoutHookPlugins = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(withoutHookPlugins);
    setEmbeddedPluginsRootOverrideForTests(withoutHookPlugins);
    await initCommand({ force: true });

    const nativeStatus = await statusCommand(
      ['prompt-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        verbose: true,
      },
    );
    expect(nativeStatus.output).toContain('currentCatalog=source:local,available:no');
    expect(nativeStatus.output).toContain('hooks=visible');
    expect(nativeStatus.output).not.toContain('Historical managed instruction placeholder');
    expect(nativeStatus.reports[0].plugins[0].driftWarnings).toEqual([]);

    const mixedStatus = await statusCommand(
      ['mixed-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        verbose: true,
      },
    );
    expect(mixedStatus.output).toContain('currentCatalog=source:local,available:no');
    expect(mixedStatus.output).toContain('hooks=visible');
    expect(mixedStatus.reports[0].plugins[0].driftWarnings).toEqual([]);
  });

  it('reports drift when an expected Codex hook only exists inside an opaque mixed group', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      addMixedHookPlugin,
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_FORCE_CODEX_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await installCommand(
      ['mixed-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    await fs.writeJson(
      path.join(repoRoot, '.codex', 'hooks.json'),
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: 'echo mixed public hook' },
                { type: 'prompt', prompt: 'external prompt' },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                { type: 'command', command: 'echo mixed native stop' },
                { type: 'agent', agent: 'external-agent' },
              ],
            },
          ],
        },
      },
      { spaces: 2 },
    );

    const result = await statusCommand(
      ['mixed-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
    );

    expect(result.reports[0].plugins[0].repoManagedSessionState?.hooks).toBe('absent');
    expect(result.output).toContain('插件状态');
    expect(result.output).not.toContain('Codex hooks artifact 中缺少当前插件声明的 hook handlers。');
    expect(result.reports[0].plugins[0].driftWarnings).toContain(
      'Codex hooks artifact 中缺少当前插件声明的 hook handlers。',
    );

    const verboseResult = await statusCommand(
      ['mixed-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        verbose: true,
      },
    );
    expect(verboseResult.output).toContain('诊断信息');
    expect(verboseResult.output).toContain('Codex hooks artifact 中缺少当前插件声明的 hook handlers。');
  });

  it('keeps Claude nativeHooks-only capability through embedded catalog and ledger fallback', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      addClaudeNativeHookOnlyPlugin,
    );
    process.env.AW_HOME = awHome;
    process.env.AW_CODEX_HOME = codexHome;
    process.env.AW_CLAUDE_HOME = path.join(path.dirname(codexHome), 'claude-home');
    process.env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    await initCommand({ force: true });
    await expect(
      fs.readJson(path.join(awHome, 'plugins', 'claude-compact', '.agents-plugin', 'plugin.json')),
    ).resolves.toMatchObject({
      extensions: {
        nativeHooks: {
          claude: [
            {
              event: 'SessionStart',
              matcher: 'compact',
              command: 'echo claude compact',
            },
          ],
        },
      },
    });

    const nativeCliRunner = async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    await installCommand(
      ['claude-compact'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'claude',
        verbose: true,
      },
      {
        adapters: {
          claude: new ClaudeAdapter(repoRoot, nativeCliRunner, process.env),
          codex: new FakeAdapter('codex', repoRoot, {}),
        },
      },
    );

    await expect(fs.readJson(path.join(awHome, 'installed.json'))).resolves.toMatchObject({
      plugins: {
        'claude-compact': {
          platforms: {
            claude: {
              projectScopes: expect.any(Object),
            },
          },
        },
      },
    });
    const installedLedger = await fs.readJson(path.join(awHome, 'installed.json'));
    const claudeScopeRecords = Object.values(
      installedLedger.plugins['claude-compact'].platforms.claude.projectScopes,
    ) as Array<{ capabilitySnapshot: { managedExtensions: string[] } }>;
    expect(claudeScopeRecords[0].capabilitySnapshot.managedExtensions).toEqual(['hooks']);

    await fs.remove(path.join(repoRoot, 'plugins', 'claude-compact'));
    const withoutClaudePlugin = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(withoutClaudePlugin);
    setEmbeddedPluginsRootOverrideForTests(withoutClaudePlugin);
    await initCommand({ force: true });

    const result = await statusCommand(
      ['claude-compact'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'claude',
        verbose: true,
      },
      {
        adapters: {
          claude: new ClaudeAdapter(repoRoot, nativeCliRunner, process.env),
          codex: new FakeAdapter('codex', repoRoot, {}),
        },
      },
    );

    expect(result.output).toContain('currentCatalog=source:local,available:no');
    expect(result.output).toContain('catalogCompatibility=missing');
    expect(result.reports[0].plugins[0].scopeInitialized).toBe('yes');
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
      {
        nativeCliRunner: createCodexMarketplaceAddRunner(subdir),
      },
    );

    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'config.toml'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'hooks.json'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'agents', 'aw-git-commit-commit-reviewer.toml'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(repoRoot, '.codex', 'rules', 'aw-git-commit-git-ops.rules'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(subdir, '.codex'))).resolves.toBe(false);

    await upgradeCommand(
      ['git-commit'],
      {
        cwd: subdir,
        scope: 'project',
        platform: 'codex',
        requestedSkillTrigger: 'default',
      },
    );

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
