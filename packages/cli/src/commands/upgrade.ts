import {
  isCommandWarningError,
} from '../types.js';
import type {
  CatalogResolution,
  CodexCapabilitySnapshot,
  GeneratedArtifact,
  InstalledLedger,
  InstalledScopeRecord,
  PluginLocation,
  NativePluginsByPlatform,
  PlatformAdapter,
  PlatformName,
  PluginMeta,
  ResolvedInstallOptions,
  Scope,
  SkippedUpgradeCode,
  SkippedUpgradeTarget,
  TrackingManifest,
  UpgradeCommandOptions,
  UpgradeCommandResult,
} from '../types.js';
import {
  assertAgentVersionsForWriteTargets,
  collectCommandWarnings,
  createAdapters,
  formatPolicyProducts,
  getGeneratedArtifactIdentityRefusal,
  getTrackingArtifactIdentityRefusal,
  hasHistoricalEvidence,
  hasScopeManagedEvidence,
  loadPluginTargetsForCommand,
  listManagedPluginNamesForPreparedLedger,
  pluginSupportsPlatform,
  prepareCommandEnvironment,
  preparePluginTargetsForCommand,
  resolveCurrentCatalogWriteTargetPairs,
  resolveInstallOptionsForLocationTargets,
  resolveInstallOptionsForTargets,
  wrapCommandErrorWithWarnings,
  type ResolvedPluginTarget,
} from './common.js';
import {
  buildInstallPlannerContext,
  cleanupOrphanedAutoDependenciesAfterFailedInstall,
  commitInstalledScopeDependencyEdges,
  createPluginLocationForPlatform,
  disposePinnedCatalogRoot,
  ensureRollbackRemovedDependencyLocation,
  initializeInstalledScopeDependencyMetadata,
  installTargetsOnPlatforms,
  pinCatalogResolutionForLocalMarketplaceRebuild,
  pinCurrentCatalogTargetsForLocalMarketplaceRebuild,
  retargetCurrentCatalogTargetToCatalogRoot,
  resolveGraphInstallOptionsByLocation,
  resolveProjectKeysByPlatform,
  toInstalledScopeInstallOptions,
  type InstallLocationGraphContext,
} from './install.js';
import {
  createCommandExecutionContext,
  emitCommandEvent,
  type CommandExecutionContextInput,
} from './runtime.js';
import {
  applyCatalogSelectorEnv,
  normalizeUpgradeCommandOptions,
  type RawUpgradeCommandOptions,
} from './options.js';
import {
  createPluginConfigSchemaIdentity,
  preflightRequiredPluginConfigs,
} from '../utils/plugin-config.js';
import {
  assertCodexProjectInstallableTargets,
  getCodexProjectInstallability,
} from './codex-project-installability.js';
import {
  isCodexProjectWriteSafetyError,
  preflightCodexProjectWriteSafety,
} from './codex-project-safety.js';
import {
  assertNoDuplicateInstalls,
  shouldEnforceDuplicateInstallPreflight,
} from './scope-exclusivity-preflight.js';
import {
  uninstallTargetsOnPlatforms,
} from './uninstall.js';
import {
  resolveClaudeProjectKey,
  resolveClaudePaths,
  resolveCodexPaths,
  resolveCodexProjectKey,
} from '../utils/paths.js';
import {
  compareStrictSemVerFields,
} from '../utils/manifest.js';
import {
  readInstalledLedger,
  writeInstalledLedger,
} from '../utils/local-marketplace.js';
import {
  serializePluginLocation,
  sortPluginLocations,
} from '../utils/plugin-dependency-location.js';
import { createInstalledDependencyEdge } from '../utils/plugin-dependency-graph.js';
import { readCodexNativeRecoveryBreadcrumb } from '../utils/codex-native-recovery.js';
import {
  planPluginDependencyUpgradeAll,
  planPluginDependencyWrites,
  type PluginDependencyUpgradeAllSkip,
  type PluginDependencyUpgradeAllSkipInput,
  type PluginDependencyWritePlan,
} from '../utils/plugin-dependency-planner.js';
import {
  executePluginDependencyWriteGraph,
  type PluginDependencyWriteExecutorNode,
  type PluginDependencyWriteExecutorRollbackFailure,
} from './plugin-dependency-write-executor.js';
import {
  getTrackingArtifactIntegrityErrors,
  getTrackingRecord,
  readTrackingManifest,
} from '../utils/tracking.js';
import { mergeGeneratedArtifacts } from '../utils/generated-artifacts.js';
import { codexCapabilitySnapshotHasRepoManagedArtifacts } from '../utils/codex-project-surface.js';
import type { PluginStatusReport, StatusReport } from '../types.js';
import { readInstallRecordForLocation } from '../install-state/facade.js';
import type { InstallRecordFile } from '../install-state/types.js';

type UpgradeCommandRuntime = CommandExecutionContextInput & {
  catalogResolution?: CatalogResolution;
  marketplacePrepared?: boolean;
  resolveInstallOptions?: (
    platform: PlatformName,
    target: ResolvedPluginTarget,
  ) => ResolvedInstallOptions;
};

function bindCatalogResolutionToAdapters(
  adapters: Record<PlatformName, PlatformAdapter>,
  catalogResolution: CatalogResolution,
): Record<PlatformName, PlatformAdapter> {
  return Object.fromEntries(
    (Object.entries(adapters) as Array<[PlatformName, PlatformAdapter]>).map(([platform, adapter]) => [
      platform,
      {
        name: adapter.name,
        detect: (cwd) => adapter.detect(cwd),
        installPlugin: (plugin, scope, options) => adapter.installPlugin(plugin, scope, {
          ...options,
          catalogResolution,
        }),
        uninstallPlugin: (plugin, scope) => adapter.uninstallPlugin(plugin, scope),
        installExtensions: (plugin, scope, options) => adapter.installExtensions(plugin, scope, {
          ...options,
          catalogResolution,
        }),
        uninstallExtensions: (plugin, scope, generatedArtifacts) =>
          adapter.uninstallExtensions(plugin, scope, generatedArtifacts),
        upgradePlugin: (plugin, scope, options) => adapter.upgradePlugin(plugin, scope, {
          ...options,
          catalogResolution,
        }),
        status: (plugin, scope, options) => adapter.status(plugin, scope, {
          ...options,
          catalogResolution,
        }),
      } satisfies PlatformAdapter,
    ]),
  ) as Record<PlatformName, PlatformAdapter>;
}

function withEarlyDegradedLedgerWarning(
  warnings: string[],
  ledger: InstalledLedger,
): string[] {
  if (warnings.length > 0 || ledger.ledgerState.status !== 'degraded') {
    return warnings;
  }

  return [
    `installed.json 处于 degraded 状态（${ledger.ledgerState.reason ?? 'unknown'}），跳过 skill trigger 偏好 replay，保留 embedded pristine 默认策略。`,
  ];
}

function toPlannerInstallSource(
  source: InstallRecordFile['record']['installSource'] | undefined,
): InstalledScopeRecord<CodexCapabilitySnapshot>['installSource'] {
  if (!source) {
    return undefined;
  }
  return {
    kind: source.kind,
    explicitlyRequested: source.explicitlyRequested,
    allowsUnusedCleanup: source.kind === 'dependency' && source.explicitlyRequested === false,
  };
}

function toPlannerDependencyEdges(
  edges: InstallRecordFile['record']['dependencyEdges'] | undefined,
): InstalledScopeRecord<CodexCapabilitySnapshot>['dependencyEdges'] {
  return edges?.map((edge) => createInstalledDependencyEdge({
    dependency: {
      ...edge.dependency,
      projectKey: edge.dependency.projectKey ?? null,
    },
    declaration: structuredClone(edge.declaration),
  }));
}

type UpgradeAllTrackingState = 'none' | 'managed' | 'invalid';

interface UpgradeAllTrackingEvidence {
  state: UpgradeAllTrackingState;
  reason?: string;
}

interface UpgradeAllReadyTarget {
  platform: PlatformName;
  target: ResolvedPluginTarget;
}

interface UpgradeCommandReceiptTarget {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  requested: boolean;
  selectedVersion?: string;
  selectedVersionSource?: 'currentCatalog' | 'historical';
  dependencyOf?: Array<{
    plugin: string;
    platform: PlatformName;
    scope: Scope;
  }>;
}

interface UpgradeCommandReceiptAction {
  plugin: string;
  platform: PlatformName;
  scope: Scope;
  type: 'installDependency' | 'upgradeDependency';
  status: 'succeeded';
  requested?: boolean;
  selectedVersion?: string;
  selectedVersionSource?: 'currentCatalog' | 'historical';
  dependencyOf?: Array<{
    plugin: string;
    platform: PlatformName;
    scope: Scope;
  }>;
}

interface UpgradeLocationNodeResult {
  warnings: string[];
  nativePlugins: NativePluginsByPlatform;
  repoManagedArtifacts: GeneratedArtifact[];
}

function mergeUpgradeNodeResult(
  aggregate: UpgradeLocationNodeResult,
  next: UpgradeLocationNodeResult,
): UpgradeLocationNodeResult {
  const nativePlugins: NativePluginsByPlatform = {
    ...aggregate.nativePlugins,
  };
  for (const [platform, pluginNames] of Object.entries(next.nativePlugins) as Array<[PlatformName, string[]]>) {
    nativePlugins[platform] ??= [];
    for (const pluginName of pluginNames) {
      if (!nativePlugins[platform].includes(pluginName)) {
        nativePlugins[platform].push(pluginName);
      }
    }
  }

  return {
    warnings: [...aggregate.warnings, ...next.warnings],
    nativePlugins,
    repoManagedArtifacts: mergeGeneratedArtifacts(
      aggregate.repoManagedArtifacts,
      next.repoManagedArtifacts,
    ),
  };
}

