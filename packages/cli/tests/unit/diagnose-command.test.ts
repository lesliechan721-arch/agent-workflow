import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { diagnoseCommand } from '../../src/commands/diagnose.js';
import type { PluginMeta } from '../../src/types.js';
import { createArtifactConfigDigest } from '../../src/utils/artifact-plan.js';
import { resolveArtifactRenderConfig, resolveArtifactRendererTarget } from '../../src/utils/artifact-renderer.js';
import { calculateFileDigest, calculatePluginBundleFingerprint } from '../../src/utils/plugin-scripts.js';
import {
  createInstallStateFixtureEnv,
  refreshDependencyIndexDigestsForP2,
  rewriteSanitizedInstallRecordForP2,
} from '../helpers/install-state-projection-fixtures.js';
import {
  createMinimalPluginInstallStateFixtureBuilder,
  findForbiddenStdoutTerms,
  writeMinimalPluginInstallStateFixture,
} from '../helpers/minimal-plugin-install-state-fixtures.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function maybePrepareP2RecordFiles(fixture: Awaited<ReturnType<typeof writeMinimalPluginInstallStateFixture>>): Promise<void> {
  await rewriteSanitizedInstallRecordForP2(fixture.files.installRecordPath).catch(() => undefined);
  await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath).catch(() => undefined);
}

async function createProjectPluginMeta(options: {
  rootDir: string;
  pluginName: string;
  includeDynamicInstructionTarget?: boolean;
}): Promise<PluginMeta> {
  const pluginRoot = path.join(options.rootDir, 'catalog', options.pluginName);
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const rendererPath = path.join(pluginRoot, 'scripts', 'render.mjs');
  const includeDynamicInstructionTarget = options.includeDynamicInstructionTarget ?? true;
  const manifest = {
    name: options.pluginName,
    version: '1.0.0',
    description: `${options.pluginName} plugin`,
    marketplace: {
      category: 'workflow',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'NONE',
      },
    },
    ...(includeDynamicInstructionTarget
      ? {
          artifacts: {
            targets: [{
              id: `${options.pluginName}-instruction`,
              platform: 'codex',
              scopes: ['project'],
              target: 'codex.developerInstructionsBlock',
              kind: 'instruction',
              projectManagedKind: 'skill',
              states: ['present', 'disabled'],
              refreshKeys: ['sharedFlag'],
              requiresCodexProjectConfig: true,
            }],
          },
        }
      : {
          artifacts: {
            targets: [],
          },
        }),
    scripts: {
      artifacts: {
        render: {
          runner: 'node',
          path: 'scripts/render.mjs',
        },
      },
    },
  };
  await fs.ensureDir(path.dirname(manifestPath));
  await fs.ensureDir(path.dirname(rendererPath));
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  await fs.writeFile(rendererPath, 'export default {};\n', 'utf8');
  return {
    rootDir: pluginRoot,
    manifestPath,
    manifest,
  };
}

async function alignFixtureSourceToPlugin(options: {
  fixture: Awaited<ReturnType<typeof writeMinimalPluginInstallStateFixture>>;
  currentPlugin: PluginMeta;
}): Promise<void> {
  const source = {
    pluginVersion: options.currentPlugin.manifest.version,
    manifestDigest: await calculateFileDigest(options.currentPlugin.manifestPath),
    bundleFingerprint: await calculatePluginBundleFingerprint(options.currentPlugin.rootDir),
  };
  const record = await fs.readJson(options.fixture.files.installRecordPath) as {
    record: { source: typeof source };
  } & Record<string, unknown>;
  record.record.source = source;
  await fs.writeJson(options.fixture.files.installRecordPath, record, { spaces: 2 });

  const identity = await fs.readJson(options.fixture.files.projectIdentityPath) as {
    source: typeof source;
  } & Record<string, unknown>;
  identity.source = source;
  await fs.writeJson(options.fixture.files.projectIdentityPath, identity, { spaces: 2 });

  const renderConfig = await resolveArtifactRenderConfig({
    pluginName: options.currentPlugin.manifest.name,
    manifest: options.currentPlugin.manifest,
    scope: 'project',
    cwd: options.fixture.paths.repoRoot,
    env: createInstallStateFixtureEnv(options.fixture.paths),
  });
  const target = await resolveArtifactRendererTarget(options.currentPlugin);
  const diagnosticCache = await fs.readJson(options.fixture.files.diagnosticCachePath) as {
    artifacts: Array<{ id: string; target: string; configDigest?: string }>;
  };
  const digestSalt = target.rendererDigest ?? target.manifestDigest!;
  for (const artifact of diagnosticCache.artifacts) {
    artifact.configDigest = createArtifactConfigDigest({
      artifact: {
        id: artifact.id,
        platform: 'codex',
        target: artifact.target as 'codex.developerInstructionsBlock',
        refreshKeys: ['sharedFlag'],
      },
      configValues: renderConfig.values,
      digestSalt,
    });
  }
  await fs.writeJson(options.fixture.files.diagnosticCachePath, diagnosticCache, { spaces: 2 });
  await refreshDependencyIndexDigestsForP2(options.fixture.files.dependencyIndexPath).catch(() => undefined);
}

