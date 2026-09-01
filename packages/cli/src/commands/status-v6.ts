import fs from 'node:fs';
import path from 'node:path';

import type {
  CatalogSource,
  PlatformName,
  PluginMeta,
  PluginConfigSchemaField,
  Scope,
} from '../types.js';
import { analyzeCodexSurface, type CodexExtensionKind } from '../utils/codex-surface-analysis.js';
import {
  catalogSourceErrorCode,
  sanitizeCatalogSourceError,
} from '../utils/catalog-public-error.js';
import { calculateCatalogSourceIdentity } from '../utils/catalog-source-identity.js';
import {
  canonicalMarketplaceRegistrationNames,
  inventoryCatalogSourceReferences,
  inventoryLegacyOwnerReferences,
  type CatalogSourceInventoryError,
} from '../utils/catalog-source-references.js';
import { readCatalogSourcesConfigSnapshot, resolveCatalogSourceRef } from '../utils/catalog-sources.js';
import {
  formatPluginId,
  parsePluginId,
  planPluginSelectorSourceIds,
  withResolvedMultiSourceCatalog,
} from '../utils/multi-source-catalog.js';
import type { CatalogOperationContext } from '../utils/catalog-operation-context.js';
import {
  assertStrictSemVer,
  checkAwCapabilitySupport,
  compareStrictSemVer,
  readPluginManifest,
  tryParseStrictSemVer,
} from '../utils/manifest.js';
import { resolveCliPackageRoot, resolveCodexPaths } from '../utils/paths.js';
import { supportsPlatform } from '../utils/platform-support.js';
import { parsePlatformValue, parseScopeValue } from './options.js';
import {
  inspectCodexPluginRegistrationLive,
  inspectCodexSharedNativeLive,
  inspectRebuildTarget,
} from './rebuild-integration.js';
import { createNoopReporter } from '../output/reporter.js';
import { createNoopDebugLogger } from '../output/debug-log.js';
import { getDefaultNativeCliRunner } from '../utils/native-cli.js';
import { resolveAwHome } from '../utils/paths.js';
import type {
  ArtifactCollisionEvidence,
  OwnedComponent,
  OwnedProbeResult,
  OwnershipInspection,
} from '../utils/ownership.js';
import {
  codexProjectConfigAliasesUserHome,
  createProjectLocationKey,
  getClaudeHome,
  getCodexHome,
  resolveCanonicalRepoProjectKey,
} from '../utils/state-paths.js';
import { resolveEffectivePluginConfig } from '../utils/plugin-config.js';
import { readCodexConfigFile } from '../utils/codex-config.js';
import {
  readPluginIntentState,
  type PluginIntentState,
} from '../utils/plugin-intent-state.js';
import { IMPLEMENTED_AW_CAPABILITIES } from './aw-capabilities.js';
import { createDependencyPlacementPlan } from './dependency-operation-plan.js';
import { calculateCodexSharedNativePayloadDigest } from '../utils/catalog-digests.js';
import { getCodexOperationRequirement } from '../utils/agent-version.js';
import {
  inspectSystemCodexFilesystem,
  type SystemCodexFilesystemInspection,
} from '../utils/codex-manager.js';

export interface StatusV6CatalogSource {
  id: string;
  identity: string;
  type: CatalogSource['type'];
  primary: boolean;
  requestedRef: string;
  resolvedCommit?: string;
  catalogVersion?: string;
  channel?: string;
  freshness?: 'active';
  error?: string;
  errorCode?: string;
}

export interface StatusV6Target {
  pluginName: string;
  sourceId: string;
  sourceIdentity: string;
  pluginId: string;
  version?: string;
  platform: PlatformName;
  /** TUI placement adapter. Codex shared-native identity is still emitted only once. */
  scope: Scope;
  cwd: string;
  desired: {
    enabled: boolean;
    scopes: Scope[];
    relation: 'root' | 'dependency' | 'managed' | 'none';
  };
  actual: {
    state: StatusV6ActualState;
  };
  state: 'present' | 'absent' | 'partial' | 'error';
  components: StatusV6Component[];
  errors: StatusV6TargetError[];
  recovery: StatusV6RecoveryAction[];
  sharedNative?: {
    pluginId: string;
    state: 'present' | 'missing' | 'outdated' | 'corrupt' | 'foreign';
    version?: string;
    diagnostic?: 'staleCacheObserved';
    shared: true;
  };
  activation?: {
    user?: boolean;
    project?: boolean;
    effective?: boolean;
    evidence: 'observed' | 'assumed' | 'unobserved';
    systemConsumer?: SystemCodexFilesystemInspection;
  };
  extensions?: {
    state: 'ready' | 'missing' | 'drifted' | 'conflict';
    kinds: CodexExtensionKind[];
  };
  dependency?: {
    directCount: number;
    issueCount: number;
  };
  dependencyReadiness?: StatusV6DependencyReadiness[];
}

export type StatusV6ActualState =
  | 'ready'
  | 'needsSync'
  | 'drifted'
  | 'conflict'
  | 'orphaned'
  | 'unresolved'
  | 'absent';

export interface StatusV6RecoveryAction {
  command: 'sync' | 'cleanup' | 'reinstall' | 'uninstall' | 'manual';
  scope?: Scope;
  description: string;
}

type StatusV6TargetDraft = Omit<
  StatusV6Target,
  'desired' | 'actual' | 'recovery'
>;

export type StatusV6DependencyReadinessState =
  | 'ready'
  | 'absent'
  | 'blockedByCollision'
  | 'incomplete'
  | 'error';

export interface StatusV6DependencyReadiness {
  dependencyPluginId: string;
  state: StatusV6DependencyReadinessState;
  rootIssueId?: string;
  rootIssueCode?: string;
}

export interface StatusV6Component {
  key: string;
  state: OwnershipInspection['components'][number]['state'];
  error?: StatusV6TargetError;
}

export interface StatusV6TargetError {
  code: string;
  message: string;
  severity: 'warning' | 'blocking';
  collision?: ArtifactCollisionEvidence;
  dependencyPluginId?: string;
  rootIssueId?: string;
  rootIssueCode?: string;
}

type StatusV6TargetErrorInput = Omit<StatusV6TargetError, 'severity'>;

export interface StatusV6Payload {
  schemaVersion: 6;
  catalog: {
    primarySourceId: string;
    configDigest: string;
    compositeDigest: string;
    generationSetDigest?: string;
    sources: StatusV6CatalogSource[];
  };
  filters: {
    plugins: string[];
    platform: PlatformName | 'both';
    scope?: Scope;
    cwd: string;
  };
  targets: StatusV6Target[];
  errors: Array<{ code: string; message: string }>;
}

export type TargetRevisionState =
  | { state: 'current'; availableVersion: string; installedVersion?: string }
  | { state: 'upgradeAvailable'; availableVersion: string; installedVersion?: string }
  | { state: 'unknown'; availableVersion?: string; installedVersion?: string };

export interface StatusTargetRevision {
  pluginId: string;
  platform: PlatformName;
  scope: Scope;
  revision: TargetRevisionState;
}

interface StatusPluginCapability {
  name: string;
  version: string;
  sharedNativePayloadDigest: string;
  displayName: string;
  shortDescription: string;
  description: string;
  configSchema?: Record<string, PluginConfigSchemaField>;
  configIssues?: StatusV6PluginSummary['configIssues'];
  configDiagnostic?: StatusV6PluginSummary['configDiagnostic'];
  targets: Record<PlatformName, Record<Scope, boolean>>;
  states: Partial<Record<PlatformName, Partial<Record<Scope, {
    state: StatusV6Target['state'];
    errors: StatusV6Target['errors'];
    components: StatusV6Component[];
    dependencyReadiness?: StatusV6DependencyReadiness[];
    installedVersion?: string;
  }>>>>;
  dependencies: string[];
  missingCapabilities?: string[];
  codex?: {
    pluginId: string;
    nativeKinds: string[];
    extensionKinds: CodexExtensionKind[];
    sharedNative?: NonNullable<StatusV6Target['sharedNative']>;
    activation: NonNullable<StatusV6Target['activation']>;
  };
}

export interface StatusV6PluginSummary {
  pluginName: string;
  pluginId: string;
  displayName?: string;
  description: string;
  version?: string;
  supportedTargets?: Record<PlatformName, Scope[]>;
  configFieldCount?: number;
  configSchema?: Record<string, PluginConfigSchemaField>;
  configIssues?: Array<{
    type: 'missing-required' | 'invalid-config';
    key: string;
    title: string;
    source: 'default' | 'user' | 'project' | 'projectLocal' | 'missing';
  }>;
  configDiagnostic?: { code: 'configReadFailed'; message: string };
  dependencyDirectCount?: number;
  dependencyTotalCount?: number;
  dependencyIssueCount?: number;
  missingCapabilities?: string[];
}

export interface LiveConsoleItem {
  pluginName: string;
  version?: string;
  pluginSummary?: Omit<StatusV6PluginSummary, 'pluginName' | 'pluginId'>;
  targets: StatusV6Target[];
}

export interface ConsoleItemsLoadResult {
  items: LiveConsoleItem[];
  catalogUnavailable: boolean;
  status: StatusV6Payload;
}

let dependencyInspectionHookForTests: (() => void) | undefined;

export function setStatusDependencyInspectionHookForTests(hook: (() => void) | undefined): void {
  dependencyInspectionHookForTests = hook;
}

export async function loadConsoleItemsResult(
  options: {
    cwd?: string;
    platform?: string;
    scope?: string;
    verbose?: boolean;
  } = {},
  runtime: { env?: NodeJS.ProcessEnv } = {},
): Promise<ConsoleItemsLoadResult> {
  const result = await statusCommandV6({
    cwd: options.cwd ?? process.cwd(),
    env: runtime.env,
    platform: options.platform,
    scope: options.scope,
    verbose: options.verbose,
  });
  const groups = new Map<string, LiveConsoleItem>();
  const summaries = new Map(result.pluginSummaries.map((summary) => [summary.pluginId, summary]));
  for (const target of result.payload.targets) {
    const summary = summaries.get(target.pluginId);
    let pluginSummary: LiveConsoleItem['pluginSummary'];
    if (summary !== undefined) {
      const { pluginName: _pluginName, pluginId: _pluginId, ...projected } = summary;
      pluginSummary = projected;
    }
    const current = groups.get(target.pluginId) ?? {
      pluginName: target.pluginId,
      ...(target.version ? { version: target.version } : {}),
      ...(pluginSummary ? { pluginSummary } : {}),
      targets: [],
    };
    current.targets.push(target);
    groups.set(target.pluginId, current);
  }
  const allSourcesFailed = result.payload.catalog.sources.length > 0
    && result.payload.catalog.sources.every((source) => source.error !== undefined);
  return {
    items: [...groups.values()].sort((left, right) =>
      left.pluginName.localeCompare(right.pluginName)),
    catalogUnavailable: allSourcesFailed,
    status: result.payload,
  };
}

export async function loadConsoleItems(
  options: {
    cwd?: string;
    platform?: string;
    scope?: string;
    verbose?: boolean;
  } = {},
  runtime: { env?: NodeJS.ProcessEnv } = {},
): Promise<LiveConsoleItem[]> {
  return (await loadConsoleItemsResult(options, runtime)).items;
}

interface PlannedStatusSelector {
  raw: string;
  parsed: ReturnType<typeof parsePluginId>;
}

interface StatusInventoryError {
  code: 'nativeStateUnreadable' | 'stateInventoryFailed';
  message: string;
  relevance: CatalogSourceInventoryError['relevance'];
}

