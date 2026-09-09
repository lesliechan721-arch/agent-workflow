import { describe, expect, it, vi } from 'vitest';

import { createOperationPlan } from '../../src/commands/operation-plan.js';
import type { StatusV8Payload, StatusV8PluginSummary } from '../../src/commands/status-v6.js';
import {
  operationEvidenceFingerprint,
  TuiController,
  type OperationEvidence,
  type PluginWriteTaskEvidence,
  type PluginWriteTaskExecutionResult,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import type {
  PluginListItemViewModel,
  TuiViewModel,
  UserIssueViewModel,
} from '../../src/tui/model.js';
import {
  buildPluginWriteTaskCandidates,
  buildPluginWriteTaskDraft,
  evaluatePluginWriteTaskRestoreVersion,
  pluginWriteTaskVersionEvidence,
} from '../../src/tui/plugin-write-task.js';

function plugin(
  pluginName: string,
  installedVersion = '1.0.0',
  activeVersion = '1.0.0',
): PluginListItemViewModel {
  return {
    pluginId: `official/${pluginName}`,
    sourceId: 'official',
    displayName: pluginName,
    update: {
      pluginId: `official/${pluginName}`,
      state: 'currentAgainstCatalog',
      sourceIdentity: 'identity:official',
      generationKey: 'official/active',
      targets: [{
        platform: 'codex', scope: 'project',
        ...(installedVersion ? { installedVersion } : {}),
        activeVersion, eligibility: 'allowed',
      }],
    },
  } as PluginListItemViewModel;
}

function sharedMissingDependencyIssue(): UserIssueViewModel {
  return {
    issueId: 'dependency:official/shared:codex:project',
    category: 'dependencyMissing', group: 'dependency',
    title: '缺少共享依赖', explanation: '缺少共享依赖。', impact: [],
    entity: { kind: 'plugin', id: 'official/root-a' },
    pluginId: 'official/root-a',
    dependencyPluginId: 'official/shared', dependencyPlatform: 'codex',
    dependencyScope: 'project', sourceId: 'official', sourceIdentity: 'identity:official',
    rootEntity: { pluginId: 'official/shared', platform: 'codex', scope: 'project' },
    affectedTargets: [
      { pluginId: 'official/root-a', platform: 'codex', scope: 'project', relationship: 'consumer' },
      { pluginId: 'official/root-b', platform: 'codex', scope: 'project', relationship: 'consumer' },
    ],
    actions: [{
      id: 'installDependency', label: '补齐依赖插件', pluginId: 'official/shared',
      platform: 'codex', scope: 'project', writeAction: 'install',
    }],
    technicalDetails: [],
    diagnostic: { severity: 'error', code: 'dependencyMissing', message: '缺少共享依赖。' },
  } as UserIssueViewModel;
}

describe('plugin write task planning', () => {
  it('keeps the same candidate binding across activation and detects changed source content', () => {
    const candidatePlugin = plugin('demo');
    candidatePlugin.update = {
      pluginId: candidatePlugin.pluginId,
      state: 'available',
      sourceIdentity: 'identity:official',
      generationKey: 'old/active',
      targets: [{
        platform: 'codex', scope: 'project', installedVersion: '1.0.0',
        activeVersion: '1.0.0', candidateVersion: '2.0.0', availableVersion: '2.0.0',
        candidateEvidence: 'logical/snapshot-a',
        eligibility: 'allowed', requiresCatalogActivation: true,
      }],
    };
    const before = buildPluginWriteTaskCandidates({ plugins: [candidatePlugin], issues: [] }, 'update');
    const beforeEvidence = pluginWriteTaskVersionEvidence(candidatePlugin, before);

    const activatedPlugin = structuredClone(candidatePlugin);
    activatedPlugin.update.generationKey = 'logical/snapshot-a';
    Object.assign(activatedPlugin.update.targets[0]!, {
      activeVersion: '2.0.0', availableVersion: '2.0.0',
    });
    delete activatedPlugin.update.targets[0]!.candidateVersion;
    delete activatedPlugin.update.targets[0]!.candidateEvidence;
    delete activatedPlugin.update.targets[0]!.requiresCatalogActivation;
    const after = buildPluginWriteTaskCandidates({ plugins: [activatedPlugin], issues: [] }, 'update');
    expect(pluginWriteTaskVersionEvidence(activatedPlugin, after)).toEqual(beforeEvidence);

    activatedPlugin.update.generationKey = 'logical/snapshot-b';
    expect(pluginWriteTaskVersionEvidence(activatedPlugin, after)).not.toEqual(beforeEvidence);
    activatedPlugin.update.generationKey = 'logical/snapshot-a';
    activatedPlugin.update.sourceIdentity = 'identity:changed';
    expect(pluginWriteTaskVersionEvidence(activatedPlugin, after)).not.toEqual(beforeEvidence);
  });

  it('blocks an absent target when another scope has an older installed version', () => {
    const shared = plugin('shared', '');
    shared.update.targets.push({
      platform: 'codex', scope: 'user', installedVersion: '0.9.0',
      activeVersion: '1.0.0', eligibility: 'allowed',
    });

    expect(evaluatePluginWriteTaskRestoreVersion({
      pluginId: 'official/shared', platform: 'codex', scope: 'project',
    }, true, { plugins: [shared] })).toEqual({ blockReason: 'restoreVersionChanged' });
  });

  it('requires a placement decision when another scope has the same installed version', () => {
    const shared = plugin('shared', '');
    shared.update.targets.push({
      platform: 'codex', scope: 'user', installedVersion: '1.0.0',
      activeVersion: '1.0.0', eligibility: 'allowed',
    });

    expect(evaluatePluginWriteTaskRestoreVersion({
      pluginId: 'official/shared', platform: 'codex', scope: 'project',
    }, true, { plugins: [shared] })).toEqual({ blockReason: 'manualRecoveryRequired' });
  });

  it('preserves an installed target even when another scope has different evidence', () => {
    const shared = plugin('shared');
    shared.update.targets.push({
      platform: 'codex', scope: 'user', installedVersion: '0.9.0',
      activeVersion: '1.0.0', eligibility: 'allowed',
    });

    expect(evaluatePluginWriteTaskRestoreVersion({
      pluginId: 'official/shared', platform: 'codex', scope: 'project',
    }, true, { plugins: [shared] })).toEqual({
      evidence: { state: 'preserved', installedVersion: '1.0.0', activeVersion: '1.0.0' },
    });
  });

  it('leaves a cross-scope activation repair to its exact issue action instead of syncing an undesired project', () => {
    const demo = plugin('demo');
    demo.update.targets.push({
      platform: 'codex', scope: 'user', installedVersion: '1.0.0',
      activeVersion: '1.0.0', eligibility: 'allowed',
    });
    const model: Pick<TuiViewModel, 'plugins' | 'issues'> = {
      plugins: [demo],
      issues: [{
        ...sharedMissingDependencyIssue(),
        category: 'incompleteInstallation', pluginId: 'official/demo',
        dependencyPluginId: undefined, dependencyPlatform: undefined, dependencyScope: undefined,
        rootEntity: { pluginId: 'official/demo', platform: 'codex', scope: 'project' },
        affectedTargets: [{ pluginId: 'official/demo', platform: 'codex', scope: 'project', relationship: 'direct' }],
        actions: [{ id: 'sync', label: '恢复在当前项目使用', writeAction: 'sync',
          pluginId: 'official/demo', platform: 'codex', scope: 'user' }],
      }],
    };
    const candidates = buildPluginWriteTaskCandidates(model, 'restore');
    const draft = buildPluginWriteTaskDraft({
      kind: 'pluginWriteTask', goal: 'restore', executionPolicy: 'all',
      targets: candidates.map((candidate) => candidate.target),
    }, model, candidates);
    expect(draft.executableTargets).toEqual([]);
    expect(draft.blockedTargets).toEqual([expect.objectContaining({ reason: 'manualRecoveryRequired' })]);
    expect(draft.causes).toEqual([]);
  });

  it('deduplicates one missing dependency cause across installed root consumers', () => {
    const model: Pick<TuiViewModel, 'plugins' | 'issues'> = {
      plugins: [plugin('root-a'), plugin('root-b'), plugin('shared', '')],
      issues: [sharedMissingDependencyIssue()],
    };
    const candidates = buildPluginWriteTaskCandidates(model, 'restore');

    expect(candidates).toMatchObject([
      { target: { pluginId: 'official/root-a' }, eligible: true, recommendedMethod: 'sync' },
      { target: { pluginId: 'official/root-b' }, eligible: true, recommendedMethod: 'sync' },
    ]);
    const draft = buildPluginWriteTaskDraft({
      kind: 'pluginWriteTask', goal: 'restore', executionPolicy: 'all',
      targets: candidates.map((candidate) => candidate.target),
    }, model, candidates);

    expect(draft.blockedTargets).toEqual([]);
    expect(draft.causes).toEqual([expect.objectContaining({
      repairTarget: { pluginId: 'official/shared', platform: 'codex', scope: 'project' },
      method: 'sync',
      restoreVersionEvidence: { state: 'absent', activeVersion: '1.0.0' },
      consumers: [
        { pluginId: 'official/root-a', platform: 'codex', scope: 'project' },
        { pluginId: 'official/root-b', platform: 'codex', scope: 'project' },
      ],
    })]);
  });

  it('blocks restore when the installed root version cannot be verified', () => {
    const model: Pick<TuiViewModel, 'plugins' | 'issues'> = {
      plugins: [plugin('root-a', '')],
      issues: [{
        ...sharedMissingDependencyIssue(),
        affectedTargets: [{
          pluginId: 'official/root-a', platform: 'codex', scope: 'project',
          relationship: 'consumer',
        }],
      }],
    };

    expect(buildPluginWriteTaskCandidates(model, 'restore')).toMatchObject([{
      target: { pluginId: 'official/root-a', platform: 'codex', scope: 'project' },
      eligible: false,
      blockReason: 'restoreVersionUnverified',
    }]);
  });

  it('blocks a damaged dependency when restore would change its installed version', () => {
    const model: Pick<TuiViewModel, 'plugins' | 'issues'> = {
      plugins: [plugin('root-a'), plugin('shared', '1.0.0', '2.0.0')],
      issues: [{
        ...sharedMissingDependencyIssue(),
        category: 'dependencyNotReady',
        affectedTargets: [{
          pluginId: 'official/root-a', platform: 'codex', scope: 'project',
          relationship: 'consumer',
        }],
        actions: [{
          id: 'reinstallDependency', label: '重新安装依赖', pluginId: 'official/shared',
          platform: 'codex', scope: 'project', writeAction: 'reinstall',
        }],
      }],
    };

    expect(buildPluginWriteTaskCandidates(model, 'restore')).toMatchObject([{
      target: { pluginId: 'official/root-a', platform: 'codex', scope: 'project' },
      eligible: false,
      blockReason: 'restoreVersionChanged',
    }]);
  });
});

function loaded(): TuiStatusLoadResult {
  const payload: StatusV8Payload = {
    schemaVersion: 8,
    catalog: {
      primarySourceId: 'official', configDigest: 'sha256:config',
      compositeDigest: 'sha256:composite',
      sources: [{
        id: 'official', identity: 'identity:official', type: 'path', primary: true,
        requestedRef: 'path', freshness: 'active', catalogVersion: '1.0.0',
      }],
    },
    filters: { plugins: [], platform: 'both', cwd: '/workspace' },
    targets: [], errors: [],
  };
  const summary: StatusV8PluginSummary = {
    pluginName: 'demo', pluginId: 'official/demo', description: 'Demo',
  };
  return { payload, pluginSummaries: [summary] };
}

describe('plugin write task source activation handoff', () => {
  it('returns a completed catalog activation to the original task route', async () => {
    const candidate = {
      sourceId: 'official', sourceConfigFingerprint: 'sha256:source',
      sourceIdentity: 'identity:official', logicalIdentity: 'workspace:official',
      requestedRef: 'path', resolvedCommit: 'path', catalogVersion: '2.0.0',
      channel: 'latest' as const, manifestDigest: `sha256:${'1'.repeat(64)}`,
      snapshotDigest: `sha256:${'2'.repeat(64)}`,
    };
    const evidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:config', compositeDigest: candidate.snapshotDigest },
      catalogGeneration: {
        action: 'update', candidate, activationMode: 'normal', configDigest: 'sha256:config',
      },
    };
    const dependencies: TuiControllerDependencies = {
      loadStatus: vi.fn().mockResolvedValue(loaded()),
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      executeIntent: vi.fn().mockResolvedValue({ status: 'succeeded' }),
      createToken: vi.fn().mockReturnValueOnce('operation-1').mockReturnValueOnce('review-1'),
      now: () => 1_000,
    };
    const controller = new TuiController(dependencies);
    const taskRoute = {
      name: 'pluginWriteTask' as const, pluginId: 'official/demo', goal: 'update' as const,
      targetKeys: ['official/demo\0codex\0user'],
      versionEvidence: { 'official/demo\0codex\0user': '2.0.0' },
    };
    await controller.load();
    controller.push(taskRoute);

    const review = await controller.buildOperationReview({
      kind: 'catalogGeneration', action: 'update', sourceId: 'official',
    }, taskRoute);
    await expect(controller.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'succeeded', returnRoute: taskRoute,
    });

    controller.leaveResult();
    expect(controller.snapshot.router.current.route).toEqual(taskRoute);
    controller.dispose();
  });
});

