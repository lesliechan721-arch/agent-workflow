import path from 'node:path';

import fs from 'fs-extra';

import { generateAgentArtifacts } from '../generators/agents.js';
import {
  extractCodexHookGroups,
} from '../generators/hooks.js';
import { renderCodexManagedInstructionBlock } from '../generators/instructions.js';
import { generateCodexPermissionArtifacts } from '../generators/permissions.js';
import { buildGeneratedName } from '../generators/shared.js';
import type {
  CommandEvent,
  NativeMarketplaceEventData,
  NativePostCheckEventData,
  NativeRecoveryEventData,
  NativeRpcEventData,
} from '../output/model.js';
import type {
  CatalogCompatibility,
  CatalogResolution,
  CodexNativeCacheStatus,
  CodexCapabilitySnapshot,
  CodexSkillArtifact,
  CodexProjectManagedKind,
  CodexSharedHookGroup,
  CodexSharedNativeRefs,
  GeneratedArtifact,
  GeneratedArtifactStatus,
  InstalledLedger,
  InstalledScopeRecord,
  ManagedArtifactStatus,
  MarketplaceRootResolution,
  MarketplaceSourceStatus,
  NativeRecoveryState,
  NativeRecoveryStatus,
  PlatformAdapter,
  PluginArtifactTargetDefinition,
  PluginMeta,
  PluginStatusReport,
  ProjectTrust,
  RepoManagedProjectItemReport,
  RepoManagedProjectItemState,
  RepoManagedProjectKindSummary,
  Scope,
  ScopeInitializedState,
  StatusReport,
  TrackedHookGroupIdentity,
  TrackingManifest,
  TrackingPluginRecord,
} from '../types.js';
import {
  type CodexProjectLayerEvidence,
  detectCodexProjectLayerEvidence,
  detectCodexSessionState,
  detectEnvironment,
  resolveCodexProjectTrust,
} from '../utils/detect.js';
import {
  applyCodexConfigTransactionFile,
  type CodexAgentRegistrationConfig,
  type CodexManagedInstructionBlock,
  type CodexMcpServerConfig,
  type CodexConfigSnapshot,
  composeManagedDeveloperInstructionsBlock,
  readCodexConfigFile,
  readRenderedCodexMcpServersFile,
  resolveCodexMcpServerStatusSignal,
} from '../utils/codex-config.js';
import {
  type CodexAppServerProcessRunner,
} from '../utils/codex-app-server-client.js';
import {
  checkCodexNativeInstallPostCheck,
  checkCodexNativeUninstallPostCheck,
  getCodexNativePluginInstallRootPath,
  hasCodexNativeCacheEvidence,
  hasCodexNativeStateEvidence,
  listCodexNativeEvidence,
  readCodexNativePluginState,
} from '../utils/codex-native-state.js';
import {
  deleteCodexNativeRecoveryBreadcrumb,
  listCodexNativeRecoveryBreadcrumbs,
  readCodexNativeRecoveryBreadcrumb,
  updateCodexNativeRecoveryBreadcrumb,
  writeCodexNativeRecoveryBreadcrumb,
} from '../utils/codex-native-recovery.js';
import {
  collectCodexDynamicSkillSyncKeys,
  ensureLocalMarketplace,
  getLocalMarketplaceCodexSkillRoot,
  materializeStagedMarketplaceCodexDynamicSkills,
  readInstalledLedger,
  resolveCodexProjectScopeInitialized,
  resolveScopeInitialized,
  syncLocalMarketplaceCodexDynamicSkills,
} from '../utils/local-marketplace.js';
import {
  resolveArtifactRenderConfig,
  runArtifactRenderer,
} from '../utils/artifact-renderer.js';
import {
  createArtifactConfigDigest,
  type ValidatedArtifactPlanArtifact,
  validateArtifactPlan,
} from '../utils/artifact-plan.js';
import {
  diagnoseCodexRoleVisibility,
  getCodexRoleDescriptionMismatch,
  planCodexManagedRoleRemoval,
  resolveCodexRoleNamespace,
} from '../utils/codex-roles.js';
import { writeJsonFile } from '../utils/json.js';
import { readPluginManifest, resolvePluginsFromCatalog } from '../utils/manifest.js';
import { readMarketplaceManifestAtPath } from '../utils/marketplace.js';
import {
  resolveActiveLocalBundle,
  resolveCatalogPlugins,
  resolveCurrentCatalog,
} from '../utils/plugin-catalog.js';
import {
  resolveAwHome,
  resolveAwHomeCanonical,
  resolveCodexPaths,
  resolveCodexProjectKey,
  resolveEmbeddedPluginsRoot,
  resolveRepoRoot,
  getMarketplaceManifestPath,
} from '../utils/paths.js';
import {
  validateRenderedCodexRules,
  validateCodexSharedHooksContent,
} from '../utils/rendered-contract.js';
import {
  attachGeneratedArtifactsToError,
  createGeneratedArtifactContentDigest,
  getGeneratedArtifactIdentityKey,
  hasSameGeneratedArtifactDesiredIdentity,
  mergeGeneratedArtifacts,
} from '../utils/generated-artifacts.js';
import {
  getTrackingArtifactIntegrityErrors,
  getTrackingRecord,
  readTrackingManifest,
} from '../utils/tracking.js';
import {
  createCodexSkillExpectedTree,
  createCodexSkillStagingTreeContentDigest,
  type CodexSkillStagingTree,
} from '../utils/codex-skill-staging.js';
import {
  readDynamicSkillTree,
  validateSkillDirectoriesRoot,
  writeDynamicSkillTree,
} from '../utils/dynamic-skill-tree.js';
import { assertCanonicalTrackedCodexArtifactMainPaths } from '../utils/codex-artifact-paths.js';
import {
  parseCodexSharedHooksFile,
  planCodexSharedHooksUpdate,
  renderTrackedHookGroupIdentity,
  resolvePlatformHookDefinitions,
  trackedHookGroupsContainAll,
} from '../utils/hooks-contract.js';
import { resolvePlatformEntries } from '../utils/platform-entries.js';
import {
  CODEX_REPO_MANAGED_ITEM_KIND_ORDER,
  codexCapabilitySnapshotsEqual,
  collectDeclaredCodexProjectSkillKeys,
  getCodexDynamicArtifactTargets,
  getCodexProjectManagedKinds,
  hasCodexProjectManagedArtifacts,
  needsCodexProjectConfigAccess,
  normalizeCodexCapabilitySnapshot,
  requiresCodexNativePlugin,
} from '../utils/codex-project-surface.js';
import {
  buildCodexMarketplaceAddInvocation,
  buildCodexMarketplaceListInvocation,
  buildCodexMarketplaceRemoveInvocation,
  buildCodexPluginAddInvocation,
  buildCodexPluginListInvocation,
  buildCodexPluginRemoveInvocation,
  NativeCliError,
  type NativeCliRunner,
  runNativeCliChecked,
} from '../utils/native-cli.js';
import {
  calculateFileDigest,
  resolveBundledPluginFilePath,
} from '../utils/plugin-scripts.js';
import {
  readInstallRecordForLocation,
  readProjectArtifactIdentityForLocator,
} from '../install-state/facade.js';
import {
  createProjectArtifactSharedLocator,
  resolveProjectArtifactProjectRoot,
  resolveProjectScopeRepoRoot,
} from '../install-state/paths.js';
import { detectCodexExternalOwnership } from './helpers.js';
import {
  preflightCodexProjectStatusProjectConfig,
} from '../commands/codex-project-safety.js';

export { buildCodexMarketplaceAddInvocation };

export {
  getCodexProjectManagedKinds,
  hasCodexProjectManagedArtifacts,
  hasRepoManagedArtifacts,
  requiresCodexNativePlugin,
} from '../utils/codex-project-surface.js';

const MARKETPLACE_NAME = 'aw';
const NOOP_COMMAND_EVENT_SINK = () => undefined;

type CommandEventSink = (event: CommandEvent) => void | Promise<void>;
type NativeMarketplaceOperation = NativeMarketplaceEventData['operation'];
type NativeRpcMethod = NativeRpcEventData['method'];
type NativeRecoveryOperation = NativeRecoveryEventData['operation'];
type NativePostCheckOperation = NativePostCheckEventData['operation'];

function normalizeCodexMarketplaceSource(value: string | undefined): string | undefined {
  return value ? path.normalize(value) : undefined;
}

function isCodexMarketplaceRegistered(
  marketplace: CodexConfigSnapshot['marketplaces'][string] | undefined,
  awHome: string,
): boolean {
  return (
    marketplace?.sourceType === 'local' &&
    normalizeCodexMarketplaceSource(marketplace.source) === normalizeCodexMarketplaceSource(awHome) &&
    marketplace.sourcePointsToManifest !== true
  );
}

interface CodexMarketplaceHealth {
  registered: boolean;
  source?: string;
  sourceType: MarketplaceSourceStatus;
  rootResolution: MarketplaceRootResolution;
  warning?: string;
}

function normalizeCodexMarketplaceSourceType(
  marketplace: CodexConfigSnapshot['marketplaces'][string] | undefined,
): MarketplaceSourceStatus {
  if (!marketplace?.sourceType) {
    return 'missing';
  }

  return marketplace.sourceType === 'local' ? 'local' : 'invalid';
}

function resolveCodexMarketplaceRootResolution(
  marketplace: CodexConfigSnapshot['marketplaces'][string] | undefined,
  awHome: string,
  sourceType: MarketplaceSourceStatus,
): MarketplaceRootResolution {
  if (!marketplace?.source) {
    return 'missing';
  }
  if (marketplace.sourcePointsToManifest) {
    return 'unknown';
  }
  if (sourceType !== 'local') {
    return 'installedCopy';
  }
  return normalizeCodexMarketplaceSource(marketplace.source) === normalizeCodexMarketplaceSource(awHome)
    ? 'localSource'
    : 'unknown';
}

function describeCodexMarketplaceWarning(
  marketplace: CodexConfigSnapshot['marketplaces'][string] | undefined,
  awHome: string,
  sourceType: MarketplaceSourceStatus,
): string | undefined {
  if (!marketplace?.source) {
    return 'Codex marketplace aw 未注册，无法加载 AW 原生插件。';
  }
  if (marketplace.sourcePointsToManifest) {
    return `Codex marketplace source 指向旧 manifest 文件 ${marketplace.source}，需要重新注册本地 marketplace 根目录。`;
  }
  if (sourceType === 'missing') {
    return 'Codex marketplace aw 缺少 source_type="local"，Codex 会按安装副本解析而不是当前 AW_HOME。';
  }
  if (sourceType === 'invalid') {
    return `Codex marketplace aw 的 source_type=${marketplace.sourceType ?? 'missing'} 不受 AW 支持，应为 "local"。`;
  }
  if (normalizeCodexMarketplaceSource(marketplace.source) !== normalizeCodexMarketplaceSource(awHome)) {
    return `Codex marketplace source 指向 ${marketplace.source}，未指向当前 AW_HOME ${awHome}。`;
  }

  return undefined;
}

function resolveCodexMarketplaceHealth(
  marketplace: CodexConfigSnapshot['marketplaces'][string] | undefined,
  awHome: string,
): CodexMarketplaceHealth {
  const sourceType = normalizeCodexMarketplaceSourceType(marketplace);
  const rootResolution = resolveCodexMarketplaceRootResolution(marketplace, awHome, sourceType);
  const registered = sourceType === 'local' && rootResolution === 'localSource';
  return {
    registered,
    source: marketplace?.source,
    sourceType,
    rootResolution,
    warning: registered
      ? undefined
      : describeCodexMarketplaceWarning(marketplace, awHome, sourceType),
  };
}

function summarizeNativeCliOutput(error: NativeCliError): string {
  const detail = error.stderr.trim() || error.stdout.trim();
  return detail || `exit code ${error.exitCode}`;
}

function createCodexMarketplaceSuggestion(
  awHome: string,
  error?: unknown,
): string {
  if (error === undefined) {
    return `请确认 [marketplaces.aw] 指向 ${awHome}，必要时手动运行 \`codex plugin marketplace add ${awHome}\` 后重试。`;
  }

  return `请确认可以运行 \`codex plugin marketplace add ${awHome}\`。${nativeCliFailureHint(error)}`;
}