function projectStateInventoryError(
  error: unknown,
  env: NodeJS.ProcessEnv,
  cwd: string,
): StatusInventoryError {
  const sanitized = sanitizeCatalogSourceError(error, env, [
    getCodexHome(env),
    getClaudeHome(env),
    path.resolve(cwd),
  ]);
  const native = /(?:Codex|Claude|config\.toml|settings|installed_plugins)/iu.test(sanitized.message);
  const code = native ? 'nativeStateUnreadable' : 'stateInventoryFailed';
  return { code, message: `${code}: ${sanitized.message}`, relevance: { global: true } };
}

function inventoryErrorMatchesSelection(options: {
  error: StatusInventoryError;
  selectors: PlannedStatusSelector[];
  platformExplicit: boolean;
  scopeExplicit: boolean;
  platforms: PlatformName[];
  scopes: Scope[];
  currentProjectLocationKey: string;
}): boolean {
  const relevance = options.error.relevance;
  if (relevance.global) return true;
  if (relevance.projectLocationKey
    && relevance.projectLocationKey !== options.currentProjectLocationKey) return false;
  if (options.platformExplicit && relevance.platform
    && !options.platforms.includes(relevance.platform)) return false;
  if (options.scopeExplicit && relevance.scope
    && !options.scopes.includes(relevance.scope)) return false;
  if (options.selectors.length === 0 || (!relevance.sourceId && !relevance.pluginName)) return true;
  return options.selectors.some((selector) =>
    (!relevance.pluginName || selector.parsed.pluginName === relevance.pluginName)
    && (!relevance.sourceId
      || selector.parsed.sourceId === undefined
      || selector.parsed.sourceId === relevance.sourceId));
}

function finalizeTargetError(
  error: StatusV6TargetErrorInput | StatusV6TargetError,
  targetState: StatusV6Target['state'],
): StatusV6TargetError {
  return {
    ...error,
    severity: error.code === 'artifactCollision'
      || (targetState === 'error'
        && error.code !== 'awCapabilityUnsupported'
        && error.dependencyPluginId === undefined)
      ? 'blocking'
      : 'warning',
  };
}

function projectTargetError(
  error: StatusV6TargetErrorInput | StatusV6TargetError,
  env: NodeJS.ProcessEnv,
  cwd: string,
  targetState: StatusV6Target['state'],
): StatusV6TargetError {
  const sanitized = sanitizeCatalogSourceError(new Error(error.message), env, [
    getCodexHome(env),
    getClaudeHome(env),
    path.resolve(cwd),
  ]);
  return finalizeTargetError({ ...error, message: sanitized.message }, targetState);
}

function sourceRequestedRef(source: CatalogSource, cliVersion: string): string {
  return source.type === 'git' ? resolveCatalogSourceRef(source.refPolicy, cliVersion) : 'path';
}

function selectedPlatforms(value: string | undefined): PlatformName[] {
  const selection = value === undefined ? 'both' : parsePlatformValue(value);
  return selection === 'both' ? ['codex', 'claude'] : [selection];
}

function selectedScopes(value: string | undefined): Scope[] {
  return value === undefined ? ['user', 'project'] : [parseScopeValue(value)];
}

interface DesiredTargetState {
  scopes: Scope[];
  relation: 'root' | 'dependency' | 'managed' | 'none';
}

function emptyIntent(): PluginIntentState {
  return {
    schemaVersion: 2,
    kind: 'aw-plugin-intents',
    roots: [],
    dependencyScopeOverrides: [],
  };
}

function desiredTargetKey(pluginId: string, platform: PlatformName): string {
  return `${pluginId}\0${platform}`;
}

function calculateDesiredTargetStates(options: {
  userIntent: PluginIntentState;
  projectIntent: PluginIntentState;
  available: Array<{
    name: string;
    dependencies: string[];
    source: { id: string };
    targets: Record<PlatformName, Record<Scope, boolean>>;
    states?: StatusPluginCapability['states'];
    codex?: { pluginId: string };
  }>;
  codexProjectAllowed: boolean;
}): Map<string, DesiredTargetState> {
  const desired = new Map<string, { scopes: Set<Scope>; relation: DesiredTargetState['relation'] }>();
  const add = (
    pluginId: string,
    platform: PlatformName,
    scope: Scope,
    relation: DesiredTargetState['relation'],
  ): void => {
    const key = desiredTargetKey(pluginId, platform);
    const current = desired.get(key) ?? { scopes: new Set<Scope>(), relation: 'none' as const };
    current.scopes.add(scope);
    if (relation === 'root' || (relation === 'dependency' && current.relation !== 'root')) {
      current.relation = relation;
    }
    desired.set(key, current);
  };
  const byId = new Map(options.available.map((entry) => [
    formatPluginId({ sourceId: entry.source.id, pluginName: entry.name }),
    entry,
  ]));
  for (const [scope, intent] of [
    ['user', options.userIntent],
    ['project', options.projectIntent],
  ] as const) {
    for (const root of intent.roots) {
      for (const platform of root.platforms) add(root.pluginId, platform, scope, 'root');
    }
    for (const platform of ['codex', 'claude'] as const) {
      const platformRoots = intent.roots.filter((root) =>
        root.platforms.includes(platform) && byId.has(root.pluginId));
      const closure = new Set<string>();
      const visit = (pluginId: string): void => {
        if (closure.has(pluginId)) return;
        closure.add(pluginId);
        const entry = byId.get(pluginId);
        if (!entry) return;
        for (const dependency of entry.dependencies) {
          visit(formatPluginId({ sourceId: entry.source.id, pluginName: dependency }));
        }
      };
      for (const root of platformRoots) visit(root.pluginId);
      const nodes = [...closure].flatMap((pluginId) => {
        const entry = byId.get(pluginId);
        if (!entry || !entry.targets[platform].user && !entry.targets[platform].project) return [];
        const allowedScopes: Scope[] = [
          ...(entry.targets[platform].project
            && (platform !== 'codex' || options.codexProjectAllowed) ? ['project' as const] : []),
          ...(entry.targets[platform].user ? ['user' as const] : []),
        ];
        return allowedScopes.length === 0 ? [] : [{
          pluginId,
          pluginName: entry.name,
          platform,
          relation: platformRoots.some((root) => root.pluginId === pluginId)
            ? 'requested' as const
            : 'dependency' as const,
          depth: platformRoots.some((root) => root.pluginId === pluginId) ? 0 : 1,
          allowedScopes,
          ...(scope === 'project'
            && !platformRoots.some((root) => root.pluginId === pluginId)
            && entry.states?.[platform]?.user?.state === 'present'
            && !entry.states[platform]?.user?.errors.some((error) => error.severity === 'blocking')
            ? { preferredScope: 'user' as const, preferredScopeReason: 'existingWiderTarget' as const }
            : {}),
        }];
      });
      const nodeIds = new Set(nodes.map((node) => node.pluginId));
      const roots = platformRoots.flatMap((root) => nodeIds.has(root.pluginId)
        ? [{ pluginId: root.pluginId, platform, scope }]
        : []);
      if (roots.length === 0) continue;
      const edges = nodes.flatMap((node) => {
        const entry = byId.get(node.pluginId)!;
        return entry.dependencies.flatMap((dependency) => {
          const dependencyId = formatPluginId({
            sourceId: entry.source.id,
            pluginName: dependency,
          });
          return nodeIds.has(dependencyId)
            ? [{ from: node.pluginId, to: dependencyId, platform }]
            : [];
        });
      });
      const plan = createDependencyPlacementPlan({
        requestedPluginIds: roots.map((root) => root.pluginId),
        nodes,
        roots,
        dependencyEdges: edges,
        scopeOverrides: intent.dependencyScopeOverrides.filter((override) =>
          nodeIds.has(override.pluginId)
          && (override.platform === undefined || override.platform === platform)),
      });
      for (const target of plan.targets) {
        add(
          target.pluginId,
          target.platform,
          target.resolvedScope,
          target.relation === 'requested' ? 'root' : 'dependency',
        );
      }
    }
  }
  return new Map([...desired].map(([key, value]) => [key, {
    scopes: [...value.scopes].sort(),
    relation: value.relation,
  }]));
}

function statusRecovery(options: {
  actual: StatusV6ActualState;
  desired: DesiredTargetState;
  platform: PlatformName;
  pluginId: string;
  sharedNative?: StatusV6Target['sharedNative'];
  conflictRoots?: Partial<Record<Scope, string[]>>;
  errorCodes?: string[];
}): StatusV6RecoveryAction[] {
  if (options.errorCodes?.some((code) =>
    code === 'codexProjectPluginVersionTooLow'
    || code === 'codexProjectPluginUnsupported'
    || code === 'codexSystemCliUnsupported')) {
    return [{
      command: 'manual',
      description: '升级或修复官方 system Codex CLI 后重试原操作。',
    }];
  }
  if (options.actual === 'ready' || options.actual === 'absent') return [];
  if (options.actual === 'orphaned') {
    return [{ command: 'cleanup', description: '清理可证明属于 AW 的遗留输出。' }];
  }
  if (options.actual === 'unresolved') {
    return [
      { command: 'sync', description: '来源恢复后同步 desired intent。' },
      { command: 'cleanup', description: '来源无法恢复时清理可证明属于 AW 的输出。' },
    ];
  }
  if (options.actual === 'conflict') {
    if (options.desired.scopes.includes('user') && options.desired.scopes.includes('project')) {
      return (['user', 'project'] as const).flatMap((scope) =>
        (options.conflictRoots?.[scope] ?? []).map((rootPluginId) => ({
          command: 'uninstall' as const,
          scope,
          description: `运行 aw uninstall ${rootPluginId} --platform ${options.platform} --scope ${scope}，再运行 aw sync ${options.pluginId} --platform ${options.platform} --scope ${scope === 'user' ? 'project' : 'user'}。`,
        })));
    }
    const collision = options.sharedNative?.state === 'foreign'
      ? `Codex shared native ${options.sharedNative.pluginId}`
      : `${options.pluginId} 的 foreign extension`;
    return [
      {
        command: 'sync',
        description: `先移除或重命名 ${collision}，再运行 aw sync ${options.pluginId} --platform ${options.platform}。cleanup 会保留 foreign 内容，不会删除该冲突。`,
      },
    ];
  }
  return [{
    command: options.actual === 'drifted' ? 'reinstall' : 'sync',
    ...(options.desired.scopes.length === 1 ? { scope: options.desired.scopes[0] } : {}),
    description: options.actual === 'drifted'
      ? '重新安装以修复手动修改或损坏的现场。'
      : '同步 desired intent 和当前现场。',
  }];
}

function rootIntentsForTarget(options: {
  pluginId: string;
  platform: PlatformName;
  userIntent: PluginIntentState;
  projectIntent: PluginIntentState;
  available: Array<{ name: string; dependencies: string[]; source: { id: string } }>;
}): Partial<Record<Scope, string[]>> {
  const byId = new Map(options.available.map((entry) => [
    formatPluginId({ sourceId: entry.source.id, pluginName: entry.name }),
    entry,
  ]));
  const result: Partial<Record<Scope, string[]>> = {};
  for (const [scope, intent] of [
    ['user', options.userIntent],
    ['project', options.projectIntent],
  ] as const) {
    const roots = intent.roots.filter((root) => {
      if (!root.platforms.includes(options.platform)) return false;
      const seen = new Set<string>();
      const reaches = (pluginId: string): boolean => {
        if (pluginId === options.pluginId) return true;
        if (seen.has(pluginId)) return false;
        seen.add(pluginId);
        const entry = byId.get(pluginId);
        return entry?.dependencies.some((dependency) => reaches(formatPluginId({
          sourceId: entry.source.id,
          pluginName: dependency,
        }))) === true;
      };
      return reaches(root.pluginId);
    }).map((root) => root.pluginId).sort();
    if (roots.length > 0) result[scope] = roots;
  }
  return result;
}