describe('plugin write task result', () => {
  it('reports an executable-subset success as partial while blocked roots remain', async () => {
    const executable = {
      pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
    };
    const blocked = {
      pluginId: 'official/demo', platform: 'claude' as const, scope: 'project' as const,
    };
    const cause = {
      causeKey: 'restore\0official/demo\0codex\0user', issueId: 'restore:demo',
      sourceId: 'official', sourceIdentity: 'identity:official', repairTarget: executable,
      method: 'sync' as const, consumers: [executable],
    };
    const receiptTarget = {
      pluginName: 'demo', ...executable, sourceId: 'official',
    };
    const sourceResult = {
      platforms: ['codex'], plugins: ['demo'], warnings: [], rebuildResults: [],
      targetResults: [{ target: receiptTarget, action: 'sync', state: 'completed' as const }],
      overallState: 'succeeded' as const, receiptTargets: [receiptTarget],
      operationPlan: createOperationPlan({
        intentChanges: [], actions: [], changes: ['official/demo:codex:user'], warnings: [],
        evidence: {
          catalogDigests: [{ sourceId: 'official', digest: 'sha256:catalog' }],
          intentDigests: [], configDigests: [], targetOwnerFingerprints: [],
        },
      }),
    };
    const intent = {
      kind: 'pluginWriteTask' as const, goal: 'restore' as const,
      targets: [blocked, executable].sort((left, right) =>
        [left.pluginId, left.platform, left.scope].join('\0')
          .localeCompare([right.pluginId, right.platform, right.scope].join('\0'), 'en')),
      executionPolicy: 'executableSubset' as const,
    };
    const evidence: PluginWriteTaskEvidence = {
      catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
      taskPlan: {
        goal: 'restore', requestedTargets: intent.targets, executableTargets: [executable],
        causes: [cause],
        blockedTargets: [{ target: blocked, reason: 'manualRecoveryRequired', issueIds: ['manual'] }],
        sources: [{
          sourceId: 'official', sourceIdentity: 'identity:official', requestedTargets: [executable],
          causes: [cause], preview: sourceResult, executable: true,
        }],
        targetFingerprint: 'sha256:targets', planFingerprint: '',
      },
    };
    evidence.taskPlan.planFingerprint = operationEvidenceFingerprint(evidence);
    const execution: PluginWriteTaskExecutionResult = {
      ...sourceResult,
      taskPlan: evidence.taskPlan,
      sourceResults: [{
        sourceId: 'official', sourceIdentity: 'identity:official',
        requestedTargets: [executable], result: sourceResult,
      }],
    };
    const controller = new TuiController({
      loadStatus: vi.fn().mockResolvedValue(loaded()),
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      executeIntent: vi.fn().mockResolvedValue(execution),
      createToken: vi.fn().mockReturnValueOnce('operation-1').mockReturnValueOnce('review-1'),
      now: () => 1_000,
    });
    await controller.load();

    const review = await controller.buildOperationReview(intent);
    const result = await controller.executeOperation(review.reviewToken);
    expect(result).toMatchObject({
      state: 'partial',
      summary: {
        code: 'operationPartial',
        task: {
          blockedTargets: [{ target: blocked, reason: 'manualRecoveryRequired' }],
          rootResults: [
            expect.objectContaining({
              pluginId: 'official/demo', state: 'partial',
              targets: expect.arrayContaining([
                expect.objectContaining({
                  platform: 'claude', scope: 'project', state: 'skipped',
                }),
                expect.objectContaining({
                  platform: 'codex', scope: 'user', state: 'completed',
                }),
              ]),
            }),
          ],
        },
      },
    });
    expect(result.state === 'partial' ? result.summary.task : undefined)
      .not.toHaveProperty('retryTargets');
    expect(controller.retryFailedPluginWriteTask()).toBeUndefined();
    controller.dispose();
  });

  it('aggregates successful and failed exact placements into one plugin root', async () => {
    const userTarget = {
      pluginId: 'official/demo', platform: 'codex' as const, scope: 'user' as const,
    };
    const projectTarget = {
      pluginId: 'official/demo', platform: 'claude' as const, scope: 'project' as const,
    };
    const requestedTargets = [projectTarget, userTarget];
    const causes = requestedTargets.map((target) => ({
      causeKey: `restore\0${target.platform}\0${target.scope}`,
      issueId: `restore:${target.platform}:${target.scope}`,
      sourceId: 'official', sourceIdentity: 'identity:official', repairTarget: target,
      method: 'sync' as const, consumers: [target],
    }));
    const receiptTargets = requestedTargets.map((target) => ({
      pluginName: 'demo', sourceId: 'official', ...target,
    }));
    const sourceResult = {
      platforms: ['claude', 'codex'], plugins: ['demo'], warnings: [], rebuildResults: [],
      targetResults: [
        { target: receiptTargets[0]!, action: 'sync', state: 'failed' as const,
          relation: 'requested' as const, errorCode: 'writeFailed' },
        { target: receiptTargets[1]!, action: 'sync', state: 'completed' as const,
          relation: 'requested' as const },
      ],
      overallState: 'partial' as const, receiptTargets,
      operationPlan: createOperationPlan({
        intentChanges: [], actions: [], changes: ['two placements'], warnings: [],
        evidence: {
          catalogDigests: [{ sourceId: 'official', digest: 'sha256:catalog' }],
          intentDigests: [], configDigests: [], targetOwnerFingerprints: [],
        },
      }),
    };
    const intent = {
      kind: 'pluginWriteTask' as const, goal: 'restore' as const,
      targets: requestedTargets, executionPolicy: 'all' as const,
    };
    const evidence: PluginWriteTaskEvidence = {
      catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
      taskPlan: {
        goal: 'restore', requestedTargets, executableTargets: requestedTargets,
        causes, blockedTargets: [],
        sources: [{
          sourceId: 'official', sourceIdentity: 'identity:official', requestedTargets,
          causes, preview: sourceResult, executable: true,
        }],
        targetFingerprint: 'sha256:targets', planFingerprint: '',
      },
    };
    evidence.taskPlan.planFingerprint = operationEvidenceFingerprint(evidence);
    const execution: PluginWriteTaskExecutionResult = {
      ...sourceResult,
      taskPlan: evidence.taskPlan,
      sourceResults: [{
        sourceId: 'official', sourceIdentity: 'identity:official',
        requestedTargets, result: sourceResult,
      }],
    };
    const controller = new TuiController({
      loadStatus: vi.fn().mockResolvedValue(loaded()),
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      executeIntent: vi.fn().mockResolvedValue(execution),
      createToken: vi.fn().mockReturnValueOnce('operation-1').mockReturnValueOnce('review-1'),
      now: () => 1_000,
    });
    await controller.load();

    const review = await controller.buildOperationReview(intent);
    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({
      state: 'partial',
      summary: {
        code: 'operationPartial',
        task: {
          retryTargets: [projectTarget],
          rootResults: [{
            pluginId: 'official/demo', state: 'partial',
            targets: expect.arrayContaining([
              expect.objectContaining({ platform: 'claude', scope: 'project', state: 'failed' }),
              expect.objectContaining({ platform: 'codex', scope: 'user', state: 'completed' }),
            ]),
          }],
        },
      },
    });
    controller.dispose();
  });
});
