import path from 'node:path';

import chalk from 'chalk';
import fs from 'fs-extra';

import { CommandWarningError, isCommandWarningError } from '../types.js';
import { ClaudeAdapter } from '../adapters/claude.js';
import { CodexAdapter } from '../adapters/codex.js';
import type {
  AgentDefinition,
  ArtifactTarget,
  CatalogResolution,
  CommandAction,
  CodexCapabilitySnapshot,
  CodexProjectManagedKind,
  DynamicArtifactKind,
  EnvironmentDetection,
  GeneratedArtifact,
  HookDefinition,
  InstallCommandOptions,
  InstalledLedger,
  InstalledScopeRecord,
  InstructionDefinition,
  PlatformAdapter,
  PlatformName,
  PlatformSelection,
  PluginMeta,
  PluginArtifactTargetDefinition,
  PermissionDefinition,
  PluginStatusReport,
  ResolvedInstallOptions,
  Scope,
  StatusReport,
  UpgradeCommandOptions,
} from '../types.js';
import {
  createCommandExecutionContext,
  emitCommandEvent,
  isCommandExecutionContext,
  type CommandExecutionContext,
  type CommandExecutionContextInput,
} from './runtime.js';
import { detectEnvironment, listDetectedPlatforms } from '../utils/detect.js';
import {
  ensureLocalMarketplace,
  readInstalledLedger,
  type LocalMarketplaceGateOptions,
} from '../utils/local-marketplace.js';
import { generatedArtifactKindRequiresArtifactKey } from '../utils/generated-artifacts.js';
import {
  codexDynamicArtifactTargetRequiresProjectConfig,
  normalizeCodexCapabilitySnapshot,
  requiresCodexNativePlugin,
} from '../utils/codex-project-surface.js';
import {
  readPluginManifest,
  resolvePluginsFromCatalog,
} from '../utils/manifest.js';
import {
  getTrackingArtifactIntegrityErrors,
  getTrackingRecord,
  readTrackingManifest,
} from '../utils/tracking.js';
import { resolveSkillTriggerApplicabilityForPlugin } from '../utils/skill-trigger-preferences.js';
import {
  resolveEmbeddedPluginsRoot,
  resolveClaudePaths,
  resolveClaudeProjectKey,
  resolveCodexPaths,
  resolveCodexProjectKey,
} from '../utils/paths.js';
import {
  resolveActiveLocalBundle,
  resolveCurrentCatalog,
} from '../utils/plugin-catalog.js';
import { serializePluginLocation } from '../utils/plugin-dependency-location.js';
import {
  formatMarketplaceProductsForError,
  formatSupportedPlatforms,
  supportsPlatform,
  resolveSupportedPlatforms,
} from '../utils/platform-support.js';
import {
  canExecuteCodexProjectWithoutNative,
  listExecutablePlatformsForTargets,
} from './platform-resolution.js';

export function createAdapters(
  cwd: string,
  runtimeOrEnv: CommandExecutionContext | NodeJS.ProcessEnv = process.env,
  options: CommandExecutionContextInput = {},
): Record<PlatformName, PlatformAdapter> {
  if (isCommandExecutionContext(runtimeOrEnv)) {
    const adapters = runtimeOrEnv.adapters ?? runtimeOrEnv.adaptersFactory(cwd, runtimeOrEnv);
    const codexAdapter = adapters.codex as {
      setCommandEventSink?: (
        sink: (event: import('../output/model.js').CommandEvent) => void | Promise<void>,
      ) => void;
    };
    codexAdapter.setCommandEventSink?.((event) => emitCommandEvent(runtimeOrEnv, event));
    return adapters;
  }

  const context = createCommandExecutionContext({
    ...options,
    env: runtimeOrEnv,
  });
  if (context.adapters) {
    return context.adapters;
  }

  return {
    codex: new CodexAdapter(cwd, context.nativeCliRunner, context.env),
    claude: new ClaudeAdapter(cwd, context.nativeCliRunner, context.env),
  };
}

export interface ResolvedPluginTarget {
  pluginName: string;
  plugin: PluginMeta;
  currentPlugin?: PluginMeta;
  embeddedPlugin?: PluginMeta;
  source: 'currentCatalog' | 'historical';
  historicalArtifacts?: GeneratedArtifact[];
}

export interface PreparedPluginCommandContext {
  ledger: InstalledLedger;
  targets: ResolvedPluginTarget[];
  warnings: string[];
  marketplace?: PreparedMarketplaceState;
}

export interface PreparedMarketplaceState {
  rootDir: string;
  source: CatalogResolution['source'];
  changed: boolean;
  mode: CatalogPreparationMode;
  catalog: CatalogResolution;
}

export interface RequestedPlatformTargetPair {
  pluginName: string;
  platform: PlatformName;
}

export type CatalogPreparationMode = 'readOnly' | 'runtimeWritable';

interface PreparedCatalogState {
  catalog: CatalogResolution;
  marketplace: PreparedMarketplaceState;
  warnings: string[];
}

function createLocalMarketplaceGate(
  context: CommandExecutionContext | undefined,
): LocalMarketplaceGateOptions | undefined {
  if (!context) {
    return undefined;
  }

  return {
    interactive: context.interactive,
    confirmOverwrite: async ({ message, defaultValue }) => {
      const result = await context.prompt.confirm?.({ message, defaultValue });
      return result?.action === 'select' && result.value === true;
    },
    onNotice: async (message) => {
      await context.reporter.notice({
        level: 'warning',
        message,
        identity: `local-marketplace:${message}`,
        target: 'stderr',
      });
    },
  };
}

function resolveCatalogPreparationMode(options: {
  catalogMode?: CatalogPreparationMode;
  ensureLocalMarketplace?: boolean;
}): CatalogPreparationMode {
  if (options.catalogMode) {
    return options.catalogMode;
  }

  return options.ensureLocalMarketplace ? 'runtimeWritable' : 'readOnly';
}

function createReadOnlyMarketplaceState(catalog: CatalogResolution): PreparedMarketplaceState {
  return {
    rootDir: catalog.rootDir,
    source: catalog.source,
    changed: false,
    mode: 'readOnly',
    catalog,
  };
}

function createRuntimeWritableMarketplaceState(
  ensuredMarketplace: Awaited<ReturnType<typeof ensureLocalMarketplace>>,
): PreparedMarketplaceState {
  return {
    rootDir: ensuredMarketplace.rootDir,
    source: 'local',
    changed: ensuredMarketplace.changed,
    mode: 'runtimeWritable',
    catalog: {
      rootDir: ensuredMarketplace.rootDir,
      source: 'local',
    },
  };
}

type HistoricalManagedKind = GeneratedArtifact['kind'];
type HistoricalExtensionKind = Extract<
  HistoricalManagedKind,
  'instruction' | 'permission' | 'hook' | 'agent'
>;
type HistoricalManagedKindsByPlatform = Record<PlatformName, Set<HistoricalManagedKind>>;
type HistoricalDynamicTargetsByPlatform = Record<PlatformName, Map<string, PluginArtifactTargetDefinition>>;

interface HistoricalTrackingSummary {
  kindsByPlatform: HistoricalManagedKindsByPlatform;
  trackedStaticKindsByPlatform: HistoricalManagedKindsByPlatform;
  trackedDynamicKindsByPlatform: HistoricalManagedKindsByPlatform;
  dynamicTargetsByPlatform: HistoricalDynamicTargetsByPlatform;
  historicalArtifacts: GeneratedArtifact[];
}

const HISTORICAL_SKILLS_PATH = './historical-skills';
const HISTORICAL_MCP_SERVERS_PATH = './historical-mcp.json';
const HISTORICAL_EXTENSION_KIND_ORDER: HistoricalExtensionKind[] = [
  'instruction',
  'permission',
  'hook',
  'agent',
];
const PLATFORM_PRODUCT_BY_NAME: Record<PlatformName, string> = {
  codex: 'CODEX',
  claude: 'CLAUDE',
};

const PLATFORM_DISPLAY_BY_NAME: Record<PlatformName, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

