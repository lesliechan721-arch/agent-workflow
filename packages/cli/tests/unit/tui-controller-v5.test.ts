import { describe, expect, it, vi } from 'vitest';

import type { StatusV8Payload, StatusV8PluginSummary } from '../../src/commands/status-v6.js';
import { flattenStatusTargets } from '../../src/commands/status-v6.js';
import { createDependencyPlacementPlan, type DependencyOperationPlan } from '../../src/commands/dependency-operation-plan.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { createRebuildProgressFeed, type RebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import {
  TuiController,
  TuiOperationBlockedError,
  operationEvidenceMatches,
  operationEvidenceFingerprint,
  pluginWriteBatchTargets,
  pluginWriteBatchFailedRequestedPluginIds,
  pluginWriteBatchFailedRequestedTargets,
  userIssueKey,
  type OperationEvidence,
  type OperationIntent,
  type PluginWriteBatchEvidence,
  type PluginWriteBatchExecutionResult,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import {
  buildConfigPage,
  buildPlatformActions,
  buildPluginDetailActions,
  buildPluginPreviewActions,
  buildTuiViewModel,
  type PluginListItemViewModel,
} from '../../src/tui/model.js';
import { TuiRouter } from '../../src/tui/router.js';
import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';
import type { PortableInstallReceipt } from '../../src/portable/commands.js';

function source(
  id: string,
  options: { primary?: boolean; error?: string; type?: 'git' | 'path' } = {},
): StatusV8Payload['catalog']['sources'][number] {
  return {
    id,
    identity: `identity:${id}`,
    type: options.type ?? 'git',
    primary: options.primary ?? id === 'official',
    requestedRef: options.type === 'path' ? 'path' : 'refs/heads/catalog/latest',
    ...(!options.error ? { freshness: 'active' as const } : {}),
    ...(options.error ? { error: options.error, errorCode: 'catalogSourceUnavailable' } : {}),
  };
}

describe('TuiController session retirement', () => {
  it('records only successful status read time and keeps it when returning home', async () => {
    let now = 1_000;
    const value = new TuiController(dependencies({ now: () => now }));
    await value.load();
    expect(value.snapshot.statusReadAtMs).toBe(1_000);

    now = 2_000;
    value.push({ name: 'pluginList', mode: 'browse' });
    expect(value.goHome()).toBe(true);
    expect(value.snapshot.statusReadAtMs).toBe(1_000);

    const failed = new TuiController(dependencies({
      now: () => 3_000,
      loadStatus: vi.fn().mockRejectedValue(new Error('failed')),
    }));
    await failed.load();
    expect(failed.snapshot.statusReadAtMs).toBeUndefined();
  });

  it('aborts and waits for a pending local status read without interrupting a write', async () => {
    let observedSignal: AbortSignal | undefined;
    const loadStatus = vi.fn((signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<TuiStatusLoadResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('cancelled', 'AbortError'));
        }, { once: true });
      });
    });
    const value = new TuiController(dependencies({ loadStatus }));
    const loading = value.load();
    await Promise.resolve();

    await expect(value.cancelAndWaitForReads()).resolves.toBe(true);
    await loading;

    expect(observedSignal?.aborted).toBe(true);
    expect(value.hasActiveWrite).toBe(false);
  });

  it('closes new read and write entry points before draining existing reads', async () => {
    const pending = deferred<TuiStatusLoadResult>();
    const getConfigPage = vi.fn();
    const executeIntent = vi.fn();
    const value = new TuiController(dependencies({
      loadStatus: vi.fn(() => pending.promise),
      getConfigPage,
      executeIntent,
    }));
    const loading = value.load();
    await Promise.resolve();
    value.beginRetirement();

    await expect(value.getConfigPage('official/demo', { scope: 'user' }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(value.executeOperation('missing')).resolves.toMatchObject({
      state: 'blocked', code: 'sessionRetiring',
    });
    expect(getConfigPage).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();

    pending.resolve({ payload: status(), pluginSummaries: summaries(['official', 'demo']) });
    await loading;
    await expect(value.cancelAndWaitForReads()).resolves.toBe(true);
  });
});

describe('TUI plugin write batches', () => {
  it('enumerates exact targets from intent, ownership, and Codex activation evidence', () => {
    const codex = target({ pluginName: 'native', platform: 'codex', scope: 'user', state: 'present' });
    codex.placements[0]!.components.push(
      { kind: 'intent', key: 'desired', state: 'desired', metadata: {
        enabled: true, scopes: ['user'], relation: 'root',
      } },
      { kind: 'activation', key: 'user', state: 'enabled', metadata: { evidence: 'observed' } },
    );
    codex.placements.push({
      scope: 'project', state: 'ready',
      components: [
        { kind: 'intent', key: 'desired', state: 'desired', metadata: {
          enabled: true, scopes: ['project'], relation: 'root',
        } },
        { kind: 'ownership', key: 'fixture-project', state: 'present' },
        { kind: 'activation', key: 'project', state: 'enabled', metadata: { evidence: 'observed' } },
      ],
      reasons: [], recoveryActions: [],
    });
    codex.components.push({ kind: 'sharedNative', key: 'native@aw-official', state: 'usable' });
    const claude = target({ pluginName: 'native', platform: 'claude', scope: 'project', state: 'present' });
    claude.components.push({ kind: 'intent', key: 'desired', state: 'desired', metadata: {
      enabled: true, scopes: ['project'], relation: 'root',
    } });
    const supportedButAbsent = target({
      pluginName: 'native', platform: 'claude', scope: 'user', state: 'absent',
    });
    const targets = [codex, claude, supportedButAbsent];

    const placements = flattenStatusTargets(targets);
    expect(pluginWriteBatchTargets('sync', ['official/native'], placements)).toEqual([
      { pluginId: 'official/native', platform: 'claude', scope: 'project' },
      { pluginId: 'official/native', platform: 'codex', scope: 'project' },
      { pluginId: 'official/native', platform: 'codex', scope: 'user' },
    ]);
    expect(pluginWriteBatchTargets('uninstall', ['official/native'], placements)).toEqual([
      { pluginId: 'official/native', platform: 'claude', scope: 'project' },
      { pluginId: 'official/native', platform: 'codex', scope: 'project' },
      { pluginId: 'official/native', platform: 'codex', scope: 'user' },
    ]);
    expect(pluginWriteBatchTargets('cleanup', ['official/native'], placements)).toEqual([
      { pluginId: 'official/native', platform: 'claude', scope: 'project' },
      { pluginId: 'official/native', platform: 'codex', scope: 'project' },
      { pluginId: 'official/native', platform: 'codex', scope: 'user' },
    ]);
  });

  it('keeps both configured Codex activations when the system probe is unavailable', () => {
    const codex = target({ pluginName: 'native', platform: 'codex', scope: 'user', state: 'present' });
    codex.placements[0]!.components.push(
      { kind: 'activation', key: 'user', state: 'enabled', metadata: { evidence: 'assumed' } },
    );
    codex.placements.push({
      scope: 'project', state: 'ready',
      components: [
        { kind: 'ownership', key: 'fixture-project', state: 'present' },
        { kind: 'activation', key: 'project', state: 'enabled', metadata: { evidence: 'assumed' } },
      ],
      reasons: [], recoveryActions: [],
    });
    codex.components.push({ kind: 'sharedNative', key: 'native@aw-official', state: 'usable' });

    expect(pluginWriteBatchTargets('cleanup', ['official/native'], flattenStatusTargets([codex]))).toEqual([
      { pluginId: 'official/native', platform: 'codex', scope: 'project' },
      { pluginId: 'official/native', platform: 'codex', scope: 'user' },
    ]);
  });

  function failedBatchResult(
    targetResults: Array<Record<string, unknown>>,
  ): PluginWriteBatchExecutionResult {
    const result = {
      platforms: ['codex'], plugins: [], warnings: [], rebuildResults: [], targetResults,
      overallState: 'failed', receiptTargets: [],
    } as unknown as PluginWriteBatchExecutionResult['groupResults'][number]['result'];
    return {
      ...result,
      requestedPluginIds: ['official/root-a', 'official/root-b'],
      groupResults: [{
        groupId: 'official\0codex', sourceId: 'official', platform: 'codex',
        scope: 'project',
        requestedPluginIds: ['official/root-a', 'official/root-b'], result,
      }],
    };
  }

  it('maps requested and dependency failures back to the affected roots', () => {
    const execution = failedBatchResult([
      { target: { pluginId: 'official/root-a', platform: 'codex', scope: 'project' },
        action: 'sync', state: 'failed', requiredBy: [] },
      { target: { pluginId: 'official/dependency', platform: 'codex', scope: 'project' },
        action: 'sync', state: 'failed', requiredBy: ['official/root-b'] },
    ]);
    expect(pluginWriteBatchFailedRequestedPluginIds(execution)).toEqual([
      'official/root-a', 'official/root-b',
    ]);
  });

  it('does not claim a precise retry when a failed group has no target evidence', () => {
    expect(pluginWriteBatchFailedRequestedPluginIds(failedBatchResult([]))).toEqual([]);
    expect(pluginWriteBatchFailedRequestedTargets(failedBatchResult([]))).toEqual([]);
  });

  it('keeps platform-specific failed roots and excludes successful root targets', () => {
    const codex = failedBatchResult([
      { target: { pluginId: 'official/root-a', platform: 'codex', scope: 'project' },
        action: 'sync', state: 'completed', requiredBy: [] },
      { target: { pluginId: 'official/root-b', platform: 'codex', scope: 'project' },
        action: 'sync', state: 'failed', requiredBy: [] },
    ]).groupResults[0]!;
    const claude = failedBatchResult([
      { target: { pluginId: 'official/root-a', platform: 'claude', scope: 'project' },
        action: 'sync', state: 'failed', requiredBy: [] },
      { target: { pluginId: 'official/root-b', platform: 'claude', scope: 'project' },
        action: 'sync', state: 'completed', requiredBy: [] },
    ]).groupResults[0]!;
    const execution = {
      ...failedBatchResult([]),
      groupResults: [
        { ...codex, groupId: 'official\0codex', platform: 'codex' as const },
        { ...claude, groupId: 'official\0claude', platform: 'claude' as const },
      ],
    };
    expect(pluginWriteBatchFailedRequestedTargets(execution)).toEqual([
      { pluginId: 'official/root-a', platform: 'claude', scope: 'project' },
      { pluginId: 'official/root-b', platform: 'codex', scope: 'project' },
    ]);
  });

  it('aggregates all requested roots, dependencies, timeout, and shared confirmation', () => {
    const dependencyPlan = {
      requestedPluginIds: ['official/root-a', 'official/root-b'],
      resolvedPluginIds: ['official/dependency', 'official/root-a', 'official/root-b'],
      dependencyEdges: [
        { from: 'official/root-a', to: 'official/dependency', platform: 'codex' },
        { from: 'official/root-b', to: 'official/dependency', platform: 'codex' },
      ],
      scopeOverrides: [],
      targets: [
        { pluginId: 'official/root-a', pluginName: 'root-a', platform: 'codex', relation: 'requested',
          depth: 0, requiredBy: [], resolvedScope: 'project', action: 'install', assignmentSource: 'root' },
        { pluginId: 'official/root-b', pluginName: 'root-b', platform: 'codex', relation: 'requested',
          depth: 0, requiredBy: [], resolvedScope: 'project', action: 'install', assignmentSource: 'root' },
        { pluginId: 'official/dependency', pluginName: 'dependency', platform: 'codex', relation: 'dependency',
          depth: 1, requiredBy: ['official/root-a', 'official/root-b'], resolvedScope: 'project',
          action: 'install', assignmentSource: 'default' },
      ],
    } as unknown as NonNullable<OperationEvidence['dependencyPlan']>;
    const preview = {
      platforms: ['codex'], plugins: [], warnings: [], rebuildResults: [], targetResults: [],
      overallState: 'succeeded', receiptTargets: [], dependencyPlan,
      operationPlan: {
        planFingerprint: 'sha256:group-plan',
        actions: [{
          kind: 'runPreApply', pluginId: 'official/dependency', platform: 'codex',
          scope: 'project', script: 'scripts/preApply.mjs',
        }],
      },
      codexReconcilePlans: [{
        sharedNativeActions: [],
        activationActions: { user: [], project: [] },
        extensionWrites: [], extensionRemovals: [],
        review: {
          requiresConfirmation: true,
          sharedImpact: { pluginIds: ['shared/native'], warning: '会影响其它项目。' },
        },
      }],
      codexManagerPreview: { state: 'requires-install' },
    } as unknown as PluginWriteBatchEvidence['groups'][number]['preview'];
    const evidence: PluginWriteBatchEvidence = {
      ...baseEvidence,
      requestedPluginIds: ['official/root-a', 'official/root-b'],
      groups: [{
        groupId: 'official\0codex', sourceId: 'official', platform: 'codex',
        scope: 'project',
        requestedPluginIds: ['official/root-a', 'official/root-b'], preview, executable: true,
      }],
      targetVersions: [
        {
          pluginId: 'official/root-a', platform: 'codex', scope: 'project',
          presence: 'installed', availableVersion: '2.0.0',
        },
        {
          pluginId: 'official/root-b', platform: 'codex', scope: 'project',
          presence: 'new', availableVersion: '2.0.0',
        },
      ],
    };

    const review = buildOperationReviewProjection({
      intent: {
        kind: 'pluginWriteBatch', action: 'install',
        selection: { kind: 'selected', pluginIds: evidence.requestedPluginIds },
        platform: 'codex', scope: 'project', scriptTimeoutMs: 12_000,
      },
      evidence,
    });

    expect(review.requiresConfirmation).toBe(true);
    expect(review.sharedImpact.pluginIds).toEqual(['shared/native']);
    expect(review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'official/root-a', relation: 'requested', sourceId: 'official' }),
      expect.objectContaining({ pluginId: 'official/root-b', relation: 'requested', sourceId: 'official' }),
      expect.objectContaining({ pluginId: 'official/dependency', relation: 'direct', sourceId: 'official' }),
      expect.objectContaining({ title: 'preApply 脚本超时', description: '12000 ms' }),
      expect.objectContaining({
        title: '运行 official/dependency preApply',
        pluginId: 'official/dependency',
        relation: 'direct',
      }),
      expect.objectContaining({ title: '获取 Codex 运行组件' }),
      expect.objectContaining({
        pluginId: 'official/root-a', description: expect.stringContaining('已有安装，版本待确认'),
      }),
      expect.objectContaining({
        pluginId: 'official/root-b', description: expect.stringContaining('新增当前项目安装'),
      }),
    ]));
  });

  it('identifies a missing saved user target as an all-project installation in Review', () => {
    const evidence: PluginWriteBatchEvidence = {
      ...baseEvidence,
      requestedPluginIds: ['official/root'],
      groups: [{
        groupId: 'official\0codex\0user', sourceId: 'official', platform: 'codex', scope: 'user',
        requestedPluginIds: ['official/root'], executable: true,
        preview: {
          platforms: ['codex'], plugins: ['official/root'], warnings: [], rebuildResults: [],
          targetResults: [{
            target: { pluginId: 'official/root', pluginName: 'root', platform: 'codex', scope: 'user' },
            action: 'sync', state: 'completed', requiredBy: [],
          }],
          overallState: 'succeeded', receiptTargets: [],
          operationPlan: { planFingerprint: 'sha256:user-plan' },
        } as unknown as PluginWriteBatchEvidence['groups'][number]['preview'],
      }],
      targetVersions: [{
        pluginId: 'official/root', platform: 'codex', scope: 'user',
        presence: 'new', availableVersion: '2.0.0',
      }],
    };
    const review = buildOperationReviewProjection({
      intent: {
        kind: 'pluginWriteBatch', action: 'sync', platform: 'codex', scope: 'user',
        selection: { kind: 'targets', targets: [{
          pluginId: 'official/root', platform: 'codex', scope: 'user',
        }] },
      },
      evidence,
    });
    const requested = review.changes.find((change) => change.pluginId === 'official/root');
    expect(requested?.description).toContain('新增所有项目安装');
    expect(requested?.description).not.toContain('新增当前项目安装');
  });

  it('uses each exact target scope in a mixed-scope batch Review', () => {
    const preview = (pluginId: string, platform: 'codex' | 'claude', scope: 'project' | 'user') => ({
      platforms: [platform], plugins: [pluginId], warnings: [], rebuildResults: [],
      targetResults: [{
        target: { pluginId, pluginName: pluginId.split('/')[1]!, platform, scope },
        action: 'uninstall', state: 'completed', requiredBy: [],
      }],
      overallState: 'succeeded', receiptTargets: [],
      operationPlan: { planFingerprint: `sha256:${platform}-${scope}` },
    } as unknown as PluginWriteBatchEvidence['groups'][number]['preview']);
    const evidence: PluginWriteBatchEvidence = {
      ...baseEvidence,
      requestedPluginIds: ['official/project-root', 'official/user-root'],
      groups: [
        {
          groupId: 'official\0codex\0project', sourceId: 'official', platform: 'codex',
          scope: 'project', requestedPluginIds: ['official/project-root'],
          preview: preview('official/project-root', 'codex', 'project'), executable: true,
        },
        {
          groupId: 'official\0claude\0user', sourceId: 'official', platform: 'claude',
          scope: 'user', requestedPluginIds: ['official/user-root'],
          preview: preview('official/user-root', 'claude', 'user'), executable: true,
        },
      ],
    };
    const review = buildOperationReviewProjection({
      intent: {
        kind: 'pluginWriteBatch', action: 'uninstall',
        selection: {
          kind: 'targets',
          targets: [
            { pluginId: 'official/project-root', platform: 'codex', scope: 'project' },
            { pluginId: 'official/user-root', platform: 'claude', scope: 'user' },
          ],
        },
        platform: 'codex', scope: 'project',
      },
      evidence,
    });

    expect(review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'official/project-root', description: 'official · Codex · 当前项目',
      }),
      expect.objectContaining({
        pluginId: 'official/user-root', description: 'official · Claude Code · 所有项目',
      }),
    ]));
  });

  it('shows the preApply plugin identity in a normal write Review', () => {
    const review = buildOperationReviewProjection({
      intent: {
        kind: 'pluginWrite', action: 'sync', pluginId: 'official/root',
        platform: 'codex', scope: 'project',
      },
      evidence: {
        ...baseEvidence,
        operationPlan: {
          planFingerprint: 'sha256:normal-plan',
          actions: [{
            kind: 'runPreApply', pluginId: 'official/dependency', platform: 'codex',
            scope: 'project', script: 'scripts/preApply.mjs',
          }],
        } as unknown as NonNullable<OperationEvidence['operationPlan']>,
      },
    });

    expect(review.changes).toContainEqual(expect.objectContaining({
      title: '运行 official/dependency preApply',
      pluginId: 'official/dependency',
    }));
    expect(review.equivalentCommand).toContain('--yes');
  });

  it('owns one batch flow and finishes it at the installed plugin list', () => {
    const router = new TuiRouter();
    router.push({ name: 'pluginList', mode: 'browse' }, { query: 'tool', focusIndex: 2 });
    const flow = router.beginBatchFlow();
    router.push({ name: 'batchSelection' });
    router.push({ name: 'batchPlacement' });
    expect(flow).toMatchObject({
      kind: 'batchWrite', returnTarget: { name: 'pluginList', mode: 'browse' },
    });
    router.finishFlow(undefined, { name: 'result', operationId: 'batch-1' });
    router.back();
    expect(router.snapshot.current.route).toEqual({ name: 'pluginList', mode: 'browse' });
  });

  it('keeps one history record without offering an imprecise group retry', async () => {
    const preview = failedBatchResult([]).groupResults[0]!.result;
    const evidence: PluginWriteBatchEvidence = {
      ...baseEvidence,
      requestedPluginIds: ['official/root-a', 'official/root-b'],
      groups: [{
        groupId: 'official\0codex', sourceId: 'official', platform: 'codex',
        scope: 'project',
        requestedPluginIds: ['official/root-a', 'official/root-b'], preview, executable: false,
      }],
    };
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const executeIntent = vi.fn().mockResolvedValue(failedBatchResult([]));
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status(),
        pluginSummaries: summaries(['official', 'root-a'], ['official', 'root-b']),
      }),
      captureEvidence,
      executeIntent,
    }));
    await controller.load();
    controller.push({ name: 'pluginList', mode: 'browse' });
    controller.beginPluginWriteBatch();
    controller.push({ name: 'batchPlacement' });
    const review = await controller.buildOperationReview({
      kind: 'pluginWriteBatch', action: 'sync',
      selection: { kind: 'selected', pluginIds: ['official/root-b', 'official/root-a'] },
      platform: 'codex', scope: 'project',
    });
    expect(review).toMatchObject({
      operationKind: 'pluginWriteBatch', batch: { groupCount: 1, executableGroupCount: 0 },
    });
    const result = await controller.executeOperation(review.reviewToken);
    expect(result).toMatchObject({
      state: 'blocked',
      summary: { batch: { failedRequestedPluginIds: [], retryTargets: [] } },
    });
    expect(controller.listOperationHistory()).toHaveLength(1);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(captureEvidence.mock.calls[0]?.[0]).toMatchObject({
      selection: { kind: 'selected', pluginIds: ['official/root-a', 'official/root-b'] },
    });

    const retry = controller.retryFailedPluginWriteBatch();
    expect(retry).toBeUndefined();
    await nextTurn(2);
    expect(captureEvidence).toHaveBeenCalledTimes(1);
  });

  it('keeps completed group effects when a later stale group becomes a partial result', async () => {
    const completedTarget = {
      target: {
        pluginId: 'official/root-a', pluginName: 'root-a',
        platform: 'codex', scope: 'project',
      },
      action: 'sync', state: 'completed', requiredBy: [],
    };
    const staleTarget = {
      target: {
        pluginId: 'team/root-b', pluginName: 'root-b',
        platform: 'codex', scope: 'project',
      },
      action: 'sync', state: 'failed', requiredBy: [], errorCode: 'operationReviewStale',
    };
    const groupResult = (
      overallState: 'succeeded' | 'failed',
      targetResults: Array<Record<string, unknown>>,
    ): PluginWriteBatchExecutionResult['groupResults'][number]['result'] => ({
      platforms: ['codex'], plugins: [], warnings: [], rebuildResults: [], targetResults,
      overallState, receiptTargets: [],
    } as unknown as PluginWriteBatchExecutionResult['groupResults'][number]['result']);
    const completed = groupResult('succeeded', [completedTarget]);
    const stale = groupResult('failed', [staleTarget]);
    const execution = {
      platforms: ['codex'], plugins: [], warnings: [], rebuildResults: [],
      targetResults: [completedTarget, staleTarget], overallState: 'partial', receiptTargets: [],
      requestedPluginIds: ['official/root-a', 'team/root-b'],
      groupResults: [
        { groupId: 'official\0codex', sourceId: 'official', platform: 'codex',
          scope: 'project',
          requestedPluginIds: ['official/root-a'], result: completed },
        { groupId: 'team\0codex', sourceId: 'team', platform: 'codex',
          scope: 'project',
          requestedPluginIds: ['team/root-b'], result: stale },
      ],
    } as unknown as PluginWriteBatchExecutionResult;
    const preview = (fingerprint: string) => ({
      platforms: ['codex'], plugins: [], warnings: [], rebuildResults: [], targetResults: [],
      overallState: 'succeeded', receiptTargets: [],
      operationPlan: { planFingerprint: fingerprint },
    } as unknown as PluginWriteBatchEvidence['groups'][number]['preview']);
    const evidence: PluginWriteBatchEvidence = {
      ...baseEvidence,
      requestedPluginIds: ['official/root-a', 'team/root-b'],
      groups: [
        { groupId: 'official\0codex', sourceId: 'official', platform: 'codex',
          scope: 'project',
          requestedPluginIds: ['official/root-a'], preview: preview('sha256:official'), executable: true },
        { groupId: 'team\0codex', sourceId: 'team', platform: 'codex',
          scope: 'project',
          requestedPluginIds: ['team/root-b'], preview: preview('sha256:team'), executable: true },
      ],
    };
    const retryEvidence: PluginWriteBatchEvidence = {
      ...baseEvidence,
      requestedPluginIds: ['team/root-b'],
      groups: [{ groupId: 'team\0codex', sourceId: 'team', platform: 'codex',
        scope: 'project',
        requestedPluginIds: ['team/root-b'], preview: preview('sha256:team-retry'), executable: true }],
    };
    const captureEvidence = vi.fn()
      .mockResolvedValueOnce(evidence)
      .mockResolvedValueOnce(retryEvidence);
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status(),
        pluginSummaries: summaries(['official', 'root-a'], ['team', 'root-b']),
      }),
      captureEvidence,
      executeIntent: vi.fn().mockResolvedValue(execution),
    }));
    await controller.load();
    controller.push({ name: 'pluginList', mode: 'installed' });
    controller.beginPluginWriteBatch();
    controller.push({ name: 'batchPlacement' });
    const review = await controller.buildOperationReview({
      kind: 'pluginWriteBatch', action: 'sync',
      selection: { kind: 'selected', pluginIds: ['official/root-a', 'team/root-b'] },
      platform: 'codex', scope: 'project',
    });

    const result = await controller.executeOperation(review.reviewToken);
    expect(result).toMatchObject({
      state: 'partial',
      summary: { batch: {
        failedRequestedPluginIds: ['team/root-b'],
        rootResults: [
          expect.objectContaining({ pluginId: 'official/root-a', state: 'completed' }),
          expect.objectContaining({ pluginId: 'team/root-b', state: 'failed' }),
        ],
      } },
    });
    const history = controller.listOperationHistory();
    expect(history).toHaveLength(1);
    expect(controller.getOperationDiagnostic(history[0]!.recordId)?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: 'official/root-a', state: 'completed',
          effects: expect.objectContaining({ awWrite: 'completed' }),
        }),
        expect.objectContaining({
          pluginId: 'team/root-b', state: 'failed', errorCode: 'operationReviewStale',
        }),
      ]),
    );

    expect(controller.retryFailedPluginWriteBatch()?.operationKind).toBe('pluginWriteBatch');
    await nextTurn();
    expect(captureEvidence.mock.calls[1]?.[0]).toMatchObject({
      selection: {
        kind: 'targets',
        targets: [{ pluginId: 'team/root-b', platform: 'codex', scope: 'project' }],
      },
    });
    expect(controller.snapshot.activeReview?.operationId).not.toBe(review.operationId);
  });

  it('counts one canonical failed root with two exact failed targets', async () => {
    const failedTarget = (platform: 'codex' | 'claude') => ({
      target: {
        pluginId: 'official/root', pluginName: 'root', platform, scope: 'project' as const,
      },
      action: 'sync', state: 'failed' as const, requiredBy: [], errorCode: 'preApplyFailed',
    });
    const groupResult = (platform: 'codex' | 'claude') => ({
      platforms: [platform], plugins: [], warnings: [], rebuildResults: [],
      targetResults: [failedTarget(platform)], overallState: 'failed', receiptTargets: [],
    } as unknown as PluginWriteBatchExecutionResult['groupResults'][number]['result']);
    const execution = {
      ...groupResult('codex'),
      targetResults: [failedTarget('codex'), failedTarget('claude')],
      requestedPluginIds: ['official/root'],
      groupResults: (['codex', 'claude'] as const).map((platform) => ({
        groupId: `official\0${platform}\0project`, sourceId: 'official', platform,
        scope: 'project' as const, requestedPluginIds: ['official/root'],
        result: groupResult(platform),
      })),
    } as unknown as PluginWriteBatchExecutionResult;
    const preview = groupResult('codex');
    const evidence: PluginWriteBatchEvidence = {
      ...baseEvidence,
      requestedPluginIds: ['official/root'],
      groups: (['codex', 'claude'] as const).map((platform) => ({
        groupId: `official\0${platform}\0project`, sourceId: 'official', platform,
        scope: 'project', requestedPluginIds: ['official/root'], preview, executable: false,
      })),
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      executeIntent: vi.fn().mockResolvedValue(execution),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWriteBatch', action: 'sync',
      selection: {
        kind: 'targets',
        targets: [
          { pluginId: 'official/root', platform: 'codex', scope: 'project' },
          { pluginId: 'official/root', platform: 'claude', scope: 'project' },
        ],
      },
      platform: 'codex', scope: 'project',
    });
    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      summary: { batch: {
        failedRequestedPluginIds: ['official/root'],
        retryTargets: [
          { pluginId: 'official/root', platform: 'claude', scope: 'project' },
          { pluginId: 'official/root', platform: 'codex', scope: 'project' },
        ],
        rootResults: [{
          pluginId: 'official/root', state: 'failed',
          targets: [
            expect.objectContaining({ platform: 'claude', scope: 'project', state: 'failed' }),
            expect.objectContaining({ platform: 'codex', scope: 'project', state: 'failed' }),
          ],
        }],
      } },
    });
  });
});

function sourceDetail(
  id: string,
  options: { autoCheck?: boolean; primary?: boolean; explicitRef?: string } = {},
): NonNullable<TuiStatusLoadResult['sourceDetails']>[number] {
  return {
    id,
    type: 'git',
    primary: options.primary ?? id === 'official',
    autoCheck: options.autoCheck ?? true,
    locationSummary: `https://example.test/${id}.git`,
    refPolicy: options.explicitRef ? 'explicit' : 'cliChannel',
    ...(options.explicitRef ? { explicitRef: options.explicitRef } : {}),
    pluginCount: 0,
    sourceIdentity: `identity:${id}`,
    requestedRef: options.explicitRef ?? 'refs/heads/catalog/latest',
    configDigest: 'sha256:config',
  };
}

function status(options: {
  sources?: StatusV8Payload['catalog']['sources'];
  targets?: StatusV8Payload['targets'];
  errors?: StatusV8Payload['errors'];
} = {}): StatusV8Payload {
  return {
    schemaVersion: 8,
    catalog: {
      primarySourceId: 'official',
      configDigest: 'sha256:config',
      compositeDigest: 'sha256:composite',
      sources: options.sources ?? [source('official')],
    },
    filters: { plugins: [], platform: 'both', cwd: '/workspace' },
    targets: options.targets ?? [],
    errors: options.errors ?? [],
  };
}

function target(options: {
  pluginName?: string;
  sourceId?: string;
  platform?: 'codex' | 'claude';
  scope: 'user' | 'project';
  state: 'present' | 'absent' | 'partial' | 'error';
  errorCode?: string;
  errors?: StatusV8Payload['targets'][number]['reasons'];
  recoveryActions?: StatusV8Payload['targets'][number]['recoveryActions'];
}): StatusV8Payload['targets'][number] {
  const pluginName = options.pluginName ?? 'demo';
  const sourceId = options.sourceId ?? 'official';
  const state = options.state === 'present'
    ? 'ready' as const
    : options.state === 'partial'
      ? 'needsSync' as const
      : options.state === 'error' ? 'blocked' as const : 'absent' as const;
  const placement = {
    scope: options.scope,
    state,
    components: [{ kind: 'ownership' as const, key: 'fixture', state: options.state }],
    reasons: options.errors
      ?? (options.state === 'error' ? [{ code: options.errorCode ?? 'targetError', message: 'safe failure', severity: 'blocking' as const }] : []),
    recoveryActions: options.recoveryActions ?? [],
  };
  const identity = {
    pluginName,
    sourceId,
    sourceIdentity: `identity:${sourceId}`,
    pluginId: `${sourceId}/${pluginName}`,
    version: '1.0.0',
    cwd: '/workspace',
  };
  if (options.platform === 'claude') {
    return { ...identity, platform: 'claude', ...placement };
  }
  return {
    ...identity,
    platform: 'codex',
    state: placement.state,
    components: [],
    reasons: placement.reasons,
    recoveryActions: placement.recoveryActions,
    placements: [placement],
  };
}

function summaries(...entries: Array<[string, string]>): StatusV8PluginSummary[] {
  return entries.map(([sourceId, pluginName]) => ({
    pluginName,
    pluginId: `${sourceId}/${pluginName}`,
    description: `${sourceId} description`,
  }));
}

const baseEvidence: OperationEvidence = {
  catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
  source: {
    sourceId: 'official',
    sourceIdentity: 'identity:official',
    snapshotDigest: 'sha256:snapshot',
    contentDigest: 'sha256:content',
  },
  targetFingerprint: 'sha256:target',
};

function defaultConfigEvidence(scope: 'user' | 'project'): OperationEvidence {
  return {
    ...baseEvidence,
    config: {
      scope,
      storeDigest: 'sha256:store',
      impactState: 'known',
      affectedTargets: [],
    },
  };
}

function dependencies(overrides: Partial<TuiControllerDependencies> = {}): TuiControllerDependencies {
  return {
    loadStatus: vi.fn().mockResolvedValue({
      payload: status(),
      pluginSummaries: summaries(['official', 'demo']),
    }),
    captureEvidence: vi.fn(async (intent: OperationIntent) => intent.kind === 'configSave'
      ? defaultConfigEvidence(intent.scope) : baseEvidence),
    executeIntent: vi.fn().mockResolvedValue({ ok: true }),
    createToken: vi.fn()
      .mockReturnValueOnce('operation-1')
      .mockReturnValueOnce('review-1')
      .mockReturnValueOnce('operation-2')
      .mockReturnValueOnce('review-2'),
    now: () => 1_000,
    ...overrides,
  };
}

