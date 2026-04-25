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
import { createAvailableLedger } from '../../src/utils/local-marketplace.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { resolveClaudePaths, resolveClaudeProjectKey } from '../../src/utils/paths.js';
import { upsertTrackingRecord } from '../../src/utils/tracking.js';

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
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

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
            managedExtensions: ['instructions', 'permissions'],
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
          managedExtensions: ['instructions', 'permissions'],
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
        allow: ['git diff', 'git status', 'manual:allow', 'old:allow'],
        ask: ['git commit', 'manual:ask', 'old:ask'],
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
            allow: ['git status', 'git diff'],
            ask: ['git commit'],
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
            allow: ['git status', 'git diff'],
            ask: ['git commit'],
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
    expect(installExtensionsSpy).toHaveBeenCalledWith(plugin, 'project');
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
});
