import { describe, expect, it, vi } from 'vitest';

import {
  buildPluginDependencyWriteExecutorNodes,
  executePluginDependencyWriteGraph,
  type PluginDependencyWriteExecutorNode,
} from '../../src/commands/plugin-dependency-write-executor.js';
import {
  type PluginDependencyNodePlan,
  type PluginDependencyWritePlan,
} from '../../src/utils/plugin-dependency-planner.js';
import type { PluginLocation } from '../../src/types.js';
import { serializePluginLocation } from '../../src/utils/plugin-dependency-location.js';

function makeLocation(
  plugin: string,
  overrides: Partial<PluginLocation> = {},
): PluginLocation {
  const scope = overrides.scope ?? 'user';
  return {
    plugin,
    platform: overrides.platform ?? 'codex',
    scope,
    ...(scope === 'project'
      ? { projectKey: overrides.projectKey ?? '/tmp/project' }
      : {}),
  };
}

function makeNode(options: {
  location: PluginLocation;
  action?: PluginDependencyWriteExecutorNode['action'];
  requested?: boolean;
  rollbackEligible?: boolean;
  dependencyOf?: PluginLocation[];
  outgoingEdges?: PluginDependencyWriteExecutorNode['outgoingEdges'];
}): PluginDependencyWriteExecutorNode {
  return {
    location: options.location,
    action: options.action ?? 'install',
    requested: options.requested ?? true,
    rollbackEligible: options.rollbackEligible ?? false,
    dependencyOf: options.dependencyOf ?? [],
    outgoingEdges: options.outgoingEdges ?? [],
  };
}

function makePlanNode(options: {
  location: PluginLocation;
  action?: PluginDependencyNodePlan['action'];
  requested?: boolean;
  dependencyOf?: PluginLocation[];
}): PluginDependencyNodePlan {
  return {
    location: options.location,
    action: options.action ?? 'install',
    reason: options.requested === false
      ? 'installDependency'
      : 'requested',
    requested: options.requested ?? true,
    dependencyOf: options.dependencyOf ?? [],
  };
}

describe('plugin dependency write executor', () => {
  it('finishes graph preflight before any write and leaves zero writes on failure', async () => {
    const executeNode = vi.fn();
    const commitNodeEdges = vi.fn();
    const rollbackNode = vi.fn();

    await expect(executePluginDependencyWriteGraph({
      nodes: [makeNode({ location: makeLocation('git-commit') })],
      preflight: async () => {
        throw new Error('dependency install options conflict');
      },
      executeNode,
      commitNodeEdges,
      rollbackNode,
    })).rejects.toThrow('dependency install options conflict');

    expect(executeNode).not.toHaveBeenCalled();
    expect(commitNodeEdges).not.toHaveBeenCalled();
    expect(rollbackNode).not.toHaveBeenCalled();
  });

  it('does not commit parent outgoing edges after the parent node fails', async () => {
    const dependency = makeLocation('dep-a');
    const parent = makeLocation('parent');
    const committedEdges: string[] = [];

    await expect(executePluginDependencyWriteGraph({
      nodes: [
        makeNode({
          location: dependency,
          action: 'installDependency',
          requested: false,
          rollbackEligible: true,
        }),
        makeNode({
          location: parent,
          action: 'install',
          outgoingEdges: [{
            dependent: parent,
            dependency,
            declaration: { name: dependency.plugin },
            retainedExistingEdge: false,
            satisfied: false,
          }],
        }),
      ],
      preflight: async () => {},
      executeNode: async (node) => {
        if (node.location.plugin === 'parent') {
          throw new Error('parent install failed');
        }
        return { ok: true };
      },
      commitNodeEdges: async (node) => {
        committedEdges.push(node.location.plugin);
      },
      rollbackNode: async () => {},
    })).rejects.toThrow('parent install failed');

    expect(committedEdges).toEqual(['dep-a']);
  });

  it('rolls back only fresh auto dependencies that are not referenced by successful dependents', async () => {
    const unusedDependency = makeLocation('dep-unused');
    const protectedDependency = makeLocation('dep-protected');
    const successfulParent = makeLocation('parent-ok');
    const failingParent = makeLocation('parent-fail');
    const rolledBack: string[] = [];

    await expect(executePluginDependencyWriteGraph({
      nodes: [
        makeNode({
          location: unusedDependency,
          action: 'installDependency',
          requested: false,
          rollbackEligible: true,
        }),
        makeNode({
          location: protectedDependency,
          action: 'installDependency',
          requested: false,
          rollbackEligible: true,
        }),
        makeNode({
          location: successfulParent,
          action: 'install',
          outgoingEdges: [{
            dependent: successfulParent,
            dependency: protectedDependency,
            declaration: { name: protectedDependency.plugin },
            retainedExistingEdge: false,
            satisfied: false,
          }],
        }),
        makeNode({
          location: failingParent,
          action: 'install',
        }),
      ],
      preflight: async () => {},
      executeNode: async (node) => {
        if (node.location.plugin === 'parent-fail') {
          throw new Error('root install failed');
        }
        return { ok: true };
      },
      commitNodeEdges: async () => {},
      rollbackNode: async (node) => {
        rolledBack.push(node.location.plugin);
      },
    })).rejects.toThrow('root install failed');

    expect(rolledBack).toEqual(['dep-unused']);
  });

  it('builds executor nodes with default rollback eligibility for fresh auto dependencies only', () => {
    const dependency = makeLocation('dep-a');
    const requested = makeLocation('parent');
    const dependencyKey = serializePluginLocation(dependency);
    const requestedKey = serializePluginLocation(requested);
    const plan: Pick<PluginDependencyWritePlan, 'writeOrder' | 'nodesByLocation' | 'edges'> = {
      writeOrder: [dependency, requested],
      nodesByLocation: {
        [dependencyKey]: makePlanNode({
          location: dependency,
          action: 'installDependency',
          requested: false,
          dependencyOf: [requested],
        }),
        [requestedKey]: makePlanNode({
          location: requested,
          action: 'install',
        }),
      },
      edges: [{
        dependent: requested,
        dependency,
        declaration: { name: dependency.plugin },
        retainedExistingEdge: false,
        satisfied: false,
      }],
    };

    const freshNodes = buildPluginDependencyWriteExecutorNodes({
      plan,
      installedRecordByLocation: new Map(),
    });
    expect(freshNodes[0]?.rollbackEligible).toBe(true);
    expect(freshNodes[1]?.rollbackEligible).toBe(false);
    expect(freshNodes[1]?.outgoingEdges).toHaveLength(1);

    const existingNodes = buildPluginDependencyWriteExecutorNodes({
      plan,
      installedRecordByLocation: new Map([[dependencyKey, { present: true }]]),
    });
    expect(existingNodes[0]?.rollbackEligible).toBe(false);
  });
});