function menuPlugin(overrides: Partial<PluginListItemViewModel> = {}): PluginListItemViewModel {
  return {
    pluginId: 'official/demo',
    sourceId: 'official',
    displayName: 'Demo',
    description: 'Demo plugin',
    version: '2.0.0',
    configFieldCount: 0,
    sourceLabel: 'Official',
    supportedPlatforms: ['codex'],
    installedPlacements: [{ platform: 'codex', state: 'notInstalled', supportedScopes: ['user', 'project'] }],
    aggregateStatus: 'available',
    portableSkills: false,
    savedConfigScopes: [],
    dependencySummary: {
      directCount: 0, transitiveCount: 0, totalCount: 0,
      readyCount: 0, missingCount: 0, issueCount: 0,
    },
    technicalComponents: [],
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function portableReceipt(options: {
  status?: PortableInstallReceipt['status'];
  scope?: 'project' | 'user';
  agentMode?: 'automatic' | 'explicit';
  records?: PortableInstallReceipt['verification']['records'];
  missing?: PortableInstallReceipt['verification']['missing'];
  unknown?: NonNullable<PortableInstallReceipt['verification']['unknown']>;
} = {}): PortableInstallReceipt {
  const statusValue = options.status ?? 'partial';
  const unknown = options.unknown ?? [{ skill: 'review', agent: 'cursor' }];
  return {
    receiptSchemaVersion: 5,
    command: 'skill:install',
    ok: statusValue === 'succeeded',
    status: statusValue,
    plugin: { id: 'official/demo', sourceId: 'official', version: '1.0.0' },
    scope: options.scope ?? 'user',
    selectedSkills: [{
      name: 'review', description: 'Review changes', providerPluginId: 'official/demo',
      providerDisplayName: 'Demo', relation: 'requested', dynamic: false,
      filesDigest: 'sha256:skill',
    }],
    requestedSkills: ['review'],
    agentMode: options.agentMode ?? 'explicit',
    requestedAgents: options.agentMode === 'automatic' ? [] : ['cursor'],
    skillsCliVersion: '1.0.0',
    collisions: [],
    dependencies: [],
    materializationDigest: 'sha256:materialization',
    verification: {
      records: options.records ?? [],
      missing: options.missing ?? [],
      ...(unknown.length > 0 ? { unknown } : {}),
    },
    warnings: unknown.length > 0 ? ['结果未知。'] : [],
    failures: unknown.length > 0 ? [{
      code: 'portableSkillsCliVerificationFailed',
      message: '结果未知。',
      recovery: '重新检查。',
    }] : [],
  };
}

function portableEvidence(receipt: PortableInstallReceipt): OperationEvidence {
  return {
    ...baseEvidence,
    portable: {
      pluginId: receipt.plugin.id,
      sourceId: receipt.plugin.sourceId,
      pluginVersion: receipt.plugin.version,
      scope: receipt.scope,
      selected: receipt.selectedSkills,
      requestedSkills: receipt.requestedSkills,
      agentMode: receipt.agentMode,
      requestedAgents: receipt.requestedAgents,
      skillsCliVersion: receipt.skillsCliVersion,
      collisions: receipt.collisions,
      dependencies: receipt.dependencies,
      materializationDigest: receipt.materializationDigest,
      configDigest: 'sha256:config',
      evidenceDigest: 'sha256:evidence',
      generationSetDigest: 'sha256:generation',
    },
  };
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('Portable result recheck lifecycle', () => {
  async function resultController(recheck: TuiControllerDependencies['recheckPortableInstall']) {
    const initial = portableReceipt();
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(portableEvidence(initial)),
      executeIntent: vi.fn().mockResolvedValue(initial),
      recheckPortableInstall: recheck,
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'portableInstall', pluginId: 'official/demo', scope: 'user',
      selectedSkills: ['review'], requestedAgents: ['cursor'],
    });
    await controller.executeOperation(review.reviewToken);
    return controller;
  }

  it.each([
    ['user', 'automatic'],
    ['user', 'explicit'],
    ['project', 'automatic'],
    ['project', 'explicit'],
  ] as const)('keeps authorized %s/%s intent metadata on a blocked result without verification facts', async (
    scope,
    agentMode,
  ) => {
    const fixture = portableReceipt({ scope, agentMode, unknown: [] });
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(portableEvidence(fixture)),
      executeIntent: vi.fn().mockRejectedValue(new TuiOperationBlockedError(
        'portableSkillsCliMissing',
        'Skills CLI is unavailable.',
      )),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'portableInstall', pluginId: 'official/demo', scope,
      selectedSkills: ['review'],
      ...(agentMode === 'explicit' ? { requestedAgents: ['cursor'] } : {}),
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'blocked',
      operationKind: 'portableInstall',
      pluginId: 'official/demo',
      portableIntent: { scope, agentMode },
    });
    expect(result).not.toHaveProperty('summary.portable');
    expect(result).not.toHaveProperty('verification');
    expect(controller.snapshot.result?.portableIntent).toEqual({ scope, agentMode });
  });

  it('single-flights a valid recheck and updates the same result and history identity', async () => {
    const pending = deferred<PortableInstallReceipt>();
    const recheck = vi.fn(() => pending.promise);
    const controller = await resultController(recheck);
    const before = structuredClone(controller.snapshot.result!);
    const beforeRecord = controller.getOperationDiagnostic(before.operationRecordId!)!;

    const first = controller.recheckPortableResult();
    const second = controller.recheckPortableResult();
    expect(recheck).toHaveBeenCalledTimes(1);
    pending.resolve(portableReceipt({
      status: 'succeeded',
      records: [{ name: 'review', agents: ['cursor'] }],
      unknown: [],
    }));
    await Promise.all([first, second]);

    expect(controller.snapshot.result).toMatchObject({
      state: 'succeeded',
      operationId: before.operationId,
      operationRecordId: before.operationRecordId,
      effects: {
        awWrite: before.effects?.awWrite,
        preApplyExternalEffect: before.effects?.preApplyExternalEffect,
        finalVerification: 'completed',
      },
      summary: {
        portable: { verified: [{ name: 'review', agents: ['cursor'] }], unknown: [] },
        diagnosticIds: before.summary?.diagnosticIds,
      },
    });
    expect(controller.listOperationHistory()).toHaveLength(1);
    expect(controller.getOperationDiagnostic(before.operationRecordId!)).toMatchObject({
      summary: {
        recordId: beforeRecord.summary.recordId,
        operationId: beforeRecord.summary.operationId,
        createdAtMs: beforeRecord.summary.createdAtMs,
        state: 'succeeded',
        effects: { finalVerification: 'completed' },
      },
      diagnostics: beforeRecord.diagnostics,
    });
  });

  it.each([
    ['home', (controller: TuiController) => controller.goHome()],
    ['escape', (controller: TuiController) => controller.leaveResult()],
    ['leave and re-enter', (controller: TuiController) => {
      controller.push({ name: 'sourceList' });
      controller.back();
    }],
    ['new operation', (controller: TuiController) => controller.startReviewPreparation({
      kind: 'pluginWrite', action: 'sync', pluginId: 'official/demo',
      platform: 'codex', scope: 'user',
    })],
    ['retirement', (controller: TuiController) => controller.beginRetirement()],
    ['dispose', (controller: TuiController) => controller.dispose()],
  ] as const)('discards a late recheck success after %s', async (_label, leave) => {
    const pending = deferred<PortableInstallReceipt>();
    const controller = await resultController(vi.fn(() => pending.promise));
    const record = structuredClone(controller.listOperationHistory());
    const checking = controller.recheckPortableResult();

    leave(controller);
    pending.resolve(portableReceipt({
      status: 'succeeded', records: [{ name: 'review', agents: ['cursor'] }], unknown: [],
    }));
    await expect(checking).resolves.toMatchObject({ status: 'partial' });

    expect(controller.listOperationHistory()).toEqual(record);
    if (_label !== 'dispose') {
      expect(controller.snapshot.result?.summary.portable?.verified ?? []).toEqual([]);
    }
  });

  it('swallows a late recheck failure after leaving the result', async () => {
    const pending = deferred<PortableInstallReceipt>();
    const controller = await resultController(vi.fn(() => pending.promise));
    const record = structuredClone(controller.listOperationHistory());
    const checking = controller.recheckPortableResult();

    controller.leaveResult();
    pending.reject(new Error('late private read failure'));

    await expect(checking).resolves.toMatchObject({ status: 'partial' });
    expect(controller.listOperationHistory()).toEqual(record);
    expect(controller.snapshot.result).toBeUndefined();
  });
});

