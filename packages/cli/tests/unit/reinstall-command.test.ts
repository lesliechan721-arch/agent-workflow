import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reinstallCommand } from '../../src/commands/reinstall.js';
import {
  createMinimalPluginInstallStateFixtureBuilder,
  writeMinimalPluginInstallStateFixture,
} from '../helpers/minimal-plugin-install-state-fixtures.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { rewriteSanitizedInstallRecordForP2 } from '../helpers/install-state-projection-fixtures.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  Scope,
  StatusReport,
} from '../../src/types.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-p9-reinstall-'));
  tempDirs.push(root);
  return createMinimalPluginInstallStateFixtureBuilder(root);
}

async function seedRepoPlugin(repoRoot: string): Promise<void> {
  await fs.copy(
    fixturePath('repo-template'),
    repoRoot,
  );
}

async function seedCurrentCatalog(repoRoot: string): Promise<void> {
  await seedRepoPlugin(repoRoot);
  const embeddedRoot = await createSyntheticEmbeddedRoot(repoRoot);
  tempDirs.push(embeddedRoot);
  setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
}

class FakeAdapter implements PlatformAdapter {
  async detect(): Promise<boolean> {
    return true;
  }

  async installPlugin(): Promise<void> {}
  async uninstallPlugin(): Promise<void> {}
  async installExtensions(): Promise<GeneratedArtifact[]> {
    return [];
  }
  async uninstallExtensions(): Promise<void> {}
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

afterEach(async () => {
  vi.restoreAllMocks();
  setEmbeddedPluginsRootOverrideForTests(null);
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('reinstall command (P9)', () => {
  it('fails fast when reinstall --platform both mixes current-supported targets with historical unsupported evidence', async () => {
    const builder = await makeBuilder();
    await seedRepoPlugin(builder.paths.repoRoot);
    const manifestPath = path.join(
      builder.paths.repoRoot,
      'plugins',
      'git-commit',
      '.agents-plugin',
      'plugin.json',
    );
    const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
    manifest.marketplace = {
      ...(manifest.marketplace as Record<string, unknown>),
      policy: {
        ...((manifest.marketplace as Record<string, unknown>).policy as Record<string, unknown>),
        products: ['CLAUDE'],
      },
    };
    delete manifest.apps;
    await fs.writeJson(manifestPath, manifest, { spaces: 2 });
    await fs.remove(path.join(builder.paths.repoRoot, 'plugins', 'git-commit', '.app.json'));
    const embeddedRoot = await createSyntheticEmbeddedRoot(builder.paths.repoRoot);
    tempDirs.push(embeddedRoot);
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);

    const codexTarget = builder.createTarget({
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    });
    await builder.writeNativeMarker(codexTarget, 'install');

    const uninstallSpy = vi.fn<typeof import('../../src/commands/uninstall.js').uninstallCommand>();
    const cleanupSpy = vi.fn<typeof import('../../src/commands/cleanup.js').cleanupCommand>();
    const installSpy = vi.fn<typeof import('../../src/commands/install.js').installCommand>();

    await expect(
      reinstallCommand(
        ['git-commit'],
        {
          cwd: builder.paths.repoRoot,
          scope: 'user',
          platform: 'both',
        },
        {
          env: {
            ...process.env,
            AW_HOME: builder.paths.awHome,
            AW_CODEX_HOME: builder.paths.codexHome,
            AW_CLAUDE_HOME: builder.paths.claudeHome,
            AW_FORCE_CODEX_AVAILABLE: '1',
            AW_FORCE_CLAUDE_AVAILABLE: '1',
          },
          adapters: {
            codex: new FakeAdapter(),
            claude: new FakeAdapter(),
          } satisfies Record<PlatformName, PlatformAdapter>,
          uninstallCommandImpl: uninstallSpy,
          cleanupCommandImpl: cleanupSpy,
          installCommandImpl: installSpy,
        },
      ),
    ).rejects.toThrow(/不能在同一次写入里同时清理历史不再支持的平台并重建当前支持的平台/);

    expect(uninstallSpy).not.toHaveBeenCalled();
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(installSpy).not.toHaveBeenCalled();
  });

  it('expands reinstall --platform both into concrete supported targets', async () => {
    const builder = await makeBuilder();
    await seedRepoPlugin(builder.paths.repoRoot);
    const embeddedRoot = await createSyntheticEmbeddedRoot(builder.paths.repoRoot);
    tempDirs.push(embeddedRoot);
    setEmbeddedPluginsRootOverrideForTests(embeddedRoot);
    const codexTarget = builder.createTarget({
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'user',
    });
    const claudeTarget = builder.createTarget({
      pluginName: 'git-commit',
      platform: 'claude',
      scope: 'user',
    });
    await builder.writeRepoArtifact(codexTarget);
    const codexLifecycle = await builder.writeHistoricalLifecycleRuntime(codexTarget);
    const codexRecord = await builder.writeInstallRecord(codexTarget, codexLifecycle);
    await rewriteSanitizedInstallRecordForP2(path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${codexTarget.recordId}.json`,
    ));

    await builder.writeRepoArtifact(claudeTarget);
    const claudeLifecycle = await builder.writeHistoricalLifecycleRuntime(claudeTarget);
    const claudeRecord = await builder.writeInstallRecord(claudeTarget, claudeLifecycle);
    await rewriteSanitizedInstallRecordForP2(path.join(
      builder.paths.claudeHome,
      '.agent-workflows',
      'records',
      `${claudeTarget.recordId}.json`,
    ));
    await builder.writeDependencyIndex([
      { target: codexTarget, record: codexRecord },
      { target: claudeTarget, record: claudeRecord },
    ]);

    const uninstallSpy = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
      repoManagedArtifacts: [],
    }));
    const cleanupSpy = vi.fn<typeof import('../../src/commands/cleanup.js').cleanupCommand>();
    const installSpy = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex', 'claude'],
      warnings: [],
      nativePlugins: {},
      repoManagedArtifacts: [],
    }));

    const result = await reinstallCommand(
      ['git-commit'],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'both',
      },
      {
        env: {
          ...process.env,
          AW_HOME: builder.paths.awHome,
          AW_CODEX_HOME: builder.paths.codexHome,
          AW_CLAUDE_HOME: builder.paths.claudeHome,
          AW_FORCE_CODEX_AVAILABLE: '1',
          AW_FORCE_CLAUDE_AVAILABLE: '1',
        },
        adapters: {
          codex: new FakeAdapter(),
          claude: new FakeAdapter(),
        } satisfies Record<PlatformName, PlatformAdapter>,
        uninstallCommandImpl: uninstallSpy,
        cleanupCommandImpl: cleanupSpy,
        installCommandImpl: installSpy,
      },
    );

    const removalPlatforms = [
      ...uninstallSpy.mock.calls.map((call) => call[1].platform),
      ...cleanupSpy.mock.calls.map((call) => call[1].platform),
    ].sort();
    expect(removalPlatforms).toEqual(['claude', 'codex']);
    expect(removalPlatforms.includes('both')).toBe(false);
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(result.platforms).toEqual(['codex', 'claude']);
    expect(result.platforms.includes('both')).toBe(false);
  });

  it('fails reinstall scope preflight before uninstalling when the sibling scope is already healthy', async () => {
    const builder = await makeBuilder();
    const env = {
      ...process.env,
      AW_HOME: builder.paths.awHome,
      AW_CODEX_HOME: builder.paths.codexHome,
      AW_CLAUDE_HOME: builder.paths.claudeHome,
      AW_FORCE_CODEX_AVAILABLE: '1',
    } satisfies NodeJS.ProcessEnv;
    const projectKey = await fs.realpath(builder.paths.repoRoot);
    const pluginName = 'duplicate-reinstall-plugin';
    const userTarget = builder.createTarget({
      pluginName,
      platform: 'codex',
      scope: 'user',
    });
    const projectTarget = builder.createTarget({
      pluginName,
      platform: 'codex',
      scope: 'project',
      projectKey,
    });
    await builder.writeRepoArtifact(userTarget);
    const userLifecycle = await builder.writeHistoricalLifecycleRuntime(userTarget);
    const userRecord = await builder.writeInstallRecord(userTarget, userLifecycle);
    await builder.writeDiagnosticCache(userTarget);
    await builder.writeExternalNativeEvidence(userTarget);
    await builder.writeRepoArtifact(projectTarget);
    const projectLifecycle = await builder.writeHistoricalLifecycleRuntime(projectTarget);
    const projectRecord = await builder.writeInstallRecord(projectTarget, projectLifecycle);
    await builder.writeDiagnosticCache(projectTarget);
    await builder.writeProjectIdentity(projectTarget);
    await builder.writeDependencyIndex([
      { target: userTarget, record: userRecord },
      { target: projectTarget, record: projectRecord },
    ]);

    const cleanupSpy = vi.fn<typeof import('../../src/commands/cleanup.js').cleanupCommand>();
    const installSpy = vi.fn<typeof import('../../src/commands/install.js').installCommand>();
    await expect(
      reinstallCommand(
        [pluginName],
        {
          cwd: builder.paths.repoRoot,
          scope: 'user',
          platform: 'codex',
        },
        {
          env,
          adapters: {
            codex: new FakeAdapter(),
            claude: new FakeAdapter(),
          } satisfies Record<PlatformName, PlatformAdapter>,
          cleanupCommandImpl: cleanupSpy,
          installCommandImpl: installSpy,
        },
      ),
    ).rejects.toThrow(/duplicateInstall/);

    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(installSpy).not.toHaveBeenCalled();
  });

  it('stops on adoptable project artifacts instead of deleting them as residuals', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await fs.mkdtemp(path.join(os.tmpdir(), 'aw-p9-reinstall-adoptable-')),
      scenario: 'freshCloneProject',
    });
    tempDirs.push(fixture.paths.rootDir);
    await seedCurrentCatalog(fixture.paths.repoRoot);
    const installSpy = vi.fn<typeof import('../../src/commands/install.js').installCommand>();

    await expect(
      reinstallCommand(
        ['git-commit'],
        {
          cwd: fixture.paths.repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          env: {
            ...process.env,
            AW_HOME: fixture.paths.awHome,
            AW_CODEX_HOME: fixture.paths.codexHome,
            AW_CLAUDE_HOME: fixture.paths.claudeHome,
          },
          adapters: {
            codex: new FakeAdapter(),
            claude: new FakeAdapter(),
          } satisfies Record<PlatformName, PlatformAdapter>,
          installCommandImpl: installSpy,
        },
      ),
    ).rejects.toThrow(/install .*--adopt-existing/);

    expect(installSpy).not.toHaveBeenCalled();
  });

  it('rebuilds dependency protection from valid records before reinstalling a healthy target', async () => {
    const builder = await makeBuilder();
    await seedCurrentCatalog(builder.paths.repoRoot);
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });

    await builder.writeRepoArtifact(target);
    const lifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    await builder.writeInstallRecord(target, lifecycle);
    await rewriteSanitizedInstallRecordForP2(path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    ));
    await fs.remove(path.join(builder.paths.awHome, 'dependency-index'));

    const installSpy = vi.fn(async () => ({
      plugins: ['git-commit'],
      platforms: ['codex'],
      warnings: [],
      nativePlugins: {},
      repoManagedArtifacts: [],
    }));

    const result = await reinstallCommand(
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
        installCommandImpl: installSpy,
      },
    );

    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(result.platforms).toEqual(['codex']);
  });

  it('rebuilds dependency protection before implicit cleanup on repairable residue', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await fs.mkdtemp(path.join(os.tmpdir(), 'aw-p9-reinstall-needs-repair-')),
      scenario: 'recordAndInstallMarkerResidual',
    });
    tempDirs.push(fixture.paths.rootDir);
    await seedCurrentCatalog(fixture.paths.repoRoot);
    await rewriteSanitizedInstallRecordForP2(fixture.files.installRecordPath);
    await fs.remove(path.join(fixture.paths.awHome, 'dependency-index'));

    const installSpy = vi.fn(async () => ({
      plugins: [fixture.target.location.plugin],
      platforms: [fixture.target.location.platform],
      warnings: [],
      nativePlugins: {},
      repoManagedArtifacts: [],
    }));

    const result = await reinstallCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: fixture.target.location.scope,
        platform: fixture.target.location.platform,
      },
      {
        env: {
          ...process.env,
          AW_HOME: fixture.paths.awHome,
          AW_CODEX_HOME: fixture.paths.codexHome,
          AW_CLAUDE_HOME: fixture.paths.claudeHome,
        },
        adapters: {
          codex: new FakeAdapter(),
          claude: new FakeAdapter(),
        } satisfies Record<PlatformName, PlatformAdapter>,
        installCommandImpl: installSpy,
      },
    );

    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(result.platforms).toEqual([fixture.target.location.platform]);
  });

  it('prefers install --adopt-existing over deleting claimable project artifacts, even when dependents still reference them', async () => {
    const builder = await makeBuilder();
    await seedCurrentCatalog(builder.paths.repoRoot);
    const projectKey = await fs.realpath(builder.paths.repoRoot);
    const target = builder.createTarget({
      pluginName: 'git-commit',
      platform: 'codex',
      scope: 'project',
      projectKey,
    });
    const dependent = builder.createTarget({
      pluginName: 'residual-parent',
      platform: 'codex',
      scope: 'project',
      projectKey,
    });

    await builder.writeRepoArtifact(target);
    await builder.writeProjectIdentity(target);
    const targetRecordPath = path.join(
      builder.paths.repoRoot,
      '.codex',
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    );
    await builder.writeInstallRecord(target);
    await fs.remove(targetRecordPath);

    const dependentRecord = await builder.writeInstallRecord(dependent);
    const dependentRecordPath = path.join(
      builder.paths.repoRoot,
      '.codex',
      '.agent-workflows',
      'records',
      `${dependent.recordId}.json`,
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

    const cleanupSpy = vi.fn<typeof import('../../src/commands/cleanup.js').cleanupCommand>();
    const installSpy = vi.fn<typeof import('../../src/commands/install.js').installCommand>();

    const error = await reinstallCommand(
      [target.location.plugin],
      {
        cwd: builder.paths.repoRoot,
        scope: target.location.scope,
        platform: target.location.platform,
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
        cleanupCommandImpl: cleanupSpy,
        installCommandImpl: installSpy,
      },
    ).then(
      () => null,
      (caught) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/install .*--adopt-existing/);
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(installSpy).not.toHaveBeenCalled();
  });
});
