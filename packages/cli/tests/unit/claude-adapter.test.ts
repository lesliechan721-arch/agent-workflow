import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ClaudeAdapter,
  applyClaudeInstallLedger,
  applyClaudeUninstallLedger,
} from '../../src/adapters/claude.js';
import type { InstalledLedger, PluginMeta, StatusReport } from '../../src/types.js';
import {
  createAvailableLedger,
  initializeLocalMarketplace,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  resolveClaudePaths,
  resolveClaudeProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { upsertTrackingRecord } from '../../src/utils/tracking.js';
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

async function makeWorkspace(): Promise<{ repoRoot: string; env: NodeJS.ProcessEnv }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-claude-adapter-'));
  tempDirs.push(root);
  const repoRoot = path.join(root, 'repo');
  await fs.copy(fixturePath('repo-template'), repoRoot);
  return {
    repoRoot,
    env: {
      ...process.env,
      AW_CLAUDE_HOME: path.join(root, 'claude-home'),
    },
  };
}

afterEach(async () => {
  setEmbeddedPluginsRootOverrideForTests(null);
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

async function setupLocalMarketplace(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
  await initializeLocalMarketplace({ force: true, env });
}

async function removePluginFromLocalMarketplace(
  awHome: string,
  pluginName: string,
): Promise<void> {
  await fs.remove(path.join(awHome, 'plugins', pluginName));
  for (const manifestPath of [
    path.join(awHome, '.claude-plugin', 'marketplace.json'),
    path.join(awHome, '.agents', 'plugins', 'marketplace.json'),
  ]) {
    const manifest = await fs.readJson(manifestPath);
    manifest.plugins = (manifest.plugins ?? []).filter(
      (entry: { name?: string }) => entry.name !== pluginName,
    );
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  }
}

function createStatusReport(catalogCompatibility?: 'current' | 'missing' | 'capabilityChanged'): StatusReport {
  return {
    platform: 'claude',
    scope: 'project',
    initialized: true,
    plugins: [
      {
        pluginName: 'git-commit',
        native: {
          marketplaceRegistered: true,
          pluginAvailable: true,
          pluginInstalled: true,
          version: '0.1.0',
        },
        generatedArtifacts: [],
        driftWarnings: [],
        scopeInitialized: 'yes',
        catalogCompatibility,
        platformRuntimeEvidence: {
          present: false,
        },
        platformNativeFallbackEvidence: {
          present: false,
        },
        scopeManagedEvidence: {
          ledger: true,
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
          instructions: 'visible',
          rules: 'visible',
          hooks: 'not_applicable',
          agents: 'not_applicable',
          diagnostics: [],
        },
        projectTrust: 'not_applicable',
      },
    ],
  };
}

describe('ClaudeAdapter', () => {
  it('tracks Claude hook-only capabilities in the ledger without emitting hook artifacts', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const basePlugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const hookOnlyPlugin: PluginMeta = {
      ...basePlugin,
      manifest: {
        ...basePlugin.manifest,
        extensions: {
          nativeHooks: {
            claude: [
              {
                event: 'Stop',
                command: 'echo claude stop',
              },
            ],
          },
        },
      },
    };

    const ledger = await applyClaudeInstallLedger(
      createAvailableLedger(),
      hookOnlyPlugin,
      'user',
      repoRoot,
    );

    expect(ledger.plugins['git-commit'].platforms.claude?.userScope?.capabilitySnapshot).toEqual({
      managedExtensions: ['hooks'],
    });

    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    await expect(adapter.installExtensions(hookOnlyPlugin, 'project')).resolves.toEqual([]);
  });

  it('writes and removes Claude scope records in the installed ledger', async () => {
    const { repoRoot } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const projectKey = await resolveClaudeProjectKey(repoRoot);
    const degradedLedger: InstalledLedger = {
      version: 1,
      ledgerState: {
        status: 'degraded',
        degradedAt: '2026-04-25T00:00:00.000Z',
        reason: 'rebuilt_from_missing_or_invalid',
      },
      plugins: {},
    };

    const afterProjectInstall = await applyClaudeInstallLedger(
      degradedLedger,
      plugin,
      'project',
      repoRoot,
    );
    expect(afterProjectInstall.ledgerState).toEqual({
      status: 'available',
      degradedAt: null,
      reason: null,
    });
    expect(afterProjectInstall.plugins['git-commit'].platforms.claude).toMatchObject({
      lastRequestedScope: 'project',
      projectScopes: {
        [projectKey]: {
          managed: true,
          resolvedVersion: '0.1.0',
          capabilitySnapshot: {
            managedExtensions: ['instructions', 'permissions', 'hooks'],
          },
        },
      },
    });

    const afterUserInstall = await applyClaudeInstallLedger(
      afterProjectInstall,
      plugin,
      'user',
      repoRoot,
    );
    expect(afterUserInstall.plugins['git-commit'].platforms.claude).toMatchObject({
      lastRequestedScope: 'user',
      userScope: {
        managed: true,
        resolvedVersion: '0.1.0',
        capabilitySnapshot: {
          managedExtensions: ['instructions', 'permissions', 'hooks'],
        },
      },
    });

    const afterProjectUninstall = await applyClaudeUninstallLedger(
      afterUserInstall,
      'git-commit',
      'project',
      repoRoot,
    );
    expect(
      afterProjectUninstall.plugins['git-commit'].platforms.claude?.projectScopes,
    ).toBeUndefined();

    const afterUserUninstall = await applyClaudeUninstallLedger(
      afterProjectUninstall,
      'git-commit',
      'user',
      repoRoot,
    );
    expect(afterUserUninstall.plugins['git-commit']).toBeUndefined();
  });

  it('merges manual and generated Claude permissions, then restores manual state on uninstall', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    const paths = resolveClaudePaths(repoRoot, 'project', env);

    await fs.ensureDir(paths.configDir);
    await fs.writeJson(
      paths.settingsPath,
      {
        permissions: {
          allow: ['manual:allow', 'old:allow'],
          ask: ['manual:ask', 'old:ask'],
          deny: ['manual:deny'],
        },
        awGenerated: {
          permissions: {
            'existing-plugin': {
              allow: ['old:allow'],
              ask: ['old:ask'],
              deny: [],
            },
          },
        },
      },
      { spaces: 2 },
    );

    const artifacts = await adapter.installExtensions(plugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, artifacts);

    const instructionArtifact = artifacts.find((artifact) => artifact.kind === 'instruction');
    expect(instructionArtifact?.path).toBeTruthy();
    await expect(fs.pathExists(instructionArtifact!.path)).resolves.toBe(true);

    await expect(fs.readJson(paths.settingsPath)).resolves.toMatchObject({
      permissions: {
        allow: ['Bash(git diff)', 'Bash(git status)', 'manual:allow', 'old:allow'],
        ask: ['Bash(git commit)', 'manual:ask', 'old:ask'],
        deny: ['manual:deny'],
      },
      awGenerated: {
        permissions: {
          'existing-plugin': {
            allow: ['old:allow'],
            ask: ['old:ask'],
            deny: [],
          },
          'git-commit': {
            allow: ['Bash(git status)', 'Bash(git diff)'],
            ask: ['Bash(git commit)'],
            deny: [],
          },
        },
        manualPermissions: {
          allow: ['manual:allow'],
          ask: ['manual:ask'],
          deny: ['manual:deny'],
        },
      },
    });

    await adapter.uninstallExtensions(plugin, 'project');

    await expect(fs.pathExists(instructionArtifact!.path)).resolves.toBe(false);
    await expect(fs.readJson(paths.settingsPath)).resolves.toMatchObject({
      permissions: {
        allow: ['manual:allow', 'old:allow'],
        ask: ['manual:ask', 'old:ask'],
        deny: ['manual:deny'],
      },
      awGenerated: {
        permissions: {
          'existing-plugin': {
            allow: ['old:allow'],
            ask: ['old:ask'],
            deny: [],
          },
        },
        manualPermissions: {
          allow: ['manual:allow'],
          ask: ['manual:ask'],
          deny: ['manual:deny'],
        },
      },
    });
  });

  it('removes empty generated Claude permission state after uninstalling the last plugin', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const permissionOnlyPlugin: PluginMeta = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        extensions: {
          permissions: plugin.manifest.extensions?.permissions,
        },
      },
    };
    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    const paths = resolveClaudePaths(repoRoot, 'project', env);

    const artifacts = await adapter.installExtensions(permissionOnlyPlugin, 'project');
    await upsertTrackingRecord(paths.trackingDir, permissionOnlyPlugin.manifest.name, artifacts);
    await adapter.uninstallExtensions(permissionOnlyPlugin, 'project');

    await expect(fs.readJson(paths.settingsPath)).resolves.toEqual({});
  });

  it('removes Claude generated artifacts without relying on tracking records', async () => {
    const { repoRoot, env } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    const paths = resolveClaudePaths(repoRoot, 'project', env);

    const artifacts = await adapter.installExtensions(plugin, 'project');
    const instructionArtifact = artifacts.find((artifact) => artifact.kind === 'instruction');

    expect(instructionArtifact?.path).toBeTruthy();
    await expect(fs.pathExists(instructionArtifact!.path)).resolves.toBe(true);
    await expect(fs.readJson(paths.settingsPath)).resolves.toMatchObject({
      awGenerated: {
        permissions: {
          'git-commit': {
            allow: ['Bash(git status)', 'Bash(git diff)'],
            ask: ['Bash(git commit)'],
            deny: [],
          },
        },
      },
    });

    await adapter.uninstallExtensions(plugin, 'project', artifacts);

    await expect(fs.pathExists(instructionArtifact!.path)).resolves.toBe(false);
    await expect(fs.readJson(paths.settingsPath)).resolves.toEqual({});
  });

  it('applies Claude upgrade guardrails before reinstalling changed capabilities', async () => {
    const { repoRoot } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new ClaudeAdapter(repoRoot);

    vi.spyOn(adapter, 'status').mockResolvedValueOnce(createStatusReport('missing'));
    await expect(adapter.upgradePlugin(plugin, 'project')).rejects.toThrow(
      'git-commit 当前 catalog 已缺失，请先执行 uninstall。',
    );

    vi.spyOn(adapter, 'status').mockResolvedValueOnce(createStatusReport('capabilityChanged'));
    const uninstallExtensionsSpy = vi.spyOn(adapter, 'uninstallExtensions').mockResolvedValue();
    const installPluginSpy = vi.spyOn(adapter, 'installPlugin').mockResolvedValue();
    const installExtensionsSpy = vi.spyOn(adapter, 'installExtensions').mockResolvedValue([]);

    await expect(adapter.upgradePlugin(plugin, 'project')).resolves.toBeUndefined();
    expect(uninstallExtensionsSpy).toHaveBeenCalledWith(plugin, 'project');
    expect(installPluginSpy).toHaveBeenCalledWith(plugin, 'project');
    expect(installExtensionsSpy).toHaveBeenCalledWith(plugin, 'project', { event: 'upgrade' });
  });

  it('keeps available ledgers unchanged when adding Claude scope records', async () => {
    const { repoRoot } = await makeWorkspace();
    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));

    const nextLedger = await applyClaudeInstallLedger(
      createAvailableLedger(),
      plugin,
      'user',
      repoRoot,
    );

    expect(nextLedger.ledgerState).toEqual({
      status: 'available',
      degradedAt: null,
      reason: null,
    });
  });

  it('detects Claude via injected env and adds the marketplace when local native state is missing', async () => {
    const { repoRoot, env } = await makeWorkspace();
    env.AW_HOME = path.join(path.dirname(repoRoot), 'aw-home');
    env.AW_FORCE_CLAUDE_AVAILABLE = '1';
    await setupLocalMarketplace(repoRoot, env);

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const adapter = new ClaudeAdapter(repoRoot, nativeCliRunner, env);

    await expect(adapter.detect(repoRoot)).resolves.toBe(true);
    await adapter.installPlugin(plugin, 'project');
    await adapter.uninstallPlugin(plugin, 'project');

    expect(nativeCliRunner.mock.calls.map(([invocation]) => invocation.args)).toEqual([
      ['plugin', 'marketplace', 'add', env.AW_HOME, '--scope', 'project'],
      ['plugin', 'install', 'git-commit@aw', '--scope', 'project'],
      ['plugin', 'uninstall', 'git-commit@aw', '--scope', 'project'],
    ]);
  });

  it('skips Claude marketplace add when the active local bundle already matches AW_HOME', async () => {
    const { repoRoot, env } = await makeWorkspace();
    env.AW_HOME = path.join(path.dirname(repoRoot), 'aw-home');
    await setupLocalMarketplace(repoRoot, env);

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
    }));
    const adapter = new ClaudeAdapter(repoRoot, nativeCliRunner, env);
    const paths = resolveClaudePaths(repoRoot, 'project', env);

    await fs.ensureDir(paths.configDir);
    await fs.ensureDir(path.dirname(paths.knownMarketplacesPath));
    await fs.writeJson(
      paths.settingsPath,
      {
        extraKnownMarketplaces: {
          aw: {
            source: env.AW_HOME,
          },
        },
      },
      { spaces: 2 },
    );
    await fs.writeJson(
      paths.knownMarketplacesPath,
      {
        marketplaces: {
          aw: {
            installLocation: env.AW_HOME,
          },
        },
      },
      { spaces: 2 },
    );

    await adapter.installPlugin(plugin, 'project');

    expect(nativeCliRunner.mock.calls.map(([invocation]) => invocation.args)).toEqual([
      ['plugin', 'install', 'git-commit@aw', '--scope', 'project'],
    ]);
  });

  it('reports Claude drift and missing current-catalog entries using the injected local marketplace env', async () => {
    const { repoRoot, env } = await makeWorkspace();
    env.AW_HOME = path.join(path.dirname(repoRoot), 'aw-home');
    await setupLocalMarketplace(repoRoot, env);
    await removePluginFromLocalMarketplace(env.AW_HOME, 'git-commit');

    const plugin = await readPluginManifest(path.join(repoRoot, 'plugins', 'git-commit'));
    const adapter = new ClaudeAdapter(repoRoot, undefined, env);
    const paths = resolveClaudePaths(repoRoot, 'project', env);
    const projectKey = await resolveClaudeProjectKey(repoRoot);
    const driftedSource = path.join(path.dirname(repoRoot), 'drifted-aw');
    const driftedInstallLocation = path.join(path.dirname(repoRoot), 'materialized-aw');

    await fs.ensureDir(paths.configDir);
    await fs.ensureDir(path.join(driftedInstallLocation, '.claude-plugin'));
    await fs.writeJson(
      path.join(driftedInstallLocation, '.claude-plugin', 'marketplace.json'),
      {
        name: 'aw',
        plugins: [],
      },
      { spaces: 2 },
    );
    await fs.ensureDir(path.dirname(paths.knownMarketplacesPath));
    await fs.writeJson(
      paths.settingsPath,
      {
        extraKnownMarketplaces: {
          aw: {
            source: driftedSource,
          },
        },
        plugins: {
          installed: {
            'git-commit': {
              marketplace: 'aw',
              version: '0.1.0',
              installedAt: '2026-04-25T00:00:00.000Z',
              scope: 'project',
              projectPath: projectKey,
            },
          },
        },
      },
      { spaces: 2 },
    );
    await fs.writeJson(
      paths.knownMarketplacesPath,
      {
        marketplaces: {
          aw: {
            installLocation: driftedInstallLocation,
          },
        },
      },
      { spaces: 2 },
    );

    const ledger = await applyClaudeInstallLedger(
      createAvailableLedger(),
      plugin,
      'project',
      repoRoot,
    );
    await writeInstalledLedger(ledger, env);
    await upsertTrackingRecord(paths.trackingDir, plugin.manifest.name, [
      {
        path: path.join(paths.configDir, 'instructions', 'missing.md'),
        kind: 'instruction',
        platform: 'claude',
      },
      {
        path: paths.settingsPath,
        kind: 'permission',
        platform: 'claude',
      },
    ]);

    const status = await adapter.status(plugin, 'project');
    const pluginStatus = status.plugins[0];

    expect(status.initialized).toBe(true);
    expect(pluginStatus).toMatchObject({
      catalogCompatibility: 'missing',
      artifactsInitialized: false,
      native: {
        marketplaceRegistered: true,
        pluginAvailable: false,
        pluginInstalled: false,
        declaredSource: driftedSource,
        materializedInstallLocation: driftedInstallLocation,
      },
      currentCatalog: {
        rootDir: env.AW_HOME,
        source: 'local',
        available: false,
      },
      platformRuntimeEvidence: {
        present: false,
        details: 'materialized marketplace 缺少 git-commit 的 source。',
      },
      platformNativeFallbackEvidence: {
        present: false,
        details: 'installed_plugins.json 未命中 project scope 的 git-commit@aw 记录。',
      },
      scopeManagedEvidence: {
        ledger: true,
        tracking: true,
        sharedNativeRef: false,
      },
      repoManagedSessionState: {
        instructions: 'visible',
        rules: 'absent',
      },
    });
    expect(pluginStatus?.driftWarnings).toEqual(expect.arrayContaining([
      'tracking manifest 记录的 Claude 受管产物存在缺失。',
      'marketplace 已声明，但 declared source 已漂移。',
      'known_marketplaces.json 中的 installLocation 已漂移。',
      'runtime evidence 不完整：materialized marketplace 缺少 git-commit 的 source。',
      'native fallback evidence 不完整：installed_plugins.json 未命中 project scope 的 git-commit@aw 记录。',
    ]));
  });
});
