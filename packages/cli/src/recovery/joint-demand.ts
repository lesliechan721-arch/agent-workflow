import type { PluginMeta, Scope } from '../types.js';
import { resolveWorkContext, type WorkContext } from '../intent/work-context.js';
import { createEmptyPreferences, type AgentId, type DeploymentPreferences } from '../intent/deployment-preferences.js';
import { resolvePluginDependencyClosure, resolvePluginMetaDependencyClosure } from '../utils/plugin-dependencies.js';
import { readDemand, resolveDelivery, type DemandRoot, type DemandSnapshot, type ReadDemandOptions } from './demand.js';
import type { RecoveryDiagnostic, RecoveryTarget } from './receipt.js';
import type { NativeSharedReference, NativeSharedReferenceView } from '../utils/native-demand.js';
import type { RecoveryStatus } from './status.js';
import { hasSharedUserPackage } from '../platforms/layout.js';
import { observeIntent } from '../intent/intent-store.js';
import { readCatalogSourcesConfigSnapshot } from '../utils/catalog-sources.js';
import { resolvePartialCatalogOperationContext } from '../utils/catalog-operation-context.js';

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

export const canReuseProviderAcrossScopes = (target: AgentId): boolean => target === 'generic' || hasSharedUserPackage(target);

// Independently installed native packages can provide static Skills to a project.
export function hasInheritableSkills({ manifest }: PluginMeta): boolean {
  return Boolean(manifest.skills) && !manifest.extensions && !manifest.mcpServers && !manifest.artifacts
    && !manifest.config && !manifest.managedCommands && !manifest.nativeTools
    && !manifest.scripts?.artifacts?.render && !manifest.scripts?.preApply;
}

export function isInstalledSkillProvider(target: RecoveryTarget): boolean {
  return target.scope === 'user' && target.observation === 'verified' && hasReadyProviderSkills(target);
}

export function hasReadyProviderSkills(target: Pick<RecoveryTarget, 'content' | 'blockers' | 'componentGaps' | 'installedComponentCount' | 'reasons'>): boolean {
  return target.content === 'satisfied'
    && !target.blockers.length && !target.componentGaps?.length && (target.installedComponentCount ?? 0) > 0
    && !target.reasons?.some((entry) => entry.code === 'opencodePluginLoadFailed');
}

export interface ProjectSkillProvider {
  pluginId: string;
  target: AgentId;
  sourceIdentity: string;
  projectCopy: 'absent' | 'owned' | 'blocked';
  userNeedsRepair: boolean;
  userAbsent: boolean;
}

export function projectSkillCandidates(plan: JointDemandPlan): JointPlacement[] {
  return plan.placements.filter((project) => project.scope === 'project' && !canReuseProviderAcrossScopes(project.target)
    && project.plugin.sourceIdentity && hasInheritableSkills(project.plugin)
    && project.contributions.every((entry) => entry.path.length > 1)
    && plan.placements.some((user) => user.scope === 'user' && user.target === project.target && user.pluginId === project.pluginId
      && user.plugin.sourceIdentity === project.plugin.sourceIdentity && user.plugin.catalogLogicalIdentity === project.plugin.catalogLogicalIdentity));
}

type PlacementPosition = Pick<JointPlacement, 'pluginId' | 'target' | 'scope'>;
const placementKey = ({ pluginId, target, scope }: PlacementPosition): string => [pluginId, target, scope].join('\0');

/** Contribution paths explain a demand. Follow manifest edges to find all its providers. */
export function indexJointDependencies(demand: JointDemandPlan) {
  const placements = new Map(demand.placements.map((item) => [placementKey(item), item]));
  const manifests = new Map(demand.placements.map((item) => [item.pluginId, item.plugin]));
  const dependencies = new Map<string, Set<string>>();
  function dependencyIds(pluginId: string): string[] {
    const plugin = manifests.get(pluginId);
    return plugin?.manifest.dependencies?.map((name) => `${plugin.sourceId}/${name}`) ?? [];
  }
  function reaches(root: string, dependency: string): boolean {
    if (root === dependency) return true;
    const known = dependencies.get(root);
    if (known) return known.has(dependency);
    const closure = new Set<string>();
    const visit = (pluginId: string) => {
      if (closure.has(pluginId)) return;
      closure.add(pluginId);
      for (const id of dependencyIds(pluginId)) visit(id);
    };
    visit(root);
    dependencies.set(root, closure);
    return closure.has(dependency);
  }
  function directProviders(consumer: PlacementPosition): JointPlacement[] {
    return dependencyIds(consumer.pluginId).flatMap((pluginId) => {
      const user = consumer.scope === 'project' ? placements.get(placementKey({ ...consumer, pluginId, scope: 'user' })) : undefined;
      const provider = placements.get(placementKey({ ...consumer, pluginId }))
        ?? (user?.contributions.some((entry) => entry.scope === 'project') ? user : undefined);
      return provider ? [provider] : [];
    });
  }
  function providers(consumer: PlacementPosition): Set<JointPlacement> {
    const closure = new Set<JointPlacement>();
    const visit = (position: PlacementPosition) => {
      for (const provider of directProviders(position)) {
        if (closure.has(provider)) continue;
        closure.add(provider);
        visit(provider);
      }
    };
    visit(consumer);
    return closure;
  }
  return { reaches, directProviders, providers };
}