function projectedLiveState(options: {
  inspection: OwnershipInspection;
  required: readonly OwnedComponent[];
  optional: readonly OwnedComponent[];
}): StatusV6Target['state'] {
  if (options.inspection.state === 'error'
    || options.inspection.components.some((entry) => entry.state === 'error')) return 'error';
  const owned = options.inspection.components.filter((entry) => (
    entry.state === 'present' || entry.state === 'partial'
  ));
  if (owned.length === 0) return 'absent';
  if (owned.some((entry) => entry.state === 'partial')) return 'partial';
  const required = new Set(options.required);
  const optional = new Set(options.optional);
  if (options.inspection.components.some((entry) =>
    entry.state === 'present' && !required.has(entry.component) && !optional.has(entry.component))) {
    return 'partial';
  }
  if (!options.required.every((component) => options.inspection.components.some((entry) =>
    entry.component === component && entry.state === 'present'))) return 'partial';
  if (options.required.length > 0) return 'present';
  return options.optional.some((component) => options.inspection.components.some((entry) =>
    entry.component === component && entry.state === 'present')) ? 'present' : 'absent';
}

export function projectTargetRevision(
  availableVersion: string | undefined,
  installedVersion: string | undefined,
): TargetRevisionState {
  if (!availableVersion || !installedVersion
    || !tryParseStrictSemVer(availableVersion)
    || !tryParseStrictSemVer(installedVersion)) {
    return {
      state: 'unknown',
      ...(availableVersion ? { availableVersion } : {}),
      ...(installedVersion ? { installedVersion } : {}),
    };
  }
  const relation = compareStrictSemVer(installedVersion, availableVersion);
  if (relation === 0) return { state: 'current', availableVersion, installedVersion };
  if (relation < 0) return { state: 'upgradeAvailable', availableVersion, installedVersion };
  return { state: 'unknown', availableVersion, installedVersion };
}

function renderStatusV6(payload: StatusV6Payload, verbose: boolean): string {
  const lines = [`Catalog sources: ${payload.catalog.sources.length}`];
  for (const source of payload.catalog.sources) {
    lines.push(`${source.primary ? '*' : '-'} ${source.id}: ${source.error ?? source.freshness ?? 'unavailable'}`);
  }
  for (const target of payload.targets) {
    const errors = target.errors.length > 0
      ? ` [${target.errors.map((error) => `${error.code}: ${error.message}`).join('; ')}]`
      : '';
    const desired = target.desired.enabled ? target.desired.scopes.join('+') : 'absent';
    lines.push(`${target.pluginId} ${target.platform}: desired=${desired} actual=${target.actual.state}${errors}`);
    if (target.sharedNative) {
      lines.push(`  shared native ${target.sharedNative.pluginId}: ${target.sharedNative.state}`);
    }
    if (target.activation) {
      lines.push(`  activation user=${String(target.activation.user)} project=${String(target.activation.project)} (${target.activation.evidence})`);
      if (target.activation.systemConsumer) {
        const version = 'detectedVersion' in target.activation.systemConsumer
          ? ` ${target.activation.systemConsumer.detectedVersion}`
          : '';
        lines.push(`  system Codex consumer: ${target.activation.systemConsumer.state}${version}`);
      }
    }
    if (target.extensions) {
      lines.push(`  extensions ${target.extensions.kinds.join(',')}: ${target.extensions.state}`);
    }
    if (verbose) {
      for (const component of target.components) {
        const error = component.error
          ? ` [${component.error.code}: ${component.error.message}]`
          : '';
        lines.push(`  component ${component.key}: ${component.state}${error}`);
      }
    }
  }
  for (const error of payload.errors) lines.push(`Error: ${error.message}`);
  return lines.join('\n');
}

function collisionMessage(collision: ArtifactCollisionEvidence): string {
  const reason = {
    ownerMismatch: '已有内容属于其他 owner',
    unownedContent: '已有内容没有 AW owner 标记',
    typeMismatch: '已有内容类型与目标不匹配',
  }[collision.reason];
  return `artifactCollision: ${collision.artifactKind} ${collision.artifactKey}: ${reason}。请移除或迁移冲突内容后重试。`;
}

function collisionRootIssueId(options: {
  pluginId: string;
  platform: PlatformName;
  scope: Scope;
  collision: ArtifactCollisionEvidence;
}): string {
  return [
    'artifactCollision',
    options.pluginId,
    options.platform,
    options.scope,
    options.collision.artifactKind,
    options.collision.artifactKey,
  ].join(':');
}

