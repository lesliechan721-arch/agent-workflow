import path from 'node:path';

import fs from 'fs-extra';

import type {
  CatalogResolution,
  ClaudeCapabilitySnapshot,
  CodexCapabilitySnapshot,
  CodexProjectManagedKind,
  GeneratedArtifact,
  InstalledLedger,
  InstalledLedgerPluginRecord,
  InstalledScopeRecord,
  PlatformName,
  PluginMeta,
  Scope,
  TrackingManifest,
  TrackingPluginRecord,
} from '../types.js';
import { listCodexNativeRecoveryBreadcrumbs } from '../utils/codex-native-recovery.js';
import {
  hasCodexNativeCacheEvidence,
  listCodexNativeEvidence,
} from '../utils/codex-native-state.js';
import { detectEnvironment, listDetectedPlatforms } from '../utils/detect.js';
import { readInstalledLedger } from '../utils/local-marketplace.js';
import { resolvePluginsFromCatalog } from '../utils/manifest.js';
import {
  buildIncomingDependencyIndex,
  canAutoCleanupScopeRecord,
} from '../utils/plugin-dependency-graph.js';
import { serializePluginLocation } from '../utils/plugin-dependency-location.js';
import { resolveCatalogPlugins } from '../utils/plugin-catalog.js';
import {
  resolveClaudePaths,
  resolveClaudeProjectKey,
  resolveCodexPaths,
  resolveCodexProjectKey,
  resolveEmbeddedPluginsRoot,
  resolveRepoRoot,
} from '../utils/paths.js';
import {
  getTrackingArtifactIntegrityErrors,
  readTrackingManifest,
} from '../utils/tracking.js';
import type { TrackingArtifactIntegrityError } from '../utils/tracking.js';
import {
  readClaudeInstalledPluginsState,
  readClaudeSettings,
} from '../adapters/helpers.js';
import {
  createHistoricalPluginTarget,
  pluginSupportsPlatform,
  type ResolvedPluginTarget,
} from './common.js';
import { collectInstallEvidence } from '../install-state/evidence.js';
import { projectInstallState } from '../install-state/status-projection.js';

const MARKETPLACE_NAME = 'aw';

type HistoricalManagedKind = GeneratedArtifact['kind'];
type HistoricalCodexKind = CodexProjectManagedKind;
const HISTORICAL_CODEX_KIND_ORDER: HistoricalCodexKind[] = [
  'skill',
  'mcpServer',
  'instruction',
  'permission',
  'hook',
  'agent',
];
const HISTORICAL_CODEX_KIND_SET = new Set<HistoricalCodexKind>(
  HISTORICAL_CODEX_KIND_ORDER,
);
type DiscoveryEvidenceSource =
  | 'ledger'
  | 'tracking'
  | 'codexNativeConfig'
  | 'codexNativeCache'
  | 'codexNativeRecovery'
  | 'codexSharedNativeRef'
  | 'claudeSettings'
  | 'claudeInstalledPlugins';

export interface DiscoveryProjectIdentity {
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  projectRoot?: string;
  executionCwd: string;
}

export interface DiscoveryEvidenceSummary extends DiscoveryProjectIdentity {
  sources: DiscoveryEvidenceSource[];
  trackingKinds: HistoricalManagedKind[];
  trackingIntegrityErrors: TrackingArtifactIntegrityError[];
  trackingHasHookIdentities: boolean;
  ledgerManaged: boolean;
  ledgerStateStatus: InstalledLedger['ledgerState']['status'];
  ledgerStateReason: InstalledLedger['ledgerState']['reason'];
  codexRequiresNativePlugin?: boolean;
  codexHasRepoManagedArtifacts?: boolean;
  codexManagedKinds?: HistoricalCodexKind[];
  claudeManagedExtensions?: string[];
  readErrors: string[];
}

export interface DiscoveredPluginName {
  pluginName: string;
  evidenceByPlatformScope: Record<string, DiscoveryEvidenceSummary>;
  currentCatalog?: {
    catalog: CatalogResolution;
    currentPlugin: PluginMeta;
    embeddedPlugin?: PluginMeta;
  };
  ledgerRecord?: InstalledLedgerPluginRecord;
}

export interface DiscoveredPluginTarget {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  projectRoot?: string;
  executionCwd: string;
  target: ResolvedPluginTarget;
  evidence: DiscoveryEvidenceSummary;
  evidenceByPlatformScope: Record<string, DiscoveryEvidenceSummary>;
}

export interface CommandCandidate {
  id: string;
  command: 'install' | 'status' | 'uninstall' | 'upgrade';
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  projectRoot?: string;
  executionCwd: string;
  target: ResolvedPluginTarget;
  selectable: boolean;
  disabledReason?: string;
  compatiblePlatforms?: PlatformName[];
  evidence: DiscoveryEvidenceSummary;
  evidenceByPlatformScope: Record<string, DiscoveryEvidenceSummary>;
  dependencyStatus?: {
    autoInstalled: boolean;
    autoRemovable: boolean;
    dependents: Array<{
      plugin: string;
      platform: PlatformName;
      scope: Scope;
      projectKey?: string;
    }>;
  };
  installState?: {
    kind: 'installed' | 'needsRepair' | 'adoptable' | 'residual' | 'externallyManaged' | 'notInstalled';
    adoptExistingAvailable: boolean;
    autoInstalled: boolean;
    unusedDependencyHint: boolean;
    dependencyProtected: boolean;
    ownerConflict: boolean;
  };
}

