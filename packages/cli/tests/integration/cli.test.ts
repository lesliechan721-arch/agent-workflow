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
import { readInstallRecordForLocation } from '../../src/install-state/facade.js';
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
import { getCatalogFullPackageRoot } from '../../src/utils/bundle-layout.js';
import { resolveCatalogPlugins } from '../../src/utils/plugin-catalog.js';
import { readTrackingManifest } from '../../src/utils/tracking.js';
import type {
  NativeCliInvocation,
  NativeCliRunner,
} from '../../src/utils/native-cli.js';
import {
  resolveClaudeProjectKey,
  resolveCodexPaths,
  resolveCodexProjectKey,
} from '../../src/utils/paths.js';
import { resolveSafeCliEnv } from '../helpers/cli-runtime.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { createMinimalPluginInstallStateFixtureBuilder } from '../helpers/minimal-plugin-install-state-fixtures.js';
import {
  activateCliEmbeddedRoot,
  registerCliCatalogSourceRoot,
  registerCliEmbeddedRoot,
  registerCliFixtureRepoRoot,
  registerCliTempRoot,
} from '../helpers/workspace.js';
import { registerCurrentTestReadonlyFixtureRoot } from '../setup/test-isolation.js';
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

function registerRepoFixtureRoots(): void {
  registerCurrentTestReadonlyFixtureRoot(fixturePath(), 'cli integration fixture root');
}

