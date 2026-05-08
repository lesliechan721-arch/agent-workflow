import type {
  CatalogResolution,
  GeneratedArtifact,
  NativePluginsByPlatform,
  Scope,
  SkippedUpgradeTarget,
} from '../types.js';

export interface CliMarketplaceReceipt {
  rootDir: string;
  changed: boolean;
  mode?: 'readOnly' | 'runtimeWritable';
  catalog: CatalogResolution;
}

export interface CliCommandResult {
  platforms: string[];
  plugins: string[];
  warnings: string[];
  skipped?: SkippedUpgradeTarget[];
  receiptTargets?: ReceiptTarget[];
  receiptActions?: CliCommandReceiptAction[];
  nativePlugins?: NativePluginsByPlatform;
  repoManagedArtifacts?: GeneratedArtifact[];
  marketplace?: CliMarketplaceReceipt;
  receiptDetails?: CliCommandReceiptDetails;
}

export interface CliCommandExecutionGroup {
  scope: Scope;
  platforms: string[];
  plugins: string[];
}

export interface CliCommandReceipt {
  result: CliCommandResult;
  groups: CliCommandExecutionGroup[];
}

export interface CliInitReceipt {
  rootDir: string;
  changed: boolean;
  warnings: string[];
}

export type CliReceiptCommand = 'install' | 'uninstall' | 'upgrade';

export interface CliCommandReceiptAction {
  type: 'installDependency' | 'upgradeDependency';
  plugin: string;
  platform: string;
  scope: Scope;
  requested?: boolean;
  dependencyOf?: ReceiptTarget[];
}

interface ReceiptTarget {
  plugin: string;
  platform: string;
  scope: Scope;
  projectKey?: string;
  requested?: boolean;
  dependencyOf?: ReceiptTarget[];
}

export interface ReceiptFileEntry {
  path: string;
  repoRelativePath?: string;
}

export interface ReceiptProjectArtifactIdentityEntry extends ReceiptFileEntry {
  sharedIdentityId?: string;
}

export interface ReceiptProjectReferenceEntry {
  location: ReceiptTarget;
  recordPath: string;
  token?: string;
  command?: string;
}

export interface ReceiptNativeTransactionMarker {
  status: 'none' | 'markerOnlyInstall' | 'markerOnlyUninstall' | 'recordInstallResidual';
  recordCommitted?: boolean;
  markerPending?: boolean;
  needsAttention?: boolean;
  repairCommand?: string;
  cleanupCommand?: string;
}

export interface ReceiptDependencyIndexSummary {
  trusted: boolean;
  coverageReason?: string[];
  verifiedLocations?: ReceiptTarget[];
  revisitLocations?: ReceiptTarget[];
  recoveryMessage?: string | null;
  retiredEntries?: Array<{
    location: ReceiptTarget;
    recordPath: string;
  }>;
}

export interface ReceiptSharedSkillTriggerOwnerSummary {
  present: boolean;
  needsTakeover?: boolean;
  ownerConflict?: boolean;
  suppressedOwnerConflict?: boolean;
}

export interface CliCommandReceiptDetails {
  privateStateFiles?: ReceiptFileEntry[];
  ignoredStateFiles?: ReceiptFileEntry[];
  sharedConfigFiles?: ReceiptFileEntry[];
  projectLocalConfigFiles?: ReceiptFileEntry[];
  projectArtifactIdentityFiles?: ReceiptProjectArtifactIdentityEntry[];
  nativeTransactionMarker?: ReceiptNativeTransactionMarker;
  dependencyIndex?: ReceiptDependencyIndexSummary;
  staleProjectReferences?: ReceiptProjectReferenceEntry[];
  sharedSkillTriggerOwner?: ReceiptSharedSkillTriggerOwnerSummary;
  adoptExistingLifecycleReason?: 'adoptExistingFirstLocalRecord';
}

interface ReceiptAction extends ReceiptTarget {
  type: CliReceiptCommand | CliCommandReceiptAction['type'];
  status: 'succeeded';
}

interface ReceiptArtifact {
  platform: string;
  kind: GeneratedArtifact['kind'];
  path: string;
  artifactKey?: string;
}

