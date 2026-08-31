import { describe, expect, it } from 'vitest';

import {
  buildInitReceiptJson,
  buildRebuildReceiptJson,
  renderRebuildReceipt,
} from '../../src/output/command-receipt.js';
import { createDependencyOperationPlan } from '../../src/commands/dependency-operation-plan.js';
import type { CodexReconcilePlan } from '../../src/utils/codex-reconciler.js';

describe('command receipt v5', () => {
  it('serializes the five write commands with one receipt schema', () => {
    for (const command of ['install', 'upgrade', 'reinstall', 'uninstall', 'cleanup'] as const) {
      const requestedAction = command === 'install' ? 'add'
        : command === 'uninstall' ? 'remove' : 'keep';
      const receipt = buildRebuildReceiptJson(command, {
        platforms: ['codex'],
        plugins: ['git-commit'],
        warnings: [],
        overallState: 'succeeded',
        rebuildResults: [{
          status: 'succeeded',
          command,
          target: {
            pluginName: 'git-commit',
            pluginVersion: '1.0.0',
            platform: 'codex',
            scope: 'user',
            cwd: '/repo',
          },
          actions: [{ name: 'postcheck.inspect', status: 'succeeded' }],
          cleanupAttempted: command === 'cleanup' || command === 'reinstall',
          removed: [],
          absent: [],
          residual: [],
          quarantined: [],
          failures: [],
        }],
      });
      expect(receipt).toMatchObject({
        ok: true,
        command,
        receiptSchemaVersion: 5,
        layers: {
          userIntent: [expect.objectContaining({
            pluginId: 'git-commit',
            relation: 'requested',
            action: requestedAction,
          })],
        },
        targets: [{ pluginName: 'git-commit', status: 'succeeded' }],
      });
    }
  });

  it('maps no-plan requested intent into the six receipt layers without changing actual targets', () => {
    for (const [command, action] of [
      ['install', 'add'],
      ['upgrade', 'keep'],
      ['reinstall', 'keep'],
      ['uninstall', 'remove'],
      ['cleanup', 'keep'],
      ['sync', 'keep'],
    ] as const) {
      const receipt = buildRebuildReceiptJson(command, {
        platforms: ['codex'], plugins: ['official/demo'], warnings: [],
        overallState: 'failed',
        errors: [{ code: 'invalidArguments', message: 'invalid request' }],
        receiptTargets: [{
          pluginName: 'demo', pluginId: 'official/demo', sourceId: 'official',
          platform: 'codex', scope: 'project',
        }],
      });

      expect(receipt.layers).toEqual({
        projectIntent: [{
          pluginId: 'official/demo', platform: 'codex', scope: 'project',
          relation: 'requested', action, requiredBy: [],
        }],
        userIntent: [],
        sharedCodexNative: [],
        userActivation: [],
        projectActivation: [],
        awExtensions: [],
      });
      expect(receipt.targets).toEqual([
        expect.objectContaining({
          pluginId: 'official/demo', platform: 'codex', scope: 'project', status: 'failed',
          desired: { scope: 'project', relation: 'requested' },
        }),
      ]);
    }
  });

  it('projects init multi-source evidence without cache paths', () => {
    expect(buildInitReceiptJson({
      ok: true,
      changed: true,
      warnings: [],
      primarySourceId: 'official',
      configDigest: 'sha256:config',
      compositeDigest: 'sha256:composite',
      sources: [{
        id: 'official',
        ok: true,
        requestedRef: 'refs/heads/catalog/latest',
        resolvedCommit: 'abc',
        catalogVersion: '1.0.0',
        channel: 'latest',
        freshness: 'cache',
      }],
    })).toMatchObject({ command: 'init', receiptSchemaVersion: 5, ok: true });
  });

  it.each([
    ['install', 'add', 'install', 'completed'],
    ['upgrade', 'keep', 'upgrade', 'completed'],
    ['reinstall', 'keep', 'reinstall', 'completed'],
    ['uninstall', 'remove', 'keep', 'kept'],
    ['cleanup', 'keep', 'keep', 'kept'],
    ['sync', 'keep', 'move', 'completed'],
  ] as const)('maps planned %s intent without replacing the target action', (
    command,
    intentAction,
    targetAction,
    dependencyState,
  ) => {
    const dependencyPlan = createDependencyOperationPlan({
      requestedPluginIds: ['team/root'],
      resolvedPluginIds: ['team/leaf', 'team/root'],
      dependencyEdges: [{ from: 'team/root', to: 'team/leaf' }],
      targets: [{
        pluginId: 'team/leaf', pluginName: 'leaf', platform: 'codex', requestedScope: 'project',
        resolvedScope: 'user', relation: 'dependency', requiredBy: ['team/root'], state: 'present',
        action: targetAction, order: 0,
      }],
    });
    const receipt = buildRebuildReceiptJson(command, {
      platforms: ['codex'], plugins: ['leaf'], warnings: [], overallState: 'succeeded', dependencyPlan,
      rebuildResults: [{
        status: 'succeeded', command: 'install', target: {
          pluginName: 'leaf', pluginId: 'team/leaf', sourceId: 'team',
          sourceIdentity: `sha256:${'1'.repeat(64)}`, pluginVersion: '1.0.0',
          platform: 'codex', scope: 'user', cwd: '/repo',
        },
        actions: [], cleanupAttempted: false, removed: [], absent: [], residual: [], quarantined: [], failures: [],
      }],
    });

    expect(receipt).toMatchObject({
      receiptSchemaVersion: 5,
      dependencyPlanSchemaVersion: 2,
      requestedPluginIds: ['team/root'],
      resolvedPluginIds: ['team/leaf', 'team/root'],
      layers: {
        userIntent: [expect.objectContaining({
          pluginId: 'team/leaf', relation: 'dependency', action: intentAction,
        })],
      },
      targets: [{ relation: 'dependency', requiredBy: ['team/root'], dependencyState }],
    });
  });

  it('keeps desired intent and shared-impact recovery in a failed receipt', () => {
    const codexPlan = {
      sharedNativeActions: [{
        pluginId: 'team/demo', codexPluginId: 'demo@aw-team', action: 'replace',
        desiredVersion: '2.0.0', affectsOtherScopes: true,
      }],
      activationActions: {
        user: [{ pluginId: 'team/demo', codexPluginId: 'demo@aw-team', scope: 'user', action: 'enable', desired: true }],
        project: [{ pluginId: 'team/demo', codexPluginId: 'demo@aw-team', scope: 'project', action: 'none', desired: false }],
      },
      extensionWrites: [{ pluginId: 'team/demo', componentKey: 'rules', kind: 'permission', scope: 'user', action: 'write' }],
      extensionRemovals: [],
      review: {
        requiresConfirmation: true,
        sharedImpact: {
          pluginIds: ['demo@aw-team'],
          warning: 'Replacing shared native state can affect other projects.',
        },
      },
    } as unknown as CodexReconcilePlan;
    const receipt = buildRebuildReceiptJson('sync', {
      platforms: ['codex'], plugins: [], warnings: [], overallState: 'failed',
      codexReconcilePlans: [codexPlan],
      rebuildResults: [{
        status: 'failed', command: 'install', target: {
          pluginName: 'demo', pluginId: 'team/demo', sourceId: 'team',
          pluginVersion: '2.0.0', platform: 'codex', scope: 'user', cwd: '/repo',
        },
        actions: [], cleanupAttempted: false, removed: [], absent: [], residual: [],
        quarantined: [], failures: [{ phase: 'postcheck', message: 'codexExtensionDrift: drift' }],
        error: { phase: 'postcheck', message: 'codexExtensionDrift: drift' },
      }],
    });

    expect(receipt).toMatchObject({
      receiptSchemaVersion: 5,
      layers: {
        sharedCodexNative: [expect.objectContaining({
          codexPluginId: 'demo@aw-team', shared: true, sharedImpact: true,
          warning: expect.stringContaining('other projects'),
        })],
        userActivation: [expect.objectContaining({ desired: true })],
        projectActivation: [expect.objectContaining({ desired: false })],
        awExtensions: [expect.objectContaining({ componentKey: 'rules', action: 'write' })],
      },
      targets: [expect.objectContaining({
        desired: { scope: 'user', relation: 'requested' },
        recovery: expect.arrayContaining(['run sync']),
      })],
    });
  });

  it.each([
    'codexProjectPluginVersionTooLow',
    'codexProjectPluginUnsupported',
    'codexSystemCliUnsupported',
  ])('maps %s to only the official system Codex CLI recovery', (code) => {
    const recovery = [
      'upgrade or repair the official system Codex CLI, then retry the original operation',
    ];
    const target = {
      pluginName: 'demo', pluginId: 'team/demo', sourceId: 'team',
      pluginVersion: '2.0.0', platform: 'codex' as const, scope: 'project' as const, cwd: '/repo',
    };
    const failedTarget = buildRebuildReceiptJson('install', {
      platforms: ['codex'], plugins: ['team/demo'], warnings: [], overallState: 'failed',
      rebuildResults: [{
        status: 'failed', command: 'install', target,
        actions: [], cleanupAttempted: false, removed: [], absent: [], residual: [], quarantined: [],
        failures: [{ phase: 'preflight', message: `${code}: consumer probe failed` }],
        error: { phase: 'preflight', message: `${code}: consumer probe failed` },
      }],
    });
    expect(failedTarget.targets[0]?.recovery).toEqual(recovery);

    const earlyFailure = buildRebuildReceiptJson('install', {
      platforms: ['codex'], plugins: ['team/demo'], warnings: [], overallState: 'failed',
      errors: [{ code, message: `${code}: consumer probe failed` }],
      receiptTargets: [target],
    });
    expect(earlyFailure.targets[0]?.recovery).toEqual(recovery);
  });

  it('publicly reuses an exact existing shared native without an ownership ledger', () => {
    const codexPlan = {
      sharedNativeActions: [{
        pluginId: 'team/demo', codexPluginId: 'demo@aw-team', action: 'claim',
        desiredVersion: '2.0.0', affectsOtherScopes: false,
      }],
      activationActions: { user: [], project: [] },
      extensionWrites: [],
      extensionRemovals: [],
      review: { requiresConfirmation: false, sharedImpact: { pluginIds: [] } },
    } as unknown as CodexReconcilePlan;
    const result = {
      platforms: ['codex'], plugins: ['team/demo'], warnings: [], overallState: 'succeeded' as const,
      codexReconcilePlans: [codexPlan],
    };

    expect(buildRebuildReceiptJson('install', result).layers.sharedCodexNative).toEqual([
      expect.objectContaining({
        action: 'reuse',
        reusedExistingExactNative: true,
        ownershipLedgerCreated: false,
      }),
    ]);
    const human = renderRebuildReceipt('install', result).join('\n');
    expect(human).toContain('复用已存在的精确 shared native；不建立 ownership ledger。');
    expect(human).not.toContain('claim');
  });
});
