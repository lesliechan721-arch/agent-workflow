import os from 'node:os';
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
  CatalogCompatibility,
  CodexCapabilitySnapshot,
  CodexProjectManagedKind,
  CodexSharedHookGroup,
  CodexSharedNativeRefs,
  GeneratedArtifact,
  GeneratedArtifactStatus,
  InstalledLedger,
  InstalledScopeRecord,
  MarketplaceRootResolution,
  MarketplaceSourceStatus,
  PlatformAdapter,
  PluginMeta,
  PluginStatusReport,
  ProjectTrust,
  RepoManagedProjectItemReport,
  RepoManagedProjectItemState,
  RepoManagedProjectKindSummary,
  ResolvedInstallOptions,
  Scope,
  ScopeInitializedState,
  SkillTriggerPreference,
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
  type CodexMcpServerConfig,
  type CodexConfigSnapshot,
  readCodexConfigFile,
  readRenderedCodexMcpServersFile,
  removeCodexMarketplaceFile,
  removeCodexPluginEnabledFile,
  resolveCodexMcpServerStatusSignal,
  upsertCodexPluginEnabledFile,
} from '../utils/codex-config.js';
import {
  ensureLocalMarketplace,
  readInstalledLedger,
  resolveCodexProjectScopeInitialized,
  resolveScopeInitialized,
} from '../utils/local-marketplace.js';
import { writeJsonFile } from '../utils/json.js';
import { readPluginManifest } from '../utils/manifest.js';
import { readMarketplaceManifest } from '../utils/marketplace.js';
import {
  resolveActiveLocalBundle,
  resolveCatalogPlugins,
  resolveCurrentCatalog,
} from '../utils/plugin-catalog.js';
import {
  resolveAwHomeCanonical,
  resolveCodexPaths,
  resolveCodexProjectKey,
  resolveEmbeddedPluginsRoot,
  resolveRepoRoot,
} from '../utils/paths.js';
import {
  validateRenderedCodexRules,
  validateCodexSharedHooksContent,
} from '../utils/rendered-contract.js';
import {
  attachGeneratedArtifactsToError,
  mergeGeneratedArtifacts,
} from '../utils/generated-artifacts.js';
import {
  getTrackingArtifactIntegrityErrors,
  getTrackingRecord,
  readTrackingManifest,
} from '../utils/tracking.js';
import {
  parseCodexSharedHooksFile,
  planCodexSharedHooksUpdate,
  renderTrackedHookGroupIdentity,
  resolvePlatformHookDefinitions,
  trackedHookGroupsContainAll,
} from '../utils/hooks-contract.js';
import { resolvePlatformEntries } from '../utils/platform-entries.js';
import {
  getNextSkillTriggerWriteOrder,
  patchCodexOpenAiYaml,
  resolveSkillTriggerPolicies,
  resolveSkillTriggerStatusReportFields,
  type SkillTriggerPolicyEntry,
} from '../utils/skill-trigger-preferences.js';
import {
  NativeCliError,
  runNativeCli,
  type NativeCliInvocation,
  type NativeCliRunner,
} from '../utils/native-cli.js';
import { detectCodexExternalOwnership } from './helpers.js';
import {
  needsCodexProjectConfigAccess,
  preflightCodexProjectStatusProjectConfig,
} from '../commands/codex-project-safety.js';

const MARKETPLACE_NAME = 'aw';

export function buildCodexMarketplaceAddInvocation(
  awHome: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): NativeCliInvocation {
  return {
    command: 'codex',
    args: ['plugin', 'marketplace', 'add', awHome],
    cwd,
    env,
  };
}

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

function createCodexMarketplaceAddError(
  awHome: string,
  error: unknown,
): Error {
  return new Error(
    `无法通过 Codex 原生命令注册 AW 本地 marketplace：请确认可以运行 \`codex plugin marketplace add ${awHome}\`。${nativeCliFailureHint(error)}`,
  );
}

