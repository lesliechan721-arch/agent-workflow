import { describe, expect, it } from 'vitest';

import {
  createDependencyPlacementPlan,
  type DependencyPlacementPlanInput,
} from '../../src/commands/dependency-operation-plan.js';

function graph(): DependencyPlacementPlanInput {
  return {
    requestedPluginIds: ['team/root'],
    nodes: [
      { pluginId: 'team/root', pluginName: 'root', platform: 'codex', relation: 'requested', depth: 0, allowedScopes: ['project', 'user'] },
      { pluginId: 'team/middle', pluginName: 'middle', platform: 'codex', relation: 'dependency', depth: 1, allowedScopes: ['project', 'user'] },
      { pluginId: 'team/leaf', pluginName: 'leaf', platform: 'codex', relation: 'dependency', depth: 2, allowedScopes: ['project', 'user'] },
      { pluginId: 'team/root', pluginName: 'root', platform: 'claude', relation: 'requested', depth: 0, allowedScopes: ['project', 'user'] },
      { pluginId: 'team/middle', pluginName: 'middle', platform: 'claude', relation: 'dependency', depth: 1, allowedScopes: ['project', 'user'] },
      { pluginId: 'team/leaf', pluginName: 'leaf', platform: 'claude', relation: 'dependency', depth: 2, allowedScopes: ['project', 'user'] },
    ],
    roots: [
      { pluginId: 'team/root', platform: 'codex', scope: 'project' },
      { pluginId: 'team/root', platform: 'claude', scope: 'project' },
    ],
    dependencyEdges: [
      { from: 'team/root', to: 'team/middle', platform: 'codex' },
      { from: 'team/middle', to: 'team/leaf', platform: 'codex' },
      { from: 'team/root', to: 'team/middle', platform: 'claude' },
      { from: 'team/middle', to: 'team/leaf', platform: 'claude' },
    ],
    scopeOverrides: [
      { pluginId: 'team/middle', platform: 'codex', scope: 'user' },
    ],
  };
}

function target(
  plan: ReturnType<typeof createDependencyPlacementPlan>,
  pluginId: string,
  platform: 'codex' | 'claude',
) {
  return plan.targets.find((entry) => entry.pluginId === pluginId && entry.platform === platform)!;
}

