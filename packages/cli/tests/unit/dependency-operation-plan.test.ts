import { describe, expect, it } from 'vitest';

import { createDependencyOperationPlan } from '../../src/commands/dependency-operation-plan.js';

describe('dependency operation plan', () => {
  it('produces the same digest for reordered evidence and keeps dependency-first target order', () => {
    const base = {
      requestedPluginIds: ['official/root'],
      resolvedPluginIds: ['official/leaf', 'official/root'],
      dependencyEdges: [{ from: 'official/root', to: 'official/leaf' }],
      sources: [{
        sourceId: 'official', sourceIdentity: `sha256:${'1'.repeat(64)}`,
        resolvedCommit: 'abc', manifestDigest: `sha256:${'2'.repeat(64)}`,
        snapshotDigest: `sha256:${'3'.repeat(64)}`,
      }],
      nodes: ['leaf', 'root'].map((pluginName) => ({
        pluginId: `official/${pluginName}`, pluginName, pluginVersion: '1.0.0',
        sourceId: 'official', sourceIdentity: `sha256:${'1'.repeat(64)}`,
        manifestDigest: `sha256:${pluginName === 'leaf' ? '4' : '5'}`.padEnd(71, pluginName === 'leaf' ? '4' : '5'),
        contentDigest: `sha256:${pluginName === 'leaf' ? '6' : '7'}`.padEnd(71, pluginName === 'leaf' ? '6' : '7'),
      })),
      targets: ['leaf', 'root'].map((pluginName, order) => ({
        pluginId: `official/${pluginName}`, pluginName, platform: 'codex' as const,
        requestedScope: 'user' as const, resolvedScope: 'user' as const,
        relation: pluginName === 'root' ? 'requested' as const : 'dependency' as const,
        requiredBy: pluginName === 'leaf' ? ['official/root'] : [],
        state: 'absent' as const, action: 'install' as const, order,
      })),
    };
    const first = createDependencyOperationPlan(base);
    const second = createDependencyOperationPlan({
      ...base,
      nodes: [...base.nodes].reverse(),
      sources: [...base.sources].reverse(),
      dependencyEdges: [...base.dependencyEdges].reverse(),
    });

    expect(second.planDigest).toBe(first.planDigest);
    expect(first.targets.map((target) => target.pluginId)).toEqual([
      'official/leaf',
      'official/root',
    ]);
  });
});
