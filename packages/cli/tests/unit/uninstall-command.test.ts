import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureArtifactRollbackState,
  uninstallCommand,
  uninstallTargetsOnPlatforms,
} from '../../src/commands/uninstall.js';
import { buildGeneratedName } from '../../src/generators/shared.js';
import {
  createMinimalPluginInstallStateFixtureBuilder,
} from '../helpers/minimal-plugin-install-state-fixtures.js';
import {
  refreshDependencyIndexDigestsForP2,
  rewriteSanitizedInstallRecordForP2,
} from '../helpers/install-state-projection-fixtures.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  createAvailableLedger,
  writeInstalledLedger,
} from '../../src/utils/local-marketplace.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from '../../src/utils/plugin-scripts.js';
import {
  resolveClaudePaths,
  resolveCodexPaths,
  resolveClaudeProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import {
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { writeTrackingManifest } from '../../src/utils/tracking.js';
import type {
  GeneratedArtifact,
  LifecycleConfigSnapshotMetadata,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  PluginStatusReport,
  Scope,
  StatusReport,
} from '../../src/types.js';
import type { NativeCliRunner } from '../../src/utils/native-cli.js';
import type { ResolvedPluginTarget } from '../../src/commands/common.js';
import { resolveSafeCliEnv } from '../helpers/cli-runtime.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import {
  getCurrentSourceTestIsolation,
  registerCurrentTestWritableStateRoot,
} from '../setup/test-isolation.js';

function fixturePath(...segments: string[]): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'fixtures',
    ...segments,
  );
}

async function makeBuilder() {
  const root = registerCurrentTestWritableStateRoot(
    await fs.mkdtemp(path.join(os.tmpdir(), 'aw-p9-uninstall-')),
    'uninstall fixture root',
  );
  return createMinimalPluginInstallStateFixtureBuilder(root);
}

function createBuilderEnv(paths: {
  awHome: string;
  codexHome: string;
  claudeHome: string;
}): NodeJS.ProcessEnv {
  return resolveSafeCliEnv({
    AW_HOME: paths.awHome,
    AW_CODEX_HOME: paths.codexHome,
    AW_CLAUDE_HOME: paths.claudeHome,
  });
}

async function ensureRepoPlugin(
  repoRoot: string,
  pluginName: string,
  options: {
    uninstallScriptFile?: string;
    markerFileName?: string;
  } = {},
): Promise<PluginMeta> {
  const pluginRoot = path.join(repoRoot, 'plugins', pluginName);
  await fs.copy(
    path.join(fixturePath('repo-template'), 'plugins', 'git-commit'),
    pluginRoot,
  );
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  manifest.name = pluginName;
  if (options.uninstallScriptFile) {
    manifest.scripts = {
      lifecycle: {
        uninstall: {
          linux: {
            runner: 'node',
            path: options.uninstallScriptFile.startsWith('./')
              ? options.uninstallScriptFile
              : `./${options.uninstallScriptFile}`,
          },
          darwin: {
            runner: 'node',
            path: options.uninstallScriptFile.startsWith('./')
              ? options.uninstallScriptFile
              : `./${options.uninstallScriptFile}`,
          },
          win32: {
            runner: 'node',
            path: options.uninstallScriptFile.startsWith('./')
              ? options.uninstallScriptFile
              : `./${options.uninstallScriptFile}`,
          },
        },
      },
    };
    const scriptPath = path.join(pluginRoot, options.uninstallScriptFile);
    await fs.ensureDir(path.dirname(scriptPath));
    await fs.writeFile(
      scriptPath,
      `import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.AW_HOME, '${options.markerFileName ?? 'marker.txt'}'), 'ok', 'utf8');`,
      'utf8',
    );
  }
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  return readPluginManifest(pluginRoot);
}

