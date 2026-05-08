import type {
  InstalledDependencyEdge,
  InstalledScopeInstallOptions,
  InstalledScopeInstallSource,
  PlatformName,
  PluginDependencyEntry,
  PluginLocation,
  PluginManifestSource,
  Scope,
} from '../types.js';
import {
  comparePluginLocations,
  normalizePluginLocation,
  serializePluginLocation,
  sortPluginLocations,
} from './plugin-dependency-location.js';
import {
  CODEX_PROJECT_MANAGED_KIND_ORDER,
  getCodexProjectManagedKinds,
  hasCodexProjectManagedArtifacts,
} from './codex-project-surface.js';

const ALL_PLATFORMS: readonly PlatformName[] = ['codex', 'claude'];
const PLATFORM_PRODUCT_BY_NAME: Record<PlatformName, string> = {
  codex: 'CODEX',
  claude: 'CLAUDE',
};
const PLATFORM_DISPLAY_BY_NAME: Record<PlatformName, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

export type PluginDependencyPlannerMode = 'install' | 'upgrade';
export type PluginDependencyPlannerHealthState =
  | 'healthy'
  | 'missing'
  | 'degraded'
  | 'external'
  | 'externalOnly'
  | 'breadcrumbOnly'
  | 'enabledOnly'
  | 'cacheOnly'
  | 'trackingBroken'
  | 'repairRequired';
export type PluginDependencyManifestSource =
  | 'currentCatalog'
  | 'installedSnapshot'
  | 'currentCatalogFallback'
  | 'none';
export type PluginDependencyNodeAction =
  | 'install'
  | 'upgrade'
  | 'installDependency'
  | 'upgradeDependency'
  | 'none';
export type PluginDependencyNodeReason =
  | 'requested'
  | 'alreadySatisfiedDependency'
  | 'installDependency'
  | 'upgradeDependency';
export type PluginDependencyCatalogDriftKind =
  | 'none'
  | 'snapshotMissing'
  | 'currentCatalogMissing'
  | 'dependenciesChanged';

export interface PluginDependencyPlannerInstalledRecord {
  location: PluginLocation;
  resolvedVersion?: string;
  installSource?: InstalledScopeInstallSource;
  dependencyEdges?: InstalledDependencyEdge[];
  installOptions?: InstalledScopeInstallOptions;
  snapshotManifest?: PluginManifestSource;
}

export interface PluginDependencyPlannerHealthRecord {
  location: PluginLocation;
  state: PluginDependencyPlannerHealthState;
  visible?: boolean;
  managedByAw?: boolean;
}

export interface PluginDependencyPlannerState {
  currentCatalogByPlugin: Record<string, PluginManifestSource>;
  installedRecords?: PluginDependencyPlannerInstalledRecord[];
  healthRecords?: PluginDependencyPlannerHealthRecord[];
}

export interface PluginDependencyPlannerTarget {
  location: PluginLocation;
  installOptions?: InstalledScopeInstallOptions;
}

export interface PluginDependencyEdgePlan {
  dependent: PluginLocation;
  dependency: PluginLocation;
  declaration: PluginDependencyEntry;
  retainedExistingEdge: boolean;
  satisfied: boolean;
}

export interface PluginDependencyNodePlan {
  location: PluginLocation;
  action: PluginDependencyNodeAction;
  reason: PluginDependencyNodeReason;
  requested: boolean;
  dependencyOf: PluginLocation[];
  installOptions?: InstalledScopeInstallOptions;
}

export interface PluginDependencyPlannerPreflight {
  all: PluginLocation[];
  requiredConfig: PluginLocation[];
  externalOwnership: PluginLocation[];
  trackingIdentity: PluginLocation[];
  roleNamespace: PluginLocation[];
  projectSafety: PluginLocation[];
  codexProjectInstallability: PluginLocation[];
}

export interface PluginDependencyWritePlan {
  mode: PluginDependencyPlannerMode;
  requestedRoots: PluginLocation[];
  topologicalOrder: PluginLocation[];
  writeOrder: PluginLocation[];
  nodesByLocation: Record<string, PluginDependencyNodePlan>;
  edges: PluginDependencyEdgePlan[];
  preflight: PluginDependencyPlannerPreflight;
}

export interface PluginDependencyUpgradeAllSkipInput {
  location: PluginLocation;
  reason: string;
  code?: string;
}

export interface PluginDependencyUpgradeAllSkip {
  location: PluginLocation;
  reason: string;
  code: string;
  blockedBy?: PluginLocation;
}

export interface PluginDependencyUpgradeAllOptions {
  state: PluginDependencyPlannerState;
  platforms: PlatformName[];
  scope: Scope;
  projectKeysByPlatform?: Partial<Record<PlatformName, string | null>>;
  initialSkipped?: PluginDependencyUpgradeAllSkipInput[];
}

export interface PluginDependencyUpgradeAllPlan {
  roots: PluginLocation[];
  topologicalOrder: PluginLocation[];
  writeOrder: PluginLocation[];
  nodesByLocation: Record<string, PluginDependencyNodePlan>;
  edges: PluginDependencyEdgePlan[];
  skipped: PluginDependencyUpgradeAllSkip[];
  autoCleanupCandidates: PluginLocation[];
  preflight: PluginDependencyPlannerPreflight;
}

export interface PluginDependencyUninstallBlock {
  location: PluginLocation;
  dependents: PluginLocation[];
}

export interface PluginDependencyUninstallPlan {
  requested: PluginLocation[];
  blocked: PluginDependencyUninstallBlock[];
  incompleteMetadataLocations: PluginLocation[];
  uninstallOrder: PluginLocation[];
  autoCleanup: PluginLocation[];
}

export interface PluginDependencyStatusResolvedEntry {
  declaration: PluginDependencyEntry;
  source: PluginDependencyManifestSource;
}

export interface PluginDependencyStatusSatisfiedEntry {
  declaration: PluginDependencyEntry;
  location: PluginLocation;
}

export interface PluginDependencyStatusMissingEntry {
  declaration: PluginDependencyEntry;
  expectedLocation?: PluginLocation;
  reason: string;
}

export interface PluginDependencyStatusCatalogDrift {
  kind: PluginDependencyCatalogDriftKind;
  snapshotDependencies: string[];
  currentDependencies: string[];
}

