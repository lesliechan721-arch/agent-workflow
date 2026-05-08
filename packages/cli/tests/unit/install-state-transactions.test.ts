import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRecordId } from '../../src/install-state/ids.js';
import { createProjectArtifactSharedLocator, getProjectArtifactSharedIdentityPath } from '../../src/install-state/paths.js';
import {
  createInstallRecordInstallSource,
  markInstallRecordInstallSourceExplicitlyRequested,
} from '../../src/install-state/facade.js';
import {
  createDependencyIndexRefreshPostCommitAction,
  createDiagnosticCacheDeletePostCommitAction,
  createInstallRecordDeleteStage,
  createInstallRecordWriteStage,
  createNativeTransactionMarkerDeletePostCommitAction,
  createProjectArtifactIdentityWriteStage,
  InstallStateTransactionError,
  mergeDynamicArtifactDiagnosticCache,
  runInstallStateGraphRecordTransaction,
  runInstallStateTransaction,
} from '../../src/install-state/transactions.js';
import {
  garbageCollectHistoricalLifecycleRuntimes,
  stageHistoricalLifecycleRuntime,
} from '../../src/install-state/runtime-state.js';
import type {
  DynamicArtifactDiagnosticCache,
  InstallRecordFile,
  NativeTransactionMarker,
  PluginLocation,
  ProjectArtifactIdentityFile,
} from '../../src/install-state/types.js';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

function makeLocation(overrides: Partial<PluginLocation> = {}): PluginLocation {
  const scope = overrides.scope ?? 'user';
  return {
    plugin: overrides.plugin ?? 'git-commit',
    platform: overrides.platform ?? 'codex',
    scope,
    ...(scope === 'project'
      ? { projectKey: overrides.projectKey ?? '/tmp/project' }
      : {}),
  };
}

function makeRecord(location: PluginLocation = makeLocation()): InstallRecordFile {
  return {
    version: 2,
    recordId: createRecordId(location),
    record: {
      pluginName: location.plugin,
      platform: location.platform,
      scope: location.scope,
      ...(location.scope === 'project' ? { projectKey: location.projectKey ?? undefined } : {}),
      installedAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:01.000Z',
      source: {
        pluginVersion: '1.2.3',
        manifestDigest: 'sha256:manifest',
        bundleFingerprint: 'sha256:bundle',
      },
      installSource: {
        kind: 'explicit',
        explicitlyRequested: true,
      },
      native: {
        pluginId: `${location.plugin}@aw`,
        installedByAw: true,
      },
      artifacts: [{
        kind: 'instruction',
        platform: location.platform,
        path: '/tmp/instruction.md',
        id: 'instruction-a',
        target: 'codex.developerInstructionsBlock',
        artifactKey: 'artifact-a',
      }],
      dependencyEdges: [],
    },
  };
}

function makeDiagnosticCache(record: InstallRecordFile): DynamicArtifactDiagnosticCache {
  return {
    version: 1,
    recordId: record.recordId,
    location: {
      plugin: record.record.pluginName,
      platform: record.record.platform,
      scope: record.record.scope,
      ...(record.record.scope === 'project' ? { projectKey: record.record.projectKey } : {}),
    },
    updatedAt: '2026-05-07T00:00:02.000Z',
    artifacts: [{
      id: 'instruction-a',
      target: 'codex.developerInstructionsBlock',
      state: 'present',
      artifactKey: 'artifact-a',
      configDigest: 'sha256:config-old',
      contentDigest: 'sha256:content-old',
      lastRefresh: {
        status: 'success',
        at: '2026-05-07T00:00:02.000Z',
        event: 'install',
      },
      refreshReach: {
        commandScope: 'user',
        refreshedUserTarget: true,
      },
    }],
  };
}