async function createLifecycleSnapshotMetadata(options: {
  sourcePluginRoot: string;
  pluginName: string;
  pluginVersion: string;
}): Promise<LifecycleConfigSnapshotMetadata> {
  const snapshotRoot = registerCurrentTestWritableStateRoot(
    await fs.mkdtemp(path.join(os.tmpdir(), 'aw-lifecycle-snapshot-')),
    'uninstall lifecycle snapshot root',
  );

  const bundleRoot = path.join(snapshotRoot, 'bundle');
  await fs.copy(options.sourcePluginRoot, bundleRoot);
  const manifestPath = path.join(bundleRoot, '.agents-plugin', 'plugin.json');

  return {
    snapshotRoot,
    bundleRoot,
    manifestPath,
    pluginName: options.pluginName,
    pluginVersion: options.pluginVersion,
    sourceManifestDigest: await calculateFileDigest(manifestPath),
    bundleFingerprint: await calculatePluginBundleFingerprint(bundleRoot),
    createdAt: '2026-04-28T00:00:00.000Z',
    createdFrom: {
      source: 'currentCatalog',
      pluginRoot: options.sourcePluginRoot,
    },
  };
}

class FakeAdapter implements PlatformAdapter {
  readonly uninstallPluginCalls: string[] = [];
  readonly uninstallExtensionsCalls: string[] = [];
  readonly uninstallExtensionArtifacts: GeneratedArtifact[][] = [];

  async detect(): Promise<boolean> {
    return true;
  }

  async installPlugin(): Promise<void> {}

  async uninstallPlugin(plugin: PluginMeta): Promise<void> {
    this.uninstallPluginCalls.push(plugin.manifest.name);
  }

  async installExtensions(): Promise<GeneratedArtifact[]> {
    return [];
  }

  async uninstallExtensions(
    plugin: PluginMeta,
    _scope: Scope,
    generatedArtifacts: GeneratedArtifact[] = [],
  ): Promise<void> {
    this.uninstallExtensionsCalls.push(plugin.manifest.name);
    this.uninstallExtensionArtifacts.push(structuredClone(generatedArtifacts));
  }

  async upgradePlugin(): Promise<void> {}

  async status(_plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    return {
      platform: 'codex',
      scope,
      initialized: false,
      plugins: [],
    };
  }
}

class VisibleManagedAdapter extends FakeAdapter {
  readonly statusCalls: string[] = [];

  override async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    this.statusCalls.push(plugin.manifest.name);
    return {
      platform: 'codex',
      scope,
      initialized: true,
      plugins: [createManagedPluginStatus(plugin.manifest.name)],
    };
  }
}

function createManagedPluginStatus(pluginName: string): PluginStatusReport {
  return {
    pluginName,
    native: {
      marketplaceRegistered: true,
      pluginAvailable: true,
      pluginInstalled: true,
    },
    generatedArtifacts: [],
    driftWarnings: [],
    ledgerStateStatus: 'available',
    ledgerStateReason: null,
    scopeInitialized: 'yes',
    catalogCompatibility: 'current',
    scopeManagedEvidence: {
      ledger: true,
      tracking: false,
      sharedNativeRef: false,
    },
    platformRuntimeEvidence: {
      present: false,
    },
    platformNativeFallbackEvidence: {
      present: false,
    },
  };
}

function makeRuntime(
  env: NodeJS.ProcessEnv,
  adapters?: Partial<Record<PlatformName, PlatformAdapter>>,
) {
  return {
    env,
    adapters: {
      codex: adapters?.codex ?? new FakeAdapter(),
      claude: adapters?.claude ?? new FakeAdapter(),
    } satisfies Record<PlatformName, PlatformAdapter>,
  };
}

function createAgentVersionRunner(options: {
  codex?: string;
  claude?: string;
} = {}): NativeCliRunner {
  return async (invocation) => {
    if (invocation.args.length !== 1 || invocation.args[0] !== '--version') {
      throw new Error(`Unexpected native CLI invocation in uninstall-command.test.ts: ${invocation.command} ${invocation.args.join(' ')}`.trim());
    }

    if (invocation.command === 'codex') {
      return {
        exitCode: 0,
        stdout: options.codex ?? 'codex-cli 0.145.0',
        stderr: '',
      };
    }

    if (invocation.command === 'claude') {
      return {
        exitCode: 0,
        stdout: options.claude ?? '2.1.88 (Claude Code)',
        stderr: '',
      };
    }

    throw new Error(`Unexpected native CLI command: ${invocation.command}`);
  };
}

