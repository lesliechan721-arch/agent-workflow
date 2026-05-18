import type {
  CatalogResolution,
  ConfigStoreRemovalResult,
  GeneratedArtifact,
  NativePluginsByPlatform,
  NextStepInstruction,
  ReceiptOverallState,
  ReceiptTargetIdentity,
  ReceiptTargetResult,
  Scope,
  SkippedUpgradeTarget,
} from '../types.js';
import type {
  CleanupConfigAction,
  CleanupJsonPayload,
  CleanupPlanItem,
  CleanupTargetPayload,
} from '../commands/cleanup.js';
import { isCleanupExecutionFailure } from '../commands/cleanup.js';
import {
  createCliCommandNextStep,
  createLegacyNextStepText,
  createNextStepsBoundary,
  createUiActionNextStep,
  dedupeNextSteps,
  formatNextStepForHuman,
} from './model.js';

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
  nextSteps?: NextStepInstruction[];
  targetResults?: ReceiptTargetResult[];
  overallState?: ReceiptOverallState;
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
  type: 'installDependency' | 'upgradeDependency' | 'uninstallAutoDependency';
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

export interface ReceiptConfigRemovalAction extends ReceiptFileEntry {
  plugin: string;
  scope: Scope;
  projectKey?: string;
  status: 'removed' | 'skipped' | 'failed';
  reason?: string;
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
  removedConfigStores?: ReceiptFileEntry[];
  configRemovalActions?: ReceiptConfigRemovalAction[];
  configStoreRemovals?: ConfigStoreRemovalResult[];
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
    reasonCode?: CatalogResolution['reasonCode'];
  };
}

interface ReceiptJsonBase {
  ok: true;
  command: 'init' | CliReceiptCommand;
  warnings: string[];
  nextStepsSchemaVersion: 1;
  nextSteps: NextStepInstruction[];
  legacyNextSteps?: string[];
  privateStateFiles?: ReceiptFileEntry[];
  ignoredStateFiles?: ReceiptFileEntry[];
  sharedConfigFiles?: ReceiptFileEntry[];
  projectLocalConfigFiles?: ReceiptFileEntry[];
  projectArtifactIdentityFiles?: ReceiptProjectArtifactIdentityEntry[];
  removedConfigStores?: ReceiptFileEntry[];
  configRemovalActions?: ReceiptConfigRemovalAction[];
  configStoreRemovals?: ConfigStoreRemovalResult[];
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
  receiptSchemaVersion: 2;
  overallState: ReceiptOverallState;
  plugins: string[];
  targets: ReceiptTarget[];
  actions: ReceiptAction[];
  targetResults: ReceiptTargetResult[];
  artifacts: ReceiptArtifact[];
  native: ReceiptNativeSummary;
}

export interface UninstallReceiptJson extends ReceiptJsonBase {
  command: 'uninstall';
  receiptSchemaVersion: 2;
  overallState: ReceiptOverallState;
  plugins: string[];
  targets: ReceiptTarget[];
  actions: ReceiptAction[];
  targetResults: ReceiptTargetResult[];
  artifacts: ReceiptArtifact[];
  native: ReceiptNativeSummary;
}