describe('dependency placement plan v2', () => {
  it('keeps platform assignments independent and propagates widening to a fixed point', () => {
    const plan = createDependencyPlacementPlan(graph());

    expect(target(plan, 'team/middle', 'codex')).toMatchObject({
      resolvedScope: 'user', assignmentSource: 'userOverride', minimumScope: 'project',
    });
    expect(target(plan, 'team/leaf', 'codex')).toMatchObject({
      resolvedScope: 'user', minimumScope: 'user', assignmentSource: 'consumerPromotion',
    });
    expect(target(plan, 'team/middle', 'claude').resolvedScope).toBe('project');
    expect(target(plan, 'team/leaf', 'claude').resolvedScope).toBe('project');
  });

  it('reuses a healthy wider user dependency without creating a user root', () => {
    const input = graph();
    input.nodes = input.nodes.filter((node) => node.platform === 'codex').map((node) =>
      node.pluginId === 'team/middle'
        ? { ...node, preferredScope: 'user' as const, preferredScopeReason: 'existingWiderTarget' as const }
        : node);
    input.roots = input.roots.filter((root) => root.platform === 'codex');
    input.dependencyEdges = input.dependencyEdges.filter((edge) => edge.platform === 'codex');
    input.scopeOverrides = [];

    const plan = createDependencyPlacementPlan(input);
    expect(target(plan, 'team/middle', 'codex')).toMatchObject({
      resolvedScope: 'user', assignmentSource: 'existingWiderTarget',
    });
    expect(target(plan, 'team/leaf', 'codex')).toMatchObject({
      resolvedScope: 'user', assignmentSource: 'consumerPromotion',
    });
    expect(plan.requestedPluginIds).toEqual(['team/root']);
  });

  it('widens every dependency of a user root and rejects a too-narrow explicit override', () => {
    const input = graph();
    input.nodes = input.nodes.filter((node) => node.platform === 'codex');
    input.roots = [{ pluginId: 'team/root', platform: 'codex', scope: 'user' }];
    input.dependencyEdges = input.dependencyEdges.filter((edge) => edge.platform === 'codex');
    input.scopeOverrides = [];
    const widened = createDependencyPlacementPlan(input);
    expect(target(widened, 'team/middle', 'codex').resolvedScope).toBe('user');
    expect(target(widened, 'team/leaf', 'codex').resolvedScope).toBe('user');

    input.scopeOverrides = [{ pluginId: 'team/middle', platform: 'codex', scope: 'project' }];
    const blocked = createDependencyPlacementPlan(input);
    expect(target(blocked, 'team/middle', 'codex')).toMatchObject({
      placementErrorCode: 'dependencyScopeOverrideTooNarrow', minimumScope: 'user',
    });
    expect(target(blocked, 'team/leaf', 'codex')).toMatchObject({
      resolvedScope: 'user', minimumScope: 'user', assignmentSource: 'consumerPromotion',
    });
  });

  it('fails closed for conflicting, invalid, root, and outside-closure overrides', () => {
    expect(() => createDependencyPlacementPlan({
      ...graph(),
      scopeOverrides: [
        { pluginId: 'team/middle', platform: 'codex', scope: 'project' },
        { pluginId: 'team/middle', platform: 'codex', scope: 'user' },
      ],
    })).toThrow('dependencyScopeOverrideConflict');
    expect(() => createDependencyPlacementPlan({
      ...graph(),
      scopeOverrides: [{
        pluginId: 'team/middle', platform: 'other' as 'codex', scope: 'user',
      }],
    })).toThrow('dependencyScopeOverrideInvalidPlatform');
    expect(() => createDependencyPlacementPlan({
      ...graph(),
      scopeOverrides: [{ pluginId: 'team/root', platform: 'codex', scope: 'user' }],
    })).toThrow('dependencyScopeOverrideTargetsRoot');
    expect(() => createDependencyPlacementPlan({
      ...graph(),
      scopeOverrides: [{ pluginId: 'team/missing', platform: 'codex', scope: 'user' }],
    })).toThrow('dependencyScopeOverrideOutsideClosure');
  });

  it('rejects duplicate root targets independent of root input order', () => {
    const duplicates = [
      { pluginId: 'team/root', platform: 'codex' as const, scope: 'project' as const },
      { pluginId: 'team/root', platform: 'codex' as const, scope: 'user' as const },
    ];
    for (const roots of [duplicates, [...duplicates].reverse(), [duplicates[0]!, duplicates[0]!]]) {
      expect(() => createDependencyPlacementPlan({ ...graph(), roots }))
        .toThrow('dependencyPlacementDuplicateRoot');
    }
  });

  it('expands an implicit selector only to closure platforms and distinguishes an explicit miss', () => {
    const input = graph();
    input.nodes = input.nodes.filter((node) => node.platform === 'codex');
    input.roots = input.roots.filter((root) => root.platform === 'codex');
    input.dependencyEdges = input.dependencyEdges.filter((edge) => edge.platform === 'codex');
    input.scopeOverrides = [{ pluginId: 'team/middle', scope: 'user' }];

    const implicit = createDependencyPlacementPlan(input);
    expect(implicit.scopeOverrides).toEqual([
      { pluginId: 'team/middle', platform: 'codex', scope: 'user' },
    ]);
    expect(target(implicit, 'team/middle', 'codex').assignmentSource).toBe('userOverride');

    const explicit = createDependencyPlacementPlan({
      ...input,
      scopeOverrides: [{ pluginId: 'team/middle', platform: 'codex', scope: 'user' }],
    });
    expect(explicit.scopeOverrides).toEqual(implicit.scopeOverrides);
    expect(() => createDependencyPlacementPlan({
      ...input,
      scopeOverrides: [{ pluginId: 'team/middle', platform: 'claude', scope: 'user' }],
    })).toThrow('dependencyScopeOverrideUnsupportedPlatform');
  });

  it('canonicalizes placement arrays without producing an independent digest', () => {
    const input = graph();
    const first = createDependencyPlacementPlan(input);
    const second = createDependencyPlacementPlan({
      ...input,
      requestedPluginIds: [...input.requestedPluginIds].reverse(),
      nodes: [...input.nodes].reverse(),
      roots: [...input.roots].reverse(),
      dependencyEdges: [...input.dependencyEdges].reverse(),
      scopeOverrides: [...(input.scopeOverrides ?? [])].reverse(),
    });

    expect(second).toEqual(first);
    expect(first).not.toHaveProperty('dependencyPlanDigest');
  });
});