function replaceProcessEnv(nextEnv: NodeJS.ProcessEnv): void {
  const nextKeys = new Set(Object.keys(nextEnv));

  for (const key of Object.keys(process.env)) {
    if (!nextKeys.has(key)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(nextEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function registerEmbeddedCatalogRoots(
  embeddedRoot: string,
  source: string,
): void {
  registerCliEmbeddedRoot(embeddedRoot, `${source} embedded root`);
  registerCliCatalogSourceRoot(
    getCatalogFullPackageRoot(embeddedRoot),
    `${source} catalog source root`,
  );
}

async function makeWorkspace(): Promise<{ repoRoot: string; awHome: string; embeddedRoot: string; codexHome: string; claudeHome: string }> {
  registerRepoFixtureRoots();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-'));
  tempDirs.push(root);
  registerCliTempRoot(root, 'cli integration root');

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  registerCliFixtureRepoRoot(repoRoot, 'cli integration repo root');
  await removeAppsFromGitCommit(repoRoot);
  if (await fs.pathExists(path.join(repoRoot, '.codex'))) {
    await fs.chmod(path.join(repoRoot, '.codex'), 0o700).catch(() => undefined);
  }
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  registerEmbeddedCatalogRoots(embeddedRoot, 'cli integration');

  return {
    repoRoot,
    awHome: path.join(root, 'aw-home'),
    embeddedRoot,
    codexHome: path.join(root, 'codex-home'),
    claudeHome: path.join(root, 'claude-home'),
  };
}

async function makeWorkspaceWithMutator(
  mutateRepo: (repoRoot: string) => Promise<void>,
): Promise<{ repoRoot: string; awHome: string; embeddedRoot: string; codexHome: string; claudeHome: string }> {
  registerRepoFixtureRoots();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-cli-'));
  tempDirs.push(root);
  registerCliTempRoot(root, 'cli integration mutated root');

  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  registerCliFixtureRepoRoot(repoRoot, 'cli integration mutated repo root');
  await mutateRepo(repoRoot);
  await removeAppsFromGitCommit(repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  registerEmbeddedCatalogRoots(embeddedRoot, 'cli integration mutated');

  return {
    repoRoot,
    awHome: path.join(root, 'aw-home'),
    embeddedRoot,
    codexHome: path.join(root, 'codex-home'),
    claudeHome: path.join(root, 'claude-home'),
  };
}

function activateWorkspaceEnv(
  workspace: {
    awHome: string;
    embeddedRoot: string;
    codexHome?: string;
    claudeHome?: string;
  },
  options: {
    forceCodex?: boolean;
    forceClaude?: boolean;
    overrides?: NodeJS.ProcessEnv;
  } = {},
): NodeJS.ProcessEnv {
  const env = resolveSafeCliEnv({
    AW_HOME: workspace.awHome,
    ...(workspace.codexHome ? { AW_CODEX_HOME: workspace.codexHome } : {}),
    ...(workspace.claudeHome ? { AW_CLAUDE_HOME: workspace.claudeHome } : {}),
    ...(options.forceCodex ? { AW_FORCE_CODEX_AVAILABLE: '1' } : {}),
    ...(options.forceClaude ? { AW_FORCE_CLAUDE_AVAILABLE: '1' } : {}),
    ...options.overrides,
  });
  replaceProcessEnv(env);
  activateCliEmbeddedRoot(workspace.embeddedRoot, 'cli integration embedded root activation');
  return env;
}

function normalizeMacTmpPath(value: string): string {
  return value.replace(/^\/private(?=\/var\/folders\/)/, '');
}

async function readInstallRecord(options: {
  cwd: string;
  plugin: string;
  platform?: PlatformName;
  scope?: 'project' | 'user';
  projectKey?: string;
  env?: NodeJS.ProcessEnv;
}) {
  return readInstallRecordForLocation({
    cwd: options.cwd,
    location: {
      plugin: options.plugin,
      platform: options.platform ?? 'codex',
      scope: options.scope ?? 'user',
      ...(options.scope === 'project' ? { projectKey: options.projectKey } : {}),
    },
    env: options.env ?? process.env,
  });
}

async function createInstallStateBuilderForWorkspace(workspace: {
  repoRoot: string;
}): Promise<Awaited<ReturnType<typeof createMinimalPluginInstallStateFixtureBuilder>>> {
  return createMinimalPluginInstallStateFixtureBuilder(path.dirname(workspace.repoRoot));
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
    const invocationEnv = invocation.env ?? env;
    const invocationCwd = invocation.cwd ?? cwd;
    if (invocation.args.length === 1 && invocation.args[0] === '--version') {
      return {
        exitCode: 0,
        stdout: invocation.command === 'claude' ? '2.1.88 (Claude Code)' : 'codex-cli 0.131.0',
        stderr: '',
      };
    }
    const configPath = resolveCodexPaths(invocationCwd, 'user', invocationEnv).configTomlPath;
    if (invocation.args[0] === 'plugin' && invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
      await upsertCodexMarketplaceFile(configPath, 'aw', {
        source: invocation.args[3] ?? '',
        sourceType: 'local',
      });
    }
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
  manifest.skillTriggers.review = {
    defaultTrigger: 'auto',
    allowDynamicTrigger: true,
  };
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
  const catalogRoot = await resolveCatalogFixtureRoot(embeddedRoot);
  const manifestPath = path.join(catalogRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  update(manifest);
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
}

async function resolveCatalogFixtureRoot(rootDir: string): Promise<string> {
  const fullRoot = getCatalogFullPackageRoot(rootDir);
  return await fs.pathExists(path.join(fullRoot, 'plugins'))
    ? fullRoot
    : rootDir;
}

async function removeEmbeddedGitCommitReviewSkill(embeddedRoot: string): Promise<void> {
  const catalogRoot = await resolveCatalogFixtureRoot(embeddedRoot);
  await updateEmbeddedGitCommitManifest(embeddedRoot, (manifest) => {
    const skillTriggers = manifest.skillTriggers as Record<string, unknown> | undefined;
    if (skillTriggers) {
      delete skillTriggers.review;
    }
    manifest.version = '0.2.0';
  });
  await fs.remove(path.join(catalogRoot, 'plugins', 'git-commit', 'skills', 'review'));
  await fs.remove(path.join(catalogRoot, 'plugins', 'git-commit', 'codex', 'skills', 'review'));
}

async function removeEmbeddedGitCommitReviewMcp(embeddedRoot: string): Promise<void> {
  const pluginRoot = path.join(await resolveCatalogFixtureRoot(embeddedRoot), 'plugins', 'git-commit');
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
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('CLI integration', () => {
  it('keeps aw init --force scoped to current catalog resolution without materializing ~/.aw runtime state', async () => {
    const { awHome, embeddedRoot } = await makeWorkspace();
    activateWorkspaceEnv({ awHome, embeddedRoot });

    const result = await initCommand({ force: true });

    expect(result.changed).toBe(true);
    expect(result.catalog).toMatchObject({
      source: 'local',
    });
    expect(normalizeMacTmpPath(result.catalog.rootDir)).toBe(
      normalizeMacTmpPath(getCatalogFullPackageRoot(embeddedRoot)),
    );
    await expect(fs.pathExists(path.join(awHome, '.claude-plugin', 'marketplace.json'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(awHome, 'plugins', 'git-commit'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(awHome, 'installed.json'))).resolves.toBe(false);
  });

  it('keeps single-platform plugins in the local current catalog after aw init --force', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      async (workspaceRepoRoot) => addNativeHookOnlyPlugin(workspaceRepoRoot, 'prompt-guard'),
    );
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot, claudeHome: path.join(path.dirname(codexHome), 'claude-home') }, { forceCodex: true, forceClaude: true });

    const result = await initCommand({ force: true });
    await expect(validateLocalMarketplaceLayout(result.rootDir)).resolves.toBeUndefined();

    const { catalog, plugins } = await resolveCatalogPlugins(undefined, process.env);
    expect(catalog.source).toBe('local');
    expect(plugins.map((plugin) => plugin.manifest.name)).toContain('prompt-guard');

    const claudeMarketplace = await fs.readJson(path.join(result.rootDir, '.claude-plugin', 'marketplace.json'));
    expect(claudeMarketplace.plugins.map((plugin: { name: string }) => plugin.name)).not.toContain('prompt-guard');
  });

  it('keeps status read-only when ~/.aw is stale and falls back to the embedded catalog', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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

  it('supports historical status fallback and queries both platforms when status omits --platform', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot, claudeHome: path.join(path.dirname(codexHome), 'claude-home') }, { forceCodex: true, forceClaude: true });

    await initCommand({ force: true });

    const result = await statusCommand(
      ['legacy-plugin'],
      {
        cwd: repoRoot,
        scope: 'project',
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
    expect(result.matrix.health).toBe('notInstalled');
    expect(result.reports[0]?.plugins[0]).toMatchObject({
      scopeInitialized: 'no',
      ledgerStateStatus: 'available',
      projectTrust: 'unknown',
    });
    expect(result.reports[1]?.plugins[0]).toMatchObject({
      scopeInitialized: 'no',
      ledgerStateStatus: 'available',
      projectTrust: 'unknown',
    });
  });

  it('keeps status structured fields on install-record truth even if adapter reports degraded compatibility metadata', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

    await initCommand({ force: true });
    await installCommand(
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
            },
          }),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

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

    expect(result.reports[0]?.plugins[0]).toMatchObject({
      scopeInitialized: 'yes',
      ledgerStateStatus: 'available',
      ledgerStateReason: null,
    });
  });

  it('renders daily status summaries without raw diagnostic field names by default', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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
    expect(result.output).not.toContain('位置：');
    expect(result.output).not.toContain('catalogCompatibility=');
    expect(result.output).not.toContain('scopeInitialized=');
    expect(result.output).not.toContain('driftWarnings=');
    expect(result.matrix.health).toBe('notInstalled');
  });

  it('keeps stable config fields in status JSON when schema diagnostics are unavailable', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(async (workspaceRoot) => {
      await addDependencyFixturePlugin(workspaceRoot, {
        ...createDependencyPluginManifest({
          name: 'config-status-plugin',
          products: ['codex'],
        }),
        config: {
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
        },
      });
    });
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });
    await initCommand({ force: true });

    const result = await statusCommand(
      ['config-status-plugin'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, {
            'config-status-plugin': {
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
      config: 'no-schema',
    });
    expect(payload.summaries[0].cells[0]).toMatchObject({
      config: 'no-schema',
    });
  });

  it('fails install preflight for missing required config without prompting or writing state', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      addRequiredConfigSchemaToGitCommit,
    );
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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

    expect(Object.values(states).every((state) => Object.keys(state).length === 0)).toBe(true);
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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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

    await expect(readInstallRecord({
      cwd: repoRoot,
      env: process.env,
      plugin: 'workflow-child',
      platform: 'codex',
      scope: 'user',
    })).resolves.toMatchObject({
      status: 'ok',
      value: {
        record: {
          installSource: {
            kind: 'dependency',
            explicitlyRequested: false,
          },
        },
      },
    });
    await expect(readInstallRecord({
      cwd: repoRoot,
      env: process.env,
      plugin: 'workflow-parent',
      platform: 'codex',
      scope: 'user',
    })).resolves.toMatchObject({
      status: 'ok',
      value: {
        record: {
          dependencyEdges: [
            expect.objectContaining({
              dependency: expect.objectContaining({
                plugin: 'workflow-child',
                platform: 'codex',
                scope: 'user',
              }),
              declaration: expect.objectContaining({
                name: 'workflow-child',
              }),
            }),
          ],
        },
      },
    });
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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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

    expect(Object.values(states).every((state) => Object.keys(state).length === 0)).toBe(true);
    await expect(readInstallRecord({
      cwd: repoRoot,
      env: process.env,
      plugin: 'config-parent',
      platform: 'codex',
      scope: 'user',
    })).resolves.toMatchObject({ status: 'missing' });
    await expect(readInstallRecord({
      cwd: repoRoot,
      env: process.env,
      plugin: 'config-child',
      platform: 'codex',
      scope: 'user',
    })).resolves.toMatchObject({ status: 'missing' });
    await expect(fs.pathExists(path.join(awHome, 'installed.json'))).resolves.toBe(false);
  });

  it('reports unknown status targets as notInstalled instead of throwing', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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

  it('resolves install targets with marketplace.policy.products under the new platform contract', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      async (root) => addNativeHookOnlyPlugin(root, 'prompt-guard'),
    );
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot, claudeHome: path.join(path.dirname(codexHome), 'claude-home') }, { forceCodex: true, forceClaude: true });

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
    ).resolves.toMatchObject({
      platforms: ['codex'],
      plugins: ['prompt-guard'],
    });

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
            codex: new FakeAdapter('codex', repoRoot, {}),
            claude: new FakeAdapter('claude', repoRoot, {}),
          },
        },
      ),
    ).rejects.toThrow('Unsupported platform "auto"');
  });

  it('shows single-platform current catalog plugins in status when status omits --platform', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      async (root) => addNativeHookOnlyPlugin(root, 'prompt-guard'),
    );
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot, claudeHome: path.join(path.dirname(codexHome), 'claude-home') }, { forceCodex: true, forceClaude: true });

    await initCommand({ force: true });

    const result = await statusCommand(
      ['prompt-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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
      },
    });
  });

  it('marks installed.json degraded with artifact_write when instruction-only codex install fails after artifacts are written', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(addInstructionOnlyPlugin);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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

  it('rejects upgrade --all on degraded ledger and still installs both targets when fresh install preflight tolerates unknown scopeInitialized', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot, claudeHome: path.join(path.dirname(codexHome), 'claude-home') }, { forceCodex: true, forceClaude: true });

    await initCommand({ force: true });

    const installedLedgerPath = path.join(awHome, 'installed.json');
    const installedLedger = createAvailableLedger();
    installedLedger.ledgerState = {
      status: 'degraded',
      degradedAt: '2026-04-25T00:00:00.000Z',
      reason: 'rebuilt_from_missing_or_invalid',
    };
    await writeInstalledLedger(installedLedger, process.env);

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
          platform: 'both',
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
    ).resolves.toMatchObject({
      platforms: ['codex', 'claude'],
      plugins: ['git-commit'],
    });
  });

  it('keeps capability-changed and missing managed plugins non-fatal during upgrade --all', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

    await initCommand({ force: true });

    const installStates: Record<string, FakePluginState> = {};
    await installCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        adapters: {
          codex: new FakeAdapter('codex', repoRoot, installStates),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );

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
    ).resolves.toMatchObject({
      plugins: [],
      skipped: [],
    });

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
      skipped: [],
    });
  });

  it('keeps unused auto dependencies installed after uninstall and marks them for manual cleanup', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      async (root) => {
        await addDependencyFixturePlugin(root, createDependencyPluginManifest({
          name: 'cleanup-grandchild',
        }));
        await addDependencyFixturePlugin(root, createDependencyPluginManifest({
          name: 'cleanup-child',
          dependencies: [{ name: 'cleanup-grandchild' }],
        }));
        await addDependencyFixturePlugin(root, createDependencyPluginManifest({
          name: 'cleanup-parent',
          dependencies: [{ name: 'cleanup-child' }],
        }));
      },
    );
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

    await initCommand({ force: true });

    const states: Record<string, FakePluginState> = {};
    await installCommand(
      ['cleanup-parent'],
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

    const result = await uninstallCommand(
      ['cleanup-parent'],
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

    expect((result as { receiptActions?: unknown }).receiptActions).toBeUndefined();
    await expect(readInstallRecord({
      cwd: repoRoot,
      env: process.env,
      plugin: 'cleanup-parent',
      platform: 'codex',
      scope: 'user',
    })).resolves.toMatchObject({ status: 'missing' });
    await expect(readInstallRecord({
      cwd: repoRoot,
      env: process.env,
      plugin: 'cleanup-child',
      platform: 'codex',
      scope: 'user',
    })).resolves.toMatchObject({ status: 'ok' });
    await expect(readInstallRecord({
      cwd: repoRoot,
      env: process.env,
      plugin: 'cleanup-grandchild',
      platform: 'codex',
      scope: 'user',
    })).resolves.toMatchObject({ status: 'ok' });

    const childStatus = await statusCommand(
      ['cleanup-child'],
      {
        cwd: repoRoot,
        scope: 'user',
        platform: 'codex',
        json: true,
      },
    );
    expect(JSON.parse(childStatus.output)).toMatchObject({
      locations: [
        expect.objectContaining({
          autoInstalled: true,
          unusedDependencyHint: true,
        }),
      ],
    });

    await expect(fs.pathExists(path.join(repoRoot, '.codex-user', 'cleanup-parent.codex.txt'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(repoRoot, '.codex-user', 'cleanup-child.codex.txt'))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(repoRoot, '.codex-user', 'cleanup-grandchild.codex.txt'))).resolves.toBe(true);
  });

  it('keeps Claude user ledger untouched when uninstalling only project scope', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot, claudeHome: path.join(path.dirname(codexHome), 'claude-home') }, { forceClaude: true });

    await initCommand({ force: true });
    await installCommand(
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
    const builder = await createInstallStateBuilderForWorkspace({ repoRoot });
    const claudeUser = builder.createTarget({
      pluginName: 'git-commit',
      platform: 'claude',
      scope: 'user',
    });
    await builder.writeInstallRecord(claudeUser);

    const installedLedgerPath = path.join(awHome, 'installed.json');
    const installedLedger = createAvailableLedger();
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
    await writeInstalledLedger(installedLedger, process.env);

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

    await initCommand({ force: true });

    const projectKey = await resolveCodexProjectKey(repoRoot);
    await installCommand(
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
              scopeInitialized: 'yes',
              nativeInstalled: true,
              marketplaceRegistered: true,
            },
          }),
          claude: new FakeAdapter('claude', repoRoot, {}),
        },
      },
    );
    const builder = await createInstallStateBuilderForWorkspace({ repoRoot });
    const codexProject = builder.createTarget({
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'project',
      projectKey,
    });
    await builder.writeInstallRecord(codexProject);
    const installedLedgerPath = path.join(awHome, 'installed.json');
    const installedLedger = createAvailableLedger();
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
    await writeInstalledLedger(installedLedger, process.env);

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

    await initCommand({ force: true });

    const projectKey = await resolveCodexProjectKey(repoRoot);
    await installCommand(
      ['git-commit'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        nativeCliRunner: createCodexMarketplaceAddRunner(repoRoot),
      },
    );
    const installedLedgerPath = path.join(awHome, 'installed.json');
    const installedLedger = createAvailableLedger();
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
    await writeInstalledLedger(installedLedger, process.env);

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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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
    registerEmbeddedCatalogRoots(nextEmbeddedRoot, 'cli integration refreshed');
    activateCliEmbeddedRoot(nextEmbeddedRoot, 'cli integration refreshed embedded root');

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
    const projectKey = await resolveCodexProjectKey(repoRoot);
    await expect(readInstallRecord({
      cwd: repoRoot,
      env: process.env,
      plugin: 'npm-guard',
      platform: 'codex',
      scope: 'project',
      projectKey,
    })).resolves.toMatchObject({ status: 'ok' });
    await expect(fs.readJson(path.join(awHome, 'installed.json'))).resolves.not.toMatchObject({
      ledgerState: {
        reason: 'operation_interrupted_after_native_write',
      },
    });
  });

  it('keeps historical Codex hooks when uninstalling an instruction-only plugin after ~/.aw is refreshed', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(addInstructionAndHookOnlyPlugins);
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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
    registerEmbeddedCatalogRoots(nextEmbeddedRoot, 'cli integration refreshed');
    activateCliEmbeddedRoot(nextEmbeddedRoot, 'cli integration refreshed embedded root');

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
    const projectKey = await resolveCodexProjectKey(repoRoot);
    await expect(readInstallRecord({
      cwd: repoRoot,
      env: process.env,
      plugin: 'npm-guard',
      platform: 'codex',
      scope: 'project',
      projectKey,
    })).resolves.toMatchObject({ status: 'ok' });
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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

    await initCommand({ force: true });
    const { plugins } = await resolveCatalogPlugins(['prompt-guard'], process.env);
    expect(plugins[0]?.manifest).toMatchObject({
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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });
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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });
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
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });
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
    registerEmbeddedCatalogRoots(withoutPromptGuard, 'cli integration without prompt guard');
    activateCliEmbeddedRoot(withoutPromptGuard, 'cli integration without prompt guard embedded root');
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
    registerEmbeddedCatalogRoots(withoutHookPlugins, 'cli integration without hook plugins');
    activateCliEmbeddedRoot(withoutHookPlugins, 'cli integration without hook plugins embedded root');
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
    expect(nativeStatus.matrix.health).toBe('ready');
    expect(nativeStatus.matrix.cells[0]).toMatchObject({
      health: 'ready',
      installState: {
        currentCatalogAvailable: false,
      },
    });
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
    expect(mixedStatus.matrix.health).toBe('ready');
    expect(mixedStatus.matrix.cells[0]).toMatchObject({
      health: 'ready',
      installState: {
        currentCatalogAvailable: false,
      },
    });
    expect(mixedStatus.reports[0].plugins[0].driftWarnings).toEqual([]);
  });

  it('reports drift when an expected Codex hook only exists inside an opaque mixed group', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      addMixedHookPlugin,
    );
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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

    expect(result.reports[0].plugins[0].repoManagedSessionState?.hooks).toBe('not_applicable');
    expect(result.output).toContain('插件状态');
    expect(result.output).not.toContain('Codex hooks artifact 中缺少当前插件声明的 hook handlers。');
    expect(result.reports[0].plugins[0].driftWarnings).toEqual([]);

    const verboseResult = await statusCommand(
      ['mixed-guard'],
      {
        cwd: repoRoot,
        scope: 'project',
        platform: 'codex',
        verbose: true,
      },
    );
    expect(verboseResult.output).toContain('状态详情');
    expect(verboseResult.output).not.toContain('Codex hooks artifact 中缺少当前插件声明的 hook handlers。');
  });

  it('keeps Claude nativeHooks-only capability through embedded catalog and ledger fallback', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspaceWithMutator(
      addClaudeNativeHookOnlyPlugin,
    );
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot, claudeHome: path.join(path.dirname(codexHome), 'claude-home') }, { forceClaude: true });

    await initCommand({ force: true });
    const { plugins } = await resolveCatalogPlugins(['claude-compact'], process.env);
    expect(plugins[0]?.manifest).toMatchObject({
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

    const claudeProjectKey = await resolveClaudeProjectKey(repoRoot);
    await expect(readInstallRecord({
      cwd: repoRoot,
      env: process.env,
      plugin: 'claude-compact',
      platform: 'claude',
      scope: 'project',
      projectKey: claudeProjectKey,
    })).resolves.toMatchObject({
      status: 'ok',
      value: {
        record: {
          pluginName: 'claude-compact',
          platform: 'claude',
          scope: 'project',
        },
      },
    });

    await fs.remove(path.join(repoRoot, 'plugins', 'claude-compact'));
    const withoutClaudePlugin = await createSyntheticEmbeddedRoot(repoRoot);
    tempDirs.push(withoutClaudePlugin);
    registerEmbeddedCatalogRoots(withoutClaudePlugin, 'cli integration without Claude plugin');
    activateCliEmbeddedRoot(withoutClaudePlugin, 'cli integration without Claude plugin embedded root');
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

    expect(result.matrix.health).toBe('ready');
    expect(result.matrix.cells[0]).toMatchObject({
      health: 'ready',
      installState: {
        currentCatalogAvailable: false,
      },
    });
    expect(result.reports[0].plugins[0].scopeInitialized).toBe('yes');
  });

  it('anchors Codex project artifacts at the repo root when commands run from a subdirectory', async () => {
    const { repoRoot, awHome, embeddedRoot, codexHome } = await makeWorkspace();
    activateWorkspaceEnv({ awHome, codexHome, embeddedRoot }, { forceCodex: true });

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