export interface PluginDependencyStatusProjection {
  location: PluginLocation;
  healthSource: PluginDependencyManifestSource;
  declared: PluginDependencyEntry[];
  resolved: PluginDependencyStatusResolvedEntry[];
  satisfied: PluginDependencyStatusSatisfiedEntry[];
  missing: PluginDependencyStatusMissingEntry[];
  dependents: PluginLocation[];
  autoInstalled: boolean;
  autoRemovable: boolean;
  catalogDrift: PluginDependencyStatusCatalogDrift;
}

interface NormalizedInstalledRecord extends PluginDependencyPlannerInstalledRecord {
  location: PluginLocation;
}

interface NormalizedHealthRecord extends PluginDependencyPlannerHealthRecord {
  location: PluginLocation;
  visible: boolean;
  managedByAw: boolean;
}

interface PlannerIndexes {
  currentCatalogByPlugin: Record<string, PluginManifestSource>;
  installedByLocation: Map<string, NormalizedInstalledRecord>;
  healthByLocation: Map<string, NormalizedHealthRecord>;
  dependencyMetadataComplete: boolean;
  incomingDependentsByLocation: Map<string, PluginLocation[]>;
  existingEdgesByDependentAndName: Map<string, Map<string, InstalledDependencyEdge>>;
}

interface InternalPlannerNode {
  location: PluginLocation;
  manifest: PluginManifestSource;
  requested: boolean;
  action: PluginDependencyNodeAction;
  reason: PluginDependencyNodeReason;
  targetInstallOptions?: InstalledScopeInstallOptions;
  effectiveInstallOptions?: InstalledScopeInstallOptions;
  dependencyOfKeys: Set<string>;
}