async function resolveCodexUserDynamicSkillSyncKeys(options: {
  cwd: string;
  plugin: PluginMeta;
  env: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const recordRead = await readInstallRecordForLocation({
    cwd: options.cwd,
    location: {
      plugin: options.plugin.manifest.name,
      platform: 'codex',
      scope: 'user',
    },
    env: options.env,
  });

  return collectCodexDynamicSkillSyncKeys({
    skillKeys: getCodexDynamicArtifactTargets(options.plugin, { scope: 'user' })
      .filter((target) => target.target === 'codex.skill')
      .map((target) => target.skillKey?.trim())
      .filter((skillKey): skillKey is string => Boolean(skillKey)),
    installedArtifacts: recordRead.status === 'ok'
      ? recordRead.value.record.artifacts
      : [],
  });
}

function createCodexNativePostCheckSuggestion(
  operation: 'install' | 'uninstall',
): string {
  return operation === 'install'
    ? 'Codex native side effect 已发生，但 AW 安装尚未完成；请运行 `aw status --verbose` 查看 breadcrumb、config 和 cache 诊断。'
    : 'Codex native side effect 已发生，但 AW 卸载校验未通过；请运行 `aw status --verbose` 查看当前残留。';
}

function createCodexRecoverySuggestion(
  operation: NativeRecoveryOperation,
  state: NativeRecoveryState,
  recoveryBreadcrumbPersisted: boolean,
): string {
  if (operation === 'write' && !recoveryBreadcrumbPersisted) {
    return 'Codex native side effect 已发生，但 AW 没有持久化恢复证据；当前不能承诺后续 cleanup / uninstall 一定具备自动授权。';
  }

  if (operation === 'delete') {
    return '原生状态已处理，但 AW 还需要清理 recovery breadcrumb；请运行 `aw status --verbose` 继续确认。';
  }

  if (state === 'cleanup_failed') {
    return 'Codex native side effect 已发生，但 recovery 记录还需要保留；请运行 `aw status --verbose` 查看当前诊断。';
  }

  return 'Codex native side effect 已发生，但 AW 仍需依赖 recovery breadcrumb 跟踪后续修复。';
}

function nativeCliFailureHint(error: unknown): string {
  if (!(error instanceof NativeCliError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const cause = error.cause as { code?: string; message?: string } | undefined;
  if (cause?.code === 'ENOENT') {
    return '找不到 `codex` 可执行文件，请确认 Codex CLI 已安装，并且当前 PATH 可以访问它。';
  }

  if (error.exitCode === 124) {
    return 'Codex 原生命令执行超时，请稍后重试；如果仍失败，请先手动运行 `codex plugin marketplace add <AW_HOME>` 查看原因。';
  }

  return summarizeNativeCliOutput(error);
}

function createCodexMarketplaceVerificationError(
  awHome: string,
  configPath: string,
): Error {
  return new Error(
    `Codex 原生命令已执行，但 ${configPath} 中的 [marketplaces.aw] 没有指向 ${awHome}（source_type 应为 "local"）。请手动运行 \`codex plugin marketplace add ${awHome}\` 后重试。`,
  );
}

type CodexNativeCliReasonCode =
  | 'codexNativeCliUnavailable'
  | 'codexNativeMarketplaceMissing'
  | 'codexNativeMarketplaceDrift';

class CodexNativeCliLifecycleError extends Error {
  readonly reasonCode: CodexNativeCliReasonCode;

  constructor(reasonCode: CodexNativeCliReasonCode, message: string) {
    super(message);
    this.name = 'CodexNativeCliLifecycleError';
    this.reasonCode = reasonCode;
  }
}

function getCodexMarketplaceVerificationReason(
  marketplace: CodexConfigSnapshot['marketplaces'][string] | undefined,
  awHome: string,
): CodexNativeCliReasonCode {
  if (!marketplace?.source) {
    return 'codexNativeMarketplaceMissing';
  }
  return isCodexMarketplaceRegistered(marketplace, awHome)
    ? 'codexNativeMarketplaceMissing'
    : 'codexNativeMarketplaceDrift';
}

function createCodexPluginCliError(
  operation: 'install' | 'uninstall' | 'list',
  pluginId: string,
  error: unknown,
): CodexNativeCliLifecycleError {
  const command = operation === 'install'
    ? `codex plugin add ${pluginId}`
    : operation === 'uninstall'
      ? `codex plugin remove ${pluginId}`
      : 'codex plugin list';
  return new CodexNativeCliLifecycleError(
    'codexNativeCliUnavailable',
    `无法通过 Codex CLI 执行 \`${command}\`：${nativeCliFailureHint(error)}`,
  );
}

function createCodexMarketplaceCliError(
  operation: 'add' | 'list' | 'remove',
  marketplacePath: string,
  error: unknown,
): CodexNativeCliLifecycleError {
  const command = operation === 'add'
    ? `codex plugin marketplace add ${marketplacePath}`
    : operation === 'remove'
      ? `codex plugin marketplace remove ${MARKETPLACE_NAME}`
      : 'codex plugin marketplace list';
  return new CodexNativeCliLifecycleError(
    'codexNativeCliUnavailable',
    `无法通过 Codex CLI 执行 \`${command}\`：${nativeCliFailureHint(error)}`,
  );
}

function normalizeCodexUserPluginId(pluginNameOrId: string): `${string}@aw` {
  const normalized = pluginNameOrId.endsWith(`@${MARKETPLACE_NAME}`)
    ? pluginNameOrId
    : `${pluginNameOrId}@${MARKETPLACE_NAME}`;
  if (
    normalized.trim() === '' ||
    normalized.includes('/') ||
    normalized.includes('\\')
  ) {
    throw new Error(`Invalid Codex plugin id: "${pluginNameOrId}".`);
  }
  return normalized as `${string}@aw`;
}

function codexPluginNameFromId(pluginId: `${string}@aw`): string {
  return pluginId.slice(0, -(`@${MARKETPLACE_NAME}`.length));
}

function describeCodexNativeInstallPostCheckFailure(
  state: Awaited<ReturnType<typeof checkCodexNativeInstallPostCheck>>['state'],
): string {
  if (!state.pluginEnabled && !state.pluginInstalled) {
    return `enabled config 与 native cache 都缺失（config: ${state.configPath}，cache: ${state.cacheRootPath}）。`;
  }
  if (!state.pluginEnabled) {
    return `缺少 enabled config entry（${state.configPath}），但 cache 状态为 ${state.cacheStatus}${state.activeCachePath ? `（${state.activeCachePath}）` : ''}。`;
  }
  return `缺少可用 native cache（cache 状态：${state.cacheStatus}，目录：${state.cacheRootPath}）。`;
}

function formatCodexNativeCacheResidue(
  state: Awaited<ReturnType<typeof checkCodexNativeUninstallPostCheck>>['state'],
): string {
  if (state.cacheStatus === 'active') {
    return `目标 native cache 仍然存在（active cache: ${state.activeCachePath ?? state.cacheRootPath}）。`;
  }

  if (state.cacheStatus === 'ambiguous') {
    return `目标 native cache 状态 ambiguous，cache root 下存在多个有效版本（${
      state.validCachePaths.join('，') || state.cacheRootPath
    }）。`;
  }

  if (state.cacheStatus === 'invalid') {
    const residues = [...state.invalidCachePaths, ...state.ignoredCacheEntries];
    return `目标 native cache 状态 invalid，cache root 下存在无效目录或非目录条目（${
      residues.join('，') || state.cacheRootPath
    }）。`;
  }

  return `目标 native cache 仍然存在（${state.cacheRootPath}）。`;
}

function describeCodexNativeUninstallPostCheckFailure(
  state: Awaited<ReturnType<typeof checkCodexNativeUninstallPostCheck>>['state'],
): string {
  const residues: string[] = [];
  if (state.configEntryPresent) {
    residues.push(`目标 config entry 仍然存在（${state.configPath}）。`);
  }
  if (state.installedManifestPresent) {
    residues.push(`native installed manifest 仍然存在（${state.installedManifestPath}）。`);
  }
  if (hasCodexNativeCacheEvidence(state)) {
    residues.push(formatCodexNativeCacheResidue(state));
  }
  return residues.join('；');
}

function hasCodexSharedNativeRefs(
  ledger: InstalledLedger,
  pluginName?: string,
  nextRefs?: CodexSharedNativeRefs,
): boolean {
  return Object.entries(ledger.plugins).some(([name, record]) => {
    const snapshot = normalizeCodexCapabilitySnapshot(record.platforms.codex?.userScope?.capabilitySnapshot);
    if (!snapshot.requiresNativePlugin) {
      return false;
    }
    const refs = name === pluginName && nextRefs
      ? nextRefs
      : normalizeSharedNativeRefs(record.platforms.codex?.sharedNativeRefs);
    return refs.user || refs.projects.length > 0;
  });
}

async function assessCodexMarketplaceCleanupForAdapter(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  ledger: InstalledLedger;
  pluginName?: string;
  nextRefs?: CodexSharedNativeRefs;
}): Promise<{ marketplaceConfigPresent: boolean; canCleanup: boolean }> {
  const configPath = resolveCodexPaths(options.cwd, 'user', options.env).configTomlPath;
  const config = await readCodexConfigFile(configPath);
  const hasSharedRefs = hasCodexSharedNativeRefs(options.ledger, options.pluginName, options.nextRefs);
  const [breadcrumbs, nativeEvidence] = await Promise.all([
    listCodexNativeRecoveryBreadcrumbs(options.env),
    listCodexNativeEvidence(options.env),
  ]);

  return {
    marketplaceConfigPresent: config.snapshot.marketplaces[MARKETPLACE_NAME] !== undefined,
    canCleanup: !hasSharedRefs && breadcrumbs.length === 0 && nativeEvidence.length === 0,
  };
}

function createEmptyCodexConfigSnapshot(): CodexConfigSnapshot {
  return {
    marketplaces: {},
    plugins: {},
    projects: {},
    agents: {},
    mcpServers: {},
    developerInstructions: {
      defined: false,
      managedBlocks: {},
    },
  };
}

function createEmptyCodexProjectLayerEvidence(): CodexProjectLayerEvidence {
  return {
    currentLayerDeveloperInstructionsDefined: false,
    ancestorDeveloperInstructionsDefined: false,
    projectLayerDeveloperInstructionsDefined: false,
    higherPriorityRulesPresent: false,
    higherPriorityHooksPresent: false,
    higherPriorityAgentRoleNames: [],
    hasProjectLayerArtifacts: false,
  };
}

export function requiresNativePlugin(plugin: PluginMeta): boolean {
  return requiresCodexNativePlugin(plugin, 'user');
}

export function resolveCodexCatalogCompatibility(options: {
  currentManifestPresent: boolean;
  currentScopeManagedEvidence: boolean;
  platformNativeFallbackEvidence: boolean;
  currentCapabilities: CodexCapabilitySnapshot;
  installedCapabilitySnapshot?: CodexCapabilitySnapshot;
}): CatalogCompatibility | undefined {
  if (!options.currentManifestPresent) {
    return options.currentScopeManagedEvidence || options.platformNativeFallbackEvidence
      ? 'missing'
      : undefined;
  }

  if (!options.currentScopeManagedEvidence || !options.installedCapabilitySnapshot) {
    return undefined;
  }

  return codexCapabilitySnapshotsEqual(options.installedCapabilitySnapshot, options.currentCapabilities)
    ? 'current'
    : 'capabilityChanged';
}

async function writeTextArtifact(
  baseDir: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const targetPath = path.join(baseDir, relativePath);
  await fs.ensureDir(path.dirname(targetPath));
  await fs.writeFile(targetPath, content, 'utf8');
  return targetPath;
}

function renderCodexRoleTomlString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('\n')) {
    const escaped = trimmed
      .replace(/\\/g, '\\\\')
      .replace(/"""/g, '\\"\\"\\"');
    return `"""\n${escaped}\n"""`;
  }

  return JSON.stringify(trimmed);
}

function normalizeCodexRelativePath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function getManagedCodexRoleLayerPath(
  configDir: string,
  pluginName: string,
  roleKey: string,
): string {
  return path.join(configDir, 'agents', `${buildGeneratedName(pluginName, roleKey)}.toml`);
}

function renderManagedCodexRoleFile(options: {
  roleKey: string;
  description: string;
  developerInstructions: string;
  model?: string;
  modelReasoningEffort?: string;
}): string {
  return [
    `name = ${renderCodexRoleTomlString(options.roleKey)}`,
    `description = ${renderCodexRoleTomlString(options.description)}`,
    `developer_instructions = ${renderCodexRoleTomlString(options.developerInstructions)}`,
    ...(options.model ? [`model = ${renderCodexRoleTomlString(options.model)}`] : []),
    ...(options.modelReasoningEffort
      ? [`model_reasoning_effort = ${renderCodexRoleTomlString(options.modelReasoningEffort)}`]
      : []),
    '',
  ].join('\n');
}

function buildGeneratedArtifactPaths(...artifactPaths: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();

  for (const artifactPath of artifactPaths) {
    const normalizedPath = path.normalize(artifactPath);
    if (seen.has(normalizedPath)) {
      continue;
    }
    seen.add(normalizedPath);
    output.push(artifactPath);
  }

  return output;
}

function getRepoSkillsRoot(repoRoot: string): string {
  return path.join(repoRoot, '.agents', 'skills');
}

function getRepoSkillPath(repoRoot: string, skillName: string): string {
  return path.join(getRepoSkillsRoot(repoRoot), skillName);
}

function readTrackedCodexSkillArtifacts(
  record: TrackingPluginRecord | undefined,
): GeneratedArtifact[] {
  return (record?.artifacts ?? []).filter((artifact) => artifact.kind === 'skill');
}

function trackedCodexSkillKeys(
  record: TrackingPluginRecord | undefined,
): string[] {
  return readTrackedCodexSkillArtifacts(record)
    .map((artifact) => artifact.artifactKey)
    .filter((artifactKey): artifactKey is string => Boolean(artifactKey))
    .sort();
}

function findTrackedCodexSkillArtifact(
  record: TrackingPluginRecord | undefined,
  skillName: string,
): GeneratedArtifact | undefined {
  return readTrackedCodexSkillArtifacts(record).find((artifact) => artifact.artifactKey === skillName);
}

async function collectCodexSkillTreeFileContents(
  rootDir: string,
): Promise<Record<string, Buffer>> {
  return (await readDynamicSkillTree(rootDir, 'codex.skill'))?.files ?? {};
}

function compareCodexSkillTrees(options: {
  expectedFiles: Record<string, Buffer>;
  actualFiles: Record<string, Buffer>;
}): { drifted: boolean; reason?: string } {
  const allPaths = [...new Set([
    ...Object.keys(options.expectedFiles),
    ...Object.keys(options.actualFiles),
  ])].sort();

  for (const relativePath of allPaths) {
    const expected = options.expectedFiles[relativePath];
    const actual = options.actualFiles[relativePath];
    if (expected === undefined) {
      return { drifted: true, reason: `存在未受管文件 ${relativePath}` };
    }
    if (actual === undefined) {
      return { drifted: true, reason: `缺少文件 ${relativePath}` };
    }
    if (!actual.equals(expected)) {
      return { drifted: true, reason: `文件内容已漂移 ${relativePath}` };
    }
  }

  return { drifted: false };
}

async function compareCodexRepoSkillToPristine(options: {
  embeddedRoot: string;
  pluginName: string;
  skillName: string;
  actualSkillRoot: string;
}): Promise<{ drifted: boolean; reason?: string }> {
  const pristineSkillRoot = path.join(
    options.embeddedRoot,
    'plugins',
    options.pluginName,
    'codex',
    'skills',
    options.skillName,
  );

  return compareCodexSkillTrees({
    expectedFiles: await collectCodexSkillTreeFileContents(pristineSkillRoot),
    actualFiles: await collectCodexSkillTreeFileContents(options.actualSkillRoot),
  });
}

async function compareCodexRepoSkillToExpectedTree(options: {
  expectedTree: CodexSkillStagingTree;
  actualSkillRoot: string;
}): Promise<{ drifted: boolean; reason?: string }> {
  return compareCodexSkillTrees({
    expectedFiles: options.expectedTree.files,
    actualFiles: await collectCodexSkillTreeFileContents(options.actualSkillRoot),
  });
}

async function writeCodexSkillTree(
  rootDir: string,
  tree: CodexSkillStagingTree,
): Promise<string[]> {
  return writeDynamicSkillTree(rootDir, tree);
}

function findTrackedCodexDynamicSkillArtifact(
  record: TrackingPluginRecord | undefined,
  skillName: string,
): GeneratedArtifact | undefined {
  return readTrackedCodexSkillArtifacts(record).find((artifact) =>
    artifact.artifactKey === skillName && artifact.target === 'codex.skill');
}

function readMutableLedger(ledger: InstalledLedger): InstalledLedger {
  const nextLedger = structuredClone(ledger);
  if (nextLedger.ledgerState.status !== 'available') {
    nextLedger.ledgerState = {
      status: 'available',
      degradedAt: null,
      reason: null,
    };
  }

  return nextLedger;
}

function normalizeSharedNativeRefs(
  sharedNativeRefs: CodexSharedNativeRefs | undefined,
): CodexSharedNativeRefs {
  return {
    user: sharedNativeRefs?.user === true,
    projects: [...new Set(sharedNativeRefs?.projects ?? [])].sort(),
  };
}

function createEmptyNativeRecoveryStatus(): NativeRecoveryStatus {
  return {
    present: false,
    state: null,
    reason: null,
    evidenceMatches: null,
    suggestion: null,
  };
}

function createCodexNativeRecoverySuggestion(
  pluginName: string,
  state: NativeRecoveryStatus['state'],
  evidenceMatches: boolean,
): string {
  const repairCommand = `aw install ${pluginName} -p codex -s user`;
  const cleanupCommand = `aw cleanup ${pluginName} -p codex -s user`;

  if (state === 'cleanup_failed' || !evidenceMatches) {
    return `重新运行 ${cleanupCommand} 清理残留恢复记录；如果 Codex cache 和 config 已经手动清掉，AW 仍需要删除 breadcrumb。`;
  }

  if (state === 'pending_after_native_write') {
    return `运行 ${repairCommand} 补齐 AW 安装账本，或运行 ${cleanupCommand} 清理 Codex native 残留。`;
  }

  return `运行 ${repairCommand} 修复未完成安装，或运行 ${cleanupCommand} 清理 Codex native 残留。`;
}

function buildNativeRecoveryStatus(options: {
  pluginName: string;
  pluginEnabled: boolean;
  pluginInstalled: boolean;
  breadcrumb: Awaited<ReturnType<typeof readCodexNativeRecoveryBreadcrumb>>;
}): NativeRecoveryStatus {
  if (!options.breadcrumb) {
    return createEmptyNativeRecoveryStatus();
  }

  const evidenceMatches = options.pluginEnabled || options.pluginInstalled;

  return {
    present: true,
    state: options.breadcrumb.state,
    reason: options.breadcrumb.reason,
    evidenceMatches,
    suggestion: createCodexNativeRecoverySuggestion(
      options.pluginName,
      options.breadcrumb.state,
      evidenceMatches,
    ),
  };
}

function upsertCodexScopeLedger(
  ledger: InstalledLedger,
  plugin: PluginMeta,
  scope: Scope,
  projectKey: string | undefined,
): InstalledLedger {
  const nextLedger = readMutableLedger(ledger);
  const timestamp = new Date().toISOString();
  const pluginRecord = nextLedger.plugins[plugin.manifest.name] ?? {
    lastResolvedVersion: plugin.manifest.version,
    platforms: {},
  };
  pluginRecord.lastResolvedVersion = plugin.manifest.version;
  pluginRecord.platforms.codex ??= {};
  pluginRecord.platforms.codex.lastRequestedScope = scope;
  pluginRecord.platforms.codex.lastRequestedAt = timestamp;

  const capabilitySnapshot: CodexCapabilitySnapshot = {
    requiresNativePlugin: requiresCodexNativePlugin(plugin, scope),
    hasRepoManagedArtifacts: hasCodexProjectManagedArtifacts(plugin),
    projectManagedKinds: getCodexProjectManagedKinds(plugin),
  };

  const scopeRecord: InstalledScopeRecord<CodexCapabilitySnapshot> = {
    managed: true,
    updatedAt: timestamp,
    resolvedVersion: plugin.manifest.version,
    capabilitySnapshot,
  };
  if (scope === 'project' && projectKey) {
    scopeRecord.projectKey = projectKey;
  }
  if (scope === 'user') {
    pluginRecord.platforms.codex.userScope = scopeRecord;
  } else if (projectKey) {
    pluginRecord.platforms.codex.projectScopes ??= {};
    pluginRecord.platforms.codex.projectScopes[projectKey] = scopeRecord;
  }

  if (scope === 'user' && capabilitySnapshot.requiresNativePlugin) {
    const sharedNativeRefs = normalizeSharedNativeRefs(pluginRecord.platforms.codex.sharedNativeRefs);
    sharedNativeRefs.user = true;
    pluginRecord.platforms.codex.sharedNativeRefs = sharedNativeRefs;
  }

  nextLedger.plugins[plugin.manifest.name] = pluginRecord;
  return nextLedger;
}

export async function applyCodexInstallLedger(
  ledger: InstalledLedger,
  plugin: PluginMeta,
  scope: Scope,
  cwd: string,
): Promise<InstalledLedger> {
  const projectKey = scope === 'project' ? await resolveCodexProjectKey(cwd) : undefined;
  return upsertCodexScopeLedger(ledger, plugin, scope, projectKey);
}

function removeCodexScopeLedger(
  ledger: InstalledLedger,
  pluginName: string,
  scope: Scope,
  projectKey: string | undefined,
): InstalledLedger {
  const nextLedger = readMutableLedger(ledger);
  const pluginRecord = nextLedger.plugins[pluginName];
  if (!pluginRecord?.platforms.codex) {
    return nextLedger;
  }

  if (scope === 'user') {
    delete pluginRecord.platforms.codex.userScope;
  } else if (projectKey) {
    delete pluginRecord.platforms.codex.projectScopes?.[projectKey];
    if (
      pluginRecord.platforms.codex.projectScopes &&
      Object.keys(pluginRecord.platforms.codex.projectScopes).length === 0
    ) {
      delete pluginRecord.platforms.codex.projectScopes;
    }
  }

  const sharedNativeRefs = normalizeSharedNativeRefs(pluginRecord.platforms.codex.sharedNativeRefs);
  if (scope === 'user') {
    sharedNativeRefs.user = false;
    if (sharedNativeRefs.user || sharedNativeRefs.projects.length > 0) {
      pluginRecord.platforms.codex.sharedNativeRefs = sharedNativeRefs;
    } else {
      delete pluginRecord.platforms.codex.sharedNativeRefs;
    }
  }

  const hasProjectScopes = Object.keys(pluginRecord.platforms.codex.projectScopes ?? {}).length > 0;
  const hasSharedRefs = sharedNativeRefs.user || sharedNativeRefs.projects.length > 0;
  if (!pluginRecord.platforms.codex.userScope && !hasProjectScopes && !hasSharedRefs) {
    delete pluginRecord.platforms.codex;
  }

  if (Object.keys(pluginRecord.platforms).length === 0) {
    delete nextLedger.plugins[pluginName];
  }

  return nextLedger;
}

export async function applyCodexUninstallLedger(
  ledger: InstalledLedger,
  pluginName: string,
  scope: Scope,
  cwd: string,
): Promise<InstalledLedger> {
  const projectKey = scope === 'project' ? await resolveCodexProjectKey(cwd) : undefined;
  return removeCodexScopeLedger(ledger, pluginName, scope, projectKey);
}

export async function pruneCodexTrackedArtifacts(options: {
  cwd: string;
  scope: Scope;
  env?: NodeJS.ProcessEnv;
  pluginName: string;
  artifacts: GeneratedArtifact[];
  preservedArtifacts?: GeneratedArtifact[];
}): Promise<void> {
  const trackingRecord = options.artifacts.length > 0
    ? {
        name: options.pluginName,
        generatedAt: new Date(0).toISOString(),
        artifacts: [...options.artifacts],
      } satisfies TrackingPluginRecord
    : undefined;
  await pruneTrackedCodexArtifacts({
    cwd: options.cwd,
    scope: options.scope,
    env: options.env ?? process.env,
    pluginName: options.pluginName,
    trackingRecord,
    preservedArtifacts: options.preservedArtifacts,
  });
}

function getInstalledScopeSnapshot(
  ledger: InstalledLedger,
  pluginName: string,
  scope: Scope,
  projectKey: string | undefined,
): CodexCapabilitySnapshot | undefined {
  if (scope === 'user') {
    return ledger.plugins[pluginName]?.platforms.codex?.userScope?.capabilitySnapshot;
  }

  return projectKey
    ? ledger.plugins[pluginName]?.platforms.codex?.projectScopes?.[projectKey]?.capabilitySnapshot
    : undefined;
}

function readTrackedCodexHookGroups(
  record: TrackingPluginRecord | undefined,
): TrackedHookGroupIdentity[] | null {
  if (!record) {
    return [];
  }

  const groups: TrackedHookGroupIdentity[] = [];
  for (const artifact of record.artifacts) {
    if (artifact.kind !== 'hook') {
      continue;
    }

    if (artifact.hookGroups === undefined) {
      return null;
    }

    const trackedGroups = Array.isArray(artifact.hookGroups) ? artifact.hookGroups : null;
    if (!trackedGroups) {
      return null;
    }

    groups.push(...trackedGroups);
  }

  return groups;
}

function createTrackingRecordFromArtifacts(
  pluginName: string,
  trackingRecord: TrackingPluginRecord | undefined,
  generatedArtifacts: GeneratedArtifact[],
): TrackingPluginRecord | undefined {
  const previousArtifacts = trackingRecord?.artifacts ?? [];
  const nextArtifacts = generatedArtifacts.map((artifact) => {
    const previousArtifact = previousArtifacts.find((candidate) => {
      if (
        artifact.id &&
        artifact.target &&
        candidate.id === artifact.id &&
        candidate.target === artifact.target &&
        candidate.platform === artifact.platform
      ) {
        return true;
      }

      if (
        (artifact.kind === 'skill' || artifact.kind === 'mcpServer') &&
        artifact.artifactKey &&
        candidate.kind === artifact.kind &&
        candidate.platform === artifact.platform &&
        candidate.artifactKey === artifact.artifactKey
      ) {
        return true;
      }

      return getGeneratedArtifactIdentityKey(candidate) === getGeneratedArtifactIdentityKey(artifact);
    });

    return previousArtifact
      ? {
          ...previousArtifact,
          ...artifact,
        }
      : artifact;
  });
  const artifacts = mergeGeneratedArtifacts(
    previousArtifacts,
    nextArtifacts,
  );
  if (artifacts.length === 0) {
    return undefined;
  }

  return {
    name: trackingRecord?.name ?? pluginName,
    generatedAt: trackingRecord?.generatedAt ?? new Date(0).toISOString(),
    artifacts,
  };
}

async function restoreBundledUserCodexSkillIfPresent(options: {
  pluginName: string;
  skillKey: string;
  skillPath: string;
}): Promise<boolean> {
  let embeddedRoot: string;
  try {
    embeddedRoot = await resolveEmbeddedPluginsRoot();
  } catch {
    return false;
  }
  const embeddedSkillRoot = path.join(
    embeddedRoot,
    'plugins',
    options.pluginName,
    'codex',
    'skills',
    options.skillKey,
  );
  if (!(await fs.pathExists(embeddedSkillRoot))) {
    return false;
  }

  await fs.remove(options.skillPath);
  await fs.ensureDir(path.dirname(options.skillPath));
  await fs.copy(embeddedSkillRoot, options.skillPath, {
    overwrite: true,
    errorOnExist: false,
  });
  return true;
}

async function pruneTrackedCodexArtifacts(options: {
  cwd: string;
  scope: Scope;
  env: NodeJS.ProcessEnv;
  pluginName: string;
  trackingRecord: TrackingPluginRecord | undefined;
  preservedArtifacts?: GeneratedArtifact[];
  rollbackBaseline?: { path: string; content: string | null };
  roleFileRollbackBaselines?: Map<string, TextFileRollbackBaseline>;
}): Promise<void> {
  const paths = resolveCodexPaths(options.cwd, options.scope, options.env);
  await assertCanonicalTrackedCodexArtifactMainPaths({
    cwd: options.cwd,
    scope: options.scope,
    env: options.env,
    pluginName: options.pluginName,
    artifacts: options.trackingRecord?.artifacts ?? [],
  });
  const preservedTrackingRecord = options.preservedArtifacts?.length
    ? {
        name: options.pluginName,
        generatedAt: new Date(0).toISOString(),
        artifacts: options.preservedArtifacts,
      } satisfies TrackingPluginRecord
    : undefined;
  const trackedRoleArtifacts = readTrackedCodexRoleArtifacts(options.trackingRecord);
  const preservedRoleArtifacts = readTrackedCodexRoleArtifacts(
    preservedTrackingRecord,
  );
  const preservedDynamicSkillArtifacts = readTrackedCodexDynamicSkillArtifacts(
    preservedTrackingRecord,
  );
  const roleFileRollbackBaselines = options.roleFileRollbackBaselines ?? new Map();
  const restoringRoleFiles = Boolean(options.rollbackBaseline) || roleFileRollbackBaselines.size > 0;
  if (options.trackingRecord) {
    for (const artifact of options.trackingRecord.artifacts) {
      const managedRoleArtifact =
        artifact.kind === 'agent' &&
        trackedRoleArtifacts.some((entry) =>
          entry.path === artifact.path &&
          entry.artifactKey === resolveCodexRoleIdentity(artifact),
        );
      if (artifact.kind === 'permission' || (artifact.kind === 'agent' && !managedRoleArtifact)) {
        await fs.remove(artifact.path);
        continue;
      }

      if (artifact.kind === 'skill') {
        if (artifact.state === 'disabled') {
          continue;
        }
        if (!artifact.artifactKey) {
          throw new Error(
            `tracking manifest 中的 skill 缺少 artifactKey，不能对 ${artifact.path} 执行 path-only 删除。`,
          );
        }

        const overlappingPreservedDynamicSkill = preservedDynamicSkillArtifacts.find((preservedArtifact) =>
          path.normalize(preservedArtifact.path) === path.normalize(artifact.path) ||
          preservedArtifact.artifactKey === artifact.artifactKey,
        );
        if (overlappingPreservedDynamicSkill) {
          if (
            artifact.target === 'codex.skill' &&
            hasSameGeneratedArtifactDesiredIdentity(artifact, overlappingPreservedDynamicSkill)
          ) {
            continue;
          }

          if (artifact.target === 'codex.skill') {
            throw new Error(
              `tracking manifest 中的 codex.skill "${artifact.id ?? artifact.artifactKey}" ` +
                `与当前声明的 "${overlappingPreservedDynamicSkill.id ?? overlappingPreservedDynamicSkill.artifactKey}" ` +
                '共享同一路径或 artifactKey，CLI 不会按 path-only 清理旧 identity；请先清理旧 tracking 后再升级。',
            );
          }

          throw new Error(
            `tracking manifest 中仍残留旧 skill "${artifact.artifactKey}"，它与当前 codex.skill ` +
              `"${overlappingPreservedDynamicSkill.artifactKey}" 共享路径或 artifactKey；` +
              '本轮不做旧 static skill 到 dynamic identity 的自动迁移，请先清理旧 tracking 后再升级。',
          );
        }

        if (
          options.scope === 'user' &&
          !options.preservedArtifacts?.length &&
          artifact.target === 'codex.skill' &&
          await restoreBundledUserCodexSkillIfPresent({
            pluginName: options.pluginName,
            skillKey: artifact.artifactKey,
            skillPath: artifact.path,
          })
        ) {
          continue;
        }

        await fs.remove(artifact.path);
      }
    }
  }

  if (options.rollbackBaseline) {
    if (options.rollbackBaseline.content === null) {
      await fs.remove(options.rollbackBaseline.path);
    } else {
      await fs.ensureDir(path.dirname(options.rollbackBaseline.path));
      await fs.writeFile(options.rollbackBaseline.path, options.rollbackBaseline.content, 'utf8');
    }
  } else {
    const trackedInstruction = options.trackingRecord?.artifacts.some((artifact) => artifact.kind === 'instruction');
    const preservedInstruction = options.preservedArtifacts?.some((artifact) => artifact.kind === 'instruction') ?? false;
    const trackedMcpArtifacts = readTrackedCodexMcpArtifacts(options.trackingRecord);
    if (trackedMcpArtifacts.some((artifact) => !artifact.artifactKey)) {
      throw new Error(
        `tracking manifest 中的 mcpServer 缺少 artifactKey，不能对 ${paths.configTomlPath} 执行 path-only 删除。`,
      );
    }

    if ((trackedInstruction && !preservedInstruction) || trackedMcpArtifacts.length > 0) {
      await applyCodexConfigTransactionFile(paths.configTomlPath, {
        ...((trackedInstruction && !preservedInstruction)
          ? { removeManagedInstructionPluginName: options.pluginName }
          : {}),
        ...(trackedMcpArtifacts.length > 0
          ? {
              removeMcpServers: trackedMcpArtifacts
                .map((artifact) => artifact.artifactKey)
                .filter((artifactKey): artifactKey is string => Boolean(artifactKey)),
            }
          : {}),
      });
    }
  }

  if (trackedRoleArtifacts.length > 0) {
    const staleRoleArtifacts = trackedRoleArtifacts.filter((artifact) =>
      !preservedRoleArtifacts.some((preserved) =>
        path.normalize(preserved.path) === path.normalize(artifact.path) ||
        preserved.artifactKey === artifact.artifactKey,
      ),
    );
    for (const artifact of staleRoleArtifacts) {
      if (restoringRoleFiles) {
        const baseline = roleFileRollbackBaselines.get(path.normalize(artifact.path));
        if (baseline) {
          await restoreTextFileRollbackBaseline(baseline);
        } else if (options.rollbackBaseline) {
          await fs.remove(artifact.path);
        }
        continue;
      }

      const removalPlan = planCodexManagedRoleRemoval({
        content: (await readCodexConfigFile(paths.configTomlPath)).content,
        configPath: paths.configTomlPath,
        roleKey: artifact.artifactKey,
        managedRoleLayerPath: artifact.path,
      });
      await fs.remove(removalPlan.roleLayerPathToDelete);
    }
    if (!restoringRoleFiles && staleRoleArtifacts.length > 0) {
      await applyCodexConfigTransactionFile(paths.configTomlPath, {
        removeAgentRegistrations: staleRoleArtifacts.map((artifact) => artifact.artifactKey),
      });
    }
  }

  const trackedHookGroups = readTrackedCodexHookGroups(options.trackingRecord);
  if (trackedHookGroups && trackedHookGroups.length > 0) {
    const parsedHooks = await readParsedCodexSharedHooksFile(paths.hooksPath);
    const updatePlan = planCodexSharedHooksUpdate(parsedHooks, {
      rerenderedIdentities: trackedHookGroups,
    });
    const preservedHistorical = new Set(updatePlan.preservedHistoricalAwRawGroups);
    const preservedForeign = new Set(updatePlan.preservedForeignRawGroups);
    const preservedRawGroups = parsedHooks.rawGroups.filter((group) =>
      preservedHistorical.has(group) || preservedForeign.has(group),
    );
    await writeCodexSharedHookGroups(paths.hooksPath, preservedRawGroups);
    return;
  }

  if (trackedHookGroups === null && hasTrackedCodexHookArtifact(options.trackingRecord)) {
    const parsedHooks = await readParsedCodexSharedHooksFile(paths.hooksPath);
    await writeCodexSharedHookGroups(paths.hooksPath, parsedHooks.rawGroups);
  }
}

function hasTrackedCodexHookArtifact(
  record: TrackingPluginRecord | undefined,
): boolean {
  return Boolean(record?.artifacts.some((artifact) => artifact.kind === 'hook'));
}

function createEmptyParsedCodexSharedHooksFile() {
  return parseCodexSharedHooksFile({ hooks: {} }, 'codex.hooks');
}

async function readCodexHookGroups(hooksPath: string): Promise<TrackedHookGroupIdentity[]> {
  const parsed = await readParsedCodexSharedHooksFile(hooksPath);
  return parsed.managedIdentities;
}

async function readParsedCodexSharedHooksFile(hooksPath: string) {
  if (!(await fs.pathExists(hooksPath))) {
    return createEmptyParsedCodexSharedHooksFile();
  }

  const raw = await fs.readJson(hooksPath) as { hooks?: unknown };
  return parseCodexSharedHooksFile(raw, 'codex.hooks');
}

function renderTrackedCodexSharedHookGroup(
  identity: TrackedHookGroupIdentity,
): CodexSharedHookGroup {
  const rendered = renderTrackedHookGroupIdentity(identity);
  const rawGroup: Record<string, unknown> = {
    hooks: rendered.hooks.map((handler) => ({ ...handler })),
  };
  if (rendered.matcher !== undefined) {
    rawGroup.matcher = rendered.matcher;
  }

  return {
    event: rendered.event,
    ...(rendered.matcher === undefined ? {} : { matcher: rendered.matcher }),
    hooks: rawGroup.hooks as Record<string, unknown>[],
    rawGroup,
  };
}

function buildCodexSharedHooksContent(
  groups: CodexSharedHookGroup[],
): Record<string, unknown> {
  const hooks: Record<string, Array<Record<string, unknown>>> = {};
  for (const group of groups) {
    hooks[group.event] ??= [];
    hooks[group.event].push(group.rawGroup);
  }

  return { hooks };
}

async function writeCodexSharedHookGroups(
  hooksPath: string,
  groups: CodexSharedHookGroup[],
): Promise<string | undefined> {
  if (groups.length === 0) {
    await fs.remove(hooksPath);
    return undefined;
  }

  const content = buildCodexSharedHooksContent(groups);
  validateCodexSharedHooksContent(content, 'codex.hooks');
  await writeJsonFile(hooksPath, content);
  return hooksPath;
}

async function resolveTrackedPlugin(
  pluginName: string,
  env: NodeJS.ProcessEnv,
  catalogResolution?: CatalogResolution,
): Promise<PluginMeta> {
  if (catalogResolution) {
    return (await resolvePluginsFromCatalog(catalogResolution.rootDir, [pluginName]))[0];
  }

  try {
    return (await resolveCatalogPlugins([pluginName], env)).plugins[0];
  } catch (error) {
    if (!(error instanceof Error) || error.message !== `Unknown plugin "${pluginName}".`) {
      throw error;
    }

    const bundleRoot = await resolveActiveLocalBundle(pluginName, env);
    if (bundleRoot) {
      return readPluginManifest(bundleRoot, { mode: 'bundle' });
    }

    throw error;
  }
}

type ResolvedTrackedCodexHookRewrite = {
  previousTrackedIdentities: TrackedHookGroupIdentity[];
  nextHookIdentities: TrackedHookGroupIdentity[];
  historicalTrackedIdentities: TrackedHookGroupIdentity[];
};

function resolveInstallTrackedCodexHookGroups(
  trackedHookGroups: TrackedHookGroupIdentity[] | null,
  resolvedHookGroups: TrackedHookGroupIdentity[],
): TrackedHookGroupIdentity[] {
  return trackedHookGroups ?? resolvedHookGroups;
}

async function resolveTrackedCodexHookRewrite(
  plugin: PluginMeta,
  trackingManifest: TrackingManifest,
  env: NodeJS.ProcessEnv,
  catalogResolution?: CatalogResolution,
): Promise<ResolvedTrackedCodexHookRewrite> {
  const currentTrackingRecord = getTrackingRecord(trackingManifest, plugin.manifest.name);
  const currentHookIdentities = extractCodexHookGroups(
    resolvePlatformHookDefinitions(plugin.manifest, 'codex'),
  );
  const currentTrackedIdentities = resolveInstallTrackedCodexHookGroups(
    readTrackedCodexHookGroups(currentTrackingRecord),
    currentHookIdentities,
  );

  const previousTrackedIdentities = [...currentTrackedIdentities];
  const nextHookIdentities = [...currentHookIdentities];
  const historicalTrackedIdentities: TrackedHookGroupIdentity[] = [];

  const otherTrackedPluginNames = Object.keys(trackingManifest.plugins)
    .filter((pluginName) => pluginName !== plugin.manifest.name)
    .sort();

  for (const trackedPluginName of otherTrackedPluginNames) {
    const trackingRecord = trackingManifest.plugins[trackedPluginName];
    const trackedHookGroups = readTrackedCodexHookGroups(trackingRecord);
    if (trackedHookGroups !== null && trackedHookGroups.length === 0) {
      continue;
    }

    try {
      const trackedPlugin = await resolveTrackedPlugin(
        trackedPluginName,
        env,
        catalogResolution,
      );
      const resolvedHookGroups = extractCodexHookGroups(
        resolvePlatformHookDefinitions(trackedPlugin.manifest, 'codex'),
      );
      previousTrackedIdentities.push(
        ...resolveInstallTrackedCodexHookGroups(trackedHookGroups, resolvedHookGroups),
      );
      nextHookIdentities.push(...resolvedHookGroups);
    } catch {
      if (trackedHookGroups && trackedHookGroups.length > 0) {
        historicalTrackedIdentities.push(...trackedHookGroups);
      }
    }
  }

  return {
    previousTrackedIdentities,
    nextHookIdentities,
    historicalTrackedIdentities,
  };
}

async function syncCodexHooks(
  hooksPath: string,
  plugin: PluginMeta,
  trackingManifest: TrackingManifest,
  env: NodeJS.ProcessEnv,
  catalogResolution?: CatalogResolution,
): Promise<string | undefined> {
  const parsedHooks = await readParsedCodexSharedHooksFile(hooksPath);
  const rewritePlan = await resolveTrackedCodexHookRewrite(
    plugin,
    trackingManifest,
    env,
    catalogResolution,
  );
  const updatePlan = planCodexSharedHooksUpdate(parsedHooks, {
    rerenderedIdentities: rewritePlan.previousTrackedIdentities,
    historicalIdentities: rewritePlan.historicalTrackedIdentities,
  });

  const preservedHistorical = new Set(updatePlan.preservedHistoricalAwRawGroups);
  const preservedForeign = new Set(updatePlan.preservedForeignRawGroups);
  const preservedRawGroups = parsedHooks.rawGroups.filter((group) =>
    preservedHistorical.has(group) || preservedForeign.has(group),
  );
  const nextManagedRawGroups = rewritePlan.nextHookIdentities.map(renderTrackedCodexSharedHookGroup);

  return writeCodexSharedHookGroups(hooksPath, [
    ...preservedRawGroups,
    ...nextManagedRawGroups,
  ]);
}

const CODEX_CONFIG_ROLLBACK_BASELINE = Symbol('codexConfigRollbackBaseline');
const CODEX_ROLE_FILE_ROLLBACK_BASELINES = Symbol('codexRoleFileRollbackBaselines');

type GeneratedArtifactWithCodexRollbackBaseline = GeneratedArtifact & {
  [CODEX_CONFIG_ROLLBACK_BASELINE]?: {
    path: string;
    content: string | null;
  };
};

interface TextFileRollbackBaseline {
  path: string;
  content: string | null;
}

type GeneratedArtifactWithCodexRoleFileRollbackBaselines = GeneratedArtifact & {
  [CODEX_ROLE_FILE_ROLLBACK_BASELINES]?: TextFileRollbackBaseline[];
};

function attachCodexConfigRollbackBaseline(
  artifacts: GeneratedArtifact[],
  baseline: { path: string; content: string | null },
): void {
  for (const artifact of artifacts) {
    if (
      artifact.kind !== 'instruction' &&
      artifact.kind !== 'mcpServer' &&
      artifact.kind !== 'agent'
    ) {
      continue;
    }

    Object.defineProperty(artifact, CODEX_CONFIG_ROLLBACK_BASELINE, {
      value: baseline,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
}

function attachCodexRoleFileRollbackBaselines(
  artifacts: GeneratedArtifact[],
  baselines: TextFileRollbackBaseline[],
): void {
  if (baselines.length === 0) {
    return;
  }

  for (const artifact of artifacts) {
    Object.defineProperty(artifact, CODEX_ROLE_FILE_ROLLBACK_BASELINES, {
      value: baselines,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
}

function getCodexConfigRollbackBaseline(
  artifacts: GeneratedArtifact[],
): { path: string; content: string | null } | undefined {
  for (const artifact of artifacts) {
    const baseline = (artifact as GeneratedArtifactWithCodexRollbackBaseline)[
      CODEX_CONFIG_ROLLBACK_BASELINE
    ];
    if (baseline) {
      return baseline;
    }
  }

  return undefined;
}

function getCodexRoleFileRollbackBaselines(
  artifacts: GeneratedArtifact[],
): Map<string, TextFileRollbackBaseline> {
  const baselines = new Map<string, TextFileRollbackBaseline>();
  for (const artifact of artifacts) {
    const artifactBaselines = (artifact as GeneratedArtifactWithCodexRoleFileRollbackBaselines)[
      CODEX_ROLE_FILE_ROLLBACK_BASELINES
    ] ?? [];
    for (const baseline of artifactBaselines) {
      baselines.set(path.normalize(baseline.path), baseline);
    }
  }
  return baselines;
}

async function captureTextFileRollbackBaseline(
  filePath: string,
): Promise<TextFileRollbackBaseline> {
  const exists = await fs.pathExists(filePath);
  return {
    path: filePath,
    content: exists ? await fs.readFile(filePath, 'utf8') : null,
  };
}

async function restoreTextFileRollbackBaseline(
  baseline: TextFileRollbackBaseline,
): Promise<void> {
  if (baseline.content === null) {
    await fs.remove(baseline.path);
    return;
  }

  await fs.ensureDir(path.dirname(baseline.path));
  await fs.writeFile(baseline.path, baseline.content, 'utf8');
}

function getCodexSkillStatusPaths(skillRoot: string): string[] {
  return [
    path.join(skillRoot, 'SKILL.md'),
    path.join(skillRoot, 'agents', 'openai.yaml'),
  ];
}

async function readCodexSkillRuntimeTree(skillRoot: string): Promise<Record<string, Buffer> | null> {
  return (await readDynamicSkillTree(skillRoot, 'codex.skill'))?.files ?? null;
}

async function resolveRenderedCodexMcpServers(
  plugin: PluginMeta,
): Promise<Record<string, CodexMcpServerConfig>> {
  if (!plugin.manifest.mcpServers) {
    return {};
  }

  const sourceManifestPath = path.resolve(plugin.rootDir, plugin.manifest.mcpServers);
  if (await fs.pathExists(sourceManifestPath)) {
    return readRenderedCodexMcpServersFile(sourceManifestPath);
  }

  const codexBundlePath = path.resolve(
    plugin.rootDir,
    'codex',
    plugin.manifest.mcpServers.startsWith('./')
      ? plugin.manifest.mcpServers.slice(2)
      : plugin.manifest.mcpServers,
  );
  return readRenderedCodexMcpServersFile(codexBundlePath);
}

function readTrackedCodexMcpArtifacts(
  record: TrackingPluginRecord | undefined,
): GeneratedArtifact[] {
  return (record?.artifacts ?? []).filter((artifact) => artifact.kind === 'mcpServer');
}

function resolveCodexRoleIdentity(
  artifact: Pick<GeneratedArtifact, 'target' | 'roleKey' | 'artifactKey'>,
): string | undefined {
  if (artifact.target !== 'codex.agentRole' && artifact.roleKey === undefined) {
    return undefined;
  }

  const roleKey = artifact.roleKey?.trim() || artifact.artifactKey?.trim();
  return roleKey || undefined;
}

function readTrackedCodexRoleArtifacts(
  record: TrackingPluginRecord | undefined,
): Array<GeneratedArtifact & { artifactKey: string; roleKey: string }> {
  return (record?.artifacts ?? [])
    .filter((artifact) => artifact.kind === 'agent')
    .map((artifact) => {
      const roleKey = resolveCodexRoleIdentity(artifact);
      if (!roleKey) {
        return undefined;
      }

      return {
        ...artifact,
        artifactKey: roleKey,
        roleKey,
      };
    })
    .filter((artifact): artifact is GeneratedArtifact & { artifactKey: string; roleKey: string } =>
      Boolean(artifact),
    );
}

function readTrackedCodexDynamicSkillArtifacts(
  record: TrackingPluginRecord | undefined,
): Array<GeneratedArtifact & { artifactKey: string }> {
  return (record?.artifacts ?? [])
    .filter((artifact) => artifact.kind === 'skill' && artifact.target === 'codex.skill')
    .map((artifact) => {
      const skillKey = artifact.artifactKey?.trim();
      if (!skillKey) {
        return undefined;
      }
      return {
        ...artifact,
        artifactKey: skillKey,
      };
    })
    .filter((artifact): artifact is GeneratedArtifact & { artifactKey: string } =>
      Boolean(artifact),
    );
}

function assertTrackedCodexSkillIdentityMatchesPlan(options: {
  pluginName: string;
  trackingRecord: TrackingPluginRecord | undefined;
  skillArtifacts: Array<{
    id: string;
    target: 'codex.skill';
    skillKey: string;
  }>;
}): void {
  const trackedSkillArtifactsById = new Map(
    readTrackedCodexDynamicSkillArtifacts(options.trackingRecord)
      .filter((artifact) => artifact.id && artifact.target === 'codex.skill')
      .map((artifact) => [artifact.id as string, artifact]),
  );

  for (const artifact of options.skillArtifacts) {
    const trackedArtifact = trackedSkillArtifactsById.get(artifact.id);
    if (!trackedArtifact) {
      continue;
    }

    if (trackedArtifact.artifactKey !== artifact.skillKey) {
      throw new Error(
        `Tracking artifact "${artifact.id}" 记录的 skillKey 为 "${trackedArtifact.artifactKey}"，` +
          `但 ${options.pluginName} 当前静态 metadata / render plan 要求 "${artifact.skillKey}"。` +
          '请先修复 tracking 受管身份后再继续写入。',
      );
    }
  }
}

function assertTrackedCodexRoleIdentityMatchesPlan(options: {
  pluginName: string;
  trackingRecord: TrackingPluginRecord | undefined;
  roleArtifacts: Array<{
    id: string;
    target: 'codex.agentRole';
    roleKey: string;
  }>;
}): void {
  const trackedRoleArtifactsById = new Map(
    readTrackedCodexRoleArtifacts(options.trackingRecord)
      .filter((artifact) => artifact.id && artifact.target === 'codex.agentRole')
      .map((artifact) => [artifact.id as string, artifact]),
  );

  for (const artifact of options.roleArtifacts) {
    const trackedArtifact = trackedRoleArtifactsById.get(artifact.id);
    if (!trackedArtifact) {
      continue;
    }

    if (trackedArtifact.roleKey !== artifact.roleKey) {
      throw new Error(
        `Tracking artifact "${artifact.id}" 记录的 roleKey 为 "${trackedArtifact.roleKey}"，` +
          `但 ${options.pluginName} 当前静态 metadata / render plan 要求 "${artifact.roleKey}"。` +
          '请先修复 tracking 受管身份后再继续写入。',
      );
    }
  }
}

function hasTrackedCodexMcpServer(
  record: TrackingPluginRecord | undefined,
  serverKey: string,
): boolean {
  return readTrackedCodexMcpArtifacts(record).some((artifact) => artifact.artifactKey === serverKey);
}

function findTrackedCodexMcpServerOwner(
  trackingManifest: TrackingManifest,
  pluginName: string,
  serverKey: string,
): string | undefined {
  for (const [ownerPluginName, record] of Object.entries(trackingManifest.plugins)) {
    if (ownerPluginName === pluginName) {
      continue;
    }

    if (readTrackedCodexMcpArtifacts(record).some((artifact) => artifact.artifactKey === serverKey)) {
      return ownerPluginName;
    }
  }

  return undefined;
}

function trackedCodexMcpServerKeys(
  record: TrackingPluginRecord | undefined,
): string[] {
  return readTrackedCodexMcpArtifacts(record)
    .map((artifact) => artifact.artifactKey)
    .filter((artifactKey): artifactKey is string => Boolean(artifactKey))
    .sort();
}

function createCodexMcpConflictError(
  pluginName: string,
  serverKey: string,
  ownerPluginName?: string,
): Error {
  const ownerDetail = ownerPluginName
    ? `它已由 ${ownerPluginName} 的 tracking 记录为受管 MCP server。`
    : '它已存在于 .codex/config.toml 中，但当前插件没有 tracking 证明归属。';
  return new Error(
    `${pluginName} 无法写入 MCP server "${serverKey}"：${ownerDetail}`,
  );
}

function assertNoCodexMcpServerConflicts(options: {
  pluginName: string;
  trackingManifest: TrackingManifest;
  trackingRecord: TrackingPluginRecord | undefined;
  scopeConfig: { snapshot: CodexConfigSnapshot };
  desiredServers: Record<string, CodexMcpServerConfig>;
}): void {
  for (const serverKey of Object.keys(options.desiredServers)) {
    const ownerPluginName = findTrackedCodexMcpServerOwner(
      options.trackingManifest,
      options.pluginName,
      serverKey,
    );
    if (ownerPluginName) {
      throw createCodexMcpConflictError(options.pluginName, serverKey, ownerPluginName);
    }

    if (hasTrackedCodexMcpServer(options.trackingRecord, serverKey)) {
      continue;
    }

    if (options.scopeConfig.snapshot.mcpServers[serverKey]) {
      throw createCodexMcpConflictError(options.pluginName, serverKey);
    }
  }
}

type ResolvedCodexStatusMcpExpectation = {
  declared: boolean;
  expectedServers: Record<string, CodexMcpServerConfig | undefined>;
  diagnostics: string[];
};

async function resolveCodexStatusMcpExpectation(
  plugin: PluginMeta,
  trackingRecord: TrackingPluginRecord | undefined,
  currentCatalogAvailable: boolean,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedCodexStatusMcpExpectation> {
  if (currentCatalogAvailable) {
    try {
      const expectedServers = await resolveRenderedCodexMcpServers(plugin);
      return {
        declared: Object.keys(expectedServers).length > 0,
        expectedServers,
        diagnostics: [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        declared: Boolean(plugin.manifest.mcpServers),
        expectedServers: Object.fromEntries(
          trackedCodexMcpServerKeys(trackingRecord).map((serverKey) => [serverKey, undefined]),
        ),
        diagnostics: [`Codex MCP 定义无法解析，已回退到 tracking server keys：${message}`],
      };
    }
  }

  const diagnostics: string[] = [];
  const activeLocalBundle = await resolveActiveLocalBundle(plugin.manifest.name, env);
  if (activeLocalBundle) {
    try {
      const activePlugin = await readPluginManifest(activeLocalBundle, { mode: 'bundle' });
      const expectedServers = await resolveRenderedCodexMcpServers(activePlugin);
      return {
        declared: Object.keys(expectedServers).length > 0,
        expectedServers,
        diagnostics,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(`Codex activeLocalBundle 的 MCP 定义无法解析，已回退到 tracking server keys：${message}`);
    }
  }

  const trackedKeys = trackedCodexMcpServerKeys(trackingRecord);
  return {
    declared: trackedKeys.length > 0,
    expectedServers: Object.fromEntries(trackedKeys.map((serverKey) => [serverKey, undefined])),
    diagnostics,
  };
}

type ResolvedCodexStatusHookExpectation = {
  declared: boolean;
  expectedGroups: TrackedHookGroupIdentity[] | null;
  diagnostics: string[];
};

async function resolveCodexStatusHookExpectation(
  plugin: PluginMeta,
  trackingRecord: TrackingPluginRecord | undefined,
  currentCatalogAvailable: boolean,
  env: NodeJS.ProcessEnv,
): Promise<ResolvedCodexStatusHookExpectation> {
  if (currentCatalogAvailable) {
    const currentHooks = resolvePlatformHookDefinitions(plugin.manifest, 'codex');
    return {
      declared: currentHooks.length > 0,
      expectedGroups: extractCodexHookGroups(currentHooks),
      diagnostics: [],
    };
  }

  const diagnostics: string[] = [];
  const activeLocalBundle = await resolveActiveLocalBundle(plugin.manifest.name, env);
  if (activeLocalBundle) {
    try {
      const activePlugin = await readPluginManifest(activeLocalBundle, { mode: 'bundle' });
      const activeHooks = resolvePlatformHookDefinitions(activePlugin.manifest, 'codex');
      return {
        declared: activeHooks.length > 0,
        expectedGroups: extractCodexHookGroups(activeHooks),
        diagnostics,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push(`Codex activeLocalBundle 无法解析，已回退到 tracking hook identities：${message}`);
    }
  }

  const trackedHookGroups = readTrackedCodexHookGroups(trackingRecord);
  if (trackedHookGroups === null) {
    diagnostics.push('历史 tracking manifest 只有 Codex hook kind，缺少可比较的 hook identities。');
    return {
      declared: hasTrackedCodexHookArtifact(trackingRecord),
      expectedGroups: null,
      diagnostics,
    };
  }

  return {
    declared: trackedHookGroups.length > 0,
    expectedGroups: trackedHookGroups,
    diagnostics,
  };
}

async function collectGeneratedArtifacts(
  pluginName: string,
  trackingDir: string,
): Promise<GeneratedArtifactStatus[]> {
  const trackingManifest = await readTrackingManifest(trackingDir);
  const trackingRecord = getTrackingRecord(trackingManifest, pluginName);
  if (!trackingRecord) {
    return [];
  }

  return collectGeneratedArtifactStatuses(trackingRecord.artifacts);
}

async function collectGeneratedArtifactStatuses(
  artifacts: GeneratedArtifact[],
): Promise<GeneratedArtifactStatus[]> {
  return Promise.all(
    artifacts.map(async (artifact) => ({
      path: artifact.path,
      exists: artifact.state === 'disabled' ? false : await fs.pathExists(artifact.path),
      kind: artifact.kind,
      ...(artifact.hookGroups === undefined
        ? {}
        : { hookGroups: structuredClone(artifact.hookGroups) }),
      ...(artifact.paths === undefined ? {} : { paths: [...artifact.paths] }),
      ...(artifact.artifactKey === undefined ? {} : { artifactKey: artifact.artifactKey }),
      ...(artifact.id === undefined ? {} : { id: artifact.id }),
      ...(artifact.target === undefined ? {} : { target: artifact.target }),
      ...(artifact.state === undefined ? {} : { state: artifact.state }),
      ...(artifact.disabledReason === undefined
        ? {}
        : { disabledReason: artifact.disabledReason }),
      ...(artifact.refreshKeys === undefined ? {} : { refreshKeys: [...artifact.refreshKeys] }),
      ...(artifact.configDigest === undefined ? {} : { configDigest: artifact.configDigest }),
      ...(artifact.contentDigest === undefined ? {} : { contentDigest: artifact.contentDigest }),
      ...(resolveCodexRoleIdentity(artifact) === undefined
        ? {}
        : { roleKey: resolveCodexRoleIdentity(artifact) }),
      ...(artifact.lastRefresh === undefined
        ? {}
        : { lastRefresh: structuredClone(artifact.lastRefresh) }),
      ...(artifact.refreshReach === undefined
        ? {}
        : { refreshReach: structuredClone(artifact.refreshReach) }),
    })),
  );
}

function listCodexHigherPriorityLayerRoots(cwd: string, repoRoot: string): string[] {
  const roots: string[] = [path.resolve(cwd)];
  const resolvedRepoRoot = path.resolve(repoRoot);
  let currentDir = path.resolve(cwd);

  while (currentDir !== resolvedRepoRoot) {
    roots.push(path.join(currentDir, '.codex'));
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  roots.push(path.join(resolvedRepoRoot, '.codex'));
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

async function resolveCodexHigherPriorityRoleNamespaces(
  cwd: string,
  repoRoot: string,
): Promise<Awaited<ReturnType<typeof resolveCodexRoleNamespace>>[]> {
  return Promise.all(
    listCodexHigherPriorityLayerRoots(cwd, repoRoot).map((layerRoot) =>
      resolveCodexRoleNamespace(path.join(layerRoot, 'config.toml')),
    ),
  );
}

async function hasProjectSharedIdentityForCodexSkill(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  pluginName: string;
  skillKey: string;
}): Promise<boolean> {
  const repoRoot = resolveProjectScopeRepoRoot(options.cwd);
  const locator = createProjectArtifactSharedLocator({
    plugin: options.pluginName,
    platform: 'codex',
    repoRoot,
    projectRoot: resolveProjectArtifactProjectRoot(options.cwd, {
      platform: 'codex',
      scope: 'project',
      projectKey: undefined,
    }),
  });
  const identityRead = await readProjectArtifactIdentityForLocator({
    repoRoot,
    locator,
    cwd: options.cwd,
    homeDir: options.env.HOME,
  });
  if (identityRead.status !== 'ok') {
    return false;
  }

  return identityRead.value.artifacts.some((artifact) =>
    artifact.kind === 'skill' &&
      artifact.platform === 'codex' &&
      artifact.artifactKey === options.skillKey &&
      artifact.target === 'codex.skill');
}

async function assertCodexProjectSkillPathOwnedByAw(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  pluginName: string;
  trackingRecord: TrackingPluginRecord | undefined;
  skillKey: string;
  skillPath: string;
}): Promise<void> {
  if (!(await fs.pathExists(options.skillPath))) {
    return;
  }

  if (
    findTrackedCodexDynamicSkillArtifact(options.trackingRecord, options.skillKey) ||
    await hasProjectSharedIdentityForCodexSkill({
      cwd: options.cwd,
      env: options.env,
      pluginName: options.pluginName,
      skillKey: options.skillKey,
    })
  ) {
    return;
  }

  throw new Error(
    `Codex repo skill "${options.skillKey}" 已存在于 ${
      path.relative(resolveProjectScopeRepoRoot(options.cwd), options.skillPath) || options.skillPath
    }，但当前没有 AW ownership 证明，不会静默覆盖。`,
  );
}

async function buildExpectedCodexSkillTreeForStatus(options: {
  plugin: PluginMeta;
  scope: Scope;
  skillName: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<CodexSkillStagingTree | null> {
  if (!options.plugin.manifest.scripts?.artifacts?.render) {
    return null;
  }

  const renderResult = await runArtifactRenderer({
    event: 'install',
    plugin: options.plugin,
    platform: 'codex',
    scope: options.scope,
    cwd: options.cwd,
    commandEnv: options.env,
  });
  const renderConfig = await resolveArtifactRenderConfig({
    pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });
  const plan = validateArtifactPlan({
    manifest: options.plugin.manifest,
    plan: renderResult.plan,
    platform: 'codex',
    scope: options.scope,
    renderConfig,
    rendererDigest: renderResult.target.rendererDigest,
    manifestDigest: renderResult.target.manifestDigest,
  });
  const artifact = plan.artifacts.find((entry): entry is ValidatedArtifactPlanArtifact & CodexSkillArtifact =>
    entry.target === 'codex.skill' && entry.skillKey === options.skillName);
  if (!artifact) {
    return null;
  }

  const sourceDirs = renderResult.context.artifactSources.find((entry) =>
    entry.id === artifact.id && entry.target === artifact.target)?.sourceDirs ?? [];
  return createCodexSkillExpectedTree({
    artifact,
    sourceDirs,
  });
}

async function resolveCurrentArtifactConfigDigest(options: {
  plugin: PluginMeta;
  scope: Scope;
  artifact: Pick<GeneratedArtifact, 'id' | 'platform' | 'target' | 'refreshKeys'>;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  if (
    !options.plugin.manifest.scripts?.artifacts?.render ||
    !options.artifact.id ||
    !options.artifact.target ||
    !options.artifact.refreshKeys
  ) {
    return undefined;
  }

  const renderConfig = await resolveArtifactRenderConfig({
    pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });
  const manifestDigest = await calculateFileDigest(options.plugin.manifestPath);
  const rendererPath = await resolveBundledPluginFilePath({
    bundleRoot: options.plugin.rootDir,
    pluginRelativePath: options.plugin.manifest.scripts.artifacts.render.path,
    fieldName: 'scripts.artifacts.render.path',
  });
  const rendererDigest = await calculateFileDigest(rendererPath);

  return createArtifactConfigDigest({
    artifact: {
      id: options.artifact.id,
      platform: options.artifact.platform,
      target: options.artifact.target,
      refreshKeys: options.artifact.refreshKeys,
    },
    configValues: renderConfig.values,
    digestSalt: rendererDigest ?? manifestDigest,
  });
}

const CODEX_TRUST_GATED_PROJECT_KINDS = new Set<CodexProjectManagedKind>([
  'mcpServer',
  'instruction',
  'permission',
  'hook',
  'agent',
]);

function hasTrustGatedCodexProjectKinds(kinds: CodexProjectManagedKind[]): boolean {
  return kinds.some((kind) => CODEX_TRUST_GATED_PROJECT_KINDS.has(kind));
}

function trackingRecordHasTrustGatedCodexArtifacts(
  trackingRecord: TrackingPluginRecord | undefined,
): boolean {
  return (trackingRecord?.artifacts ?? []).some((artifact) =>
    artifact.kind === 'mcpServer' ||
      artifact.kind === 'instruction' ||
      artifact.kind === 'permission' ||
      artifact.kind === 'hook' ||
      artifact.kind === 'agent',
  );
}

function applyProjectTrustToItemState(
  state: Extract<RepoManagedProjectItemState, 'visible' | 'missing' | 'drifted' | 'orphan' | 'absent' | 'unknown'>,
  projectTrust: ProjectTrust,
  gated: boolean,
): RepoManagedProjectItemState {
  if (!gated || state !== 'visible') {
    return state;
  }

  if (projectTrust === 'untrusted') {
    return 'blockedByProjectTrust';
  }
  if (projectTrust === 'unknown') {
    return 'projectTrustUnknown';
  }
  return 'visible';
}

function itemDriftState(
  state: RepoManagedProjectItemState,
): 'yes' | 'no' | 'unknown' {
  switch (state) {
    case 'drifted':
    case 'missing':
    case 'orphan':
      return 'yes';
    case 'unknown':
      return 'unknown';
    default:
      return 'no';
  }
}

function createProjectItem(options: {
  kind: GeneratedArtifact['kind'];
  path: string;
  tracked: boolean;
  exists: boolean;
  state: RepoManagedProjectItemState;
  artifactKey?: string;
  diagnostics?: string[];
}): RepoManagedProjectItemReport {
  return {
    kind: options.kind,
    path: options.path,
    tracked: options.tracked,
    exists: options.exists,
    state: options.state,
    drift: itemDriftState(options.state),
    diagnostics: [...new Set(options.diagnostics ?? [])],
    ...(options.artifactKey === undefined ? {} : { artifactKey: options.artifactKey }),
  };
}

function sortRepoManagedItems(
  items: RepoManagedProjectItemReport[],
): RepoManagedProjectItemReport[] {
  const order = new Map(CODEX_REPO_MANAGED_ITEM_KIND_ORDER.map((kind, index) => [kind, index]));
  return [...items].sort((left, right) =>
    (order.get(left.kind) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.kind) ?? Number.MAX_SAFE_INTEGER) ||
    (left.artifactKey ?? '').localeCompare(right.artifactKey ?? '') ||
    left.path.localeCompare(right.path)
  );
}

function composeDynamicInstructionBlock(
  pluginName: string,
  artifacts: readonly ValidatedArtifactPlanArtifact[],
): CodexManagedInstructionBlock | undefined {
  const fragments = artifacts
    .filter((artifact) =>
      artifact.target === 'codex.developerInstructionsBlock' && artifact.state === 'present',
    )
    .map((artifact) => {
      if (typeof artifact.content !== 'string') {
        throw new Error(`Artifact "${artifact.id}" 的 instruction 必须提供 content。`);
      }
      return {
        artifactId: artifact.id,
        value: artifact.content,
      };
    });

  return fragments.length > 0
    ? composeManagedDeveloperInstructionsBlock(pluginName, fragments)
    : undefined;
}

function createPresentInstructionBlockDigest(block: CodexManagedInstructionBlock): string {
  return createGeneratedArtifactContentDigest({
    target: 'codex.developerInstructionsBlock',
    state: 'present',
    content: block.value.trim(),
  });
}

function summarizeRepoManagedItems(
  items: RepoManagedProjectItemReport[],
  applicable: boolean,
): RepoManagedProjectKindSummary {
  const summary: RepoManagedProjectKindSummary = {
    state: applicable ? 'absent' : 'not_applicable',
    totalCount: items.length,
    visibleCount: 0,
    missingCount: 0,
    driftedCount: 0,
    orphanCount: 0,
    blockedCount: 0,
    projectTrustUnknownCount: 0,
    unknownCount: 0,
    absentCount: 0,
  };

  for (const item of items) {
    switch (item.state) {
      case 'visible':
        summary.visibleCount += 1;
        break;
      case 'missing':
        summary.missingCount += 1;
        break;
      case 'drifted':
        summary.driftedCount += 1;
        break;
      case 'orphan':
        summary.orphanCount += 1;
        break;
      case 'blockedByProjectTrust':
        summary.blockedCount += 1;
        break;
      case 'projectTrustUnknown':
        summary.projectTrustUnknownCount += 1;
        break;
      case 'unknown':
        summary.unknownCount += 1;
        break;
      case 'absent':
        summary.absentCount += 1;
        break;
    }
  }

  if (!applicable && items.length === 0) {
    return summary;
  }

  if (summary.missingCount > 0) {
    summary.state = 'missing';
  } else if (summary.driftedCount > 0) {
    summary.state = 'drifted';
  } else if (summary.orphanCount > 0) {
    summary.state = 'orphan';
  } else if (summary.blockedCount > 0) {
    summary.state = 'blockedByProjectTrust';
  } else if (summary.projectTrustUnknownCount > 0) {
    summary.state = 'projectTrustUnknown';
  } else if (summary.unknownCount > 0) {
    summary.state = 'unknown';
  } else if (summary.visibleCount > 0) {
    summary.state = 'visible';
  } else {
    summary.state = 'absent';
  }

  return summary;
}

function resolveProjectArtifactVisibility(
  projectTrust: ProjectTrust,
): 'visible' | 'blockedByProjectTrust' | 'projectTrustUnknown' {
  if (projectTrust === 'untrusted') {
    return 'blockedByProjectTrust';
  }
  if (projectTrust === 'unknown') {
    return 'projectTrustUnknown';
  }
  return 'visible';
}

function describeFailedArtifactRefresh(
  artifact: Pick<GeneratedArtifactStatus, 'lastRefresh'>,
): string | undefined {
  if (artifact.lastRefresh?.status !== 'failed') {
    return undefined;
  }

  const triggerKeys = artifact.lastRefresh.triggerKeys?.length
    ? `，triggerKeys=${artifact.lastRefresh.triggerKeys.join(',')}`
    : '';
  const errorSummary = artifact.lastRefresh.error
    ? `：${artifact.lastRefresh.error}`
    : '';
  return `最近一次 ${artifact.lastRefresh.event} 失败（${artifact.lastRefresh.updatedAt}${triggerKeys}）${errorSummary}`;
}

async function buildCodexManagedArtifactStatuses(options: {
  plugin: PluginMeta;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
  repoRoot: string;
  projectTrust: ProjectTrust;
  projectLayerEvidence: CodexProjectLayerEvidence;
  scopeConfig: { snapshot: CodexConfigSnapshot };
  generatedArtifacts: GeneratedArtifactStatus[];
}): Promise<ManagedArtifactStatus[]> {
  const trackedDynamicArtifacts = options.generatedArtifacts.filter((artifact) =>
    artifact.id !== undefined && artifact.target !== undefined,
  );
  if (trackedDynamicArtifacts.length === 0) {
    return [];
  }

  const trackedRoleArtifacts = trackedDynamicArtifacts.filter(
    (artifact) =>
      artifact.target === 'codex.agentRole' &&
      resolveCodexRoleIdentity({
        target: artifact.target,
        roleKey: artifact.roleKey,
        artifactKey: artifact.artifactKey,
      }),
  );
  const currentScopeRoleNamespace = trackedRoleArtifacts.length > 0
    ? await resolveCodexRoleNamespace(resolveCodexPaths(options.cwd, options.scope, options.env).configTomlPath, {
        awManagedTableKeys: trackedRoleArtifacts
          .map((artifact) =>
            resolveCodexRoleIdentity({
              target: artifact.target,
              roleKey: artifact.roleKey,
              artifactKey: artifact.artifactKey,
            }))
          .filter((roleKey): roleKey is string => Boolean(roleKey)),
        awManagedRoleLayerPaths: trackedRoleArtifacts.map((artifact) => artifact.path),
      })
    : undefined;
  const higherPriorityRoleNamespaces =
    options.scope === 'user' && options.projectTrust === 'trusted' && trackedRoleArtifacts.length > 0
      ? await resolveCodexHigherPriorityRoleNamespaces(options.cwd, options.repoRoot)
      : [];
  const presentInstructionCount = trackedDynamicArtifacts.filter((artifact) =>
    artifact.target === 'codex.developerInstructionsBlock' && artifact.state === 'present',
  ).length;
  const trackedInstructionArtifacts = trackedDynamicArtifacts.filter((artifact) =>
    artifact.target === 'codex.developerInstructionsBlock',
  );
  const instructionArtifactDigests = trackedInstructionArtifacts.flatMap((artifact) =>
    artifact.contentDigest ? [artifact.contentDigest] : [],
  );
  const hasSharedInstructionBlockDigest =
    trackedInstructionArtifacts.length > 0 &&
    instructionArtifactDigests.length === trackedInstructionArtifacts.length &&
    new Set(instructionArtifactDigests).size === 1;

  return Promise.all(trackedDynamicArtifacts.map(async (artifact) => {
    const diagnostics: string[] = [];
    let currentConfigDigest: string | undefined;
    try {
      currentConfigDigest = await resolveCurrentArtifactConfigDigest({
        plugin: options.plugin,
        scope: options.scope,
        artifact: {
          id: artifact.id,
          platform: 'codex',
          target: artifact.target,
          refreshKeys: artifact.refreshKeys,
        },
        cwd: options.cwd,
        env: options.env,
      });
    } catch (error) {
      diagnostics.push(`无法计算当前 config digest：${error instanceof Error ? error.message : String(error)}`);
    }

    if (artifact.target === 'codex.developerInstructionsBlock') {
      const instructionBlock =
        options.scopeConfig.snapshot.developerInstructions.managedBlocks[options.plugin.manifest.name];
      const hasBlock = Boolean(instructionBlock);
      const sessionVisibility =
        options.scope === 'project'
          ? hasBlock
            ? resolveProjectArtifactVisibility(options.projectTrust)
            : 'absent'
          : !hasBlock
            ? 'absent'
            : options.projectTrust === 'trusted' &&
                (
                  options.projectLayerEvidence.currentLayerDeveloperInstructionsDefined ||
                  options.projectLayerEvidence.ancestorDeveloperInstructionsDefined
                )
              ? 'unknownByExternalLayer'
              : options.projectTrust === 'trusted' &&
                  options.projectLayerEvidence.projectLayerDeveloperInstructionsDefined
                ? 'shadowedByProjectDeveloperInstructions'
                : 'visible';
      let currentContentDigest: string | undefined;
      let health: ManagedArtifactStatus['health'];

      if (artifact.state === 'disabled') {
        currentContentDigest = !hasBlock
          ? createGeneratedArtifactContentDigest({
              target: artifact.target,
              state: 'disabled',
              disabledReason: artifact.disabledReason ?? null,
            })
          : createGeneratedArtifactContentDigest({
              target: artifact.target,
              state: 'present',
              content: instructionBlock.value.trim(),
            });
        const canCompareInstructionBlockDigest =
          hasBlock && hasSharedInstructionBlockDigest && artifact.contentDigest;
        if (
          canCompareInstructionBlockDigest &&
          currentContentDigest !== artifact.contentDigest
        ) {
          health = 'contentDrift';
          diagnostics.push('当前 managed developer_instructions block 与 tracking contentDigest 不一致。');
        } else if (hasBlock && presentInstructionCount === 0) {
          health = 'contentDrift';
          diagnostics.push('artifact tracking 标记为 disabled，但当前 managed developer_instructions block 仍然存在。');
        } else if (artifact.lastRefresh?.status === 'failed') {
          health = 'recentRefreshFailed';
          diagnostics.push(describeFailedArtifactRefresh(artifact) ?? '最近一次 artifact refresh 失败。');
        } else if (
          artifact.configDigest &&
          currentConfigDigest &&
          artifact.configDigest !== currentConfigDigest
        ) {
          health = 'configDigestStale';
          diagnostics.push('tracking configDigest 与当前 render config 不一致。');
        } else {
          health = 'disabledByConfig';
        }
      } else if (!hasBlock) {
        health = 'blockMissing';
        diagnostics.push('当前 scope 的 AW managed developer_instructions block 缺失。');
      } else {
        currentContentDigest = createGeneratedArtifactContentDigest({
          target: artifact.target,
          state: 'present',
          content: instructionBlock.value.trim(),
        });
        const canCompareInstructionBlockDigest =
          artifact.contentDigest &&
          (presentInstructionCount === 1 || hasSharedInstructionBlockDigest);
        if (
          canCompareInstructionBlockDigest &&
          currentContentDigest !== artifact.contentDigest
        ) {
          health = 'contentDrift';
          diagnostics.push('当前 managed developer_instructions block 与 tracking contentDigest 不一致。');
        } else if (artifact.lastRefresh?.status === 'failed') {
          health = 'recentRefreshFailed';
          diagnostics.push(describeFailedArtifactRefresh(artifact) ?? '最近一次 artifact refresh 失败。');
        } else if (
          artifact.configDigest &&
          currentConfigDigest &&
          artifact.configDigest !== currentConfigDigest
        ) {
          health = 'configDigestStale';
          diagnostics.push('tracking configDigest 与当前 render config 不一致。');
        } else {
          health = 'healthy';
        }
      }

      return {
        ...artifact,
        tracked: true,
        currentConfigDigest,
        currentContentDigest,
        health,
        sessionVisibility,
        diagnostics,
      };
    }

    if (artifact.target === 'codex.skill') {
      const rootStats = artifact.state === 'disabled'
        ? null
        : await fs.lstat(artifact.path).catch(() => null);
      const skillRootExists = Boolean(rootStats);
      const validSkillRoot = Boolean(rootStats?.isDirectory() && !rootStats.isSymbolicLink());
      let runtimeTree: Record<string, Buffer> | null = null;
      let runtimeTreeError: string | undefined;
      if (validSkillRoot) {
        try {
          runtimeTree = await readCodexSkillRuntimeTree(artifact.path);
        } catch (error) {
          runtimeTreeError = error instanceof Error ? error.message : String(error);
        }
      } else if (skillRootExists) {
        runtimeTreeError = 'dynamic skill runtime 根路径不是受支持的真实目录。';
      }
      const currentContentDigest = runtimeTree
        ? createCodexSkillStagingTreeContentDigest({
            skillKey: artifact.artifactKey ?? path.basename(artifact.path),
            files: runtimeTree,
          })
        : undefined;
      let health: ManagedArtifactStatus['health'];

      if (artifact.state === 'disabled') {
        if (artifact.lastRefresh?.status === 'failed') {
          health = 'recentRefreshFailed';
          diagnostics.push(describeFailedArtifactRefresh(artifact) ?? '最近一次 artifact refresh 失败。');
        } else if (
          artifact.configDigest &&
          currentConfigDigest &&
          artifact.configDigest !== currentConfigDigest
        ) {
          health = 'configDigestStale';
          diagnostics.push('tracking configDigest 与当前 render config 不一致。');
        } else {
          health = 'disabledByConfig';
        }
      } else if (!skillRootExists) {
        health = 'missing';
        diagnostics.push('当前 scope 缺少受管 dynamic skill runtime。');
      } else if (runtimeTreeError) {
        health = 'contentDrift';
        diagnostics.push(runtimeTreeError);
      } else if (!runtimeTree) {
        health = 'contentDrift';
        diagnostics.push('dynamic skill runtime 缺少 SKILL.md 或 agents/openai.yaml。');
      } else if (artifact.contentDigest && currentContentDigest && artifact.contentDigest !== currentContentDigest) {
        health = 'contentDrift';
        diagnostics.push('当前 dynamic skill runtime 内容与 tracking contentDigest 不一致。');
      } else if (artifact.lastRefresh?.status === 'failed') {
        health = 'recentRefreshFailed';
        diagnostics.push(describeFailedArtifactRefresh(artifact) ?? '最近一次 artifact refresh 失败。');
      } else if (
        artifact.configDigest &&
        currentConfigDigest &&
        artifact.configDigest !== currentConfigDigest
      ) {
        health = 'configDigestStale';
        diagnostics.push('tracking configDigest 与当前 render config 不一致。');
      } else {
        health = 'healthy';
      }

      return {
        ...artifact,
        tracked: true,
        currentConfigDigest,
        currentContentDigest,
        health,
        sessionVisibility: options.scope === 'project'
          ? resolveProjectArtifactVisibility(options.projectTrust)
          : 'visible',
        diagnostics,
      };
    }

    const roleKey = resolveCodexRoleIdentity({
      target: artifact.target,
      roleKey: artifact.roleKey,
      artifactKey: artifact.artifactKey,
    });
    if (!roleKey) {
      diagnostics.push('无法从 tracking 或静态 metadata 恢复 codex.agentRole 的真实 roleKey。');
      return {
        ...artifact,
        tracked: true,
        currentConfigDigest,
        currentContentDigest: undefined,
        health: 'unavailable',
        sessionVisibility: 'absent',
        diagnostics,
      };
    }
    const registration = roleKey
      ? options.scopeConfig.snapshot.agents[roleKey]
      : undefined;
    const namespaceRole = roleKey
      ? currentScopeRoleNamespace?.roles.find((role) => role.tableKey === roleKey)
      : undefined;
    const expectedRoleLayerPath = path.normalize(artifact.path);
    const registeredRoleLayerPath = registration?.configFile
      ? path.normalize(path.resolve(path.dirname(resolveCodexPaths(options.cwd, options.scope, options.env).configTomlPath), registration.configFile))
      : undefined;
    const registrationHealthy = Boolean(
      roleKey &&
      registration &&
      registeredRoleLayerPath === expectedRoleLayerPath,
    );
    const roleLayerExists = await fs.pathExists(artifact.path);
    let currentContentDigest: string | undefined;
    let health: ManagedArtifactStatus['health'];

    if (artifact.state === 'disabled') {
      if (registration || roleLayerExists) {
        health = registration && !registrationHealthy ? 'registrationDrift' : 'contentDrift';
        diagnostics.push('artifact tracking 标记为 disabled，但当前 role registration 或 role layer 仍然存在。');
      } else if (artifact.lastRefresh?.status === 'failed') {
        health = 'recentRefreshFailed';
        diagnostics.push(describeFailedArtifactRefresh(artifact) ?? '最近一次 artifact refresh 失败。');
      } else if (
        artifact.configDigest &&
        currentConfigDigest &&
        artifact.configDigest !== currentConfigDigest
      ) {
        health = 'configDigestStale';
        diagnostics.push('tracking configDigest 与当前 render config 不一致。');
      } else {
        health = 'disabledByConfig';
      }
    } else if (!registration) {
      health = 'registrationDrift';
      diagnostics.push('当前 scope 缺少受管 role registration。');
    } else if (!registrationHealthy) {
      health = 'registrationDrift';
      diagnostics.push(
        registeredRoleLayerPath
          ? `role registration 当前指向 ${registeredRoleLayerPath}，未指向 tracking role layer ${expectedRoleLayerPath}。`
          : 'role registration 缺少 config_file，无法指向 tracking role layer。',
      );
    } else if (!roleLayerExists) {
      health = 'roleLayerMissing';
      diagnostics.push('tracking role layer 文件缺失。');
    } else {
      const roleFileContent = await fs.readFile(artifact.path, 'utf8');
      currentContentDigest = createGeneratedArtifactContentDigest({
        target: artifact.target,
        state: 'present',
        roleKey,
        registration: {
          description: registration.description?.trim(),
        },
        roleFile: roleFileContent,
      });
      const descriptionMismatch = namespaceRole
        ? getCodexRoleDescriptionMismatch(namespaceRole)
        : undefined;
      if (descriptionMismatch) {
        health = 'registrationDrift';
        diagnostics.push('role registration.description 与 role layer description 不一致。');
      } else if (artifact.contentDigest && currentContentDigest !== artifact.contentDigest) {
        health = 'contentDrift';
        diagnostics.push('当前 role registration / role layer 内容与 tracking contentDigest 不一致。');
      } else if (artifact.lastRefresh?.status === 'failed') {
        health = 'recentRefreshFailed';
        diagnostics.push(describeFailedArtifactRefresh(artifact) ?? '最近一次 artifact refresh 失败。');
      } else if (
        artifact.configDigest &&
        currentConfigDigest &&
        artifact.configDigest !== currentConfigDigest
      ) {
        health = 'configDigestStale';
        diagnostics.push('tracking configDigest 与当前 render config 不一致。');
      } else {
        health = 'healthy';
      }
    }

    const sessionVisibility =
      !registrationHealthy || !roleLayerExists
        ? 'absent'
        : options.scope === 'project'
          ? resolveProjectArtifactVisibility(options.projectTrust)
          : options.projectTrust === 'trusted' && roleKey
            ? diagnoseCodexRoleVisibility(roleKey, higherPriorityRoleNamespaces).state
            : 'visible';

    return {
      ...artifact,
      tracked: true,
      currentConfigDigest,
      currentContentDigest,
      health,
      sessionVisibility,
      diagnostics,
    };
  }));
}

function applyDeclaredDynamicArtifactIdentity(
  generatedArtifacts: GeneratedArtifactStatus[],
  declaredTargets: PluginArtifactTargetDefinition[],
): GeneratedArtifactStatus[] {
  const declaredByKey = new Map(
    declaredTargets.map((target) => [`${target.id}:${target.target}`, target]),
  );

  return generatedArtifacts.map((artifact) => {
    if (!artifact.id || !artifact.target) {
      return artifact;
    }

    const declaration = declaredByKey.get(`${artifact.id}:${artifact.target}`);
    if (!declaration || artifact.target !== 'codex.agentRole') {
      return artifact;
    }

    const resolvedRoleKey = resolveCodexRoleIdentity({
      target: artifact.target,
      roleKey: artifact.roleKey ?? declaration.roleKey,
      artifactKey: artifact.artifactKey,
    });
    if (!resolvedRoleKey) {
      return artifact;
    }

    return {
      ...artifact,
      roleKey: resolvedRoleKey,
    };
  });
}

export class CodexAdapter implements PlatformAdapter {
  readonly name = 'codex' as const;

  private readonly cwd: string;
  private readonly nativeCliRunner?: NativeCliRunner;
  private readonly env: NodeJS.ProcessEnv;
  private commandEventSink: CommandEventSink = NOOP_COMMAND_EVENT_SINK;

  constructor(cwd: string, env?: NodeJS.ProcessEnv);
  constructor(
    cwd: string,
    env: NodeJS.ProcessEnv,
    codexAppServerRunner: CodexAppServerProcessRunner,
  );
  constructor(
    cwd: string,
    nativeCliRunner?: NativeCliRunner,
    env?: NodeJS.ProcessEnv,
    codexAppServerRunner?: CodexAppServerProcessRunner,
  );
  constructor(
    cwd: string,
    nativeCliRunnerOrEnv?: NativeCliRunner | NodeJS.ProcessEnv,
    envOrAppServerRunner: NodeJS.ProcessEnv | CodexAppServerProcessRunner = process.env,
    _codexAppServerRunner?: CodexAppServerProcessRunner,
  ) {
    this.cwd = cwd;
    if (typeof nativeCliRunnerOrEnv === 'function') {
      this.nativeCliRunner = nativeCliRunnerOrEnv;
      this.env =
        typeof envOrAppServerRunner === 'function' ? process.env : envOrAppServerRunner;
    } else {
      this.env = nativeCliRunnerOrEnv ?? process.env;
    }
  }

  setCommandEventSink(sink: CommandEventSink | undefined): void {
    this.commandEventSink = sink ?? NOOP_COMMAND_EVENT_SINK;
  }

  private async emitCommandEvent(event: CommandEvent): Promise<void> {
    await this.commandEventSink(event);
  }

  private async emitNativeMarketplaceEvent(options: {
    plugin: string;
    scope: Scope;
    marketplacePath: string;
    operation: NativeMarketplaceOperation;
    phase: NativeMarketplaceEventData['phase'];
    errorCategory?: string;
    suggestion?: string;
  }): Promise<void> {
    await this.emitCommandEvent({
      type: 'native:marketplace',
      source: {
        platform: 'codex',
        plugin: options.plugin,
        scope: options.scope,
      },
      data: {
        platform: 'codex',
        scope: options.scope,
        plugin: options.plugin,
        marketplaceName: MARKETPLACE_NAME,
        marketplacePath: options.marketplacePath,
        operation: options.operation,
        phase: options.phase,
        ...(options.errorCategory ? { errorCategory: options.errorCategory } : {}),
        ...(options.suggestion ? { suggestion: options.suggestion } : {}),
      },
    });
  }

  private async emitNativeRpcEvent(options: {
    plugin: string;
    scope: Scope;
    pluginId: string;
    method: NativeRpcMethod;
    phase: NativeRpcEventData['phase'];
    durationMs: number;
    nativeWriteSucceeded?: boolean;
    errorCategory?: string;
    suggestion?: string;
  }): Promise<void> {
    await this.emitCommandEvent({
      type: 'native:rpc',
      source: {
        platform: 'codex',
        plugin: options.plugin,
        scope: options.scope,
      },
      data: {
        platform: 'codex',
        scope: options.scope,
        plugin: options.plugin,
        pluginId: options.pluginId,
        method: options.method,
        phase: options.phase,
        durationMs: options.durationMs,
        ...(options.nativeWriteSucceeded === undefined
          ? {}
          : { nativeWriteSucceeded: options.nativeWriteSucceeded }),
        ...(options.errorCategory ? { errorCategory: options.errorCategory } : {}),
        ...(options.suggestion ? { suggestion: options.suggestion } : {}),
      },
    });
  }

  private async emitNativeRecoveryEvent(options: {
    plugin: string;
    scope: Scope;
    pluginId: string;
    operation: NativeRecoveryOperation;
    phase: NativeRecoveryEventData['phase'];
    state: NativeRecoveryState;
    nativeWriteSucceeded: boolean;
    recoveryBreadcrumbPersisted: boolean;
    errorCategory?: string;
    suggestion?: string;
  }): Promise<void> {
    await this.emitCommandEvent({
      type: 'native:recovery',
      source: {
        platform: 'codex',
        plugin: options.plugin,
        scope: options.scope,
      },
      data: {
        platform: 'codex',
        scope: options.scope,
        plugin: options.plugin,
        pluginId: options.pluginId,
        operation: options.operation,
        phase: options.phase,
        state: options.state,
        nativeWriteSucceeded: options.nativeWriteSucceeded,
        recoveryBreadcrumbPersisted: options.recoveryBreadcrumbPersisted,
        ...(options.errorCategory ? { errorCategory: options.errorCategory } : {}),
        ...(options.suggestion ? { suggestion: options.suggestion } : {}),
      },
    });
  }

  private async emitNativePostCheckEvent(options: {
    plugin: string;
    scope: Scope;
    pluginId: string;
    operation: NativePostCheckOperation;
    phase: NativePostCheckEventData['phase'];
    pluginEnabled: boolean | null;
    configEntryPresent: boolean | null;
    pluginInstalled: boolean | null;
    activeCachePath: string | null;
    errorCategory?: string;
    suggestion?: string;
  }): Promise<void> {
    await this.emitCommandEvent({
      type: 'native:post-check',
      source: {
        platform: 'codex',
        plugin: options.plugin,
        scope: options.scope,
      },
      data: {
        platform: 'codex',
        scope: options.scope,
        plugin: options.plugin,
        pluginId: options.pluginId,
        operation: options.operation,
        phase: options.phase,
        pluginEnabled: options.pluginEnabled,
        configEntryPresent: options.configEntryPresent,
        pluginInstalled: options.pluginInstalled,
        activeCachePath: options.activeCachePath,
        ...(options.errorCategory ? { errorCategory: options.errorCategory } : {}),
        ...(options.suggestion ? { suggestion: options.suggestion } : {}),
      },
    });
  }

  private async writeRecoveryBreadcrumbWithEvent(options: {
    plugin: string;
    scope: Scope;
    state: NativeRecoveryState;
    reason: string;
    marketplacePath?: string;
    pluginVersion?: string;
    bundleFingerprint?: string | null;
    activeCachePath?: string | null;
    lastError?: string | null;
  }): Promise<void> {
    const pluginId = normalizeCodexUserPluginId(options.plugin);
    await this.emitNativeRecoveryEvent({
      plugin: options.plugin,
      scope: options.scope,
      pluginId,
      operation: 'write',
      phase: 'start',
      state: options.state,
      nativeWriteSucceeded: true,
      recoveryBreadcrumbPersisted: false,
    });
    try {
      await writeCodexNativeRecoveryBreadcrumb({
        pluginName: options.plugin,
        state: options.state,
        reason: options.reason,
        marketplacePath: options.marketplacePath,
        pluginVersion: options.pluginVersion,
        bundleFingerprint: options.bundleFingerprint ?? undefined,
        activeCachePath: options.activeCachePath ?? undefined,
        lastError: options.lastError ?? undefined,
        env: this.env,
      });
      await this.emitNativeRecoveryEvent({
        plugin: options.plugin,
        scope: options.scope,
        pluginId,
        operation: 'write',
        phase: 'success',
        state: options.state,
        nativeWriteSucceeded: true,
        recoveryBreadcrumbPersisted: true,
      });
    } catch (error) {
      await this.emitNativeRecoveryEvent({
        plugin: options.plugin,
        scope: options.scope,
        pluginId,
        operation: 'write',
        phase: 'error',
        state: options.state,
        nativeWriteSucceeded: true,
        recoveryBreadcrumbPersisted: false,
        errorCategory: 'breadcrumb_write_failed',
        suggestion: createCodexRecoverySuggestion('write', options.state, false),
      });
      throw error;
    }
  }

  private async updateRecoveryBreadcrumbWithEvent(options: {
    plugin: string;
    scope: Scope;
    state: NativeRecoveryState;
    reason: string;
    pluginVersion?: string | null;
    bundleFingerprint?: string | null;
    activeCachePath?: string | null;
    lastError?: string | null;
  }): Promise<void> {
    const pluginId = normalizeCodexUserPluginId(options.plugin);
    await this.emitNativeRecoveryEvent({
      plugin: options.plugin,
      scope: options.scope,
      pluginId,
      operation: 'update',
      phase: 'start',
      state: options.state,
      nativeWriteSucceeded: true,
      recoveryBreadcrumbPersisted: true,
    });
    try {
      await updateCodexNativeRecoveryBreadcrumb({
        pluginName: options.plugin,
        state: options.state,
        reason: options.reason,
        pluginVersion: options.pluginVersion ?? undefined,
        bundleFingerprint: options.bundleFingerprint ?? undefined,
        activeCachePath: options.activeCachePath ?? undefined,
        lastError: options.lastError ?? undefined,
        env: this.env,
      });
      await this.emitNativeRecoveryEvent({
        plugin: options.plugin,
        scope: options.scope,
        pluginId,
        operation: 'update',
        phase: 'success',
        state: options.state,
        nativeWriteSucceeded: true,
        recoveryBreadcrumbPersisted: true,
      });
    } catch (error) {
      await this.emitNativeRecoveryEvent({
        plugin: options.plugin,
        scope: options.scope,
        pluginId,
        operation: 'update',
        phase: 'error',
        state: options.state,
        nativeWriteSucceeded: true,
        recoveryBreadcrumbPersisted: true,
        errorCategory: 'breadcrumb_update_failed',
        suggestion: createCodexRecoverySuggestion('update', options.state, true),
      });
      throw error;
    }
  }

  private async deleteRecoveryBreadcrumbWithEvent(options: {
    plugin: string;
    scope: Scope;
    state: NativeRecoveryState;
    recoveryBreadcrumbPersistedBefore?: boolean;
  }): Promise<void> {
    const pluginId = normalizeCodexUserPluginId(options.plugin);
    const recoveryBreadcrumbPersistedBefore = options.recoveryBreadcrumbPersistedBefore ?? true;
    await this.emitNativeRecoveryEvent({
      plugin: options.plugin,
      scope: options.scope,
      pluginId,
      operation: 'delete',
      phase: 'start',
      state: options.state,
      nativeWriteSucceeded: true,
      recoveryBreadcrumbPersisted: recoveryBreadcrumbPersistedBefore,
    });
    try {
      await deleteCodexNativeRecoveryBreadcrumb(pluginId, this.env);
      await this.emitNativeRecoveryEvent({
        plugin: options.plugin,
        scope: options.scope,
        pluginId,
        operation: 'delete',
        phase: 'success',
        state: options.state,
        nativeWriteSucceeded: true,
        recoveryBreadcrumbPersisted: false,
      });
    } catch (error) {
      await this.emitNativeRecoveryEvent({
        plugin: options.plugin,
        scope: options.scope,
        pluginId,
        operation: 'delete',
        phase: 'error',
        state: options.state,
        nativeWriteSucceeded: true,
        recoveryBreadcrumbPersisted: recoveryBreadcrumbPersistedBefore,
        errorCategory: 'breadcrumb_delete_failed',
        suggestion: createCodexRecoverySuggestion('delete', options.state, true),
      });
      throw error;
    }
  }

  async detect(cwd: string): Promise<boolean> {
    const detection = await detectEnvironment(cwd, this.env);
    return detection.codex.available;
  }

  async installPlugin(
    plugin: PluginMeta,
    scope: Scope,
    options?: {
      catalogResolution?: CatalogResolution;
      marketplacePrepared?: boolean;
    },
  ): Promise<void> {
    await this.installPluginFromMarketplace(plugin, scope, options);
  }

  async installPluginFromMarketplace(
    plugin: PluginMeta,
    scope: Scope,
    options: {
      marketplacePath?: string;
      catalogResolution?: CatalogResolution;
      marketplacePrepared?: boolean;
    } = {},
  ): Promise<void> {
    if (scope === 'project') {
      if (plugin.manifest.apps) {
        throw new Error(
          `${plugin.manifest.name} 声明了 apps，Codex project scope 暂不支持 apps；请改用 --scope user 或拆分插件。`,
        );
      }
      if (!hasCodexProjectManagedArtifacts(plugin)) {
        throw new Error(
          `${plugin.manifest.name} 不包含任何 repo-managed artifacts，Codex project scope 不支持纯 native-only 安装。`,
        );
      }
    }

    if (!requiresCodexNativePlugin(plugin, scope)) {
      return;
    }

    if (!options.marketplacePrepared) {
      await ensureLocalMarketplace(this.env, undefined, options.catalogResolution);
    }
    const awHome = await resolveAwHomeCanonical(this.env);
    const userPaths = resolveCodexPaths(this.cwd, 'user', this.env);
    const userConfig = await readCodexConfigFile(userPaths.configTomlPath);
    const externalOwnership = detectCodexExternalOwnership(
      userConfig.snapshot.plugins,
      plugin.manifest.name,
      MARKETPLACE_NAME,
    );
    if (externalOwnership?.present) {
      throw new Error(externalOwnership.details ?? '同名插件已由外部 marketplace 管理。');
    }

    const activeSkillsRoot = path.join(
      awHome,
      'plugins',
      plugin.manifest.name,
      'codex',
      'skills',
    );
    if (await fs.pathExists(activeSkillsRoot)) {
      await validateSkillDirectoriesRoot(activeSkillsRoot, 'codex.skill');
    }
    if (options.marketplacePath && await fs.pathExists(options.marketplacePath)) {
      const marketplaceRoot = path.dirname(path.dirname(path.dirname(options.marketplacePath)));
      const stagedSkillsRoot = path.join(
        marketplaceRoot,
        'plugins',
        plugin.manifest.name,
        'codex',
        'skills',
      );
      if (await fs.pathExists(stagedSkillsRoot)) {
        await validateSkillDirectoriesRoot(stagedSkillsRoot, 'codex.skill');
      }
    }

    if (!isCodexMarketplaceRegistered(userConfig.snapshot.marketplaces[MARKETPLACE_NAME], awHome)) {
      await this.emitNativeMarketplaceEvent({
        plugin: plugin.manifest.name,
        scope,
        marketplacePath: awHome,
        operation: 'add',
        phase: 'start',
      });
      try {
        await runNativeCliChecked(
          buildCodexMarketplaceAddInvocation(awHome, this.cwd, this.env),
          this.nativeCliRunner,
        );
        await this.emitNativeMarketplaceEvent({
          plugin: plugin.manifest.name,
          scope,
          marketplacePath: awHome,
          operation: 'add',
          phase: 'success',
        });
      } catch (error) {
        await this.emitNativeMarketplaceEvent({
          plugin: plugin.manifest.name,
          scope,
          marketplacePath: awHome,
          operation: 'add',
          phase: 'error',
          errorCategory: 'codexNativeCliUnavailable',
          suggestion: createCodexMarketplaceSuggestion(awHome, error),
        });
        throw createCodexMarketplaceCliError('add', awHome, error);
      }
    }

    await this.emitNativeMarketplaceEvent({
      plugin: plugin.manifest.name,
      scope,
      marketplacePath: awHome,
      operation: 'list',
      phase: 'start',
    });
    try {
      await runNativeCliChecked(
        buildCodexMarketplaceListInvocation(this.cwd, this.env),
        this.nativeCliRunner,
      );
      await this.emitNativeMarketplaceEvent({
        plugin: plugin.manifest.name,
        scope,
        marketplacePath: awHome,
        operation: 'list',
        phase: 'success',
      });
    } catch (error) {
      await this.emitNativeMarketplaceEvent({
        plugin: plugin.manifest.name,
        scope,
        marketplacePath: awHome,
        operation: 'list',
        phase: 'error',
        errorCategory: 'codexNativeCliUnavailable',
        suggestion: createCodexMarketplaceSuggestion(awHome, error),
      });
      throw createCodexMarketplaceCliError('list', awHome, error);
    }

    await this.emitNativeMarketplaceEvent({
      plugin: plugin.manifest.name,
      scope,
      marketplacePath: awHome,
      operation: 'verify',
      phase: 'start',
    });
    const refreshedConfig = await readCodexConfigFile(userPaths.configTomlPath);
    const refreshedMarketplace = refreshedConfig.snapshot.marketplaces[MARKETPLACE_NAME];
    if (!isCodexMarketplaceRegistered(refreshedMarketplace, awHome)) {
      const reasonCode = getCodexMarketplaceVerificationReason(refreshedMarketplace, awHome);
      await this.emitNativeMarketplaceEvent({
        plugin: plugin.manifest.name,
        scope,
        marketplacePath: awHome,
        operation: 'verify',
        phase: 'error',
        errorCategory: reasonCode,
        suggestion: createCodexMarketplaceSuggestion(awHome),
      });
      throw new CodexNativeCliLifecycleError(
        reasonCode,
        createCodexMarketplaceVerificationError(awHome, userPaths.configTomlPath).message,
      );
    }
    await this.emitNativeMarketplaceEvent({
      plugin: plugin.manifest.name,
      scope,
      marketplacePath: awHome,
      operation: 'verify',
      phase: 'success',
    });

    const codexDynamicSkillSyncKeys = scope === 'user'
      ? await resolveCodexUserDynamicSkillSyncKeys({
          cwd: this.cwd,
          plugin,
          env: this.env,
        })
      : [];
    if (scope === 'user') {
      await materializeStagedMarketplaceCodexDynamicSkills({
        rootDir: awHome,
        pluginName: plugin.manifest.name,
        skillKeys: codexDynamicSkillSyncKeys,
      });
      if (options.marketplacePath && await fs.pathExists(options.marketplacePath)) {
        const marketplaceRoot = path.dirname(path.dirname(path.dirname(options.marketplacePath)));
        const stagedPluginRoot = path.join(marketplaceRoot, 'plugins', plugin.manifest.name);
        if (await fs.pathExists(stagedPluginRoot)) {
          const activePluginRoot = path.join(awHome, 'plugins', plugin.manifest.name);
          for (const relativePath of ['.codex-plugin', 'codex']) {
            const stagedPath = path.join(stagedPluginRoot, relativePath);
            if (!(await fs.pathExists(stagedPath))) {
              continue;
            }
            const activePath = path.join(activePluginRoot, relativePath);
            await fs.remove(activePath);
            await fs.copy(stagedPath, activePath, {
              overwrite: true,
              errorOnExist: false,
            });
          }
        }
      }
    }

    if (await fs.pathExists(activeSkillsRoot)) {
      await validateSkillDirectoriesRoot(activeSkillsRoot, 'codex.skill');
    }

    const marketplacePath = awHome;
    const pluginId = normalizeCodexUserPluginId(plugin.manifest.name);
    const installStartedAt = Date.now();
    await this.emitNativeRpcEvent({
      plugin: plugin.manifest.name,
      scope,
      pluginId,
      method: 'codex plugin add',
      phase: 'start',
      durationMs: 0,
    });
    try {
      await runNativeCliChecked(
        buildCodexPluginAddInvocation(pluginId, this.cwd, this.env),
        this.nativeCliRunner,
      );
    } catch (error) {
      await this.emitNativeRpcEvent({
        plugin: plugin.manifest.name,
        scope,
        pluginId,
        method: 'codex plugin add',
        phase: 'error',
        durationMs: Date.now() - installStartedAt,
        nativeWriteSucceeded: false,
        errorCategory: 'codexNativeCliUnavailable',
        suggestion: createCodexMarketplaceSuggestion(awHome, error),
      });
      throw createCodexPluginCliError('install', pluginId, error);
    }
    await this.emitNativeRpcEvent({
      plugin: plugin.manifest.name,
      scope,
      pluginId,
      method: 'codex plugin add',
      phase: 'success',
      durationMs: Date.now() - installStartedAt,
      nativeWriteSucceeded: true,
    });

    try {
      await this.writeRecoveryBreadcrumbWithEvent({
        plugin: plugin.manifest.name,
        scope,
        state: 'pending_after_native_write',
        reason: 'native_write_succeeded_post_steps_pending',
        marketplacePath,
        pluginVersion: plugin.manifest.version,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Codex 原生插件 ${plugin.manifest.name}@aw 已写入，但 AW 没有持久化恢复证据：${detail}。当前不能承诺后续 cleanup / uninstall 一定具备自动授权；请先运行 \`aw status --verbose\` 检查 breadcrumb、config 和 cache 诊断，再决定后续修复或清理。`,
      );
    }

    await this.emitNativePostCheckEvent({
      plugin: plugin.manifest.name,
      scope,
      pluginId,
      operation: 'install',
      phase: 'start',
      pluginEnabled: null,
      configEntryPresent: null,
      pluginInstalled: null,
      activeCachePath: null,
    });
    try {
      await runNativeCliChecked(
        buildCodexPluginListInvocation(this.cwd, this.env),
        this.nativeCliRunner,
      );
    } catch (error) {
      await this.emitNativePostCheckEvent({
        plugin: plugin.manifest.name,
        scope,
        pluginId,
        operation: 'install',
        phase: 'error',
        pluginEnabled: null,
        configEntryPresent: null,
        pluginInstalled: null,
        activeCachePath: null,
        errorCategory: 'codexNativeCliUnavailable',
        suggestion: createCodexNativePostCheckSuggestion('install'),
      });
      await this.updateRecoveryBreadcrumbWithEvent({
        plugin: plugin.manifest.name,
        scope,
        state: 'post_check_failed',
        reason: 'native_install_post_check_cli_list_failed',
        lastError: nativeCliFailureHint(error),
      });
      throw createCodexPluginCliError('list', pluginId, error);
    }
    const postCheck = await checkCodexNativeInstallPostCheck(plugin.manifest.name, this.env);
    if (!postCheck.ok) {
      const detail = describeCodexNativeInstallPostCheckFailure(postCheck.state);
      await this.emitNativePostCheckEvent({
        plugin: plugin.manifest.name,
        scope,
        pluginId,
        operation: 'install',
        phase: 'error',
        pluginEnabled: postCheck.state.pluginEnabled,
        configEntryPresent: postCheck.state.configEntryPresent,
        pluginInstalled: postCheck.state.pluginInstalled,
        activeCachePath: postCheck.state.activeCachePath ?? null,
        errorCategory: 'post_check_failed',
        suggestion: createCodexNativePostCheckSuggestion('install'),
      });
      await this.updateRecoveryBreadcrumbWithEvent({
        plugin: plugin.manifest.name,
        scope,
        state: 'post_check_failed',
        reason: 'native_install_post_check_failed',
        activeCachePath: postCheck.state.activeCachePath ?? null,
        lastError: detail,
      });
      throw new Error(
        `Codex 原生插件 ${plugin.manifest.name}@aw 已写入，但安装后校验失败：${detail}。AW 不会回退到只写 enabled config；请先运行 \`aw status --verbose\` 查看 breadcrumb、config 和 cache 诊断。`,
      );
    }
    await this.emitNativePostCheckEvent({
      plugin: plugin.manifest.name,
      scope,
      pluginId,
      operation: 'install',
      phase: 'success',
      pluginEnabled: postCheck.state.pluginEnabled,
      configEntryPresent: postCheck.state.configEntryPresent,
      pluginInstalled: postCheck.state.pluginInstalled,
      activeCachePath: postCheck.state.activeCachePath ?? null,
    });
  }

  async uninstallPlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    const ledger = await readInstalledLedger(this.env);
    const userPaths = resolveCodexPaths(this.cwd, 'user', this.env);
    // Codex project uninstall only removes repo-managed artifacts; shared user native state stays in place.
    if (scope === 'project') {
      return;
    }

    const projectKey = await resolveCodexProjectKey(this.cwd);
    const installedSnapshot = getInstalledScopeSnapshot(ledger, plugin.manifest.name, scope, projectKey);
    const installedRequiresNative = normalizeCodexCapabilitySnapshot(installedSnapshot).requiresNativePlugin;
    const currentRefs = normalizeSharedNativeRefs(
      ledger.plugins[plugin.manifest.name]?.platforms.codex?.sharedNativeRefs,
    );
    const scopePaths = resolveCodexPaths(this.cwd, scope, this.env);
    const trackingManifest = await readTrackingManifest(scopePaths.trackingDir);
    const trackingRecord = getTrackingRecord(trackingManifest, plugin.manifest.name);
    const trackingEvidenceUsable =
      Boolean(trackingRecord) &&
      getTrackingArtifactIntegrityErrors(trackingRecord?.artifacts ?? []).length === 0;
    const nativeState = await readCodexNativePluginState(plugin.manifest.name, this.env);
    const recoveryBreadcrumb = await readCodexNativeRecoveryBreadcrumb(plugin.manifest.name, this.env);
    const managedOrRecoveryEvidence =
      installedRequiresNative ||
      trackingEvidenceUsable ||
      currentRefs.user ||
      recoveryBreadcrumb !== null;
    const shouldHandleUserNative =
      managedOrRecoveryEvidence
        ? (
            requiresCodexNativePlugin(plugin, scope) ||
            installedRequiresNative ||
            hasCodexNativeStateEvidence(nativeState) ||
            recoveryBreadcrumb !== null
          )
        : nativeState.pluginEnabled;
    if (!shouldHandleUserNative) {
      return;
    }

    const nextRefs = normalizeSharedNativeRefs(currentRefs);
    nextRefs.user = false;

    if (!nextRefs.user && nextRefs.projects.length === 0) {
      await this.uninstallCodexUserNativePlugin(plugin.manifest.name, {
        preserveMarketplace: true,
      });
    }

    const cleanup = await assessCodexMarketplaceCleanupForAdapter({
      cwd: this.cwd,
      env: this.env,
      ledger,
      pluginName: plugin.manifest.name,
      nextRefs,
    });
    if (cleanup.marketplaceConfigPresent && cleanup.canCleanup) {
      await this.removeCodexMarketplaceRegistration(plugin.manifest.name, scope);
    }
  }

  async uninstallUserNativePluginById(pluginNameOrId: string): Promise<void> {
    await this.uninstallCodexUserNativePlugin(pluginNameOrId);

    const cleanup = await assessCodexMarketplaceCleanupForAdapter({
      cwd: this.cwd,
      env: this.env,
      ledger: await readInstalledLedger(this.env),
    });
    if (cleanup.marketplaceConfigPresent && cleanup.canCleanup) {
      await this.removeCodexMarketplaceRegistration(codexPluginNameFromId(normalizeCodexUserPluginId(pluginNameOrId)), 'user');
    }
  }

  private async removeCodexMarketplaceRegistration(
    pluginName: string,
    scope: Scope,
  ): Promise<void> {
    const userPaths = resolveCodexPaths(this.cwd, 'user', this.env);
    const configBefore = await readCodexConfigFile(userPaths.configTomlPath);
    if (configBefore.snapshot.marketplaces[MARKETPLACE_NAME] === undefined) {
      return;
    }

    await this.emitNativeMarketplaceEvent({
      plugin: pluginName,
      scope,
      marketplacePath: MARKETPLACE_NAME,
      operation: 'remove',
      phase: 'start',
    });
    try {
      await runNativeCliChecked(
        buildCodexMarketplaceRemoveInvocation(MARKETPLACE_NAME, this.cwd, this.env),
        this.nativeCliRunner,
      );
    } catch (error) {
      await this.emitNativeMarketplaceEvent({
        plugin: pluginName,
        scope,
        marketplacePath: MARKETPLACE_NAME,
        operation: 'remove',
        phase: 'error',
        errorCategory: 'codexNativeCliUnavailable',
        suggestion: createCodexMarketplaceSuggestion(MARKETPLACE_NAME, error),
      });
      throw createCodexMarketplaceCliError('remove', MARKETPLACE_NAME, error);
    }

    const configAfter = await readCodexConfigFile(userPaths.configTomlPath);
    if (configAfter.snapshot.marketplaces[MARKETPLACE_NAME] !== undefined) {
      await this.emitNativeMarketplaceEvent({
        plugin: pluginName,
        scope,
        marketplacePath: MARKETPLACE_NAME,
        operation: 'remove',
        phase: 'error',
        errorCategory: 'codexNativeMarketplaceDrift',
        suggestion: 'Codex CLI 已返回成功，但 [marketplaces.aw] 仍存在；请运行 `aw status --verbose` 查看 native marketplace 诊断。',
      });
      throw new CodexNativeCliLifecycleError(
        'codexNativeMarketplaceDrift',
        'Codex CLI 已返回成功，但 [marketplaces.aw] 仍存在，AW 不会手动删除 Codex config 来伪装 marketplace 移除成功。',
      );
    }

    await this.emitNativeMarketplaceEvent({
      plugin: pluginName,
      scope,
      marketplacePath: MARKETPLACE_NAME,
      operation: 'remove',
      phase: 'success',
    });
  }

  private async uninstallCodexUserNativePlugin(
    pluginNameOrId: string,
    options: { preserveMarketplace?: boolean } = {},
  ): Promise<void> {
    const pluginId = normalizeCodexUserPluginId(pluginNameOrId);
    const pluginName = codexPluginNameFromId(pluginId);
    const scope = 'user' as const;
    const existingBreadcrumb = await readCodexNativeRecoveryBreadcrumb(pluginId, this.env);

    const uninstallStartedAt = Date.now();
    await this.emitNativeRpcEvent({
      plugin: pluginName,
      scope,
      pluginId,
      method: 'codex plugin remove',
      phase: 'start',
      durationMs: 0,
    });
    try {
      await runNativeCliChecked(
        buildCodexPluginRemoveInvocation(pluginId, this.cwd, this.env),
        this.nativeCliRunner,
      );
    } catch (error) {
      await this.emitNativeRpcEvent({
        plugin: pluginName,
        scope,
        pluginId,
        method: 'codex plugin remove',
        phase: 'error',
        durationMs: Date.now() - uninstallStartedAt,
        nativeWriteSucceeded: false,
        errorCategory: 'codexNativeCliUnavailable',
        suggestion: createCodexNativePostCheckSuggestion('uninstall'),
      });
      if (existingBreadcrumb) {
        await this.updateRecoveryBreadcrumbWithEvent({
          plugin: pluginName,
          scope,
          state: 'cleanup_failed',
          reason: 'native_uninstall_cli_failed',
          lastError: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined);
      }
      throw createCodexPluginCliError('uninstall', pluginId, error);
    }
    await this.emitNativeRpcEvent({
      plugin: pluginName,
      scope,
      pluginId,
      method: 'codex plugin remove',
      phase: 'success',
      durationMs: Date.now() - uninstallStartedAt,
      nativeWriteSucceeded: true,
    });

    await this.emitNativePostCheckEvent({
      plugin: pluginName,
      scope,
      pluginId,
      operation: 'uninstall',
      phase: 'start',
      pluginEnabled: null,
      configEntryPresent: null,
      pluginInstalled: null,
      activeCachePath: null,
    });
    try {
      await runNativeCliChecked(
        buildCodexPluginListInvocation(this.cwd, this.env),
        this.nativeCliRunner,
      );
    } catch (error) {
      await this.emitNativePostCheckEvent({
        plugin: pluginName,
        scope,
        pluginId,
        operation: 'uninstall',
        phase: 'error',
        pluginEnabled: null,
        configEntryPresent: null,
        pluginInstalled: null,
        activeCachePath: null,
        errorCategory: 'codexNativeCliUnavailable',
        suggestion: createCodexNativePostCheckSuggestion('uninstall'),
      });
      if (existingBreadcrumb) {
        await this.updateRecoveryBreadcrumbWithEvent({
          plugin: pluginName,
          scope,
          state: 'cleanup_failed',
          reason: 'native_uninstall_post_check_cli_list_failed',
          lastError: nativeCliFailureHint(error),
        }).catch(() => undefined);
      }
      throw createCodexPluginCliError('list', pluginId, error);
    }
    const postCheck = await checkCodexNativeUninstallPostCheck(pluginName, this.env);
    if (!postCheck.ok) {
      const detail = describeCodexNativeUninstallPostCheckFailure(postCheck.state);
      await this.emitNativePostCheckEvent({
        plugin: pluginName,
        scope,
        pluginId,
        operation: 'uninstall',
        phase: 'error',
        pluginEnabled: postCheck.state.pluginEnabled,
        configEntryPresent: postCheck.state.configEntryPresent,
        pluginInstalled: postCheck.state.pluginInstalled,
        activeCachePath: postCheck.state.activeCachePath ?? null,
        errorCategory: 'post_check_failed',
        suggestion: createCodexNativePostCheckSuggestion('uninstall'),
      });
      if (existingBreadcrumb) {
        await this.updateRecoveryBreadcrumbWithEvent({
          plugin: pluginName,
          scope,
          state: 'cleanup_failed',
          reason: 'native_uninstall_post_check_failed',
          activeCachePath: postCheck.state.activeCachePath ?? null,
          lastError: detail,
        }).catch(() => undefined);
      }
      throw new Error(
        `Codex 原生插件 ${pluginId} 卸载后校验失败：${detail}。AW 不会退回到只删 enabled config；请先运行 \`aw status --verbose\` 查看当前残留。`,
      );
    }
    await this.emitNativePostCheckEvent({
      plugin: pluginName,
      scope,
      pluginId,
      operation: 'uninstall',
      phase: 'success',
      pluginEnabled: postCheck.state.pluginEnabled,
      configEntryPresent: postCheck.state.configEntryPresent,
      pluginInstalled: postCheck.state.pluginInstalled,
      activeCachePath: postCheck.state.activeCachePath ?? null,
    });

    try {
      await this.deleteRecoveryBreadcrumbWithEvent({
        plugin: pluginName,
        scope,
        state: existingBreadcrumb?.state ?? 'cleanup_failed',
        recoveryBreadcrumbPersistedBefore: Boolean(existingBreadcrumb),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Codex 原生插件 ${pluginId} 已卸载，但删除恢复标记失败：${detail}。请先运行 \`aw status --verbose\` 确认 breadcrumb 清理情况。`,
      );
    }

    if (options.preserveMarketplace) {
      return;
    }
  }

  async installExtensions(
    plugin: PluginMeta,
    scope: Scope,
    options?: {
      event?: 'install' | 'upgrade' | 'refresh';
      changedConfigKeys?: string[];
      dynamicOnly?: boolean;
      previousArtifacts?: GeneratedArtifact[];
      catalogResolution?: CatalogResolution;
      marketplacePrepared?: boolean;
    },
  ): Promise<GeneratedArtifact[]> {
    const paths = resolveCodexPaths(this.cwd, scope, this.env);
    const artifacts: GeneratedArtifact[] = [];
    const roleFileRollbackBaselines = new Map<string, TextFileRollbackBaseline>();
    let codexConfigRollbackBaseline: { path: string; content: string | null } | undefined;

    const captureRoleFileRollbackBaseline = async (filePath: string): Promise<void> => {
      const normalizedPath = path.normalize(filePath);
      if (roleFileRollbackBaselines.has(normalizedPath)) {
        return;
      }
      roleFileRollbackBaselines.set(
        normalizedPath,
        await captureTextFileRollbackBaseline(filePath),
      );
    };

    try {
      const diskTrackingManifest = await readTrackingManifest(paths.trackingDir);
      const diskTrackingRecord = getTrackingRecord(diskTrackingManifest, plugin.manifest.name);
      const trackingManifest = options?.previousArtifacts === undefined
        ? diskTrackingManifest
        : {
            ...diskTrackingManifest,
            plugins: {
              ...diskTrackingManifest.plugins,
              [plugin.manifest.name]: {
                name: plugin.manifest.name,
                generatedAt: diskTrackingRecord?.generatedAt ?? new Date().toISOString(),
                artifacts: options.previousArtifacts,
              },
            },
          };
      const trackingRecord = getTrackingRecord(trackingManifest, plugin.manifest.name);
      const event = options?.event ?? 'install';
      const dynamicOnly = options?.dynamicOnly === true;
      const declaredDynamicTargets = (plugin.manifest.artifacts?.targets ?? []).filter(
        (target) => target.platform === 'codex' && target.scopes.includes(scope),
      );
      const dynamicRenderResult = declaredDynamicTargets.length > 0
        ? await runArtifactRenderer({
            event,
            plugin,
            platform: 'codex',
            scope,
            cwd: this.cwd,
            commandEnv: this.env,
            changedConfigKeys: options?.changedConfigKeys,
            previousArtifacts: trackingRecord?.artifacts ?? [],
          })
        : undefined;
      const dynamicRenderConfig = declaredDynamicTargets.length > 0
        ? await resolveArtifactRenderConfig({
            pluginName: plugin.manifest.name,
            manifest: plugin.manifest,
            scope,
            cwd: this.cwd,
            env: this.env,
          })
        : undefined;
      const validatedDynamicArtifacts = declaredDynamicTargets.length > 0
        ? validateArtifactPlan({
            manifest: plugin.manifest,
            plan: dynamicRenderResult!.plan,
            platform: 'codex',
            scope,
            renderConfig: dynamicRenderConfig!,
            rendererDigest: dynamicRenderResult!.target.rendererDigest,
            manifestDigest: dynamicRenderResult!.target.manifestDigest,
          }).artifacts
        : [];
      const dynamicInstructionArtifacts = validatedDynamicArtifacts.filter(
        (artifact) => artifact.target === 'codex.developerInstructionsBlock',
      );
      const dynamicRoleArtifacts = validatedDynamicArtifacts.filter(
        (artifact) => artifact.target === 'codex.agentRole',
      );
      const dynamicSkillArtifacts = validatedDynamicArtifacts.filter(
        (artifact) => artifact.target === 'codex.skill',
      );
      assertTrackedCodexSkillIdentityMatchesPlan({
        pluginName: plugin.manifest.name,
        trackingRecord,
        skillArtifacts: dynamicSkillArtifacts.map((artifact) => {
          if (!artifact.skillKey) {
            throw new Error(`Artifact "${artifact.id}" 的 codex.skill 必须声明 skillKey。`);
          }
          return {
            id: artifact.id,
            target: 'codex.skill' as const,
            skillKey: artifact.skillKey,
          };
        }),
      });
      assertTrackedCodexRoleIdentityMatchesPlan({
        pluginName: plugin.manifest.name,
        trackingRecord,
        roleArtifacts: dynamicRoleArtifacts.map((artifact) => {
          if (!artifact.roleKey) {
            throw new Error(`Artifact "${artifact.id}" 的 codex.agentRole 必须声明 roleKey。`);
          }
          return {
            id: artifact.id,
            target: 'codex.agentRole' as const,
            roleKey: artifact.roleKey,
          };
        }),
      });
      const dynamicSkillSourceDirs = (artifact: ValidatedArtifactPlanArtifact): string[] =>
        dynamicRenderResult?.context.artifactSources.find((entry) =>
          entry.id === artifact.id && entry.target === artifact.target)?.sourceDirs ?? [];
      const instructions = dynamicOnly || dynamicInstructionArtifacts.length > 0
        ? []
        : resolvePlatformEntries(plugin.manifest.extensions?.instructions, 'codex');
      const renderedMcpServers = dynamicOnly
        ? {}
        : await resolveRenderedCodexMcpServers(plugin);

      if (scope === 'user') {
        for (const artifact of dynamicSkillArtifacts) {
          const skillKey = artifact.skillKey?.trim();
          if (!skillKey) {
            throw new Error(`Artifact "${artifact.id}" 的 codex.skill 必须声明 skillKey。`);
          }

          const skillPath = getLocalMarketplaceCodexSkillRoot(
            resolveAwHome(this.env),
            plugin.manifest.name,
            skillKey,
          );
          const expectedTree = await createCodexSkillExpectedTree({
            artifact,
            sourceDirs: dynamicSkillSourceDirs(artifact),
          });
          const writtenPaths = artifact.state === 'disabled'
            ? (await fs.remove(skillPath), [] as string[])
            : await writeCodexSkillTree(skillPath, expectedTree);

          artifacts.push({
            path: skillPath,
            ...(writtenPaths.length > 0 ? { paths: writtenPaths } : {}),
            kind: 'skill',
            platform: 'codex',
            artifactKey: skillKey,
            id: artifact.id,
            target: artifact.target,
            state: artifact.state,
            ...(artifact.disabledReason === undefined
              ? {}
              : { disabledReason: artifact.disabledReason }),
            refreshKeys: [...artifact.refreshKeys],
            configDigest: artifact.configDigest,
            contentDigest: createCodexSkillStagingTreeContentDigest(expectedTree),
          });
        }
      }

      if (scope === 'project') {
        const repoRoot = await resolveRepoRoot(this.cwd);
        for (const artifact of dynamicSkillArtifacts) {
          const skillKey = artifact.skillKey?.trim();
          if (!skillKey) {
            throw new Error(`Artifact "${artifact.id}" 的 codex.skill 必须声明 skillKey。`);
          }

          const skillPath = getRepoSkillPath(repoRoot, skillKey);
          await assertCodexProjectSkillPathOwnedByAw({
            cwd: this.cwd,
            env: this.env,
            pluginName: plugin.manifest.name,
            trackingRecord,
            skillKey,
            skillPath,
          });

          const expectedTree = await createCodexSkillExpectedTree({
            artifact,
            sourceDirs: dynamicSkillSourceDirs(artifact),
          });
          const managedPaths = Object.keys(expectedTree.files).map((relativePath) =>
            path.join(skillPath, relativePath.split('/').join(path.sep)));

          if (artifact.state === 'disabled') {
            await fs.remove(skillPath);
            artifacts.push({
              path: skillPath,
              paths: managedPaths,
              kind: 'skill',
              platform: 'codex',
              artifactKey: skillKey,
              id: artifact.id,
              target: artifact.target,
              state: artifact.state,
              ...(artifact.disabledReason === undefined
                ? {}
                : { disabledReason: artifact.disabledReason }),
              refreshKeys: [...artifact.refreshKeys],
              configDigest: artifact.configDigest,
              contentDigest: createCodexSkillStagingTreeContentDigest(expectedTree),
            });
            continue;
          }

          const writtenPaths = await writeCodexSkillTree(skillPath, expectedTree);
          artifacts.push({
            path: skillPath,
            paths: writtenPaths,
            kind: 'skill',
            platform: 'codex',
            artifactKey: skillKey,
            id: artifact.id,
            target: artifact.target,
            state: artifact.state,
            refreshKeys: [...artifact.refreshKeys],
            configDigest: artifact.configDigest,
            contentDigest: createCodexSkillStagingTreeContentDigest(expectedTree),
          });
        }
      }

      if (
        instructions.length > 0 ||
        dynamicInstructionArtifacts.length > 0 ||
        dynamicRoleArtifacts.length > 0 ||
        Object.keys(renderedMcpServers).length > 0
      ) {
        const scopeConfig = await readCodexConfigFile(paths.configTomlPath);
        assertNoCodexMcpServerConflicts({
          pluginName: plugin.manifest.name,
          trackingManifest,
          trackingRecord,
          scopeConfig,
          desiredServers: renderedMcpServers,
        });

        const roleRegistrations: Record<string, CodexAgentRegistrationConfig> = {};
        const removeRoleRegistrations: string[] = [];
        const managedRoleFilesToDelete: string[] = [];
        for (const artifact of dynamicRoleArtifacts) {
          const roleKey = artifact.roleKey;
          if (!roleKey) {
            throw new Error(`Artifact "${artifact.id}" 的 codex.agentRole 必须声明 roleKey。`);
          }
          const managedRoleLayerPath = getManagedCodexRoleLayerPath(
            paths.configDir,
            plugin.manifest.name,
            roleKey,
          );
          const existingRegistration = scopeConfig.snapshot.agents[roleKey];
          const existingConfigFile = existingRegistration?.configFile;
          const existingRoleLayerPath = existingConfigFile
            ? path.resolve(path.dirname(paths.configTomlPath), existingConfigFile)
            : undefined;
          const registrationPointsAtManagedRole =
            existingRoleLayerPath !== undefined &&
            path.normalize(existingRoleLayerPath) === path.normalize(managedRoleLayerPath);

          if (artifact.state === 'disabled') {
            const removalPlan = planCodexManagedRoleRemoval({
              content: scopeConfig.content,
              configPath: paths.configTomlPath,
              roleKey,
              managedRoleLayerPath,
            });
            await captureRoleFileRollbackBaseline(removalPlan.roleLayerPathToDelete);
            if (registrationPointsAtManagedRole) {
              removeRoleRegistrations.push(roleKey);
            }
            managedRoleFilesToDelete.push(removalPlan.roleLayerPathToDelete);
            artifacts.push({
              path: managedRoleLayerPath,
              paths: buildGeneratedArtifactPaths(paths.configTomlPath, managedRoleLayerPath),
              kind: 'agent',
              platform: 'codex',
              artifactKey: roleKey,
              id: artifact.id,
              target: artifact.target,
              state: artifact.state,
              ...(artifact.disabledReason === undefined
                ? {}
                : { disabledReason: artifact.disabledReason }),
              refreshKeys: [...artifact.refreshKeys],
              configDigest: artifact.configDigest,
              contentDigest: createGeneratedArtifactContentDigest({
                target: artifact.target,
                state: artifact.state,
                roleKey,
                disabledReason: artifact.disabledReason ?? null,
              }),
              roleKey,
            });
            continue;
          }

          if (
            existingRegistration &&
            !registrationPointsAtManagedRole
          ) {
            throw new Error(
              `Codex role "${roleKey}" 已存在非 AW managed registration，当前 config_file 为 ${
                existingConfigFile ?? '<missing>'
              }，不会静默覆盖。`,
            );
          }

          const registrationDescription = artifact.content?.registration?.description?.trim();
          const roleFileDescription = artifact.content?.roleFile?.description?.trim();
          if (
            registrationDescription &&
            roleFileDescription &&
            registrationDescription !== roleFileDescription
          ) {
            throw new Error(
              `Artifact "${artifact.id}" 的 registration.description 与 roleFile.description 必须保持一致。`,
            );
          }
          const description = registrationDescription ?? roleFileDescription;
          if (!description) {
            throw new Error(`Artifact "${artifact.id}" 的 codex.agentRole 必须提供 description。`);
          }

          const roleFile = artifact.content?.roleFile;
          if (!roleFile?.developer_instructions?.trim()) {
            throw new Error(
              `Artifact "${artifact.id}" 的 codex.agentRole 必须提供 developer_instructions。`,
            );
          }

          await captureRoleFileRollbackBaseline(managedRoleLayerPath);
          const renderedRoleFile = renderManagedCodexRoleFile({
            roleKey,
            description,
            developerInstructions: roleFile.developer_instructions,
            model: roleFile.model,
            modelReasoningEffort: roleFile.model_reasoning_effort,
          });
          const artifactPath = await writeTextArtifact(
            paths.configDir,
            normalizeCodexRelativePath(path.relative(paths.configDir, managedRoleLayerPath)),
            renderedRoleFile,
          );
          artifacts.push({
            path: artifactPath,
            paths: buildGeneratedArtifactPaths(paths.configTomlPath, artifactPath),
            kind: 'agent',
            platform: 'codex',
            artifactKey: roleKey,
            id: artifact.id,
            target: artifact.target,
            state: artifact.state,
            refreshKeys: [...artifact.refreshKeys],
            configDigest: artifact.configDigest,
            contentDigest: createGeneratedArtifactContentDigest({
              target: artifact.target,
              state: artifact.state,
              roleKey,
              registration: { description },
              roleFile: renderedRoleFile,
            }),
            roleKey,
          });
          roleRegistrations[roleKey] = {
            description,
            configFile: normalizeCodexRelativePath(
              path.relative(path.dirname(paths.configTomlPath), managedRoleLayerPath),
            ),
          };
        }

        for (const managedRoleFilePath of managedRoleFilesToDelete) {
          await fs.remove(managedRoleFilePath);
        }

        const dynamicInstructionBlock = dynamicInstructionArtifacts.length > 0
          ? composeDynamicInstructionBlock(plugin.manifest.name, dynamicInstructionArtifacts)
          : undefined;
        const dynamicInstructionBlockContentDigest = dynamicInstructionBlock
          ? createPresentInstructionBlockDigest(dynamicInstructionBlock)
          : undefined;
        const transaction = await applyCodexConfigTransactionFile(paths.configTomlPath, {
          ...(dynamicInstructionArtifacts.length > 0
            ? dynamicInstructionBlock
              ? {
                  upsertManagedInstructionBlock: dynamicInstructionBlock,
                }
              : {
                  removeManagedInstructionPluginName: plugin.manifest.name,
                }
            : instructions.length > 0
              ? {
                  upsertManagedInstructionBlock: {
                    pluginName: plugin.manifest.name,
                    value: renderCodexManagedInstructionBlock(
                      plugin.manifest.name,
                      instructions,
                    ),
                  },
                }
              : {}),
          ...(Object.keys(roleRegistrations).length > 0
            ? { upsertAgentRegistrations: roleRegistrations }
            : {}),
          ...(removeRoleRegistrations.length > 0
            ? { removeAgentRegistrations: removeRoleRegistrations }
            : {}),
          ...(Object.keys(renderedMcpServers).length > 0
            ? { upsertMcpServers: renderedMcpServers }
            : {}),
        });
        codexConfigRollbackBaseline = {
          path: paths.configTomlPath,
          content: transaction.baselineContent,
        };

        if (dynamicInstructionArtifacts.length > 0) {
          for (const artifact of dynamicInstructionArtifacts) {
            artifacts.push({
              path: paths.configTomlPath,
              paths: buildGeneratedArtifactPaths(paths.configTomlPath),
              kind: 'instruction',
              platform: 'codex',
              id: artifact.id,
              target: artifact.target,
              state: artifact.state,
              ...(artifact.disabledReason === undefined
                ? {}
                : { disabledReason: artifact.disabledReason }),
              refreshKeys: [...artifact.refreshKeys],
              configDigest: artifact.configDigest,
              contentDigest: dynamicInstructionBlockContentDigest ??
                createGeneratedArtifactContentDigest(
                  artifact.state === 'present'
                    ? {
                        target: artifact.target,
                        state: artifact.state,
                        content: artifact.content?.trim(),
                      }
                    : {
                        target: artifact.target,
                        state: artifact.state,
                        disabledReason: artifact.disabledReason ?? null,
                      },
                ),
            });
          }
        } else if (instructions.length > 0) {
          artifacts.push({ path: paths.configTomlPath, kind: 'instruction', platform: 'codex' });
        }
        for (const serverKey of Object.keys(renderedMcpServers)) {
          artifacts.push({
            path: paths.configTomlPath,
            kind: 'mcpServer',
            platform: 'codex',
            artifactKey: serverKey,
          });
        }

        if (artifacts.some((artifact) =>
          artifact.kind === 'instruction' ||
          artifact.kind === 'mcpServer' ||
          (artifact.kind === 'agent' && Boolean(artifact.artifactKey))
        )) {
          attachCodexConfigRollbackBaseline(artifacts, {
            path: paths.configTomlPath,
            content: transaction.baselineContent,
          });
          attachCodexRoleFileRollbackBaselines(artifacts, [
            ...roleFileRollbackBaselines.values(),
          ]);
        }
      }

      if (dynamicOnly) {
        return artifacts;
      }

      for (const artifact of generateCodexPermissionArtifacts(
        plugin.manifest.name,
        resolvePlatformEntries(plugin.manifest.extensions?.permissions, 'codex'),
      )) {
        validateRenderedCodexRules(artifact.content);
        const artifactPath = await writeTextArtifact(paths.configDir, artifact.relativePath, artifact.content);
        artifacts.push({ path: artifactPath, kind: 'permission', platform: 'codex' });
      }

      if (scope === 'project') {
        const hooks = resolvePlatformHookDefinitions(plugin.manifest, 'codex');
        const hooksPath = await syncCodexHooks(
          paths.hooksPath,
          plugin,
          trackingManifest,
          this.env,
          options?.catalogResolution,
        );
        if (hooks.length > 0 && hooksPath) {
          artifacts.push({
            path: hooksPath,
            kind: 'hook',
            platform: 'codex',
            hookGroups: extractCodexHookGroups(hooks),
          });
        }
      }

      for (const artifact of generateAgentArtifacts(
        plugin.manifest.name,
        resolvePlatformEntries(plugin.manifest.extensions?.agents, 'codex'),
        'codex',
      )) {
        const artifactPath = await writeTextArtifact(paths.configDir, artifact.relativePath, artifact.content);
        artifacts.push({ path: artifactPath, kind: 'agent', platform: 'codex' });
      }

      return artifacts;
    } catch (error) {
      for (const baseline of [...roleFileRollbackBaselines.values()].reverse()) {
        await restoreTextFileRollbackBaseline(baseline);
      }
      if (codexConfigRollbackBaseline) {
        if (codexConfigRollbackBaseline.content === null) {
          await fs.remove(codexConfigRollbackBaseline.path);
        } else {
          await fs.ensureDir(path.dirname(codexConfigRollbackBaseline.path));
          await fs.writeFile(
            codexConfigRollbackBaseline.path,
            codexConfigRollbackBaseline.content,
            'utf8',
          );
        }
      }
      throw attachGeneratedArtifactsToError(error, artifacts);
    }
  }

  async uninstallExtensions(
    plugin: PluginMeta,
    scope: Scope,
    generatedArtifacts: GeneratedArtifact[] = [],
  ): Promise<void> {
    const trackingManifest = await readTrackingManifest(resolveCodexPaths(this.cwd, scope, this.env).trackingDir);
    const trackingRecord = createTrackingRecordFromArtifacts(
      plugin.manifest.name,
      getTrackingRecord(trackingManifest, plugin.manifest.name),
      generatedArtifacts,
    );
    const rollbackBaseline = getCodexConfigRollbackBaseline(generatedArtifacts);
    const roleFileRollbackBaselines = getCodexRoleFileRollbackBaselines(generatedArtifacts);
    await pruneTrackedCodexArtifacts({
      cwd: this.cwd,
      scope,
      env: this.env,
      pluginName: plugin.manifest.name,
      trackingRecord,
      rollbackBaseline,
      roleFileRollbackBaselines,
    });
  }

  async upgradePlugin(
    plugin: PluginMeta,
    scope: Scope,
    options?: {
      catalogResolution?: CatalogResolution;
      marketplacePrepared?: boolean;
    },
  ): Promise<void> {
    const status = await this.status(plugin, scope, options);
    const pluginStatus = status.plugins[0];
    if (pluginStatus?.catalogCompatibility === 'missing') {
      throw new Error(`${plugin.manifest.name} 当前 catalog 已缺失，请先执行 uninstall。`);
    }

    if (pluginStatus?.catalogCompatibility === 'capabilityChanged') {
      await this.uninstallPlugin(plugin, scope);
      await this.uninstallExtensions(plugin, scope);
    }

    await this.installPlugin(plugin, scope, options);
    await this.installExtensions(plugin, scope, { event: 'upgrade', ...options });
  }

  async status(
    plugin: PluginMeta,
    scope: Scope,
    options?: {
      previousArtifacts?: GeneratedArtifact[];
      catalogResolution?: CatalogResolution;
    },
  ): Promise<StatusReport> {
    const userPaths = resolveCodexPaths(this.cwd, 'user', this.env);
    const scopePaths = resolveCodexPaths(this.cwd, scope, this.env);
    const currentCatalog = options?.catalogResolution ?? await resolveCurrentCatalog(this.env);
    const [ledger, trackedGeneratedArtifacts, projectKey, repoRoot, awHome] =
      await Promise.all([
        readInstalledLedger(this.env),
        options?.previousArtifacts === undefined
          ? collectGeneratedArtifacts(plugin.manifest.name, scopePaths.trackingDir)
          : collectGeneratedArtifactStatuses(options.previousArtifacts),
        resolveCodexProjectKey(this.cwd),
        resolveRepoRoot(this.cwd),
        resolveAwHomeCanonical(this.env),
      ]);
    let generatedArtifacts = trackedGeneratedArtifacts;
    const trackingManifest = await readTrackingManifest(scopePaths.trackingDir);
    const diskTrackingRecord = getTrackingRecord(trackingManifest, plugin.manifest.name);
    const trackingRecord = options?.previousArtifacts === undefined
      ? diskTrackingRecord
      : {
          name: plugin.manifest.name,
          generatedAt: diskTrackingRecord?.generatedAt ?? new Date().toISOString(),
          artifacts: options.previousArtifacts,
        };
    const trackingIntegrityErrors = getTrackingArtifactIntegrityErrors(
      trackingRecord?.artifacts ?? [],
    );
    if (scope === 'project') {
      await preflightCodexProjectStatusProjectConfig({
        plugin,
        trackingRecord,
        cwd: this.cwd,
        env: this.env,
      });
    }

    let userConfig = {
      content: '',
      snapshot: createEmptyCodexConfigSnapshot(),
    };
    let userConfigUnreadableDetail: string | undefined;
    if (scope === 'project') {
      try {
        userConfig = await readCodexConfigFile(userPaths.configTomlPath);
      } catch (error) {
        userConfigUnreadableDetail = error instanceof Error ? error.message : String(error);
      }
    } else {
      userConfig = await readCodexConfigFile(userPaths.configTomlPath);
    }

    const scopeConfig = scope === 'project' &&
      !needsCodexProjectConfigAccess(plugin, trackingRecord)
      ? {
        content: '',
        snapshot: createEmptyCodexConfigSnapshot(),
      }
      : await readCodexConfigFile(scopePaths.configTomlPath);

    const trackingEvidenceUsable =
      Boolean(trackingRecord) && trackingIntegrityErrors.length === 0;
    const externalOwnership = userConfigUnreadableDetail
      ? {
        present: false,
        checkState: 'unknown' as const,
        details: `无法读取用户级 Codex 配置，无法可靠检查 external ownership：${userConfigUnreadableDetail}`,
      }
      : (() => {
        const ownership = detectCodexExternalOwnership(
          userConfig.snapshot.plugins,
          plugin.manifest.name,
          MARKETPLACE_NAME,
        );
        return ownership
          ? { ...ownership, checkState: 'known' as const }
          : { present: false, checkState: 'known' as const };
      })();
    const currentMarketplace = await readMarketplaceManifestAtPath(
      getMarketplaceManifestPath(currentCatalog.rootDir, 'codex'),
      'codex marketplace manifest',
    );
    const currentCatalogAvailable = currentMarketplace.plugins.some(
      (entry) => entry.name === plugin.manifest.name,
    );
    const sourceCatalogRoot = currentCatalog.rootDir;
    const ledgerScopeInitialized = resolveScopeInitialized(
      ledger,
      plugin.manifest.name,
      'codex',
      scope,
      projectKey,
    );
    const scopeInitialized: ScopeInitializedState =
      scope === 'project'
        ? resolveCodexProjectScopeInitialized({
            ledger,
            pluginName: plugin.manifest.name,
            projectKey,
            trackingArtifacts: trackingRecord?.artifacts,
            trackingIdentityComplete: trackingEvidenceUsable,
            externalOwnershipPresent: externalOwnership?.present,
          })
        : ledgerScopeInitialized;
    const sharedNativeRefs = normalizeSharedNativeRefs(
      ledger.plugins[plugin.manifest.name]?.platforms.codex?.sharedNativeRefs,
    );
    const sharedNativeRefEvidence = scope === 'user' ? sharedNativeRefs.user : false;
    const nativeState = scope === 'user' || !userConfigUnreadableDetail
      ? await readCodexNativePluginState(plugin.manifest.name, this.env)
      : null;
    const nativePluginEnabled = nativeState?.pluginEnabled ?? false;
    const nativePluginInstalled = nativeState?.pluginInstalled ?? false;
    const currentScopeManagedEvidence =
      scopeInitialized === 'yes' ||
      trackingEvidenceUsable ||
      sharedNativeRefEvidence;
    const catalogCompatibilityScopeEvidence =
      currentScopeManagedEvidence ||
      Boolean(trackingRecord) ||
      generatedArtifacts.length > 0;
    const recoveryBreadcrumb = scope === 'user'
      ? await readCodexNativeRecoveryBreadcrumb(plugin.manifest.name, this.env)
      : null;
    const nativeRecovery = scope === 'user'
      ? buildNativeRecoveryStatus({
          pluginName: plugin.manifest.name,
          pluginEnabled: nativePluginEnabled,
          pluginInstalled: nativePluginInstalled,
          breadcrumb: recoveryBreadcrumb,
        })
      : createEmptyNativeRecoveryStatus();
    const platformNativeFallbackEvidence =
      scope === 'user' &&
      nativePluginEnabled &&
      !currentScopeManagedEvidence;
    const projectManagedKinds = getCodexProjectManagedKinds(plugin);
    const hasTrustGatedProjectArtifacts =
      scope === 'project' &&
      (
        hasTrustGatedCodexProjectKinds(projectManagedKinds) ||
        trackingRecordHasTrustGatedCodexArtifacts(trackingRecord)
      );
    const currentCapabilities: CodexCapabilitySnapshot = {
      requiresNativePlugin: requiresCodexNativePlugin(plugin, scope),
      hasRepoManagedArtifacts: hasCodexProjectManagedArtifacts(plugin),
      projectManagedKinds,
    };
    const installedCapabilitySnapshot = getInstalledScopeSnapshot(
      ledger,
      plugin.manifest.name,
      scope,
      projectKey,
    );
    const installedCapabilities = normalizeCodexCapabilitySnapshot(installedCapabilitySnapshot);
    const catalogCompatibility = resolveCodexCatalogCompatibility({
      currentManifestPresent: currentCatalogAvailable,
      currentScopeManagedEvidence: catalogCompatibilityScopeEvidence,
      platformNativeFallbackEvidence,
      currentCapabilities,
      installedCapabilitySnapshot,
    });
    const requiresNativePluginStatus =
      currentCapabilities.requiresNativePlugin ||
      installedCapabilities.requiresNativePlugin ||
      sharedNativeRefEvidence ||
      nativePluginEnabled ||
      nativePluginInstalled ||
      (nativeState ? hasCodexNativeCacheEvidence(nativeState) : false) ||
      nativeRecovery.present;
    const marketplaceHealth = resolveCodexMarketplaceHealth(
      userConfig.snapshot.marketplaces[MARKETPLACE_NAME],
      awHome,
    );

    const projectLayerEvidence = scope === 'project' &&
      !needsCodexProjectConfigAccess(plugin, trackingRecord) &&
      !hasTrustGatedProjectArtifacts
      ? createEmptyCodexProjectLayerEvidence()
      : await detectCodexProjectLayerEvidence(this.cwd, repoRoot);
    const projectTrustApplicable =
      scope === 'project'
        ? hasTrustGatedProjectArtifacts || projectLayerEvidence.hasProjectLayerArtifacts
        : projectLayerEvidence.hasProjectLayerArtifacts;
    const projectTrust = userConfigUnreadableDetail
      ? (projectTrustApplicable ? 'unknown' : 'not_applicable')
      : resolveCodexProjectTrust({
        applicable: projectTrustApplicable,
        lookupKeys: [
          path.resolve(this.cwd),
          path.resolve(repoRoot),
          projectKey,
        ],
        trustLevels: Object.fromEntries(
          Object.entries(userConfig.snapshot.projects).map(([key, value]) => [key, value.trustLevel]),
        ),
        hasProjectLayerArtifacts: projectTrustApplicable,
      });

    const declaredDynamicTargets = (plugin.manifest.artifacts?.targets ?? []).filter((artifact) =>
      artifact.platform === 'codex' && artifact.scopes.includes(scope),
    );
    generatedArtifacts = applyDeclaredDynamicArtifactIdentity(generatedArtifacts, declaredDynamicTargets);
    const declaredDynamicInstructionTargets = declaredDynamicTargets.filter(
      (artifact) => artifact.target === 'codex.developerInstructionsBlock',
    );
    const declaredDynamicRoleTargets = declaredDynamicTargets.filter(
      (artifact) => artifact.target === 'codex.agentRole',
    );
    const trackedDynamicInstructionArtifacts = generatedArtifacts.filter(
      (artifact) => artifact.target === 'codex.developerInstructionsBlock',
    );
    const trackedDynamicRoleArtifacts = generatedArtifacts.filter(
      (artifact) => artifact.target === 'codex.agentRole',
    );
    const codexInstructions = resolvePlatformEntries(plugin.manifest.extensions?.instructions, 'codex');
    const codexPermissions = resolvePlatformEntries(plugin.manifest.extensions?.permissions, 'codex');
    const codexHookExpectation = await resolveCodexStatusHookExpectation(
      plugin,
      trackingRecord,
      currentCatalogAvailable,
      this.env,
    );
    const codexMcpExpectation = await resolveCodexStatusMcpExpectation(
      plugin,
      trackingRecord,
      currentCatalogAvailable,
      this.env,
    );
    const codexAgents = resolvePlatformEntries(plugin.manifest.extensions?.agents, 'codex');
    const trackedStaticAgentIds = codexAgents.map((agent) =>
      buildGeneratedName(plugin.manifest.name, agent.name),
    );
    const trackedMcpKeys = new Set(trackedCodexMcpServerKeys(trackingRecord));
    const expectedMcpKeys = new Set(Object.keys(codexMcpExpectation.expectedServers));
    const actualMcpKeys = new Set(Object.keys(scopeConfig.snapshot.mcpServers));
    const codexMcpSignals = [...new Set([
      ...trackedMcpKeys,
      ...expectedMcpKeys,
      ...actualMcpKeys,
    ])]
      .filter((serverKey) =>
        trackedMcpKeys.has(serverKey) ||
        expectedMcpKeys.has(serverKey),
      )
      .sort()
      .map((serverKey) =>
        resolveCodexMcpServerStatusSignal({
          key: serverKey,
          tracked: trackedMcpKeys.has(serverKey),
          actual: scopeConfig.snapshot.mcpServers[serverKey],
          expected: codexMcpExpectation.expectedServers[serverKey],
        }),
      );

    const repoManagedHookDeclared = scope === 'project'
      ? codexHookExpectation.declared
      : Boolean(trackingRecord?.artifacts.some((artifact) => artifact.kind === 'hook'));
    const managedArtifacts = await buildCodexManagedArtifactStatuses({
      plugin,
      scope,
      cwd: this.cwd,
      env: this.env,
      repoRoot,
      projectTrust,
      projectLayerEvidence,
      scopeConfig,
      generatedArtifacts,
    });
    const dynamicInstructionStatuses = managedArtifacts.filter(
      (artifact) => artifact.target === 'codex.developerInstructionsBlock',
    );
    const dynamicRoleStatuses = managedArtifacts.filter(
      (artifact) => artifact.target === 'codex.agentRole',
    );
    const instructionManaged = Boolean(
      scopeConfig.snapshot.developerInstructions.managedBlocks[plugin.manifest.name],
    );
    const rulesManaged = Boolean(
      trackingRecord?.artifacts.some((artifact) => artifact.kind === 'permission'),
    ) && generatedArtifacts
      .filter((artifact) => artifact.kind === 'permission')
      .every((artifact) => artifact.exists);
    let hooksManaged = Boolean(
      trackingRecord?.artifacts.some((artifact) => artifact.kind === 'hook'),
    ) && generatedArtifacts
      .filter((artifact) => artifact.kind === 'hook')
      .every((artifact) => artifact.exists);
    const staticAgentsManaged = Boolean(
      trackingRecord?.artifacts.some((artifact) => artifact.kind === 'agent' && artifact.target === undefined),
    ) && generatedArtifacts
      .filter((artifact) => artifact.kind === 'agent' && artifact.target === undefined)
      .every((artifact) => artifact.exists);
    const dynamicRoleManaged = dynamicRoleStatuses.length > 0 &&
      dynamicRoleStatuses.every((artifact) => artifact.sessionVisibility !== 'absent');
    const agentsManaged = staticAgentsManaged || dynamicRoleManaged;

    const driftWarnings: string[] = [];
    driftWarnings.push(...codexHookExpectation.diagnostics);
    driftWarnings.push(...codexMcpExpectation.diagnostics);
    if (hooksManaged) {
      if (codexHookExpectation.expectedGroups === null) {
        hooksManaged = false;
      } else if (codexHookExpectation.expectedGroups.length > 0) {
        try {
          const actualGroups = await readCodexHookGroups(scopePaths.hooksPath);
          if (!trackedHookGroupsContainAll(actualGroups, codexHookExpectation.expectedGroups)) {
            hooksManaged = false;
            driftWarnings.push('Codex hooks artifact 中缺少当前插件声明的 hook handlers。');
          }
        } catch (error) {
          hooksManaged = false;
          const message = error instanceof Error ? error.message : String(error);
          driftWarnings.push(`Codex hooks artifact 无法解析：${message}`);
        }
      }
    }

    for (const signal of codexMcpSignals) {
      if (signal.state === 'missing') {
        driftWarnings.push(`Codex MCP server "${signal.key}" 缺失。`);
      } else if (signal.state === 'drifted') {
        driftWarnings.push(
          `Codex MCP server "${signal.key}" 已漂移。${signal.reason ? ` ${signal.reason}` : ''}`.trim(),
        );
      } else if (signal.state === 'orphan') {
        driftWarnings.push(`Codex MCP server "${signal.key}" 存在，但当前插件没有 tracking 证明归属。`);
      }
    }

    for (const artifact of managedArtifacts) {
      if (artifact.health === 'healthy' || artifact.health === 'disabledByConfig') {
        continue;
      }
      const subject = artifact.target === 'codex.developerInstructionsBlock'
        ? `Codex instruction artifact "${artifact.id ?? plugin.manifest.name}"`
        : artifact.target === 'codex.skill'
          ? `Codex skill artifact "${artifact.artifactKey ?? artifact.id ?? artifact.path}"`
          : `Codex role artifact "${
            resolveCodexRoleIdentity({
              target: artifact.target,
              roleKey: artifact.roleKey,
              artifactKey: artifact.artifactKey,
            }) ?? artifact.id ?? artifact.path
          }"`;
      const detail = artifact.diagnostics[0] ? ` ${artifact.diagnostics[0]}` : '';
      if (artifact.health === 'blockMissing' || artifact.health === 'roleLayerMissing' || artifact.health === 'missing') {
        driftWarnings.push(`${subject} 缺失。${detail}`.trim());
      } else if (artifact.health === 'registrationDrift') {
        driftWarnings.push(`${subject} registration 已漂移。${detail}`.trim());
      } else if (artifact.health === 'recentRefreshFailed') {
        driftWarnings.push(`${subject} 最近 refresh 失败。${detail}`.trim());
      } else if (artifact.health === 'configDigestStale') {
        driftWarnings.push(`${subject} config digest 已过期。${detail}`.trim());
      } else if (artifact.health === 'contentDrift') {
        driftWarnings.push(`${subject} 内容已漂移。${detail}`.trim());
      } else {
        driftWarnings.push(`${subject} 状态无法可靠判定。${detail}`.trim());
      }
    }

    const repoManagedSessionState = detectCodexSessionState({
      scope,
      declarations: {
        instructions:
          codexInstructions.length > 0 ||
          declaredDynamicInstructionTargets.length > 0 ||
          trackedDynamicInstructionArtifacts.length > 0,
        permissions: codexPermissions.length > 0,
        hooks: repoManagedHookDeclared,
        agents:
          codexAgents.length > 0 ||
          declaredDynamicRoleTargets.length > 0 ||
          trackedDynamicRoleArtifacts.length > 0,
      },
      managed: {
        instructions: instructionManaged,
        rules: rulesManaged,
        hooks: hooksManaged,
        agents: agentsManaged,
        agentRoleNames: [
          ...trackedStaticAgentIds,
          ...dynamicRoleStatuses
            .map((artifact) =>
              resolveCodexRoleIdentity({
                target: artifact.target,
                roleKey: artifact.roleKey,
                artifactKey: artifact.artifactKey,
              }))
            .filter((roleKey): roleKey is string => Boolean(roleKey)),
        ],
      },
      higherPriorityExternal: {
        developerInstructions:
          scope === 'user' &&
          projectTrust === 'trusted' &&
          (
            projectLayerEvidence.currentLayerDeveloperInstructionsDefined ||
            projectLayerEvidence.ancestorDeveloperInstructionsDefined
          ),
        rules:
          scope === 'user' &&
          projectTrust === 'trusted' &&
          projectLayerEvidence.higherPriorityRulesPresent,
        hooks:
          scope === 'user' &&
          projectTrust === 'trusted' &&
          projectLayerEvidence.higherPriorityHooksPresent,
        agentRoleNames:
          scope === 'user' && projectTrust === 'trusted'
            ? projectLayerEvidence.higherPriorityAgentRoleNames
            : [],
      },
      projectLayerDeveloperInstructionsDefined:
        scope === 'user' && projectLayerEvidence.projectLayerDeveloperInstructionsDefined,
      projectTrust,
    });

    const artifactsInitialized = generatedArtifacts.every((artifact) =>
      artifact.state === 'disabled' || artifact.exists) &&
      managedArtifacts.every((artifact) =>
        artifact.health === 'healthy' || artifact.health === 'disabledByConfig',
      ) &&
      (
        !trackingRecord?.artifacts.some((artifact) => artifact.kind === 'instruction') ||
        instructionManaged
      ) &&
      codexMcpSignals.every((signal) => signal.state === 'visible');

    if (generatedArtifacts.some((artifact) => artifact.state !== 'disabled' && !artifact.exists)) {
      driftWarnings.push('tracking manifest 记录的 Codex 受管产物存在缺失。');
    }
    for (const integrityError of trackingIntegrityErrors) {
      driftWarnings.push(`Codex tracking identity 无法安全判定：${integrityError.message}`);
    }
    if (platformNativeFallbackEvidence) {
      driftWarnings.push('平台真值仍在，但 CLI 账本或 tracking manifest 缺失。');
    }
    if (userConfigUnreadableDetail) {
      driftWarnings.push(`无法读取用户级 Codex 配置，external ownership / project trust 只能按 unknown 处理：${userConfigUnreadableDetail}`);
    }
    if (externalOwnership?.present) {
      driftWarnings.push(externalOwnership.details ?? '同名插件由外部 marketplace 管理。');
    }
    if (
      (currentCapabilities.requiresNativePlugin ||
        installedCapabilities.requiresNativePlugin ||
        nativePluginEnabled ||
        nativePluginInstalled) &&
      !marketplaceHealth.registered &&
      marketplaceHealth.warning
    ) {
      driftWarnings.push(marketplaceHealth.warning);
    }
    driftWarnings.push(...repoManagedSessionState.diagnostics);

    let repoManagedSessionItems: RepoManagedProjectItemReport[] | undefined;
    let repoManagedSkillsSummary: RepoManagedProjectKindSummary | undefined;
    let repoManagedMcpSummary: RepoManagedProjectKindSummary | undefined;
    if (scope === 'project') {
      const items: RepoManagedProjectItemReport[] = [];

      for (const integrityError of trackingIntegrityErrors) {
        if (integrityError.kind !== 'skill' && integrityError.kind !== 'mcpServer') {
          continue;
        }

        items.push(createProjectItem({
          kind: integrityError.kind,
          path: integrityError.path,
          tracked: true,
          exists: await fs.pathExists(integrityError.path),
          state: 'unknown',
          diagnostics: [integrityError.message],
        }));
      }

      const trackedSkillKeys = new Set(trackedCodexSkillKeys(trackingRecord));
      const declaredSkillKeys = new Set(
        currentCatalogAvailable
          ? await collectDeclaredCodexProjectSkillKeys(plugin)
          : trackedCodexSkillKeys(trackingRecord),
      );
      for (const skillName of [...new Set([
        ...trackedSkillKeys,
        ...declaredSkillKeys,
      ])].sort()) {
        const trackedArtifact = findTrackedCodexSkillArtifact(trackingRecord, skillName);
        const tracked = Boolean(trackedArtifact);
        const skillPath = trackedArtifact?.path ?? getRepoSkillPath(repoRoot, skillName);
        const disabled = trackedArtifact?.state === 'disabled';
        const exists = disabled ? false : await fs.pathExists(skillPath);

        let state: Extract<RepoManagedProjectItemState, 'visible' | 'missing' | 'drifted' | 'orphan' | 'absent' | 'unknown'>;
        const diagnostics: string[] = [];

        if (disabled) {
          state = 'absent';
        } else if (!tracked && exists) {
          state = 'orphan';
        } else if (tracked && !exists) {
          state = 'missing';
        } else if (!tracked) {
          state = 'absent';
        } else {
          state = 'visible';
          try {
            if (trackedArtifact?.target === 'codex.skill') {
            let expectedTree: CodexSkillStagingTree | null = null;
            if (currentCatalogAvailable) {
              try {
                expectedTree = await buildExpectedCodexSkillTreeForStatus({
                  plugin,
                  scope,
                  skillName,
                  cwd: this.cwd,
                  env: this.env,
                });
              } catch (error) {
                diagnostics.push(
                  `无法重新渲染 dynamic skill 期望内容：${error instanceof Error ? error.message : String(error)}`,
                );
              }
            }
            const comparison = expectedTree
              ? await compareCodexRepoSkillToExpectedTree({
                expectedTree,
                actualSkillRoot: skillPath,
              })
              : trackedArtifact.contentDigest
                ? {
                    drifted:
                      createCodexSkillStagingTreeContentDigest({
                        skillKey: skillName,
                        files: await collectCodexSkillTreeFileContents(skillPath),
                      }) !== trackedArtifact.contentDigest,
                    reason: undefined,
                  }
                : { drifted: false };
              if (comparison.drifted) {
                state = 'drifted';
                diagnostics.push(comparison.reason ?? '动态 skill 内容与 tracking 记录不一致。');
              }
            } else {
              if (currentCatalogAvailable) {
                const comparison = await compareCodexRepoSkillToPristine({
                  embeddedRoot: sourceCatalogRoot,
                  pluginName: plugin.manifest.name,
                  skillName,
                  actualSkillRoot: skillPath,
                });
                if (comparison.drifted) {
                  state = 'drifted';
                  if (comparison.reason) {
                    diagnostics.push(comparison.reason);
                  }
                }
              }
            }
          } catch (error) {
            state = 'drifted';
            diagnostics.push(error instanceof Error ? error.message : String(error));
          }
        }

        items.push(createProjectItem({
          kind: 'skill',
          path: skillPath,
          tracked,
          exists,
          state,
          artifactKey: skillName,
          diagnostics,
        }));
      }

      const trackedMcpArtifacts = readTrackedCodexMcpArtifacts(trackingRecord);
      const trackedMcpKeys = new Set(
        trackedMcpArtifacts
          .map((artifact) => artifact.artifactKey)
          .filter((artifactKey): artifactKey is string => Boolean(artifactKey)),
      );
      const expectedMcpKeys = new Set(Object.keys(codexMcpExpectation.expectedServers));
      for (const signal of codexMcpSignals) {
        const trackedArtifact = trackedMcpArtifacts.find((artifact) => artifact.artifactKey === signal.key);
        const baseState =
          signal.state === 'visible' || signal.state === 'missing' || signal.state === 'drifted' || signal.state === 'orphan'
            ? signal.state
            : 'unknown';
        const state = applyProjectTrustToItemState(
          baseState,
          projectTrust,
          true,
        );
        items.push(createProjectItem({
          kind: 'mcpServer',
          path: trackedArtifact?.path ?? scopePaths.configTomlPath,
          tracked: trackedMcpKeys.has(signal.key),
          exists: signal.state !== 'missing',
          state,
          artifactKey: signal.key,
          diagnostics: signal.reason ? [signal.reason] : [],
        }));
      }

      const instructionArtifact = trackingRecord?.artifacts.find((artifact) =>
        artifact.kind === 'instruction' && artifact.target === undefined,
      );
      if (
        (codexInstructions.length > 0 || instructionArtifact) &&
        declaredDynamicInstructionTargets.length === 0 &&
        trackedDynamicInstructionArtifacts.length === 0
      ) {
        const instructionBlock = scopeConfig.snapshot.developerInstructions.managedBlocks[plugin.manifest.name];
        let instructionState: Extract<RepoManagedProjectItemState, 'visible' | 'missing' | 'drifted' | 'absent'>;
        if (!instructionArtifact) {
          instructionState = instructionBlock ? 'absent' : 'absent';
        } else if (!instructionBlock) {
          instructionState = 'missing';
        } else {
          instructionState = 'visible';
          if (
            currentCatalogAvailable &&
            renderCodexManagedInstructionBlock(plugin.manifest.name, codexInstructions) !== instructionBlock.value
          ) {
            instructionState = 'drifted';
          }
        }

        items.push(createProjectItem({
          kind: 'instruction',
          path: instructionArtifact?.path ?? scopePaths.configTomlPath,
          tracked: Boolean(instructionArtifact),
          exists: Boolean(instructionBlock),
          state: applyProjectTrustToItemState(instructionState, projectTrust, true),
        }));
      }

      const expectedPermissionContents = currentCatalogAvailable
        ? new Map(
            generateCodexPermissionArtifacts(plugin.manifest.name, codexPermissions).map((artifact) => [
              path.join(scopePaths.configDir, artifact.relativePath),
              artifact.content,
            ]),
          )
        : new Map<string, string>();
      const trackedPermissionArtifacts = (trackingRecord?.artifacts ?? [])
        .filter((artifact) => artifact.kind === 'permission')
        .sort((left, right) => left.path.localeCompare(right.path));
      const emittedPermissionPaths = new Set<string>();
      for (const artifact of trackedPermissionArtifacts) {
        emittedPermissionPaths.add(artifact.path);
        const exists = await fs.pathExists(artifact.path);
        let state: Extract<RepoManagedProjectItemState, 'visible' | 'missing' | 'drifted'>;
        if (!exists) {
          state = 'missing';
        } else if (expectedPermissionContents.has(artifact.path)) {
          const content = await fs.readFile(artifact.path, 'utf8');
          state = content === expectedPermissionContents.get(artifact.path) ? 'visible' : 'drifted';
        } else {
          state = 'visible';
        }
        items.push(createProjectItem({
          kind: 'permission',
          path: artifact.path,
          tracked: true,
          exists,
          state: applyProjectTrustToItemState(state, projectTrust, true),
        }));
      }
      if (currentCatalogAvailable) {
        for (const expectedPath of [...expectedPermissionContents.keys()].sort()) {
          if (emittedPermissionPaths.has(expectedPath)) {
            continue;
          }
          items.push(createProjectItem({
            kind: 'permission',
            path: expectedPath,
            tracked: false,
            exists: await fs.pathExists(expectedPath),
            state: 'absent',
          }));
        }
      }

      const hookArtifact = trackingRecord?.artifacts.find((artifact) => artifact.kind === 'hook');
      if (codexHookExpectation.declared || hookArtifact) {
        const hookExists = await fs.pathExists(scopePaths.hooksPath);
        let hookState: Extract<RepoManagedProjectItemState, 'visible' | 'missing' | 'drifted' | 'absent' | 'unknown'>;
        const diagnostics: string[] = [];
        if (!hookArtifact) {
          hookState = 'absent';
        } else if (!hookExists) {
          hookState = 'missing';
        } else if (codexHookExpectation.expectedGroups === null) {
          hookState = 'unknown';
          diagnostics.push(...codexHookExpectation.diagnostics);
        } else {
          try {
            const actualGroups = await readCodexHookGroups(scopePaths.hooksPath);
            hookState = trackedHookGroupsContainAll(actualGroups, codexHookExpectation.expectedGroups)
              ? 'visible'
              : 'drifted';
            if (hookState === 'drifted') {
              diagnostics.push('hooks.json 中缺少或修改了当前插件声明的 hook handlers。');
            }
          } catch (error) {
            hookState = 'unknown';
            diagnostics.push(error instanceof Error ? error.message : String(error));
          }
        }

        items.push(createProjectItem({
          kind: 'hook',
          path: hookArtifact?.path ?? scopePaths.hooksPath,
          tracked: Boolean(hookArtifact),
          exists: hookExists,
          state: applyProjectTrustToItemState(hookState, projectTrust, true),
          diagnostics,
        }));
      }

      const expectedAgentContents = currentCatalogAvailable
        ? new Map(
            generateAgentArtifacts(
              plugin.manifest.name,
              codexAgents,
              'codex',
            ).map((artifact) => [
              path.join(scopePaths.configDir, artifact.relativePath),
              artifact.content,
            ]),
          )
        : new Map<string, string>();
      const trackedAgentArtifacts = (trackingRecord?.artifacts ?? [])
        .filter((artifact) => artifact.kind === 'agent' && artifact.target === undefined)
        .sort((left, right) => left.path.localeCompare(right.path));
      const emittedAgentPaths = new Set<string>();
      for (const artifact of trackedAgentArtifacts) {
        emittedAgentPaths.add(artifact.path);
        const exists = await fs.pathExists(artifact.path);
        let state: Extract<RepoManagedProjectItemState, 'visible' | 'missing' | 'drifted'>;
        if (!exists) {
          state = 'missing';
        } else if (expectedAgentContents.has(artifact.path)) {
          const content = await fs.readFile(artifact.path, 'utf8');
          state = content === expectedAgentContents.get(artifact.path) ? 'visible' : 'drifted';
        } else {
          state = 'visible';
        }
        items.push(createProjectItem({
          kind: 'agent',
          path: artifact.path,
          tracked: true,
          exists,
          state: applyProjectTrustToItemState(state, projectTrust, true),
        }));
      }
      if (currentCatalogAvailable) {
        for (const expectedPath of [...expectedAgentContents.keys()].sort()) {
          if (emittedAgentPaths.has(expectedPath)) {
            continue;
          }
          items.push(createProjectItem({
            kind: 'agent',
            path: expectedPath,
            tracked: false,
            exists: await fs.pathExists(expectedPath),
            state: 'absent',
          }));
        }
      }

      repoManagedSessionItems = sortRepoManagedItems(items);
      repoManagedSkillsSummary = summarizeRepoManagedItems(
        repoManagedSessionItems.filter((item) => item.kind === 'skill'),
        projectManagedKinds.includes('skill') ||
          trackedSkillKeys.size > 0,
      );
      repoManagedMcpSummary = summarizeRepoManagedItems(
        repoManagedSessionItems.filter((item) => item.kind === 'mcpServer'),
        projectManagedKinds.includes('mcpServer') ||
          trackedMcpKeys.size > 0 ||
          expectedMcpKeys.size > 0,
      );

      if (repoManagedSessionItems.some((item) => item.state === 'blockedByProjectTrust')) {
        driftWarnings.push('当前 repo 处于 untrusted 状态，部分 project scope 产物不会进入会话。');
      }
      if (repoManagedSessionItems.some((item) => item.state === 'projectTrustUnknown')) {
        driftWarnings.push('当前 repo trust 状态未知，部分 project scope 会话可见性无法确定。');
      }

      for (const item of repoManagedSessionItems) {
        const subject = item.kind === 'skill'
          ? `Codex repo skill "${item.artifactKey ?? path.basename(item.path)}"`
          : item.kind === 'mcpServer'
            ? `Codex MCP server "${item.artifactKey ?? item.path}"`
            : item.kind === 'instruction'
              ? 'Codex developer instructions'
              : item.kind === 'permission'
                ? `Codex rules artifact ${item.path}`
                : item.kind === 'hook'
                  ? 'Codex hooks artifact'
                  : `Codex agent artifact ${item.path}`;
        if (item.state === 'missing') {
          driftWarnings.push(`${subject} 缺失。`);
        } else if (item.state === 'drifted') {
          driftWarnings.push(
            `${subject} 已漂移。${item.diagnostics[0] ? ` ${item.diagnostics[0]}` : ''}`.trim(),
          );
        } else if (item.state === 'orphan') {
          driftWarnings.push(`${subject} 存在，但当前插件没有 tracking 证明归属。`);
        } else if (item.state === 'unknown') {
          driftWarnings.push(
            `${subject} 状态无法可靠判定。${item.diagnostics[0] ? ` ${item.diagnostics[0]}` : ''}`.trim(),
          );
        }
      }
    }

    const enrichedRepoManagedSessionState = scope === 'project'
      ? {
          ...repoManagedSessionState,
          skills: repoManagedSkillsSummary ?? summarizeRepoManagedItems([], false),
          mcpServers: repoManagedMcpSummary ?? summarizeRepoManagedItems([], false),
          items: repoManagedSessionItems ?? [],
          diagnostics: [
            ...new Set([
              ...repoManagedSessionState.diagnostics,
              ...(repoManagedSessionItems ?? []).flatMap((item) => item.diagnostics),
            ]),
          ],
        }
      : repoManagedSessionState;

    const pluginStatus: PluginStatusReport = {
      pluginName: plugin.manifest.name,
      native: {
        marketplaceRegistered: marketplaceHealth.registered,
        marketplaceSource: marketplaceHealth.source,
        marketplaceSourceType: marketplaceHealth.sourceType,
        marketplaceRootResolution: marketplaceHealth.rootResolution,
        requiresNativePlugin: requiresNativePluginStatus,
        pluginAvailable: currentCatalogAvailable,
        pluginInstalled: nativePluginInstalled,
        pluginEnabled: nativePluginEnabled,
        configEntryPresent: nativeState?.configEntryPresent,
        configPath: nativeState?.configPath,
        cacheRootPath: nativeState?.cacheRootPath,
        cacheStatus: nativeState?.cacheStatus as CodexNativeCacheStatus | undefined,
        activeCacheVersion: nativeState?.activeCacheVersion,
        activeCachePath: nativeState?.activeCachePath,
        validCachePaths: nativeState?.validCachePaths,
        invalidCachePaths: nativeState?.invalidCachePaths,
        ignoredCacheEntries: nativeState?.ignoredCacheEntries,
        recovery: nativeRecovery,
        version: nativeState?.activeCacheVersion,
        declaredSource: marketplaceHealth.source,
        details: marketplaceHealth.source
          ? `source=${marketplaceHealth.source}`
          : undefined,
        sharedNativeRefs,
      },
      generatedArtifacts,
      managedArtifacts,
      driftWarnings: [...new Set(driftWarnings)],
      ledgerStateStatus: ledger.ledgerState.status,
      ledgerStateReason: ledger.ledgerState.reason,
      scopeInitialized,
      ...(scope === 'project' ? { projectManagedKinds } : {}),
      catalogCompatibility,
      externalOwnership,
      projectTrust,
      platformNativeFallbackEvidence: {
        present: platformNativeFallbackEvidence,
        details: platformNativeFallbackEvidence
          ? 'user scope 的 [plugins."<plugin>@aw"] enabled 仍然存在，但 AW 缺少成功 scope record。'
          : undefined,
      },
      scopeManagedEvidence: {
        ledger: ledgerScopeInitialized === 'yes',
        tracking: trackingEvidenceUsable,
        sharedNativeRef: sharedNativeRefEvidence,
      },
      currentCatalog: {
        rootDir: currentCatalog.rootDir,
        source: currentCatalog.source,
        available: currentCatalogAvailable,
        reason: currentCatalog.reason,
      },
      artifactsInitialized,
      repoManagedSessionState: enrichedRepoManagedSessionState,
    };

    return {
      platform: 'codex',
      scope,
      initialized:
        scopeInitialized === 'yes' ||
        (scope === 'user' && (
          pluginStatus.native.pluginInstalled ||
          pluginStatus.native.pluginEnabled === true ||
          pluginStatus.native.recovery?.present === true
        )) ||
        generatedArtifacts.length > 0 ||
        platformNativeFallbackEvidence,
      scopeInitialized: scopeInitialized as ScopeInitializedState,
      plugins: [pluginStatus],
    };
  }
}
