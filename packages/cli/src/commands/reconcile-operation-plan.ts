import type { PlatformName } from '../types.js';
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
  order: number;
}

export interface ReconcileOperationPlan extends Omit<DependencyPlacementPlan, 'targets'> {
  targets: ReconcileTargetPlan[];
}

export function createReconcileOperationPlan(options: {
  placement: DependencyPlacementPlan;
  actual: Array<{
    pluginId: string;
    platform: PlatformName;
    state: ReconcileTargetState;
    action: ReconcileTargetAction;
    errorCode?: string;
    order: number;
  }>;
}): ReconcileOperationPlan {
  const actualByTarget = new Map(options.actual.map((target) => [
    `${target.pluginId}\0${target.platform}`,
    target,
  ]));
  return {
    ...options.placement,
    targets: options.placement.targets.map((placement) => {
      const actual = actualByTarget.get(`${placement.pluginId}\0${placement.platform}`);
      if (!actual) {
        throw new Error(`reconcileTargetMissing: ${placement.pluginId}#${placement.platform}`);
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
        order: actual.order,
      };
    }),
  };
}