interface ReceiptNativePlugin {
  platform: string;
  plugin: string;
}

interface ReceiptNativeSummary {
  plugins: ReceiptNativePlugin[];
  marketplace?: {
    rootDir: string;
    source: CatalogResolution['source'];
    mode: 'readOnly' | 'runtimeWritable';
    changed: boolean;
    reason?: string;
  };
}

interface ReceiptJsonBase {
  ok: true;
  command: 'init' | CliReceiptCommand;
  warnings: string[];
  nextSteps: string[];
  privateStateFiles?: ReceiptFileEntry[];
  ignoredStateFiles?: ReceiptFileEntry[];
  sharedConfigFiles?: ReceiptFileEntry[];
  projectLocalConfigFiles?: ReceiptFileEntry[];
  projectArtifactIdentityFiles?: ReceiptProjectArtifactIdentityEntry[];
  nativeTransactionMarker?: ReceiptNativeTransactionMarker;
  dependencyIndex?: ReceiptDependencyIndexSummary;
  staleProjectReferences?: ReceiptProjectReferenceEntry[];
  sharedSkillTriggerOwner?: ReceiptSharedSkillTriggerOwnerSummary;
  adoptExistingLifecycleReason?: 'adoptExistingFirstLocalRecord';
}

export interface InitReceiptJson extends ReceiptJsonBase {
  command: 'init';
  rootDir: string;
  changed: boolean;
}

export interface InstallReceiptJson extends ReceiptJsonBase {
  command: 'install';
  plugins: string[];
  targets: ReceiptTarget[];
  actions: ReceiptAction[];
  artifacts: ReceiptArtifact[];
  native: ReceiptNativeSummary;
}

export interface UninstallReceiptJson extends ReceiptJsonBase {
  command: 'uninstall';
  plugins: string[];
  targets: ReceiptTarget[];
  actions: ReceiptAction[];
  artifacts: ReceiptArtifact[];
  native: ReceiptNativeSummary;
}

export interface UpgradeReceiptJson extends ReceiptJsonBase {
  command: 'upgrade';
  upgraded: ReceiptTarget[];
  skipped: SkippedUpgradeTarget[];
  targets: ReceiptTarget[];
  actions: ReceiptAction[];
  artifacts: ReceiptArtifact[];
  native: ReceiptNativeSummary;
}

export type CommandReceiptJson =
  | InstallReceiptJson
  | UninstallReceiptJson
  | UpgradeReceiptJson;

const PLATFORM_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

export function mergeMarketplaceReceipts(
  results: Array<{ marketplace?: CliMarketplaceReceipt }>,
): CliMarketplaceReceipt | undefined {
  const receipts = results
    .map((result) => result.marketplace)
    .filter((receipt): receipt is CliMarketplaceReceipt => Boolean(receipt));
  if (receipts.length === 0) {
    return undefined;
  }

  return {
    rootDir: receipts[0].rootDir,
    changed: receipts.some((receipt) => receipt.changed),
    mode: receipts.some((receipt) => receipt.mode === 'runtimeWritable')
      ? 'runtimeWritable'
      : receipts[0].mode,
    catalog: receipts.find((receipt) => receipt.catalog.source === 'local')?.catalog ?? receipts[0].catalog,
  };
}

function formatChineseList(values: string[]): string {
  const unique = uniqueStrings(values);
  return unique.length > 0 ? unique.join('、') : '无';
}

function scopeLabel(scope: Scope): string {
  return scope === 'project' ? '当前项目' : '当前用户';
}

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

function sanitizeHumanText(text: string): string {
  return text
    .replaceAll('project scope', '当前项目')
    .replaceAll('user scope', '当前用户')
    .replaceAll('repo-managed', '当前仓库文件')
    .replaceAll('app-server', '本地服务')
    .replaceAll('RPC', '接口调用')
    .replaceAll('rpc', '接口调用')
    .replaceAll('breadcrumb', '恢复标记')
    .replaceAll('ledger', '安装记录')
    .replaceAll('marketplace', '插件目录')
    .replaceAll('cache', '本地缓存')
    .replaceAll('healthSource', '状态来源')
    .replaceAll('config health', '配置状态')
    .replaceAll('script health', '脚本状态');
}