export interface UpgradeReceiptJson extends ReceiptJsonBase {
  command: 'upgrade';
  receiptSchemaVersion: 2;
  overallState: ReceiptOverallState;
  upgraded: ReceiptTarget[];
  skipped: SkippedUpgradeTarget[];
  targets: ReceiptTarget[];
  actions: ReceiptAction[];
  targetResults: ReceiptTargetResult[];
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
    if (target.platform === 'both' || target.platform === 'auto') {
      continue;
    }
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

function collectActionTargets(receipt: CliCommandReceipt): ReceiptTarget[] {
  return dedupeTargets((receipt.result.receiptActions ?? []).map((action) => ({
    plugin: action.plugin,
    platform: action.platform,
    scope: action.scope,
    ...(action.dependencyOf ? { dependencyOf: action.dependencyOf } : {}),
    ...(action.requested !== undefined ? { requested: action.requested } : {}),
  })));
}

function toReceiptTargetIdentity(target: ReceiptTarget): ReceiptTargetIdentity {
  return {
    pluginName: target.plugin,
    platform: target.platform as ReceiptTargetIdentity['platform'],
    scope: target.scope,
    ...(target.projectKey ? { projectKey: target.projectKey } : {}),
  };
}

function inferOverallState(targetResults: ReceiptTargetResult[]): ReceiptOverallState {
  if (targetResults.some((entry) => entry.state === 'failed' || entry.state === 'rolledBack')) {
    return 'failed';
  }
  if (targetResults.some((entry) => entry.state === 'completed')) {
    return 'succeeded';
  }
  return targetResults.length > 0 ? 'failed' : 'succeeded';
}

function buildTargetResults(
  command: CliReceiptCommand,
  receipt: CliCommandReceipt,
): ReceiptTargetResult[] {
  if (receipt.result.targetResults && receipt.result.targetResults.length > 0) {
    return receipt.result.targetResults;
  }

  const explicitTargets = collectSucceededTargets(receipt);
  const actionTargets = collectActionTargets(receipt);
  const requestedTargets = dedupeTargets([...explicitTargets, ...actionTargets]);
  const skippedTargets = command === 'upgrade'
    ? receipt.result.skipped ?? []
    : [];
  const completedByKey = new Map<string, ReceiptTargetResult>();

  for (const target of requestedTargets) {
    const action = (receipt.result.receiptActions ?? []).find((entry) =>
      entry.plugin === target.plugin &&
      entry.platform === target.platform &&
      entry.scope === target.scope,
    )?.type ?? command;
    const identity = toReceiptTargetIdentity(target);
    const key = `${identity.pluginName}\0${identity.platform}\0${identity.scope}\0${identity.projectKey ?? ''}\0${action}`;
    if (!completedByKey.has(key)) {
      completedByKey.set(key, {
        target: identity,
        action,
        state: 'completed',
        rollbackState: 'notNeeded',
      });
    }
  }

  for (const skipped of skippedTargets) {
    const identity = toReceiptTargetIdentity({
      plugin: skipped.plugin,
      platform: skipped.platform,
      scope: skipped.scope,
      ...(skipped.requested !== undefined ? { requested: skipped.requested } : {}),
      ...(skipped.dependencyOf ? { dependencyOf: skipped.dependencyOf } : {}),
    });
    const key = `${identity.pluginName}\0${identity.platform}\0${identity.scope}\0${identity.projectKey ?? ''}\0${command}`;
    completedByKey.set(key, {
      target: identity,
      action: command,
      state: 'notRun',
      errorCode: skipped.code,
      message: skipped.reason,
    });
  }

  return [...completedByKey.values()];
}

function configStoreIdentity(scope: Scope, pluginName: string, projectKey?: string) {
  return {
    pluginName,
    storeKind: scope === 'project' ? 'projectShared' as const : 'user' as const,
    ...(scope === 'project' && projectKey ? { projectRoot: projectKey } : {}),
  };
}

function configStoreSubjectTargets(
  targetResults: ReceiptTargetResult[],
  action: ReceiptConfigRemovalAction,
): ReceiptTargetIdentity[] {
  const matches = targetResults
    .map((entry) => entry.target)
    .filter((target) =>
      target.pluginName === action.plugin &&
      target.scope === action.scope &&
      (action.projectKey === undefined || target.projectKey === action.projectKey),
    );
  return matches.length > 0
    ? matches
    : [{
        pluginName: action.plugin,
        scope: action.scope,
        platform: 'codex',
        ...(action.projectKey ? { projectKey: action.projectKey } : {}),
      }];
}

function buildConfigStoreRemovals(
  result: CliCommandResult,
  targetResults: ReceiptTargetResult[],
): ConfigStoreRemovalResult[] | undefined {
  if (result.receiptDetails?.configStoreRemovals?.length) {
    return result.receiptDetails.configStoreRemovals;
  }

  const actions = result.receiptDetails?.configRemovalActions ?? [];
  if (actions.length === 0) {
    return undefined;
  }

  return actions.map((action) => ({
    store: configStoreIdentity(action.scope, action.plugin, action.projectKey),
    state: action.status === 'removed'
      ? 'removed'
      : action.status === 'failed'
        ? 'failed'
        : action.reason === '当前 target scope 没有可删除的 AW 自管配置。'
          ? 'notFound'
          : 'skipped',
    ...(action.status === 'failed'
      ? {
          reasonCode: 'removeFailed' as const,
          message: action.reason,
        }
      : action.status === 'skipped' && action.reason && action.reason !== '当前 target scope 没有可删除的 AW 自管配置。'
        ? {
            reasonCode: 'subjectFailed' as const,
            message: action.reason,
          }
        : {}),
    subjectTargets: configStoreSubjectTargets(targetResults, action),
    ...(action.path ? { path: action.path } : {}),
  }));
}

type ReceiptJsonDetails = Omit<
  ReceiptJsonBase,
  'ok' | 'command' | 'warnings' | 'nextStepsSchemaVersion' | 'nextSteps' | 'legacyNextSteps' | 'configStoreRemovals'
>;

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
    ...(result.receiptDetails.removedConfigStores?.length
      ? { removedConfigStores: result.receiptDetails.removedConfigStores }
      : {}),
    ...(result.receiptDetails.configRemovalActions?.length
      ? { configRemovalActions: result.receiptDetails.configRemovalActions }
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
            ...(result.marketplace.catalog.reasonCode
              ? { reasonCode: result.marketplace.catalog.reasonCode }
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

function buildCommandNextSteps(result: CliCommandResult): NextStepInstruction[] {
  if (result.nextSteps && result.nextSteps.length > 0) {
    return dedupeNextSteps(result.nextSteps);
  }

  return [createUiActionNextStep(
    '查看当前状态',
    '可以重新确认这次操作后各个目标的安装状态和后续可执行动作。',
    'openStatus',
    buildStatusCommand(result),
  )];
}

export function buildInitReceiptJson(result: CliInitReceipt): InitReceiptJson {
  const nextSteps = createNextStepsBoundary([
    createUiActionNextStep(
      '查看当前环境与插件状态',
      '可以确认本地插件目录是否已准备好，以及当前环境识别到了哪些插件。',
      'openStatus',
      'aw status',
    ),
  ]);
  return {
    ok: true,
    command: 'init',
    rootDir: result.rootDir,
    changed: result.changed,
    warnings: [...new Set(result.warnings)],
    ...nextSteps,
  };
}

export function buildCommandReceiptJson(
  command: CliReceiptCommand,
  receipt: CliCommandReceipt,
): CommandReceiptJson {
  const warnings = [...new Set(receipt.result.warnings)];
  const nextSteps = createNextStepsBoundary(buildCommandNextSteps(receipt.result));
  const succeededTargets = collectSucceededTargets(receipt);
  const actions = collectReceiptActions(command, receipt);
  const targetResults = buildTargetResults(command, receipt);
  const overallState = receipt.result.overallState ?? inferOverallState(targetResults);
  const plugins = collectAffectedPlugins({
    command,
    receipt,
    targets: succeededTargets,
    actions,
  });
  const artifacts = collectArtifacts(receipt.result.repoManagedArtifacts);
  const native = collectNativeSummary(receipt.result);
  const configStoreRemovals = buildConfigStoreRemovals(receipt.result, targetResults);
  const receiptDetails = buildReceiptDetails(receipt.result);

  if (command === 'install') {
    return {
      ok: true,
      command: 'install',
      receiptSchemaVersion: 2,
      overallState,
      plugins,
      targets: succeededTargets,
      actions,
      targetResults,
      artifacts,
      native,
      warnings,
      ...nextSteps,
      ...(configStoreRemovals?.length ? { configStoreRemovals } : {}),
      ...receiptDetails,
    };
  }

  if (command === 'uninstall') {
    return {
      ok: true,
      command: 'uninstall',
      receiptSchemaVersion: 2,
      overallState,
      plugins,
      targets: succeededTargets,
      actions,
      targetResults,
      artifacts,
      native,
      warnings,
      ...nextSteps,
      ...(configStoreRemovals?.length ? { configStoreRemovals } : {}),
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
    receiptSchemaVersion: 2,
    overallState,
    upgraded,
    skipped,
    targets,
    actions,
    targetResults,
    artifacts,
    native,
    warnings,
    ...nextSteps,
    ...(configStoreRemovals?.length ? { configStoreRemovals } : {}),
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

function renderConfigRemovalSummary(
  removals: ConfigStoreRemovalResult[] | undefined,
): string | null {
  if (!removals || removals.length === 0) {
    return null;
  }
  const failed = removals.filter((action) => action.state === 'failed');
  if (failed.length > 0) {
    return failed.length === 1
      ? '配置处理：主体已完成，但 AW 自管配置删除失败。'
      : `配置处理：主体已完成，但 ${failed.length} 个 AW 自管配置删除失败。`;
  }
  const skipped = removals.filter((action) => action.state === 'skipped');
  if (skipped.length > 0) {
    return '配置处理：已保留 AW 自管配置。';
  }
  const notFound = removals.filter((action) => action.state === 'notFound');
  if (notFound.length > 0 && notFound.length === removals.length) {
    return '配置处理：没有可删除的 AW 自管配置。';
  }
  const removed = removals.filter((action) => action.state === 'removed');
  if (removed.length > 0) {
    return '已删除 AW 自管配置。';
  }
  return null;
}

export function renderInitReceipt(result: CliInitReceipt): string[] {
  const payload = buildInitReceiptJson(result);
  return [
    `${result.changed ? '已准备好' : '已复用'}本地插件目录：${result.rootDir}。`,
    `下一步：${formatNextStepForHuman(payload.nextSteps[0]!)}`,
  ];
}

export function renderCommandReceipt(
  command: CliReceiptCommand,
  receipt: CliCommandReceipt,
  options: {
    headlineVariant?: 'install' | 'reinstall';
  } = {},
): string[] {
  const payload = buildCommandReceiptJson(command, receipt);
  const lines: string[] = [];
  const artifacts = formatArtifactSurfaces(receipt.result.repoManagedArtifacts);
  const privateStateTouched = (payload.privateStateFiles?.length ?? 0) > 0
    || (payload.ignoredStateFiles?.length ?? 0) > 0
    || (payload.projectLocalConfigFiles?.length ?? 0) > 0;
  const markerNeedsAttention = payload.nativeTransactionMarker?.needsAttention === true;
  const sharedOwnerSuppressed = payload.sharedSkillTriggerOwner?.suppressedOwnerConflict === true;
  const headlineVariant = options.headlineVariant ?? payload.command;

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
      lines.push(`下一步：${formatNextStepForHuman(payload.nextSteps[0]!)}`);
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
    lines.push(`${headlineVariant === 'reinstall' ? '主要重新安装已经完成' : '主要安装已经完成'}，但还需要收口本机原生状态：${plugins}。`);
  } else {
    lines.push(`${
      payload.command === 'install'
        ? headlineVariant === 'reinstall' ? '已重新安装' : '已安装'
        : '已卸载'
    } ${plugins}。`);
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
  const configRemovalSummary = renderConfigRemovalSummary(payload.configStoreRemovals);
  if (configRemovalSummary) {
    lines.push(configRemovalSummary);
  } else if ((payload.removedConfigStores?.length ?? 0) > 0) {
    lines.push('已删除 AW 自管配置。');
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
    lines.push(`下一步：${formatNextStepForHuman(payload.nextSteps[0]!)}`);
  }
  return lines;
}

function renderCleanupPlanItems(title: string, items: CleanupPlanItem[]): string[] {
  const lines = [title];
  if (items.length === 0) {
    lines.push('- 无');
    return lines;
  }
  for (const item of items) {
    lines.push(`- ${item.label}${item.path ? `：${item.path}` : ''}${item.detail ? ` (${item.detail})` : ''}`);
  }
  return lines;
}

function renderCleanupConfigActions(title: string, actions: CleanupConfigAction[]): string[] {
  const lines = [title];
  if (actions.length === 0) {
    lines.push('- 无');
    return lines;
  }
  for (const action of actions) {
    lines.push(`- ${action.scope}/${action.plugin}：${action.path} [${action.status}]${action.reason ? ` ${action.reason}` : ''}`);
  }
  return lines;
}

function renderCleanupLocations(title: string, locations: CleanupTargetPayload['affectedDependents']): string[] {
  const lines = [title];
  if (locations.length === 0) {
    lines.push('- 无');
    return lines;
  }
  for (const location of locations) {
    lines.push(`- ${location.platform}/${location.scope}/${location.plugin}${location.projectKey ? ` (${location.projectKey})` : ''}`);
  }
  return lines;
}

function renderCleanupBlockingReasons(payload: CleanupTargetPayload): string[] {
  const lines = ['阻断原因：'];
  if (payload.blockingReasons.length === 0) {
    lines.push('- 无');
    return lines;
  }
  for (const reason of payload.blockingReasons) {
    lines.push(`- [${reason.code}] ${reason.message}${reason.suggestedCommand ? ` 建议：${reason.suggestedCommand}` : ''}`);
  }
  return lines;
}

export function buildCleanupReceiptJson(result: {
  payload: CleanupJsonPayload;
  warnings: string[];
}): CleanupJsonPayload & { warnings: string[] } {
  if (result.payload.dependencyIndex) {
    const nextSteps = result.payload.nextStepsSchemaVersion === 1
      ? {
          nextStepsSchemaVersion: result.payload.nextStepsSchemaVersion,
          nextSteps: result.payload.nextSteps,
          ...(result.payload.legacyNextSteps ? { legacyNextSteps: result.payload.legacyNextSteps } : {}),
        }
      : createNextStepsBoundary([
        createCliCommandNextStep(
          '查看最新依赖状态',
          '可以重新检查 dependency index 清理后，当前环境里还剩哪些依赖引用需要继续处理。',
          'aw status --verbose',
        ),
      ]);
    return {
      ...result.payload,
      receiptSchemaVersion: 2,
      overallState: result.payload.overallState ?? 'succeeded',
      targetResults: result.payload.targetResults ?? [],
      ...nextSteps,
      warnings: [...new Set(result.warnings)],
    };
  }

  const overallState = result.payload.overallState ?? (isCleanupExecutionFailure(result.payload) ? 'failed' : 'succeeded');
  const nextSteps = result.payload.nextStepsSchemaVersion === 1
    ? {
        nextStepsSchemaVersion: result.payload.nextStepsSchemaVersion,
        nextSteps: result.payload.nextSteps,
        ...(result.payload.legacyNextSteps ? { legacyNextSteps: result.payload.legacyNextSteps } : {}),
      }
    : createNextStepsBoundary([createCliCommandNextStep(
      result.payload.dryRun ? '继续执行 cleanup' : '查看 cleanup 后状态',
      result.payload.dryRun
        ? '可以继续进入 cleanup 执行流程，并按这次预检确认删除项、备份项和配置处理结果。'
        : '可以重新确认 cleanup 后还剩哪些安装证据、残留和后续可执行动作。',
      result.payload.dryRun ? result.payload.recommendedCommand : buildStatusCommand({
        platforms: [result.payload.target.platform],
        plugins: [result.payload.target.plugin],
        warnings: [],
      }),
    )]);
  const targetResults = result.payload.targetResults ?? [{
    target: {
      pluginName: result.payload.target.plugin,
      platform: result.payload.target.platform,
      scope: result.payload.target.scope,
      ...(result.payload.target.projectKey ? { projectKey: result.payload.target.projectKey } : {}),
    },
    action: 'cleanup',
    state: result.payload.dryRun ? 'notRun' : overallState === 'failed' ? 'failed' : 'completed',
    rollbackState: 'notNeeded',
  }];
  const configStoreRemovals = result.payload.configStoreRemovals ?? (result.payload.wouldRemoveConfig.length > 0
    ? result.payload.wouldRemoveConfig.map((entry) => ({
        store: {
          pluginName: entry.plugin,
          storeKind: entry.scope === 'project' ? 'projectShared' as const : 'user' as const,
          ...(entry.projectKey ? { projectRoot: entry.projectKey } : {}),
        },
        state: entry.status === 'removed'
          ? 'removed'
          : entry.status === 'failed'
            ? 'failed'
            : entry.reason === '当前 target scope 没有可删除的 AW 自管配置。'
              ? 'notFound'
              : 'skipped',
        ...(entry.status === 'failed'
          ? {
              reasonCode: 'removeFailed' as const,
              message: entry.reason,
            }
          : entry.status !== 'removed' && entry.reason && entry.reason !== '当前 target scope 没有可删除的 AW 自管配置。'
            ? {
                reasonCode: 'subjectFailed' as const,
                message: entry.reason,
              }
            : {}),
        subjectTargets: targetResults.map((item) => item.target),
        path: entry.path,
      }))
    : undefined);
  return {
    ...result.payload,
    receiptSchemaVersion: 2,
    overallState,
    targetResults,
    ...nextSteps,
    ...(configStoreRemovals?.length ? { configStoreRemovals } : {}),
    warnings: [...new Set(result.warnings)],
  };
}

export function renderCleanupReceipt(result: {
  payload: CleanupJsonPayload;
  warnings: string[];
}): string[] {
  const payload = buildCleanupReceiptJson(result);
  if (payload.dependencyIndex) {
    const lines = [`已退休 ${payload.retiredEntries.length} 条 dependency index stale 引用。`];
    if (payload.retiredEntries.length === 0) {
      lines.push('这次没有需要退休的项目引用。');
    } else {
      for (const entry of payload.retiredEntries) {
        lines.push(`- ${entry.recordPath}`);
      }
    }
    if (payload.nextSteps.length > 0) {
      lines.push(`下一步：${formatNextStepForHuman(payload.nextSteps[0]!)}`);
    }
    return lines;
  }

  const cleanupFailed = isCleanupExecutionFailure(payload);
  const lines: string[] = [
    `${payload.dryRun ? 'cleanup 评估完成' : cleanupFailed ? 'cleanup 失败' : 'cleanup 已完成'}：${payload.target.plugin}。`,
    `目标类型：${payload.target.targetType}。`,
    `force 语义：${payload.force ? '已启用' : '未启用'}${payload.forceReason ? `；${payload.forceReason}` : ''}`,
  ];
  lines.push(...renderCleanupPlanItems(payload.dryRun ? '计划删除项：' : '实际删除项：', payload.dryRun
    ? payload.plannedRemovals
    : payload.actualRemovals ?? payload.plannedRemovals));
  lines.push(...renderCleanupPlanItems(payload.dryRun ? '备份项：' : '实际备份项：', payload.dryRun
    ? payload.wouldBackups
    : payload.actualBackups ?? []));
  lines.push(...renderCleanupPlanItems(payload.dryRun ? '跳过项：' : '执行跳过项：', payload.dryRun
    ? payload.skippedForeignItems
    : payload.skippedItems ?? payload.skippedForeignItems));
  lines.push(...renderCleanupLocations('受影响依赖：', payload.affectedDependents));
  lines.push(...renderCleanupBlockingReasons(payload));
  lines.push(...renderCleanupConfigActions(payload.dryRun ? '配置处理：' : '配置处理结果：', payload.wouldRemoveConfig));
  const configRemovalSummary = renderConfigRemovalSummary(payload.configStoreRemovals);
  if (configRemovalSummary) {
    lines.push(configRemovalSummary);
  }
  if (!payload.dryRun) {
    lines.push(...renderCleanupPlanItems('未清项：', payload.remainingItems ?? []));
  }
  if (payload.nextSteps.length > 0) {
    lines.push(`下一步：${formatNextStepForHuman(payload.nextSteps[0]!)}`);
  }
  if (payload.warnings.length > 0) {
    lines.push(`Warnings：${payload.warnings.join('；')}`);
  }
  return lines;
}