describe('TUI v4 router and ViewModel', () => {
  it('normalizes the legacy plugin preview route to the unified detail', async () => {
    const controller = new TuiController(dependencies());
    await controller.load();

    controller.push({ name: 'pluginPreview', pluginId: 'official/demo' });

    expect(controller.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/demo',
    });
  });

  it('keeps catalog content evidence keyed by canonical plugin identity', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status(),
        pluginSummaries: summaries(['official', 'demo']),
        contentOverviews: {
          'official/demo': {
            pluginId: 'official/demo',
            pluginVersion: '2.0.0',
            catalogVersion: '3.0.0',
            evidence: 'catalogBundle',
            items: [{
              id: 'skill:review', name: 'review', type: 'skill',
              description: 'Review changes', tools: ['Codex'],
            }],
            notices: [],
          },
        },
      }),
    }));
    await controller.load();

    expect(controller.getPluginContentOverview('official/demo')).toMatchObject({
      pluginId: 'official/demo', pluginVersion: '2.0.0',
      items: [{ name: 'review', tools: ['Codex'] }],
    });
    expect(controller.getPluginContentOverview('other/demo')).toBeUndefined();
  });

  it('loads one plugin content overview on demand and shares the in-flight read', async () => {
    const pending = deferred<Awaited<ReturnType<NonNullable<TuiControllerDependencies['loadPluginContent']>>>>();
    const loadPluginContent = vi.fn(() => pending.promise);
    const controller = new TuiController(dependencies({ loadPluginContent }));
    await controller.load();

    const first = controller.loadPluginContent('official/demo');
    const second = controller.loadPluginContent('official/demo');

    expect(loadPluginContent).toHaveBeenCalledTimes(1);
    expect(controller.getPluginContentState('official/demo')).toBe('loading');
    pending.resolve({
      pluginId: 'official/demo', pluginVersion: '2.0.0', catalogVersion: '3.0.0',
      evidence: 'catalogBundle', items: [], notices: [],
    });
    await Promise.all([first, second]);
    expect(controller.getPluginContentState('official/demo')).toBe('ready');
    expect(controller.getPluginContentOverview('official/demo')).toMatchObject({
      pluginId: 'official/demo', evidence: 'catalogBundle',
    });
  });

  it('projects a safe coverage issue when the plugin content loader rejects', async () => {
    // Risk: a rejected loader must remain readable through the same typed coverage path as runtime failures.
    const loadPluginContent = vi.fn().mockRejectedValue(new Error('PRIVATE-CONTENT-FAILURE'));
    const controller = new TuiController(dependencies({ loadPluginContent }));
    await controller.load();

    await controller.loadPluginContent('official/demo');

    const overview = controller.getPluginContentOverview('official/demo');
    expect(controller.getPluginContentState('official/demo')).toBe('ready');
    expect(overview).toMatchObject({
      pluginId: 'official/demo', evidence: 'unavailable', coverage: 'unavailable', items: [],
      coverageIssue: { code: 'unreadable', message: expect.any(String) },
    });
    expect(JSON.stringify(overview)).not.toContain('PRIVATE-CONTENT-FAILURE');
  });

  it('invalidates loaded plugin content when status is reloaded', async () => {
    const loadPluginContent = vi.fn().mockResolvedValue({
      pluginId: 'official/demo', pluginVersion: '2.0.0', catalogVersion: '3.0.0',
      evidence: 'catalogBundle', items: [], notices: [],
    });
    const controller = new TuiController(dependencies({ loadPluginContent }));
    await controller.load();
    await controller.loadPluginContent('official/demo');
    expect(controller.getPluginContentState('official/demo')).toBe('ready');

    await controller.load();

    expect(controller.getPluginContentState('official/demo')).toBe('idle');
    expect(controller.getPluginContentOverview('official/demo')).toBeUndefined();
  });

  it('includes recognizable saved settings without claiming the plugin is installable', () => {
    const view = buildTuiViewModel({
      status: status(),
      pluginSummaries: [],
      configStoreInventory: [{
        pluginId: 'removed/demo', sourceId: 'removed', pluginName: 'demo', scope: 'user',
      }],
    });

    expect(view.plugins).toEqual([expect.objectContaining({
      pluginId: 'removed/demo',
      aggregateStatus: 'unavailable',
      configOnly: true,
      savedConfigScopes: ['user'],
      supportedPlatforms: [],
      installedPlacements: [],
    })]);
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status(), pluginSummaries: [], configStoreInventory: [{
          pluginId: 'removed/demo', sourceId: 'removed', pluginName: 'demo', scope: 'user',
        }],
      }),
    }));
    return controller.load().then(() => {
      expect(controller.listPlugins({ mode: 'installed' })).toHaveLength(1);
      expect(controller.listPlugins({ mode: 'browse' })).toHaveLength(1);
      expect(controller.listPlugins({ mode: 'browse', installFilter: 'installed' })).toEqual([]);
      expect(controller.listPlugins({ mode: 'browse', installFilter: 'attention' }))
        .toHaveLength(1);
      expect(controller.listInstallTargets('removed/demo', 'user')).toEqual([]);
      expect(buildPluginDetailActions(controller.getPluginOverview('removed/demo')!)
        .map((action) => action.id)).toEqual(['settings', 'sourceProblem', 'about']);
      controller.push({ name: 'pluginDetail', pluginId: 'removed/demo' });
      controller.beginSavedConfigRecovery('removed/demo');
      expect(controller.snapshot.router.current.route).toEqual({
        name: 'configUnavailable',
        pluginId: 'removed/demo',
        storedScopes: ['user'],
        layer: { scope: 'user' },
        diagnosticCode: 'catalogSourceUnavailable',
        diagnosticStage: 'read-config',
      });
    });
  });

  it('builds capability actions only for capabilities with live content', () => {
    const empty = menuPlugin();
    expect(buildPluginPreviewActions(empty).map((action) => action.id)).toEqual(['add', 'source']);
    expect(buildPluginDetailActions(empty).map((action) => action.id)).toEqual(['platform', 'about']);

    const capable = menuPlugin({
      portableSkills: true,
      configFieldCount: 2,
      dependencySummary: {
        directCount: 1, transitiveCount: 1, totalCount: 2,
        readyCount: 2, missingCount: 0, issueCount: 0,
      },
    });
    expect(buildPluginPreviewActions(capable).map((action) => action.id)).toEqual([
      'add', 'dependencies', 'settings', 'source',
    ]);
    expect(buildPluginDetailActions(capable).map((action) => action.id)).toEqual([
      'platform', 'dependencies', 'settings', 'about',
    ]);
  });

  it('projects collision-only targets as blocked without installed evidence', () => {
    const collision = target({
      pluginName: 'collision',
      scope: 'user',
      state: 'absent',
      errors: [{
        code: 'artifactCollision',
        message: 'safe collision',
        severity: 'blocking',
      }],
    });

    expect(buildTuiViewModel({
      status: status({ targets: [collision] }),
      pluginSummaries: summaries(['official', 'collision']),
    }).plugins[0]?.installedPlacements).toEqual([{
      platform: 'codex',
      state: 'blocked',
      supportedScopes: ['user'],
      reason: 'artifactCollision',
    }]);
  });

  it('keeps add for a mixed-platform collision and makes output conflict first when all platforms block', () => {
    const mixed = menuPlugin({
      supportedPlatforms: ['codex', 'claude'],
      installedPlacements: [
        { platform: 'codex', state: 'blocked', supportedScopes: ['user'], reason: 'artifactCollision' },
        { platform: 'claude', state: 'notInstalled', supportedScopes: ['user'] },
      ],
    });
    const blocked = menuPlugin({
      supportedPlatforms: ['codex', 'claude'],
      installedPlacements: [
        { platform: 'codex', state: 'blocked', supportedScopes: ['user'], reason: 'artifactCollision' },
        { platform: 'claude', state: 'blocked', supportedScopes: ['user'], reason: 'artifactCollision' },
      ],
    });

    expect(buildPluginPreviewActions(mixed).map((action) => action.id)).toEqual(['add', 'source']);
    expect(buildPluginPreviewActions(blocked).map((action) => action.id)).toEqual([
      'outputCollision', 'source', 'about',
    ]);
    expect(buildPlatformActions(blocked, 'codex').map((action) => action.id)).toEqual([
      'outputCollision', 'source', 'about',
    ]);
  });

  it.each(['present', 'partial'] as const)(
    'keeps a blocking collision on an owned %s placement and hides constructive actions',
    (state) => {
      const collision = target({
        pluginName: `collision-${state}`,
        scope: 'user',
        state,
        errors: [{
          code: 'artifactCollision',
          message: 'safe collision',
          severity: 'blocking',
        }],
      });
      const plugin = buildTuiViewModel({
        status: status({ targets: [collision] }),
        pluginSummaries: summaries(['official', `collision-${state}`]),
        targetRevisions: [{
          pluginId: collision.pluginId,
          platform: 'codex',
          scope: 'user',
          revision: {
            state: 'upgradeAvailable',
            availableVersion: '2.0.0',
            installedVersion: '1.0.0',
          },
        }],
      }).plugins[0]!;

      expect(plugin.installedPlacements[0]).toMatchObject({
        state: 'installed',
        scope: 'user',
        blockingReason: 'artifactCollision',
      });
      expect(buildPlatformActions(plugin, 'codex').map((action) => action.id)).toEqual([
        'outputCollision', 'remove', 'technical',
      ]);
      if (state === 'present') {
        const mixed = {
          ...plugin,
          supportedPlatforms: ['codex', 'claude'] as const,
          installedPlacements: [
            ...plugin.installedPlacements,
            { platform: 'claude' as const, state: 'notInstalled' as const, supportedScopes: ['user' as const] },
          ],
        };
        expect(buildPluginPreviewActions(mixed)[0]?.id).toBe('add');
      }
    },
  );

  it('builds preview primary actions from live placement health and availability', () => {
    const incomplete = menuPlugin({
      aggregateStatus: 'needsAttention',
      installedPlacements: [{
        platform: 'codex', state: 'installed', scope: 'user', health: 'incomplete',
        revision: { state: 'unknown', availableVersion: '2.0.0' },
      }],
    });
    const healthyWithMissingPlatform = menuPlugin({
      aggregateStatus: 'installed',
      supportedPlatforms: ['codex', 'claude'],
      installedPlacements: [
        {
          platform: 'codex', state: 'installed', scope: 'user', health: 'ready',
          revision: { state: 'current', availableVersion: '2.0.0', installedVersion: '2.0.0' },
        },
        { platform: 'claude', state: 'notInstalled', supportedScopes: ['user'] },
      ],
    });
    const healthyEverywhere = menuPlugin({
      aggregateStatus: 'installed',
      installedPlacements: [{
        platform: 'codex', state: 'installed', scope: 'user', health: 'ready',
        revision: { state: 'current', availableVersion: '2.0.0', installedVersion: '2.0.0' },
      }],
    });

    expect(buildPluginPreviewActions(incomplete)[0]?.id).toBe('repair');
    expect(buildPluginPreviewActions(healthyWithMissingPlatform)[0]?.id).toBe('add');
    expect(buildPluginPreviewActions(healthyEverywhere)[0]?.id).toBe('manage');
  });

  it('shows refresh-and-sync only with reliable upgradeAvailable revision evidence', () => {
    const ready = (revision: Extract<PluginListItemViewModel['installedPlacements'][number], {
      state: 'installed';
    }>['revision']): PluginListItemViewModel => menuPlugin({
      aggregateStatus: 'installed',
      installedPlacements: [{
        platform: 'codex', state: 'installed', scope: 'user', health: 'ready', revision,
      }],
      update: {
        pluginId: 'official/demo',
        state: revision.state === 'upgradeAvailable' ? 'available' : 'currentAgainstCatalog',
        sourceIdentity: 'identity:official',
        generationKey: 'official-active',
        targets: [{
          platform: 'codex', scope: 'user',
          ...(revision.installedVersion ? { installedVersion: revision.installedVersion } : {}),
          ...(revision.availableVersion ? { activeVersion: revision.availableVersion } : {}),
          ...(revision.state === 'upgradeAvailable' && revision.availableVersion
            ? { availableVersion: revision.availableVersion }
            : {}),
          eligibility: revision.state === 'upgradeAvailable' ? 'allowed' : 'unverified',
        }],
      },
    });

    expect(buildPlatformActions(ready({
      state: 'current', availableVersion: '2.0.0', installedVersion: '2.0.0',
    }), 'codex').map((action) => action.id)).not.toContain('refreshAndSync');
    expect(buildPlatformActions(ready({ state: 'unknown', availableVersion: '2.0.0' }), 'codex')
      .map((action) => action.id)).not.toContain('refreshAndSync');
    expect(buildPlatformActions(ready({
      state: 'upgradeAvailable', availableVersion: '2.0.0', installedVersion: '1.0.0',
    }), 'codex')).toContainEqual(expect.objectContaining({ id: 'refreshAndSync', availableVersion: '2.0.0' }));
  });

  it('limits unavailable source menus to source and safe recovery actions', () => {
    const unavailable = menuPlugin({ aggregateStatus: 'unavailable' });
    expect(buildPluginPreviewActions(unavailable).map((action) => action.id)).toEqual(['sourceProblem']);
    expect(buildPluginDetailActions(unavailable).map((action) => action.id)).toEqual([
      'sourceProblem', 'about',
    ]);
    expect(buildPlatformActions(unavailable, 'codex').map((action) => action.id)).toEqual([
      'sourceProblem', 'refreshSource',
    ]);

    const installed = menuPlugin({
      aggregateStatus: 'unavailable',
      installedPlacements: [{
        platform: 'codex', state: 'installed', scope: 'user', health: 'ready',
        revision: { state: 'upgradeAvailable', availableVersion: '2.0.0', installedVersion: '1.0.0' },
      }],
    });
    expect(buildPluginPreviewActions(installed).map((action) => action.id)).toEqual([
      'sourceProblem', 'manage',
    ]);
    expect(buildPluginDetailActions(installed).map((action) => action.id)).toEqual([
      'platform', 'sourceProblem', 'about',
    ]);
    expect(buildPlatformActions(installed, 'codex').map((action) => action.id)).toEqual([
      'sourceProblem', 'refreshSource',
    ]);
  });

  it('keeps capability blockers unavailable without turning a healthy source into a source problem', () => {
    const unsupported = target({
      pluginName: 'modern',
      scope: 'user',
      state: 'error',
      errors: [{
        code: 'awCapabilityUnsupported',
        message: 'safe capability failure',
        severity: 'blocking',
      }],
    });
    unsupported.placements[0]!.recoveryActions = [{
      command: 'manual',
      description: '升级 AW CLI 到支持插件所需 capability 的版本后重试。',
    }];
    unsupported.recoveryActions = unsupported.placements[0]!.recoveryActions;
    const view = buildTuiViewModel({
      status: status({ targets: [unsupported] }),
      pluginSummaries: [{
        ...summaries(['official', 'modern'])[0]!,
        missingCapabilities: ['aw.future-feature.v1'],
      }],
    });
    const plugin = view.plugins[0]!;

    expect(plugin).toMatchObject({
      aggregateStatus: 'unavailable',
      capabilityUnsupported: true,
      capabilityRecovery: '升级 AW CLI 到支持插件所需 capability 的版本后重试。',
      missingCapabilities: ['aw.future-feature.v1'],
    });
    expect(view.sourceTabs).toEqual([expect.objectContaining({ id: 'official', state: 'ready' })]);
    expect(view.issues.some((issue) => issue.category === 'sourceUnavailable')).toBe(false);
    for (const actions of [
      buildPluginPreviewActions(plugin),
      buildPluginDetailActions(plugin),
      buildPlatformActions(plugin, 'codex'),
    ]) {
      expect(actions.map((action) => action.id)).toEqual(expect.arrayContaining([
        'upgradeAwCli', 'capabilityTechnical',
      ]));
      expect(actions.map((action) => action.id)).not.toContain('sourceProblem');
      expect(actions.map((action) => action.id)).not.toContain('refreshSource');
    }
  });

  it('uses add for absent and sync for an incomplete Codex placement', () => {
    expect(buildPlatformActions(menuPlugin(), 'codex')[0]?.id).toBe('add');
    expect(buildPlatformActions(menuPlugin({
      aggregateStatus: 'needsAttention',
      installedPlacements: [{
        platform: 'codex', state: 'installed', scope: 'project', health: 'incomplete',
        revision: { state: 'unknown', availableVersion: '2.0.0' },
      }],
    }), 'codex')[0]?.id).toBe('sync');
  });

  it('keeps pure-native scope overlap legal and consumes real scoped uninstall recovery for mixed conflict', () => {
    const pureNative = target({ scope: 'project', state: 'present' });
    pureNative.placements[0]!.components.push(
      {
        kind: 'intent', key: 'desired', state: 'desired',
        metadata: { enabled: true, scopes: ['project'], relation: 'root' },
      },
      { kind: 'activation', key: 'project', state: 'enabled', metadata: { effective: true, evidence: 'observed' } },
    );
    pureNative.placements.push({
      scope: 'user', state: 'ready',
      components: [
        {
          kind: 'intent', key: 'desired', state: 'desired',
          metadata: { enabled: true, scopes: ['user'], relation: 'root' },
        },
        { kind: 'ownership', key: 'fixture-user', state: 'present' },
        { kind: 'activation', key: 'user', state: 'enabled', metadata: { effective: true, evidence: 'observed' } },
      ],
      reasons: [], recoveryActions: [],
    });
    pureNative.components.push(
      { kind: 'sharedNative', key: 'demo@aw-official', state: 'usable', metadata: { shared: true } },
    );
    const purePlugin = buildTuiViewModel({
      status: status({ targets: [pureNative] }),
      pluginSummaries: summaries(['official', 'demo']),
    }).plugins[0]!;
    expect(purePlugin.installedPlacements).toEqual([
      expect.objectContaining({
        scope: 'project', state: 'installed', desiredScopes: ['project', 'user'], actualState: 'ready',
      }),
    ]);
    expect(purePlugin.installedPlacements[0]?.state).not.toBe('scopeConflict');

    const pureSingleScope = buildTuiViewModel({
      status: status({ targets: [{
        ...pureNative,
        placements: pureNative.placements.map((placement) => ({
          ...placement,
          components: placement.components.map((component) => component.kind === 'intent'
          ? { ...component, metadata: { enabled: true, scopes: ['user'], relation: 'root' } }
          : component.kind === 'activation' && component.key === 'project'
            ? { ...component, state: 'disabled' }
            : component),
        })),
      }] }),
      pluginSummaries: [{
        ...summaries(['official', 'demo'])[0]!,
        supportedTargets: { codex: ['user', 'project'], claude: [] },
      }],
    }).plugins[0]!;
    expect(buildPlatformActions(pureSingleScope, 'codex')[0]).toEqual({
      id: 'addScope', platform: 'codex', scope: 'project',
    });

    const mixed = {
      ...pureNative,
      state: 'blocked' as const,
      reasons: [{ code: 'codexExtensionScopeConflict', message: 'safe conflict', severity: 'blocking' as const }],
      recoveryActions: [
        {
          command: 'uninstall' as const,
          scope: 'user' as const,
          description: '运行 aw uninstall official/demo --platform codex --scope user，再运行 aw sync official/demo --platform codex --scope project。',
        },
        {
          command: 'uninstall' as const,
          scope: 'project' as const,
          description: '运行 aw uninstall official/demo --platform codex --scope project，再运行 aw sync official/demo --platform codex --scope user。',
        },
      ],
    };
    const mixedPlugin = buildTuiViewModel({
      status: status({ targets: [mixed] }),
      pluginSummaries: summaries(['official', 'demo']),
    }).plugins[0]!;
    expect(mixedPlugin.installedPlacements[0]).toMatchObject({
      state: 'scopeConflict',
      placements: expect.arrayContaining([
        expect.objectContaining({ scope: 'project', health: 'ready' }),
        expect.objectContaining({ scope: 'user', health: 'ready' }),
      ]),
    });
    expect(buildPlatformActions(mixedPlugin, 'codex').map((action) => action.id)).toEqual([
      'scopeConflict',
    ]);
    expect(buildPluginDetailActions(mixedPlugin).filter((action) =>
      action.id === 'scopeConflict')).toHaveLength(1);
    expect(buildTuiViewModel({
      status: status({ targets: [mixed] }),
      pluginSummaries: summaries(['official', 'demo']),
    }).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'scopeConflict',
        actions: expect.arrayContaining([
          expect.objectContaining({ id: 'keepProjectScope', pluginId: 'official/demo' }),
          expect.objectContaining({ id: 'keepUserScope', pluginId: 'official/demo' }),
        ]),
      }),
    ]));

    const foreign = buildTuiViewModel({
      status: status({ targets: [{
        ...pureNative,
        state: 'blocked',
        components: pureNative.components.map((component) => component.kind === 'sharedNative'
          ? { ...component, state: 'blocked', metadata: { shared: true, reason: 'foreign' } }
          : component),
        placements: pureNative.placements.map((placement) => ({
          ...placement,
          state: 'blocked',
          reasons: [{ code: 'codexSharedNativeForeign', message: 'safe foreign', severity: 'blocking' }],
          recoveryActions: [{
            command: 'sync',
            description: '先移除或重命名 foreign shared native；cleanup 会保留 foreign 内容。',
          }],
        })),
        reasons: [{ code: 'codexSharedNativeForeign', message: 'safe foreign', severity: 'blocking' }],
        recoveryActions: [{
          command: 'sync',
          description: '先移除或重命名 foreign shared native；cleanup 会保留 foreign 内容。',
        }],
      }] }),
      pluginSummaries: summaries(['official', 'demo']),
    }).plugins[0]!;
    expect(buildPlatformActions(foreign, 'codex').map((action) => action.id)).toEqual([
      'technical', 'back',
    ]);

    const needsSync = menuPlugin({
      aggregateStatus: 'needsAttention',
      installedPlacements: [{
        platform: 'codex', state: 'installed', scope: 'project', health: 'incomplete',
        actualState: 'needsSync', desiredScopes: ['project'],
        revision: { state: 'current', availableVersion: '2.0.0', installedVersion: '2.0.0' },
      }],
    });
    expect(buildPlatformActions(needsSync, 'codex')[0]?.id).toBe('sync');
  });

  it('centralizes install target compatibility and recomputes it for the selected scope', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ targets: [
          target({
            platform: 'codex', scope: 'user', state: 'absent',
            errors: [{ code: 'artifactCollision', message: 'safe collision', severity: 'blocking' }],
          }),
          target({ platform: 'codex', scope: 'project', state: 'absent' }),
          target({ platform: 'claude', scope: 'project', state: 'absent' }),
        ] }),
        pluginSummaries: [{
          ...summaries(['official', 'demo'])[0]!,
          supportedTargets: { codex: ['user', 'project'], claude: ['project'] },
        }],
      }),
    }));
    await controller.load();

    expect(controller.listInstallTargets('official/demo', 'user')).toEqual([
      { platform: 'codex', compatible: false, disabled: '存在输出冲突；请先移除或迁移占用内容' },
      { platform: 'claude', compatible: false, disabled: '不支持所选位置' },
    ]);
    expect(controller.listInstallTargets('official/demo', 'project')).toEqual([
      { platform: 'codex', compatible: true },
      { platform: 'claude', compatible: true },
    ]);
  });

  it('classifies only missing compatible batch install targets as writable', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ targets: [
          target({ platform: 'codex', scope: 'project', state: 'present' }),
          target({ platform: 'claude', scope: 'project', state: 'absent' }),
        ] }),
        pluginSummaries: [{
          ...summaries(['official', 'demo'])[0]!,
          supportedTargets: { codex: ['project'], claude: ['project'] },
        }],
      }),
    }));
    await controller.load();

    expect(controller.listPluginInstallBatchTargets(
      ['official/demo'], 'both', 'project',
    )).toEqual([
      { pluginId: 'official/demo', platform: 'claude', scope: 'project', state: 'add' },
      { pluginId: 'official/demo', platform: 'codex', scope: 'project', state: 'existing' },
    ]);
    expect(controller.pluginHasInstallableTarget('official/demo')).toBe(true);
    expect(controller.listPlugins({ mode: 'browse', installFilter: 'uninstalled' })).toEqual([]);
  });

  it('classifies each Codex batch install scope from its exact placement', async () => {
    const codex = target({ platform: 'codex', scope: 'project', state: 'error' });
    if (codex.platform !== 'codex') throw new Error('expected Codex target');
    codex.placements.push({
      scope: 'user', state: 'absent',
      components: [{ kind: 'ownership', key: 'fixture-user', state: 'absent' }],
      reasons: [], recoveryActions: [],
    });
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ targets: [codex] }),
        pluginSummaries: [{
          ...summaries(['official', 'demo'])[0]!,
          supportedTargets: { codex: ['project', 'user'], claude: [] },
        }],
      }),
    }));
    await controller.load();

    expect(controller.listPluginInstallBatchTargets(
      ['official/demo'], 'codex', 'user',
    )).toEqual([
      { pluginId: 'official/demo', platform: 'codex', scope: 'user', state: 'add' },
    ]);
  });

  it('preserves exact installed targets before blocking missing targets that cannot be installed', async () => {
    const existing = (pluginName: string): StatusV7Payload['targets'][number] => {
      const value = target({ pluginName, platform: 'codex', scope: 'project', state: 'present' });
      value.components.push(
        { kind: 'intent', key: 'desired', state: 'desired', metadata: {
          enabled: true, scopes: ['project'], relation: 'root',
        } },
        { kind: 'activation', key: 'project', state: 'enabled', metadata: { evidence: 'observed' } },
      );
      return value;
    };
    const missing = (pluginName: string): StatusV7Payload['targets'][number] =>
      target({ pluginName, platform: 'claude', scope: 'project', state: 'absent' });
    const unobserved = target({ pluginName: 'unobserved', platform: 'codex', scope: 'project', state: 'absent' });
    unobserved.components.push({
      kind: 'activation', key: 'project', state: 'enabled', metadata: { evidence: 'unobserved' },
    });
    const foreign = target({
      pluginName: 'foreign', platform: 'codex', scope: 'project', state: 'error',
      errorCode: 'codexSharedNativeForeign',
    });
    foreign.components.push({
      kind: 'sharedNative', key: 'foreign@aw-official', state: 'blocked', metadata: { reason: 'foreign' },
    });
    const foldedMissing = target({
      pluginName: 'folded-missing', platform: 'codex', scope: 'user', state: 'absent',
    });
    foldedMissing.components.push(
      { kind: 'activation', key: 'user', state: 'disabled', metadata: { evidence: 'observed' } },
      { kind: 'activation', key: 'project', state: 'disabled', metadata: { evidence: 'observed' } },
    );
    const foldedUser = target({
      pluginName: 'folded-user', platform: 'codex', scope: 'user', state: 'present',
    });
    foldedUser.components.push(
      { kind: 'intent', key: 'desired', state: 'desired', metadata: {
        enabled: true, scopes: ['user'], relation: 'root',
      } },
      { kind: 'activation', key: 'user', state: 'enabled', metadata: { evidence: 'observed' } },
      { kind: 'activation', key: 'project', state: 'disabled', metadata: { evidence: 'observed' } },
    );
    const foldedProject = target({
      pluginName: 'folded-project', platform: 'codex', scope: 'project', state: 'present',
    });
    foldedProject.components.push(
      { kind: 'intent', key: 'desired', state: 'desired', metadata: {
        enabled: true, scopes: ['project'], relation: 'root',
      } },
      { kind: 'activation', key: 'user', state: 'disabled', metadata: { evidence: 'observed' } },
      { kind: 'activation', key: 'project', state: 'enabled', metadata: { evidence: 'observed' } },
    );
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({
          sources: [source('official'), source('offline', { error: 'unavailable' })],
          targets: [
            existing('capability'), missing('capability'),
            { ...existing('offline'), sourceId: 'offline', sourceIdentity: 'identity:offline', pluginId: 'offline/offline' },
            { ...missing('offline'), sourceId: 'offline', sourceIdentity: 'identity:offline', pluginId: 'offline/offline' },
            existing('compatibility'), missing('compatibility'), unobserved, foreign,
            foldedMissing, foldedUser, foldedProject,
          ],
        }),
        pluginSummaries: [
          { ...summaries(['official', 'capability'])[0]!, missingCapabilities: ['aw.future.v1'], supportedTargets: { codex: ['project'], claude: ['project'] } },
          { ...summaries(['offline', 'offline'])[0]!, supportedTargets: { codex: ['project'], claude: ['project'] } },
          { ...summaries(['official', 'compatibility'])[0]!, supportedTargets: { codex: [], claude: [] } },
          { ...summaries(['official', 'unobserved'])[0]!, supportedTargets: { codex: ['project'], claude: [] } },
          { ...summaries(['official', 'foreign'])[0]!, supportedTargets: { codex: ['project'], claude: [] } },
          { ...summaries(['official', 'unknown'])[0]!, supportedTargets: { codex: ['project'], claude: [] } },
          { ...summaries(['official', 'folded-missing'])[0]!, supportedTargets: { codex: ['user', 'project'], claude: [] } },
          { ...summaries(['official', 'folded-user'])[0]!, supportedTargets: { codex: ['user', 'project'], claude: [] } },
          { ...summaries(['official', 'folded-project'])[0]!, supportedTargets: { codex: ['user', 'project'], claude: [] } },
        ],
      }),
    }));
    await controller.load();

    expect(controller.listPluginInstallBatchTargets(
      ['official/capability'], 'both', 'project',
    )).toEqual([
      { pluginId: 'official/capability', platform: 'claude', scope: 'project', state: 'blocked', reason: '当前 AW CLI 不支持插件所需功能' },
      { pluginId: 'official/capability', platform: 'codex', scope: 'project', state: 'existing' },
    ]);
    expect(controller.listPluginInstallBatchTargets(
      ['offline/offline'], 'both', 'project',
    )).toEqual([
      { pluginId: 'offline/offline', platform: 'claude', scope: 'project', state: 'blocked', reason: '插件来源不可用' },
      { pluginId: 'offline/offline', platform: 'codex', scope: 'project', state: 'existing' },
    ]);
    expect(controller.listPluginInstallBatchTargets(
      ['official/compatibility'], 'both', 'project',
    )).toEqual([
      { pluginId: 'official/compatibility', platform: 'claude', scope: 'project', state: 'blocked', reason: '插件不支持所选工具或位置' },
      { pluginId: 'official/compatibility', platform: 'codex', scope: 'project', state: 'existing' },
    ]);
    expect(controller.listPluginInstallBatchTargets(
      ['official/unobserved', 'official/foreign'], 'codex', 'project',
    )).toEqual([
      { pluginId: 'official/foreign', platform: 'codex', scope: 'project', state: 'blocked', reason: 'safe failure' },
      { pluginId: 'official/unobserved', platform: 'codex', scope: 'project', state: 'blocked', reason: '无法确认所选位置是否缺失' },
    ]);
    expect(controller.listPluginInstallBatchTargets(
      ['official/unknown'], 'codex', 'project',
    )).toEqual([
      { pluginId: 'official/unknown', platform: 'codex', scope: 'project', state: 'blocked', reason: '无法确认所选位置是否缺失' },
    ]);
    expect(controller.listPluginInstallBatchTargets(
      ['official/folded-missing'], 'codex', 'user',
    )[0]?.state).toBe('add');
    expect(controller.listPluginInstallBatchTargets(
      ['official/folded-missing'], 'codex', 'project',
    )[0]?.state).toBe('add');
    expect(controller.listPluginInstallBatchTargets(
      ['official/folded-user'], 'codex', 'user',
    )[0]?.state).toBe('existing');
    expect(controller.listPluginInstallBatchTargets(
      ['official/folded-user'], 'codex', 'project',
    )[0]?.state).toBe('add');
    expect(controller.listPluginInstallBatchTargets(
      ['official/folded-project'], 'codex', 'project',
    )[0]?.state).toBe('existing');
    expect(controller.listPluginInstallBatchTargets(
      ['official/folded-project'], 'codex', 'user',
    )[0]?.state).toBe('add');
  });

  it('keeps a typed placement draft and asks only when editable platforms disagree', async () => {
    const previewDependencyPlacement = vi.fn(async (intent: Extract<import('../../src/tui/controller.js').OperationIntent, { kind: 'pluginWrite' }>): Promise<DependencyOperationPlan> => {
      const platforms = intent.platform === 'both' ? ['codex', 'claude'] as const : [intent.platform];
      const selected = (pluginId: string, platform: 'codex' | 'claude') =>
        intent.dependencyScopeOverrides?.find((entry) =>
          entry.pluginId === pluginId && entry.platform === platform)?.scope;
      const targets: DependencyOperationPlan['targets'] = platforms.flatMap((platform) => {
        const directOverride = selected('official/toolkit', platform);
        const directScope = directOverride ?? intent.scope;
        const transitiveScope = directScope === 'user' ? 'user' : intent.scope;
        return [
          {
            pluginId: 'official/toolkit', pluginName: 'Toolkit', platform,
            relation: 'dependency', depth: 1, requiredBy: ['official/demo'],
            rootScope: intent.scope, minimumScope: intent.scope, resolvedScope: directScope,
            allowedScopes: ['project', 'user'], assignmentSource: directOverride
              ? 'userOverride' : 'default', locked: intent.scope === 'user',
            ...(directOverride ? { lockReason: 'dependencyScopeOverride', locked: true } : {}),
            affectsOtherProjects: directScope === 'user', state: 'absent', action: 'install', order: 1,
          },
          {
            pluginId: 'official/base', pluginName: 'Base', platform,
            relation: 'dependency', depth: 2, requiredBy: ['official/toolkit'],
            rootScope: intent.scope, minimumScope: transitiveScope, resolvedScope: transitiveScope,
            allowedScopes: ['project', 'user'], assignmentSource: directScope === 'user'
              ? 'consumerPromotion' : 'default', locked: intent.scope === 'user',
            affectsOtherProjects: transitiveScope === 'user', state: 'absent', action: 'install', order: 0,
          },
          {
            pluginId: 'official/reused', pluginName: 'Reused', platform,
            relation: 'dependency', depth: 1, requiredBy: ['official/demo'],
            rootScope: intent.scope, minimumScope: intent.scope, resolvedScope: 'user',
            allowedScopes: ['project', 'user'], assignmentSource: 'existingWiderTarget',
            locked: intent.scope === 'user', affectsOtherProjects: true,
            state: 'present', action: 'keep', order: 2,
          },
          {
            pluginId: 'official/demo', pluginName: 'Demo', platform,
            relation: 'requested', depth: 0, requiredBy: [], rootScope: intent.scope,
            minimumScope: intent.scope, resolvedScope: intent.scope,
            allowedScopes: [intent.scope], assignmentSource: 'root', locked: true,
            affectsOtherProjects: intent.scope === 'user', state: 'absent', action: 'install', order: 3,
          },
        ];
      });
      return {
        dependencyPlanSchemaVersion: 2,
        dependencyPlanDigest: `sha256:${JSON.stringify(targets)}`,
        requestedPluginIds: ['official/demo'],
        resolvedPluginIds: ['official/base', 'official/toolkit', 'official/reused', 'official/demo'],
        dependencyEdges: platforms.flatMap((platform) => [
          { from: 'official/demo', to: 'official/toolkit', platform },
          { from: 'official/toolkit', to: 'official/base', platform },
          { from: 'official/demo', to: 'official/reused', platform },
        ]),
        scopeOverrides: intent.dependencyScopeOverrides ?? [],
        targets,
        claimRoots: [],
      };
    });
    const controller = new TuiController(dependencies({ previewDependencyPlacement }));
    await controller.load();
    controller.beginInstallFlow('official/demo', 'project');
    controller.setInstallPlatforms(['codex', 'claude']);

    await expect(controller.prepareInstallDependencyPlacement()).resolves.toBe(false);
    expect(controller.snapshot.installPlacementDraft?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'official/reused', platform: 'codex', scope: 'user', explanation: '复用健康的所有项目安装' }),
      expect.objectContaining({ pluginId: 'official/toolkit', platform: 'codex', scope: 'project' }),
      expect.objectContaining({ pluginId: 'official/toolkit', platform: 'claude', scope: 'project' }),
    ]));

    await controller.setDependencyScope('official/toolkit', 'codex', 'user');
    await expect(controller.prepareInstallDependencyPlacement()).resolves.toBe(true);
    expect(controller.snapshot.installPlacementDraft?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'official/toolkit', platform: 'codex', scope: 'user',
        assignmentSource: 'userOverride', locked: false,
      }),
      expect.objectContaining({ pluginId: 'official/base', platform: 'codex', scope: 'user', assignmentSource: 'consumerPromotion' }),
      expect.objectContaining({ pluginId: 'official/toolkit', platform: 'claude', scope: 'project' }),
    ]));

    await controller.resetDependencyScopes();
    expect(controller.snapshot.installPlacementDraft?.dependencyScopeOverrides).toEqual([]);
    expect(controller.snapshot.installPlacementDraft?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'official/toolkit', platform: 'codex', scope: 'project', assignmentSource: 'default',
      }),
      expect.objectContaining({
        pluginId: 'official/reused', platform: 'codex', scope: 'user', assignmentSource: 'existingWiderTarget',
      }),
    ]));

    await controller.setDependencyScope('official/toolkit', 'codex', 'user');

    controller.setInstallRootScope('user');
    controller.setInstallPlatforms(['codex', 'claude']);
    await controller.prepareInstallDependencyPlacement();
    expect(controller.snapshot.installPlacementDraft?.dependencyScopeOverrides).toContainEqual({
      pluginId: 'official/toolkit', platform: 'codex', scope: 'user',
    });

    controller.setInstallRootScope('project');
    controller.setInstallPlatforms(['codex', 'claude']);
    await controller.prepareInstallDependencyPlacement();
    expect(controller.snapshot.installPlacementDraft?.dependencyScopeOverrides).toContainEqual({
      pluginId: 'official/toolkit', platform: 'codex', scope: 'user',
    });

    await controller.setDependencyScope('official/toolkit', 'codex', 'project');
    controller.setInstallRootScope('user');
    controller.setInstallPlatforms(['codex', 'claude']);
    await controller.prepareInstallDependencyPlacement();
    expect(controller.snapshot.installPlacementDraft?.dependencyScopeOverrides).toEqual([]);

    controller.setInstallRootScope('project');
    controller.setInstallPlatforms(['codex', 'claude']);
    await controller.prepareInstallDependencyPlacement();
    await controller.setDependencyScope('official/toolkit', 'codex', 'user');

    controller.setInstallPlatforms(['claude']);
    await controller.prepareInstallDependencyPlacement();
    expect(controller.snapshot.installPlacementDraft?.dependencyScopeOverrides).toEqual([]);
    expect(controller.snapshot.installPlacementDraft?.targets.every((entry) =>
      entry.platform === 'claude')).toBe(true);

    controller.setInstallRootScope('user');
    controller.setInstallPlatforms(['claude']);
    await expect(controller.prepareInstallDependencyPlacement()).resolves.toBe(false);
    expect(controller.snapshot.installPlacementDraft?.targets.every((entry) => entry.locked)).toBe(true);
  });

  it('keeps mixed root scopes while editing and pruning dependency choices', async () => {
    const previewDependencyPlacement = vi.fn(async (intent: Extract<OperationIntent, { kind: 'pluginWrite' }>): Promise<DependencyOperationPlan> => {
      const platforms = intent.platform === 'both' ? ['claude', 'codex'] as const : [intent.platform];
      const placement = createDependencyPlacementPlan({
        requestedPluginIds: [intent.pluginId],
        roots: platforms.map((platform) => ({ pluginId: intent.pluginId, platform, scope: intent.scope })),
        nodes: platforms.flatMap((platform) => [
          { pluginId: intent.pluginId, pluginName: 'Root', platform, relation: 'requested' as const,
            depth: 0, allowedScopes: ['project', 'user'] as const },
          { pluginId: 'official/toolkit', pluginName: 'Toolkit', platform, relation: 'dependency' as const,
            depth: 1, allowedScopes: ['project', 'user'] as const },
        ]).map((node) => ({ ...node, allowedScopes: [...node.allowedScopes] })),
        dependencyEdges: platforms.map((platform) => ({ from: intent.pluginId, to: 'official/toolkit', platform })),
        scopeOverrides: intent.dependencyScopeOverrides,
      });
      return { ...placement, dependencyPlanSchemaVersion: 2, dependencyPlanDigest: 'sha256:mixed', claimRoots: [],
        targets: placement.targets.map((target, order) => ({ ...target, order, state: 'absent', action: 'install' })) };
    });
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind !== 'pluginWriteBatch' || intent.selection.kind !== 'targets') return baseEvidence;
      const groups = await Promise.all(intent.selection.targets.map(async (root) => {
        const dependencyPlan = await previewDependencyPlacement({
          kind: 'pluginWrite', action: 'install', ...root,
          dependencyScopeOverrides: intent.dependencyScopeOverrides?.filter((override) => override.platform === root.platform),
        });
        return {
          groupId: `official:${root.platform}:${root.scope}`, sourceId: 'official', platform: root.platform,
          scope: root.scope, requestedPluginIds: [root.pluginId], executable: true,
          preview: { platforms: [root.platform], plugins: [root.pluginId], warnings: [], rebuildResults: [],
            targetResults: [], overallState: 'succeeded' as const, receiptTargets: [], dependencyPlan,
            operationPlan: createOperationPlan({ intentChanges: [], actions: [], changes: [], warnings: [],
              evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] } }),
          },
        };
      }));
      return { ...baseEvidence, requestedPluginIds: ['official/demo'], groups } as PluginWriteBatchEvidence;
    });
    const executeIntent = vi.fn().mockRejectedValue(new Error('writeRejected'));
    let tokenIndex = 0;
    const controller = new TuiController(dependencies({ previewDependencyPlacement, captureEvidence,
      executeIntent, createToken: () => `mixed-${++tokenIndex}` }));
    await controller.load();
    controller.beginInstallFlow('official/demo', 'project');
    const exactRootTargets = [
      { pluginId: 'official/demo', platform: 'codex' as const, scope: 'project' as const },
      { pluginId: 'official/demo', platform: 'claude' as const, scope: 'user' as const },
    ];
    controller.setInstallRootTargets(exactRootTargets);
    await expect(controller.prepareInstallDependencyPlacement()).resolves.toBe(true);
    expect(controller.snapshot.installPlacementDraft?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'official/toolkit', platform: 'codex', scope: 'project', locked: false }),
      expect.objectContaining({ pluginId: 'official/toolkit', platform: 'claude', scope: 'user' }),
    ]));
    await controller.setDependencyScope('official/toolkit', 'codex', 'user');
    expect(controller.installPlacementIntent()).toMatchObject({
      kind: 'pluginWriteBatch', selection: { kind: 'targets', targets: expect.arrayContaining(exactRootTargets) },
      dependencyScopeOverrides: [{ pluginId: 'official/toolkit', platform: 'codex', scope: 'user' }],
    });
    expect(controller.snapshot.installPlacementDraft?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'codex', scope: 'user', affectsOtherProjects: true }),
    ]));
    expect(previewDependencyPlacement.mock.calls.filter(([intent]) => intent.platform === 'claude')
      .every(([intent]) => !intent.dependencyScopeOverrides?.length)).toBe(true);
    controller.push({ name: 'dependencyPlacement', pluginId: 'official/demo' });
    const flowId = controller.snapshot.router.currentFlowId;
    const review = await controller.buildOperationReview(controller.installPlacementIntent());
    expect(controller.snapshot.router.currentFlowId).toBe(flowId);
    expect(review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'official/toolkit', description: expect.stringContaining('所有项目') }),
      expect.objectContaining({ pluginId: 'official/demo', description: expect.stringContaining('当前项目') }),
    ]));
    controller.back();
    expect(controller.snapshot.router.current.route.name).toBe('dependencyPlacement');
    expect(controller.snapshot.installPlacementDraft?.exactRootTargets).toEqual(expect.arrayContaining(exactRootTargets));
    const blockedReview = await controller.buildOperationReview(controller.installPlacementIntent());
    await expect(controller.executeOperation(blockedReview.reviewToken)).resolves.toMatchObject({ state: 'blocked' });
    expect(controller.snapshot.installPlacementDraft).toBeUndefined();
    expect(controller.snapshot.canResumeInstallDraft).toBe(true);
    controller.resumeResultDraft();
    expect(controller.snapshot.router.current.route.name).toBe('dependencyPlacement');
    expect(controller.snapshot.installPlacementDraft).toMatchObject({
      exactRootTargets: expect.arrayContaining(exactRootTargets),
      dependencyScopeOverrides: [{ pluginId: 'official/toolkit', platform: 'codex', scope: 'user' }],
      state: 'selecting', targets: [], canContinue: false,
    });
    expect(controller.snapshot.canResumeInstallDraft).toBeUndefined();
    previewDependencyPlacement.mockClear();
    await controller.prepareInstallDependencyPlacement();
    expect(previewDependencyPlacement).toHaveBeenCalledTimes(2);
    expect(controller.snapshot.installPlacementDraft?.canContinue).toBe(true);
    const resumedFlowId = controller.snapshot.router.currentFlowId;
    const resumedReview = await controller.buildOperationReview(controller.installPlacementIntent());
    expect(controller.snapshot.router.currentFlowId).toBe(resumedFlowId);
    expect(resumedReview.reviewToken).not.toBe(blockedReview.reviewToken);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    controller.back();
    await controller.setDependencyScope('official/toolkit', 'codex', 'project');
    controller.setInstallRootTargets(exactRootTargets.map((target) => ({ ...target, scope: 'user' })));
    await expect(controller.prepareInstallDependencyPlacement()).resolves.toBe(false);
    expect(controller.snapshot.installPlacementDraft?.dependencyScopeOverrides).toEqual([]);
    controller.setInstallRootScope('project');
    controller.setInstallPlatforms(['codex']);
    await controller.prepareInstallDependencyPlacement();
    expect(controller.installPlacementIntent()).toMatchObject({ kind: 'pluginWrite', platform: 'codex', scope: 'project' });
    expect(controller.snapshot.installPlacementDraft).not.toHaveProperty('exactRootTargets');
    await controller.setDependencyScope('official/toolkit', 'codex', 'user');
    controller.setInstallPlatforms(['claude']);
    expect(controller.snapshot.installPlacementDraft?.dependencyScopeOverrides).toEqual([]);
    controller.setInstallRootTargets(exactRootTargets);
    controller.push({ name: 'pluginList', mode: 'browse' });
    controller.beginPluginWriteBatch();
    const batchReview = await controller.buildOperationReview(controller.installPlacementIntent());
    await expect(controller.executeOperation(batchReview.reviewToken)).resolves.toMatchObject({ state: 'blocked' });
    expect(controller.snapshot.canResumeInstallDraft).toBeUndefined();
    expect(controller.snapshot.installPlacementDraft).toBeUndefined();
    const batchResultRoute = controller.snapshot.router.current.route;
    controller.resumeResultDraft();
    expect(controller.snapshot.router.current.route).toEqual(batchResultRoute);
    expect(controller.snapshot.installPlacementDraft).toBeUndefined();
  });

  it('invalidates a late dependency placement preview when Back cancels it', async () => {
    const preview = deferred<DependencyOperationPlan | undefined>();
    const controller = new TuiController(dependencies({
      previewDependencyPlacement: vi.fn(() => preview.promise),
    }));
    await controller.load();
    controller.beginInstallFlow('official/demo', 'project');
    controller.setInstallPlatforms(['codex']);
    const preparation = controller.prepareInstallDependencyPlacement();
    await nextTurn();
    expect(controller.snapshot.installPlacementDraft?.state).toBe('loading');

    controller.back();
    preview.resolve(undefined);

    await expect(preparation).rejects.toMatchObject({ name: 'AbortError' });
    expect(controller.snapshot.installPlacementDraft).toBeUndefined();
  });

  it('projects manifest order, presentation groups, choices, and private values safely', () => {
    const fields = [
      { key: 'level', title: '级别', kind: 'manifest' as const, reserved: false, writable: true, valueState: 'configured' as const, effectiveValue: 'strict', sourceLayer: 'user' as const, storedValue: 'strict', storedSourceLayer: 'user' as const },
      { key: 'rules', title: '规则', kind: 'manifest' as const, reserved: false, writable: true, valueState: 'configured' as const, effectiveValue: '/Users/private/rules.json', sourceLayer: 'local' as const, storedValue: '/Users/private/rules.json', storedSourceLayer: 'local' as const },
      { key: 'token', title: '令牌', kind: 'manifest' as const, reserved: false, writable: true, canSet: true, valueState: 'configured' as const, effectiveValue: 'sk-private', sourceLayer: 'user' as const, storedValue: 'sk-private', storedSourceLayer: 'user' as const },
    ];
    const page = buildConfigPage({
      pluginId: 'official/demo',
      schema: {
        fields: {
          level: {
            type: 'string',
            title: '级别',
            choices: {
              allowCustom: false,
              presets: [
                { id: 'fast', title: '快速', value: 'fast' },
                { id: 'strict', title: '严格', value: 'strict', recommended: true },
              ],
            },
          },
          rules: { type: 'string', title: '规则', sensitive: true, default: '/Users/private/default-rules.json' },
          token: { type: 'string', title: '令牌', sensitive: true, default: 'default-secret' },
        },
        presentation: {
          groups: [{ id: 'basic', title: '基本设置', fields: ['level'] }],
        },
      },
      read: { pluginName: 'demo', scope: 'user', projectLayer: 'shared', fields },
    });

    expect(page.groups.map((group) => [group.title, group.fields.map((field) => field.key)])).toEqual([
      ['基本设置', ['level']],
      ['其他设置', ['rules', 'token']],
    ]);
    expect(page.groups[0]!.fields[0]).toEqual(expect.objectContaining({
      type: 'string',
      allowCustom: false,
      matchedPresetId: 'strict',
      choices: [
        { id: 'fast', title: '快速', value: 'fast' },
        { id: 'strict', title: '严格', value: 'strict', recommended: true },
      ],
      value: 'strict',
    }));
    expect(page.presets).toEqual([]);
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('/Users/private');
    expect(serialized).not.toContain('sk-private');
    const privateFields = page.groups.flatMap((group) => group.fields)
      .filter((field) => field.sensitive);
    expect(privateFields.every((field) => !Object.hasOwn(field, 'value')
      && !Object.hasOwn(field, 'effectiveValue')
      && !Object.hasOwn(field, 'draftValue')
      && !Object.hasOwn(field, 'defaultValue')
      && !Object.hasOwn(field, 'choices'))).toBe(true);

    const projectPage = buildConfigPage({
      pluginId: 'official/demo',
      schema: { fields: { token: { type: 'string', sensitive: true } } },
      read: {
        pluginName: 'demo', scope: 'project', projectLayer: 'shared',
        fields: [fields[2]!],
      },
    });
    expect(projectPage.groups[0]!.fields[0]).toMatchObject({
      sensitive: true,
      writable: false,
      canSet: false,
    });
    expect(JSON.stringify(projectPage)).not.toContain('sk-private');

    const fallback = buildConfigPage({
      pluginId: 'official/demo',
      schema: { fields: { level: { type: 'string' }, rules: { type: 'string' }, token: { type: 'string', sensitive: true } } },
      read: { pluginName: 'demo', scope: 'user', projectLayer: 'shared', fields },
    });
    expect(fallback.groups).toHaveLength(1);
    expect(fallback.groups[0]!.title).toBe('插件设置');
    expect(fallback.groups[0]!.fields.map((field) => field.key)).toEqual(['level', 'rules', 'token']);

    const fieldAdvanced = buildConfigPage({
      pluginId: 'official/demo',
      schema: {
        fields: { level: { type: 'string' }, model: { type: 'string' } },
        presentation: {
          groups: [
            { id: 'general', title: '插件设置', fields: ['level'] },
            { id: 'advanced', title: '高级设置', fields: ['model'], advanced: true },
          ],
        },
      },
      read: { pluginName: 'demo', scope: 'user', projectLayer: 'shared', fields: [fields[0]!, {
        key: 'model', title: '模型', kind: 'manifest', reserved: false, writable: true,
        valueState: 'configured', effectiveValue: 'review-v2', sourceLayer: 'user',
        storedValue: 'review-v2', storedSourceLayer: 'user',
      }] },
    });
    expect(fieldAdvanced.groups.map((group) => [group.id, group.title, group.advanced,
      group.fields.map((field) => field.key)])).toEqual([
      ['general', '插件设置', false, ['level']],
      ['advanced', '高级设置', true, ['model']],
    ]);

    const layeredField = {
      ...fields[0]!,
      effectiveValue: 'fast',
      sourceLayer: 'project' as const,
      storedValue: 'strict',
      storedSourceLayer: 'user' as const,
    };
    const editable = buildConfigPage({
      pluginId: 'official/demo',
      schema: { fields: { level: { type: 'string' } } },
      read: { pluginName: 'demo', scope: 'user', projectLayer: 'shared', fields: [{
        ...layeredField,
        effectiveValue: 'strict',
        sourceLayer: 'user',
      }] },
      effectiveRead: { pluginName: 'demo', scope: 'effective', projectLayer: 'shared', fields: [layeredField] },
    });
    const effective = buildConfigPage({
      pluginId: 'official/demo',
      schema: { fields: { level: { type: 'string' } } },
      read: { pluginName: 'demo', scope: 'effective', projectLayer: 'shared', fields: [layeredField] },
    });
    expect(editable.groups[0]!.fields[0]).toMatchObject({
      displayValue: 'strict', value: 'strict', configured: true, sourceLabel: '本层已设置',
      effectiveDisplayValue: 'fast', effectiveValue: 'fast', effectiveSourceLabel: '当前项目',
    });
    expect(effective.groups[0]!.fields[0]).toMatchObject({
      displayValue: 'fast', value: 'fast', configured: true, sourceLabel: '当前项目',
    });
  });

  it('projects boolean presets, open custom policy, and sensitive selection safely', () => {
    const configured = (key: string, value: boolean) => ({
      key,
      title: key,
      kind: 'manifest' as const,
      reserved: false,
      writable: true,
      valueState: 'configured' as const,
      effectiveValue: value,
      sourceLayer: 'user' as const,
      storedValue: value,
      storedSourceLayer: 'user' as const,
    });
    const page = buildConfigPage({
      pluginId: 'official/demo',
      schema: {
        fields: {
          closed: {
            type: 'boolean',
            choices: {
              allowCustom: false,
              presets: [{ id: 'on', title: '仅开启', value: true, recommended: true }],
            },
          },
          open: {
            type: 'boolean',
            choices: {
              allowCustom: true,
              presets: [{ id: 'on', title: '开启方案', value: true }],
            },
          },
          secret: {
            type: 'boolean',
            sensitive: true,
            choices: {
              allowCustom: false,
              presets: [{ id: 'on', title: '敏感开启', value: true }],
            },
          },
        },
      },
      read: {
        pluginName: 'demo',
        scope: 'user',
        fields: [configured('closed', true), configured('open', false), configured('secret', true)],
      },
    });
    const fields = Object.fromEntries(page.groups.flatMap((group) =>
      group.fields.map((field) => [field.key, field])));

    expect(fields.closed).toMatchObject({
      allowCustom: false,
      matchedPresetId: 'on',
      choices: [{ id: 'on', title: '仅开启', value: true, recommended: true }],
    });
    expect(fields.open).toMatchObject({
      allowCustom: true,
      choices: [{ id: 'on', title: '开启方案', value: true }],
    });
    expect(fields.secret).toMatchObject({
      sensitive: true,
      allowCustom: false,
    });
    expect(fields.secret).not.toHaveProperty('choices');
    expect(fields.secret).not.toHaveProperty('matchedPresetId');
    expect(fields.secret).not.toHaveProperty('value');
  });

  it('projects canonical object presets and a stable sensitive-child summary', () => {
    const definition = {
      fields: {
        credentials: {
          type: 'object' as const,
          choices: {
            allowCustom: true,
            presets: [
              {
                id: 'service-a',
                title: 'Service A',
                value: { token: 'secret', region: 'west' },
              },
              {
                id: 'service-b',
                title: 'Service B',
                value: { token: 'other-secret', region: 'west' },
              },
            ],
          },
          properties: {
            token: { type: 'string' as const, sensitive: true, required: true },
            region: { type: 'string' as const, required: true },
          },
        },
      },
    };
    const page = buildConfigPage({
      pluginId: 'official/demo',
      schema: definition,
      read: {
        pluginName: 'demo',
        scope: 'effective',
        fields: [{
          key: 'credentials',
          title: 'credentials',
          kind: 'manifest',
          reserved: false,
          writable: true,
          valueState: 'configured',
          effectiveValue: { region: 'west', token: '[redacted]' },
          sourceLayer: 'user',
          value: { region: 'west', token: '[redacted]' },
          source: 'user',
          matchedPreset: 'service-a',
          valid: true,
          issues: [],
        }],
      },
      effectiveRawValues: { credentials: { region: 'west', token: 'secret' } },
    });
    const field = page.groups[0]!.fields[0]!;

    expect(field).toMatchObject({
      type: 'object',
      displayValue: '已设置',
      draftValue: { region: 'west', token: 'secret' },
    });
    expect(field).not.toHaveProperty('matchedPresetId');
    expect(field.displayValue).not.toContain('Service');
    expect(field.displayValue).not.toContain('自定义');
    expect(field.displayValue).not.toContain('secret');
  });

  it('matches a raw inherited object preset for a project override and precomputes redacted unset changes', () => {
    const schema = {
      fields: {
        credentials: {
          type: 'object' as const,
          choices: {
            allowCustom: true,
            presets: [{
              id: 'inherited',
              title: 'Inherited service',
              value: { token: 'inherited-secret', region: 'west' },
            }],
          },
          properties: {
            token: { type: 'string' as const, sensitive: true },
            region: { type: 'string' as const },
          },
        },
      },
    };
    const entry = (scope: 'user' | 'project', value: { token: string; region: string }) => ({
      key: 'credentials',
      title: 'credentials',
      kind: 'manifest' as const,
      reserved: false,
      writable: true,
      valueState: 'configured' as const,
      effectiveValue: value,
      sourceLayer: scope,
      storedValue: value,
      storedSourceLayer: scope,
    });
    const userRaw = { token: 'inherited-secret', region: 'west' };
    const projectRaw = { token: 'current-secret', region: 'east' };
    const page = buildConfigPage({
      pluginId: 'official/demo',
      schema,
      read: {
        pluginName: 'demo',
        scope: 'project',
        fields: [entry('project', { token: '[redacted]', region: 'east' })],
      },
      effectiveRead: {
        pluginName: 'demo',
        scope: 'effective',
        fields: [entry('project', { token: '[redacted]', region: 'east' })],
      },
      layerReads: {
        user: {
          pluginName: 'demo',
          scope: 'user',
          fields: [entry('user', { token: '[redacted]', region: 'west' })],
        },
        project: {
          pluginName: 'demo',
          scope: 'project',
          fields: [entry('project', { token: '[redacted]', region: 'east' })],
        },
      },
      rawValues: { credentials: projectRaw },
      rawLayerValues: { user: { credentials: userRaw }, project: { credentials: projectRaw } },
      effectiveRawValues: { credentials: projectRaw },
    });
    const field = page.groups[0]!.fields[0]!;

    expect(field.fallbackDisplayValue).toBe('已设置');
    expect(field.fallbackDisplayValue).not.toContain('Inherited service');
    expect(field.fallbackObjectChanges).toEqual(expect.arrayContaining([
      { property: 'region', before: 'east', after: 'west' },
      { property: 'token', before: '已设置', after: '已设置', private: true },
    ]));
    expect(JSON.stringify(field.fallbackObjectChanges)).not.toContain('current-secret');
    expect(JSON.stringify(field.fallbackObjectChanges)).not.toContain('inherited-secret');
  });

  it('projects an invalid user fallback instead of a schema default after project removal', () => {
    const schema = {
      fields: {
        mode: { type: 'string' as const, default: 'safe' },
      },
    };
    const page = buildConfigPage({
      pluginId: 'official/demo',
      schema,
      read: {
        pluginName: 'demo',
        scope: 'project',
        fields: [{
          key: 'mode',
          title: 'mode',
          kind: 'manifest',
          reserved: false,
          writable: true,
          valueState: 'configured',
          effectiveValue: 'fast',
          sourceLayer: 'project',
          storedValue: 'fast',
          storedSourceLayer: 'project',
          fallback: {
            state: 'invalid',
            sourceLayer: 'user',
            issues: [{ type: 'invalid-config', key: 'mode', source: 'user' }],
          },
          value: 'fast',
          source: 'project',
          matchedPreset: null,
          valid: true,
          issues: [],
        }],
      },
      layerReads: {
        user: {
          pluginName: 'demo',
          scope: 'user',
          fields: [{
            key: 'mode',
            title: 'mode',
            kind: 'manifest',
            reserved: false,
            writable: true,
            valueState: 'invalid',
            effectiveValue: null,
            sourceLayer: 'user',
            storedSourceLayer: 'user',
            value: null,
            source: 'user',
            matchedPreset: null,
            valid: false,
            issues: [{ type: 'invalid-config', key: 'mode', source: 'user' }],
          }],
        },
      },
      rawLayerValues: { user: { mode: 'invalid-user-secret' } },
    });
    const field = page.groups[0]!.fields[0]!;

    expect(field.fallbackDisplayValue).toContain('值无效');
    expect(field.fallbackDisplayValue).toContain('应用会被阻止');
    expect(field.fallbackSourceLabel).toBe('个人默认');
    expect(field.fallbackDisplayValue).not.toContain('safe');
    expect(JSON.stringify(field)).not.toContain('invalid-user-secret');
  });

  it('does not classify an object preset through sensitive KV values', () => {
    const schema = {
      fields: {
        credentials: {
          type: 'object' as const,
          choices: {
            allowCustom: true,
            presets: [
              { id: 'primary', title: 'Primary account', value: { account: 'secret-a' } },
              { id: 'secondary', title: 'Secondary account', value: { account: 'secret-b' } },
            ],
          },
          additionalProperties: { type: 'string' as const, sensitive: true },
        },
      },
    };
    const page = buildConfigPage({
      pluginId: 'official/demo',
      schema,
      read: {
        pluginName: 'demo',
        scope: 'effective',
        fields: [{
          key: 'credentials',
          title: 'credentials',
          kind: 'manifest',
          reserved: false,
          writable: true,
          valueState: 'configured',
          effectiveValue: { account: '[redacted]' },
          sourceLayer: 'user',
        }],
      },
      effectiveRawValues: { credentials: { account: 'secret-a' } },
    });
    const field = page.groups[0]!.fields[0]!;

    expect(field.displayValue).toBe('已设置');
    expect(field).not.toHaveProperty('matchedPresetId');
    expect(field.displayValue).not.toContain('Primary account');
    expect(field.displayValue).not.toContain('自定义');
  });
  it('restores list focus, query, and source tab after a detail route goes back', () => {
    const router = new TuiRouter();
    router.push(
      { name: 'pluginList', mode: 'browse', sourceId: 'team' },
      { focusIndex: 4, scrollOffset: 2, query: 'gate', sourceTabId: 'team' },
    );
    router.push({ name: 'pluginDetail', pluginId: 'team/review-gate' });

    expect(router.back()).toMatchObject({
      depth: 2,
      current: {
        route: { name: 'pluginList', mode: 'browse', sourceId: 'team' },
        context: { focusIndex: 4, scrollOffset: 2, query: 'gate', sourceTabId: 'team' },
      },
    });
  });

  it('keeps dependency detail optional and restores the originating route on back', () => {
    const router = new TuiRouter();
    router.push({ name: 'pluginPreview', pluginId: 'official/root' }, { focusIndex: 1 });
    router.push({ name: 'pluginDependencies', pluginId: 'official/root' });

    expect(router.back()).toMatchObject({
      depth: 2,
      current: {
        route: { name: 'pluginPreview', pluginId: 'official/root' },
        context: { focusIndex: 1 },
      },
    });
  });

  it('owns transient frames by a stable flow and finishes at the preserved plugin anchor', () => {
    const router = new TuiRouter();
    router.push(
      { name: 'pluginList', mode: 'browse', sourceId: 'official' },
      {
        focusIndex: 2,
        scrollOffset: 1,
        query: 'agent',
        sourceTabId: 'official',
        focusedEntityId: 'official/demo',
      },
    );
    router.push({ name: 'pluginPreview', pluginId: 'official/demo' });
    const originFrameId = router.snapshot.currentFrameId;
    const flow = router.beginPluginFlow('pluginInstall', 'official/demo');
    router.push({ name: 'installPlacement', pluginId: 'official/demo' });
    const stepFrameId = router.snapshot.currentFrameId;
    router.push({ name: 'installTargets', pluginId: 'official/demo' });

    expect(router.snapshot.currentFlowId).toBe(flow.id);
    expect(flow.originFrameId).toBe(originFrameId);
    expect(router.back().currentFrameId).toBe(stepFrameId);

    router.push({ name: 'review', operationId: 'operation-1' });
    router.replace({ name: 'progress', operationId: 'operation-1' });
    router.finishFlow(
      { name: 'pluginDetail', pluginId: 'official/demo' },
      { name: 'result', operationId: 'operation-1' },
    );

    expect(router.snapshot).toMatchObject({
      depth: 4,
      current: { route: { name: 'result', operationId: 'operation-1' } },
    });
    expect(router.snapshot.currentFlowId).toBeUndefined();
    router.back();
    expect(router.snapshot.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/demo' });
    router.back();
    expect(router.snapshot.current).toEqual({
      route: { name: 'pluginList', mode: 'browse', sourceId: 'official' },
      context: {
        focusIndex: 2,
        scrollOffset: 1,
        query: 'agent',
        sourceTabId: 'official',
        focusedEntityId: 'official/demo',
      },
    });
  });

  it('returns a nested Portable flow to target platforms and can close the full install flow', () => {
    const router = new TuiRouter();
    router.push({ name: 'pluginPreview', pluginId: 'official/demo' });
    const installFlow = router.beginPluginFlow('pluginInstall', 'official/demo');
    router.push({ name: 'installTargets', pluginId: 'official/demo' });
    router.beginPortableFlow('official/demo');
    router.push({ name: 'portableSkillSelect', pluginId: 'official/demo' });

    router.resetPortableFlow('official/demo');
    expect(router.snapshot.current.route).toEqual({
      name: 'installTargets', pluginId: 'official/demo',
    });
    expect(router.activeFlow()).toMatchObject({ id: installFlow.id, kind: 'pluginInstall' });

    router.beginPortableFlow('official/demo');
    router.push({ name: 'result', operationId: 'portable-1' });
    router.finishFlowById(
      installFlow.id,
      'pluginInstall',
      { name: 'pluginDetail', pluginId: 'official/demo' },
      { name: 'result', operationId: 'portable-1' },
    );
    router.back();
    expect(router.snapshot.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/demo',
    });
    expect(router.activeFlow()).toBeUndefined();
  });

  it('returns dependency overview evidence loaded by the runtime without recomputing a client closure', async () => {
    const overview = {
      pluginId: 'official/root',
      summary: { directCount: 1, transitiveCount: 0, totalCount: 1, readyCount: 0, missingCount: 1, issueCount: 0 },
      dependencies: [{
        pluginId: 'official/toolkit', displayName: 'Toolkit', relation: 'direct' as const,
        depth: 1, requiredBy: [{ pluginId: 'official/root', displayName: 'Root' }],
        placements: [], aggregateStatus: 'notInstalled' as const,
        placementReferences: [{ consumer: { pluginId: 'official/root', platform: 'codex' as const, scope: 'project' as const, project: 'current' as const }, dependency: { pluginId: 'official/toolkit', platform: 'codex' as const, scope: 'user' as const, project: null } }],
      }],
      dependents: [],
      blockers: [],
    };
    const captureEvidence = vi.fn().mockResolvedValue(baseEvidence);
    const controller = new TuiController(dependencies({
      captureEvidence,
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ targets: [
          target({ pluginName: 'root', scope: 'project', state: 'partial' }),
          target({ pluginName: 'toolkit', scope: 'user', state: 'present' }),
        ] }),
        pluginSummaries: summaries(['official', 'root'], ['official', 'toolkit']),
        dependencyOverviews: [overview, {
          pluginId: 'official/toolkit',
          summary: { directCount: 0, transitiveCount: 0, totalCount: 0, readyCount: 0, missingCount: 0, issueCount: 0 },
          dependencies: [],
          dependents: [{
            pluginId: 'official/root', displayName: 'Root', relation: 'dependent' as const,
            depth: 1, requiredBy: [], placements: [], aggregateStatus: 'notInstalled' as const,
            placementReferences: [{ consumer: { pluginId: 'official/root', platform: 'codex' as const, scope: 'project' as const, project: 'current' as const }, dependency: { pluginId: 'official/toolkit', platform: 'codex' as const, scope: 'user' as const, project: null } }],
          }],
          blockers: [],
        }],
      }),
    }));
    await controller.load();

    expect(controller.getPluginDependencyOverview('official/root')).toEqual(overview);
    expect(controller.getPluginOverview('official/root')?.dependencySummary).toEqual(overview.summary);
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'uninstall', pluginId: 'official/root', platform: 'codex', scope: 'user',
    });
    expect(review.changes).toContainEqual(expect.objectContaining({
      group: 'preserved', pluginId: 'official/toolkit', kind: 'keep',
    }));
    await expect(controller.buildOperationReview({
      kind: 'pluginWrite', action: 'uninstall', pluginId: 'official/toolkit', platform: 'codex', scope: 'user',
    })).resolves.toMatchObject({ pluginAction: 'uninstall' });
    await expect(controller.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'official/toolkit', platform: 'codex', scope: 'user',
      force: true,
    })).resolves.toMatchObject({
      pluginAction: 'cleanup',
      title: '强制清理插件',
      description: expect.stringContaining('依赖者会变为不完整'),
      equivalentCommand: 'aw cleanup official/toolkit --platform codex --scope user --force',
      changes: expect.arrayContaining([
        expect.objectContaining({ kind: 'warning', title: '跳过依赖保护' }),
      ]),
    });
    expect(captureEvidence).toHaveBeenCalledTimes(3);
  });

  it('does not block dependency removal for an explicitly absent consumer target', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ targets: [
          target({ pluginName: 'root', scope: 'project', state: 'absent' }),
          target({ pluginName: 'toolkit', scope: 'user', state: 'present' }),
        ] }),
        pluginSummaries: summaries(['official', 'root'], ['official', 'toolkit']),
        dependencyOverviews: [{
          pluginId: 'official/toolkit',
          summary: { directCount: 0, transitiveCount: 0, totalCount: 0, readyCount: 0, missingCount: 0, issueCount: 0 },
          dependencies: [],
          dependents: [{
            pluginId: 'official/root', displayName: 'Root', relation: 'dependent' as const,
            depth: 1, requiredBy: [], placements: [], aggregateStatus: 'notInstalled' as const,
            placementReferences: [{
              consumer: { pluginId: 'official/root', platform: 'codex' as const, scope: 'project' as const, project: 'current' as const },
              dependency: { pluginId: 'official/toolkit', platform: 'codex' as const, scope: 'user' as const, project: null },
            }],
          }],
          blockers: [],
        }],
      }),
    }));
    await controller.load();

    await expect(controller.buildOperationReview({
      kind: 'pluginWrite', action: 'uninstall', pluginId: 'official/toolkit', platform: 'codex', scope: 'user',
    })).resolves.toMatchObject({ operationKind: 'pluginWrite', pluginAction: 'uninstall' });
  });

  it('keeps same-name plugins separate and sorts the tie by source identity', () => {
    const view = buildTuiViewModel({
      status: status({
        sources: [
          source('official'),
          source('team', { primary: false }),
        ],
        targets: [
          target({ sourceId: 'team', pluginName: 'review-gate', scope: 'user', state: 'absent' }),
          target({ sourceId: 'official', pluginName: 'review-gate', scope: 'user', state: 'present' }),
        ],
      }),
      pluginSummaries: summaries(['team', 'review-gate'], ['official', 'review-gate']),
    });

    expect(view.plugins.map((plugin) => [plugin.pluginId, plugin.aggregateStatus])).toEqual([
      ['official/review-gate', 'installed'],
      ['team/review-gate', 'available'],
    ]);
  });

  it('projects typed dependency issue actions to the canonical dependency target', () => {
    const missing = target({ pluginName: 'root', scope: 'project', state: 'partial' });
    if (missing.platform !== 'codex') throw new Error('Expected Codex fixture.');
    missing.placements[0]!.components.push({
      kind: 'intent', key: 'desired', state: 'desired',
      metadata: { enabled: true, scopes: ['project'], relation: 'root' },
    });
    missing.placements[0]!.reasons = [{
      code: 'dependencyMissing',
      message: 'dependencyMissing: official/toolkit is absent at its recorded target.',
      severity: 'warning',
      dependencyPluginId: 'official/toolkit',
      dependencyPlatform: 'codex',
      dependencyScope: 'user',
      dependencyProject: null,
    }];
    missing.placements[0]!.recoveryActions = [{
      command: 'sync', scope: 'project', description: 'Sync the complete root dependency plan.',
    }];
    missing.reasons = missing.placements[0]!.reasons;
    missing.recoveryActions = missing.placements[0]!.recoveryActions;
    const view = buildTuiViewModel({
      status: status({ targets: [missing] }),
      pluginSummaries: summaries(['official', 'root'], ['official', 'toolkit']),
      dependencyOverviews: [{
        pluginId: 'official/root',
        summary: { directCount: 1, transitiveCount: 0, totalCount: 1, readyCount: 0, missingCount: 1, issueCount: 1 },
        dependencies: [{
          pluginId: 'official/toolkit', displayName: 'Toolkit', relation: 'direct', depth: 1,
          requiredBy: [{ pluginId: 'official/root', displayName: 'Root' }], placements: [],
          aggregateStatus: 'notInstalled', placementReferences: [{
            consumer: { pluginId: 'official/root', platform: 'codex', scope: 'project', project: 'current' },
            dependency: { pluginId: 'official/toolkit', platform: 'codex', scope: 'user', project: null },
          }],
        }],
        dependents: [], blockers: [],
      }],
    });

    expect(view.issues).toContainEqual(expect.objectContaining({
      category: 'dependencyMissing',
      pluginId: 'official/root',
      dependencyPluginId: 'official/toolkit',
      platform: 'codex',
      scope: 'project',
      actions: expect.arrayContaining([expect.objectContaining({
        id: 'sync',
        pluginId: 'official/root',
        writeAction: 'sync',
        platform: 'codex',
        scope: 'project',
      })]),
    }));
    expect(view.issues[0]?.actions.some((action) => action.id === 'installDependency')).toBe(false);
  });

  it('keeps usable shared Codex content out of installed and attention lists without scope evidence', () => {
    // Risk: aggregate shared content can survive after the last consumer is disabled.
    const inactive = target({ pluginName: 'inactive', scope: 'user', state: 'absent' });
    if (inactive.platform !== 'codex') throw new Error('Expected Codex fixture.');
    inactive.components.push({
      kind: 'sharedNative', key: 'inactive@aw-official', state: 'usable', metadata: { shared: true },
    });
    inactive.placements[0]!.components = [
      { kind: 'ownership', key: 'native', state: 'partial' },
      { kind: 'activation', key: 'user', state: 'disabled', metadata: { evidence: 'observed' } },
      { kind: 'extension', key: 'aw', state: 'missing', metadata: { kinds: [] } },
    ];

    const view = buildTuiViewModel({
      status: status({ targets: [inactive] }),
      pluginSummaries: summaries(['official', 'inactive']),
    });

    expect(view.plugins[0]).toMatchObject({
      aggregateStatus: 'available',
      installedPlacements: [{ platform: 'codex', state: 'notInstalled' }],
    });
    expect(view.home.installedPlugins).toBe(0);
    expect(view.home.issueCount).toBe(0);
  });

  it('does not derive a write action from damaged shared content without a consumer scope', () => {
    // Risk: a shared recovery hint must not create intent or target an inactive scope.
    const inactive = target({ pluginName: 'inactive', scope: 'user', state: 'absent' });
    if (inactive.platform !== 'codex') throw new Error('Expected Codex fixture.');
    inactive.state = 'needsSync';
    inactive.components.push({
      kind: 'sharedNative', key: 'inactive@aw-official', state: 'replaceable',
      metadata: { shared: true, reason: 'damaged' },
    });
    inactive.reasons = [{
      code: 'codexSharedNativeCorrupt', message: 'safe damaged evidence', severity: 'warning',
    }];
    inactive.recoveryActions = [{
      command: 'manual', scope: 'user', description: '选择使用位置后重新安装。',
    }];

    const view = buildTuiViewModel({
      status: status({ targets: [inactive] }),
      pluginSummaries: summaries(['official', 'inactive']),
    });

    expect(view.plugins[0]?.aggregateStatus).toBe('available');
    expect(buildPluginPreviewActions(view.plugins[0]!).map((action) => action.id)).toContain('add');
    expect(view.issues[0]?.actions.map((action) => action.id)).toEqual(['viewTechnical']);
  });

  it('keeps root recovery scope exact when a desired consumer dependency is not ready', () => {
    // Risk: a healthy project dependency must not replace the failed user dependency target.
    const consumer = target({ pluginName: 'root', scope: 'project', state: 'partial' });
    if (consumer.platform !== 'codex') throw new Error('Expected Codex fixture.');
    consumer.placements[0]!.components.push({
      kind: 'intent', key: 'desired', state: 'desired',
      metadata: { enabled: true, scopes: ['project'], relation: 'root' },
    });
    consumer.placements[0]!.reasons = [{
      code: 'dependencyNotReady', message: 'safe dependency evidence', severity: 'warning',
      dependencyPluginId: 'official/toolkit', dependencyPlatform: 'codex',
      dependencyScope: 'user', dependencyProject: null,
    }];
    consumer.placements[0]!.recoveryActions = [{
      command: 'sync', scope: 'project', description: 'Sync the complete root dependency plan.',
    }];
    consumer.placements[0]!.recoveryActions = [{
      command: 'sync', scope: 'project', description: 'Sync the complete root dependency plan.',
    }];
    consumer.reasons = consumer.placements[0]!.reasons;
    consumer.recoveryActions = consumer.placements[0]!.recoveryActions;
    consumer.recoveryActions = consumer.placements[0]!.recoveryActions;
    const dependency = target({ pluginName: 'toolkit', scope: 'project', state: 'present' });

    const issue = buildTuiViewModel({
      status: status({ targets: [consumer, dependency] }),
      pluginSummaries: summaries(['official', 'root'], ['official', 'toolkit']),
    }).issues.find((entry) => entry.category === 'dependencyNotReady')!;

    expect(issue.explanation).toContain('official/toolkit（Codex · 所有项目）');
    expect(issue.actions).toContainEqual(expect.objectContaining({
      id: 'sync', pluginId: 'official/root', platform: 'codex', scope: 'project',
    }));
    expect(issue.actions).not.toContainEqual(expect.objectContaining({
      pluginId: 'official/toolkit', scope: 'project', writeAction: 'reinstall',
    }));
  });

  it('keeps cleanup on orphaned consumers and merges each exact recovery action', () => {
    // Risk: collapsing one dependency root can change cleanup to the dependency identity or drop a consumer.
    const rootIssueId = 'incompleteInstallation:official/toolkit:codex:user';
    const consumer = (pluginName: string, scope: 'user' | 'project') => {
      const value = target({ pluginName, scope, state: 'present' });
      if (value.platform !== 'codex') throw new Error('Expected Codex fixture.');
      value.state = 'orphaned';
      value.placements[0]!.state = 'orphaned';
      value.placements[0]!.reasons = [{
        code: 'dependencyNotReady', message: 'safe dependency evidence', severity: 'warning',
        dependencyPluginId: 'official/toolkit', dependencyPlatform: 'codex',
        dependencyScope: 'user', dependencyProject: null,
        rootIssueId, rootIssueCode: 'incompleteInstallation',
      }];
      value.placements[0]!.recoveryActions = [{
        command: 'cleanup', scope, description: `Clean ${scope} root output.`,
      }];
      value.reasons = value.placements[0]!.reasons;
      value.recoveryActions = value.placements[0]!.recoveryActions;
      return value;
    };

    const issue = buildTuiViewModel({
      status: status({ targets: [consumer('consumer-a', 'user'), consumer('consumer-b', 'project')] }),
      pluginSummaries: summaries(
        ['official', 'consumer-a'], ['official', 'consumer-b'], ['official', 'toolkit'],
      ),
    }).issues.find((entry) => entry.issueId === rootIssueId)!;

    expect(issue.actions.filter((action) => action.id === 'cleanup')).toEqual([
      expect.objectContaining({ pluginId: 'official/consumer-a', platform: 'codex', scope: 'user' }),
      expect.objectContaining({ pluginId: 'official/consumer-b', platform: 'codex', scope: 'project' }),
    ]);
    expect(issue.actions.some((action) => action.id === 'installDependency'
      || action.id === 'reinstallDependency')).toBe(false);
  });

  it('verifies only the selected consumer after merged cleanup succeeds', async () => {
    // Risk: the surviving first consumer must not make a completed second cleanup look failed.
    const rootIssueId = 'incompleteInstallation:official/toolkit:codex:user';
    const consumer = (pluginName: string, scope: 'user' | 'project') => {
      const value = target({ pluginName, scope, state: 'present' });
      if (value.platform !== 'codex') throw new Error('Expected Codex fixture.');
      value.state = 'orphaned';
      value.placements[0]!.state = 'orphaned';
      value.placements[0]!.reasons = [{
        code: 'dependencyNotReady', message: 'safe dependency evidence', severity: 'warning',
        dependencyPluginId: 'official/toolkit', dependencyPlatform: 'codex',
        dependencyScope: 'user', dependencyProject: null,
        rootIssueId, rootIssueCode: 'incompleteInstallation',
      }];
      value.placements[0]!.recoveryActions = [{
        command: 'cleanup', scope, description: `Clean ${scope} root output.`,
      }];
      value.reasons = value.placements[0]!.reasons;
      value.recoveryActions = value.placements[0]!.recoveryActions;
      return value;
    };
    const summariesValue = summaries(
      ['official', 'consumer-a'], ['official', 'consumer-b'], ['official', 'toolkit'],
    );
    const before: TuiStatusLoadResult = {
      payload: status({ targets: [consumer('consumer-a', 'user'), consumer('consumer-b', 'project')] }),
      pluginSummaries: summariesValue,
    };
    const after: TuiStatusLoadResult = {
      payload: status({ targets: [consumer('consumer-a', 'user')] }),
      pluginSummaries: summariesValue,
    };
    const value = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'succeeded',
        targetResults: [{
          target: { pluginId: 'official/consumer-b', platform: 'codex', scope: 'project' },
          action: 'cleanup', state: 'completed',
        }],
      }),
    }));
    await value.load();
    const issue = value.listUserIssues().find((entry) => entry.issueId === rootIssueId)!;
    const action = issue.actions.find((entry) => entry.id === 'cleanup'
      && entry.pluginId === 'official/consumer-b')!;
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: action.pluginId!,
      platform: action.platform!, scope: action.scope!,
      originIssue: {
        issueId: issue.issueId, issueKey: userIssueKey(issue), category: issue.category,
        actionId: action.id, consumerPluginId: action.pluginId,
        consumerSourceIdentity: 'identity:official', consumerPlatform: action.platform,
        consumerScope: action.scope, dependencyPluginId: issue.dependencyPluginId,
        dependencyPlatform: issue.dependencyPlatform, dependencyScope: issue.dependencyScope,
        dependencyProject: issue.dependencyProject,
      },
    });

    await expect(value.executeOperation(review.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    expect(value.listUserIssues()[0]?.affectedTargets).toEqual([
      expect.objectContaining({ pluginId: 'official/consumer-a', scope: 'user' }),
    ]);
  });

  it('does not synthesize a conflict or removal recovery for two ready pure-native scopes', () => {
    const pureNativeTarget = (scope: 'user' | 'project') => {
      const value = target({ scope, state: 'present' });
      value.components.push(
        {
          kind: 'intent', key: 'desired', state: 'desired',
          metadata: { enabled: true, scopes: ['project', 'user'], relation: 'root' },
        },
        { kind: 'sharedNative', key: 'demo@aw-official', state: 'usable', metadata: { shared: true } },
        { kind: 'activation', key: 'user', state: 'enabled', metadata: { effective: true, evidence: 'observed' } },
        { kind: 'activation', key: 'project', state: 'enabled', metadata: { effective: true, evidence: 'observed' } },
      );
      return value;
    };
    const view = buildTuiViewModel({
      status: status({
        targets: [
          pureNativeTarget('user'),
          pureNativeTarget('project'),
        ],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });

    expect(view.plugins[0]?.installedPlacements).toEqual([
      expect.objectContaining({
        platform: 'codex', state: 'installed', health: 'ready',
        desiredScopes: ['project', 'user'], actualState: 'ready',
      }),
    ]);
    expect(view.issues.some((issue) => issue.category === 'scopeConflict')).toBe(false);
    expect(buildPluginDetailActions(view.plugins[0]!).some((action) =>
      action.id === 'resolveScopeConflict')).toBe(false);
  });

  it('keeps shared V8 diagnostics singular and exposes both ready Codex lifecycle placements', () => {
    const shared = target({ pluginName: 'shared-ready', scope: 'user', state: 'partial' });
    shared.state = 'needsSync';
    shared.components.push({
      kind: 'sharedNative', key: 'shared-ready@aw-official', state: 'replaceable',
      metadata: { shared: true, reason: 'renderDrift', version: '1.0.0' },
    });
    shared.reasons = [{
      code: 'codexSharedNativeRenderDrift', message: 'shared render drift', severity: 'warning',
    }];
    shared.recoveryActions = [
      { command: 'sync', scope: 'user', description: 'Synchronize user.' },
      { command: 'sync', scope: 'project', description: 'Synchronize project.' },
    ];
    shared.placements[0] = {
      scope: 'user',
      state: 'needsSync',
      components: [
        { kind: 'intent', key: 'desired', state: 'desired', metadata: {
          enabled: true, scopes: ['user'], relation: 'root',
        } },
        { kind: 'ownership', key: 'fixture-user', state: 'present' },
        { kind: 'activation', key: 'user', state: 'enabled', metadata: { evidence: 'observed' } },
      ],
      reasons: [],
      recoveryActions: [{ command: 'sync', scope: 'user', description: 'Synchronize user.' }],
    };
    shared.placements.push({
      scope: 'project',
      state: 'needsSync',
      components: [
        { kind: 'intent', key: 'desired', state: 'desired', metadata: {
          enabled: true, scopes: ['project'], relation: 'root',
        } },
        { kind: 'ownership', key: 'fixture-project', state: 'present' },
        { kind: 'activation', key: 'project', state: 'enabled', metadata: { evidence: 'observed' } },
      ],
      reasons: [],
      recoveryActions: [{ command: 'sync', scope: 'project', description: 'Synchronize project.' }],
    });

    const ready = target({ pluginName: 'dual-ready', scope: 'user', state: 'present' });
    ready.components.push({
      kind: 'sharedNative', key: 'dual-ready@aw-official', state: 'usable',
      metadata: { shared: true, version: '1.0.0' },
    }, {
      kind: 'systemConsumer', key: 'codex:user', state: 'compatible',
    }, {
      kind: 'systemConsumer', key: 'codex:project', state: 'compatible',
    });
    ready.placements[0] = {
      scope: 'user',
      state: 'ready',
      components: [
        { kind: 'intent', key: 'desired', state: 'desired', metadata: {
          enabled: true, scopes: ['user'], relation: 'root',
        } },
        { kind: 'ownership', key: 'fixture-user', state: 'present' },
        { kind: 'activation', key: 'user', state: 'enabled', metadata: { evidence: 'observed' } },
      ],
      reasons: [], recoveryActions: [],
    };
    ready.placements.push({
      scope: 'project',
      state: 'ready',
      components: [
        { kind: 'intent', key: 'desired', state: 'desired', metadata: {
          enabled: true, scopes: ['project'], relation: 'root',
        } },
        { kind: 'ownership', key: 'fixture-project', state: 'present' },
        { kind: 'activation', key: 'project', state: 'enabled', metadata: { evidence: 'observed' } },
      ],
      reasons: [], recoveryActions: [],
    });

    const view = buildTuiViewModel({
      status: status({ targets: [shared, ready] }),
      pluginSummaries: summaries(['official', 'shared-ready'], ['official', 'dual-ready']),
    });
    const sharedDiagnostics = view.issues.filter((issue) => issue.pluginId === 'official/shared-ready'
      && issue.technicalDetails.some((detail) => detail.code === 'codexSharedNativeRenderDrift'));
    expect(sharedDiagnostics).toEqual([expect.objectContaining({ placements: ['project', 'user'] })]);
    const sharedPlugin = view.plugins.find((entry) => entry.pluginId === 'official/shared-ready')!;
    expect(sharedPlugin.installedPlacements).toEqual([expect.objectContaining({
      platform: 'codex',
      desiredScopes: ['project', 'user'],
      scopedPlacements: expect.arrayContaining([
        expect.objectContaining({ scope: 'project', actualState: 'needsSync' }),
        expect.objectContaining({ scope: 'user', actualState: 'needsSync' }),
      ]),
    })]);
    expect(buildPlatformActions(sharedPlugin, 'codex')).toEqual(expect.arrayContaining([
      { id: 'sync', platform: 'codex', scope: 'project' },
      { id: 'sync', platform: 'codex', scope: 'user' },
    ]));

    const plugin = view.plugins.find((entry) => entry.pluginId === 'official/dual-ready')!;
    expect(plugin.installedPlacements).toEqual([expect.objectContaining({
      platform: 'codex',
      scopedPlacements: expect.arrayContaining([
        expect.objectContaining({ scope: 'project', health: 'ready', actualState: 'ready' }),
        expect.objectContaining({ scope: 'user', health: 'ready', actualState: 'ready' }),
      ]),
    })]);
    expect(buildPlatformActions(plugin, 'codex')).toEqual(expect.arrayContaining([
      { id: 'reinstall', platform: 'codex', scope: 'project' },
      { id: 'remove', platform: 'codex', scope: 'project' },
      { id: 'reinstall', platform: 'codex', scope: 'user' },
      { id: 'remove', platform: 'codex', scope: 'user' },
    ]));
    expect(plugin.technicalComponents.filter((component) =>
      component.key === 'dual-ready@aw-official')).toEqual([
      {
        platform: 'codex', shared: true, key: 'dual-ready@aw-official', state: 'usable',
      },
    ]);
    expect(plugin.technicalComponents.filter((component) => component.key.startsWith('codex:')))
      .toEqual([
        expect.objectContaining({ key: 'codex:user', platform: 'codex', scope: 'user' }),
        expect.objectContaining({ key: 'codex:project', platform: 'codex', scope: 'project' }),
      ]);
  });

  it.each([
    ['present', 'error'],
    ['error', 'present'],
  ] as const)('does not treat %s + %s as installed scope conflict evidence', (userState, projectState) => {
    const view = buildTuiViewModel({
      status: status({
        targets: [
          target({ scope: 'user', state: userState }),
          target({ scope: 'project', state: projectState }),
        ],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });

    expect(view.plugins[0]?.installedPlacements).toEqual([expect.objectContaining({
      platform: 'codex',
      state: 'installed',
      scope: userState === 'present' ? 'user' : 'project',
      health: 'ready',
      revision: { state: 'unknown', availableVersion: '1.0.0' },
    })]);
    expect(view.issues.some((issue) => issue.category === 'scopeConflict')).toBe(false);
    expect(view.issues.some((issue) => issue.category === 'diagnostic')).toBe(true);
  });

  it('projects top-level inventory errors once with safe stable details', () => {
    const view = buildTuiViewModel({
      status: status({
        targets: [target({ scope: 'user', state: 'error' })],
        errors: [
          { code: 'legacyStateUnsupported', message: 'legacy at /Users/private/state' },
          { code: 'nativeStateUnreadable', message: 'token=private-token' },
          { code: 'nativeStateUnreadable', message: 'duplicate raw error' },
          { code: 'targetError', message: 'already represented by the target' },
        ],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });

    expect(view.issues.map((issue) => issue.issueId)).toEqual([
      'status:nativeStateUnreadable',
      'status:legacyStateUnsupported',
      'diagnostic:official/demo:codex:user',
    ]);
    expect(JSON.stringify(view.issues)).not.toContain('/Users/private');
    expect(JSON.stringify(view.issues)).not.toContain('private-token');
  });

  it('presents shared native render drift as a recoverable sync warning', () => {
    const view = buildTuiViewModel({
      status: status({
        targets: [target({
          scope: 'project',
          state: 'partial',
          errors: [{
            code: 'codexSharedNativeRenderDrift',
            message: 'stable technical detail',
            severity: 'warning',
          }],
        })],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });

    const issue = view.issues[0]!;
    expect(issue).toMatchObject({
      title: expect.stringContaining('由平台共用的内容待同步'),
      explanation: 'Codex 平台由多个项目共用的生成内容与当前渲染输入不一致。',
      impact: ['运行同步可重新生成由平台共用的 Skill。'],
      technicalDetails: [{
        code: 'codexSharedNativeRenderDrift',
        message: '状态检查报告了这个安全错误代码。',
      }],
    });
    expect(JSON.stringify(issue)).not.toContain('corrupt');
  });

  it('presents damaged shared generated content without claiming config drift', () => {
    const view = buildTuiViewModel({
      status: status({
        targets: [target({
          scope: 'project',
          state: 'partial',
          errors: [{
            code: 'codexSharedNativeCorrupt',
            message: 'stable technical detail',
            severity: 'warning',
          }],
        })],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });

    expect(view.issues[0]).toMatchObject({
      title: expect.stringContaining('由平台共用的内容待同步'),
      explanation: 'Codex 平台由多个项目共用的生成内容缺失或损坏。',
      impact: ['运行同步可重新生成由平台共用的 Skill。'],
    });
  });

  it('classifies issue routes from typed status and config evidence without message matching', () => {
    const view = buildTuiViewModel({
      status: status({
        targets: [
          target({ pluginName: 'partial', scope: 'user', state: 'partial' }),
          target({
            pluginName: 'collision',
            scope: 'user',
            state: 'absent',
            errors: [{
              code: 'artifactCollision',
              message: 'safe collision',
              severity: 'blocking',
              collision: {
                reason: 'unownedContent',
                artifactKind: 'skill-directory',
                artifactKey: 'review',
                expectedOwner: 'official/collision',
              },
            }],
          }),
          target({
            pluginName: 'missing', scope: 'user', state: 'error', errorCode: 'sourceMissing',
            recoveryActions: [
              { command: 'sync', description: '来源恢复后同步 desired intent。' },
              { command: 'cleanup', description: '清理可证明属于 AW 的输出。' },
            ],
          }),
          target({ pluginName: 'changed', scope: 'user', state: 'error', errorCode: 'sourceChanged' }),
          target({
            pluginName: 'offline', scope: 'user', state: 'error', errorCode: 'catalogSourceUnavailable',
            recoveryActions: [{ command: 'cleanup', scope: 'user', description: 'Clean user target.' }],
          }),
          target({
            pluginName: 'offline-two', scope: 'project', state: 'error', errorCode: 'catalogSourceUnavailable',
            recoveryActions: [{ command: 'cleanup', scope: 'project', description: 'Clean project target.' }],
          }),
        ],
        errors: [{ code: 'legacyStateUnsupported', message: 'arbitrary text that does not name legacy state', severity: 'blocking' }],
      }),
      pluginSummaries: [{
        pluginName: 'required',
        pluginId: 'official/required',
        description: 'required config fixture',
        configIssues: [{ scope: 'user', type: 'missing-required', key: 'rules', title: '规则文件', source: 'missing' }],
      }],
      sourceHealth: new Map([['official', {
        sourceId: 'official',
        state: 'unavailable',
        issueId: 'source:official:unavailable',
      }]]),
    });

    expect(Object.fromEntries(view.issues.map((issue) => [issue.issueId, issue.category]))).toMatchObject({
      'incompleteInstallation:official/partial:codex:user': 'incompleteInstallation',
      'target:official/collision:codex:user:absent': 'artifactCollision',
      'target:official/missing:codex:user:blocked': 'sourceMissing',
      'target:official/changed:codex:user:blocked': 'sourceIdentityChanged',
      'config:official/required:required': 'requiredConfigMissing',
      'status:legacyStateUnsupported': 'legacyState',
      'source:official:unavailable': 'sourceUnavailable',
    });
    expect(JSON.stringify(view.issues)).not.toContain('arbitrary text');
    expect(view.issues.find((issue) => issue.category === 'incompleteInstallation')?.actions
      .map((action) => action.id)).toEqual(['sync', 'viewTechnical']);
    const collision = view.issues.find((issue) => issue.category === 'artifactCollision');
    expect(collision).toMatchObject({
      title: expect.stringContaining('输出冲突'),
      explanation: expect.stringContaining('不会覆盖或删除'),
      actions: [{ id: 'viewTechnical' }, { id: 'retryLater' }],
      technicalDetails: [{ code: 'artifactCollision', message: '目标包含没有 AW owner 标记的内容。' }],
    });
    const sourceUnavailable = view.issues.find((issue) => issue.category === 'sourceUnavailable');
    expect(sourceUnavailable?.actions).toEqual([
      expect.objectContaining({
        id: 'cleanup', pluginId: 'official/offline', platform: 'codex', scope: 'user',
      }),
      expect.objectContaining({
        id: 'cleanup', pluginId: 'official/offline-two', platform: 'codex', scope: 'project',
      }),
      expect.objectContaining({ id: 'editSource' }),
      expect.objectContaining({ id: 'refreshSource' }),
      expect.objectContaining({ id: 'viewTechnical' }),
    ]);
    expect(sourceUnavailable?.affectedTargets).toEqual([
      { pluginId: 'official/offline', platform: 'codex', scope: 'user', relationship: 'direct' },
      { pluginId: 'official/offline-two', platform: 'codex', scope: 'project', relationship: 'direct' },
    ]);
    expect(view.issues.filter((issue) => issue.sourceId === 'official'
      && issue.category === 'sourceUnavailable')).toHaveLength(1);
    expect(view.issues.find((issue) => issue.category === 'sourceUnavailable')?.impact).toContain(
      '2 个安装位置受此来源根问题影响。',
    );
    expect(view.issues.find((issue) => issue.category === 'sourceMissing')?.actions.map((action) => action.id))
      .toEqual(['cleanup', 'reAddSource', 'viewTechnical']);
    expect(view.issues.find((issue) => issue.category === 'sourceIdentityChanged')?.actions.map((action) => action.id))
      .toEqual(['viewSourceChange', 'viewTechnical']);
  });

  it.each([
    ['catalogSourceUnavailable', 'sourceUnavailable', ['cleanup', 'editSource', 'viewTechnical']],
    ['bundleUnavailable', 'sourceUnavailable', ['cleanup', 'editSource', 'viewTechnical']],
    ['codexIntentSourceUnavailable', 'sourceUnavailable', ['cleanup', 'editSource', 'viewTechnical']],
    ['sourceMissing', 'sourceMissing', ['cleanup', 'reAddSource', 'viewTechnical']],
  ] as const)('classifies %s as %s and provides only its local recovery', (code, category, actions) => {
    const view = buildTuiViewModel({
      status: status({
        targets: [target({
          pluginName: `offline-${code}`,
          scope: 'user',
          state: 'error',
          errorCode: code,
          recoveryActions: [{ command: 'cleanup', description: '清理可证明属于 AW 的输出。' }],
        })],
      }),
      pluginSummaries: [],
    });

    expect(view.issues).toHaveLength(1);
    expect(view.issues[0]).toMatchObject({ category, rootCode: code, platform: 'codex', scope: 'user' });
    expect(view.issues[0]?.actions.map((action) => action.id)).toEqual(actions);
    expect(view.issues[0]?.actions[0]).toMatchObject({
      id: 'cleanup', platform: 'codex', scope: 'user', writeAction: 'cleanup',
    });
  });

  it('selects one stable primary reason and orders issue root groups', () => {
    const consumer = target({
      pluginName: 'consumer', scope: 'project', state: 'partial', errors: [{
        code: 'dependencyNotReady',
        message: 'safe dependency symptom',
        dependencyPluginId: 'official/leaf',
        rootIssueId: 'artifactCollision:official/leaf:codex:user:agent:leaf-role',
        rootIssueCode: 'artifactCollision',
        severity: 'warning',
      }],
    });
    const view = buildTuiViewModel({
      status: status({
        targets: [
          target({ pluginName: 'removed', scope: 'user', state: 'error', errorCode: 'sourceMissing' }),
          consumer,
          target({ sourceId: 'team', pluginName: 'graph', scope: 'user', state: 'absent' }),
          target({
            pluginName: 'dependency', scope: 'user', state: 'partial', errors: [{
              code: 'dependencyMissing',
              message: 'safe dependency evidence',
              dependencyPluginId: 'official/leaf',
              severity: 'warning',
            }],
          }),
          target({ pluginName: 'incomplete', scope: 'user', state: 'partial' }),
        ],
      }),
      pluginSummaries: [
        ...summaries(
          ['official', 'removed'],
          ['official', 'consumer'],
          ['official', 'leaf'],
          ['team', 'graph'],
          ['official', 'dependency'],
          ['official', 'incomplete'],
          ['official', 'available'],
        ),
        {
          pluginName: 'configured',
          pluginId: 'team/configured',
          description: 'config fixture',
          configIssues: [{
            scope: 'user', type: 'invalid-config', key: 'mode', title: '模式', source: 'user',
          }],
        },
        {
          pluginName: 'source-configured',
          pluginId: 'official/source-configured',
          description: 'source config fixture',
          configIssues: [{
            scope: 'user', type: 'invalid-config', key: 'mode', title: '模式', source: 'user',
          }],
        },
      ],
      sourceHealth: new Map([['official', {
        sourceId: 'official', state: 'unavailable', issueId: 'source:official:unavailable',
      }]]),
      dependencyOverviews: [{
        pluginId: 'team/graph',
        summary: { directCount: 1, transitiveCount: 0, totalCount: 1, readyCount: 0, missingCount: 0, issueCount: 1 },
        dependencies: [],
        dependents: [],
        blockers: [{
          code: 'dependencyGraphInvalid',
          title: '依赖关系无效',
          explanation: '依赖关系形成环。',
        }],
      }],
    });

    expect(view.issues.map((issue) => issue.group)).toEqual([
      'sourceRemoved',
      'artifactCollision',
      'sourceUnavailable',
      'dependency',
      'dependency',
      'config',
      'config',
      'installation',
    ]);
    expect(view.issues.filter((issue) =>
      issue.issueId === 'artifactCollision:official/leaf:codex:user:agent:leaf-role')).toHaveLength(1);
    expect(view.plugins.find((plugin) => plugin.pluginId === 'official/consumer')?.primaryAttention)
      .toEqual({
        severity: 'error',
        code: 'artifactCollision',
        message: '目标位置已有不属于当前插件的内容。AW 不会覆盖或删除这些内容。',
      });
    expect(view.plugins.find((plugin) => plugin.pluginId === 'team/configured')?.primaryAttention?.code)
      .toBe('invalidConfig');
    expect(view.plugins.find((plugin) => plugin.pluginId === 'official/available')?.primaryAttention)
      .toMatchObject({ severity: 'error', code: 'sourceUnavailable' });
    expect(view.plugins.find((plugin) => plugin.pluginId === 'official/incomplete')?.primaryAttention?.code)
      .toBe('sourceUnavailable');
    expect(view.plugins.find((plugin) => plugin.pluginId === 'official/dependency')?.primaryAttention?.code)
      .toBe('sourceUnavailable');
    expect(view.plugins.find((plugin) => plugin.pluginId === 'team/graph')?.primaryAttention?.code)
      .toBe('dependencyGraphInvalid');
    expect(view.plugins.find((plugin) => plugin.pluginId === 'official/source-configured')?.primaryAttention?.code)
      .toBe('sourceUnavailable');
  });

  it('keeps a direct root ahead of consumers and makes root aggregation order-independent', () => {
    const rootIssueId = 'artifactCollision:official/leaf:codex:user:agent:leaf-role';
    const direct = target({
      pluginName: 'leaf', scope: 'user', state: 'absent', errors: [{
        code: 'artifactCollision',
        message: 'safe direct collision',
        severity: 'blocking',
        rootIssueId,
        rootIssueCode: 'artifactCollision',
      }],
    });
    const consumer = (pluginName: string, scope: 'user' | 'project') => target({
      pluginName, scope, state: 'partial', errors: [{
        code: 'dependencyNotReady',
        message: 'safe dependency symptom',
        severity: 'warning',
        dependencyPluginId: 'official/leaf',
        rootIssueId,
        rootIssueCode: 'artifactCollision',
      }],
    });
    const targets = [consumer('consumer-b', 'project'), direct, consumer('consumer-a', 'user')];
    const project = (orderedTargets: StatusV8Payload['targets']) => buildTuiViewModel({
      status: status({ targets: orderedTargets }),
      pluginSummaries: summaries(
        ['official', 'leaf'],
        ['official', 'consumer-a'],
        ['official', 'consumer-b'],
      ),
    }).issues.find((issue) => issue.issueId === rootIssueId);

    expect(project(targets)).toMatchObject({
      pluginId: 'official/leaf',
      relationship: 'direct',
      rootEntity: { pluginId: 'official/leaf', platform: 'codex', scope: 'user' },
      affectedTargets: [
        { pluginId: 'official/consumer-a', platform: 'codex', scope: 'user', relationship: 'consumer' },
        { pluginId: 'official/consumer-b', platform: 'codex', scope: 'project', relationship: 'consumer' },
        { pluginId: 'official/leaf', platform: 'codex', scope: 'user', relationship: 'direct' },
      ],
    });
    expect(project([...targets].reverse())).toEqual(project(targets));
    expect(project(targets.filter((entry) => entry.pluginId !== 'official/leaf'))).toMatchObject({
      pluginId: 'official/leaf',
      relationship: 'consumer',
      rootEntity: { pluginId: 'official/leaf', platform: 'codex', scope: 'user' },
    });
  });

  it.each([
    {
      state: 'partial' as const,
      directErrors: [],
      rootIssueId: 'incompleteInstallation:official/leaf:codex:user',
      rootIssueCode: 'incompleteInstallation',
      category: 'incompleteInstallation',
    },
    {
      state: 'error' as const,
      directErrors: [{
        code: 'componentInspectionFailed',
        message: 'safe direct diagnostic',
        severity: 'blocking' as const,
      }],
      rootIssueId: 'diagnostic:official/leaf:codex:user',
      rootIssueCode: 'diagnostic',
      category: 'diagnostic',
    },
  ])('uses dependency evidence as the canonical key for a direct $state root', (fixture) => {
    const direct = target({
      pluginName: 'leaf', scope: 'user', state: fixture.state, errors: fixture.directErrors,
    });
    const consumer = (pluginName: string, scope: 'user' | 'project') => target({
      pluginName, scope, state: 'present', errors: [{
        code: 'dependencyNotReady',
        message: 'safe dependency symptom',
        severity: 'warning',
        dependencyPluginId: 'official/leaf',
        rootIssueId: fixture.rootIssueId,
        rootIssueCode: fixture.rootIssueCode,
      }],
    });
    const targets = [consumer('consumer-b', 'project'), direct, consumer('consumer-a', 'user')];
    const project = (orderedTargets: StatusV8Payload['targets']) => buildTuiViewModel({
      status: status({ targets: orderedTargets }),
      pluginSummaries: summaries(
        ['official', 'leaf'],
        ['official', 'consumer-a'],
        ['official', 'consumer-b'],
      ),
    }).issues.find((issue) => issue.issueId === fixture.rootIssueId);

    expect(project(targets)).toMatchObject({
      pluginId: 'official/leaf',
      category: fixture.category,
      relationship: 'direct',
      rootEntity: { pluginId: 'official/leaf', platform: 'codex', scope: 'user' },
      affectedTargets: [
        { pluginId: 'official/consumer-a', platform: 'codex', scope: 'user', relationship: 'consumer' },
        { pluginId: 'official/consumer-b', platform: 'codex', scope: 'project', relationship: 'consumer' },
        { pluginId: 'official/leaf', platform: 'codex', scope: 'user', relationship: 'direct' },
      ],
    });
    expect(project([...targets].reverse())).toEqual(project(targets));
  });

  it('selects an unavailable source before config and incomplete symptoms', () => {
    const view = buildTuiViewModel({
      status: status({ targets: [target({ pluginName: 'offline', scope: 'user', state: 'partial' })] }),
      pluginSummaries: [{
        pluginName: 'offline',
        pluginId: 'official/offline',
        description: 'offline fixture',
        configIssues: [{ scope: 'user', type: 'invalid-config', key: 'mode', title: '模式', source: 'user' }],
      }],
      sourceHealth: new Map([['official', {
        sourceId: 'official', state: 'unavailable', issueId: 'source:official:unavailable',
      }]]),
    });

    expect(view.plugins[0]?.primaryAttention).toMatchObject({
      severity: 'error', code: 'sourceUnavailable',
    });
  });

  it('keeps bundleUnavailable as a plugin target issue beside an unavailable source root', () => {
    const unavailableTarget = target({
      pluginName: 'offline', scope: 'user', state: 'error', errorCode: 'catalogSourceUnavailable',
    });
    unavailableTarget.placements[0]!.reasons.push({ code: 'bundleUnavailable', message: 'bundle missing' });
    unavailableTarget.reasons = unavailableTarget.placements[0]!.reasons;
    unavailableTarget.placements[0]!.recoveryActions = [
      { command: 'sync', description: '来源恢复后同步 desired intent。' },
      { command: 'cleanup', description: '清理可证明属于 AW 的输出。' },
    ];
    unavailableTarget.recoveryActions = unavailableTarget.placements[0]!.recoveryActions;
    const view = buildTuiViewModel({
      status: status({ targets: [unavailableTarget] }),
      pluginSummaries: [],
      sourceHealth: new Map([['official', {
        sourceId: 'official', state: 'unavailable', issueId: 'source:official:unavailable',
      }]]),
    });

    expect(view.issues).toHaveLength(2);
    expect(view.home.issueCount).toBe(2);
    expect(view.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        issueId: 'source:official:unavailable', category: 'sourceUnavailable',
        impact: expect.arrayContaining(['1 个安装位置受此来源根问题影响。']),
      }),
      expect.objectContaining({
        issueId: expect.stringContaining('bundleUnavailable'),
        pluginId: 'official/offline', category: 'sourceUnavailable',
        rootCode: 'bundleUnavailable', mergeEligible: false,
        title: expect.stringContaining('当前插件目录不再包含此插件'),
        explanation: '当前插件目录不再包含此插件，但仍发现 AW 管理的已安装内容。',
        actions: expect.arrayContaining([
          expect.objectContaining({ id: 'cleanup', writeAction: 'cleanup', label: '清理 AW 管理内容' }),
        ]),
      }),
    ]));
    expect(view.issues.find((issue) => issue.rootCode === 'bundleUnavailable')?.impact)
      .toContain('可以核验后取消这个位置的使用设置，并清理可信的 AW 现场。');
    expect(view.plugins).toContainEqual(expect.objectContaining({
      pluginId: 'official/offline',
      aggregateStatus: 'unavailable',
      installedPlacements: [expect.objectContaining({ state: 'installed', health: 'error' })],
    }));
  });

  it('keeps config issue type and layer while isolating a safe per-plugin read diagnostic', () => {
    const view = buildTuiViewModel({
      status: status(),
      pluginSummaries: [
        {
          pluginName: 'invalid', pluginId: 'official/invalid', description: 'invalid',
          configIssues: [{ scope: 'project', type: 'invalid-config', key: 'mode', title: '模式', source: 'project' }],
        },
        {
          pluginName: 'unreadable', pluginId: 'official/unreadable', description: 'unreadable',
          configDiagnostic: { scope: 'user', code: 'configReadFailed', message: '插件设置当前不可读。未读取或显示设置值。' },
        },
      ],
    });

    expect(view.issues.find((issue) => issue.pluginId === 'official/invalid')).toMatchObject({
      title: 'invalid · 设置值无效',
      configLayer: { scope: 'project' },
      requiredFields: [{ key: 'mode', title: '模式', type: 'invalid-config', source: 'project', scope: 'project' }],
      diagnostic: {
        technical: { code: 'invalid-config', stage: 'validate-config' },
      },
    });
    expect(view.issues.find((issue) => issue.pluginId === 'official/invalid')?.diagnostic.technical?.checks)
      .toContain('完成或修正列出的设置字段。');
    expect(view.issues.find((issue) => issue.pluginId === 'official/unreadable')).toMatchObject({
      category: 'diagnostic',
      technicalDetails: [{ code: 'configReadFailed', message: '设置读取报告了这个安全错误代码。' }],
      diagnostic: {
        technical: { code: 'configReadFailed', stage: 'read-config' },
      },
    });
  });
});

describe('TUI Catalog freshness session overlay', () => {
  it('reaches ready before a slow automatic freshness probe completes', async () => {
    const pending = deferred<{ sourceId: string; state: 'current' }>();
    const controller = new TuiController(dependencies({
      probeCatalogFreshness: vi.fn(() => pending.promise),
    }));

    await controller.load();

    expect(controller.snapshot.phase).toBe('ready');
    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'official', state: 'ready' });
    expect(controller.getPluginOverview('official/demo')).toBeDefined();
    pending.resolve({ sourceId: 'official', state: 'current' });
    await nextTurn();
    expect(controller.getCatalogFreshness('official')?.state).toBe('current');
    controller.dispose();
  });

  it('keeps a healthy Active source available when its background check fails', async () => {
    const controller = new TuiController(dependencies({
      probeCatalogFreshness: vi.fn(async () => {
        throw Object.assign(new Error('offline'), { code: 'catalogSourceResolutionFailed' });
      }),
    }));

    await controller.load();
    await nextTurn();

    expect(controller.getCatalogFreshness('official')).toMatchObject({
      state: 'checkFailed', errorCode: 'catalogSourceResolutionFailed',
    });
    expect(controller.snapshot.sourceHealth).toContainEqual({ sourceId: 'official', state: 'ready' });
    expect(controller.getPluginOverview('official/demo')?.aggregateStatus).not.toBe('unavailable');
    expect(controller.listSources()).toContainEqual(expect.objectContaining({
      id: 'official', state: 'ready',
    }));
    expect(controller.snapshot.viewModel?.home).toMatchObject({
      issueCount: 0,
      unavailableSourceCount: 0,
      catalogRecoveryCount: 0,
    });
    controller.dispose();
  });

  it('automatically checks only enabled sources but keeps manual checks available', async () => {
    const sources = [source('official', { primary: true }), source('team', { primary: false })];
    const probeCatalogFreshness = vi.fn(async (sourceId: string) => ({
      sourceId,
      state: 'current' as const,
    }));
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ sources }),
        pluginSummaries: summaries(['official', 'demo']),
        sourceDetails: [
          sourceDetail('official', { primary: true }),
          sourceDetail('team', { primary: false, autoCheck: false }),
        ],
      }),
      probeCatalogFreshness,
    }));

    await controller.load();
    await nextTurn();
    expect(probeCatalogFreshness.mock.calls.map(([sourceId]) => sourceId)).toEqual(['official']);
    expect(controller.getSourceOverview('team').detail?.autoCheck).toBe(false);

    await controller.recheckCatalogSource('team');
    expect(probeCatalogFreshness.mock.calls.map(([sourceId]) => sourceId)).toEqual(['official', 'team']);
    expect(probeCatalogFreshness.mock.calls.at(-1)?.[1]).toEqual({ fullValidation: true });
    controller.dispose();
  });

  it('explicitly checks every source with at most two probes in flight', async () => {
    const sources = [
      source('official', { primary: true }),
      source('team', { primary: false }),
      source('local', { primary: false }),
    ];
    const pending = new Map(sources.map(({ id }) => [id, deferred<{
      sourceId: string;
      state: 'current';
    }>()]));
    let active = 0;
    let maximumActive = 0;
    const probeCatalogFreshness = vi.fn(async (sourceId: string) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await pending.get(sourceId)!.promise;
      } finally {
        active -= 1;
      }
    });
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ sources }),
        pluginSummaries: summaries(['official', 'demo']),
        sourceDetails: sources.map(({ id, primary }) => sourceDetail(id, {
          primary,
          autoCheck: false,
        })),
      }),
      probeCatalogFreshness,
    }));

    await controller.load();
    const checking = controller.recheckAllCatalogSources();
    await nextTurn();
    expect(probeCatalogFreshness.mock.calls.map(([sourceId]) => sourceId)).toEqual([
      'official', 'team',
    ]);
    pending.get('official')!.resolve({ sourceId: 'official', state: 'current' });
    await nextTurn();
    expect(probeCatalogFreshness.mock.calls.map(([sourceId]) => sourceId)).toEqual([
      'official', 'team', 'local',
    ]);
    pending.get('team')!.resolve({ sourceId: 'team', state: 'current' });
    pending.get('local')!.resolve({ sourceId: 'local', state: 'current' });
    await checking;

    expect(maximumActive).toBe(2);
    expect(probeCatalogFreshness).toHaveBeenCalledTimes(3);
    controller.dispose();
  });

  it('coalesces repeated ordinary checks for the same source', async () => {
    const pending = deferred<{ sourceId: string; state: 'current' }>();
    const probeCatalogFreshness = vi.fn(() => pending.promise);
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status(),
        pluginSummaries: summaries(['official', 'demo']),
        sourceDetails: [sourceDetail('official', { autoCheck: false })],
      }),
      probeCatalogFreshness,
    }));

    await controller.load();
    const first = controller.recheckCatalogSource('official');
    const second = controller.recheckCatalogSource('official');
    await nextTurn();

    expect(probeCatalogFreshness).toHaveBeenCalledTimes(1);
    pending.resolve({ sourceId: 'official', state: 'current' });
    await Promise.all([first, second]);
    controller.dispose();
  });

  it('aborts and invalidates a running automatic check when autoCheck is disabled', async () => {
    const pending = deferred<{ sourceId: string; state: 'updateAvailable' }>();
    let aborted = false;
    const enabled = {
      payload: status(),
      pluginSummaries: summaries(['official', 'demo']),
      sourceDetails: [sourceDetail('official')],
    };
    const disabled = {
      ...enabled,
      sourceDetails: [sourceDetail('official', { autoCheck: false })],
    };
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(enabled)
      .mockResolvedValueOnce(disabled)
      .mockResolvedValueOnce(enabled);
    const probeCatalogFreshness = vi.fn((_sourceId, _options, signal: AbortSignal) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return pending.promise;
    });
    const controller = new TuiController(dependencies({ loadStatus, probeCatalogFreshness }));

    await controller.load();
    await nextTurn();
    await controller.reloadCatalog({ sourceId: 'official' });
    expect(aborted).toBe(true);
    expect(controller.getCatalogFreshness('official')?.state).toBe('notChecked');
    pending.resolve({ sourceId: 'official', state: 'updateAvailable' });
    await nextTurn();
    expect(controller.getCatalogFreshness('official')?.state).toBe('notChecked');

    await controller.reloadCatalog({ sourceId: 'official' });
    await nextTurn();
    expect(probeCatalogFreshness).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('queues a newly enabled source when it has not been attempted in this session', async () => {
    const initial = {
      payload: status(),
      pluginSummaries: summaries(['official', 'demo']),
      sourceDetails: [sourceDetail('official', { autoCheck: false })],
    };
    const enabled = {
      ...initial,
      sourceDetails: [sourceDetail('official')],
    };
    const probeCatalogFreshness = vi.fn(async (sourceId: string) => ({
      sourceId, state: 'current' as const,
    }));
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(enabled),
      probeCatalogFreshness,
    }));

    await controller.load();
    await nextTurn();
    expect(probeCatalogFreshness).not.toHaveBeenCalled();
    await controller.reloadCatalog({ sourceId: 'official' });
    await nextTurn();
    expect(probeCatalogFreshness).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('marks an exact commit source fixed without calling its automatic provider', async () => {
    const probeCatalogFreshness = vi.fn();
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status(),
        pluginSummaries: summaries(['official', 'demo']),
        sourceDetails: [sourceDetail('official', { explicitRef: 'a'.repeat(40) })],
        catalogGenerations: [{
          sourceId: 'official',
          sourceType: 'git',
          state: 'ready',
          active: {
            catalogVersion: '1.0.0', channel: 'latest', requestedRef: 'a'.repeat(40),
            resolvedCommit: 'a'.repeat(40), storeKey: 'official-active', digestShort: 'aaaaaaaa',
          },
        }],
      }),
      probeCatalogFreshness,
    }));

    await controller.load();
    await nextTurn();
    expect(probeCatalogFreshness).not.toHaveBeenCalled();
    expect(controller.getCatalogFreshness('official')?.state).toBe('fixed');
    controller.dispose();
  });

  it('selects light or complete manual source checks from the current Active state', async () => {
    const ready = {
      payload: status(),
      pluginSummaries: summaries(['official', 'demo']),
      sourceDetails: [sourceDetail('official', { autoCheck: false })],
      catalogGenerations: [{
        sourceId: 'official', sourceType: 'git' as const, state: 'ready' as const,
        active: {
          catalogVersion: '1.0.0', channel: 'latest' as const,
          requestedRef: 'catalog/latest', resolvedCommit: 'a'.repeat(40),
          storeKey: 'official-active', digestShort: 'aaaaaaaa',
        },
      }],
    };
    const damaged = {
      ...ready,
      catalogGenerations: [{
        ...ready.catalogGenerations[0]!, state: 'repairRequired' as const,
      }],
    };
    const unknown = {
      ...ready,
      catalogGenerations: [{
        ...ready.catalogGenerations[0]!, state: undefined,
      }],
    };
    const probeCatalogFreshness = vi.fn(async (sourceId: string) => ({
      sourceId, state: 'current' as const,
    }));
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce(ready)
        .mockResolvedValueOnce(damaged)
        .mockResolvedValueOnce(unknown),
      probeCatalogFreshness,
    }));

    await controller.load();
    await controller.recheckCatalogSource('official');
    expect(probeCatalogFreshness.mock.calls.at(-1)?.[1]).toEqual({ fullValidation: false });

    await controller.reloadCatalog({ sourceId: 'official' });
    await controller.recheckCatalogSource('official');
    expect(probeCatalogFreshness.mock.calls.at(-1)?.[1]).toEqual({ fullValidation: true });

    await controller.reloadCatalog({ sourceId: 'official' });
    await controller.recheckCatalogSource('official');
    expect(probeCatalogFreshness.mock.calls.at(-1)?.[1]).toEqual({ fullValidation: true });
    controller.dispose();
  });

  it.each([
    ['disabled', sourceDetail('official', { autoCheck: false })],
    ['fixed', sourceDetail('official', { explicitRef: 'a'.repeat(40) })],
  ])('keeps a manual probe running across a same-descriptor reload for a %s source', async (
    _label,
    detail,
  ) => {
    const pending = deferred<{ sourceId: string; state: 'updateAvailable' }>();
    let aborted = false;
    const loaded = {
      payload: status(),
      pluginSummaries: summaries(['official', 'demo']),
      sourceDetails: [detail],
      ...(detail.explicitRef ? {
        catalogGenerations: [{
          sourceId: 'official', sourceType: 'git' as const, state: 'ready' as const,
          active: {
            catalogVersion: '1.0.0', channel: 'latest' as const,
            requestedRef: detail.explicitRef, resolvedCommit: detail.explicitRef,
            storeKey: 'official-active', digestShort: 'aaaaaaaa',
          },
        }],
      } : {}),
    };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      probeCatalogFreshness: vi.fn((_sourceId, _options, signal) => {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        return pending.promise;
      }),
    }));

    await controller.load();
    const manual = controller.recheckCatalogSource('official');
    await nextTurn();
    expect(controller.getCatalogFreshness('official')?.state).toBe('checking');
    await controller.reloadCatalog({ sourceId: 'official' });
    expect(aborted).toBe(false);
    expect(controller.getCatalogFreshness('official')?.state).toBe('checking');

    pending.resolve({ sourceId: 'official', state: 'updateAvailable' });
    await manual;
    expect(controller.getCatalogFreshness('official')?.state).toBe('updateAvailable');
    controller.dispose();
  });

  it.each([
    ['activationRequired', { state: 'activationRequired' as const }],
    ['repairRequired', {
      state: 'repairRequired' as const,
      active: {
        catalogVersion: '1.0.0' as const, channel: 'latest' as const,
        requestedRef: 'b'.repeat(64), resolvedCommit: 'b'.repeat(64),
        storeKey: 'official-active', digestShort: 'bbbbbbbb',
      },
    }],
    ['configMismatch', {
      state: 'configMismatch' as const,
      active: {
        catalogVersion: '1.0.0' as const, channel: 'latest' as const,
        requestedRef: 'b'.repeat(64), resolvedCommit: 'b'.repeat(64),
        storeKey: 'official-active', digestShort: 'bbbbbbbb',
      },
    }],
  ])('probes an exact commit once when generation state is %s', async (_label, generation) => {
    const probeCatalogFreshness = vi.fn(async (sourceId: string) => ({
      sourceId, state: 'current' as const,
    }));
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status(),
        pluginSummaries: summaries(['official', 'demo']),
        sourceDetails: [sourceDetail('official', { explicitRef: 'b'.repeat(64) })],
        catalogGenerations: [{
          sourceId: 'official', sourceType: 'git', ...generation,
        }],
      }),
      probeCatalogFreshness,
    }));

    await controller.load();
    await nextTurn();
    expect(controller.getCatalogFreshness('official')?.state).toBe('current');
    expect(probeCatalogFreshness).toHaveBeenCalledTimes(1);
    expect(probeCatalogFreshness).toHaveBeenCalledWith(
      'official', { fullValidation: false }, expect.any(AbortSignal),
    );
    controller.dispose();
  });

  it('applies a confirmed autoCheck disable before the final status reload completes', async () => {
    const finalLoad = deferred<TuiStatusLoadResult>();
    const automatic = deferred<{ sourceId: string; state: 'current' }>();
    let aborted = false;
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:after' },
      sourceWrite: {
        configDigest: 'sha256:before', proposedConfigDigest: 'sha256:after',
        inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true,
      },
    };
    const enabled = {
      payload: status(),
      pluginSummaries: summaries(['official', 'demo']),
      sourceDetails: [sourceDetail('official')],
    };
    const disabled = {
      ...enabled,
      sourceDetails: [sourceDetail('official', { autoCheck: false })],
    };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValueOnce(enabled).mockImplementationOnce(() => finalLoad.promise),
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
      executeIntent: vi.fn().mockResolvedValue({ ok: true }),
      probeCatalogFreshness: vi.fn((_sourceId, _options, signal) => {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        return automatic.promise;
      }),
    }));
    await controller.load();
    await nextTurn();
    const review = await controller.buildOperationReview({
      kind: 'sourceMutation', action: 'update', sourceId: 'official',
      update: { autoCheck: false },
    });

    const executing = controller.executeOperation(review.reviewToken);
    await nextTurn(2);
    expect(aborted).toBe(true);
    expect(controller.getCatalogFreshness('official')?.state).toBe('notChecked');
    finalLoad.resolve(disabled);
    await expect(executing).resolves.toMatchObject({ state: 'succeeded' });
    automatic.resolve({ sourceId: 'official', state: 'current' });
    await nextTurn();
    expect(controller.getCatalogFreshness('official')?.state).toBe('notChecked');
    controller.dispose();
  });

  it('queues a confirmed autoCheck enable before a delayed final reload fails', async () => {
    const finalLoad = deferred<TuiStatusLoadResult>();
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:after' },
      sourceWrite: {
        configDigest: 'sha256:before', proposedConfigDigest: 'sha256:after',
        inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true,
      },
    };
    const disabled = {
      payload: status(),
      pluginSummaries: summaries(['official', 'demo']),
      sourceDetails: [sourceDetail('official', { autoCheck: false })],
    };
    const probeCatalogFreshness = vi.fn(async (sourceId: string) => ({
      sourceId, state: 'current' as const,
    }));
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValueOnce(disabled).mockImplementationOnce(() => finalLoad.promise),
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
      executeIntent: vi.fn().mockResolvedValue({ ok: true }),
      probeCatalogFreshness,
    }));
    await controller.load();
    await nextTurn();
    const review = await controller.buildOperationReview({
      kind: 'sourceMutation', action: 'update', sourceId: 'official',
      update: { autoCheck: true },
    });

    const executing = controller.executeOperation(review.reviewToken);
    await nextTurn(2);
    expect(probeCatalogFreshness).toHaveBeenCalledTimes(1);
    finalLoad.reject(new Error('final load failed'));
    await expect(executing).resolves.toMatchObject({
      state: 'blocked', code: 'tuiStateReloadFailed', writeMayHaveCompleted: true,
    });
    expect(controller.getCatalogFreshness('official')?.state).toBe('current');
    controller.dispose();
  });

  it('starts the primary probe first and limits other source probes to two', async () => {
    const sources = [
      source('official', { primary: true }),
      source('one', { primary: false }),
      source('two', { primary: false }),
      source('three', { primary: false }),
      source('four', { primary: false }),
    ];
    const gates = new Map(sources.map((entry) => [entry.id, deferred<void>()]));
    const started: string[] = [];
    let activeOther = 0;
    let maximumOther = 0;
    const probeCatalogFreshness: TuiControllerDependencies['probeCatalogFreshness'] = vi.fn(
      async (sourceId) => {
        started.push(sourceId);
        if (sourceId !== 'official') {
          activeOther += 1;
          maximumOther = Math.max(maximumOther, activeOther);
        }
        await gates.get(sourceId)!.promise;
        if (sourceId !== 'official') activeOther -= 1;
        return { sourceId, state: 'current' };
      },
    );
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ sources }),
        pluginSummaries: summaries(['official', 'demo']),
      }),
      probeCatalogFreshness,
    }));

    await controller.load();
    await nextTurn();
    expect(started[0]).toBe('official');
    expect(started.slice(1).sort()).toEqual(['one', 'two']);
    expect(maximumOther).toBe(2);
    gates.get('one')!.resolve();
    gates.get('two')!.resolve();
    await nextTurn();
    expect(started).toEqual(expect.arrayContaining(['three', 'four']));
    for (const gate of gates.values()) gate.resolve();
    controller.dispose();
  });

  it('does not repeat all probes on reload and explicitly rechecks only one source', async () => {
    const sources = [source('official', { primary: true }), source('team', { primary: false })];
    const probeCatalogFreshness = vi.fn(async (sourceId: string, options: { fullValidation: boolean }) => ({
      sourceId,
      state: 'current' as const,
      ...(options.fullValidation ? { activeVersion: '1.0.0' } : {}),
    }));
    const loadStatus = vi.fn().mockResolvedValue({
      payload: status({ sources }),
      pluginSummaries: summaries(['official', 'demo']),
    });
    const controller = new TuiController(dependencies({ loadStatus, probeCatalogFreshness }));
    await controller.load();
    await nextTurn();
    expect(probeCatalogFreshness).toHaveBeenCalledTimes(2);

    await controller.reloadCatalog({ sourceId: 'official' });
    await nextTurn();
    expect(probeCatalogFreshness).toHaveBeenCalledTimes(2);

    await controller.recheckCatalogSource('team');
    expect(probeCatalogFreshness).toHaveBeenCalledTimes(3);
    expect(probeCatalogFreshness.mock.calls.at(-1)?.slice(0, 2)).toEqual([
      'team', { fullValidation: true },
    ]);
    controller.dispose();
  });

  it('keeps complete candidates private to the current probe token and exposes full validation separately', async () => {
    const candidate = {
      sourceConfigFingerprint: 'sha256:source', sourceIdentity: 'identity:official',
      logicalIdentity: 'workspace:official', requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit: 'a'.repeat(40), catalogVersion: '2.0.0', channel: 'latest' as const,
      manifestDigest: `sha256:${'b'.repeat(64)}`, snapshotDigest: `sha256:${'c'.repeat(64)}`,
    };
    const probeCatalogFreshness = vi.fn()
      .mockResolvedValueOnce({
        sourceId: 'official', state: 'updateAvailable' as const, candidate,
        reusableCandidate: {
          sourceConfigFingerprint: 'sha256:source', activeStoreKey: null,
          probe: { sourceId: 'official', candidate, manifest: {} },
        },
      })
      .mockResolvedValueOnce({ sourceId: 'official', state: 'current' as const })
      .mockResolvedValueOnce({ sourceId: 'official', state: 'current' as const });
    const reviewEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:config', compositeDigest: candidate.snapshotDigest },
      catalogGeneration: {
        action: 'update', candidate, activationMode: 'normal', configDigest: 'sha256:config',
      },
    };
    const prepareReviewEvidence = vi.fn(async () => reviewEvidence);
    const controller = new TuiController(dependencies({
      probeCatalogFreshness,
      prepareReviewEvidence,
    }));
    await controller.load();
    await nextTurn();

    await controller.buildOperationReview({
      kind: 'catalogGeneration', action: 'update', sourceId: 'official',
    });
    expect(prepareReviewEvidence.mock.calls.at(-1)?.[3]).toMatchObject({
      sourceId: 'official', activeStoreKey: null,
    });

    await controller.buildOperationReview({
      kind: 'catalogGeneration', action: 'update', sourceId: 'official',
      sourceMutation: {
        action: 'update', sourceId: 'official', update: { autoCheck: false },
      },
    });
    expect(prepareReviewEvidence.mock.calls.at(-1)?.[3]).toBeUndefined();

    await controller.recheckCatalogSource('official');
    await controller.buildOperationReview({
      kind: 'catalogGeneration', action: 'update', sourceId: 'official',
    });
    expect(prepareReviewEvidence.mock.calls.at(-1)?.[3]).toBeUndefined();

    await controller.fullValidateCatalogSource('official');
    expect(probeCatalogFreshness.mock.calls.at(-1)?.[1]).toEqual({ fullValidation: true });
    controller.dispose();
  });

  it('aborts probes on dispose and ignores their late result', async () => {
    let aborted = false;
    const pending = deferred<{ sourceId: string; state: 'updateAvailable' }>();
    const controller = new TuiController(dependencies({
      probeCatalogFreshness: vi.fn((_sourceId, _options, signal) => {
        signal.addEventListener('abort', () => { aborted = true; }, { once: true });
        return pending.promise;
      }),
    }));
    await controller.load();
    await nextTurn();

    controller.dispose();
    pending.resolve({ sourceId: 'official', state: 'updateAvailable' });
    await nextTurn();

    expect(aborted).toBe(true);
    expect(controller.snapshot.phase).toBe('disposed');
    expect(controller.getCatalogFreshness('official')?.state).toBe('checking');
  });

  it('keeps a completed probe overlay but blocks Active switching while a source draft exists', async () => {
    const pending = deferred<{ sourceId: string; state: 'updateAvailable' }>();
    const controller = new TuiController(dependencies({
      probeCatalogFreshness: vi.fn(() => pending.promise),
    }));
    await controller.load();
    await nextTurn();
    controller.setExternalDraftState([{ kind: 'sourceDraft', owner: 'source', revision: 1 }]);

    expect(() => controller.startReviewPreparation({
      kind: 'catalogGeneration', action: 'update', sourceId: 'official',
    })).toThrowError(expect.objectContaining({ code: 'catalogActivationBlocked' }));
    await expect(controller.reloadCatalog({ sourceId: 'official' })).resolves.toBe(false);

    pending.resolve({ sourceId: 'official', state: 'updateAvailable' });
    await nextTurn();
    expect(controller.getCatalogFreshness('official')?.state).toBe('updateAvailable');
    controller.dispose();
  });
});