async function stripFixtureLifecycle(
  fixture: Awaited<ReturnType<typeof writeMinimalPluginInstallStateFixture>>,
): Promise<void> {
  const record = await fs.readJson(fixture.files.installRecordPath) as {
    record: Record<string, unknown>;
  } & Record<string, unknown>;
  delete record.record.lifecycle;
  await fs.writeJson(fixture.files.installRecordPath, record, { spaces: 2 });
  await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath).catch(() => undefined);
}

function createRendererRunner() {
  return {
    run: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      stdout: JSON.stringify({ version: 1, artifacts: [] }),
      stderr: '',
      timedOut: false,
    })),
  };
}

async function createAlignedInstalledDiagnoseFixture(prefix: string) {
  const fixture = await writeMinimalPluginInstallStateFixture({
    rootDir: await makeTempDir(prefix),
    scenario: 'installed',
  });
  await maybePrepareP2RecordFiles(fixture);
  const currentPlugin = await createProjectPluginMeta({
    rootDir: fixture.paths.rootDir,
    pluginName: fixture.target.location.plugin,
  });
  await alignFixtureSourceToPlugin({ fixture, currentPlugin });
  await stripFixtureLifecycle(fixture);
  const rendererRunner = createRendererRunner();

  return {
    fixture,
    currentPlugin,
    rendererRunner,
    runtime: {
      env: createInstallStateFixtureEnv(fixture.paths),
      p7Targets: [{
        pluginName: fixture.target.location.plugin,
        platform: fixture.target.location.platform,
        scope: fixture.target.location.scope,
        projectKey: fixture.target.location.projectKey ?? undefined,
        executionCwd: fixture.paths.repoRoot,
        currentPlugin,
      }],
      p7ArtifactRendererRunner: rendererRunner,
    } as never,
  };
}