function createCodexMarketplaceVerificationError(
  awHome: string,
  configPath: string,
): Error {
  return new Error(
    `Codex 原生命令已执行，但 ${configPath} 中的 [marketplaces.aw] 没有指向 ${awHome}（source_type 应为 "local"）。请手动运行 \`codex plugin marketplace add ${awHome}\` 后重试。`,
  );
}

function createEmptyCodexConfigSnapshot(): CodexConfigSnapshot {
  return {
    marketplaces: {},
    plugins: {},
    projects: {},
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

interface NormalizedCodexCapabilitySnapshot {
  requiresNativePlugin: boolean;
  hasRepoManagedArtifacts: boolean;
  projectManagedKinds: CodexProjectManagedKind[];
  hasManagedKindDetails: boolean;
}

const CODEX_PROJECT_MANAGED_KIND_ORDER: CodexProjectManagedKind[] = [
  'skill',
  'mcpServer',
  'instruction',
  'permission',
  'hook',
  'agent',
];

const CODEX_PROJECT_MANAGED_KIND_SET = new Set<CodexProjectManagedKind>(
  CODEX_PROJECT_MANAGED_KIND_ORDER,
);

function normalizeCodexProjectManagedKinds(
  values: CodexCapabilitySnapshot['projectManagedKinds'] | CodexCapabilitySnapshot['managedKinds'],
): CodexProjectManagedKind[] {
  const selected = new Set<CodexProjectManagedKind>();
  for (const value of values ?? []) {
    if (CODEX_PROJECT_MANAGED_KIND_SET.has(value)) {
      selected.add(value);
    }
  }
  return CODEX_PROJECT_MANAGED_KIND_ORDER.filter((kind) => selected.has(kind));
}

function normalizeCodexCapabilitySnapshot(
  snapshot: CodexCapabilitySnapshot | undefined,
): NormalizedCodexCapabilitySnapshot {
  const rawManagedKinds = snapshot?.projectManagedKinds ?? snapshot?.managedKinds;
  const projectManagedKinds = normalizeCodexProjectManagedKinds(rawManagedKinds);
  const hasManagedKindDetails = Array.isArray(rawManagedKinds);
  return {
    requiresNativePlugin: snapshot?.requiresNativePlugin === true,
    hasRepoManagedArtifacts: hasManagedKindDetails
      ? projectManagedKinds.length > 0
      : snapshot?.hasRepoManagedArtifacts === true,
    projectManagedKinds,
    hasManagedKindDetails,
  };
}

function codexCapabilitySnapshotsEqual(
  installedSnapshot: CodexCapabilitySnapshot | undefined,
  currentSnapshot: CodexCapabilitySnapshot | undefined,
): boolean {
  const installed = normalizeCodexCapabilitySnapshot(installedSnapshot);
  const current = normalizeCodexCapabilitySnapshot(currentSnapshot);
  if (installed.requiresNativePlugin !== current.requiresNativePlugin) {
    return false;
  }

  if (installed.hasManagedKindDetails && current.hasManagedKindDetails) {
    return JSON.stringify(installed.projectManagedKinds) === JSON.stringify(current.projectManagedKinds);
  }

  return installed.hasRepoManagedArtifacts === current.hasRepoManagedArtifacts;
}

export function requiresCodexNativePlugin(plugin: PluginMeta, scope: Scope): boolean {
  if (scope === 'project') {
    return false;
  }

  return Boolean(
    plugin.manifest.skills ||
      plugin.manifest.slashCommands ||
      plugin.manifest.mcpServers ||
      plugin.manifest.apps,
  );
}

export function requiresNativePlugin(plugin: PluginMeta): boolean {
  return requiresCodexNativePlugin(plugin, 'user');
}

export function getCodexProjectManagedKinds(plugin: PluginMeta): CodexProjectManagedKind[] {
  const kinds = new Set<CodexProjectManagedKind>();
  if (plugin.manifest.skills || plugin.manifest.slashCommands) {
    kinds.add('skill');
  }
  if (plugin.manifest.mcpServers) {
    kinds.add('mcpServer');
  }
  if (resolvePlatformEntries(plugin.manifest.extensions?.instructions, 'codex').length > 0) {
    kinds.add('instruction');
  }
  if (resolvePlatformEntries(plugin.manifest.extensions?.permissions, 'codex').length > 0) {
    kinds.add('permission');
  }
  if (resolvePlatformHookDefinitions(plugin.manifest, 'codex').length > 0) {
    kinds.add('hook');
  }
  if (resolvePlatformEntries(plugin.manifest.extensions?.agents, 'codex').length > 0) {
    kinds.add('agent');
  }

  return CODEX_PROJECT_MANAGED_KIND_ORDER.filter((kind) => kinds.has(kind));
}

export function hasCodexProjectManagedArtifacts(plugin: PluginMeta): boolean {
  return getCodexProjectManagedKinds(plugin).length > 0;
}

export function hasRepoManagedArtifacts(plugin: PluginMeta): boolean {
  return hasCodexProjectManagedArtifacts(plugin);
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

function getRepoSkillsRoot(repoRoot: string): string {
  return path.join(repoRoot, '.agents', 'skills');
}

function getRepoSkillPath(repoRoot: string, skillName: string): string {
  return path.join(getRepoSkillsRoot(repoRoot), skillName);
}

async function listCodexBundleSkillKeys(plugin: PluginMeta): Promise<string[]> {
  if (!plugin.rootDir) {
    return [];
  }

  const skillsRoot = path.join(plugin.rootDir, 'codex', 'skills');
  if (!(await fs.pathExists(skillsRoot))) {
    return [];
  }

  const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
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

async function collectDirectoryFileContents(rootDir: string): Promise<Map<string, Buffer>> {
  const snapshot = new Map<string, Buffer>();
  if (!(await fs.pathExists(rootDir))) {
    return snapshot;
  }

  const visit = async (currentDir: string): Promise<void> => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      snapshot.set(path.relative(rootDir, entryPath), await fs.readFile(entryPath));
    }
  };

  await visit(rootDir);
  return snapshot;
}

async function compareCodexRepoSkillToPristine(options: {
  embeddedRoot: string;
  pluginName: string;
  skillName: string;
  actualSkillRoot: string;
  preference: SkillTriggerPreference;
  policy: SkillTriggerPolicyEntry;
}): Promise<{ drifted: boolean; reason?: string }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-codex-repo-skill-compare-'));
  const expectedSkillRoot = path.join(
    tempRoot,
    options.pluginName,
    'codex',
    'skills',
    options.skillName,
  );
  const pristineSkillRoot = path.join(
    options.embeddedRoot,
    'plugins',
    options.pluginName,
    'codex',
    'skills',
    options.skillName,
  );

  try {
    await fs.copy(pristineSkillRoot, expectedSkillRoot, { overwrite: true });
    if (options.preference !== 'default' && options.policy.allowInstallOverride) {
      await patchCodexOpenAiYaml(
        path.join(expectedSkillRoot, 'agents', 'openai.yaml'),
        options.preference,
      );
    }

    const [expectedFiles, actualFiles] = await Promise.all([
      collectDirectoryFileContents(expectedSkillRoot),
      collectDirectoryFileContents(options.actualSkillRoot),
    ]);
    const allPaths = [...new Set([
      ...expectedFiles.keys(),
      ...actualFiles.keys(),
    ])].sort();

    for (const relativePath of allPaths) {
      const expected = expectedFiles.get(relativePath);
      const actual = actualFiles.get(relativePath);
      if (!expected) {
        return { drifted: true, reason: `存在未受管文件 ${relativePath}` };
      }
      if (!actual) {
        return { drifted: true, reason: `缺少文件 ${relativePath}` };
      }
      if (!expected.equals(actual)) {
        return { drifted: true, reason: `文件内容已漂移 ${relativePath}` };
      }
    }

    return { drifted: false };
  } finally {
    await fs.remove(tempRoot).catch(() => undefined);
  }
}

function readMutableLedger(ledger: InstalledLedger): InstalledLedger {
  if (ledger.ledgerState.status === 'available') {
    return ledger;
  }

  return {
    ...ledger,
    ledgerState: {
      status: 'available',
      degradedAt: null,
      reason: null,
    },
  };
}

function normalizeSharedNativeRefs(
  sharedNativeRefs: CodexSharedNativeRefs | undefined,
): CodexSharedNativeRefs {
  return {
    user: sharedNativeRefs?.user === true,
    projects: [...new Set(sharedNativeRefs?.projects ?? [])].sort(),
  };
}

function upsertCodexScopeLedger(
  ledger: InstalledLedger,
  plugin: PluginMeta,
  scope: Scope,
  projectKey: string | undefined,
  resolvedInstallOptions?: ResolvedInstallOptions,
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
  if (resolvedInstallOptions?.applicability === 'overridable') {
    scopeRecord.installOptions = {
      skillTriggerPreference: resolvedInstallOptions.skillTriggerPreference,
    };
    if (ledger.ledgerState.status === 'available') {
      scopeRecord.skillTriggerWriteOrder = getNextSkillTriggerWriteOrder({
        ledger,
        pluginName: plugin.manifest.name,
        platform: 'codex',
      });
    }
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
  resolvedInstallOptions?: ResolvedInstallOptions,
): Promise<InstalledLedger> {
  const projectKey = scope === 'project' ? await resolveCodexProjectKey(cwd) : undefined;
  return upsertCodexScopeLedger(ledger, plugin, scope, projectKey, resolvedInstallOptions);
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
  const artifacts = mergeGeneratedArtifacts(trackingRecord?.artifacts, generatedArtifacts);
  if (artifacts.length === 0) {
    return undefined;
  }

  return {
    name: trackingRecord?.name ?? pluginName,
    generatedAt: trackingRecord?.generatedAt ?? new Date(0).toISOString(),
    artifacts,
  };
}

async function pruneTrackedCodexArtifacts(options: {
  cwd: string;
  scope: Scope;
  env: NodeJS.ProcessEnv;
  pluginName: string;
  trackingRecord: TrackingPluginRecord | undefined;
  rollbackBaseline?: { path: string; content: string | null };
}): Promise<void> {
  const paths = resolveCodexPaths(options.cwd, options.scope, options.env);
  if (options.trackingRecord) {
    for (const artifact of options.trackingRecord.artifacts) {
      if (artifact.kind === 'permission' || artifact.kind === 'agent' || artifact.kind === 'skill') {
        if (artifact.kind === 'skill' && !artifact.artifactKey) {
          throw new Error(
            `tracking manifest 中的 skill 缺少 artifactKey，不能对 ${artifact.path} 执行 path-only 删除。`,
          );
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
    const trackedMcpArtifacts = readTrackedCodexMcpArtifacts(options.trackingRecord);
    if (trackedMcpArtifacts.some((artifact) => !artifact.artifactKey)) {
      throw new Error(
        `tracking manifest 中的 mcpServer 缺少 artifactKey，不能对 ${paths.configTomlPath} 执行 path-only 删除。`,
      );
    }

    if (trackedInstruction || trackedMcpArtifacts.length > 0) {
      await applyCodexConfigTransactionFile(paths.configTomlPath, {
        ...(trackedInstruction
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
): Promise<PluginMeta> {
  try {
    const { plugins } = await resolveCatalogPlugins([pluginName], env);
    return plugins[0];
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
      const trackedPlugin = await resolveTrackedPlugin(trackedPluginName, env);
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
): Promise<string | undefined> {
  const parsedHooks = await readParsedCodexSharedHooksFile(hooksPath);
  const rewritePlan = await resolveTrackedCodexHookRewrite(plugin, trackingManifest, env);
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

type GeneratedArtifactWithCodexRollbackBaseline = GeneratedArtifact & {
  [CODEX_CONFIG_ROLLBACK_BASELINE]?: {
    path: string;
    content: string | null;
  };
};

function attachCodexConfigRollbackBaseline(
  artifacts: GeneratedArtifact[],
  baseline: { path: string; content: string | null },
): void {
  for (const artifact of artifacts) {
    if (
      artifact.kind !== 'instruction' &&
      artifact.kind !== 'mcpServer'
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

  return Promise.all(
    trackingRecord.artifacts.map(async (artifact) => ({
      path: artifact.path,
      exists: await fs.pathExists(artifact.path),
      kind: artifact.kind,
      ...(artifact.artifactKey === undefined ? {} : { artifactKey: artifact.artifactKey }),
    })),
  );
}

const CODEX_REPO_MANAGED_ITEM_KIND_ORDER: GeneratedArtifact['kind'][] = [
  'skill',
  'mcpServer',
  'instruction',
  'permission',
  'hook',
  'agent',
];

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

export class CodexAdapter implements PlatformAdapter {
  readonly name = 'codex' as const;

  private readonly cwd: string;
  private readonly nativeCliRunner?: NativeCliRunner;
  private readonly env: NodeJS.ProcessEnv;

  constructor(cwd: string, env?: NodeJS.ProcessEnv);
  constructor(cwd: string, nativeCliRunner?: NativeCliRunner, env?: NodeJS.ProcessEnv);
  constructor(
    cwd: string,
    nativeCliRunnerOrEnv?: NativeCliRunner | NodeJS.ProcessEnv,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.cwd = cwd;
    if (typeof nativeCliRunnerOrEnv === 'function') {
      this.nativeCliRunner = nativeCliRunnerOrEnv;
      this.env = env;
    } else {
      this.env = nativeCliRunnerOrEnv ?? env;
    }
  }

  async detect(cwd: string): Promise<boolean> {
    const detection = await detectEnvironment(cwd, this.env);
    return detection.codex.available;
  }

  async installPlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
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

    await ensureLocalMarketplace(this.env);
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

    if (!isCodexMarketplaceRegistered(userConfig.snapshot.marketplaces[MARKETPLACE_NAME], awHome)) {
      try {
        await runNativeCli(
          buildCodexMarketplaceAddInvocation(awHome, this.cwd, this.env),
          this.nativeCliRunner,
        );
      } catch (error) {
        throw createCodexMarketplaceAddError(awHome, error);
      }

      const refreshedConfig = await readCodexConfigFile(userPaths.configTomlPath);
      if (!isCodexMarketplaceRegistered(refreshedConfig.snapshot.marketplaces[MARKETPLACE_NAME], awHome)) {
        throw createCodexMarketplaceVerificationError(awHome, userPaths.configTomlPath);
      }
    }

    await upsertCodexPluginEnabledFile(userPaths.configTomlPath, `${plugin.manifest.name}@${MARKETPLACE_NAME}`, {
      enabled: true,
    });
  }

  async uninstallPlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    const ledger = await readInstalledLedger(this.env);
    const userPaths = resolveCodexPaths(this.cwd, 'user', this.env);
    const projectKey = await resolveCodexProjectKey(this.cwd);
    const installedSnapshot = getInstalledScopeSnapshot(ledger, plugin.manifest.name, scope, projectKey);
    if (!normalizeCodexCapabilitySnapshot(installedSnapshot).requiresNativePlugin) {
      return;
    }

    // Codex project uninstall only removes repo-managed artifacts; shared user native state stays in place.
    if (scope === 'project') {
      return;
    }

    const currentRefs = normalizeSharedNativeRefs(
      ledger.plugins[plugin.manifest.name]?.platforms.codex?.sharedNativeRefs,
    );
    const nextRefs = normalizeSharedNativeRefs(currentRefs);
    nextRefs.user = false;

    if (!nextRefs.user && nextRefs.projects.length === 0) {
      await removeCodexPluginEnabledFile(userPaths.configTomlPath, `${plugin.manifest.name}@${MARKETPLACE_NAME}`);
    }

    const hasRemainingNativeRefs = Object.entries(ledger.plugins).some(([name, record]) => {
      if (name === plugin.manifest.name) {
        return nextRefs.user || nextRefs.projects.length > 0;
      }

      const snapshot = normalizeCodexCapabilitySnapshot(record.platforms.codex?.userScope?.capabilitySnapshot);
      const refs = normalizeSharedNativeRefs(record.platforms.codex?.sharedNativeRefs);
      return snapshot.requiresNativePlugin && (refs.user || refs.projects.length > 0);
    });
    if (!hasRemainingNativeRefs) {
      await removeCodexMarketplaceFile(userPaths.configTomlPath, MARKETPLACE_NAME);
    }
  }

  async installExtensions(plugin: PluginMeta, scope: Scope): Promise<GeneratedArtifact[]> {
    const paths = resolveCodexPaths(this.cwd, scope, this.env);
    const artifacts: GeneratedArtifact[] = [];

    try {
      const trackingManifest = await readTrackingManifest(paths.trackingDir);
      const trackingRecord = getTrackingRecord(trackingManifest, plugin.manifest.name);
      const instructions = resolvePlatformEntries(plugin.manifest.extensions?.instructions, 'codex');
      const renderedMcpServers = await resolveRenderedCodexMcpServers(plugin);

      if (instructions.length > 0 || Object.keys(renderedMcpServers).length > 0) {
        const scopeConfig = await readCodexConfigFile(paths.configTomlPath);
        assertNoCodexMcpServerConflicts({
          pluginName: plugin.manifest.name,
          trackingManifest,
          trackingRecord,
          scopeConfig,
          desiredServers: renderedMcpServers,
        });

        const transaction = await applyCodexConfigTransactionFile(paths.configTomlPath, {
          ...(instructions.length > 0
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
          ...(Object.keys(renderedMcpServers).length > 0
            ? { upsertMcpServers: renderedMcpServers }
            : {}),
        });

        if (instructions.length > 0) {
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

        if (artifacts.some((artifact) => artifact.path === paths.configTomlPath)) {
          attachCodexConfigRollbackBaseline(artifacts, {
            path: paths.configTomlPath,
            content: transaction.baselineContent,
          });
        }
      }

      for (const artifact of generateCodexPermissionArtifacts(
        plugin.manifest.name,
        resolvePlatformEntries(plugin.manifest.extensions?.permissions, 'codex'),
      )) {
        validateRenderedCodexRules(artifact.content);
        const artifactPath = await writeTextArtifact(paths.configDir, artifact.relativePath, artifact.content);
        artifacts.push({ path: artifactPath, kind: 'permission', platform: 'codex' });
      }

      const hooks = resolvePlatformHookDefinitions(plugin.manifest, 'codex');
      const hooksPath = await syncCodexHooks(
        paths.hooksPath,
        plugin,
        trackingManifest,
        this.env,
      );
      if (hooks.length > 0 && hooksPath) {
        artifacts.push({
          path: hooksPath,
          kind: 'hook',
          platform: 'codex',
          hookGroups: extractCodexHookGroups(hooks),
        });
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
    await pruneTrackedCodexArtifacts({
      cwd: this.cwd,
      scope,
      env: this.env,
      pluginName: plugin.manifest.name,
      trackingRecord,
      rollbackBaseline,
    });
  }

  async upgradePlugin(plugin: PluginMeta, scope: Scope): Promise<void> {
    const status = await this.status(plugin, scope);
    const pluginStatus = status.plugins[0];
    if (pluginStatus?.catalogCompatibility === 'missing') {
      throw new Error(`${plugin.manifest.name} 当前 catalog 已缺失，请先执行 uninstall。`);
    }

    if (pluginStatus?.catalogCompatibility === 'capabilityChanged') {
      await this.uninstallPlugin(plugin, scope);
      await this.uninstallExtensions(plugin, scope);
    }

    await this.installPlugin(plugin, scope);
    await this.installExtensions(plugin, scope);
  }

  async status(plugin: PluginMeta, scope: Scope): Promise<StatusReport> {
    const userPaths = resolveCodexPaths(this.cwd, 'user', this.env);
    const scopePaths = resolveCodexPaths(this.cwd, scope, this.env);
    const [ledger, generatedArtifacts, currentCatalog, projectKey, repoRoot, embeddedRoot, awHome] =
      await Promise.all([
        readInstalledLedger(this.env),
        collectGeneratedArtifacts(plugin.manifest.name, scopePaths.trackingDir),
        resolveCurrentCatalog(this.env),
        resolveCodexProjectKey(this.cwd),
        resolveRepoRoot(this.cwd),
        resolveEmbeddedPluginsRoot(),
        resolveAwHomeCanonical(this.env),
      ]);
    const trackingManifest = await readTrackingManifest(scopePaths.trackingDir);
    const trackingRecord = getTrackingRecord(trackingManifest, plugin.manifest.name);
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
    const currentMarketplace = await readMarketplaceManifest(this.cwd, 'codex', this.env);
    const currentCatalogAvailable = currentMarketplace.manifest.plugins.some(
      (entry) => entry.name === plugin.manifest.name,
    );
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
    const currentScopeManagedEvidence =
      scopeInitialized === 'yes' ||
      trackingEvidenceUsable ||
      sharedNativeRefEvidence;
    const nativePluginEnabled =
      userConfig.snapshot.plugins[`${plugin.manifest.name}@${MARKETPLACE_NAME}`]?.enabled === true;
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
      currentScopeManagedEvidence,
      platformNativeFallbackEvidence,
      currentCapabilities,
      installedCapabilitySnapshot,
    });
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
    const trackedAgentIds = codexAgents.map((agent) =>
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
    const agentsManaged = Boolean(
      trackingRecord?.artifacts.some((artifact) => artifact.kind === 'agent'),
    ) && generatedArtifacts
      .filter((artifact) => artifact.kind === 'agent')
      .every((artifact) => artifact.exists);

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

    const repoManagedSessionState = detectCodexSessionState({
      scope,
      declarations: {
        instructions: codexInstructions.length > 0,
        permissions: codexPermissions.length > 0,
        hooks: codexHookExpectation.declared,
        agents: codexAgents.length > 0,
      },
      managed: {
        instructions: instructionManaged,
        rules: rulesManaged,
        hooks: hooksManaged,
        agents: agentsManaged,
        agentRoleNames: trackedAgentIds,
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

    const skillTriggerStatus = await resolveSkillTriggerStatusReportFields({
      pluginName: plugin.manifest.name,
      platform: 'codex',
      scope,
      projectKey,
      ledger,
      currentCatalog,
      currentCatalogAvailable,
      embeddedRoot,
      ...(scope === 'project'
        ? {
            runtimeTarget: {
              platform: 'codex' as const,
              scope: 'project' as const,
              kind: 'repoSkill' as const,
              root: getRepoSkillsRoot(repoRoot),
            },
          }
        : {}),
    });

    const artifactsInitialized = generatedArtifacts.every((artifact) => artifact.exists) &&
      (
        !trackingRecord?.artifacts.some((artifact) => artifact.kind === 'instruction') ||
        instructionManaged
      ) &&
      codexMcpSignals.every((signal) => signal.state === 'visible');

    if (generatedArtifacts.some((artifact) => !artifact.exists)) {
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
        nativePluginEnabled) &&
      !marketplaceHealth.registered &&
      marketplaceHealth.warning
    ) {
      driftWarnings.push(marketplaceHealth.warning);
    }
    driftWarnings.push(...repoManagedSessionState.diagnostics);
    if (skillTriggerStatus) {
      driftWarnings.push(...skillTriggerStatus.warnings);
    }

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
        currentCatalogAvailable ? await listCodexBundleSkillKeys(plugin) : trackedCodexSkillKeys(trackingRecord),
      );
      let skillPoliciesByName = new Map<string, SkillTriggerPolicyEntry>();
      if (currentCatalogAvailable) {
        try {
          const resolution = await resolveSkillTriggerPolicies({
            embeddedRoot,
            pluginName: plugin.manifest.name,
            platform: 'codex',
          });
          skillPoliciesByName = new Map(
            resolution.policies.map((policy) => [policy.skillName, policy]),
          );
        } catch {
          // Skill trigger warnings already surface policy read failures.
        }
      }

      for (const skillName of [...new Set([
        ...trackedSkillKeys,
        ...declaredSkillKeys,
      ])].sort()) {
        const trackedArtifact = findTrackedCodexSkillArtifact(trackingRecord, skillName);
        const tracked = Boolean(trackedArtifact);
        const skillPath = trackedArtifact?.path ?? getRepoSkillPath(repoRoot, skillName);
        const exists = await fs.pathExists(skillPath);

        let state: Extract<RepoManagedProjectItemState, 'visible' | 'missing' | 'drifted' | 'orphan' | 'absent' | 'unknown'>;
        const diagnostics: string[] = [];

        if (!tracked && exists) {
          state = 'orphan';
        } else if (tracked && !exists) {
          state = 'missing';
        } else if (!tracked) {
          state = 'absent';
        } else {
          state = 'visible';
          const policy = skillPoliciesByName.get(skillName);
          const canCompare =
            currentCatalogAvailable &&
            Boolean(policy) &&
            (
              policy?.allowInstallOverride !== true ||
              skillTriggerStatus?.skillTriggerApplicability === 'fixed' ||
              typeof skillTriggerStatus?.skillTriggerPreference === 'string'
            );
          if (policy && canCompare) {
            const comparison = await compareCodexRepoSkillToPristine({
              embeddedRoot,
              pluginName: plugin.manifest.name,
              skillName,
              actualSkillRoot: skillPath,
              preference: skillTriggerStatus?.skillTriggerPreference ?? 'default',
              policy,
            });
            if (comparison.drifted) {
              state = 'drifted';
              if (comparison.reason) {
                diagnostics.push(comparison.reason);
              }
            }
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

      const instructionArtifact = trackingRecord?.artifacts.find((artifact) => artifact.kind === 'instruction');
      if (codexInstructions.length > 0 || instructionArtifact) {
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
        .filter((artifact) => artifact.kind === 'agent')
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
        pluginAvailable: currentCatalogAvailable,
        pluginInstalled: nativePluginEnabled,
        declaredSource: marketplaceHealth.source,
        details: marketplaceHealth.source
          ? `source=${marketplaceHealth.source}`
          : undefined,
        sharedNativeRefs,
      },
      generatedArtifacts,
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
          ? 'user scope 的 [plugins."<plugin>@aw"] enabled 仍然存在。'
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
      ...(skillTriggerStatus
        ? {
            skillTriggerApplicability: skillTriggerStatus.skillTriggerApplicability,
            installOptions: skillTriggerStatus.installOptions,
            skillTriggerPreference: skillTriggerStatus.skillTriggerPreference,
            skillTriggerRuntimeMatches: skillTriggerStatus.skillTriggerRuntimeMatches,
            skillTriggerRuntimeState: skillTriggerStatus.skillTriggerRuntimeState,
            skillTriggerDrift: skillTriggerStatus.skillTriggerDrift,
          }
        : {}),
    };

    return {
      platform: 'codex',
      scope,
      initialized:
        scopeInitialized === 'yes' ||
        (scope === 'user' && pluginStatus.native.pluginInstalled) ||
        generatedArtifacts.length > 0 ||
        platformNativeFallbackEvidence,
      scopeInitialized: scopeInitialized as ScopeInitializedState,
      plugins: [pluginStatus],
    };
  }
}
