import path from 'node:path';
import fs from 'fs-extra';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StatusV7Payload } from '../../src/commands/status-v6.js';
import type { ReconcileOperationPlan } from '../../src/commands/reconcile-operation-plan.js';
import type { RebuildCommandResult } from '../../src/commands/rebuild-command.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import {
  configAffectedStatusTargets,
  createTuiControllerDependencies,
  statusTargetFingerprint,
} from '../../src/tui/controller-runtime.js';
import {
  TuiConfigInvalidStoreError,
  TuiController,
  type OperationEvidence,
} from '../../src/tui/controller.js';
import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import {
  createCatalogSnapshotFixture,
  createDependencyCatalogSnapshotFixture,
} from '../helpers/catalog-source-fixture.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig as replaceCatalogSourcesConfigWithoutActive,
} from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogSnapshotLogicalIdentity } from '../../src/utils/catalog-generation-store.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import {
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import {
  createEmptyPluginIntentState,
  upsertPluginIntentRoot,
  writePluginIntentState,
} from '../../src/utils/plugin-intent-state.js';

const OFFLINE_SOURCE_IDENTITY = `sha256:${'1'.repeat(64)}`;

async function replaceCatalogSourcesConfig(
  options: Parameters<typeof replaceCatalogSourcesConfigWithoutActive>[0],
) {
  const result = await replaceCatalogSourcesConfigWithoutActive(options);
  for (const source of options.config.sources) {
    await syncCatalogSourceGeneration({
      sourceId: source.id, cliVersion: '1.0.0', env: options.env,
    });
  }
  return result;
}

const runtimeMocks = vi.hoisted(() => ({
  statusCommandV7: vi.fn(),
  cleanupWriteCommand: vi.fn(),
  installWriteCommand: vi.fn(),
  reinstallWriteCommand: vi.fn(),
  uninstallWriteCommand: vi.fn(),
  preflightCatalogSourceMutation: vi.fn(),
  setPrimaryCatalogSourceCommand: vi.fn(),
  probeCatalogSourceGeneration: vi.fn(),
  activateCatalogSourceGeneration: vi.fn(),
  preparePortableInstall: vi.fn(),
  applyPluginConfigWrite: vi.fn(),
  replayConfigRuntimeWrites: vi.fn(),
  resetPluginConfigWithHelper: vi.fn(),
}));

vi.mock('../../src/commands/status-v6.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/status-v6.js')>(),
  statusCommandV7: runtimeMocks.statusCommandV7,
}));

vi.mock('../../src/commands/write-commands.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/write-commands.js')>(),
  cleanupWriteCommand: runtimeMocks.cleanupWriteCommand,
  installWriteCommand: runtimeMocks.installWriteCommand,
  syncWriteCommand: runtimeMocks.installWriteCommand,
  reinstallWriteCommand: runtimeMocks.reinstallWriteCommand,
  uninstallWriteCommand: runtimeMocks.uninstallWriteCommand,
}));

vi.mock('../../src/commands/catalog-source.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/catalog-source.js')>(),
  preflightCatalogSourceMutation: runtimeMocks.preflightCatalogSourceMutation,
  setPrimaryCatalogSourceCommand: runtimeMocks.setPrimaryCatalogSourceCommand,
}));

vi.mock('../../src/portable/commands.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/portable/commands.js')>(),
  preparePortableInstall: runtimeMocks.preparePortableInstall,
}));

vi.mock('../../src/utils/catalog-generation-service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/catalog-generation-service.js')>(),
  probeCatalogSourceGeneration: runtimeMocks.probeCatalogSourceGeneration,
  activateCatalogSourceGeneration: runtimeMocks.activateCatalogSourceGeneration,
}));

vi.mock('../../src/utils/plugin-config-write.js', () => ({
  applyPluginConfigWrite: runtimeMocks.applyPluginConfigWrite,
  replayConfigRuntimeWrites: runtimeMocks.replayConfigRuntimeWrites,
  resetPluginConfigWithHelper: runtimeMocks.resetPluginConfigWithHelper,
}));

function target(
  scope: 'user' | 'project',
  state: 'absent' | 'present' | 'partial' | 'error',
): StatusV7Payload['targets'][number] {
  const enabled = state === 'present' || state === 'partial';
  const targetState = state === 'present'
    ? 'ready' as const
    : state === 'partial'
      ? 'needsSync' as const
      : state === 'error' ? 'blocked' as const : 'absent' as const;
  return {
    pluginName: 'demo',
    pluginId: 'official/demo',
    sourceId: 'official',
    sourceIdentity: OFFLINE_SOURCE_IDENTITY,
    version: '1.0.0',
    platform: 'codex',
    scope,
    cwd: '/workspace',
    state: targetState,
    components: [
      {
        kind: 'intent', key: 'desired', state: enabled ? 'desired' : 'absent',
        metadata: { enabled, scopes: enabled ? [scope] : [], relation: enabled ? 'managed' : 'none' },
      },
      { kind: 'ownership', key: 'fixture', state },
      {
        kind: 'activation', key: scope, state: enabled ? 'enabled' : 'disabled',
        metadata: { evidence: 'assumed' },
      },
    ],
    reasons: state === 'error'
      ? [{ code: 'targetError', message: 'safe failure', severity: 'blocking' }]
      : [],
    recoveryActions: [],
  };
}

function bundleUnavailableStatus(
  configDigest = 'sha256:config',
): Awaited<ReturnType<typeof runtimeMocks.statusCommandV7>> {
  const orphan = target('user', 'error');
  orphan.reasons = [{ code: 'bundleUnavailable', message: 'safe failure', severity: 'blocking' }];
  return {
    payload: {
      schemaVersion: 7,
      catalog: {
        primarySourceId: 'official',
        configDigest,
        compositeDigest: 'sha256:composite',
        sources: [{
          id: 'official',
          identity: 'identity:official',
          type: 'path',
          primary: true,
          requestedRef: 'path',
          freshness: 'active',
        }],
      },
      filters: { plugins: ['official/demo'], platform: 'codex', cwd: '/workspace' },
      targets: [orphan],
      errors: [],
    },
    pluginSummaries: [],
  };
}

describe('TUI config affected targets', () => {
  it('reviews every field in a combined source update and the bound script timeout', () => {
    const sourceMutation = {
      action: 'update' as const,
      update: {
        url: 'https://example.test/catalog.git',
        refPolicy: { type: 'explicit' as const, ref: 'catalog/beta' },
        subdir: null,
        autoCheck: false,
      },
    };
    const evidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:after' },
      catalogGeneration: {
        action: 'activate',
        candidate: {
          sourceConfigFingerprint: 'sha256:source-config',
          sourceIdentity: 'sha256:source',
          logicalIdentity: 'workspace',
          requestedRef: 'catalog/beta',
          resolvedCommit: 'a'.repeat(40),
          catalogVersion: '1.0.0',
          channel: 'beta',
          manifestDigest: 'sha256:manifest',
          snapshotDigest: 'sha256:snapshot',
        },
        configDigest: 'sha256:before',
        proposedConfigDigest: 'sha256:after',
        sourceMutation,
      },
    };
    const sourceReview = buildOperationReviewProjection({
      intent: { kind: 'catalogGeneration', action: 'activate', sourceId: 'team', sourceMutation },
      evidence,
    });
    expect(sourceReview.changes.map((change) => [change.title, change.description])).toEqual(
      expect.arrayContaining([
        ['Git URL', '将更新'],
        ['Git ref policy', '固定 ref · catalog/beta'],
        ['插件目录子目录', '根目录'],
        ['自动检查', '关闭'],
      ]),
    );
    const addReview = buildOperationReviewProjection({
      intent: {
        kind: 'catalogGeneration', action: 'activate', sourceId: 'local',
        sourceMutation: {
          action: 'add',
          source: {
            id: 'local', type: 'path', path: '/private/catalog', primary: false, autoCheck: false,
          },
        },
      },
      evidence: {
        ...evidence,
        catalogGeneration: {
          ...evidence.catalogGeneration!,
          sourceMutation: {
            action: 'add',
            source: {
              id: 'local', type: 'path', path: '/private/catalog', primary: false, autoCheck: false,
            },
          },
        },
      },
    });
    expect(addReview.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '保存来源配置' }),
      expect.objectContaining({ title: '本地目录', description: '已设置' }),
      expect.objectContaining({ title: '自动检查', description: '关闭' }),
    ]));
    expect(JSON.stringify(addReview)).not.toContain('/private/catalog');

    const timeoutReview = buildOperationReviewProjection({
      intent: {
        kind: 'pluginWrite', action: 'sync', pluginId: 'team/demo',
        platform: 'codex', scope: 'project', scriptTimeoutMs: 12_000,
      },
      evidence: { catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:catalog' } },
    });
    expect(timeoutReview.changes).toContainEqual(expect.objectContaining({
      title: 'preApply 脚本超时', description: '12000 ms',
    }));
    expect(timeoutReview.equivalentCommand).toContain('--script-timeout 12000');
  });

  it('expands user scope conflicts and keeps project layers project-only', () => {
    const targets = [
      target('user', 'present'),
      target('project', 'partial'),
      { ...target('user', 'present'), platform: 'claude' as const },
      { ...target('project', 'error'), platform: 'claude' as const },
    ];

    expect(configAffectedStatusTargets(targets, 'official/demo', 'user')
      .map(({ platform, scope }) => `${platform}:${scope}`)).toEqual([
      'claude:user', 'codex:project', 'codex:user',
    ]);
    expect(configAffectedStatusTargets(targets, 'official/demo', 'project')
      .map(({ platform, scope }) => `${platform}:${scope}`)).toEqual(['codex:project']);
  });

  it('includes desired missing targets and excludes orphaned actual targets', () => {
    const desiredMissing = target('user', 'absent');
    desiredMissing.components.find((component) => component.kind === 'intent')!.metadata = {
      enabled: true, scopes: ['user'], relation: 'root',
    };
    const orphanedActual = target('project', 'present');
    orphanedActual.components.find((component) => component.kind === 'intent')!.metadata = {
      enabled: false, scopes: [], relation: 'none',
    };

    expect(configAffectedStatusTargets(
      [desiredMissing, orphanedActual], 'official/demo', 'user',
    ).map(({ platform, scope }) => `${platform}:${scope}`)).toEqual(['codex:user']);
    expect(configAffectedStatusTargets(
      [desiredMissing, orphanedActual], 'official/demo', 'project',
    )).toEqual([]);
  });

  it('expands a collapsed pure-native target into each desired scope', () => {
    const collapsed = target('user', 'present');
    collapsed.components.find((component) => component.kind === 'intent')!.metadata = {
      enabled: true, scopes: ['project', 'user'], relation: 'root',
    };

    expect(configAffectedStatusTargets([collapsed], 'official/demo', 'user')
      .map(({ platform, scope }) => `${platform}:${scope}`)).toEqual([
      'codex:project', 'codex:user',
    ]);
    expect(configAffectedStatusTargets([collapsed], 'official/demo', 'project')
      .map(({ platform, scope }) => `${platform}:${scope}`)).toEqual(['codex:project']);
  });
});