async function updateDiagnosticCache(
  cachePath: string,
  mutate: (cache: {
    artifacts: Array<Record<string, unknown>>;
  } & Record<string, unknown>) => void,
): Promise<void> {
  const cache = await fs.readJson(cachePath) as {
    artifacts: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  mutate(cache);
  await fs.writeJson(cachePath, cache, { spaces: 2 });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('diagnose P7', () => {
  it.each([
    {
      label: 'dynamic content drift',
      mutate: async (fixture: Awaited<ReturnType<typeof writeMinimalPluginInstallStateFixture>>) => {
        await fs.writeFile(fixture.target.repoArtifactPath, `${fixture.target.repoArtifactContent}changed\n`, 'utf8');
      },
      expectedText: '动态内容与已接受摘要不一致',
    },
    {
      label: 'dynamic config stale',
      mutate: async (fixture: Awaited<ReturnType<typeof writeMinimalPluginInstallStateFixture>>) => {
        await updateDiagnosticCache(fixture.files.diagnosticCachePath, (cache) => {
          cache.artifacts[0]!.configDigest = 'config:stale';
        });
      },
      expectedText: '共享渲染配置摘要已经变化',
    },
    {
      label: 'recent refresh failed',
      mutate: async (fixture: Awaited<ReturnType<typeof writeMinimalPluginInstallStateFixture>>) => {
        await updateDiagnosticCache(fixture.files.diagnosticCachePath, (cache) => {
          cache.artifacts[0]!.lastRefresh = {
            status: 'failed',
            at: '2026-05-08T00:00:00.000Z',
            event: 'config',
            error: 'refresh timeout',
          };
        });
      },
      expectedText: '最近一次动态刷新失败',
    },
  ])('reports %s from cache without invoking the renderer by default', async ({ mutate, expectedText }) => {
    const { fixture, rendererRunner, runtime } = await createAlignedInstalledDiagnoseFixture(`aw-diagnose-dynamic-${Math.random().toString(16).slice(2)}-`);
    await mutate(fixture);

    const result = await diagnoseCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot },
      runtime,
    );

    expect(rendererRunner.run).not.toHaveBeenCalled();
    expect(result.output).toContain(expectedText);
    expect(findForbiddenStdoutTerms(result.output)).toEqual([]);
  });

  it('treats decoupled dynamic diagnostic cache entries as unavailable without reporting drift', async () => {
    const { fixture, rendererRunner, runtime } = await createAlignedInstalledDiagnoseFixture('aw-diagnose-decoupled-cache-');
    await updateDiagnosticCache(fixture.files.diagnosticCachePath, (cache) => {
      cache.artifacts[0]!.artifactKey = 'another-plugin.skill';
      cache.artifacts[0]!.configDigest = 'config:foreign';
      cache.artifacts[0]!.contentDigest = 'digest:foreign';
      cache.artifacts[0]!.lastRefresh = {
        status: 'failed',
        at: '2026-05-08T00:00:00.000Z',
        event: 'config',
        error: 'should not leak',
      };
    });

    const result = await diagnoseCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot },
      runtime,
    );

    expect(rendererRunner.run).not.toHaveBeenCalled();
    expect(result.output).toContain('动态诊断信息目前不可用');
    expect(result.output).toContain('aw diagnose');
    expect(result.output).not.toContain('动态内容与已接受摘要不一致');
    expect(result.output).not.toContain('共享渲染配置摘要已经变化');
    expect(result.output).not.toContain('最近一次动态刷新失败');
  });

  it('explains removed legacy dynamic tracking without treating the old entry as current missing capability', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-diagnose-legacy-dynamic-'),
      scenario: 'installed',
    });
    await maybePrepareP2RecordFiles(fixture);
    const currentPlugin = await createProjectPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
      includeDynamicInstructionTarget: false,
    });
    await alignFixtureSourceToPlugin({ fixture, currentPlugin });
    await stripFixtureLifecycle(fixture);
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
    await updateDiagnosticCache(fixture.files.diagnosticCachePath, (cache) => {
      cache.artifacts[0]!.id = 'lightweight-instruction';
    });
    await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath);
    const rendererRunner = createRendererRunner();

    const result = await diagnoseCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot, json: true },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: fixture.target.location.platform,
          scope: fixture.target.location.scope,
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
          currentPlugin,
        }],
        p7ArtifactRendererRunner: rendererRunner,
      } as never,
    );

    const payload = JSON.parse(result.output) as {
      locations: Array<{
        summary: string;
        findings: string[];
        issues: Array<{ code: string }>;
        legacyDynamicTracking: Array<{
          id: string;
          target: string;
        }>;
      }>;
    };
    expect(rendererRunner.run).not.toHaveBeenCalled();
    expect(payload.locations[0]?.summary).toContain('历史 dynamic tracking');
    expect(payload.locations[0]?.findings.join('\n')).toContain('不会在 status / diagnose / repair 中隐式迁移');
    expect(payload.locations[0]?.legacyDynamicTracking).toEqual([
      expect.objectContaining({
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
      }),
    ]);
    expect(payload.locations[0]?.issues ?? []).toEqual([]);
  });

  it('keeps default project diagnose absolutely read-only when ignore rules are missing', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-diagnose-readonly-project-'),
    );
    const target = builder.createTarget({
      pluginName: 'readonly-diagnose',
      platform: 'codex',
      scope: 'project',
      projectKey: builder.paths.repoRoot,
    });
    const env = createInstallStateFixtureEnv(builder.paths);
    const gitignorePath = path.join(builder.paths.repoRoot, '.gitignore');
    const privateStateRoot = path.join(builder.paths.repoRoot, '.codex', '.agent-workflows');
    const claudePrivateStateRoot = path.join(builder.paths.repoRoot, '.claude', '.agent-workflows');
    const projectLocalConfigRoot = path.join(builder.paths.repoRoot, '.agent-workflows', 'plugin-config.local');
    const recordPath = path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'records', `${target.recordId}.json`);
    const diagnosticCachePath = path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'diagnostics', `${target.recordId}.json`);

    const result = await diagnoseCommand(
      [target.location.plugin],
      { cwd: builder.paths.repoRoot },
      {
        env,
        p7Targets: [{
          pluginName: target.location.plugin,
          platform: target.location.platform,
          scope: target.location.scope,
          projectKey: target.location.projectKey ?? undefined,
          executionCwd: builder.paths.repoRoot,
        }],
      } as never,
    );

    expect(result.output).toContain('未安装');
    await expect(fs.pathExists(gitignorePath)).resolves.toBe(false);
    await expect(fs.pathExists(privateStateRoot)).resolves.toBe(false);
    await expect(fs.pathExists(claudePrivateStateRoot)).resolves.toBe(false);
    await expect(fs.pathExists(projectLocalConfigRoot)).resolves.toBe(false);
    await expect(fs.pathExists(recordPath)).resolves.toBe(false);
    await expect(fs.pathExists(diagnosticCachePath)).resolves.toBe(false);
  });

  it('shows record plus install marker residual as actionable without mutating record or marker files', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-diagnose-record-marker-'),
      scenario: 'recordAndInstallMarkerResidual',
    });
    await maybePrepareP2RecordFiles(fixture);
    const beforeRecord = await fs.readFile(fixture.files.installRecordPath, 'utf8');
    const beforeMarker = await fs.readFile(fixture.files.nativeMarkerPath, 'utf8');

    const result = await diagnoseCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: fixture.target.location.platform,
          scope: fixture.target.location.scope,
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
        }],
      } as never,
    );

    expect(result.output).toContain('结论：需要处理');
    expect(result.output).toContain('aw repair');
    expect(result.output).toContain('aw cleanup');
    expect(await fs.readFile(fixture.files.installRecordPath, 'utf8')).toBe(beforeRecord);
    expect(await fs.readFile(fixture.files.nativeMarkerPath, 'utf8')).toBe(beforeMarker);

    const jsonResult = await diagnoseCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot, json: true },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: fixture.target.location.platform,
          scope: fixture.target.location.scope,
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
        }],
      } as never,
    );
    const payload = JSON.parse(jsonResult.output) as {
      locations: Array<{
        nativeTransactionMarker: {
          status: string;
          recordCommitted: boolean;
          markerPending: boolean;
          needsAttention: boolean;
        };
      }>;
    };
    expect(payload.locations[0].nativeTransactionMarker).toMatchObject({
      status: 'recordInstallResidual',
      recordCommitted: true,
      markerPending: true,
      needsAttention: true,
    });
  });

  it('includes stale prune tokens and commands in default diagnose output', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-diagnose-stale-index-'),
      scenario: 'staleDependencyIndex',
    });
    await maybePrepareP2RecordFiles(fixture);

    const jsonResult = await diagnoseCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot, json: true },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: fixture.target.location.platform,
          scope: fixture.target.location.scope,
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
        }],
      } as never,
    );
    const payload = JSON.parse(jsonResult.output) as {
      locations: Array<{
        dependencyIndex: {
          dependencyIndexTrusted: boolean;
          dependencyIndexCoverageReason: string[];
          staleProjectReferences: Array<{
            recordPath: string;
          }>;
          actions: Array<{
            type: string;
            token?: string;
            command?: string;
          }>;
        };
      }>;
    };
    expect(payload.locations[0].dependencyIndex.dependencyIndexTrusted).toBe(false);
    expect(payload.locations[0].dependencyIndex.dependencyIndexCoverageReason).toContain('staleReference');
    expect(payload.locations[0].dependencyIndex.staleProjectReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordPath: fixture.files.installRecordPath,
        }),
      ]),
    );
    const staleAction = payload.locations[0].dependencyIndex.actions.find((action) => action.type === 'staleProjectReference');
    expect(staleAction?.token).toEqual(expect.any(String));
    expect(staleAction?.command).toContain('aw cleanup --dependency-index --prune-stale');

    const human = await diagnoseCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: fixture.target.location.platform,
          scope: fixture.target.location.scope,
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
        }],
      } as never,
    );
    expect(human.output).toContain('prune token');
    expect(human.output).toContain(staleAction!.token!);
    expect(human.output).toContain(staleAction!.command!);
  });

  it('does not emit prune tokens for unreadable dependency references', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-diagnose-unreadable-index-'),
      scenario: 'unreadableDependencyIndex',
    });
    await maybePrepareP2RecordFiles(fixture);

    const result = await diagnoseCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot, json: true },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: fixture.target.location.platform,
          scope: fixture.target.location.scope,
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
        }],
      } as never,
    );

    const payload = JSON.parse(result.output) as {
      locations: Array<{
        dependencyIndex: {
          actions: Array<{
            type: string;
            token?: string;
            command?: string;
          }>;
        };
      }>;
    };
    expect(payload.locations[0].dependencyIndex.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'unreadableProjectReference',
        }),
      ]),
    );
    expect(payload.locations[0].dependencyIndex.actions[0]).not.toHaveProperty('token');
    expect(payload.locations[0].dependencyIndex.actions[0]).not.toHaveProperty('command');
  });

  it('shows cleanup --force backup items in human and JSON diagnose output', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-diagnose-force-cleanup-'),
    );
    const target = builder.createTarget({
      pluginName: 'force-cleanup-target',
      platform: 'codex',
      scope: 'project',
      projectKey: builder.paths.repoRoot,
    });
    await builder.writeRepoArtifact(target);
    await builder.writeProjectIdentity(target);
    await builder.writeDiagnosticCache(target);
    const fixture = {
      paths: builder.paths,
      target,
    };

    const human = await diagnoseCommand(
      [target.location.plugin],
      { cwd: builder.paths.repoRoot },
      {
        env: createInstallStateFixtureEnv(builder.paths),
        p7Targets: [{
          pluginName: target.location.plugin,
          platform: target.location.platform,
          scope: target.location.scope,
          projectKey: target.location.projectKey ?? undefined,
          executionCwd: builder.paths.repoRoot,
        }],
      } as never,
    );
    expect(human.output).toContain('cleanup --force 备份范围');
    expect(human.output).toContain(target.repoArtifactPath);

    const json = await diagnoseCommand(
      [target.location.plugin],
      { cwd: builder.paths.repoRoot, json: true },
      {
        env: createInstallStateFixtureEnv(builder.paths),
        p7Targets: [{
          pluginName: target.location.plugin,
          platform: target.location.platform,
          scope: target.location.scope,
          projectKey: target.location.projectKey ?? undefined,
          executionCwd: builder.paths.repoRoot,
        }],
      } as never,
    );
    const payload = JSON.parse(json.output) as {
      locations: Array<{
        forceCleanup: {
          required: boolean;
          backupItems: Array<{ path: string; reason: string }>;
        };
      }>;
    };
    expect(payload.locations[0].forceCleanup).toMatchObject({
      required: true,
      backupItems: [
        expect.objectContaining({
          path: target.repoArtifactPath,
        }),
      ],
    });
  });

  it('shows recovery paths for dependency index coverage gaps and suppresses unused dependency hints', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-diagnose-coverage-gap-'),
      scenario: 'installed',
    });
    await maybePrepareP2RecordFiles(fixture);
    const record = await fs.readJson(fixture.files.installRecordPath) as {
      record: {
        installSource: {
          kind: 'explicit' | 'dependency';
          explicitlyRequested: boolean;
        };
      };
    } & Record<string, unknown>;
    record.record.installSource = {
      kind: 'dependency',
      explicitlyRequested: false,
    };
    await fs.writeJson(fixture.files.installRecordPath, record, { spaces: 2 });
    await fs.remove(path.join(fixture.paths.awHome, 'dependency-index'));

    const result = await diagnoseCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: fixture.target.location.platform,
          scope: fixture.target.location.scope,
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
        }],
      } as never,
    );

    expect(result.output).toContain('依赖索引当前不可信');
    expect(result.output).toContain('回到可能相关的仓库重新运行 diagnose 或 repair');
    expect(result.output).not.toContain('这个目标是自动装上的依赖');
  });

  it('offers cleanup for config-only Codex native residue when dependency index is missing', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-diagnose-config-only-native-residue-'),
    );
    const target = builder.createTarget({ pluginName: 'git-commit', platform: 'codex', scope: 'user' });
    await fs.outputFile(
      path.join(builder.paths.codexHome, 'config.toml'),
      `[plugins."${target.pluginId}"]\nenabled = true\n`,
      'utf8',
    );

    const runtime = {
      env: createInstallStateFixtureEnv(builder.paths),
      p7Targets: [{
        pluginName: target.location.plugin,
        platform: target.location.platform,
        scope: target.location.scope,
        executionCwd: builder.paths.repoRoot,
      }],
    } as never;

    const json = await diagnoseCommand(
      [target.location.plugin],
      { cwd: builder.paths.repoRoot, json: true },
      runtime,
    );
    const payload = JSON.parse(json.output) as {
      locations: Array<{
        state: string;
        cleanupAvailable: boolean;
        nextSteps: string[];
      }>;
    };
    expect(payload.locations[0]).toMatchObject({
      state: 'externallyManaged',
      cleanupAvailable: true,
    });
    expect(payload.locations[0]?.nextSteps).toContain('aw cleanup git-commit -p codex -s user');

    const human = await diagnoseCommand(
      [target.location.plugin],
      { cwd: builder.paths.repoRoot, platform: 'codex', scope: 'user' },
      runtime,
    );
    expect(human.output).toContain('可执行操作：repair=no，cleanup=yes');
    expect(human.output).toContain('aw cleanup git-commit -p codex -s user');
  });

  it('runs the renderer in diagnose --deep without rewriting the diagnostic cache', async () => {
    const { fixture, currentPlugin } = await createAlignedInstalledDiagnoseFixture('aw-diagnose-deep-');
    const cacheBefore = await fs.readFile(fixture.files.diagnosticCachePath, 'utf8');
    const rendererRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          version: 1,
          artifacts: [{
            id: `${fixture.target.location.plugin}-instruction`,
            platform: 'codex',
            target: 'codex.developerInstructionsBlock',
            kind: 'instruction',
            state: 'present',
            refreshKeys: ['sharedFlag'],
            content: fixture.target.repoArtifactContent,
          }],
        }),
        stderr: '',
        timedOut: false,
      })),
    };

    const result = await diagnoseCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot, json: true, deep: true },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: fixture.target.location.platform,
          scope: fixture.target.location.scope,
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
          currentPlugin,
        }],
        p7ArtifactRendererRunner: rendererRunner,
      } as never,
    );

    const cacheAfter = await fs.readFile(fixture.files.diagnosticCachePath, 'utf8');
    const payload = JSON.parse(result.output) as {
      deep: boolean;
      locations: Array<{
        deepDiagnose: {
          attempted: boolean;
          rendered: boolean;
        };
      }>;
    };
    expect(rendererRunner.run).toHaveBeenCalledTimes(1);
    expect(cacheAfter).toBe(cacheBefore);
    expect(payload.deep).toBe(true);
    expect(payload.locations[0].deepDiagnose).toMatchObject({
      attempted: true,
      rendered: true,
    });
  });

  it('reports codex.skill expected-tree diff sources in diagnose --deep JSON', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-diagnose-deep-skill-'),
      scenario: 'installed',
    });
    await maybePrepareP2RecordFiles(fixture);
    const currentPlugin = await createProjectPluginMeta({
      rootDir: fixture.paths.rootDir,
      pluginName: fixture.target.location.plugin,
    });
    currentPlugin.manifest.artifacts = {
      targets: [{
        id: 'codex-explore-skill',
        platform: 'codex',
        scopes: ['project'],
        target: 'codex.skill',
        kind: 'skill',
        projectManagedKind: 'skill',
        states: ['present'],
        refreshKeys: ['sharedFlag'],
        skillKey: 'codex-explore',
      }],
    };
    await fs.writeJson(currentPlugin.manifestPath, currentPlugin.manifest, { spaces: 2 });
    await alignFixtureSourceToPlugin({ fixture, currentPlugin });
    await stripFixtureLifecycle(fixture);

    const record = await fs.readJson(fixture.files.installRecordPath) as {
      recordId: string;
      record: {
        artifacts: Array<Record<string, unknown>>;
        options?: Record<string, unknown>;
      };
    };
    record.record.artifacts = [{
      ...record.record.artifacts[0],
      id: 'codex-explore-skill',
      target: 'codex.skill',
      artifactKey: 'codex-explore',
      path: path.join(fixture.paths.repoRoot, '.agents', 'skills', 'codex-explore'),
      paths: [
        path.join(fixture.paths.repoRoot, '.agents', 'skills', 'codex-explore', 'SKILL.md'),
        path.join(fixture.paths.repoRoot, '.agents', 'skills', 'codex-explore', 'agents', 'openai.yaml'),
      ],
    }];
    record.record.options = {
      ...(record.record.options ?? {}),
      skillTriggerPreference: 'manual',
    };
    await fs.writeJson(fixture.files.installRecordPath, record, { spaces: 2 });
    await refreshDependencyIndexDigestsForP2(fixture.files.dependencyIndexPath);

    await fs.remove(fixture.files.projectIdentityPath);
    await fs.outputFile(
      path.join(fixture.paths.repoRoot, '.agents', 'skills', 'codex-explore', 'SKILL.md'),
      '# drifted skill\n',
      'utf8',
    );
    await fs.outputFile(
      path.join(fixture.paths.repoRoot, '.agents', 'skills', 'codex-explore', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
      'utf8',
    );
    await fs.writeJson(fixture.files.diagnosticCachePath, {
      version: 1,
      recordId: record.recordId,
      location: {
        plugin: fixture.target.location.plugin,
        platform: fixture.target.location.platform,
        scope: fixture.target.location.scope,
        projectKey: fixture.target.location.projectKey,
      },
      updatedAt: '2026-05-09T00:00:00.000Z',
      artifacts: [{
        id: 'codex-explore-skill',
        target: 'codex.skill',
        state: 'present',
        artifactKey: 'codex-explore',
        configDigest: 'sha256:cached',
        contentDigest: 'sha256:cached-content',
      }],
    }, { spaces: 2 });

    const rendererRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        stdout: JSON.stringify({
          version: 1,
          artifacts: [{
            id: 'codex-explore-skill',
            platform: 'codex',
            target: 'codex.skill',
            kind: 'skill',
            state: 'present',
            skillKey: 'codex-explore',
            refreshKeys: ['sharedFlag'],
            content: {
              skillFile: '# expected skill\n',
              openaiYaml: 'policy:\n  allow_implicit_invocation: true\n',
            },
          }],
        }),
        stderr: '',
        timedOut: false,
      })),
    };

    const result = await diagnoseCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot, json: true, deep: true },
      {
        env: createInstallStateFixtureEnv(fixture.paths),
        p7Targets: [{
          pluginName: fixture.target.location.plugin,
          platform: fixture.target.location.platform,
          scope: fixture.target.location.scope,
          projectKey: fixture.target.location.projectKey ?? undefined,
          executionCwd: fixture.paths.repoRoot,
          currentPlugin,
        }],
        p7ArtifactRendererRunner: rendererRunner,
      } as never,
    );

    const payload = JSON.parse(result.output) as {
      locations: Array<{
        findings: string[];
        deepDiagnose: {
          artifacts: Array<{
            id: string;
            target: string;
            artifactKey?: string;
            triggerPreference?: string;
            drift?: boolean;
            driftReasons?: string[];
            fileDiffs?: Array<{ path: string; reason: string }>;
          }>;
        };
      }>;
    };
    const artifact = payload.locations[0]?.deepDiagnose.artifacts.find((entry) => entry.id === 'codex-explore-skill');
    expect(rendererRunner.run).toHaveBeenCalledTimes(1);
    expect(artifact).toMatchObject({
      target: 'codex.skill',
      artifactKey: 'codex-explore',
      drift: true,
    });
    expect(artifact?.triggerPreference).toEqual(expect.any(String));
    expect(artifact?.driftReasons?.some((reason) => reason.includes('SKILL.md'))).toBe(true);
    expect(artifact?.fileDiffs?.some((entry) => entry.path === 'SKILL.md')).toBe(true);
    expect(payload.locations[0]?.findings.join('\n')).toContain('expected tree');
  });
});