export function formatPolicyProducts(plugin: PluginMeta): string {
  const products = plugin.manifest.marketplace.policy.products;
  return products && products.length > 0 ? products.join(', ') : '未限制';
}

export function pluginSupportsPlatform(plugin: PluginMeta, platform: PlatformName): boolean {
  return supportsPlatform(plugin.manifest, platform);
}

export function assertPluginsSupportPlatforms(
  plugins: PluginMeta[],
  platforms: PlatformName[],
): void {
  const unsupported = plugins.flatMap((plugin) =>
    platforms
      .filter((platform) => !pluginSupportsPlatform(plugin, platform))
      .map((platform) => ({
        plugin,
        platform,
      })),
  );

  if (unsupported.length === 0) {
    return;
  }

  const details = unsupported
    .map(({ plugin, platform }) =>
      `${plugin.manifest.name} -> ${PLATFORM_DISPLAY_BY_NAME[platform]} (${formatMarketplaceProductsForError(plugin.manifest)}, 实际支持平台=${formatSupportedPlatforms(resolveSupportedPlatforms(plugin.manifest))}, 需要 ${PLATFORM_PRODUCT_BY_NAME[platform]})`,
    )
    .join('；');
  throw new Error(`插件不支持目标平台：${details}`);
}

function isHistoricalExtensionKind(kind: HistoricalManagedKind): kind is HistoricalExtensionKind {
  return HISTORICAL_EXTENSION_KIND_ORDER.includes(kind as HistoricalExtensionKind);
}

function createHistoricalKindsByPlatform(): HistoricalManagedKindsByPlatform {
  return {
    claude: new Set(),
    codex: new Set(),
  };
}

function createHistoricalDynamicTargetsByPlatform(): HistoricalDynamicTargetsByPlatform {
  return {
    claude: new Map(),
    codex: new Map(),
  };
}

function createHistoricalTrackingSummary(): HistoricalTrackingSummary {
  return {
    kindsByPlatform: createHistoricalKindsByPlatform(),
    trackedStaticKindsByPlatform: createHistoricalKindsByPlatform(),
    trackedDynamicKindsByPlatform: createHistoricalKindsByPlatform(),
    dynamicTargetsByPlatform: createHistoricalDynamicTargetsByPlatform(),
    historicalArtifacts: [],
  };
}

function inferDynamicManagedKind(target: ArtifactTarget): DynamicArtifactKind {
  if (target === 'codex.agentRole') {
    return 'codexRole';
  }
  if (target === 'codex.skill') {
    return 'skill';
  }
  return 'instruction';
}

function inferProjectManagedKind(target: ArtifactTarget): CodexProjectManagedKind {
  if (target === 'codex.agentRole') {
    return 'agent';
  }
  if (target === 'codex.skill') {
    return 'skill';
  }
  return 'instruction';
}

function inferHistoricalExtensionKindFromDynamicTarget(
  target: ArtifactTarget,
): HistoricalManagedKind {
  if (target === 'codex.agentRole') {
    return 'agent';
  }
  if (target === 'codex.skill') {
    return 'skill';
  }
  return 'instruction';
}

function resolveHistoricalTrackedRoleKey(
  artifact: Pick<GeneratedArtifact, 'target' | 'roleKey' | 'artifactKey'>,
): string | undefined {
  if (artifact.target !== 'codex.agentRole') {
    return undefined;
  }

  const roleKey = artifact.roleKey?.trim() || artifact.artifactKey?.trim();
  return roleKey || undefined;
}

function appendHistoricalTrackingArtifacts(
  summary: HistoricalTrackingSummary,
  artifacts: GeneratedArtifact[],
  scope: Scope,
): void {
  for (const artifact of artifacts) {
    const normalizedArtifact = artifact.target === 'codex.agentRole'
      ? {
          ...artifact,
          ...(resolveHistoricalTrackedRoleKey(artifact) && !artifact.roleKey
            ? { roleKey: resolveHistoricalTrackedRoleKey(artifact) }
            : {}),
        }
      : artifact;
    summary.kindsByPlatform[artifact.platform].add(artifact.kind);

    const artifactId = normalizedArtifact.id;
    const artifactTarget = normalizedArtifact.target;
    const dynamicTarget =
      normalizedArtifact.platform === 'codex' &&
      artifactId !== undefined &&
      artifactTarget !== undefined;
    if (!dynamicTarget) {
      summary.trackedStaticKindsByPlatform[normalizedArtifact.platform].add(normalizedArtifact.kind);
      summary.historicalArtifacts.push(structuredClone(normalizedArtifact));
      continue;
    }

    const extensionKind = inferHistoricalExtensionKindFromDynamicTarget(artifactTarget);
    summary.trackedDynamicKindsByPlatform[normalizedArtifact.platform].add(extensionKind);
    summary.historicalArtifacts.push(structuredClone(normalizedArtifact));

    const dynamicKey = `${normalizedArtifact.platform}:${artifactId}:${artifactTarget}`;
    if (summary.dynamicTargetsByPlatform[normalizedArtifact.platform].has(dynamicKey)) {
      continue;
    }

    const states: PluginArtifactTargetDefinition['states'] = normalizedArtifact.state
      ? [normalizedArtifact.state]
      : ['present'];
    const resolvedRoleKey = resolveHistoricalTrackedRoleKey(normalizedArtifact);
    summary.dynamicTargetsByPlatform[normalizedArtifact.platform].set(dynamicKey, {
      id: artifactId,
      platform: normalizedArtifact.platform,
      scopes: [scope],
      target: artifactTarget,
      kind: inferDynamicManagedKind(artifactTarget),
      projectManagedKind: inferProjectManagedKind(artifactTarget),
      states,
      refreshKeys: normalizedArtifact.refreshKeys ? [...normalizedArtifact.refreshKeys] : [],
      requiresCodexProjectConfig: codexDynamicArtifactTargetRequiresProjectConfig({
        target: artifactTarget,
      }),
      ...(artifactTarget === 'codex.agentRole' && resolvedRoleKey
        ? { roleKey: resolvedRoleKey }
        : {}),
      ...(artifactTarget === 'codex.skill' && normalizedArtifact.artifactKey
        ? { skillKey: normalizedArtifact.artifactKey }
        : {}),
    });
  }
}

function getCodexSnapshotManagedKinds(
  snapshot: CodexCapabilitySnapshot | undefined,
): CodexProjectManagedKind[] {
  return normalizeCodexCapabilitySnapshot(snapshot).projectManagedKinds;
}

function shouldEmitHistoricalPlaceholderKind(
  kind: HistoricalExtensionKind,
  platform: PlatformName,
  summary: HistoricalTrackingSummary,
): boolean {
  if (kind === 'agent') {
    return summary.trackedStaticKindsByPlatform[platform].has('agent');
  }

  if (kind === 'instruction') {
    return (
      summary.trackedStaticKindsByPlatform[platform].has('instruction') ||
      (
        summary.kindsByPlatform[platform].has('instruction') &&
        !summary.trackedDynamicKindsByPlatform[platform].has('instruction')
      )
    );
  }

  return summary.kindsByPlatform[platform].has(kind);
}

function createHistoricalExtensionKinds(
  summary: HistoricalTrackingSummary,
): PluginMeta['manifest']['extensions'] | undefined {
  const hasKind = (kind: HistoricalExtensionKind): boolean =>
    shouldEmitHistoricalPlaceholderKind(kind, 'claude', summary) ||
    shouldEmitHistoricalPlaceholderKind(kind, 'codex', summary);
  const platformOverrides = (kind: HistoricalExtensionKind) => ({
    claude: shouldEmitHistoricalPlaceholderKind(kind, 'claude', summary) ? undefined : null,
    codex: shouldEmitHistoricalPlaceholderKind(kind, 'codex', summary) ? undefined : null,
  });

  if (!Object.values(summary.kindsByPlatform).some((kinds) =>
    [...kinds].some((kind) => isHistoricalExtensionKind(kind)),
  )) {
    return undefined;
  }

  return {
    instructions: hasKind('instruction')
      ? [{
          name: 'historical-instruction',
          title: 'Historical Instruction',
          content: 'Historical managed instruction placeholder.',
          agentOverrides: platformOverrides('instruction') as InstructionDefinition['agentOverrides'],
        }]
      : undefined,
    permissions: hasKind('permission')
      ? [{
          name: 'historical-permission',
          allow: [],
          ask: [],
          deny: [],
          agentOverrides: platformOverrides('permission') as PermissionDefinition['agentOverrides'],
        }]
      : undefined,
    hooks: hasKind('hook')
      ? [{
          event: 'session_start',
          command: 'true',
          agentOverrides: platformOverrides('hook') as HookDefinition['agentOverrides'],
        }]
      : undefined,
    agents: hasKind('agent')
      ? [{
          name: 'historical-agent',
          description: 'Historical agent placeholder.',
          prompt: 'Historical agent placeholder.',
          tools: [],
          agentOverrides: platformOverrides('agent') as AgentDefinition['agentOverrides'],
        }]
      : undefined,
  };
}

