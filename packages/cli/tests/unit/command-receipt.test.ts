import { describe, expect, it } from 'vitest';
import { getCommandPackageId } from '@lesliechan721/aw-plugin-core/manifest';

import { createOperationPlan } from '../../src/commands/operation-plan.js';
import type { ReconcileOperationPlan } from '../../src/commands/reconcile-operation-plan.js';
import type { RebuildResult } from '../../src/commands/rebuild-operations.js';
import {
  buildInitReceiptJson,
  buildRebuildReceiptJson,
  requestedIntentAction,
  renderRebuildReceipt,
} from '../../src/output/command-receipt.js';
import type { CommandProducerResult, ReceiptTargetResult } from '../../src/types.js';
import type { CodexReconcilePlan } from '../../src/utils/codex-reconciler.js';

const target = {
  pluginName: 'demo',
  pluginId: 'team/demo',
  sourceId: 'team',
  platform: 'codex' as const,
  scope: 'user' as const,
};

function completedTarget(action = 'install'): ReceiptTargetResult {
  return { target, action, state: 'completed' };
}

function successfulRebuild(command: RebuildResult['command'] = 'install'): RebuildResult {
  return {
    status: 'succeeded',
    command,
    target: {
      ...target,
      sourceIdentity: `sha256:${'1'.repeat(64)}`,
      pluginVersion: '1.0.0',
      cwd: '/repo',
    },
    actions: [{ name: 'postcheck.inspect', status: 'succeeded' }],
    cleanupAttempted: command === 'cleanup' || command === 'reinstall',
    removed: [],
    absent: [],
    residual: [],
    quarantined: [],
    failures: [],
  };
}

function codexReusePlan(): CodexReconcilePlan {
  return {
    requirement: {
      scope: 'project', minimumVersion: '0.0.0',
    },
    desiredTargets: [{ pluginId: 'team/demo', scopes: ['project', 'user'] }],
    sharedNativeActions: [{
      pluginId: 'team/demo', codexPluginId: 'demo@aw', action: 'reuse',
      desiredVersion: '1.0.0', affectsOtherScopes: true,
    }],
    activationActions: { user: [], project: [] },
    extensionWrites: [],
    extensionRemovals: [],
    staleActivationRemovals: [],
    managedInventory: {
      before: [], desired: [], ownershipSuperset: [], converged: [],
      related: { before: [], desired: [], ownershipSuperset: [], converged: [] },
    },
    warnings: [],
    postcheck: { requirement: {
      scope: 'project', minimumVersion: '0.0.0',
    }, support: 'observed', plugins: [] },
    review: { requiresConfirmation: false, sharedImpact: { pluginIds: [] } },
  };
}