describe('TUI batch write runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('previews same-source selected roots in one typed command call', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'batch-shared-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'first' },
      { name: 'second' },
    ]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    runtimeMocks.installWriteCommand.mockResolvedValue({
      platforms: ['codex'], plugins: ['first', 'second'], warnings: [], rebuildResults: [],
      targetResults: [], overallState: 'succeeded', receiptTargets: [],
      operationPlan: createOperationPlan({
        intentChanges: [], actions: [], changes: ['two roots'], warnings: [],
        evidence: {
          catalogDigests: [{ sourceId: 'team', digest: 'sha256:team' }],
          intentDigests: [], configDigests: [], targetOwnerFingerprints: [],
        },
      }),
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
    }));

    await dependencies.captureEvidence({
      kind: 'pluginWriteBatch', action: 'install',
      selection: { kind: 'selected', pluginIds: ['team/first', 'team/second'] },
      platform: 'both', scope: 'user', scriptTimeoutMs: 33_000,
    }, new AbortController().signal);

    expect(runtimeMocks.installWriteCommand).toHaveBeenCalledOnce();
    expect(runtimeMocks.installWriteCommand).toHaveBeenCalledWith(
      ['team/first', 'team/second'],
      expect.objectContaining({ platform: 'both', scope: 'user', scriptTimeoutMs: 33_000 }),
      expect.objectContaining({ previewOperationPlan: true }),
    );
  });

  it('freezes project intent roots, isolates sources, and skips an unreviewable group', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'batch-first-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'batch-second-source');
    await Promise.all([
      createCatalogSnapshotFixture(firstRoot, 'alpha', [], 'alpha\n'),
      createCatalogSnapshotFixture(secondRoot, 'beta', [], 'beta\n'),
    ]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'first', type: 'path', primary: true, path: firstRoot },
          { id: 'second', type: 'path', primary: false, path: secondRoot },
        ],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    let intentState = upsertPluginIntentRoot(createEmptyPluginIntentState(), {
      pluginId: 'first/alpha', platforms: ['codex'],
    });
    intentState = upsertPluginIntentRoot(intentState, {
      pluginId: 'second/beta', platforms: ['codex'],
    });
    await writePluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, intentState);
    let secondSourceRecovered = false;
    runtimeMocks.installWriteCommand.mockImplementation(async (pluginIds, options) => {
      const pluginId = pluginIds[0]!;
      const sourceId = pluginId.split('/')[0]!;
      const target = {
        pluginName: pluginId.split('/')[1]!, pluginId, sourceId,
        platform: options.platform === 'both' ? 'codex' as const : options.platform,
        scope: options.scope,
      };
      const failed = sourceId === 'second' && !secondSourceRecovered;
      return {
        platforms: [target.platform],
        plugins: failed ? [] : pluginIds,
        warnings: [], rebuildResults: [],
        targetResults: [{
          target, action: 'sync', state: failed ? 'failed' as const : 'completed' as const,
          ...(failed ? { errorCode: 'catalogSourceUnavailable' } : {}),
        }],
        overallState: failed ? 'failed' as const : 'succeeded' as const,
        receiptTargets: [target],
        ...(!failed ? {
          operationPlan: createOperationPlan({
            intentChanges: [], actions: [], changes: [pluginId], warnings: [],
            evidence: {
              catalogDigests: [{ sourceId, digest: `sha256:${sourceId}` }],
              intentDigests: [], configDigests: [], targetOwnerFingerprints: [],
            },
          }),
        } : {}),
      };
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWriteBatch' as const,
      action: 'sync' as const,
      selection: { kind: 'currentProjectIntentRoots' as const },
      platform: 'codex' as const,
      scope: 'project' as const,
      scriptTimeoutMs: 41_000,
    };

    const evidence = await dependencies.captureEvidence(intent, new AbortController().signal);
    expect(evidence).toMatchObject({
      requestedPluginIds: ['first/alpha', 'second/beta'],
      groups: [
        expect.objectContaining({
          sourceId: 'first', requestedPluginIds: ['first/alpha'], executable: true,
        }),
        expect.objectContaining({
          sourceId: 'second', requestedPluginIds: ['second/beta'], executable: false,
        }),
      ],
    });

    secondSourceRecovered = true;
    intentState = upsertPluginIntentRoot(intentState, {
      pluginId: 'first/later', platforms: ['codex'],
    });
    await writePluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, intentState);

    const result = await dependencies.executeIntent(intent, evidence) as {
      overallState: string;
      requestedPluginIds: string[];
      targetResults: Array<{ target: { pluginId: string }; state: string }>;
      groupResults: Array<{ sourceId: string; result: { overallState: string } }>;
    };
    expect(result).toMatchObject({
      overallState: 'partial',
      requestedPluginIds: ['first/alpha', 'second/beta'],
      groupResults: [
        { sourceId: 'first', result: { overallState: 'succeeded' } },
        { sourceId: 'second', result: { overallState: 'failed' } },
      ],
    });
    expect(result.targetResults).toEqual([
      expect.objectContaining({ target: expect.objectContaining({ pluginId: 'first/alpha' }), state: 'completed' }),
      expect.objectContaining({ target: expect.objectContaining({ pluginId: 'second/beta' }), state: 'failed' }),
    ]);
    expect(runtimeMocks.installWriteCommand.mock.calls).toHaveLength(4);
    expect(runtimeMocks.installWriteCommand.mock.calls.filter((call) =>
      call[0][0] === 'first/alpha')).toHaveLength(3);
    expect(runtimeMocks.installWriteCommand.mock.calls.filter((call) =>
      call[0][0] === 'second/beta')).toHaveLength(1);
    expect(runtimeMocks.installWriteCommand.mock.calls.filter((call) =>
      call[0][0] === 'second/beta').every((call) => call[2]?.previewOperationPlan === true)).toBe(true);
    expect(runtimeMocks.installWriteCommand.mock.calls.every((call) =>
      call[1].scriptTimeoutMs === 41_000)).toBe(true);
    expect(runtimeMocks.installWriteCommand.mock.calls.at(-1)?.[2]).toEqual(expect.objectContaining({
      expectedPlanFingerprint: expect.any(String),
      awHomeMutationToken: expect.any(Object),
    }));
  });

  it('returns partial facts when a later group becomes stale after an earlier write', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'batch-stale-first');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'batch-stale-second');
    await Promise.all([
      createCatalogSnapshotFixture(firstRoot, 'alpha', [], 'alpha\n'),
      createCatalogSnapshotFixture(secondRoot, 'beta', [], 'beta\n'),
    ]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'first', type: 'path', primary: true, path: firstRoot },
          { id: 'second', type: 'path', primary: false, path: secondRoot },
        ],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    let firstExecuted = false;
    let firstExecutionFails = false;
    runtimeMocks.installWriteCommand.mockImplementation(async (pluginIds, options, runtime) => {
      const pluginId = pluginIds[0]!;
      const [sourceId, pluginName] = pluginId.split('/') as [string, string];
      if (sourceId === 'first' && runtime?.previewOperationPlan !== true) firstExecuted = true;
      const target = { pluginName, pluginId, sourceId, platform: 'codex' as const, scope: options.scope };
      const preApplyFailed = sourceId === 'first'
        && firstExecutionFails
        && runtime?.previewOperationPlan !== true;
      const operationPlanStale = sourceId === 'second'
        && firstExecutionFails
        && runtime?.previewOperationPlan !== true;
      return {
        platforms: ['codex'], plugins: preApplyFailed || operationPlanStale ? [] : pluginIds,
        warnings: [],
        rebuildResults: preApplyFailed ? [{
          status: 'failed' as const,
          command: 'install' as const,
          target: {
            ...target,
            sourceIdentity: 'sha256:first',
            pluginVersion: '1.0.0',
            cwd: options.cwd,
          },
          actions: [{ name: 'preApply', status: 'failed' as const }],
          cleanupAttempted: false,
          removed: [], absent: [], residual: [], quarantined: [],
          failures: [{ phase: 'preApply' as const, message: 'preApply failed after launch' }],
          error: { phase: 'preApply' as const, message: 'preApply failed after launch' },
        }] : [],
        targetResults: [{
          target,
          action: 'install',
          state: preApplyFailed || operationPlanStale ? 'failed' as const : 'completed' as const,
          ...(preApplyFailed
            ? { errorCode: 'preApplyFailed', message: 'preApply failed after launch' }
            : operationPlanStale
              ? { errorCode: 'operationPlanStale', message: 'locked plan changed' }
              : {}),
        }],
        overallState: preApplyFailed || operationPlanStale ? 'failed' as const : 'succeeded' as const,
        receiptTargets: [target],
        operationPlan: createOperationPlan({
          intentChanges: [], actions: [], changes: [`${pluginId}:codex:${options.scope}:install`],
          warnings: [],
          evidence: {
            catalogDigests: [{ sourceId, digest: `sha256:${sourceId}` }],
            intentDigests: [], configDigests: [],
            targetOwnerFingerprints: [{
              pluginId, platform: 'codex', scope: options.scope,
              fingerprint: sourceId === 'second' && firstExecuted
                ? 'sha256:external-change'
                : 'sha256:absent',
            }],
          },
        }),
      };
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
    }));
    const intent = {
      kind: 'pluginWriteBatch' as const, action: 'install' as const,
      selection: { kind: 'selected' as const, pluginIds: ['first/alpha', 'second/beta'] },
      platform: 'codex' as const, scope: 'project' as const,
    };
    const evidence = await dependencies.captureEvidence(intent, new AbortController().signal);

    const result = await dependencies.executeIntent(intent, evidence) as {
      overallState: string;
      groupResults: Array<{ sourceId: string; result: RebuildCommandResult }>;
    };

    expect(result.overallState).toBe('partial');
    expect(result.groupResults).toMatchObject([
      { sourceId: 'first', result: { overallState: 'succeeded' } },
      {
        sourceId: 'second',
        result: {
          overallState: 'failed',
          targetResults: [expect.objectContaining({ errorCode: 'operationReviewStale' })],
        },
      },
    ]);
    expect(runtimeMocks.installWriteCommand.mock.calls.filter((call) =>
      call[0][0] === 'second/beta').every((call) => call[2]?.previewOperationPlan === true)).toBe(true);

    firstExecuted = false;
    firstExecutionFails = true;
    runtimeMocks.installWriteCommand.mockClear();
    const failedEvidence = await dependencies.captureEvidence(intent, new AbortController().signal);
    const failedResult = await dependencies.executeIntent(intent, failedEvidence) as {
      overallState: string;
      rebuildResults: RebuildCommandResult['rebuildResults'];
      groupResults: Array<{ sourceId: string; result: RebuildCommandResult }>;
    };
    expect(failedResult.overallState).toBe('failed');
    expect(failedResult.groupResults).toMatchObject([
      {
        sourceId: 'first',
        result: {
          overallState: 'failed',
          targetResults: [expect.objectContaining({ errorCode: 'preApplyFailed' })],
        },
      },
      {
        sourceId: 'second',
        result: {
          overallState: 'failed',
          targetResults: [expect.objectContaining({ errorCode: 'operationReviewStale' })],
        },
      },
    ]);
    expect(failedResult.rebuildResults).toEqual([
      expect.objectContaining({
        status: 'failed',
        actions: [expect.objectContaining({ name: 'preApply', status: 'failed' })],
      }),
      expect.objectContaining({ status: 'failed' }),
    ]);
  });
});