function dedupeTargets(targets: ReceiptTarget[]): ReceiptTarget[] {
  const entries = new Map<string, ReceiptTarget>();
  for (const target of targets) {
    const key = `${target.plugin}\0${target.platform}\0${target.scope}\0${target.projectKey ?? ''}`;
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, {
        ...target,
        ...(target.dependencyOf
          ? {
              dependencyOf: dedupeTargets(target.dependencyOf),
            }
          : {}),
      });
      continue;
    }
    existing.requested = existing.requested === true || target.requested === true;
    if (target.dependencyOf && target.dependencyOf.length > 0) {
      existing.dependencyOf = dedupeTargets([...(existing.dependencyOf ?? []), ...target.dependencyOf]);
    }
  }
  return [...entries.values()];
}

function collectSucceededTargets(receipt: CliCommandReceipt): ReceiptTarget[] {
  if (receipt.result.receiptTargets && receipt.result.receiptTargets.length > 0) {
    return dedupeTargets(receipt.result.receiptTargets);
  }

  const targets: ReceiptTarget[] = [];
  for (const group of receipt.groups) {
    for (const plugin of uniqueStrings(group.plugins)) {
      for (const platform of uniqueStrings(group.platforms)) {
        targets.push({
          plugin,
          platform,
          scope: group.scope,
        });
      }
    }
  }
  return dedupeTargets(targets);
}

type ReceiptJsonDetails = Omit<ReceiptJsonBase, 'ok' | 'command' | 'warnings' | 'nextSteps'>;

function buildReceiptDetails(result: CliCommandResult): ReceiptJsonDetails {
  if (!result.receiptDetails) {
    return {};
  }
  return {
    ...(result.receiptDetails.privateStateFiles?.length
      ? { privateStateFiles: result.receiptDetails.privateStateFiles }
      : {}),
    ...(result.receiptDetails.ignoredStateFiles?.length
      ? { ignoredStateFiles: result.receiptDetails.ignoredStateFiles }
      : {}),
    ...(result.receiptDetails.sharedConfigFiles?.length
      ? { sharedConfigFiles: result.receiptDetails.sharedConfigFiles }
      : {}),
    ...(result.receiptDetails.projectLocalConfigFiles?.length
      ? { projectLocalConfigFiles: result.receiptDetails.projectLocalConfigFiles }
      : {}),
    ...(result.receiptDetails.projectArtifactIdentityFiles?.length
      ? { projectArtifactIdentityFiles: result.receiptDetails.projectArtifactIdentityFiles }
      : {}),
    ...(result.receiptDetails.nativeTransactionMarker
      ? { nativeTransactionMarker: result.receiptDetails.nativeTransactionMarker }
      : {}),
    ...(result.receiptDetails.dependencyIndex
      ? { dependencyIndex: result.receiptDetails.dependencyIndex }
      : {}),
    ...(result.receiptDetails.staleProjectReferences?.length
      ? { staleProjectReferences: result.receiptDetails.staleProjectReferences }
      : {}),
    ...(result.receiptDetails.sharedSkillTriggerOwner
      ? { sharedSkillTriggerOwner: result.receiptDetails.sharedSkillTriggerOwner }
      : {}),
    ...(result.receiptDetails.adoptExistingLifecycleReason
      ? { adoptExistingLifecycleReason: result.receiptDetails.adoptExistingLifecycleReason }
      : {}),
  };
}

function collectReceiptActions(
  command: CliReceiptCommand,
  receipt: CliCommandReceipt,
): ReceiptAction[] {
  const explicitTargets = collectSucceededTargets(receipt).filter((target) =>
    command === 'install' || command === 'upgrade'
      ? target.requested !== false
      : true,
  );
  const explicitActions = explicitTargets.map((target) => ({
    ...target,
    type: command,
    status: 'succeeded' as const,
  }));
  const extraActions = (receipt.result.receiptActions ?? []).map((action) => ({
    ...action,
    status: 'succeeded' as const,
  }));
  return [...explicitActions, ...extraActions];
}

