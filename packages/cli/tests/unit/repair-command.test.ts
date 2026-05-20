import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { repairCommand } from '../../src/commands/repair.js';
import { statusCommand } from '../../src/commands/status.js';
import type {
  GeneratedArtifact,
  PlatformAdapter,
  PluginMeta,
  Scope,
  StatusReport,
} from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { calculateFileDigest, calculatePluginBundleFingerprint } from '../../src/utils/plugin-scripts.js';
import * as pluginConfigModule from '../../src/utils/plugin-config.js';
import * as sharedRuntimeOwnerModule from '../../src/install-state/shared-runtime-owner.js';
import * as transactionsModule from '../../src/install-state/transactions.js';
import { createInstallStateFixtureEnv } from '../helpers/install-state-projection-fixtures.js';
import {
  createProjectArtifactSharedLocator,
  getDiagnosticCachePath,
  getInstallRecordPath,
  getInstallStatePrivateRoot,
  getProjectArtifactSharedIdentityPath,
  resolveProjectScopeRepoRoot,
} from '../../src/install-state/paths.js';
import {
  refreshDependencyIndexDigestsForP2,
  rewriteSanitizedInstallRecordForP2,
} from '../helpers/install-state-projection-fixtures.js';
import {
  createMinimalPluginInstallStateFixtureBuilder,
  writeMinimalPluginInstallStateFixture,
} from '../helpers/minimal-plugin-install-state-fixtures.js';
import { setEmbeddedPluginsRootOverrideForTests } from '../../src/utils/paths.js';
import { expectPathFenceViolation } from '../helpers/test-isolation.js';
import {
  getSourceTestRepositoryCwd,
  runWithCurrentRepositoryCwdAsReadOnly,
} from '../setup/test-isolation.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function digest(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function snapshotPathState(targetPath: string): Promise<{
  exists: boolean;
  digest: string | null;
}> {
  if (!(await fs.pathExists(targetPath))) {
    return {
      exists: false,
      digest: null,
    };
  }
  const stats = await fs.stat(targetPath);
  if (stats.isFile()) {
    return {
      exists: true,
      digest: digest(await fs.readFile(targetPath, 'utf8')),
    };
  }
  const entries = await fs.readdir(targetPath);
  return {
    exists: true,
    digest: digest(JSON.stringify(entries.sort())),
  };
}

async function createPluginMeta(options: {
  rootDir: string;
  pluginName: string;
  version?: string;
  installLifecycleExitCode?: number;
}): Promise<PluginMeta> {
  const pluginRoot = path.join(options.rootDir, 'catalog', options.pluginName);
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = {
    name: options.pluginName,
    version: options.version ?? '1.0.0',
    description: `${options.pluginName} plugin`,
    compatibility: {
      aw: {
        minVersion: '0.0.0',
      },
    },
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'NONE',
      },
    },
    ...(options.installLifecycleExitCode === undefined
      ? {}
      : {
          scripts: {
            lifecycle: {
              install: {
                default: {
                  runner: 'node',
                  path: './scripts/install.mjs',
                },
              },
            },
          },
        }),
  };
  await fs.ensureDir(path.dirname(manifestPath));
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  if (options.installLifecycleExitCode !== undefined) {
    const lifecyclePath = path.join(pluginRoot, 'scripts', 'install.mjs');
    await fs.ensureDir(path.dirname(lifecyclePath));
    await fs.writeFile(
      lifecyclePath,
      `process.exit(${options.installLifecycleExitCode});\n`,
      'utf8',
    );
  }
  return {
    rootDir: pluginRoot,
    manifestPath,
    manifest,
  };
}

async function createBundledSkillPluginMeta(options: {
  rootDir: string;
  pluginName: string;
  skillKey: string;
}): Promise<PluginMeta> {
  const pluginRoot = path.join(options.rootDir, 'plugins', options.pluginName);
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest = {
    name: options.pluginName,
    version: '1.0.0',
    description: `${options.pluginName} plugin`,
    skills: './skills',
    skillTriggers: {
      [options.skillKey]: {
        defaultTrigger: 'auto',
        allowDynamicTrigger: true,
      },
    },
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'NONE',
      },
    },
    artifacts: {
      targets: [{
        id: `${options.skillKey}-skill`,
        platform: 'codex',
        scopes: ['user', 'project'],
        target: 'codex.skill',
        projectManagedKind: 'skill',
        states: ['present', 'disabled'],
        refreshKeys: [],
        skillKey: options.skillKey,
      }],
    },
  };
  await fs.ensureDir(path.dirname(manifestPath));
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  const skillsIndexPath = path.join(pluginRoot, 'skills', options.skillKey, 'SKILL.md');
  const codexSkillPath = path.join(pluginRoot, 'skills', options.skillKey, 'agents', 'openai.yaml');
  await fs.ensureDir(path.dirname(skillsIndexPath));
  await fs.ensureDir(path.dirname(codexSkillPath));
  await fs.writeFile(skillsIndexPath, `# ${options.skillKey}\n`, 'utf8');
  await fs.writeFile(codexSkillPath, 'policy:\n  allow_implicit_invocation: true\n', 'utf8');
  return readPluginManifest(pluginRoot);
}

async function alignFixtureSourceToPlugin(options: {
  installRecordPath?: string;
  projectIdentityPath?: string;
  plugin: PluginMeta;
}): Promise<void> {
  const source = {
    pluginVersion: options.plugin.manifest.version,
    manifestDigest: await calculateFileDigest(options.plugin.manifestPath),
    bundleFingerprint: await calculatePluginBundleFingerprint(options.plugin.rootDir),
  };
  if (options.installRecordPath && await fs.pathExists(options.installRecordPath)) {
    const record = await fs.readJson(options.installRecordPath) as {
      record: { source: typeof source };
    } & Record<string, unknown>;
    record.record.source = source;
    await fs.writeJson(options.installRecordPath, record, { spaces: 2 });
  }
  if (options.projectIdentityPath && await fs.pathExists(options.projectIdentityPath)) {
    const identity = await fs.readJson(options.projectIdentityPath) as {
      source: typeof source;
    } & Record<string, unknown>;
    identity.source = source;
    await fs.writeJson(options.projectIdentityPath, identity, { spaces: 2 });
  }
}

class FakeRepairAdapter implements PlatformAdapter {
  readonly name = 'codex' as const;
  readonly installPlugin = vi.fn(async () => undefined);
  readonly installExtensions = vi.fn(async () => [] as GeneratedArtifact[]);

  async detect(): Promise<boolean> {
    return true;
  }

  async uninstallPlugin(): Promise<void> {}

  async uninstallExtensions(): Promise<void> {}

  async upgradePlugin(): Promise<void> {}

  async status(): Promise<StatusReport> {
    return {
      platform: 'codex',
      scope: 'user',
      initialized: true,
      plugins: [{
        name: 'synthetic',
        installed: true,
        managedArtifacts: [],
        driftWarnings: [],
      } as never],
    };
  }
}

class FakeClaudeRepairAdapter implements PlatformAdapter {
  readonly name = 'claude' as const;

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

