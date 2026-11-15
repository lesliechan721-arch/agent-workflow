import type { PluginMeta, Scope } from '../types.js';
import { resolveWorkContext, type WorkContext } from '../intent/work-context.js';
import { createEmptyPreferences, type AgentId, type DeploymentPreferences } from '../intent/deployment-preferences.js';
import { resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js';
import { readDemand, resolveDelivery, type DemandSnapshot, type ReadDemandOptions } from './demand.js';
import type { RecoveryDiagnostic } from './receipt.js';
import type { NativeSharedReference, NativeSharedReferenceView } from '../utils/native-demand.js';
import type { RecoveryStatus } from './status.js';
import { hasSharedUserPackage } from '../platforms/layout.js';

export interface JointDemandSnapshot {
  context: WorkContext;
  user: DemandSnapshot;
  project?: DemandSnapshot;
  preferences: DeploymentPreferences | null;
}
export interface DemandContribution {
  root: string;
  scope: Scope;
  path: string[];
}
export interface JointPlacement {
  pluginId: string;
  target: AgentId;
  scope: Scope;
  plugin: PluginMeta;
  contributions: DemandContribution[];
}
export interface JointRootTarget {
  pluginId: string;
  scope: Scope;
  target: AgentId;
  state: 'required' | 'excluded' | 'unsupported' | 'blocked' | 'unknown';
  dependencies: string[];
  blockers: RecoveryDiagnostic[];
  reasons?: RecoveryDiagnostic[];
}
export interface JointDemandPlan {
  roots: JointRootTarget[];
  placements: JointPlacement[];
  errors: RecoveryDiagnostic[];
  complete: boolean;
}

export async function readJointDemand(options: Omit<ReadDemandOptions, 'scope' | 'preferences'> & {
  scope?: Scope; context?: Scope; preferences?: DeploymentPreferences;
}): Promise<JointDemandSnapshot> {
  const context = await resolveWorkContext(options);
  const { preferences: draftPreferences, ...readOptions } = options;
  const user = await readDemand({ ...readOptions, scope: 'user' });
  const project = context.projectRoot ? await readDemand({ ...readOptions, scope: 'project', cwd: context.projectRoot, preferences: user.preferences }) : undefined;
  const preferences = draftPreferences ?? (user.preferences.state === 'valid' ? user.preferences.value
    : user.preferences.state === 'absent' ? createEmptyPreferences() : null);
  return { context, user, project, preferences };
}

export function deriveJointDemand(snapshot: JointDemandSnapshot): JointDemandPlan {
  const result: JointDemandPlan = { roots: [], placements: [], errors: [], complete: true };
  const preferences = snapshot.preferences;
  const demands = [snapshot.user, ...(snapshot.project ? [snapshot.project] : [])];
  result.errors.push(...demands.flatMap((demand) => demand.errors));
  if (!preferences || demands.some((demand) => demand.roots === null)) result.complete = false;
  if (!preferences) return result;
  if (!preferences.targets.length && demands.some((demand) => demand.roots?.length)) {
    result.errors.push({ code: 'targetsNotConfigured', message: '请先配置本机 Agent。' });
  }
  const excluded = new Set(preferences.exclusions.map((entry) => `${entry.plugin}\0${entry.target}`));
  const placements = new Map<string, JointPlacement>();
  for (const demand of demands) {
    for (const root of demand.roots ?? []) {
      for (const target of preferences.targets) {
        const entry: JointRootTarget = { pluginId: root.pluginId, scope: demand.scope, target,
          state: 'required', dependencies: [], blockers: [] };
        result.roots.push(entry);
        if (excluded.has(`${root.pluginId}\0${target}`)) { entry.state = 'excluded'; continue; }
        if (!root.plugin || root.blockers.length) {
          entry.state = 'unknown'; result.complete = false;
          entry.blockers = root.blockers.map((code) => ({ code, pluginId: root.pluginId, message: `${root.pluginId}: ${code}` }));
          continue;
        }
        let closure: PluginMeta[];
        try { closure = resolvePluginMetaDependencyClosure(demand.plugins.filter((plugin) => plugin.sourceId === root.sourceId), [root.plugin.manifest.name]); }
        catch (error) {
          entry.state = 'blocked'; entry.blockers.push({ code: 'dependencyContractInvalid', pluginId: root.pluginId,
            message: error instanceof Error ? error.message : '依赖合同无效。' }); continue;
        }
        const byId = new Map(closure.map((plugin) => [plugin.pluginId!, plugin]));
        const paths = new Map<string, string[]>();
        const visit = (id: string, path: string[]): void => {
          if (paths.has(id)) return;
          paths.set(id, [...path, id]);
          for (const dependency of byId.get(id)?.manifest.dependencies ?? []) visit(`${root.sourceId}/${dependency}`, [...path, id]);
        };
        visit(root.pluginId, []);
        entry.dependencies = closure.map((plugin) => plugin.pluginId!);
        for (const plugin of closure) {
          const id = plugin.pluginId!;
          if (id !== root.pluginId && excluded.has(`${id}\0${target}`)) {
            entry.state = 'blocked'; entry.blockers.push({ code: 'dependencyExcluded', pluginId: id,
              message: `${demand.scope}: ${paths.get(id)!.join(' → ')} @ ${target} 被本机排除。` });
          }
          if (!resolveDelivery(plugin.manifest, target, demand.scope)) {
            (entry.reasons ??= []).push({ code: 'deliveryUnsupported', pluginId: id,
              message: `${demand.scope}: ${paths.get(id)!.join(' → ')} @ ${target} 不支持所需目标或范围。` });
            if (entry.state === 'required') entry.state = 'unsupported';
          }
        }
        if (entry.state !== 'required') continue;
        for (const plugin of closure) {
          const pluginId = plugin.pluginId!;
          const key = `${plugin.catalogLogicalIdentity ?? plugin.sourceIdentity ?? plugin.sourceId}\0${pluginId}\0${target}`;
          const existing = placements.get(key);
          const contribution = { root: root.pluginId, scope: demand.scope, path: paths.get(pluginId)! };
          if (existing) existing.contributions.push(contribution);
          else placements.set(key, { pluginId, target, scope: demand.scope, plugin, contributions: [contribution] });
        }
      }
    }
  }
  // Unknown providers protect their complete source closure. Dependency contracts
  // are validated above and currently permit only names from the same source.
  if (!result.complete) {
    const sourceIdentity = (demand: DemandSnapshot, pluginId: string): string => {
      const sourceId = pluginId.split('/')[0]!;
      return demand.intent.state === 'valid'
        ? demand.intent.value.sources[sourceId]?.logicalIdentity ?? sourceId : sourceId;
    };
    const uncertainUser = result.roots.filter((entry) => entry.scope === 'user' && entry.state === 'unknown');
    for (const entry of result.roots.filter((entry) => entry.scope === 'project' && entry.state === 'required')) {
      if (snapshot.user.roots !== null && !uncertainUser.some((user) => user.target === entry.target
        && sourceIdentity(snapshot.user, user.pluginId) === sourceIdentity(snapshot.project!, entry.pluginId))) continue;
      entry.state = 'unknown'; entry.blockers.push({ code: 'jointDemandUnknown', message: '完整需求未知，不能确定项目提供位置。' });
    }
  }
  result.placements = [...placements.values()].flatMap((placement) => {
    const contributions = placement.contributions.filter((contribution) => result.roots.some((entry) =>
      entry.pluginId === contribution.root && entry.scope === contribution.scope
      && entry.target === placement.target && entry.state === 'required'));
    // Separate native directories need their dependency closure in each scope.
    // Explicit roots also keep each scope's package, activation or generic output.
    if (placement.target !== 'generic' && !hasSharedUserPackage(placement.target)
      || contributions.some((item) => item.scope === 'project' && item.path.length === 1)) {
      return (['user', 'project'] as const).flatMap((scope) => {
        const scoped = contributions.filter((item) => item.scope === scope);
        return scoped.length ? [{ ...placement, scope, contributions: scoped }] : [];
      });
    }
    return contributions.length ? [{ ...placement, contributions }] : [];
  });
  result.errors.push(...result.roots.flatMap((root) => root.blockers));
  return result;
}

/** These facts cover only the authorized User and current-project observations. */
export function deriveSharedReferenceView(snapshot: JointDemandSnapshot, demand: JointDemandPlan,
  status: RecoveryStatus): NativeSharedReferenceView {
  const desired: NativeSharedReference[] = demand.placements.flatMap((placement) => placement.target !== 'generic'
    && placement.plugin.sourceIdentity ? [{ pluginId: placement.pluginId, sourceIdentity: placement.plugin.sourceIdentity,
      platform: placement.target, scope: placement.scope,
      projectRoot: placement.scope === 'project' ? snapshot.context.projectRoot ?? null : null }] : []);
  const plugins = new Map([...snapshot.user.plugins, ...(snapshot.project?.plugins ?? [])].map((plugin) => [plugin.pluginId, plugin]));
  const observed: NativeSharedReference[] = [];
  const observations: NativeSharedReferenceView['observations'] = [];
  for (const target of [...(status.observedTargets ?? status.inventory?.flatMap((root) => root.targetResults) ?? []), ...status.extraObserved]) {
    const sourceIdentity = plugins.get(target.pluginId)?.sourceIdentity;
    if (target.agent === null || target.agent === 'generic' || !sourceIdentity) continue;
    const reference: NativeSharedReference = { pluginId: target.pluginId, sourceIdentity, platform: target.agent,
      scope: target.scope, projectRoot: target.scope === 'project' ? snapshot.context.projectRoot ?? null : null };
    if (!target.deploymentObservations?.length) { observations.push({ ...reference, complete: false }); continue; }
    for (const deployment of target.deploymentObservations) {
      const { after } = deployment;
      const actual = { ...reference, physicalKey: after.physicalKey };
      observations.push({ ...actual, complete: after.registration !== 'unknown' && after.package !== 'unknown'
        && after.consumers.every((consumer) => consumer.activation !== 'unknown') });
      if (after.consumers.some((consumer) => consumer.activation === 'enabled')) observed.push(actual);
    }
  }
  return { scopes: [...snapshot.context.scopes], projectRoot: snapshot.context.projectRoot ?? null,
    desiredComplete: demand.complete, desired, observed, observations };
}

/** Used before saving an exclusion; placements can be blocked without rejecting targets. */
export async function validateExclusions(options: Parameters<typeof readJointDemand>[0], preferences: DeploymentPreferences): Promise<void> {
  const plan = deriveJointDemand(await readJointDemand({ ...options, preferences }));
  const conflicts = plan.errors.filter((error) => error.code === 'dependencyExcluded');
  if (conflicts.length) throw new Error(`dependencyExcluded: ${conflicts.map((error) => error.message).join('\n')}`);
  if (!plan.complete) throw new Error('jointDemandUnknown: cannot validate exclusions.');
}