function collectAffectedPlugins(options: {
  command: CliReceiptCommand;
  receipt: CliCommandReceipt;
  targets: ReceiptTarget[];
  actions: ReceiptAction[];
}): string[] {
  if (options.command === 'upgrade') {
    return uniqueStrings(options.targets.map((target) => target.plugin));
  }

  return uniqueStrings([
    ...options.receipt.result.plugins,
    ...options.targets.map((target) => target.plugin),
    ...options.actions.map((action) => action.plugin),
  ]);
}

function mapSkippedTargets(skipped: SkippedUpgradeTarget[]): ReceiptTarget[] {
  return skipped.map((entry) => ({
    plugin: entry.plugin,
    platform: entry.platform,
    scope: entry.scope,
    ...(entry.requested !== undefined ? { requested: entry.requested } : {}),
    ...(entry.dependencyOf
      ? {
          dependencyOf: entry.dependencyOf,
        }
      : {}),
  }));
}

function collectArtifacts(artifacts: GeneratedArtifact[] | undefined): ReceiptArtifact[] {
  return (artifacts ?? []).map((artifact) => ({
    platform: artifact.platform,
    kind: artifact.kind,
    path: artifact.path,
    ...(artifact.artifactKey ? { artifactKey: artifact.artifactKey } : {}),
  }));
}

function collectNativeSummary(result: CliCommandResult): ReceiptNativeSummary {
  const plugins = Object.entries(result.nativePlugins ?? {})
    .flatMap(([platform, names]) =>
      (names ?? []).map((plugin) => ({
        platform,
        plugin,
      })),
    );

  return {
    plugins,
    ...(result.marketplace
      ? {
          marketplace: {
            rootDir: result.marketplace.catalog.rootDir,
            source: result.marketplace.catalog.source,
            mode: result.marketplace.mode ?? 'runtimeWritable',
            changed: result.marketplace.changed,
            ...(result.marketplace.catalog.reason
              ? { reason: result.marketplace.catalog.reason }
              : {}),
          },
        }
      : {}),
  };
}

function buildStatusCommand(result: CliCommandResult): string {
  const firstPlugin = result.plugins[0];
  const uniquePlatforms = uniqueStrings(result.platforms);
  let platformFlag = '';
  if (uniquePlatforms.length === 1) {
    platformFlag = ` -p ${uniquePlatforms[0]}`;
  } else if (uniquePlatforms.length > 1) {
    platformFlag = ' -p both';
  }
  return `aw status${firstPlugin ? ` ${firstPlugin}` : ''}${platformFlag}`;
}

function buildCommandNextSteps(result: CliCommandResult): string[] {
  return [`运行 ${buildStatusCommand(result)} 查看当前状态。`];
}

export function buildInitReceiptJson(result: CliInitReceipt): InitReceiptJson {
  return {
    ok: true,
    command: 'init',
    rootDir: result.rootDir,
    changed: result.changed,
    warnings: [...new Set(result.warnings)],
    nextSteps: ['运行 aw status 查看当前环境与插件状态。'],
  };
}

export function buildCommandReceiptJson(
  command: CliReceiptCommand,
  receipt: CliCommandReceipt,
): CommandReceiptJson {
  const warnings = [...new Set(receipt.result.warnings)];
  const nextSteps = buildCommandNextSteps(receipt.result);
  const succeededTargets = collectSucceededTargets(receipt);
  const actions = collectReceiptActions(command, receipt);
  const plugins = collectAffectedPlugins({
    command,
    receipt,
    targets: succeededTargets,
    actions,
  });
  const artifacts = collectArtifacts(receipt.result.repoManagedArtifacts);
  const native = collectNativeSummary(receipt.result);
  const receiptDetails = buildReceiptDetails(receipt.result);

  if (command === 'install') {
    return {
      ok: true,
      command: 'install',
      plugins,
      targets: succeededTargets,
      actions,
      artifacts,
      native,
      warnings,
      nextSteps,
      ...receiptDetails,
    };
  }

  if (command === 'uninstall') {
    return {
      ok: true,
      command: 'uninstall',
      plugins,
      targets: succeededTargets,
      actions,
      artifacts,
      native,
      warnings,
      nextSteps,
      ...receiptDetails,
    };
  }

  const upgraded = dedupeTargets(actions.map((action) => ({
    plugin: action.plugin,
    platform: action.platform,
    scope: action.scope,
    ...(action.requested !== undefined ? { requested: action.requested } : {}),
    ...(action.dependencyOf
      ? {
          dependencyOf: action.dependencyOf,
        }
      : {}),
  })));
  const skipped = receipt.result.skipped ?? [];
  const targets = receipt.result.receiptTargets
    ? dedupeTargets(receipt.result.receiptTargets)
    : dedupeTargets([...upgraded, ...mapSkippedTargets(skipped)]);
  return {
    ok: true,
    command: 'upgrade',
    upgraded,
    skipped,
    targets,
    actions,
    artifacts,
    native,
    warnings,
    nextSteps,
    ...receiptDetails,
  };
}