describe('TUI controller runtime scope conflict validation', () => {
  it('loads recognizable saved settings without a current Catalog plugin', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePluginConfigStore({
      sourceId: 'removed',
      sourceIdentity: 'identity:removed',
      logicalIdentity: 'workspace:removed',
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { enabled: true },
    });
    const brokenPath = resolvePluginConfigStorePath({
      sourceId: 'removed', pluginName: 'broken', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await fs.ensureDir(path.dirname(brokenPath));
    await fs.writeFile(brokenPath, '{broken');
    const catalogConfig = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        schemaVersion: 7,
        catalog: {
          primarySourceId: 'official', configDigest: catalogConfig.digest,
          compositeDigest: 'sha256:composite', sources: [],
        },
        filters: { plugins: [], platform: 'both', cwd: isolation.layout.fixtureCwd },
        targets: [], errors: [],
      },
      pluginSummaries: [], targetRevisions: [],
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
    }));

    await expect(dependencies.loadStatus(new AbortController().signal)).resolves.toMatchObject({
      configuredSources: [expect.objectContaining({ id: 'official', type: 'git' })],
      configStoreInventory: [
        { pluginId: 'removed/broken', sourceId: 'removed', pluginName: 'broken', scope: 'user' },
        { pluginId: 'removed/demo', sourceId: 'removed', pluginName: 'demo', scope: 'user' },
      ],
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['present', 'error'],
    ['error', 'present'],
  ] as const)('does not duplicate forged %s + %s scope-origin legality before core planning', async (userState, projectState) => {
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: { targets: [target('user', userState), target('project', projectState)] },
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    const presentScope = userState === 'present' ? 'user' : 'project';

    await expect(dependencies.validateIntent!({
      kind: 'pluginWrite',
      action: 'uninstall',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: presentScope,
      originIssue: {
        issueId: 'scope:official/demo:codex',
        issueKey: 'forged',
        category: 'scopeConflict',
        actionId: presentScope === 'user' ? 'keepProjectScope' : 'keepUserScope',
      },
    }, new AbortController().signal)).resolves.toBeUndefined();

    expect(runtimeMocks.cleanupWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.installWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.reinstallWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.uninstallWriteCommand).not.toHaveBeenCalled();
  });

  it.each(['partial', 'present'] as const)('keeps present + %s scope conflict validation valid', async (projectState) => {
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: { targets: [target('user', 'present'), target('project', projectState)] },
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));

    await expect(dependencies.validateIntent!({
      kind: 'pluginWrite',
      action: 'uninstall',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: 'project',
      originIssue: {
        issueId: 'scope:official/demo:codex',
        issueKey: 'scope-evidence',
        category: 'scopeConflict',
        actionId: 'keepUserScope',
      },
    }, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('leaves sync target-state legality to core planning', async () => {
    const selected = target('project', 'present');
    selected.state = 'needsSync';
    runtimeMocks.statusCommandV7.mockResolvedValue({ payload: { targets: [selected] } });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'sync' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'project' as const,
    };

    await expect(dependencies.validateIntent!(intent, new AbortController().signal))
      .resolves.toBeUndefined();
    selected.state = 'ready';
    await expect(dependencies.validateIntent!(intent, new AbortController().signal))
      .resolves.toBeUndefined();
    selected.platform = 'claude';
    selected.state = 'needsSync';
    await expect(dependencies.validateIntent!({ ...intent, platform: 'claude' }, new AbortController().signal))
      .resolves.toBeUndefined();
  });

  it('leaves cross-scope native and extension legality to core planning', async () => {
    const selected = target('project', 'present');
    selected.components = [
      {
        kind: 'intent', key: 'desired', state: 'desired',
        metadata: { enabled: true, scopes: ['user'], relation: 'root' },
      },
      { kind: 'ownership', key: 'fixture', state: 'present' },
      {
        kind: 'activation', key: 'user', state: 'enabled',
        metadata: { effective: true, evidence: 'observed' },
      },
      {
        kind: 'activation', key: 'project', state: 'disabled',
        metadata: { effective: true, evidence: 'observed' },
      },
      { kind: 'sharedNative', key: 'demo@aw-official', state: 'usable', metadata: { shared: true } },
    ];
    runtimeMocks.statusCommandV7.mockResolvedValue({ payload: { targets: [selected] } });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'install' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'project' as const,
    };

    await expect(dependencies.validateIntent!(intent, new AbortController().signal))
      .resolves.toBeUndefined();

    selected.components = selected.components.filter((component) => component.kind !== 'sharedNative');
    await expect(dependencies.validateIntent!(intent, new AbortController().signal))
      .resolves.toBeUndefined();

    selected.components.push(
      { kind: 'sharedNative', key: 'demo@aw-official', state: 'usable', metadata: { shared: true } },
      { kind: 'extension', key: 'aw', state: 'conflict', metadata: { kinds: ['instruction'] } },
    );
    await expect(dependencies.validateIntent!(intent, new AbortController().signal))
      .resolves.toBeUndefined();
  });

  it('includes the private revision sidecar in the target review fingerprint', () => {
    const targets = [target('user', 'present')];
    const current = [{
      pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
      revision: { state: 'current' as const, availableVersion: '1.0.0', installedVersion: '1.0.0' },
    }];
    const upgradeAvailable = [{
      pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
      revision: { state: 'upgradeAvailable' as const, availableVersion: '2.0.0', installedVersion: '1.0.0' },
    }];

    expect(statusTargetFingerprint(targets, current))
      .not.toBe(statusTargetFingerprint(targets, upgradeAvailable));
  });

  it.each([
    ['current', 'present'],
    ['unknown', 'present'],
    ['upgradeAvailable', 'partial'],
  ] as const)('leaves refresh-and-sync legality for revision %s and placement %s to core planning', async (revisionState, placementState) => {
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: { targets: [target('user', placementState)] },
      targetRevisions: [{
        pluginId: 'official/demo', platform: 'codex', scope: 'user',
        revision: revisionState === 'unknown'
          ? { state: 'unknown', availableVersion: '1.0.0' }
          : {
              state: revisionState,
              availableVersion: revisionState === 'current' ? '1.0.0' : '2.0.0',
              installedVersion: '1.0.0',
            },
      }],
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));

    await expect(dependencies.validateIntent!({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    }, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('accepts refresh-and-sync only for a present placement with upgradeAvailable evidence', async () => {
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: { targets: [target('user', 'present')] },
      targetRevisions: [{
        pluginId: 'official/demo', platform: 'codex', scope: 'user',
        revision: { state: 'upgradeAvailable', availableVersion: '2.0.0', installedVersion: '1.0.0' },
      }],
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));

    await expect(dependencies.validateIntent!({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    }, new AbortController().signal)).resolves.toBeUndefined();
  });

  it('prepares config review from loaded session evidence without another status or remote stage', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-review-config-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        schemaVersion: 7,
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
          primarySourceId: 'team',
          sources: [],
        },
        targets: [
          { ...target('user', 'present'), pluginId: 'team/demo', sourceId: 'team' },
          { ...target('project', 'partial'), pluginId: 'team/demo', sourceId: 'team' },
        ],
        errors: [],
      },
      pluginSummaries: [{
        pluginId: 'team/demo',
        pluginName: 'demo',
        sourceId: 'team',
        sourceIdentity: 'ignored-by-test',
        dependencyDirectCount: 0,
        dependencyTotalCount: 0,
      }],
      targetRevisions: [
        { pluginId: 'team/demo', platform: 'codex', scope: 'user', revision: { state: 'current', availableVersion: '1.0.0' } },
        { pluginId: 'team/demo', platform: 'codex', scope: 'project', revision: { state: 'current', availableVersion: '1.0.0' } },
      ],
    });
    let reviewLogCount = 0;
    const debugLog = vi.fn((event: { type: string }) => {
      if (!event.type.startsWith('review.prepare.')) return undefined;
      reviewLogCount += 1;
      if (reviewLogCount === 1) throw new Error('log unavailable');
      return Promise.reject(new Error('async log unavailable'));
    });
    const times = [10, 14, 20, 27, 31, 40];
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
      debugLogger: { log: debugLog },
    }), undefined, { now: () => times.shift() ?? 40 });
    const stages: string[] = [];
    const signal = new AbortController().signal;
    await dependencies.loadStatus(signal);

    const evidence = await dependencies.prepareReviewEvidence!({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      updates: { mode: 'strict' },
    }, signal, (stage) => { stages.push(stage); });
    expect(evidence).toMatchObject({
      config: {
        scope: 'user',
        affectedTargets: [
          { platform: 'codex', scope: 'project' },
          { platform: 'codex', scope: 'user' },
        ],
      },
    });

    expect(runtimeMocks.statusCommandV7).toHaveBeenCalledOnce();
    expect(stages).toEqual(['config', 'evidence']);
    expect(debugLog.mock.calls.map(([event]) => event)
      .filter((event) => event.type.startsWith('review.prepare.'))).toEqual([
      expect.objectContaining({ type: 'review.prepare.config' }),
      expect.objectContaining({ type: 'review.prepare.evidence' }),
    ]);

    const storePath = path.join(isolation.layout.awHomeDir, 'plugin-config', 'team', 'demo', 'config.json');
    const envelope = {
      schemaVersion: 4,
      sourceId: 'team',
      binding: { kind: 'source', sourceIdentity: evidence.source.sourceIdentity },
      pluginName: 'demo',
      values: { mode: 'saved' },
    };
    await fs.outputJson(storePath, envelope, { spaces: 2 });
    const beforeReorder = await dependencies.prepareReviewEvidence!({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', updates: { mode: 'strict' },
    }, signal, () => undefined);
    await fs.outputFile(storePath, `${JSON.stringify({
      values: envelope.values,
      pluginName: envelope.pluginName,
      binding: envelope.binding,
      sourceId: envelope.sourceId,
      schemaVersion: envelope.schemaVersion,
    })}\n`);
    const afterReorder = await dependencies.prepareReviewEvidence!({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', updates: { mode: 'strict' },
    }, signal, () => undefined);
    expect(afterReorder.config?.storeDigest).not.toBe(beforeReorder.config?.storeDigest);

    const controller = new TuiController(dependencies);
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', apply: true,
      updates: { mode: 'strict' },
      changes: [{ key: 'mode', title: 'Mode', before: 'saved', after: 'strict' }],
    });
    const writesBeforeRawChange = runtimeMocks.applyPluginConfigWrite.mock.calls.length;
    await fs.outputJson(storePath, envelope, { spaces: 2 });
    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'stale',
    });
    expect(runtimeMocks.applyPluginConfigWrite).toHaveBeenCalledTimes(writesBeforeRawChange);
    controller.dispose();
  });

  it('keeps Review, stale fingerprints, and writer reapply targets on one config affected-target rule', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-config-targets-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX', 'CLAUDE'];
      manifest.config = { fields: {
        mode: { type: 'string', title: 'Mode' },
        nativeMode: { type: 'string', title: 'Native mode', default: 'safe' },
      } };
      manifest.artifacts = { targets: [{
        id: 'native-skill',
        platform: 'codex',
        target: 'codex.skill',
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        scopes: ['user'],
        states: ['present'],
        refreshKeys: ['nativeMode'],
        skillKey: 'native-skill',
      }] };
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    const userTarget = { ...target('user', 'present'), pluginId: 'team/demo', sourceId: 'team' };
    const projectTarget = {
      ...target('project', 'partial'), pluginId: 'team/demo', sourceId: 'team', platform: 'claude' as const,
    };
    const statusResult = (targets: StatusV7Payload['targets']) => ({
      payload: {
        schemaVersion: 7 as const,
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
          primarySourceId: 'team',
          sources: [],
        },
        filters: { plugins: ['team/demo'], platform: 'both' as const, cwd: isolation.layout.fixtureCwd },
        targets,
        errors: [],
      },
      pluginSummaries: [{
        pluginId: 'team/demo', pluginName: 'demo', sourceId: 'team', sourceIdentity: 'identity:team',
        dependencyDirectCount: 0, dependencyTotalCount: 0,
      }],
      targetRevisions: [],
    });
    runtimeMocks.applyPluginConfigWrite.mockImplementation(async (options: {
      applyTargets: Array<{ platform: string; scope: string }>;
    }) => ({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: {
        state: 'succeeded',
        targetResults: options.applyTargets.map((entry) => ({ target: entry, action: 'reinstall', state: 'completed' })),
      },
    }));
    const createController = async (targets: StatusV7Payload['targets']) => {
      runtimeMocks.statusCommandV7.mockResolvedValue(statusResult(targets));
      const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'native 99.0.0', stderr: '' }),
        interactive: false,
      })));
      await controller.load();
      return controller;
    };
    const impactTitles = (review: Awaited<ReturnType<TuiController['buildOperationReview']>>) =>
      review.changes.filter((change) => change.group === 'configImpact').map((change) => change.title);

    const both = await createController([userTarget, projectTarget]);
    const userReview = await both.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared',
      apply: true, scriptTimeoutMs: 18_000, updates: { mode: 'user' },
      changes: [{ key: 'mode', title: 'Mode', before: 'old', after: 'user' }],
    });
    expect(userReview.changes).toContainEqual(expect.objectContaining({
      title: 'preApply 脚本超时', description: '18000 ms',
    }));
    expect(impactTitles(userReview)).toEqual(['重新应用 Claude Code · 当前项目']);
    await expect(both.executeOperation(userReview.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    expect(runtimeMocks.applyPluginConfigWrite).toHaveBeenLastCalledWith(expect.objectContaining({
      sharedNativeApplyConfirmed: true,
      rebuildRuntime: expect.objectContaining({ scriptTimeoutMs: 18_000 }),
      applyTargets: [expect.objectContaining({ platform: 'claude', scope: 'project' })],
    }));
    both.dispose();

    const sourceOnly = await createController([userTarget]);
    const sourceOnlyReview = await sourceOnly.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared',
      apply: true, updates: { nativeMode: 'safe' },
      changes: [{ key: 'nativeMode', title: 'Native mode', before: 'safe', after: 'safe' }],
    });
    expect(impactTitles(sourceOnlyReview)).toEqual(['重新生成 native-skill 动态 Skill']);
    expect(sourceOnlyReview).toMatchObject({
      requiresConfirmation: true,
      sharedImpact: { pluginIds: ['team/demo'] },
    });
    sourceOnly.dispose();

    await writePluginConfigStore({
      sourceId: 'team',
      logicalIdentity: await readCatalogSnapshotLogicalIdentity(sourceRoot),
      pluginName: 'demo',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { nativeMode: 'legacy-project-value' },
    });
    const legacyProjectOverride = await createController([userTarget, projectTarget]);
    const legacyProjectReview = await legacyProjectOverride.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'project', projectLayer: 'shared',
      apply: true, removeKeys: ['nativeMode'],
      changes: [{
        key: 'nativeMode', title: 'Native mode',
        before: 'legacy-project-value', after: 'safe',
      }],
    });
    expect(impactTitles(legacyProjectReview)).toEqual([
      '有效设置输入不变；无需重新应用',
    ]);
    expect(legacyProjectReview.requiresConfirmation).toBe(false);
    expect(JSON.stringify(legacyProjectReview.changes)).not.toContain('动态 Skill');
    legacyProjectOverride.dispose();

    const saveOnly = await createController([userTarget]);
    const saveOnlyReview = await saveOnly.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared',
      apply: false, scriptTimeoutMs: 19_000, updates: { mode: 'saved' },
      changes: [{ key: 'mode', title: 'Mode', before: 'old', after: 'saved' }],
    });
    expect(saveOnlyReview.changes).not.toContainEqual(expect.objectContaining({
      title: 'preApply 脚本超时',
    }));
    await expect(saveOnly.executeOperation(saveOnlyReview.reviewToken))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(runtimeMocks.applyPluginConfigWrite).toHaveBeenLastCalledWith(expect.objectContaining({
      rebuildRuntime: expect.not.objectContaining({ scriptTimeoutMs: expect.anything() }),
      applyTargets: [],
    }));
    saveOnly.dispose();

    const projectOnly = await createController([userTarget, projectTarget]);
    const projectReview = await projectOnly.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'project', projectLayer: 'shared', apply: true, updates: { mode: 'project' },
      changes: [{ key: 'mode', title: 'Mode', before: 'old', after: 'project' }],
    });
    expect(impactTitles(projectReview)).toEqual(['重新应用 Claude Code · 当前项目']);
    await expect(projectOnly.executeOperation(projectReview.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    expect(runtimeMocks.applyPluginConfigWrite).toHaveBeenLastCalledWith(expect.objectContaining({
      sharedNativeApplyConfirmed: true,
      applyTargets: [expect.objectContaining({ platform: 'claude', scope: 'project' })],
    }));
    projectOnly.dispose();

    runtimeMocks.replayConfigRuntimeWrites.mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'succeeded', targetResults: [] },
      otherProjectsMayRequireSync: true,
    });
    const retry = await createController([userTarget, projectTarget]);
    const retryReview = await retry.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      apply: true,
      retryApply: true,
    });
    expect(impactTitles(retryReview)).toEqual([
      '重新应用 Claude Code · 当前项目', '重新应用 Codex · 所有项目',
    ]);
    expect(retryReview).toMatchObject({
      requiresConfirmation: true,
      sharedImpact: { pluginIds: ['team/demo'] },
    });
    await expect(retry.executeOperation(retryReview.reviewToken))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(runtimeMocks.replayConfigRuntimeWrites).toHaveBeenCalledWith(expect.objectContaining({
      sharedNativeApplyConfirmed: true,
      applyTargets: [
        expect.objectContaining({ platform: 'claude', scope: 'project' }),
        expect.objectContaining({ platform: 'codex', scope: 'user' }),
      ],
    }));
    retry.dispose();

    const retryWithoutApplyFlag = await createController([userTarget, projectTarget]);
    const retryWithoutApplyReview = await retryWithoutApplyFlag.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      apply: false,
      retryApply: true,
    });
    expect(impactTitles(retryWithoutApplyReview)).toEqual([
      '重新应用 Claude Code · 当前项目', '重新应用 Codex · 所有项目',
    ]);
    expect(retryWithoutApplyReview).toMatchObject({
      requiresConfirmation: true,
      sharedImpact: { pluginIds: ['team/demo'] },
    });
    await expect(retryWithoutApplyFlag.executeOperation(retryWithoutApplyReview.reviewToken))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(runtimeMocks.replayConfigRuntimeWrites).toHaveBeenLastCalledWith(expect.objectContaining({
      applyTargets: [
        expect.objectContaining({ platform: 'claude', scope: 'project' }),
        expect.objectContaining({ platform: 'codex', scope: 'user' }),
      ],
    }));
    retryWithoutApplyFlag.dispose();

    const drifting = await createController([userTarget, projectTarget]);
    const driftReview = await drifting.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared', apply: true, updates: { mode: 'stale' },
      changes: [{ key: 'mode', title: 'Mode', before: 'old', after: 'stale' }],
    });
    const writesBeforeDrift = runtimeMocks.applyPluginConfigWrite.mock.calls.length;
    runtimeMocks.statusCommandV7.mockResolvedValue(statusResult([userTarget]));
    const stale = await drifting.executeOperation(driftReview.reviewToken);
    expect(stale).toMatchObject({ state: 'stale' });
    if (stale.state === 'stale') {
      expect(impactTitles(stale.review)).toEqual(['有效设置输入不变；无需重新应用']);
    }
    expect(runtimeMocks.applyPluginConfigWrite).toHaveBeenCalledTimes(writesBeforeDrift);
    drifting.dispose();
  });

  it('offers deterministic reset evidence for an invalid namespaced store', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-invalid-config-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const storePath = path.join(
      isolation.layout.awHomeDir,
      'plugin-config',
      'team',
      'demo',
      'config.json',
    );
    await fs.outputFile(storePath, '{invalid', 'utf8');
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));

    const pageError = await dependencies.getConfigPage!(
      'team/demo',
      { scope: 'effective' },
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(pageError).toBeInstanceOf(TuiConfigInvalidStoreError);
    expect(pageError).toMatchObject({
      code: 'invalidConfigStores',
      evidence: [{
        scope: 'user',
        code: 'invalidJson',
        pathSummary: 'AW_HOME/plugin-config/team/demo/config.json',
      }],
    });
    expect(JSON.stringify(pageError)).not.toContain(isolation.layout.awHomeDir);

    const invalidUserAvailability = await dependencies.getConfigResetAvailability!(
      'team/demo',
      { scope: 'user' },
      new AbortController().signal,
    );
    expect(invalidUserAvailability).toMatchObject({
      exists: true,
      state: 'invalid',
      invalidCode: 'invalidJson',
      sourceIdentityPresent: true,
      sourceIdentity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      storeDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    const resetIntent = {
      kind: 'configReset' as const,
      pluginId: 'team/demo',
      scope: 'user' as const,
      projectLayer: 'shared' as const,
    };
    const resetEvidence = await dependencies.prepareReviewEvidence!(
      resetIntent,
      new AbortController().signal,
      () => undefined,
    );
    expect(resetEvidence.config).toMatchObject({ impactState: 'unknown' });
    expect(resetEvidence.config).not.toHaveProperty('noEffectiveChange');
    const resetProjection = buildOperationReviewProjection({
      intent: resetIntent,
      evidence: resetEvidence,
    });
    expect(resetProjection.changes).toContainEqual(expect.objectContaining({
      kind: 'warning',
      title: '设置重置后的应用影响未知',
    }));
    expect(JSON.stringify(resetProjection.changes)).not.toContain('当前安装保持不变');
    await fs.writeJson(storePath, {
      schemaVersion: 4,
      sourceId: 'team',
      binding: { kind: 'source', sourceIdentity: invalidUserAvailability.sourceIdentity },
      pluginName: 'demo',
      values: { mode: 'ready' },
    });
    await expect(dependencies.getConfigResetAvailability!(
      'team/demo',
      { scope: 'user' },
      new AbortController().signal,
    )).resolves.toMatchObject({ exists: true, state: 'ready' });

    const projectStorePath = path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-config',
      'team',
      'demo',
      'config.json',
    );
    await fs.outputFile(projectStorePath, '{project-invalid', 'utf8');
    const projectError = await dependencies.getConfigPage!(
      'team/demo',
      { scope: 'effective' },
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(projectError).toMatchObject({
      evidence: [{
        scope: 'project',
        code: 'invalidJson',
        pathSummary: '<project>/.agent-workflows/plugin-config/team/demo/config.json',
      }],
    });

    await fs.outputFile(storePath, '{user-invalid-again', 'utf8');
    const bothError = await dependencies.getConfigPage!(
      'team/demo',
      { scope: 'effective' },
      new AbortController().signal,
    ).catch((error: unknown) => error);
    expect(bothError).toMatchObject({
      evidence: [
        expect.objectContaining({ scope: 'user', code: 'invalidJson' }),
        expect.objectContaining({ scope: 'project', code: 'invalidJson' }),
      ],
    });
    await fs.remove(sourceRoot);
    await fs.remove(path.join(isolation.layout.awHomeDir, 'catalog-store'));
    await expect(dependencies.getConfigResetAvailability!(
      'team/demo',
      { scope: 'user' },
      new AbortController().signal,
    )).resolves.toMatchObject({
      exists: true,
      state: 'invalid',
      invalidCode: 'invalidJson',
      sourceIdentityPresent: false,
    });
  });

  it('keeps a schema-invalid project field editable and projects an invalid lower fallback', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-invalid-field-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = {
        fields: {
          mode: { type: 'string', title: 'Mode', default: 'safe' },
          token: {
            type: 'string', title: 'Token', sensitive: true,
            validation: { pattern: '^valid$', maxLength: 20 },
          },
        },
      };
    });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const identity = (await dependencies.getConfigResetAvailability!(
      'team/demo', { scope: 'user' }, new AbortController().signal,
    )).sourceIdentity!;
    const logicalIdentity = await readCatalogSnapshotLogicalIdentity(sourceRoot);
    const envelope = (scope: 'user' | 'project', values: Record<string, unknown>) => ({
      schemaVersion: 4,
      sourceId: 'team',
      binding: scope === 'user'
        ? { kind: 'source', sourceIdentity: identity }
        : { kind: 'catalog', logicalIdentity },
      pluginName: 'demo',
      values,
    });
    await fs.outputJson(path.join(
      isolation.layout.awHomeDir, 'plugin-config', 'team', 'demo', 'config.json',
    ), envelope('user', { token: 'lower-secret' }));
    await fs.outputJson(path.join(
      isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-config', 'team', 'demo', 'config.json',
    ), envelope('project', { mode: 42, token: 'project-secret' }));

    const page = await dependencies.getConfigPage!(
      'team/demo', { scope: 'project' }, new AbortController().signal,
    );
    const fields = page.groups.flatMap((group) => group.fields);
    expect(fields.find((field) => field.key === 'mode')).toMatchObject({
      displayValue: '值无效',
      invalidOverrideIssue: '字段“Mode”在本层的值无效。请修改或删除此字段。',
      fallbackDisplayValue: 'safe',
    });
    expect(fields.find((field) => field.key === 'token')).toMatchObject({
      displayValue: '值无效',
      fallbackDisplayValue: '值无效；保存可成功，但应用会被阻止',
      fallbackSourceLabel: '个人默认',
    });
    expect(JSON.stringify(page)).not.toContain('lower-secret');
    expect(JSON.stringify(page)).not.toContain('project-secret');

    await fs.remove(path.join(
      isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-config', 'team', 'demo', 'config.json',
    ));
    await fs.outputJson(path.join(
      isolation.layout.awHomeDir, 'plugin-config', 'team', 'demo', 'config.json',
    ), envelope('user', { mode: 42, token: 'user-secret' }));
    const projectPage = await dependencies.getConfigPage!(
      'team/demo', { scope: 'project' }, new AbortController().signal,
    );
    const inheritedInvalid = projectPage.groups.flatMap((group) => group.fields)
      .find((field) => field.key === 'mode');
    expect(inheritedInvalid).toMatchObject({
      configured: false,
      invalidOverrideOwnedByLayer: false,
      invalidOverrideIssue: '字段“Mode”在个人默认中的值无效。请切换到该设置层修改或删除此字段。',
    });
    expect(inheritedInvalid).not.toHaveProperty('fallbackDisplayValue');
    expect(JSON.stringify(projectPage)).not.toContain('user-secret');
  });

  it('reviews and executes a real reset without a loaded Catalog session', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const storePath = path.join(
      isolation.layout.awHomeDir, 'plugin-config', 'official', 'demo', 'config.json',
    );
    await fs.outputFile(storePath, '{invalid', 'utf8');
    const actualWrites = await vi.importActual<typeof import('../../src/utils/plugin-config-write.js')>(
      '../../src/utils/plugin-config-write.js',
    );
    runtimeMocks.resetPluginConfigWithHelper.mockImplementation(
      actualWrites.resetPluginConfigWithHelper,
    );
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        schemaVersion: 7,
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:offline-reset',
          sources: [],
        },
        filters: { plugins: [], platform: 'all', cwd: isolation.layout.fixtureCwd },
        targets: [],
        errors: [],
      },
      pluginSummaries: [],
      targetRevisions: [],
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const intent = {
      kind: 'configReset',
      pluginId: 'official/demo',
      scope: 'user' as const,
      projectLayer: 'shared' as const,
    } as const;
    const controller = new TuiController(dependencies);
    const review = await controller.buildOperationReview(intent);
    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'succeeded',
      summary: { resetDisposition: 'deletedFile' },
    });

    expect(runtimeMocks.statusCommandV7).toHaveBeenCalledOnce();
    await expect(fs.pathExists(storePath)).resolves.toBe(false);
    controller.dispose();
    runtimeMocks.resetPluginConfigWithHelper.mockReset();
  });

  it('allows an offline reset Review when its Catalog source appears later', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const intent = {
      kind: 'configReset' as const,
      pluginId: 'late/demo',
      scope: 'user' as const,
      projectLayer: 'shared' as const,
    };
    const signal = new AbortController().signal;
    const evidence = await dependencies.prepareReviewEvidence!(intent, signal, () => {});
    expect(evidence.source).toBeUndefined();

    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'late-reset-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'late', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    runtimeMocks.resetPluginConfigWithHelper.mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });

    await expect(dependencies.executeIntent(intent, evidence)).resolves.toMatchObject({
      configWrite: 'succeeded',
    });
  });

  it.each([
    ['symbolicLink', 'unlinkedSymlink'],
    ['directory', 'quarantinedDirectory'],
  ] as const)('reviews and executes a real %s reset target', async (targetKind, disposition) => {
    const isolation = getCurrentSourceTestIsolation();
    const storePath = path.join(
      isolation.layout.awHomeDir, 'plugin-config', 'offline', 'demo', 'config.json',
    );
    const preservedPath = path.join(isolation.layout.fixtureCwd, `preserved-${targetKind}`);
    if (targetKind === 'symbolicLink') {
      await fs.outputFile(preservedPath, 'preserved', 'utf8');
      await fs.ensureSymlink(preservedPath, storePath);
    } else {
      await fs.outputFile(path.join(storePath, 'preserved.txt'), 'preserved', 'utf8');
    }
    const actualWrites = await vi.importActual<typeof import('../../src/utils/plugin-config-write.js')>(
      '../../src/utils/plugin-config-write.js',
    );
    runtimeMocks.resetPluginConfigWithHelper.mockImplementation(
      actualWrites.resetPluginConfigWithHelper,
    );
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const signal = new AbortController().signal;
    await expect(dependencies.getConfigResetAvailability!(
      'offline/demo', { scope: 'user' }, signal,
    )).resolves.toMatchObject({ exists: true, targetKind, resettable: true });
    const intent = {
      kind: 'configReset' as const,
      pluginId: 'offline/demo',
      scope: 'user' as const,
      projectLayer: 'shared' as const,
    };
    const evidence = await dependencies.prepareReviewEvidence!(intent, signal, () => {});
    const result = await dependencies.executeIntent(intent, evidence) as {
      resetDisposition: string;
      quarantineBasename?: string;
    };

    expect(result.resetDisposition).toBe(disposition);
    await expect(fs.pathExists(storePath)).resolves.toBe(false);
    if (targetKind === 'symbolicLink') {
      await expect(fs.readFile(preservedPath, 'utf8')).resolves.toBe('preserved');
    } else {
      expect(result.quarantineBasename).toMatch(/^config\.broken-.*\.json$/u);
      await expect(fs.readFile(path.join(
        path.dirname(storePath), result.quarantineBasename!, 'preserved.txt',
      ), 'utf8')).resolves.toBe('preserved');
    }
    runtimeMocks.resetPluginConfigWithHelper.mockReset();
  });

  it.each([
    ['install', 'absent', undefined],
    ['refreshAndSync', 'present', 'upgradeAvailable'],
    ['reinstall', 'present', undefined],
    ['uninstall', 'present', undefined],
    ['cleanup', 'present', undefined],
  ] as const)('prepares one legal %s Review with one status entry', async (action, state, revisionState) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, `runtime-review-${action}-source`);
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    if (action === 'refreshAndSync') {
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.version = '2.0.0';
      });
    }
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
        },
        targets: [{
          ...target('user', state),
          pluginId: 'team/demo',
          sourceId: 'team',
          sourceIdentity: 'identity:team',
          version: '0.0.0',
          cwd: isolation.layout.fixtureCwd,
        }],
      },
      pluginSummaries: [{
        pluginId: 'team/demo',
        pluginName: 'demo',
        sourceId: 'team',
        sourceIdentity: 'identity:team',
        dependencyDirectCount: 0,
        dependencyTotalCount: 0,
      }],
      targetRevisions: revisionState ? [{
        pluginId: 'team/demo',
        platform: 'codex',
        scope: 'user',
        revision: {
          state: revisionState,
          availableVersion: '0.0.0',
          installedVersion: '0.0.0',
        },
      }] : [],
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const stages: string[] = [];

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'pluginWrite',
      action,
      pluginId: 'team/demo',
      platform: 'codex',
      scope: 'user',
    }, new AbortController().signal, (stage) => { stages.push(stage); })).resolves.toMatchObject({
      source: {
        sourceId: 'team',
        pluginVersion: action === 'refreshAndSync' ? '2.0.0' : '1.0.0',
      },
    });

    expect(runtimeMocks.statusCommandV7).toHaveBeenCalledOnce();
    expect(stages).toEqual([
      ...(action === 'refreshAndSync' ? ['refresh'] : []),
      'status', 'catalog', 'evidence',
    ]);
  });

  it('keeps the old Active and reports a non-blocking warning when refresh fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-refresh-fallback-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await fs.remove(path.join(sourceRoot, 'catalog-manifest.json'));
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        catalog: { configDigest: configured.digest, compositeDigest: 'sha256:composite' },
        targets: [{
          ...target('user', 'present'), pluginId: 'team/demo', sourceId: 'team',
          sourceIdentity: 'identity:team', version: '1.0.0', cwd: isolation.layout.fixtureCwd,
        }],
      },
      pluginSummaries: [{
        pluginId: 'team/demo', pluginName: 'demo', sourceId: 'team', sourceIdentity: 'identity:team',
        dependencyDirectCount: 0, dependencyTotalCount: 0,
      }],
      targetRevisions: [{
        pluginId: 'team/demo', platform: 'codex', scope: 'user',
        revision: { state: 'upgradeAvailable', availableVersion: '2.0.0', installedVersion: '1.0.0' },
      }],
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'team/demo',
      platform: 'codex', scope: 'user',
    }, new AbortController().signal, () => {})).resolves.toMatchObject({
      source: { sourceId: 'team', pluginVersion: '1.0.0' },
      preparationWarnings: [expect.stringContaining('catalogSourceRefreshFailed: team:')],
    });
  });

  it('passes overrides through Phase3 and persists a user-to-project adjustment without cleanup', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-placement-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'demo', dependencies: ['dependency'] },
      { name: 'dependency' },
    ]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    const plan: ReconcileOperationPlan = {
      dependencyPlanSchemaVersion: 2,
      dependencyPlanDigest: 'sha256:placement',
      requestedPluginIds: ['team/demo'],
      resolvedPluginIds: ['team/dependency', 'team/demo'],
      dependencyEdges: [{ from: 'team/demo', to: 'team/dependency', platform: 'codex' }],
      scopeOverrides: [{ pluginId: 'team/dependency', platform: 'codex', scope: 'user' }],
      targets: [
        {
          pluginId: 'team/dependency', pluginName: 'dependency', platform: 'codex',
          relation: 'dependency', depth: 1, requiredBy: ['team/demo'], rootScope: 'project',
          minimumScope: 'project', resolvedScope: 'user', allowedScopes: ['project', 'user'],
          assignmentSource: 'userOverride', locked: false, affectsOtherProjects: true,
          state: 'present', action: 'keep', order: 0,
        },
        {
          pluginId: 'team/demo', pluginName: 'demo', platform: 'codex',
          relation: 'requested', depth: 0, requiredBy: [], rootScope: 'project',
          minimumScope: 'project', resolvedScope: 'project', allowedScopes: ['project'],
          assignmentSource: 'root', locked: true, affectsOtherProjects: false,
          state: 'absent', action: 'install', order: 1,
        },
      ],
      claimRoots: [{ pluginId: 'team/demo', platform: 'codex' }],
    };
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        schemaVersion: 7,
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
          primarySourceId: 'team',
          sources: [],
        },
        filters: { plugins: ['team/demo'], platform: 'codex', cwd: isolation.layout.fixtureCwd },
        targets: [
          {
            ...target('project', 'absent'),
            pluginId: 'team/demo', sourceId: 'team', sourceIdentity: 'identity:team',
            cwd: isolation.layout.fixtureCwd,
          },
          {
            ...target('user', 'present'),
            pluginName: 'dependency', pluginId: 'team/dependency',
            sourceId: 'team', sourceIdentity: 'identity:team', cwd: isolation.layout.fixtureCwd,
            desired: { enabled: true, scopes: ['user'], relation: 'dependency' },
            actual: { state: 'ready' },
            sharedNative: { pluginId: 'dependency@team', state: 'present', shared: true },
            activation: { user: true, project: true, effective: true, evidence: 'observed' },
          },
        ],
        errors: [],
      },
      pluginSummaries: [{
        pluginId: 'team/demo', pluginName: 'demo', sourceId: 'team', sourceIdentity: 'identity:team',
        dependencyDirectCount: 1, dependencyTotalCount: 1,
      }],
      targetRevisions: [],
    });
    runtimeMocks.installWriteCommand.mockResolvedValue({
      dependencyPlan: plan,
      targetResults: [],
      overallState: 'succeeded',
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'install' as const,
      pluginId: 'team/demo',
      platform: 'codex' as const,
      scope: 'project' as const,
      dependencyScopeOverrides: [{
        pluginId: 'team/dependency', platform: 'codex' as const, scope: 'user' as const,
      }],
      scriptTimeoutMs: 12_000,
    };

    const evidence = await dependencies.captureEvidence(intent, new AbortController().signal);
    expect(evidence.dependencyPlan).toEqual(plan);
    expect(runtimeMocks.installWriteCommand).toHaveBeenLastCalledWith(
      ['team/demo'],
      expect.objectContaining({
        platform: 'codex', scope: 'project',
        dependencyScopeOverrides: intent.dependencyScopeOverrides,
        scriptTimeoutMs: 12_000,
      }),
      expect.objectContaining({ previewOperationPlan: true }),
    );

    await expect(dependencies.executeIntent(intent, evidence)).resolves.toMatchObject({
      overallState: 'succeeded',
    });
    expect(runtimeMocks.installWriteCommand).toHaveBeenLastCalledWith(
      ['team/demo'],
      expect.objectContaining({
        platform: 'codex', scope: 'project',
        dependencyScopeOverrides: intent.dependencyScopeOverrides,
        scriptTimeoutMs: 12_000,
      }),
      expect.not.objectContaining({
        expectedPlanFingerprint: expect.anything(),
      }),
    );

    const projectPlan: ReconcileOperationPlan = {
      ...plan,
      dependencyPlanDigest: 'sha256:project-placement',
      scopeOverrides: [{ pluginId: 'team/dependency', platform: 'codex', scope: 'project' }],
      targets: plan.targets.map((entry) => entry.pluginId === 'team/dependency'
        ? {
            ...entry,
            resolvedScope: 'project',
            assignmentSource: 'userOverride',
            affectsOtherProjects: false,
            action: 'keep',
          }
        : entry),
    };
    runtimeMocks.installWriteCommand.mockClear();
    runtimeMocks.installWriteCommand.mockResolvedValue({
      dependencyPlan: projectPlan,
      targetResults: [],
      overallState: 'succeeded',
    });
    const adjustedIntent = {
      ...intent,
      dependencyScopeOverrides: projectPlan.scopeOverrides,
    };

    const adjustedEvidence = await dependencies.captureEvidence(
      adjustedIntent,
      new AbortController().signal,
    );
    expect(adjustedEvidence).toMatchObject({
      dependencyPlan: projectPlan,
    });
    await expect(dependencies.executeIntent(adjustedIntent, adjustedEvidence))
      .resolves.toMatchObject({ dependencyPlan: projectPlan, overallState: 'succeeded' });
    expect(runtimeMocks.installWriteCommand).toHaveBeenCalledTimes(3);
    expect(runtimeMocks.cleanupWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.reinstallWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.uninstallWriteCommand).not.toHaveBeenCalled();
  });

  it('executes sync through the reviewed write chain', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-sync-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    const selected = {
      ...target('project', 'present'),
      pluginId: 'team/demo', sourceId: 'team', sourceIdentity: 'identity:team',
      cwd: isolation.layout.fixtureCwd,
      actual: { state: 'needsSync' as const },
    };
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        schemaVersion: 7,
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
          primarySourceId: 'team',
          sources: [],
        },
        filters: { plugins: ['team/demo'], platform: 'codex', cwd: isolation.layout.fixtureCwd },
        targets: [selected],
        errors: [],
      },
      pluginSummaries: [{
        pluginId: 'team/demo', pluginName: 'demo', sourceId: 'team', sourceIdentity: 'identity:team',
        dependencyDirectCount: 0, dependencyTotalCount: 0,
      }],
      targetRevisions: [],
    });
    runtimeMocks.installWriteCommand.mockResolvedValue({
      targetResults: [],
      overallState: 'succeeded',
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'sync' as const,
      pluginId: 'team/demo',
      platform: 'codex' as const,
      scope: 'project' as const,
      scriptTimeoutMs: 24_000,
    };

    const evidence = await dependencies.captureEvidence(intent, new AbortController().signal);
    expect(runtimeMocks.installWriteCommand).toHaveBeenLastCalledWith(
      ['team/demo'],
      expect.objectContaining({ platform: 'codex', scope: 'project', scriptTimeoutMs: 24_000 }),
      expect.objectContaining({ previewOperationPlan: true }),
    );
    await expect(dependencies.executeIntent(intent, evidence)).resolves.toMatchObject({
      overallState: 'succeeded',
    });
    expect(runtimeMocks.installWriteCommand).toHaveBeenCalledTimes(3);
    expect(runtimeMocks.installWriteCommand).toHaveBeenLastCalledWith(
      ['team/demo'],
      expect.objectContaining({ platform: 'codex', scope: 'project', scriptTimeoutMs: 24_000 }),
      expect.not.objectContaining({ reconcileIntentOnly: expect.anything() }),
    );

    runtimeMocks.installWriteCommand.mockResolvedValue({
      targetResults: [],
      overallState: 'succeeded',
    });
    const controller = new TuiController(dependencies);
    const mutableIntent = { ...intent, scriptTimeoutMs: 25_000 };
    const review = await controller.buildOperationReview(mutableIntent);
    mutableIntent.scriptTimeoutMs = 26_000;
    await expect(controller.executeOperation(review.reviewToken))
      .resolves.toMatchObject({ state: 'succeeded' });
    expect(runtimeMocks.installWriteCommand).toHaveBeenLastCalledWith(
      ['team/demo'],
      expect.objectContaining({ scriptTimeoutMs: 25_000 }),
      expect.anything(),
    );
    controller.dispose();

    runtimeMocks.installWriteCommand.mockResolvedValue({
      targetResults: [{ errorCode: 'operationPlanStale', state: 'failed' }],
      overallState: 'failed',
    });
    await expect(dependencies.executeIntent(intent, evidence)).rejects.toMatchObject({
      code: 'operationReviewStale',
    });
  });

  it('resets config without schema or applying visible targets', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-config-reset-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        schemaVersion: 7,
        catalog: {
          configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
          primarySourceId: 'team',
          sources: [],
        },
        filters: { plugins: ['team/demo'], platform: 'codex', cwd: isolation.layout.fixtureCwd },
        targets: [{
          ...target('user', 'present'), pluginId: 'team/demo', sourceId: 'team',
          sourceIdentity: 'identity:team', cwd: isolation.layout.fixtureCwd,
        }],
        errors: [],
      },
      pluginSummaries: [{
        pluginId: 'team/demo', pluginName: 'demo', sourceId: 'team', sourceIdentity: 'identity:team',
        dependencyDirectCount: 0, dependencyTotalCount: 0,
      }],
      targetRevisions: [],
    });
    runtimeMocks.resetPluginConfigWithHelper.mockResolvedValue({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const signal = new AbortController().signal;
    await dependencies.loadStatus(signal);
    const intent = {
      kind: 'configReset' as const,
      pluginId: 'team/demo',
      scope: 'user' as const,
      projectLayer: 'shared' as const,
    };
    const evidence = await dependencies.prepareReviewEvidence!(intent, signal, () => {});

    await expect(dependencies.executeIntent(intent, evidence)).resolves.toMatchObject({
      configWrite: 'succeeded',
    });
    expect(runtimeMocks.resetPluginConfigWithHelper).toHaveBeenCalledWith(expect.objectContaining({
      apply: false,
      sourceId: 'team',
      pluginName: 'demo',
    }));
  });

  it('lets the core preview own collision rejection during Review preparation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-review-collision-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        catalog: { configDigest: configured.digest, compositeDigest: 'sha256:composite' },
        targets: [{
          ...target('user', 'absent'),
          pluginId: 'team/demo', sourceId: 'team', sourceIdentity: 'identity:team',
          version: '0.0.0', cwd: isolation.layout.fixtureCwd,
          reasons: [{ code: 'artifactCollision', message: 'safe collision', severity: 'blocking' }],
        }],
      },
      pluginSummaries: [{
        pluginId: 'team/demo', pluginName: 'demo', sourceId: 'team', sourceIdentity: 'identity:team',
        dependencyDirectCount: 0, dependencyTotalCount: 0,
      }],
      targetRevisions: [],
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const stages: string[] = [];

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'pluginWrite', action: 'install', pluginId: 'team/demo', platform: 'codex', scope: 'user',
    }, new AbortController().signal, (stage) => { stages.push(stage); }))
      .resolves.toMatchObject({ catalog: expect.any(Object) });
    expect(stages[0]).toBe('status');
  });

  it.each([
    ['install', 'absent', undefined, true],
    ['refreshAndSync', 'present', 'upgradeAvailable', true],
    ['reinstall', 'partial', undefined, true],
    ['uninstall', 'present', undefined, false],
    ['cleanup', 'partial', undefined, false],
  ] as const)('%s runtime validation delegates the collision boundary for %s', async (
    action,
    state,
    revisionState,
    blocked,
  ) => {
    const collisionTarget = target('user', state);
    collisionTarget.reasons = [{
      code: 'artifactCollision',
      message: 'safe collision',
      severity: 'blocking',
    }];
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: { targets: [collisionTarget] },
      targetRevisions: revisionState ? [{
        pluginId: 'official/demo',
        platform: 'codex',
        scope: 'user',
        revision: { state: revisionState, availableVersion: '2.0.0', installedVersion: '1.0.0' },
      }] : [],
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const validation = dependencies.validateIntent!({
      kind: 'pluginWrite', action, pluginId: 'official/demo', platform: 'codex', scope: 'user',
    }, new AbortController().signal);

    void blocked;
    await expect(validation).resolves.toBeUndefined();
  });

  it('uses one source mutation preflight for review validation and evidence', async () => {
    runtimeMocks.preflightCatalogSourceMutation.mockResolvedValue({
      sourceId: 'team',
      configDigest: 'sha256:before',
      proposedConfigDigest: 'sha256:after',
      sourceIdentity: 'sha256:source',
      identityChanged: false,
      impactDigest: 'sha256:impact',
      references: {
        inventorySchemaVersion: 2,
        primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
        inventoryComplete: true,
        references: [{ category: 'marketplace', sourceId: 'official', marketplaceName: 'aw' }],
        errors: [],
      },
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const stages: string[] = [];

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'sourceMutation',
      action: 'setPrimary',
      sourceId: 'team',
    }, new AbortController().signal, (stage) => { stages.push(stage); })).resolves.toMatchObject({
      sourceWrite: { configDigest: 'sha256:before', proposedConfigDigest: 'sha256:after' },
    });

    expect(runtimeMocks.preflightCatalogSourceMutation).toHaveBeenCalledOnce();
    expect(stages).toEqual(['validate', 'evidence']);
    expect(runtimeMocks.statusCommandV7).not.toHaveBeenCalled();
  });

  it('passes reviewed primary impact to execution and surfaces lock-time stale', async () => {
    runtimeMocks.preflightCatalogSourceMutation.mockResolvedValue({
      sourceId: 'team',
      configDigest: 'sha256:before',
      proposedConfigDigest: 'sha256:after',
      identityChanged: false,
      impactDigest: 'sha256:impact',
      references: {
        inventorySchemaVersion: 2,
        primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
        inventoryComplete: true,
        references: [{ category: 'marketplace', sourceId: 'official', marketplaceName: 'aw' }],
        errors: [],
      },
    });
    runtimeMocks.setPrimaryCatalogSourceCommand.mockRejectedValue(Object.assign(
      new Error('Catalog source impact changed after review.'),
      { code: 'operationReviewStale' },
    ));
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const intent = { kind: 'sourceMutation' as const, action: 'setPrimary' as const, sourceId: 'team' };
    const evidence = await dependencies.prepareReviewEvidence!(
      intent,
      new AbortController().signal,
      () => undefined,
    );

    await expect(dependencies.executeIntent!(intent, evidence)).rejects.toMatchObject({
      code: 'operationReviewStale',
    });
    expect(runtimeMocks.setPrimaryCatalogSourceCommand).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'team',
      expectedConfigDigest: 'sha256:before',
      expectedImpactDigest: 'sha256:impact',
      requireImpactConfirmation: true,
      confirmImpact: true,
    }));
  });

  it('reviews activate-then-primary impact and preserves activation when primary evidence becomes stale', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activate-primary');
    await createCatalogSnapshotFixture(sourceRoot);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfigWithoutActive({
      config: {
        schemaVersion: 2,
        sources: [
          ...before.config.sources,
          { id: 'team', type: 'path', path: sourceRoot, primary: false },
        ],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const config = await readCatalogSourcesConfigSnapshot(isolation.env);
    const manifest = await fs.readJson(path.join(sourceRoot, 'catalog-manifest.json'));
    const candidate = {
      sourceId: 'team',
      sourceConfigFingerprint: `sha256:${'1'.repeat(64)}`,
      sourceIdentity: `sha256:${'2'.repeat(64)}`,
      logicalIdentity: 'fixture-workspace',
      requestedRef: 'path',
      resolvedCommit: 'path',
      catalogVersion: '1.0.0',
      channel: 'latest' as const,
      manifestDigest: `sha256:${'3'.repeat(64)}`,
      snapshotDigest: `sha256:${'4'.repeat(64)}`,
    };
    runtimeMocks.probeCatalogSourceGeneration.mockResolvedValue({
      sourceId: 'team', candidate, manifest,
    });
    runtimeMocks.preflightCatalogSourceMutation.mockResolvedValue({
      sourceId: 'team',
      configDigest: config.digest,
      proposedConfigDigest: `sha256:${'5'.repeat(64)}`,
      identityChanged: false,
      impactDigest: `sha256:${'6'.repeat(64)}`,
      references: {
        inventorySchemaVersion: 2,
        primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
        inventoryComplete: true,
        references: [{
          category: 'config', sourceId: 'official', pluginId: 'official/demo', scope: 'user',
        }],
        errors: [],
      },
    });
    const generation = {
      catalogGenerationSchemaVersion: 1 as const,
      sourceId: 'team', mode: 'sync' as const, outcome: 'activated' as const,
      activeChanged: true, resolution: candidate,
      lastSync: { syncedAt: '2026-01-01T00:00:00.000Z', mode: 'sync' as const, state: 'succeeded' as const, resolvedCommit: 'path' },
    };
    runtimeMocks.activateCatalogSourceGeneration.mockResolvedValue(generation);
    runtimeMocks.setPrimaryCatalogSourceCommand.mockRejectedValue(Object.assign(
      new Error('primary impact changed'), { code: 'operationReviewStale' },
    ));
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const intent = {
      kind: 'catalogGeneration' as const,
      action: 'activate' as const,
      sourceId: 'team',
      setPrimaryAfterActivation: true,
    };
    const evidence = await dependencies.prepareReviewEvidence!(
      intent,
      new AbortController().signal,
      () => undefined,
    );

    expect(runtimeMocks.preflightCatalogSourceMutation).toHaveBeenCalledWith(expect.objectContaining({
      request: { action: 'setPrimary', sourceId: 'team' },
    }));
    expect(evidence.catalogGeneration).toMatchObject({
      primaryConfigDigest: config.digest,
      primaryImpactDigest: `sha256:${'6'.repeat(64)}`,
      primaryImpact: {
        primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
        affectedReferences: [expect.objectContaining({ pluginId: 'official/demo' })],
      },
    });
    await expect(dependencies.executeIntent!(intent, evidence)).resolves.toMatchObject({
      status: 'partial',
      partialReason: 'primary',
      activeAvailable: true,
      generation,
      errorCode: 'operationReviewStale',
    });
    expect(runtimeMocks.setPrimaryCatalogSourceCommand).toHaveBeenCalledWith(expect.objectContaining({
      expectedConfigDigest: config.digest,
      expectedImpactDigest: `sha256:${'6'.repeat(64)}`,
      requireImpactConfirmation: true,
      confirmImpact: true,
    }));
    expect((await readCatalogSourcesConfigSnapshot(isolation.env)).config.sources
      .find((source) => source.id === 'official')).toMatchObject({ primary: true });
  });

  it('stops a managed source mutation when public preflight rejects it', async () => {
    runtimeMocks.preflightCatalogSourceMutation.mockRejectedValue(Object.assign(
      new Error('Catalog source "workspace-dev" is managed by a Catalog Workspace.'),
      { code: 'managedSourceProtected' },
    ));
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'sourceMutation',
      action: 'remove',
      sourceId: 'workspace-dev',
    }, new AbortController().signal, () => undefined)).rejects.toMatchObject({
      code: 'managedSourceProtected',
    });
    expect(runtimeMocks.preflightCatalogSourceMutation).toHaveBeenCalledOnce();
  });

  it('does not return source evidence after cancellation during an unsupported preflight boundary', async () => {
    let resolvePreflight!: (value: {
      configDigest: string;
      proposedConfigDigest: string;
      references: { references: never[]; errors: never[] };
    }) => void;
    runtimeMocks.preflightCatalogSourceMutation.mockReturnValue(new Promise((resolve) => {
      resolvePreflight = resolve;
    }));
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const abort = new AbortController();
    const stages: string[] = [];
    const preparation = dependencies.prepareReviewEvidence!({
      kind: 'sourceMutation',
      action: 'setPrimary',
      sourceId: 'team',
    }, abort.signal, (stage) => { stages.push(stage); });
    await vi.waitFor(() => expect(runtimeMocks.preflightCatalogSourceMutation).toHaveBeenCalledOnce());

    abort.abort();
    resolvePreflight({
      configDigest: 'sha256:before',
      proposedConfigDigest: 'sha256:after',
      references: { references: [], errors: [] },
    });

    await expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
    expect(stages).toEqual(['validate']);
  });

  it('uses one portable prepare call for review evidence', async () => {
    runtimeMocks.preparePortableInstall.mockResolvedValue({
      configDigest: 'sha256:config',
      evidenceDigest: 'sha256:portable',
      selected: [],
      dependencyContributions: [],
      conflicts: [],
    });
    const isolation = getCurrentSourceTestIsolation();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    }));
    const stages: string[] = [];

    await expect(dependencies.prepareReviewEvidence!({
      kind: 'portableInstall',
      pluginId: 'team/demo',
      scope: 'user',
      selectedSkills: [],
    }, new AbortController().signal, (stage) => { stages.push(stage); })).resolves.toMatchObject({
      portable: { evidenceDigest: 'sha256:portable' },
    });

    expect(runtimeMocks.preparePortableInstall).toHaveBeenCalledOnce();
    expect(stages).toEqual(['portable', 'evidence']);
    expect(runtimeMocks.statusCommandV7).not.toHaveBeenCalled();
  });

  it('uses status ownership evidence to run ordinary cleanup when the current Catalog bundle is absent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.env.AW_CODEX_HOME!, 'skills');
    await fs.ensureDir(path.join(skillsRoot, 'demo-owned'));
    await writeSkillOwnerMarker({
      skillRoot: path.join(skillsRoot, 'demo-owned'),
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'official',
        sourceIdentity: OFFLINE_SOURCE_IDENTITY,
        pluginId: 'official/demo',
        plugin: 'demo',
        artifactKey: 'demo-owned',
        platform: 'codex',
        scope: 'user',
      },
    });
    const configSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV7.mockResolvedValue(bundleUnavailableStatus(configSnapshot.digest));
    runtimeMocks.cleanupWriteCommand.mockResolvedValue({
      platforms: ['codex'],
      plugins: ['demo'],
      warnings: [],
      rebuildResults: [],
      targetResults: [{
        target: {
          pluginName: 'demo',
          pluginId: 'official/demo',
          sourceId: 'official',
          platform: 'codex',
          scope: 'user',
          cwd: '/workspace',
        },
        action: 'cleanup',
        state: 'completed',
      }],
      overallState: 'succeeded',
      receiptTargets: [],
      codexManagerPreview: { state: 'requires-install' },
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'cleanup' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'user' as const,
      scriptTimeoutMs: 20_000,
      originIssue: {
        issueId: 'target:official/demo:codex:user:error',
        issueKey: 'sourceUnavailable\0official/demo\0\0\0\0\0official\0identity:official\0codex\0user',
        category: 'sourceUnavailable' as const,
        actionId: 'cleanup' as const,
      },
    };

    await expect(dependencies.validateIntent!(intent, new AbortController().signal))
      .resolves.toBeUndefined();
    const evidence = await dependencies.captureEvidence(intent, new AbortController().signal);
    expect(evidence).toMatchObject({
      source: { sourceId: 'official', sourceIdentity: OFFLINE_SOURCE_IDENTITY, requestedRef: 'path' },
      offlineCleanup: {
        reason: 'bundleUnavailable',
        pluginId: 'official/demo',
        targetFingerprint: expect.stringMatching(/^sha256:/u),
      },
      codexManager: {
        state: 'requires-install',
        packageName: '@openai/codex',
        version: '0.151.0',
      },
      targetFingerprint: expect.stringMatching(/^sha256:/u),
    });

    await expect(dependencies.executeIntent(intent, evidence)).resolves.toMatchObject({
      overallState: 'succeeded',
    });
    expect(runtimeMocks.cleanupWriteCommand).toHaveBeenCalledWith(
      ['official/demo'],
      expect.objectContaining({
        platform: 'codex', scope: 'user', force: false,
        allowManagedCodexInstall: true,
      }),
      expect.objectContaining({
        expectedOfflineCleanupEvidence: expect.objectContaining({
          reason: 'bundleUnavailable',
          pluginId: 'official/demo',
          targetFingerprint: expect.stringMatching(/^sha256:/u),
        }),
        managedCodexAuthorizer: expect.any(Function),
      }),
    );
    expect(runtimeMocks.cleanupWriteCommand.mock.calls.at(-1)?.[1])
      .not.toHaveProperty('scriptTimeoutMs');
    const runtime = runtimeMocks.cleanupWriteCommand.mock.calls.at(-1)?.[2];
    await expect(runtime.managedCodexAuthorizer()).resolves.toBe(true);
    expect(runtimeMocks.installWriteCommand).not.toHaveBeenCalled();
    expect(runtimeMocks.uninstallWriteCommand).not.toHaveBeenCalled();
  });

  it('binds reviewed force cleanup to one exact shallow exclusive candidate', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'runtime-force-review-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n');
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    runtimeMocks.statusCommandV7.mockResolvedValue({
      payload: {
        schemaVersion: 7,
        catalog: {
          primarySourceId: 'team', configDigest: configured.digest,
          compositeDigest: 'sha256:composite',
          sources: [{
            id: 'team', identity: 'identity:team', type: 'path', primary: true,
            requestedRef: 'path', freshness: 'active',
          }],
        },
        filters: { plugins: [], platform: 'both', cwd: isolation.layout.fixtureCwd },
        targets: [{ ...target('user', 'error'), pluginId: 'team/demo', sourceId: 'team' }],
        errors: [],
      },
      pluginSummaries: [{
        pluginId: 'team/demo', pluginName: 'demo', sourceId: 'team',
        dependencyDirectCount: 0, dependencyTotalCount: 0,
      }],
      targetRevisions: [],
    });
    const forceEvidence = {
      reason: 'bundleUnavailable' as const,
      pluginId: 'team/demo', pluginName: 'demo', sourceId: 'team',
      sourceIdentity: 'identity:team', platform: 'codex' as const, scope: 'user' as const,
      forceExclusive: true as const,
      plan: {
        schemaVersion: 1 as const, pluginId: 'team/demo', sourceIdentity: 'identity:team',
        platform: 'codex' as const, scope: 'user' as const,
        actions: [{
          action: 'removeOwnedOutput' as const, kind: 'skill-directory' as const,
          target: '/owned/demo',
        }],
      },
      planDigest: 'sha256:force', targetFingerprint: 'sha256:force',
    };
    runtimeMocks.cleanupWriteCommand.mockResolvedValue({
      platforms: ['codex'], plugins: [], warnings: [], rebuildResults: [], targetResults: [],
      overallState: 'succeeded', receiptTargets: [], offlineCleanupPlans: [forceEvidence],
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite' as const, action: 'cleanup' as const,
      pluginId: 'team/demo', platform: 'codex' as const, scope: 'user' as const, force: true,
    };

    const reviewedEvidence = await dependencies.captureEvidence(intent, new AbortController().signal);
    expect(reviewedEvidence).toMatchObject({ offlineCleanup: forceEvidence });

    const changedPlan = {
      ...forceEvidence.plan,
      actions: [{
        action: 'removeOwnedOutput' as const,
        kind: 'skill-directory' as const,
        target: '/owned/changed-demo',
      }],
    };
    runtimeMocks.cleanupWriteCommand.mockResolvedValueOnce({
      platforms: ['codex'], plugins: [], warnings: [], rebuildResults: [], targetResults: [],
      overallState: 'succeeded', receiptTargets: [],
      offlineCleanupPlans: [{
        ...forceEvidence,
        plan: changedPlan,
        planDigest: 'sha256:changed-force',
        targetFingerprint: 'sha256:changed-force',
      }],
    });
    await expect(dependencies.executeIntent(intent, reviewedEvidence))
      .rejects.toMatchObject({ code: 'operationReviewStale' });
    expect(runtimeMocks.cleanupWriteCommand).toHaveBeenCalledTimes(2);

    runtimeMocks.cleanupWriteCommand.mockResolvedValueOnce({
      platforms: ['codex'], plugins: [], warnings: [], rebuildResults: [], targetResults: [],
      overallState: 'failed', receiptTargets: [], offlineCleanupPlans: [],
    });
    await expect(dependencies.captureEvidence(intent, new AbortController().signal))
      .rejects.toMatchObject({ code: 'forceCleanupPathUnavailable' });
  });
});