interface PlannerResolution {
  location: PluginLocation;
  satisfied: boolean;
  retainedExistingEdge: boolean;
  expectedLocation?: PluginLocation;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stableStringifyInstallOptions(
  value: InstalledScopeInstallOptions | undefined,
): string {
  return JSON.stringify(value ?? null);
}

function normalizeManifestProductToken(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeDependencyEntry(entry: PluginDependencyEntry): PluginDependencyEntry {
  const platforms = entry.when?.platforms
    ? [...new Set(entry.when.platforms)].sort()
    : undefined;

  return {
    name: entry.name,
    target: entry.target?.scope
      ? { scope: entry.target.scope }
      : undefined,
    inheritInstallOptions: entry.inheritInstallOptions === true ? true : undefined,
    when: platforms ? { platforms } : undefined,
  };
}

function normalizeDependencyDeclaration(
  declaration: InstalledDependencyEdge['declaration'],
): InstalledDependencyEdge['declaration'] {
  const platforms = declaration.when?.platforms
    ? [...new Set(declaration.when.platforms)].sort()
    : undefined;

  return {
    name: declaration.name,
    target: declaration.target?.scope
      ? { scope: declaration.target.scope }
      : undefined,
    inheritInstallOptions: declaration.inheritInstallOptions === true ? true : undefined,
    when: platforms ? { platforms } : undefined,
  };
}

function serializeDependencyEntry(entry: PluginDependencyEntry): string {
  const normalized = normalizeDependencyEntry(entry);
  return JSON.stringify({
    name: normalized.name,
    targetScope: normalized.target?.scope ?? null,
    inheritInstallOptions: normalized.inheritInstallOptions === true,
    platforms: normalized.when?.platforms ?? [],
  });
}

function listDependencyNames(manifest: PluginManifestSource | undefined): string[] {
  return (manifest?.dependencies?.plugins ?? []).map((entry) => entry.name);
}

function dependencySignature(manifest: PluginManifestSource | undefined): string {
  return JSON.stringify(
    (manifest?.dependencies?.plugins ?? []).map((entry) => ({
      name: entry.name,
      targetScope: entry.target?.scope ?? null,
      inheritInstallOptions: entry.inheritInstallOptions === true,
      platforms: [...(entry.when?.platforms ?? [])].sort(),
    })),
  );
}

function normalizeInstalledDependencyEdge(edge: InstalledDependencyEdge): InstalledDependencyEdge {
  return {
    dependency: normalizePluginLocation(edge.dependency),
    declaration: normalizeDependencyDeclaration(edge.declaration),
  };
}

function hasCompleteDependencyMetadata(record: {
  installSource?: InstalledScopeInstallSource;
  dependencyEdges?: InstalledDependencyEdge[];
}): boolean {
  return Boolean(record.installSource && record.dependencyEdges);
}

function buildPlannerIndexes(state: PluginDependencyPlannerState): PlannerIndexes {
  const installedByLocation = new Map<string, NormalizedInstalledRecord>();
  const healthByLocation = new Map<string, NormalizedHealthRecord>();
  const incomingDependentsByLocation = new Map<string, Map<string, PluginLocation>>();
  const existingEdgesByDependentAndName = new Map<string, Map<string, InstalledDependencyEdge>>();
  let dependencyMetadataComplete = true;

  for (const [pluginName, manifest] of Object.entries(state.currentCatalogByPlugin)) {
    validateManifestDependencyStructure(pluginName, manifest);
  }

  for (const record of state.installedRecords ?? []) {
    const location = normalizePluginLocation(record.location);
    const key = serializePluginLocation(location);
    const normalizedEdges = record.dependencyEdges?.map((edge) => normalizeInstalledDependencyEdge(edge));
    installedByLocation.set(key, {
      ...record,
      location,
      dependencyEdges: normalizedEdges,
      snapshotManifest: record.snapshotManifest ? clone(record.snapshotManifest) : undefined,
      installOptions: record.installOptions ? clone(record.installOptions) : undefined,
      installSource: record.installSource ? clone(record.installSource) : undefined,
    });

    if (!hasCompleteDependencyMetadata(record)) {
      dependencyMetadataComplete = false;
    }

    const edgesByName = new Map<string, InstalledDependencyEdge>();
    for (const edge of normalizedEdges ?? []) {
      edgesByName.set(edge.declaration.name, edge);
      const dependencyKey = serializePluginLocation(edge.dependency);
      const bucket = incomingDependentsByLocation.get(dependencyKey) ?? new Map<string, PluginLocation>();
      bucket.set(`${key}\u0000${edge.declaration.name}`, location);
      incomingDependentsByLocation.set(dependencyKey, bucket);
    }
    existingEdgesByDependentAndName.set(key, edgesByName);
  }

  for (const record of state.healthRecords ?? []) {
    const location = normalizePluginLocation(record.location);
    healthByLocation.set(serializePluginLocation(location), {
      ...record,
      location,
      visible: record.visible ?? true,
      managedByAw: record.managedByAw ?? true,
    });
  }

  return {
    currentCatalogByPlugin: Object.fromEntries(
      Object.entries(state.currentCatalogByPlugin).map(([pluginName, manifest]) => [
        pluginName,
        clone(manifest),
      ]),
    ),
    installedByLocation,
    healthByLocation,
    dependencyMetadataComplete,
    incomingDependentsByLocation: new Map(
      [...incomingDependentsByLocation.entries()].map(([locationKey, dependents]) => [
        locationKey,
        [...dependents.values()].sort(comparePluginLocations),
      ]),
    ),
    existingEdgesByDependentAndName,
  };
}

function validateManifestDependencyStructure(
  pluginName: string,
  manifest: PluginManifestSource,
): void {
  const entries = manifest.dependencies?.plugins ?? [];
  const coveredPlatformsByDependency = new Map<string, Set<PlatformName>>();

  for (const [index, rawEntry] of entries.entries()) {
    const entry = rawEntry as PluginDependencyEntry;
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      throw new Error(`插件 ${pluginName} 的 dependencies.plugins[${index}] 缺少合法的 name。`);
    }
    if (entry.name === pluginName) {
      throw new Error(`插件 ${pluginName} 不能依赖自身。`);
    }
    if (entry.target && entry.target.scope !== 'user' && entry.target.scope !== 'project') {
      throw new Error(`插件 ${pluginName} 的依赖 ${entry.name} 使用了非法 target.scope。`);
    }
    if (
      entry.inheritInstallOptions !== undefined &&
      typeof entry.inheritInstallOptions !== 'boolean'
    ) {
      throw new Error(`插件 ${pluginName} 的依赖 ${entry.name} 使用了非法 inheritInstallOptions。`);
    }

    const effectivePlatforms = new Set<PlatformName>();
    const platforms = entry.when?.platforms ?? [...ALL_PLATFORMS];
    if (platforms.length === 0) {
      throw new Error(`插件 ${pluginName} 的依赖 ${entry.name} 声明了空的 when.platforms。`);
    }
    for (const platform of platforms) {
      if (!ALL_PLATFORMS.includes(platform)) {
        throw new Error(`插件 ${pluginName} 的依赖 ${entry.name} 使用了未知平台 ${String(platform)}。`);
      }
      if (effectivePlatforms.has(platform)) {
        throw new Error(`插件 ${pluginName} 的依赖 ${entry.name} 在 when.platforms 中重复声明了 ${platform}。`);
      }
      effectivePlatforms.add(platform);
    }

    const coveredPlatforms = coveredPlatformsByDependency.get(entry.name) ?? new Set<PlatformName>();
    const overlap = [...effectivePlatforms].filter((platform) => coveredPlatforms.has(platform));
    if (overlap.length > 0) {
      throw new Error(
        `插件 ${pluginName} 对依赖 ${entry.name} 声明了重叠的平台条件 ${overlap.join(', ')}。`,
      );
    }
    for (const platform of effectivePlatforms) {
      coveredPlatforms.add(platform);
    }
    coveredPlatformsByDependency.set(entry.name, coveredPlatforms);
  }
}

function assertProjectLocation(location: PluginLocation, pluginName = location.plugin): void {
  if (location.scope === 'project' && !location.projectKey) {
    throw new Error(`插件 ${pluginName} 的目标 scope 为 project，但当前命令不在项目内，无法解析 project key。`);
  }
}

function getManifestForCatalogPlugin(
  indexes: PlannerIndexes,
  dependentPluginName: string,
  dependencyName: string,
): PluginManifestSource {
  const dependencyManifest = indexes.currentCatalogByPlugin[dependencyName];
  if (!dependencyManifest) {
    throw new Error(`插件 ${dependentPluginName} 依赖 catalog 中不存在的插件 ${dependencyName}。`);
  }
  return dependencyManifest;
}

function manifestSupportsPlatform(
  manifest: PluginManifestSource,
  platform: PlatformName,
): boolean {
  const products = manifest.marketplace.policy.products;
  if (!products || products.length === 0) {
    return true;
  }

  const normalizedProducts = new Set(products.map((product) => normalizeManifestProductToken(product)));
  return normalizedProducts.has(PLATFORM_PRODUCT_BY_NAME[platform]);
}

function assertManifestSupportsPlatform(
  dependentManifest: PluginManifestSource,
  dependencyManifest: PluginManifestSource,
  platform: PlatformName,
): void {
  if (manifestSupportsPlatform(dependencyManifest, platform)) {
    return;
  }

  const supportedProducts = dependencyManifest.marketplace.policy.products?.join(', ') ?? '未限制';
  throw new Error(
    `插件 ${dependentManifest.name} 在 ${PLATFORM_DISPLAY_BY_NAME[platform]} 上依赖 ${dependencyManifest.name}，但 ${dependencyManifest.name} 只支持 ${supportedProducts}。`,
  );
}

function getEffectiveDependencyEntries(
  manifest: PluginManifestSource,
  platform: PlatformName,
): PluginDependencyEntry[] {
  return (manifest.dependencies?.plugins ?? [])
    .filter((entry) => {
      const platforms = entry.when?.platforms;
      return !platforms || platforms.includes(platform);
    })
    .map((entry) => normalizeDependencyEntry(entry));
}

function createExpectedDependencyLocation(
  dependent: PluginLocation,
  entry: PluginDependencyEntry,
): PluginLocation {
  if (dependent.scope === 'user' && entry.target?.scope === 'project') {
    throw new Error(
      `插件 ${dependent.plugin} 安装到 user scope 时不能依赖 project scope 插件 ${entry.name}；请将依赖改为 user scope，或把 ${dependent.plugin} 安装到 project scope。`,
    );
  }

  const scope = entry.target?.scope ?? dependent.scope;
  if (scope === 'project' && !dependent.projectKey) {
    throw new Error(`插件 ${dependent.plugin} 的依赖 ${entry.name} 目标是 project scope，但当前命令不在项目内。`);
  }

  return normalizePluginLocation({
    plugin: entry.name,
    platform: dependent.platform,
    scope,
    projectKey: scope === 'user' ? null : dependent.projectKey,
  });
}

function listVisibleCandidateLocations(
  dependent: PluginLocation,
  entry: PluginDependencyEntry,
): PluginLocation[] {
  if (dependent.scope === 'user' && entry.target?.scope === 'project') {
    throw new Error(
      `插件 ${dependent.plugin} 安装到 user scope 时不能依赖 project scope 插件 ${entry.name}；请将依赖改为 user scope，或把 ${dependent.plugin} 安装到 project scope。`,
    );
  }

  const userLocation = normalizePluginLocation({
    plugin: entry.name,
    platform: dependent.platform,
    scope: 'user',
    projectKey: null,
  });

  if (entry.target?.scope === 'user') {
    return [userLocation];
  }

  if (entry.target?.scope === 'project') {
    assertProjectLocation(dependent);
    return [
      normalizePluginLocation({
        plugin: entry.name,
        platform: dependent.platform,
        scope: 'project',
        projectKey: dependent.projectKey,
      }),
    ];
  }

  if (dependent.scope === 'user') {
    return [userLocation];
  }

  assertProjectLocation(dependent);
  return [
    normalizePluginLocation({
      plugin: entry.name,
      platform: dependent.platform,
      scope: 'project',
      projectKey: dependent.projectKey,
    }),
    userLocation,
  ];
}

function isHealthySatisfiedLocation(
  indexes: PlannerIndexes,
  location: PluginLocation,
): boolean {
  const key = serializePluginLocation(location);
  const installedRecord = indexes.installedByLocation.get(key);
  const healthRecord = indexes.healthByLocation.get(key);
  return Boolean(
    installedRecord &&
      healthRecord &&
      healthRecord.visible &&
      healthRecord.managedByAw &&
      healthRecord.state === 'healthy',
  );
}

function edgeLocationStillSatisfies(
  indexes: PlannerIndexes,
  dependent: PluginLocation,
  entry: PluginDependencyEntry,
  edge: InstalledDependencyEdge | undefined,
): boolean {
  if (!edge || edge.dependency.plugin !== entry.name || edge.dependency.platform !== dependent.platform) {
    return false;
  }

  const allowedLocations = listVisibleCandidateLocations(dependent, entry);
  return allowedLocations.some((location) => (
    serializePluginLocation(location) === serializePluginLocation(edge.dependency) &&
    isHealthySatisfiedLocation(indexes, edge.dependency)
  ));
}

function resolveDependencyForPlanning(options: {
  indexes: PlannerIndexes;
  dependent: PluginLocation;
  entry: PluginDependencyEntry;
}): PlannerResolution {
  const dependentKey = serializePluginLocation(options.dependent);
  const existingEdge = options.indexes.existingEdgesByDependentAndName
    .get(dependentKey)
    ?.get(options.entry.name);

  if (edgeLocationStillSatisfies(options.indexes, options.dependent, options.entry, existingEdge)) {
    return {
      location: normalizePluginLocation(existingEdge!.dependency),
      satisfied: true,
      retainedExistingEdge: true,
    };
  }

  const candidateLocations = listVisibleCandidateLocations(options.dependent, options.entry);
  const healthyCandidate = candidateLocations.find((location) =>
    isHealthySatisfiedLocation(options.indexes, location),
  );
  if (healthyCandidate) {
    return {
      location: healthyCandidate,
      satisfied: true,
      retainedExistingEdge: false,
    };
  }

  const expectedLocation = createExpectedDependencyLocation(options.dependent, options.entry);
  return {
    location: expectedLocation,
    expectedLocation,
    satisfied: false,
    retainedExistingEdge: false,
  };
}

function resolveDependencyForStatus(options: {
  indexes: PlannerIndexes;
  dependent: PluginLocation;
  entry: PluginDependencyEntry;
  allowFreshSearch: boolean;
}): PlannerResolution {
  const dependentKey = serializePluginLocation(options.dependent);
  const existingEdge = options.indexes.existingEdgesByDependentAndName
    .get(dependentKey)
    ?.get(options.entry.name);

  if (edgeLocationStillSatisfies(options.indexes, options.dependent, options.entry, existingEdge)) {
    return {
      location: normalizePluginLocation(existingEdge!.dependency),
      satisfied: true,
      retainedExistingEdge: true,
    };
  }

  if (options.allowFreshSearch) {
    const candidateLocations = listVisibleCandidateLocations(options.dependent, options.entry);
    const healthyCandidate = candidateLocations.find((location) =>
      isHealthySatisfiedLocation(options.indexes, location),
    );
    if (healthyCandidate) {
      return {
        location: healthyCandidate,
        satisfied: true,
        retainedExistingEdge: false,
      };
    }
  }

  return {
    location: createExpectedDependencyLocation(options.dependent, options.entry),
    expectedLocation: createExpectedDependencyLocation(options.dependent, options.entry),
    satisfied: false,
    retainedExistingEdge: false,
  };
}

function actionPriority(action: PluginDependencyNodeAction): number {
  switch (action) {
    case 'none':
      return 0;
    case 'upgradeDependency':
      return 1;
    case 'installDependency':
      return 2;
    case 'upgrade':
    case 'install':
      return 3;
  }
}

function createDependencyNodePlan(
  node: InternalPlannerNode,
  nodesByKey: Map<string, InternalPlannerNode>,
): PluginDependencyNodePlan {
  return {
    location: node.location,
    action: node.action,
    reason: node.reason,
    requested: node.requested,
    dependencyOf: [...node.dependencyOfKeys]
      .map((key) => nodesByKey.get(key)?.location)
      .filter((location): location is PluginLocation => Boolean(location))
      .sort(comparePluginLocations),
    installOptions: node.effectiveInstallOptions ? clone(node.effectiveInstallOptions) : undefined,
  };
}

function createPreflight(writeOrder: readonly PluginLocation[]): PluginDependencyPlannerPreflight {
  const all = sortPluginLocations(writeOrder);
  const projectSafety = all.filter((location) => location.platform === 'codex' && location.scope === 'project');
  return {
    all,
    requiredConfig: [...all],
    externalOwnership: [...all],
    trackingIdentity: [...all],
    roleNamespace: [...all],
    projectSafety,
    codexProjectInstallability: [...projectSafety],
  };
}

function getSyntheticPluginMeta(manifest: PluginManifestSource): {
  manifest: PluginManifestSource;
  rootDir: string;
  manifestPath: string;
} {
  return {
    manifest,
    rootDir: '',
    manifestPath: '',
  };
}

function assertCodexProjectInstallable(location: PluginLocation, manifest: PluginManifestSource): void {
  if (location.platform !== 'codex' || location.scope !== 'project') {
    return;
  }

  const managedKinds = getCodexProjectManagedKinds(
    getSyntheticPluginMeta(manifest),
  );
  if (manifest.apps) {
    throw new Error(`${manifest.name} 声明了 apps，Codex project scope 暂不支持 apps；请改用 --scope user 或拆分插件。`);
  }
  if (!hasCodexProjectManagedArtifacts(getSyntheticPluginMeta(manifest))) {
    const kindsLabel = managedKinds.length > 0
      ? managedKinds.join(', ')
      : CODEX_PROJECT_MANAGED_KIND_ORDER.join(', ');
    throw new Error(`${manifest.name} 没有任何 Codex project-managed kind，Codex project scope 不支持安装。可用 kind：${kindsLabel}。`);
  }
}

function resolveRootAction(mode: PluginDependencyPlannerMode): PluginDependencyNodeAction {
  return mode === 'install' ? 'install' : 'upgrade';
}

function resolveDependencyAction(options: {
  mode: PluginDependencyPlannerMode;
  satisfied: boolean;
  indexes: PlannerIndexes;
  location: PluginLocation;
}): PluginDependencyNodeAction {
  if (options.mode === 'install') {
    if (options.satisfied) {
      return 'none';
    }
    return 'installDependency';
  }
  return options.indexes.installedByLocation.has(serializePluginLocation(options.location))
    ? 'upgradeDependency'
    : 'installDependency';
}

function createWritePlan(options: {
  mode: PluginDependencyPlannerMode;
  indexes: PlannerIndexes;
  targets: PluginDependencyPlannerTarget[];
}): PluginDependencyWritePlan {
  const nodesByKey = new Map<string, InternalPlannerNode>();
  const completionOrder: string[] = [];
  const traversalStack: string[] = [];
  const edges: PluginDependencyEdgePlan[] = [];

  function ensureNode(input: {
    location: PluginLocation;
    manifest: PluginManifestSource;
    requested: boolean;
    action: PluginDependencyNodeAction;
    reason: PluginDependencyNodeReason;
    targetInstallOptions?: InstalledScopeInstallOptions;
  }): InternalPlannerNode {
    const key = serializePluginLocation(input.location);
    const existing = nodesByKey.get(key);
    if (existing) {
      if (input.requested) {
        existing.requested = true;
        existing.action = resolveRootAction(options.mode);
        existing.reason = 'requested';
        existing.targetInstallOptions = input.targetInstallOptions
          ? clone(input.targetInstallOptions)
          : existing.targetInstallOptions;
      } else if (actionPriority(input.action) > actionPriority(existing.action)) {
        existing.action = input.action;
        existing.reason = input.reason;
      }
      return existing;
    }

    const node: InternalPlannerNode = {
      location: input.location,
      manifest: clone(input.manifest),
      requested: input.requested,
      action: input.action,
      reason: input.reason,
      targetInstallOptions: input.targetInstallOptions ? clone(input.targetInstallOptions) : undefined,
      effectiveInstallOptions: input.targetInstallOptions ? clone(input.targetInstallOptions) : undefined,
      dependencyOfKeys: new Set<string>(),
    };
    nodesByKey.set(key, node);
    return node;
  }

  function visit(
    location: PluginLocation,
    manifest: PluginManifestSource,
    node: InternalPlannerNode,
  ): void {
    const key = serializePluginLocation(location);
    if (completionOrder.includes(key)) {
      return;
    }
    const cycleIndex = traversalStack.indexOf(key);
    if (cycleIndex >= 0) {
      const cycleChain = traversalStack
        .slice(cycleIndex)
        .concat(key)
        .map((locationKey) => nodesByKey.get(locationKey)?.location.plugin ?? locationKey);
      throw new Error(`检测到插件循环依赖：${cycleChain.join(' -> ')}。`);
    }

    traversalStack.push(key);
    assertProjectLocation(location, manifest.name);
    assertManifestSupportsPlatform(manifest, manifest, location.platform);

    for (const entry of getEffectiveDependencyEntries(manifest, location.platform)) {
      const dependencyManifest = getManifestForCatalogPlugin(options.indexes, manifest.name, entry.name);
      assertManifestSupportsPlatform(manifest, dependencyManifest, location.platform);
      const resolution = resolveDependencyForPlanning({
        indexes: options.indexes,
        dependent: location,
        entry,
      });
      const dependencyAction = resolveDependencyAction({
        mode: options.mode,
        satisfied: resolution.satisfied,
        indexes: options.indexes,
        location: resolution.location,
      });
      const dependencyNode = ensureNode({
        location: resolution.location,
        manifest: dependencyManifest,
        requested: false,
        action: dependencyAction,
        reason: dependencyAction === 'none'
          ? 'alreadySatisfiedDependency'
          : dependencyAction === 'installDependency'
            ? 'installDependency'
            : 'upgradeDependency',
      });
      dependencyNode.dependencyOfKeys.add(key);
      edges.push({
        dependent: location,
        dependency: resolution.location,
        declaration: clone(entry),
        retainedExistingEdge: resolution.retainedExistingEdge,
        satisfied: resolution.satisfied,
      });
      visit(resolution.location, dependencyManifest, dependencyNode);
    }

    traversalStack.pop();
    completionOrder.push(key);
    if (
      node.action === 'installDependency' &&
      node.location.platform === 'codex' &&
      node.location.scope === 'project'
    ) {
      assertCodexProjectInstallable(node.location, node.manifest);
    }
  }

  const requestedRoots = options.targets.map((target) => normalizePluginLocation(target.location));
  for (const target of options.targets) {
    const location = normalizePluginLocation(target.location);
    assertProjectLocation(location);
    const manifest = options.indexes.currentCatalogByPlugin[location.plugin];
    if (!manifest) {
      throw new Error(`插件 ${location.plugin} 在 current catalog 中不存在。`);
    }
    const node = ensureNode({
      location,
      manifest,
      requested: true,
      action: resolveRootAction(options.mode),
      reason: 'requested',
      targetInstallOptions: target.installOptions,
    });
    if (!node.effectiveInstallOptions && target.installOptions) {
      node.effectiveInstallOptions = clone(target.installOptions);
    }
    visit(location, manifest, node);
  }

  const topologicalOrder = completionOrder
    .map((key) => nodesByKey.get(key)?.location)
    .filter((location): location is PluginLocation => Boolean(location));
  const reverseTopologicalOrder = [...topologicalOrder].reverse();

  const inheritedInstallOptionsByKey = new Map<string, InstalledScopeInstallOptions | undefined>();
  for (const key of reverseTopologicalOrder.map((location) => serializePluginLocation(location))) {
    const node = nodesByKey.get(key);
    if (!node) {
      continue;
    }
    const installedRecord = options.indexes.installedByLocation.get(key);
    if (!node.effectiveInstallOptions && installedRecord?.installOptions) {
      node.effectiveInstallOptions = clone(installedRecord.installOptions);
    }

    const nodeEdges = edges.filter((edge) => serializePluginLocation(edge.dependent) === key);
    for (const edge of nodeEdges) {
      if (edge.declaration.inheritInstallOptions !== true) {
        continue;
      }
      const dependencyKey = serializePluginLocation(edge.dependency);
      const dependencyNode = nodesByKey.get(dependencyKey);
      if (!dependencyNode || dependencyNode.action !== 'installDependency') {
        continue;
      }

      const nextValue = node.effectiveInstallOptions ? clone(node.effectiveInstallOptions) : undefined;
      const previousValue = inheritedInstallOptionsByKey.get(dependencyKey);
      if (
        inheritedInstallOptionsByKey.has(dependencyKey) &&
        stableStringifyInstallOptions(previousValue) !== stableStringifyInstallOptions(nextValue)
      ) {
        throw new Error(
          `依赖插件 ${dependencyNode.location.plugin} 收到冲突的安装选项；请先显式安装 ${dependencyNode.location.plugin}，或拆分本次 install 命令。`,
        );
      }

      inheritedInstallOptionsByKey.set(dependencyKey, nextValue);
      dependencyNode.effectiveInstallOptions = nextValue ? clone(nextValue) : undefined;
    }
  }

  const writeOrder = topologicalOrder.filter((location) => {
    const node = nodesByKey.get(serializePluginLocation(location));
    return node?.action !== 'none';
  });
  const nodesByLocation = Object.fromEntries(
    [...nodesByKey.entries()].map(([key, node]) => [
      key,
      createDependencyNodePlan(node, nodesByKey),
    ]),
  );

  return {
    mode: options.mode,
    requestedRoots,
    topologicalOrder,
    writeOrder,
    nodesByLocation,
    edges,
    preflight: createPreflight(writeOrder),
  };
}

export function planPluginDependencyWrites(options: {
  mode: PluginDependencyPlannerMode;
  state: PluginDependencyPlannerState;
  targets: PluginDependencyPlannerTarget[];
}): PluginDependencyWritePlan {
  const indexes = buildPlannerIndexes(options.state);
  return createWritePlan({
    mode: options.mode,
    indexes,
    targets: options.targets,
  });
}

function isLocationInScope(options: {
  location: PluginLocation;
  platform: PlatformName;
  scope: Scope;
  projectKeysByPlatform?: Partial<Record<PlatformName, string | null>>;
}): boolean {
  if (options.location.platform !== options.platform || options.location.scope !== options.scope) {
    return false;
  }
  if (options.scope === 'user') {
    return true;
  }
  return options.location.projectKey === (options.projectKeysByPlatform?.[options.platform] ?? null);
}

function isAccessibleAutoCleanupLocation(
  location: PluginLocation,
  projectKeysByPlatform: Map<PlatformName, string | null>,
): boolean {
  if (location.scope === 'user') {
    return true;
  }

  const projectKey = projectKeysByPlatform.get(location.platform);
  return Boolean(projectKey && projectKey === location.projectKey);
}

function buildIncomingIndexFromEdges(
  recordsByLocation: Map<string, NormalizedInstalledRecord>,
  edgeOverrides: Map<string, InstalledDependencyEdge[]>,
  removedLocations: Set<string>,
): Map<string, PluginLocation[]> {
  const incoming = new Map<string, Map<string, PluginLocation>>();

  for (const [dependentKey, record] of recordsByLocation.entries()) {
    if (removedLocations.has(dependentKey)) {
      continue;
    }
    const edges = edgeOverrides.get(dependentKey) ?? record.dependencyEdges ?? [];
    for (const rawEdge of edges) {
      const edge = normalizeInstalledDependencyEdge(rawEdge);
      const dependencyKey = serializePluginLocation(edge.dependency);
      if (removedLocations.has(dependencyKey)) {
        continue;
      }
      const bucket = incoming.get(dependencyKey) ?? new Map<string, PluginLocation>();
      bucket.set(`${dependentKey}\u0000${edge.declaration.name}`, record.location);
      incoming.set(dependencyKey, bucket);
    }
  }

  return new Map(
    [...incoming.entries()].map(([key, dependents]) => [
      key,
      [...dependents.values()].sort(comparePluginLocations),
    ]),
  );
}

function isAutoInstalledRecord(record: NormalizedInstalledRecord | undefined): boolean {
  return Boolean(
    record?.installSource &&
      record.installSource.kind === 'dependency' &&
      record.installSource.allowsUnusedCleanup === true,
  );
}

function canAutoRemoveRecord(options: {
  record: NormalizedInstalledRecord | undefined;
  indexes: PlannerIndexes;
  locationKey: string;
  incomingIndex: Map<string, PluginLocation[]>;
}): boolean {
  if (!options.record || !isAutoInstalledRecord(options.record)) {
    return false;
  }
  if (options.record.installSource?.explicitlyRequested === true) {
    return false;
  }
  if (!options.indexes.dependencyMetadataComplete) {
    return false;
  }
  if (!isHealthySatisfiedLocation(options.indexes, options.record.location)) {
    return false;
  }
  return (options.incomingIndex.get(options.locationKey) ?? []).length === 0;
}

function collectVisibleIncompleteDependencyMetadataLocations(options: {
  indexes: PlannerIndexes;
  visibleKeys: Set<string>;
}): PluginLocation[] {
  return [...options.indexes.installedByLocation.entries()]
    .filter(([locationKey, record]) => (
      options.visibleKeys.has(locationKey) &&
      !hasCompleteDependencyMetadata(record)
    ))
    .map(([, record]) => record.location)
    .sort(comparePluginLocations);
}

export function planPluginDependencyUpgradeAll(
  options: PluginDependencyUpgradeAllOptions,
): PluginDependencyUpgradeAllPlan {
  const indexes = buildPlannerIndexes(options.state);
  const requestedProjectKeysByPlatform = options.projectKeysByPlatform ?? {};
  const projectKeysByPlatform = new Map<PlatformName, string | null>();
  const candidateRoots = [...indexes.installedByLocation.values()]
    .filter((record) =>
      options.platforms.some((platform) => isLocationInScope({
        location: record.location,
        platform,
        scope: options.scope,
        projectKeysByPlatform: requestedProjectKeysByPlatform,
      })),
    )
    .sort((left, right) => comparePluginLocations(left.location, right.location));

  for (const platform of options.platforms) {
    projectKeysByPlatform.set(
      platform,
      options.scope === 'project' ? (requestedProjectKeysByPlatform[platform] ?? null) : null,
    );
  }

  const initialSkipsByKey = new Map<string, PluginDependencyUpgradeAllSkip>();
  for (const skip of options.initialSkipped ?? []) {
    const location = normalizePluginLocation(skip.location);
    initialSkipsByKey.set(serializePluginLocation(location), {
      location,
      reason: skip.reason,
      code: skip.code ?? 'directSkip',
    });
  }

  const roots = candidateRoots
    .filter((record) => record.installSource?.explicitlyRequested === true)
    .map((record) => record.location);
  const plan = createWritePlan({
    mode: 'upgrade',
    indexes,
    targets: roots
      .filter((location) => !initialSkipsByKey.has(serializePluginLocation(location)))
      .map((location) => ({
        location,
        installOptions: indexes.installedByLocation.get(serializePluginLocation(location))?.installOptions,
      })),
  });

  const graphEdgesByDependent = new Map<string, InstalledDependencyEdge[]>();
  for (const edge of plan.edges) {
    const key = serializePluginLocation(edge.dependent);
    const bucket = graphEdgesByDependent.get(key) ?? [];
    bucket.push({
      dependency: edge.dependency,
      declaration: edge.declaration,
    });
    graphEdgesByDependent.set(key, bucket);
  }

  const dependentsByDependency = new Map<string, PluginLocation[]>();
  for (const edge of plan.edges) {
    const dependencyKey = serializePluginLocation(edge.dependency);
    const bucket = dependentsByDependency.get(dependencyKey) ?? [];
    bucket.push(edge.dependent);
    dependentsByDependency.set(
      dependencyKey,
      bucket.sort(comparePluginLocations),
    );
  }

  const skippedByKey = new Map<string, PluginDependencyUpgradeAllSkip>(initialSkipsByKey);
  const queue = [...initialSkipsByKey.values()];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentKey = serializePluginLocation(current.location);
    for (const dependent of dependentsByDependency.get(currentKey) ?? []) {
      const dependentKey = serializePluginLocation(dependent);
      if (skippedByKey.has(dependentKey)) {
        continue;
      }
      const nextSkip: PluginDependencyUpgradeAllSkip = {
        location: dependent,
        code: 'dependencySkipped',
        reason: `依赖 ${current.location.plugin} 被跳过：${current.reason}`,
        blockedBy: current.location,
      };
      skippedByKey.set(dependentKey, nextSkip);
      queue.push(nextSkip);
    }
  }