  async status(): Promise<StatusReport> {
    return {
      platform: 'claude',
      scope: 'user',
      initialized: true,
      plugins: [],
    };
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('repair command P8', () => {
  it('allows repair to read project install-state paths from a read-only repo fixture but blocks writes there', async () => {
    const repositoryCwd = resolveProjectScopeRepoRoot(getSourceTestRepositoryCwd());
    await runWithCurrentRepositoryCwdAsReadOnly(() => {
      const repositoryCwd = process.cwd();
      const projectRoot = resolveProjectScopeRepoRoot(repositoryCwd);
      const cwd = path.join(projectRoot, 'packages', 'cli');
      const location = {
        plugin: 'readonly-repair-plugin',
        platform: 'codex' as const,
        scope: 'project' as const,
        projectKey: projectRoot,
      };
      const recordPath = getInstallRecordPath(cwd, location, process.env, 'read');
      const diagnosticCachePath = getDiagnosticCachePath(cwd, location, process.env, 'read');
      const identityPath = getProjectArtifactSharedIdentityPath({
        repoRoot: projectRoot,
        locator: createProjectArtifactSharedLocator({
          plugin: location.plugin,
          platform: 'codex',
          repoRoot: projectRoot,
          projectRoot,
        }),
        access: 'read',
      });

      expect(recordPath).toContain(path.join(projectRoot, '.codex', '.agent-workflows', 'records'));
      expect(diagnosticCachePath).toContain(path.join(projectRoot, '.codex', '.agent-workflows', 'diagnostics'));
      expect(identityPath).toContain(path.join(projectRoot, '.agent-workflows', 'project-artifacts', 'codex'));

      expectPathFenceViolation(
        () => getInstallStatePrivateRoot(cwd, location, process.env, 'write'),
        {
          access: 'write',
          path: path.join(projectRoot, '.codex', '.agent-workflows'),
          source: 'codex project install-state private root',
          reason: 'writeToReadOnlyRoot',
          conflictingRootPath: projectRoot,
          recommendedFixIncludes: 'withSafeTestCwd()',
        },
      );
      expectPathFenceViolation(
        () => getProjectArtifactSharedIdentityPath({
          repoRoot: projectRoot,
          locator: createProjectArtifactSharedLocator({
            plugin: location.plugin,
            platform: 'codex',
            repoRoot: projectRoot,
            projectRoot,
          }),
          access: 'write',
        }),
        {
          access: 'write',
          path: identityPath,
          source: 'project artifact shared identity',
          reason: 'writeToReadOnlyRoot',
          conflictingRootPath: projectRoot,
          recommendedFixIncludes: 'withSafeTestCwd()',
        },
      );
    }, { repositoryCwd });
  });

  it('reapplies same-bundle artifacts and rewrites record/cache/identity', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-repair-same-bundle-'),
      scenario: 'installed',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
    });
    await alignFixtureSourceToPlugin({
      installRecordPath: fixture.files.installRecordPath,
      projectIdentityPath: fixture.files.projectIdentityPath,
      plugin,
    });
    await rewriteSanitizedInstallRecordForP2(fixture.files.installRecordPath);
    await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath);
    await fs.remove(fixture.target.repoArtifactPath);

    const adapter = new FakeRepairAdapter();
    const artifactContent = fixture.target.repoArtifactContent;
    adapter.installExtensions.mockImplementation(async () => {
      await fs.outputFile(fixture.target.repoArtifactPath, artifactContent, 'utf8');
      return [{
        path: fixture.target.repoArtifactPath,
        kind: 'instruction',
        platform: 'codex',
        id: `${fixture.target.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        artifactKey: `${fixture.target.pluginSlug}.skill`,
        contentDigest: digest(artifactContent),
      }];
    });

    const result = await repairCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        adapters: {
          codex: adapter,
          claude: new FakeClaudeRepairAdapter(),
        },
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: 'codex',
          scope: 'project',
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
          currentPlugin: plugin,
        }],
      } as never,
    );

    const payload = result.payload.locations[0]!;
    expect(adapter.installExtensions).toHaveBeenCalled();
    expect(payload.action).toBe('sameBundleRepair');
    expect(payload.changed.record).toBe(true);
    expect(payload.changed.dynamicDiagnosticCache).toBe(true);
    expect(payload.changed.projectIdentity).toBe(true);
    await expect(fs.readFile(fixture.target.repoArtifactPath, 'utf8')).resolves.toBe(artifactContent);
    const record = await fs.readJson(fixture.files.installRecordPath) as {
      record: {
        source: {
          pluginVersion: string;
        };
      };
    };
    expect(record.record.source.pluginVersion).toBe('1.0.0');
    const cache = await fs.readJson(fixture.files.diagnosticCachePath) as {
      artifacts: Array<{ lastRefresh?: { event: string } }>;
    };
    expect(cache.artifacts[0]?.lastRefresh?.event).toBe('repair');
  });

  it('replays the installed version from historical runtime when current catalog is unavailable', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-repair-historical-runtime-'),
      scenario: 'installed',
    });
    await rewriteSanitizedInstallRecordForP2(fixture.files.installRecordPath);
    const updatedRecord = await fs.readJson(fixture.files.installRecordPath) as {
      record: {
        source: {
          manifestDigest: string;
          bundleFingerprint: string;
        };
        lifecycle?: {
          manifestPath: string;
          bundleRoot: string;
          sourceManifestDigest: string;
          bundleFingerprint: string;
        };
      };
    };
    if (!updatedRecord.record.lifecycle) {
      throw new Error('missing historical lifecycle runtime in fixture');
    }
    const historicalManifestDigest = await calculateFileDigest(updatedRecord.record.lifecycle.manifestPath);
    const historicalBundleFingerprint = await calculatePluginBundleFingerprint(updatedRecord.record.lifecycle.bundleRoot);
    updatedRecord.record.source.manifestDigest = historicalManifestDigest;
    updatedRecord.record.source.bundleFingerprint = historicalBundleFingerprint;
    updatedRecord.record.lifecycle.sourceManifestDigest = historicalManifestDigest;
    updatedRecord.record.lifecycle.bundleFingerprint = historicalBundleFingerprint;
    await fs.writeJson(fixture.files.installRecordPath, updatedRecord, { spaces: 2 });
    await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath);
    await fs.remove(fixture.target.repoArtifactPath);

    const adapter = new FakeRepairAdapter();
    adapter.installExtensions.mockImplementation(async () => {
      await fs.outputFile(fixture.target.repoArtifactPath, fixture.target.repoArtifactContent, 'utf8');
      return [{
        path: fixture.target.repoArtifactPath,
        kind: 'instruction',
        platform: 'codex',
        id: `${fixture.target.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        artifactKey: `${fixture.target.pluginSlug}.skill`,
        contentDigest: digest(fixture.target.repoArtifactContent),
      }];
    });

    const result = await repairCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        adapters: {
          codex: adapter,
          claude: new FakeClaudeRepairAdapter(),
        },
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: 'codex',
          scope: 'project',
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
        }],
      } as never,
    );

    expect(adapter.installExtensions).toHaveBeenCalled();
    expect(result.payload.locations[0]).toMatchObject({
      action: 'sameBundleRepair',
      changed: {
        artifactsReapplied: true,
      },
    });
    await expect(fs.readFile(fixture.target.repoArtifactPath, 'utf8')).resolves.toBe(fixture.target.repoArtifactContent);
  });

  it('uses the current effective config for repair instead of the install record skill trigger preference', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-repair-effective-config-'),
      scenario: 'installed',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
    });
    await alignFixtureSourceToPlugin({
      installRecordPath: fixture.files.installRecordPath,
      projectIdentityPath: fixture.files.projectIdentityPath,
      plugin,
    });
    await rewriteSanitizedInstallRecordForP2(fixture.files.installRecordPath);
    await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath);

    const record = await fs.readJson(fixture.files.installRecordPath) as {
      record: {
        options?: {
          skillTriggerPreference?: 'default' | 'manual' | 'auto';
        };
      };
    };
    record.record.options = {
      ...(record.record.options ?? {}),
      skillTriggerPreference: 'manual',
    };
    await fs.writeJson(fixture.files.installRecordPath, record, { spaces: 2 });

    const configStorePath = path.join(
      fixture.paths.awHome,
      'plugin-config',
      fixture.target.location.plugin,
      'config.json',
    );
    await fs.outputJson(
      configStorePath,
      {
        $aw: {
          skillTriggers: {
            commit: {
              trigger: 'auto',
            },
          },
        },
      },
      { spaces: 2 },
    );

    const preferenceSpy = vi.spyOn(pluginConfigModule, 'resolveUniformSkillTriggerPreference')
      .mockResolvedValue('auto');

    const adapter = new FakeRepairAdapter();
    adapter.installExtensions.mockImplementation(async (_plugin, _scope, options) => {
      expect(options?.skillTriggerPreference).toBe('auto');
      return [];
    });

    await repairCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        adapters: {
          codex: adapter,
          claude: new FakeClaudeRepairAdapter(),
        },
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: 'codex',
          scope: 'project',
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
          currentPlugin: plugin,
        }],
      } as never,
    );

    expect(preferenceSpy).toHaveBeenCalledWith(expect.objectContaining({
      plugin,
      platform: 'codex',
      scope: 'project',
    }));
    await expect(fs.readJson(configStorePath)).resolves.toMatchObject({
      $aw: {
        skillTriggers: {
          commit: {
            trigger: 'auto',
          },
        },
      },
    });
  });

  it('fails repair scope preflight before rewriting an installed location when the sibling scope is already healthy', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-repair-duplicate-installed-'),
    );
    const env = createInstallStateFixtureEnv(builder.paths);
    const projectKey = await fs.realpath(builder.paths.repoRoot);
    const pluginName = 'duplicate-repair-plugin';
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

    const plugin = await createPluginMeta({
      rootDir: builder.paths.rootDir,
      pluginName,
    });
    const adapter = new FakeRepairAdapter();

    await expect(repairCommand(
      [pluginName],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env,
        adapters: {
          codex: adapter,
          claude: new FakeClaudeRepairAdapter(),
        },
        p7Targets: [{
          pluginName,
          platform: 'codex',
          scope: 'user',
          executionCwd: builder.paths.repoRoot,
          currentPlugin: plugin,
        }],
      } as never,
    )).rejects.toThrow(/duplicateInstall/);

    expect(adapter.installExtensions).not.toHaveBeenCalled();
    expect(adapter.installPlugin).not.toHaveBeenCalled();
  });

  it('fails repair --adopt-existing scope preflight before claiming project artifacts when the sibling scope is already healthy', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-repair-duplicate-adopt-'),
    );
    const env = createInstallStateFixtureEnv(builder.paths);
    const projectKey = await fs.realpath(builder.paths.repoRoot);
    const pluginName = 'duplicate-adopt-plugin';
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
    await builder.writeProjectIdentity(projectTarget);
    await builder.writeDependencyIndex([{ target: userTarget, record: userRecord }]);

    const plugin = await createPluginMeta({
      rootDir: builder.paths.rootDir,
      pluginName,
      installLifecycleExitCode: 0,
    });
    const adapter = new FakeRepairAdapter();

    await expect(repairCommand(
      [pluginName],
      {
        cwd: builder.paths.repoRoot,
        scope: 'project',
        platform: 'codex',
        adoptExisting: true,
      },
      {
        env,
        adapters: {
          codex: adapter,
          claude: new FakeClaudeRepairAdapter(),
        },
        p7Targets: [{
          pluginName,
          platform: 'codex',
          scope: 'project',
          projectKey,
          executionCwd: builder.paths.repoRoot,
          currentPlugin: plugin,
        }],
      } as never,
    )).rejects.toThrow(/duplicateInstall/);

    expect(adapter.installExtensions).not.toHaveBeenCalled();
    await expect(fs.pathExists(path.join(
      builder.paths.repoRoot,
      '.codex',
      '.agent-workflows',
      'records',
      `${projectTarget.recordId}.json`,
    ))).resolves.toBe(false);
  });

  it('fails source-drift artifact repair without rewriting install-state files', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-repair-drift-fail-'),
      scenario: 'installed',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
      version: '2.0.0',
    });
    await rewriteSanitizedInstallRecordForP2(fixture.files.installRecordPath);
    await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath);
    await fs.remove(fixture.target.repoArtifactPath);

    const adapter = new FakeRepairAdapter();
    const beforeRecordDigest = digest(await fs.readFile(fixture.files.installRecordPath, 'utf8'));
    const beforeCacheDigest = digest(await fs.readFile(fixture.files.diagnosticCachePath, 'utf8'));
    const beforeIdentityDigest = digest(await fs.readFile(fixture.files.projectIdentityPath, 'utf8'));

    await expect(
      repairCommand(
        [fixture.target.location.plugin],
        {
          cwd: fixture.paths.repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          env: createInstallStateFixtureEnv(fixture.paths),
          adapters: {
            codex: adapter,
            claude: new FakeClaudeRepairAdapter(),
          },
          p7Targets: [{
            pluginName: fixture.target.location.plugin,
            platform: 'codex',
            scope: 'project',
            projectKey: fixture.target.location.projectKey ?? undefined,
            executionCwd: fixture.paths.repoRoot,
            currentPlugin: plugin,
          }],
        } as never,
      ),
    ).rejects.toThrow('不能隐式升级');

    expect(adapter.installExtensions).not.toHaveBeenCalled();
    await expect(fs.readFile(fixture.files.installRecordPath, 'utf8')).resolves.toSatisfy((content) =>
      digest(content) === beforeRecordDigest);
    await expect(fs.readFile(fixture.files.diagnosticCachePath, 'utf8')).resolves.toSatisfy((content) =>
      digest(content) === beforeCacheDigest);
    await expect(fs.readFile(fixture.files.projectIdentityPath, 'utf8')).resolves.toSatisfy((content) =>
      digest(content) === beforeIdentityDigest);
  });

  it('fails ordinary repair before writes when the current catalog is unavailable', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-repair-no-catalog-installed-'),
      scenario: 'installed',
    });
    await rewriteSanitizedInstallRecordForP2(fixture.files.installRecordPath);
    await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath);
    await fs.outputJson(fixture.files.sharedOwnerPath, {
      version: 1,
      pluginName: fixture.target.location.plugin,
      platform: 'codex',
      owner: {
        plugin: 'owner-plugin',
        platform: 'codex',
        scope: 'user',
      },
      ownerRecordPath: '/tmp/owner-record.json',
      ownerRecordDigest: 'sha256:owner',
      preference: 'manual',
      updatedAt: '2026-05-08T00:00:00.000Z',
    }, { spaces: 2 });
    await fs.outputJson(fixture.files.nativeMarkerPath, {
      version: 1,
      pluginName: fixture.target.location.plugin,
      pluginId: fixture.target.pluginId,
      platform: 'codex',
      scope: 'user',
      operation: 'install',
      nativeWriteSucceeded: true,
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    }, { spaces: 2 });

    const watchedPaths = [
      fixture.target.repoArtifactPath,
      fixture.files.installRecordPath,
      fixture.files.projectIdentityPath,
      fixture.files.diagnosticCachePath,
      path.join(fixture.files.lifecycleRuntimeRoot, 'bundle', 'plugin.json'),
      fixture.files.dependencyIndexPath,
      fixture.files.nativeMarkerPath,
      fixture.files.sharedOwnerPath,
    ] as const;
    const beforeStates = await Promise.all(watchedPaths.map((filePath) => snapshotPathState(filePath)));
    const adapter = new FakeRepairAdapter();

    await expect(
      repairCommand(
        [fixture.target.location.plugin],
        {
          cwd: fixture.paths.repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          env: createInstallStateFixtureEnv(fixture.paths),
          adapters: {
            codex: adapter,
            claude: new FakeClaudeRepairAdapter(),
          },
          p7Targets: [{
            pluginName: fixture.target.location.plugin,
            platform: 'codex',
            scope: 'project',
            projectKey: fixture.target.location.projectKey ?? undefined,
            executionCwd: fixture.paths.repoRoot,
          }],
        } as never,
      ),
    ).rejects.toThrow('当前 catalog 中缺少该插件');

    expect(adapter.installExtensions).not.toHaveBeenCalled();
    expect(adapter.installPlugin).not.toHaveBeenCalled();
    const afterStates = await Promise.all(watchedPaths.map((filePath) => snapshotPathState(filePath)));
    expect(afterStates).toEqual(beforeStates);
  });

  it('closes a record-plus-install marker residual without recreating the record on source drift', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-repair-record-marker-'),
      scenario: 'recordAndInstallMarkerResidual',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
      version: '2.0.0',
    });
    await rewriteSanitizedInstallRecordForP2(fixture.files.installRecordPath);
    await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath);
    await fs.outputFile(
      fixture.files.externalNativeConfigPath,
      `[plugins."${fixture.target.pluginId}"]\nenabled = true\n`,
      'utf8',
    );
    await fs.outputJson(
      fixture.files.externalNativeCachePath,
      { pluginId: fixture.target.pluginId, source: 'fixture' },
      { spaces: 2 },
    );

    const adapter = new FakeRepairAdapter();
    const beforeRecordDigest = digest(await fs.readFile(fixture.files.installRecordPath, 'utf8'));
    const beforeCacheDigest = digest(await fs.readFile(fixture.files.diagnosticCachePath, 'utf8'));

    const result = await repairCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.rootDir,
        scope: 'user',
        platform: 'codex',
        json: true,
      },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        adapters: {
          codex: adapter,
          claude: new FakeClaudeRepairAdapter(),
        },
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: 'codex',
          scope: 'user',
          executionCwd: fixture.paths.rootDir,
          currentPlugin: plugin,
        }],
      } as never,
    );

    expect(result.payload.locations[0]?.action).toBe('recordMarkerClosure');
    expect(adapter.installExtensions).not.toHaveBeenCalled();
    expect(adapter.installPlugin).not.toHaveBeenCalled();
    await expect(fs.pathExists(fixture.files.nativeMarkerPath)).resolves.toBe(false);
    await expect(fs.readFile(fixture.files.installRecordPath, 'utf8')).resolves.toSatisfy((content) =>
      digest(content) === beforeRecordDigest);
    await expect(fs.readFile(fixture.files.diagnosticCachePath, 'utf8')).resolves.toSatisfy((content) =>
      digest(content) === beforeCacheDigest);
  });

  it('repairs a marker-only install from native post-check without replaying native install', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-repair-marker-only-ok-'),
    );
    const target = builder.createTarget({ platform: 'codex', scope: 'user' });
    await builder.writeNativeMarker(target, 'install');
    await builder.writeExternalNativeEvidence(target);
    const plugin = await createPluginMeta({
      rootDir: builder.paths.rootDir,
      pluginName: target.location.plugin,
    });

    const userArtifactPath = path.join(builder.paths.rootDir, 'user-artifacts', `${target.pluginSlug}.md`);
    const adapter = new FakeRepairAdapter();
    adapter.installExtensions.mockImplementation(async () => {
      await fs.outputFile(userArtifactPath, 'marker-only repaired\n', 'utf8');
      return [{
        path: userArtifactPath,
        kind: 'instruction',
        platform: 'codex',
        id: `${target.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        artifactKey: `${target.pluginSlug}.skill`,
        contentDigest: digest('marker-only repaired\n'),
      }];
    });

    const result = await repairCommand(
      [target.location.plugin],
      {
        cwd: builder.paths.rootDir,
        scope: 'user',
        platform: 'codex',
        json: true,
      },
      {
        env: createInstallStateFixtureEnv(builder.paths),
        adapters: {
          codex: adapter,
          claude: new FakeClaudeRepairAdapter(),
        },
        p7Targets: [{
          pluginName: target.location.plugin,
          platform: 'codex',
          scope: 'user',
          executionCwd: builder.paths.rootDir,
          currentPlugin: plugin,
        }],
      } as never,
    );

    expect(result.payload.locations[0]?.action).toBe('markerOnlyRepair');
    expect(adapter.installPlugin).not.toHaveBeenCalled();
    await expect(fs.pathExists(path.join(builder.paths.codexHome, '.agent-workflows', 'records', `${target.recordId}.json`))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(builder.paths.awHome, 'native-recovery', 'codex', 'user', `${target.pluginId}.json`))).resolves.toBe(false);
  });

  it('keeps the native marker when marker-only native repair fails', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-repair-marker-only-fail-'),
    );
    const target = builder.createTarget({ platform: 'codex', scope: 'user' });
    await builder.writeNativeMarker(target, 'install');
    const plugin = await createPluginMeta({
      rootDir: builder.paths.rootDir,
      pluginName: target.location.plugin,
    });

    const adapter = new FakeRepairAdapter();
    adapter.installPlugin.mockImplementationOnce(async () => {
      throw new Error('native install failed');
    });

    await expect(
      repairCommand(
        [target.location.plugin],
        {
          cwd: builder.paths.rootDir,
          scope: 'user',
          platform: 'codex',
        },
        {
          env: createInstallStateFixtureEnv(builder.paths),
          adapters: {
            codex: adapter,
            claude: new FakeClaudeRepairAdapter(),
          },
          p7Targets: [{
            pluginName: target.location.plugin,
            platform: 'codex',
            scope: 'user',
            executionCwd: builder.paths.rootDir,
            currentPlugin: plugin,
          }],
        } as never,
      ),
    ).rejects.toThrow('native install failed');

    await expect(fs.pathExists(path.join(builder.paths.awHome, 'native-recovery', 'codex', 'user', `${target.pluginId}.json`))).resolves.toBe(true);
    await expect(fs.pathExists(path.join(builder.paths.codexHome, '.agent-workflows', 'records', `${target.recordId}.json`))).resolves.toBe(false);
  });

  it('adopts existing project artifacts and reports the first-local-record lifecycle reason', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-repair-adopt-existing-'),
      scenario: 'freshCloneProject',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
      installLifecycleExitCode: 0,
    });
    await alignFixtureSourceToPlugin({
      projectIdentityPath: fixture.files.projectIdentityPath,
      plugin,
    });

    const adapter = new FakeRepairAdapter();
    adapter.installExtensions.mockImplementation(async () => {
      await fs.outputFile(fixture.target.repoArtifactPath, fixture.target.repoArtifactContent, 'utf8');
      return [{
        path: fixture.target.repoArtifactPath,
        kind: 'instruction',
        platform: 'codex',
        id: `${fixture.target.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        artifactKey: `${fixture.target.pluginSlug}.skill`,
        contentDigest: digest(fixture.target.repoArtifactContent),
      }];
    });

    const result = await repairCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: 'project',
        platform: 'codex',
        adoptExisting: true,
        json: true,
      },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        adapters: {
          codex: adapter,
          claude: new FakeClaudeRepairAdapter(),
        },
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: 'codex',
          scope: 'project',
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
          currentPlugin: plugin,
        }],
      } as never,
    );

    expect(result.payload.locations[0]?.action).toBe('adoptExisting');
    expect(result.payload.locations[0]?.adoptExistingLifecycleReason).toBe('adoptExistingFirstLocalRecord');
    expect(result.payload.locations[0]?.sharedSkillTriggerOwner.suppressedOwnerConflict).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({
      ok: true,
      command: 'repair',
      locations: [{
        action: 'adoptExisting',
        adoptExistingLifecycleReason: 'adoptExistingFirstLocalRecord',
      }],
    });
    await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(true);
    await expect(fs.pathExists(fixture.files.diagnosticCachePath)).resolves.toBe(true);
    await expect(fs.pathExists(fixture.files.projectIdentityPath)).resolves.toBe(true);
    await expect(fs.pathExists(fixture.files.dependencyIndexPath)).resolves.toBe(true);
  });

  it('reports a stable skipped reason when adopt-existing does not need install lifecycle', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-repair-adopt-no-lifecycle-'),
      scenario: 'freshCloneProject',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
    });
    await alignFixtureSourceToPlugin({
      projectIdentityPath: fixture.files.projectIdentityPath,
      plugin,
    });

    const adapter = new FakeRepairAdapter();
    adapter.installExtensions.mockImplementation(async () => {
      await fs.outputFile(fixture.target.repoArtifactPath, fixture.target.repoArtifactContent, 'utf8');
      return [{
        path: fixture.target.repoArtifactPath,
        kind: 'instruction',
        platform: 'codex',
        id: `${fixture.target.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        artifactKey: `${fixture.target.pluginSlug}.skill`,
        contentDigest: digest(fixture.target.repoArtifactContent),
      }];
    });

    const result = await repairCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: 'project',
        platform: 'codex',
        adoptExisting: true,
        json: true,
      },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        adapters: {
          codex: adapter,
          claude: new FakeClaudeRepairAdapter(),
        },
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: 'codex',
          scope: 'project',
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
          currentPlugin: plugin,
        }],
      } as never,
    );

    expect(result.payload.locations[0]?.adoptExistingLifecycleSkippedReason).toBe('noInstallLifecycleDeclared');
  });

  it('fails adopt-existing when shared identity metadata is corrupted and leaves shared files unchanged', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-repair-adopt-corrupted-identity-'),
      scenario: 'freshCloneProject',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
    });
    await alignFixtureSourceToPlugin({
      projectIdentityPath: fixture.files.projectIdentityPath,
      plugin,
    });
    const corrupted = await fs.readJson(fixture.files.projectIdentityPath) as {
      artifacts: Array<{ path: string }>;
    };
    corrupted.artifacts[0]!.path = '../outside-repo.txt';
    await fs.writeJson(fixture.files.projectIdentityPath, corrupted, { spaces: 2 });
    const beforeArtifact = await fs.readFile(fixture.target.repoArtifactPath, 'utf8');
    const beforeIdentity = await fs.readFile(fixture.files.projectIdentityPath, 'utf8');
    const adapter = new FakeRepairAdapter();

    await expect(
      repairCommand(
        [fixture.target.location.plugin],
        {
          cwd: fixture.paths.repoRoot,
          scope: 'project',
          platform: 'codex',
          adoptExisting: true,
        },
        {
          env: createInstallStateFixtureEnv(fixture.paths),
          adapters: {
            codex: adapter,
            claude: new FakeClaudeRepairAdapter(),
          },
          p7Targets: [{
            pluginName: fixture.target.location.plugin,
            platform: 'codex',
            scope: 'project',
            projectKey: fixture.target.location.projectKey ?? undefined,
            executionCwd: fixture.paths.repoRoot,
            currentPlugin: plugin,
          }],
        } as never,
      ),
    ).rejects.toThrow('shared identity 已损坏');

    expect(adapter.installExtensions).not.toHaveBeenCalled();
    await expect(fs.readFile(fixture.target.repoArtifactPath, 'utf8')).resolves.toBe(beforeArtifact);
    await expect(fs.readFile(fixture.files.projectIdentityPath, 'utf8')).resolves.toBe(beforeIdentity);
    await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(false);
  });

  it('fails adopt-existing when ownership cannot be verified and keeps repo-visible artifacts untouched', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-repair-adopt-unverifiable-'),
      scenario: 'freshCloneProject',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
    });
    await fs.remove(fixture.files.projectIdentityPath);
    await fs.writeFile(fixture.target.repoArtifactPath, `${fixture.target.repoArtifactContent}drifted\n`, 'utf8');
    const beforeArtifact = await fs.readFile(fixture.target.repoArtifactPath, 'utf8');
    const adapter = new FakeRepairAdapter();

    await expect(
      repairCommand(
        [fixture.target.location.plugin],
        {
          cwd: fixture.paths.repoRoot,
          scope: 'project',
          platform: 'codex',
          adoptExisting: true,
        },
        {
          env: createInstallStateFixtureEnv(fixture.paths),
          adapters: {
            codex: adapter,
            claude: new FakeClaudeRepairAdapter(),
          },
          p7Targets: [{
            pluginName: fixture.target.location.plugin,
            platform: 'codex',
            scope: 'project',
            projectKey: fixture.target.location.projectKey ?? undefined,
            executionCwd: fixture.paths.repoRoot,
            currentPlugin: plugin,
          }],
          p7Collect: async () => ({
            target: {
              pluginName: fixture.target.location.plugin,
              platform: 'codex',
              scope: 'project',
              projectKey: fixture.target.location.projectKey ?? undefined,
              executionCwd: fixture.paths.repoRoot,
              currentPlugin: plugin,
            },
            location: fixture.target.location,
            evidence: {
              projectSharedIdentity: {
                attempted: true,
                read: {
                  status: 'missing',
                  path: fixture.files.projectIdentityPath,
                  code: 'missing',
                  error: 'missing',
                },
              },
              adoptable: {
                possible: false,
                source: 'none',
                artifactEvidencePresent: true,
                blockers: ['artifactIdentityUnverifiable'],
              },
              residualEvidence: {
                repoVisibleArtifactPresent: true,
              },
            },
            projection: {
              adoptExistingAvailable: false,
            },
            currentCatalog: null,
            deepDiagnose: {
              attempted: false,
              rendered: false,
              artifacts: [],
            },
            summary: 'ownership unverifiable',
            nextSteps: [],
            findings: [],
            dependencyIndexActions: [],
            forceCleanup: {
              required: false,
              backupItems: [],
            },
          }),
        } as never,
      ),
    ).rejects.toThrow('归属无法验证');

    expect(adapter.installExtensions).not.toHaveBeenCalled();
    await expect(fs.readFile(fixture.target.repoArtifactPath, 'utf8')).resolves.toBe(beforeArtifact);
    await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(false);
  });

  it('fails adopt-existing when install lifecycle fails and does not create a local record', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-repair-adopt-lifecycle-fail-'),
      scenario: 'freshCloneProject',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
      installLifecycleExitCode: 7,
    });
    await alignFixtureSourceToPlugin({
      projectIdentityPath: fixture.files.projectIdentityPath,
      plugin,
    });
    const beforeIdentity = await fs.readFile(fixture.files.projectIdentityPath, 'utf8');
    const adapter = new FakeRepairAdapter();
    adapter.installExtensions.mockImplementation(async () => {
      await fs.outputFile(fixture.target.repoArtifactPath, fixture.target.repoArtifactContent, 'utf8');
      return [{
        path: fixture.target.repoArtifactPath,
        kind: 'instruction',
        platform: 'codex',
        id: `${fixture.target.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        artifactKey: `${fixture.target.pluginSlug}.skill`,
        contentDigest: digest(fixture.target.repoArtifactContent),
      }];
    });

    await expect(
      repairCommand(
        [fixture.target.location.plugin],
        {
          cwd: fixture.paths.repoRoot,
          scope: 'project',
          platform: 'codex',
          adoptExisting: true,
        },
        {
          env: createInstallStateFixtureEnv(fixture.paths),
          adapters: {
            codex: adapter,
            claude: new FakeClaudeRepairAdapter(),
          },
          p7Targets: [{
            pluginName: fixture.target.location.plugin,
            platform: 'codex',
            scope: 'project',
            projectKey: fixture.target.location.projectKey ?? undefined,
            executionCwd: fixture.paths.repoRoot,
            currentPlugin: plugin,
          }],
        } as never,
      ),
    ).rejects.toThrow('Lifecycle script "install" failed');

    await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(false);
    await expect(fs.pathExists(fixture.files.diagnosticCachePath)).resolves.toBe(false);
    await expect(fs.readFile(fixture.files.projectIdentityPath, 'utf8')).resolves.toBe(beforeIdentity);
  });

  it('fails adopt-existing before writes when the current catalog is unavailable', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-repair-no-catalog-adopt-'),
      scenario: 'freshCloneProject',
    });
    await fs.outputJson(fixture.files.sharedOwnerPath, {
      version: 1,
      pluginName: fixture.target.location.plugin,
      platform: 'codex',
      owner: {
        plugin: 'owner-plugin',
        platform: 'codex',
        scope: 'user',
      },
      ownerRecordPath: '/tmp/owner-record.json',
      ownerRecordDigest: 'sha256:owner',
      preference: 'manual',
      updatedAt: '2026-05-08T00:00:00.000Z',
    }, { spaces: 2 });
    await fs.outputJson(fixture.files.dependencyIndexPath, {
      version: 1,
      updatedAt: '2026-05-08T00:00:00.000Z',
      records: [],
    }, { spaces: 2 });
    const watchedPaths = [
      fixture.target.repoArtifactPath,
      fixture.files.projectIdentityPath,
      fixture.files.dependencyIndexPath,
      fixture.files.sharedOwnerPath,
    ] as const;
    const beforeStates = await Promise.all(watchedPaths.map((filePath) => snapshotPathState(filePath)));
    const adapter = new FakeRepairAdapter();

    await expect(
      repairCommand(
        [fixture.target.location.plugin],
        {
          cwd: fixture.paths.repoRoot,
          scope: 'project',
          platform: 'codex',
          adoptExisting: true,
        },
        {
          env: createInstallStateFixtureEnv(fixture.paths),
          adapters: {
            codex: adapter,
            claude: new FakeClaudeRepairAdapter(),
          },
          p7Targets: [{
            pluginName: fixture.target.location.plugin,
            platform: 'codex',
            scope: 'project',
            projectKey: fixture.target.location.projectKey ?? undefined,
            executionCwd: fixture.paths.repoRoot,
          }],
        } as never,
      ),
    ).rejects.toThrow('当前不在 current catalog 中');

    expect(adapter.installExtensions).not.toHaveBeenCalled();
    expect(adapter.installPlugin).not.toHaveBeenCalled();
    const afterStates = await Promise.all(watchedPaths.map((filePath) => snapshotPathState(filePath)));
    expect(afterStates).toEqual(beforeStates);
    await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(false);
    await expect(fs.pathExists(fixture.files.diagnosticCachePath)).resolves.toBe(false);
  });

  it('repairs a same-bundle missing dependency and returns status to installed', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-repair-dependency-missing-'),
    );
    const parentTarget = builder.createTarget({ pluginName: 'parent-plugin', platform: 'codex', scope: 'project', projectKey: builder.paths.repoRoot });
    const childTarget = builder.createTarget({ pluginName: 'child-plugin', platform: 'codex', scope: 'project', projectKey: builder.paths.repoRoot });

    await builder.writeRepoArtifact(parentTarget);
    const parentLifecycle = await builder.writeHistoricalLifecycleRuntime(parentTarget);
    const parentRecord = await builder.writeInstallRecord(parentTarget, parentLifecycle);
    parentRecord.record.dependencyEdges = [{
      dependency: childTarget.location,
      declaration: {
        name: childTarget.location.plugin,
        target: { scope: 'project' },
      },
    }];
    await fs.writeJson(path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${parentTarget.recordId}.json`), parentRecord, { spaces: 2 });
    await builder.writeDiagnosticCache(parentTarget);
    await builder.writeProjectIdentity(parentTarget);
    await builder.writeDependencyIndex([{ target: parentTarget, record: parentRecord }]);
    await rewriteSanitizedInstallRecordForP2(path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${parentTarget.recordId}.json`));
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));

    const parentPlugin = await createPluginMeta({
      rootDir: builder.paths.rootDir,
      pluginName: parentTarget.location.plugin,
    });
    const childPlugin = await createPluginMeta({
      rootDir: builder.paths.rootDir,
      pluginName: childTarget.location.plugin,
    });
    await alignFixtureSourceToPlugin({
      installRecordPath: path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${parentTarget.recordId}.json`),
      projectIdentityPath: path.join(builder.paths.repoRoot, '.agent-workflows', 'project-artifacts', 'codex', `${parentTarget.sharedIdentityId}.json`),
      plugin: parentPlugin,
    });
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));

    const adapter = new FakeRepairAdapter();
    const artifactContentByPlugin = new Map([
      [parentTarget.location.plugin, parentTarget.repoArtifactContent],
      [childTarget.location.plugin, childTarget.repoArtifactContent],
    ]);
    const artifactPathByPlugin = new Map([
      [parentTarget.location.plugin, parentTarget.repoArtifactPath],
      [childTarget.location.plugin, childTarget.repoArtifactPath],
    ]);
    adapter.installExtensions.mockImplementation(async (plugin, scope) => {
      const content = artifactContentByPlugin.get(plugin.manifest.name)!;
      const artifactPath = artifactPathByPlugin.get(plugin.manifest.name)!;
      await fs.outputFile(artifactPath, content, 'utf8');
      return [{
        path: artifactPath,
        kind: 'instruction',
        platform: 'codex',
        id: `${plugin.manifest.name === parentTarget.location.plugin ? parentTarget.pluginSlug : childTarget.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        artifactKey: `${plugin.manifest.name === parentTarget.location.plugin ? parentTarget.pluginSlug : childTarget.pluginSlug}.skill`,
        contentDigest: digest(content),
      }];
    });

    const runtime = {
      env: createInstallStateFixtureEnv(builder.paths),
      adapters: {
        codex: adapter,
        claude: new FakeClaudeRepairAdapter(),
      },
      p7Targets: [{
        pluginName: parentTarget.location.plugin,
        platform: 'codex',
        scope: 'project',
        projectKey: parentTarget.location.projectKey ?? undefined,
        executionCwd: builder.paths.repoRoot,
        currentPlugin: parentPlugin,
      }],
      p8CurrentPluginsByName: {
        [parentTarget.location.plugin]: parentPlugin,
        [childTarget.location.plugin]: childPlugin,
      },
    } as never;

    const repair = await repairCommand(
      [parentTarget.location.plugin],
      {
        cwd: builder.paths.repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      runtime,
    );

    expect(repair.payload.locations[0]?.action).toBe('sameBundleRepair');
    const childRecordPath = path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${childTarget.recordId}.json`);
    const childRecord = await fs.readJson(childRecordPath) as {
      record: {
        installSource: {
          kind: string;
          explicitlyRequested: boolean;
        };
      };
    };
    expect(childRecord.record.installSource).toEqual({
      kind: 'dependency',
      explicitlyRequested: false,
    });
    const repairedParentRecord = await fs.readJson(path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${parentTarget.recordId}.json`)) as {
      record: {
        dependencyEdges: Array<{ dependency: { plugin: string } }>;
      };
    };
    expect(repairedParentRecord.record.dependencyEdges).toEqual([
      expect.objectContaining({
        dependency: expect.objectContaining({
          plugin: childTarget.location.plugin,
        }),
      }),
    ]);
    const status = await statusCommand(
      [parentTarget.location.plugin],
      {
        cwd: builder.paths.repoRoot,
        scope: 'project',
        platform: 'codex',
      },
      {
        env: createInstallStateFixtureEnv(builder.paths),
        p7Targets: [{
          pluginName: parentTarget.location.plugin,
          platform: 'codex',
          scope: 'project',
          projectKey: parentTarget.location.projectKey ?? undefined,
          executionCwd: builder.paths.repoRoot,
          currentPlugin: parentPlugin,
        }],
      } as never,
    );
    expect(status.output).toContain('已安装');
  });

  it.each([
    { label: 'same-bundle project repair', adoptExisting: false },
    { label: 'adopt-existing', adoptExisting: true },
  ])('does not rewrite shared owner during %s', async ({ adoptExisting }) => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir(`aw-repair-owner-${adoptExisting ? 'adopt' : 'repair'}-`),
      scenario: adoptExisting ? 'freshCloneProject' : 'installed',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
      installLifecycleExitCode: adoptExisting ? 0 : undefined,
    });
    await alignFixtureSourceToPlugin({
      ...(adoptExisting
        ? { projectIdentityPath: fixture.files.projectIdentityPath }
        : {
            installRecordPath: fixture.files.installRecordPath,
            projectIdentityPath: fixture.files.projectIdentityPath,
          }),
      plugin,
    });
    if (!adoptExisting) {
      await rewriteSanitizedInstallRecordForP2(fixture.files.installRecordPath);
      await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath);
    }
    const ownerPayload = {
      version: 1,
      pluginName: fixture.target.location.plugin,
      platform: 'codex',
      owner: {
        plugin: 'other-owner',
        platform: 'codex',
        scope: 'user',
      },
      ownerRecordPath: '/tmp/other-owner-record.json',
      ownerRecordDigest: 'sha256:other',
      preference: 'manual',
      updatedAt: '2026-05-08T00:00:00.000Z',
    };
    await fs.outputJson(fixture.files.sharedOwnerPath, ownerPayload, { spaces: 2 });
    const ownerBefore = await fs.readFile(fixture.files.sharedOwnerPath, 'utf8');

    const adapter = new FakeRepairAdapter();
    adapter.installExtensions.mockImplementation(async () => {
      await fs.outputFile(fixture.target.repoArtifactPath, fixture.target.repoArtifactContent, 'utf8');
      return [{
        path: fixture.target.repoArtifactPath,
        kind: 'instruction',
        platform: 'codex',
        id: `${fixture.target.pluginSlug}-instruction`,
        target: 'codex.developerInstructionsBlock',
        artifactKey: `${fixture.target.pluginSlug}.skill`,
        contentDigest: digest(fixture.target.repoArtifactContent),
      }];
    });

    await repairCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: 'project',
        platform: 'codex',
        ...(adoptExisting ? { adoptExisting: true } : {}),
      },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        adapters: {
          codex: adapter,
          claude: new FakeClaudeRepairAdapter(),
        },
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: 'codex',
          scope: 'project',
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
          currentPlugin: plugin,
        }],
        p8CurrentPluginsByName: {
          [fixture.target.location.plugin]: plugin,
        },
      } as never,
    );

    await expect(fs.readFile(fixture.files.sharedOwnerPath, 'utf8')).resolves.toBe(ownerBefore);
  });

  it('honors repair --takeover-shared-runtime in direct repair execution', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-repair-takeover-direct-'),
    );
    const env = createInstallStateFixtureEnv(builder.paths);
    const pluginName = 'takeover-direct-plugin';
    const target = builder.createTarget({
      pluginName,
      platform: 'codex',
      scope: 'user',
    });
    await builder.writeRepoArtifact(target);
    const targetLifecycle = await builder.writeHistoricalLifecycleRuntime(target);
    await builder.writeInstallRecord(target, targetLifecycle);
    await builder.writeDiagnosticCache(target);
    await builder.writeExternalNativeEvidence(target);
    await builder.writeDependencyIndex([]);

    const targetRecordPath = path.join(
      builder.paths.codexHome,
      '.agent-workflows',
      'records',
      `${target.recordId}.json`,
    );
    const plugin = await createPluginMeta({
      rootDir: builder.paths.rootDir,
      pluginName,
    });
    await alignFixtureSourceToPlugin({
      installRecordPath: targetRecordPath,
      plugin,
    });
    const ownerStageSpy = vi.spyOn(transactionsModule, 'createSharedRuntimeOwnerWriteStage')
      .mockResolvedValue({
        label: 'shared runtime owner',
        async commit() {
          return;
        },
        async rollback() {
          return undefined;
        },
        async finalize() {
          return undefined;
        },
      });
    vi.spyOn(sharedRuntimeOwnerModule, 'preflightSharedSkillTriggerRuntimeOwnerUpsert')
      .mockImplementation(async (options) => (
        options.takeoverSharedRuntime
          ? {
            status: 'ok',
            assessment: {} as never,
            ownerInspection: {} as never,
            ownerAction: 'takeover',
            shouldWriteOwner: true,
            shouldMaterializeRuntime: true,
          }
          : {
            status: 'takeoverRequired',
            assessment: {} as never,
            ownerInspection: {} as never,
            takeoverRequired: {
              reason: 'foreignOwner',
              takeoverAllowed: true,
              suggestedFlag: '--takeover-shared-runtime',
              message: 'need --takeover-shared-runtime',
            },
          }
      ));

    const withoutTakeoverAdapter = new FakeRepairAdapter();
    await expect(repairCommand(
      [pluginName],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
      },
      {
        env,
        adapters: {
          codex: withoutTakeoverAdapter,
          claude: new FakeClaudeRepairAdapter(),
        },
        p7Targets: [{
          pluginName,
          platform: 'codex',
          scope: 'user',
          executionCwd: builder.paths.repoRoot,
          currentPlugin: plugin,
        }],
      } as never,
    )).rejects.toThrow('need --takeover-shared-runtime');
    expect(withoutTakeoverAdapter.installExtensions).not.toHaveBeenCalled();

    const withTakeoverAdapter = new FakeRepairAdapter();
    await repairCommand(
      [pluginName],
      {
        cwd: builder.paths.repoRoot,
        scope: 'user',
        platform: 'codex',
        takeoverSharedRuntime: true,
      },
      {
        env,
        adapters: {
          codex: withTakeoverAdapter,
          claude: new FakeClaudeRepairAdapter(),
        },
        p7Targets: [{
          pluginName,
          platform: 'codex',
          scope: 'user',
          executionCwd: builder.paths.repoRoot,
          currentPlugin: plugin,
        }],
      } as never,
    );

    expect(withTakeoverAdapter.installExtensions).toHaveBeenCalled();
    expect(ownerStageSpy).toHaveBeenCalledWith(expect.objectContaining({
      recordPath: targetRecordPath,
    }));
  });

  it('refuses default repair for non-adoptable residual artifacts without creating AW state', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-repair-residual-only-'),
      scenario: 'residual',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
    });
    const adapter = new FakeRepairAdapter();
    const beforeArtifact = await fs.readFile(fixture.target.repoArtifactPath, 'utf8');
    const beforeCache = await fs.readFile(fixture.files.diagnosticCachePath, 'utf8');

    await expect(
      repairCommand(
        [fixture.target.location.plugin],
        {
          cwd: fixture.paths.repoRoot,
          scope: 'project',
          platform: 'codex',
        },
        {
          env: createInstallStateFixtureEnv(fixture.paths),
          adapters: {
            codex: adapter,
            claude: new FakeClaudeRepairAdapter(),
          },
          p7Targets: [{
            pluginName: fixture.target.location.plugin,
            platform: 'codex',
            scope: 'project',
            projectKey: fixture.target.location.projectKey ?? undefined,
            executionCwd: fixture.paths.repoRoot,
            currentPlugin: plugin,
          }],
        } as never,
      ),
    ).rejects.toThrow(/cleanup|重新安装/);

    expect(adapter.installExtensions).not.toHaveBeenCalled();
    expect(adapter.installPlugin).not.toHaveBeenCalled();
    await expect(fs.readFile(fixture.target.repoArtifactPath, 'utf8')).resolves.toBe(beforeArtifact);
    await expect(fs.readFile(fixture.files.diagnosticCachePath, 'utf8')).resolves.toBe(beforeCache);
    await expect(fs.pathExists(fixture.files.installRecordPath)).resolves.toBe(false);
    await expect(fs.pathExists(fixture.files.projectIdentityPath)).resolves.toBe(false);
  });

  it('repairs the dependency index without pruning stale project references or rewriting other state', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-repair-dependency-index-'),
    );
    const projectTarget = builder.createTarget({ platform: 'codex', scope: 'project', projectKey: builder.paths.repoRoot });
    const userTarget = builder.createTarget({ pluginName: 'user-plugin', platform: 'codex', scope: 'user' });

    await builder.writeRepoArtifact(projectTarget);
    const projectLifecycle = await builder.writeHistoricalLifecycleRuntime(projectTarget);
    const projectRecord = await builder.writeInstallRecord(projectTarget, projectLifecycle);
    await builder.writeDiagnosticCache(projectTarget);
    await builder.writeProjectIdentity(projectTarget);

    await builder.writeRepoArtifact(userTarget);
    const userLifecycle = await builder.writeHistoricalLifecycleRuntime(userTarget);
    const userRecord = await builder.writeInstallRecord(userTarget, userLifecycle);
    await builder.writeDiagnosticCache(userTarget);
    await builder.writeProjectIdentity(userTarget);
    await builder.writeNativeMarker(userTarget, 'install');
    await builder.writeSharedRuntimeOwner(userTarget, path.join(builder.paths.codexHome, '.agent-workflows', 'records', `${userTarget.recordId}.json`));
    const configStorePath = path.join(builder.paths.repoRoot, '.agent-workflows', 'plugin-config', 'user-plugin', 'config.json');
    await fs.outputJson(configStorePath, { sample: true }, { spaces: 2 });

    await builder.writeDependencyIndex([
      { target: projectTarget, record: projectRecord },
      { target: userTarget, record: userRecord },
    ]);
    await rewriteSanitizedInstallRecordForP2(path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${projectTarget.recordId}.json`));
    await rewriteSanitizedInstallRecordForP2(path.join(builder.paths.codexHome, '.agent-workflows', 'records', `${userTarget.recordId}.json`));
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    await fs.remove(path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${projectTarget.recordId}.json`));

    const watchedPaths = [
      path.join(builder.paths.codexHome, '.agent-workflows', 'records', `${userTarget.recordId}.json`),
      path.join(builder.paths.codexHome, '.agent-workflows', 'diagnostics', `${userTarget.recordId}.json`),
      path.join(builder.paths.repoRoot, '.agent-workflows', 'project-artifacts', 'codex', `${userTarget.sharedIdentityId}.json`),
      userTarget.repoArtifactPath,
      path.join(userLifecycle.runtimeRoot, 'bundle', 'plugin.json'),
      path.join(builder.paths.awHome, 'native-recovery', 'codex', 'user', `${userTarget.pluginId}.json`),
      path.join(builder.paths.awHome, 'shared-runtime-owners', 'codex', `${userTarget.pluginSlug}.${userTarget.pluginHash}.json`),
      configStorePath,
    ] as const;
    const beforeStates = await Promise.all(watchedPaths.map((filePath) => snapshotPathState(filePath)));

    const result = await repairCommand(
      [],
      {
        cwd: builder.paths.repoRoot,
        dependencyIndex: true,
      },
      {
        env: createInstallStateFixtureEnv(builder.paths),
      },
    );

    expect(result.payload.dependencyIndex?.rebuiltEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plugin: userTarget.location.plugin,
          scope: 'user',
        }),
      ]),
    );
    expect(result.payload.dependencyIndex?.preservedEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plugin: projectTarget.location.plugin,
          status: 'staleCandidate',
        }),
      ]),
    );
    expect(result.payload.dependencyIndex?.coverage.coverageTrusted).toBe(false);
    expect(result.payload.dependencyIndex?.dependencyIndexTrusted).toBe(false);
    expect(result.payload.dependencyIndex?.dependencyIndexCoverageReason).toContain('staleReference');
    expect(result.payload.dependencyIndex?.dependencyIndexRevisitLocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plugin: projectTarget.location.plugin,
        }),
      ]),
    );
    const afterStates = await Promise.all(watchedPaths.map((filePath) => snapshotPathState(filePath)));
    expect(afterStates).toEqual(beforeStates);
    expect(result.output).toContain('覆盖范围仍不完整');
    expect(result.output).toContain(projectTarget.location.plugin);
  });

  it('reports dependency-index recovery guidance when no related project location can be revisited', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-repair-dependency-index-missing-'),
    );
    const userTarget = builder.createTarget({ pluginName: 'solo-plugin', platform: 'codex', scope: 'user' });
    await builder.writeRepoArtifact(userTarget);
    const userLifecycle = await builder.writeHistoricalLifecycleRuntime(userTarget);
    const userRecord = await builder.writeInstallRecord(userTarget, userLifecycle);
    await builder.writeDiagnosticCache(userTarget);
    await builder.writeDependencyIndex([{ target: userTarget, record: userRecord }]);
    await rewriteSanitizedInstallRecordForP2(path.join(builder.paths.codexHome, '.agent-workflows', 'records', `${userTarget.recordId}.json`));
    await refreshDependencyIndexDigestsForP2(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));
    await fs.remove(path.join(builder.paths.awHome, 'dependency-index', 'index.json'));

    const human = await repairCommand(
      [],
      {
        cwd: builder.paths.repoRoot,
        dependencyIndex: true,
      },
      {
        env: createInstallStateFixtureEnv(builder.paths),
      },
    );
    expect(human.payload.dependencyIndex?.coverage.coverageTrusted).toBe(false);
    expect(human.payload.dependencyIndex?.coverage.recoverySuggestion).toBe('revisitRelatedProjects');
    expect(human.payload.dependencyIndex?.dependencyIndexRecoveryMessage).toBe('请回到可能相关的仓库重新运行 status --verbose 或 repair。');
    expect(human.output).toContain('回到可能相关的仓库重新运行 status --verbose 或 repair');
  });

  it('refuses to implicitly migrate legacy dynamic tracking that the current manifest no longer declares', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-repair-legacy-dynamic-'),
      scenario: 'installed',
    });
    const plugin = await createPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
    });
    await alignFixtureSourceToPlugin({
      installRecordPath: fixture.files.installRecordPath,
      projectIdentityPath: fixture.files.projectIdentityPath,
      plugin,
    });
    await rewriteSanitizedInstallRecordForP2(fixture.files.installRecordPath);
    await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath);
    const record = await fs.readJson(fixture.files.installRecordPath) as {
      record: {
        artifacts: Array<Record<string, unknown>>;
      };
    };
    record.record.artifacts[0] = {
      ...record.record.artifacts[0],
      id: 'lightweight-instruction',
    };
    await fs.writeJson(fixture.files.installRecordPath, record, { spaces: 2 });
    await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath);

    const adapter = new FakeRepairAdapter();
    await expect(repairCommand(
      [fixture.target.location.plugin],
      {
        cwd: fixture.paths.repoRoot,
        scope: 'project',
        platform: 'codex',
        json: true,
      },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        adapters: {
          codex: adapter,
          claude: new FakeClaudeRepairAdapter(),
        },
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: 'codex',
          scope: 'project',
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
          currentPlugin: plugin,
        }],
        p8CurrentPluginsByName: {
          [fixture.target.location.plugin]: plugin,
        },
      } as never,
    )).rejects.toThrow('当前 manifest 已移除的历史 dynamic tracking');
    expect(adapter.installExtensions).not.toHaveBeenCalled();
  });
});
