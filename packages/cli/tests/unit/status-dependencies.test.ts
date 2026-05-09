import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { statusCommand } from '../../src/commands/status.js';
import type { PluginMeta } from '../../src/types.js';
import { createArtifactConfigDigest } from '../../src/utils/artifact-plan.js';
import { resolveArtifactRenderConfig, resolveArtifactRendererTarget } from '../../src/utils/artifact-renderer.js';
import { calculateFileDigest, calculatePluginBundleFingerprint } from '../../src/utils/plugin-scripts.js';
import {
  createInstallStateFixtureEnv,
  refreshDependencyIndexDigestsForP2,
  rewriteSanitizedInstallRecordForP2,
  sanitizeInstallRecordForP2,
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

async function createAlignedInstalledStatusFixture(prefix: string) {
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

function projectRecordPath(rootDir: string, recordId: string): string {
  return path.join(rootDir, '.codex', '.agent-workflows', 'records', `${recordId}.json`);
}

async function writeInstalledProjectRecord(options: {
  builder: Awaited<ReturnType<typeof createMinimalPluginInstallStateFixtureBuilder>>;
  pluginName: string;
  installSource?: { kind: 'explicit' | 'dependency'; explicitlyRequested: boolean };
  dependencyEdges?: Array<{
    dependency: {
      plugin: string;
      platform: 'codex' | 'claude';
      scope: 'user' | 'project';
      projectKey?: string | null;
    };
    declaration: {
      name: string;
      target?: { scope?: 'user' | 'project' };
      inheritInstallOptions?: boolean;
      when?: { platforms?: Array<'codex' | 'claude'> };
    };
  }>;
}) {
  const target = options.builder.createTarget({
    pluginName: options.pluginName,
    platform: 'codex',
    scope: 'project',
    projectKey: options.builder.paths.repoRoot,
  });
  await options.builder.writeRepoArtifact(target);
  const recordPath = projectRecordPath(options.builder.paths.repoRoot, target.recordId);
  const sanitizedRecord = sanitizeInstallRecordForP2(await options.builder.writeInstallRecord(target));
  if (options.installSource) {
    sanitizedRecord.record.installSource = options.installSource;
  }
  if (options.dependencyEdges) {
    sanitizedRecord.record.dependencyEdges = options.dependencyEdges;
  }
  await fs.writeJson(recordPath, sanitizedRecord, { spaces: 2 });
  await options.builder.writeProjectIdentity(target);
  await options.builder.writeDiagnosticCache(target);

  return { target, record: sanitizedRecord, recordPath };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('status P7', () => {
  it('keeps default status read-only and does not invoke the dynamic renderer', async () => {
    const { fixture, rendererRunner, runtime } = await createAlignedInstalledStatusFixture('aw-status-installed-');

    const result = await statusCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot },
      runtime,
    );

    expect(rendererRunner.run).not.toHaveBeenCalled();
    expect(result.output).toContain('插件状态');
    expect(result.output).toContain(`- ${fixture.target.location.plugin}`);
    expect(findForbiddenStdoutTerms(result.output)).toEqual([]);
  });

  it.each([
    {
      label: 'dynamic content drift',
      mutate: async (fixture: Awaited<ReturnType<typeof writeMinimalPluginInstallStateFixture>>) => {
        await fs.writeFile(fixture.target.repoArtifactPath, `${fixture.target.repoArtifactContent}changed\n`, 'utf8');
      },
      expectedText: '动态内容和上次接受的结果不一致。',
    },
    {
      label: 'dynamic config stale',
      mutate: async (fixture: Awaited<ReturnType<typeof writeMinimalPluginInstallStateFixture>>) => {
        await updateDiagnosticCache(fixture.files.diagnosticCachePath, (cache) => {
          cache.artifacts[0]!.configDigest = 'config:stale';
        });
      },
      expectedText: '共享配置已经变化，但动态内容还没刷新。',
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
      expectedText: '最近一次动态刷新失败，需要处理。',
    },
  ])('reports %s from dynamic diagnostic cache without invoking the renderer', async ({ mutate, expectedText }) => {
    const { fixture, rendererRunner, runtime } = await createAlignedInstalledStatusFixture(`aw-status-dynamic-${Math.random().toString(16).slice(2)}-`);
    await mutate(fixture);

    const result = await statusCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot },
      runtime,
    );

    expect(rendererRunner.run).not.toHaveBeenCalled();
    expect(result.output).toContain(expectedText);
    expect(result.output).not.toContain('diagnose --deep');
  });

  it('treats decoupled dynamic diagnostic cache entries as unavailable without reporting drift', async () => {
    const { fixture, rendererRunner, runtime } = await createAlignedInstalledStatusFixture('aw-status-decoupled-cache-');
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

    const result = await statusCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot },
      runtime,
    );

    expect(rendererRunner.run).not.toHaveBeenCalled();
    expect(result.output).toContain('当前安装仍可识别，但只读模式下无法确认动态内容是否还和上次接受的一致。');
    expect(result.output).toContain('aw diagnose');
    expect(result.output).not.toContain('动态内容和上次接受的结果不一致');
    expect(result.output).not.toContain('共享配置已经变化');
    expect(result.output).not.toContain('最近一次动态刷新失败');
  });

  it('explains removed legacy dynamic tracking without reporting the old entry as current missing capability', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-status-legacy-dynamic-'),
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

    const result = await statusCommand(
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
        issues: Array<{ code: string }>;
        legacyDynamicTracking: Array<{
          id: string;
          target: string;
        }>;
      }>;
    };
    expect(rendererRunner.run).not.toHaveBeenCalled();
    expect(payload.locations[0]?.summary).toContain('历史 dynamic tracking');
    expect(payload.locations[0]?.legacyDynamicTracking).toEqual([
      expect.objectContaining({
        id: 'lightweight-instruction',
        target: 'codex.developerInstructionsBlock',
      }),
    ]);
    expect(payload.locations[0]?.issues ?? []).toEqual([]);
  });

  it('keeps default project status absolutely read-only when ignore rules are missing', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-status-readonly-project-'),
    );
    const target = builder.createTarget({
      pluginName: 'readonly-status',
      platform: 'codex',
      scope: 'project',
      projectKey: builder.paths.repoRoot,
    });
    const env = createInstallStateFixtureEnv(builder.paths);
    const gitignorePath = path.join(builder.paths.repoRoot, '.gitignore');
    const privateStateRoot = path.join(builder.paths.repoRoot, '.codex', '.agent-workflows');
    const claudePrivateStateRoot = path.join(builder.paths.repoRoot, '.claude', '.agent-workflows');
    const projectLocalConfigRoot = path.join(builder.paths.repoRoot, '.agent-workflows', 'plugin-config.local');
    const recordPath = projectRecordPath(builder.paths.repoRoot, target.recordId);
    const diagnosticCachePath = path.join(builder.paths.repoRoot, '.codex', '.agent-workflows', 'diagnostics', `${target.recordId}.json`);

    const result = await statusCommand(
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

  it('treats record plus install marker residual as needs attention instead of installed and keeps read paths unchanged', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-status-record-marker-'),
      scenario: 'recordAndInstallMarkerResidual',
    });
    await maybePrepareP2RecordFiles(fixture);
    const beforeRecord = await fs.readFile(fixture.files.installRecordPath, 'utf8');
    const beforeMarker = await fs.readFile(fixture.files.nativeMarkerPath, 'utf8');

    const human = await statusCommand(
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

    expect(human.output).toContain('状态：需要处理');
    expect(human.output).toContain('aw repair');
    expect(human.output).toContain('aw cleanup');
    expect(await fs.readFile(fixture.files.installRecordPath, 'utf8')).toBe(beforeRecord);
    expect(await fs.readFile(fixture.files.nativeMarkerPath, 'utf8')).toBe(beforeMarker);

    const jsonResult = await statusCommand(
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
        state: string;
        nextSteps: string[];
        record: { present: boolean };
        nativeState: { transactionKind: string };
        nativeTransactionMarker: {
          status: string;
          recordCommitted: boolean;
          markerPending: boolean;
          needsAttention: boolean;
        };
      }>;
    };
    expect(payload.locations[0]).toMatchObject({
      state: 'needsRepair',
      record: { present: true },
      nativeState: { transactionKind: 'recordInstallResidual' },
      nativeTransactionMarker: {
        status: 'recordInstallResidual',
        recordCommitted: true,
        markerPending: true,
        needsAttention: true,
      },
    });
    expect(payload.locations[0].nextSteps).toEqual(
      expect.arrayContaining([
        expect.stringContaining('aw repair'),
        expect.stringContaining('aw cleanup'),
      ]),
    );
  });

  it('emits prune tokens for stale dependency index references in status JSON and verbose output', async () => {
    const fixture = await writeMinimalPluginInstallStateFixture({
      rootDir: await makeTempDir('aw-status-stale-index-'),
      scenario: 'staleDependencyIndex',
    });
    await maybePrepareP2RecordFiles(fixture);

    const jsonResult = await statusCommand(
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
          coverageTrusted: boolean;
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
    expect(payload.locations[0].dependencyIndex.coverageTrusted).toBe(false);
    expect(payload.locations[0].dependencyIndex.dependencyIndexCoverageReason).toContain('staleReference');
    expect(payload.locations[0].dependencyIndex.staleProjectReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordPath: fixture.files.installRecordPath,
        }),
      ]),
    );
    expect(payload.locations[0].dependencyIndex.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'staleProjectReference',
          token: expect.any(String),
          command: expect.stringContaining('aw cleanup --dependency-index --prune-stale'),
        }),
      ]),
    );

    const verboseResult = await statusCommand(
      [fixture.target.location.plugin],
      { cwd: fixture.paths.repoRoot, verbose: true },
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
    expect(verboseResult.output).toContain('详细信息');
    expect(verboseResult.output).toContain('aw cleanup --dependency-index --prune-stale');
  });

  it('keeps dependency JSON fields stable for dependents, autoInstalled, and unusedDependencyHint', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-status-dependency-fields-'),
    );
    const unused = await writeInstalledProjectRecord({
      builder,
      pluginName: 'unused-dependency',
      installSource: { kind: 'dependency', explicitlyRequested: false },
    });
    const retained = await writeInstalledProjectRecord({
      builder,
      pluginName: 'retained-dependency',
      installSource: { kind: 'dependency', explicitlyRequested: true },
    });
    const inUse = await writeInstalledProjectRecord({
      builder,
      pluginName: 'dependency-in-use',
      installSource: { kind: 'dependency', explicitlyRequested: false },
    });
    const consumer = await writeInstalledProjectRecord({
      builder,
      pluginName: 'consumer-plugin',
      dependencyEdges: [{
        dependency: inUse.target.location,
        declaration: {
          name: inUse.target.location.plugin,
        },
      }],
    });
    await builder.writeDependencyIndex([
      { target: unused.target, record: unused.record },
      { target: retained.target, record: retained.record },
      { target: inUse.target, record: inUse.record },
      { target: consumer.target, record: consumer.record },
    ]);

    const payload = JSON.parse((await statusCommand(
      [unused.target.location.plugin, retained.target.location.plugin, inUse.target.location.plugin],
      { cwd: builder.paths.repoRoot, json: true },
      {
        env: createInstallStateFixtureEnv(builder.paths),
        p7Targets: [unused, retained, inUse].map((entry) => ({
          pluginName: entry.target.location.plugin,
          platform: entry.target.location.platform,
          scope: entry.target.location.scope,
          projectKey: entry.target.location.projectKey ?? undefined,
          executionCwd: builder.paths.repoRoot,
        })),
      } as never,
    )).output) as {
      locations: Array<{
        plugin: string;
        dependents: Array<{ plugin: string }>;
        autoInstalled: boolean;
        unusedDependencyHint: boolean;
      }>;
      consoleItems: Array<{
        pluginName: string;
        locations: Array<{
          reasonCodes: string[];
          detailHints?: string[];
          actions: Array<{ kind: string; label: string }>;
        }>;
      }>;
    };
    const locations = new Map(payload.locations.map((location) => [location.plugin, location]));
    const consoleItems = new Map(payload.consoleItems.map((item) => [item.pluginName, item]));

    expect(locations.get('unused-dependency')).toMatchObject({
      dependents: [],
      autoInstalled: true,
      unusedDependencyHint: true,
    });
    expect(locations.get('retained-dependency')).toMatchObject({
      dependents: [],
      autoInstalled: true,
      unusedDependencyHint: false,
    });
    expect(locations.get('dependency-in-use')).toMatchObject({
      autoInstalled: true,
      unusedDependencyHint: false,
    });
    expect(locations.get('dependency-in-use')?.dependents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          plugin: 'consumer-plugin',
        }),
      ]),
    );
    expect(consoleItems.get('unused-dependency')?.locations[0]?.reasonCodes).toContain('autoDependencyRemovable');
    expect(consoleItems.get('unused-dependency')?.locations[0]?.actions.find((action) => action.kind === 'runUninstall')?.label).toBe('清理自动依赖');
    expect(consoleItems.get('retained-dependency')?.locations[0]?.reasonCodes).not.toContain('autoDependencyRemovable');
    expect(consoleItems.get('retained-dependency')?.locations[0]?.actions.find((action) => action.kind === 'runUninstall')?.label).toBe('卸载');
    expect(consoleItems.get('retained-dependency')?.locations[0]?.detailHints).toEqual(
      expect.arrayContaining(['这个位置最初由依赖自动安装，但当前仍被显式保留或还有可信引用。']),
    );
  });

  it('shows recovery details for untrusted dependency index coverage and suppresses unused dependency hints', async () => {
    const builder = await createMinimalPluginInstallStateFixtureBuilder(
      await makeTempDir('aw-status-untrusted-index-'),
    );
    const target = await writeInstalledProjectRecord({
      builder,
      pluginName: 'coverage-gap',
      installSource: { kind: 'dependency', explicitlyRequested: false },
    });
    await builder.writeDependencyIndex([{ target: target.target, record: target.record }]);
    await fs.remove(path.join(builder.paths.awHome, 'dependency-index'));

    const jsonResult = await statusCommand(
      [target.target.location.plugin],
      { cwd: builder.paths.repoRoot, json: true },
      {
        env: createInstallStateFixtureEnv(builder.paths),
        p7Targets: [{
          pluginName: target.target.location.plugin,
          platform: target.target.location.platform,
          scope: target.target.location.scope,
          projectKey: target.target.location.projectKey ?? undefined,
          executionCwd: builder.paths.repoRoot,
        }],
      } as never,
    );
    const payload = JSON.parse(jsonResult.output) as {
      locations: Array<{
        dependencyIndex: {
          coverageTrusted: boolean;
          reasons: string[];
          recoverySuggestion: string | null;
          verifiedLocations: Array<{ plugin: string }>;
        };
        unusedDependencyHint: boolean;
      }>;
    };
    expect(payload.locations[0]).toMatchObject({
      dependencyIndex: {
        coverageTrusted: false,
        recoverySuggestion: 'revisitRelatedProjects',
      },
      unusedDependencyHint: false,
    });
    expect(payload.locations[0].dependencyIndex.reasons).toContain('indexMissing');
    expect(payload.locations[0].dependencyIndex.verifiedLocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ plugin: 'coverage-gap' }),
      ]),
    );

    const verboseResult = await statusCommand(
      [target.target.location.plugin],
      { cwd: builder.paths.repoRoot, verbose: true },
      {
        env: createInstallStateFixtureEnv(builder.paths),
        p7Targets: [{
          pluginName: target.target.location.plugin,
          platform: target.target.location.platform,
          scope: target.target.location.scope,
          projectKey: target.target.location.projectKey ?? undefined,
          executionCwd: builder.paths.repoRoot,
        }],
      } as never,
    );
    expect(verboseResult.output).toContain('"coverageTrusted": false');
    expect(verboseResult.output).toContain('"recoverySuggestion": "revisitRelatedProjects"');
    expect(verboseResult.output).toContain('"unusedDependencyHint": false');
  });
});
