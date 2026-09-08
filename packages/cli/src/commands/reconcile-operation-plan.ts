import type { PlatformName, Scope } from '../types.js';
import type {
  DependencyPlacementPlan,
  DependencyPlacementTarget,
} from './dependency-operation-plan.js';

export type ReconcileTargetAction = 'install' | 'reinstall' | 'move' | 'keep' | 'block';
export type ReconcileTargetState = 'absent' | 'present' | 'partial' | 'error';

export interface ReconcileTargetPlan extends DependencyPlacementTarget {
  state: ReconcileTargetState;
  action: ReconcileTargetAction;
  errorCode?: string;
  preservedScope?: Scope;
  order: number;
}

export interface ReconcileOperationPlan extends Omit<DependencyPlacementPlan, 'targets'> {
  targets: ReconcileTargetPlan[];
}

export interface ReconcileActualTarget {
  pluginId: string;
  platform: PlatformName;
  scope?: Scope;
  state: ReconcileTargetState;
  action: ReconcileTargetAction;
  errorCode?: string;
  preservedScope?: Scope;
  order: number;
}

export function createReconcileOperationPlan(options: {
  placement: DependencyPlacementPlan;
  actual: ReconcileActualTarget[];
}): ReconcileOperationPlan {
  const actualByTarget = new Map<string, ReconcileActualTarget[]>();
  for (const target of options.actual) {
    const key = `${target.pluginId}\0${target.platform}`;
    actualByTarget.set(key, [...(actualByTarget.get(key) ?? []), target]);
  }
  const placementCounts = new Map<string, number>();
  for (const placement of options.placement.targets) {
    const key = `${placement.pluginId}\0${placement.platform}`;
    placementCounts.set(key, (placementCounts.get(key) ?? 0) + 1);
  }
  return {
    ...options.placement,
    targets: options.placement.targets.map((placement) => {
      const key = `${placement.pluginId}\0${placement.platform}`;
      const candidates = actualByTarget.get(key) ?? [];
      const scope = placement.requestedScope ?? placement.resolvedScope;
      if ((placementCounts.get(key) ?? 0) > 1 && candidates.some((target) => !target.scope)) {
        throw new Error(`reconcileTargetAmbiguous: ${placement.pluginId}#${placement.platform}`);
      }
      const matches = candidates.filter((target) => target.scope === scope || !target.scope);
      if (matches.length > 1) {
        throw new Error(
          `reconcileTargetAmbiguous: ${placement.pluginId}#${placement.platform}#${scope}`,
        );
      }
      const actual = matches[0];
      if (!actual) {
        if (candidates.length === 0 && placementCounts.get(key) === 1) {
          throw new Error(`reconcileTargetMissing: ${placement.pluginId}#${placement.platform}`);
        }
        throw new Error(
          `reconcileTargetMissing: ${placement.pluginId}#${placement.platform}#${scope}`,
        );
      }
      const placementError = placement.placementErrorCode;
      const errorCode = actual.errorCode ?? placementError;
      return {
        ...placement,
        state: actual.state,
        action: errorCode ? 'block' : actual.action,
        ...(errorCode
          ? { errorCode }
          : {}),
        ...(actual.preservedScope ? { preservedScope: actual.preservedScope } : {}),
        order: actual.order,
      };
    }),
  };
}