  const skipped = [...skippedByKey.values()].sort((left, right) =>
    comparePluginLocations(left.location, right.location),
  );
  const skippedKeys = new Set(skipped.map((item) => serializePluginLocation(item.location)));
  const writeOrder = plan.writeOrder.filter((location) => !skippedKeys.has(serializePluginLocation(location)));
  const currentGraphKeys = new Set(plan.topologicalOrder.map((location) => serializePluginLocation(location)));

  const edgeOverrides = new Map<string, InstalledDependencyEdge[]>();
  for (const [locationKey, record] of indexes.installedByLocation.entries()) {
    if (currentGraphKeys.has(locationKey) && !skippedKeys.has(locationKey)) {
      edgeOverrides.set(locationKey, graphEdgesByDependent.get(locationKey) ?? []);
    } else {
      edgeOverrides.set(locationKey, record.dependencyEdges ?? []);
    }
  }

  const incomingAfterRefresh = buildIncomingIndexFromEdges(
    indexes.installedByLocation,
    edgeOverrides,
    new Set<string>(),
  );
  const autoCleanupCandidates = [...indexes.installedByLocation.entries()]
    .filter(([locationKey, record]) => (
      !currentGraphKeys.has(locationKey) &&
      isAccessibleAutoCleanupLocation(record.location, projectKeysByPlatform) &&
      canAutoRemoveRecord({
        record,
        indexes,
        locationKey,
        incomingIndex: incomingAfterRefresh,
      })
    ))
    .map(([, record]) => record.location)
    .sort(comparePluginLocations);