function createHistoricalArtifactTargets(
  summary: HistoricalTrackingSummary,
): PluginArtifactTargetDefinition[] | undefined {
  const targets = [...summary.dynamicTargetsByPlatform.codex.values()]
    .sort((left, right) =>
      left.target.localeCompare(right.target) || left.id.localeCompare(right.id),
    );
  return targets.length > 0 ? targets : undefined;
}

export async function createHistoricalPluginTarget(
  cwd: string,
  scope: Scope,
  pluginName: string,
  embeddedPlugin: PluginMeta | undefined,
  env: NodeJS.ProcessEnv = process.env,
  ledger: InstalledLedger | undefined = undefined,
  hints: {
    codexNativeManifestPlaceholder?: boolean;
  } = {},
): Promise<ResolvedPluginTarget> {
  const resolvedLedger = ledger ?? await readInstalledLedger(env);
  const pluginRecord = resolvedLedger.plugins[pluginName];
  const [claudeProjectKey, codexProjectKey] = await Promise.all([
    resolveClaudeProjectKey(cwd),
    resolveCodexProjectKey(cwd),
  ]);

  const trackingSummary = createHistoricalTrackingSummary();
  const [claudeTracking, codexTracking] = await Promise.all([
    readTrackingManifest(resolveClaudePaths(cwd, scope, env).trackingDir).catch(() => undefined),
    readTrackingManifest(resolveCodexPaths(cwd, scope, env).trackingDir).catch(() => undefined),
  ]);

  for (const manifest of [claudeTracking, codexTracking]) {
    if (!manifest) {
      continue;
    }
    const record = getTrackingRecord(manifest, pluginName);
    appendHistoricalTrackingArtifacts(trackingSummary, record?.artifacts ?? [], scope);
  }

  const claudeScopeRecord =
    scope === 'user'
      ? pluginRecord?.platforms.claude?.userScope
      : pluginRecord?.platforms.claude?.projectScopes?.[claudeProjectKey];
  if (claudeScopeRecord?.capabilitySnapshot.managedExtensions?.includes('instructions')) {
    trackingSummary.kindsByPlatform.claude.add('instruction');
  }
  if (claudeScopeRecord?.capabilitySnapshot.managedExtensions?.includes('permissions')) {
    trackingSummary.kindsByPlatform.claude.add('permission');
  }
  if (claudeScopeRecord?.capabilitySnapshot.managedExtensions?.includes('hooks')) {
    trackingSummary.kindsByPlatform.claude.add('hook');
  }

  const codexScopeRecord =
    scope === 'user'
      ? pluginRecord?.platforms.codex?.userScope
      : pluginRecord?.platforms.codex?.projectScopes?.[codexProjectKey];
  for (const kind of getCodexSnapshotManagedKinds(codexScopeRecord?.capabilitySnapshot)) {
    trackingSummary.kindsByPlatform.codex.add(kind);
  }

  const codexHistoricalKinds = trackingSummary.kindsByPlatform.codex;
  const codexRequiresNativePlugin =
    codexScopeRecord?.capabilitySnapshot.requiresNativePlugin === true ||
    hints.codexNativeManifestPlaceholder === true;
  const hasCodexNativeManifestPlaceholder =
    codexHistoricalKinds.has('skill') || codexHistoricalKinds.has('mcpServer');

  return {
    pluginName,
    plugin: {
      rootDir: '',
      manifestPath: '',
      manifest: {
        name: pluginName,
        version: pluginRecord?.lastResolvedVersion ?? '0.0.0',
        description: 'Historical managed plugin placeholder.',
        skills:
          codexHistoricalKinds.has('skill') ||
          (codexRequiresNativePlugin && !hasCodexNativeManifestPlaceholder)
            ? HISTORICAL_SKILLS_PATH
            : undefined,
        mcpServers: codexHistoricalKinds.has('mcpServer')
          ? HISTORICAL_MCP_SERVERS_PATH
          : undefined,
        marketplace: {
          category: 'historical',
          strict: true,
          policy: {
            installation: 'HISTORICAL',
            authentication: 'NONE',
          },
        },
        extensions: createHistoricalExtensionKinds(trackingSummary),
        ...(createHistoricalArtifactTargets(trackingSummary)
          ? {
              artifacts: {
                targets: createHistoricalArtifactTargets(trackingSummary),
              },
            }
          : {}),
      },
    },
    currentPlugin: undefined,
    embeddedPlugin,
    source: 'historical',
    historicalArtifacts: trackingSummary.historicalArtifacts,
  };
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function dedupeWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)];
}

export function wrapCommandErrorWithWarnings(error: unknown, warnings: string[]): Error {
  const normalizedError = normalizeError(error);
  if (warnings.length === 0) {
    return normalizedError;
  }

  if (isCommandWarningError(normalizedError)) {
    return new CommandWarningError(normalizedError.message, {
      warnings: [...warnings, ...normalizedError.warnings],
      exitCode: normalizedError.exitCode,
    });
  }

  return new CommandWarningError(normalizedError.message, {
    warnings,
  });
}

async function resolveScopeKeys(
  cwd: string,
  scope: Scope,
): Promise<Record<PlatformName, string | undefined>> {
  if (scope === 'user') {
    return {
      codex: undefined,
      claude: undefined,
    };
  }

  const [claudeProjectKey, codexProjectKey] = await Promise.all([
    resolveClaudeProjectKey(cwd),
    resolveCodexProjectKey(cwd),
  ]);

  return {
    codex: codexProjectKey,
    claude: claudeProjectKey,
  };
}

function getScopeIdentity(
  platform: PlatformName,
  scope: Scope,
  scopeKeys: Record<PlatformName, string | undefined>,
): string {
  if (scope === 'user') {
    return 'user';
  }

  const scopeKey = scopeKeys[platform];
  if (!scopeKey) {
    throw new Error(`无法解析 ${platform} 的 project scope key。`);
  }

  return `project:${scopeKey}`;
}

