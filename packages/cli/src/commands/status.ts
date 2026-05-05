import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';

import type {
  EnvironmentDetection,
  InstalledLedger,
  InstalledScopeRecord,
  LifecycleConfigSnapshotMetadata,
  PlatformName,
  PluginStatusReport,
  RepoManagedProjectItemReport,
  PluginManifestSource,
  PluginMeta,
  Scope,
  StatusConfigHealth,
  StatusHealthSource,
  StatusScriptHealth,
  StatusReport,
} from '../types.js';
import { detectEnvironment } from '../utils/detect.js';
import { readInstalledLedger } from '../utils/local-marketplace.js';
import { readPluginManifest } from '../utils/manifest.js';
import { resolveEffectivePluginConfig, type PluginConfigIssue } from '../utils/plugin-config.js';
import {
  calculatePluginBundleFingerprint,
} from '../utils/plugin-scripts.js';
import { resolveLifecycleScriptForOs } from '../utils/plugin-script-contract.js';
import {
  createAdapters,
  formatStatusOutput,
  hasHistoricalEvidence,
  hasScopeManagedEvidence,
} from './common.js';
import { buildCommandCandidates, type CommandCandidate } from './discovery.js';
import {
  createCommandExecutionContext,
  type CommandExecutionContextInput,
} from './runtime.js';
import {
  normalizeStatusCommandOptions,
  type RawStatusCommandOptions,
} from './options.js';
import { isCodexProjectStatusFatalError } from './codex-project-safety.js';

type StatusCommandRuntime = CommandExecutionContextInput;

export type StatusHealth =
  | 'ready'
  | 'partial'
  | 'needsAttention'
  | 'external'
  | 'notInstalled'
  | 'unknown';

export interface StatusMatrixCell {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  projectRoot?: string;
  executionCwd: string;
  health: StatusHealth;
  report?: PluginStatusReport;
  evidenceSources: string[];
  healthSource: StatusHealthSource;
  config: StatusConfigHealth;
  scripts: StatusScriptHealth;
  configSources?: string[];
  configIssues?: PluginConfigIssue[];
  healthWarnings?: string[];
  disabledReason?: string;
  error?: string;
}

export interface StatusSummary {
  pluginName: string;
  health: StatusHealth;
  cells: Array<Pick<StatusMatrixCell, 'platform' | 'scope' | 'health' | 'healthSource' | 'config' | 'scripts' | 'projectKey' | 'configIssues'>>;
  nextSteps: string[];
}

interface StatusHealthManifestSource {
  healthSource: StatusHealthSource;
  plugin?: PluginMeta;
  warnings: string[];
}

export interface StatusMatrixReport {
  detection: EnvironmentDetection;
  filters: {
    platform?: PlatformName | 'both';
    scope?: Scope;
    plugins?: string[];
  };
  health: StatusHealth;
  summaries: StatusSummary[];
  cells: StatusMatrixCell[];
  reports: StatusReport[];
}

function statusErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runtimeOs(): 'linux' | 'darwin' | 'win32' {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
}

function isInsidePath(childPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function stripDotSlash(value: string): string {
  return value.startsWith('./') ? value.slice(2) : value;
}

async function fileDigest(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(filePath));
  return `sha256:${hash.digest('hex')}`;
}

function getStatusScopeRecord(
  ledger: InstalledLedger,
  pluginName: string,
  platform: PlatformName,
  scope: Scope,
  projectKey: string | undefined,
): InstalledScopeRecord<Record<string, unknown>> | undefined {
  const platformRecord = ledger.plugins[pluginName]?.platforms[platform];
  if (!platformRecord) {
    return undefined;
  }

  if (scope === 'user') {
    return platformRecord.userScope as InstalledScopeRecord<Record<string, unknown>> | undefined;
  }

  return projectKey
    ? platformRecord.projectScopes?.[projectKey] as InstalledScopeRecord<Record<string, unknown>> | undefined
    : undefined;
}

async function loadSnapshotPlugin(
  pluginName: string,
  snapshot: LifecycleConfigSnapshotMetadata,
): Promise<PluginMeta> {
  if (snapshot.pluginName !== pluginName) {
    throw new Error('snapshot belongs to another plugin');
  }

  const snapshotRoot = await fs.realpath(snapshot.snapshotRoot);
  const bundleRoot = await fs.realpath(snapshot.bundleRoot);
  const expectedBundleRoot = await fs.realpath(path.join(snapshotRoot, 'bundle'));
  if (bundleRoot !== expectedBundleRoot || !isInsidePath(bundleRoot, snapshotRoot)) {
    throw new Error('snapshot bundle root is outside snapshot root');
  }

  const manifestPath = await fs.realpath(snapshot.manifestPath);
  if (!isInsidePath(manifestPath, bundleRoot)) {
    throw new Error('snapshot manifest path is outside bundle root');
  }
  const digest = await fileDigest(manifestPath);
  if (digest !== snapshot.sourceManifestDigest) {
    throw new Error('snapshot manifest digest mismatch');
  }
  const fingerprint = await calculatePluginBundleFingerprint(bundleRoot);
  if (fingerprint !== snapshot.bundleFingerprint) {
    throw new Error('snapshot bundle fingerprint mismatch');
  }

  const plugin = await readPluginManifest(bundleRoot, { mode: 'bundle' });
  if (
    plugin.manifest.name !== snapshot.pluginName ||
    plugin.manifest.version !== snapshot.pluginVersion ||
    path.resolve(plugin.manifestPath) !== path.resolve(manifestPath)
  ) {
    throw new Error('snapshot manifest identity mismatch');
  }
  return plugin;
}

