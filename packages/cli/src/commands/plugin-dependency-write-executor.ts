import type {
  PluginDependencyEdgePlan,
  PluginDependencyNodeAction,
} from '../utils/plugin-dependency-planner.js';
import type { PluginLocation } from '../types.js';
import { serializePluginLocation } from '../utils/plugin-dependency-location.js';

export interface PluginDependencyWriteExecutorNode {
  location: PluginLocation;
  action: PluginDependencyNodeAction;
  requested: boolean;
  rollbackEligible: boolean;
  dependencyOf: PluginLocation[];
  outgoingEdges: PluginDependencyEdgePlan[];
}

export interface PluginDependencyWriteExecutorRollbackFailure {
  node: PluginDependencyWriteExecutorNode;
  error: unknown;
}

export interface PluginDependencyWriteExecutorResult<TNodeResult> {
  nodeResultsByLocation: Record<string, TNodeResult>;
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decrementIncomingCount(
  incomingCounts: Map<string, number>,
  dependency: PluginLocation,
): void {
  const key = serializePluginLocation(dependency);
  const nextValue = (incomingCounts.get(key) ?? 0) - 1;
  if (nextValue > 0) {
    incomingCounts.set(key, nextValue);
  } else {
    incomingCounts.delete(key);
  }
}

function incrementIncomingCount(
  incomingCounts: Map<string, number>,
  dependency: PluginLocation,
): void {
  const key = serializePluginLocation(dependency);
  incomingCounts.set(key, (incomingCounts.get(key) ?? 0) + 1);
}

export async function executePluginDependencyWriteGraph<TNodeResult>(options: {
  nodes: PluginDependencyWriteExecutorNode[];
  preflight: () => Promise<void>;
  executeNode: (node: PluginDependencyWriteExecutorNode) => Promise<TNodeResult>;
  commitNodeEdges: (node: PluginDependencyWriteExecutorNode) => Promise<void>;
  rollbackNode: (node: PluginDependencyWriteExecutorNode) => Promise<void>;
  createRollbackFailure?: (
    error: unknown,
    failures: PluginDependencyWriteExecutorRollbackFailure[],
  ) => Error;
}): Promise<PluginDependencyWriteExecutorResult<TNodeResult>> {
  await options.preflight();

  const nodeResultsByLocation = new Map<string, TNodeResult>();
  const incomingCommittedEdgesByDependency = new Map<string, number>();
  const rollbackEligibleNodes: PluginDependencyWriteExecutorNode[] = [];

  try {
    for (const node of options.nodes) {
      const result = await options.executeNode(node);
      nodeResultsByLocation.set(serializePluginLocation(node.location), result);
      await options.commitNodeEdges(node);
      for (const edge of node.outgoingEdges) {
        incrementIncomingCount(incomingCommittedEdgesByDependency, edge.dependency);
      }
      if (node.rollbackEligible) {
        rollbackEligibleNodes.push(node);
      }
    }
  } catch (error) {
    const rollbackFailures: PluginDependencyWriteExecutorRollbackFailure[] = [];
    for (const node of [...rollbackEligibleNodes].reverse()) {
      const locationKey = serializePluginLocation(node.location);
      if ((incomingCommittedEdgesByDependency.get(locationKey) ?? 0) > 0) {
        continue;
      }

      try {
        await options.rollbackNode(node);
        for (const edge of node.outgoingEdges) {
          decrementIncomingCount(incomingCommittedEdgesByDependency, edge.dependency);
        }
      } catch (rollbackError) {
        rollbackFailures.push({
          node,
          error: rollbackError,
        });
      }
    }

    if (rollbackFailures.length > 0) {
      if (options.createRollbackFailure) {
        throw options.createRollbackFailure(error, rollbackFailures);
      }

      throw new Error(
        `${normalizeErrorMessage(error)}；自动安装依赖回滚未完全完成：${
          rollbackFailures
            .map((failure) => `${failure.node.location.platform}/${failure.node.location.scope}/${failure.node.location.plugin}: ${normalizeErrorMessage(failure.error)}`)
            .join('；')
        }`,
      );
    }

    throw error;
  }

  return {
    nodeResultsByLocation: Object.fromEntries(nodeResultsByLocation),
  };
}