function makeProjectIdentity(repoRoot: string, location: PluginLocation, manifestDigest: string): ProjectArtifactIdentityFile {
  const locator = createProjectArtifactSharedLocator({
    plugin: location.plugin,
    platform: location.platform,
    repoRoot,
    projectRoot: repoRoot,
  });
  return {
    version: 1,
    sharedIdentityId: path.basename(getProjectArtifactSharedIdentityPath({ repoRoot, locator }), '.json'),
    locator,
    source: {
      pluginVersion: '1.2.3',
      manifestDigest,
      bundleFingerprint: 'sha256:bundle',
    },
    generatedAt: '2026-05-07T00:00:01.000Z',
    artifacts: [{
      kind: 'instruction',
      platform: location.platform,
      path: '.agents/skills/commit/SKILL.md',
      artifactKey: 'artifact-a',
      id: 'instruction-a',
      target: 'codex.developerInstructionsBlock',
      state: 'present',
      contentDigest: 'sha256:content-old',
    }],
  };
}

function makeNativeMarker(pluginName = 'git-commit'): NativeTransactionMarker {
  return {
    version: 1,
    pluginName,
    pluginId: `${pluginName}@aw`,
    platform: 'codex',
    scope: 'user',
    operation: 'install',
    nativeWriteSucceeded: true,
    createdAt: '2026-05-07T00:00:00.000Z',
    updatedAt: '2026-05-07T00:00:01.000Z',
  };
}