export interface DiscoveryOptions {
  cwd: string;
  scopeFilter?: Scope;
  platformFilter?: PlatformName | 'both';
  names?: string[];
  pluginNames?: string[];
  env?: NodeJS.ProcessEnv;
  includeCurrentCatalog?: boolean;
}

export interface ResolveDiscoveredPluginTargetsOptions extends DiscoveryOptions {
  command?: 'status' | 'uninstall' | 'upgrade';
}

export interface BuildCommandCandidatesOptions extends ResolveDiscoveredPluginTargetsOptions {
  command: 'status' | 'uninstall' | 'upgrade';
}

interface DiscoveryContext {
  cwd: string;
  env: NodeJS.ProcessEnv;
  scopes: Scope[];
  platforms: PlatformName[];
  identities: Record<PlatformName, Record<Scope, DiscoveryProjectIdentity>>;
}

interface MutableEvidence extends DiscoveryEvidenceSummary {
  sources: DiscoveryEvidenceSource[];
  trackingKinds: HistoricalManagedKind[];
  trackingIntegrityErrors: TrackingArtifactIntegrityError[];
  readErrors: string[];
}

interface DiscoveryReadError extends DiscoveryProjectIdentity {
  message: string;
}

function platformScopeKey(
  platform: PlatformName,
  scope: Scope,
  projectKey?: string,
): string {
  return scope === 'user'
    ? `${platform}:user`
    : `${platform}:project:${projectKey ?? 'unknown'}`;
}

function resolveScopes(scopeFilter: Scope | undefined): Scope[] {
  return scopeFilter ? [scopeFilter] : ['user', 'project'];
}

function resolvePlatforms(platformFilter: PlatformName | 'both' | undefined): PlatformName[] {
  if (platformFilter === 'codex' || platformFilter === 'claude') {
    return [platformFilter];
  }

  return ['codex', 'claude'];
}

async function realpathOrResolved(inputPath: string): Promise<string> {
  try {
    return await fs.realpath(path.resolve(inputPath));
  } catch {
    return path.resolve(inputPath);
  }
}

async function createDiscoveryContext(options: DiscoveryOptions): Promise<DiscoveryContext> {
  const env = options.env ?? process.env;
  const cwd = options.cwd;
  const scopes = resolveScopes(options.scopeFilter);
  const platforms = resolvePlatforms(options.platformFilter);
  const [repoRoot, codexProjectKey, claudeProjectKey, executionCwd] = await Promise.all([
    resolveRepoRoot(cwd),
    resolveCodexProjectKey(cwd),
    resolveClaudeProjectKey(cwd),
    realpathOrResolved(cwd),
  ]);
  const codexProjectRoot = await realpathOrResolved(repoRoot);

  return {
    cwd,
    env,
    scopes,
    platforms,
    identities: {
      codex: {
        user: {
          platform: 'codex',
          scope: 'user',
          executionCwd,
        },
        project: {
          platform: 'codex',
          scope: 'project',
          projectKey: codexProjectKey,
          projectRoot: codexProjectRoot,
          executionCwd: codexProjectRoot,
        },
      },
      claude: {
        user: {
          platform: 'claude',
          scope: 'user',
          executionCwd,
        },
        project: {
          platform: 'claude',
          scope: 'project',
          projectKey: claudeProjectKey,
          projectRoot: executionCwd,
          executionCwd,
        },
      },
    },
  };
}

function createEmptyEvidence(
  identity: DiscoveryProjectIdentity,
  ledger: InstalledLedger,
): MutableEvidence {
  return {
    ...identity,
    sources: [],
    trackingKinds: [],
    trackingIntegrityErrors: [],
    trackingHasHookIdentities: false,
    ledgerManaged: false,
    ledgerStateStatus: ledger.ledgerState.status,
    ledgerStateReason: ledger.ledgerState.reason,
    readErrors: [],
  };
}

function getOrCreateDiscoveryRecord(
  records: Map<string, DiscoveredPluginName>,
  pluginName: string,
): DiscoveredPluginName {
  let record = records.get(pluginName);
  if (!record) {
    record = {
      pluginName,
      evidenceByPlatformScope: {},
    };
    records.set(pluginName, record);
  }

  return record;
}

function getOrCreateEvidence(
  record: DiscoveredPluginName,
  identity: DiscoveryProjectIdentity,
  ledger: InstalledLedger,
): MutableEvidence {
  const key = platformScopeKey(identity.platform, identity.scope, identity.projectKey);
  const existing = record.evidenceByPlatformScope[key];
  if (existing) {
    return existing as MutableEvidence;
  }

  const evidence = createEmptyEvidence(identity, ledger);
  record.evidenceByPlatformScope[key] = evidence;
  return evidence;
}

function addEvidenceSource(
  evidence: MutableEvidence,
  source: DiscoveryEvidenceSource,
): void {
  if (!evidence.sources.includes(source)) {
    evidence.sources.push(source);
  }
}