async function resolveStatusHealthManifest(options: {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  ledger: InstalledLedger;
  currentPlugin?: PluginMeta;
  hasHistoricalEvidence: boolean;
}): Promise<StatusHealthManifestSource> {
  const warnings: string[] = [];
  const scopeRecord = getStatusScopeRecord(
    options.ledger,
    options.pluginName,
    options.platform,
    options.scope,
    options.projectKey,
  );

  const snapshot = scopeRecord?.lifecycleConfigSnapshot;
  if (snapshot) {
    try {
      return {
        healthSource: 'installSnapshot',
        plugin: await loadSnapshotPlugin(options.pluginName, snapshot),
        warnings,
      };
    } catch (error) {
      warnings.push(
        `install snapshot unusable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (options.currentPlugin) {
    return {
      healthSource: 'currentCatalog',
      plugin: options.currentPlugin,
      warnings,
    };
  }

  return {
    healthSource: options.hasHistoricalEvidence ? 'historical' : 'none',
    warnings,
  };
}

async function pathExistsInsideBundle(bundleRoot: string, relativePath: string): Promise<boolean> {
  const resolvedRoot = path.resolve(bundleRoot);
  const absolutePath = path.resolve(resolvedRoot, stripDotSlash(relativePath));
  if (!isInsidePath(absolutePath, resolvedRoot) || !(await fs.pathExists(absolutePath))) {
    return false;
  }
  const [realRoot, realPath] = await Promise.all([
    fs.realpath(resolvedRoot),
    fs.realpath(absolutePath),
  ]);
  return isInsidePath(realPath, realRoot);
}

async function resolveScriptHealth(plugin: PluginMeta | undefined): Promise<StatusScriptHealth> {
  const manifest = plugin?.manifest;
  if (!plugin || !manifest) {
    return 'not_declared';
  }

  const lifecycle = manifest.scripts?.lifecycle ?? {};
  const helperPath = manifest.scripts?.helpers?.config;
  if (Object.keys(lifecycle).length === 0 && !helperPath) {
    return 'not_declared';
  }

  if (helperPath && !(await pathExistsInsideBundle(plugin.rootDir, helperPath))) {
    return 'missing-from-bundle';
  }

  for (const selector of Object.values(lifecycle)) {
    const entry = resolveLifecycleScriptForOs(selector, runtimeOs());
    if (!entry) {
      return 'unsupported-on-current-os';
    }
    if (!(await pathExistsInsideBundle(plugin.rootDir, entry.path))) {
      return 'missing-from-bundle';
    }
  }

  return 'declared';
}

function resolveConfigSourceSummary(
  manifest: PluginManifestSource,
  sources: Record<string, string>,
): string[] {
  const sourceSet = new Set<string>();
  for (const key of Object.keys(manifest.config?.schema ?? {})) {
    const source = sources[key];
    if (source && source !== 'missing') {
      sourceSet.add(source);
    }
  }
  return [...sourceSet].sort();
}

async function resolveConfigHealth(options: {
  plugin: PluginMeta | undefined;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{ config: StatusConfigHealth; configSources?: string[]; configIssues?: PluginConfigIssue[] }> {
  if (!options.plugin?.manifest.config?.schema) {
    return { config: 'no-schema' };
  }

  const effective = await resolveEffectivePluginConfig({
    pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest,
    cwd: options.cwd,
    env: options.env,
  });
  const configIssues = effective.issues.length > 0
    ? effective.issues.map((issue) => ({
        type: issue.type,
        key: issue.key,
        ...(issue.source ? { source: issue.source } : {}),
        message: issue.message,
      }))
    : undefined;
  if (effective.issues.some((issue) => issue.type === 'invalid-config')) {
    return {
      config: 'invalid-config',
      configSources: resolveConfigSourceSummary(options.plugin.manifest, effective.sources),
      ...(configIssues ? { configIssues } : {}),
    };
  }
  if (effective.issues.some((issue) => issue.type === 'missing-required')) {
    return {
      config: 'missing-required',
      configSources: resolveConfigSourceSummary(options.plugin.manifest, effective.sources),
      ...(configIssues ? { configIssues } : {}),
    };
  }
  return {
    config: 'configured',
    configSources: resolveConfigSourceSummary(options.plugin.manifest, effective.sources),
  };
}

async function resolveStatusRuntimeHealth(options: {
  pluginName: string;
  platform: PlatformName;
  scope: Scope;
  projectKey?: string;
  ledger: InstalledLedger;
  currentPlugin?: PluginMeta;
  hasHistoricalEvidence: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  healthSource: StatusHealthSource;
  config: StatusConfigHealth;
  scripts: StatusScriptHealth;
  configSources?: string[];
  configIssues?: PluginConfigIssue[];
  healthWarnings?: string[];
}> {
  const source = await resolveStatusHealthManifest(options);
  const config = await resolveConfigHealth({
    plugin: source.plugin,
    cwd: options.cwd,
    env: options.env,
  });
  return {
    healthSource: source.healthSource,
    ...config,
    scripts: await resolveScriptHealth(source.plugin),
    ...(source.warnings.length > 0 ? { healthWarnings: source.warnings } : {}),
  };
}

function platformLabel(platform: PlatformName): string {
  return platform === 'codex' ? 'Codex' : 'Claude Code';
}

function healthLabel(health: StatusHealth): string {
  return {
    ready: '可用',
    partial: '部分可用',
    needsAttention: '需要处理',
    external: '外部管理',
    notInstalled: '未安装',
    unknown: '状态未知',
  }[health];
}

function formatSkillTriggerRuntime(plugin: PluginStatusReport): string | undefined {
  if (!plugin.skillTriggerRuntimeState) {
    return undefined;
  }

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

function hasRuntimeEvidence(plugin: PluginStatusReport): boolean {
  return (
    plugin.native.pluginInstalled ||
    plugin.generatedArtifacts.length > 0 ||
    plugin.platformRuntimeEvidence?.present === true ||
    plugin.platformNativeFallbackEvidence?.present === true ||
    hasScopeManagedEvidence(plugin)
  );
}

function hasMissingArtifacts(plugin: PluginStatusReport): boolean {
  return (
    plugin.generatedArtifacts.some((artifact) => !artifact.exists) ||
    plugin.artifactsInitialized === false
  );
}

function getRepoManagedProjectItems(plugin: PluginStatusReport): RepoManagedProjectItemReport[] {
  return plugin.repoManagedSessionState?.items ?? [];
}

function hasRepoManagedActionableItems(plugin: PluginStatusReport): boolean {
  return getRepoManagedProjectItems(plugin).some((item) =>
    item.state === 'missing' ||
      item.state === 'drifted' ||
      item.state === 'orphan' ||
      item.state === 'blockedByProjectTrust',
  );
}

function hasRepoManagedUnknownItems(plugin: PluginStatusReport): boolean {
  return getRepoManagedProjectItems(plugin).some((item) =>
    item.state === 'unknown' || item.state === 'projectTrustUnknown',
  );
}

function hasManagedRepoEvidence(plugin: PluginStatusReport): boolean {
  return hasScopeManagedEvidence(plugin) || getRepoManagedProjectItems(plugin).some((item) => item.tracked);
}

function isReadySkillsOnlyProjectStatus(plugin: PluginStatusReport): boolean {
  return Array.isArray(plugin.projectManagedKinds) &&
    plugin.projectManagedKinds.length > 0 &&
    plugin.projectManagedKinds.every((kind) => kind === 'skill') &&
    getRepoManagedProjectItems(plugin).length > 0 &&
    getRepoManagedProjectItems(plugin).every((item) => item.kind === 'skill' && item.state === 'visible') &&
    plugin.skillTriggerDrift === 'no' &&
    plugin.externalOwnership?.checkState !== 'unknown';
}

function isCodexUserNativePlugin(
  plugin: PluginStatusReport,
  platform: PlatformName,
  scope: Scope,
): boolean {
  return platform === 'codex' && scope === 'user' && plugin.native.requiresNativePlugin === true;
}

function hasNativeRecovery(plugin: PluginStatusReport): boolean {
  return plugin.native.recovery?.present === true;
}

function hasGeneralHealthDowngrade(plugin: PluginStatusReport): boolean {
  return (
    (plugin.ledgerStateStatus === 'degraded' && !isReadySkillsOnlyProjectStatus(plugin)) ||
    plugin.catalogCompatibility === 'missing' ||
    plugin.catalogCompatibility === 'capabilityChanged' ||
    plugin.skillTriggerDrift === 'yes' ||
    hasMissingArtifacts(plugin) ||
    plugin.currentCatalog?.available === false
  );
}

function resolveCodexUserNativeHealth(plugin: PluginStatusReport): StatusHealth {
  const installed = plugin.native.pluginInstalled;
  const enabled = plugin.native.pluginEnabled === true;
  const hasCacheEvidence =
    plugin.native.cacheStatus === 'active' ||
    plugin.native.cacheStatus === 'ambiguous' ||
    plugin.native.cacheStatus === 'invalid';
  const hasSuccessfulScopeRecord = plugin.scopeManagedEvidence?.ledger === true;
  const hasManagedEvidence = hasScopeManagedEvidence(plugin);

  if (hasRepoManagedActionableItems(plugin) || hasGeneralHealthDowngrade(plugin)) {
    return 'needsAttention';
  }

  if (hasRepoManagedUnknownItems(plugin) || plugin.skillTriggerDrift === 'unknown') {
    return 'unknown';
  }

  if (!installed && !enabled) {
    return hasManagedEvidence || hasNativeRecovery(plugin) || hasCacheEvidence
      ? 'needsAttention'
      : 'notInstalled';
  }

  if (!installed || !enabled) {
    return 'needsAttention';
  }

  if (hasNativeRecovery(plugin) || !hasSuccessfulScopeRecord || plugin.scopeInitialized !== 'yes') {
    return 'needsAttention';
  }

  return 'ready';
}

function resolvePluginHealth(
  plugin: PluginStatusReport | undefined,
  platform: PlatformName,
  scope: Scope,
): StatusHealth {
  if (!plugin) {
    return 'unknown';
  }

  if (plugin.externalOwnership?.checkState === 'unknown') {
    return 'unknown';
  }

  if (plugin.externalOwnership?.present) {
    if (hasRuntimeEvidence(plugin) || hasManagedRepoEvidence(plugin) || hasNativeRecovery(plugin)) {
      return 'needsAttention';
    }
    return 'external';
  }

  if (isCodexUserNativePlugin(plugin, platform, scope)) {
    return resolveCodexUserNativeHealth(plugin);
  }

  if (!hasRuntimeEvidence(plugin)) {
    return plugin.scopeInitialized === 'unknown' ? 'unknown' : 'notInstalled';
  }

  if (plugin.scopeInitialized === 'unknown') {
    return 'unknown';
  }

  if (hasRepoManagedActionableItems(plugin)) {
    return 'needsAttention';
  }

  if (hasGeneralHealthDowngrade(plugin)) {
    return 'needsAttention';
  }

  if (
    hasRepoManagedUnknownItems(plugin) ||
    plugin.skillTriggerDrift === 'unknown'
  ) {
    return 'unknown';
  }

  if (plugin.scopeInitialized !== 'yes') {
    return 'partial';
  }

  return 'ready';
}

const HEALTH_SEVERITY: Record<StatusHealth, number> = {
  needsAttention: 5,
  partial: 4,
  unknown: 3,
  external: 2,
  ready: 1,
  notInstalled: 0,
};

function combineHealth(healths: StatusHealth[]): StatusHealth {
  const meaningful = healths.filter((health) => health !== 'notInstalled');
  if (meaningful.length === 0) {
    return 'notInstalled';
  }

  return meaningful.sort((left, right) => HEALTH_SEVERITY[right] - HEALTH_SEVERITY[left])[0];
}

function describeEvidenceSource(source: string): string {
  return {
    ledger: 'ledger',
    tracking: 'tracking',
    codexNativeConfig: 'Codex enabled config',
    codexNativeCache: 'Codex active cache',
    codexNativeRecovery: 'Codex native recovery',
    codexSharedNativeRef: 'shared native ref',
    claudeSettings: 'Claude settings',
    claudeInstalledPlugins: 'Claude installed plugins',
  }[source] ?? source;
}

function describeEvidence(cell: StatusMatrixCell): string {
  const evidence = new Set(cell.evidenceSources.map(describeEvidenceSource));
  if (cell.report?.scopeManagedEvidence?.ledger) {
    evidence.add('ledger');
  }
  if (cell.report?.scopeManagedEvidence?.tracking) {
    evidence.add('tracking');
  }
  if (cell.report?.scopeManagedEvidence?.sharedNativeRef) {
    evidence.add('shared native ref');
  }
  if (cell.report?.platformRuntimeEvidence?.present) {
    evidence.add('runtime');
  }
  if (cell.report?.platformNativeFallbackEvidence?.present) {
    evidence.add('native fallback');
  }
  if (cell.report?.externalOwnership?.present) {
    evidence.add('external ownership');
  }

  return evidence.size > 0 ? [...evidence].join(', ') : '无受管证据';
}

function describeCatalog(plugin: PluginStatusReport | undefined): string | undefined {
  if (!plugin?.currentCatalog) {
    return undefined;
  }

  if (plugin.currentCatalog.available) {
    return plugin.currentCatalog.source === 'embedded'
      ? `当前 catalog 来自 embedded（本地 marketplace 未处于健康状态：${plugin.currentCatalog.reason ?? '原因未知'}）`
      : '当前 catalog 可用';
  }

  return `当前 catalog 中找不到插件目录（来自 ${plugin.currentCatalog.source}${plugin.currentCatalog.reason ? `，${plugin.currentCatalog.reason}` : ''}）`;
}

function describeNative(
  plugin: PluginStatusReport | undefined,
  platform: PlatformName,
  scope: Scope,
): string | undefined {
  if (!plugin) {
    return undefined;
  }

  if (platform === 'codex') {
    if (scope === 'user' && plugin.native.requiresNativePlugin) {
      const recovery = plugin.native.recovery;
      if (recovery?.present) {
        const stateLabels = {
          pending_after_native_write: 'native 写入已完成，AW 后续步骤仍待完成',
          post_check_failed: 'native 写入已完成，但 post-check 失败',
          lifecycle_failed: 'native 写入已完成，但 lifecycle 失败',
          tracking_write_failed: 'native 写入已完成，但 tracking 写入失败',
          ledger_write_failed: 'native 写入已完成，但 ledger 写入失败',
          snapshot_write_failed: 'native 写入已完成，但 snapshot 写入失败',
          cleanup_failed: 'native 残留大概率已清理，但 recovery breadcrumb 仍未删除',
        } as const;
        const summary = stateLabels[recovery.state ?? 'pending_after_native_write'];
        if (recovery.evidenceMatches === false) {
          return `Codex native recovery breadcrumb 仍在：${summary}。当前 cache/config 已不匹配，通常表示 breadcrumb 删除失败。`;
        }
        return `Codex native 已写入，但 AW 安装或清理未完成：${summary}。`;
      }

      if (plugin.native.pluginInstalled && plugin.native.pluginEnabled !== true) {
        return 'Codex active cache 仍在，但 enabled config 缺失或已关闭。';
      }

      if (!plugin.native.pluginInstalled && plugin.native.pluginEnabled === true) {
        return 'Codex enabled config 已存在，但 active cache 缺失，原生安装未完成。';
      }
    }

    if (scope === 'project' && hasManagedRepoEvidence(plugin)) {
      if (plugin.native.pluginInstalled) {
        return plugin.native.pluginEnabled === true
          ? '附加诊断：用户级 Codex native cache 和 enabled config 也存在'
          : '附加诊断：用户级 Codex native cache 也存在';
      }
      return undefined;
    }
    if (plugin.native.marketplaceRegistered) {
      const source = plugin.native.marketplaceSource ?? plugin.native.declaredSource;
      return source
        ? `Codex 已注册本地 marketplace：${source}`
        : 'Codex 已注册本地 marketplace';
    }
    if (plugin.native.marketplaceRootResolution === 'missing') {
      return 'Codex marketplace aw 未注册，需要重新注册本地 marketplace';
    }
    if (plugin.native.marketplaceRootResolution === 'installedCopy') {
      return 'Codex marketplace aw 不是 local source 注册，需要重新注册本地 marketplace';
    }
    if (plugin.native.marketplaceRootResolution === 'unknown') {
      const source = plugin.native.marketplaceSource ?? plugin.native.declaredSource;
      return source
        ? `Codex marketplace source 未指向当前 AW marketplace：${source}`
        : 'Codex marketplace source 无法确认，需要重新注册本地 marketplace';
    }
  }

  if (plugin.native.pluginInstalled) {
    return plugin.native.pluginEnabled === true ? '原生插件已安装并启用' : '原生插件 cache 仍然存在';
  }

  return undefined;
}

function describeSkillTrigger(plugin: PluginStatusReport | undefined): string | undefined {
  if (!plugin?.skillTriggerPreference && !plugin?.skillTriggerRuntimeState) {
    return undefined;
  }

  const parts = [
    plugin.skillTriggerPreference ? `账本偏好 ${plugin.skillTriggerPreference}` : undefined,
    formatSkillTriggerRuntime(plugin) ? `运行时 ${formatSkillTriggerRuntime(plugin)}` : undefined,
    plugin.skillTriggerDrift ? `漂移 ${plugin.skillTriggerDrift}` : undefined,
  ].filter(Boolean);
  return `skill trigger：${parts.join('，')}`;
}

function formatRepoManagedItemLabel(
  item: RepoManagedProjectItemReport,
): string {
  if (item.kind === 'skill') {
    return `skill ${item.artifactKey ?? item.path}`;
  }
  if (item.kind === 'mcpServer') {
    return `mcp ${item.artifactKey ?? item.path}`;
  }
  return item.kind;
}

function describeRepoManagedState(plugin: PluginStatusReport | undefined): string | undefined {
  if (!plugin?.repoManagedSessionState) {
    return undefined;
  }

  const parts: string[] = [];
  if (plugin.repoManagedSessionState.skills) {
    parts.push(`skills=${plugin.repoManagedSessionState.skills.state}`);
  }
  if (plugin.repoManagedSessionState.mcpServers) {
    parts.push(`mcpServers=${plugin.repoManagedSessionState.mcpServers.state}`);
  }

  const notableItems = (plugin.repoManagedSessionState.items ?? [])
    .filter((item) => item.state !== 'visible' && item.state !== 'absent')
    .slice(0, 4)
    .map((item) => `${formatRepoManagedItemLabel(item)}=${item.state}`);
  parts.push(...notableItems);

  if (parts.length === 0) {
    return undefined;
  }

  return `repo-managed：${parts.join('，')}`;
}

function describeRuntimeHealth(cell: StatusMatrixCell): string {
  const source = {
    installSnapshot: 'install snapshot',
    currentCatalog: 'current catalog',
    historical: 'historical evidence',
    none: 'none',
  }[cell.healthSource];
  const sourceSummary = cell.configSources && cell.configSources.length > 0
    ? `，配置来源 ${cell.configSources.join('/')}`
    : '';
  return `config=${cell.config}${sourceSummary}，scripts=${cell.scripts}，healthSource=${source}`;
}

function describeCell(cell: StatusMatrixCell): string {
  if (cell.error) {
    return `读取失败：${cell.error}`;
  }

  if (!cell.report || cell.health === 'notInstalled') {
    return '未发现 AW 管理状态。';
  }

  const descriptions = [
    `证据：${describeEvidence(cell)}`,
    describeRepoManagedState(cell.report),
    describeNative(cell.report, cell.platform, cell.scope),
    describeCatalog(cell.report),
    describeRuntimeHealth(cell),
    describeSkillTrigger(cell.report),
  ].filter(Boolean);

  if (cell.report.driftWarnings.length > 0) {
    descriptions.push(`注意：${cell.report.driftWarnings.join('；')}`);
  }

  return descriptions.join('；') || '未发现更多诊断。';
}

function nextStepForCell(cell: StatusMatrixCell): string | undefined {
  const suffix = ` -p ${cell.platform} -s ${cell.scope}`;
  if (cell.health === 'notInstalled') {
    return `安装 ${cell.pluginName}：aw install ${cell.pluginName}${suffix}`;
  }
  if (cell.health === 'external') {
    return `检查 ${cell.pluginName} 的外部 marketplace 占用后，再决定是否迁移到 AW 管理。`;
  }
  if (cell.report?.externalOwnership?.present && hasRuntimeEvidence(cell.report)) {
    return `先解除 ${cell.pluginName} 的同名外部 native 插件冲突，再重新检查当前 repo-managed 状态。`;
  }
  if (cell.error) {
    return `重新运行 aw status ${cell.pluginName}${suffix} --verbose 查看读取失败细节。`;
  }
  const unknownItem = cell.report?.repoManagedSessionState?.items?.find((item) =>
    item.state === 'unknown' || item.state === 'projectTrustUnknown',
  );
  if (unknownItem) {
    return `先修复 ${formatRepoManagedItemLabel(unknownItem)} 的不可判定状态，再重新运行 aw status ${cell.pluginName}${suffix}。`;
  }
  const blockedItem = cell.report?.repoManagedSessionState?.items?.find((item) =>
    item.state === 'blockedByProjectTrust',
  );
  if (blockedItem) {
    return `先让 Codex 信任当前仓库，再重新检查 ${formatRepoManagedItemLabel(blockedItem)} 的 project scope 状态。`;
  }
  const orphanItem = cell.report?.repoManagedSessionState?.items?.find((item) =>
    item.state === 'orphan',
  );
  if (orphanItem) {
    return `先处理未受管的 ${formatRepoManagedItemLabel(orphanItem)}，再决定是重新受管还是手动保留。`;
  }
  if (cell.report?.catalogCompatibility === 'missing') {
    return `当前插件目录缺失；如需清理历史状态，运行 aw uninstall ${cell.pluginName}${suffix}`;
  }
  if (cell.platform === 'codex' && cell.scope === 'user' && cell.report?.native.requiresNativePlugin) {
    if (cell.report.native.recovery?.present) {
      if (cell.report.native.recovery.evidenceMatches === false) {
        return `重新运行 aw uninstall ${cell.pluginName}${suffix} 清理 recovery breadcrumb；如果 Codex cache/config 已手动清掉，AW 仍需要移除这条恢复记录。`;
      }
      return `当前 Codex native 安装未完整收口；运行 aw install ${cell.pluginName}${suffix} 修复，或运行 aw uninstall ${cell.pluginName}${suffix} 清理残留。`;
    }
    if (cell.report.native.pluginInstalled && cell.report.native.pluginEnabled !== true) {
      return `先确认 ${cell.pluginName} 的 Codex cache 残留来源；当前 AW 不会在缺少归属证据时静默删除它。`;
    }
    if (!cell.report.native.pluginInstalled && cell.report.native.pluginEnabled === true) {
      return `重新运行 aw install ${cell.pluginName}${suffix}，让 Codex 同时补齐 enabled config 和 active cache。`;
    }
    if (
      cell.report.native.pluginInstalled &&
      cell.report.native.pluginEnabled === true &&
      cell.report.scopeManagedEvidence?.ledger !== true
    ) {
      return `当前 Codex native 状态已存在，但 AW 缺少成功 scope record；请先运行 aw install ${cell.pluginName}${suffix} 修复账本。`;
    }
  }
  if (cell.report?.catalogCompatibility === 'capabilityChanged') {
    return `插件能力声明已变化，运行 aw upgrade ${cell.pluginName}${suffix}`;
  }
  if (
    cell.report?.ledgerStateStatus === 'degraded' &&
    cell.report.skillTriggerApplicability === 'overridable' &&
    (
      cell.report.skillTriggerDrift === 'unknown' ||
      !cell.report.skillTriggerPreference
    )
  ) {
    return `本机安装账本处于 degraded 状态；下一次 install/upgrade 请显式传 --skill-trigger default|manual|auto。`;
  }
  if (
    cell.platform === 'codex' &&
    cell.report?.native.marketplaceRegistered === false &&
    cell.report.driftWarnings.some((warning) => warning.includes('Codex marketplace'))
  ) {
    return `重新注册 Codex marketplace：aw install ${cell.pluginName} --platform codex --scope ${cell.scope}`;
  }
  if (cell.report?.skillTriggerDrift === 'yes') {
    return cell.report.skillTriggerApplicability === 'overridable'
      ? `重新应用 skill trigger 偏好：aw upgrade ${cell.pluginName}${suffix} --skill-trigger ${cell.report.skillTriggerPreference ?? 'default'}`
      : `刷新当前 skill runtime：aw upgrade ${cell.pluginName}${suffix}`;
  }

  return undefined;
}

function createSummary(pluginName: string, cells: StatusMatrixCell[]): StatusSummary {
  const health = combineHealth(cells.map((cell) => cell.health));
  const nextSteps = [
    ...new Set(
      cells
        .map(nextStepForCell)
        .filter((step): step is string => Boolean(step)),
    ),
  ];

  if (nextSteps.length === 0) {
    nextSteps.push(`查看详情：aw status ${pluginName} --verbose`);
  }

  return {
    pluginName,
    health,
    cells: cells.map((cell) => ({
      platform: cell.platform,
      scope: cell.scope,
      health: cell.health,
      healthSource: cell.healthSource,
      config: cell.config,
      scripts: cell.scripts,
      projectKey: cell.projectKey,
      ...(cell.configIssues ? { configIssues: cell.configIssues } : {}),
    })),
    nextSteps,
  };
}

function createNotInstalledSummary(pluginName: string): StatusSummary {
  return {
    pluginName,
    health: 'notInstalled',
    cells: [],
    nextSteps: [`安装 ${pluginName}：aw install ${pluginName}`],
  };
}

function formatDetectionSummary(detection: EnvironmentDetection): string {
  const parts = (['codex', 'claude'] as const).map((platform) => {
    const result = detection[platform];
    return `${platformLabel(platform)} ${result.available ? '可用' : '不可用'}`;
  });
  return parts.join('，');
}

function formatDefaultStatusOutput(matrix: StatusMatrixReport): string {
  const lines: string[] = [
    '状态摘要',
    `平台检测：${formatDetectionSummary(matrix.detection)}`,
  ];

  if (matrix.summaries.length === 0) {
    lines.push('未发现 AW 管理的插件。');
    lines.push('');
    lines.push('下一步');
    lines.push('- 运行 aw install 进入交互式安装，或运行 aw install <plugin> 安装指定插件。');
    return lines.join('\n');
  }

  for (const summary of matrix.summaries) {
    const cellCount = summary.cells.length;
    const suffix = cellCount > 0 ? `，${cellCount} 个状态点` : '';
    lines.push(`- ${summary.pluginName}：${healthLabel(summary.health)}${suffix}`);
  }

  lines.push('');
  lines.push('明细');
  for (const cell of matrix.cells) {
    lines.push(
      `- ${cell.pluginName} / ${platformLabel(cell.platform)} / ${cell.scope} scope：${healthLabel(cell.health)}。${describeCell(cell)}`,
    );
  }

  const steps = [
    ...new Set(matrix.summaries.flatMap((summary) => summary.nextSteps)),
  ];
  if (steps.length > 0) {
    lines.push('');
    lines.push('下一步');
    for (const step of steps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join('\n');
}

function formatStatusJsonPayload(
  matrix: StatusMatrixReport,
  verbose: boolean | undefined,
): string {
  return JSON.stringify(
    matrix,
    null,
    verbose ? 2 : 0,
  );
}

function createReportsByKey(): Map<string, StatusReport> {
  return new Map<string, StatusReport>();
}

function upsertReport(
  reportsByKey: Map<string, StatusReport>,
  candidate: CommandCandidate,
  status: StatusReport,
): void {
  const key = `${candidate.platform}:${candidate.scope}`;
  const report = reportsByKey.get(key) ?? {
    platform: candidate.platform,
    scope: candidate.scope,
    initialized: false,
    scopeInitialized: status.scopeInitialized,
    plugins: [],
  };
  report.initialized ||= status.initialized;
  report.scopeInitialized ??= status.scopeInitialized;
  report.plugins.push(...status.plugins);
  reportsByKey.set(key, report);
}

function sortReports(reports: StatusReport[]): StatusReport[] {
  const scopeOrder = { user: 0, project: 1 };
  const platformOrder = { codex: 0, claude: 1 };
  return reports.sort((left, right) =>
    platformOrder[left.platform] - platformOrder[right.platform] ||
    scopeOrder[left.scope] - scopeOrder[right.scope],
  );
}

function sortCells(cells: StatusMatrixCell[]): StatusMatrixCell[] {
  const scopeOrder = { user: 0, project: 1 };
  const platformOrder = { codex: 0, claude: 1 };
  return cells.sort((left, right) =>
    left.pluginName.localeCompare(right.pluginName) ||
    platformOrder[left.platform] - platformOrder[right.platform] ||
    scopeOrder[left.scope] - scopeOrder[right.scope] ||
    (left.projectKey ?? '').localeCompare(right.projectKey ?? ''),
  );
}

export async function statusCommand(
  pluginNames: string[],
  rawOptions: RawStatusCommandOptions,
  runtime: StatusCommandRuntime = {},
): Promise<{ reports: StatusReport[]; output: string; matrix: StatusMatrixReport }> {
  const options = normalizeStatusCommandOptions(rawOptions);
  const context = createCommandExecutionContext(runtime);
  const env = context.env;
  const adapters = createAdapters(options.cwd, context);
  const requestedPlugins = pluginNames.length > 0 ? pluginNames : undefined;
  const ledger = await readInstalledLedger(env);
  const candidates = await buildCommandCandidates({
    command: 'status',
    cwd: options.cwd,
    scopeFilter: options.scope,
    platformFilter: options.platform,
    pluginNames: requestedPlugins,
    env,
  });

  const reportsByKey = createReportsByKey();
  const cells: StatusMatrixCell[] = [];

  for (const candidate of candidates) {
    if (candidate.evidence.readErrors.length > 0) {
      cells.push({
        pluginName: candidate.pluginName,
        platform: candidate.platform,
        scope: candidate.scope,
        projectKey: candidate.projectKey,
        projectRoot: candidate.projectRoot,
        executionCwd: candidate.executionCwd,
        health: 'unknown',
        evidenceSources: candidate.evidence.sources,
        healthSource: 'none',
        config: 'no-schema',
        scripts: 'not_declared',
        disabledReason: candidate.disabledReason,
        error: candidate.evidence.readErrors.join('；'),
      });
      continue;
    }

    try {
      const status = await adapters[candidate.platform].status(
        candidate.target.plugin,
        candidate.scope,
      );
      const pluginStatus = status.plugins[0];
      const pluginHasAnyDiscoveryEvidence = Object.values(
        candidate.evidenceByPlatformScope,
      ).some((evidence) => evidence.sources.length > 0);
      const hasEvidence =
        pluginStatus &&
        (hasHistoricalEvidence(pluginStatus) || hasRuntimeEvidence(pluginStatus));
      const hasHistoricalHealthEvidence =
        Boolean(hasEvidence) ||
        candidate.evidence.sources.length > 0 ||
        pluginHasAnyDiscoveryEvidence;

      if (requestedPlugins === undefined && !hasEvidence && !pluginHasAnyDiscoveryEvidence) {
        continue;
      }

      const runtimeHealth = await resolveStatusRuntimeHealth({
        pluginName: candidate.pluginName,
        platform: candidate.platform,
        scope: candidate.scope,
        projectKey: candidate.projectKey,
        ledger,
        currentPlugin: candidate.target.currentPlugin,
        hasHistoricalEvidence: hasHistoricalHealthEvidence,
        cwd: candidate.executionCwd,
        env,
      });

      upsertReport(reportsByKey, candidate, status);
      cells.push({
        pluginName: candidate.pluginName,
        platform: candidate.platform,
        scope: candidate.scope,
        projectKey: candidate.projectKey,
        projectRoot: candidate.projectRoot,
        executionCwd: candidate.executionCwd,
        health: resolvePluginHealth(pluginStatus, candidate.platform, candidate.scope),
        report: pluginStatus,
        evidenceSources: candidate.evidence.sources,
        ...runtimeHealth,
        disabledReason: candidate.disabledReason,
      });
    } catch (error) {
      if (isCodexProjectStatusFatalError(error)) {
        throw error;
      }

      cells.push({
        pluginName: candidate.pluginName,
        platform: candidate.platform,
        scope: candidate.scope,
        projectKey: candidate.projectKey,
        projectRoot: candidate.projectRoot,
        executionCwd: candidate.executionCwd,
        health: 'unknown',
        evidenceSources: candidate.evidence.sources,
        healthSource: 'none',
        config: 'no-schema',
        scripts: 'not_declared',
        disabledReason: candidate.disabledReason,
        error: statusErrorMessage(error),
      });
    }
  }

  const sortedCells = sortCells(cells);
  const cellsByPlugin = new Map<string, StatusMatrixCell[]>();
  for (const cell of sortedCells) {
    cellsByPlugin.set(cell.pluginName, [...(cellsByPlugin.get(cell.pluginName) ?? []), cell]);
  }

  const summaries = [...cellsByPlugin.entries()]
    .map(([pluginName, pluginCells]) => createSummary(pluginName, pluginCells));
  for (const pluginName of requestedPlugins ?? []) {
    if (!cellsByPlugin.has(pluginName)) {
      summaries.push(createNotInstalledSummary(pluginName));
    }
  }

  const reports = sortReports([...reportsByKey.values()]);
  const detection = await detectEnvironment(options.cwd, env);
  const matrix: StatusMatrixReport = {
    detection,
    filters: {
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      ...(requestedPlugins ? { plugins: requestedPlugins } : {}),
    },
    health: combineHealth(summaries.map((summary) => summary.health)),
    summaries,
    cells: sortedCells,
    reports,
  };

  const humanOutput = options.verbose
    ? [
        formatDefaultStatusOutput(matrix),
        '',
        '诊断详情',
        formatStatusOutput(detection, reports),
      ].join('\n').trimEnd()
    : formatDefaultStatusOutput(matrix);

  return {
    reports,
    matrix,
    output: options.json
      ? formatStatusJsonPayload(matrix, options.verbose)
      : humanOutput,
  };
}