  return {
    roots,
    topologicalOrder: plan.topologicalOrder,
    writeOrder,
    nodesByLocation: plan.nodesByLocation,
    edges: plan.edges,
    skipped,
    autoCleanupCandidates,
    preflight: createPreflight(writeOrder),
  };
}

function topoSortLocations(options: {
  nodes: PluginLocation[];
  edgesByDependent: Map<string, InstalledDependencyEdge[]>;
}): PluginLocation[] {
  const nodesByKey = new Map(
    options.nodes.map((location) => [serializePluginLocation(location), normalizePluginLocation(location)]),
  );
  const completionOrder: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(locationKey: string): void {
    if (visited.has(locationKey)) {
      return;
    }
    if (visiting.has(locationKey)) {
      return;
    }
    visiting.add(locationKey);
    for (const edge of options.edgesByDependent.get(locationKey) ?? []) {
      const dependencyKey = serializePluginLocation(edge.dependency);
      if (nodesByKey.has(dependencyKey)) {
        visit(dependencyKey);
      }
    }
    visiting.delete(locationKey);
    visited.add(locationKey);
    completionOrder.push(locationKey);
  }

  for (const location of options.nodes) {
    visit(serializePluginLocation(location));
  }

  return completionOrder
    .map((key) => nodesByKey.get(key))
    .filter((location): location is PluginLocation => Boolean(location));
}

