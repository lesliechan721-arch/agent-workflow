import path from 'node:path';
import { resolveSupportedPlatforms, type PlatformTarget } from '@lesliechan721/aw-plugin-core';
import type { Scope } from '../types.js';
import {
  createEmptyPreferences, parsePreferences, writePreferences,
  type DeploymentPreferences,
} from '../intent/deployment-preferences.js';
import { deriveJointDemand, readJointDemand, validateExclusions } from '../recovery/joint-demand.js';
import { withAwHomeMutationLock } from '../utils/aw-home-mutation-lock.js';
import { agentLabel, scopeLabel } from './glossary.js';
import { resolveUserHome } from '../utils/state-paths.js';

export interface AgentSettings {
  preferences: DeploymentPreferences;
  revision: string;
  plugins: Array<{ pluginId: string; scopes: Scope[]; supportedTargets: PlatformTarget[] }>;
  context: Scope;
  projectRoot?: string;
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
  return { blocked: Boolean(pluginId && reasons.length), reasons,
    conflicts: plan.conflicts.map((conflict) => ({ targets: [conflict.left.target, conflict.right.target],
      plugins: [...new Set([...conflict.left.plugins, ...conflict.right.plugins])],
      technical: [conflict.message, ...[conflict.left, conflict.right]
        .filter((position) => position.target === 'generic' || position.target === 'antigravity' && position.scope === 'project')
        .map((position) => `通用发现目录（${scopeLabel(position.scope)}）：${path.join(position.scope === 'user'
          ? resolveUserHome(context.env ?? process.env) : snapshot.context.projectRoot!, '.agents', 'skills')}`)],
      message: `${agentLabel(conflict.left.target)}（${scopeLabel(conflict.left.scope)}）与 ${agentLabel(conflict.right.target)}（${scopeLabel(conflict.right.scope)}）使用冲突的 Skill 目录，不能同时安装。` })), counts };
}

export async function saveAgentSettings(context: SettingsContext, request: {
  expectedRevision: string; preferences: DeploymentPreferences; pluginId?: string;
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