function getInstalledScopeRecordForTarget(
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

export function createResolvedInstallOptionsKey(
  platform: PlatformName,
  pluginName: string,
  scopeIdentity: string,
): string {
  return `${platform}:${pluginName}:${scopeIdentity}`;
}

function resolveLedgerBackedPreference(
  scopeRecord: InstalledScopeRecord<Record<string, unknown>> | undefined,
): Pick<Extract<ResolvedInstallOptions, { applicability: 'overridable' }>, 'skillTriggerPreference' | 'skillTriggerSource'> {
  const ledgerPreference = scopeRecord?.installOptions?.skillTriggerPreference;
  return ledgerPreference
    ? {
        skillTriggerPreference: ledgerPreference,
        skillTriggerSource: 'ledger',
      }
    : {
        skillTriggerPreference: 'default',
        skillTriggerSource: 'default',
      };
}

function hasRecoverableLedgerSkillTriggerPreference(
  scopeRecord: InstalledScopeRecord<Record<string, unknown>> | undefined,
): boolean {
  return scopeRecord?.managed === true && typeof scopeRecord.installOptions?.skillTriggerPreference === 'string';
}

function renderSkillTriggerConfigGuidance(
  pluginName: string,
  platform: PlatformName,
  scope: Scope,
  reason: string,
): string {
  return `${pluginName} 在 ${platform} (${scope}) ${reason}；请改用配置管理维护 skill trigger 偏好后再重试。`;
}

async function hasTrackingManagedEvidenceForTarget(
  cwd: string,
  scope: Scope,
  platform: PlatformName,
  pluginName: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const trackingDir = platform === 'claude'
    ? resolveClaudePaths(cwd, scope, env).trackingDir
    : resolveCodexPaths(cwd, scope, env).trackingDir;
  const manifest = await readTrackingManifest(trackingDir);
  return Boolean(getTrackingRecord(manifest, pluginName));
}

async function prepareCatalogState(
  mode: CatalogPreparationMode,
  env: NodeJS.ProcessEnv,
  ledger?: InstalledLedger,
  context?: CommandExecutionContext,
): Promise<PreparedCatalogState> {
  if (mode === 'runtimeWritable') {
    const ensuredMarketplace = await ensureLocalMarketplace(
      env,
      createLocalMarketplaceGate(context),
    );
    return {
      catalog: {
        rootDir: ensuredMarketplace.rootDir,
        source: 'local',
      },
      marketplace: createRuntimeWritableMarketplaceState(ensuredMarketplace),
      warnings: ensuredMarketplace.warnings ?? [],
    };
  }

  const [currentCatalog, embeddedRoot] = await Promise.all([
    resolveCurrentCatalog(env),
    resolveEmbeddedPluginsRoot(),
  ]);
  const catalog =
    ledger?.ledgerState.status === 'degraded' && currentCatalog.source === 'local'
      ? {
        rootDir: embeddedRoot,
        source: 'embedded' as const,
        reason: 'installed.json 处于 degraded 状态，read-only catalog 回退到 embedded bundle。',
        reasonCode: 'localLedgerDegraded' as const,
      }
      : currentCatalog;

  return {
    catalog,
    marketplace: createReadOnlyMarketplaceState(catalog),
    warnings: [],
  };
}

export async function preparePluginTargetsForCommand(
  cwd: string,
  scope: Scope,
  pluginNames: string[] | undefined,
  options: {
    catalogMode?: CatalogPreparationMode;
    ensureLocalMarketplace?: boolean;
    allowHistoricalFallback?: boolean;
    env?: NodeJS.ProcessEnv;
    context?: CommandExecutionContext;
  } = {},
): Promise<PreparedPluginCommandContext> {
  const env = options.env ?? process.env;
  const catalogMode = resolveCatalogPreparationMode(options);
  const ledger = await readInstalledLedger(env);
  const catalogState = await prepareCatalogState(catalogMode, env, ledger, options.context);
  const loadedTargets = await loadPluginTargetsForCommandWithCatalog(cwd, scope, pluginNames, {
    catalog: catalogState.catalog,
    allowHistoricalFallback: options.allowHistoricalFallback,
    env,
  });

  return {
    ledger,
    targets: loadedTargets.targets,
    warnings: dedupeWarnings(catalogState.warnings),
    marketplace: catalogState.marketplace,
  };
}

export async function prepareCommandEnvironment(
  options: {
    catalogMode?: CatalogPreparationMode;
    ensureLocalMarketplace?: boolean;
    env?: NodeJS.ProcessEnv;
    context?: CommandExecutionContext;
  } = {},
): Promise<Pick<PreparedPluginCommandContext, 'ledger' | 'warnings' | 'marketplace'>> {
  const env = options.env ?? process.env;
  const catalogMode = resolveCatalogPreparationMode(options);
  const ledger = await readInstalledLedger(env);
  const catalogState = await prepareCatalogState(catalogMode, env, ledger, options.context);

  return {
    ledger,
    warnings: dedupeWarnings(catalogState.warnings),
    marketplace: catalogState.marketplace,
  };
}

export function requiresRuntimeWritableMarketplaceForTargets(
  platforms: PlatformName[],
  targets: ResolvedPluginTarget[],
  scope: Scope,
): boolean {
  return platforms.some((platform) => {
    if (platform === 'claude') {
      return true;
    }

    return targets.some((target) =>
      target.currentPlugin
        ? requiresCodexNativePlugin(target.currentPlugin, scope)
        : requiresCodexNativePlugin(target.plugin, scope),
    );
  });
}

export async function listManagedPluginNamesForPreparedLedger(
  platform: PlatformName,
  scope: Scope,
  cwd: string,
  ledger: InstalledLedger,
): Promise<string[]> {
  const scopeKeys = await resolveScopeKeys(cwd, scope);
  return Object.keys(ledger.plugins)
    .filter((pluginName) =>
      getInstalledScopeRecordForTarget(ledger, pluginName, platform, scope, scopeKeys)?.managed === true,
    )
    .sort();
}

export async function resolveInstallOptionsForTargets(
  mode: 'install' | 'upgrade' | 'upgrade-all',
  targets: ResolvedPluginTarget[],
  platforms: PlatformName[],
  options: Pick<InstallCommandOptions | UpgradeCommandOptions, 'cwd' | 'scope' | 'requestedSkillTrigger'> & {
    env?: NodeJS.ProcessEnv;
  },
  ledger: InstalledLedger,
): Promise<Map<string, ResolvedInstallOptions>> {
  const scopeKeys = await resolveScopeKeys(options.cwd, options.scope);
  const resolved = new Map<string, ResolvedInstallOptions>();
  const env = options.env ?? process.env;
  const ledgerTrust: ResolvedInstallOptions['ledgerTrust'] =
    ledger.ledgerState.status === 'available' ? 'available' : 'degraded';

  for (const platform of platforms) {
    const scopeIdentity = getScopeIdentity(platform, options.scope, scopeKeys);

    for (const target of targets) {
      const nextOptions = await resolveInstallOptionsForResolvedTarget({
        mode,
        target,
        platform,
        scope: options.scope,
        requestedSkillTrigger: options.requestedSkillTrigger,
        cwd: options.cwd,
        env,
        ledger,
        scopeKeys,
        ledgerTrust,
      });
      resolved.set(
        createResolvedInstallOptionsKey(platform, target.pluginName, scopeIdentity),
        nextOptions,
      );
    }
  }

  return resolved;
}

export interface ResolvedInstallOptionsLocationRequest {
  location: {
    plugin: string;
    platform: PlatformName;
    scope: Scope;
    projectKey: string | null;
  };
  target: ResolvedPluginTarget;
  requestedSkillTrigger?: InstallCommandOptions['requestedSkillTrigger'];
}

async function resolveInstallOptionsForResolvedTarget(options: {
  mode: 'install' | 'upgrade' | 'upgrade-all';
  target: ResolvedPluginTarget;
  platform: PlatformName;
  scope: Scope;
  requestedSkillTrigger?: InstallCommandOptions['requestedSkillTrigger'];
  cwd: string;
  env: NodeJS.ProcessEnv;
  ledger: InstalledLedger;
  scopeKeys: Record<PlatformName, string | undefined>;
  ledgerTrust: ResolvedInstallOptions['ledgerTrust'];
}): Promise<ResolvedInstallOptions> {
  const skillTriggerPlugin = options.target.embeddedPlugin ?? options.target.currentPlugin ?? options.target.plugin;
  const applicability = await resolveSkillTriggerApplicabilityForPlugin(
    skillTriggerPlugin,
    options.platform,
  );
  const scopeRecord = getInstalledScopeRecordForTarget(
    options.ledger,
    options.target.pluginName,
    options.platform,
    options.scope,
    options.scopeKeys,
  );
  const isManagedTarget = scopeRecord?.managed === true;
  const trackingManagedEvidence = options.platform === 'codex' && options.scope === 'project'
    ? await hasTrackingManagedEvidenceForTarget(
        options.cwd,
        options.scope,
        options.platform,
        options.target.pluginName,
        options.env,
      )
    : false;

  if (applicability === 'none' || applicability === 'fixed') {
    return {
      applicability,
      ledgerTrust: options.ledgerTrust,
    };
  }

  if (options.requestedSkillTrigger) {
    return {
      applicability: 'overridable',
      skillTriggerPreference: options.requestedSkillTrigger,
      skillTriggerSource: 'cli',
      ledgerTrust: options.ledgerTrust,
    };
  }

  if (options.platform === 'codex' && options.scope === 'project') {
    if (options.ledger.ledgerState.status === 'available' && hasRecoverableLedgerSkillTriggerPreference(scopeRecord)) {
      return {
        applicability: 'overridable',
        skillTriggerPreference: scopeRecord!.installOptions!.skillTriggerPreference!,
        skillTriggerSource: 'ledger',
        ledgerTrust: options.ledgerTrust,
      };
    }
    if (isManagedTarget || trackingManagedEvidence) {
      const message = options.ledger.ledgerState.status === 'available'
        ? renderSkillTriggerConfigGuidance(
            options.target.pluginName,
            options.platform,
            options.scope,
            '的 skill trigger 偏好无法从当前 scope ledger 安全恢复，tracking 只能证明 repo artifact 归属',
          )
        : renderSkillTriggerConfigGuidance(
            options.target.pluginName,
            options.platform,
            options.scope,
            '已受管，installed.json 处于 degraded 状态时不能隐式继承旧的 skill trigger 偏好',
          );
      throw new CommandWarningError(message);
    }
    return {
      applicability: 'overridable',
      skillTriggerPreference: 'default',
      skillTriggerSource: 'default',
      ledgerTrust: options.ledgerTrust,
    };
  }

  if (options.mode === 'install') {
    if (options.ledger.ledgerState.status === 'available') {
      return {
        applicability: 'overridable',
        ...resolveLedgerBackedPreference(scopeRecord),
        ledgerTrust: options.ledgerTrust,
      };
    }
    if (isManagedTarget) {
      throw new CommandWarningError(
        renderSkillTriggerConfigGuidance(
          options.target.pluginName,
          options.platform,
          options.scope,
          '已受管，installed.json 处于 degraded 状态时不能隐式继承旧的 skill trigger 偏好',
        ),
      );
    }
    return {
      applicability: 'overridable',
      skillTriggerPreference: 'default',
      skillTriggerSource: 'default',
      ledgerTrust: options.ledgerTrust,
    };
  }

  if (options.ledger.ledgerState.status === 'available') {
    return {
      applicability: 'overridable',
      ...resolveLedgerBackedPreference(scopeRecord),
      ledgerTrust: options.ledgerTrust,
    };
  }

  throw new CommandWarningError(
    renderSkillTriggerConfigGuidance(
      options.target.pluginName,
      options.platform,
      options.scope,
      '的 skill trigger 偏好无法从 degraded installed.json 安全恢复',
    ),
  );
}

export async function resolveInstallOptionsForLocationTargets(
  mode: 'install' | 'upgrade' | 'upgrade-all',
  requests: ResolvedInstallOptionsLocationRequest[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
  },
  ledger: InstalledLedger,
): Promise<Map<string, ResolvedInstallOptions>> {
  const env = options.env ?? process.env;
  const ledgerTrust: ResolvedInstallOptions['ledgerTrust'] =
    ledger.ledgerState.status === 'available' ? 'available' : 'degraded';
  const scopeKeysByScope = new Map<Scope, Record<PlatformName, string | undefined>>();
  const resolved = new Map<string, ResolvedInstallOptions>();

  for (const request of requests) {
    const scopeKeys = scopeKeysByScope.get(request.location.scope) ??
      await resolveScopeKeys(options.cwd, request.location.scope);
    scopeKeysByScope.set(request.location.scope, scopeKeys);
    const nextOptions = await resolveInstallOptionsForResolvedTarget({
      mode,
      target: request.target,
      platform: request.location.platform,
      scope: request.location.scope,
      requestedSkillTrigger: request.requestedSkillTrigger,
      cwd: options.cwd,
      env,
      ledger,
      scopeKeys,
      ledgerTrust,
    });
    resolved.set(serializePluginLocation(request.location), nextOptions);
  }

  return resolved;
}

export async function createResolvedInstallOptionsResolver(
  resolvedOptionsByKey: Map<string, ResolvedInstallOptions>,
  cwd: string,
  scope: Scope,
): Promise<(platform: PlatformName, target: ResolvedPluginTarget) => ResolvedInstallOptions> {
  const scopeKeys = await resolveScopeKeys(cwd, scope);

  return (platform: PlatformName, target: ResolvedPluginTarget): ResolvedInstallOptions => {
    const scopeIdentity = getScopeIdentity(platform, scope, scopeKeys);
    const resolved = resolvedOptionsByKey.get(
      createResolvedInstallOptionsKey(platform, target.pluginName, scopeIdentity),
    );
    if (!resolved) {
      throw new Error(
        `缺少 ${platform}/${target.pluginName} (${scopeIdentity}) 的 resolved install options。`,
      );
    }

    return resolved;
  };
}

interface LoadedPluginTargetsForCommand {
  catalog: CatalogResolution;
  targets: ResolvedPluginTarget[];
}

async function loadPluginTargetsForCommandWithCatalog(
  cwd: string,
  scope: Scope,
  pluginNames?: string[],
  options: {
    catalog?: CatalogResolution;
    allowHistoricalFallback?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<LoadedPluginTargetsForCommand> {
  const env = options.env ?? process.env;
  const [catalog, embeddedRoot] = await Promise.all([
    options.catalog
      ? Promise.resolve(options.catalog)
      : resolveCurrentCatalog(env),
    resolveEmbeddedPluginsRoot(),
  ]);
  const catalogPlugins = await resolvePluginsFromCatalog(catalog.rootDir, undefined);
  const embeddedPlugins = await resolvePluginsFromCatalog(embeddedRoot, undefined);
  if (!pluginNames || pluginNames.length === 0) {
    if (catalogPlugins.length === 0) {
      throw new Error('没有发现可用插件。');
    }

    const embeddedPluginMap = new Map(
      embeddedPlugins.map((plugin) => [plugin.manifest.name, plugin]),
    );
    return {
      catalog,
      targets: catalogPlugins.map((plugin) => ({
        pluginName: plugin.manifest.name,
        plugin,
        currentPlugin: plugin,
        embeddedPlugin: embeddedPluginMap.get(plugin.manifest.name),
        source: 'currentCatalog' as const,
      })),
    };
  }

  const catalogMap = new Map(catalogPlugins.map((plugin) => [plugin.manifest.name, plugin]));
  const embeddedPluginMap = new Map(
    embeddedPlugins.map((plugin) => [plugin.manifest.name, plugin]),
  );
  const ledger = options.allowHistoricalFallback
    ? await readInstalledLedger(env)
    : undefined;
  const targets: ResolvedPluginTarget[] = [];
  for (const pluginName of pluginNames) {
    const currentPlugin = catalogMap.get(pluginName);
    if (currentPlugin) {
      targets.push({
        pluginName,
        plugin: currentPlugin,
        currentPlugin,
        embeddedPlugin: embeddedPluginMap.get(pluginName),
        source: 'currentCatalog',
      });
      continue;
    }

    if (!options.allowHistoricalFallback) {
      throw new Error(`Unknown plugin "${pluginName}".`);
    }

    targets.push(await createHistoricalPluginTarget(
      cwd,
      scope,
      pluginName,
      embeddedPluginMap.get(pluginName),
      env,
      ledger,
    ));
  }

  return {
    catalog,
    targets,
  };
}

export async function loadPluginTargetsForCommand(
  cwd: string,
  scope: Scope,
  pluginNames?: string[],
  options: {
    catalogMode?: CatalogPreparationMode;
    ensureLocalMarketplace?: boolean;
    allowHistoricalFallback?: boolean;
    env?: NodeJS.ProcessEnv;
    context?: CommandExecutionContext;
  } = {},
): Promise<ResolvedPluginTarget[]> {
  const env = options.env ?? process.env;
  const catalogMode = resolveCatalogPreparationMode(options);
  const ledger = catalogMode === 'readOnly'
    ? await readInstalledLedger(env)
    : undefined;
  const catalogState = await prepareCatalogState(catalogMode, env, ledger, options.context);

  return (await loadPluginTargetsForCommandWithCatalog(cwd, scope, pluginNames, {
    catalog: catalogState.catalog,
    allowHistoricalFallback: options.allowHistoricalFallback,
    env,
  })).targets;
}

async function tryReadBundlePluginAt(
  pluginRoot: string,
): Promise<PluginMeta | null> {
  if (!(await fs.pathExists(path.join(pluginRoot, '.agents-plugin', 'plugin.json')))) {
    return null;
  }

  try {
    return await readPluginManifest(pluginRoot, { mode: 'bundle' });
  } catch {
    return null;
  }
}

async function resolveCurrentBundlePluginForRemoval(
  pluginName: string,
  env: NodeJS.ProcessEnv,
): Promise<PluginMeta | null> {
  try {
    const catalog = await resolveCurrentCatalog(env);
    const plugin = await tryReadBundlePluginAt(path.join(catalog.rootDir, 'plugins', pluginName));
    if (plugin) {
      return plugin;
    }
  } catch {
    // Fall back to the active local bundle or historical metadata when the
    // embedded catalog is unavailable during cleanup-oriented commands.
  }

  const activeLocalBundle = await resolveActiveLocalBundle(pluginName, env);
  if (!activeLocalBundle) {
    return null;
  }

  return tryReadBundlePluginAt(activeLocalBundle);
}

async function resolveEmbeddedBundlePluginForRemoval(
  pluginName: string,
): Promise<PluginMeta | undefined> {
  try {
    return (await tryReadBundlePluginAt(
      path.join(await resolveEmbeddedPluginsRoot(), 'plugins', pluginName),
    )) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function loadPluginTargetsForRemovalCommand(
  cwd: string,
  scope: Scope,
  pluginNames?: string[],
  options: {
    allowHistoricalFallback?: boolean;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ResolvedPluginTarget[]> {
  if (!pluginNames || pluginNames.length === 0) {
    return [];
  }

  const env = options.env ?? process.env;
  const ledger = options.allowHistoricalFallback
    ? await readInstalledLedger(env)
    : undefined;

  return Promise.all(pluginNames.map(async (pluginName) => {
    const [currentPlugin, embeddedPlugin] = await Promise.all([
      resolveCurrentBundlePluginForRemoval(pluginName, env),
      resolveEmbeddedBundlePluginForRemoval(pluginName),
    ]);

    if (currentPlugin) {
      return {
        pluginName,
        plugin: currentPlugin,
        currentPlugin,
        embeddedPlugin,
        source: 'currentCatalog' as const,
      };
    }

    if (embeddedPlugin && await resolveActiveLocalBundle(pluginName, env)) {
      return {
        pluginName,
        plugin: embeddedPlugin,
        currentPlugin: embeddedPlugin,
        embeddedPlugin,
        source: 'currentCatalog' as const,
      };
    }

    if (!options.allowHistoricalFallback) {
      throw new Error(`Unknown plugin "${pluginName}".`);
    }

    return createHistoricalPluginTarget(
      cwd,
      scope,
      pluginName,
      embeddedPlugin,
      env,
      ledger,
    );
  }));
}

export function hasScopeManagedEvidence(plugin: PluginStatusReport): boolean {
  return Boolean(
    plugin.scopeManagedEvidence?.ledger ||
      plugin.scopeManagedEvidence?.tracking ||
      plugin.scopeManagedEvidence?.sharedNativeRef,
  );
}

export function getGeneratedArtifactIdentityRefusal(
  plugin: PluginStatusReport,
): string | null {
  const invalidArtifacts = plugin.generatedArtifacts.filter((artifact) =>
    generatedArtifactKindRequiresArtifactKey(artifact.kind) && !artifact.artifactKey,
  );
  if (invalidArtifacts.length === 0) {
    const unrecoverableRoleArtifacts = plugin.generatedArtifacts.filter((artifact) =>
      artifact.kind === 'agent' &&
      artifact.target === 'codex.agentRole' &&
      !artifact.roleKey &&
      !artifact.artifactKey,
    );
    if (unrecoverableRoleArtifacts.length === 0) {
      return null;
    }

    const details = unrecoverableRoleArtifacts
      .map((artifact) => `${artifact.id ?? 'codex.agentRole'} ${artifact.path}`)
      .join('；');
    return `tracking manifest 中存在无法恢复真实 roleKey 的 codex.agentRole 产物（${details}），CLI 不会编造占位 role 名；请先恢复 current catalog 或修复 tracking manifest 后重试。`;
  }

  const details = invalidArtifacts
    .map((artifact) => `${artifact.kind} ${artifact.path}`)
    .join('；');
  return `tracking manifest 中存在缺少 artifactKey 的受管产物（${details}），CLI 不能安全执行 path-only 清理；请先修复 tracking manifest 后重试。`;
}

export async function getTrackingArtifactIdentityRefusal(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: PlatformName;
  scope: Scope;
  pluginName: string;
}): Promise<string | null> {
  const trackingDir = options.platform === 'claude'
    ? resolveClaudePaths(options.cwd, options.scope, options.env).trackingDir
    : resolveCodexPaths(options.cwd, options.scope, options.env).trackingDir;

  try {
    const manifest = await readTrackingManifest(trackingDir);
    const record = getTrackingRecord(manifest, options.pluginName);
    const integrityErrors = getTrackingArtifactIntegrityErrors(record?.artifacts ?? []);
    if (integrityErrors.length === 0) {
      return null;
    }

    const details = integrityErrors
      .map((error) => `${error.kind} ${error.path}`)
      .join('；');
    return `tracking manifest 中存在缺少 artifactKey 的受管产物（${details}），CLI 不能安全执行 path-only 清理；请先修复 tracking manifest 后重试。`;
  } catch {
    return null;
  }
}

export function hasHistoricalEvidence(plugin: PluginStatusReport): boolean {
  return (
    hasScopeManagedEvidence(plugin) ||
    plugin.generatedArtifacts.length > 0 ||
    plugin.platformRuntimeEvidence?.present === true ||
    plugin.platformNativeFallbackEvidence?.present === true ||
    plugin.externalOwnership?.present === true
  );
}

function createCodexNativeRunnerRequiredError(
  action: CommandAction,
  scope: Scope,
  plugins: PluginMeta[],
): Error {
  if (canExecuteCodexProjectWithoutNative({ action, scope, plugins })) {
    return new Error('Codex project repo-managed target 不需要本机 Codex native runner，但平台解析未把它识别为可执行；请检查插件 manifest。');
  }

  const reason = scope === 'project'
    ? '当前 Codex project target 不是纯 repo-managed 可执行目标（可能包含 native-only 或 apps 能力），需要本机 Codex native runner。'
    : 'Codex user scope 需要本机 Codex native runner。';

  return new Error(
    `${reason} PATH 中没有检测到可用 \`codex\`；请安装 Codex CLI 或设置 AW_FORCE_CODEX_AVAILABLE=1 后重试。`,
  );
}

function createBothPlatformsUnavailableError(
  detection: EnvironmentDetection,
  action: CommandAction,
  scope: Scope,
  plugins: PluginMeta[],
): Error {
  if (
    !detection.codex.available &&
    !canExecuteCodexProjectWithoutNative({ action, scope, plugins })
  ) {
    return createCodexNativeRunnerRequiredError(action, scope, plugins);
  }

  return new Error('`--platform both` 只在 Codex target 和 Claude Code 都可执行时可用。');
}

export async function resolveTargetPlatforms(
  action: CommandAction,
  requestedPlatform: PlatformSelection,
  cwd: string,
  scope: Scope,
  plugins: PluginMeta[],
  _adapters: Record<PlatformName, PlatformAdapter>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PlatformName[]> {
  const detection = await detectEnvironment(cwd, env);
  const executablePlatforms = listExecutablePlatformsForTargets({
    nativeAvailablePlatforms: listDetectedPlatforms(detection),
    action,
    scope,
    plugins,
  });
  const shouldEnforceProducts = action === 'install' || action === 'upgrade';

  if (requestedPlatform === 'codex' || requestedPlatform === 'claude') {
    if (!executablePlatforms.includes(requestedPlatform)) {
      if (requestedPlatform === 'codex') {
        throw createCodexNativeRunnerRequiredError(action, scope, plugins);
      }
      throw new Error(`${requestedPlatform} 当前环境不可用。`);
    }
    if (shouldEnforceProducts) {
      assertPluginsSupportPlatforms(plugins, [requestedPlatform]);
    }
    return [requestedPlatform];
  }

  if (requestedPlatform === 'both') {
    if (executablePlatforms.length !== 2) {
      throw createBothPlatformsUnavailableError(detection, action, scope, plugins);
    }
    if (shouldEnforceProducts) {
      assertPluginsSupportPlatforms(plugins, ['codex', 'claude']);
    }
    return ['codex', 'claude'];
  }

  const exhaustive: never = requestedPlatform;
  throw new Error(`Unsupported platform "${exhaustive}". Expected one of: codex, claude, both.`);
}

export async function resolveCurrentCatalogWriteTargetPairs(
  action: 'install' | 'upgrade',
  requestedPlatform: PlatformSelection,
  cwd: string,
  scope: Scope,
  targets: Pick<ResolvedPluginTarget, 'pluginName' | 'plugin' | 'currentPlugin'>[],
  _adapters: Record<PlatformName, PlatformAdapter>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RequestedPlatformTargetPair[]> {
  const plugins = targets.map((target) => target.currentPlugin ?? target.plugin);
  const detection = await detectEnvironment(cwd, env);
  const executablePlatforms = listExecutablePlatformsForTargets({
    nativeAvailablePlatforms: listDetectedPlatforms(detection),
    action,
    scope,
    plugins,
  });

  if (requestedPlatform === 'codex' || requestedPlatform === 'claude') {
    if (!executablePlatforms.includes(requestedPlatform)) {
      if (requestedPlatform === 'codex') {
        throw createCodexNativeRunnerRequiredError(action, scope, plugins);
      }
      throw new Error(`${requestedPlatform} 当前环境不可用。`);
    }
    assertPluginsSupportPlatforms(plugins, [requestedPlatform]);
    return targets.map((target) => ({
      pluginName: target.pluginName,
      platform: requestedPlatform,
    }));
  }

  if (executablePlatforms.length === 0) {
    throw new Error(
      '当前环境没有检测到可执行平台；Codex project repo-managed target 不需要本机 Codex，Codex user/native-only target 仍需要对应 native runner。',
    );
  }

  const pairs: RequestedPlatformTargetPair[] = [];
  for (const target of targets) {
    const plugin = target.currentPlugin ?? target.plugin;
    const compatiblePlatforms = executablePlatforms.filter((platform) =>
      pluginSupportsPlatform(plugin, platform),
    );
    if (compatiblePlatforms.length === 0) {
      assertPluginsSupportPlatforms([plugin], executablePlatforms);
    }
    for (const platform of compatiblePlatforms) {
      pairs.push({
        pluginName: target.pluginName,
        platform,
      });
    }
  }

  return pairs;
}

export function formatDetectedPlatforms(detection: EnvironmentDetection): string[] {
  const lines = [chalk.bold('detected-platforms')];

  for (const platform of ['codex', 'claude'] as const) {
    const result = detection[platform];
    const scopes = result.scopes.length > 0 ? result.scopes.join(',') : '-';
    lines.push(
      `  - ${platform}: ${result.available ? 'available' : 'unavailable'} scopes=${scopes}${result.reason ? ` reason=${result.reason}` : ''}`,
    );
  }

  return lines;
}

export function collectCommandWarnings(
  _platforms: PlatformName[],
  _scope: Scope,
): string[] {
  return [];
}

export function filterPostCommandDriftWarnings(driftWarnings: string[]): {
  visible: string[];
  diagnostics: string[];
} {
  const visible = driftWarnings.filter((warning) =>
    warning.includes('untrusted') ||
    warning.includes('trust 状态未知') ||
    warning.includes('不会进入会话') ||
    warning.includes('无法进入会话') ||
    warning.includes('缺失') ||
    warning.includes('外部 marketplace'),
  );
  const visibleSet = new Set(visible);
  return {
    visible,
    diagnostics: driftWarnings.filter((warning) => !visibleSet.has(warning)),
  };
}

function formatSkillTriggerRuntime(plugin: PluginStatusReport): string {
  if (plugin.skillTriggerRuntimeState === 'unknown') {
    return 'unknown';
  }

  if (plugin.skillTriggerRuntimeState === 'mixed') {
    return 'mixed';
  }

  const matches = plugin.skillTriggerRuntimeMatches ?? [];
  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    return `matches(${matches.join(',')})`;
  }

  return 'mixed';
}

export function formatStatusReports(reports: StatusReport[]): string {
  const lines: string[] = [];
  for (const report of reports) {
    lines.push(chalk.bold(`${report.platform} (${report.scope})`));
    lines.push(`  initialized: ${report.initialized ? 'yes' : 'no'}`);
    if (report.scopeInitialized) {
      lines.push(`  scopeInitialized: ${report.scopeInitialized}`);
    }
    for (const plugin of report.plugins) {
      lines.push(`  - ${plugin.pluginName}`);
      lines.push('    native-state:');
      lines.push(
        `      marketplaceRegistered=${plugin.native.marketplaceRegistered ? 'yes' : 'no'} pluginAvailable=${plugin.native.pluginAvailable ? 'yes' : 'no'} pluginEnabled=${plugin.native.pluginEnabled === true ? 'yes' : 'no'} pluginInstalled=${plugin.native.pluginInstalled ? 'yes' : 'no'} version=${plugin.native.version ?? '-'}`,
      );
      if (plugin.native.configEntryPresent !== undefined || plugin.native.configPath) {
        lines.push(
          `      configEntryPresent=${plugin.native.configEntryPresent ? 'yes' : 'no'} configPath=${plugin.native.configPath ?? '-'}`,
        );
      }
      if (plugin.native.cacheStatus || plugin.native.cacheRootPath || plugin.native.activeCachePath) {
        lines.push(
          `      cacheStatus=${plugin.native.cacheStatus ?? '-'} cacheRootPath=${plugin.native.cacheRootPath ?? '-'} activeCachePath=${plugin.native.activeCachePath ?? '-'} activeCacheVersion=${plugin.native.activeCacheVersion ?? '-'}`,
        );
      }
      if (plugin.native.recovery) {
        lines.push(
          `      recoveryPresent=${plugin.native.recovery.present ? 'yes' : 'no'} state=${plugin.native.recovery.state ?? '-'} evidenceMatches=${plugin.native.recovery.evidenceMatches === null ? '-' : plugin.native.recovery.evidenceMatches ? 'yes' : 'no'}`,
        );
        if (plugin.native.recovery.reason) {
          lines.push(`      recoveryReason=${plugin.native.recovery.reason}`);
        }
        if (plugin.native.recovery.suggestion) {
          lines.push(`      recoverySuggestion=${plugin.native.recovery.suggestion}`);
        }
      }
      if (plugin.native.marketplaceSource) {
        lines.push(`      marketplaceSource=${plugin.native.marketplaceSource}`);
      }
      if (plugin.native.marketplaceSourceType) {
        lines.push(`      marketplaceSourceType=${plugin.native.marketplaceSourceType}`);
      }
      if (plugin.native.marketplaceRootResolution) {
        lines.push(`      marketplaceRootResolution=${plugin.native.marketplaceRootResolution}`);
      }
      if (plugin.native.details) {
        lines.push(`      details=${plugin.native.details}`);
      }
      if (plugin.native.declaredSource) {
        lines.push(`      declaredSource=${plugin.native.declaredSource}`);
      }
      if (plugin.native.materializedInstallLocation) {
        lines.push(`      materializedInstallLocation=${plugin.native.materializedInstallLocation}`);
      }
      if (plugin.native.activeLocalBundlePath) {
        lines.push(`      activeLocalBundlePath=${plugin.native.activeLocalBundlePath}`);
      }
      if (plugin.externalOwnership?.checkState === 'unknown') {
        lines.push(
          `      externalOwnership=unknown${plugin.externalOwnership.details ? ` (${plugin.externalOwnership.details})` : ''}`,
        );
      } else if (plugin.externalOwnership?.present) {
        lines.push(
          `      externalOwnership=${plugin.externalOwnership.marketplace ?? '-'}${plugin.externalOwnership.details ? ` (${plugin.externalOwnership.details})` : ''}`,
        );
      }
      if (plugin.platformRuntimeEvidence?.present || plugin.platformRuntimeEvidence?.details) {
        lines.push(
          `      runtimeEvidence=${plugin.platformRuntimeEvidence.present ? 'yes' : 'no'}${plugin.platformRuntimeEvidence.details ? ` (${plugin.platformRuntimeEvidence.details})` : ''}`,
        );
      }
      if (plugin.platformNativeFallbackEvidence?.present || plugin.platformNativeFallbackEvidence?.details) {
        lines.push(
          `      nativeFallbackEvidence=${plugin.platformNativeFallbackEvidence.present ? 'yes' : 'no'}${plugin.platformNativeFallbackEvidence.details ? ` (${plugin.platformNativeFallbackEvidence.details})` : ''}`,
        );
      }

      lines.push('    initialization:');
      lines.push(`      scopeInitialized=${plugin.scopeInitialized ?? '-'}`);
      if (plugin.projectManagedKinds) {
        lines.push(`      projectManagedKinds=${plugin.projectManagedKinds.join(',') || '-'}`);
      }
      if (plugin.ledgerStateStatus) {
        lines.push(
          `      ledgerState=${plugin.ledgerStateStatus}${plugin.ledgerStateReason ? ` (${plugin.ledgerStateReason})` : ''}`,
        );
      }
      if (plugin.catalogCompatibility) {
        lines.push(`      catalogCompatibility=${plugin.catalogCompatibility}`);
      }
      if (plugin.scopeManagedEvidence) {
        lines.push(
          `      managedEvidence=ledger:${plugin.scopeManagedEvidence.ledger ? 'yes' : 'no'},tracking:${plugin.scopeManagedEvidence.tracking ? 'yes' : 'no'},sharedNativeRef:${plugin.scopeManagedEvidence.sharedNativeRef ? 'yes' : 'no'}`,
        );
      }
      if (plugin.skillTriggerApplicability) {
        lines.push(`      skillTriggerApplicability=${plugin.skillTriggerApplicability}`);
      }
      if (plugin.skillTriggerPreference) {
        lines.push(`      skillTriggerLedger=${plugin.skillTriggerPreference}`);
      }
      if (plugin.skillTriggerRuntimeState) {
        lines.push(`      skillTriggerRuntime=${formatSkillTriggerRuntime(plugin)}`);
      }
      if (plugin.skillTriggerDrift) {
        lines.push(`      skillTriggerDrift=${plugin.skillTriggerDrift}`);
      }
      if (plugin.currentCatalog) {
        lines.push(
          `      currentCatalog=source:${plugin.currentCatalog.source},available:${plugin.currentCatalog.available ? 'yes' : 'no'},root:${plugin.currentCatalog.rootDir}${plugin.currentCatalog.reason ? `,reason:${plugin.currentCatalog.reason}` : ''}`,
        );
      }
      if (plugin.activeLocalBundle) {
        lines.push(`      activeLocalBundle=${plugin.activeLocalBundle}`);
      }

      lines.push('    generated-artifacts:');
      if (plugin.artifactsInitialized !== undefined) {
        lines.push(`      artifactsInitialized=${plugin.artifactsInitialized ? 'yes' : 'no'}`);
      }
      if (plugin.generatedArtifacts.length === 0) {
        lines.push('      none');
      } else {
        for (const artifact of plugin.generatedArtifacts) {
          lines.push(
            `      ${artifact.kind}=${artifact.exists ? 'present' : 'missing'} path=${artifact.path}${artifact.artifactKey ? ` artifactKey=${artifact.artifactKey}` : ''}`,
          );
        }
      }
      if (plugin.managedArtifacts?.length) {
        lines.push('    managed-artifacts:');
        for (const artifact of plugin.managedArtifacts) {
          lines.push(
            `      target=${artifact.target ?? '-'} id=${artifact.id ?? '-'} health=${artifact.health} visibility=${artifact.sessionVisibility} state=${artifact.state ?? '-'} kind=${artifact.kind} path=${artifact.path}${artifact.roleKey ? ` roleKey=${artifact.roleKey}` : ''}${artifact.artifactKey ? ` artifactKey=${artifact.artifactKey}` : ''}${artifact.configDigest ? ` configDigest=${artifact.configDigest}` : ''}${artifact.currentConfigDigest ? ` currentConfigDigest=${artifact.currentConfigDigest}` : ''}${artifact.contentDigest ? ` contentDigest=${artifact.contentDigest}` : ''}${artifact.currentContentDigest ? ` currentContentDigest=${artifact.currentContentDigest}` : ''}${artifact.diagnostics.length > 0 ? ` diagnostics=${artifact.diagnostics.join(' | ')}` : ''}`,
          );
        }
      }

      lines.push('    session-state:');
      if (plugin.projectTrust) {
        lines.push(`      projectTrust=${plugin.projectTrust}`);
      }
      if (plugin.repoManagedSessionState) {
        lines.push(
          `      instructions=${plugin.repoManagedSessionState.instructions} rules=${plugin.repoManagedSessionState.rules} hooks=${plugin.repoManagedSessionState.hooks} agents=${plugin.repoManagedSessionState.agents}`,
        );
        if (plugin.repoManagedSessionState.skills) {
          lines.push(
            `      skills=${plugin.repoManagedSessionState.skills.state} total=${plugin.repoManagedSessionState.skills.totalCount} visible=${plugin.repoManagedSessionState.skills.visibleCount} missing=${plugin.repoManagedSessionState.skills.missingCount} drifted=${plugin.repoManagedSessionState.skills.driftedCount} orphan=${plugin.repoManagedSessionState.skills.orphanCount} blocked=${plugin.repoManagedSessionState.skills.blockedCount} trustUnknown=${plugin.repoManagedSessionState.skills.projectTrustUnknownCount} unknown=${plugin.repoManagedSessionState.skills.unknownCount} absent=${plugin.repoManagedSessionState.skills.absentCount}`,
          );
        }
        if (plugin.repoManagedSessionState.mcpServers) {
          lines.push(
            `      mcpServers=${plugin.repoManagedSessionState.mcpServers.state} total=${plugin.repoManagedSessionState.mcpServers.totalCount} visible=${plugin.repoManagedSessionState.mcpServers.visibleCount} missing=${plugin.repoManagedSessionState.mcpServers.missingCount} drifted=${plugin.repoManagedSessionState.mcpServers.driftedCount} orphan=${plugin.repoManagedSessionState.mcpServers.orphanCount} blocked=${plugin.repoManagedSessionState.mcpServers.blockedCount} trustUnknown=${plugin.repoManagedSessionState.mcpServers.projectTrustUnknownCount} unknown=${plugin.repoManagedSessionState.mcpServers.unknownCount} absent=${plugin.repoManagedSessionState.mcpServers.absentCount}`,
          );
        }
        if (plugin.repoManagedSessionState.items?.length) {
          for (const item of plugin.repoManagedSessionState.items) {
            lines.push(
              `      item kind=${item.kind} state=${item.state} drift=${item.drift} tracked=${item.tracked ? 'yes' : 'no'} exists=${item.exists ? 'yes' : 'no'} path=${item.path}${item.artifactKey ? ` artifactKey=${item.artifactKey}` : ''}${item.diagnostics.length > 0 ? ` diagnostics=${item.diagnostics.join(' | ')}` : ''}`,
            );
          }
        }
      } else {
        lines.push('      not_applicable');
      }

      if (plugin.driftWarnings.length === 0) {
        lines.push('    drift: none');
      } else {
        for (const warning of plugin.driftWarnings) {
          lines.push(`    drift: ${warning}`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function formatStatusOutput(
  detection: EnvironmentDetection,
  reports: StatusReport[],
): string {
  return [...formatDetectedPlatforms(detection), '', formatStatusReports(reports)]
    .join('\n')
    .trimEnd();
}
