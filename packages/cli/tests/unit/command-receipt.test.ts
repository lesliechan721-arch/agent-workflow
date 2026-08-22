import { describe, expect, it } from 'vitest';

import {
  buildInitReceiptJson,
  buildRebuildReceiptJson,
} from '../../src/output/command-receipt.js';
import { createDependencyOperationPlan } from '../../src/commands/dependency-operation-plan.js';

describe('command receipt v4', () => {
  it('serializes the five write commands with one receipt schema', () => {
    for (const command of ['install', 'upgrade', 'reinstall', 'uninstall', 'cleanup'] as const) {
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
        receiptSchemaVersion: 4,
        targets: [{ pluginName: 'git-commit', status: 'succeeded' }],
      });
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
    })).toMatchObject({ command: 'init', receiptSchemaVersion: 4, ok: true });
  });

  it('projects dependency plan identity and kept target state without changing receipt schema v4', () => {
    const dependencyPlan = createDependencyOperationPlan({
      requestedPluginIds: ['team/root'],
      resolvedPluginIds: ['team/leaf', 'team/root'],
      dependencyEdges: [{ from: 'team/root', to: 'team/leaf' }],
      sources: [{
        sourceId: 'team', sourceIdentity: `sha256:${'1'.repeat(64)}`, resolvedCommit: 'abc',
        manifestDigest: `sha256:${'2'.repeat(64)}`, snapshotDigest: `sha256:${'3'.repeat(64)}`,
      }],
      nodes: ['leaf', 'root'].map((pluginName) => ({
        pluginId: `team/${pluginName}`, pluginName, pluginVersion: '1.0.0', sourceId: 'team',
        sourceIdentity: `sha256:${'1'.repeat(64)}`, manifestDigest: `sha256:${'4'.repeat(64)}`,
        contentDigest: `sha256:${'5'.repeat(64)}`,
      })),
      targets: [{
        pluginId: 'team/leaf', pluginName: 'leaf', platform: 'codex', requestedScope: 'project',
        resolvedScope: 'user', relation: 'dependency', requiredBy: ['team/root'], state: 'present',
        action: 'keep', order: 0,
      }],
    });
    const receipt = buildRebuildReceiptJson('install', {
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
      receiptSchemaVersion: 4,
      dependencyPlanSchemaVersion: 1,
      requestedPluginIds: ['team/root'],
      resolvedPluginIds: ['team/leaf', 'team/root'],
      targets: [{ relation: 'dependency', requiredBy: ['team/root'], dependencyState: 'kept' }],
    });
  });
});
