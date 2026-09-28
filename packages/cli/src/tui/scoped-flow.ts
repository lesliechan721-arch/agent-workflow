import type { Scope } from '../types.js';
import { addRequirements, intentAdd, intentRemove } from '../commands/intent-command.js';
import { calculateIntentDigest } from '../intent/intent-codec.js';
import { observeIntent, resolveIntentPath,
  type IntentLocation, type IntentObservation } from '../intent/intent-store.js';
import { normalizeAgents, observePreferences, resetTargets, setAgents,
  resolvePreferencesPath, type AgentId, type PreferencesLocation,
  type PreferencesObservation } from '../intent/deployment-preferences.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { canonicalizePathThroughExistingAncestor } from '../utils/state-paths.js';
import type { RecoveryPlan } from '../recovery/coordinator.js';
import type { RetirePlan } from '../recovery/retirement.js';
import type { RecoveryReceipt } from '../recovery/receipt.js';

export interface TargetsPlan {
  kind: 'targets';
  scope: Scope;
  action: 'set' | 'reset';
  agents: AgentId[];
  previousAgents: AgentId[];
  overrideCount: number;
  expected: PreferencesObservation;
  canonicalPath: string;
  changes: string[];
  warnings: string[];
}

export interface IntentPlan {
  kind: 'intent'; scope: Scope; action: 'add' | 'remove'; selector: string;
  expected: IntentObservation; canonicalPath: string; proposedDigest?: string;
  changes: string[]; warnings: string[];
}

export type ScopedTuiPlan = { kind: 'recovery'; scope: Scope; plan: RecoveryPlan }
  | { kind: 'retire'; scope: Scope; plan: RetirePlan } | TargetsPlan | IntentPlan;

const intentPath = async (location: IntentLocation): Promise<string> =>
  canonicalizePathThroughExistingAncestor(await resolveIntentPath(location));
const preferencesPath = async (location: PreferencesLocation): Promise<string> =>
  canonicalizePathThroughExistingAncestor(await resolvePreferencesPath(location));

export async function prepareIntentPlan(location: IntentLocation, action: 'add' | 'remove',
  selector: string): Promise<IntentPlan> {
  const canonicalPath = await intentPath(location);
  const expected = await observeIntent(location);
  if (expected.state !== 'valid' && expected.state !== 'absent') throw new Error('pluginIntentStateInvalid');
  if (action === 'remove' && (expected.state === 'absent'
    || !expected.value.roots.some((root) => root.pluginId === selector))) {
    throw new Error('pluginIntentRootMissing');
  }
  const proposed = action === 'add'
    ? await addRequirements({ ...location, selectors: [selector], dryRun: true }) : undefined;
  if (proposed?.errors.length || action === 'add' && !proposed?.state) {
    throw new Error(proposed?.errors[0]?.code ?? 'pluginIntentAddUnavailable');
  }
  if (await intentPath(location) !== canonicalPath) throw new Error('operationReviewStale');
  return { kind: 'intent', scope: location.scope, action, selector, expected, canonicalPath,
    ...(proposed?.state ? { proposedDigest: calculateIntentDigest(proposed.state) } : {}),
    changes: [action === 'add' ? `声明插件需求：${selector}` : `移除插件需求：${selector}`],
    warnings: action === 'remove' ? ['只修改需求声明；已有安装内容会保留。'] : ['只修改需求声明；不会安装插件。'],
  };
}

export async function executeIntentPlan(location: IntentLocation, plan: IntentPlan): Promise<RecoveryReceipt> {
  if (location.scope !== plan.scope) throw new Error('operationReviewStale');
  return withAwHomeMutationLock({ env: location.env, action: async (token) => {
    if (await intentPath(location) !== plan.canonicalPath) throw new Error('operationReviewStale');
    const current = await observeIntent(location);
    if (current.state !== plan.expected.state || ('rawDigest' in current ? current.rawDigest : undefined)
      !== ('rawDigest' in plan.expected ? plan.expected.rawDigest : undefined)
      || await intentPath(location) !== plan.canonicalPath) {
      throw new Error('operationReviewStale');
    }
    if (plan.action === 'add') {
      const proposed = await addRequirements({ ...location, token, selectors: [plan.selector], dryRun: true });
      if (proposed.errors.length || !proposed.state
        || calculateIntentDigest(proposed.state) !== plan.proposedDigest
        || await intentPath(location) !== plan.canonicalPath) {
        throw new Error('operationReviewStale');
      }
      return intentAdd({ ...location, token, selectors: [plan.selector] });
    }
    return intentRemove({ ...location, token, selector: plan.selector });
  } });
}

function sameObservation(left: PreferencesObservation, right: PreferencesObservation): boolean {
  return left.state === right.state && ('rawDigest' in left ? left.rawDigest : undefined)
    === ('rawDigest' in right ? right.rawDigest : undefined);
}

export async function prepareTargetsPlan(
  location: PreferencesLocation,
  action: 'set' | 'reset',
  agents: readonly string[],
): Promise<TargetsPlan> {
  const canonicalPath = await preferencesPath(location);
  const expected = await observePreferences(location);
  if (expected.state === 'unreadable' || action === 'set' && expected.state === 'invalid') {
    throw new Error('deploymentPreferencesUnavailable');
  }
  const previousAgents = expected.state === 'valid' ? expected.value.agents : [];
  const overrideCount = expected.state === 'valid' ? expected.value.dependencyScopeOverrides.length : 0;
  const nextAgents = action === 'reset' ? [] : normalizeAgents(agents);
  if (await preferencesPath(location) !== canonicalPath) throw new Error('operationReviewStale');
  return {
    kind: 'targets', scope: location.scope, action, agents: nextAgents, previousAgents,
    overrideCount, expected, canonicalPath,
    changes: action === 'reset'
      ? ['清空本机工具选择', `清空 ${overrideCount} 项本机依赖范围覆盖`]
      : [`本机工具：${previousAgents.join('、') || '未选择'} → ${nextAgents.join('、') || '未选择'}`,
        '保留已有本机依赖范围覆盖'],
    warnings: [],
  };
}

export async function executeTargetsPlan(location: PreferencesLocation, plan: TargetsPlan): Promise<{
  changed: boolean; agents: AgentId[];
}> {
  if (location.scope !== plan.scope) throw new Error('operationReviewStale');
  return withAwHomeMutationLock({ env: location.env, action: async (token) => {
    if (await preferencesPath(location) !== plan.canonicalPath) throw new Error('operationReviewStale');
    const current = await observePreferences(location);
    if (!sameObservation(plan.expected, current)
      || await preferencesPath(location) !== plan.canonicalPath) throw new Error('operationReviewStale');
    const saved = plan.action === 'reset'
      ? await resetTargets({ ...location, token })
      : await setAgents({ ...location, token }, plan.agents);
    return { changed: saved.changed, agents: saved.value.agents };
  } });
}