describe('install-state transactions', () => {
  it('returns a rollback warning when project identity restore fails before record commit', async () => {
    const repoRoot = await makeTempDir('aw-install-state-project-');
    const location = makeLocation({ scope: 'project', projectKey: repoRoot });
    const oldIdentity = makeProjectIdentity(repoRoot, location, 'sha256:manifest-old');
    const newIdentity = makeProjectIdentity(repoRoot, location, 'sha256:manifest-new');
    const locator = oldIdentity.locator;
    const identityPath = getProjectArtifactSharedIdentityPath({ repoRoot, locator });
    await fs.outputJson(identityPath, oldIdentity, { spaces: 2 });

    const stage = await createProjectArtifactIdentityWriteStage({
      repoRoot,
      locator,
      value: newIdentity,
    });
    const failingStage = {
      label: 'synthetic failure',
      async commit() {
        throw new Error('stop before record commit');
      },
      async rollback() {
        return undefined;
      },
      async finalize() {
        return undefined;
      },
    };

    const originalMove = fs.move.bind(fs);
    vi.spyOn(fs, 'move').mockImplementation(async (source, destination, options) => {
      if (
        typeof source === 'string' &&
        typeof destination === 'string' &&
        destination === identityPath &&
        path.basename(source).includes('.aw-backup')
      ) {
        throw new Error('restore blocked');
      }
      return originalMove(source, destination, options);
    });

    const result = await runInstallStateTransaction({
      stages: [stage, failingStage],
    }).catch((error) => error);

    expect(result).toBeInstanceOf(InstallStateTransactionError);
    expect((result as InstallStateTransactionError).warnings).toEqual([
      expect.objectContaining({
        code: 'projectIdentityRollbackFailed',
      }),
    ]);
  });

  it('keeps the committed record and marker when post-commit marker cleanup fails', async () => {
    const root = await makeTempDir('aw-install-state-marker-');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const markerPath = path.join(env.AW_HOME!, 'native-recovery', 'codex', 'user', 'git-commit@aw.json');
    const record = makeRecord();
    const recordPath = path.join(root, 'records', `${record.recordId}.json`);
    await fs.outputJson(markerPath, makeNativeMarker(), { spaces: 2 });

    const originalRemove = fs.remove.bind(fs);
    vi.spyOn(fs, 'remove').mockImplementation(async (targetPath) => {
      if (targetPath === markerPath) {
        throw new Error('marker busy');
      }
      return originalRemove(targetPath);
    });

    const result = await runInstallStateTransaction({
      stages: [await createInstallRecordWriteStage({ filePath: recordPath, value: record })],
      postCommit: [
        createNativeTransactionMarkerDeletePostCommitAction({
          pluginNameOrId: 'git-commit',
          env,
        }),
      ],
    });

    expect(result.committed).toBe(true);
    expect(result.completeSuccess).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'nativeMarkerDeleteFailed',
      }),
    ]);
    await expect(fs.pathExists(recordPath)).resolves.toBe(true);
    await expect(fs.pathExists(markerPath)).resolves.toBe(true);
  });

  it('returns a structured incomplete-success result when marker cleanup fails after record commit', async () => {
    const root = await makeTempDir('aw-install-state-graph-');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const record = makeRecord();
    const recordPath = path.join(root, 'records', `${record.recordId}.json`);
    const markerPath = path.join(env.AW_HOME!, 'native-recovery', 'codex', 'user', 'git-commit@aw.json');
    await fs.outputJson(markerPath, makeNativeMarker(), { spaces: 2 });

    const originalRemove = fs.remove.bind(fs);
    vi.spyOn(fs, 'remove').mockImplementation(async (targetPath) => {
      if (targetPath === markerPath) {
        throw new Error('marker busy');
      }
      return originalRemove(targetPath);
    });

    const result = await runInstallStateGraphRecordTransaction({
      mode: 'upsert',
      stages: [
        await createInstallRecordWriteStage({
          filePath: recordPath,
          value: record,
        }),
      ],
      recordFile: record,
      recordPath,
      env,
      postCommit: [
        createNativeTransactionMarkerDeletePostCommitAction({
          pluginNameOrId: 'git-commit',
          env,
        }),
      ],
    });

    expect(result.recordOperation).toBe('upsert');
    expect(result.recordPath).toBe(recordPath);
    expect(result.completeSuccess).toBe(false);
    expect(result.additionalPostCommit).toEqual([
      expect.objectContaining({
        label: 'native transaction marker delete',
        status: 'warning',
      }),
    ]);
    expect(result.dependencyIndex).toMatchObject({
      label: 'dependency index refresh',
      status: 'ok',
    });
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'nativeMarkerDeleteFailed',
      }),
    ]);
    await expect(fs.pathExists(recordPath)).resolves.toBe(true);
    await expect(fs.pathExists(markerPath)).resolves.toBe(true);
  });

  it('deletes the record but only warns when diagnostic cache cleanup fails', async () => {
    const root = await makeTempDir('aw-install-state-delete-');
    const record = makeRecord();
    const recordPath = path.join(root, 'records', `${record.recordId}.json`);
    const cachePath = path.join(root, 'diagnostics', `${record.recordId}.json`);
    await fs.outputJson(recordPath, record, { spaces: 2 });
    await fs.outputJson(cachePath, makeDiagnosticCache(record), { spaces: 2 });

    const originalRemove = fs.remove.bind(fs);
    vi.spyOn(fs, 'remove').mockImplementation(async (targetPath) => {
      if (targetPath === cachePath) {
        throw new Error('cache busy');
      }
      return originalRemove(targetPath);
    });

    const result = await runInstallStateTransaction({
      stages: [createInstallRecordDeleteStage({ filePath: recordPath })],
      postCommit: [
        createDiagnosticCacheDeletePostCommitAction({ filePath: cachePath }),
      ],
    });

    expect(result.completeSuccess).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'diagnosticCacheDeleteFailed',
      }),
    ]);
    await expect(fs.pathExists(recordPath)).resolves.toBe(false);
    await expect(fs.pathExists(cachePath)).resolves.toBe(true);
  });

  it('preserves the accepted diagnostic state when refresh fails', async () => {
    const record = makeRecord();
    const current = makeDiagnosticCache(record);
    const next: DynamicArtifactDiagnosticCache = {
      ...current,
      updatedAt: '2026-05-07T00:00:03.000Z',
      artifacts: [{
        ...current.artifacts[0]!,
        state: 'disabled',
        disabledReason: 'renderer failed',
        configDigest: 'sha256:config-new',
        contentDigest: 'sha256:content-new',
        lastRefresh: {
          status: 'failed',
          at: '2026-05-07T00:00:03.000Z',
          event: 'config',
          error: 'boom',
        },
        refreshReach: {
          commandScope: 'user',
          refreshedUserTarget: true,
        },
      }],
    };

    const merged = mergeDynamicArtifactDiagnosticCache({
      mode: 'refreshFailed',
      current,
      next,
    });

    expect(merged.artifacts[0]).toMatchObject({
      state: 'present',
      configDigest: 'sha256:config-old',
      contentDigest: 'sha256:content-old',
      lastRefresh: {
        status: 'failed',
        event: 'config',
      },
    });
  });

  it('does not roll back an already written record when dependency index refresh fails', async () => {
    const root = await makeTempDir('aw-install-state-index-');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const indexPath = path.join(env.AW_HOME!, 'dependency-index', 'index.json');
    const record = makeRecord();
    const recordPath = path.join(root, 'records', `${record.recordId}.json`);
    await fs.outputFile(indexPath, '{broken', 'utf8');

    const result = await runInstallStateTransaction({
      stages: [await createInstallRecordWriteStage({ filePath: recordPath, value: record })],
      postCommit: [
        createDependencyIndexRefreshPostCommitAction({
          mode: 'upsert',
          recordFile: record,
          recordPath,
          env,
        }),
      ],
    });

    expect(result.completeSuccess).toBe(false);
    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'dependencyIndexRefreshFailed',
      }),
    ]);
    await expect(fs.pathExists(recordPath)).resolves.toBe(true);
    await expect(fs.readFile(indexPath, 'utf8')).resolves.toBe('{broken');
  });

  it('keeps dependency kind when an auto-installed record is later marked explicit', () => {
    const dependencyInstallSource = createInstallRecordInstallSource('dependency');
    expect(dependencyInstallSource).toEqual({
      kind: 'dependency',
      explicitlyRequested: false,
    });
    expect(createInstallRecordInstallSource('explicit')).toEqual({
      kind: 'explicit',
      explicitlyRequested: true,
    });
    expect(
      markInstallRecordInstallSourceExplicitlyRequested(dependencyInstallSource),
    ).toEqual({
      kind: 'dependency',
      explicitlyRequested: true,
    });
  });

  it('rolls back only the current runtimeId and leaves sibling lifecycle runtimes intact', async () => {
    const root = await makeTempDir('aw-install-state-runtime-');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const bundleRoot = path.join(root, 'bundle-source');
    await fs.outputJson(path.join(bundleRoot, 'plugin.json'), {
      name: 'git-commit',
      version: '1.2.3',
    }, { spaces: 2 });

    const location = makeLocation();
    const first = await stageHistoricalLifecycleRuntime({
      cwd: root,
      location,
      sourceBundleRoot: bundleRoot,
      pluginVersion: '1.2.3',
      manifestDigest: 'sha256:manifest',
      bundleFingerprint: 'sha256:bundle',
      events: ['install', 'upgrade', 'uninstall'],
      env,
    });
    await first.commit();
    await first.finalize();

    const second = await stageHistoricalLifecycleRuntime({
      cwd: root,
      location,
      sourceBundleRoot: bundleRoot,
      pluginVersion: '1.2.3',
      manifestDigest: 'sha256:manifest',
      bundleFingerprint: 'sha256:bundle',
      events: ['install', 'upgrade', 'uninstall'],
      env,
    });
    await second.commit();
    await second.rollback();
    await second.finalize();

    expect(first.runtimePaths.runtimeId).not.toBe(second.runtimePaths.runtimeId);
    await expect(fs.pathExists(first.runtimeRef.runtimeRoot)).resolves.toBe(true);
    await expect(fs.pathExists(second.runtimeRef.runtimeRoot)).resolves.toBe(false);
  });

  it('fails closed and retains lifecycle runtimes when GC coverage is not trusted', async () => {
    const root = await makeTempDir('aw-install-state-gc-');
    const env = { AW_HOME: path.join(root, 'aw-home') } as NodeJS.ProcessEnv;
    const bundleRoot = path.join(root, 'bundle-source');
    await fs.outputJson(path.join(bundleRoot, 'plugin.json'), {
      name: 'git-commit',
      version: '1.2.3',
    }, { spaces: 2 });

    const runtime = await stageHistoricalLifecycleRuntime({
      cwd: root,
      location: makeLocation(),
      sourceBundleRoot: bundleRoot,
      pluginVersion: '1.2.3',
      manifestDigest: 'sha256:manifest',
      bundleFingerprint: 'sha256:bundle',
      events: ['install', 'upgrade', 'uninstall'],
      env,
    });
    await runtime.commit();
    await runtime.finalize();

    const result = await garbageCollectHistoricalLifecycleRuntimes({
      env,
      coverage: {
        trusted: false,
        verifiedRecordPaths: [],
        reason: 'dependency index coverage is incomplete',
      },
    });

    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('dependency index coverage is incomplete');
    await expect(fs.pathExists(runtime.runtimeRef.runtimeRoot)).resolves.toBe(true);
  });
});