function formatArtifactSurfaces(artifacts: GeneratedArtifact[] | undefined): string | undefined {
  const surfaces = new Set<string>();
  for (const artifact of artifacts ?? []) {
    if (artifact.platform !== 'codex') {
      continue;
    }
    switch (artifact.kind) {
      case 'skill':
        surfaces.add('.agents/skills');
        break;
      case 'mcpServer':
      case 'instruction':
        surfaces.add('.codex/config.toml');
        break;
      case 'permission':
        surfaces.add('.codex/rules');
        break;
      case 'hook':
        surfaces.add('.codex/hooks.json');
        break;
      case 'agent':
        surfaces.add('.codex/agents');
        break;
    }
  }

  if (surfaces.size === 0) {
    return undefined;
  }
  surfaces.add('.codex/.agent-workflows-manifest.json');
  return [...surfaces].join('、');
}

function formatTargetSummary(targets: ReceiptTarget[]): string {
  const platforms = formatChineseList(targets.map((target) => platformLabel(target.platform)));
  const scopes = formatChineseList(targets.map((target) => scopeLabel(target.scope)));
  return `${platforms}；${scopes}`;
}

export function renderInitReceipt(result: CliInitReceipt): string[] {
  return [
    `${result.changed ? '已准备好' : '已复用'}本地插件目录：${result.rootDir}。`,
    '下一步：运行 aw status 查看当前环境与插件状态。',
  ];
}