export async function statusCommandV6(options: {
  plugins?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cliVersion?: string;
  platform?: string;
  scope?: string;
  json?: boolean;
  verbose?: boolean;
  catalogOperationContext?: CatalogOperationContext;
  inventoryCatalogSourceReferences?: typeof inventoryCatalogSourceReferences;
}): Promise<{
  payload: StatusV6Payload;
  output: string;
  hasErrors: boolean;
  pluginSummaries: StatusV6PluginSummary[];
  targetRevisions: StatusTargetRevision[];
}> {
  const env = options.env ?? process.env;
  const dependencyPluginCache = new Map<string, Promise<PluginMeta>>();
  const dependencyInspectionCache = new Map<
    string,
    Promise<{
      state: StatusV6DependencyReadinessState;
      rootIssueId?: string;
      rootIssueCode?: string;
    }>
  >();
  const cliVersion = options.cliVersion ?? assertStrictSemVer(
    (JSON.parse(fs.readFileSync(path.join(resolveCliPackageRoot(), 'package.json'), 'utf8')) as {
      version?: unknown;
    }).version,
    'packages/cli/package.json version',
  );
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  const intentErrors: Array<{ code: string; message: string }> = [];
  const readIntent = async (scope: Scope): Promise<PluginIntentState> => {
    try {
      return await readPluginIntentState({ scope, cwd: options.cwd, env });
    } catch {
      intentErrors.push({
        code: 'pluginIntentStateInvalid',
        message: `pluginIntentStateInvalid: ${scope} plugin intent state is invalid.`,
      });
      return emptyIntent();
    }
  };
  const [userIntent, projectIntent] = await Promise.all([
    readIntent('user'),
    readIntent('project'),
  ]);
  const codexConfigErrors: Array<{ scope: Scope; code: string; message: string }> = [];
  const readActivationConfig = async (scope: Scope) => {
    try {
      return await readCodexConfigFile(resolveCodexPaths(options.cwd, scope, env).configTomlPath);
    } catch {
      codexConfigErrors.push({
        scope,
        code: 'codexActivationDrift',
        message: `codexActivationDrift: ${scope} Codex activation config is unreadable.`,
      });
      return undefined;
    }
  };
  const [userCodexConfig, projectCodexConfig] = await Promise.all([
    readActivationConfig('user'),
    readActivationConfig('project'),
  ]);
  const currentProjectKey = await resolveCanonicalRepoProjectKey(options.cwd);
  const currentProjectLocationKey = createProjectLocationKey(currentProjectKey);
  const codexScopePathsAlias = codexProjectConfigAliasesUserHome(options.cwd, env);
  const inventoryErrors: StatusInventoryError[] = [];
  const readInventory = options.inventoryCatalogSourceReferences
    ?? inventoryCatalogSourceReferences;
  const ownerInventory = await readInventory({ cwd: options.cwd, env }).catch(async (error) => {
    inventoryErrors.push(projectStateInventoryError(error, env, options.cwd));
    return inventoryLegacyOwnerReferences({ cwd: options.cwd, env }).catch((fallbackError) => {
      inventoryErrors.push(projectStateInventoryError(fallbackError, env, options.cwd));
      return { inventorySchemaVersion: 1 as const, references: [], errors: [] };
    });
  });
  for (const error of ownerInventory.errors ?? []) {
    const code = error.kind === 'nativeStateRead' ? 'nativeStateUnreadable' : 'stateInventoryFailed';
    inventoryErrors.push({
      code,
      message: `${code}: ${error.kind}@${error.location}: ${error.message}`,
      relevance: error.relevance,
    });
  }
  const nativeCliRunner = getDefaultNativeCliRunner();
  const codexSystemConsumerInspections = new Map<Scope, Promise<SystemCodexFilesystemInspection>>();
  const inspectCodexSystemConsumer = (scope: Scope) => {
    let inspection = codexSystemConsumerInspections.get(scope);
    if (!inspection) {
      inspection = inspectSystemCodexFilesystem({
        cwd: options.cwd,
        env,
        operationRequirement: getCodexOperationRequirement(scope),
      });
      codexSystemConsumerInspections.set(scope, inspection);
    }
    return inspection;
  };
  const codexRegistrationCache = new Map<
    string,
    ReturnType<typeof inspectCodexPluginRegistrationLive>
  >();
  const inspectCodexRegistration = async (pluginId: string, scope: Scope) => {
    const consumer = await inspectCodexSystemConsumer(scope);
    if (consumer.state !== 'compatible') {
      return {
        entries: [],
        observations: { user: false, project: false },
        activations: {},
      };
    }
    let inspection = codexRegistrationCache.get(pluginId);
    if (!inspection) {
      inspection = inspectCodexPluginRegistrationLive({
        pluginId,
        cwd: options.cwd,
        env,
        nativeCliRunner,
      });
      codexRegistrationCache.set(pluginId, inspection);
    }
    return inspection;
  };
  const nativeProbeCache = new Map<string, Promise<OwnedProbeResult>>();
  const codexDesiredUserActivationIds = new Set<string>();
  const readOnlyNativeProbe = (probe: {
    pluginName: string;
    sourceId: string;
    sourceIdentity: string;
    platform: PlatformName;
    scope: Scope;
    marketplaceName: string;
    marketplaceRoot: string;
  }) => async (): Promise<OwnedProbeResult> => {
    const key = [
      probe.sourceIdentity,
      probe.pluginName,
      probe.platform,
      probe.scope,
      probe.marketplaceName,
    ].join('\0');
    let value = nativeProbeCache.get(key);
    if (!value) {
      value = probe.platform === 'codex'
          ? inspectCodexRegistration(
            `${probe.pluginName}@${probe.marketplaceName}`,
            options.scope === undefined ? probe.scope : scopes[0]!,
          ).then((registration) => registration.entries.some((entry) =>
            entry.pluginId === `${probe.pluginName}@${probe.marketplaceName}`)
            ? 'present' as const
            : 'absent' as const)
        : Promise.resolve(ownerInventory.references.some((reference) =>
            (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
            && reference.sourceId === probe.sourceId
            && reference.sourceIdentity === probe.sourceIdentity
            && reference.pluginName === probe.pluginName
            && reference.platform === probe.platform
            && reference.scope === probe.scope
            && (probe.scope === 'user' || reference.projectKey === currentProjectKey))
          ? 'present'
          : 'absent');
      nativeProbeCache.set(key, value);
    }
    return value;
  };
  const hasCurrentCodexProjectOwner = (sourceId: string, pluginName: string): boolean =>
    ownerInventory.references.some((reference) =>
      reference.kind === 'namespacedOwner'
      && reference.sourceId === sourceId
      && reference.pluginName === pluginName
      && reference.platform === 'codex'
      && reference.scope === 'project'
      && reference.projectKey === currentProjectKey);
  const configured = new Map(snapshot.config.sources.map((source) => [source.id, source]));
  const requested = options.plugins ?? [];
  const platforms = selectedPlatforms(options.platform);
  const scopes = selectedScopes(options.scope);
  const selectorErrors: Array<{ code: string; message: string }> = [];
  const parsedSelectors: PlannedStatusSelector[] = [];
  const plannedSelectors: PlannedStatusSelector[] = [];
  const liveOnlySelectors: PlannedStatusSelector[] = [];
  for (const selector of requested) {
    let parsed: ReturnType<typeof parsePluginId>;
    try {
      parsed = parsePluginId(selector);
    } catch (error) {
      selectorErrors.push({
        code: 'invalidPluginSelector',
        message: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    parsedSelectors.push({ raw: selector, parsed });
    if (parsed.sourceId !== undefined && !configured.has(parsed.sourceId)) {
      const hasLiveReference = ownerInventory.references.some((reference) =>
        (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
        && reference.sourceId === parsed.sourceId
        && reference.pluginName === parsed.pluginName
        && platforms.includes(reference.platform as PlatformName)
        && scopes.includes(reference.scope as Scope)
        && (reference.scope !== 'project' || reference.projectKey === currentProjectKey));
      if (hasLiveReference) {
        liveOnlySelectors.push({ raw: selector, parsed });
      } else if (!inventoryErrors.some((error) => inventoryErrorMatchesSelection({
        error,
        selectors: [{ raw: selector, parsed }],
        platformExplicit: options.platform !== undefined,
        scopeExplicit: options.scope !== undefined,
        platforms,
        scopes,
        currentProjectLocationKey,
      }))) {
        selectorErrors.push({
          code: 'pluginNotFound',
          message: `Plugin "${selector}" was not found because catalog source "${parsed.sourceId}" is not configured.`,
        });
      }
      continue;
    }
    plannedSelectors.push({ raw: selector, parsed });
  }
  const selectedInventoryErrors = inventoryErrors.filter((error) => inventoryErrorMatchesSelection({
    error,
    selectors: parsedSelectors,
    platformExplicit: options.platform !== undefined,
    scopeExplicit: options.scope !== undefined,
    platforms,
    scopes,
    currentProjectLocationKey,
  }));
  const plannedSourceIds = requested.length === 0
    ? undefined
    : planPluginSelectorSourceIds(plannedSelectors.map((selector) => selector.parsed));
  const selectedConfiguredSources = plannedSourceIds === undefined
    ? snapshot.config.sources
    : plannedSourceIds.map((sourceId) => configured.get(sourceId)!);
  const identityEntries = await Promise.all(selectedConfiguredSources.map(async (source): Promise<[
    string,
    { identity?: string; error?: string },
  ]> => {
    try {
      return [source.id, { identity: await calculateCatalogSourceIdentity(source) }];
    } catch (error) {
      const sanitized = sanitizeCatalogSourceError(error, env);
      return [source.id, {
        error: sanitized.message,
      }];
    }
  }));
  const identities = new Map(identityEntries);
  const catalog = await withResolvedMultiSourceCatalog({
    cliVersion,
    configSnapshot: snapshot,
    ...(plannedSourceIds === undefined ? {} : { sourceIds: plannedSourceIds }),
    ...(options.catalogOperationContext
      ? { operationContext: options.catalogOperationContext }
      : {}),
    env,
    consume: async (resolution) => ({
      primarySourceId: resolution.primarySourceId,
      configDigest: resolution.configDigest,
      compositeDigest: resolution.compositeDigest,
      sources: await Promise.all(resolution.sources.map(async (item) => {
        const source = configured.get(item.sourceId)!;
        const identity = identities.get(item.sourceId)!;
        const base = {
          id: item.sourceId,
          identity: identity.identity ?? 'unavailable',
          type: source.type,
          primary: source.primary,
          requestedRef: item.resolution?.requestedRef ?? sourceRequestedRef(source, cliVersion),
        };
        if (identity.error || item.error) {
          const error = item.error ?? new Error(identity.error);
          return {
            ...base,
            error: [identity.error, item.error?.message].filter(Boolean).join('; '),
            errorCode: catalogSourceErrorCode(error),
          };
        }
        try {
          const placementEntries = item.resolution!.manifest.entries.map((entry) => {
            const products = entry.policy.products;
            const supports = (platform: PlatformName): boolean => products === undefined
              || products.includes(platform === 'codex' ? 'CODEX' : 'CLAUDE');
            return {
              name: entry.name,
              dependencies: entry.dependencies,
              source: { id: item.resolution!.sourceId },
              targets: {
                codex: { user: supports('codex'), project: supports('codex') },
                claude: { user: supports('claude'), project: supports('claude') },
              },
            };
          });
          const sourceDesired = calculateDesiredTargetStates({
            userIntent,
            projectIntent,
            available: placementEntries,
            codexProjectAllowed: !codexScopePathsAlias,
          });
          const registeredNames = canonicalMarketplaceRegistrationNames(
            ownerInventory.references,
            item.resolution!.sourceId,
          );
          if (registeredNames.length > 1) {
            throw new Error(
              'marketplaceIdentityUnavailable: Multiple canonical native marketplace registrations match the source.',
            );
          }
          const desiredMarketplaceName = registeredNames[0]
            ?? (item.resolution!.sourceId === resolution.primarySourceId
              ? 'aw'
              : `aw-${item.resolution!.sourceId}`);
          for (const entry of placementEntries) {
            const pluginId = formatPluginId({
              sourceId: item.resolution!.sourceId,
              pluginName: entry.name,
            });
            if (sourceDesired.get(desiredTargetKey(pluginId, 'codex'))?.scopes.includes('user')) {
              codexDesiredUserActivationIds.add(`${entry.name}@${desiredMarketplaceName}`);
            }
          }
          const plugins: StatusPluginCapability[] = await Promise.all(
            item.resolution!.manifest.entries.map(async (entry) => {
              const capabilitySupport = checkAwCapabilitySupport(
                entry.requires.aw.capabilities ?? [],
                IMPLEMENTED_AW_CAPABILITIES,
              );
              if (!capabilitySupport.supported) {
                const products = entry.policy.products;
                const supports = (platform: PlatformName): boolean => products === undefined
                  || products.includes(platform === 'codex' ? 'CODEX' : 'CLAUDE');
                const states: StatusPluginCapability['states'] = {};
                const message = `awCapabilityUnsupported: ${item.resolution!.sourceId}/${entry.name} requires unsupported AW capabilities: ${capabilitySupport.missing.join(', ')}.`;
                for (const platform of ['codex', 'claude'] as const) {
                  if (!supports(platform)) continue;
                  states[platform] = {};
                  for (const scope of ['user', 'project'] as const) {
                    states[platform]![scope] = {
                      state: 'error',
                      components: [],
                      errors: [finalizeTargetError({ code: 'awCapabilityUnsupported', message }, 'error')],
                    };
                  }
                }
                return {
                  name: entry.name,
                  version: entry.version,
                  sharedNativePayloadDigest: entry.contentDigest,
                  displayName: entry.interface?.displayName ?? entry.name,
                  shortDescription: entry.interface?.shortDescription ?? entry.description,
                  description: entry.description,
                  targets: {
                    claude: { user: supports('claude'), project: supports('claude') },
                    codex: { user: supports('codex'), project: supports('codex') },
                  },
                  states,
                  dependencies: entry.dependencies,
                  missingCapabilities: capabilitySupport.missing,
                };
              }
              const plugin = await readPluginManifest(
                path.join(item.resolution!.rootDir, 'plugins', entry.name),
                { mode: 'bundle' },
              );
              const claude = supportsPlatform(plugin.manifest, 'claude');
              const codex = supportsPlatform(plugin.manifest, 'codex');
              const codexSurface = analyzeCodexSurface(plugin.manifest);
              const sharedNativePayloadDigest = codexSurface.nativeKinds.length > 0
                ? await calculateCodexSharedNativePayloadDigest(plugin.rootDir)
                : entry.contentDigest;
              plugin.sourceId = item.resolution!.sourceId;
              plugin.sourceIdentity = item.resolution!.sourceIdentity;
              plugin.pluginId = formatPluginId({ sourceId: item.resolution!.sourceId, pluginName: entry.name });
              let effectiveConfig: Awaited<ReturnType<typeof resolveEffectivePluginConfig>> | undefined;
              let configDiagnostic: StatusV6PluginSummary['configDiagnostic'];
              if (plugin.manifest.config?.schema) {
                try {
                  effectiveConfig = await resolveEffectivePluginConfig({
                    sourceId: plugin.sourceId,
                    sourceIdentity: plugin.sourceIdentity,
                    pluginName: plugin.manifest.name,
                    manifest: plugin.manifest,
                    cwd: options.cwd,
                    env,
                  });
                } catch {
                  configDiagnostic = {
                    code: 'configReadFailed',
                    message: '插件设置当前不可读。未读取或显示设置值。',
                  };
                }
              }
              const states: StatusPluginCapability['states'] = {};
              const defaultMarketplaceName = item.resolution!.sourceId === resolution.primarySourceId
                ? 'aw'
                : `aw-${item.resolution!.sourceId}`;
              const marketplaceNameFor = (
                pluginName: string,
                platform: PlatformName,
                scope: Scope,
              ): string => {
                const liveName = ownerInventory.references.find((reference) =>
                  (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
                  && reference.sourceId === item.resolution!.sourceId
                  && reference.sourceIdentity === item.resolution!.sourceIdentity
                  && reference.pluginName === pluginName
                  && reference.platform === platform
                  && reference.scope === scope
                  && (scope === 'user' || reference.projectKey === currentProjectKey)
                  && reference.marketplaceName)?.marketplaceName;
                if (liveName) return liveName;
                const registeredNames = canonicalMarketplaceRegistrationNames(
                  ownerInventory.references,
                  item.resolution!.sourceId,
                );
                if (registeredNames.length > 1) {
                  throw new Error(
                    'marketplaceIdentityUnavailable: Multiple canonical native marketplace registrations match the source.',
                  );
                }
                return registeredNames[0] ?? defaultMarketplaceName;
              };
              const marketplaceRoot = path.join(resolveAwHome(env), 'marketplaces', item.resolution!.sourceId);
              for (const platform of ['codex', 'claude'] as const) {
                states[platform] = {};
                for (const scope of ['user', 'project'] as const) {
                  if (platform === 'codex'
                    && scope === 'project'
                    && codexScopePathsAlias
                    && !hasCurrentCodexProjectOwner(item.resolution!.sourceId, entry.name)) continue;
                  const supported = platform === 'claude'
                    ? claude
                    : codex && codexSurface.ok;
                  if (!supported) continue;
                  const changedOwner = ownerInventory.references.find((reference) =>
                    (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
                    && reference.sourceId === item.resolution!.sourceId
                    && reference.pluginName === entry.name
                    && reference.platform === platform
                    && reference.scope === scope
                    && (scope === 'user' || reference.projectKey === currentProjectKey)
                    && reference.sourceIdentity
                    && reference.sourceIdentity !== item.resolution!.sourceIdentity);
                  if (changedOwner) {
                    states[platform]![scope] = {
                      state: 'error',
                      components: [],
                      errors: [finalizeTargetError({
                        code: 'sourceChanged',
                        message: `sourceChanged: owner at ${changedOwner.location} has a different source identity.`,
                      }, 'error')],
                    };
                    continue;
                  }
                  try {
                    const marketplaceName = marketplaceNameFor(entry.name, platform, scope);
                    const inspected = await inspectRebuildTarget({
                      sourceId: item.resolution!.sourceId,
                      sourceIdentity: item.resolution!.sourceIdentity,
                      pluginId: plugin.pluginId,
                      marketplaceName,
                      marketplaceRoot,
                      plugin,
                      platform,
                      scope,
                      cwd: options.cwd,
                      catalog: {
                        rootDir: item.resolution!.rootDir,
                        source: 'local',
                      },
                      context: {
                        env,
                        nativeCliRunner: getDefaultNativeCliRunner(),
                        reporter: createNoopReporter(),
                        debugLogger: createNoopDebugLogger(),
                      },
                      userActivationDesired: codexDesiredUserActivationIds,
                      nativeProbe: readOnlyNativeProbe({
                        pluginName: entry.name,
                        sourceId: item.resolution!.sourceId,
                        sourceIdentity: item.resolution!.sourceIdentity,
                        platform,
                        scope,
                        marketplaceName,
                        marketplaceRoot,
                      }),
                    });
                    const liveState = projectedLiveState({
                      inspection: inspected.inspection,
                      required: inspected.target.desiredOwnedComponents ?? inspected.target.ownedComponents,
                      optional: inspected.target.optionalOwnedComponents ?? [],
                    });
                    const collisionErrors: StatusV6TargetError[] = inspected.inspection.components.flatMap(
                      (component) => component.collision ? [finalizeTargetError({
                        code: 'artifactCollision',
                        message: collisionMessage(component.collision),
                        collision: component.collision,
                        rootIssueId: collisionRootIssueId({
                          pluginId: formatPluginId({
                            sourceId: item.resolution!.sourceId,
                            pluginName: entry.name,
                          }),
                          platform,
                          scope,
                          collision: component.collision,
                        }),
                        rootIssueCode: 'artifactCollision',
                      }, liveState)] : [],
                    );
                    const dependencyErrors: StatusV6TargetError[] = [];
                    const dependencyReadiness: StatusV6DependencyReadiness[] = [];
                    const directDependencies = plugin.manifest.dependencies ?? [];
                    if (directDependencies.length > 0
                      && (liveState === 'present' || liveState === 'partial')) {
                      for (const dependencyName of directDependencies) {
                        const dependencyId = formatPluginId({
                          sourceId: item.resolution!.sourceId,
                          pluginName: dependencyName,
                        });
                        const dependencyEntry = item.resolution!.manifest.entries.find((candidate) =>
                          candidate.name === dependencyName);
                        if (!dependencyEntry) {
                          const rootIssueId = `dependencyMissing:${dependencyId}:${platform}:${scope}`;
                          dependencyReadiness.push({
                            dependencyPluginId: dependencyId,
                            state: 'absent',
                            rootIssueId,
                            rootIssueCode: 'dependencyMissing',
                          });
                          dependencyErrors.push(finalizeTargetError({
                            code: 'dependencyMissing',
                            message: `dependencyMissing: ${dependencyId} is not available in the current source snapshot.`,
                            dependencyPluginId: dependencyId,
                            rootIssueId,
                            rootIssueCode: 'dependencyMissing',
                          }, 'partial'));
                          continue;
                        }
                        const dependencySupport = checkAwCapabilitySupport(
                          dependencyEntry.requires.aw.capabilities ?? [],
                          IMPLEMENTED_AW_CAPABILITIES,
                        );
                        if (!dependencySupport.supported) {
                          const rootIssueId = `awCapabilityUnsupported:${dependencyId}`;
                          dependencyReadiness.push({
                            dependencyPluginId: dependencyId,
                            state: 'error',
                            rootIssueId,
                            rootIssueCode: 'awCapabilityUnsupported',
                          });
                          dependencyErrors.push(finalizeTargetError({
                            code: 'awCapabilityUnsupported',
                            message: `awCapabilityUnsupported: ${dependencyId} requires unsupported AW capabilities: ${dependencySupport.missing.join(', ')}.`,
                            dependencyPluginId: dependencyId,
                            rootIssueId,
                            rootIssueCode: 'awCapabilityUnsupported',
                          }, 'partial'));
                          continue;
                        }
                        const pluginCacheKey = [item.resolution!.sourceIdentity, dependencyId].join('\0');
                        let dependencyPluginPromise = dependencyPluginCache.get(pluginCacheKey);
                        if (!dependencyPluginPromise) {
                          dependencyPluginPromise = readPluginManifest(
                            path.join(item.resolution!.rootDir, 'plugins', dependencyName),
                            { mode: 'bundle' },
                          ).then((dependencyPlugin) => {
                            dependencyPlugin.sourceId = item.resolution!.sourceId;
                            dependencyPlugin.sourceIdentity = item.resolution!.sourceIdentity;
                            dependencyPlugin.pluginId = dependencyId;
                            return dependencyPlugin;
                          });
                          dependencyPluginCache.set(pluginCacheKey, dependencyPluginPromise);
                        }
                        const placements: Scope[] = scope === 'project' ? ['project', 'user'] : ['user'];
                        let dependencyResult: {
                          state: StatusV6DependencyReadinessState;
                          rootIssueId?: string;
                          rootIssueCode?: string;
                        } = {
                          state: 'absent',
                        };
                        for (const dependencyScope of placements) {
                          const inspectionCacheKey = [
                            item.resolution!.sourceIdentity,
                            dependencyId,
                            platform,
                            dependencyScope,
                            dependencyScope === 'project' ? currentProjectKey : '',
                          ].join('\0');
                          let dependencyInspection = dependencyInspectionCache.get(inspectionCacheKey);
                          if (!dependencyInspection) {
                            dependencyInspection = dependencyPluginPromise.then(async (dependencyPlugin) => {
                              dependencyInspectionHookForTests?.();
                              const dependencyMarketplaceName = marketplaceNameFor(
                                dependencyName,
                                platform,
                                dependencyScope,
                              );
                              const dependencyInspected = await inspectRebuildTarget({
                                sourceId: item.resolution!.sourceId,
                                sourceIdentity: item.resolution!.sourceIdentity,
                                pluginId: dependencyId,
                                marketplaceName: dependencyMarketplaceName,
                                marketplaceRoot,
                                plugin: dependencyPlugin,
                                platform,
                                scope: dependencyScope,
                                cwd: options.cwd,
                                catalog: { rootDir: item.resolution!.rootDir, source: 'local' },
                                context: {
                                  env,
                                  nativeCliRunner: getDefaultNativeCliRunner(),
                                  reporter: createNoopReporter(),
                                  debugLogger: createNoopDebugLogger(),
                                },
                                userActivationDesired: codexDesiredUserActivationIds,
                                nativeProbe: readOnlyNativeProbe({
                                  pluginName: dependencyName,
                                  sourceId: item.resolution!.sourceId,
                                  sourceIdentity: item.resolution!.sourceIdentity,
                                  platform,
                                  scope: dependencyScope,
                                  marketplaceName: dependencyMarketplaceName,
                                  marketplaceRoot,
                                }),
                              });
                              const dependencyLiveState = projectedLiveState({
                                inspection: dependencyInspected.inspection,
                                required: dependencyInspected.target.desiredOwnedComponents
                                  ?? dependencyInspected.target.ownedComponents,
                                optional: dependencyInspected.target.optionalOwnedComponents ?? [],
                              });
                              const collision = dependencyInspected.inspection.components.find(
                                (component) => component.collision,
                              )?.collision;
                              if (collision) {
                                return {
                                  state: 'blockedByCollision' as const,
                                  rootIssueId: collisionRootIssueId({
                                    pluginId: dependencyId,
                                    platform,
                                    scope: dependencyScope,
                                    collision,
                                  }),
                                  rootIssueCode: 'artifactCollision',
                                };
                              }
                              return {
                                state: dependencyLiveState === 'present' ? 'ready' as const
                                  : dependencyLiveState === 'absent' ? 'absent' as const
                                    : dependencyLiveState === 'partial' ? 'incomplete' as const
                                      : 'error' as const,
                                ...(dependencyLiveState === 'partial'
                                  ? {
                                      rootIssueId: `incompleteInstallation:${dependencyId}:${platform}:${dependencyScope}`,
                                      rootIssueCode: 'incompleteInstallation',
                                    }
                                  : dependencyLiveState === 'error'
                                    ? {
                                        rootIssueId: `diagnostic:${dependencyId}:${platform}:${dependencyScope}`,
                                        rootIssueCode: 'diagnostic',
                                      }
                                    : {}),
                              };
                            }).catch(() => ({
                              state: 'error' as const,
                              rootIssueId: `diagnostic:${dependencyId}:${platform}:${dependencyScope}`,
                              rootIssueCode: 'diagnostic',
                            }));
                            dependencyInspectionCache.set(inspectionCacheKey, dependencyInspection);
                          }
                          const candidate = await dependencyInspection;
                          if (candidate.state === 'ready') {
                            dependencyResult = candidate;
                            break;
                          }
                          const priority: Record<StatusV6DependencyReadinessState, number> = {
                            ready: 5,
                            blockedByCollision: 4,
                            incomplete: 3,
                            error: 2,
                            absent: 1,
                          };
                          if (priority[candidate.state] > priority[dependencyResult.state]) {
                            dependencyResult = candidate;
                          }
                        }
                        if (dependencyResult.state === 'absent') {
                          dependencyResult = {
                            state: 'absent',
                            rootIssueId: `dependencyMissing:${dependencyId}:${platform}:${scope}`,
                            rootIssueCode: 'dependencyMissing',
                          };
                        }
                        dependencyReadiness.push({
                          dependencyPluginId: dependencyId,
                          ...dependencyResult,
                        });
                        if (dependencyResult.state === 'absent') {
                          dependencyErrors.push(finalizeTargetError({
                            code: 'dependencyMissing',
                            message: `dependencyMissing: ${dependencyId} is absent from its required live placement.`,
                            dependencyPluginId: dependencyId,
                            rootIssueId: dependencyResult.rootIssueId,
                            rootIssueCode: dependencyResult.rootIssueCode,
                          }, 'partial'));
                        } else if (dependencyResult.state !== 'ready') {
                          dependencyErrors.push(finalizeTargetError({
                            code: 'dependencyNotReady',
                            message: `dependencyNotReady: ${dependencyId} is not ready at its required live placement.`,
                            dependencyPluginId: dependencyId,
                            ...(dependencyResult.rootIssueId
                              ? { rootIssueId: dependencyResult.rootIssueId }
                              : {}),
                            ...(dependencyResult.rootIssueCode
                              ? { rootIssueCode: dependencyResult.rootIssueCode }
                              : {}),
                          }, 'partial'));
                        }
                      }
                    }
                    states[platform]![scope] = {
                      state: liveState,
                      errors: [...inspected.inspection.errors.map((error) => finalizeTargetError({
                        code: 'componentInspectionFailed',
                        message: `${error.label}: ${error.message}`,
                      }, liveState)), ...collisionErrors, ...dependencyErrors],
                      ...(dependencyReadiness.length > 0 ? { dependencyReadiness } : {}),
                      components: inspected.inspection.components.map((component) => {
                            const projectedError = component.collision
                              ? projectTargetError({
                                  code: 'artifactCollision',
                                  message: collisionMessage(component.collision),
                                  collision: component.collision,
                                }, env, options.cwd, liveState)
                              : component.diagnostic
                              ? projectTargetError({
                                  code: 'componentInspectionFailed',
                                  message: component.diagnostic,
                                }, env, options.cwd, liveState)
                              : undefined;
                            return {
                              key: component.component.identity.artifactKey,
                              state: component.state,
                              ...(projectedError ? { error: projectedError } : {}),
                            };
                          }),
                      ...(inspected.installedVersion
                        ? { installedVersion: inspected.installedVersion }
                        : {}),
                    };
                  } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    const configErrorCode = platform === 'codex' && codexConfigErrors.length > 0
                      ? codexSurface.nativeKinds.length > 0
                        ? 'codexSharedNativeCorrupt'
                        : 'codexActivationDrift'
                      : undefined;
                    const code = configErrorCode
                      ?? message.split(':', 1)[0]
                      ?? 'targetInspectionFailed';
                    states[platform]![scope] = {
                      state: 'error',
                      components: [],
                      errors: [finalizeTargetError({
                        code,
                        message: configErrorCode
                          ? `${configErrorCode}: Codex activation state is unreadable.`
                          : message,
                      }, 'error')],
                    };
                  }
                }
              }
              let codexStatus: StatusPluginCapability['codex'];
              if (codex && codexSurface.ok) {
                const marketplaceName = marketplaceNameFor(entry.name, 'codex', 'user');
                const codexPluginId = `${entry.name}@${marketplaceName}`;
                const desiredCodexScopes = sourceDesired.get(desiredTargetKey(
                  formatPluginId({ sourceId: item.resolution!.sourceId, pluginName: entry.name }),
                  'codex',
                ))?.scopes ?? [];
                const registrationScope: Scope = options.scope !== undefined
                  ? scopes[0]!
                  : desiredCodexScopes.includes('project')
                    ? 'project'
                    : desiredCodexScopes.includes('user') ? 'user' : 'project';
                const pluginRegistration = codexSurface.nativeKinds.length > 0
                  ? await inspectCodexRegistration(codexPluginId, registrationScope)
                  : {
                      entries: [],
                      observations: { user: false, project: false },
                      activations: {},
                    };
                let residueFailed = false;
                const sharedInspection = codexSurface.nativeKinds.length > 0
                  ? await inspectCodexSharedNativeLive({
                      pluginName: entry.name,
                      desiredVersion: entry.version,
                      expectedPayloadDigest: sharedNativePayloadDigest,
                      cwd: options.cwd,
                      env,
                      managedByCurrentIntent: false,
                      marketplaceName,
                      marketplaceRoot,
                      nativeCliRunner,
                      pluginRegistration,
                    }).catch(() => {
                      residueFailed = true;
                      return undefined;
                    })
                  : undefined;
                const nativeState = sharedInspection?.sharedNative;
                const sharedNative: StatusV6Target['sharedNative'] = residueFailed
                  ? { pluginId: codexPluginId, state: 'corrupt', shared: true }
                  : !nativeState
                  ? undefined
                  : nativeState.state === 'foreign'
                    ? { pluginId: codexPluginId, state: 'foreign', shared: true }
                    : nativeState.state === 'absent'
                      ? {
                          pluginId: codexPluginId,
                          state: 'missing',
                          shared: true,
                          ...(nativeState.diagnostic === 'staleCacheObserved'
                            ? { diagnostic: nativeState.diagnostic }
                            : {}),
                        }
                      : nativeState.state === 'corrupt'
                        ? { pluginId: codexPluginId, state: 'corrupt', shared: true }
                        : nativeState.state === 'outdated'
                          ? {
                              pluginId: codexPluginId,
                              state: 'outdated',
                              version: nativeState.version,
                              shared: true,
                            }
                        : nativeState.state === 'present' || nativeState.state === 'claimable'
                          ? {
                              pluginId: codexPluginId,
                              state: 'present',
                              version: nativeState.version,
                              shared: true,
                            }
                          : undefined;
                const configuredUserActivation = userCodexConfig
                  ?.snapshot.plugins[codexPluginId]?.enabled;
                const configuredProjectActivation = projectCodexConfig
                  ?.snapshot.plugins[codexPluginId]?.enabled;
                const userActivation = sharedInspection?.activationObservations.user
                  ? sharedInspection.activations.user === true
                  : configuredUserActivation;
                const projectActivation = sharedInspection?.activationObservations.project
                  && configuredProjectActivation !== undefined
                  ? configuredProjectActivation && sharedInspection.activations.project === true
                  : configuredProjectActivation;
                const activationObserved = registrationScope === 'project'
                  ? sharedInspection?.activationObservations.project === true
                  : sharedInspection?.activationObservations.user === true;
                codexStatus = {
                  pluginId: codexPluginId,
                  nativeKinds: codexSurface.nativeKinds,
                  extensionKinds: codexSurface.extensionKinds,
                  ...(sharedNative ? { sharedNative } : {}),
                  activation: {
                    ...(userActivation !== undefined ? { user: userActivation } : {}),
                    ...(projectActivation !== undefined ? { project: projectActivation } : {}),
                    ...((userActivation !== undefined || projectActivation !== undefined)
                      ? { effective: projectActivation === true || userActivation === true }
                      : {}),
                    evidence: activationObserved ? 'observed' : 'assumed',
                  },
                };
              }
              return {
                name: entry.name,
                version: entry.version,
                sharedNativePayloadDigest,
                displayName: plugin.manifest.interface?.displayName ?? entry.name,
                shortDescription: plugin.manifest.interface?.shortDescription
                  ?? plugin.manifest.description,
                description: plugin.manifest.description,
                ...(plugin.manifest.config?.schema
                  ? { configSchema: plugin.manifest.config.schema }
                  : {}),
                ...(effectiveConfig?.issues.length
                  ? {
                      configIssues: effectiveConfig.issues.map((issue) => ({
                        type: issue.type,
                        key: issue.key,
                        title: plugin.manifest.config!.schema[issue.key]?.title ?? issue.key,
                        source: issue.source ?? 'missing',
                      })),
                    }
                  : {}),
                ...(configDiagnostic ? { configDiagnostic } : {}),
                targets: {
                  claude: { user: claude, project: claude },
                  codex: {
                    user: codex,
                    project: codex
                      && codexSurface.ok
                      && codexSurface.classification !== 'empty',
                  },
                },
                states,
                dependencies: plugin.manifest.dependencies ?? [],
                ...(codexStatus ? { codex: codexStatus } : {}),
              };
            }),
          );
          return {
            ...base,
            resolvedCommit: item.resolution!.resolvedCommit,
            catalogVersion: item.resolution!.manifest.catalogVersion,
            channel: item.resolution!.manifest.channel,
            freshness: 'active' as const,
            plugins,
          };
        } catch (error) {
          const sanitized = sanitizeCatalogSourceError(error, env);
          return {
            ...base,
            error: sanitized.message,
            errorCode: catalogSourceErrorCode(sanitized),
          };
        }
      })),
    }),
  });
  const available = catalog.sources.flatMap((source) => 'plugins' in source
    ? source.plugins.map((plugin) => ({ ...plugin, source }))
    : []);
  const desiredTargetStates = calculateDesiredTargetStates({
    userIntent,
    projectIntent,
    available,
    codexProjectAllowed: !codexScopePathsAlias,
  });
  const failedSourceIds = new Set(
    catalog.sources.filter((source) => 'error' in source).map((source) => source.id),
  );
  const selectedById = new Map<string, (typeof available)[number]>();
  if (requested.length === 0) {
    for (const entry of available) {
      selectedById.set(formatPluginId({ sourceId: entry.source.id, pluginName: entry.name }), entry);
    }
  } else {
    for (const selector of plannedSelectors) {
      if (selector.parsed.sourceId === undefined && failedSourceIds.size > 0) {
        selectorErrors.push({
          code: 'catalogSourceUnavailable',
          message: `Cannot resolve bare plugin selector "${selector.raw}" while catalog sources are unavailable: ${[...failedSourceIds].join(', ')}.`,
        });
        continue;
      }
      if (selector.parsed.sourceId !== undefined && failedSourceIds.has(selector.parsed.sourceId)) {
        selectorErrors.push({
          code: 'catalogSourceUnavailable',
          message: `Cannot resolve plugin selector "${selector.raw}" because catalog source "${selector.parsed.sourceId}" is unavailable.`,
        });
        continue;
      }
      const matches = available.filter((entry) =>
        entry.name === selector.parsed.pluginName
        && (selector.parsed.sourceId === undefined || entry.source.id === selector.parsed.sourceId));
      if (matches.length === 0) {
        const selectorHasInventoryError = selectedInventoryErrors.some((error) =>
          inventoryErrorMatchesSelection({
            error,
            selectors: [selector],
            platformExplicit: options.platform !== undefined,
            scopeExplicit: options.scope !== undefined,
            platforms,
            scopes,
            currentProjectLocationKey,
          }));
        if (!selectorHasInventoryError) {
          selectorErrors.push({
            code: 'pluginNotFound',
            message: `Plugin "${selector.raw}" was not found in the selected catalog source set.`,
          });
        }
        continue;
      }
      if (selector.parsed.sourceId === undefined && matches.length > 1) {
        selectorErrors.push({
          code: 'ambiguousPlugin',
          message: `Plugin "${selector.raw}" is ambiguous across sources: ${matches.map((entry) => entry.source.id).join(', ')}.`,
        });
        continue;
      }
      for (const entry of matches) {
        selectedById.set(formatPluginId({ sourceId: entry.source.id, pluginName: entry.name }), entry);
      }
    }
  }
  const selected = [...selectedById.values()];
  const explicitTargetFilter = requested.length > 0
    && (options.platform !== undefined || options.scope !== undefined);
  const targets: StatusV6TargetDraft[] = selected.flatMap((entry) => platforms.flatMap((platform) =>
    scopes.flatMap((scope): StatusV6TargetDraft[] => {
      const target = {
        pluginName: entry.name,
        sourceId: entry.source.id,
        sourceIdentity: entry.source.identity,
        pluginId: formatPluginId({ sourceId: entry.source.id, pluginName: entry.name }),
        version: entry.version,
        platform,
        scope,
        cwd: path.resolve(options.cwd),
        components: [] as StatusV6Component[],
      };
      if (platform === 'codex'
        && scope === 'project'
        && codexScopePathsAlias
        && !hasCurrentCodexProjectOwner(entry.source.id, entry.name)) {
        if (options.scope !== 'project') return [];
        return [{
          ...target,
          state: 'error',
          errors: [finalizeTargetError({
            code: 'codexScopePathAlias',
            message: 'codexScopePathAlias: Codex project config resolves to the user config directory. Run this command from an actual project directory.',
          }, 'error')],
        }];
      }
      if (entry.targets[platform][scope]) {
        const live = entry.states[platform]?.[scope];
        const dependencyIssueCount = (live?.errors ?? []).filter((error) =>
          error.code.startsWith('dependency')
          || error.code === 'awCapabilityUnsupported'
          || error.code === 'sourceChanged').length;
        return [{
          ...target,
          state: live?.state ?? 'error',
          components: live?.components ?? [],
          errors: live?.errors ?? [finalizeTargetError({
            code: 'targetInspectionFailed',
            message: `No live inspection result exists for ${entry.source.id}/${entry.name}.`,
          }, 'error')],
          ...(live?.dependencyReadiness
            ? { dependencyReadiness: live.dependencyReadiness }
            : {}),
          ...(entry.dependencies.length > 0 || dependencyIssueCount > 0 ? {
            dependency: {
              directCount: entry.dependencies.length,
              issueCount: dependencyIssueCount,
            },
          } : {}),
        }];
      }
      const unsupportedLiveReference = ownerInventory.references.find((reference) =>
        (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
        && reference.sourceId === entry.source.id
        && reference.pluginName === entry.name
        && reference.platform === platform
        && reference.scope === scope
        && (scope === 'user' || reference.projectKey === currentProjectKey));
      if (unsupportedLiveReference) {
        const sourceChanged = Boolean(
          unsupportedLiveReference.sourceIdentity
          && unsupportedLiveReference.sourceIdentity !== entry.source.identity,
        );
        return [{
          ...target,
          state: 'error',
          errors: [finalizeTargetError({
            code: sourceChanged ? 'sourceChanged' : 'noLongerSupported',
            message: sourceChanged
              ? `sourceChanged: live state for ${target.pluginId} has a different source identity.`
              : `noLongerSupported: ${target.pluginId} has live state for ${platform}/${scope}, but the current bundle no longer supports that target.`,
          }, 'error')],
        }];
      }
      if (!explicitTargetFilter) return [];
      return [{
        ...target,
        state: 'error',
        errors: [finalizeTargetError({
          code: platform === 'codex' && scope === 'project'
            ? 'codexProjectPluginUnsupported'
            : 'unsupportedTarget',
          message: platform === 'codex' && scope === 'project'
            ? `codexProjectPluginUnsupported: ${entry.source.id}/${entry.name} cannot use the current Codex project plugin contract.`
            : `${entry.source.id}/${entry.name} does not support ${platform}/${scope}.`,
        }, 'error')],
      }];
    })));
  const referenceSelectors = [...plannedSelectors, ...liveOnlySelectors];
  const referenceSelected = (reference: {
    sourceId?: string;
    pluginName?: string;
    platform?: string;
    scope?: string;
    projectKey?: string | null;
  }): boolean => (
    reference.pluginName !== undefined
    && reference.platform !== undefined
    && reference.scope !== undefined
    && platforms.includes(reference.platform as PlatformName)
    && scopes.includes(reference.scope as Scope)
    && (reference.scope !== 'project' || reference.projectKey === currentProjectKey)
    && (requested.length === 0 || referenceSelectors.some((selector) =>
      selector.parsed.pluginName === reference.pluginName
      && (selector.parsed.sourceId === undefined || selector.parsed.sourceId === reference.sourceId)))
  );
  const legacyOwners = ownerInventory.references.filter((reference) =>
    (reference.kind === 'legacyOwner' || reference.kind === 'legacyMarketplace')
    && reference.pluginName !== undefined
    && reference.platform !== undefined
    && reference.scope !== undefined
    && platforms.includes(reference.platform as PlatformName)
    && scopes.includes(reference.scope as Scope)
    && (requested.length === 0 || plannedSelectors.some((selector) =>
      selector.parsed.pluginName === reference.pluginName)));
  const missingSourceOwners = ownerInventory.references.filter((reference) =>
    (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
    && reference.sourceId
    && !configured.has(reference.sourceId)
    && referenceSelected(reference));
  const missingTargets = [...new Map(missingSourceOwners.flatMap((reference) => {
    if (!reference.sourceId || !reference.pluginName
      || (reference.platform !== 'codex' && reference.platform !== 'claude')
      || (reference.scope !== 'user' && reference.scope !== 'project')) return [];
    const pluginId = formatPluginId({ sourceId: reference.sourceId, pluginName: reference.pluginName });
    const target: StatusV6TargetDraft = {
      pluginName: reference.pluginName,
      sourceId: reference.sourceId,
      sourceIdentity: reference.sourceIdentity ?? 'unavailable',
      pluginId,
      platform: reference.platform,
      scope: reference.scope,
      cwd: path.resolve(options.cwd),
      state: 'error',
      components: [],
      errors: [finalizeTargetError({
        code: 'sourceMissing',
        message: `sourceMissing: catalog source "${reference.sourceId}" is not configured for ${pluginId}.`,
      }, 'error')],
    };
    return [[`${pluginId}\0${reference.platform}\0${reference.scope}`, target] as const];
  })).values()];
  targets.push(...missingTargets);
  const unavailableSourceReferences = ownerInventory.references.filter((reference) =>
    (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
    && reference.sourceId
    && configured.has(reference.sourceId)
    && failedSourceIds.has(reference.sourceId)
    && referenceSelected(reference));
  const unavailableSourceTargets = [...new Map(unavailableSourceReferences.flatMap((reference) => {
    if (!reference.sourceId || !reference.pluginName
      || (reference.platform !== 'codex' && reference.platform !== 'claude')
      || (reference.scope !== 'user' && reference.scope !== 'project')) return [];
    const pluginId = formatPluginId({ sourceId: reference.sourceId, pluginName: reference.pluginName });
    const target: StatusV6TargetDraft = {
      pluginName: reference.pluginName,
      sourceId: reference.sourceId,
      sourceIdentity: reference.sourceIdentity ?? 'unavailable',
      pluginId,
      platform: reference.platform,
      scope: reference.scope,
      cwd: path.resolve(options.cwd),
      state: 'error',
      components: [],
      errors: [finalizeTargetError({
        code: 'catalogSourceUnavailable',
        message: `catalogSourceUnavailable: catalog source "${reference.sourceId}" is unavailable for ${pluginId}.`,
      }, 'error')],
    };
    return [[`${pluginId}\0${reference.platform}\0${reference.scope}`, target] as const];
  })).values()];
  targets.push(...unavailableSourceTargets);
  const availablePluginIds = new Set(available.map((entry) =>
    formatPluginId({ sourceId: entry.source.id, pluginName: entry.name })));
  const resolvedSourceIds = new Set(catalog.sources.flatMap((source) =>
    'plugins' in source ? [source.id] : []));
  const unavailableBundleReferences = ownerInventory.references.filter((reference) =>
    (reference.kind === 'namespacedOwner' || reference.kind === 'namespacedMarketplace')
    && reference.sourceId
    && configured.has(reference.sourceId)
    && resolvedSourceIds.has(reference.sourceId)
    && reference.pluginName
    && referenceSelected(reference)
    && !availablePluginIds.has(formatPluginId({
      sourceId: reference.sourceId,
      pluginName: reference.pluginName,
    })));
  const unavailableBundleTargets = [...new Map(unavailableBundleReferences.flatMap((reference) => {
    if (!reference.sourceId || !reference.pluginName
      || (reference.platform !== 'codex' && reference.platform !== 'claude')
      || (reference.scope !== 'user' && reference.scope !== 'project')) return [];
    const pluginId = formatPluginId({ sourceId: reference.sourceId, pluginName: reference.pluginName });
    if (requested.length > 0 && !plannedSelectors.some((selector) =>
      selector.parsed.pluginName === reference.pluginName
      && (selector.parsed.sourceId === undefined || selector.parsed.sourceId === reference.sourceId))) return [];
    const target: StatusV6TargetDraft = {
      pluginName: reference.pluginName,
      sourceId: reference.sourceId,
      sourceIdentity: reference.sourceIdentity ?? 'unavailable',
      pluginId,
      platform: reference.platform,
      scope: reference.scope,
      cwd: path.resolve(options.cwd),
      state: 'error',
      components: [],
      errors: [finalizeTargetError({
        code: 'bundleUnavailable',
        message: `bundleUnavailable: ${pluginId} has live state but is not present in the current source snapshot.`,
      }, 'error')],
    };
    return [[`${pluginId}\0${reference.platform}\0${reference.scope}`, target] as const];
  })).values()];
  targets.push(...unavailableBundleTargets);
  const targetKeys = new Set(targets.map((target) =>
    `${target.pluginId}\0${target.platform}\0${target.scope}`));
  for (const [scope, intent] of [
    ['user', userIntent],
    ['project', projectIntent],
  ] as const) {
    for (const root of intent.roots) {
      const parsed = parsePluginId(root.pluginId);
      if (!parsed.sourceId) continue;
      if (requested.length > 0 && !parsedSelectors.some((selector) =>
        selector.parsed.pluginName === parsed.pluginName
        && (selector.parsed.sourceId === undefined || selector.parsed.sourceId === parsed.sourceId))) {
        continue;
      }
      for (const platform of root.platforms.filter((candidate) => platforms.includes(candidate))) {
        if (!scopes.includes(scope)) continue;
        const key = `${root.pluginId}\0${platform}\0${scope}`;
        if (targetKeys.has(key)) continue;
        targets.push({
          pluginName: parsed.pluginName,
          sourceId: parsed.sourceId,
          sourceIdentity: identities.get(parsed.sourceId)?.identity ?? 'unavailable',
          pluginId: root.pluginId,
          platform,
          scope,
          cwd: path.resolve(options.cwd),
          state: 'error',
          components: [],
          errors: [finalizeTargetError({
            code: 'codexIntentSourceUnavailable',
            message: `codexIntentSourceUnavailable: desired intent for ${root.pluginId} cannot be resolved from the current Catalog.`,
          }, 'partial')],
        });
        targetKeys.add(key);
      }
    }
  }
  const projectedInventoryErrors = [...new Map(selectedInventoryErrors.map((error) => [
    `${error.code}\0${error.message}`,
    { code: error.code, message: error.message },
  ])).values()];
  const errors = [
    ...projectedInventoryErrors,
    ...selectorErrors,
    ...intentErrors,
    ...legacyOwners.map((reference) => projectTargetError({
      code: 'legacyStateUnsupported',
      message: `legacyStateUnsupported: legacy live ${reference.kind} at ${reference.location}`,
    }, env, options.cwd, 'error')),
  ];
  const draftTargets = targets.map((target) => ({
    ...target,
    errors: target.errors.map((error) => projectTargetError(error, env, options.cwd, target.state)),
  }));
  const selectedByPluginId = new Map(selected.map((entry) => [
    formatPluginId({ sourceId: entry.source.id, pluginName: entry.name }),
    entry,
  ]));
  const explicitScope = options.scope === undefined ? undefined : scopes[0]!;
  const warning = (code: string, message: string): StatusV6TargetError => ({
    code,
    message: `${code}: ${message}`,
    severity: 'warning',
  });
  const decorateTarget = async (
    target: StatusV6TargetDraft,
    groupedScopes: Scope[],
    groupedTargets: StatusV6TargetDraft[],
  ): Promise<StatusV6Target> => {
    const entry = selectedByPluginId.get(target.pluginId);
    const codex = entry?.codex;
    const desiredAll = desiredTargetStates.get(desiredTargetKey(target.pluginId, target.platform))
      ?? { scopes: [], relation: 'none' as const };
    const desired = target.platform === 'codex'
      ? desiredAll
      : {
          scopes: desiredAll.scopes.includes(target.scope) ? [target.scope] : [],
          relation: desiredAll.relation,
        };
    const sharedNative = codex?.sharedNative ?? target.sharedNative;
    const baseActivation = codex?.activation ?? target.activation;
    const consumerScope: Scope = desired.scopes.includes('project')
      ? 'project'
      : desired.scopes.includes('user')
        ? 'user'
        : explicitScope ?? (groupedScopes.includes('project') ? 'project' : 'user');
    const inspectSystemConsumer = target.platform === 'codex'
      && baseActivation !== undefined
      && ((codex?.nativeKinds.length ?? 0) > 0 || target.sharedNative !== undefined);
    const systemConsumer = inspectSystemConsumer
      ? await inspectCodexSystemConsumer(consumerScope)
      : undefined;
    const activation = baseActivation && systemConsumer
      ? {
          ...baseActivation,
          evidence: baseActivation.evidence === 'observed'
            ? 'observed' as const
            : systemConsumer.state === 'missing' ? 'assumed' as const : 'unobserved' as const,
          systemConsumer,
        }
      : baseActivation;
    const observationScopes = explicitScope
      ? [explicitScope]
      : desired.scopes.length > 0 ? desired.scopes : groupedScopes;
    const scopedTargets = groupedTargets.filter((candidate) =>
      observationScopes.includes(candidate.scope));
    const observedTargets = scopedTargets.length > 0 ? scopedTargets : groupedTargets;
    const ownershipState = observedTargets.some((candidate) => candidate.state === 'error')
      ? 'error' as const
      : observedTargets.some((candidate) => candidate.state === 'partial')
        ? 'partial' as const
        : observedTargets.some((candidate) => candidate.state === 'present')
          ? 'present' as const
          : 'absent' as const;
    const hasSourceError = observedTargets.some((candidate) => candidate.errors.some((error) =>
      error.code === 'sourceMissing'
      || error.code === 'catalogSourceUnavailable'
      || error.code === 'bundleUnavailable'
      || error.code === 'codexIntentSourceUnavailable'));
    const desiredOverlapConflict = target.platform === 'codex'
      && (codex?.extensionKinds.length ?? 0) > 0
      && desired.scopes.includes('user')
      && desired.scopes.includes('project');
    const expectedUser = desired.scopes.includes('user');
    const expectedProject = desired.scopes.includes('project');
    const activationDrift = target.platform === 'codex'
      && (codexConfigErrors.some((error) =>
        error.scope === 'user' || observationScopes.includes(error.scope))
        || ((codex?.nativeKinds.length ?? 0) > 0
          && ((expectedUser && activation?.user !== true)
            || (!expectedUser && activation?.user === true)
            || (expectedProject && activation?.project !== true)
            || (!expectedProject && activation?.project === true))));
    const extensionComponents = observedTargets.flatMap((candidate) => candidate.components).filter(
      (component) => component.key !== 'native'
        && !component.key.startsWith('activation-')
        && !component.key.startsWith('marketplace-'),
    );
    const extensions: StatusV6Target['extensions'] = target.platform !== 'codex'
      || (codex?.extensionKinds.length ?? 0) === 0
      ? undefined
      : {
          state: desiredOverlapConflict
            ? 'conflict'
            : extensionComponents.some((component) => component.error?.code === 'artifactCollision')
              ? 'conflict'
              : observedTargets.some((candidate) =>
                  candidate.state === 'partial' || candidate.state === 'error')
                ? 'drifted'
              : extensionComponents.some((component) =>
                  component.state === 'partial' || component.state === 'error')
              ? 'drifted'
              : desired.scopes.length > 0 && (extensionComponents.length === 0
                || extensionComponents.every((component) => component.state === 'absent'))
                ? 'missing'
                : 'ready',
          kinds: codex!.extensionKinds,
        };
    const desiredEnabled = desired.scopes.length > 0;
    const consumerIssue = activation?.systemConsumer?.state === 'incompatible'
      || activation?.systemConsumer?.state === 'unresolved'
      ? activation.systemConsumer
      : undefined;
    const consumerBlocking = consumerIssue !== undefined;
    const claimMissing = false;
    const actual: StatusV6ActualState = hasSourceError && desiredEnabled
      ? 'unresolved'
      : consumerBlocking && desiredEnabled
        ? 'unresolved'
        : desiredOverlapConflict
          ? 'conflict'
          : !desiredEnabled
            ? ownershipState !== 'absent' || desired.relation === 'managed'
              ? 'orphaned'
              : 'absent'
            : sharedNative?.state === 'foreign'
              ? 'conflict'
              : sharedNative?.state === 'corrupt'
                ? 'drifted'
                : sharedNative?.state === 'missing' || sharedNative?.state === 'outdated' || claimMissing
                  ? 'needsSync'
                  : activationDrift || extensions?.state === 'drifted'
                    ? 'drifted'
                    : extensions?.state === 'missing' || ownershipState === 'absent'
                      ? 'needsSync'
                      : ownershipState === 'partial' || ownershipState === 'error'
                        ? 'drifted'
                        : 'ready';
    const baseTargetErrors = observedTargets.flatMap((candidate) => candidate.errors);
    const stableErrors = [
      ...(sharedNative?.state === 'foreign'
        && !baseTargetErrors.some((error) => error.code === 'codexSharedNativeForeign')
        ? [warning('codexSharedNativeForeign', `${sharedNative.pluginId} is foreign and was preserved.`)]
        : []),
      ...(sharedNative?.state === 'corrupt'
        && !baseTargetErrors.some((error) => error.code === 'codexSharedNativeCorrupt')
        ? [warning('codexSharedNativeCorrupt', `${sharedNative.pluginId} is corrupt.`)]
        : []),
      ...(sharedNative?.state === 'outdated'
        ? [warning('codexSharedNativeUpdateRequired', `${sharedNative.pluginId} requires a shared update.`)]
        : []),
      ...(sharedNative?.diagnostic === 'staleCacheObserved'
        ? [warning('staleCacheObserved', `${sharedNative.pluginId} has non-blocking stale Codex cache residue.`)]
        : []),
      ...(desiredOverlapConflict
        ? [warning('codexExtensionScopeConflict', `${target.pluginId} has AW extensions desired at user and project scope.`)]
        : []),
      ...(activationDrift && sharedNative?.state !== 'missing'
        ? [warning('codexActivationDrift', `${target.pluginId} activation differs from desired intent.`)]
        : []),
      ...(extensions?.state === 'drifted'
        ? [warning('codexExtensionDrift', `${target.pluginId} extension projection has drifted.`)]
        : []),
      ...(target.platform === 'codex' && hasSourceError && desiredEnabled
        ? [warning('codexIntentSourceUnavailable', `${target.pluginId} desired intent cannot be resolved from the current Catalog.`)]
        : []),
      ...(target.platform === 'codex' && consumerBlocking && desiredEnabled
        ? [warning(
            consumerIssue.code,
            consumerIssue.diagnostic,
          )]
        : []),
    ];
    const targetErrors = [...baseTargetErrors, ...stableErrors];
    const dedupedErrors = [...new Map(targetErrors.map((error) => [
      `${error.code}\0${error.message}`,
      error,
    ])).values()];
    const components = [...new Map(observedTargets.flatMap((candidate) => candidate.components)
      .map((component) => [component.key, component] as const)).values()];
    const representativeScope = explicitScope
      ?? (desired.scopes.length === 1
      ? desired.scopes[0]!
      : observedTargets.find((candidate) => candidate.state !== 'absent')?.scope
        ?? (groupedScopes.includes('user') ? 'user' : groupedScopes[0] ?? target.scope));
    return {
      ...target,
      scope: representativeScope,
      state: ownershipState,
      components,
      errors: dedupedErrors,
      desired: {
        enabled: desiredEnabled,
        scopes: desired.scopes,
        relation: desired.relation,
      },
      actual: { state: actual },
      recovery: statusRecovery({
        actual,
        desired,
        platform: target.platform,
        pluginId: target.pluginId,
        ...(sharedNative ? { sharedNative } : {}),
        conflictRoots: rootIntentsForTarget({
          pluginId: target.pluginId,
          platform: target.platform,
          userIntent,
          projectIntent,
          available,
        }),
        errorCodes: dedupedErrors.map((error) => error.code),
      }),
      ...(sharedNative ? { sharedNative } : {}),
      ...(activation ? { activation } : {}),
      ...(extensions ? { extensions } : {}),
    };
  };
  const codexGroups = new Map<string, StatusV6TargetDraft[]>();
  const projectedTargets: StatusV6Target[] = [];
  for (const target of draftTargets) {
    if (target.platform !== 'codex') {
      projectedTargets.push(await decorateTarget(target, [target.scope], [target]));
      continue;
    }
    const group = codexGroups.get(target.pluginId) ?? [];
    group.push(target);
    codexGroups.set(target.pluginId, group);
  }
  for (const group of codexGroups.values()) {
    const scopes = [...new Set(group.map((target) => target.scope))].sort();
    projectedTargets.push(await decorateTarget(group[0]!, scopes, group));
  }
  projectedTargets.sort((left, right) =>
    `${left.pluginId}\0${left.platform}\0${left.scope}`.localeCompare(
      `${right.pluginId}\0${right.platform}\0${right.scope}`,
      'en',
    ));
  const targetRevisions: StatusTargetRevision[] = projectedTargets.map((target) => {
    const entry = selectedByPluginId.get(target.pluginId);
    return {
      pluginId: target.pluginId,
      platform: target.platform,
      scope: target.scope,
      revision: projectTargetRevision(
        entry?.version,
        entry?.states[target.platform]?.[target.scope]?.installedVersion,
      ),
    };
  });
  const payload: StatusV6Payload = {
    schemaVersion: 6,
    catalog: {
      primarySourceId: catalog.primarySourceId,
      configDigest: catalog.configDigest,
      compositeDigest: catalog.compositeDigest,
      ...(options.catalogOperationContext
        ? { generationSetDigest: options.catalogOperationContext.generationSetDigest }
        : {}),
      sources: catalog.sources.map((source) => {
        if (!('plugins' in source)) return source;
        const { plugins: _plugins, ...projected } = source;
        return projected;
      }),
    },
    filters: {
      plugins: requested,
      platform: options.platform === undefined ? 'both' : parsePlatformValue(options.platform),
      ...(options.scope === undefined ? {} : { scope: parseScopeValue(options.scope) }),
      cwd: path.resolve(options.cwd),
    },
    targets: projectedTargets,
    errors,
  };
  const hasErrors = payload.catalog.sources.some((source) => source.error !== undefined)
    || payload.errors.length > 0
    || payload.targets.some((target) => target.errors.some((error) => error.severity === 'blocking'));
  return {
    payload,
    output: options.json ? JSON.stringify(payload) : renderStatusV6(payload, options.verbose === true),
    hasErrors,
    targetRevisions,
    pluginSummaries: available.map((entry) => {
      const sourceEntries = available.filter((candidate) => candidate.source.id === entry.source.id);
      const byName = new Map(sourceEntries.map((candidate) => [candidate.name, candidate]));
      const transitive = new Set<string>();
      const visit = (name: string): void => {
        const candidate = byName.get(name);
        for (const dependency of candidate?.dependencies ?? []) {
          if (transitive.has(dependency)) continue;
          transitive.add(dependency);
          visit(dependency);
        }
      };
      visit(entry.name);
      const dependencyIssueCount = targets.filter((target) => target.pluginId === formatPluginId({
        sourceId: entry.source.id,
        pluginName: entry.name,
      })).reduce((count, target) => count + target.errors.filter((error) =>
        error.code.startsWith('dependency')
        || error.code === 'awCapabilityUnsupported'
        || error.code === 'sourceChanged').length, 0);
      return {
        pluginName: entry.name,
        pluginId: formatPluginId({ sourceId: entry.source.id, pluginName: entry.name }),
        displayName: entry.displayName,
        description: entry.shortDescription,
        version: entry.version,
        supportedTargets: {
          codex: (['user', 'project'] as const).filter((scope) => entry.targets.codex[scope]),
          claude: (['user', 'project'] as const).filter((scope) => entry.targets.claude[scope]),
        },
        configFieldCount: Object.keys(entry.configSchema ?? {}).length,
        ...(entry.configSchema ? { configSchema: entry.configSchema } : {}),
        ...(entry.configIssues ? { configIssues: entry.configIssues } : {}),
        ...(entry.configDiagnostic ? { configDiagnostic: entry.configDiagnostic } : {}),
        dependencyDirectCount: entry.dependencies.length,
        dependencyTotalCount: transitive.size,
        dependencyIssueCount,
        ...(entry.missingCapabilities
          ? { missingCapabilities: entry.missingCapabilities }
          : {}),
      };
    }),
  };
}