function buildUpgradeGraphExecutorNodes(options: {
  plan: PluginDependencyWritePlan;
  graphContext: InstallLocationGraphContext;
}): PluginDependencyWriteExecutorNode[] {
  const outgoingEdgesByDependent = new Map<string, typeof options.plan.edges>();
  for (const edge of options.plan.edges) {
    const dependentKey = serializePluginLocation(edge.dependent);
    const bucket = outgoingEdgesByDependent.get(dependentKey) ?? [];
    bucket.push(edge);
    outgoingEdgesByDependent.set(dependentKey, bucket);
  }

  return options.plan.writeOrder.map((location) => {
    const key = serializePluginLocation(location);
    const node = options.plan.nodesByLocation[key];
    const installedRecord = options.graphContext.installedRecordByLocation.get(key);
    return {
      location,
      action: node.action,
      requested: node.requested,
      rollbackEligible: node.action === 'installDependency' && !installedRecord,
      dependencyOf: node.dependencyOf,
      outgoingEdges: outgoingEdgesByDependent.get(key) ?? [],
    };
  });
}

function createUpgradeReceiptTargets(
  plan: PluginDependencyWritePlan,
  targetByPlugin: ReadonlyMap<string, ResolvedPluginTarget>,
  skippedTargets: UpgradeCommandReceiptTarget[] = [],
): UpgradeCommandReceiptTarget[] {
  return [
    ...plan.writeOrder.map((location) => {
      const node = plan.nodesByLocation[serializePluginLocation(location)];
      const target = targetByPlugin.get(location.plugin);
      return {
        plugin: location.plugin,
        platform: location.platform,
        scope: location.scope,
        requested: node?.requested === true,
        ...(target
          ? {
              selectedVersion: target.plugin.manifest.version,
              selectedVersionSource: target.source === 'historical' ? 'historical' as const : 'currentCatalog' as const,
            }
          : {}),
        ...(node?.dependencyOf.length
          ? {
              dependencyOf: node.dependencyOf.map((dependencyOf) => ({
                plugin: dependencyOf.plugin,
                platform: dependencyOf.platform,
                scope: dependencyOf.scope,
              })),
            }
          : {}),
      };
    }),
    ...skippedTargets,
  ];
}

function createUpgradeSkippedReceiptTargets(options: {
  plan: PluginDependencyWritePlan;
  skipped: PluginDependencyUpgradeAllSkip[];
  requestedRoots: PluginLocation[];
  targetByPlugin: ReadonlyMap<string, ResolvedPluginTarget>;
}): UpgradeCommandReceiptTarget[] {
  const requestedRootKeys = new Set(
    options.requestedRoots.map((location) => serializePluginLocation(location)),
  );
  return options.skipped.map((entry) => {
    const node = options.plan.nodesByLocation[serializePluginLocation(entry.location)];
    const target = options.targetByPlugin.get(entry.location.plugin);
    return {
      plugin: entry.location.plugin,
      platform: entry.location.platform,
      scope: entry.location.scope,
      requested: node?.requested ?? requestedRootKeys.has(serializePluginLocation(entry.location)),
      ...(target
        ? {
            selectedVersion: target.plugin.manifest.version,
            selectedVersionSource: target.source === 'historical' ? 'historical' as const : 'currentCatalog' as const,
          }
        : {}),
      ...(node?.dependencyOf.length
        ? {
            dependencyOf: node.dependencyOf.map((dependencyOf) => ({
              plugin: dependencyOf.plugin,
              platform: dependencyOf.platform,
              scope: dependencyOf.scope,
            })),
          }
        : {}),
    };
  });
}

function createUpgradeSkippedTargetMetadata(options: {
  plan: PluginDependencyWritePlan;
  skipped: PluginDependencyUpgradeAllSkip;
  requestedRoots: PluginLocation[];
}): Pick<SkippedUpgradeTarget, 'requested' | 'dependencyOf'> {
  const requestedRootKeys = new Set(
    options.requestedRoots.map((location) => serializePluginLocation(location)),
  );
  const node = options.plan.nodesByLocation[serializePluginLocation(options.skipped.location)];
  return {
    requested: node?.requested ?? requestedRootKeys.has(serializePluginLocation(options.skipped.location)),
    ...(node?.dependencyOf.length
      ? {
          dependencyOf: node.dependencyOf.map((dependencyOf) => ({
            plugin: dependencyOf.plugin,
            platform: dependencyOf.platform,
            scope: dependencyOf.scope,
          })),
        }
      : {}),
  };
}

function createUpgradeReceiptActions(
  plan: PluginDependencyWritePlan,
  targetByPlugin: ReadonlyMap<string, ResolvedPluginTarget>,
): UpgradeCommandReceiptAction[] {
  return plan.writeOrder
    .filter((location) => {
      const action = plan.nodesByLocation[serializePluginLocation(location)]?.action;
      return action === 'installDependency' || action === 'upgradeDependency';
    })
    .map((location) => {
      const action = plan.nodesByLocation[serializePluginLocation(location)]!.action;
      const target = targetByPlugin.get(location.plugin);
      return {
        plugin: location.plugin,
        platform: location.platform,
        scope: location.scope,
        type: action === 'installDependency' ? 'installDependency' : 'upgradeDependency',
        status: 'succeeded' as const,
        requested: plan.nodesByLocation[serializePluginLocation(location)]?.requested === true,
        ...(target
          ? {
              selectedVersion: target.plugin.manifest.version,
              selectedVersionSource: target.source === 'historical' ? 'historical' as const : 'currentCatalog' as const,
            }
          : {}),
        ...(plan.nodesByLocation[serializePluginLocation(location)]?.dependencyOf.length
          ? {
              dependencyOf: plan.nodesByLocation[serializePluginLocation(location)]!.dependencyOf.map((dependencyOf) => ({
                plugin: dependencyOf.plugin,
                platform: dependencyOf.platform,
                scope: dependencyOf.scope,
              })),
            }
          : {}),
      };
    });
}

function collectUpgradeAllExplicitRootLocations(options: {
  ledger: InstalledLedger;
  platforms: PlatformName[];
  scope: Scope;
  scopeKeys: Record<PlatformName, string | undefined>;
}): PluginLocation[] {
  const locations = new Map<string, PluginLocation>();

  for (const [pluginName] of Object.entries(options.ledger.plugins)) {
    for (const platform of options.platforms) {
      const scopeRecord = getUpgradeAllInstalledScopeRecord(
        options.ledger,
        pluginName,
        platform,
        options.scope,
        options.scopeKeys,
      );
      if (
        !scopeRecord ||
        scopeRecord.managed !== true ||
        scopeRecord.installSource?.explicitlyRequested !== true
      ) {
        continue;
      }

      const location = createPluginLocationForPlatform({
        plugin: pluginName,
        platform,
        scope: options.scope,
        projectKeysByPlatform: {
          codex: options.scopeKeys.codex ?? null,
          claude: options.scopeKeys.claude ?? null,
        },
      });
      locations.set(serializePluginLocation(location), location);
    }
  }

  return sortPluginLocations([...locations.values()]);
}

