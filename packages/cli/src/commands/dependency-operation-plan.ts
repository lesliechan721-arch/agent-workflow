import crypto from 'node:crypto';

import type { PlatformName, Scope } from '../types.js';

export const DEPENDENCY_PLAN_SCHEMA_VERSION = 1;

export type DependencyTargetAction = 'install' | 'upgrade' | 'reinstall' | 'keep' | 'block';

export interface DependencyPlanSourceEvidence {
  sourceId: string;
  sourceIdentity: string;
  resolvedCommit: string;
  manifestDigest: string;
  snapshotDigest: string;
}

export interface DependencyPlanNodeEvidence {
  pluginId: string;
  pluginName: string;
  pluginVersion: string;
  sourceId: string;
  sourceIdentity: string;
  manifestDigest: string;
  contentDigest: string;
}

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
  configDigest?: string;
}

export interface DependencyOperationPlan {
  dependencyPlanSchemaVersion: 1;
  requestedPluginIds: string[];
  resolvedPluginIds: string[];
  dependencyEdges: Array<{ from: string; to: string }>;
  sources: DependencyPlanSourceEvidence[];
  nodes: DependencyPlanNodeEvidence[];
  targets: DependencyPlanTarget[];
  planDigest: string;
}

export type DependencyOperationPlanInput = Omit<DependencyOperationPlan, 'dependencyPlanSchemaVersion' | 'planDigest'>;

export function stableDependencyPlanJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableDependencyPlanJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${stableDependencyPlanJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createDependencyOperationPlan(
  input: DependencyOperationPlanInput,
): DependencyOperationPlan {
  const payload: Omit<DependencyOperationPlan, 'planDigest'> = {
    dependencyPlanSchemaVersion: DEPENDENCY_PLAN_SCHEMA_VERSION,
    requestedPluginIds: [...new Set(input.requestedPluginIds)].sort(compareText),
    resolvedPluginIds: [...new Set(input.resolvedPluginIds)],
    dependencyEdges: [...input.dependencyEdges].sort((left, right) =>
      compareText(`${left.from}\0${left.to}`, `${right.from}\0${right.to}`)),
    sources: [...input.sources].sort((left, right) => compareText(left.sourceId, right.sourceId)),
    nodes: [...input.nodes].sort((left, right) => compareText(left.pluginId, right.pluginId)),
    targets: [...input.targets].sort((left, right) => left.order - right.order
      || compareText(`${left.pluginId}\0${left.platform}\0${left.resolvedScope}`,
        `${right.pluginId}\0${right.platform}\0${right.resolvedScope}`)),
  };
  return {
    ...payload,
    planDigest: `sha256:${crypto.createHash('sha256').update(stableDependencyPlanJson(payload)).digest('hex')}`,
  };
}