export async function readJointDemand(options: Omit<ReadDemandOptions, 'scope' | 'preferences'> & {
  scope?: Scope; context?: Scope; preferences?: DeploymentPreferences; expectedProjectRoot?: string;
}): Promise<JointDemandSnapshot> {
  const context = await resolveWorkContext(options);
  if (options.expectedProjectRoot && context.projectRoot !== options.expectedProjectRoot) {
    throw new Error('projectRootUnavailable: the reviewed project root is no longer available.');
  }
  const { preferences: draftPreferences, ...readOptions } = options;
  const [userIntent, projectIntent] = await Promise.all([
    options.intent ?? observeIntent({ ...options, scope: 'user' }),
    context.projectRoot ? options.intent ?? observeIntent({ ...options, scope: 'project', cwd: context.projectRoot }) : undefined,
  ]);
  let catalog: ReturnType<NonNullable<ReadDemandOptions['resolveCatalog']>> | undefined;
  const resolveCatalog = options.resolveCatalog ?? (() => catalog ??= (async () => {
    const snapshot = await readCatalogSourcesConfigSnapshot(options.env);
    const configured = new Set(snapshot.config.sources.map((source) => source.id));
    const sourceIds = [...new Set([userIntent, projectIntent].flatMap((intent) => intent?.state === 'valid'
      ? intent.value.roots.map((root) => root.pluginId.split('/')[0]!) : []))].filter((id) => configured.has(id));
    const resolved = options.catalogOperationContext ?? await resolvePartialCatalogOperationContext({
      env: options.env, configSnapshot: snapshot, signal: options.signal, sourceIds,
    }, options.catalogReadScope);
    return { context: resolved, configured };
  })());
  const shared = { resolveCatalog, manifestReads: options.manifestReads ?? new Map<string, Promise<PluginMeta>>() };
  const user = await readDemand({ ...readOptions, ...shared, intent: userIntent, scope: 'user' });
  const project = context.projectRoot ? await readDemand({ ...readOptions, ...shared, intent: projectIntent,
    scope: 'project', cwd: context.projectRoot, preferences: user.preferences }) : undefined;
  const preferences = draftPreferences ?? (user.preferences.state === 'valid' ? user.preferences.value
    : user.preferences.state === 'absent' ? createEmptyPreferences() : null);
  return { context, user, project, preferences };
}

/** An Active index can bound the references to protect when the bundle manifest cannot be read. */
function protectedCatalogDependencies(demand: DemandSnapshot, root: DemandRoot): string[] {
  if (root.sourceState !== 'ready' || !(root.unreadableDependency || root.blockers.includes('pluginManifestUnavailable'))) return [];
  const source = demand.catalogOperationContext?.catalog.sources.find((entry) => entry.sourceId === root.sourceId)?.resolution;
  if (!source) return [];
  try {
    return resolvePluginDependencyClosure(source.manifest.entries, [root.pluginId.split('/')[1]!])
      .map((entry) => `${root.sourceId}/${entry.name}`);
  } catch { return []; }
}