describe('TUI v4 Review safety', () => {
  it('finishes nested source recovery at the exact config editor route with the parent draft flow active', async () => {
    const candidate = {
      sourceId: 'official',
      sourceConfigFingerprint: 'sha256:source',
      sourceIdentity: 'identity:official',
      logicalIdentity: 'workspace:official',
      requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit: 'a'.repeat(40),
      catalogVersion: '1.0.0',
      channel: 'latest' as const,
      manifestDigest: `sha256:${'b'.repeat(64)}`,
      snapshotDigest: `sha256:${'c'.repeat(64)}`,
    };
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:config', compositeDigest: candidate.snapshotDigest },
      catalogGeneration: {
        action: 'repair', candidate, exactRepair: true,
        activationMode: 'normal', configDigest: 'sha256:config',
      },
    };
    const loadStatus = vi.fn().mockResolvedValue({
      payload: status(), pluginSummaries: summaries(['official', 'demo']),
    });
    const controller = new TuiController(dependencies({
      loadStatus,
      prepareReviewEvidence: vi.fn().mockResolvedValue(sourceEvidence),
      executeIntent: vi.fn().mockResolvedValue({ status: 'succeeded' }),
    }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    controller.beginConfigFlow('official/demo');
    const overviewFrameId = controller.snapshot.router.currentFrameId;
    const resumeRoute = {
      name: 'configFieldEditor' as const,
      pluginId: 'official/demo',
      layer: { scope: 'user' as const },
      fieldKey: 'mode',
      editor: 'string' as const,
    };
    controller.replace({
      name: 'configUnavailable',
      pluginId: 'official/demo',
      overviewFrameId,
      layer: { scope: 'user' },
      resumeRoute,
      resumeContext: { configGroupId: 'advanced', focusIndex: 2, scrollOffset: 1 },
      diagnosticCode: 'catalogSourceUnavailable',
    }, { configGroupId: 'advanced', focusIndex: 2, scrollOffset: 1 });
    controller.setExternalDraftState([{ kind: 'configDraft', owner: 'config', revision: 1 }]);

    controller.beginConfigSourceRecovery('official');
    expect(controller.snapshot.router.current.route).toEqual({
      name: 'sourceDetail', sourceId: 'official',
    });
    const preparation = controller.startReviewPreparation({
      kind: 'catalogGeneration', action: 'repair', sourceId: 'official',
    });
    await vi.waitFor(() => expect(controller.snapshot.activeReview).toBeDefined());
    const token = controller.snapshot.activeReview!.reviewToken;
    expect(preparation.state).toBe('running');

    await expect(controller.executeOperation(token)).resolves.toMatchObject({ state: 'succeeded' });
    controller.leaveResult();

    expect(controller.snapshot.router.current.route).toEqual(resumeRoute);
    expect(controller.snapshot.router.current.context).toEqual({
      configGroupId: 'advanced', focusIndex: 2, scrollOffset: 1,
    });
    expect(controller.snapshot.router.currentFlowId).toBeDefined();
    controller.back();
    expect(controller.snapshot.router.currentFrameId).toBe(overviewFrameId);
    expect(controller.snapshot.router.current.context).toEqual({});
    expect(loadStatus).toHaveBeenCalledTimes(2);
  });

  it('opens force cleanup Review for an exact Intent-only preview', async () => {
    const forceEvidence: OperationEvidence = {
      ...baseEvidence,
      operationPlan: createOperationPlan({
        intentChanges: [{ scope: 'user', beforeDigest: 'sha256:before', afterDigest: 'sha256:after' }],
        actions: [],
        changes: ['official/demo:codex:user:removeIntent'],
        warnings: [],
        evidence: {
          catalogDigests: [],
          intentDigests: [{ scope: 'user', digest: 'sha256:intent' }],
          configDigests: [],
          targetOwnerFingerprints: [],
        },
      }),
      offlineCleanupPlans: [{
        reason: 'bundleUnavailable',
        pluginId: 'official/demo',
        pluginName: 'demo',
        sourceId: 'official',
        sourceIdentity: 'identity:official',
        platform: 'codex',
        scope: 'user',
        forceExclusive: true,
        plan: {
          schemaVersion: 1,
          pluginId: 'official/demo',
          sourceIdentity: 'identity:official',
          platform: 'codex',
          scope: 'user',
          actions: [],
        },
        planDigest: 'sha256:force',
        targetFingerprint: 'sha256:force',
      }],
    };
    const captureEvidence = vi.fn().mockResolvedValue(forceEvidence);
    const controller = new TuiController(dependencies({ captureEvidence }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });

    const candidate = await controller.getForceCleanupCandidate('official/demo', 'codex', 'user');
    expect(candidate).toEqual({
      pluginId: 'official/demo', platform: 'codex', scope: 'user', actionCount: 0,
    });
    controller.startForceCleanupReview(candidate!);
    await vi.waitFor(() => expect(controller.snapshot.activeReview).toBeDefined());

    expect(captureEvidence).toHaveBeenCalledTimes(2);
    expect(captureEvidence.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'pluginWrite', action: 'cleanup', force: true,
    });

    const unavailable = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(baseEvidence),
    }));
    await unavailable.load();
    await expect(unavailable.getForceCleanupCandidate('official/demo', 'codex', 'user'))
      .resolves.toBeUndefined();
  });

  it('shows refresh fallback in the ordinary Review and uses the refreshed plugin version', async () => {
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({
        ...baseEvidence,
        source: { ...baseEvidence.source!, pluginVersion: '3.0.0' },
        preparationWarnings: ['catalogSourceRefreshFailed: official: safe failure'],
      }),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo',
      platform: 'codex', scope: 'user',
    });

    expect(review.subject.version).toBe('3.0.0');
    expect(review.changes).toContainEqual({
      kind: 'warning',
      group: 'portableWarnings',
      title: '来源刷新失败；本次使用旧 Active',
      description: '同步可以继续。再次刷新并同步时会重试来源刷新。',
    });
  });

  it.each([
    ['install', 'add', 'add'],
    ['refreshAndSync', 'keep', 'change'],
    ['reinstall', 'keep', 'change'],
    ['uninstall', 'remove', 'remove'],
    ['cleanup', 'keep', 'remove'],
    ['sync', 'keep', 'change'],
  ] as const)('keeps the no-plan %s user-visible target change consistent through execution', async (
    action,
    _intentKind,
    targetKind,
  ) => {
    const executeIntent = vi.fn().mockResolvedValue({ ok: true });
    const controller = new TuiController(dependencies({ executeIntent }));
    await controller.load();
    const intent = {
      kind: 'pluginWrite' as const,
      action,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'project' as const,
    };

    const review = await controller.buildOperationReview(intent);

    expect(review.changes).toContainEqual(expect.objectContaining({
      kind: targetKind,
      group: 'requested',
      pluginId: 'official/demo',
      relation: 'requested',
      title: 'Codex · 当前项目',
    }));

    await controller.executeOperation(review.reviewToken);
    expect(executeIntent).toHaveBeenCalledWith(intent, baseEvidence);
  });

  it.each([
    ['install', 'keep', 'add'],
    ['uninstall', 'keep', 'remove'],
    ['refreshAndSync', 'move', 'keep'],
    ['reinstall', 'move', 'keep'],
    ['sync', 'move', 'keep'],
  ] as const)('uses command desired intent for %s when the planned target action is %s', async (
    action,
    targetAction,
    expectedKind,
  ) => {
    const dependencyPlan: DependencyOperationPlan = {
      dependencyPlanSchemaVersion: 2,
      dependencyPlanDigest: `sha256:${action}`,
      requestedPluginIds: ['official/root'],
      resolvedPluginIds: ['official/dependency', 'official/root'],
      dependencyEdges: [{ from: 'official/root', to: 'official/dependency', platform: 'codex' }],
      scopeOverrides: [],
      claimRoots: [],
      targets: [{
        pluginId: 'official/dependency', pluginName: 'Dependency', platform: 'codex',
        relation: 'dependency', depth: 1, requiredBy: ['official/root'], rootScope: 'project',
        minimumScope: 'project', resolvedScope: 'project', allowedScopes: ['project', 'user'],
        assignmentSource: 'userOverride', locked: false, affectsOtherProjects: false,
        state: 'present', action: targetAction, order: 0,
      }, {
        pluginId: 'official/root', pluginName: 'Root', platform: 'codex',
        relation: 'requested', depth: 0, requiredBy: [], rootScope: 'project',
        minimumScope: 'project', resolvedScope: 'project', allowedScopes: ['project'],
        assignmentSource: 'root', locked: true, affectsOtherProjects: false,
        state: 'present', action: targetAction, order: 1,
      }],
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({ ...baseEvidence, dependencyPlan }),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action, pluginId: 'official/root', platform: 'codex', scope: 'project',
    });
    const intentRows = review.changes.filter((change) =>
      change.group === 'requested' || change.group === 'dependencies');

    expect(intentRows.length).toBeGreaterThan(0);
    expect(intentRows.every((change) => change.kind === expectedKind)).toBe(true);
  });

  it('shows an exact existing shared native as reuse without an ownership ledger', async () => {
    const codexReconcilePlans = [{
      sharedNativeActions: [{
        pluginId: 'official/demo', codexPluginId: 'demo@aw-official', action: 'reuse',
        desiredVersion: '1.0.0', affectsOtherScopes: false,
      }],
      activationActions: { user: [], project: [] },
      extensionWrites: [],
      extensionRemovals: [],
      review: { requiresConfirmation: false, sharedImpact: { pluginIds: [] } },
    }] as unknown as NonNullable<OperationEvidence['codexReconcilePlans']>;
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({ ...baseEvidence, codexReconcilePlans }),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/demo',
      platform: 'codex', scope: 'user',
    });

    expect(review.changes).toContainEqual(expect.objectContaining({
      group: 'sharedCodexNative',
      kind: 'keep',
      description: '复用完全相同的由平台共用内容',
    }));
    expect(JSON.stringify(review.changes)).not.toContain('claim');
  });

  it('shows cleanup intent cancellation and safe output totals without local targets', async () => {
    const offlineCleanup: NonNullable<OperationEvidence['offlineCleanup']> = {
      reason: 'sourceMissing',
      pluginId: 'official/demo',
      pluginName: 'demo',
      sourceId: 'official',
      sourceIdentity: 'identity:official',
      platform: 'codex',
      scope: 'project',
      plan: {
        schemaVersion: 1,
        pluginId: 'official/demo',
        sourceIdentity: 'identity:official',
        platform: 'codex',
        scope: 'project',
        actions: [
          { action: 'removeOwnedOutput', kind: 'namespacedOwner', target: '/workspace/.codex/owners/demo.json' },
          { action: 'removeNativeRegistration', kind: 'namespacedMarketplace', target: 'demo@aw-official' },
        ],
      },
      planDigest: 'sha256:offline-plan',
      targetFingerprint: 'sha256:offline-plan',
    };
    const operationPlan = createOperationPlan({
      intentChanges: [{ scope: 'project', beforeDigest: 'sha256:before', afterDigest: 'sha256:after' }],
      actions: [],
      changes: ['official/demo:codex:project:removeIntent'],
      warnings: ['inventoryUnreadable: sha256:residual'],
      evidence: {
        catalogDigests: [],
        intentDigests: [{ scope: 'project', digest: 'sha256:intent' }],
        configDigests: [],
        targetOwnerFingerprints: [],
      },
    });
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({
        ...baseEvidence,
        operationPlan,
        offlineCleanupPlans: [offlineCleanup],
      }),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'official/demo',
      platform: 'codex', scope: 'project',
    });

    expect(review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'change', title: '核验当前 AW 管理现场',
      }),
      expect.objectContaining({
        kind: 'remove', title: '取消已保存的使用设置',
      }),
      expect.objectContaining({
        kind: 'remove', title: '移除可验证的 AW 输出', description: 'Codex · 当前项目 · 2 项',
      }),
      expect.objectContaining({
        kind: 'warning', title: '部分现场残留无法完整核验',
      }),
      expect.objectContaining({
        kind: 'keep', title: '保留不属于插件或被共用的内容、插件设置、依赖使用范围和其他平台或位置',
      }),
      expect.objectContaining({
        kind: 'keep', title: '其他根插件仍可按自己的设置使用或安装此依赖',
      }),
    ]));
    expect(review.technicalDetails).toEqual(expect.arrayContaining([
      '离线清理目标：official/demo · codex/project',
      '离线清理计划：2 个动作 · offline-',
    ]));
    expect(JSON.stringify(review)).not.toContain('/workspace/.codex/owners/demo.json');
    expect(JSON.stringify(review)).not.toContain('inventoryUnreadable');
  });

  it('keeps an Intent-only cleanup valid when there are no removable outputs', async () => {
    const offlineCleanup: NonNullable<OperationEvidence['offlineCleanup']> = {
      reason: 'bundleUnavailable',
      pluginId: 'official/demo',
      pluginName: 'demo',
      sourceId: 'official',
      sourceIdentity: 'identity:official',
      platform: 'codex',
      scope: 'user',
      plan: {
        schemaVersion: 1,
        pluginId: 'official/demo',
        sourceIdentity: 'identity:official',
        platform: 'codex',
        scope: 'user',
        actions: [],
      },
      planDigest: 'sha256:intent-only',
      targetFingerprint: 'sha256:intent-only',
    };
    const operationPlan = createOperationPlan({
      intentChanges: [{ scope: 'user', beforeDigest: 'sha256:before', afterDigest: 'sha256:after' }],
      actions: [],
      changes: ['official/demo:codex:user:removeIntent'],
      warnings: [],
      evidence: {
        catalogDigests: [],
        intentDigests: [{ scope: 'user', digest: 'sha256:intent' }],
        configDigests: [],
        targetOwnerFingerprints: [],
      },
    });
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({
        ...baseEvidence,
        operationPlan,
        offlineCleanupPlans: [offlineCleanup],
      }),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'official/demo',
      platform: 'codex', scope: 'user',
    });

    expect(review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'remove', title: '取消已保存的使用设置' }),
      expect.objectContaining({
        kind: 'keep',
        title: '没有可验证的 AW 输出',
        description: 'Codex · 所有项目 · 仍会取消此位置的使用设置',
      }),
    ]));
  });

  it('shows managed Codex acquisition without making manager selection stale evidence', async () => {
    const evidence: OperationEvidence = {
      ...baseEvidence,
      codexManager: {
        state: 'requires-install',
        packageName: '@openai/codex',
        version: '0.151.0',
      },
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(evidence),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/demo',
      platform: 'codex', scope: 'user',
    });

    expect(review.changes).toContainEqual(expect.objectContaining({
      kind: 'add',
      group: 'runtime',
      title: '获取 Codex 运行组件',
      description: '@openai/codex@0.151.0 · AW 管理缓存',
    }));
    expect(review.equivalentCommand).toContain('--allow-managed-codex-install');
    expect(operationEvidenceFingerprint(evidence)).toBe(operationEvidenceFingerprint({
      ...baseEvidence,
      codexManager: { state: 'system', packageName: '@openai/codex', version: '0.200.0' },
    }));
  });

  it('keeps reset source evidence asymmetric for offline recovery', () => {
    const offline: OperationEvidence = {
      catalog: { configDigest: 'offline', compositeDigest: 'offline' },
      resetTarget: {
        sourceId: 'team', pluginName: 'demo', scope: 'user',
        kind: 'regularFile', fingerprint: 'sha256:target',
      },
    };
    const available: OperationEvidence = {
      ...offline,
      source: {
        sourceId: 'team', sourceIdentity: 'sha256:source-a', manifestDigest: 'sha256:manifest-a',
      },
    };
    const advanced: OperationEvidence = {
      ...available,
      source: {
        sourceId: 'team', sourceIdentity: 'sha256:source-a', manifestDigest: 'sha256:manifest-b',
      },
    };

    expect(operationEvidenceMatches(offline, available)).toBe(true);
    expect(operationEvidenceMatches(available, offline)).toBe(false);
    expect(operationEvidenceMatches(available, advanced)).toBe(false);
  });

  it.each([
    {
      label: 'managed acquisition failure',
      managerState: 'requires-install' as const,
      errorCode: 'managedCodexUnavailable' as const,
      recovery: '升级 AW',
    },
    {
      label: 'cached Review followed by a missing runtime',
      managerState: 'cached' as const,
      errorCode: 'managedCodexAuthorizationRequired' as const,
      recovery: '--allow-managed-codex-install',
    },
  ])('reports $label as a Codex pre-write blocker', async ({ managerState, errorCode, recovery }) => {
    const evidence: OperationEvidence = {
      ...baseEvidence,
      codexManager: {
        state: managerState,
        packageName: '@openai/codex',
        version: '0.151.0',
      },
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        targetResults: [{
          target: {
            pluginId: 'official/demo',
            platform: 'codex',
            scope: 'user',
          },
          action: 'install',
          state: 'failed',
          errorCode,
        }],
      }),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/demo',
      platform: 'codex', scope: 'user',
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'blocked',
      code: errorCode,
      message: expect.stringContaining('插件写入前停止'),
      summary: {
        code: 'operationFailed',
        targets: [expect.objectContaining({ errorCode })],
      },
    });
    expect(result.message).toContain(recovery);
    expect(result).not.toHaveProperty('writeMayHaveCompleted');
  });

  it('groups the frozen plan by intent layer while a skipped requested target keeps the result failed', async () => {
    const dependencyPlan = {
      dependencyPlanSchemaVersion: 1 as const,
      requestedPluginIds: ['official/root'],
      resolvedPluginIds: ['official/base', 'official/toolkit', 'official/root'],
      dependencyEdges: [
        { from: 'official/root', to: 'official/toolkit' },
        { from: 'official/toolkit', to: 'official/base' },
      ],
      targets: [
        { pluginId: 'official/base', pluginName: 'base', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'dependency' as const, depth: 2, requiredBy: ['official/toolkit'], state: 'absent' as const, action: 'install' as const, order: 0 },
        { pluginId: 'official/toolkit', pluginName: 'toolkit', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'dependency' as const, depth: 1, requiredBy: ['official/root'], state: 'present' as const, action: 'keep' as const, order: 1 },
        { pluginId: 'official/root', pluginName: 'root', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'requested' as const, depth: 0, requiredBy: [], state: 'absent' as const, action: 'install' as const, order: 2 },
      ],
    };
    const codexReconcilePlans = [{
      sharedNativeActions: [{
        pluginId: 'official/root', codexPluginId: 'root@aw-official', action: 'replace',
        desiredVersion: '2.0.0', affectsOtherScopes: true,
      }],
      activationActions: {
        user: [{
          pluginId: 'official/root', codexPluginId: 'root@aw-official',
          scope: 'user', action: 'enable', desired: true,
        }],
        project: [{
          pluginId: 'official/root', codexPluginId: 'root@aw-official',
          scope: 'project', action: 'none', desired: false,
        }],
      },
      extensionWrites: [{
        pluginId: 'official/root', componentKey: 'extensions.instructions:guide',
        kind: 'instruction', scope: 'user', action: 'write',
      }],
      extensionRemovals: [],
      review: {
        requiresConfirmation: true,
        sharedImpact: {
          pluginIds: ['root@aw-official'],
          warning: 'Replacing shared native state can affect other projects.',
        },
      },
    }] as unknown as NonNullable<OperationEvidence['codexReconcilePlans']>;
    const evidence = { ...baseEvidence, dependencyPlan, codexReconcilePlans };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        dependencyPlan,
        targetResults: [
          { target: { pluginId: 'official/base', platform: 'codex', scope: 'user' }, action: 'install', state: 'failed' },
          { target: { pluginId: 'official/toolkit', platform: 'codex', scope: 'user' }, action: 'keep', state: 'completed' },
          { target: { pluginId: 'official/root', platform: 'codex', scope: 'user' }, action: 'skipped', state: 'failed' },
        ],
      }),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/root', platform: 'codex', scope: 'user',
    });

    expect(review.primaryLabel).toContain('3 个插件');
    expect(review.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'official/root', group: 'requested', relation: 'requested', kind: 'add' }),
      expect.objectContaining({ pluginId: 'official/toolkit', group: 'dependencies', relation: 'direct', kind: 'add' }),
      expect.objectContaining({ pluginId: 'official/root', group: 'sharedCodexNative', kind: 'change' }),
      expect.objectContaining({ pluginId: 'official/root', group: 'userActivation', kind: 'change' }),
      expect.objectContaining({ pluginId: 'official/root', group: 'projectActivation', kind: 'keep' }),
      expect.objectContaining({ pluginId: 'official/root', group: 'awExtensions', kind: 'change' }),
      expect.objectContaining({ group: 'preserved' }),
    ]));
    expect(review).toMatchObject({
      requiresConfirmation: true,
      sharedImpact: {
        pluginIds: ['root@aw-official'],
        warning: expect.stringContaining('other projects'),
      },
    });
    expect(review.equivalentCommand).toBe(
      'aw install official/root --platform codex --scope user --script-timeout 300000 --yes',
    );
    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'blocked',
      code: 'operationFailed',
      summary: { code: 'operationFailed', targets: expect.arrayContaining([
        expect.objectContaining({ pluginId: 'official/base', relation: 'transitive', state: 'failed' }),
        expect.objectContaining({ pluginId: 'official/toolkit', relation: 'direct', state: 'kept', requiredBy: ['official/root'] }),
        expect.objectContaining({ pluginId: 'official/root', relation: 'requested', state: 'skipped' }),
      ]) },
    });
    expect(controller.snapshot.progressTargets).toEqual([]);
    expect(controller.snapshot.progress).toEqual({ messages: [] });
  });

  it('keeps a failed dependency execution failed when no target completed or was kept', async () => {
    const dependencyPlan = {
      dependencyPlanSchemaVersion: 1 as const,
      requestedPluginIds: ['official/root'],
      resolvedPluginIds: ['official/toolkit', 'official/root'],
      dependencyEdges: [{ from: 'official/root', to: 'official/toolkit' }],
      targets: [
        { pluginId: 'official/toolkit', pluginName: 'toolkit', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'dependency' as const, requiredBy: ['official/root'], state: 'absent' as const, action: 'install' as const, order: 0 },
        { pluginId: 'official/root', pluginName: 'root', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'requested' as const, requiredBy: [], state: 'absent' as const, action: 'install' as const, order: 1 },
      ],
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({ ...baseEvidence, dependencyPlan }),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        dependencyPlan,
        targetResults: [
          { target: { pluginId: 'official/toolkit', platform: 'codex', scope: 'user' }, action: 'install', state: 'failed', errorCode: 'dependencyStillRequired' },
          { target: { pluginId: 'official/root', platform: 'codex', scope: 'user' }, action: 'skipped', state: 'failed', errorCode: 'writeFailed' },
        ],
      }),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/root', platform: 'codex', scope: 'user',
    });

    const result = await controller.executeOperation(review.reviewToken);
    expect(result).toMatchObject({
      state: 'blocked',
      code: 'operationFailed',
      summary: {
        code: 'operationFailed',
        targets: [
          expect.objectContaining({ pluginId: 'official/toolkit', relation: 'direct', state: 'failed' }),
          expect.objectContaining({ pluginId: 'official/root', relation: 'requested', state: 'skipped' }),
        ],
      },
    });
    expect(result).not.toHaveProperty('writeMayHaveCompleted');
    expect(controller.snapshot.result).toMatchObject({
      state: 'blocked', code: 'operationFailed', summary: { code: 'operationFailed' },
    });
  });

  it.each([
    ['user'],
    ['project'],
  ] as const)('reviews an install with an explicit dependency scope at %s', async (
    resolvedScope,
  ) => {
    const plan = (intent: Extract<import('../../src/tui/controller.js').OperationIntent, { kind: 'pluginWrite' }>): DependencyOperationPlan => ({
      dependencyPlanSchemaVersion: 2,
      dependencyPlanDigest: `sha256:${resolvedScope}`,
      requestedPluginIds: ['official/demo'],
      resolvedPluginIds: ['official/toolkit', 'official/demo'],
      dependencyEdges: [{ from: 'official/demo', to: 'official/toolkit', platform: 'codex' }],
      scopeOverrides: intent.dependencyScopeOverrides ?? [],
      claimRoots: [],
      targets: [
        {
          pluginId: 'official/toolkit', pluginName: 'Toolkit', platform: 'codex',
          relation: 'dependency', depth: 1, requiredBy: ['official/demo'],
          rootScope: 'project', minimumScope: 'project', resolvedScope,
          allowedScopes: ['project', 'user'], assignmentSource: 'userOverride', locked: false,
          affectsOtherProjects: resolvedScope === 'user', state: 'present',
          action: resolvedScope === 'project' ? 'keep' : 'move', order: 0,
        },
        {
          pluginId: 'official/demo', pluginName: 'Demo', platform: 'codex',
          relation: 'requested', depth: 0, requiredBy: [], rootScope: 'project',
          minimumScope: 'project', resolvedScope: 'project', allowedScopes: ['project'],
          assignmentSource: 'root', locked: true, affectsOtherProjects: false,
          state: 'present', action: 'keep', order: 1,
        },
      ],
    });
    const previewDependencyPlacement = vi.fn(async (intent: Extract<import('../../src/tui/controller.js').OperationIntent, { kind: 'pluginWrite' }>) =>
      plan(intent));
    const captureEvidence = vi.fn(async (intent: import('../../src/tui/controller.js').OperationIntent) => ({
      ...baseEvidence,
      dependencyPlan: plan(intent as Extract<typeof intent, { kind: 'pluginWrite' }>),
    }));
    const executeIntent = vi.fn().mockResolvedValue({
      platforms: ['codex'], plugins: ['official/demo'], warnings: [],
      targetResults: [], overallState: 'succeeded', rebuildResults: [], receiptTargets: [],
    });
    const existingDependencyTarget = target({
      pluginName: 'toolkit', scope: resolvedScope === 'project' ? 'user' : 'project', state: 'present',
    });
    existingDependencyTarget.components.push(
      {
        kind: 'intent', key: 'desired', state: 'enabled',
        metadata: {
          enabled: true,
          scopes: [resolvedScope === 'project' ? 'user' : 'project'],
          relation: 'dependency',
        },
      },
      { kind: 'sharedNative', key: 'toolkit@aw-official', state: 'usable' },
      { kind: 'activation', key: 'user', state: 'enabled', metadata: { effective: true, evidence: 'observed' } },
      { kind: 'activation', key: 'project', state: 'enabled', metadata: { effective: true, evidence: 'observed' } },
    );
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({
          targets: [existingDependencyTarget],
        }),
        pluginSummaries: summaries(['official', 'demo'], ['official', 'toolkit']),
      }),
      previewDependencyPlacement,
      captureEvidence,
      executeIntent,
    }));
    await controller.load();
    controller.beginInstallFlow('official/demo', 'project');
    controller.setInstallPlatforms(['codex']);
    await controller.prepareInstallDependencyPlacement();
    await controller.setDependencyScope('official/toolkit', 'codex', resolvedScope);
    const intent = controller.installPlacementIntent();

    expect(intent).toMatchObject({
      action: 'install',
    });
    expect(intent).not.toHaveProperty('dependencyPlacementAdjustment');
    const review = await controller.buildOperationReview(intent);
    expect(review.title).toBe('添加插件');

    const result = await controller.executeOperation(review.reviewToken);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'install',
    }), expect.any(Object));
    expect(executeIntent).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'cleanup' }), expect.anything());
    expect(result).toMatchObject({ state: 'succeeded' });
  });

  it('single-flights plugin execution without a second pre-dispatch freshness scan', async () => {
    const executeIntent = vi.fn().mockResolvedValue({
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    const validateIntent = vi.fn().mockResolvedValue(undefined);
    const captureEvidence = vi.fn().mockResolvedValue(baseEvidence);
    const controller = new TuiController(dependencies({
      validateIntent,
      captureEvidence,
      executeIntent,
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });
    const observedCodes: string[] = [];
    controller.subscribe((snapshot) => {
      if (snapshot.result?.state === 'blocked') observedCodes.push(snapshot.result.code);
    });

    const first = controller.executeOperation(review.reviewToken);
    const second = controller.executeOperation(review.reviewToken);
    expect(second).toBe(first);
    expect(controller.snapshot.router.current.route).toEqual({ name: 'progress', operationId: review.operationId });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(validateIntent).toHaveBeenCalledTimes(1);
    expect(captureEvidence).toHaveBeenCalledTimes(1);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult.operationId).toBe(review.operationId);
    expect(observedCodes).not.toContain('reviewTicketInvalid');
  });

  it('does not publish after disposal while an operation write is pending', async () => {
    const write = deferred<unknown>();
    const controller = new TuiController(dependencies({
      executeIntent: vi.fn(() => write.promise),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });
    const listener = vi.fn();
    controller.subscribe(listener);
    const executing = controller.executeOperation(review.reviewToken);
    const callsBeforeDispose = listener.mock.calls.length;

    await expect(controller.cancelAndWaitForReads()).resolves.toBe(false);
    expect(controller.hasActiveWrite).toBe(true);

    controller.dispose();
    write.resolve({ targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }] });
    await executing;

    expect(listener).toHaveBeenCalledTimes(callsBeforeDispose);
    expect(controller.snapshot.phase).toBe('disposed');
    expect(controller.snapshot.router.current.route.name).toBe('progress');
  });

  it.each([
    ['pluginWrite', {
      kind: 'pluginWrite' as const, action: 'refreshAndSync' as const, pluginId: 'official/demo',
      platform: 'codex' as const, scope: 'user' as const,
    }, baseEvidence, { name: 'pluginDetail' as const, pluginId: 'official/demo' }],
    ['sourceMutation', {
      kind: 'sourceMutation' as const, action: 'add' as const, sourceId: 'team',
      source: { id: 'team', type: 'path' as const, primary: false, path: '/safe/fixture' },
    }, {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:candidate' },
      sourceWrite: {
        configDigest: 'sha256:before', proposedConfigDigest: 'sha256:candidate',
        inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true,
      },
    }, { name: 'sourceAdd' as const, step: 'location' as const, owner: 'draft-1' }],
  ])('uses the fixed unconfirmed-write result after a successful %s write cannot reload status', async (
    _label,
    intent,
    evidence,
    returnRoute,
  ) => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
        .mockRejectedValueOnce(new Error('/private/reload failed')),
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      executeIntent: vi.fn().mockResolvedValue({
        targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
      }),
    }));
    await controller.load();
    controller.push(returnRoute);
    const review = await controller.buildOperationReview(intent);

    expect(await controller.executeOperation(review.reviewToken)).toMatchObject({
      state: 'blocked', code: 'tuiStateReloadFailed', writeMayHaveCompleted: true,
      message: '写入可能已完成，当前无法确认。请查看刷新后的平台或问题状态。',
      returnRoute,
    });
    controller.leaveResult();
    expect(controller.snapshot.router.current.route).toEqual(
      intent.kind === 'sourceMutation' ? { name: 'sourceList' } : returnRoute,
    );
  });

  it.each([
    ['succeeded', {
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    }],
    ['partial', {
      targetResults: [
        { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
        { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
      ],
    }],
    ['blocked', new Error('writeRejected')],
  ] as const)('replaces transient routes for a %s result and never returns to Progress', async (state, execution) => {
    const controller = new TuiController(dependencies({
      executeIntent: execution instanceof Error
        ? vi.fn().mockRejectedValue(execution)
        : vi.fn().mockResolvedValue(execution),
    }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'both', scope: 'user',
    });
    const depthAtReview = controller.snapshot.router.depth;

    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({ state });
    if (state === 'succeeded') {
      expect(controller.snapshot.router).toMatchObject({
        depth: depthAtReview - 1,
        current: { route: { name: 'pluginDetail', pluginId: 'official/demo' } },
      });
      expect(controller.snapshot.completionNotice).toMatchObject({
        pluginId: 'official/demo',
        title: '插件更新完成',
      });
      controller.back();
      expect(controller.snapshot.router).toMatchObject({ depth: 1, current: { route: { name: 'home' } } });
      return;
    }
    expect(controller.snapshot.router).toMatchObject({
      depth: depthAtReview,
      current: { route: { name: 'result', operationId: review.operationId } },
    });

    controller.leaveResult();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/demo' });
    expect(controller.snapshot.router.depth).toBe(depthAtReview - 1);
    controller.back();
    expect(controller.snapshot.router).toMatchObject({ depth: 1, current: { route: { name: 'home' } } });
  });

  it('clears install selection and progress at Result, and clears an abandoned install draft', async () => {
    const progressFeed = createRebuildProgressFeed();
    const controller = new TuiController(dependencies(), progressFeed);
    await controller.load();
    controller.push({ name: 'pluginPreview', pluginId: 'official/demo' });
    controller.beginInstallFlow('official/demo', 'user');
    controller.setInstallPlatforms(['codex']);
    controller.push({ name: 'installPlacement', pluginId: 'official/demo' });
    progressFeed.setCurrent({ target: 'demo · Codex/当前用户', phase: '写入平台插件' }, '正在写入');
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });

    await controller.executeOperation(review.reviewToken);

    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/demo' });
    expect(controller.snapshot.completionNotice).toMatchObject({
      pluginId: 'official/demo',
      title: '插件安装完成',
    });
    expect(controller.snapshot.installPlacementDraft).toBeUndefined();
    expect(controller.snapshot.progress).toEqual({ messages: [] });
    expect(controller.snapshot.progressTargets).toEqual([]);

    controller.beginInstallFlow('official/demo', 'project');
    controller.push({ name: 'installPlacement', pluginId: 'official/demo' });
    expect(controller.snapshot.installPlacementDraft).toBeDefined();
    controller.back();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/demo' });
    expect(controller.snapshot.installPlacementDraft).toBeUndefined();
  });

  it('keeps a blocked install draft private until the user explicitly returns to modify it', async () => {
    const controller = new TuiController(dependencies({
      executeIntent: vi.fn().mockRejectedValue(new Error('writeRejected')),
    }));
    await controller.load();
    controller.push({ name: 'pluginPreview', pluginId: 'official/demo' });
    controller.beginInstallFlow('official/demo', 'user');
    controller.setInstallPlatforms(['codex']);
    controller.push({ name: 'installTargets', pluginId: 'official/demo' });
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });

    await controller.executeOperation(review.reviewToken);
    expect(controller.snapshot.installPlacementDraft).toBeUndefined();

    controller.resumeResultDraft();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/demo' });
    expect(controller.snapshot.installPlacementDraft).toMatchObject({
      pluginId: 'official/demo', rootScope: 'user', platforms: ['codex'],
    });
  });

  it('owns every source-add wizard step from the source list and removes them before Result', async () => {
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:after' },
      sourceWrite: {
        configDigest: 'sha256:before',
        proposedConfigDigest: 'sha256:after',
        inventoryDigest: 'sha256:inventory',
        referenceCount: 0,
        inventoryComplete: true,
      },
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
    }));
    await controller.load();
    controller.push({ name: 'sourceList' });
    controller.push({ name: 'sourceAdd', step: 'type', owner: 'source-draft' });
    controller.push({ name: 'sourceAdd', step: 'id', owner: 'source-draft' });
    controller.push({ name: 'sourceAdd', step: 'location', owner: 'source-draft' });
    controller.push({ name: 'sourceAdd', step: 'refPolicy', owner: 'source-draft' });
    const review = await controller.buildOperationReview({
      kind: 'sourceMutation',
      action: 'add',
      sourceId: 'team',
      source: { id: 'team', type: 'path', primary: false, path: '/safe/fixture' },
    });

    await controller.executeOperation(review.reviewToken);

    expect(controller.snapshot.router).toMatchObject({
      depth: 3,
      current: { route: { name: 'result', operationId: review.operationId } },
    });
    controller.leaveResult();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'sourceList' });
    controller.back();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'home' });
  });

  it.each([
    ['plugin', { name: 'pluginDetail' as const, pluginId: 'official/demo' }],
    ['source', { name: 'sourceList' as const }],
    ['issue', { name: 'issueList' as const }],
    ['home', { name: 'home' as const }],
    ['failed target', { name: 'platform' as const, pluginId: 'official/demo', platform: 'codex' as const }],
  ])('leaves Result through one terminal API for the %s action and removes transient history', async (_label, targetRoute) => {
    const controller = new TuiController(dependencies({
      executeIntent: vi.fn().mockResolvedValue({
        targetResults: [
          { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
          { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
        ],
      }),
    }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });
    await controller.executeOperation(review.reviewToken);

    controller.leaveResult(targetRoute);

    expect(controller.snapshot.result).toBeUndefined();
    expect(controller.snapshot.router.current.route).toEqual(targetRoute);
    expect(controller.snapshot.router.depth).toBe(targetRoute.name === 'home' ? 1 : 2);
    controller.back();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'home' });
  });

  it('normalizes an explicit Result destination before replacing its terminal frame', async () => {
    const controller = new TuiController(dependencies({
      executeIntent: vi.fn().mockResolvedValue({
        targetResults: [
          { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
          { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
        ],
      }),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });
    await controller.executeOperation(review.reviewToken);

    controller.leaveResult({ name: 'pluginDetail', pluginId: 'missing/plugin' });

    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
    expect(controller.snapshot.result).toBeUndefined();
  });

  function issueWriteFixture(afterWrite: TuiStatusLoadResult | Error) {
    const initial: TuiStatusLoadResult = {
      payload: status({
        sources: [source('official', { type: 'path' })],
        targets: [target({ scope: 'user', state: 'partial' })],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const loadStatus = vi.fn().mockResolvedValueOnce(initial);
    if (afterWrite instanceof Error) loadStatus.mockRejectedValueOnce(afterWrite);
    else loadStatus.mockResolvedValueOnce(afterWrite);
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    const value = new TuiController(dependencies({ loadStatus, executeIntent }));
    return { value, initial, executeIntent };
  }

  async function buildIssueReview(value: TuiController) {
    await value.load();
    const issue = value.listUserIssues().find((entry) => entry.category === 'incompleteInstallation')!;
    return value.buildOperationReview({
      kind: 'pluginWrite',
      action: 'reinstall',
      pluginId: issue.pluginId!,
      platform: issue.platform!,
      scope: issue.scope!,
      originIssue: {
        issueId: issue.issueId,
        issueKey: userIssueKey(issue),
        category: issue.category,
        actionId: 'reinstall',
      },
    });
  }

  it('reports issueStillPresent after a successful command when the typed issue remains', async () => {
    const fixture = issueWriteFixture({
      payload: status({
        sources: [source('official', { type: 'path' })],
        targets: [target({ scope: 'user', state: 'partial' })],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });
    const review = await buildIssueReview(fixture.value);

    const result = await fixture.value.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'blocked', code: 'issueStillPresent', writeMayHaveCompleted: true,
      verification: 'issueStillPresent',
    });
    expect(fixture.executeIntent).toHaveBeenCalledTimes(1);
    expect(fixture.value.snapshot.phase).toBe('ready');
  });

  it('keeps an issue-origin dependency result failed when the requested target is skipped', async () => {
    const dependencyPlan = {
      dependencyPlanSchemaVersion: 1 as const,
      requestedPluginIds: ['official/demo'],
      resolvedPluginIds: ['official/base', 'official/toolkit', 'official/demo'],
      dependencyEdges: [
        { from: 'official/demo', to: 'official/toolkit' },
        { from: 'official/toolkit', to: 'official/base' },
      ],
      targets: [
        { pluginId: 'official/base', pluginName: 'base', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'dependency' as const, requiredBy: ['official/toolkit'], state: 'present' as const, action: 'keep' as const, order: 0 },
        { pluginId: 'official/toolkit', pluginName: 'toolkit', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'dependency' as const, requiredBy: ['official/demo'], state: 'absent' as const, action: 'install' as const, order: 1 },
        { pluginId: 'official/demo', pluginName: 'demo', platform: 'codex' as const, requestedScope: 'user' as const, resolvedScope: 'user' as const, relation: 'requested' as const, requiredBy: [], state: 'partial' as const, action: 'install' as const, order: 2 },
      ],
    };
    const loaded: TuiStatusLoadResult = {
      payload: status({
        sources: [source('official', { type: 'path' })],
        targets: [target({ scope: 'user', state: 'partial' })],
      }),
      pluginSummaries: summaries(['official', 'base'], ['official', 'toolkit'], ['official', 'demo']),
    };
    const value = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence: vi.fn().mockResolvedValue({ ...baseEvidence, dependencyPlan }),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        dependencyPlan,
        targetResults: [
          { target: { pluginId: 'official/base', platform: 'codex', scope: 'user' }, action: 'keep', state: 'completed' },
          { target: { pluginId: 'official/toolkit', platform: 'codex', scope: 'user' }, action: 'install', state: 'failed' },
          { target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' }, action: 'skipped', state: 'failed' },
        ],
      }),
    }));
    const review = await buildIssueReview(value);

    const result = await value.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'blocked',
      code: 'operationFailed',
      summary: {
        code: 'operationFailed',
        targets: [
          expect.objectContaining({ pluginId: 'official/base', relation: 'transitive', state: 'kept' }),
          expect.objectContaining({ pluginId: 'official/toolkit', relation: 'direct', state: 'failed' }),
          expect.objectContaining({ pluginId: 'official/demo', relation: 'requested', state: 'skipped' }),
        ],
      },
      originIssue: expect.objectContaining({ category: 'incompleteInstallation', actionId: 'reinstall' }),
    });
    expect(result).not.toHaveProperty('code', 'issueStillPresent');
    expect(value.listUserIssues()).toContainEqual(expect.objectContaining({
      category: 'incompleteInstallation', pluginId: 'official/demo', scope: 'user',
    }));
  });

  it('reports issueVerificationFailed without claiming no write when post-write reload fails', async () => {
    const fixture = issueWriteFixture(new Error('/Users/private/reload failure'));
    const review = await buildIssueReview(fixture.value);

    const result = await fixture.value.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'blocked', code: 'issueVerificationFailed', writeMayHaveCompleted: true,
      verification: 'verificationFailed',
      message: '写入可能已完成，当前无法确认。请查看刷新后的平台或问题状态。',
    });
    expect(fixture.executeIntent).toHaveBeenCalledTimes(1);
    expect(fixture.value.snapshot.phase).toBe('ready');
    expect(JSON.stringify(fixture.value.snapshot)).not.toContain('/Users/private');
  });

  it('reports issue success only after the typed issue disappears', async () => {
    const fixture = issueWriteFixture({
      payload: status({
        sources: [source('official', { type: 'path' })],
        targets: [target({ scope: 'user', state: 'present' })],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    });
    const review = await buildIssueReview(fixture.value);

    expect(await fixture.value.executeOperation(review.reviewToken)).toMatchObject({ state: 'succeeded' });
    expect(fixture.value.listUserIssues()).toEqual([]);
  });

  it('reloads status and blocks an all-failed receipt as an unconfirmed write', async () => {
    const refreshed = {
      payload: status({
        sources: [source('official', { type: 'path' })],
        targets: [target({ scope: 'user', state: 'partial' })],
      }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const loadStatus = vi.fn()
      .mockResolvedValueOnce({
        payload: status({ sources: [source('official', { type: 'path' })] }),
        pluginSummaries: summaries(['official', 'demo']),
      })
      .mockResolvedValue(refreshed);
    const controller = new TuiController(dependencies({
      loadStatus,
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        targetResults: [{
          target: { platform: 'codex', scope: 'user' },
          state: 'failed',
          errorCode: 'durableCleanupFailed',
        }],
      }),
    }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'blocked', code: 'operationFailed', writeMayHaveCompleted: true,
      operationKind: 'pluginWrite', pluginId: 'official/demo',
      returnRoute: { name: 'pluginDetail', pluginId: 'official/demo' },
    });
    expect(result).not.toHaveProperty('summary');
    expect(loadStatus).toHaveBeenCalledTimes(2);
    expect(controller.getTargetState('official/demo', 'codex', 'user')).toBe('needsSync');
  });

  it('leaves issue-origin freshness to the reviewed core write plan', async () => {
    const executeIntent = vi.fn();
    const captureEvidence = vi.fn().mockResolvedValue(baseEvidence);
    const value = new TuiController(dependencies({ executeIntent, captureEvidence }));
    await value.load();

    await expect(value.buildOperationReview({
      kind: 'pluginWrite', action: 'reinstall', pluginId: 'official/demo', platform: 'codex', scope: 'user',
      originIssue: {
        issueId: 'forged', issueKey: 'forged', category: 'incompleteInstallation', actionId: 'reinstall',
      },
    })).resolves.toMatchObject({ pluginAction: 'reinstall' });
    expect(captureEvidence).toHaveBeenCalledOnce();
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('delegates dependency issue freshness to the locked plugin write executor', async () => {
    const consumer = target({ pluginName: 'root', scope: 'project', state: 'partial' });
    if (consumer.platform !== 'codex') throw new Error('Expected Codex fixture.');
    consumer.placements[0]!.components.push({
      kind: 'intent', key: 'desired', state: 'desired',
      metadata: { enabled: true, scopes: ['project'], relation: 'root' },
    });
    consumer.placements[0]!.reasons = [{
      code: 'dependencyMissing',
      message: 'safe dependency evidence',
      dependencyPluginId: 'official/toolkit',
      dependencyPlatform: 'codex',
      dependencyScope: 'user',
      dependencyProject: null,
      severity: 'warning',
    }];
    consumer.reasons = consumer.placements[0]!.reasons;
    const loaded: TuiStatusLoadResult = {
      payload: status({ targets: [consumer, target({ pluginName: 'toolkit', scope: 'user', state: 'absent' })] }),
      pluginSummaries: summaries(['official', 'root'], ['official', 'toolkit']),
      dependencyOverviews: [{
        pluginId: 'official/root',
        summary: { directCount: 1, transitiveCount: 0, totalCount: 1, readyCount: 0, missingCount: 1, issueCount: 1 },
        dependencies: [{
          pluginId: 'official/toolkit', displayName: 'Toolkit', relation: 'direct', depth: 1,
          requiredBy: [{ pluginId: 'official/root', displayName: 'Root' }], placements: [], aggregateStatus: 'notInstalled',
          placementReferences: [{
            consumer: { pluginId: 'official/root', platform: 'codex', scope: 'project', project: 'current' },
            dependency: { pluginId: 'official/toolkit', platform: 'codex', scope: 'user', project: null },
          }],
        }],
        dependents: [], blockers: [],
      }],
    };
    const validateIntent = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('operationReviewStale: consumer issue changed'));
    const captureEvidence = vi.fn().mockResolvedValue(baseEvidence);
    const executeIntent = vi.fn().mockRejectedValue(new Error(
      'operationReviewStale: dependency issue changed under the mutation lock',
    ));
    const value = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue(loaded), validateIntent, captureEvidence, executeIntent,
    }));
    await value.load();
    const issue = value.listUserIssues().find((candidate) => candidate.category === 'dependencyMissing')!;
    const action = issue.actions.find((candidate) => candidate.id === 'sync')!;
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'sync', pluginId: 'official/root', platform: 'codex', scope: 'project',
      originIssue: {
        issueId: issue.issueId, issueKey: userIssueKey(issue), category: issue.category, actionId: action.id,
        consumerPluginId: issue.pluginId, consumerSourceIdentity: issue.sourceIdentity,
        consumerPlatform: issue.platform, consumerScope: issue.scope,
        dependencyPluginId: issue.dependencyPluginId, dependencyPlatform: issue.dependencyPlatform,
        dependencyScope: issue.dependencyScope, dependencyProject: issue.dependencyProject,
      },
    });

    await expect(value.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'blocked', code: 'operationReviewStale',
    });
    expect(captureEvidence).toHaveBeenCalledTimes(1);
    expect(executeIntent).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['present', 'error'],
    ['error', 'present'],
  ] as const)('does not duplicate scope-conflict legality for %s + %s in the controller', async (userState, projectState) => {
    const captureEvidence = vi.fn().mockResolvedValue(baseEvidence);
    const executeIntent = vi.fn();
    const value = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue({
        payload: status({ targets: [
          target({ scope: 'user', state: userState }),
          target({ scope: 'project', state: projectState }),
        ] }),
        pluginSummaries: summaries(['official', 'demo']),
      }),
      captureEvidence,
      executeIntent,
    }));
    await value.load();

    await expect(value.buildOperationReview({
      kind: 'pluginWrite',
      action: 'uninstall',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: userState === 'present' ? 'user' : 'project',
      originIssue: {
        issueId: 'scope:official/demo:codex',
        issueKey: 'forged',
        category: 'scopeConflict',
        actionId: userState === 'present' ? 'keepProjectScope' : 'keepUserScope',
      },
    })).resolves.toMatchObject({ pluginAction: 'uninstall' });
    expect(captureEvidence).toHaveBeenCalledOnce();
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('reports a committed config write with one failed target as partial', async () => {
    const controller = new TuiController(dependencies({
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'partial',
        apply: {
          state: 'partial',
          targetResults: [
            { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
            { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
          ],
        },
      }),
    }));
    controller.push({
      name: 'configFields',
      pluginId: 'official/demo',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      projectLayer: 'shared',
      apply: true,
      updates: { mode: 'strict' },
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'partial',
      summary: {
        code: 'operationPartial',
        message: '设置已保存，但插件内容重新应用失败或部分失败。',
        configScope: 'user',
        configApplyRetryAvailable: true,
        targets: [
          expect.objectContaining({ platform: 'codex', state: 'completed' }),
          expect.objectContaining({ platform: 'claude', state: 'failed' }),
        ],
      },
    });
    expect(controller.snapshot.router.current.route).toMatchObject({ name: 'result' });
    expect(controller.snapshot.activeReview).toBeUndefined();
  });

  it('projects only the stable project shareability warning into the config result', async () => {
    const controller = new TuiController(dependencies({
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'succeeded',
        apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
        warnings: [
          'projectConfigShareabilityUnverified: Git evidence unavailable.',
          'private diagnostic /Users/example',
        ],
      }),
    }));
    controller.push({
      name: 'configFields',
      pluginId: 'official/demo',
      layer: { scope: 'project', projectLayer: 'shared' },
    });
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'project',
      projectLayer: 'shared',
      apply: false,
      updates: { mode: 'strict' },
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result.summary.messages).toEqual([
      '警告：projectConfigShareabilityUnverified: Git evidence unavailable.',
    ]);
  });

  it.each([
    ['user', true, ['提示：其它项目没有被扫描，可能需要在对应项目目录中运行 aw sync。']],
    ['project', false, []],
  ] as const)('projects the safe other-project sync fact for %s scope', async (
    scope,
    otherProjectsMayRequireSync,
    messages,
  ) => {
    const controller = new TuiController(dependencies({
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'succeeded',
        apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
        otherProjectsMayRequireSync,
        warnings: ['private diagnostic /Users/example'],
      }),
    }));
    controller.push({
      name: 'configFields',
      pluginId: 'official/demo',
      layer: { scope, projectLayer: 'shared' },
    });
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope,
      projectLayer: 'shared',
      apply: false,
      updates: { mode: 'strict' },
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result.summary.messages).toEqual(messages);
  });

  it('reports a saved invalid config with no target writes as unapplied partial', async () => {
    const controller = new TuiController(dependencies({
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'partial',
        apply: { state: 'unavailable', reason: 'invalidConfig', targetResults: [] },
      }),
    }));
    controller.push({
      name: 'configFields',
      pluginId: 'official/demo',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      projectLayer: 'shared',
      apply: true,
      updates: { mode: 'strict' },
    });

    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'partial',
      summary: {
        code: 'operationPartial',
        configApplied: false,
        configApplySkippedReason: 'invalidConfig',
        configApplyRetryAvailable: false,
        message: '设置已保存，但没有应用。当前配置仍无效。',
      },
    });
  });

  it.each([
    ['absent', undefined],
    ['deletedFile', undefined],
    ['unlinkedSymlink', undefined],
    ['quarantinedDirectory', 'config.broken-safe.json'],
  ] as const)('projects the safe %s config reset disposition', async (resetDisposition, quarantineBasename) => {
    const controller = new TuiController(dependencies({
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'succeeded',
        apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
        resetDisposition,
        ...(quarantineBasename ? { quarantineBasename } : {}),
      }),
    }));
    const review = await controller.buildOperationReview({
      kind: 'configReset', pluginId: 'official/demo', scope: 'user', projectLayer: 'shared',
    });

    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'succeeded',
      summary: {
        resetDisposition,
        ...(quarantineBasename ? { quarantineBasename } : {}),
      },
    });
  });

  it('reports a committed reset as partial when the post-write status reload fails', async () => {
    const initial = {
      payload: status({ sources: [source('official', { type: 'path', primary: true })] }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new Error('/private/reload failed'));
    const controller = new TuiController(dependencies({
      loadStatus,
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'succeeded',
        apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
      }),
    }));
    await controller.load();
    controller.push({
      name: 'configUnavailable', pluginId: 'official/demo',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const review = await controller.buildOperationReview({
      kind: 'configReset', pluginId: 'official/demo', scope: 'user', projectLayer: 'shared',
    });

    expect(await controller.executeOperation(review.reviewToken)).toMatchObject({
      state: 'partial', operationKind: 'configReset', pluginId: 'official/demo',
      summary: {
        code: 'operationPartial',
        message: '设置已保存，但最终状态无法刷新。',
        messages: expect.arrayContaining(['状态刷新失败。配置写入已经提交；请稍后刷新状态。']),
      },
      returnRoute: { name: 'configUnavailable', pluginId: 'official/demo' },
    });
    expect(controller.snapshot.result).toMatchObject({
      effects: { configCommit: 'completed', finalVerification: 'failed' },
    });
    expect(controller.snapshot.phase).toBe('ready');
    expect(JSON.stringify(controller.snapshot)).not.toContain('/private/reload');
  });

  it('accepts a reset receipt when the refreshed plugin bundle is unavailable', async () => {
    const initial = {
      payload: status({ sources: [source('official', { type: 'path', primary: true })] }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const unavailable = {
      payload: status({
        sources: [source('official')],
        targets: [target({ scope: 'user', state: 'error', errorCode: 'bundleUnavailable' })],
      }),
      pluginSummaries: [],
    };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(unavailable),
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'succeeded',
        apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
      }),
    }));
    await controller.load();
    controller.push({ name: 'configUnavailable', pluginId: 'official/demo' });
    const review = await controller.buildOperationReview({
      kind: 'configReset', pluginId: 'official/demo', scope: 'user', projectLayer: 'shared',
    });

    expect(await controller.executeOperation(review.reviewToken)).toMatchObject({
      state: 'succeeded', operationKind: 'configReset',
      summary: { message: '操作已完成。' },
    });
    controller.leaveResult();
    expect(controller.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/demo',
    });
  });

  it('returns from a successful result to the installed list when its plugin was deleted', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
        .mockResolvedValue({ payload: status(), pluginSummaries: [] }),
    }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'uninstall', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });

    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    controller.leaveResult();

    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
  });

  it('normalizes deleted plugin routes restored from history after a background reload', async () => {
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
        .mockResolvedValue({ payload: status(), pluginSummaries: [] }),
    }));
    await controller.load();
    controller.push({ name: 'configUnavailable', pluginId: 'official/demo' });
    controller.push({ name: 'sourceList' });

    await controller.load();
    controller.back();

    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
  });

  it('normalizes missing source ancestors and keeps an evicted history detail explicit after reload', async () => {
    const loaded = { payload: status(), pluginSummaries: summaries(['official', 'demo']) };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue(loaded),
    }));
    await controller.load();
    controller.push({ name: 'sourceTechnical', sourceId: 'removed' });
    controller.push({ name: 'operationDiagnostic', recordId: 'removed-record' });

    await controller.load();

    expect(controller.snapshot.router.current.route).toEqual({
      name: 'operationDiagnostic', recordId: 'removed-record',
    });
    controller.back();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'sourceList' });
  });

  it('normalizes a deleted plugin return route for blocked and stale results', async () => {
    const changedEvidence = { ...baseEvidence, targetFingerprint: 'sha256:changed' };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
        .mockResolvedValue({ payload: status(), pluginSummaries: [] }),
      captureEvidence: vi.fn()
        .mockResolvedValueOnce(baseEvidence)
        .mockResolvedValue(changedEvidence),
    }));
    await controller.load();
    controller.push({ name: 'configUnavailable', pluginId: 'official/demo' });
    const staleReview = await controller.buildOperationReview({
      kind: 'configReset', pluginId: 'official/demo', scope: 'user', projectLayer: 'shared',
    });

    await expect(controller.executeOperation(staleReview.reviewToken)).resolves.toMatchObject({ state: 'stale' });
    controller.back();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });

    const blocked = new TuiController(dependencies({
      loadStatus: vi.fn()
        .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
        .mockResolvedValue({ payload: status(), pluginSummaries: [] }),
      executeIntent: vi.fn().mockRejectedValue(new Error('writeRejected')),
    }));
    await blocked.load();
    blocked.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const blockedReview = await blocked.buildOperationReview({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });
    await expect(blocked.executeOperation(blockedReview.reviewToken)).resolves.toMatchObject({ state: 'blocked' });
    blocked.leaveResult();
    expect(blocked.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
  });

  it('confirms reset when the source remains ready after execution', async () => {
    const readyStatus = {
      payload: status({ sources: [source('official', { type: 'path', primary: true })] }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockResolvedValue(readyStatus),
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'succeeded',
        apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
      }),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'configReset', pluginId: 'official/demo', scope: 'user', projectLayer: 'shared',
    });

    expect(await controller.executeOperation(review.reviewToken)).toMatchObject({
      state: 'succeeded', operationKind: 'configReset',
    });
  });

  it('reloads status and reports uncertainty when config runtime apply throws', async () => {
    const loadStatus = vi.fn().mockResolvedValue({
      payload: status({ sources: [source('official', { type: 'path' })] }),
      pluginSummaries: summaries(['official', 'demo']),
    });
    const controller = new TuiController(dependencies({
      loadStatus,
      executeIntent: vi.fn().mockRejectedValue(
        new Error('runtimeApplyFailed: runtime apply failed: /Users/private/config.json'),
      ),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      projectLayer: 'shared',
      apply: true,
      updates: { mode: 'strict' },
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'blocked', code: 'runtimeApplyFailed', operationKind: 'configSave',
      writeMayHaveCompleted: true,
    });
    expect(loadStatus).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(controller.snapshot)).not.toContain('/Users/private');
  });

  it('preserves a committed config save as partial and creates a new apply-only Review', async () => {
    const committedError = Object.assign(new Error('runtime apply failed'), {
      code: 'configApplyFailed',
      configWrite: 'succeeded' as const,
    });
    const executeIntent = vi.fn()
      .mockRejectedValueOnce(committedError)
      .mockResolvedValueOnce({
        configWrite: 'succeeded',
        overallState: 'succeeded',
        apply: { state: 'succeeded', targetResults: [] },
      });
    const controller = new TuiController(dependencies({ executeIntent }));
    controller.push({
      name: 'configFields',
      pluginId: 'official/demo',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      projectLayer: 'shared',
      apply: true,
      updates: { mode: 'strict' },
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'partial',
      operationKind: 'configSave',
      summary: {
        code: 'operationPartial',
        message: '设置已保存，但后续应用失败。',
        configScope: 'user',
        configApplyRetryAvailable: true,
      },
    });
    const history = controller.listOperationHistory();
    expect(history).toHaveLength(1);
    expect(controller.getOperationDiagnostic(history[0]!.recordId)?.summary.effects).toMatchObject({
      configCommit: 'completed', finalVerification: 'completed',
    });

    const retry = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      apply: true,
      retryApply: true,
    });
    expect(retry.reviewToken).not.toBe(review.reviewToken);
    await controller.executeOperation(retry.reviewToken);
    expect(executeIntent.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      kind: 'configSave', apply: true, retryApply: true,
    }));
    expect(executeIntent.mock.calls[1]?.[0]).not.toHaveProperty('updates');
  });

  it('preserves a committed config reset without inventing a reset disposition', async () => {
    const loadStatus = vi.fn()
      .mockResolvedValueOnce({ payload: status(), pluginSummaries: summaries(['official', 'demo']) })
      .mockRejectedValueOnce(new Error('status unavailable'));
    const controller = new TuiController(dependencies({
      loadStatus,
      executeIntent: vi.fn().mockRejectedValue(Object.assign(new Error('apply failed'), {
        code: 'configApplyFailed',
        configWrite: 'succeeded' as const,
      })),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'configReset', pluginId: 'official/demo', scope: 'user', projectLayer: 'shared',
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'partial',
      operationKind: 'configReset',
      summary: {
        message: '设置层重置已提交，但后续步骤未完成。',
        configScope: 'user',
      },
    });
    expect(controller.snapshot.result).toMatchObject({
      effects: { configCommit: 'completed', finalVerification: 'failed' },
    });
    expect(result.summary).not.toHaveProperty('configApplyRetryAvailable');
    expect(result.summary).not.toHaveProperty('resetDisposition');
  });

  it('invalidates cancelled, expired, and over-limit Review tickets through public behavior', async () => {
    let token = 0;
    let now = 1_000;
    const controller = new TuiController(dependencies({
      createToken: () => `token-${++token}`,
      now: () => now,
      reviewTtlMs: 10,
      maxReviewTickets: 2,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'install' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'user' as const,
    };
    const oldest = await controller.buildOperationReview(intent);
    const retained = await controller.buildOperationReview(intent);
    const newest = await controller.buildOperationReview(intent);
    expect(await controller.executeOperation(oldest.reviewToken)).toMatchObject({
      state: 'blocked', code: 'reviewTicketInvalid',
    });
    expect(await controller.executeOperation(retained.reviewToken)).toMatchObject({ state: 'succeeded' });

    const cancelled = await controller.buildOperationReview(intent);
    controller.back();
    expect(await controller.executeOperation(cancelled.reviewToken)).toMatchObject({
      state: 'blocked', code: 'reviewTicketInvalid',
    });

    const expired = await controller.buildOperationReview(intent);
    now = 2_000;
    await controller.buildOperationReview(intent);
    expect(await controller.executeOperation(expired.reviewToken)).toMatchObject({
      state: 'blocked', code: 'reviewTicketInvalid',
    });
    expect(newest.reviewToken).not.toBe(cancelled.reviewToken);
  });

  it('rebuilds a plugin Review after the locked executor reports that the intent became illegal', async () => {
    const changedEvidence = { ...baseEvidence, targetFingerprint: 'sha256:changed' };
    const executeIntent = vi.fn().mockRejectedValue(new Error(
      'operationReviewStale: locked target evidence changed',
    ));
    const validateIntent = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('targetAlreadyInstalled: new state is not legal'));
    const captureEvidence = vi.fn()
      .mockResolvedValueOnce(baseEvidence)
      .mockResolvedValueOnce(changedEvidence)
      .mockResolvedValueOnce(changedEvidence);
    const controller = new TuiController(dependencies({
      captureEvidence,
      executeIntent,
      validateIntent,
    }));
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'install' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'user' as const,
    };
    const review = await controller.buildOperationReview(intent);

    const result = await controller.executeOperation(review.reviewToken);

    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(validateIntent).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      state: 'blocked',
      code: 'targetAlreadyInstalled',
    });
    expect(result).not.toHaveProperty('writeMayHaveCompleted');
    expect(controller.snapshot.router.current.route).toEqual({ name: 'result', operationId: review.operationId });
  });

  it('returns a new Review when the locked write reports a typed stale prefix', async () => {
    const changedEvidence = { ...baseEvidence, targetFingerprint: 'sha256:locked-change' };
    const executeIntent = vi.fn()
      .mockRejectedValueOnce(new TuiOperationBlockedError(
        'operationReviewStale',
        'operationReviewStale: /Users/private/target token-private',
        [{
          id: 'runtime-root', code: 'catalogGenerationUnavailable', stage: 'source',
          sourceId: 'official', safeMessage: 'The Catalog source could not be prepared safely.',
          target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
          causes: [], detailLines: [],
        }],
      ))
      .mockResolvedValueOnce({
        overallState: 'succeeded', targetResults: [{
          target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
          action: 'install', state: 'completed', requiredBy: [],
        }],
      });
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn()
        .mockResolvedValueOnce(baseEvidence)
        .mockResolvedValueOnce(baseEvidence)
        .mockResolvedValueOnce(changedEvidence)
        .mockResolvedValueOnce(changedEvidence),
      executeIntent,
    }));
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: 'user',
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result.state).toBe('stale');
    expect(controller.snapshot.router.depth).toBe(2);
    const staleHistory = controller.listOperationHistory();
    expect(staleHistory).toEqual([expect.objectContaining({
      operationId: review.operationId, state: 'blocked', code: 'catalogGenerationUnavailable',
    })]);
    expect(controller.getOperationDiagnostic(staleHistory[0]!.recordId)?.diagnostics)
      .toEqual([expect.objectContaining({
        code: 'catalogGenerationUnavailable', stage: 'source', sourceId: 'official',
      })]);
    const replacement = result.state === 'stale' ? result.review : undefined;
    await expect(controller.executeOperation(replacement!.reviewToken)).resolves.toMatchObject({
      state: 'succeeded',
    });
    expect(controller.listOperationHistory()).toHaveLength(2);
    expect(controller.listOperationHistory()[0]).toMatchObject({ diagnosticCount: 0 });
    expect(JSON.stringify(controller.snapshot)).not.toContain('/Users/private');
    expect(JSON.stringify(controller.snapshot)).not.toContain('token-private');
  });

  it('keeps the stale cause and the failed re-preparation cause in operation history', async () => {
    const rootCause = new TuiOperationBlockedError(
      'taskNoExecutableTargets',
      'The task has no executable targets.',
      [{
        id: 'temporary-root',
        code: 'issueVerificationFailed',
        stage: 'preflight.inspect',
        sourceId: 'official',
        safeMessage: 'The target inspection could not verify the current target.',
        target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
        causes: [], detailLines: [],
      }],
    );
    const captureEvidence = vi.fn()
      .mockResolvedValueOnce(baseEvidence)
      .mockRejectedValueOnce(rootCause);
    const controller = new TuiController(dependencies({
      captureEvidence,
      executeIntent: vi.fn().mockRejectedValue(
        new Error('operationReviewStale: /Users/private/target --token private-value'),
      ),
    }));
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/demo',
      platform: 'codex', scope: 'user',
    });

    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'blocked', code: 'taskNoExecutableTargets',
    });
    const history = controller.listOperationHistory();
    expect(history).toHaveLength(1);
    const detail = controller.getOperationDiagnostic(history[0]!.recordId)!;
    expect(detail.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      'operationReviewStale',
      'issueVerificationFailed',
    ]);
    expect(detail.targets).toContainEqual(expect.objectContaining({
      pluginId: 'official/demo', state: 'skipped',
      diagnosticIds: [expect.stringContaining(':failure:1')],
    }));
    expect(JSON.stringify(detail)).not.toContain('/Users/private');
    expect(JSON.stringify(detail)).not.toContain('private-value');
  });

  it('does not expose sensitive config values in Review or controller snapshots', async () => {
    const secret = 'sk-private-review-secret';
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({
        ...baseEvidence,
        config: {
          scope: 'user',
          projectLayer: 'shared',
          schemaIdentity: 'sha256:schema',
          storeDigest: 'sha256:store',
          affectedTargets: [],
        },
      }),
    }));
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      projectLayer: 'shared',
      apply: false,
      updates: { token: secret },
      sensitiveKeys: ['token'],
    });

    const visible = JSON.stringify({ review, snapshot: controller.snapshot });
    expect(visible).not.toContain(secret);
    expect(visible).toContain('已设置 → 将更新');
    expect(visible).not.toContain('/Users/');
  });

  it.each([
    ['user and current project', 'user', [
      { platform: 'codex', scope: 'user' },
      { platform: 'codex', scope: 'project' },
    ], ['Codex · 所有项目', 'Codex · 当前项目']],
    ['project only', 'project', [
      { platform: 'claude', scope: 'project' },
    ], ['Claude Code · 当前项目']],
    ['user only', 'user', [
      { platform: 'claude', scope: 'user' },
    ], ['Claude Code · 所有项目']],
  ] as const)('uses evidence-owned affected targets for a %s config Review', async (_label, scope, affectedTargets, labels) => {
    const evidence: OperationEvidence = {
      ...baseEvidence,
      config: {
        scope,
        projectLayer: 'shared',
        schemaIdentity: 'sha256:schema',
        storeDigest: 'sha256:store',
        affectedTargets: [...affectedTargets],
      },
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(evidence),
    }));

    const review = await controller.buildOperationReview({
      kind: 'configSave', pluginId: 'official/demo', scope,
      projectLayer: 'shared', apply: true, updates: { mode: 'safe' },
      changes: [{ key: 'mode', title: '模式', before: '旧值', after: '新值' }],
    });

    expect(review.changes.filter((change) => change.group === 'configImpact').map((change) => change.title))
      .toEqual(labels.map((label) => `重新应用 ${label}`));
    expect(review.requiresConfirmation).toBe(false);
  });

  it.each([
    [false, ['Codex 由平台共用的内容待同步'], '个人默认已保存；动态 Skill 尚未重新生成。'],
    [true, ['重新生成 codex-explore、codex-subagent-guide 动态 Skill'], '配置来源为个人默认；更新 Codex 由平台共用的内容会影响所有启用项目。'],
  ] as const)('describes shared native render impact when apply=%s', async (apply, impactTitles, description) => {
    const evidence: OperationEvidence = {
      ...baseEvidence,
      config: {
        scope: 'user',
        schemaIdentity: 'sha256:schema',
        storeDigest: 'sha256:store',
        affectedTargets: [
          { platform: 'codex', scope: 'user' },
          { platform: 'codex', scope: 'project' },
        ],
        sharedNativeRenderTargets: [
          { id: 'explore', skillKey: 'codex-explore', refreshKeys: ['exploreWait'] },
          { id: 'subagent', skillKey: 'codex-subagent-guide', refreshKeys: ['subagentWait'] },
        ],
      },
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(evidence),
    }));

    const review = await controller.buildOperationReview({
      kind: 'configSave', pluginId: 'official/enhance', scope: 'user',
      projectLayer: 'shared', apply, updates: { exploreWait: 15 },
      changes: [{ key: 'exploreWait', title: '等待窗口', before: '10', after: '15' }],
    });

    expect(review.changes.filter((change) => change.group === 'configImpact')
      .map((change) => change.title)).toEqual(impactTitles);
    expect(review.changes).toContainEqual(expect.objectContaining({ description }));
    expect(review.changes).toContainEqual(expect.objectContaining({
      title: '当前项目 Agent role 继续使用当前项目配置', kind: 'keep',
    }));
    expect(review).toMatchObject({
      requiresConfirmation: apply,
      sharedImpact: apply
        ? { pluginIds: ['official/enhance'], warning: expect.stringContaining('所有启用项目') }
        : { pluginIds: [] },
    });
  });

  it.each([false, true])(
    'only promises to save shared native config without visible targets when apply=%s',
    async (apply) => {
      const evidence: OperationEvidence = {
        ...baseEvidence,
        config: {
          scope: 'user',
          schemaIdentity: 'sha256:schema',
          storeDigest: 'sha256:store',
          affectedTargets: [],
          sharedNativeRenderTargets: [
            { id: 'explore', skillKey: 'codex-explore', refreshKeys: ['exploreWait'] },
            { id: 'subagent', skillKey: 'codex-subagent-guide', refreshKeys: ['subagentWait'] },
          ],
        },
      };
      const controller = new TuiController(dependencies({
        captureEvidence: vi.fn().mockResolvedValue(evidence),
      }));

      const review = await controller.buildOperationReview({
        kind: 'configSave', pluginId: 'official/enhance', scope: 'user',
        projectLayer: 'shared', apply, updates: { exploreWait: 15 },
        changes: [{ key: 'exploreWait', title: '等待窗口', before: '10', after: '15' }],
      });

      expect(review.changes.filter((change) => change.group === 'configImpact'))
        .toEqual([{ kind: 'keep', group: 'configImpact', title: '当前没有可见安装；只保存设置' }]);
      expect(JSON.stringify(review.changes)).not.toContain('共享 Codex native render 待同步');
      expect(JSON.stringify(review.changes)).not.toContain('重新生成');
      expect(review.requiresConfirmation).toBe(false);
    },
  );

  it('describes an effective config no-op without claiming that no installation exists', async () => {
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({
        ...baseEvidence,
        config: {
          scope: 'project',
          schemaIdentity: 'sha256:schema',
          storeDigest: 'sha256:store',
          impactState: 'known',
          noEffectiveChange: true,
          affectedTargets: [],
        },
      }),
    }));

    const review = await controller.buildOperationReview({
      kind: 'configSave', pluginId: 'official/enhance', scope: 'project',
      projectLayer: 'shared', apply: true, removeKeys: ['exploreWait'],
      changes: [{ key: 'exploreWait', title: '等待窗口', before: '15', after: '15' }],
    });

    expect(review.changes.filter((change) => change.group === 'configImpact')).toEqual([{
      kind: 'keep', group: 'configImpact', title: '有效设置输入不变；无需重新应用',
    }]);
    expect(JSON.stringify(review.changes)).not.toContain('当前没有可见安装');
    expect(JSON.stringify(review.changes)).not.toContain('动态 Skill');
    expect(review.requiresConfirmation).toBe(false);
  });

  it('reports unknown reset impact without claiming that installations stay unchanged', async () => {
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue({
        ...baseEvidence,
        config: {
          scope: 'user',
          storeDigest: 'sha256:invalid-store',
          impactState: 'unknown',
          affectedTargets: [],
        },
        resetTarget: {
          sourceId: 'official', pluginName: 'enhance', scope: 'user',
          kind: 'regularFile', fingerprint: 'sha256:reset-target',
        },
      }),
    }));

    const review = await controller.buildOperationReview({
      kind: 'configReset', pluginId: 'official/enhance', scope: 'user',
      projectLayer: 'shared',
    });

    expect(review.changes).toContainEqual(expect.objectContaining({
      kind: 'warning', group: 'configImpact', title: '设置重置后的应用影响未知',
    }));
    expect(JSON.stringify(review.changes)).not.toContain('当前安装保持不变');
  });

  it('keeps visible placement stale protection for an unknown reset impact', () => {
    const expected: OperationEvidence = {
      ...baseEvidence,
      targetFingerprint: 'sha256:visible-before',
      config: {
        scope: 'user', storeDigest: 'sha256:invalid-store',
        impactState: 'unknown', affectedTargets: [],
      },
      resetTarget: {
        sourceId: 'official', pluginName: 'enhance', scope: 'user',
        kind: 'regularFile', fingerprint: 'sha256:reset-target',
      },
    };

    expect(operationEvidenceMatches(expected, {
      ...expected,
      targetFingerprint: 'sha256:visible-after',
    })).toBe(false);
  });

  it('passes the canonical plugin identity to the write executor', async () => {
    const executeIntent = vi.fn().mockResolvedValue({ ok: true });
    const controller = new TuiController(dependencies({ executeIntent }));
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite',
      action: 'cleanup',
      pluginId: 'team-tools/review-gate',
      platform: 'claude',
      scope: 'project',
    });

    await controller.executeOperation(review.reviewToken);

    expect(executeIntent).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'team-tools/review-gate' }),
      baseEvidence,
    );
    expect(controller.snapshot.result).toMatchObject({
      summary: { pluginId: 'team-tools/review-gate', action: 'cleanup' },
    });
  });

  it('keeps only a safe result summary and reloads after a post-command failure', async () => {
    const secret = '/Users/private/config.json?token=private-token';
    const succeeded = new TuiController(dependencies({
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'succeeded',
        apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
        effective: { token: secret },
        path: secret,
      }),
    }));
    const successReview = await succeeded.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      projectLayer: 'shared',
      apply: false,
      updates: { token: secret },
      sensitiveKeys: ['token'],
    });
    await succeeded.executeOperation(successReview.reviewToken);

    const failed = new TuiController(dependencies({
      executeIntent: vi.fn().mockRejectedValue(new Error(`nativeStateUnreadable: ${secret}`)),
    }));
    const failureReview = await failed.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'official/demo',
      platform: 'codex',
      scope: 'user',
    });
    await failed.executeOperation(failureReview.reviewToken);

    expect(succeeded.snapshot.result).toEqual(expect.objectContaining({
      state: 'succeeded',
      summary: expect.objectContaining({ code: 'operationSucceeded', message: '操作已完成。' }),
    }));
    expect(failed.snapshot.result).toEqual(expect.objectContaining({
      state: 'blocked',
      code: 'nativeStateUnreadable',
      writeMayHaveCompleted: true,
      message: '写入可能已完成，当前无法确认。请查看刷新后的平台或问题状态。',
    }));
    expect(JSON.stringify({ success: succeeded.snapshot, failure: failed.snapshot })).not.toContain(secret);
  });

  it('keeps typed target diagnostics and preApply effect facts in safe operation history', async () => {
    const secret = 'stderr: Authorization=private-token';
    const controller = new TuiController(dependencies({
      executeIntent: vi.fn().mockResolvedValue({
        platforms: ['codex'],
        plugins: ['official/demo'],
        warnings: [secret, 'obsolete contract at /Users/private/.aw/state.json'],
        overallState: 'failed',
        targetResults: [{
          target: { pluginId: 'official/demo', pluginName: 'demo', platform: 'codex', scope: 'user' },
          action: 'install', state: 'failed', errorCode: 'preApplyFailed', message: secret,
        }],
        rebuildResults: [{
          status: 'failed', command: 'install',
          target: { pluginId: 'official/demo', pluginName: 'demo', platform: 'codex', scope: 'user' },
          actions: [{ name: 'preApply', status: 'failed' }],
          error: {
            phase: 'preApply', message: secret,
            operationDiagnostic: {
              code: 'preApplyExited', stage: 'preApply', exitCode: 7,
              safeMessage: 'The preApply process exited unsuccessfully.',
            },
          },
        }],
      }),
    }));
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });

    const result = await controller.executeOperation(review.reviewToken);
    const recordId = controller.snapshot.result?.operationRecordId;
    const detail = controller.getOperationDiagnostic(recordId!);

    expect(result).toMatchObject({ state: 'blocked' });
    expect(controller.snapshot.result).toMatchObject({
      effects: { awWrite: 'notStarted', preApplyExternalEffect: 'possible' },
    });
    expect(detail).toMatchObject({
      diagnostics: [{ code: 'preApplyExited', stage: 'preApply', exitCode: 7 }],
      targets: [{ state: 'failed', errorCode: 'preApplyFailed' }],
    });
    expect(JSON.stringify({ snapshot: controller.snapshot, detail })).not.toContain(secret);
  });

  it('transfers terminal diagnostics into the twenty-record history without retaining operation-private state', async () => {
    let token = 0;
    const controller = new TuiController(dependencies({
      createToken: () => `token-${++token}`,
      executeIntent: vi.fn().mockResolvedValue({
        platforms: ['codex'],
        plugins: ['official/demo'],
        overallState: 'succeeded',
        targetResults: [{
          target: { pluginId: 'official/demo', platform: 'codex', scope: 'user' },
          action: 'install', state: 'completed',
        }],
      }),
    }));

    for (let index = 0; index < 25; index += 1) {
      const review = await controller.buildOperationReview({
        kind: 'pluginWrite', action: 'install', pluginId: 'official/demo', platform: 'codex', scope: 'user',
      });
      await controller.executeOperation(review.reviewToken);
      controller.leaveResult();
    }

    expect(controller.listOperationHistory()).toHaveLength(20);
    expect(controller.operationDiagnosticRetentionCountForTests()).toBe(0);
  });

  it('isolates nested router, status, ticket, progress, and result values from caller mutation', async () => {
    const router = new TuiRouter();
    const route = {
      name: 'configFields' as const,
      pluginId: 'official/demo',
      layer: { scope: 'project' as 'project' | 'user' },
    };
    router.push(route);
    route.layer.scope = 'user';
    expect(router.snapshot.current.route).toMatchObject({ layer: { scope: 'project' } });

    const loaded = {
      payload: status({ sources: [source('official', { type: 'path' })] }),
      pluginSummaries: summaries(['official', 'demo']),
    };
    const loadSnapshot = structuredClone(loaded);
    let progressListener: ((value: { messages: string[] }) => void) | undefined;
    const controller = new TuiController(dependencies({
      loadStatus: vi.fn().mockImplementation(async () => structuredClone(loadSnapshot)),
    }), {
      subscribe: (listener) => {
        progressListener = listener;
        return vi.fn();
      },
    } as unknown as RebuildProgressFeed);
    await controller.load();
    loaded.pluginSummaries[0]!.pluginName = 'mutated';
    const messages = ['safe'];
    progressListener?.({ messages });
    messages[0] = 'mutated';
    expect(controller.snapshot.progress.messages).toEqual(['safe']);
    const intent = {
      kind: 'configSave' as const,
      pluginId: 'official/demo',
      scope: 'user' as const,
      projectLayer: 'shared' as const,
      apply: false,
      updates: { mode: 'safe' },
    };
    const review = await controller.buildOperationReview(intent);
    intent.updates.mode = 'mutated';
    await controller.executeOperation(review.reviewToken);
    const snapshot = controller.snapshot;

    expect(controller.listPlugins({ mode: 'browse' })[0]?.displayName).toBe('demo');
    expect(snapshot.progress.messages).toEqual([]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.viewModel?.plugins)).toBe(true);
    expect(controller.dependencies.executeIntent).toHaveBeenCalledWith(
      expect.objectContaining({ updates: { mode: 'safe' } }),
      defaultConfigEvidence('user'),
    );
  });

  it('publishes rebuild progress through the unified snapshot', () => {
    let progressListener: ((value: { current?: { target: string; phase: string }; messages: string[] }) => void) | undefined;
    const progressFeed = {
      subscribe: vi.fn((listener) => {
        progressListener = listener;
        listener({ messages: [] });
        return vi.fn();
      }),
    } as unknown as RebuildProgressFeed;
    const controller = new TuiController(dependencies(), progressFeed);
    progressListener?.({ current: { target: 'demo', phase: '检查当前组件' }, messages: ['开始检查'] });

    expect(controller.snapshot.progress).toEqual({
      current: { target: 'demo', phase: '检查当前组件' },
      messages: ['开始检查'],
    });
  });

  it('retains elapsed time and only the latest eight safe progress messages in the result summary', async () => {
    let listener: ((value: { messages: string[] }) => void) | undefined;
    let now = 1_000;
    const controller = new TuiController(dependencies({
      now: () => now,
      executeIntent: vi.fn(async () => {
        listener?.({ messages: Array.from({ length: 10 }, (_, index) => `安全消息 ${index + 1}`) });
        now = 4_500;
        return {
          configWrite: 'succeeded',
          overallState: 'succeeded',
          apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
        };
      }),
    }), {
      subscribe: (next) => {
        listener = next;
        next({ messages: [] });
        return vi.fn();
      },
      clearCurrent: vi.fn(),
    } as unknown as RebuildProgressFeed);
    const review = await controller.buildOperationReview({
      kind: 'configSave', pluginId: 'official/demo', scope: 'user', projectLayer: 'shared', apply: false, updates: { mode: 'safe' },
    });
    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'succeeded',
      summary: { elapsedMs: 3_500, messages: Array.from({ length: 8 }, (_, index) => `安全消息 ${index + 3}`) },
    });
  });

  it('clears current and messages before each consecutive formal execution', async () => {
    const feed = createRebuildProgressFeed();
    const second = deferred<unknown>();
    let call = 0;
    const value = new TuiController(dependencies({
      executeIntent: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          feed.addEvent({
            type: 'rebuild:action',
            source: { plugin: 'demo', platform: 'codex', scope: 'user' },
            data: { name: 'preflight.inspect', phase: 'start' },
          } as never);
          return { ok: true };
        }
        return second.promise;
      }),
    }), feed);
    const intent = {
      kind: 'pluginWrite' as const, action: 'install' as const,
      pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
    };
    const first = await value.buildOperationReview(intent);
    const firstResult = await value.executeOperation(first.reviewToken);
    expect(firstResult).toMatchObject({ summary: { messages: expect.any(Array) } });
    expect(value.snapshot.progress).toEqual({ messages: [] });

    const next = await value.buildOperationReview(intent);
    const executing = value.executeOperation(next.reviewToken);
    await nextTurn();
    expect(value.snapshot.progress.current).toEqual({
      target: 'official/demo', phase: '验证当前状态',
    });
    expect(value.snapshot.progress.messages).toEqual([]);
    second.resolve({ ok: true });
    const secondResult = await executing;
    expect(secondResult).toMatchObject({ summary: { messages: [] } });
    expect(JSON.stringify(secondResult)).not.toContain('demo · Codex');
  });

  it('binds source writes to proposed config and inventory evidence without exposing private input', async () => {
    const privatePath = '/Users/private/catalog';
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:candidate' },
      sourceWrite: {
        configDigest: 'sha256:before',
        proposedConfigDigest: 'sha256:candidate',
        sourceIdentity: 'sha256:identity',
        inventoryDigest: 'sha256:inventory',
        referenceCount: 0,
        inventoryComplete: true,
      },
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
      executeIntent: vi.fn().mockResolvedValue({ ok: true }),
    }));
    await controller.load();
    const review = await controller.buildOperationReview({
      kind: 'sourceMutation',
      action: 'add',
      sourceId: 'local-dev',
      source: { id: 'local-dev', type: 'path', primary: false, path: privatePath },
      changes: [{ title: '本地目录', private: true }],
    });

    expect(review.technicalDetails).toContain('新配置：candidat');
    expect(review.technicalDetails).toContain('引用清单：inventor · 0 项');
    expect(JSON.stringify(controller.snapshot)).not.toContain(privatePath);
    await controller.executeOperation(review.reviewToken);
    expect(controller.snapshot.result).toMatchObject({ state: 'succeeded', operationKind: 'sourceMutation' });
    expect(vi.mocked(controller.dependencies.loadStatus).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('describes an autoCheck-only Review as a settings save with unchanged Active and store', async () => {
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:after' },
      sourceWrite: {
        configDigest: 'sha256:before', proposedConfigDigest: 'sha256:after',
        inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true,
      },
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'sourceMutation',
      action: 'update',
      sourceId: 'official',
      update: { autoCheck: false },
      changes: [{ title: '自动检查更新', before: '开启', after: '关闭' }],
    });

    expect(review).toMatchObject({
      title: '保存自动检查设置',
      description: '只保存自动检查设置；当前启用版本和本地目录副本保持不变。',
      primaryLabel: '保存设置',
      changes: [expect.objectContaining({
        title: '自动检查更新', description: '开启 → 关闭',
      })],
    });
    expect(JSON.stringify(review)).not.toContain('source sync');
    controller.dispose();
  });

  it('shows the reviewed primary transition impact in the source Review', async () => {
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:after' },
      sourceWrite: {
        configDigest: 'sha256:before',
        proposedConfigDigest: 'sha256:after',
        inventoryDigest: 'sha256:inventory',
        impactDigest: 'sha256:impact',
        referenceCount: 2,
        inventoryComplete: true,
        impact: {
          impactSchemaVersion: 3,
          sourceId: 'team',
          primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
          inventoryComplete: true,
          references: [],
          affectedReferences: [
            { category: 'config', sourceId: 'official', pluginId: 'official/demo', scope: 'user' },
            { category: 'marketplace', sourceId: 'official', marketplaceName: 'aw' },
          ],
          changes: {
            added: [], removed: [], changed: [], newlyIncompatible: [],
            dependencyChanged: [], platformSupportChanged: [],
          },
          errors: [],
        },
      },
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'sourceMutation', action: 'setPrimary', sourceId: 'team',
    });

    expect(review).toMatchObject({
      requiresConfirmation: true,
      changes: expect.arrayContaining([
        expect.objectContaining({ title: '设置引用受影响', description: '1 项' }),
        expect.objectContaining({ title: 'Marketplace引用受影响', description: '1 项' }),
      ]),
    });
  });

  it('shows primary references in an activate-then-primary Review', async () => {
    const candidate = {
      sourceId: 'team', sourceConfigFingerprint: 'sha256:source', sourceIdentity: 'sha256:identity',
      logicalIdentity: 'workspace:team', requestedRef: 'path', resolvedCommit: 'path',
      catalogVersion: '1.0.0', channel: 'latest' as const,
      manifestDigest: `sha256:${'1'.repeat(64)}`, snapshotDigest: `sha256:${'2'.repeat(64)}`,
    };
    const evidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:config', compositeDigest: candidate.snapshotDigest },
      catalogGeneration: {
        action: 'activate', candidate, activationMode: 'normal', configDigest: 'sha256:config',
        setPrimaryAfterActivation: true,
        primaryConfigDigest: 'sha256:config',
        primaryImpactDigest: 'sha256:primary-impact',
        primaryImpact: {
          impactSchemaVersion: 3,
          sourceId: 'team',
          primaryChange: { fromSourceId: 'official', toSourceId: 'team' },
          inventoryComplete: true,
          references: [],
          affectedReferences: [
            { category: 'config', sourceId: 'official', pluginId: 'official/demo', scope: 'user' },
          ],
          changes: {
            added: [], removed: [], changed: [], newlyIncompatible: [],
            dependencyChanged: [], platformSupportChanged: [],
          },
          errors: [],
        },
      },
    };
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(evidence),
    }));
    await controller.load();

    const review = await controller.buildOperationReview({
      kind: 'catalogGeneration', action: 'activate', sourceId: 'team',
      setPrimaryAfterActivation: true,
    });

    expect(review).toMatchObject({
      requiresConfirmation: true,
      changes: expect.arrayContaining([expect.objectContaining({
        title: '切换主来源会影响现有引用',
        description: '1 项；切换将在插件目录启用后执行。',
      })]),
      sharedImpact: { pluginIds: ['official/demo'] },
    });
  });

  it('rebuilds a source Review with zero writes when config evidence becomes stale', async () => {
    const first: OperationEvidence = {
      catalog: { configDigest: 'sha256:one', compositeDigest: 'sha256:candidate-one' },
      sourceWrite: { configDigest: 'sha256:one', proposedConfigDigest: 'sha256:candidate-one', inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true },
    };
    const second: OperationEvidence = {
      catalog: { configDigest: 'sha256:two', compositeDigest: 'sha256:candidate-two' },
      sourceWrite: { configDigest: 'sha256:two', proposedConfigDigest: 'sha256:candidate-two', inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true },
    };
    const executeIntent = vi.fn();
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second),
      executeIntent,
    }));
    const review = await controller.buildOperationReview({ kind: 'sourceMutation', action: 'setPrimary', sourceId: 'team-tools' });
    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({ state: 'stale' });
    expect(executeIntent).not.toHaveBeenCalled();
    expect(controller.snapshot.activeReview?.technicalDetails).toContain('新配置：candidat');
  });

  it('maps a source config CAS conflict to the same typed stale Review', async () => {
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:one', compositeDigest: 'sha256:candidate' },
      sourceWrite: { configDigest: 'sha256:one', proposedConfigDigest: 'sha256:candidate', inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true },
    };
    const conflict = new Error('Catalog source config changed concurrently.');
    conflict.name = 'CatalogSourcesConfigConflictError';
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
      executeIntent: vi.fn().mockRejectedValue(conflict),
    }));
    const review = await controller.buildOperationReview({
      kind: 'sourceMutation',
      action: 'setPrimary',
      sourceId: 'team-tools',
    });

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'stale',
      operationKind: 'sourceMutation',
      sourceAction: 'setPrimary',
      review: { operationKind: 'sourceMutation', sourceAction: 'setPrimary' },
    });
  });

  it('publishes ReviewPreparing before validation and replaces it with Review without growing the stack', async () => {
    const validation = deferred<void>();
    const captured = deferred<OperationEvidence>();
    const validateIntent = vi.fn(() => validation.promise);
    const captureEvidence = vi.fn(() => captured.promise);
    const controller = new TuiController(dependencies({ validateIntent, captureEvidence }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' }, { focusIndex: 3 });
    const depth = controller.snapshot.router.depth;

    const preparation = controller.startReviewPreparation({
      kind: 'pluginWrite', action: 'refreshAndSync', pluginId: 'official/demo', platform: 'codex', scope: 'user',
    });

    expect(controller.snapshot.router).toMatchObject({
      depth: depth + 1,
      current: { route: { name: 'reviewPreparing', preparationId: preparation.id } },
    });
    expect(controller.snapshot.reviewPreparation).toMatchObject({
      state: 'running',
      operationKind: 'pluginWrite',
      subject: 'demo',
      currentStage: 'validate',
      stages: [
        { id: 'validate', state: 'running' },
        { id: 'evidence', state: 'pending' },
      ],
    });
    expect(validateIntent).not.toHaveBeenCalled();
    expect(captureEvidence).not.toHaveBeenCalled();

    await nextTurn();
    expect(validateIntent).toHaveBeenCalledOnce();
    validation.resolve();
    await nextTurn();
    expect(controller.snapshot.reviewPreparation?.stages).toEqual([
      { id: 'validate', label: '验证当前状态', state: 'completed' },
      { id: 'evidence', label: '准备确认信息', state: 'running' },
    ]);
    captured.resolve(baseEvidence);
    await nextTurn();

    expect(controller.snapshot.router).toMatchObject({
      depth: depth + 1,
      current: { route: { name: 'review' } },
    });
    expect(controller.snapshot.reviewPreparation).toBeUndefined();
    controller.back();
    expect(controller.snapshot.router.current).toEqual({
      route: { name: 'pluginDetail', pluginId: 'official/demo' },
      context: { focusIndex: 3 },
    });
  });

  it('single-flights identical preparation and discards late completion after cancellation', async () => {
    const captured = deferred<OperationEvidence>();
    const executeIntent = vi.fn();
    const captureEvidence = vi.fn(() => captured.promise);
    const controller = new TuiController(dependencies({ captureEvidence, executeIntent }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'reinstall' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'user' as const,
    };

    const first = controller.startReviewPreparation(intent);
    const second = controller.startReviewPreparation(structuredClone(intent));
    expect(second.id).toBe(first.id);
    expect(controller.snapshot.router.depth).toBe(3);
    await nextTurn();
    expect(captureEvidence).toHaveBeenCalledOnce();

    controller.back();
    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/demo' });
    expect(controller.snapshot.reviewPreparation).toBeUndefined();
    expect(captureEvidence.mock.calls[0]?.[1]).toMatchObject({ aborted: true });
    captured.resolve(baseEvidence);
    await nextTurn();

    expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/demo' });
    expect(controller.snapshot.activeReview).toBeUndefined();
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('uses one preparation entry and publishes only stages reported by real review work', async () => {
    const prepareReviewEvidence: NonNullable<TuiControllerDependencies['prepareReviewEvidence']> = vi.fn(
      async (_intent, _signal, onStage) => {
        for (const stage of ['status', 'catalog', 'inventory', 'dependencyPlan', 'evidence'] as const) {
          await onStage(stage);
        }
        return baseEvidence;
      },
    );
    const validateIntent = vi.fn();
    const captureEvidence = vi.fn();
    const controller = new TuiController(dependencies({
      prepareReviewEvidence,
      validateIntent,
      captureEvidence,
    }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const observedStages: string[][] = [];
    controller.subscribe((snapshot) => {
      if (snapshot.reviewPreparation) {
        observedStages.push(snapshot.reviewPreparation.stages.map((stage) =>
          `${stage.id}:${stage.state}`));
      }
    });
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'install' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'user' as const,
    };

    controller.startReviewPreparation(intent);
    await nextTurn(2);

    expect(prepareReviewEvidence).toHaveBeenCalledOnce();
    expect(validateIntent).not.toHaveBeenCalled();
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(observedStages).toEqual(expect.arrayContaining([
      ['status:running'],
      ['status:completed', 'catalog:running'],
      ['status:completed', 'catalog:completed', 'inventory:running'],
      ['status:completed', 'catalog:completed', 'inventory:completed', 'dependencyPlan:running'],
      ['status:completed', 'catalog:completed', 'inventory:completed', 'dependencyPlan:completed', 'evidence:running'],
      ['status:completed', 'catalog:completed', 'inventory:completed', 'dependencyPlan:completed', 'evidence:completed'],
    ]));
    expect(controller.snapshot.router.current.route.name).toBe('review');

    await controller.buildOperationReview(intent);
    expect(prepareReviewEvidence).toHaveBeenCalledTimes(2);
    expect(validateIntent).not.toHaveBeenCalled();
    expect(captureEvidence).not.toHaveBeenCalled();
  });

  it('keeps private config and source inputs out of every public preparation stage', async () => {
    const secret = 'preparation-private-token';
    const privatePath = '/Users/private/catalog-source';
    const intents: OperationIntent[] = [{
      kind: 'configSave',
      pluginId: 'official/demo',
      scope: 'user',
      apply: false,
      updates: { token: secret },
      sensitiveKeys: ['token'],
    }, {
      kind: 'sourceMutation',
      action: 'add',
      sourceId: 'private-source',
      source: {
        id: 'private-source',
        type: 'path',
        path: privatePath,
        primary: false,
        autoCheck: false,
      },
    }];

    for (const intent of intents) {
      const serializedSnapshots: string[] = [];
      const controller = new TuiController(dependencies({
        prepareReviewEvidence: async (_intent, _signal, onStage) => {
          for (const stage of ['validate', 'config', 'evidence'] as const) await onStage(stage);
          return baseEvidence;
        },
      }));
      await controller.load();
      controller.subscribe((snapshot) => {
        if (snapshot.reviewPreparation) serializedSnapshots.push(JSON.stringify(snapshot));
      });

      controller.startReviewPreparation(intent);
      await nextTurn(2);

      expect(serializedSnapshots.length).toBeGreaterThan(1);
      expect(serializedSnapshots.every((serialized) => !serialized.includes(secret)
        && !serialized.includes(privatePath))).toBe(true);
    }
  });

  it('replaces a preparation when the same intent has a different return route', async () => {
    const firstCapture = deferred<OperationEvidence>();
    const secondCapture = deferred<OperationEvidence>();
    const captureEvidence = vi.fn()
      .mockImplementationOnce(() => firstCapture.promise)
      .mockImplementationOnce(() => secondCapture.promise);
    const controller = new TuiController(dependencies({ captureEvidence }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const intent = {
      kind: 'pluginWrite' as const,
      action: 'reinstall' as const,
      pluginId: 'official/demo',
      platform: 'codex' as const,
      scope: 'user' as const,
    };

    const first = controller.startReviewPreparation(intent, { name: 'home' });
    await nextTurn();
    const second = controller.startReviewPreparation(intent, {
      name: 'pluginDetail', pluginId: 'official/demo',
    });
    await nextTurn();

    expect(second.id).not.toBe(first.id);
    expect(captureEvidence).toHaveBeenCalledTimes(2);
    expect(captureEvidence.mock.calls[0]?.[1]).toMatchObject({ aborted: true });
    firstCapture.resolve(baseEvidence);
    secondCapture.resolve(baseEvidence);
    await nextTurn();

    expect(controller.snapshot.router.current.route.name).toBe('review');
    controller.back();
    expect(controller.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/demo',
    });
  });

  it('keeps a safe preparation failure on the page and supports retry and Back', async () => {
    const validateIntent = vi.fn()
      .mockRejectedValueOnce(new Error('/private/user/token failed'))
      .mockResolvedValueOnce(undefined);
    const controller = new TuiController(dependencies({ validateIntent }));
    await controller.load();
    controller.push({ name: 'sourceDetail', sourceId: 'official' }, { focusIndex: 2 });
    const intent = { kind: 'sourceMutation' as const, action: 'setPrimary' as const, sourceId: 'official' };

    controller.startReviewPreparation(intent);
    await nextTurn();
    expect(controller.snapshot.router.current.route.name).toBe('reviewPreparing');
    expect(controller.snapshot.reviewPreparation).toMatchObject({
      state: 'failed',
      operationKind: 'sourceMutation',
      subject: 'official',
      code: 'reviewPreparationFailed',
      message: '无法准备确认信息。请返回检查选择，或重试。',
    });
    expect(JSON.stringify(controller.snapshot)).not.toContain('/private/user/token');

    controller.retryReviewPreparation();
    await nextTurn();
    expect(controller.snapshot.router.current.route.name).toBe('review');
    expect(validateIntent).toHaveBeenCalledTimes(2);
    controller.back();
    expect(controller.snapshot.router.current).toEqual({
      route: { name: 'sourceDetail', sourceId: 'official' },
      context: { focusIndex: 2 },
    });
  });

  it('keeps preparation failure state when storing the prepared review throws', async () => {
    const controller = new TuiController(dependencies({
      captureEvidence: vi.fn().mockResolvedValue(baseEvidence),
    }));
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });

    controller.startReviewPreparation({
      kind: 'pluginWriteTask', goal: 'restore', executionPolicy: 'all',
      targets: [{ pluginId: 'official/demo', platform: 'codex', scope: 'user' }],
    });
    await nextTurn();

    expect(controller.snapshot.router.current.route.name).toBe('reviewPreparing');
    expect(controller.snapshot.reviewPreparation).toMatchObject({
      state: 'failed',
      operationKind: 'pluginWriteTask',
      code: 'reviewPreparationFailed',
      message: '无法准备确认信息。请返回检查选择，或重试。',
    });
    expect(controller.snapshot.activeReview).toBeUndefined();
  });
});
