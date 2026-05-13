import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanupCommand } from '../../src/commands/cleanup.js';
import { renderCleanupReceipt } from '../../src/output/command-receipt.js';
import { createDependencyIndexPruneToken } from '../../src/install-state/transactions.js';
import {
  createMinimalPluginInstallStateFixtureBuilder,
  writeMinimalPluginInstallStateFixture,
} from '../helpers/minimal-plugin-install-state-fixtures.js';
import {
  refreshDependencyIndexDigestsForP2,
  rewriteSanitizedInstallRecordForP2,
} from '../helpers/install-state-projection-fixtures.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  calculateFileDigest,
  calculatePluginBundleFingerprint,
} from '../../src/utils/plugin-scripts.js';
import { removeCodexPluginEnabledFile } from '../../src/utils/codex-config.js';
import { createAvailableLedger, writeInstalledLedger } from '../../src/utils/local-marketplace.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  Scope,
  StatusReport,
} from '../../src/types.js';

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-p9-cleanup-'));
  tempDirs.push(root);
  return createMinimalPluginInstallStateFixtureBuilder(root);
}

async function ensureRepoPlugin(
  repoRoot: string,
  pluginName: string,
  markerFileName = 'cleanup-should-not-run.txt',
): Promise<PluginMeta> {
  const pluginRoot = path.join(repoRoot, 'plugins', pluginName);
  await fs.copy(
    path.join(fixturePath('repo-template'), 'plugins', 'git-commit'),
    pluginRoot,
  );
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
  manifest.name = pluginName;
  manifest.scripts = {
    lifecycle: {
      uninstall: {
        linux: { runner: 'node', path: './scripts/uninstall.mjs' },
        darwin: { runner: 'node', path: './scripts/uninstall.mjs' },
        win32: { runner: 'node', path: './scripts/uninstall.mjs' },
      },
    },
  };
  await fs.ensureDir(path.join(pluginRoot, 'scripts'));
  await fs.writeFile(
    path.join(pluginRoot, 'scripts', 'uninstall.mjs'),
    `import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.AW_HOME, '${markerFileName}'), 'ran', 'utf8');`,
    'utf8',
  );
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  return readPluginManifest(pluginRoot);
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

class FakeCodexNativeCleanupAdapter extends FakeAdapter {
  readonly uninstallUserNativePluginByIdCalls: string[] = [];
  private readonly protectedPluginIds: Set<string>;

  constructor(
    private readonly configPath: string,
    private readonly cacheRootPath?: string,
    private readonly installRootPath?: string,
    options: {
      protectedPluginIds?: string[];
    } = {},
  ) {
    super();
    this.protectedPluginIds = new Set(options.protectedPluginIds ?? []);
  }

  private async isPluginEnabledInConfig(pluginNameOrId: string): Promise<boolean> {
    if (!(await fs.pathExists(this.configPath))) {
      return false;
    }
    const content = await fs.readFile(this.configPath, 'utf8');
    const pluginId = pluginNameOrId.endsWith('@aw') ? pluginNameOrId : `${pluginNameOrId}@aw`;
    return content.includes(`[plugins."${pluginId}"]`) && content.includes('enabled = true');
  }

  override async uninstallPlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    await super.uninstallPlugin(plugin, scope);
    if (this.protectedPluginIds.has(`${plugin.manifest.name}@aw`)) {
      return;
    }
    if (!(await this.isPluginEnabledInConfig(plugin.manifest.name))) {
      return;
    }
    await removeCodexPluginEnabledFile(this.configPath, `${plugin.manifest.name}@aw`);
    if (this.cacheRootPath) {
      await fs.remove(this.cacheRootPath);
    }
    if (this.installRootPath) {
      await fs.remove(this.installRootPath);
    }
  }

  async uninstallUserNativePluginById(pluginNameOrId: string): Promise<void> {
    this.uninstallUserNativePluginByIdCalls.push(pluginNameOrId);
    await removeCodexPluginEnabledFile(this.configPath, pluginNameOrId);
    if (this.cacheRootPath) {
      await fs.remove(this.cacheRootPath);
    }
    if (this.installRootPath) {
      await fs.remove(this.installRootPath);
    }
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('cleanup command (P9)', () => {
  it('cleans healthy installed targets through the standard uninstall-equivalent path', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'claude', scope: 'user' });
    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = await builder.writeInstallRecord(target, lifecycle);
    const recordPath = path.join(
      builder.paths.claudeHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    );
    await rewriteSanitizedInstallRecordForP2(recordPath);
    await builder.writeDependencyIndex([{ target, record }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    const plugin = await ensureRepoPlugin(builder.paths.repoRoot, 'git-commit', 'cleanup-ran.txt');
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

    const claude = new FakeAdapter();
    const result = await cleanupCommand(
      ['git-commit'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'claude',
      },
      {
        env: {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        },
        adapters: {
          codex: new FakeAdapter(),
          claude,
        } satisfies Record<PlatformName, PlatformAdapter>,
      },
    );

    expect(result.payload).toMatchObject({
      command: 'cleanup',
      dependencyIndex: false,
      cleanupPlanSchemaVersion: 1,
      dryRun: false,
      target: {
        plugin: 'git-commit',
        platform: 'claude',
        scope: 'user',
        targetType: 'installed',
      },
    });
    expect(claude.uninstallPluginCalls).toEqual(['git-commit']);
    await expect(fs.readFile(path.join(builder.paths.awHome, 'cleanup-ran.txt'), 'utf8')).resolves.toBe('ran');
    await expect(fs.pathExists(recordPath)).resolves.toBe(false);
  });

  it('downgrades healthy installed cleanup to recovery cleanup when --force is set and standard uninstall target resolution fails', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'claude', scope: 'user' });
    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = await builder.writeInstallRecord(target, lifecycle);
    const recordPath = path.join(
      builder.paths.claudeHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    );
    await rewriteSanitizedInstallRecordForP2(recordPath);
    await builder.writeDependencyIndex([{ target, record }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    await ensureRepoPlugin(builder.paths.repoRoot, 'git-commit', 'fallback-cleanup-should-not-run.txt');

    const claude = new FakeAdapter();
    const result = await cleanupCommand(
      ['git-commit'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'claude',
        force: true,
      },
      {
        env: {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        },
        p9TargetResolver: async () => {
          throw new Error('synthetic target resolution failure');
        },
        adapters: {
          codex: new FakeAdapter(),
          claude,
        } satisfies Record<PlatformName, PlatformAdapter>,
      },
    );

    expect(result.payload).toMatchObject({
      command: 'cleanup',
      dependencyIndex: false,
      dryRun: false,
      force: true,
      target: {
        plugin: 'git-commit',
        platform: 'claude',
        scope: 'user',
        targetType: 'installed',
      },
      blockingReasons: [],
      actualBackups: [],
      actualRemovals: expect.arrayContaining([
        expect.objectContaining({
          kind: 'install-record',
        }),
      ]),
    });
    expect(result.payload.forceReason).toContain('标准 uninstall 等价路径不可用');
    expect(result.warnings.join('\n')).toContain('已因 --force 降级为恢复清理');
    expect(claude.uninstallPluginCalls).toEqual(['git-commit']);
    await expect(fs.pathExists(recordPath)).resolves.toBe(false);
    await expect(fs.pathExists(path.join(builder.paths.awHome, 'fallback-cleanup-should-not-run.txt'))).resolves.toBe(false);
  });

  it('cleans record plus install-marker residuals without running uninstall lifecycle', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });

    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = await builder.writeInstallRecord(target, lifecycle);
    await rewriteSanitizedInstallRecordForP2(path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    ));
    await builder.writeDiagnosticCache(target);
    await builder.writeNativeMarker(target, 'install');
    await builder.writeDependencyIndex([{ target, record }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    await ensureRepoPlugin(builder.paths.repoRoot, 'git-commit');

    const codex = new FakeAdapter();
    await cleanupCommand(
      ['git-commit'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
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
      },
    );

    await expect(fs.pathExists(path.join(builder.paths.codexHome, '.agent-workflows', 'records', `${target.recordId}.json`))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(builder.paths.codexHome, '.agent-workflows', 'diagnostics', `${target.recordId}.json`))).resolves.toBe(false);
    await expect(fs.pathExists(lifecycle.runtimeRoot)).resolves.toBe(false);
    await expect(fs.pathExists(path.join(builder.paths.awHome, 'native-recovery', 'codex', 'user', `${target.pluginId}.json`))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(builder.paths.awHome, 'cleanup-should-not-run.txt'))).resolves.toBe(false);
    const index = await fs.readJson(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    expect(index.records).toEqual([]);
    expect(codex.uninstallPluginCalls).toEqual(['git-commit']);
  });

  it('requires --force before cleaning a shared runtime owner when the embedded bundle is unavailable', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
    const recordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    );
    const ownerPath = path.join(
      builder.paths.awHome,
      'shared-runtime-owners',
      'codex',
      `${target.pluginSlug}.${target.pluginHash}.json`,
    );

    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = await builder.writeInstallRecord(target, lifecycle);
    await rewriteSanitizedInstallRecordForP2(recordPath);
    await builder.writeNativeMarker(target, 'install');
    await builder.writeSharedRuntimeOwner(target, recordPath);
    await builder.writeDependencyIndex([{ target, record }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    await ensureRepoPlugin(builder.paths.repoRoot, 'git-commit');

    setEmbeddedPluginsRootOverrideForTests(path.join(builder.paths.repoRoot, 'missing-plugins-dist'));

    const runtime = {
      env: {
        ...process.env,
        AW_HOME: builder.paths.awHome,
        AW_CODEX_HOME: builder.paths.codexHome,
        AW_CLAUDE_HOME: builder.paths.claudeHome,
      },
      p9TargetResolver: async () => {
        throw new Error('synthetic target resolution failure');
      },
      adapters: {
        codex: new FakeAdapter(),
        claude: new FakeAdapter(),
      } satisfies Record<PlatformName, PlatformAdapter>,
    };

    await expect(
      cleanupCommand(
        ['git-commit'],
        {
          cwd: builder.paths.repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        runtime,
      ),
    ).rejects.toThrow(/如需跳过 runtime 重放并强制清理 owner，请加 --force/);
    await expect(fs.pathExists(ownerPath)).resolves.toBe(true);
    await expect(fs.pathExists(recordPath)).resolves.toBe(true);

    const result = await cleanupCommand(
      ['git-commit'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
        force: true,
      },
      runtime,
    );

    await expect(fs.pathExists(ownerPath)).resolves.toBe(false);
    await expect(fs.pathExists(recordPath)).resolves.toBe(false);
  });

  it('prunes stale dependency-index entries without deleting project files', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await fs.mkdtemp(path.join(os.tmpdir(), 'aw-p9-prune-stale-')),
      scenario: 'staleDependencyIndex',
    });
    tempDirs.push(fixture.paths.rootDir);
    const indexPath = fixture.files.dependencyIndexPath;
    const before = await fs.readJson(indexPath);
    const digest = await fs.readFile(indexPath).then((buffer) => import('../../src/install-state/internal.js').then((mod) => mod.sha256Hex(buffer)));
    const token = createDependencyIndexPruneToken({
      location: fixture.target.location,
      recordPath: fixture.files.installRecordPath,
      indexDigest: digest,
    });

    const result = await cleanupCommand(
      [],
      {
        cwd: fixture.paths.repoRoot,
        dependencyIndex: true,
        pruneStale: token,
        yes: true,
      },
      {
        env: {
          ...process.env,
          AW_HOME: fixture.paths.awHome,
          AW_CODEX_HOME: fixture.paths.codexHome,
          AW_CLAUDE_HOME: fixture.paths.claudeHome,
        },
      },
    );

    expect(result.retiredEntries).toEqual([{
      location: fixture.target.location,
      recordPath: fixture.files.installRecordPath,
    }]);
    expect(result.payload).toMatchObject({
      command: 'cleanup',
      dependencyIndex: true,
      retiredEntries: [{
        location: {
          plugin: fixture.target.location.plugin,
          platform: fixture.target.location.platform,
          scope: fixture.target.location.scope,
        },
        recordPath: fixture.files.installRecordPath,
      }],
    });
    expect(result.payload).toMatchObject({
      nextSteps: ['运行 aw diagnose 查看最新依赖状态。'],
    });
    await expect(fs.pathExists(fixture.target.repoArtifactPath)).resolves.toBe(true);
    const after = await fs.readJson(indexPath);
    expect(before.records).toHaveLength(1);
    expect(after.records).toEqual([]);
  });

  it('builds a cleanup --plan payload without writing state', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'cache-only', platform: 'codex', scope: 'user' });
    const cacheRootPath = path.join(
      builder.paths.codexHome,
      'plugins',
      'cache',
      'aw',
      target.location.plugin,
    );
    await fs.outputJson(
      path.join(cacheRootPath, '0.1.0', 'plugin.json'),
      { id: `${target.location.plugin}@aw`, version: '0.1.0' },
      { spaces: 2 },
    );

    const result = await cleanupCommand(
      ['cache-only'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
        plan: true,
        force: true,
        removeConfig: true,
      },
      {
        env: {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        },
        adapters: {
          codex: new FakeCodexNativeCleanupAdapter(path.join(builder.paths.codexHome, 'config.toml'), cacheRootPath),
          claude: new FakeAdapter(),
        } satisfies Record<PlatformName, PlatformAdapter>,
      },
    );

    expect(result.payload).toMatchObject({
      command: 'cleanup',
      dependencyIndex: false,
      cleanupPlanSchemaVersion: 1,
      dryRun: true,
      force: true,
      removeConfig: true,
      target: {
        plugin: 'cache-only',
        platform: 'codex',
        scope: 'user',
        targetType: 'cache-only',
      },
      plannedRemovals: expect.arrayContaining([
        expect.objectContaining({
          kind: 'native-cache',
        }),
      ]),
      wouldBackups: [],
      wouldRemoveConfig: expect.arrayContaining([
        expect.objectContaining({
          status: 'planned',
        }),
      ]),
      skippedForeignItems: [],
      affectedDependents: [],
      blockingReasons: [],
    });
    await expect(fs.pathExists(cacheRootPath)).resolves.toBe(true);
  });

  it('builds a real blocking cleanup plan and renders blocking reasons plus config handling', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'empty-plugin', platform: 'codex', scope: 'user' });

    const result = await cleanupCommand(
      ['empty-plugin'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
        plan: true,
        removeConfig: true,
      },
      {
        env: {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        },
        p9TargetResolver: async () => {
          throw new Error('synthetic target resolution failure');
        },
        adapters: {
          codex: new FakeAdapter(),
          claude: new FakeAdapter(),
        } satisfies Record<PlatformName, PlatformAdapter>,
      },
    );

    expect(result.payload).toMatchObject({
      command: 'cleanup',
      dependencyIndex: false,
      dryRun: true,
      force: false,
      removeConfig: true,
      target: {
        plugin: 'empty-plugin',
        platform: 'codex',
        scope: 'user',
        targetType: 'not-installed',
      },
      wouldBackups: [],
      wouldRemoveConfig: expect.arrayContaining([
        expect.objectContaining({
          status: 'blocked',
        }),
      ]),
      blockingReasons: expect.arrayContaining([
        expect.objectContaining({
          code: 'nothingToClean',
        }),
      ]),
    });

    const output = renderCleanupReceipt({
      payload: result.payload,
      warnings: result.warnings,
    }).join('\n');
    expect(output).toContain('阻断原因：');
    expect(output).toContain('[nothingToClean]');
    expect(output).toContain('配置处理：');
  });

  it('returns real execution cleanup payload fields and receipt labels for force cleanup', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'project' });
    await builder.writeRepoArtifact(target);
    await builder.writeProjectIdentity(target);
    await builder.writeNativeMarker(target, 'install');

    const result = await cleanupCommand(
      ['git-commit'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'project',
        platform: 'codex',
        force: true,
      },
      {
        env: {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        },
        p9TargetResolver: async () => {
          throw new Error('synthetic target resolution failure');
        },
        adapters: {
          codex: new FakeAdapter(),
          claude: new FakeAdapter(),
        } satisfies Record<PlatformName, PlatformAdapter>,
      },
    );

    expect(result.payload).toMatchObject({
      command: 'cleanup',
      dependencyIndex: false,
      dryRun: false,
      force: true,
      target: {
        plugin: 'git-commit',
        platform: 'codex',
        scope: 'project',
        targetType: 'marker-only',
      },
      actualBackups: expect.arrayContaining([
        expect.objectContaining({
          kind: 'backup',
        }),
      ]),
      skippedItems: [],
      remainingItems: [],
      blockingReasons: [],
    });
    expect(result.payload).toMatchObject({
      actualRemovals: expect.arrayContaining([
        expect.objectContaining({
          kind: 'native-transaction-marker',
        }),
      ]),
    });

    const output = renderCleanupReceipt({
      payload: result.payload,
      warnings: result.warnings,
    }).join('\n');
    expect(output).toContain('cleanup 已完成');
    expect(output).toContain('实际删除项：');
    expect(output).toContain('实际备份项：');
    expect(output).toContain('执行跳过项：');
    expect(output).toContain('未清项：');
    expect(output).toContain('阻断原因：\n- 无');
    expect(result.warnings.join('\n')).toContain('已备份');
    expect(result.payload.actualBackups?.length ?? 0).toBeGreaterThan(0);
  });

  it('fails closed for unreadable dependency-index references instead of pruning them as stale', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await fs.mkdtemp(path.join(os.tmpdir(), 'aw-p9-prune-unreadable-')),
      scenario: 'unreadableDependencyIndex',
    });
    tempDirs.push(fixture.paths.rootDir);
    const indexPath = fixture.files.dependencyIndexPath;
    const digest = await fs.readFile(indexPath).then((buffer) => import('../../src/install-state/internal.js').then((mod) => mod.sha256Hex(buffer)));
    const token = createDependencyIndexPruneToken({
      location: fixture.target.location,
      recordPath: fixture.files.installRecordPath,
      indexDigest: digest,
    });

    await expect(
      cleanupCommand(
        [],
        {
          cwd: fixture.paths.repoRoot,
          dependencyIndex: true,
          pruneStale: token,
          yes: true,
        },
        {
          env: {
            ...process.env,
            AW_HOME: fixture.paths.awHome,
            AW_CODEX_HOME: fixture.paths.codexHome,
            AW_CLAUDE_HOME: fixture.paths.claudeHome,
          },
        },
      ),
    ).rejects.toThrow(/unreadable reference/);

    const index = await fs.readJson(indexPath);
    expect(index.records).toHaveLength(1);
  });

  it('cleans config-only Codex native residue even when dependency index is missing', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
    const configPath = path.join(builder.paths.codexHome, 'config.toml');
    await fs.outputFile(
      configPath,
      `[plugins."${target.pluginId}"]\nenabled = true\n`,
      'utf8',
    );

    const codex = new FakeCodexNativeCleanupAdapter(configPath);
    await cleanupCommand(
      ['git-commit'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
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
      },
    );

    expect(
      codex.uninstallUserNativePluginByIdCalls.length + codex.uninstallPluginCalls.length,
    ).toBeGreaterThan(0);
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain(target.pluginId);
  });

  it('uses the runtime adapters factory for CLI-style Codex native cleanup', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
    const configPath = path.join(builder.paths.codexHome, 'config.toml');
    const cacheRootPath = path.join(
      builder.paths.codexHome,
      'plugins',
      'cache',
      'aw',
      target.location.plugin,
    );
    await fs.outputFile(
      configPath,
      `[plugins."${target.pluginId}"]\nenabled = true\n`,
      'utf8',
    );
    await fs.outputJson(
      path.join(cacheRootPath, target.source.pluginVersion, 'plugin.json'),
      { id: target.pluginId, version: target.source.pluginVersion },
      { spaces: 2 },
    );

    const codex = new FakeCodexNativeCleanupAdapter(configPath, cacheRootPath);
    await cleanupCommand(
      ['git-commit'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env: {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        },
        adaptersFactory: () => ({
          codex,
          claude: new FakeAdapter(),
        }) satisfies Record<PlatformName, PlatformAdapter>,
      },
    );

    expect(codex.uninstallUserNativePluginByIdCalls).toEqual([target.pluginId]);
    expect(codex.uninstallPluginCalls).toEqual([]);
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain(target.pluginId);
    await expect(fs.pathExists(cacheRootPath)).resolves.toBe(false);
  });

  it('uses Codex adapter uninstall for user-scope native residue when shared native refs still protect project consumers and target resolution fails', async () => {
    const builder = await makeBuilder();
    const pluginName = 'git-commit';
    const target = builder.createTarget({ pluginName, platform: 'codex', scope: 'user' });
    const configPath = path.join(builder.paths.codexHome, 'config.toml');
    await fs.outputFile(
      configPath,
      `[plugins."${target.pluginId}"]\nenabled = true\n`,
      'utf8',
    );
    await writeInstalledLedger(
      {
        ...createAvailableLedger(),
        plugins: {
          [pluginName]: {
            lastResolvedVersion: target.source.pluginVersion,
            platforms: {
              codex: {
                sharedNativeRefs: {
                  user: true,
                  projects: ['repo:fixture-project'],
                },
              },
            },
          },
        },
      },
      {
        ...process.env,
        AW_HOME: builder.paths.awHome,
        AW_CODEX_HOME: builder.paths.codexHome,
        AW_CLAUDE_HOME: builder.paths.claudeHome,
      },
    );

    const codex = new FakeCodexNativeCleanupAdapter(
      configPath,
      undefined,
      undefined,
      { protectedPluginIds: [target.pluginId] },
    );
    const result = await cleanupCommand(
      [pluginName],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env: {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        },
        p9TargetResolver: async () => {
          throw new Error('synthetic target resolution failure');
        },
        adapters: {
          codex,
          claude: new FakeAdapter(),
        } satisfies Record<PlatformName, PlatformAdapter>,
      },
    );

    expect(codex.uninstallPluginCalls).toEqual([pluginName]);
    expect(codex.uninstallUserNativePluginByIdCalls).toEqual([]);
    expect(result.payload).toMatchObject({
      command: 'cleanup',
      dependencyIndex: false,
      dryRun: false,
      target: {
        plugin: pluginName,
        platform: 'codex',
        scope: 'user',
      },
      skippedItems: expect.arrayContaining([
        expect.objectContaining({
          kind: 'native-config',
        }),
      ]),
      remainingItems: expect.arrayContaining([
        expect.objectContaining({
          kind: 'native-config',
        }),
      ]),
    });
    expect(renderCleanupReceipt({
      payload: result.payload,
      warnings: result.warnings,
    }).join('\n')).toContain('cleanup 失败');
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain(target.pluginId);
  });

  it('keeps record-backed Codex user residual on uninstall-plus-extensions path even when direct native cleanup is available', async () => {
    const builder = await makeBuilder();
    const pluginName = 'git-commit';
    const target = builder.createTarget({ pluginName, platform: 'codex', scope: 'user' });
    const configPath = path.join(builder.paths.codexHome, 'config.toml');
    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    const record = await builder.writeInstallRecord(target, lifecycle);
    await rewriteSanitizedInstallRecordForP2(path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    ));
    await builder.writeDiagnosticCache(target);
    await builder.writeNativeMarker(target, 'install');
    await builder.writeDependencyIndex([{ target, record }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    await ensureRepoPlugin(builder.paths.repoRoot, pluginName);
    await fs.outputFile(
      configPath,
      `[plugins."${target.pluginId}"]\nenabled = true\n`,
      'utf8',
    );

    const codex = new FakeCodexNativeCleanupAdapter(configPath);
    await cleanupCommand(
      [pluginName],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
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
      },
    );

    expect(codex.uninstallPluginCalls).toEqual([pluginName]);
    expect(codex.uninstallExtensionsCalls).toEqual([pluginName]);
    expect(codex.uninstallUserNativePluginByIdCalls).toEqual([]);
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain(target.pluginId);
  });

  it('cleans cache-backed Codex native residue when dependency index is missing', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
    const configPath = path.join(builder.paths.codexHome, 'config.toml');
    const cacheRootPath = path.join(
      builder.paths.codexHome,
      'plugins',
      'cache',
      'aw',
      target.location.plugin,
    );
    await fs.outputFile(
      configPath,
      `[plugins."${target.pluginId}"]\nenabled = true\n`,
      'utf8',
    );
    await fs.outputJson(
      path.join(cacheRootPath, target.source.pluginVersion, 'plugin.json'),
      { id: target.pluginId, version: target.source.pluginVersion },
      { spaces: 2 },
    );

    const codex = new FakeCodexNativeCleanupAdapter(configPath, cacheRootPath);
    await cleanupCommand(
      ['git-commit'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env: {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        },
        p9TargetResolver: async () => {
          throw new Error('synthetic target resolution failure');
        },
        adapters: {
          codex,
          claude: new FakeAdapter(),
        } satisfies Record<PlatformName, PlatformAdapter>,
      },
    );

    expect(
      codex.uninstallUserNativePluginByIdCalls.length + codex.uninstallPluginCalls.length,
    ).toBeGreaterThan(0);
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain(target.pluginId);
    await expect(fs.pathExists(cacheRootPath)).resolves.toBe(false);
  });

  it('cleans manifest-only Codex native residue by direct native cleanup', async () => {
    const builder = await makeBuilder();
    const pluginName = 'manifest-only';
    const pluginId = `${pluginName}@aw`;
    const configPath = path.join(builder.paths.codexHome, 'config.toml');
    const installRootPath = path.join(builder.paths.codexHome, 'plugins', pluginId);
    const installedManifestPath = path.join(installRootPath, 'manifest.json');
    await fs.outputFile(installedManifestPath, '{}\n', 'utf8');

    const codex = new FakeCodexNativeCleanupAdapter(configPath, undefined, installRootPath);
    await cleanupCommand(
      [pluginName],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env: {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        },
        p9TargetResolver: async () => {
          throw new Error('synthetic target resolution failure');
        },
        adapters: {
          codex,
          claude: new FakeAdapter(),
        } satisfies Record<PlatformName, PlatformAdapter>,
      },
    );

    expect(codex.uninstallUserNativePluginByIdCalls).toEqual([pluginId]);
    expect(codex.uninstallPluginCalls).toEqual([]);
    await expect(fs.pathExists(installedManifestPath)).resolves.toBe(false);
  });

  it('cleans cache-only Codex native residue without enabled config by direct native cleanup', async () => {
    const builder = await makeBuilder();
    const pluginName = 'cache-only';
    const pluginId = `${pluginName}@aw`;
    const configPath = path.join(builder.paths.codexHome, 'config.toml');
    const cacheRootPath = path.join(
      builder.paths.codexHome,
      'plugins',
      'cache',
      'aw',
      pluginName,
    );
    await fs.outputJson(
      path.join(cacheRootPath, '0.1.0', 'plugin.json'),
      { id: pluginId, version: '0.1.0' },
      { spaces: 2 },
    );

    const codex = new FakeCodexNativeCleanupAdapter(configPath, cacheRootPath);
    await cleanupCommand(
      [pluginName],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
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
      },
    );

    expect(codex.uninstallUserNativePluginByIdCalls).toEqual([pluginId]);
    expect(codex.uninstallPluginCalls).toEqual([]);
    await expect(fs.pathExists(cacheRootPath)).resolves.toBe(false);
  });

  it('allows cleanup --force to remove the target while keeping verified dependents and surfacing follow-up guidance', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
    const configPath = path.join(builder.paths.codexHome, 'config.toml');
    await fs.outputFile(
      configPath,
      `[plugins."${target.pluginId}"]\nenabled = true\n`,
      'utf8',
    );

    const dependentTarget = builder.createTarget({
      pluginName: 'helper-local-dependent',
      platform: 'codex',
      scope: 'user',
    });
    const dependentRecord = await builder.writeInstallRecord(dependentTarget);
    const dependentRecordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${dependentTarget.recordId}.json`,
    );
    await fs.writeJson(
      dependentRecordPath,
      {
        ...dependentRecord,
        record: {
          ...dependentRecord.record,
          dependencyEdges: [{
            dependency: target.location,
            declaration: {
              name: target.location.plugin,
            },
          }],
        },
      },
      { spaces: 2 },
    );

    const result = await cleanupCommand(
      ['git-commit'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
        force: true,
      },
      {
        env: {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        },
        adapters: {
          codex: new FakeCodexNativeCleanupAdapter(configPath),
          claude: new FakeAdapter(),
        } satisfies Record<PlatformName, PlatformAdapter>,
      },
    );

    expect(result.payload).toMatchObject({
      command: 'cleanup',
      dependencyIndex: false,
      dryRun: false,
      force: true,
      target: {
        plugin: 'git-commit',
        platform: 'codex',
        scope: 'user',
        targetType: 'config-only',
      },
      affectedDependents: [{
        plugin: 'helper-local-dependent',
        platform: 'codex',
        scope: 'user',
      }],
      blockingReasons: [],
      actualRemovals: expect.arrayContaining([
        expect.objectContaining({
          kind: 'native-config',
        }),
      ]),
      remainingItems: [],
    });
    expect(result.payload.forceReason).toContain('repair、reinstall 或 cleanup');
    expect(result.warnings.join('\n')).toContain('helper-local-dependent');
    expect(result.warnings.join('\n')).toContain('repair、reinstall 或 cleanup');
    expect(renderCleanupReceipt({
      payload: result.payload,
      warnings: result.warnings,
    }).join('\n')).toContain('受影响依赖：\n- codex/user/helper-local-dependent');
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain(target.pluginId);
    await expect(fs.pathExists(dependentRecordPath)).resolves.toBe(true);
  });

  it('keeps later cleanup deletions and returns a failed receipt when one delete stage fails mid-flight', async () => {
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
    const diagnosticCachePath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'diagnostics',
      `${target.recordId}.json`,
    );
    await rewriteSanitizedInstallRecordForP2(recordPath);
    await builder.writeDiagnosticCache(target);
    await builder.writeNativeMarker(target, 'install');
    await builder.writeDependencyIndex([{ target, record }]);
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    await ensureRepoPlugin(builder.paths.repoRoot, 'git-commit');

    const originalMove = fs.move.bind(fs);
    vi.spyOn(fs, 'move').mockImplementation(async (source, destination, options) => {
      if (source === diagnosticCachePath) {
        throw new Error('synthetic diagnostic cache delete failure');
      }
      return originalMove(source, destination, options);
    });

    const result = await cleanupCommand(
      ['git-commit'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env: {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        },
        adapters: {
          codex: new FakeAdapter(),
          claude: new FakeAdapter(),
        } satisfies Record<PlatformName, PlatformAdapter>,
      },
    );

    expect(result.payload).toMatchObject({
      command: 'cleanup',
      dependencyIndex: false,
      dryRun: false,
      actualRemovals: expect.arrayContaining([
        expect.objectContaining({
          kind: 'install-record',
        }),
        expect.objectContaining({
          kind: 'native-transaction-marker',
        }),
      ]),
      remainingItems: expect.arrayContaining([
        expect.objectContaining({
          kind: 'diagnostic-cache',
          path: diagnosticCachePath,
        }),
      ]),
    });
    expect(result.warnings.join('\n')).toContain('cleanup 删除 dynamic diagnostic cache 失败');
    expect(renderCleanupReceipt({
      payload: result.payload,
      warnings: result.warnings,
    }).join('\n')).toContain('cleanup 失败');
    await expect(fs.pathExists(recordPath)).resolves.toBe(false);
    await expect(fs.pathExists(diagnosticCachePath)).resolves.toBe(true);
  });

  it('preserves successful cleanup results when --remove-config fails after the main cleanup', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
    const configPath = path.join(builder.paths.codexHome, 'config.toml');
    await fs.outputFile(
      configPath,
      `[plugins."${target.pluginId}"]\nenabled = true\n`,
      'utf8',
    );
    const configStorePath = path.join(
      builder.paths.awHome,
      'plugin-config',
      'git-commit',
      'config.json',
    );
    await fs.outputJson(configStorePath, { token: 'secret' }, { spaces: 2 });

    const originalRemove = fs.remove.bind(fs);
    vi.spyOn(fs, 'remove').mockImplementation(async (targetPath) => {
      if (targetPath === configStorePath) {
        throw new Error('synthetic config removal failure');
      }
      return originalRemove(targetPath);
    });

    const result = await cleanupCommand(
      ['git-commit'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
        removeConfig: true,
      },
      {
        env: {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
        },
        adapters: {
          codex: new FakeCodexNativeCleanupAdapter(configPath),
          claude: new FakeAdapter(),
        } satisfies Record<PlatformName, PlatformAdapter>,
      },
    );

    expect(result.payload).toMatchObject({
      command: 'cleanup',
      dependencyIndex: false,
      dryRun: false,
      actualRemovals: expect.arrayContaining([
        expect.objectContaining({
          kind: 'native-config',
        }),
      ]),
      remainingItems: [],
      wouldRemoveConfig: [{
        plugin: 'git-commit',
        scope: 'user',
        path: configStorePath,
        status: 'failed',
        reason: 'synthetic config removal failure',
      }],
    });
    expect(result.warnings.join('\n')).toContain('主体清理已完成，但删除当前 target scope 的 AW 自管配置失败');
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain(target.pluginId);
    await expect(fs.pathExists(configStorePath)).resolves.toBe(true);
  });

  it('rejects config-only Codex cleanup when a readable local scoped record still depends on it', async () => {
    const builder = await makeBuilder();
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
    const configPath = path.join(builder.paths.codexHome, 'config.toml');
    await fs.outputFile(
      configPath,
      `[plugins."${target.pluginId}"]\nenabled = true\n`,
      'utf8',
    );

    const dependentTarget = builder.createTarget({
      pluginName: 'helper-local-dependent',
      platform: 'codex',
      scope: 'user',
    });
    const dependentRecord = await builder.writeInstallRecord(dependentTarget);
    dependentRecord.record.dependencyEdges = [{
      dependency: target.location,
      declaration: {
        name: target.location.plugin,
      },
    }];
    const dependentRecordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${dependentTarget.recordId}.json`,
    );
    await fs.writeJson(dependentRecordPath, dependentRecord, { spaces: 2 });

    await expect(
      cleanupCommand(
        ['git-commit'],
        {
          cwd: builder.paths.repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          env: {
            ...process.env,
            AW_HOME: builder.paths.awHome,
            AW_CODEX_HOME: builder.paths.codexHome,
            AW_CLAUDE_HOME: builder.paths.claudeHome,
          },
          adapters: {
            codex: new FakeCodexNativeCleanupAdapter(configPath),
            claude: new FakeAdapter(),
          } satisfies Record<PlatformName, PlatformAdapter>,
        },
      ),
    ).rejects.toThrow(/verified dependent/);
  });
});