function addReadError(
  evidence: MutableEvidence,
  message: string,
): void {
  if (!evidence.readErrors.includes(message)) {
    evidence.readErrors.push(message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addTrackingEvidence(
  evidence: MutableEvidence,
  record: TrackingPluginRecord,
): void {
  addEvidenceSource(evidence, 'tracking');
  const platformArtifacts = record.artifacts.filter((artifact) => artifact.platform === evidence.platform);
  for (const integrityError of getTrackingArtifactIntegrityErrors(platformArtifacts)) {
    if (!evidence.trackingIntegrityErrors.some((existing) =>
      existing.code === integrityError.code &&
        existing.kind === integrityError.kind &&
        existing.platform === integrityError.platform &&
        existing.path === integrityError.path,
    )) {
      evidence.trackingIntegrityErrors.push(integrityError);
    }
  }
  for (const artifact of record.artifacts) {
    if (artifact.platform !== evidence.platform) {
      continue;
    }
    if (!evidence.trackingKinds.includes(artifact.kind)) {
      evidence.trackingKinds.push(artifact.kind);
    }
    if (
      artifact.kind === 'hook' &&
      Array.isArray(artifact.hookGroups) &&
      artifact.hookGroups.length > 0
    ) {
      evidence.trackingHasHookIdentities = true;
    }
  }
}

function getScopeLedgerRecord(
  ledgerRecord: InstalledLedgerPluginRecord | undefined,
  platform: PlatformName,
  scope: Scope,
  projectKey?: string,
): InstalledScopeRecord<ClaudeCapabilitySnapshot | CodexCapabilitySnapshot> | undefined {
  const platformRecord = ledgerRecord?.platforms[platform];
  if (!platformRecord) {
    return undefined;
  }

  if (scope === 'user') {
    return platformRecord.userScope as InstalledScopeRecord<
      ClaudeCapabilitySnapshot | CodexCapabilitySnapshot
    > | undefined;
  }

  return projectKey
    ? platformRecord.projectScopes?.[projectKey] as InstalledScopeRecord<
        ClaudeCapabilitySnapshot | CodexCapabilitySnapshot
      > | undefined
    : undefined;
}

function createCandidateLocation(target: Pick<CommandCandidate, 'pluginName' | 'platform' | 'scope' | 'projectKey'>) {
  return {
    plugin: target.pluginName,
    platform: target.platform,
    scope: target.scope,
    projectKey: target.scope === 'user' ? null : (target.projectKey ?? null),
  } as const;
}

function isCodexSnapshot(
  platform: PlatformName,
  snapshot: ClaudeCapabilitySnapshot | CodexCapabilitySnapshot | undefined,
): snapshot is CodexCapabilitySnapshot {
  return platform === 'codex' && snapshot !== undefined;
}

function isClaudeSnapshot(
  platform: PlatformName,
  snapshot: ClaudeCapabilitySnapshot | CodexCapabilitySnapshot | undefined,
): snapshot is ClaudeCapabilitySnapshot {
  return platform === 'claude' && snapshot !== undefined;
}

function getCodexSnapshotManagedKinds(
  snapshot: CodexCapabilitySnapshot | undefined,
): HistoricalCodexKind[] {
  const rawKinds = snapshot?.projectManagedKinds ?? snapshot?.managedKinds;
  const selected = new Set<HistoricalCodexKind>();
  for (const kind of rawKinds ?? []) {
    if (HISTORICAL_CODEX_KIND_SET.has(kind)) {
      selected.add(kind);
    }
  }

  return HISTORICAL_CODEX_KIND_ORDER.filter((kind) => selected.has(kind));
}

function addLedgerEvidence(
  evidence: MutableEvidence,
  scopeRecord: InstalledScopeRecord<ClaudeCapabilitySnapshot | CodexCapabilitySnapshot>,
): void {
  addEvidenceSource(evidence, 'ledger');
  evidence.ledgerManaged = scopeRecord.managed === true;
  if (isCodexSnapshot(evidence.platform, scopeRecord.capabilitySnapshot)) {
    evidence.codexRequiresNativePlugin =
      scopeRecord.capabilitySnapshot.requiresNativePlugin === true;
    evidence.codexHasRepoManagedArtifacts =
      scopeRecord.capabilitySnapshot.hasRepoManagedArtifacts === true;
    evidence.codexManagedKinds = getCodexSnapshotManagedKinds(scopeRecord.capabilitySnapshot);
  }
  if (isClaudeSnapshot(evidence.platform, scopeRecord.capabilitySnapshot)) {
    evidence.claudeManagedExtensions = [
      ...new Set(scopeRecord.capabilitySnapshot.managedExtensions ?? []),
    ].sort();
  }
}

async function readTrackingManifestSafe(targetDir: string): Promise<{
  manifest?: TrackingManifest;
  error?: string;
}> {
  try {
    return { manifest: await readTrackingManifest(targetDir) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function collectLedgerEvidence(
  context: DiscoveryContext,
  ledger: InstalledLedger,
  records: Map<string, DiscoveredPluginName>,
): Promise<void> {
  for (const pluginName of Object.keys(ledger.plugins).sort()) {
    const discoveryRecord = getOrCreateDiscoveryRecord(records, pluginName);
    discoveryRecord.ledgerRecord = ledger.plugins[pluginName];

    for (const platform of context.platforms) {
      for (const scope of context.scopes) {
        const identity = context.identities[platform][scope];
        const scopeRecord = getScopeLedgerRecord(
          discoveryRecord.ledgerRecord,
          platform,
          scope,
          identity.projectKey,
        );
        if (scopeRecord) {
          addLedgerEvidence(
            getOrCreateEvidence(discoveryRecord, identity, ledger),
            scopeRecord,
          );
        }
      }
    }

    if (context.platforms.includes('codex')) {
      const refs = ledger.plugins[pluginName].platforms.codex?.sharedNativeRefs;
      if (refs?.user && context.scopes.includes('user')) {
        const identity = context.identities.codex.user;
        addEvidenceSource(
          getOrCreateEvidence(discoveryRecord, identity, ledger),
          'codexSharedNativeRef',
        );
      }
    }
  }
}

async function collectTrackingEvidence(
  context: DiscoveryContext,
  ledger: InstalledLedger,
  records: Map<string, DiscoveredPluginName>,
): Promise<DiscoveryReadError[]> {
  const readErrors: DiscoveryReadError[] = [];

  for (const platform of context.platforms) {
    for (const scope of context.scopes) {
      const identity = context.identities[platform][scope];
      const paths = platform === 'codex'
        ? resolveCodexPaths(identity.executionCwd, scope, context.env)
        : resolveClaudePaths(identity.executionCwd, scope, context.env);
      const tracking = await readTrackingManifestSafe(paths.trackingDir);
      if (!tracking.manifest) {
        if (tracking.error) {
          readErrors.push({
            ...identity,
            message: `tracking manifest (${paths.trackingDir}): ${tracking.error}`,
          });
        }
        continue;
      }

      for (const pluginName of Object.keys(tracking.manifest.plugins).sort()) {
        const discoveryRecord = getOrCreateDiscoveryRecord(records, pluginName);
        const evidence = getOrCreateEvidence(discoveryRecord, identity, ledger);
        addTrackingEvidence(evidence, tracking.manifest.plugins[pluginName]);
      }
    }
  }

  return readErrors;
}

async function collectCodexNativeEvidence(
  context: DiscoveryContext,
  ledger: InstalledLedger,
  records: Map<string, DiscoveredPluginName>,
): Promise<DiscoveryReadError[]> {
  if (!context.platforms.includes('codex') || !context.scopes.includes('user')) {
    return [];
  }

  const identity = context.identities.codex.user;
  try {
    const nativeStates = await listCodexNativeEvidence(context.env);
    for (const nativeState of nativeStates) {
      const discoveryRecord = getOrCreateDiscoveryRecord(records, nativeState.pluginName);
      const evidence = getOrCreateEvidence(discoveryRecord, identity, ledger);
      if (nativeState.pluginEnabled) {
        addEvidenceSource(evidence, 'codexNativeConfig');
      }
      if (hasCodexNativeCacheEvidence(nativeState)) {
        addEvidenceSource(evidence, 'codexNativeCache');
      }
    }
  } catch (error) {
    const paths = resolveCodexPaths(identity.executionCwd, 'user', context.env);
    return [{
      ...identity,
      message: `Codex config (${paths.configTomlPath}): ${errorMessage(error)}`,
    }];
  }

  for (const breadcrumb of await listCodexNativeRecoveryBreadcrumbs(context.env)) {
    const discoveryRecord = getOrCreateDiscoveryRecord(records, breadcrumb.pluginName);
    addEvidenceSource(getOrCreateEvidence(discoveryRecord, identity, ledger), 'codexNativeRecovery');
  }

  return [];
}

async function collectClaudeRuntimeEvidence(
  context: DiscoveryContext,
  ledger: InstalledLedger,
  records: Map<string, DiscoveredPluginName>,
): Promise<DiscoveryReadError[]> {
  if (!context.platforms.includes('claude')) {
    return [];
  }

  const readErrors: DiscoveryReadError[] = [];

  for (const scope of context.scopes) {
    const identity = context.identities.claude[scope];
    const paths = resolveClaudePaths(identity.executionCwd, scope, context.env);
    let settings: Awaited<ReturnType<typeof readClaudeSettings>> = {};
    let installedPlugins: Awaited<ReturnType<typeof readClaudeInstalledPluginsState>> = {
      plugins: {},
    };
    try {
      settings = await readClaudeSettings(paths.settingsPath);
    } catch (error) {
      readErrors.push({
        ...identity,
        message: `Claude settings (${paths.settingsPath}): ${errorMessage(error)}`,
      });
    }
    try {
      installedPlugins = await readClaudeInstalledPluginsState(paths.installedPluginsPath);
    } catch (error) {
      readErrors.push({
        ...identity,
        message: `Claude installed plugins (${paths.installedPluginsPath}): ${errorMessage(error)}`,
      });
    }

    for (const [pluginName, record] of Object.entries(settings.plugins?.installed ?? {}).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (
        record.marketplace !== MARKETPLACE_NAME ||
        (record.enabled === false) ||
        (scope === 'project' && record.projectPath !== identity.projectKey) ||
        (scope === 'user' && record.scope === 'project')
      ) {
        continue;
      }
      const discoveryRecord = getOrCreateDiscoveryRecord(records, pluginName);
      addEvidenceSource(
        getOrCreateEvidence(discoveryRecord, identity, ledger),
        'claudeSettings',
      );
    }

    for (const [pluginRef, entries] of Object.entries(installedPlugins.plugins).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      for (const record of entries) {
        if (
          record.marketplace !== MARKETPLACE_NAME ||
          record.scope !== scope ||
          (scope === 'project' && record.projectPath !== identity.projectKey)
        ) {
          continue;
        }
        const pluginName = record.name || pluginRef.replace(/@[^@]+$/, '');
        const discoveryRecord = getOrCreateDiscoveryRecord(records, pluginName);
        addEvidenceSource(
          getOrCreateEvidence(discoveryRecord, identity, ledger),
          'claudeInstalledPlugins',
        );
      }
    }

    for (const pluginName of Object.keys(settings.awGenerated?.permissions ?? {}).sort()) {
      const discoveryRecord = getOrCreateDiscoveryRecord(records, pluginName);
      addEvidenceSource(
        getOrCreateEvidence(discoveryRecord, identity, ledger),
        'claudeSettings',
      );
    }
  }

  return readErrors;
}

function applyReadErrors(
  context: DiscoveryContext,
  ledger: InstalledLedger,
  records: Map<string, DiscoveredPluginName>,
  readErrors: DiscoveryReadError[],
  requestedPluginNames: string[] | undefined,
): void {
  if (readErrors.length === 0) {
    return;
  }

  const requested = new Set(requestedPluginNames ?? []);
  for (const error of readErrors) {
    if (
      !context.platforms.includes(error.platform) ||
      !context.scopes.includes(error.scope)
    ) {
      continue;
    }

    for (const record of records.values()) {
      const hasEvidence = Object.keys(record.evidenceByPlatformScope).length > 0;
      const shouldPreserveDefaultCatalogUnknown =
        requestedPluginNames === undefined && record.currentCatalog !== undefined;
      if (
        !hasEvidence &&
        !requested.has(record.pluginName) &&
        !shouldPreserveDefaultCatalogUnknown
      ) {
        continue;
      }

      const evidence = getOrCreateEvidence(record, error, ledger);
      addReadError(evidence, error.message);
    }
  }
}

async function attachCurrentCatalog(
  env: NodeJS.ProcessEnv,
  records: Map<string, DiscoveredPluginName>,
  pluginNames: string[] | undefined,
): Promise<void> {
  const [{ catalog, plugins }, embeddedRoot] = await Promise.all([
    resolveCatalogPlugins(undefined, env),
    resolveEmbeddedPluginsRoot(),
  ]);
  const embeddedPlugins = await resolvePluginsFromCatalog(embeddedRoot, undefined);
  const embeddedPluginMap = new Map(
    embeddedPlugins.map((plugin) => [plugin.manifest.name, plugin]),
  );
  const requested = pluginNames ? new Set(pluginNames) : undefined;

  for (const plugin of plugins) {
    if (requested && !requested.has(plugin.manifest.name)) {
      continue;
    }
    const record = getOrCreateDiscoveryRecord(records, plugin.manifest.name);
    record.currentCatalog = {
      catalog,
      currentPlugin: plugin,
      embeddedPlugin: embeddedPluginMap.get(plugin.manifest.name),
    };
  }
}

function filterDiscoveredRecords(
  records: Map<string, DiscoveredPluginName>,
  pluginNames: string[] | undefined,
): DiscoveredPluginName[] {
  const requested = pluginNames ? new Set(pluginNames) : undefined;
  const values = [...records.values()]
    .filter((record) => !requested || requested.has(record.pluginName));

  if (pluginNames) {
    const byName = new Map(values.map((record) => [record.pluginName, record]));
    return pluginNames
      .map((pluginName) => byName.get(pluginName))
      .filter((record): record is DiscoveredPluginName => Boolean(record));
  }

  return values.sort((left, right) => left.pluginName.localeCompare(right.pluginName));
}

export async function discoverManagedPluginNames(
  options: DiscoveryOptions,
): Promise<DiscoveredPluginName[]> {
  const context = await createDiscoveryContext(options);
  const ledger = await readInstalledLedger(context.env);
  const records = new Map<string, DiscoveredPluginName>();
  const pluginNames = options.pluginNames ?? options.names;

  await collectLedgerEvidence(context, ledger, records);
  const readErrors = [
    ...await collectTrackingEvidence(context, ledger, records),
    ...await collectCodexNativeEvidence(context, ledger, records),
    ...await collectClaudeRuntimeEvidence(context, ledger, records),
  ];

  for (const pluginName of pluginNames ?? []) {
    getOrCreateDiscoveryRecord(records, pluginName);
  }

  if (options.includeCurrentCatalog !== false) {
    await attachCurrentCatalog(context.env, records, pluginNames);
  }
  applyReadErrors(context, ledger, records, readErrors, pluginNames);

  return filterDiscoveredRecords(records, pluginNames);
}

function platformProduct(platform: PlatformName): string {
  return platform === 'codex' ? 'CODEX' : 'CLAUDE';
}

async function createTargetForEvidence(
  env: NodeJS.ProcessEnv,
  record: DiscoveredPluginName,
  evidence: DiscoveryEvidenceSummary,
): Promise<ResolvedPluginTarget> {
  const currentPlugin = record.currentCatalog?.currentPlugin;
  if (currentPlugin && pluginSupportsPlatform(currentPlugin, evidence.platform)) {
    return {
      pluginName: record.pluginName,
      plugin: currentPlugin,
      currentPlugin,
      embeddedPlugin: record.currentCatalog?.embeddedPlugin,
      source: 'currentCatalog',
    };
  }

  const historicalTarget = await createHistoricalPluginTarget(
    evidence.executionCwd,
    evidence.scope,
    record.pluginName,
    record.currentCatalog?.embeddedPlugin,
    env,
    undefined,
    {
      codexNativeManifestPlaceholder:
        evidence.platform === 'codex' &&
        (
          evidence.codexRequiresNativePlugin === true ||
          evidence.sources.includes('codexNativeConfig') ||
          evidence.sources.includes('codexNativeCache') ||
          evidence.sources.includes('codexNativeRecovery') ||
          evidence.sources.includes('codexSharedNativeRef')
        ),
    },
  );

  if (!currentPlugin) {
    return historicalTarget;
  }

  return {
    ...historicalTarget,
    currentPlugin,
    embeddedPlugin: record.currentCatalog?.embeddedPlugin,
  };
}

function evidenceHasActionableSource(evidence: DiscoveryEvidenceSummary): boolean {
  return evidence.sources.some((source) =>
    source === 'ledger' ||
    source === 'tracking' ||
    source === 'codexNativeConfig' ||
    source === 'codexNativeRecovery' ||
    source === 'codexSharedNativeRef' ||
    source === 'claudeSettings' ||
    source === 'claudeInstalledPlugins',
  );
}

function evidenceHasDiscoverySource(evidence: DiscoveryEvidenceSummary): boolean {
  return evidenceHasActionableSource(evidence) || evidence.sources.includes('codexNativeCache');
}

function evidenceHasReadErrors(evidence: DiscoveryEvidenceSummary): boolean {
  return evidence.readErrors.length > 0;
}

function isCoarseCodexRepoOnlyEvidence(
  target: ResolvedPluginTarget,
  evidence: DiscoveryEvidenceSummary,
): boolean {
  return (
    evidence.platform === 'codex' &&
    target.source === 'historical' &&
    evidence.codexHasRepoManagedArtifacts === true &&
    evidence.trackingKinds.length === 0 &&
    evidence.codexRequiresNativePlugin !== true &&
    !evidence.sources.includes('codexNativeConfig') &&
    !evidence.sources.includes('codexNativeCache') &&
    !evidence.sources.includes('codexNativeRecovery') &&
    !evidence.sources.includes('codexSharedNativeRef')
  );
}

function hasUnrecoverableHistoricalCodexRoleIdentity(
  target: ResolvedPluginTarget,
): boolean {
  if (target.source !== 'historical') {
    return false;
  }

  return (target.plugin.manifest.artifacts?.targets ?? []).some((artifact) =>
    artifact.platform === 'codex' &&
    artifact.target === 'codex.agentRole' &&
    (!artifact.roleKey || artifact.roleKey.trim() === ''),
  );
}

function resolveCandidateDependencyStatus(
  ledger: InstalledLedger,
  target: Pick<CommandCandidate, 'pluginName' | 'platform' | 'scope' | 'projectKey'>,
) {
  const ledgerRecord = ledger.plugins[target.pluginName];
  const scopeRecord = getScopeLedgerRecord(
    ledgerRecord,
    target.platform,
    target.scope,
    target.projectKey,
  );
  if (!scopeRecord) {
    return undefined;
  }

  const incomingIndex = buildIncomingDependencyIndex(ledger);
  const location = createCandidateLocation(target);
  const locationKey = serializePluginLocation(location);
  const dependents = (incomingIndex.incomingDependentsByLocation[locationKey] ?? []).map((entry) => ({
    plugin: entry.dependent.plugin,
    platform: entry.dependent.platform,
    scope: entry.dependent.scope,
    ...(entry.dependent.projectKey ? { projectKey: entry.dependent.projectKey } : {}),
  }));

  return {
    autoInstalled: scopeRecord.installSource?.kind === 'dependency',
    autoRemovable: canAutoCleanupScopeRecord({
      ledger,
      location,
      record: scopeRecord,
      incomingIndex,
    }),
    dependents,
  };
}

function resolveCandidateDisabledReason(
  command: 'status' | 'uninstall' | 'upgrade',
  target: ResolvedPluginTarget,
  evidence: DiscoveryEvidenceSummary,
  dependencyStatus: CommandCandidate['dependencyStatus'] | undefined,
): string | undefined {
  if (command === 'status') {
    return undefined;
  }

  if (!evidenceHasActionableSource(evidence)) {
    if (evidence.sources.includes('codexNativeCache')) {
      return '只发现了 Codex cache 残留，AW 没有成功账本或 recovery breadcrumb 证明归属；当前只能展示诊断，不能静默删除。';
    }
    if (evidence.readErrors.length > 0) {
      return '该 platform/scope 的受管状态读取失败，无法安全处理。';
    }
    return '没有发现当前 platform/scope 格子的受管安装证据。';
  }

  if (isCoarseCodexRepoOnlyEvidence(target, evidence)) {
    return '只有 Codex 历史账本中的粗粒度 repo-managed 标记，无法安全恢复具体受管能力。';
  }

  if (hasUnrecoverableHistoricalCodexRoleIdentity(target)) {
    return '历史 tracking 无法恢复 codex.agentRole 的真实 roleKey；当前不会编造占位 role 名，请先恢复 current catalog 或手动清理。';
  }

  if (evidence.trackingIntegrityErrors.length > 0) {
    return 'tracking manifest 中的 skill/mcpServer 缺少 artifactKey，无法安全清理。';
  }

  if (
    command === 'uninstall' &&
    dependencyStatus &&
    dependencyStatus.dependents.length > 0
  ) {
    const firstDependent = dependencyStatus.dependents[0];
    const dependentLabel = `${firstDependent.plugin} (${firstDependent.platform}/${firstDependent.scope})`;
    return dependencyStatus.dependents.length === 1
      ? `当前仍被 ${dependentLabel} 依赖，不能直接卸载。`
      : `当前仍被 ${dependentLabel} 等 ${dependencyStatus.dependents.length} 个安装位置依赖，不能直接卸载。`;
  }

  if (
    command === 'upgrade' &&
    evidence.platform === 'codex' &&
    evidence.scope === 'user' &&
    evidence.sources.includes('codexNativeRecovery') &&
    !evidence.sources.includes('ledger') &&
    !evidence.sources.includes('tracking')
  ) {
    return '当前只有 Codex native recovery breadcrumb，安装尚未完整成功；请先运行 aw install <plugin> -p codex -s user 修复，或运行 aw uninstall <plugin> -p codex -s user 清理。';
  }

  if (
    command === 'upgrade' &&
    evidence.platform === 'codex' &&
    evidence.scope === 'user' &&
    evidence.sources.includes('codexSharedNativeRef') &&
    !evidence.sources.includes('ledger') &&
    !evidence.sources.includes('tracking')
  ) {
    return '当前只剩 Codex shared native ref，不能证明该 scope 安装已完整成功；请先运行 aw install <plugin> -p codex -s user 修复账本，或运行 aw uninstall <plugin> -p codex -s user 清理残留。';
  }

  if (command === 'upgrade' && !target.currentPlugin) {
    return '当前插件目录已缺失，不能直接 upgrade；请先卸载或重新安装。';
  }

  if (target.currentPlugin && !pluginSupportsPlatform(target.currentPlugin, evidence.platform)) {
    return `插件当前目录不支持 ${platformProduct(evidence.platform)}。`;
  }

  return undefined;
}

async function resolveCandidateInstallState(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  target: Pick<CommandCandidate, 'pluginName' | 'platform' | 'scope' | 'projectKey'>;
}): Promise<CommandCandidate['installState']> {
  try {
    const location = {
      plugin: options.target.pluginName,
      platform: options.target.platform,
      scope: options.target.scope,
      ...(options.target.projectKey ? { projectKey: options.target.projectKey } : {}),
    };
    const evidence = await collectInstallEvidence({
      cwd: options.cwd,
      location,
      env: options.env,
      currentCatalog: null,
    });
    const projection = projectInstallState(evidence);

    return {
      kind: projection.kind,
      adoptExistingAvailable: projection.adoptExistingAvailable,
      autoInstalled: projection.autoInstalled,
      unusedDependencyHint: projection.unusedDependencyHint,
      dependencyProtected: projection.dependents.length > 0,
      ownerConflict: projection.sharedRuntimeNeedsTakeover
        && !(options.target.platform === 'codex' && options.target.scope === 'project'),
    };
  } catch {
    return undefined;
  }
}

async function resolveCandidatePlatformsForCurrentCatalog(
  options: ResolveDiscoveredPluginTargetsOptions,
  record: DiscoveredPluginName,
  evidencePlatforms: Set<PlatformName>,
): Promise<PlatformName[]> {
  if (options.platformFilter === 'codex' || options.platformFilter === 'claude') {
    return [options.platformFilter];
  }
  if (options.platformFilter === 'both') {
    return ['codex', 'claude'];
  }

  const detection = await detectEnvironment(options.cwd, options.env ?? process.env);
  const available = listDetectedPlatforms(detection);
  const platforms = new Set<PlatformName>([
    ...available,
    ...evidencePlatforms,
  ]);

  if (platforms.size === 0 && record.currentCatalog) {
    for (const platform of ['codex', 'claude'] as const) {
      if (pluginSupportsPlatform(record.currentCatalog.currentPlugin, platform)) {
        platforms.add(platform);
      }
    }
  }

  return [...platforms].sort();
}

export async function resolveDiscoveredPluginTargets(
  options: ResolveDiscoveredPluginTargetsOptions,
): Promise<DiscoveredPluginTarget[]> {
  const context = await createDiscoveryContext(options);
  const records = await discoverManagedPluginNames(options);
  const targets: DiscoveredPluginTarget[] = [];

  for (const record of records) {
    const evidenceEntries = Object.entries(record.evidenceByPlatformScope);
    const emittedKeys = new Set<string>();
    for (const [key, evidence] of evidenceEntries) {
      if (!context.platforms.includes(evidence.platform) || !context.scopes.includes(evidence.scope)) {
        continue;
      }
      const target = await createTargetForEvidence(context.env, record, evidence);
      if (
        target.source === 'currentCatalog' &&
        target.currentPlugin &&
        !pluginSupportsPlatform(target.currentPlugin, evidence.platform)
      ) {
        continue;
      }
      targets.push({
        pluginName: record.pluginName,
        platform: evidence.platform,
        scope: evidence.scope,
        projectKey: evidence.projectKey,
        projectRoot: evidence.projectRoot,
        executionCwd: evidence.executionCwd,
        target,
        evidence,
        evidenceByPlatformScope: record.evidenceByPlatformScope,
      });
      emittedKeys.add(key);
    }

    const currentPlugin = record.currentCatalog?.currentPlugin;
    if (!currentPlugin) {
      const requestedNames = options.pluginNames ?? options.names;
      if (requestedNames?.includes(record.pluginName) && evidenceEntries.length === 0) {
        const syntheticPlatforms = await resolveCandidatePlatformsForCurrentCatalog(
          options,
          record,
          new Set(),
        );
        const ledger = await readInstalledLedger(context.env);
        for (const platform of syntheticPlatforms) {
          if (!context.platforms.includes(platform)) {
            continue;
          }
          for (const scope of context.scopes) {
            const identity = context.identities[platform][scope];
            const evidence = createEmptyEvidence(identity, ledger);
            targets.push({
              pluginName: record.pluginName,
              platform,
              scope,
              projectKey: identity.projectKey,
              projectRoot: identity.projectRoot,
              executionCwd: identity.executionCwd,
              target: await createHistoricalPluginTarget(
                identity.executionCwd,
                identity.scope,
                record.pluginName,
                record.currentCatalog?.embeddedPlugin,
                context.env,
              ),
              evidence,
              evidenceByPlatformScope: record.evidenceByPlatformScope,
            });
          }
        }
      }
      continue;
    }

    const evidencePlatforms = new Set(evidenceEntries.map(([, evidence]) => evidence.platform));
    const currentCatalogPlatforms = await resolveCandidatePlatformsForCurrentCatalog(
      options,
      record,
      evidencePlatforms,
    );
    for (const platform of currentCatalogPlatforms) {
      if (!context.platforms.includes(platform) || !pluginSupportsPlatform(currentPlugin, platform)) {
        continue;
      }
      for (const scope of context.scopes) {
        const identity = context.identities[platform][scope];
        const key = platformScopeKey(platform, scope, identity.projectKey);
        if (emittedKeys.has(key)) {
          continue;
        }
        const evidence = createEmptyEvidence(identity, await readInstalledLedger(context.env));
        targets.push({
          pluginName: record.pluginName,
          platform,
          scope,
          projectKey: identity.projectKey,
          projectRoot: identity.projectRoot,
          executionCwd: identity.executionCwd,
          target: {
            pluginName: record.pluginName,
            plugin: currentPlugin,
            currentPlugin,
            embeddedPlugin: record.currentCatalog?.embeddedPlugin,
            source: 'currentCatalog',
          },
          evidence,
          evidenceByPlatformScope: record.evidenceByPlatformScope,
        });
      }
    }
  }

  const platformOrder = { codex: 0, claude: 1 };
  const scopeOrder = { user: 0, project: 1 };
  return targets.sort((left, right) =>
    left.pluginName.localeCompare(right.pluginName) ||
    platformOrder[left.platform] - platformOrder[right.platform] ||
    scopeOrder[left.scope] - scopeOrder[right.scope] ||
    (left.projectKey ?? '').localeCompare(right.projectKey ?? ''),
  );
}

function createCandidateId(
  command: BuildCommandCandidatesOptions['command'],
  target: DiscoveredPluginTarget,
): string {
  return [
    command,
    target.pluginName,
    target.platform,
    target.scope,
    target.projectKey ?? 'user',
  ]
    .map((value) => encodeURIComponent(value))
    .join(':');
}

export async function buildCommandCandidates(
  options: BuildCommandCandidatesOptions,
): Promise<CommandCandidate[]> {
  const discoveredTargets = await resolveDiscoveredPluginTargets({
    ...options,
    includeCurrentCatalog: true,
  });
  const ledger = await readInstalledLedger(options.env ?? process.env);
  const candidates: CommandCandidate[] = [];
  const requestedNames = options.pluginNames ?? options.names;

  for (const discovered of discoveredTargets) {
    if (
      options.command === 'status' &&
      requestedNames === undefined &&
      !evidenceHasDiscoverySource(discovered.evidence) &&
      !evidenceHasReadErrors(discovered.evidence) &&
      !Object.values(discovered.evidenceByPlatformScope).some((evidence) =>
        evidenceHasDiscoverySource(evidence) || evidenceHasReadErrors(evidence),
      )
    ) {
      continue;
    }
    if (
      options.command !== 'status' &&
      requestedNames === undefined &&
      !evidenceHasDiscoverySource(discovered.evidence) &&
      !evidenceHasReadErrors(discovered.evidence)
    ) {
      continue;
    }
    const dependencyStatus = resolveCandidateDependencyStatus(ledger, {
      pluginName: discovered.pluginName,
      platform: discovered.platform,
      scope: discovered.scope,
      projectKey: discovered.projectKey,
    });
    const disabledReason = resolveCandidateDisabledReason(
      options.command,
      discovered.target,
      discovered.evidence,
      dependencyStatus,
    );
    const installState = await resolveCandidateInstallState({
      cwd: discovered.executionCwd,
      env: options.env ?? process.env,
      target: {
        pluginName: discovered.pluginName,
        platform: discovered.platform,
        scope: discovered.scope,
        projectKey: discovered.projectKey,
      },
    });
    const candidate: CommandCandidate = {
      id: createCandidateId(options.command, discovered),
      command: options.command,
      pluginName: discovered.pluginName,
      platform: discovered.platform,
      scope: discovered.scope,
      projectKey: discovered.projectKey,
      projectRoot: discovered.projectRoot,
      executionCwd: discovered.executionCwd,
      target: discovered.target,
      selectable: disabledReason === undefined,
      disabledReason,
      ...(dependencyStatus ? { dependencyStatus } : {}),
      ...(installState ? { installState } : {}),
      evidence: discovered.evidence,
      evidenceByPlatformScope: discovered.evidenceByPlatformScope,
    };
    candidates.push(candidate);
  }

  return candidates;
}
