import { resolveSupportedPlatforms, type PlatformTarget } from '@lesliechan721/aw-plugin-core';
import type { Scope } from '../types.js';
import {
  createEmptyPreferences, parsePreferences, writePreferences,
  type DeploymentPreferences,
} from '../intent/deployment-preferences.js';
import { deriveJointDemand, readJointDemand, validateExclusions } from '../recovery/joint-demand.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { discoverPlatforms, requiresTargetConfirmation, targetAvailabilityViews,
  TargetSelectionConfirmationRequiredError, type TargetAvailabilityView } from '../platforms/discovery.js';

export interface AgentSettings {
  preferences: DeploymentPreferences;
  revision: string;
  plugins: Array<{ pluginId: string; scopes: Scope[]; supportedTargets: PlatformTarget[] }>;
  context: Scope;
  projectRoot?: string;
  availability: TargetAvailabilityView[];
}

export interface AgentSettingsPreview {
  blocked: boolean;
  reasons: Array<{ target?: PlatformTarget; pluginId?: string; root?: string; scope?: Scope; path?: string[]; message: string }>;
  conflicts: Array<{ targets: PlatformTarget[]; message: string; plugins?: string[]; technical?: string[] }>;
  counts: Partial<Record<PlatformTarget, number>>;
}

interface SettingsContext { cwd: string; env?: NodeJS.ProcessEnv }

export async function readAgentSettings(context: SettingsContext): Promise<AgentSettings> {
  const joint = await readJointDemand(context);
  const observed = joint.user.preferences;
  if (observed.state !== 'valid' && observed.state !== 'absent') {
    throw new Error('deploymentPreferencesUnavailable');
  }
  const plugins = new Map<string, AgentSettings['plugins'][number]>();
  for (const demand of [joint.user, ...(joint.project ? [joint.project] : [])]) {
    for (const root of demand.roots ?? []) {
      const previous = plugins.get(root.pluginId);
      if (previous) previous.scopes.push(demand.scope);
      else plugins.set(root.pluginId, { pluginId: root.pluginId, scopes: [demand.scope],
        supportedTargets: root.plugin ? [...resolveSupportedPlatforms(root.plugin.manifest)] : [] });
    }
  }
  return {
    preferences: observed.state === 'valid' ? observed.value : createEmptyPreferences(),
    revision: observed.state === 'valid' ? observed.rawDigest : 'absent',
    plugins: [...plugins.values()], context: joint.project ? 'project' : 'user',
    ...(joint.context.projectRoot ? { projectRoot: joint.context.projectRoot } : {}),
    availability: targetAvailabilityViews(await discoverPlatforms(context), observed.state === 'valid' ? observed.value.targets : []),
  };
}

export async function previewAgentSettings(context: SettingsContext,
  draft: DeploymentPreferences, pluginId?: string): Promise<AgentSettingsPreview> {
  const snapshot = await readJointDemand({ ...context, preferences: parsePreferences(draft) });
  const plan = deriveJointDemand(snapshot);
  const dependencyPath = (root: string, dependency: string, scope: Scope): string[] => {
    const plugins = scope === 'project' ? snapshot.project?.plugins ?? [] : snapshot.user.plugins;
    const byId = new Map(plugins.map((plugin) => [plugin.pluginId, plugin]));
    const queue = [[root]]; const visited = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!; const id = current.at(-1)!;
      if (id === dependency) return current;
      if (visited.has(id)) continue;
      visited.add(id);
      const plugin = byId.get(id);
      for (const child of plugin?.manifest.dependencies ?? []) queue.push([...current, `${plugin!.sourceId}/${child}`]);
    }
    return [root, dependency];
  };
  const reasons: AgentSettingsPreview['reasons'] = plan.roots.flatMap((root) => root.blockers
    .filter((blocker) => blocker.code === 'dependencyExcluded')
    .map((blocker) => ({ target: root.target, pluginId: blocker.pluginId, root: root.pluginId, scope: root.scope,
      path: dependencyPath(root.pluginId, blocker.pluginId ?? root.pluginId, root.scope), message: blocker.message })));
  if (pluginId && !plan.complete) reasons.push({ target: undefined, pluginId,
    message: '部分插件需求无法读取，暂时不能保存启用设置。' });
  const counts: AgentSettingsPreview['counts'] = {};
  for (const placement of plan.placements) {
    if (!pluginId || placement.pluginId === pluginId) counts[placement.target] = (counts[placement.target] ?? 0) + 1;
  }
  return { blocked: Boolean(pluginId && reasons.length), reasons, conflicts: [], counts };
}

export async function saveAgentSettings(context: SettingsContext, request: {
  expectedRevision: string; preferences: DeploymentPreferences; pluginId?: string;
  confirmedUnavailableTargets?: PlatformTarget[];
}): Promise<AgentSettings> {
  const location = { ...context, scope: 'user' as const };
  await withAwHomeMutationLock({ env: context.env, action: async (token) => {
    const current = await readAgentSettings(context);
    if (current.revision !== request.expectedRevision) throw new Error('operationReviewStale');
    const input = parsePreferences(request.preferences);
    const next = request.pluginId
      ? { ...current.preferences, exclusions: [
        ...current.preferences.exclusions.filter((entry) => entry.plugin !== request.pluginId),
        ...input.exclusions.filter((entry) => entry.plugin === request.pluginId),
      ] }
      : { ...current.preferences, targets: input.targets };
    if (!request.pluginId) {
      const unconfirmed = current.availability.filter((target) => next.targets.includes(target.id)
        && !current.preferences.targets.includes(target.id) && requiresTargetConfirmation(target.availability)
        && !request.confirmedUnavailableTargets?.includes(target.id));
      if (unconfirmed.length) throw new TargetSelectionConfirmationRequiredError(unconfirmed);
    }
    if (request.pluginId) {
      if (!current.plugins.some((plugin) => plugin.pluginId === request.pluginId)) {
        throw new Error('pluginIntentRootMissing');
      }
      await validateExclusions(context, next);
    }
    await writePreferences({ ...location, token }, next);
  } });
  return readAgentSettings(context);
}