async function preserveDependencyInstallSourceForRequestedUpgrade(options: {
  location: PluginLocation;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const ledger = await readInstalledLedger(options.env);
  const pluginRecord = ledger.plugins[options.location.plugin];
  const platformRecord = pluginRecord?.platforms[options.location.platform];
  if (!platformRecord) {
    throw new Error(`缺少 ${options.location.platform}/${options.location.plugin} (${options.location.scope}) 的 ledger platform record。`);
  }

  const scopeRecord = options.location.scope === 'user'
    ? platformRecord.userScope
    : options.location.projectKey
      ? platformRecord.projectScopes?.[options.location.projectKey]
      : undefined;
  if (!scopeRecord) {
    throw new Error(`缺少 ${options.location.platform}/${options.location.plugin} (${options.location.scope}) 的 ledger scope record。`);
  }

  scopeRecord.installSource = {
    kind: 'dependency',
    explicitlyRequested: true,
    allowsUnusedCleanup: false,
  };
  await writeInstalledLedger(ledger, options.env);
}

function collectAccessibleInstalledLocations(options: {
  ledger: InstalledLedger;
  platforms: PlatformName[];
  scope: Scope;
  projectKeysByPlatform: Record<PlatformName, string | null>;
  allowedPlugins: Set<string>;
}): PluginLocation[] {
  const locations = new Map<string, PluginLocation>();

  for (const [pluginName, pluginRecord] of Object.entries(options.ledger.plugins)) {
    if (!options.allowedPlugins.has(pluginName)) {
      continue;
    }

    for (const platform of options.platforms) {
      const platformRecord = pluginRecord.platforms[platform];
      if (!platformRecord) {
        continue;
      }

      if (platformRecord.userScope) {
        const userLocation = createPluginLocationForPlatform({
          plugin: pluginName,
          platform,
          scope: 'user',
          projectKeysByPlatform: options.projectKeysByPlatform,
        });
        locations.set(serializePluginLocation(userLocation), userLocation);
      }

      if (options.scope !== 'project') {
        continue;
      }

      const projectKey = options.projectKeysByPlatform[platform];
      if (!projectKey) {
        continue;
      }

      if (platformRecord.projectScopes?.[projectKey]) {
        const projectLocation = createPluginLocationForPlatform({
          plugin: pluginName,
          platform,
          scope: 'project',
          projectKeysByPlatform: options.projectKeysByPlatform,
        });
        locations.set(serializePluginLocation(projectLocation), projectLocation);
      }
    }
  }

  return sortPluginLocations([...locations.values()]);
}

function createCodexUserRepairSuggestion(pluginName: string): string {
  return `请先运行 aw install ${pluginName} -p codex -s user 修复，或运行 aw uninstall ${pluginName} -p codex -s user 清理。`;
}

function createUpgradeCleanupRequiredReason(options: {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  detail: string;
}): string {
  return `${options.pluginName} 在 ${options.platform} (${options.scope}) 缺少可用于 upgrade 的有效 install record：${options.detail}。请先运行 aw cleanup、aw reinstall 或重新 install。`;
}

function hasUpgradeReadyManagedEvidence(
  pluginStatus: PluginStatusReport,
  platform: PlatformName,
  scope: Scope,
): boolean {
  if (platform === 'codex' && scope === 'user') {
    return Boolean(
      pluginStatus.scopeManagedEvidence?.ledger ||
        pluginStatus.scopeManagedEvidence?.tracking,
    );
  }

  return hasScopeManagedEvidence(pluginStatus);
}

function getCodexUserUpgradeBlockReason(
  pluginName: string,
  pluginStatus: PluginStatusReport,
  scope: Scope,
  platform: PlatformName,
): string | null {
  if (platform !== 'codex' || scope !== 'user') {
    return null;
  }

  const hasCompleteManagedEvidence = hasUpgradeReadyManagedEvidence(
    pluginStatus,
    platform,
    scope,
  );
  if (hasCompleteManagedEvidence) {
    return null;
  }

  if (pluginStatus.native.recovery?.present === true) {
    return `${pluginName} 当前只有 Codex native recovery breadcrumb，安装尚未完整成功；${createCodexUserRepairSuggestion(pluginName)}`;
  }

  if (pluginStatus.scopeManagedEvidence?.sharedNativeRef === true) {
    return `${pluginName} 当前只剩 Codex shared native ref，不能证明该 scope 安装已完整成功；${createCodexUserRepairSuggestion(pluginName)}`;
  }

  if (
    pluginStatus.native.pluginInstalled &&
    pluginStatus.native.pluginEnabled !== true
  ) {
    return `${pluginName} 当前只发现 Codex cache 残留，AW 缺少成功账本或 recovery breadcrumb 证明归属；不能直接 upgrade。请先人工确认归属，再决定是否手动清理。`;
  }

  return null;
}

function getOnlyPluginStatus(
  status: StatusReport,
  platform: PlatformName,
  pluginName: string,
): PluginStatusReport {
  const pluginStatus = status.plugins[0];
  if (!pluginStatus) {
    throw new Error(`无法读取 ${platform}/${pluginName} 的当前状态。`);
  }

  return pluginStatus;
}

async function readUpgradeTargetStatus(
  adapters: Record<PlatformName, PlatformAdapter>,
  platform: PlatformName,
  target: ResolvedPluginTarget,
  scope: Scope,
  catalogResolution: CatalogResolution,
): Promise<PluginStatusReport> {
  const status = await adapters[platform].status(target.currentPlugin ?? target.plugin, scope, {
    catalogResolution,
  });
  return getOnlyPluginStatus(status, platform, target.pluginName);
}

async function preflightExplicitUpgradeTargets(
  requestedLocations: PluginLocation[],
  targetByPlugin: Map<string, ResolvedPluginTarget>,
  options: UpgradeCommandOptions,
  adapters: Record<PlatformName, PlatformAdapter>,
  env: NodeJS.ProcessEnv,
  catalogResolution: CatalogResolution,
): Promise<void> {
  for (const location of requestedLocations) {
    const target = targetByPlugin.get(location.plugin);
    if (!target) {
      throw new Error(`Unknown plugin "${location.plugin}".`);
    }
    const pluginStatus = await readUpgradeTargetStatus(
      adapters,
      location.platform,
      target,
      options.scope,
      catalogResolution,
    );

    if (
      pluginStatus.externalOwnership?.present &&
      !(location.platform === 'codex' && options.scope === 'project')
    ) {
      throw new Error(pluginStatus.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
    }

    const codexUserUpgradeBlockReason = getCodexUserUpgradeBlockReason(
      target.pluginName,
      pluginStatus,
      options.scope,
      location.platform,
    );
    if (codexUserUpgradeBlockReason) {
      throw new Error(codexUserUpgradeBlockReason);
    }

    if (target.source === 'historical' && !hasHistoricalEvidence(pluginStatus)) {
      throw new Error(`Unknown plugin "${target.pluginName}".`);
    }

    const trackingIdentityRefusal = await getTrackingArtifactIdentityRefusal({
      cwd: options.cwd,
      env,
      platform: location.platform,
      scope: options.scope,
      pluginName: target.pluginName,
    });
    if (trackingIdentityRefusal) {
      throw new Error(trackingIdentityRefusal);
    }

    const identityRefusal = getGeneratedArtifactIdentityRefusal(pluginStatus);
    if (identityRefusal) {
      throw new Error(identityRefusal);
    }

    if (pluginStatus.catalogCompatibility === 'missing') {
      throw new Error(`${target.pluginName} 当前 catalog 已缺失，请先执行 uninstall。`);
    }

    if (!target.currentPlugin) {
      throw new Error(`${target.pluginName} 当前 catalog 已缺失，请先执行 uninstall。`);
    }
  }
}

async function preflightExplicitCodexUserRecoveryOnlyTargets(options: {
  pluginNames: string[];
  commandOptions: UpgradeCommandOptions;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  if (
    options.commandOptions.scope !== 'user' ||
    (options.commandOptions.platform !== 'codex' && options.commandOptions.platform !== 'both') ||
    options.pluginNames.length === 0
  ) {
    return;
  }

  const ledger = await readInstalledLedger(options.env);
  for (const pluginName of options.pluginNames) {
    const hasManagedLedgerEvidence =
      ledger.plugins[pluginName]?.platforms.codex?.userScope?.managed === true;
    if (hasManagedLedgerEvidence) {
      continue;
    }

    if (await readCodexNativeRecoveryBreadcrumb(pluginName, options.env)) {
      throw new Error(
        `${pluginName} 当前只有 Codex native recovery breadcrumb，安装尚未完整成功；${createCodexUserRepairSuggestion(pluginName)}`,
      );
    }
  }
}

function createSkippedUpgradeTarget(
  platform: PlatformName,
  scope: Scope,
  plugin: string,
  code: SkippedUpgradeCode,
  reason: string,
  metadata?: Pick<SkippedUpgradeTarget, 'requested' | 'dependencyOf'>,
): SkippedUpgradeTarget {
  return {
    platform,
    scope,
    plugin,
    code,
    reason,
    ...(metadata?.requested !== undefined ? { requested: metadata.requested } : {}),
    ...(metadata?.dependencyOf
      ? {
          dependencyOf: metadata.dependencyOf,
        }
      : {}),
  };
}

interface PreparedExplicitUpgradeGraph {
  plan: PluginDependencyWritePlan;
  graphContext: InstallLocationGraphContext;
}

async function prepareExplicitUpgradeGraph(options: {
  requestedLocations: PluginLocation[];
  commandOptions: UpgradeCommandOptions;
  adapters: Record<PlatformName, PlatformAdapter>;
  env: NodeJS.ProcessEnv;
  ledger: InstalledLedger;
  catalogResolution: CatalogResolution;
}): Promise<PreparedExplicitUpgradeGraph> {
  const allCatalogTargets = await loadPluginTargetsForCommand(
    options.commandOptions.cwd,
    options.commandOptions.scope,
    undefined,
    {
      catalogMode: 'readOnly',
      allowHistoricalFallback: false,
      env: options.env,
      catalogResolution: options.catalogResolution,
    },
  );
  const targetByPlugin = new Map<string, ResolvedPluginTarget>(
    allCatalogTargets.map((target) => [target.pluginName, target]),
  );
  const platforms = [...new Set(options.requestedLocations.map((location) => location.platform))];
  const projectKeysByPlatform = await resolveProjectKeysByPlatform(
    options.commandOptions.cwd,
    options.commandOptions.scope,
    platforms,
  );
  const requestedLocations = options.requestedLocations.map((location) =>
    createPluginLocationForPlatform({
      plugin: location.plugin,
      platform: location.platform,
      scope: location.scope,
      projectKeysByPlatform,
    }));
  const rootInstallOptionsByLocation = await resolveInstallOptionsForLocationTargets(
    'upgrade',
    requestedLocations.map((location) => {
      const target = targetByPlugin.get(location.plugin);
      if (!target) {
        throw new Error(`插件 ${location.plugin} 在 current catalog 中不存在。`);
      }
      return {
        location,
        target,
        requestedSkillTrigger: options.commandOptions.requestedSkillTrigger,
      };
    }),
    {
      cwd: options.commandOptions.cwd,
      env: options.env,
    },
    options.ledger,
  );
  const plannerTargets = requestedLocations.map((location) => ({
    location,
    installOptions: toInstalledScopeInstallOptions(rootInstallOptionsByLocation.get(serializePluginLocation(location))),
  }));
  const { plannerState, graphContext } = await buildInstallPlannerContext({
    requestedLocations,
    targetByPlugin,
    adapters: options.adapters,
    scope: options.commandOptions.scope,
    cwd: options.commandOptions.cwd,
    env: options.env,
    ledger: options.ledger,
    projectKeysByPlatform,
    readStatusForRequestedLocations: true,
    catalogResolution: options.catalogResolution,
  });
  for (const location of requestedLocations) {
    const key = serializePluginLocation(location);
    const installRecord = await readInstallRecordForLocation({
      cwd: options.commandOptions.cwd,
      location,
      env: options.env,
    });
    if (installRecord.status !== 'ok') {
      throw new Error(createUpgradeCleanupRequiredReason({
        pluginName: location.plugin,
        platform: location.platform,
        scope: location.scope,
        detail: installRecord.status === 'missing'
          ? 'record 缺失'
          : `${installRecord.code}${installRecord.error ? `: ${installRecord.error}` : ''}`,
      }));
    }

    const plannerRecord = plannerState.installedRecords?.find((record) =>
      serializePluginLocation(record.location) === key);
    if (plannerRecord) {
      plannerRecord.resolvedVersion = installRecord.value.record.source.pluginVersion;
      plannerRecord.installSource = toPlannerInstallSource(installRecord.value.record.installSource);
      plannerRecord.dependencyEdges = toPlannerDependencyEdges(installRecord.value.record.dependencyEdges);
      plannerRecord.installOptions = installRecord.value.record.options
        ? structuredClone(installRecord.value.record.options)
        : undefined;
    }
  }

  return {
    plan: planPluginDependencyWrites({
      mode: 'upgrade',
      state: plannerState,
      targets: plannerTargets,
    }),
    graphContext,
  };
}

async function resolveUpgradeAllScopeKeys(
  cwd: string,
  scope: Scope,
): Promise<Record<PlatformName, string | undefined>> {
  if (scope === 'user') {
    return {
      codex: undefined,
      claude: undefined,
    };
  }

  const [codexProjectKey, claudeProjectKey] = await Promise.all([
    resolveCodexProjectKey(cwd),
    resolveClaudeProjectKey(cwd),
  ]);
  return {
    codex: codexProjectKey,
    claude: claudeProjectKey,
  };
}

function getUpgradeAllInstalledScopeRecord(
  ledger: InstalledLedger,
  pluginName: string,
  platform: PlatformName,
  scope: Scope,
  scopeKeys: Record<PlatformName, string | undefined>,
): InstalledScopeRecord<Record<string, unknown>> | undefined {
  const platformRecord = ledger.plugins[pluginName]?.platforms[platform];
  if (!platformRecord) {
    return undefined;
  }

  if (scope === 'user') {
    return platformRecord.userScope as InstalledScopeRecord<Record<string, unknown>> | undefined;
  }

  const scopeKey = scopeKeys[platform];
  return scopeKey
    ? platformRecord.projectScopes?.[scopeKey] as InstalledScopeRecord<Record<string, unknown>> | undefined
    : undefined;
}

function hasCompleteUpgradeAllLedgerEvidence(
  scopeRecord: InstalledScopeRecord<Record<string, unknown>> | undefined,
  platform: PlatformName,
  scope: Scope,
): boolean {
  if (scopeRecord?.managed !== true) {
    return false;
  }

  if (platform !== 'codex' || scope !== 'project') {
    return true;
  }

  return codexCapabilitySnapshotHasRepoManagedArtifacts(
    scopeRecord.capabilitySnapshot as CodexCapabilitySnapshot | undefined,
  );
}

function resolveTrackingDirForPlatform(
  cwd: string,
  platform: PlatformName,
  scope: Scope,
  env: NodeJS.ProcessEnv,
): string {
  return platform === 'codex'
    ? resolveCodexPaths(cwd, scope, env).trackingDir
    : resolveClaudePaths(cwd, scope, env).trackingDir;
}

async function readUpgradeAllTrackingManifest(
  cwd: string,
  platform: PlatformName,
  scope: Scope,
  env: NodeJS.ProcessEnv,
): Promise<{
  manifest?: TrackingManifest;
  readError?: string;
}> {
  const trackingDir = resolveTrackingDirForPlatform(cwd, platform, scope, env);
  try {
    return {
      manifest: await readTrackingManifest(trackingDir),
    };
  } catch (error) {
    return {
      readError: `${trackingDir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function getUpgradeAllTrackingEvidenceForTarget(
  manifest: TrackingManifest | undefined,
  readError: string | undefined,
  pluginName: string,
  platform: PlatformName,
): UpgradeAllTrackingEvidence {
  if (readError) {
    return {
      state: 'invalid',
      reason: `无法读取 tracking manifest：${readError}`,
    };
  }

  const record = manifest ? getTrackingRecord(manifest, pluginName) : undefined;
  const platformArtifacts = (record?.artifacts ?? []).filter((artifact) => artifact.platform === platform);
  if (platformArtifacts.length === 0) {
    return {
      state: 'none',
    };
  }

  const integrityErrors = getTrackingArtifactIntegrityErrors(platformArtifacts);
  if (integrityErrors.length > 0) {
    return {
      state: 'invalid',
      reason: integrityErrors.map((error) => error.message).join('；'),
    };
  }

  return {
    state: 'managed',
  };
}

function mergeNativePlugins(
  target: NativePluginsByPlatform,
  source: NativePluginsByPlatform | undefined,
): void {
  if (!source) {
    return;
  }

  for (const [platform, pluginNames] of Object.entries(source) as Array<[PlatformName, string[] | undefined]>) {
    if (!pluginNames || pluginNames.length === 0) {
      continue;
    }
    target[platform] ??= [];
    for (const pluginName of pluginNames) {
      if (!target[platform].includes(pluginName)) {
        target[platform].push(pluginName);
      }
    }
  }
}

async function listCodexProjectUpgradeAllNativeRunnerRequiredNames(
  cwd: string,
  ledger: InstalledLedger,
): Promise<string[]> {
  const projectKey = await resolveCodexProjectKey(cwd);
  return Object.entries(ledger.plugins)
    .filter(([, record]) => {
      const scopeRecord = record.platforms.codex?.projectScopes?.[projectKey];
      if (scopeRecord?.managed !== true) {
        return false;
      }

      return !codexCapabilitySnapshotHasRepoManagedArtifacts(scopeRecord.capabilitySnapshot);
    })
    .map(([pluginName]) => pluginName)
    .sort();
}

async function preflightUpgradeConfigs(
  targets: ResolvedPluginTarget[],
  options: UpgradeCommandOptions,
  runtime: UpgradeCommandRuntime,
): Promise<void> {
  const context = createCommandExecutionContext(runtime);
  await preflightRequiredPluginConfigs({
    targets: targets
      .filter((target) => target.currentPlugin)
      .map((target) => ({
        pluginName: target.pluginName,
        manifest: target.currentPlugin!.manifest,
        schemaSourceIdentity: createPluginConfigSchemaIdentity(target.currentPlugin!.manifest),
      })),
    cwd: options.cwd,
    defaultScope: options.scope,
    context,
    interactive: true,
  });
}

async function resolveUpgradeAllPlatforms(
  requestedPlatform: UpgradeCommandOptions['platform'],
  _cwd: string,
  _scope: UpgradeCommandOptions['scope'],
  _preparedLedger: Awaited<ReturnType<typeof prepareCommandEnvironment>>['ledger'],
  _env: NodeJS.ProcessEnv,
): Promise<PlatformName[]> {
  if (requestedPlatform === 'codex' || requestedPlatform === 'claude') {
    return [requestedPlatform];
  }

  if (requestedPlatform === 'both') {
    return ['codex', 'claude'];
  }

  const exhaustive: never = requestedPlatform;
  throw new Error(`Unsupported platform "${exhaustive}". Expected one of: codex, claude, both.`);
}

async function requiresRuntimeWritableMarketplaceForUpgradeAll(
  platforms: PlatformName[],
  scope: UpgradeCommandOptions['scope'],
  cwd: string,
  ledger: InstalledLedger,
): Promise<boolean> {
  if (platforms.includes('claude')) {
    return true;
  }

  if (!platforms.includes('codex')) {
    return false;
  }

  if (scope === 'user') {
    return true;
  }

  return (await listCodexProjectUpgradeAllNativeRunnerRequiredNames(cwd, ledger)).length > 0;
}

async function evaluateUpgradeAllTarget(options: {
  platform: PlatformName;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  target: ResolvedPluginTarget;
  adapters: Record<PlatformName, PlatformAdapter>;
  ledger: InstalledLedger;
  scopeKeys: Record<PlatformName, string | undefined>;
  trackingManifests: Partial<Record<PlatformName, { manifest?: TrackingManifest; readError?: string }>>;
  commandOptions: UpgradeCommandOptions;
  catalogResolution: CatalogResolution;
}): Promise<{
  ready?: UpgradeAllReadyTarget;
  resolvedInstallOptions?: ResolvedInstallOptions;
  skipped?: SkippedUpgradeTarget;
}> {
  const {
    platform,
    scope,
    cwd,
    env,
    target,
    adapters,
    ledger,
    scopeKeys,
    trackingManifests,
    commandOptions,
  } = options;

  const scopeRecord = getUpgradeAllInstalledScopeRecord(
    ledger,
    target.pluginName,
    platform,
    scope,
    scopeKeys,
  );
  const trackingEvidence = getUpgradeAllTrackingEvidenceForTarget(
    trackingManifests[platform]?.manifest,
    trackingManifests[platform]?.readError,
    target.pluginName,
    platform,
  );
  const location = createPluginLocationForPlatform({
    plugin: target.pluginName,
    platform,
    scope,
    projectKeysByPlatform: {
      codex: scopeKeys.codex ?? null,
      claude: scopeKeys.claude ?? null,
    },
  });
  const installRecord = await readInstallRecordForLocation({
    cwd,
    location,
    env,
  });

  if (platform === 'codex' && scope === 'project') {
    try {
      await preflightCodexProjectWriteSafety({
        targets: [target],
        platforms: [platform],
        cwd,
        scope,
        env,
        operation: 'upgrade',
      });
    } catch (error) {
      if (!isCodexProjectWriteSafetyError(error)) {
        throw error;
      }

      return {
        skipped: createSkippedUpgradeTarget(
          platform,
          scope,
          target.pluginName,
          error.code,
          error.message,
        ),
      };
    }
  } else {
    const trackingIdentityRefusal = await getTrackingArtifactIdentityRefusal({
      cwd,
      env,
      platform,
      scope,
      pluginName: target.pluginName,
    });
    if (trackingIdentityRefusal) {
      return {
        skipped: createSkippedUpgradeTarget(
          platform,
          scope,
          target.pluginName,
          'trackingIntegrityError',
          trackingIdentityRefusal,
        ),
      };
    }
  }

  const pluginStatus = await readUpgradeTargetStatus(
    adapters,
    platform,
    target,
    scope,
    options.catalogResolution,
  );

  if (platform === 'codex' && scope === 'project') {
    if (
      pluginStatus.externalOwnership?.checkState === 'unknown' ||
      pluginStatus.projectTrust === 'unknown'
    ) {
      return {
        skipped: createSkippedUpgradeTarget(
          platform,
          scope,
          target.pluginName,
          'externalOwnershipUnknown',
          pluginStatus.externalOwnership?.details ??
            `${target.pluginName} 在 Codex project scope 的 external ownership / project trust 当前无法可靠判定。`,
        ),
      };
    }
    if (pluginStatus.externalOwnership?.present) {
      return {
        skipped: createSkippedUpgradeTarget(
          platform,
          scope,
          target.pluginName,
          'externalOwnershipPresent',
          pluginStatus.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。',
        ),
      };
    }
  } else if (pluginStatus.externalOwnership?.present) {
    throw new Error(pluginStatus.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
  }

  const codexUserUpgradeBlockReason = getCodexUserUpgradeBlockReason(
    target.pluginName,
    pluginStatus,
    scope,
    platform,
  );
  if (codexUserUpgradeBlockReason) {
    return {
      skipped: createSkippedUpgradeTarget(
        platform,
        scope,
        target.pluginName,
        'cleanupRequired',
        codexUserUpgradeBlockReason,
      ),
    };
  }

  if (installRecord.status !== 'ok') {
    return {
      skipped: createSkippedUpgradeTarget(
        platform,
        scope,
        target.pluginName,
        'cleanupRequired',
        createUpgradeCleanupRequiredReason({
          pluginName: target.pluginName,
          platform,
          scope,
          detail: installRecord.status === 'missing'
            ? 'record 缺失'
            : `${installRecord.code}${installRecord.error ? `: ${installRecord.error}` : ''}`,
        }),
      ),
    };
  }

  if (
    !hasCompleteUpgradeAllLedgerEvidence(scopeRecord, platform, scope) &&
    trackingEvidence.state === 'none'
  ) {
    return {
      skipped: createSkippedUpgradeTarget(
        platform,
        scope,
        target.pluginName,
        'cleanupRequired',
        createUpgradeCleanupRequiredReason({
          pluginName: target.pluginName,
          platform,
          scope,
          detail: '只有 legacy ledger / tracking 证据，没有可验证 install record',
        }),
      ),
    };
  }

  if (!target.currentPlugin || pluginStatus.catalogCompatibility === 'missing') {
    return {
      skipped: createSkippedUpgradeTarget(
        platform,
        scope,
        target.pluginName,
        'catalogNotCurrent',
        `${target.pluginName} 当前 catalog 已缺失，请先执行 uninstall。`,
      ),
    };
  }

  if (scopeRecord?.resolvedVersion) {
    const versionComparison = compareStrictSemVerFields({
      left: {
        value: target.currentPlugin.manifest.version,
        fieldPath: 'current plugin manifest.version',
      },
      right: {
        value: scopeRecord.resolvedVersion,
        fieldPath: 'installed ledger resolvedVersion',
      },
    });
    if (versionComparison.kind === 'invalid') {
      return {
        skipped: createSkippedUpgradeTarget(
          platform,
          scope,
          target.pluginName,
          'cleanupRequired',
          versionComparison.issues.map((issue) => issue.message).join(' '),
        ),
      };
    }
    if (versionComparison.relation < 0) {
      return {
        skipped: createSkippedUpgradeTarget(
          platform,
          scope,
          target.pluginName,
          'cleanupRequired',
          `已安装版本 ${versionComparison.right.raw} 高于 current catalog 版本 ${versionComparison.left.raw}；请先检查 catalog 或修复当前安装状态。`,
        ),
      };
    }
  }

  if (platform === 'codex' && scope === 'project') {
    const installability = getCodexProjectInstallability(target.currentPlugin);
    if (!installability.installable) {
      return {
        skipped: createSkippedUpgradeTarget(
          platform,
          scope,
          target.pluginName,
          'catalogNotProjectInstallable',
          installability.reason ?? `${target.pluginName} 当前 catalog 版本不再支持 Codex project upgrade。`,
        ),
      };
    }
  }

  let resolvedInstallOptions: ResolvedInstallOptions;
  try {
    const resolved = await resolveInstallOptionsForTargets(
      'upgrade-all',
      [target],
      [platform],
      {
        ...commandOptions,
        cwd,
        scope,
        env,
      },
      ledger,
    );
    resolvedInstallOptions = [...resolved.values()][0]!;
  } catch (error) {
    if (isCommandWarningError(error)) {
      return {
        skipped: createSkippedUpgradeTarget(
          platform,
          scope,
          target.pluginName,
          'installOptionsUnavailable',
          error.message,
        ),
      };
    }
    throw error;
  }

  return {
    ready: {
      platform,
      target,
    },
    resolvedInstallOptions,
  };
}

async function preflightUpgradeGraphWrites(options: {
  plan: PluginDependencyWritePlan;
  graphContext: InstallLocationGraphContext;
  resolvedInstallOptionsByLocation: Map<string, ResolvedInstallOptions>;
  commandOptions: UpgradeCommandOptions;
  runtime: UpgradeCommandRuntime;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const writeTargets = options.plan.writeOrder.map((location) => {
    const target = options.graphContext.targetByPlugin.get(location.plugin);
    if (!target?.currentPlugin) {
      throw new Error(`插件 ${location.plugin} 在 current catalog 中不存在。`);
    }
    return {
      location,
      target,
      node: options.plan.nodesByLocation[serializePluginLocation(location)],
      status: options.graphContext.statusByLocation.get(serializePluginLocation(location)),
    };
  });

  for (const { location, target } of writeTargets) {
    if (!options.resolvedInstallOptionsByLocation.has(serializePluginLocation(location))) {
      throw new Error(`缺少 ${location.platform}/${location.plugin} (${location.scope}) 的 resolved install options。`);
    }
    if (!pluginSupportsPlatform(target.currentPlugin!, location.platform)) {
      throw new Error(
        `${location.platform}/${location.plugin}: marketplace.policy.products=[${formatPolicyProducts(target.currentPlugin!)}], 需要 ${location.platform === 'codex' ? 'CODEX' : 'CLAUDE'}`,
      );
    }
  }

  for (const scope of ['user', 'project'] as const satisfies readonly Scope[]) {
    const codexTargetsForScope = writeTargets
      .filter(({ location }) => location.platform === 'codex' && location.scope === scope)
      .map(({ target }) => target);
    if (codexTargetsForScope.length === 0) {
      continue;
    }
    if (scope === 'project') {
      assertCodexProjectInstallableTargets(codexTargetsForScope, ['codex'], 'project');
    }
    await preflightCodexProjectWriteSafety({
      targets: codexTargetsForScope,
      platforms: ['codex'],
      cwd: options.commandOptions.cwd,
      scope,
      env: options.env,
      operation: 'upgrade',
    });
  }

  for (const scope of ['user', 'project'] as const satisfies readonly Scope[]) {
    const targetsForScope = writeTargets
      .filter(({ location }) => location.scope === scope)
      .map(({ target }) => target);
    if (targetsForScope.length === 0) {
      continue;
    }
    await preflightUpgradeConfigs(
      targetsForScope,
      {
        ...options.commandOptions,
        scope,
      },
      options.runtime,
    );
  }

  for (const { location, target, node, status } of writeTargets) {
    if (
      status?.externalOwnership?.present &&
      !(location.platform === 'codex' && location.scope === 'project')
    ) {
      throw new Error(status.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
    }

    if (node.action !== 'installDependency') {
      const codexUserUpgradeBlockReason = getCodexUserUpgradeBlockReason(
        target.pluginName,
        status ?? await readUpgradeTargetStatus(
          createAdapters(options.commandOptions.cwd, createCommandExecutionContext(options.runtime)),
          location.platform,
          target,
          location.scope,
          options.runtime.catalogResolution!,
        ),
        location.scope,
        location.platform,
      );
      if (codexUserUpgradeBlockReason) {
        throw new Error(codexUserUpgradeBlockReason);
      }
    }

    const trackingIdentityRefusal = await getTrackingArtifactIdentityRefusal({
      cwd: options.commandOptions.cwd,
      env: options.env,
      platform: location.platform,
      scope: location.scope,
      pluginName: location.plugin,
    });
    if (trackingIdentityRefusal) {
      throw new Error(trackingIdentityRefusal);
    }

    if (status) {
      const identityRefusal = getGeneratedArtifactIdentityRefusal(status);
      if (identityRefusal) {
        throw new Error(identityRefusal);
      }

      if (node.action !== 'installDependency') {
        const managedEvidence = hasUpgradeReadyManagedEvidence(
          status,
          location.platform,
          location.scope,
        );
        const fallbackOnly =
          !managedEvidence &&
          (
            status.platformRuntimeEvidence?.present === true ||
            status.platformNativeFallbackEvidence?.present === true
          );

        if (fallbackOnly) {
          throw new Error(
            `${location.plugin} 在 ${location.platform} (${location.scope}) 缺少安装时快照，不能直接 upgrade；请先执行 uninstall，再重新 install。`,
          );
        }

        if (!managedEvidence) {
          throw new Error(
            `${location.plugin} 在 ${location.platform} (${location.scope}) 缺少完整受管安装证据，不能执行 upgrade。`,
          );
        }
      }

      if (status.catalogCompatibility === 'missing') {
        throw new Error(`${location.plugin} 当前 catalog 已缺失，请先执行 uninstall。`);
      }
    }

    if (!target.currentPlugin) {
      throw new Error(`${location.plugin} 当前 catalog 已缺失，请先执行 uninstall。`);
    }
  }
}

function createScopedUpgradeOptions(
  options: UpgradeCommandOptions,
  location: PluginLocation,
): UpgradeCommandOptions {
  return {
    ...options,
    platform: location.platform,
    scope: location.scope,
  };
}

async function executeUpgradeGraphPlan(options: {
  plan: PluginDependencyWritePlan;
  graphContext: InstallLocationGraphContext;
  resolvedInstallOptionsByLocation: Map<string, ResolvedInstallOptions>;
  commandOptions: UpgradeCommandOptions;
  runtime: UpgradeCommandRuntime;
}): Promise<{
  warnings: string[];
  nativePlugins: NativePluginsByPlatform;
  repoManagedArtifacts: GeneratedArtifact[];
}> {
  const context = createCommandExecutionContext(options.runtime);
  const env = context.env;
  const adapters = createAdapters(options.commandOptions.cwd, context);
  const executorNodes = buildUpgradeGraphExecutorNodes({
    plan: options.plan,
    graphContext: options.graphContext,
  });
  const graphResult = await executePluginDependencyWriteGraph({
    nodes: executorNodes,
    preflight: async () => {
      await preflightUpgradeGraphWrites({
        plan: options.plan,
        graphContext: options.graphContext,
        resolvedInstallOptionsByLocation: options.resolvedInstallOptionsByLocation,
        commandOptions: options.commandOptions,
        runtime: {
          ...context,
          adapters,
          catalogResolution: options.runtime.catalogResolution,
          marketplacePrepared: options.runtime.marketplacePrepared,
        },
        env,
      });
    },
    executeNode: async (node) => {
      const key = serializePluginLocation(node.location);
      const target = options.graphContext.targetByPlugin.get(node.location.plugin);
      const resolvedInstallOptions = options.resolvedInstallOptionsByLocation.get(key);
      const status = options.graphContext.statusByLocation.get(key);
      if (!target || !resolvedInstallOptions) {
        throw new Error(`缺少 ${node.location.platform}/${node.location.plugin} (${node.location.scope}) 的 graph upgrade 上下文。`);
      }

      const operation = node.action === 'installDependency' ? 'install' : 'upgrade';
      const warnings: string[] = [];

      const installResult = await installTargetsOnPlatforms(
        [target],
        [node.location.platform],
        {
          cwd: options.commandOptions.cwd,
          platform: node.location.platform,
          scope: node.location.scope,
          scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
          requestedSkillTrigger: node.requested
            ? options.commandOptions.requestedSkillTrigger
            : undefined,
        },
        {
          ...context,
          adapters,
          resolveInstallOptions: () => resolvedInstallOptions,
          operation,
          catalogResolution: options.runtime.catalogResolution,
          marketplacePrepared: options.runtime.marketplacePrepared,
          skipConfigPreflight: true,
          skipWriteSafetyPreflight: true,
        },
      );
      await initializeInstalledScopeDependencyMetadata({
        location: node.location,
        requested: node.requested,
        preserveExplicit: options.graphContext.installedRecordByLocation.get(key)?.installSource?.explicitlyRequested === true,
        env,
      });
      if (
        node.requested &&
        options.graphContext.installedRecordByLocation.get(key)?.installSource?.kind === 'dependency'
      ) {
        await preserveDependencyInstallSourceForRequestedUpgrade({
          location: node.location,
          env,
        });
      }
      return mergeUpgradeNodeResult(
        {
          warnings,
          nativePlugins: {},
          repoManagedArtifacts: [],
        },
        installResult,
      );
    },
    commitNodeEdges: async (node) => {
      await commitInstalledScopeDependencyEdges(node.location, node.outgoingEdges, env);
    },
    rollbackNode: async (node) => {
      const target = options.graphContext.targetByPlugin.get(node.location.plugin);
      if (!target) {
        throw new Error(`插件 ${node.location.plugin} 在 current catalog 中不存在，无法回滚自动依赖。`);
      }
      await uninstallTargetsOnPlatforms(
        [target],
        [node.location.platform],
        {
          cwd: options.commandOptions.cwd,
          platform: node.location.platform,
          scope: node.location.scope,
          scriptTimeoutMs: options.commandOptions.scriptTimeoutMs,
          removeConfig: false,
        },
        {
          ...context,
          adapters,
        },
      );
      await ensureRollbackRemovedDependencyLocation({
        location: node.location,
        cwd: options.commandOptions.cwd,
        env,
      });
    },
    createRollbackFailure: (error, failures) => new Error(
      `${error instanceof Error ? error.message : String(error)}；以下自动安装依赖回滚未完全完成：${
        failures
          .map((failure: PluginDependencyWriteExecutorRollbackFailure) =>
            `${failure.node.location.platform}/${failure.node.location.scope}/${failure.node.location.plugin}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`)
          .join('；')
      }`,
    ),
  });

  return Object.values(graphResult.nodeResultsByLocation).reduce(
    (aggregate, next) => mergeUpgradeNodeResult(aggregate, next),
    {
      warnings: [],
      nativePlugins: {},
      repoManagedArtifacts: [],
    } satisfies UpgradeLocationNodeResult,
  );
}

async function runExplicitUpgrade(
  targets: ResolvedPluginTarget[],
  platforms: PlatformName[],
  options: UpgradeCommandOptions,
  runtime: UpgradeCommandRuntime,
  preparedLedger: InstalledLedger,
  preparedGraph?: PreparedExplicitUpgradeGraph,
): Promise<{
  warnings: string[];
  plugins: string[];
  nativePlugins: NativePluginsByPlatform;
  repoManagedArtifacts: GeneratedArtifact[];
  receiptTargets: UpgradeCommandReceiptTarget[];
  receiptActions: UpgradeCommandReceiptAction[];
  }> {
  const context = createCommandExecutionContext(runtime);
  const env = context.env;
  const adapters = createAdapters(options.cwd, context);
  const prepared = preparedGraph ?? await (async () => {
    const projectKeysByPlatform = await resolveProjectKeysByPlatform(
      options.cwd,
      options.scope,
      platforms,
    );
    const requestedLocations = targets.flatMap((target) =>
      platforms
        .filter((platform) => pluginSupportsPlatform(target.currentPlugin ?? target.plugin, platform))
        .map((platform) => createPluginLocationForPlatform({
          plugin: target.pluginName,
          platform,
          scope: options.scope,
          projectKeysByPlatform,
        })),
    );
    return prepareExplicitUpgradeGraph({
      requestedLocations,
      commandOptions: options,
      adapters,
      env,
      ledger: preparedLedger,
      catalogResolution: runtime.catalogResolution!,
    });
  })();
  const graphPlan = prepared.plan;
  const graphContext = prepared.graphContext;
  const resolvedInstallOptionsByLocation = await resolveGraphInstallOptionsByLocation({
    mode: 'upgrade',
    plan: graphPlan,
    graphContext,
    commandOptions: {
      cwd: options.cwd,
      requestedSkillTrigger: options.requestedSkillTrigger,
    },
    ledger: preparedLedger,
    env,
  });

  try {
    const graphResult = await executeUpgradeGraphPlan({
      plan: graphPlan,
      graphContext,
      resolvedInstallOptionsByLocation,
      commandOptions: options,
      runtime: {
        ...runtime,
        adapters,
      },
    });

    return {
      warnings: graphResult.warnings,
      plugins: targets.map((target) => target.pluginName),
      nativePlugins: graphResult.nativePlugins,
      repoManagedArtifacts: graphResult.repoManagedArtifacts,
      receiptTargets: createUpgradeReceiptTargets(graphPlan, graphContext.targetByPlugin),
      receiptActions: createUpgradeReceiptActions(graphPlan, graphContext.targetByPlugin),
    };
  } catch (error) {
    await cleanupOrphanedAutoDependenciesAfterFailedInstall({
      plan: graphPlan,
      cwd: options.cwd,
      env,
      targetByPlugin: graphContext.targetByPlugin,
      adapters,
      scriptTimeoutMs: options.scriptTimeoutMs,
    }).catch(() => undefined);
    throw error;
  }
}

async function runUpgradeAll(
  platforms: PlatformName[],
  options: UpgradeCommandOptions,
  runtime: UpgradeCommandRuntime,
  preparedLedger: Awaited<ReturnType<typeof prepareCommandEnvironment>>['ledger'],
  currentCatalogTargets: ResolvedPluginTarget[],
): Promise<{
  warnings: string[];
  plugins: string[];
  nativePlugins: NativePluginsByPlatform;
  repoManagedArtifacts: GeneratedArtifact[];
  skipped: SkippedUpgradeTarget[];
  receiptTargets: UpgradeCommandReceiptTarget[];
  receiptActions: UpgradeCommandReceiptAction[];
}> {
  const context = createCommandExecutionContext(runtime);
  const env = context.env;
  const adapters = createAdapters(options.cwd, context);
  const scopeKeys = await resolveUpgradeAllScopeKeys(options.cwd, options.scope);
  const trackingManifests = {
    codex: platforms.includes('codex')
      ? await readUpgradeAllTrackingManifest(options.cwd, 'codex', options.scope, env)
      : undefined,
    claude: platforms.includes('claude')
      ? await readUpgradeAllTrackingManifest(options.cwd, 'claude', options.scope, env)
      : undefined,
  };
  const explicitRootLocations = collectUpgradeAllExplicitRootLocations({
    ledger: preparedLedger,
    platforms,
    scope: options.scope,
    scopeKeys,
  });
  const explicitRootNames = [...new Set(explicitRootLocations.map((location) => location.plugin))];
  if (explicitRootNames.length === 0) {
    return {
      warnings: [],
      plugins: [],
      nativePlugins: {},
      repoManagedArtifacts: [],
      skipped: [],
      receiptTargets: [],
      receiptActions: [],
    };
  }

  const targetByPlugin = new Map(currentCatalogTargets.map((target) => [target.pluginName, target]));
  const rootSkips: PluginDependencyUpgradeAllSkipInput[] = [];
  const readyRootLocations: PluginLocation[] = [];

  for (const location of explicitRootLocations) {
    const target = targetByPlugin.get(location.plugin);
    if (!target) {
      rootSkips.push({
        location,
        code: 'catalogNotCurrent',
        reason: `${location.plugin} 当前 catalog 已缺失，请先执行 uninstall。`,
      });
      continue;
    }

    if (target.currentPlugin && !pluginSupportsPlatform(target.currentPlugin, location.platform)) {
      throw new Error(
        `${location.platform}/${location.plugin}: marketplace.policy.products=[${formatPolicyProducts(target.currentPlugin)}], 需要 ${location.platform === 'codex' ? 'CODEX' : 'CLAUDE'}`,
      );
    }

    const evaluation = await evaluateUpgradeAllTarget({
      platform: location.platform,
      scope: location.scope,
      cwd: options.cwd,
      env,
      target,
      adapters,
      ledger: preparedLedger,
      scopeKeys,
      trackingManifests,
      catalogResolution: runtime.catalogResolution!,
      commandOptions: {
        ...options,
        scope: location.scope,
      },
    });
    if (evaluation.skipped) {
      rootSkips.push({
        location,
        code: evaluation.skipped.code,
        reason: evaluation.skipped.reason,
      });
      continue;
    }

    readyRootLocations.push(location);
  }

  if (readyRootLocations.length === 0) {
    return {
      warnings: [],
      plugins: [],
      nativePlugins: {},
      repoManagedArtifacts: [],
      skipped: rootSkips.map((entry) => createSkippedUpgradeTarget(
        entry.location.platform,
        entry.location.scope,
        entry.location.plugin,
        entry.code as SkippedUpgradeCode,
        entry.reason,
        {
          requested: true,
        },
      )),
      receiptTargets: rootSkips.map((entry) => ({
        plugin: entry.location.plugin,
        platform: entry.location.platform,
        scope: entry.location.scope,
        requested: true,
      })),
      receiptActions: [],
    };
  }

  const projectKeysByPlatform = {
    codex: scopeKeys.codex ?? null,
    claude: scopeKeys.claude ?? null,
  };
  const accessibleInstalledLocations = collectAccessibleInstalledLocations({
    ledger: preparedLedger,
    platforms,
    scope: options.scope,
    projectKeysByPlatform,
    allowedPlugins: new Set(targetByPlugin.keys()),
  });
  const { plannerState, graphContext } = await buildInstallPlannerContext({
    requestedLocations: readyRootLocations,
    extraLocations: accessibleInstalledLocations,
    targetByPlugin,
    adapters,
    scope: options.scope,
    cwd: options.cwd,
    env,
    ledger: preparedLedger,
    projectKeysByPlatform,
    catalogResolution: runtime.catalogResolution,
  });
  let graphPlan = planPluginDependencyUpgradeAll({
    state: plannerState,
    platforms,
    scope: options.scope,
    projectKeysByPlatform: options.scope === 'project'
      ? projectKeysByPlatform
      : undefined,
    initialSkipped: rootSkips,
  });

  const dependencySkips: PluginDependencyUpgradeAllSkipInput[] = [];
  for (const location of graphPlan.writeOrder) {
    const key = serializePluginLocation(location);
    const node = graphPlan.nodesByLocation[key];
    if (!node || node.requested) {
      continue;
    }
    const target = graphContext.targetByPlugin.get(location.plugin);
    const status = graphContext.statusByLocation.get(key);
    if (!target?.currentPlugin || !status) {
      dependencySkips.push({
        location,
        code: 'cleanupRequired',
        reason: createUpgradeCleanupRequiredReason({
          pluginName: location.plugin,
          platform: location.platform,
          scope: location.scope,
          detail: !target?.currentPlugin ? 'current catalog 缺失' : '当前状态不可读',
        }),
      });
      continue;
    }

    if (location.platform === 'codex' && location.scope === 'project') {
      try {
        await preflightCodexProjectWriteSafety({
          targets: [target],
          platforms: ['codex'],
          cwd: options.cwd,
          scope: 'project',
          env,
          operation: 'upgrade',
        });
      } catch (error) {
        if (isCodexProjectWriteSafetyError(error)) {
          dependencySkips.push({
            location,
            code: error.code,
            reason: error.message,
          });
          continue;
        }
        throw error;
      }
    } else if (status.externalOwnership?.present) {
      dependencySkips.push({
        location,
        code: 'externalOwnershipPresent',
        reason: status.externalOwnership.details ?? '同名插件已由外部 marketplace 管理。',
      });
      continue;
    }

    if (node.action !== 'installDependency') {
      const codexUserUpgradeBlockReason = getCodexUserUpgradeBlockReason(
        location.plugin,
        status,
        location.scope,
        location.platform,
      );
      if (codexUserUpgradeBlockReason) {
        dependencySkips.push({
          location,
          code: 'cleanupRequired',
          reason: codexUserUpgradeBlockReason,
        });
        continue;
      }

      const managedEvidence = hasUpgradeReadyManagedEvidence(
        status,
        location.platform,
        location.scope,
      );
      const fallbackOnly =
        !managedEvidence &&
        (
          status.platformRuntimeEvidence?.present === true ||
          status.platformNativeFallbackEvidence?.present === true
        );
      if (fallbackOnly || !managedEvidence) {
        dependencySkips.push({
          location,
          code: fallbackOnly ? 'cleanupRequired' : 'notInstalled',
          reason: fallbackOnly
            ? `${location.plugin} 在 ${location.platform} (${location.scope}) 缺少安装时快照，不能直接 upgrade；请先执行 uninstall，再重新 install。`
            : `${location.plugin} 在 ${location.platform} (${location.scope}) 缺少完整受管安装证据，不能执行 upgrade。`,
        });
        continue;
      }
    }

    const trackingIdentityRefusal = await getTrackingArtifactIdentityRefusal({
      cwd: options.cwd,
      env,
      platform: location.platform,
      scope: location.scope,
      pluginName: location.plugin,
    });
    if (trackingIdentityRefusal) {
      dependencySkips.push({
        location,
        code: 'trackingIntegrityError',
        reason: trackingIdentityRefusal,
      });
      continue;
    }

    const identityRefusal = getGeneratedArtifactIdentityRefusal(status);
    if (identityRefusal) {
      dependencySkips.push({
        location,
        code: 'trackingIntegrityError',
        reason: identityRefusal,
      });
      continue;
    }

      if (status.catalogCompatibility === 'missing') {
        dependencySkips.push({
          location,
          code: 'catalogNotCurrent',
          reason: `${location.plugin} 当前 catalog 已缺失，请先执行 uninstall。`,
        });
        continue;
      }

      if (location.platform === 'codex' && location.scope === 'project') {
        const installability = getCodexProjectInstallability(target.currentPlugin);
      if (!installability.installable) {
        dependencySkips.push({
          location,
          code: 'catalogNotProjectInstallable',
          reason: installability.reason ?? `${location.plugin} 当前 catalog 版本不再支持 Codex project upgrade。`,
        });
      }
    }
  }

  if (dependencySkips.length > 0) {
    graphPlan = planPluginDependencyUpgradeAll({
      state: plannerState,
      platforms,
      scope: options.scope,
      projectKeysByPlatform: options.scope === 'project'
        ? projectKeysByPlatform
        : undefined,
      initialSkipped: [...rootSkips, ...dependencySkips],
    });
  }

  await assertNoDuplicateInstalls({
    cwd: options.cwd,
    locations: graphPlan.preflight.scopeExclusivity.filter((location) =>
      shouldEnforceDuplicateInstallPreflight({
        location,
        plugin: targetByPlugin.get(location.plugin)?.currentPlugin
          ?? targetByPlugin.get(location.plugin)?.plugin
          ?? null,
      })),
    env,
  });
  const resolvedInstallOptionsByLocation = await resolveGraphInstallOptionsByLocation({
    mode: 'upgrade-all',
    plan: {
      mode: 'upgrade',
      requestedRoots: graphPlan.roots,
      topologicalOrder: graphPlan.topologicalOrder,
      writeOrder: graphPlan.writeOrder,
      nodesByLocation: graphPlan.nodesByLocation,
      edges: graphPlan.edges,
      preflight: graphPlan.preflight,
    },
    graphContext,
    commandOptions: {
      cwd: options.cwd,
      requestedSkillTrigger: undefined,
    },
    ledger: preparedLedger,
    env,
  });

  const executionPlan: PluginDependencyWritePlan = {
    mode: 'upgrade',
    requestedRoots: graphPlan.roots,
    topologicalOrder: graphPlan.topologicalOrder,
    writeOrder: graphPlan.writeOrder,
    nodesByLocation: graphPlan.nodesByLocation,
    edges: graphPlan.edges,
    preflight: graphPlan.preflight,
  };
  const skipped = graphPlan.skipped.map((entry) => createSkippedUpgradeTarget(
    entry.location.platform,
    entry.location.scope,
    entry.location.plugin,
    entry.code as SkippedUpgradeCode,
    entry.reason,
    createUpgradeSkippedTargetMetadata({
      plan: executionPlan,
      skipped: entry,
      requestedRoots: graphPlan.roots,
    }),
  ));

  await emitCommandEvent(context, {
    type: 'skill-trigger:resolved',
    data: {
      entries: [...resolvedInstallOptionsByLocation.entries()].map(([key, value]) => ({
        key,
        applicability: value.applicability,
        ...(value.applicability === 'overridable'
          ? {
              preference: value.skillTriggerPreference,
              source: value.skillTriggerSource,
            }
          : {}),
        ledgerTrust: value.ledgerTrust,
      })),
      skipped: skipped.map((entry) => ({
        platform: entry.platform,
        plugin: entry.plugin,
        code: entry.code,
      })),
    },
  });
  const graphResult = await executeUpgradeGraphPlan({
    plan: executionPlan,
    graphContext,
    resolvedInstallOptionsByLocation,
    commandOptions: options,
    runtime: {
      ...runtime,
      adapters,
    },
  });
  const plugins = [...new Set(
    executionPlan.writeOrder
      .filter((location) => executionPlan.nodesByLocation[serializePluginLocation(location)]?.requested)
      .map((location) => location.plugin),
  )];

  return {
    warnings: graphResult.warnings,
    plugins,
    nativePlugins: graphResult.nativePlugins,
    repoManagedArtifacts: graphResult.repoManagedArtifacts,
    skipped,
    receiptTargets: createUpgradeReceiptTargets(
      executionPlan,
      graphContext.targetByPlugin,
      createUpgradeSkippedReceiptTargets({
        plan: executionPlan,
        skipped: graphPlan.skipped,
        requestedRoots: graphPlan.roots,
        targetByPlugin: graphContext.targetByPlugin,
      }),
    ),
    receiptActions: createUpgradeReceiptActions(executionPlan, graphContext.targetByPlugin),
  };
}

export async function upgradeCommand(
  pluginNames: string[],
  rawOptions: RawUpgradeCommandOptions,
  runtime: UpgradeCommandRuntime = {},
): Promise<UpgradeCommandResult> {
  const options = normalizeUpgradeCommandOptions(rawOptions);
  const context = createCommandExecutionContext(runtime);
  const env = applyCatalogSelectorEnv(context.env, options);

  if (!options.all && pluginNames.length === 0) {
    throw new Error('upgrade 命令需要插件名，或者显式传入 `--all`。');
  }

  if (options.all && options.requestedSkillTrigger) {
    throw new Error('`upgrade` 不再接受 `--skill-trigger` / `-t`；请改用配置管理维护 skill trigger 偏好后再重试。');
  }

  const adapters = createAdapters(options.cwd, context);
  if (options.all) {
    const prepared = await prepareCommandEnvironment({
      catalogMode: 'readOnly',
      env,
      context,
      catalogResolution: runtime.catalogResolution,
    });
    let commandCatalog = prepared.catalog;
    let commandWarnings = prepared.warnings;
    const pinnedCatalogRoots: string[] = [];
    try {
      if (prepared.ledger.ledgerState.status === 'degraded') {
        throw new Error('`upgrade --all` 在 installed.json 处于 degraded 状态时不可执行，请先处理异常记录。');
      }

      const platforms = await resolveUpgradeAllPlatforms(
        options.platform,
        options.cwd,
        options.scope,
        prepared.ledger,
        env,
      );
      await emitCommandEvent(context, {
        type: 'platform:resolved',
        data: {
          requestedPlatform: options.platform,
          platforms,
          scope: options.scope,
          all: true,
        },
      });
      await assertAgentVersionsForWriteTargets({
        command: 'upgradeAll',
        platforms,
        cwd: options.cwd,
        env,
        nativeCliRunner: context.nativeCliRunner,
      });
      let currentCatalogTargets: ResolvedPluginTarget[];
      try {
        currentCatalogTargets = await loadPluginTargetsForCommand(
          options.cwd,
          options.scope,
          undefined,
          {
            catalogMode: 'readOnly',
            allowHistoricalFallback: false,
            env,
            catalogResolution: commandCatalog,
          },
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('没有发现可用插件')
        ) {
          currentCatalogTargets = [];
        } else {
          throw error;
        }
      }
      const pinnedCatalogResolution = await pinCatalogResolutionForLocalMarketplaceRebuild(
        commandCatalog,
        env,
      );
      if (pinnedCatalogResolution) {
        commandCatalog = pinnedCatalogResolution.catalogResolution;
        pinnedCatalogRoots.push(pinnedCatalogResolution.pinnedRoot);
        for (const target of currentCatalogTargets) {
          await retargetCurrentCatalogTargetToCatalogRoot(
            target,
            pinnedCatalogResolution.pinnedRoot,
          );
        }
      } else {
        pinnedCatalogRoots.push(...await pinCurrentCatalogTargetsForLocalMarketplaceRebuild({
          targets: currentCatalogTargets,
          env,
        }));
      }
      const catalogAdapters = bindCatalogResolutionToAdapters(adapters, commandCatalog);
      const preparedForExecution = await prepareCommandEnvironment({
        catalogMode: 'runtimeWritable',
        env,
        context,
        catalogResolution: commandCatalog,
      });
      const executionWarnings = preparedForExecution === prepared
        ? []
        : preparedForExecution.warnings;
      commandWarnings = [
        ...prepared.warnings,
        ...executionWarnings,
      ];
      const result = await runUpgradeAll(platforms, options, {
        ...context,
        adapters: catalogAdapters,
        catalogResolution: commandCatalog,
        marketplacePrepared: true,
      }, preparedForExecution.ledger, currentCatalogTargets);

      return {
        platforms,
        plugins: result.plugins,
        skipped: result.skipped,
        nativePlugins: result.nativePlugins,
        repoManagedArtifacts: result.repoManagedArtifacts,
        marketplace: preparedForExecution.marketplace,
        receiptTargets: result.receiptTargets,
        receiptActions: result.receiptActions,
        warnings: [
          ...commandWarnings,
          ...collectCommandWarnings(platforms, options.scope),
          ...result.warnings,
        ],
      };
    } catch (error) {
      throw wrapCommandErrorWithWarnings(
        error,
        withEarlyDegradedLedgerWarning(commandWarnings, prepared.ledger),
      );
    } finally {
      await Promise.all(pinnedCatalogRoots.map((rootDir) => disposePinnedCatalogRoot(rootDir)));
    }
  }

  await preflightExplicitCodexUserRecoveryOnlyTargets({
    pluginNames,
    commandOptions: options,
    env,
  });

  const prepared = await preparePluginTargetsForCommand(
    options.cwd,
    options.scope,
    pluginNames,
    {
      catalogMode: 'readOnly',
      allowHistoricalFallback: true,
      env,
      catalogResolution: runtime.catalogResolution,
    },
  );
  let commandCatalog = prepared.catalog;
  let catalogAdapters = bindCatalogResolutionToAdapters(adapters, commandCatalog);
  let commandWarnings = prepared.warnings;
  const pinnedCatalogRoots: string[] = [];
  await emitCommandEvent(context, {
    type: 'catalog:resolved',
    data: {
      plugins: prepared.targets.map((target) => ({
        name: target.pluginName,
        source: target.source,
        current: Boolean(target.currentPlugin),
      })),
      warnings: prepared.warnings,
    },
  });
  try {
    const requestedPlatformPairs = await resolveCurrentCatalogWriteTargetPairs(
      'upgrade',
      options.platform,
      options.cwd,
      options.scope,
      prepared.targets,
      catalogAdapters,
      env,
    );
    const platforms = [...new Set(requestedPlatformPairs.map((entry) => entry.platform))];
    const projectKeysByPlatform = await resolveProjectKeysByPlatform(
      options.cwd,
      options.scope,
      platforms,
    );
    const requestedLocations = requestedPlatformPairs.map(({ pluginName, platform }) =>
      createPluginLocationForPlatform({
        plugin: pluginName,
        platform,
        scope: options.scope,
        projectKeysByPlatform,
      }));
    const targetByPlugin = new Map(
      prepared.targets.map((target) => [target.pluginName, target] as const),
    );
    await emitCommandEvent(context, {
      type: 'platform:resolved',
      data: {
        requestedPlatform: options.platform,
        platforms,
        scope: options.scope,
      },
    });
    await assertAgentVersionsForWriteTargets({
      command: 'upgrade',
      platforms,
      cwd: options.cwd,
      env,
      nativeCliRunner: context.nativeCliRunner,
    });
    assertCodexProjectInstallableTargets(prepared.targets, platforms, options.scope);
    await preflightCodexProjectWriteSafety({
      targets: prepared.targets,
      platforms,
      cwd: options.cwd,
      scope: options.scope,
      env,
      operation: 'upgrade',
    });
    await preflightExplicitUpgradeTargets(
      requestedLocations,
      targetByPlugin,
      options,
      catalogAdapters,
      env,
      commandCatalog,
    );
    const preparedGraph = await prepareExplicitUpgradeGraph({
      requestedLocations,
      commandOptions: options,
      adapters: catalogAdapters,
      env,
      ledger: prepared.ledger,
      catalogResolution: commandCatalog,
    });
    await assertNoDuplicateInstalls({
      cwd: options.cwd,
      locations: preparedGraph.plan.preflight.scopeExclusivity.filter((location) =>
        shouldEnforceDuplicateInstallPreflight({
          location,
          plugin: prepared.targets.find((target) => target.pluginName === location.plugin)?.currentPlugin
            ?? prepared.targets.find((target) => target.pluginName === location.plugin)?.plugin
            ?? null,
        })),
      env,
    });
    await preflightUpgradeConfigs(
      prepared.targets,
      options,
      context,
    );
    const graphTargets = preparedGraph.plan.writeOrder
      .map((location) => preparedGraph.graphContext.targetByPlugin.get(location.plugin))
      .filter((target): target is ResolvedPluginTarget => Boolean(target));
    const pinnedCatalogResolution = await pinCatalogResolutionForLocalMarketplaceRebuild(
      commandCatalog,
      env,
    );
    if (pinnedCatalogResolution) {
      commandCatalog = pinnedCatalogResolution.catalogResolution;
      pinnedCatalogRoots.push(pinnedCatalogResolution.pinnedRoot);
      for (const target of preparedGraph.graphContext.targetByPlugin.values()) {
        await retargetCurrentCatalogTargetToCatalogRoot(
          target,
          pinnedCatalogResolution.pinnedRoot,
        );
      }
    } else {
      pinnedCatalogRoots.push(...await pinCurrentCatalogTargetsForLocalMarketplaceRebuild({
        targets: graphTargets,
        env,
      }));
    }
    catalogAdapters = bindCatalogResolutionToAdapters(adapters, commandCatalog);
    const preparedForExecution = await prepareCommandEnvironment({
      catalogMode: 'runtimeWritable',
      env,
      context,
      catalogResolution: commandCatalog,
    });
    const executionWarnings = preparedForExecution === prepared
      ? []
      : preparedForExecution.warnings;
    commandWarnings = [
      ...prepared.warnings,
      ...executionWarnings,
    ];
    const result = await runExplicitUpgrade(
      prepared.targets,
      platforms,
      options,
      {
        ...context,
        adapters: catalogAdapters,
        catalogResolution: commandCatalog,
        marketplacePrepared: true,
      },
      preparedForExecution.ledger,
      preparedGraph,
    );

    return {
      platforms,
      plugins: result.plugins,
      skipped: [],
      nativePlugins: result.nativePlugins,
      repoManagedArtifacts: result.repoManagedArtifacts,
      marketplace: preparedForExecution.marketplace,
      receiptTargets: result.receiptTargets,
      receiptActions: result.receiptActions,
      warnings: [
        ...commandWarnings,
        ...collectCommandWarnings(platforms, options.scope),
        ...result.warnings,
      ],
    };
  } catch (error) {
    throw wrapCommandErrorWithWarnings(
      error,
      withEarlyDegradedLedgerWarning(commandWarnings, prepared.ledger),
    );
  } finally {
    await Promise.all(pinnedCatalogRoots.map((rootDir) => disposePinnedCatalogRoot(rootDir)));
  }
}
