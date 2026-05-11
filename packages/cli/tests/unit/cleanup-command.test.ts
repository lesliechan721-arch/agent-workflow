import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupCommand } from '../../src/commands/cleanup.js';
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
import { removeCodexPluginEnabledFile } from '../../src/utils/codex-config.js';
import { createAvailableLedger, writeInstalledLedger } from '../../src/utils/local-marketplace.js';
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
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('cleanup command (P9)', () => {
  it('rejects cleanup for healthy installed targets and points users back to uninstall', async () => {
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
    await ensureRepoPlugin(builder.paths.repoRoot, 'git-commit');

    await expect(
      cleanupCommand(
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
            claude: new FakeAdapter(),
          } satisfies Record<PlatformName, PlatformAdapter>,
        },
      ),
    ).rejects.toThrow(/aw uninstall/);
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
    expect(result.output).toContain('已退休的项目引用');
    expect(result.output).toContain(fixture.files.installRecordPath);
    await expect(fs.pathExists(fixture.target.repoArtifactPath)).resolves.toBe(true);
    const after = await fs.readJson(indexPath);
    expect(before.records).toHaveLength(1);
    expect(after.records).toEqual([]);
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

    expect(codex.uninstallPluginCalls).toEqual([pluginName]);
    expect(codex.uninstallUserNativePluginByIdCalls).toEqual([]);
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