export function deriveJointDemand(snapshot: JointDemandSnapshot, skillProviders: readonly ProjectSkillProvider[] = []): JointDemandPlan {
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
      const protectedDependencies = protectedCatalogDependencies(demand, root);
      for (const target of preferences.targets) {
        const entry: JointRootTarget = { pluginId: root.pluginId, scope: demand.scope, target,
          state: 'required', dependencies: [], blockers: [] };
        result.roots.push(entry);
        if (excluded.has(`${root.pluginId}\0${target}`)) { entry.state = 'excluded'; continue; }
        if (!root.plugin || root.blockers.length) {
          entry.state = 'unknown'; result.complete = false;
          entry.dependencies = protectedDependencies;
          entry.blockers = root.blockers.map((code) => ({ code, pluginId: root.pluginId, message: `${root.pluginId}: ${code}` }));
          continue;
        }
        if (root.unreadableDependency && resolveDelivery(root.plugin.manifest, target, demand.scope)) {
          entry.state = 'unknown';
          result.complete = false;
          entry.dependencies = protectedDependencies;
          entry.blockers.push({ code: 'pluginManifestUnavailable', pluginId: root.pluginId,
            message: `无法读取 ${root.pluginId} 所需的 ${root.unreadableDependency} 清单。` });
          continue;
        }
        let closure: PluginMeta[];
        try { closure = root.unreadableDependency ? [root.plugin]
          : resolvePluginMetaDependencyClosure(demand.plugins.filter((plugin) => plugin.sourceId === root.sourceId), [root.plugin.manifest.name]); }
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
          const identity = plugin.catalogLogicalIdentity ?? plugin.sourceIdentity ?? plugin.sourceId;
          const nativeSource = canReuseProviderAcrossScopes(target) ? '' : plugin.sourceIdentity;
          const key = [identity, nativeSource, pluginId, target].join('\0');
          const existing = placements.get(key);
          const contribution = { root: root.pluginId, scope: demand.scope, path: paths.get(pluginId)! };
          if (existing) existing.contributions.push(contribution);
          else placements.set(key, { pluginId, target, scope: demand.scope, plugin, contributions: [contribution] });
        }
      }
    }
  }
  // When the indexed closure is also unavailable, protect the whole matching source.
  if (!result.complete) {
    const sourceIdentity = (demand: DemandSnapshot, pluginId: string): string => {
      const sourceId = pluginId.split('/')[0]!;
      return demand.intent.state === 'valid'
        ? demand.intent.value.sources[sourceId]?.logicalIdentity ?? sourceId : sourceId;
    };
    const uncertainUser = result.roots.filter((entry) => entry.scope === 'user' && entry.state === 'unknown');
    const projectRoots = result.roots.filter((entry) => entry.scope === 'project' && entry.state === 'required');
    for (const entry of projectRoots) {
      if (!canReuseProviderAcrossScopes(entry.target)) continue;
      // An explicit Project root always gets a scoped placement. Only the remaining
      // dependencies can change provider when the missing User evidence is restored.
      const reusable = entry.dependencies.filter((id) => !projectRoots.some((root) =>
        root.pluginId === id && root.target === entry.target));
      if (!reusable.length || snapshot.user.roots !== null && !uncertainUser.some((user) => user.target === entry.target
        && sourceIdentity(snapshot.user, user.pluginId) === sourceIdentity(snapshot.project!, entry.pluginId)
        && (!user.dependencies.length || user.pluginId.split('/')[0] !== entry.pluginId.split('/')[0]
          || user.dependencies.some((id) => reusable.includes(id))))) continue;
      entry.state = 'unknown'; entry.blockers.push({ code: 'jointDemandUnknown', message: '完整需求未知，不能确定项目提供位置。' });
    }
  }
  for (const placement of placements.values()) {
    const problem = skillProviders.find((item) => !item.userAbsent && (item.projectCopy === 'blocked' || item.userNeedsRepair) && item.pluginId === placement.pluginId
      && item.target === placement.target && item.sourceIdentity === placement.plugin.sourceIdentity);
    if (!problem || !placement.contributions.some((entry) => entry.scope === 'user')) continue;
    if (placement.contributions.some((entry) => entry.scope === 'project' && entry.path.length === 1)) continue;
    for (const contribution of placement.contributions.filter((entry) => entry.scope === 'project')) {
      const root = result.roots.find((item) => item.scope === 'project' && item.target === placement.target && item.pluginId === contribution.root);
      if (!root || root.state !== 'required') continue;
      root.state = 'blocked';
      if (problem.userNeedsRepair) {
        const userRoot = placement.contributions.find((entry) => entry.scope === 'user')!.root;
        root.blockers.push({ code: 'userSkillProviderNotReady', pluginId: placement.pluginId,
          subject: { pluginId: userRoot, scope: 'user', target: placement.target },
          message: `个人 Skill ${placement.pluginId} 尚未就绪。请先同步个人根 ${userRoot}，再重试项目安装。` });
      } else root.blockers.push({ code: 'projectSkillProviderConflict', pluginId: placement.pluginId,
        message: `无法确认个人 Skill ${placement.pluginId} 在项目中的可用性。请检查项目的包、权限和启用设置。` });
    }
  }
  result.placements = [...placements.values()].flatMap((placement) => {
    const contributions = placement.contributions.filter((contribution) => result.roots.some((entry) =>
      entry.pluginId === contribution.root && entry.scope === contribution.scope
      && entry.target === placement.target && entry.state === 'required'));
    const inheritedSkills = placement.scope === 'user' && skillProviders.some((item) => !item.userAbsent && item.projectCopy !== 'blocked'
      && item.pluginId === placement.pluginId && item.target === placement.target && item.sourceIdentity === placement.plugin.sourceIdentity);
    // Explicit roots keep each scope's package, activation or generic output.
    if ((!canReuseProviderAcrossScopes(placement.target) && !inheritedSkills)
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
      const sharedActivation = target.scope === 'project' && ['codex', 'copilot'].includes(target.agent);
      const scopedRegistration = target.agent === 'claude';
      // Project activation can be inherited. User neutral activation is already
      // independent and must not be denied by a supplemental declaration.
      const declared = sharedActivation ? after.configuration?.activation : undefined;
      observations.push({ ...actual, complete: after.registration !== 'unknown' && after.package !== 'unknown'
        && after.consumers.every((consumer) => consumer.activation !== 'unknown')
        && (!sharedActivation || declared !== undefined && declared !== 'unknown')
        && (!scopedRegistration || after.scopeRegistration !== undefined && after.scopeRegistration !== 'unknown') });
      if (scopedRegistration ? after.scopeRegistration === 'present' : sharedActivation ? declared === 'enabled'
        : after.consumers.some((consumer) => consumer.activation === 'enabled')) observed.push(actual);
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
