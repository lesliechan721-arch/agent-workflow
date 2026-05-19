import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { uninstallCommand, uninstallTargetsOnPlatforms } from '../../src/commands/uninstall.js';
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
  patchClaudeSkillFrontmatter,
  patchCodexOpenAiYaml,
} from '../../src/utils/skill-trigger-preferences.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from '../../src/utils/plugin-scripts.js';
import {
  resolveClaudeProjectKey,
  setEmbeddedPluginsRootOverrideForTests,
} from '../../src/utils/paths.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import type {
  GeneratedArtifact,
  LifecycleConfigSnapshotMetadata,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  Scope,
  StatusReport,
} from '../../src/types.js';
import type { ResolvedPluginTarget } from '../../src/commands/common.js';
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

async function makeBuilder() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-p9-uninstall-'));
  tempDirs.push(root);
  return createMinimalPluginInstallStateFixtureBuilder(root);
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
  const snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-lifecycle-snapshot-'));
  tempDirs.push(snapshotRoot);

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

  async uninstallExtensions(plugin: PluginMeta): Promise<void> {
    this.uninstallExtensionsCalls.push(plugin.manifest.name);
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
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('uninstall command (P9 install-state path)', () => {
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

    await expect(
      uninstallCommand(
        ['git-commit'],
        {
          cwd: builder.paths.repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        makeRuntime({
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        }),
      ),
    ).rejects.toThrow(/\[reason=unsafeStandardUninstall\].*aw cleanup/);
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
    const env = {
      ...process.env,
      AW_HOME: builder.paths.awHome,
      AW_CODEX_HOME: builder.paths.codexHome,
      AW_CLAUDE_HOME: builder.paths.claudeHome,
    };

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
      env: {
        ...process.env,
        AW_HOME: builder.paths.awHome,
        AW_CODEX_HOME: builder.paths.codexHome,
        AW_CLAUDE_HOME: builder.paths.claudeHome,
      },
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
      env: {
        ...process.env,
        AW_HOME: builder.paths.awHome,
        AW_CODEX_HOME: builder.paths.codexHome,
        AW_CLAUDE_HOME: builder.paths.claudeHome,
      },
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
      env: {
        ...process.env,
        AW_HOME: builder.paths.awHome,
      },
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
      makeRuntime({
        ...process.env,
        AW_HOME: builder.paths.awHome,
        AW_CODEX_HOME: builder.paths.codexHome,
        AW_CLAUDE_HOME: builder.paths.claudeHome,
      }),
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
      env: {
        ...process.env,
        AW_HOME: builder.paths.awHome,
      },
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
      makeRuntime({
        ...process.env,
        AW_HOME: builder.paths.awHome,
        AW_CODEX_HOME: builder.paths.codexHome,
        AW_CLAUDE_HOME: builder.paths.claudeHome,
      }),
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

class LegacyClaudeAdapter extends FakeAdapter {
  override async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    return {
      platform: 'claude',
      scope,
      initialized: true,
      plugins: [{
        pluginName: plugin.manifest.name,
        native: {
          marketplaceRegistered: true,
          pluginAvailable: true,
          pluginInstalled: true,
          version: plugin.manifest.version,
        },
        generatedArtifacts: [],
        driftWarnings: [],
        ledgerStateStatus: 'available',
        ledgerStateReason: null,
        scopeInitialized: 'yes',
        catalogCompatibility: 'current',
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
          source: 'local',
          available: true,
        },
        artifactsInitialized: true,
        repoManagedSessionState: {
          instructions: 'absent',
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

describe('uninstall command (legacy shared-runtime replay)', () => {
  it('replays surviving Claude preferences when the embedded manifest is unreadable', async () => {
    const builder = await makeBuilder();
    await fs.copy(fixturePath('repo-template'), builder.paths.repoRoot);
    const repoPlugin = await ensureRepoPlugin(builder.paths.repoRoot, 'git-commit');
    const pristineEmbeddedRoot = await createSyntheticEmbeddedRoot(builder.paths.repoRoot);
    tempDirs.push(pristineEmbeddedRoot);

    const localBundleRoot = path.join(builder.paths.awHome, 'plugins', 'git-commit');
    await fs.copy(path.join(pristineEmbeddedRoot, 'plugins', 'git-commit'), localBundleRoot);
    await patchClaudeSkillFrontmatter(
      path.join(localBundleRoot, 'claude', 'skills', 'commit', 'SKILL.md'),
      'auto',
    );
    await expect(
      fs.readFile(path.join(localBundleRoot, 'claude', 'skills', 'commit', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('disable-model-invocation: false');

    const projectKey = await resolveClaudeProjectKey(builder.paths.repoRoot);
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: repoPlugin.manifest.version,
      platforms: {
        claude: {
          lastRequestedScope: 'user',
          lastRequestedAt: '2026-04-28T00:00:02.000Z',
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:02.000Z',
            resolvedVersion: repoPlugin.manifest.version,
            capabilitySnapshot: {
              managedExtensions: [],
            },
            installOptions: {
              skillTriggerPreference: 'auto',
            },
            skillTriggerWriteOrder: 2,
          },
          projectScopes: {
            [projectKey]: {
              managed: true,
              updatedAt: '2026-04-28T00:00:01.000Z',
              resolvedVersion: repoPlugin.manifest.version,
              capabilitySnapshot: {
                managedExtensions: [],
              },
              installOptions: {
                skillTriggerPreference: 'manual',
              },
              skillTriggerWriteOrder: 1,
            },
          },
        },
      },
    };
    const env = {
      ...process.env,
      AW_HOME: builder.paths.awHome,
      AW_CODEX_HOME: builder.paths.codexHome,
      AW_CLAUDE_HOME: builder.paths.claudeHome,
    };
    await writeInstalledLedger(ledger, env);

    const brokenEmbeddedRoot = await createSyntheticEmbeddedRoot(builder.paths.repoRoot);
    tempDirs.push(brokenEmbeddedRoot);
    await fs.writeFile(
      path.join(brokenEmbeddedRoot, 'plugins', 'git-commit', '.agents-plugin', 'plugin.json'),
      '{"name":',
      'utf8',
    );
    setEmbeddedPluginsRootOverrideForTests(brokenEmbeddedRoot);

    const currentPlugin = await readPluginManifest(localBundleRoot, { mode: 'bundle' });
    const target: ResolvedPluginTarget = {
      pluginName: 'git-commit',
      plugin: currentPlugin,
      currentPlugin,
      embeddedPlugin: undefined,
      source: 'currentCatalog',
    };

    const claude = new LegacyClaudeAdapter();
    const result = await uninstallTargetsOnPlatforms(
      [target],
      ['claude'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'claude',
      },
      makeRuntime(env, { claude }),
    );

    expect(result.warnings).toEqual([]);
    await expect(
      fs.readFile(path.join(localBundleRoot, 'claude', 'skills', 'commit', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('disable-model-invocation: true');
  });

  it('replays surviving Claude preferences from the winning scope snapshot when the embedded root is unavailable', async () => {
    const builder = await makeBuilder();
    await fs.copy(fixturePath('repo-template'), builder.paths.repoRoot);
    const repoPlugin = await ensureRepoPlugin(builder.paths.repoRoot, 'git-commit');
    const pristineEmbeddedRoot = await createSyntheticEmbeddedRoot(builder.paths.repoRoot);
    tempDirs.push(pristineEmbeddedRoot);

    const localBundleRoot = path.join(builder.paths.awHome, 'plugins', 'git-commit');
    const pristinePluginRoot = path.join(pristineEmbeddedRoot, 'plugins', 'git-commit');
    await fs.copy(pristinePluginRoot, localBundleRoot);
    await patchClaudeSkillFrontmatter(
      path.join(localBundleRoot, 'claude', 'skills', 'commit', 'SKILL.md'),
      'auto',
    );
    await expect(
      fs.readFile(path.join(localBundleRoot, 'claude', 'skills', 'commit', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('disable-model-invocation: false');

    const projectSnapshot = await createLifecycleSnapshotMetadata({
      sourcePluginRoot: pristinePluginRoot,
      pluginName: repoPlugin.manifest.name,
      pluginVersion: repoPlugin.manifest.version,
    });

    const projectKey = await resolveClaudeProjectKey(builder.paths.repoRoot);
    const ledger = createAvailableLedger();
    ledger.plugins['git-commit'] = {
      lastResolvedVersion: repoPlugin.manifest.version,
      platforms: {
        claude: {
          lastRequestedScope: 'user',
          lastRequestedAt: '2026-04-28T00:00:02.000Z',
          userScope: {
            managed: true,
            updatedAt: '2026-04-28T00:00:02.000Z',
            resolvedVersion: repoPlugin.manifest.version,
            capabilitySnapshot: {
              managedExtensions: [],
            },
            installOptions: {
              skillTriggerPreference: 'auto',
            },
            skillTriggerWriteOrder: 2,
          },
          projectScopes: {
            [projectKey]: {
              managed: true,
              updatedAt: '2026-04-28T00:00:01.000Z',
              resolvedVersion: repoPlugin.manifest.version,
              capabilitySnapshot: {
                managedExtensions: [],
              },
              installOptions: {
                skillTriggerPreference: 'manual',
              },
              skillTriggerWriteOrder: 1,
              lifecycleConfigSnapshot: projectSnapshot,
            },
          },
        },
      },
    };
    const env = {
      ...process.env,
      AW_HOME: builder.paths.awHome,
      AW_CODEX_HOME: builder.paths.codexHome,
      AW_CLAUDE_HOME: builder.paths.claudeHome,
    };
    await writeInstalledLedger(ledger, env);

    setEmbeddedPluginsRootOverrideForTests(path.join(builder.paths.repoRoot, 'missing-plugins-dist'));

    const currentPlugin = await readPluginManifest(localBundleRoot, { mode: 'bundle' });
    const target: ResolvedPluginTarget = {
      pluginName: 'git-commit',
      plugin: currentPlugin,
      currentPlugin,
      embeddedPlugin: undefined,
      source: 'currentCatalog',
    };

    const claude = new LegacyClaudeAdapter();
    const result = await uninstallTargetsOnPlatforms(
      [target],
      ['claude'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'claude',
      },
      makeRuntime(env, { claude }),
    );

    expect(result.warnings).toEqual([]);
    await expect(
      fs.readFile(path.join(localBundleRoot, 'claude', 'skills', 'commit', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('disable-model-invocation: true');
  });

  it('replays verified default runtime before releasing the shared owner when the embedded root is unavailable', async () => {
    const builder = await makeBuilder();
    await fs.copy(fixturePath('repo-template'), builder.paths.repoRoot);
    const embeddedRoot = await createSyntheticEmbeddedRoot(builder.paths.repoRoot);
    tempDirs.push(embeddedRoot);

    const targetState = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
    const pristinePluginRoot = path.join(embeddedRoot, 'plugins', 'git-commit');
    const localBundleRoot = path.join(builder.paths.awHome, 'plugins', 'git-commit');
    await fs.copy(pristinePluginRoot, localBundleRoot);
    await patchCodexOpenAiYaml(
      path.join(localBundleRoot, 'codex', 'skills', 'commit', 'agents', 'openai.yaml'),
      'manual',
    );
    await expect(
      fs.readFile(path.join(localBundleRoot, 'codex', 'skills', 'commit', 'agents', 'openai.yaml'), 'utf8'),
    ).resolves.toContain('allow_implicit_invocation: false');

    await builder.writeRepoArtifact(targetState);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(targetState);
    await fs.remove(lifecycle.bundleRoot);
    await fs.copy(pristinePluginRoot, lifecycle.bundleRoot);
    const manifestPath = path.join(lifecycle.bundleRoot, '.agents-plugin', 'plugin.json');
    const currentPlugin = await readPluginManifest(localBundleRoot, { mode: 'bundle' });
    const verifiedLifecycle = {
      ...lifecycle,
      manifestPath,
      pluginVersion: currentPlugin.manifest.version,
      sourceManifestDigest: await calculateFileDigest(manifestPath),
      bundleFingerprint: await calculatePluginBundleFingerprint(lifecycle.bundleRoot),
    };
    const record = await builder.writeInstallRecord(targetState, verifiedLifecycle);
    const recordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${targetState.recordId}.json`,
    );
    const patchedRecord = {
      ...record,
      record: {
        ...record.record,
        source: {
          pluginVersion: verifiedLifecycle.pluginVersion,
          manifestDigest: verifiedLifecycle.sourceManifestDigest,
          bundleFingerprint: verifiedLifecycle.bundleFingerprint,
        },
      },
    };
    await fs.writeJson(recordPath, patchedRecord, { spaces: 2 });
    await rewriteSanitizedInstallRecordForP2(recordPath);
    await builder.writeExternalNativeEvidence(targetState);
    await builder.writeSharedRuntimeOwner(targetState, recordPath);
    await builder.writeDependencyIndex([{ target: targetState, record: patchedRecord }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));

    setEmbeddedPluginsRootOverrideForTests(path.join(builder.paths.repoRoot, 'missing-plugins-dist'));

    const codex = new FakeAdapter();
    const result = await uninstallTargetsOnPlatforms(
      [{
        pluginName: 'git-commit',
        plugin: currentPlugin,
        currentPlugin,
        embeddedPlugin: undefined,
        source: 'currentCatalog',
      }],
      ['codex'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      makeRuntime(
        {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        },
        { codex },
      ),
    );

    expect(result.warnings.join('\n')).toContain('embedded bundle 不可用');
    await expect(
      fs.readFile(path.join(localBundleRoot, 'codex', 'skills', 'commit', 'agents', 'openai.yaml'), 'utf8'),
    ).resolves.toContain('allow_implicit_invocation: true');
  });

  it('releases the shared owner when the verified historical bundle has no shared skill runtime', async () => {
    const builder = await makeBuilder();
    const targetState = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
    const recordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${targetState.recordId}.json`,
    );
    const ownerPath = path.join(
      builder.paths.awHome,
      'shared-runtime-owners',
      'codex',
      `${targetState.pluginSlug}.${targetState.pluginHash}.json`,
    );

    await builder.writeRepoArtifact(targetState);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(targetState);
    await builder.writeInstallRecord(targetState, lifecycle);
    const sanitizedRecord = await rewriteSanitizedInstallRecordForP2(recordPath);
    const verifiedLifecycle = {
      ...lifecycle,
      sourceManifestDigest: await calculateFileDigest(lifecycle.manifestPath),
      bundleFingerprint: await calculatePluginBundleFingerprint(lifecycle.bundleRoot),
    };
    const patchedRecord = {
      ...sanitizedRecord,
      record: {
        ...sanitizedRecord.record,
        source: {
          ...sanitizedRecord.record.source,
          manifestDigest: verifiedLifecycle.sourceManifestDigest,
          bundleFingerprint: verifiedLifecycle.bundleFingerprint,
        },
        lifecycle: verifiedLifecycle,
      },
    };
    await fs.writeJson(recordPath, patchedRecord, { spaces: 2 });
    await builder.writeExternalNativeEvidence(targetState);
    await builder.writeSharedRuntimeOwner(targetState, recordPath);
    await builder.writeDependencyIndex([{ target: targetState, record: patchedRecord }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));

    const currentPlugin = await ensureRepoPlugin(builder.paths.repoRoot, 'git-commit');
    setEmbeddedPluginsRootOverrideForTests(path.join(builder.paths.repoRoot, 'missing-plugins-dist'));

    const codex = new FakeAdapter();
    const result = await uninstallTargetsOnPlatforms(
      [makeTarget(currentPlugin)],
      ['codex'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      makeRuntime(
        {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        },
        { codex },
      ),
    );

    expect(result.warnings).toEqual([]);
    await expect(fs.pathExists(ownerPath)).resolves.toBe(false);
    await expect(fs.pathExists(recordPath)).resolves.toBe(false);
    expect(codex.uninstallPluginCalls).toEqual(['git-commit']);
  });
});