describe('command receipt v6', () => {
  it('reports a retained shared package and its exact remove command after platform cleanup', () => {
    const producer: CommandProducerResult['producer'] = { sourceId: 'team', sourceIdentity: `sha256:${'1'.repeat(64)}`, pluginName: 'demo',
      kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null };
    const packageId = getCommandPackageId(producer);
    const recovery = `aw command package remove ${packageId} --yes`;
    const retained: CommandProducerResult = {
      producer, state: 'completed', commandIds: ['installed-command'], removedCommandIds: [], errors: [], recoveryActions: [recovery],
    };
    const result = { platforms: ['codex' as const], plugins: ['team/demo'], warnings: [],
      targetResults: [completedTarget('cleanup')], commandResults: [retained] };
    expect(buildRebuildReceiptJson('cleanup', result)).toMatchObject({ receiptSchemaVersion: 6,
      overallState: 'succeeded', commandResults: [retained], recoveryActions: [recovery] });
    expect(Object.keys(buildRebuildReceiptJson('cleanup', result).commandResults![0]!).sort())
      .toEqual(['producer', 'state', 'commandIds', 'removedCommandIds', 'errors', 'recoveryActions'].sort());
    const rendered = renderRebuildReceipt('cleanup', result).join('\n');
    expect(rendered).toContain(`保留命令包 ${packageId}；所有项目共用`);
    expect(rendered).toContain(recovery);
  });
  it('includes command producer failure in the receipt without creating a platform target', () => {
    const commandResult: CommandProducerResult = {
      producer: { sourceId: 'team', sourceIdentity: `sha256:${'1'.repeat(64)}`, pluginName: 'demo',
        kind: 'package', key: 'tools', platform: null, scope: 'user', projectRoot: null },
      state: 'failed', commandIds: [], removedCommandIds: [],
      errors: [{ code: 'commandBindingInvalid', message: 'The command binding could not be published.' }],
      recoveryActions: ['aw command package sync team/demo tools --scope user --yes'],
    };
    const result = { platforms: [], plugins: ['team/demo'], warnings: [],
      overallState: 'succeeded' as const, targetResults: [], commandResults: [commandResult, commandResult] };
    const receipt = buildRebuildReceiptJson('sync', result);
    expect(receipt).toMatchObject({ receiptSchemaVersion: 6, ok: false,
      overallState: 'failed', targetResults: [], commandResults: [commandResult],
      recoveryActions: commandResult.recoveryActions, errors: [],
    });
    expect(buildRebuildReceiptJson('sync', { ...result, targetResults: [completedTarget('sync')] }))
      .toMatchObject({ ok: false, overallState: 'partial' });
    expect(renderRebuildReceipt('sync', result).join('\n')).toContain('commandBindingInvalid');
  });
  it('reports cleanup as removing requested Intent', () => {
    expect(requestedIntentAction('cleanup')).toBe('remove');
  });

  it('uses one layer-free receipt schema for the five lifecycle write commands', () => {
    for (const command of ['install', 'reinstall', 'uninstall', 'cleanup', 'sync'] as const) {
      const receipt = buildRebuildReceiptJson(command, {
        platforms: ['codex'],
        plugins: ['team/demo'],
        warnings: [],
        overallState: 'succeeded',
        targetResults: [completedTarget(command)],
        rebuildResults: [successfulRebuild(command)],
      });

      expect(receipt).toMatchObject({
        ok: true,
        command,
        receiptSchemaVersion: 6,
        overallState: 'succeeded',
        changes: [command],
        targetResults: [{
          target: expect.objectContaining({
            pluginId: 'team/demo', platform: 'codex', scope: 'user',
          }),
          action: command,
          state: 'completed',
          relation: 'requested',
          requiredBy: [],
          recoveryActions: [],
        }],
      });
      expect(receipt).not.toHaveProperty('layers');
      expect(receipt).not.toHaveProperty('targets');
    }
  });

  it('projects plan changes, fingerprint, and dependency relation into target results', () => {
    const dependencyPlan: ReconcileOperationPlan = {
      requestedPluginIds: ['team/root'],
      resolvedPluginIds: ['team/leaf', 'team/root'],
      dependencyEdges: [{ from: 'team/root', to: 'team/leaf', platform: 'codex' }],
      scopeOverrides: [],
      targets: [{
        pluginId: 'team/leaf', pluginName: 'leaf', platform: 'codex',
        resolvedScope: 'user', relation: 'dependency', requiredBy: ['team/root'], state: 'absent',
        action: 'install', order: 0, depth: 1, rootScope: 'project', minimumScope: 'project',
        allowedScopes: ['project', 'user'], assignmentSource: 'default',
        locked: false, affectsOtherProjects: true,
      }],
    };
    const operationPlan = createOperationPlan({
      intentChanges: [],
      actions: [{
        kind: 'ensureNativeRegistration', pluginId: 'team/leaf', platform: 'codex',
        scope: 'user', registration: 'leaf@aw-team',
      }],
      changes: ['team/leaf:codex:user:install'],
      warnings: [],
      evidence: {
        catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [],
      },
    });
    const leafTarget = {
      pluginName: 'leaf', pluginId: 'team/leaf', sourceId: 'team',
      platform: 'codex' as const, scope: 'user' as const,
    };
    const receipt = buildRebuildReceiptJson('install', {
      platforms: ['codex'], plugins: ['team/leaf'], warnings: [], overallState: 'succeeded',
      dependencyPlan,
      operationPlan,
      targetResults: [{ target: leafTarget, action: 'install', state: 'completed' }],
      rebuildResults: [{
        ...successfulRebuild(),
        target: {
          ...leafTarget, sourceIdentity: `sha256:${'2'.repeat(64)}`,
          pluginVersion: '1.0.0', cwd: '/repo',
        },
      }],
    });

    expect(receipt).toMatchObject({
      receiptSchemaVersion: 6,
      requestedPluginIds: ['team/root'],
      resolvedPluginIds: ['team/leaf', 'team/root'],
      dependencyEdges: [{ from: 'team/root', to: 'team/leaf', platform: 'codex' }],
      changes: ['team/leaf:codex:user:install'],
      planFingerprint: operationPlan.planFingerprint,
      targetResults: [{
        relation: 'dependency',
        requiredBy: ['team/root'],
        changes: ['team/leaf:codex:user:install'],
      }],
    });
  });

  it('projects an exact shared-native reuse result into the matching Codex target', () => {
    const projectTarget = { ...target, scope: 'project' as const };
    const receipt = buildRebuildReceiptJson('install', {
      platforms: ['codex'], plugins: ['team/demo'], warnings: [], overallState: 'succeeded',
      targetResults: [{ target: projectTarget, action: 'install', state: 'completed' }],
      rebuildResults: [{ ...successfulRebuild(), target: {
        ...successfulRebuild().target, scope: 'project',
      } }],
      codexReconcilePlans: [codexReusePlan()],
    });

    expect(receipt.targetResults[0]).toMatchObject({
      target: { pluginId: 'team/demo', platform: 'codex', scope: 'project' },
      sharedNative: { codexPluginId: 'demo@aw', action: 'reuse' },
    });
    expect(renderRebuildReceipt('install', {
      platforms: ['codex'], plugins: ['team/demo'], warnings: [], overallState: 'succeeded',
      targetResults: [{ target: projectTarget, action: 'install', state: 'completed' }],
      codexReconcilePlans: [codexReusePlan()],
    }).join('\n')).toContain('shared native demo@aw: reuse');
  });

  it.each([
    {
      name: 'all completed or kept targets',
      targetResults: [completedTarget('install'), {
        ...completedTarget('keep'),
        target: { ...target, pluginName: 'leaf', pluginId: 'team/leaf' },
      }],
      expected: 'succeeded',
    },
    {
      name: 'completed and failed independent requested targets',
      targetResults: [completedTarget('install'), {
        ...completedTarget('install'),
        target: { ...target, pluginName: 'root', pluginId: 'team/root' },
        state: 'failed' as const,
        message: 'dependencyInstallFailed: leaf failed',
      }],
      expected: 'partial',
    },
    {
      name: 'all failed targets',
      targetResults: [{
        ...completedTarget('install'), state: 'failed' as const, message: 'writeFailed: failed',
      }],
      expected: 'failed',
    },
  ])('derives $expected for $name from core target results', ({ targetResults, expected }) => {
    const receipt = buildRebuildReceiptJson('install', {
      platforms: ['codex'], plugins: [], warnings: [], overallState: 'failed', targetResults,
    });

    expect(receipt.overallState).toBe(expected);
    expect(receipt.ok).toBe(expected === 'succeeded');
  });

  it('reports failed when a completed dependency is followed by a failed requested root', () => {
    const dependencyPlan: ReconcileOperationPlan = {
      requestedPluginIds: ['team/root'],
      resolvedPluginIds: ['team/leaf', 'team/root'],
      dependencyEdges: [{ from: 'team/root', to: 'team/leaf', platform: 'codex' }],
      scopeOverrides: [],
      targets: [
        {
          pluginId: 'team/leaf', pluginName: 'leaf', platform: 'codex',
          resolvedScope: 'user', relation: 'dependency', requiredBy: ['team/root'], state: 'absent',
          action: 'install', order: 0, depth: 1, rootScope: 'user', minimumScope: 'user',
          allowedScopes: ['user'], assignmentSource: 'default', locked: false, affectsOtherProjects: false,
        },
        {
          pluginId: 'team/root', pluginName: 'root', platform: 'codex',
          resolvedScope: 'user', relation: 'requested', requiredBy: [], state: 'absent',
          action: 'install', order: 1, depth: 0, rootScope: 'user', minimumScope: 'user',
          allowedScopes: ['user'], assignmentSource: 'default', locked: false, affectsOtherProjects: false,
        },
      ],
    };
    const receipt = buildRebuildReceiptJson('install', {
      platforms: ['codex'], plugins: ['team/root'], warnings: [], overallState: 'failed', dependencyPlan,
      targetResults: [
        {
          target: { ...target, pluginName: 'leaf', pluginId: 'team/leaf' },
          action: 'install', state: 'completed',
        },
        {
          target: { ...target, pluginName: 'root', pluginId: 'team/root' },
          action: 'install', state: 'failed', message: 'writeFailed: root failed',
        },
      ],
    });

    expect(receipt).toMatchObject({
      ok: false,
      overallState: 'failed',
      targetResults: [
        { target: { pluginId: 'team/leaf' }, relation: 'dependency', state: 'completed' },
        { target: { pluginId: 'team/root' }, relation: 'requested', state: 'failed' },
      ],
    });
  });

  it('keeps dependency relation for a failed cleanup of the previous migration scope', () => {
    const dependencyPlan: ReconcileOperationPlan = {
      requestedPluginIds: ['team/root'],
      resolvedPluginIds: ['team/leaf', 'team/root'],
      dependencyEdges: [{ from: 'team/root', to: 'team/leaf', platform: 'codex' }],
      scopeOverrides: [],
      targets: [
        {
          pluginId: 'team/leaf', pluginName: 'leaf', platform: 'codex',
          resolvedScope: 'user', relation: 'dependency', requiredBy: ['team/root'], state: 'absent',
          action: 'move', order: 0, depth: 1, rootScope: 'user', minimumScope: 'user',
          allowedScopes: ['project', 'user'], assignmentSource: 'consumerPromotion',
          locked: false, affectsOtherProjects: true,
        },
        {
          pluginId: 'team/root', pluginName: 'root', platform: 'codex',
          resolvedScope: 'user', relation: 'requested', requiredBy: [], state: 'absent',
          action: 'install', order: 1, depth: 0, rootScope: 'user', minimumScope: 'user',
          allowedScopes: ['project', 'user'], assignmentSource: 'root',
          locked: true, lockReason: 'requestedRootScope', affectsOtherProjects: true,
        },
      ],
    };
    const receipt = buildRebuildReceiptJson('install', {
      platforms: ['codex'], plugins: ['team/root'], warnings: [], overallState: 'partial',
      dependencyPlan,
      targetResults: [
        {
          target: { ...target, pluginName: 'root', pluginId: 'team/root' },
          action: 'install', state: 'completed',
        },
        {
          target: {
            ...target, pluginName: 'leaf', pluginId: 'team/leaf', scope: 'project',
          },
          action: 'cleanup', state: 'failed', message: 'cleanupFailed: old scope',
          relation: 'dependency', requiredBy: ['team/root'],
        },
      ],
    });

    expect(receipt).toMatchObject({
      ok: false,
      overallState: 'partial',
      targetResults: expect.arrayContaining([expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'project' }),
        action: 'cleanup', state: 'failed', relation: 'dependency', requiredBy: ['team/root'],
      })]),
    });
  });

  it('keeps early failure recovery without inventing a plan fingerprint or changes', () => {
    const errorCode = 'codexSystemCliUnsupported';
    const receipt = buildRebuildReceiptJson('install', {
      platforms: ['codex'], plugins: ['team/demo'], warnings: [], overallState: 'failed',
      errors: [{ code: errorCode, message: `${errorCode}: consumer probe failed` }],
      receiptTargets: [{ ...target, scope: 'project' }],
    });

    const recovery = [
      'upgrade or repair the official system Codex CLI, then retry the original operation',
    ];
    expect(receipt).toMatchObject({
      ok: false,
      overallState: 'failed',
      changes: [],
      recoveryActions: recovery,
      targetResults: [{
        target: expect.objectContaining({ pluginId: 'team/demo', scope: 'project' }),
        state: 'failed',
        message: `${errorCode}: consumer probe failed`,
        errorCode,
        changes: [],
        recoveryActions: recovery,
      }],
    });
    expect(receipt).not.toHaveProperty('planFingerprint');
  });

  it('keeps a stable target failure when preApply blocks materialization', () => {
    const message = 'preApply failed with exit code 1. stderr: setup failed';
    const rebuild: RebuildResult = {
      status: 'failed',
      command: 'install',
      target: {
        ...target,
        sourceIdentity: `sha256:${'1'.repeat(64)}`,
        pluginVersion: '1.0.0',
        cwd: '/repo',
      },
      actions: [{ name: 'preApply', status: 'failed' }],
      cleanupAttempted: false,
      removed: [],
      absent: [],
      residual: [],
      quarantined: [],
      failures: [{ phase: 'preApply', message }],
      error: { phase: 'preApply', message },
    };
    const result = {
      platforms: ['codex'], plugins: [], warnings: [],
      overallState: 'failed' as const,
      targetResults: [{
        target,
        action: 'install',
        state: 'failed' as const,
        message,
        errorCode: 'preApplyFailed',
      }],
      rebuildResults: [rebuild],
    };
    const receipt = buildRebuildReceiptJson('install', result);

    expect(receipt).toMatchObject({
      ok: false,
      overallState: 'failed',
      warnings: [],
      targetResults: [{
        state: 'failed',
        errorCode: 'preApplyFailed',
        cleanupAttempted: false,
        actions: [{ name: 'preApply', status: 'failed' }],
        failures: [{ phase: 'preApply', message }],
      }],
    });
    expect(renderRebuildReceipt('install', result).join('\n')).toContain(message);
  });

  it('renders the three-state summary, warnings, recovery, and target results without layers', () => {
    const warning = 'dependencyNotice: a completed dependency needs attention';
    const result = {
      platforms: ['codex', 'claude'], plugins: ['team/leaf'], warnings: [warning],
      overallState: 'failed' as const,
      targetResults: [completedTarget('keep'), {
        target: {
          pluginName: 'root', pluginId: 'team/root', sourceId: 'team',
          platform: 'claude' as const, scope: 'project' as const,
        },
        action: 'skipped',
        state: 'failed' as const,
        message: 'dependencyInstallFailed: leaf failed',
      }],
    };
    const human = renderRebuildReceipt('sync', result).join('\n');

    expect(human).toContain('sync 部分完成：2 个目标。');
    expect(human).toContain(`警告：${warning}`);
    expect(human).toContain('- team/root / claude / project: failed');
    expect(human).toContain('恢复：run sync');
    expect(human).not.toContain('Project intent');
    expect(human).not.toContain('AW extensions');
  });

  it('keeps the independent Catalog readiness receipt schema unchanged', () => {
    expect(buildInitReceiptJson({
      ok: true,
      primarySourceId: 'official',
      configDigest: 'sha256:config',
      compositeDigest: 'sha256:composite',
      recovery: [],
      sources: [{
        id: 'official',
        ok: true,
        activeReady: true,
        requestedRef: 'refs/heads/catalog/latest',
        resolvedCommit: 'abc',
        catalogVersion: '1.0.0',
        channel: 'latest',
      }],
    })).toMatchObject({
      command: 'init', receiptSchemaVersion: 6, receiptKind: 'catalogReadiness', ok: true,
    });
  });
});
