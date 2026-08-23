import type { PlatformName, Scope } from '../types.js';

export const DEPENDENCY_PLAN_SCHEMA_VERSION = 1;

export type DependencyTargetAction = 'install' | 'upgrade' | 'reinstall' | 'keep' | 'block';

export interface DependencyPlanTarget {
  pluginId: string;
  pluginName: string;
  platform: PlatformName;
  requestedScope: Scope;
  resolvedScope: Scope;
  relation: 'requested' | 'dependency';
  requiredBy: string[];
  state: 'absent' | 'present' | 'partial' | 'error';
  action: DependencyTargetAction;
  order: number;
  errorCode?: string;
}

export interface DependencyOperationPlan {
  dependencyPlanSchemaVersion: 1;
  requestedPluginIds: string[];
  resolvedPluginIds: string[];
  dependencyEdges: Array<{ from: string; to: string }>;
  targets: DependencyPlanTarget[];
}

export type DependencyOperationPlanInput = Omit<DependencyOperationPlan, 'dependencyPlanSchemaVersion'>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createDependencyOperationPlan(
  input: DependencyOperationPlanInput,
): DependencyOperationPlan {
  return {
    dependencyPlanSchemaVersion: DEPENDENCY_PLAN_SCHEMA_VERSION,
    requestedPluginIds: [...new Set(input.requestedPluginIds)].sort(compareText),
    resolvedPluginIds: [...new Set(input.resolvedPluginIds)],
    dependencyEdges: [...input.dependencyEdges].sort((left, right) =>
      compareText(`${left.from}\0${left.to}`, `${right.from}\0${right.to}`)),
    targets: [...input.targets].sort((left, right) => left.order - right.order
      || compareText(`${left.pluginId}\0${left.platform}\0${left.resolvedScope}`,
        `${right.pluginId}\0${right.platform}\0${right.resolvedScope}`)),
  };
}