function makeTarget(plugin: PluginMeta): ResolvedPluginTarget {
  return {
    pluginName: plugin.manifest.name,
    plugin,
    currentPlugin: plugin,
    source: 'currentCatalog',
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  setEmbeddedPluginsRootOverrideForTests(null);
});

describe('uninstall command (P9 install-state path)', () => {
  it('blocks uninstall rollback staging outside registered temp roots and allows it after registration', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.layout.fixtureCwd, 'rollback-repo');
    await fs.ensureDir(cwd);
    const plugin = await ensureRepoPlugin(cwd, 'git-commit');
    const trackedArtifactPath = path.join(cwd, '.codex', 'instructions.md');
    await fs.outputFile(trackedArtifactPath, 'before\n', 'utf8');
    await writeTrackingManifest(resolveCodexPaths(cwd, 'user', process.env).trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-05-20T00:00:00.000Z',
          artifacts: [{
            path: trackedArtifactPath,
            kind: 'instruction',
            platform: 'codex',
          }],
        },
      },
    });

    const externalTmpRoot = path.join(isolation.layout.rootDir, 'external-uninstall-rollback');
    await fs.ensureDir(externalTmpRoot);

    const tmpdirSpy = vi.spyOn(os, 'tmpdir').mockReturnValue(externalTmpRoot);
    try {
      await expect(
        captureArtifactRollbackState('codex', makeTarget(plugin), 'user', cwd, process.env),
      ).rejects.toThrow(/uninstall rollback staging root/);

      registerCurrentTestWritableStateRoot(
        externalTmpRoot,
        'uninstall rollback staging root',
      );

      const rollbackState = await captureArtifactRollbackState(
        'codex',
        makeTarget(plugin),
        'user',
        cwd,
        process.env,
      );
      expect(rollbackState.cleanupRoots[0]).toContain(externalTmpRoot);
      await fs.remove(rollbackState.cleanupRoots[0]);
    } finally {
      tmpdirSpy.mockRestore();
    }
  });

  it('does not snapshot an existing external Claude skill for a disabled artifact', async () => {
    const builder = await makeBuilder();
    const env = createBuilderEnv(builder.paths);
    const plugin = await ensureRepoPlugin(builder.paths.repoRoot, 'disabled-rollback-skill');
    plugin.manifest.artifacts = {
      targets: [{
        id: 'disabled-skill',
        platform: 'claude',
        scopes: ['project'],
        target: 'claude.skill',
        kind: 'skill',
        states: ['present', 'disabled'],
        refreshKeys: [],
        skillKey: 'disabled-rollback-skill',
      }],
    };
    const skillRoot = path.join(
      builder.paths.repoRoot,
      '.claude',
      'skills',
      'disabled-rollback-skill',
    );
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), '# external\n');
    const claudePaths = resolveClaudePaths(builder.paths.repoRoot, 'project', env);
    await writeTrackingManifest(claudePaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-08-07T00:00:00.000Z',
          artifacts: [{
            path: skillRoot,
            kind: 'skill',
            platform: 'claude',
            artifactKey: 'disabled-rollback-skill',
            id: 'disabled-skill',
            target: 'claude.skill',
            state: 'disabled',
          }],
        },
      },
    });

    const rollbackState = await captureArtifactRollbackState(
      'claude',
      makeTarget(plugin),
      'project',
      builder.paths.repoRoot,
      env,
    );

    expect(rollbackState.pathSnapshots).toEqual([]);
    expect(rollbackState.cleanupRoots).toEqual([]);
    await expect(fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).resolves.toBe('# external\n');
  });

  it('rejects non-canonical Codex agent auxiliary paths without touching the external entry', async () => {
    const builder = await makeBuilder();
    const env = createBuilderEnv(builder.paths);
    const plugin = await ensureRepoPlugin(builder.paths.repoRoot, 'agent-rollback-guard');
    const codexPaths = resolveCodexPaths(builder.paths.repoRoot, 'project', env);
    const rolePath = path.join(
      codexPaths.configDir,
      'agents',
      `${buildGeneratedName(plugin.manifest.name, 'review')}.toml`,
    );
    const externalTarget = path.join(builder.paths.repoRoot, 'external-agent-target.txt');
    const externalLink = path.join(builder.paths.repoRoot, 'external-agent-link');
    await fs.outputFile(rolePath, 'name = "review"\n');
    await fs.outputFile(externalTarget, 'external\n');
    await fs.symlink(externalTarget, externalLink);
    await writeTrackingManifest(codexPaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-08-07T00:00:00.000Z',
          artifacts: [{
            path: rolePath,
            paths: [codexPaths.configTomlPath, rolePath, externalLink],
            kind: 'agent',
            platform: 'codex',
            artifactKey: 'review',
            roleKey: 'review',
            id: 'review-role',
            target: 'codex.agentRole',
            state: 'present',
          }],
        },
      },
    });
    const before = await fs.lstat(externalLink);

    await expect(captureArtifactRollbackState(
      'codex',
      makeTarget(plugin),
      'project',
      builder.paths.repoRoot,
      env,
    )).rejects.toThrow('不是当前 scope 的 canonical config.toml');

    const after = await fs.lstat(externalLink);
    expect(after.isSymbolicLink()).toBe(true);
    expect(after.ino).toBe(before.ino);
    await expect(fs.readFile(externalTarget, 'utf8')).resolves.toBe('external\n');
  });

  it('rejects a non-canonical Codex role main path without touching the external symlink', async () => {
    const builder = await makeBuilder();
    const env = createBuilderEnv(builder.paths);
    const plugin = await ensureRepoPlugin(builder.paths.repoRoot, 'role-main-path-guard');
    const codexPaths = resolveCodexPaths(builder.paths.repoRoot, 'project', env);
    const externalTarget = path.join(builder.paths.repoRoot, 'external-role-target.txt');
    const externalLink = path.join(builder.paths.repoRoot, 'external-role-link');
    await fs.outputFile(externalTarget, 'external role\n');
    await fs.symlink(externalTarget, externalLink);
    await writeTrackingManifest(codexPaths.trackingDir, {
      version: 1,
      plugins: {
        [plugin.manifest.name]: {
          name: plugin.manifest.name,
          generatedAt: '2026-08-07T00:00:00.000Z',
          artifacts: [{
            path: externalLink,
            paths: [codexPaths.configTomlPath, externalLink],
            kind: 'agent',
            platform: 'codex',
            artifactKey: 'review',
            roleKey: 'review',
            id: 'review-role',
            target: 'codex.agentRole',
            state: 'present',
          }],
        },
      },
    });
    const before = await fs.lstat(externalLink);
    const linkTargetBefore = await fs.readlink(externalLink);

    await expect(captureArtifactRollbackState(
      'codex',
      makeTarget(plugin),
      'project',
      builder.paths.repoRoot,
      env,
    )).rejects.toThrow('main path 不是当前 scope 的 canonical 路径');

    const after = await fs.lstat(externalLink);
    expect(after.isSymbolicLink()).toBe(true);
    expect(after.ino).toBe(before.ino);
    await expect(fs.readlink(externalLink)).resolves.toBe(linkTargetBefore);
    await expect(fs.readFile(externalTarget, 'utf8')).resolves.toBe('external role\n');
  });

  it('fails before deletion when the target needs cleanup instead of standard uninstall', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = await builder.writeInstallRecord(target, lifecycle);
    const recordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    );
    await rewriteSanitizedInstallRecordForP2(recordPath);
    await builder.writeNativeMarker(target, 'install');
    await builder.writeDependencyIndex([{ target, record }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    await ensureRepoPlugin(builder.paths.repoRoot, 'git-commit');
    await fs.remove(lifecycle.manifestPath);

    await expect(
      uninstallCommand(
        ['git-commit'],
        {
          cwd: builder.paths.repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        makeRuntime(createBuilderEnv(builder.paths)),
      ),
    ).rejects.toThrow(/\[reason=historicalRuntimeUnavailable\].*historical runtime/);
  });

  it('preserves disabled Claude artifact state when tracking is missing during uninstall', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({
      pluginName: 'disabled-claude-skill',
      platform: 'claude',
      scope: 'project',
      projectKey: builder.paths.repoRoot,
    });
    const skillRoot = path.join(builder.paths.repoRoot, '.claude', 'skills', 'disabled-claude-skill');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), '# unmanaged\n');
    const record = await builder.writeInstallRecord(target);
    record.record.artifacts = [{
      kind: 'skill',
      platform: 'claude',
      path: skillRoot,
      artifactKey: 'disabled-claude-skill',
      id: 'disabled-claude-skill',
      target: 'claude.skill',
      state: 'disabled',
      contentDigest: 'sha256:disabled',
    }];
    const scopedRecords = await builder.readScopedInstallRecordDirectory({
      platform: 'claude',
      scope: 'project',
    });
    const recordPath = scopedRecords.successes.find((entry) => entry.recordId === target.recordId)?.path;
    if (!recordPath) throw new Error('missing disabled Claude install record fixture');
    await fs.writeJson(recordPath, record, { spaces: 2 });
    await builder.writeDependencyIndex([{ target, record }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    const plugin = await ensureRepoPlugin(builder.paths.repoRoot, 'disabled-claude-skill');
    await fs.copy(
      path.join(fixturePath('repo-template'), 'plugins', 'marketplace-source.json'),
      path.join(builder.paths.repoRoot, 'plugins', 'marketplace-source.json'),
    );
    setEmbeddedPluginsRootOverrideForTests(
      await createSyntheticEmbeddedRoot(builder.paths.repoRoot),
    );
    const claude = new FakeAdapter();

    await uninstallTargetsOnPlatforms(
      [makeTarget(plugin)],
      ['claude'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'project',
        platform: 'claude',
      },
      {
        env: createBuilderEnv(builder.paths),
        adapters: {
          codex: new FakeAdapter(),
          claude,
        } satisfies Record<PlatformName, PlatformAdapter>,
      },
    );

    expect(claude.uninstallExtensionArtifacts).toEqual([
      [expect.objectContaining({
        target: 'claude.skill',
        artifactKey: 'disabled-claude-skill',
        state: 'disabled',
      })],
    ]);
    await expect(fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).resolves.toBe('# unmanaged\n');
  });

  it('blocks uninstall when a verified dependent still references the target', async () => {
    const builder = await makeBuilder();
    const child = builder.createTarget({ pluginName: 'cleanup-child', platform: 'codex', scope: 'user' });
    const parent = builder.createTarget({ pluginName: 'cleanup-parent', platform: 'codex', scope: 'user' });

    await builder.writeRepoArtifact(child);
    const childLifecycle = await builder.writeHistoricalLifecycleRuntime(child);
    const childRecord = await builder.writeInstallRecord(child, childLifecycle);
    await builder.writeExternalNativeEvidence(child);
    const childRecordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${child.recordId}.json`,
    );
    await rewriteSanitizedInstallRecordForP2(childRecordPath);

    const parentRecord = await builder.writeInstallRecord(parent);
    const parentRecordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${parent.recordId}.json`,
    );
    const patchedParent = {
      ...parentRecord,
      record: {
        ...parentRecord.record,
        dependencyEdges: [{
          dependency: child.location,
          declaration: {
            name: child.location.plugin,
          },
        }],
      },
    };
    await fs.writeJson(parentRecordPath, patchedParent, { spaces: 2 });
    await rewriteSanitizedInstallRecordForP2(parentRecordPath);
    await builder.writeDependencyIndex([
      { target: child, record: childRecord },
      { target: parent, record: patchedParent },
    ]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));

    const childPlugin = await ensureRepoPlugin(builder.paths.repoRoot, 'cleanup-child');
    const codex = new FakeAdapter();
    const env = createBuilderEnv(builder.paths);

    await expect(
      uninstallTargetsOnPlatforms(
        [makeTarget(childPlugin)],
        ['codex'],
        {
          cwd: builder.paths.repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        makeRuntime(env, { codex }),
      ),
    ).rejects.toThrow(/cleanup-parent/);

    expect(codex.uninstallPluginCalls).toEqual([]);
    expect(codex.uninstallExtensionsCalls).toEqual([]);
  });

  it('fails closed without suggesting repair when visible dependency metadata is incomplete', async () => {
    const builder = await makeBuilder();
    const child = builder.createTarget({ pluginName: 'cleanup-child', platform: 'codex', scope: 'user' });
    const parent = builder.createTarget({ pluginName: 'cleanup-parent', platform: 'codex', scope: 'user' });

    await builder.writeRepoArtifact(parent);
    await builder.writeInstallRecord(parent);

    const parentPlugin = await ensureRepoPlugin(builder.paths.repoRoot, 'cleanup-parent');
    const childPlugin = await ensureRepoPlugin(builder.paths.repoRoot, 'cleanup-child');
    setEmbeddedPluginsRootOverrideForTests(builder.paths.repoRoot);
    const ledger = createAvailableLedger();
    ledger.plugins[parent.location.plugin] = {
      lastResolvedVersion: parentPlugin.manifest.version,
      platforms: {
        codex: {
          lastRequestedScope: 'user',
          lastRequestedAt: parent.timestamps.updatedAt,
          userScope: {
            managed: true,
            updatedAt: parent.timestamps.updatedAt,
            resolvedVersion: parentPlugin.manifest.version,
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
    };
    ledger.plugins[child.location.plugin] = {
      lastResolvedVersion: childPlugin.manifest.version,
      platforms: {
        codex: {
          lastRequestedScope: 'user',
          lastRequestedAt: child.timestamps.updatedAt,
          userScope: {
            managed: true,
            updatedAt: child.timestamps.updatedAt,
            resolvedVersion: childPlugin.manifest.version,
            capabilitySnapshot: {},
            installSource: {
              kind: 'dependency',
              explicitlyRequested: false,
              allowsUnusedCleanup: true,
            },
          },
        },
      },
    };
    const env = createBuilderEnv(builder.paths);
    await writeInstalledLedger(ledger, env);

    const codex = new VisibleManagedAdapter();
    let errorMessage = '';
    try {
      await uninstallCommand(
        [parent.location.plugin],
        {
          cwd: builder.paths.repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        makeRuntime(env, { codex }),
      );
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    expect(codex.statusCalls).toContain('cleanup-child');
    expect(errorMessage).toMatch(/aw status --verbose.*dependency index.*aw cleanup \/ aw reinstall/);
    expect(errorMessage).not.toContain('repair');
    expect(codex.uninstallPluginCalls).toEqual([]);
    expect(codex.uninstallExtensionsCalls).toEqual([]);
  });

  it('runs uninstall lifecycle from the historical runtime instead of current catalog', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });

    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = await builder.writeInstallRecord(target, lifecycle);
    await builder.writeExternalNativeEvidence(target);
    const recordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    );
    await rewriteSanitizedInstallRecordForP2(recordPath);
    await builder.writeDependencyIndex([{ target, record }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));

    const currentPlugin = await ensureRepoPlugin(
      builder.paths.repoRoot,
      'git-commit',
      {
        uninstallScriptFile: 'scripts/current-uninstall.mjs',
        markerFileName: 'current-catalog.txt',
      },
    );
    const historicalManifestPath = path.join(lifecycle.bundleRoot, '.agents-plugin', 'plugin.json');
    await fs.ensureDir(path.dirname(historicalManifestPath));
    const historicalManifest = await fs.readJson(currentPlugin.manifestPath) as Record<string, unknown>;
    historicalManifest.scripts = {
      lifecycle: {
        uninstall: {
          linux: { runner: 'node', path: './scripts/uninstall.mjs' },
          darwin: { runner: 'node', path: './scripts/uninstall.mjs' },
          win32: { runner: 'node', path: './scripts/uninstall.mjs' },
        },
      },
    };
    await fs.ensureDir(path.join(lifecycle.bundleRoot, 'scripts'));
    await fs.writeFile(
      path.join(lifecycle.bundleRoot, 'scripts', 'uninstall.mjs'),
      `import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.AW_HOME, 'historical-runtime.txt'), 'historical', 'utf8');`,
      'utf8',
    );
    await fs.writeJson(historicalManifestPath, historicalManifest, { spaces: 2 });
    const updatedRecord = await fs.readJson(recordPath) as typeof record;
    await fs.writeJson(recordPath, {
      ...updatedRecord,
      record: {
        ...updatedRecord.record,
        source: {
          ...updatedRecord.record.source,
          manifestDigest: await calculateFileDigest(historicalManifestPath),
          bundleFingerprint: await calculatePluginBundleFingerprint(lifecycle.bundleRoot),
        },
        lifecycle: {
          ...lifecycle,
          sourceManifestDigest: await calculateFileDigest(historicalManifestPath),
          bundleFingerprint: await calculatePluginBundleFingerprint(lifecycle.bundleRoot),
        },
      },
    }, { spaces: 2 });
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    const codex = new FakeAdapter();
    const runtime = {
      env: createBuilderEnv(builder.paths),
      adapters: {
        codex,
        claude: new FakeAdapter(),
      } satisfies Record<PlatformName, PlatformAdapter>,
    };

    await uninstallTargetsOnPlatforms(
      [makeTarget(currentPlugin)],
      ['codex'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      runtime,
    );

    expect(codex.uninstallPluginCalls).toEqual(['git-commit']);
    await expect(fs.pathExists(path.join(builder.paths.awHome, 'current-catalog.txt'))).resolves.toBe(false);
  });

  it('fails closed when the historical lifecycle runtime is missing and does not run current catalog lifecycle', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });

    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = await builder.writeInstallRecord(target, lifecycle);
    await builder.writeExternalNativeEvidence(target);
    const recordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    );
    await rewriteSanitizedInstallRecordForP2(recordPath);
    await builder.writeDependencyIndex([{ target, record }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    await fs.remove(lifecycle.runtimeRoot);

    const currentPlugin = await ensureRepoPlugin(
      builder.paths.repoRoot,
      'git-commit',
      {
        uninstallScriptFile: 'scripts/current-uninstall.mjs',
        markerFileName: 'current-catalog.txt',
      },
    );
    const codex = new FakeAdapter();
    const runtime = {
      env: createBuilderEnv(builder.paths),
      adapters: {
        codex,
        claude: new FakeAdapter(),
      } satisfies Record<PlatformName, PlatformAdapter>,
    };

    await expect(
      uninstallTargetsOnPlatforms(
        [makeTarget(currentPlugin)],
        ['codex'],
        {
          cwd: builder.paths.repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        runtime,
      ),
    ).rejects.toThrow();

    expect(codex.uninstallPluginCalls).toEqual([]);
    await expect(fs.pathExists(path.join(builder.paths.awHome, 'current-catalog.txt'))).resolves.toBe(false);
  });

  it('removes the AW-managed config store after uninstall succeeds when --remove-config is set', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = await builder.writeInstallRecord(target, lifecycle);
    const recordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    );
    await rewriteSanitizedInstallRecordForP2(recordPath);
    await builder.writeExternalNativeEvidence(target);
    await builder.writeDependencyIndex([{ target, record }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    const plugin = await ensureRepoPlugin(builder.paths.repoRoot, 'git-commit');
    await fs.remove(lifecycle.bundleRoot);
    await fs.copy(path.join(builder.paths.repoRoot, 'plugins', 'git-commit'), lifecycle.bundleRoot);
    const manifestPath = path.join(lifecycle.bundleRoot, '.agents-plugin', 'plugin.json');
    await fs.writeJson(recordPath, {
      ...record,
      record: {
        ...record.record,
        source: {
          ...record.record.source,
          pluginVersion: plugin.manifest.version,
          manifestDigest: await calculateFileDigest(manifestPath),
          bundleFingerprint: await calculatePluginBundleFingerprint(lifecycle.bundleRoot),
        },
        lifecycle: {
          ...lifecycle,
          manifestPath,
          pluginVersion: plugin.manifest.version,
          sourceManifestDigest: await calculateFileDigest(manifestPath),
          bundleFingerprint: await calculatePluginBundleFingerprint(lifecycle.bundleRoot),
        },
      },
    }, { spaces: 2 });
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));

    const configStorePath = resolvePluginConfigStorePath({
      pluginName: 'git-commit',
      scope: 'user',
      cwd: builder.paths.repoRoot,
      env: createBuilderEnv(builder.paths),
    });
    await fs.outputJson(configStorePath, { token: 'secret' }, { spaces: 2 });

    const result = await uninstallCommand(
      ['git-commit'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
        removeConfig: true,
      },
      makeRuntime(createBuilderEnv(builder.paths)),
    );

    expect(result.receiptDetails?.configStoreRemovals).toEqual([{
      store: {
        pluginName: 'git-commit',
        storeKind: 'user',
      },
      state: 'removed',
      subjectTargets: [{
        pluginName: 'git-commit',
        platform: 'codex',
        scope: 'user',
      }],
      path: configStorePath,
    }]);
    await expect(fs.pathExists(configStorePath)).resolves.toBe(false);
  });

  it('preserves successful uninstall results when --remove-config fails after the main uninstall', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = await builder.writeInstallRecord(target, lifecycle);
    const recordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    );
    await rewriteSanitizedInstallRecordForP2(recordPath);
    await builder.writeExternalNativeEvidence(target);
    await builder.writeDependencyIndex([{ target, record }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    const plugin = await ensureRepoPlugin(builder.paths.repoRoot, 'git-commit');
    await fs.remove(lifecycle.bundleRoot);
    await fs.copy(path.join(builder.paths.repoRoot, 'plugins', 'git-commit'), lifecycle.bundleRoot);
    const manifestPath = path.join(lifecycle.bundleRoot, '.agents-plugin', 'plugin.json');
    await fs.writeJson(recordPath, {
      ...record,
      record: {
        ...record.record,
        source: {
          ...record.record.source,
          pluginVersion: plugin.manifest.version,
          manifestDigest: await calculateFileDigest(manifestPath),
          bundleFingerprint: await calculatePluginBundleFingerprint(lifecycle.bundleRoot),
        },
        lifecycle: {
          ...lifecycle,
          manifestPath,
          pluginVersion: plugin.manifest.version,
          sourceManifestDigest: await calculateFileDigest(manifestPath),
          bundleFingerprint: await calculatePluginBundleFingerprint(lifecycle.bundleRoot),
        },
      },
    }, { spaces: 2 });
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));

    const configStorePath = resolvePluginConfigStorePath({
      pluginName: 'git-commit',
      scope: 'user',
      cwd: builder.paths.repoRoot,
      env: createBuilderEnv(builder.paths),
    });
    await fs.outputJson(configStorePath, { token: 'secret' }, { spaces: 2 });

    const originalRemove = fs.remove.bind(fs);
    vi.spyOn(fs, 'remove').mockImplementation(async (targetPath) => {
      if (targetPath === configStorePath) {
        throw new Error('synthetic config removal failure');
      }
      return originalRemove(targetPath);
    });

    const result = await uninstallCommand(
      ['git-commit'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
        removeConfig: true,
      },
      makeRuntime(createBuilderEnv(builder.paths)),
    );

    expect(result.receiptDetails).toMatchObject({
      configRemovalActions: [{
        plugin: 'git-commit',
        scope: 'user',
        path: configStorePath,
        status: 'failed',
        reason: 'synthetic config removal failure',
      }],
      configStoreRemovals: [{
        store: {
          pluginName: 'git-commit',
          storeKind: 'user',
        },
        state: 'failed',
        reasonCode: 'removeFailed',
        subjectTargets: [{
          pluginName: 'git-commit',
          platform: 'codex',
          scope: 'user',
        }],
        path: configStorePath,
        message: 'synthetic config removal failure',
      }],
    });
    expect(result.warnings.join('\n')).toContain('主体卸载已完成，但删除 git-commit 的 AW 自管配置失败');
    await expect(fs.pathExists(recordPath)).resolves.toBe(false);
    await expect(fs.pathExists(configStorePath)).resolves.toBe(true);
  });
});