export function planPluginDependencyUninstall(options: {
  state: PluginDependencyPlannerState;
  requested: PluginLocation[];
}): PluginDependencyUninstallPlan {
  const indexes = buildPlannerIndexes(options.state);
  const requested = options.requested.map((location) => normalizePluginLocation(location));
  const requestedKeys = new Set(requested.map((location) => serializePluginLocation(location)));
  const visibleKeys = new Set<string>(requestedKeys);
  for (const [locationKey, health] of indexes.healthByLocation.entries()) {
    if (health.visible) {
      visibleKeys.add(locationKey);
    }
  }
  const incompleteMetadataLocations = collectVisibleIncompleteDependencyMetadataLocations({
    indexes,
    visibleKeys,
  });
  if (incompleteMetadataLocations.length > 0) {
    return {
      requested,
      blocked: [],
      incompleteMetadataLocations,
      uninstallOrder: [],
      autoCleanup: [],
    };
  }
  const incomingIndex = buildIncomingIndexFromEdges(
    indexes.installedByLocation,
    new Map<string, InstalledDependencyEdge[]>(),
    new Set<string>(),
  );
  const blocked: PluginDependencyUninstallBlock[] = requested
    .map((location) => {
      const dependents = (incomingIndex.get(serializePluginLocation(location)) ?? [])
        .filter((dependent) => !requestedKeys.has(serializePluginLocation(dependent)))
        .sort(comparePluginLocations);
      return { location, dependents };
    })
    .filter((entry) => entry.dependents.length > 0);

  if (blocked.length > 0) {
    return {
      requested,
      blocked,
      incompleteMetadataLocations: [],
      uninstallOrder: [],
      autoCleanup: [],
    };
  }

  return {
    requested,
    blocked: [],
    incompleteMetadataLocations: [],
    uninstallOrder: [...requested],
    autoCleanup: [],
  };
}