export function renderCommandReceipt(
  command: CliReceiptCommand,
  receipt: CliCommandReceipt,
): string[] {
  const payload = buildCommandReceiptJson(command, receipt);
  const lines: string[] = [];
  const artifacts = formatArtifactSurfaces(receipt.result.repoManagedArtifacts);
  const privateStateTouched = (payload.privateStateFiles?.length ?? 0) > 0
    || (payload.ignoredStateFiles?.length ?? 0) > 0
    || (payload.projectLocalConfigFiles?.length ?? 0) > 0;
  const markerNeedsAttention = payload.nativeTransactionMarker?.needsAttention === true;
  const sharedOwnerSuppressed = payload.sharedSkillTriggerOwner?.suppressedOwnerConflict === true;

  if (payload.command === 'upgrade') {
    const upgradedPlugins = formatChineseList(payload.upgraded.map((target) => target.plugin));
    if (payload.upgraded.length === 0 && payload.skipped.length > 0) {
      lines.push(`这次没有完成升级，已跳过 ${payload.skipped.length} 个目标。`);
    } else if (markerNeedsAttention) {
      lines.push(`主要升级已经完成，但还需要收口本机原生状态：${upgradedPlugins}。`);
    } else {
      lines.push(`已升级 ${upgradedPlugins}。`);
    }
    if (payload.targets.length > 0) {
      lines.push(`目标：${formatTargetSummary(payload.targets)}。`);
    }
    if (artifacts) {
      lines.push(`已更新项目文件：${artifacts}。`);
    }
    if ((payload.sharedConfigFiles?.length ?? 0) > 0) {
      lines.push('已更新团队共享配置。');
    }
    if ((payload.projectArtifactIdentityFiles?.length ?? 0) > 0) {
      lines.push('已更新共享身份文件。');
    }
    if (privateStateTouched) {
      lines.push('已更新 AW 本地状态。');
    }
    if (!payload.dependencyIndex?.trusted && payload.dependencyIndex?.recoveryMessage) {
      lines.push(payload.dependencyIndex.recoveryMessage);
    }
    if ((payload.staleProjectReferences?.length ?? 0) > 0) {
      lines.push(`另有 ${payload.staleProjectReferences!.length} 条项目引用需要你显式清理。`);
    }
    if (sharedOwnerSuppressed) {
      lines.push('当前项目的 repo-local skill trigger 已按本地项目路径处理，没有触发 shared runtime 接管。');
    }
    if (markerNeedsAttention && payload.nativeTransactionMarker) {
      lines.push(`下一步：${payload.nativeTransactionMarker.repairCommand} 或 ${payload.nativeTransactionMarker.cleanupCommand}`);
    } else {
      lines.push(`下一步：${payload.nextSteps[0]}`);
    }
    if (payload.skipped.length > 0) {
      lines.push(`未处理 ${payload.skipped.length} 个目标：`);
      for (const entry of payload.skipped) {
        lines.push(
          `- ${platformLabel(entry.platform)} / ${scopeLabel(entry.scope)} / ${entry.plugin}：${sanitizeHumanText(entry.reason)}`,
        );
      }
    }
    return lines;
  }

  if (payload.command !== 'install' && payload.command !== 'uninstall') {
    return lines;
  }

  const explicitPlugins = payload.command === 'install'
    ? formatChineseList(
        payload.targets
          .filter((target) => target.requested !== false)
          .map((target) => target.plugin),
      )
    : formatChineseList(payload.targets.map((target) => target.plugin));
  const plugins = explicitPlugins === '无'
    ? formatChineseList(payload.plugins)
    : explicitPlugins;
  if (markerNeedsAttention && payload.command === 'install') {
    lines.push(`主要安装已经完成，但还需要收口本机原生状态：${plugins}。`);
  } else {
    lines.push(`${payload.command === 'install' ? '已安装' : '已卸载'} ${plugins}。`);
  }
  if (payload.command === 'install') {
    const autoDependencyTargets = payload.actions.filter((action) => action.type === 'installDependency');
    if (autoDependencyTargets.length > 0) {
      lines.push(
        `已自动安装依赖：${formatChineseList(autoDependencyTargets.map((target) => target.plugin))}。`,
      );
    }
  }
  if (payload.targets.length > 0) {
    lines.push(`目标：${formatTargetSummary(payload.targets)}。`);
  }
  if (artifacts) {
    lines.push(`${payload.command === 'install' ? '已更新' : '已清理'}项目文件：${artifacts}。`);
  } else if (payload.command === 'uninstall') {
    lines.push('已清理相关文件和已安装项。');
  }
  if ((payload.sharedConfigFiles?.length ?? 0) > 0) {
    lines.push('已更新团队共享配置。');
  }
  if ((payload.projectArtifactIdentityFiles?.length ?? 0) > 0) {
    lines.push('已更新共享身份文件。');
  }
  if (privateStateTouched) {
    lines.push('已更新 AW 本地状态。');
  }
  if (!payload.dependencyIndex?.trusted && payload.dependencyIndex?.recoveryMessage) {
    lines.push(payload.dependencyIndex.recoveryMessage);
  }
  if ((payload.staleProjectReferences?.length ?? 0) > 0) {
    lines.push(`另有 ${payload.staleProjectReferences!.length} 条项目引用需要你显式清理。`);
  }
  if (sharedOwnerSuppressed) {
    lines.push('当前项目的 repo-local skill trigger 已按本地项目路径处理，没有触发 shared runtime 接管。');
  }
  if (markerNeedsAttention && payload.nativeTransactionMarker) {
    lines.push(`下一步：${payload.nativeTransactionMarker.repairCommand} 或 ${payload.nativeTransactionMarker.cleanupCommand}`);
  } else {
    lines.push(`下一步：${payload.nextSteps[0]}`);
  }
  return lines;
}
