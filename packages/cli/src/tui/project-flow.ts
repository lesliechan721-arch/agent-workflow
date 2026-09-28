import type { ProjectRecoveryReceiptV1 } from '../project/project-types.js';
import {
  normalizeProjectAgents,
  observeProjectPreferences,
  resetProjectTargets,
  setProjectAgents,
  type ProjectAgentId,
  type ProjectPreferencesLocation,
  type ProjectPreferencesObservation,
} from '../project/project-preferences.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';

export interface ProjectTuiRecoveryPlan {
  receipt: ProjectRecoveryReceiptV1;
  changes: string[];
  warnings: string[];
  removedPluginIds?: readonly string[];
}

export interface ProjectTuiTargetsPlan {
  kind: 'targets';
  action: 'set' | 'reset';
  agents: ProjectAgentId[];
  previousAgents: ProjectAgentId[];
  overrideCount: number;
  expected: ProjectPreferencesObservation;
  changes: string[];
  warnings: string[];
}

export type ProjectTuiPlan =
  | { kind: 'recovery'; plan: ProjectTuiRecoveryPlan }
  | ProjectTuiTargetsPlan;

function sameObservation(left: ProjectPreferencesObservation, right: ProjectPreferencesObservation): boolean {
  return left.state === right.state
    && ('rawDigest' in left ? left.rawDigest : undefined)
      === ('rawDigest' in right ? right.rawDigest : undefined);
}

export async function prepareProjectTargetsPlan(
  location: ProjectPreferencesLocation,
  action: 'set' | 'reset',
  agents: readonly string[] = [],
): Promise<ProjectTuiTargetsPlan> {
  const expected = await observeProjectPreferences(location);
  if (expected.state === 'unreadable' || action === 'set' && expected.state === 'invalid') {
    throw new Error('projectPreferencesUnavailable');
  }
  const previousAgents = expected.state === 'valid' ? expected.value.agents : [];
  const overrideCount = expected.state === 'valid'
    ? expected.value.dependencyScopeOverrides.length : 0;
  const nextAgents = action === 'reset' ? [] : normalizeProjectAgents(agents, true);
  return {
    kind: 'targets', action, agents: nextAgents, previousAgents, overrideCount,
    expected,
    changes: action === 'reset'
      ? ['清空本机 Agent 选择', `清空 ${overrideCount} 项本机依赖范围覆盖`]
      : [`本机 Agent：${previousAgents.join('、') || '未选择'} → ${nextAgents.join('、') || '未选择'}`,
        '保留已有本机依赖范围覆盖'],
    warnings: [],
  };
}

export async function executeProjectTargetsPlan(
  location: ProjectPreferencesLocation,
  plan: ProjectTuiTargetsPlan,
): Promise<{ changed: boolean; agents: ProjectAgentId[] }> {
  return withAwHomeMutationLock({ env: location.env, action: async (token) => {
    const current = await observeProjectPreferences(location);
    if (!sameObservation(plan.expected, current)) {
      throw new Error('operationReviewStale');
    }
    const result = plan.action === 'reset'
      ? await resetProjectTargets({ ...location, token })
      : await setProjectAgents({ ...location, token }, plan.agents);
    return { changed: result.changed, agents: result.value.agents };
  } });
}