function buildCatalogDrift(options: {
  currentManifest: PluginManifestSource | undefined;
  snapshotManifest: PluginManifestSource | undefined;
}): PluginDependencyStatusCatalogDrift {
  if (!options.snapshotManifest) {
    return {
      kind: 'snapshotMissing',
      snapshotDependencies: [],
      currentDependencies: listDependencyNames(options.currentManifest),
    };
  }
  if (!options.currentManifest) {
    return {
      kind: 'currentCatalogMissing',
      snapshotDependencies: listDependencyNames(options.snapshotManifest),
      currentDependencies: [],
    };
  }

  return {
    kind: dependencySignature(options.snapshotManifest) === dependencySignature(options.currentManifest)
      ? 'none'
      : 'dependenciesChanged',
    snapshotDependencies: listDependencyNames(options.snapshotManifest),
    currentDependencies: listDependencyNames(options.currentManifest),
  };
}

export function projectPluginDependencyStatus(options: {
  state: PluginDependencyPlannerState;
  locations?: PluginLocation[];
}): PluginDependencyStatusProjection[] {
  const indexes = buildPlannerIndexes(options.state);
  const locations = options.locations
    ? options.locations.map((location) => normalizePluginLocation(location))
    : [...indexes.installedByLocation.values()].map((record) => record.location);

  return sortPluginLocations(locations).map((location) => {
    const locationKey = serializePluginLocation(location);
    const installedRecord = indexes.installedByLocation.get(locationKey);
    const currentManifest = indexes.currentCatalogByPlugin[location.plugin];
    const snapshotManifest = installedRecord?.snapshotManifest;
    const healthManifest = snapshotManifest ?? currentManifest;
    const healthSource: PluginDependencyManifestSource =
      snapshotManifest
        ? 'installedSnapshot'
        : currentManifest
          ? 'currentCatalogFallback'
          : 'none';

    if (snapshotManifest) {
      validateManifestDependencyStructure(location.plugin, snapshotManifest);
    }

    const resolved = healthManifest
      ? getEffectiveDependencyEntries(healthManifest, location.platform).map((entry) => ({
          declaration: entry,
          source: snapshotManifest ? 'installedSnapshot' as const : 'currentCatalogFallback' as const,
        }))
      : [];
    const satisfied: PluginDependencyStatusSatisfiedEntry[] = [];
    const missing: PluginDependencyStatusMissingEntry[] = [];

    for (const entry of resolved) {
      const resolution = resolveDependencyForStatus({
        indexes,
        dependent: location,
        entry: entry.declaration,
        allowFreshSearch: !snapshotManifest,
      });
      if (resolution.satisfied) {
        satisfied.push({
          declaration: entry.declaration,
          location: resolution.location,
        });
      } else {
        missing.push({
          declaration: entry.declaration,
          expectedLocation: resolution.expectedLocation,
          reason: snapshotManifest
            ? `缺少可复用的 canonical dependency edge，或目标位置当前不健康。`
            : `当前可见位置中没有满足依赖的健康安装。`,
        });
      }
    }

    const dependents = indexes.incomingDependentsByLocation.get(locationKey) ?? [];
    const simulatedIncoming = buildIncomingIndexFromEdges(
      indexes.installedByLocation,
      new Map<string, InstalledDependencyEdge[]>(),
      new Set<string>(),
    );
    return {
      location,
      healthSource,
      declared: (currentManifest?.dependencies?.plugins ?? []).map((entry) => normalizeDependencyEntry(entry)),
      resolved,
      satisfied,
      missing,
      dependents,
      autoInstalled: installedRecord?.installSource?.kind === 'dependency',
      autoRemovable: canAutoRemoveRecord({
        record: installedRecord,
        indexes,
        locationKey,
        incomingIndex: simulatedIncoming,
      }),
      catalogDrift: buildCatalogDrift({
        currentManifest,
        snapshotManifest,
      }),
    };
  });
}
