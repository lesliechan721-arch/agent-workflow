import type {
  ConfigFieldEntryV2,
  ConfigStoreRemovalResult,
  LegacyConfigStoreEntryV2,
  PlatformSelection,
  PlatformName,
  PluginMeta,
  ReceiptTargetResult,
  Scope,
} from '../types.js';
import type {
  CliConsoleView,
  CliExecutionContext,
  CliPromptChoice,
  CliPromptAction,
  CliPromptResult,
} from './runtime.js';
import {
  createConsoleConfigFormIdentity,
  createInstallWizardDecision,
  planConsoleGraphWriteTargets,
  type ConsoleGraphWritePlan,
  type ConsoleRequiredConfigPrompt,
  type ConsoleWriteWizardOperation,
} from './console-wizard.js';
import {
  type ConsoleControllerItem,
  createConsolePluginDetailPageModel,
  createPluginConsoleExecutableActions,
  type PluginConsoleExecutableAction,
  type PluginConsoleFeatureKind,
  type PluginConsoleConfigProjection,
  type PluginConsoleLocation,
} from './console-model.js';
import {
  preparePluginTargetsForCommand,
  type ResolvedPluginTarget,
} from './common.js';
import { installCommand } from './install.js';
import { cleanupCommand, isCleanupExecutionFailure } from './cleanup.js';
import { reinstallCommand } from './reinstall.js';
import {
  loadConsoleItemsResult,
} from './status.js';
import { uninstallCommand } from './uninstall.js';
import { upgradeCommand } from './upgrade.js';
import { formatWarnings } from '../output/reporter.js';
import {
  buildCleanupReceiptJson,
  buildCommandReceiptJson,
  renderCommandReceipt,
} from '../output/command-receipt.js';
import {
  findConfigFieldEntry,
  hasConfigReadV2Content,
  coercePluginConfigValue,
  createPluginConfigSchemaIdentity,
  createPluginConfigFormModel,
  readPluginConfigStore,
  resolveConfigReadV2,
  resetPluginConfigStore,
  resolveEffectivePluginConfig,
  resolvePluginConfigStorePath,
  type PluginConfigFormFieldModel,
  type PluginConfigValue,
} from '../utils/plugin-config.js';
import {
  applyPluginConfigWrite,
  replayConfigRuntimeWrites,
  resetPluginConfigWithHelper,
} from '../utils/plugin-config-write.js';

type ConsoleNavigation = 'back' | 'reload' | 'exit' | 'stay';

interface ConsoleHomeState {
  items: ConsoleControllerItem[];
  banner?: string;
}

interface ScopedFieldState {
  configured: boolean;
  currentValue?: PluginConfigValue;
  issueMessage?: string;
}

interface ConfigSubmission {
  scope: Scope;
  updates: Record<string, PluginConfigValue>;
  removeKeys: string[];
}

interface ExecutableTargetSelection {
  action: PluginConsoleExecutableAction;
  location: PluginConsoleLocation;
}

interface ConsoleExecutionOutcome {
  selection: ExecutableTargetSelection;
  status: 'succeeded' | 'failed';
  lines: string[];
  targetResults?: ReceiptTargetResult[];
  configStoreRemovals?: ConfigStoreRemovalResult[];
}

interface ConsoleRecentResult {
  label: string;
  targetResults: ReceiptTargetResult[];
  configStoreRemovals?: ConfigStoreRemovalResult[];
  summaryLines?: string[];
}

interface ConsoleActionResolution {
  navigation: ConsoleNavigation;
  item?: ConsoleControllerItem;
  recentResult?: ConsoleRecentResult;
  notice?: string;
}

interface ConfigStoreExecutionGroup {
  storePath: string;
  scope: Scope;
  selections: ExecutableTargetSelection[];
}

interface ScopedExecutionGroup {
  scope: Scope;
  selections: ExecutableTargetSelection[];
  platform: PlatformSelection;
}

interface CleanupPlanOutcome {
  selection: ExecutableTargetSelection;
  status: 'planned' | 'failed';
  removeConfig: boolean;
  needsForce?: boolean;
  lines: string[];
}

interface ExecutableCleanupPlanGroup {
  scope: Scope;
  selections: Array<CleanupPlanOutcome & { status: 'planned'; needsForce: boolean }>;
  platform: PlatformSelection;
  force: boolean;
}

interface RunCleanupActionOptions {
  planTitle: string;
  confirmTitle: string;
  riskTitle: string;
  resultLabel: string;
  promptRemoveConfig?: boolean;
}

interface ConfigWriteOutcome {
  prompt: ConsoleRequiredConfigPrompt;
  scope: Scope;
  updatedKeys: string[];
  removedKeys: string[];
  artifactRefreshStatus: 'succeeded' | 'failed' | 'skipped';
  artifactRefreshError?: string;
}

type ConsoleConfigTarget =
  | {
    kind: 'location';
    label: string;
    location: PluginConsoleLocation;
    consumerLocations: PluginConsoleLocation[];
    projection?: PluginConsoleConfigProjection;
  }
  | {
    kind: 'preconfigure';
    label: string;
    scope: Scope;
    projection?: PluginConsoleConfigProjection;
    consumerLocations: PluginConsoleLocation[];
    plugin: PluginMeta;
  }
  | {
    kind: 'store';
    label: string;
    scope: Scope;
    projectLayer: 'shared' | 'local';
    projection?: PluginConsoleConfigProjection;
    legacyStore?: LegacyConfigStoreEntryV2;
    consumerLocations: PluginConsoleLocation[];
    plugin?: PluginMeta | null;
  };

interface ConsoleConfigWriteGroup {
  storePath: string;
  scope: Scope;
  projectLayer: 'shared' | 'local';
  formIdentity: string;
  label: string;
  locations: PluginConsoleLocation[];
  applyTargets: ReceiptTargetResult['target'][];
}

interface ConsoleConfigViewTarget {
  scope: Scope | 'effective';
  projectLayer: 'shared' | 'local';
  label: string;
}

function renderView(context: CliExecutionContext, title: string, lines: string[]): Promise<unknown> {
  const view: CliConsoleView = { title, lines };
  return Promise.resolve(context.consoleDriver.render(view));
}

function joinNonEmpty(lines: Array<string | undefined>): string[] {
  return lines.filter((line): line is string => Boolean(line && line.trim() !== ''));
}

function promptCancelled<T>(result: CliPromptResult<T>): boolean {
  return result.action !== 'select' || result.value === undefined;
}

function hasLegacyPromptValue<T>(
  result: CliPromptResult<T>,
  legacyValue: string,
): boolean {
  return result.action === 'select' && result.value === legacyValue;
}

async function selectValue(
  context: CliExecutionContext,
  options: {
    message: string;
    choices: CliPromptChoice[];
    defaultValue?: string;
    pageSize?: number;
  },
): Promise<CliPromptResult<string>> {
  return context.prompt.select!({
    ...options,
    pageSize: options.pageSize ?? Math.min(Math.max(options.choices.length, 6), 12),
  });
}

function isPromptAction<T>(
  result: CliPromptResult<T>,
  action: CliPromptAction,
): boolean {
  if (result.action === action) {
    return true;
  }
  if (action === 'back') {
    return hasLegacyPromptValue(result, '__back');
  }
  if (action === 'exit') {
    return hasLegacyPromptValue(result, '__exit');
  }
  return false;
}

function selectedPromptValue<T>(result: CliPromptResult<T>): T | null {
  return promptCancelled(result) || isPromptAction(result, 'back') || isPromptAction(result, 'exit')
    ? null
    : result.value!;
}

async function confirmValue(
  context: CliExecutionContext,
  message: string,
  defaultValue = false,
): Promise<boolean> {
  const result = await context.prompt.confirm!({ message, defaultValue });
  return !promptCancelled(result) && result.value === true;
}

function buildHomeChoices(items: ConsoleControllerItem[]): CliPromptChoice[] {
  return [
    ...items.map((item) => ({
      value: item.summary.pluginName,
      label: item.summary.title,
      short: item.summary.title,
    })),
    { value: 'home-refresh', label: '刷新' },
    { value: 'home-exit', label: '退出', role: 'exit' },
  ];
}

function groupHomeItems(items: ConsoleControllerItem[]): Array<{
  title: string;
  items: ConsoleControllerItem[];
}> {
  const sections: Array<{
    key: 'abnormal' | 'upgradeAvailable' | 'installed' | 'notInstalled';
    title: string;
  }> = [
    { key: 'abnormal', title: '异常' },
    { key: 'upgradeAvailable', title: '可升级' },
    { key: 'installed', title: '已安装' },
    { key: 'notInstalled', title: '未安装' },
  ];

  return sections
    .map((section) => ({
      title: section.title,
      items: items.filter((item) => item.summary.status === section.key),
    }))
    .filter((section) => section.items.length > 0);
}

function buildFeatureChoices(item: ConsoleControllerItem): CliPromptChoice[] {
  return [
    ...item.detailPage.featureMenu
      .map((feature) => ({
      value: feature.kind,
      label: feature.recommended ? `${feature.label}（推荐）` : feature.label,
      description: feature.disabledReason
        ?? (feature.recommended ? '当前建议先查看或执行这个入口。' : undefined)
        ?? (feature.targetSelection === 'multiTargetAllowed'
          ? '可继续选择单个平台或所有平台'
          : feature.targetSelection === 'singleTargetOnly'
            ? '继续选择目标位置'
            : undefined),
      short: feature.label,
      disabled: feature.disabledReason,
    })),
    { value: 'feature-back', label: '返回', role: 'back' },
    { value: 'feature-exit', label: '退出', role: 'exit' },
  ];
}

function buildTargetChoiceValue(location: Pick<PluginConsoleLocation, 'platform' | 'scope' | 'projectKey'>): string {
  return `${location.platform}:${location.scope}:${location.projectKey ?? '-'}`;
}

function buildTargetChoices(
  item: ConsoleControllerItem,
  featureKind: PluginConsoleFeatureKind,
): CliPromptChoice[] {
  const detail = createConsolePluginDetailPageModel(item, featureKind);
  const platforms = [...new Set(detail.targetOptions
    .filter((option) => !option.disabledReason)
    .map((option) => option.platform))];
  const feature = item.summary.features.find((entry) => entry.kind === featureKind);

  return [
    ...(feature?.targetSelection === 'multiTargetAllowed' && platforms.length > 1
      ? [{
          value: '__all_platforms',
          label: '全部支持平台',
          description: platforms.map((platform) => platform === 'codex' ? 'Codex' : 'Claude Code').join('、'),
          short: '全部支持平台',
        } satisfies CliPromptChoice]
      : []),
    ...detail.targetOptions.map((option) => ({
      value: buildTargetChoiceValue(option),
      label: `${option.label} · ${option.statusLabel ?? option.status ?? 'unknown'}`,
      description: option.disabledReason,
      short: option.label,
      disabled: option.disabledReason,
    })),
    { value: 'target-back', label: '返回', role: 'back' },
    { value: 'target-exit', label: '退出', role: 'exit' },
  ];
}

function findLocation(
  item: ConsoleControllerItem,
  value: string,
): PluginConsoleLocation | undefined {
  return item.locations.find((location) => buildTargetChoiceValue(location) === value);
}

function buildHomeLines(state: ConsoleHomeState): string[] {
  return joinNonEmpty([
    state.banner,
    ...(state.banner ? [''] : []),
    ...groupHomeItems(state.items).flatMap((section, sectionIndex) => [
      ...(sectionIndex > 0 ? [''] : []),
      `${section.title}（${section.items.length}）`,
      ...section.items.flatMap((item) => [
        `${item.pageItem.statusSymbol} ${item.summary.title}${item.pageItem.version ? ` ${item.pageItem.version}` : ''}`,
        ...(item.pageItem.description ? [`  ${item.pageItem.description}`] : []),
        `  ${joinNonEmpty([
          item.pageItem.platformSummary,
          item.pageItem.primaryActionLabel,
        ]).join(' · ')}`,
        ...(item.summary.issueSummary ? [`  ${item.summary.issueSummary}`] : []),
        ...formatHomeAgentVersionLines(item),
      ]),
    ]),
  ]);
}

function formatHomeAgentVersionLines(item: ConsoleControllerItem): string[] {
  return (item.summary.agentVersionSummary ?? [])
    .filter((diagnostic) =>
      diagnostic.status === 'missing' ||
      diagnostic.status === 'unparseable' ||
      diagnostic.status === 'tooOld')
    .map((diagnostic) => {
      const platform = platformLabel(diagnostic.platform);
      const detected = diagnostic.detectedVersion ? `当前 ${diagnostic.detectedVersion}` : diagnostic.reasonCode ?? diagnostic.status;
      return `  ${platform} 写入会被版本门禁阻断：${detected}，需要 >= ${diagnostic.requiredMinVersion}。${diagnostic.suggestedAction}`;
    });
}

function inheritedCatalogSelectorOptions(
  context: CliExecutionContext,
): {
  catalogChannel?: string;
  catalogVersion?: string;
} {
  return {
    ...(context.env.AW_CATALOG_CHANNEL ? { catalogChannel: context.env.AW_CATALOG_CHANNEL } : {}),
    ...(context.env.AW_CATALOG_VERSION ? { catalogVersion: context.env.AW_CATALOG_VERSION } : {}),
  };
}

async function loadConsoleHomeState(
  context: CliExecutionContext,
  options: { verbose?: boolean } = {},
): Promise<ConsoleHomeState> {
  const result = await loadConsoleItemsResult({
    cwd: context.cwd,
    includeCatalogOnly: true,
    ...(options.verbose ? { verbose: true } : {}),
    ...inheritedCatalogSelectorOptions(context),
  }, context);
  return {
    items: result.items,
    ...(result.catalogUnavailable
      ? { banner: '插件目录不可用，仅显示已发现安装；恢复后可安装或升级。' }
      : {}),
  };
}

async function loadConsoleDetailItem(
  context: CliExecutionContext,
  pluginName: string,
  fallback: ConsoleControllerItem,
): Promise<ConsoleControllerItem> {
  const homeState = await loadConsoleHomeState(context, { verbose: true });
  return homeState.items.find((entry) => entry.summary.pluginName === pluginName) ?? fallback;
}

function renderResultWithWarnings(
  lines: string[],
  warnings: string[] = [],
): string[] {
  const friendlyWarnings = formatWarnings(warnings, { actionableOnly: true });
  return friendlyWarnings.length > 0
    ? [...lines, '', ...friendlyWarnings]
    : lines;
}

function configScopeLabel(scope: Scope): string {
  return scope === 'user' ? '个人' : '当前项目';
}

function platformLabel(platform: PluginConsoleLocation['platform']): string {
  return platform === 'codex' ? 'Codex' : 'Claude Code';
}

function artifactRefreshStatusLabel(status: 'succeeded' | 'failed' | 'skipped'): string {
  switch (status) {
    case 'succeeded':
      return '已更新';
    case 'failed':
      return '刷新失败';
    case 'skipped':
      return '无需更新';
  }
}

function artifactRefreshLine(status: 'succeeded' | 'failed' | 'skipped'): string {
  return `相关项目文件：${artifactRefreshStatusLabel(status)}`;
}

function stateLabel(state: ReceiptTargetResult['state']): string {
  switch (state) {
    case 'completed':
      return '已完成';
    case 'rolledBack':
      return '已回滚';
    case 'notRun':
      return '未执行';
    case 'failed':
      return '失败';
  }
}

function configStoreRemovalStateLabel(state: ConfigStoreRemovalResult['state']): string {
  switch (state) {
    case 'removed':
      return '已删除';
    case 'notFound':
      return '未找到';
    case 'skipped':
      return '已保留';
    case 'failed':
      return '删除失败';
  }
}

function buildTargetLocationLabel(
  item: ConsoleControllerItem,
  target: ReceiptTargetResult['target'],
): string {
  const location = item.locations.find((entry) =>
    entry.platform === target.platform &&
    entry.scope === target.scope &&
    (entry.projectKey ?? null) === (target.projectKey ?? null),
  );
  return location?.locationLabel ?? `${platformLabel(target.platform)}（${configScopeLabel(target.scope)}）`;
}

function dedupeTargetResults(targetResults: ReceiptTargetResult[]): ReceiptTargetResult[] {
  const deduped = new Map<string, ReceiptTargetResult>();
  for (const targetResult of targetResults) {
    const key = [
      targetResult.target.pluginName,
      targetResult.target.platform,
      targetResult.target.scope,
      targetResult.target.projectKey ?? '',
      targetResult.action,
      targetResult.state,
      targetResult.rollbackState ?? '',
      targetResult.errorCode ?? '',
      targetResult.message ?? '',
    ].join('\0');
    deduped.set(key, targetResult);
  }
  return [...deduped.values()].sort((left, right) =>
    left.target.platform.localeCompare(right.target.platform) ||
    left.target.scope.localeCompare(right.target.scope) ||
    (left.target.projectKey ?? '').localeCompare(right.target.projectKey ?? '') ||
    left.action.localeCompare(right.action),
  );
}

function renderRecentConfigStoreRemovalLines(
  item: ConsoleControllerItem,
  removals: ConfigStoreRemovalResult[],
): string[] {
  if (removals.length === 0) {
    return [];
  }

  return [
    '配置处理',
    ...removals.map((removal) => {
      const subjects = removal.subjectTargets
        .map((target) => buildTargetLocationLabel(item, target))
        .join('、');
      const message = removal.message ? `：${removal.message}` : '';
      return `- ${configScopeLabel(removal.store.storeKind === 'user' ? 'user' : 'project')} AW 自管配置 · ${configStoreRemovalStateLabel(removal.state)} · 主体：${subjects}${message}`;
    }),
  ];
}

function renderRecentResultLines(
  item: ConsoleControllerItem,
  recentResult: ConsoleRecentResult | undefined,
): string[] {
  if (!recentResult) {
    return [];
  }

  return joinNonEmpty([
    `最近结果 · ${recentResult.label}`,
    ...dedupeTargetResults(recentResult.targetResults).map((targetResult) => {
      const message = targetResult.message ? `：${targetResult.message}` : '';
      return `- ${buildTargetLocationLabel(item, targetResult.target)} · ${stateLabel(targetResult.state)}${message}`;
    }),
    ...(recentResult.targetResults.length === 0 ? (recentResult.summaryLines ?? []) : []),
    ...(recentResult.configStoreRemovals?.length
      ? ['', ...renderRecentConfigStoreRemovalLines(item, recentResult.configStoreRemovals)]
      : []),
  ]);
}

function stripTuiCommandSuggestionLines(lines: string[]): string[] {
  return lines.filter((line) => !line.startsWith('下一步：'));
}

function commandResultLines(
  command: 'install' | 'uninstall' | 'upgrade',
  scope: Scope,
  result: Parameters<typeof buildCommandReceiptJson>[1]['result'],
  options: {
    headlineVariant?: 'install' | 'reinstall';
  } = {},
): string[] {
  const payload = buildCommandReceiptJson(command, {
    result,
    groups: [{
      scope,
      platforms: result.platforms,
      plugins: result.plugins,
    }],
  });
  const headline = command === 'uninstall'
    ? '已执行卸载。'
    : command === 'upgrade'
      ? '已执行升级。'
      : options.headlineVariant === 'reinstall'
        ? '已执行重新安装。'
        : '已执行安装。';
  const targetLines = payload.targetResults.map((targetResult) => {
    const message = targetResult.message ? `：${targetResult.message}` : '';
    return `- ${platformLabel(targetResult.target.platform)}（${configScopeLabel(targetResult.target.scope)}） · ${stateLabel(targetResult.state)}${message}`;
  });
  return renderResultWithWarnings([
    headline,
    ...(targetLines.length > 0 ? targetLines : []),
  ], result.warnings);
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function indentLines(lines: string[], prefix = '  '): string[] {
  return lines.map((line) => `${prefix}${line}`);
}

function createSyntheticTargetResult(
  pluginName: string,
  selection: ExecutableTargetSelection,
  action: string,
  state: ReceiptTargetResult['state'],
  message?: string,
  rollbackState: ReceiptTargetResult['rollbackState'] = state === 'rolledBack'
    ? 'completed'
    : state === 'failed'
      ? 'failed'
      : 'notNeeded',
): ReceiptTargetResult {
  return {
    target: {
      pluginName,
      platform: selection.location.platform,
      scope: selection.location.scope,
      ...(selection.location.projectKey ? { projectKey: selection.location.projectKey } : {}),
    },
    action,
    state,
    ...(message ? { message } : {}),
    rollbackState,
  };
}

function createFailedExecutionOutcome(
  pluginName: string,
  selection: ExecutableTargetSelection,
  error: unknown,
  action: string,
): ConsoleExecutionOutcome {
  const message = formatErrorMessage(error);
  return {
    selection,
    status: 'failed',
    lines: [message],
    targetResults: [createSyntheticTargetResult(pluginName, selection, action, 'failed', message, 'failed')],
  };
}

function createRecentResult(
  label: string,
  outcomes: ConsoleExecutionOutcome[],
): ConsoleRecentResult {
  return {
    label,
    targetResults: dedupeTargetResults(outcomes.flatMap((outcome) => outcome.targetResults ?? [])),
    configStoreRemovals: outcomes.flatMap((outcome) => outcome.configStoreRemovals ?? []),
  };
}

function platformSelectionForSelections(selections: ExecutableTargetSelection[]): PlatformSelection {
  const platforms = [...new Set(selections.map((selection) => selection.location.platform))];
  return platforms.length > 1 ? 'both' : platforms[0]!;
}

function groupSelectionsByScope(selections: ExecutableTargetSelection[]): ScopedExecutionGroup[] {
  const groups = new Map<Scope, ExecutableTargetSelection[]>();
  for (const selection of selections) {
    const bucket = groups.get(selection.location.scope) ?? [];
    bucket.push(selection);
    groups.set(selection.location.scope, bucket);
  }

  return [...groups.entries()].map(([scope, groupedSelections]) => ({
    scope,
    selections: groupedSelections,
    platform: platformSelectionForSelections(groupedSelections),
  }));
}

function groupExecutableCleanupPlans(
  plans: Array<CleanupPlanOutcome & { status: 'planned'; needsForce: boolean }>,
): ExecutableCleanupPlanGroup[] {
  const groups = new Map<Scope, Array<CleanupPlanOutcome & { status: 'planned'; needsForce: boolean }>>();
  for (const plan of plans) {
    const bucket = groups.get(plan.selection.location.scope) ?? [];
    bucket.push(plan);
    groups.set(plan.selection.location.scope, bucket);
  }

  return [...groups.entries()].map(([scope, groupedPlans]) => {
    const selections = groupedPlans.map((plan) => plan.selection);
    return {
      scope,
      selections: groupedPlans,
      platform: platformSelectionForSelections(selections),
      force: groupedPlans.some((plan) => plan.needsForce),
    };
  });
}

function createFailedExecutionOutcomes(
  pluginName: string,
  selections: ExecutableTargetSelection[],
  error: unknown,
  action: string,
): ConsoleExecutionOutcome[] {
  return selections.map((selection) =>
    createFailedExecutionOutcome(pluginName, selection, error, action));
}

function createGroupedExecutionOutcomes(options: {
  selections: ExecutableTargetSelection[];
  status: ConsoleExecutionOutcome['status'];
  lines: string[];
  targetResults?: ReceiptTargetResult[];
  configStoreRemovals?: ConfigStoreRemovalResult[];
}): ConsoleExecutionOutcome[] {
  return options.selections.map((selection) => ({
    selection,
    status: options.status,
    lines: options.lines,
    ...(options.targetResults ? { targetResults: options.targetResults } : {}),
    ...(options.configStoreRemovals ? { configStoreRemovals: options.configStoreRemovals } : {}),
  }));
}

function createCommandTargetResults(options: {
  command: 'install' | 'uninstall' | 'upgrade';
  scope: Scope;
  result: Parameters<typeof renderCommandReceipt>[1]['result'];
}): ReceiptTargetResult[] {
  return buildCommandReceiptJson(options.command, {
    result: options.result,
    groups: [{
      scope: options.scope,
      platforms: options.result.platforms,
      plugins: options.result.plugins,
    }],
  }).targetResults;
}

function renderGroupedLines(options: {
  entries: Array<{
    selection: ExecutableTargetSelection;
    lines: string[];
    statusLabel?: string;
  }>;
}): string[] {
  const grouped = new Map<PluginConsoleLocation['platform'], Array<{
    selection: ExecutableTargetSelection;
    lines: string[];
    statusLabel?: string;
  }>>();
  for (const entry of options.entries) {
    const bucket = grouped.get(entry.selection.location.platform) ?? [];
    bucket.push(entry);
    grouped.set(entry.selection.location.platform, bucket);
  }

  return [...grouped.entries()].flatMap(([platform, entries], index) => [
    ...(index > 0 ? [''] : []),
    `${platformLabel(platform)}：`,
    ...entries.flatMap((entry) => [
      `- ${entry.selection.location.locationLabel}${entry.statusLabel ? ` · ${entry.statusLabel}` : ''}`,
      ...indentLines(entry.lines),
    ]),
  ]);
}

function renderExecutionOutcomeLines(outcomes: ConsoleExecutionOutcome[]): string[] {
  if (outcomes.length === 0) {
    return ['当前没有可执行的目标。'];
  }

  if (outcomes.length === 1) {
    return outcomes[0]!.lines;
  }

  const succeededCount = outcomes.filter((outcome) => outcome.status === 'succeeded').length;
  const failedCount = outcomes.length - succeededCount;

  return joinNonEmpty([
    failedCount === 0
      ? `已完成 ${outcomes.length} 个目标。`
      : `已完成 ${outcomes.length} 个目标，其中 ${succeededCount} 个成功，${failedCount} 个失败。`,
    '',
    ...renderGroupedLines({
      entries: outcomes.map((outcome) => ({
        selection: outcome.selection,
        statusLabel: outcome.status === 'succeeded' ? '成功' : '失败',
        lines: outcome.lines,
      })),
    }),
  ]);
}

function scopeLabel(scope: Scope): string {
  return scope === 'project' ? '当前项目' : '当前用户';
}

function selectionToTargetIdentity(
  pluginName: string,
  selection: ExecutableTargetSelection,
): ReceiptTargetResult['target'] {
  return {
    pluginName,
    platform: selection.location.platform,
    scope: selection.location.scope,
    ...(selection.location.projectKey ? { projectKey: selection.location.projectKey } : {}),
  };
}

function describeDestructiveSelections(
  actionLabel: string,
  selections: ExecutableTargetSelection[],
  extraLines: string[] = [],
): string[] {
  const actionKind = selections[0]?.action.kind;
  const impactLines = (() => {
    switch (actionKind) {
      case 'runUninstall':
        return ['将删除这些目标上的 AW 托管安装与对应运行时状态。'];
      case 'runCleanup':
      case 'resolveDuplicateInstall':
        return ['将清理这些目标上的 AW 可重建残留和异常状态。'];
      case 'runReinstall':
        return ['将先删除这些目标上的 AW 当前状态，再按 current catalog 重新建立安装。'];
      case 'runAdoptExisting':
        return ['将为现有共享产物建立本机 ownership，不会重写仓库里已存在的共享内容。'];
      default:
        return ['将按当前选择继续处理这些目标。'];
    }
  })();
  const unaffectedLines = (() => {
    switch (actionKind) {
      case 'runCleanup':
      case 'runReinstall':
      case 'runUninstall':
      case 'resolveDuplicateInstall':
        return ['不会删除外部来源内容；遇到归属不明确的内容会跳过或阻断。'];
      case 'runAdoptExisting':
        return ['不会删除配置，也不会静默覆盖外部来源内容。'];
      default:
        return [];
    }
  })();
  return joinNonEmpty([
    `操作：${actionLabel}`,
    '',
    '对象：',
    '- 当前插件',
    '',
    '真实目标：',
    ...selections.map((selection) => `- ${selection.location.locationLabel}`),
    '',
    '将会处理：',
    ...impactLines.map((line) => `- ${line}`),
    '',
    '不会影响：',
    ...unaffectedLines,
    '',
    '配置：',
    '- 默认保留；只有你显式选择删除时才会一并移除。',
    '',
    '影响范围：',
    `- ${selections.length === 1 ? '1 个目标' : `${selections.length} 个目标`}`,
    ...(selections.length > 1
      ? ['- 结果会按真实目标逐项记录完成、未执行或失败。']
      : []),
    ...(extraLines.length > 0 ? ['', ...extraLines] : []),
  ]);
}

function renderConfigStoreExecutionGroupLines(groups: ConfigStoreExecutionGroup[]): string[] {
  if (groups.length === 0) {
    return [];
  }

  return [
    '配置删除范围：',
    ...groups.flatMap((group) => [
      `- ${scopeLabel(group.scope)} AW 自管配置`,
      `  主体：${group.selections.map((selection) => selection.location.locationLabel).join('、')}`,
      '  仅当这一组主体全部成功后才会删除。',
    ]),
  ];
}

async function promptOptionConfirmation(
  context: CliExecutionContext,
  title: string,
  lines: string[],
  continueLabel: string,
): Promise<'confirmed' | 'back' | 'exit'> {
  await renderView(context, title, lines);
  const result = await selectValue(context, {
    message: '确认操作',
    choices: [
      { value: 'confirm-back', label: '取消（推荐）', role: 'back' },
      { value: 'confirm-continue', label: continueLabel },
      { value: 'confirm-exit', label: '退出', role: 'exit' },
    ],
    defaultValue: 'confirm-back',
  });
  if (isPromptAction(result, 'exit')) {
    return 'exit';
  }
  if (isPromptAction(result, 'back') || isPromptAction(result, 'cancel')) {
    return 'back';
  }
  return selectedPromptValue(result) === 'confirm-continue' ? 'confirmed' : 'back';
}

async function confirmDestructiveAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  action: PluginConsoleExecutableAction,
  selections: ExecutableTargetSelection[],
  extraLines: string[] = [],
): Promise<'confirmed' | 'back' | 'exit'> {
  return promptOptionConfirmation(
    context,
    `${item.summary.title} 确认`,
    describeDestructiveSelections(action.label, selections, extraLines.length > 0
      ? extraLines
      : selections.length === 1 && action.confirmText
        ? [action.confirmText]
        : []),
    `继续${action.label}`,
  );
}

function buildCleanupExecutionSelections(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selections: ExecutableTargetSelection[],
): ConfigStoreExecutionGroup[] {
  const groups = new Map<string, ConfigStoreExecutionGroup>();
  for (const selection of selections) {
    const storePath = resolvePluginConfigStorePath({
      pluginName: item.summary.pluginName,
      scope: selection.location.scope,
      cwd: context.cwd,
      env: context.env,
    });
    const existing = groups.get(storePath);
    if (existing) {
      existing.selections.push(selection);
      continue;
    }
    groups.set(storePath, {
      storePath,
      scope: selection.location.scope,
      selections: [selection],
    });
  }
  return [...groups.values()];
}

function buildCleanupPlanSelections(
  groups: ConfigStoreExecutionGroup[],
  removeConfig: boolean,
): Array<{
  selection: ExecutableTargetSelection;
  removeConfig: boolean;
}> {
  return groups.flatMap((group) =>
    group.selections.map((selection, index) => ({
      selection,
      removeConfig: removeConfig && index === 0,
    })));
}

async function applyGroupedConfigRemoval(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  groups: ConfigStoreExecutionGroup[],
  outcomes: ConsoleExecutionOutcome[],
  removeConfig: boolean,
): Promise<ConfigStoreRemovalResult[]> {
  if (!removeConfig) {
    return [];
  }

  const removals: ConfigStoreRemovalResult[] = [];
  for (const group of groups) {
    const groupTargetKeys = new Set(group.selections.map((selection) =>
      buildTargetChoiceValue(selection.location)));
    const subjectTargets = group.selections.map((selection) =>
      selectionToTargetIdentity(item.summary.pluginName, selection));
    const groupOutcomes = outcomes.filter((outcome) =>
      groupTargetKeys.has(buildTargetChoiceValue(outcome.selection.location)));
    if (groupOutcomes.length === 0) {
      continue;
    }

    if (groupOutcomes.some((outcome) => outcome.status === 'failed')) {
      removals.push({
        store: {
          pluginName: item.summary.pluginName,
          storeKind: group.scope === 'project' ? 'projectShared' : 'user',
          ...(group.scope === 'project' && group.selections[0]?.location.projectKey
            ? { projectRoot: group.selections[0].location.projectKey }
            : {}),
        },
        state: 'skipped',
        reasonCode: 'subjectFailed',
        message: `已保留${scopeLabel(group.scope)}的 AW 自管配置；同一配置位置仍有主体失败。`,
        subjectTargets,
        path: group.storePath,
      });
      continue;
    }

    try {
      const reset = await resetPluginConfigStore({
        pluginName: item.summary.pluginName,
        scope: group.scope,
        cwd: context.cwd,
        env: context.env,
      });
      removals.push({
        store: {
          pluginName: item.summary.pluginName,
          storeKind: group.scope === 'project' ? 'projectShared' : 'user',
          ...(group.scope === 'project' && group.selections[0]?.location.projectKey
            ? { projectRoot: group.selections[0].location.projectKey }
            : {}),
        },
        state: reset.deleted ? 'removed' : 'notFound',
        subjectTargets,
        path: group.storePath,
      });
    } catch (error) {
      removals.push({
        store: {
          pluginName: item.summary.pluginName,
          storeKind: group.scope === 'project' ? 'projectShared' : 'user',
          ...(group.scope === 'project' && group.selections[0]?.location.projectKey
            ? { projectRoot: group.selections[0].location.projectKey }
            : {}),
        },
        state: 'failed',
        reasonCode: 'removeFailed',
        message: `未能删除${scopeLabel(group.scope)}的 AW 自管配置：${formatErrorMessage(error)}`,
        subjectTargets,
        path: group.storePath,
      });
    }
  }

  return removals;
}

function renderCleanupPlanOutcomeLines(outcomes: CleanupPlanOutcome[]): string[] {
  return renderGroupedLines({
    entries: outcomes.map((outcome) => ({
      selection: outcome.selection,
      statusLabel: outcome.status === 'planned' ? '已评估' : '评估失败',
      lines: outcome.lines,
    })),
  });
}

function summarizeCleanupPlanPayload(payload: {
  cleanupScope?: Array<{ label: string }>;
  blockingReasons?: Array<{ message: string }>;
  affectedDependents?: Array<{ plugin: string; platform: PlatformName; scope: Scope }>;
  removeConfig: boolean;
}): string[] {
  const cleanupScope = payload.cleanupScope ?? [];
  const blockingReasons = payload.blockingReasons ?? [];
  const affectedDependents = payload.affectedDependents ?? [];
  return joinNonEmpty([
    cleanupScope.length > 0
      ? `会处理 ${cleanupScope.length} 项 AW 状态。`
      : '当前没有需要处理的 AW 状态。',
    ...(cleanupScope.length > 0
      ? cleanupScope.slice(0, 4).map((entry) => `- ${entry.label}`)
      : []),
    ...(cleanupScope.length > 4
      ? [`- 其余 ${cleanupScope.length - 4} 项会在执行时一并处理。`]
      : []),
    ...(payload.removeConfig ? ['- 会按你的选择同时删除当前目标的 AW 自管配置。'] : ['- 默认保留配置。']),
    ...(affectedDependents.length > 0
      ? [
          '- 这次处理会触及依赖链，请先确认这些引用关系。',
          ...affectedDependents.slice(0, 3).map((dependent) =>
            `  - ${dependent.plugin} · ${platformLabel(dependent.platform)} · ${configScopeLabel(dependent.scope)}`),
        ]
      : []),
    ...(blockingReasons.length > 0
      ? [
          '- 已发现风险或阻断项：',
          ...blockingReasons.slice(0, 3).map((reason) => `  - ${reason.message}`),
        ]
      : []),
  ]);
}

function summarizeCleanupExecutionPayload(payload: {
  deletedItems?: Array<{ label: string }>;
  residueItems?: Array<{ label: string }>;
  failedItems?: Array<{ label: string }>;
  blockingReasons?: Array<{ message: string }>;
  removeConfig: boolean;
}): string[] {
  const deletedItems = payload.deletedItems ?? [];
  const residueItems = payload.residueItems ?? [];
  const failedItems = payload.failedItems ?? [];
  const blockingReasons = payload.blockingReasons ?? [];
  const parts = [
    deletedItems.length > 0 ? `已处理 ${deletedItems.length} 项` : undefined,
    residueItems.length > 0 ? `仍有 ${residueItems.length} 项残留` : undefined,
    failedItems.length > 0 ? `${failedItems.length} 项处理失败` : undefined,
  ].filter(Boolean);
  return joinNonEmpty([
    parts.length > 0 ? parts.join('，') : '当前没有需要清理的 AW 状态。',
    ...(payload.removeConfig ? ['- 配置按你的选择处理。'] : ['- 配置已保留。']),
    ...(blockingReasons.length > 0
      ? blockingReasons.slice(0, 3).map((reason) => `- ${reason.message}`)
      : []),
  ]);
}

async function executeWithDeferredExit<T>(
  context: CliExecutionContext,
  title: string,
  actionLabel: string,
  run: () => Promise<T>,
): Promise<{ result: T; exitRequested: boolean }> {
  const stdin = (context.stdin ?? process.stdin) as CliExecutionContext['stdin'] & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => unknown;
  };
  let exitRequested = false;
  let rawModeEnabled = false;

  const renderExecutionState = (requested: boolean): void => {
    void renderView(context, title, joinNonEmpty([
      `正在${actionLabel}。`,
      '已开始的写入、回滚、receipt 写入和状态写回会继续完成。',
      requested ? '已收到退出请求；当前操作完成后会安全退出。' : '可按 q 或 Ctrl+C 在结束后退出控制台。',
    ]));
  };

  const requestExit = (): void => {
    if (exitRequested) {
      return;
    }
    exitRequested = true;
    renderExecutionState(true);
  };

  const onData = (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const normalized = text.trim();
    if (text === '\u0003' || normalized === 'q' || normalized === 'Q') {
      requestExit();
    }
  };
  const onSigint = () => {
    requestExit();
  };

  renderExecutionState(false);
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    stdin.setRawMode(true);
    rawModeEnabled = true;
  }
  stdin.on('data', onData);
  process.on('SIGINT', onSigint);
  try {
    return {
      result: await run(),
      exitRequested,
    };
  } finally {
    stdin.off('data', onData);
    process.off('SIGINT', onSigint);
    if (rawModeEnabled) {
      stdin.setRawMode?.(false);
    }
    stdin.pause();
  }
}

async function reloadConsoleItem(
  context: CliExecutionContext,
  pluginName: string,
  fallback: ConsoleControllerItem,
): Promise<ConsoleControllerItem> {
  return await loadResultPageItem(context, pluginName) ?? fallback;
}

function renderDetailLines(
  item: ConsoleControllerItem,
  recentResult?: ConsoleRecentResult,
  notice?: string,
): string[] {
  const detail = item.detailPage;
  return joinNonEmpty([
    `${detail.summary.title}${detail.summary.version ? ` ${detail.summary.version}` : ''}`,
    `${detail.statusSymbol} ${detail.summary.statusLabel}`,
    detail.summary.description,
    detail.summary.issueSummary,
    ...(notice ? ['', `提示：${notice}`] : []),
    ...(recentResult ? ['', ...renderRecentResultLines(item, recentResult)] : []),
    '',
    '位置',
    ...detail.platformDetails.map((entry) => `${entry.statusSymbol} ${entry.label} · ${entry.statusLabel}`),
    ...(detail.dependencySummary ? ['', `依赖：${detail.dependencySummary}`] : []),
  ]);
}

function renderStatusSummaryLines(item: ConsoleControllerItem): string[] {
  const summaryLocations = item.statusPage.locations.filter((location) => location.hasEvidence);
  return joinNonEmpty([
    `${item.detailPage.statusSymbol} ${item.statusPage.summary.statusLabel}`,
    item.statusPage.summary.issueSummary,
    ...(summaryLocations.length > 0
      ? [
          '',
          '有证据的位置',
          ...summaryLocations.map((location) =>
            `${location.statusSymbol} ${location.label} · ${location.statusLabel}`),
        ]
      : ['当前没有可展开的现场证据。']),
  ]);
}

function renderStatusDetailLines(
  item: ConsoleControllerItem,
  locationKey: string,
): string[] {
  const location = item.statusPage.locations.find((entry) => entry.key === locationKey);
  if (!location) {
    return ['当前没有可展示的状态详情。'];
  }

  return joinNonEmpty([
    `${location.statusSymbol} ${location.label} · ${location.statusLabel}`,
    location.summary,
    ...(location.issue ? [location.issue.summary] : []),
    ...(location.issue?.details?.length
      ? ['', ...location.issue.details.map((detail) => `- ${detail}`)]
      : []),
    ...(location.diagnostics.length > 0
      ? [
          '',
          ...location.diagnostics.map((entry) => `${entry.label}：${entry.value}`),
        ]
      : []),
  ]);
}

function renderDependencyPageLines(item: ConsoleControllerItem): string[] {
  if (!item.dependencyPage || item.dependencyPage.groups.length === 0) {
    return ['当前没有可展示的依赖状态。'];
  }

  return item.dependencyPage.groups.flatMap((group, index) => [
    ...(index > 0 ? [''] : []),
    group.label,
    ...group.entries.map((entry) =>
      `${entry.symbol} ${entry.pluginName} · ${entry.locationLabel} · ${entry.summary}`),
  ]);
}

async function promptStringField(
  context: CliExecutionContext,
  field: PluginConfigFormFieldModel,
  required: boolean,
): Promise<string | null> {
  const promptFn = field.sensitive ? context.prompt.password! : context.prompt.input!;
  while (true) {
    const result = await promptFn({
      message: required
        ? `${field.label}${field.description ? ` (${field.description})` : ''}`
        : `${field.label}${field.description ? ` (${field.description})` : ''}，留空保持当前值`,
      ...(field.type === 'string' && field.defaultValue !== undefined && !field.sensitive
        ? { defaultValue: String(field.defaultValue) }
        : {}),
      ...(field.sensitive ? { mask: true } : {}),
    } as Parameters<typeof promptFn>[0]);
    if (promptCancelled(result)) {
      return null;
    }
    if (!required && result.value === '') {
      return '';
    }
    if (required && result.value === '') {
      await renderView(context, '配置提示', [`${field.label} 不能为空。`]);
      continue;
    }
    return result.value!;
  }
}

async function promptFieldValue(
  context: CliExecutionContext,
  projectRoot: string,
  field: PluginConfigFormFieldModel,
  required: boolean,
): Promise<PluginConfigValue | null> {
  if (field.type === 'enum') {
    const selected = await selectValue(context, {
      message: field.label,
      choices: [
        ...(field.enumValues ?? []).map((value) => ({
          value: String(value),
          label: String(value),
        })),
        ...(!required ? [{ value: '__skip', label: '保留当前值' }] : []),
      ],
      defaultValue: required
        ? String(field.enumValues?.[0] ?? '')
        : '__skip',
    });
    if (promptCancelled(selected)) {
      return null;
    }
    const value = selectedPromptValue(selected);
    if (value === null || (!required && value === '__skip')) {
      return null;
    }
    return coercePluginConfigValue({
      key: field.key,
      field: {
        type: 'enum',
        title: field.label,
        description: field.description,
        required: field.required,
        sensitive: field.sensitive,
        values: (field.enumValues ?? []).map(String),
        min: field.min,
        max: field.max,
      },
      value,
      projectRoot,
    });
  }

  if (field.type === 'boolean') {
    const selected = await selectValue(context, {
      message: field.label,
      choices: [
        { value: 'true', label: '是' },
        { value: 'false', label: '否' },
        ...(!required ? [{ value: '__skip', label: '保留当前值' }] : []),
      ],
      defaultValue: required ? 'true' : '__skip',
    });
    if (promptCancelled(selected)) {
      return null;
    }
    const value = selectedPromptValue(selected);
    if (value === null || (!required && value === '__skip')) {
      return null;
    }
    return coercePluginConfigValue({
      key: field.key,
      field: {
        type: 'boolean',
        title: field.label,
        description: field.description,
        required: field.required,
        sensitive: field.sensitive,
        min: field.min,
        max: field.max,
      },
      value: value === 'true',
      projectRoot,
    });
  }

  while (true) {
    const raw = await promptStringField(context, field, required);
    if (raw === null) {
      return null;
    }
    if (!required && raw === '') {
      return null;
    }
    try {
      return await coercePluginConfigValue({
        key: field.key,
        field: {
          type: field.type,
          title: field.label,
          description: field.description,
          required: field.required,
          sensitive: field.sensitive,
          default: field.defaultValue,
          values: field.enumValues?.map(String),
          min: field.min,
          max: field.max,
        },
        value: field.type === 'number' ? Number(raw) : raw,
        projectRoot,
      });
    } catch (error) {
      await renderView(context, '配置提示', [
        error instanceof Error ? error.message : String(error),
      ]);
    }
  }
}

async function buildScopedFieldStates(options: {
  target: ResolvedPluginTarget;
  scope: Scope;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<Record<string, ScopedFieldState>> {
  const plugin = options.target.currentPlugin ?? options.target.plugin;
  const effective = await resolveEffectivePluginConfig({
    pluginName: options.target.pluginName,
    manifest: plugin.manifest,
    cwd: options.cwd,
    env: options.env,
  });
  const store = await readPluginConfigStore({
    pluginName: options.target.pluginName,
    scope: options.scope,
    cwd: options.cwd,
    env: options.env,
  });
  const scopedIssues = new Map(
    effective.issues
      .filter((issue) => issue.source === options.scope)
      .map((issue) => [issue.key, issue.message] as const),
  );

  const states: Record<string, ScopedFieldState> = {};
  for (const [key, field] of Object.entries(plugin.manifest.config?.schema ?? {})) {
    const configured = Object.hasOwn(store.values, key);
    let currentValue: PluginConfigValue | undefined;
    if (configured && !field.sensitive) {
      try {
        currentValue = await coercePluginConfigValue({
          key,
          field,
          value: store.values[key],
          projectRoot: effective.projectRoot,
        });
      } catch {
        currentValue = undefined;
      }
    }
    states[key] = {
      configured,
      currentValue,
      issueMessage: scopedIssues.get(key),
    };
  }
  return states;
}

async function promptFullConfigSubmission(
  context: CliExecutionContext,
  target: ResolvedPluginTarget,
  defaultScope: Scope,
): Promise<ConfigSubmission | null> {
  const plugin = target.currentPlugin ?? target.plugin;
  const effective = await resolveEffectivePluginConfig({
    pluginName: target.pluginName,
    manifest: plugin.manifest,
    cwd: context.cwd,
    env: context.env,
  });
  const form = createPluginConfigFormModel({
    pluginName: target.pluginName,
    manifest: plugin.manifest,
    effective,
    initialScope: defaultScope,
    allowedScopes: ['user', 'project'],
  });
  const chosenScope = form.allowedScopes.length > 1
    ? await selectValue(context, {
        message: '选择配置写入位置',
        choices: [
          { value: 'user', label: '个人' },
          { value: 'project', label: '当前项目' },
          { value: 'config-scope-back', label: '返回', role: 'back' },
        ],
        defaultValue: form.initialScope,
      })
    : form.initialScope;
  if (typeof chosenScope !== 'string' && promptCancelled(chosenScope)) {
    return null;
  }
  const scope = typeof chosenScope === 'string'
    ? chosenScope as Scope
    : selectedPromptValue(chosenScope) as Scope;
  const fieldStates = await buildScopedFieldStates({
    target,
    scope,
    cwd: context.cwd,
    env: context.env,
  });
  const updates: Record<string, PluginConfigValue> = {};
  const removeKeys: string[] = [];

  for (const field of form.fields) {
    const state = fieldStates[field.key];
    const needsFix = field.required && (form.requiredKeys.includes(field.key) || Boolean(state.issueMessage));
    if (needsFix) {
      const value = await promptFieldValue(context, effective.projectRoot, field, true);
      if (value === null) {
        return null;
      }
      updates[field.key] = value;
      continue;
    }

    const action = state.configured
      ? await selectValue(context, {
          message: `${field.label}${state.issueMessage ? `（${state.issueMessage}）` : ''}`,
          choices: [
            {
              value: 'keep',
              label: field.sensitive
                ? '保留当前值（已配置）'
                : `保留当前值${state.currentValue === undefined ? '' : `（${String(state.currentValue)}）`}`,
            },
            { value: 'update', label: '更新' },
            ...(!field.required ? [{ value: 'clear', label: '清空' }] : []),
            { value: 'config-field-back', label: '返回', role: 'back' },
          ],
          defaultValue: 'keep',
        })
      : await selectValue(context, {
          message: field.label,
          choices: [
            { value: 'skip', label: '跳过' },
            { value: 'set', label: '设置' },
            { value: 'config-field-back', label: '返回', role: 'back' },
          ],
          defaultValue: 'skip',
        });
    if (promptCancelled(action)) {
      return null;
    }
    const resolvedAction = selectedPromptValue(action);
    if (resolvedAction === 'keep' || resolvedAction === 'skip') {
      continue;
    }
    if (resolvedAction === 'clear') {
      removeKeys.push(field.key);
      continue;
    }

    const value = await promptFieldValue(context, effective.projectRoot, field, field.required);
    if (value === null) {
      return null;
    }
    updates[field.key] = value;
  }

  return {
    scope,
    updates,
    removeKeys,
  };
}

async function promptRequiredConfigSubmission(
  context: CliExecutionContext,
  prompt: ConsoleRequiredConfigPrompt,
): Promise<ConfigSubmission | null> {
  const form = prompt.form;
  const scope = prompt.scope;
  const updates: Record<string, PluginConfigValue> = {};
  for (const field of form.fields.filter((entry) => form.requiredKeys.includes(entry.key))) {
    const value = await promptFieldValue(context, prompt.effective.projectRoot, field, true);
    if (value === null) {
      return null;
    }
    updates[field.key] = value;
  }

  return {
    scope,
    updates,
    removeKeys: [],
  };
}

function hasHomogeneousScopeOptions(
  groupedSelections: Map<PluginConsoleLocation['platform'], ExecutableTargetSelection[]>,
): boolean {
  const signatures = [...groupedSelections.values()].map((entries) =>
    entries
      .map((entry) => entry.location.scope)
      .sort()
      .join(','),
  );
  return signatures.length > 0 && new Set(signatures).size === 1;
}

function uniqueScopesForSelections(selections: ExecutableTargetSelection[]): Scope[] {
  return [...new Set(selections.map((entry) => entry.location.scope))]
    .sort((left, right) => {
      if (left === right) {
        return 0;
      }
      return left === 'user' ? -1 : 1;
    });
}

function commonScopesForPlatforms(
  groupedSelections: Map<PluginConsoleLocation['platform'], ExecutableTargetSelection[]>,
): Scope[] {
  const scopeSets = [...groupedSelections.values()].map((entries) => new Set(uniqueScopesForSelections(entries)));
  if (scopeSets.length === 0) {
    return [];
  }
  return (['user', 'project'] as const).filter((scope) => scopeSets.every((scopeSet) => scopeSet.has(scope)));
}

function buildPlatformChoices(
  platforms: PluginConsoleLocation['platform'][],
  includeAllPlatforms: boolean,
): CliPromptChoice[] {
  return [
    ...platforms.map((platform) => ({
      value: platform,
      label: platformLabel(platform),
      short: platformLabel(platform),
    })),
    ...(includeAllPlatforms
      ? [{
          value: '__all_platforms',
          label: '全部支持平台',
          description: platforms.map((platform) => platformLabel(platform)).join('、'),
          short: '全部支持平台',
        } satisfies CliPromptChoice]
      : []),
    { value: 'install-platform-back', label: '返回', role: 'back' },
    { value: 'install-platform-exit', label: '退出', role: 'exit' },
  ];
}

function buildScopeChoices(scopes: Scope[]): CliPromptChoice[] {
  return [
    ...scopes.map((scope) => ({
      value: scope,
      label: configScopeLabel(scope),
      short: configScopeLabel(scope),
    })),
    { value: 'install-scope-back', label: '返回', role: 'back' },
    { value: 'install-scope-exit', label: '退出', role: 'exit' },
  ];
}

async function selectInstallTargets(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selections: ExecutableTargetSelection[],
): Promise<ExecutableTargetSelection[] | null | 'exit'> {
  const byPlatform = new Map<PluginConsoleLocation['platform'], ExecutableTargetSelection[]>();
  for (const selection of selections) {
    const bucket = byPlatform.get(selection.location.platform) ?? [];
    bucket.push(selection);
    byPlatform.set(selection.location.platform, bucket);
  }

  const platforms = [...byPlatform.keys()].sort();
  while (true) {
    const platformResult = await selectValue(context, {
      message: '选择平台',
      choices: buildPlatformChoices(platforms, platforms.length > 1),
      defaultValue: platforms.length > 1 ? '__all_platforms' : platforms[0],
    });
    if (isPromptAction(platformResult, 'exit')) {
      return 'exit';
    }
    if (promptCancelled(platformResult) || isPromptAction(platformResult, 'back')) {
      return null;
    }

    const selectedPlatform = selectedPromptValue(platformResult);
    if (selectedPlatform === '__all_platforms') {
      const commonScopes = commonScopesForPlatforms(byPlatform);
      if (commonScopes.length === 0) {
        await renderView(context, `${item.summary.title} 安装`, [
          '这些平台没有共同可用的位置，暂时不能一起安装。',
          '请改为选择单个平台，或回到上一步调整目标。',
        ]);
        return null;
      }
      const scopeResult = await selectValue(context, {
        message: '选择位置',
        choices: buildScopeChoices(commonScopes),
        defaultValue: commonScopes[0],
      });
      if (isPromptAction(scopeResult, 'exit')) {
        return 'exit';
      }
      if (promptCancelled(scopeResult)) {
        return null;
      }
      if (isPromptAction(scopeResult, 'back')) {
        continue;
      }
      const selectedScope = selectedPromptValue(scopeResult) as Scope;
      return selections.filter((entry) => entry.location.scope === selectedScope);
    }

    const platformEntries = byPlatform.get(selectedPlatform as PluginConsoleLocation['platform']) ?? [];
    const availableScopes = uniqueScopesForSelections(platformEntries);
    const scopeResult = await selectValue(context, {
      message: '选择位置',
      choices: buildScopeChoices(availableScopes),
      defaultValue: availableScopes[0],
    });
    if (isPromptAction(scopeResult, 'exit')) {
      return 'exit';
    }
    if (promptCancelled(scopeResult)) {
      return null;
    }
    if (isPromptAction(scopeResult, 'back')) {
      continue;
    }
    const selectedScope = selectedPromptValue(scopeResult) as Scope;
    const resolved = platformEntries.filter((entry) => entry.location.scope === selectedScope);
    if (resolved.length === 0) {
      await renderView(context, `${item.summary.title} 安装`, [
        `${platformLabel(selectedPlatform as PluginConsoleLocation['platform'])} 在${configScopeLabel(selectedScope)}已没有可继续的目标。`,
        '请返回平台页重新选择。',
      ]);
      continue;
    }
    return resolved;
  }
}

async function selectTargetsForAllPlatforms(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  featureKind: PluginConsoleFeatureKind,
  selections: ExecutableTargetSelection[],
): Promise<ExecutableTargetSelection[] | null | 'exit'> {
  const byPlatform = new Map<PluginConsoleLocation['platform'], ExecutableTargetSelection[]>();
  for (const selection of selections) {
    const bucket = byPlatform.get(selection.location.platform) ?? [];
    bucket.push(selection);
    byPlatform.set(selection.location.platform, bucket);
  }

  if (hasHomogeneousScopeOptions(byPlatform)) {
    const firstPlatformEntries = [...byPlatform.values()][0] ?? [];
    const scopeValue = await selectValue(context, {
      message: '选择位置',
      choices: [
        ...firstPlatformEntries.map((entry) => ({
          value: entry.location.scope,
          label: configScopeLabel(entry.location.scope),
        })),
        { value: 'target-scope-back', label: '返回', role: 'back' },
        { value: 'target-scope-exit', label: '退出', role: 'exit' },
      ],
      defaultValue: firstPlatformEntries[0]?.location.scope,
    });
    if (isPromptAction(scopeValue, 'exit')) {
      return 'exit';
    }
    if (promptCancelled(scopeValue)) {
      return null;
    }
    if (isPromptAction(scopeValue, 'back')) {
      return null;
    }
    const resolvedScopeValue = selectedPromptValue(scopeValue);
    return selections.filter((entry) => entry.location.scope === resolvedScopeValue);
  }

  const resolved: ExecutableTargetSelection[] = [];
  for (const platform of [...byPlatform.keys()].sort()) {
    const platformEntries = byPlatform.get(platform) ?? [];
    const selectedValue = await selectValue(context, {
      message: `选择 ${platformLabel(platform)} 位置`,
      choices: [
        ...platformEntries.map((entry) => ({
          value: buildTargetChoiceValue(entry.location),
          label: entry.location.locationLabel,
        })),
        { value: '__skip', label: '跳过此平台' },
        { value: 'platform-location-back', label: '返回', role: 'back' },
        { value: 'platform-location-exit', label: '退出', role: 'exit' },
      ],
      defaultValue: buildTargetChoiceValue(platformEntries[0]!.location),
    });
    if (isPromptAction(selectedValue, 'exit')) {
      return 'exit';
    }
    if (promptCancelled(selectedValue)) {
      return null;
    }
    if (isPromptAction(selectedValue, 'back')) {
      return null;
    }
    const resolvedSelectedValue = selectedPromptValue(selectedValue);
    if (resolvedSelectedValue === '__skip') {
      continue;
    }
    const picked = platformEntries.find((entry) => buildTargetChoiceValue(entry.location) === resolvedSelectedValue);
    if (picked) {
      resolved.push(picked);
    }
  }

  if (resolved.length === 0) {
    await renderView(context, `${item.summary.title} · ${featureKind}`, ['本次没有选中任何平台。']);
    return null;
  }
  return resolved;
}

async function selectExecutableTargets(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  featureKind: PluginConsoleFeatureKind,
  enabledActions: PluginConsoleExecutableAction[],
): Promise<ExecutableTargetSelection[] | null | 'exit'> {
  const feature = item.summary.features.find((entry) => entry.kind === featureKind);
  if (feature?.targetSelection === 'none') {
    return [];
  }

  if (enabledActions.length === 1) {
    const action = enabledActions[0]!;
    const location = action.target
      ? findLocation(item, buildTargetChoiceValue(action.target))
      : undefined;
    return location ? [{ action, location }] : null;
  }

  if (featureKind === 'install' || featureKind === 'upgrade') {
    const selections = enabledActions.flatMap((action) => {
      if (!action.target) {
        return [];
      }
      const location = findLocation(item, buildTargetChoiceValue(action.target));
      return location ? [{ action, location }] : [];
    });
    return selectInstallTargets(context, item, selections);
  }

  const targetValue = await selectValue(context, {
    message: '选择目标',
    choices: buildTargetChoices(item, featureKind),
    defaultValue: enabledActions[0]?.target
      ? buildTargetChoiceValue(enabledActions[0].target)
      : undefined,
  });
  if (isPromptAction(targetValue, 'exit')) {
    return 'exit';
  }
  if (promptCancelled(targetValue)) {
    return null;
  }
  const resolvedTargetValue = selectedPromptValue(targetValue);
  if (resolvedTargetValue === '__all_platforms') {
    const selections = enabledActions.flatMap((action) => {
      if (!action.target) {
        return [];
      }
      const location = findLocation(item, buildTargetChoiceValue(action.target));
      return location ? [{ action, location }] : [];
    });
    return selectTargetsForAllPlatforms(context, item, featureKind, selections);
  }

  const action = enabledActions.find((entry) =>
    entry.target && buildTargetChoiceValue(entry.target) === resolvedTargetValue,
  );
  if (!action) {
    return null;
  }
  const location = action.target
    ? findLocation(item, buildTargetChoiceValue(action.target))
    : undefined;
  return location ? [{ action, location }] : null;
}

async function buildConfigPromptForSelection(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selection: ExecutableTargetSelection,
  options: {
    scope?: Scope;
    projectLayer?: 'shared' | 'local';
  } = {},
): Promise<ConsoleRequiredConfigPrompt | null> {
  const scope = options.scope ?? selection.location.scope;
  const projectLayer = options.projectLayer ?? 'shared';
  const targets = await preparePluginTargetsForCommand(
    context.cwd,
    scope,
    [item.summary.pluginName],
    {
      catalogMode: 'readOnly',
      allowHistoricalFallback: true,
      env: context.env,
    },
  );
  const target = targets.targets[0];
  if (!target) {
    throw new Error(`无法加载 ${item.summary.pluginName} 的当前 catalog 信息。`);
  }
  const plugin = target.currentPlugin ?? target.plugin;
  const effective = await resolveEffectivePluginConfig({
    pluginName: target.pluginName,
    manifest: plugin.manifest,
    cwd: context.cwd,
    env: context.env,
  });
  const form = createPluginConfigFormModel({
    pluginName: target.pluginName,
    manifest: plugin.manifest,
    effective,
    initialScope: scope,
    allowedScopes: [scope],
  });
  const formIdentity = await createConsoleConfigFormIdentity({
    plugin,
    form,
    scope,
    projectLayer,
    platform: selection.location.platform,
  });

  return {
    pluginName: target.pluginName,
    scope,
    projectLayer,
    storePath: resolvePluginConfigStorePath({
      pluginName: target.pluginName,
      scope,
      cwd: context.cwd,
      env: context.env,
      ...(scope === 'project' ? { projectLayer } : {}),
    }),
    formIdentity,
    schemaSourceIdentity: createPluginConfigSchemaIdentity(plugin.manifest),
    manifest: plugin.manifest,
    effective,
    form,
    targets: [{
      target,
      platform: selection.location.platform,
      scope,
      ...(selection.location.projectKey ? { projectKey: selection.location.projectKey } : {}),
      requested: true,
    }],
  };
}

function groupConfigPrompts(prompts: ConsoleRequiredConfigPrompt[]): ConsoleRequiredConfigPrompt[] {
  const grouped = new Map<string, ConsoleRequiredConfigPrompt>();
  for (const prompt of prompts) {
    const key = `${prompt.storePath}\0${prompt.formIdentity}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.targets.push(...prompt.targets);
      continue;
    }
    grouped.set(key, prompt);
  }
  return [...grouped.values()];
}

async function promptConfigSubmissionForPrompt(
  context: CliExecutionContext,
  prompt: ConsoleRequiredConfigPrompt,
  requiredOnly: boolean,
): Promise<ConfigSubmission | null> {
  const fieldStates = await buildScopedFieldStates({
    target: prompt.targets[0]!.target,
    scope: prompt.scope,
    cwd: context.cwd,
    env: context.env,
  });
  const updates: Record<string, PluginConfigValue> = {};
  const removeKeys: string[] = [];
  const fields = requiredOnly
    ? prompt.form.fields.filter((entry) => prompt.form.requiredKeys.includes(entry.key))
    : prompt.form.fields;

  for (const field of fields) {
    if (requiredOnly) {
      const value = await promptFieldValue(context, prompt.effective.projectRoot, field, true);
      if (value === null) {
        return null;
      }
      updates[field.key] = value;
      continue;
    }

    const state = fieldStates[field.key];
    const needsFix = field.required && (prompt.form.requiredKeys.includes(field.key) || Boolean(state.issueMessage));
    if (needsFix) {
      const value = await promptFieldValue(context, prompt.effective.projectRoot, field, true);
      if (value === null) {
        return null;
      }
      updates[field.key] = value;
      continue;
    }

    const action = state.configured
      ? await selectValue(context, {
          message: `${field.label}${state.issueMessage ? `（${state.issueMessage}）` : ''}`,
          choices: [
            {
              value: 'keep',
              label: field.sensitive
                ? '保留当前值（已配置）'
                : `保留当前值${state.currentValue === undefined ? '' : `（${String(state.currentValue)}）`}`,
            },
            { value: 'update', label: '更新' },
            ...(!field.required ? [{ value: 'clear', label: '清空' }] : []),
            { value: 'config-write-back', label: '返回', role: 'back' },
          ],
          defaultValue: 'keep',
        })
      : await selectValue(context, {
          message: field.label,
          choices: [
            { value: 'skip', label: '跳过' },
            { value: 'set', label: '设置' },
            { value: 'config-write-back', label: '返回', role: 'back' },
          ],
          defaultValue: 'skip',
        });
    if (promptCancelled(action)) {
      return null;
    }
    const resolvedAction = selectedPromptValue(action);
    if (resolvedAction === 'keep' || resolvedAction === 'skip') {
      continue;
    }
    if (resolvedAction === 'clear') {
      removeKeys.push(field.key);
      continue;
    }

    const value = await promptFieldValue(context, prompt.effective.projectRoot, field, field.required);
    if (value === null) {
      return null;
    }
    updates[field.key] = value;
  }

  return {
    scope: prompt.scope,
    updates,
    removeKeys,
  };
}

async function applyConfigPrompts(
  context: CliExecutionContext,
  prompts: ConsoleRequiredConfigPrompt[],
  requiredOnly: boolean,
): Promise<ConfigWriteOutcome[] | null> {
  const outcomes: ConfigWriteOutcome[] = [];
  for (const prompt of prompts) {
    const submission = requiredOnly
      ? await promptRequiredConfigSubmission(context, prompt)
      : await promptConfigSubmissionForPrompt(context, prompt, false);
    if (!submission) {
      return null;
    }
    const target = prompt.targets[0]!.target;
    const receipt = await applyPluginConfigWrite({
      plugin: target.currentPlugin ?? target.plugin,
      pluginName: prompt.pluginName,
      scope: submission.scope,
      projectLayer: prompt.projectLayer,
      cwd: context.cwd,
      env: context.env,
      applyTargets: prompt.targets.map((entry) => ({
        pluginName: prompt.pluginName,
        platform: entry.platform,
        scope: entry.scope,
        ...(entry.projectKey ? { projectKey: entry.projectKey } : {}),
      })),
      request: {
        updates: submission.updates,
        removeKeys: submission.removeKeys,
      },
    });
    outcomes.push({
      prompt,
      scope: submission.scope,
      updatedKeys: receipt.updatedKeys,
      removedKeys: receipt.removedKeys,
      artifactRefreshStatus: receipt.artifactRefresh.status,
      ...(receipt.artifactRefresh.error ? { artifactRefreshError: receipt.artifactRefresh.error } : {}),
    });
  }
  return outcomes;
}

function configTargetStoreLabel(scope: Scope, projectLayer: 'shared' | 'local'): string {
  if (scope === 'user') {
    return '个人配置';
  }
  return projectLayer === 'local' ? '当前项目本地配置' : '当前项目配置';
}

function configSchemaSourceLabel(source: NonNullable<PluginConsoleConfigProjection['schema']>['source']): string {
  return source === 'installedHistorical' ? 'installedHistorical' : 'currentCatalog';
}

function configWriteBlockedReason(
  projection: PluginConsoleConfigProjection | undefined,
): string | undefined {
  switch (projection?.state) {
    case 'catalogUnavailable':
      return projection.issueMessage ?? '当前需要 current catalog schema，但 current catalog 不可用。';
    case 'configSchemaUnavailable':
      return projection.issueMessage ?? '当前没有可用 schema，无法解释或写入字段。';
    case 'configSchemaConflict':
      return projection.issueMessage ?? '同一配置 store 被多个已安装位置消费，但 schema identity 不一致。';
    default:
      return undefined;
  }
}

function configFieldValueStateLabel(field: ConfigFieldEntryV2): string {
  switch (field.valueState) {
    case 'configured':
      return field.effectiveValue === '[redacted]'
        ? '已配置（已脱敏）'
        : field.effectiveValue === null
          ? '已配置'
          : `当前值：${String(field.effectiveValue)}`;
    case 'default':
      return field.effectiveValue === null
        ? '未配置'
        : `默认值：${String(field.effectiveValue)}`;
    case 'invalid':
      return '当前值无效';
  }
}

function configFieldSourceLabel(field: ConfigFieldEntryV2): string | undefined {
  switch (field.sourceLayer) {
    case 'default':
      return '来源：默认值';
    case 'user':
      return '来源：个人';
    case 'project':
      return '来源：项目';
    case 'local':
      return '来源：本地';
    default:
      return undefined;
  }
}

function configViewKey(target: ConsoleConfigViewTarget): string {
  return `${target.scope}:${target.projectLayer}`;
}

function configTargetKey(target: ConsoleConfigTarget): string {
  switch (target.kind) {
    case 'location':
      return `location:${buildTargetChoiceValue(target.location)}`;
    case 'preconfigure':
      return `preconfigure:${target.scope}`;
    case 'store':
      return `store:${target.scope}:${target.projectLayer}`;
  }
}

function configTargetLocations(target: ConsoleConfigTarget): PluginConsoleLocation[] {
  switch (target.kind) {
    case 'location':
      return target.consumerLocations;
    case 'preconfigure':
      return target.consumerLocations;
    case 'store':
      return target.consumerLocations;
  }
}

function configTargetScope(target: ConsoleConfigTarget): Scope {
  switch (target.kind) {
    case 'location':
      return target.location.scope;
    case 'preconfigure':
      return target.scope;
    case 'store':
      return target.scope;
  }
}

function configTargetProjection(target: ConsoleConfigTarget): PluginConsoleConfigProjection | undefined {
  return target.projection;
}

function configTargetViewOptions(target: ConsoleConfigTarget): ConsoleConfigViewTarget[] {
  if (target.kind === 'store') {
    const projection = configTargetProjection(target);
    const effectiveView = projection?.views.find((view) => view.scope === 'effective');
    return [
      ...(effectiveView && effectiveView.fields.length > 0
        ? [{
            scope: 'effective',
            projectLayer: 'shared',
            label: '生效',
          } satisfies ConsoleConfigViewTarget]
        : []),
      {
        scope: target.scope,
        projectLayer: target.projectLayer,
        label: target.projectLayer === 'local' ? '本地' : target.scope === 'user' ? '个人' : '项目',
      },
    ];
  }

  const scope = configTargetScope(target);
  if (scope === 'user') {
    return [
      { scope: 'effective', projectLayer: 'shared', label: '生效' },
      { scope: 'user', projectLayer: 'shared', label: '个人' },
    ];
  }

  return [
    { scope: 'effective', projectLayer: 'shared', label: '生效' },
    { scope: 'user', projectLayer: 'shared', label: '个人' },
    { scope: 'project', projectLayer: 'shared', label: '项目' },
    { scope: 'project', projectLayer: 'local', label: '本地' },
  ];
}

function findConfigView(
  projection: PluginConsoleConfigProjection | undefined,
  target: ConsoleConfigViewTarget,
): PluginConsoleConfigProjection['views'][number] | null {
  if (!projection) {
    return null;
  }
  return projection.views.find((view) =>
    view.scope === target.scope &&
    view.projectLayer === target.projectLayer,
  ) ?? null;
}

function targetMatchesLayer(
  target: ConsoleConfigViewTarget,
  fieldLayer: ConfigFieldEntryV2['sourceLayer'] | ConfigFieldEntryV2['storedSourceLayer'] | undefined,
): boolean {
  if (target.scope === 'effective') {
    return false;
  }
  if (fieldLayer === 'user') {
    return target.scope === 'user';
  }
  if (fieldLayer === 'project') {
    return target.scope === 'project' && target.projectLayer === 'shared';
  }
  if (fieldLayer === 'local') {
    return target.scope === 'project' && target.projectLayer === 'local';
  }
  return false;
}

function canUpdateConfigField(
  target: ConsoleConfigViewTarget,
  field: ConfigFieldEntryV2,
): boolean {
  if (target.scope === 'effective') {
    return false;
  }
  return field.writable;
}

function canClearConfigField(
  target: ConsoleConfigViewTarget,
  field: ConfigFieldEntryV2,
): boolean {
  if (target.scope === 'effective') {
    return false;
  }
  return targetMatchesLayer(target, field.sourceLayer);
}

function hasStoreOnlyView(
  view: PluginConsoleConfigProjection['views'][number] | null,
): boolean {
  return view?.fields.length === 0 && (view.legacyConfigStores.length ?? 0) > 0;
}

function renderConfigViewLines(options: {
  item: ConsoleControllerItem;
  target: ConsoleConfigTarget;
  viewTarget: ConsoleConfigViewTarget;
  view: PluginConsoleConfigProjection['views'][number] | null;
  recentResult?: ConsoleRecentResult;
}): string[] {
  const { item, target, viewTarget, view, recentResult } = options;
  const projection = target.projection ?? item.summary.config;
  const locations = configTargetLocations(target);
  const installedLocations = locations.filter((location) => location.status !== 'notInstalled');

  return joinNonEmpty([
    `插件：${item.summary.title}`,
    `目标：${target.label}`,
    `作用层：${viewTarget.label}`,
    installedLocations.length > 0
      ? `可应用位置：${installedLocations.map((location) => location.locationLabel).join('、')}`
      : undefined,
    ...(recentResult ? ['', ...renderRecentResultLines(item, recentResult)] : []),
    ...(projection?.issueMessage
      ? [
          '',
          `当前状态：${projection.issueMessage}`,
          ...(projection.issueDetails ?? []).map((detail) => `- ${detail}`),
          ...(projection.state === 'configSchemaConflict'
            ? ['- 先把相关安装位置对齐到同一 schema，或直接执行整层 reset 清理 store。']
            : projection.state === 'catalogUnavailable'
              ? ['- 恢复 current catalog 后，才能继续使用 schema-aware 写入或预置。']
              : []),
        ]
      : []),
    '',
    ...(view === null
      ? ['当前层没有可展示的字段。']
      : hasStoreOnlyView(view)
        ? [
            '当前层存在 store-only 旧配置，只能整层清理。',
            ...view.legacyConfigStores.map((entry) =>
              `- ${configTargetStoreLabel(
                entry.storeKind === 'user' ? 'user' : 'project',
                entry.storeKind === 'projectLocal' ? 'local' : 'shared',
              )} · ${entry.reason === 'pluginRemoved' ? '插件已退场' : '当前 schema 已无法解释这些值'}`),
          ]
          : [
            ...(view.fields.length > 0
              ? view.fields.map((field) => joinNonEmpty([
                  `- ${field.title} · ${configFieldValueStateLabel(field)}`,
                  configFieldSourceLabel(field),
                ]).join(' · '))
              : ['当前层没有可展示的字段。']),
            ...(view.legacyConfigStores.length > 0
              ? [
                  '',
                  '附加残留：',
                  ...view.legacyConfigStores.map((entry) =>
                    `- ${configTargetStoreLabel(
                      entry.storeKind === 'user' ? 'user' : 'project',
                      entry.storeKind === 'projectLocal' ? 'local' : 'shared',
                    )} · 只能整层清理`),
                ]
              : []),
          ]),
  ]);
}

async function loadConfigTargetPlugin(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  target: ConsoleConfigTarget,
): Promise<PluginMeta | null> {
  if (target.kind === 'store' && target.plugin !== undefined) {
    return target.plugin;
  }
  if (target.kind === 'preconfigure') {
    return target.plugin;
  }

  const prepared = await preparePluginTargetsForCommand(
    context.cwd,
    configTargetScope(target),
    [item.summary.pluginName],
    {
      catalogMode: 'readOnly',
      allowHistoricalFallback: true,
      env: context.env,
    },
  );
  const resolved = prepared.targets[0];
  return resolved ? (resolved.currentPlugin ?? resolved.plugin) : null;
}

async function ensureConfigProjection(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  target: ConsoleConfigTarget,
): Promise<PluginConsoleConfigProjection | undefined> {
  if (target.projection) {
    return target.projection;
  }
  if (item.summary.config) {
    target.projection = item.summary.config;
    return target.projection;
  }

  const plugin = await loadConfigTargetPlugin(context, item, target);
  if (!plugin) {
    return undefined;
  }
  const views = (await Promise.all([
    resolveConfigReadV2({
      pluginName: item.summary.pluginName,
      plugin,
      scope: 'effective',
      projectLayer: 'shared',
      cwd: context.cwd,
      env: context.env,
    }),
    resolveConfigReadV2({
      pluginName: item.summary.pluginName,
      plugin,
      scope: 'user',
      projectLayer: 'shared',
      cwd: context.cwd,
      env: context.env,
    }),
    resolveConfigReadV2({
      pluginName: item.summary.pluginName,
      plugin,
      scope: 'project',
      projectLayer: 'shared',
      cwd: context.cwd,
      env: context.env,
    }),
    resolveConfigReadV2({
      pluginName: item.summary.pluginName,
      plugin,
      scope: 'project',
      projectLayer: 'local',
      cwd: context.cwd,
      env: context.env,
    }),
  ])).map((result) => ({
    scope: result.scope,
    projectLayer: result.projectLayer,
    fields: result.fields,
    legacyConfigStores: result.legacyConfigStores,
  })).filter((view) => view.fields.length > 0 || view.legacyConfigStores.length > 0);

  if (views.length === 0) {
    return undefined;
  }

  target.projection = {
    configSchemaVersion: 2,
    views,
  };
  return target.projection;
}

function resolveConfigTargets(item: ConsoleControllerItem): ConsoleConfigTarget[] {
  const projection = item.summary.config;
  const locationTargets = item.locations
    .filter((location) => location.actions.some((action) => action.kind === 'openConfigWizard'))
    .map((location) => ({
      kind: 'location' as const,
      label: location.locationLabel,
      location,
      consumerLocations: item.locations.filter((candidate) =>
        candidate.scope === location.scope &&
        (candidate.projectKey ?? null) === (location.projectKey ?? null)),
      projection,
    }));
  if (locationTargets.length > 0) {
    return locationTargets;
  }

  if (!projection) {
    return [];
  }

  const targets: ConsoleConfigTarget[] = [];
  for (const view of projection.views) {
    if (view.scope === 'effective') {
      continue;
    }
    if (view.fields.length === 0 && view.legacyConfigStores.length === 0) {
      continue;
    }
    const label = configTargetStoreLabel(view.scope, view.projectLayer);
    targets.push({
      kind: 'store',
      label,
      scope: view.scope,
      projectLayer: view.projectLayer,
      projection,
      legacyStore: view.legacyConfigStores[0],
      consumerLocations: item.locations.filter((location) =>
        view.scope === 'user'
          ? location.scope === 'user'
          : location.scope === 'project'),
    });
  }
  return targets;
}

async function chooseConfigTarget(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
): Promise<ConsoleConfigTarget | 'exit' | null> {
  const targets = resolveConfigTargets(item);
  if (targets.length === 0) {
    await renderView(context, `${item.summary.title} 配置`, ['当前没有可管理的配置目标。']);
    return null;
  }
  if (targets.length === 1) {
    return targets[0]!;
  }

  await renderView(context, `${item.summary.title} 配置目标`, [
    '这个插件存在多个可配置目标，请先明确要进入的位置。',
  ]);
  const selection = await selectValue(context, {
    message: '选择配置目标',
    choices: [
      ...targets.map((target) => ({
        value: configTargetKey(target),
        label: target.label,
      })),
      { value: 'config-target-back', label: '返回', role: 'back' },
      { value: 'config-target-exit', label: '退出', role: 'exit' },
    ],
    defaultValue: configTargetKey(targets[0]!),
  });
  if (isPromptAction(selection, 'exit')) {
    return 'exit';
  }
  if (isPromptAction(selection, 'back') || isPromptAction(selection, 'cancel')) {
    return null;
  }
  return targets.find((target) => configTargetKey(target) === selectedPromptValue(selection)) ?? null;
}

async function chooseConfigView(
  context: CliExecutionContext,
  target: ConsoleConfigTarget,
  current: ConsoleConfigViewTarget,
): Promise<ConsoleConfigViewTarget | 'exit' | null> {
  const views = configTargetViewOptions(target);
  const selection = await selectValue(context, {
    message: '切换作用层',
    choices: [
      ...views.map((view) => ({
        value: configViewKey(view),
        label: view.label,
      })),
      { value: 'config-view-back', label: '返回', role: 'back' },
      { value: 'config-view-exit', label: '退出', role: 'exit' },
    ],
    defaultValue: configViewKey(current),
  });
  if (isPromptAction(selection, 'exit')) {
    return 'exit';
  }
  if (isPromptAction(selection, 'back') || isPromptAction(selection, 'cancel')) {
    return null;
  }
  return views.find((view) => configViewKey(view) === selectedPromptValue(selection)) ?? current;
}

function configResultRecentResult(label: string, targetResults: ReceiptTargetResult[], summaryLines: string[] = []): ConsoleRecentResult {
  return {
    label,
    targetResults: dedupeTargetResults(targetResults),
    ...(summaryLines.length > 0 ? { summaryLines } : {}),
  };
}

function buildConfigApplyLocations(
  target: ConsoleConfigTarget,
  viewTarget: ConsoleConfigViewTarget,
): PluginConsoleLocation[] {
  const sourceLocations = configTargetLocations(target).filter((location) => location.status !== 'notInstalled');
  if (sourceLocations.length === 0) {
    return [];
  }
  if (viewTarget.scope === 'user') {
    return sourceLocations.filter((location) => location.scope === 'user');
  }
  if (viewTarget.scope === 'project') {
    return sourceLocations.filter((location) => location.scope === 'project');
  }
  return sourceLocations;
}

function configGroupLabel(group: ConsoleConfigWriteGroup, storeLabel: string): string {
  if (group.locations.length === 0) {
    return storeLabel;
  }
  return `${storeLabel} · ${group.locations.map((location) => location.locationLabel).join('、')}`;
}

async function buildConfigWriteGroups(options: {
  context: CliExecutionContext;
  item: ConsoleControllerItem;
  target: ConsoleConfigTarget;
  viewTarget: ConsoleConfigViewTarget;
}): Promise<ConsoleConfigWriteGroup[]> {
  const storePath = resolvePluginConfigStorePath({
    pluginName: options.item.summary.pluginName,
    scope: options.viewTarget.scope as Scope,
    cwd: options.context.cwd,
    env: options.context.env,
    ...(options.viewTarget.scope === 'project' ? { projectLayer: options.viewTarget.projectLayer } : {}),
  });
  const storeLabel = configTargetStoreLabel(
    options.viewTarget.scope as Scope,
    options.viewTarget.projectLayer,
  );
  const locations = buildConfigApplyLocations(options.target, options.viewTarget);
  const plugin = await loadConfigTargetPlugin(options.context, options.item, options.target);

  if (!plugin || locations.length === 0) {
    return [{
      storePath,
      scope: options.viewTarget.scope as Scope,
      projectLayer: options.viewTarget.projectLayer,
      formIdentity: `${options.item.summary.pluginName}\0store-only`,
      label: storeLabel,
      locations,
      applyTargets: locations.map((location) => ({
        pluginName: options.item.summary.pluginName,
        platform: location.platform,
        scope: location.scope,
        ...(location.projectKey ? { projectKey: location.projectKey } : {}),
      })),
    }];
  }

  const effective = await resolveEffectivePluginConfig({
    pluginName: plugin.manifest.name,
    manifest: plugin.manifest,
    cwd: options.context.cwd,
    env: options.context.env,
  });
  const groups = new Map<string, ConsoleConfigWriteGroup>();
  for (const location of locations) {
    const form = plugin.manifest.config?.schema
      ? createPluginConfigFormModel({
          pluginName: plugin.manifest.name,
          manifest: plugin.manifest,
          effective,
          initialScope: options.viewTarget.scope as Scope,
          allowedScopes: [options.viewTarget.scope as Scope],
        })
      : {
          pluginName: plugin.manifest.name,
          initialScope: options.viewTarget.scope as Scope,
          allowedScopes: [options.viewTarget.scope as Scope],
          requiredKeys: [],
          fields: [],
        };
    const formIdentity = await createConsoleConfigFormIdentity({
      plugin,
      form,
      scope: options.viewTarget.scope as Scope,
      projectLayer: options.viewTarget.projectLayer,
      platform: location.platform,
    });
    const key = `${storePath}\0${formIdentity}`;
    const existing = groups.get(key);
    const applyTarget = {
      pluginName: options.item.summary.pluginName,
      platform: location.platform,
      scope: location.scope,
      ...(location.projectKey ? { projectKey: location.projectKey } : {}),
    } satisfies ReceiptTargetResult['target'];
    if (existing) {
      existing.locations.push(location);
      existing.applyTargets.push(applyTarget);
      continue;
    }
    groups.set(key, {
      storePath,
      scope: options.viewTarget.scope as Scope,
      projectLayer: options.viewTarget.projectLayer,
      formIdentity,
      label: '',
      locations: [location],
      applyTargets: [applyTarget],
    });
  }

  const resolvedGroups = [...groups.values()].map((group) => ({
    ...group,
    label: configGroupLabel(group, storeLabel),
  }));
  return resolvedGroups.length > 0 ? resolvedGroups : [{
    storePath,
    scope: options.viewTarget.scope as Scope,
    projectLayer: options.viewTarget.projectLayer,
    formIdentity: `${options.item.summary.pluginName}\0empty`,
    label: storeLabel,
    locations: [],
    applyTargets: [],
  }];
}

function groupResultLines(
  group: ConsoleConfigWriteGroup,
  lines: string[],
): string[] {
  return [
    group.label,
    ...indentLines(lines),
  ];
}

async function confirmConfigWrite(
  context: CliExecutionContext,
  title: string,
  lines: string[],
  confirmLabel: string,
): Promise<'confirm' | 'back' | 'exit'> {
  await renderView(context, title, lines);
  const selection = await selectValue(context, {
    message: '确认操作',
    choices: [
      { value: 'cancel', label: '取消（推荐）' },
      { value: 'confirm', label: confirmLabel },
      { value: 'confirm-back', label: '返回', role: 'back' },
      { value: 'confirm-exit', label: '退出', role: 'exit' },
    ],
    defaultValue: 'cancel',
  });
  if (isPromptAction(selection, 'exit')) {
    return 'exit';
  }
  if (isPromptAction(selection, 'back') || isPromptAction(selection, 'cancel')) {
    return 'back';
  }
  return selectedPromptValue(selection) === 'confirm' ? 'confirm' : 'back';
}

async function promptConfigFieldWriteValue(options: {
  context: CliExecutionContext;
  plugin: PluginMeta;
  field: ConfigFieldEntryV2;
  required: boolean;
}): Promise<PluginConfigValue | null> {
  const schemaField = options.plugin.manifest.config?.schema?.[options.field.key];
  if (!schemaField) {
    throw new Error(`Unknown config key "${options.field.key}".`);
  }
  const effective = await resolveEffectivePluginConfig({
    pluginName: options.plugin.manifest.name,
    manifest: options.plugin.manifest,
    cwd: options.context.cwd,
    env: options.context.env,
  });
  return promptFieldValue(options.context, effective.projectRoot, {
    key: options.field.key,
    type: schemaField.type,
    label: schemaField.title ?? options.field.key,
    description: schemaField.description,
    required: schemaField.required === true,
    sensitive: schemaField.sensitive === true,
    defaultValue: schemaField.default as PluginConfigValue | undefined,
    enumValues: schemaField.type === 'enum' ? schemaField.values : undefined,
    min: schemaField.min,
    max: schemaField.max,
    configured: options.field.valueState === 'configured',
    currentValue: undefined,
  }, options.required);
}

async function runConfigFieldWriteAction(options: {
  context: CliExecutionContext;
  item: ConsoleControllerItem;
  target: ConsoleConfigTarget;
  viewTarget: ConsoleConfigViewTarget;
  field: ConfigFieldEntryV2;
  mode: 'set' | 'unset';
}): Promise<ConsoleActionResolution> {
  const plugin = await loadConfigTargetPlugin(options.context, options.item, options.target);
  if (!plugin && options.mode === 'set') {
    throw new Error(`无法加载 ${options.item.summary.pluginName} 的当前配置 schema。`);
  }
  const groups = await buildConfigWriteGroups({
    context: options.context,
    item: options.item,
    target: options.target,
    viewTarget: options.viewTarget,
  });
  const resultSections: string[] = [];
  const recentTargetResults: ReceiptTargetResult[] = [];
  const summaryLines: string[] = [];
  const focusLocations = groups.flatMap((group) => group.locations);

  for (const group of groups) {
    let value: PluginConfigValue | null = null;
    if (options.mode === 'set') {
      value = await promptConfigFieldWriteValue({
        context: options.context,
        plugin: plugin!,
        field: options.field,
        required: true,
      });
      if (value === null) {
        return { navigation: recentTargetResults.length > 0 ? 'reload' : 'back' };
      }
    }

    const confirm = await confirmConfigWrite(
      options.context,
      `${options.item.summary.title} 配置确认`,
      [
        `目标：${options.target.label}`,
        `作用层：${options.viewTarget.label}`,
        `写入组：${group.label}`,
        `字段：${options.field.title}`,
        `操作：${options.mode === 'set' ? '更新' : '清空'}`,
      ],
      options.mode === 'set' ? '确认保存' : '确认清空',
    );
    if (confirm === 'exit') {
      return { navigation: 'exit' };
    }
    if (confirm !== 'confirm') {
      return { navigation: recentTargetResults.length > 0 ? 'reload' : 'back' };
    }

    try {
      const receipt = await applyPluginConfigWrite({
        plugin: plugin!,
        pluginName: options.item.summary.pluginName,
        scope: options.viewTarget.scope as Scope,
        projectLayer: options.viewTarget.projectLayer,
        cwd: options.context.cwd,
        env: options.context.env,
        nativeCliRunner: options.context.nativeCliRunner,
        applyTargets: group.applyTargets,
        request: options.mode === 'set'
          ? {
              updates: {
                [options.field.key]: value,
              },
            }
          : {
              removeKeys: [options.field.key],
            },
      });
      resultSections.push(...groupResultLines(group, [
        options.mode === 'set'
          ? `已更新 ${options.field.title}。`
          : `已清空 ${options.field.title}。`,
        artifactRefreshLine(receipt.artifactRefresh.status),
      ]), '');
      recentTargetResults.push(...receipt.targetResults);
      if (receipt.targetResults.length === 0) {
        summaryLines.push(`- ${group.label} · ${artifactRefreshLine(receipt.artifactRefresh.status)}`);
      }
    } catch (error) {
      const message = formatErrorMessage(error);
      resultSections.push(...groupResultLines(group, [`写入失败：${message}`]), '');
      recentTargetResults.push(...group.applyTargets.map((target) => ({
        target,
        action: 'configApply',
        state: 'failed' as const,
        message,
      })));
    }
  }

  return {
    navigation: 'stay',
    item: await reloadConsoleItem(options.context, options.item.summary.pluginName, options.item),
    recentResult: configResultRecentResult('配置', recentTargetResults, summaryLines),
  };
}

async function runConfigResetAction(options: {
  context: CliExecutionContext;
  item: ConsoleControllerItem;
  target: ConsoleConfigTarget;
  viewTarget: ConsoleConfigViewTarget;
}): Promise<ConsoleActionResolution> {
  const plugin = await loadConfigTargetPlugin(options.context, options.item, options.target) ?? undefined;
  const groups = await buildConfigWriteGroups({
    context: options.context,
    item: options.item,
    target: options.target,
    viewTarget: options.viewTarget,
  });
  const resultSections: string[] = [];
  const recentTargetResults: ReceiptTargetResult[] = [];
  const summaryLines: string[] = [];
  const orphanStoreOnly = groups.every((group) => group.locations.length === 0);

  for (const group of groups) {
    const confirm = await confirmConfigWrite(
      options.context,
      `${options.item.summary.title} 配置重置`,
      [
        `目标：${options.target.label}`,
        `作用层：${options.viewTarget.label}`,
        `写入组：${group.label}`,
        '这会删除当前配置层的整层 store。',
      ],
      '确认删除配置',
    );
    if (confirm === 'exit') {
      return { navigation: 'exit' };
    }
    if (confirm !== 'confirm') {
      return {
        navigation: 'stay',
        item: await reloadConsoleItem(options.context, options.item.summary.pluginName, options.item),
        notice: '已取消，本次没有写入任何状态。',
      };
    }

    try {
      const receipt = await resetPluginConfigWithHelper({
        pluginName: options.item.summary.pluginName,
        plugin,
        scope: options.viewTarget.scope as Scope,
        projectLayer: options.viewTarget.projectLayer,
        cwd: options.context.cwd,
        env: options.context.env,
        nativeCliRunner: options.context.nativeCliRunner,
        applyTargets: group.applyTargets,
      });
      resultSections.push(...groupResultLines(group, [
        receipt.deleted
          ? orphanStoreOnly ? '已按孤立残留 store 删除这一层配置。' : '已删除这一层配置。'
          : '这一层配置原本不存在。',
        `removedKeys：${receipt.removedKeys.length > 0 ? receipt.removedKeys.join('，') : '无'}`,
        ...(!orphanStoreOnly
          ? [
              artifactRefreshLine(receipt.artifactRefresh.status),
              ...(receipt.artifactRefresh.artifacts.length > 0
                ? receipt.artifactRefresh.artifacts.map((artifact) =>
                    `dynamic artifact：${artifact.id} · ${artifact.scope} · ${artifact.status === 'succeeded' ? '已刷新' : '刷新失败'}`)
                : []),
            ]
          : []),
      ]), '');
      recentTargetResults.push(...receipt.targetResults);
      if (receipt.targetResults.length === 0) {
        summaryLines.push(
          orphanStoreOnly
            ? `- ${group.label} · 已按孤立残留 store 删除`
            : `- ${group.label} · ${artifactRefreshLine(receipt.artifactRefresh.status)}`,
        );
      }
    } catch (error) {
      const message = formatErrorMessage(error);
      resultSections.push(...groupResultLines(group, [`删除失败：${message}`]), '');
      recentTargetResults.push(...group.applyTargets.map((target) => ({
        target,
        action: 'configApply',
        state: 'failed' as const,
        message,
      })));
    }
  }

  return {
    navigation: 'stay',
    item: await reloadConsoleItem(options.context, options.item.summary.pluginName, options.item),
    recentResult: configResultRecentResult('配置', recentTargetResults, summaryLines),
  };
}

async function runConfigReapplyAction(options: {
  context: CliExecutionContext;
  item: ConsoleControllerItem;
  target: ConsoleConfigTarget;
  viewTarget: ConsoleConfigViewTarget;
  title: string;
}): Promise<ConsoleActionResolution> {
  const plugin = await loadConfigTargetPlugin(options.context, options.item, options.target);
  if (!plugin) {
    return {
      navigation: 'stay',
      item: await reloadConsoleItem(options.context, options.item.summary.pluginName, options.item),
      recentResult: configResultRecentResult(options.title, [], ['- 当前没有可重放的 runtime 写入。']),
    };
  }
  const groups = await buildConfigWriteGroups({
    context: options.context,
    item: options.item,
    target: options.target,
    viewTarget: options.viewTarget,
  });
  const lines: string[] = [];
  const targetResults: ReceiptTargetResult[] = [];
  const summaryLines: string[] = [];

  for (const group of groups) {
    const replay = await replayConfigRuntimeWrites({
      plugin,
      scope: configTargetScope(options.target),
      cwd: options.context.cwd,
      env: options.context.env,
      nativeCliRunner: options.context.nativeCliRunner,
      applyTargets: group.applyTargets,
      includeDynamicArtifacts: true,
    });
    lines.push(...groupResultLines(group, replay.targetResults.length > 0
      ? [
          replay.artifactRefresh.status === 'failed'
            ? '重新应用配置失败。你可以进入状态页查看原因。'
            : replay.artifactRefresh.status === 'skipped'
              ? '已按当前 effective 配置重放可应用的 runtime 写入。'
              : '已按当前 effective 配置重新应用 runtime 写入。',
        ]
      : ['当前没有可重放的 runtime 写入。']), '');
    targetResults.push(...replay.targetResults);
    if (replay.targetResults.length === 0) {
      summaryLines.push(`- ${group.label} · 当前没有可重放的 runtime 写入。`);
    }
  }
  return {
    navigation: 'stay',
    item: await reloadConsoleItem(options.context, options.item.summary.pluginName, options.item),
    recentResult: configResultRecentResult(options.title, targetResults, summaryLines),
  };
}

async function runConfigWizardAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  recentResult?: ConsoleRecentResult,
): Promise<ConsoleActionResolution> {
  const target = await chooseConfigTarget(context, item);
  if (target === 'exit') {
    return { navigation: 'exit' };
  }
  if (!target) {
    return { navigation: 'back' };
  }

  const viewOptions = configTargetViewOptions(target);
  let currentView = (() => {
    if (target.kind === 'store') {
      return viewOptions.find((view) =>
        view.scope === target.scope && view.projectLayer === target.projectLayer) ?? viewOptions[0]!;
    }
    if (target.kind === 'location' && target.location.status === 'notInstalled') {
      return target.location.scope === 'user'
        ? (viewOptions.find((view) => view.scope === 'user') ?? viewOptions[0]!)
        : (viewOptions.find((view) => view.scope === 'project' && view.projectLayer === 'shared') ?? viewOptions[0]!);
    }
    return viewOptions[0]!;
  })();

  while (true) {
    const projection = await ensureConfigProjection(context, item, target);
    const view = findConfigView(projection, currentView);
    const writeBlockedReason = configWriteBlockedReason(projection);
    const updatableFields = (view?.fields ?? []).filter((field) => canUpdateConfigField(currentView, field));
    const clearableFields = (view?.fields ?? []).filter((field) => canClearConfigField(currentView, field));
    const applicableLocations = buildConfigApplyLocations(target, currentView);
    const pluginAvailable = await loadConfigTargetPlugin(context, item, target);

    await renderView(
      context,
      `${item.summary.title} 配置`,
      renderConfigViewLines({
        item,
        target,
        viewTarget: currentView,
        view,
        recentResult,
      }),
    );
    const selection = await selectValue(context, {
      message: '配置操作',
      choices: [
        ...(viewOptions.length > 1
          ? [{ value: 'switch-view', label: '切换作用层' }]
          : []),
        ...(writeBlockedReason === undefined && updatableFields.length > 0
          ? [{ value: 'update-field', label: '更新字段' }]
          : []),
        ...(writeBlockedReason === undefined && clearableFields.length > 0
          ? [{ value: 'clear-field', label: '清空字段' }]
          : []),
        ...(currentView.scope !== 'effective' && (view !== null || projection !== undefined)
          ? [{
              value: 'reset-layer',
              label: hasStoreOnlyView(view) ? '删除配置' : '重置当前层',
            }]
          : []),
        ...(currentView.scope !== 'effective' && pluginAvailable && writeBlockedReason === undefined
          ? [{
              value: 'apply-config',
              label: '应用',
              description: applicableLocations.length > 0 ? '按当前 effective 配置重放 runtime 写入。' : '当前没有可定位 runtime target，可能会是 no-op。',
            }, {
              value: 'reapply-config',
              label: '重新应用配置',
              description: applicableLocations.length > 0 ? '重新执行可重放的 runtime 写入。' : '当前没有可定位 runtime target，可能会是 no-op。',
            }]
          : []),
        { value: 'config-back', label: '返回', role: 'back' },
        { value: 'config-exit', label: '退出', role: 'exit' },
      ],
      defaultValue: viewOptions.length > 1 ? 'switch-view' : updatableFields[0] ? 'update-field' : 'config-back',
    });
    if (isPromptAction(selection, 'exit')) {
      return { navigation: 'exit' };
    }
    if (isPromptAction(selection, 'back') || isPromptAction(selection, 'cancel')) {
      return { navigation: 'back' };
    }

    switch (selectedPromptValue(selection)) {
      case 'switch-view': {
        const nextView = await chooseConfigView(context, target, currentView);
        if (nextView === 'exit') {
          return { navigation: 'exit' };
        }
        if (nextView) {
          currentView = nextView;
        }
        continue;
      }
      case 'update-field': {
        const fieldSelection = await selectValue(context, {
          message: '选择字段',
          choices: [
            ...updatableFields.map((field) => ({
              value: field.key,
              label: field.title,
              description: configFieldValueStateLabel(field),
            })),
            { value: 'field-back', label: '返回', role: 'back' },
          ],
          defaultValue: updatableFields[0]?.key,
        });
        if (isPromptAction(fieldSelection, 'back') || isPromptAction(fieldSelection, 'cancel')) {
          continue;
        }
        if (isPromptAction(fieldSelection, 'exit')) {
          return { navigation: 'exit' };
        }
        const field = updatableFields.find((entry) => entry.key === selectedPromptValue(fieldSelection));
        if (!field) {
          continue;
        }
        return runConfigFieldWriteAction({
          context,
          item,
          target,
          viewTarget: currentView,
          field,
          mode: 'set',
        });
      }
      case 'clear-field': {
        const fieldSelection = await selectValue(context, {
          message: '选择字段',
          choices: [
            ...clearableFields.map((field) => ({
              value: field.key,
              label: field.title,
              description: configFieldValueStateLabel(field),
            })),
            { value: 'field-back', label: '返回', role: 'back' },
          ],
          defaultValue: clearableFields[0]?.key,
        });
        if (isPromptAction(fieldSelection, 'back') || isPromptAction(fieldSelection, 'cancel')) {
          continue;
        }
        if (isPromptAction(fieldSelection, 'exit')) {
          return { navigation: 'exit' };
        }
        const field = clearableFields.find((entry) => entry.key === selectedPromptValue(fieldSelection));
        if (!field) {
          continue;
        }
        return runConfigFieldWriteAction({
          context,
          item,
          target,
          viewTarget: currentView,
          field,
          mode: 'unset',
        });
      }
      case 'reset-layer':
        return runConfigResetAction({
          context,
          item,
          target,
          viewTarget: currentView,
        });
      case 'apply-config':
        return runConfigReapplyAction({
          context,
          item,
          target,
          viewTarget: currentView,
          title: '应用配置',
        });
      case 'reapply-config':
        return runConfigReapplyAction({
          context,
          item,
          target,
          viewTarget: currentView,
          title: '重新应用配置',
        });
      default:
        continue;
    }
  }
}

function dependencyWriteTargets(graphPlan: ConsoleGraphWritePlan | null): Array<{
  pluginName: string;
  platform: PluginConsoleLocation['platform'];
  scope: Scope;
}> {
  if (!graphPlan) {
    return [];
  }
  return graphPlan.writeTargets
    .filter((entry) => !entry.requested)
    .map((entry) => ({
      pluginName: entry.target.pluginName,
      platform: entry.platform,
      scope: entry.scope,
    }));
}

async function confirmDependencyWrites(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  graphPlan: ConsoleGraphWritePlan | null,
): Promise<'confirmed' | 'back' | 'exit'> {
  const dependencies = dependencyWriteTargets(graphPlan);
  if (dependencies.length === 0) {
    return 'confirmed';
  }

  const lines = [
    '这次写入会一并处理以下依赖：',
    ...dependencies.map((entry) =>
      `- ${entry.pluginName} · ${platformLabel(entry.platform)} · ${configScopeLabel(entry.scope)}`),
  ];
  return promptOptionConfirmation(
    context,
    `${item.summary.title} 安装依赖确认`,
    lines,
    '继续安装',
  );
}

async function runInstallLikeAction(options: {
  context: CliExecutionContext;
  item: ConsoleControllerItem;
  selections: ExecutableTargetSelection[];
  intent: 'install' | 'upgrade';
}): Promise<ConsoleActionResolution> {
  const { context, item, selections, intent } = options;
  const firstLocation = selections[0]!.location;
  const prepared = await preparePluginTargetsForCommand(
    context.cwd,
    firstLocation.scope,
    [item.summary.pluginName],
    {
      catalogMode: 'readOnly',
      allowHistoricalFallback: false,
      env: context.env,
    },
  );
  const selectedPlatforms = [...new Set(selections.map((selection) => selection.location.platform))];
  const graphPlan = await planConsoleGraphWriteTargets({
    operation: intent,
    targets: prepared.targets,
    platforms: selectedPlatforms,
    cwd: context.cwd,
    scope: firstLocation.scope,
    ledger: prepared.ledger,
    env: context.env,
  });
  const writeTargets = graphPlan?.writeTargets ?? prepared.targets.map((target) => ({
    target,
    platform: firstLocation.platform,
    scope: firstLocation.scope,
    requested: true,
  }));

  const decision = await createInstallWizardDecision({
    intent,
    targets: writeTargets.map((entry) => entry.target),
    scopedTargets: writeTargets,
    platforms: selectedPlatforms,
    cwd: context.cwd,
    scope: firstLocation.scope,
    env: context.env,
  });

  if (decision.blockedReason) {
    await renderView(context, `${item.summary.title} 无法继续`, [
      decision.blockedReason.message,
      '',
      ...decision.blockedReason.nextSteps.map((step) => `- ${step}`),
    ]);
    return { navigation: 'back' };
  }

  const dependenciesConfirmed = await confirmDependencyWrites(context, item, graphPlan);
  if (dependenciesConfirmed === 'exit') {
    return { navigation: 'exit' };
  }
  if (dependenciesConfirmed !== 'confirmed') {
    return { navigation: 'back' };
  }

  if (decision.configPrompts.length > 0) {
    const outcomes = await applyConfigPrompts(context, decision.configPrompts, true);
    if (!outcomes) {
      return { navigation: 'back' };
    }
  }

  const { result: outcomes, exitRequested } = await executeWithDeferredExit(
    context,
    `${item.summary.title} ${decision.commandAction === 'upgrade' ? '升级' : '安装'}中`,
    decision.commandAction === 'upgrade' ? '升级' : '安装',
    async () => {
      const collected: ConsoleExecutionOutcome[] = [];
      for (const group of groupSelectionsByScope(selections)) {
        try {
          if (decision.commandAction === 'upgrade') {
            const result = await upgradeCommand([item.summary.pluginName], {
              cwd: context.cwd,
              scope: group.scope,
              platform: group.platform,
            }, context);
            collected.push(...createGroupedExecutionOutcomes({
              selections: group.selections,
              status: 'succeeded',
              lines: stripTuiCommandSuggestionLines(commandResultLines('upgrade', group.scope, result)),
              targetResults: createCommandTargetResults({
                command: 'upgrade',
                scope: group.scope,
                result,
              }),
            }));
            continue;
          }

          const result = await installCommand([item.summary.pluginName], {
            cwd: context.cwd,
            scope: group.scope,
            platform: group.platform,
          }, context);
          collected.push(...createGroupedExecutionOutcomes({
            selections: group.selections,
            status: 'succeeded',
            lines: stripTuiCommandSuggestionLines(commandResultLines('install', group.scope, result)),
            targetResults: createCommandTargetResults({
              command: 'install',
              scope: group.scope,
              result,
            }),
          }));
        } catch (error) {
          collected.push(...createFailedExecutionOutcomes(
            item.summary.pluginName,
            group.selections,
            error,
            decision.commandAction === 'upgrade' ? 'upgrade' : 'install',
          ));
        }
      }
      return collected;
    },
  );

  return {
    navigation: exitRequested ? 'exit' : 'stay',
    ...(exitRequested ? {} : { item: await reloadConsoleItem(context, item.summary.pluginName, item) }),
    recentResult: createRecentResult(
      selections[0]?.action.label ?? (decision.commandAction === 'upgrade' ? '升级' : '安装'),
      outcomes,
    ),
  };
}

async function promptRemoveConfigSelection(
  context: CliExecutionContext,
  message: string,
): Promise<boolean | 'back' | 'exit'> {
  const choice = await selectValue(context, {
    message,
    choices: [
      { value: 'keep', label: '保留配置' },
      { value: 'remove', label: '同时删除配置' },
      { value: 'remove-config-back', label: '返回', role: 'back' },
      { value: 'remove-config-exit', label: '退出', role: 'exit' },
    ],
    defaultValue: 'keep',
  });
  if (isPromptAction(choice, 'exit')) {
    return 'exit';
  }
  if (promptCancelled(choice) || isPromptAction(choice, 'back')) {
    return 'back';
  }
  return selectedPromptValue(choice) === 'remove';
}

async function runUninstallAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selections: ExecutableTargetSelection[],
): Promise<ConsoleActionResolution> {
  const removeConfig = await promptRemoveConfigSelection(context, '配置处理');
  if (removeConfig === 'exit') {
    return { navigation: 'exit' };
  }
  if (removeConfig === 'back') {
    return { navigation: 'back' };
  }
  const configGroups = buildCleanupExecutionSelections(context, item, selections);
  const confirmation = await confirmDestructiveAction(
    context,
    item,
    selections[0]!.action,
    selections,
    removeConfig ? renderConfigStoreExecutionGroupLines(configGroups) : [],
  );
  if (confirmation === 'exit') {
    return { navigation: 'exit' };
  }
  if (confirmation !== 'confirmed') {
    return {
      navigation: 'stay',
      item,
      notice: '已取消，本次没有写入任何状态。',
    };
  }

  const { result: outcomes, exitRequested } = await executeWithDeferredExit(
    context,
    `${item.summary.title} 卸载中`,
    '卸载',
    async () => {
      const collected: ConsoleExecutionOutcome[] = [];
      for (const group of configGroups) {
        for (const executionGroup of groupSelectionsByScope(group.selections)) {
          try {
            const result = await uninstallCommand([item.summary.pluginName], {
              cwd: context.cwd,
              scope: executionGroup.scope,
              platform: executionGroup.platform,
              removeConfig: false,
            }, context);
            collected.push(...createGroupedExecutionOutcomes({
              selections: executionGroup.selections,
              status: 'succeeded',
              lines: stripTuiCommandSuggestionLines(commandResultLines('uninstall', executionGroup.scope, result)),
              targetResults: createCommandTargetResults({
                command: 'uninstall',
                scope: executionGroup.scope,
                result,
              }),
            }));
          } catch (error) {
            collected.push(...createFailedExecutionOutcomes(
              item.summary.pluginName,
              executionGroup.selections,
              error,
              'uninstall',
            ));
          }
        }
      }
      return collected;
    },
  );
  const configStoreRemovals = await applyGroupedConfigRemoval(context, item, configGroups, outcomes, removeConfig);
  const recentResult = createRecentResult(selections[0]?.action.label ?? '卸载', outcomes);
  if (configStoreRemovals.length > 0) {
    recentResult.configStoreRemovals = configStoreRemovals;
  }

  return {
    navigation: exitRequested ? 'exit' : 'stay',
    ...(exitRequested ? {} : { item: await reloadConsoleItem(context, item.summary.pluginName, item) }),
    recentResult,
  };
}

async function runCleanupActionInternal(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selections: ExecutableTargetSelection[],
  options: RunCleanupActionOptions,
): Promise<ConsoleActionResolution> {
  const removeConfig = options.promptRemoveConfig === false
    ? false
    : await promptRemoveConfigSelection(context, '配置处理');
  if (removeConfig === 'exit') {
    return { navigation: 'exit' };
  }
  if (removeConfig === 'back') {
    return { navigation: 'back' };
  }
  const configGroups = buildCleanupExecutionSelections(context, item, selections);
  const plannedSelections = buildCleanupPlanSelections(configGroups, removeConfig);
  const planOutcomes: CleanupPlanOutcome[] = [];
  for (const configured of plannedSelections) {
    try {
      const plan = await cleanupCommand([item.summary.pluginName], {
        cwd: context.cwd,
        scope: configured.selection.location.scope,
        platform: configured.selection.location.platform,
        plan: true,
        removeConfig: configured.removeConfig,
      }, context);
      if (plan.payload.dependencyIndex) {
        planOutcomes.push({
          ...configured,
          status: 'failed',
          lines: ['当前 cleanup 计划返回的是 dependency index 结果，console 不会继续执行这个目标。'],
        });
        continue;
      }
      const needsForce = plan.payload.blockingReasons.length > 0;
      planOutcomes.push({
        ...configured,
        status: 'planned',
        needsForce,
        lines: summarizeCleanupPlanPayload(plan.payload),
      });
    } catch (error) {
      planOutcomes.push({
        ...configured,
        status: 'failed',
        lines: [formatErrorMessage(error)],
      });
    }
  }

  const executablePlans = planOutcomes.filter((outcome): outcome is CleanupPlanOutcome & {
    status: 'planned';
    needsForce: boolean;
  } => outcome.status === 'planned');

  const planLines = joinNonEmpty([
    ...renderCleanupPlanOutcomeLines(planOutcomes),
    ...(removeConfig ? ['', ...renderConfigStoreExecutionGroupLines(configGroups)] : []),
  ]);
  if (planOutcomes.length > 0) {
    const planDecision = await promptOptionConfirmation(
      context,
      options.planTitle,
      planLines,
      '继续清理',
    );
    if (planDecision === 'exit') {
      return { navigation: 'exit' };
    }
    if (planDecision !== 'confirmed') {
      return {
        navigation: 'stay',
        item,
        notice: '已取消，本次没有写入任何状态。',
      };
    }
  }

  if (executablePlans.length === 0) {
    return {
      navigation: 'stay',
      item: await reloadConsoleItem(context, item.summary.pluginName, item),
      recentResult: createRecentResult(options.resultLabel, planOutcomes.map((outcome) => ({
        selection: outcome.selection,
        status: 'failed',
        lines: outcome.lines,
        targetResults: [createSyntheticTargetResult(
          item.summary.pluginName,
          outcome.selection,
          'cleanup',
          'failed',
          outcome.lines[0],
          'failed',
        )],
      }))),
    };
  }

  const requiresRiskConfirmation = executablePlans.some((outcome) => outcome.needsForce);
  if (requiresRiskConfirmation) {
    const riskDecision = await promptOptionConfirmation(
      context,
      options.riskTitle,
      planLines,
      `继续处理这 ${executablePlans.length} 个清理目标`,
    );
    if (riskDecision === 'exit') {
      return { navigation: 'exit' };
    }
    if (riskDecision !== 'confirmed') {
      return {
        navigation: 'stay',
        item,
        notice: '已取消，本次没有写入任何状态。',
      };
    }
  }

  const { result: outcomes, exitRequested } = await executeWithDeferredExit(
    context,
    `${item.summary.title} 清理中`,
    '清理',
    async () => {
      const collected: ConsoleExecutionOutcome[] = planOutcomes
        .filter((outcome) => outcome.status === 'failed')
        .map((outcome) => ({
          selection: outcome.selection,
          status: 'failed',
          lines: outcome.lines,
        targetResults: [createSyntheticTargetResult(
          item.summary.pluginName,
          outcome.selection,
          'cleanup',
          'failed',
          outcome.lines[0],
          'failed',
        )],
        }));

      for (const group of groupExecutableCleanupPlans(executablePlans)) {
        try {
          const result = await cleanupCommand([item.summary.pluginName], {
            cwd: context.cwd,
            scope: group.scope,
            platform: group.platform,
            force: group.force,
            removeConfig: false,
          }, context);
          if (result.payload.dependencyIndex) {
            collected.push(...createGroupedExecutionOutcomes({
              selections: group.selections.map((plan) => plan.selection),
              status: 'failed',
              lines: ['cleanup 返回了 dependency index 结果，console 不能把它当成目标清理结果处理。'],
              targetResults: result.payload.targetResults,
            }));
            continue;
          }
          const payload = buildCleanupReceiptJson({
            payload: result.payload,
            warnings: result.warnings,
          });
          const lines = summarizeCleanupExecutionPayload(result.payload);
          const failed = isCleanupExecutionFailure(result.payload);
          collected.push(...createGroupedExecutionOutcomes({
            selections: group.selections.map((plan) => plan.selection),
            status: failed ? 'failed' : 'succeeded',
            lines,
            targetResults: payload.targetResults,
            ...('configStoreRemovals' in payload ? { configStoreRemovals: payload.configStoreRemovals } : {}),
          }));
        } catch (error) {
          collected.push(...createFailedExecutionOutcomes(
            item.summary.pluginName,
            group.selections.map((plan) => plan.selection),
            error,
            'cleanup',
          ));
        }
      }

      return collected;
    },
  );
  const configStoreRemovals = await applyGroupedConfigRemoval(context, item, configGroups, outcomes, removeConfig);
  const recentResult = createRecentResult(options.resultLabel, outcomes);
  if (configStoreRemovals.length > 0) {
    recentResult.configStoreRemovals = configStoreRemovals;
  }

  return {
    navigation: exitRequested ? 'exit' : 'stay',
    ...(exitRequested ? {} : { item: await reloadConsoleItem(context, item.summary.pluginName, item) }),
    recentResult,
  };
}

async function runCleanupAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selections: ExecutableTargetSelection[],
): Promise<ConsoleActionResolution> {
  return runCleanupActionInternal(context, item, selections, {
    planTitle: `${item.summary.title} 清理计划`,
    confirmTitle: `${item.summary.title} 清理确认`,
    riskTitle: `${item.summary.title} 清理风险`,
    resultLabel: '清理',
  });
}

async function runResolveDuplicateInstallAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selections: ExecutableTargetSelection[],
): Promise<ConsoleActionResolution> {
  return runCleanupActionInternal(context, item, selections, {
    planTitle: `${item.summary.title} 重复安装处理计划`,
    confirmTitle: `${item.summary.title} 重复安装处理确认`,
    riskTitle: `${item.summary.title} 重复安装处理风险`,
    resultLabel: '处理重复安装',
    promptRemoveConfig: false,
  });
}

async function runReinstallAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selections: ExecutableTargetSelection[],
): Promise<ConsoleActionResolution> {
  const { result: outcomes, exitRequested } = await executeWithDeferredExit(
    context,
    `${item.summary.title} 重新安装中`,
    '重新安装',
    async () => {
      const collected: ConsoleExecutionOutcome[] = [];
      for (const group of groupSelectionsByScope(selections)) {
        try {
          const result = await reinstallCommand([item.summary.pluginName], {
            cwd: context.cwd,
            scope: group.scope,
            platform: group.platform,
          }, context);
          collected.push(...createGroupedExecutionOutcomes({
            selections: group.selections,
            status: 'succeeded',
            lines: stripTuiCommandSuggestionLines(commandResultLines('install', group.scope, result, {
              headlineVariant: 'reinstall',
            })),
            targetResults: createCommandTargetResults({
              command: 'install',
              scope: group.scope,
              result,
            }),
          }));
        } catch (error) {
          collected.push(...createFailedExecutionOutcomes(
            item.summary.pluginName,
            group.selections,
            error,
            'reinstall',
          ));
        }
      }
      return collected;
    },
  );

  return {
    navigation: exitRequested ? 'exit' : 'stay',
    ...(exitRequested ? {} : { item: await reloadConsoleItem(context, item.summary.pluginName, item) }),
    recentResult: createRecentResult('重新安装', outcomes),
  };
}

async function runAdoptExistingAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selection: ExecutableTargetSelection,
): Promise<ConsoleActionResolution> {
  const { result: outcome, exitRequested } = await executeWithDeferredExit(
    context,
    `${item.summary.title} 认领中`,
    '认领现有安装',
    async () => {
      try {
        const result = await installCommand([item.summary.pluginName], {
          cwd: context.cwd,
          scope: selection.location.scope,
          platform: selection.location.platform,
          adoptExisting: true,
        }, context);
        return {
          selection,
          status: 'succeeded',
          lines: ['已为当前共享产物建立本机 ownership。'],
          targetResults: createCommandTargetResults({
            command: 'install',
            scope: selection.location.scope,
            result,
          }),
        } satisfies ConsoleExecutionOutcome;
      } catch (error) {
        return createFailedExecutionOutcome(
          item.summary.pluginName,
          selection,
          error,
          'adoptExisting',
        );
      }
    },
  );

  return {
    navigation: exitRequested ? 'exit' : 'stay',
    ...(exitRequested ? {} : { item: await reloadConsoleItem(context, item.summary.pluginName, item) }),
    recentResult: createRecentResult('认领现有安装', [outcome]),
  };
}

async function runReapplyAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  location: PluginConsoleLocation,
): Promise<ConsoleActionResolution> {
  const prepared = await preparePluginTargetsForCommand(
    context.cwd,
    location.scope,
    [item.summary.pluginName],
    {
      catalogMode: 'readOnly',
      allowHistoricalFallback: true,
      env: context.env,
    },
  );
  const target = prepared.targets[0];
  if (!target) {
    throw new Error(`无法加载 ${item.summary.pluginName}。`);
  }
  const replay = await replayConfigRuntimeWrites({
    plugin: target.currentPlugin ?? target.plugin,
    scope: location.scope,
    cwd: context.cwd,
    env: context.env,
    nativeCliRunner: context.nativeCliRunner,
    applyTargets: [{
      pluginName: item.summary.pluginName,
      platform: location.platform,
      scope: location.scope,
      ...(location.projectKey ? { projectKey: location.projectKey } : {}),
    }],
    includeDynamicArtifacts: true,
  });
  const lines = replay.artifactRefresh.status === 'succeeded'
    ? ['相关项目文件已更新。']
    : replay.artifactRefresh.status === 'skipped'
      ? ['没有需要重新应用的项目文件。']
      : ['重新应用配置失败。'];
  return {
    navigation: 'stay',
    item: await reloadConsoleItem(context, item.summary.pluginName, item),
    recentResult: configResultRecentResult('重新应用配置', replay.targetResults, lines.map((line) => `- ${line}`)),
  };
}

async function runStatusAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  location?: PluginConsoleLocation,
): Promise<ConsoleNavigation> {
  const detailItem = await loadConsoleDetailItem(context, item.summary.pluginName, item);
  const detailLocation = location
    ? detailItem.locations.find((entry) =>
        entry.platform === location.platform &&
        entry.scope === location.scope &&
        (entry.projectKey ?? null) === (location.projectKey ?? null),
      ) ?? location
    : undefined;
  if (location) {
    const detailKey = detailItem.statusPage.locations.find((entry) =>
      entry.platform === detailLocation!.platform &&
      entry.scope === detailLocation!.scope &&
      (entry.projectKey ?? null) === (detailLocation!.projectKey ?? null),
    )?.key;
    await renderView(
      context,
      `${detailItem.summary.title} 详情`,
      detailKey ? renderStatusDetailLines(detailItem, detailKey) : ['当前没有可展示的状态详情。'],
    );
    const detailSelection = await selectValue(context, {
      message: '详情',
      choices: [
        { value: 'status-detail-back', label: '返回', role: 'back' },
        { value: 'status-detail-exit', label: '退出', role: 'exit' },
      ],
      defaultValue: 'status-detail-back',
    });
    return isPromptAction(detailSelection, 'exit') ? 'exit' : 'back';
  }

  while (true) {
    const summaryLocations = detailItem.statusPage.locations.filter((entry) => entry.hasEvidence);
    await renderView(
      context,
      `${detailItem.summary.title} 状态`,
      renderStatusSummaryLines(detailItem),
    );
    const selection = await selectValue(context, {
      message: '状态',
      choices: [
        ...summaryLocations.map((entry) => ({
          value: entry.key,
          label: `详情 · ${entry.label}`,
          description: entry.summary,
        })),
        { value: 'status-back', label: '返回', role: 'back' },
        { value: 'status-exit', label: '退出', role: 'exit' },
      ],
      defaultValue: summaryLocations[0]?.key ?? 'status-back',
    });
    if (isPromptAction(selection, 'exit')) {
      return 'exit';
    }
    if (isPromptAction(selection, 'back') || isPromptAction(selection, 'cancel')) {
      return 'back';
    }
    const key = selectedPromptValue(selection);
    if (!key) {
      return 'back';
    }
    await renderView(
      context,
      `${detailItem.summary.title} 详情`,
      renderStatusDetailLines(detailItem, key),
    );
    const detailSelection = await selectValue(context, {
      message: '详情',
      choices: [
        { value: 'status-detail-back', label: '返回', role: 'back' },
        { value: 'status-detail-exit', label: '退出', role: 'exit' },
      ],
      defaultValue: 'status-detail-back',
    });
    if (isPromptAction(detailSelection, 'exit')) {
      return 'exit';
    }
  }
}

async function runDependencyAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
): Promise<ConsoleNavigation> {
  await renderView(
    context,
    `${item.summary.title} 依赖`,
    renderDependencyPageLines(item),
  );
  const selection = await selectValue(context, {
    message: '依赖详情',
    choices: [
      { value: 'dependency-back', label: '返回', role: 'back' },
      { value: 'dependency-exit', label: '退出', role: 'exit' },
    ],
    defaultValue: 'dependency-back',
  });
  return isPromptAction(selection, 'exit') ? 'exit' : 'back';
}

async function loadResultPageItem(
  context: CliExecutionContext,
  pluginName: string,
): Promise<ConsoleControllerItem | undefined> {
  const homeState = await loadConsoleHomeState(context);
  return homeState.items.find((entry) => entry.summary.pluginName === pluginName);
}

async function handleExecutableAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  featureKind: PluginConsoleFeatureKind,
  executableActions: ExecutableTargetSelection[],
): Promise<ConsoleActionResolution> {
  const firstAction = executableActions[0]?.action;
  if (
    firstAction?.destructive &&
    firstAction.kind !== 'runCleanup' &&
    firstAction.kind !== 'runUninstall' &&
    firstAction.kind !== 'resolveDuplicateInstall'
  ) {
    const confirmed = await confirmDestructiveAction(context, item, firstAction, executableActions);
    if (confirmed === 'exit') {
      return { navigation: 'exit' };
    }
    if (confirmed !== 'confirmed') {
      return {
        navigation: 'stay',
        item,
        notice: '已取消，本次没有写入任何状态。',
      };
    }
  }

  if (firstAction?.kind === 'openStatus') {
    return { navigation: await runStatusAction(context, item) };
  }
  if (firstAction?.kind === 'openDependencies') {
    return { navigation: await runDependencyAction(context, item) };
  }

  const location = executableActions[0]?.location;
  if (!location || !firstAction) {
    throw new Error(`无法定位 ${item.summary.pluginName} 的目标位置。`);
  }

  try {
    switch (firstAction.kind) {
      case 'runInstall':
        return runInstallLikeAction({
          context,
          item,
          selections: executableActions,
          intent: 'install',
        });
      case 'runUpgrade':
        return runInstallLikeAction({
          context,
          item,
          selections: executableActions,
          intent: 'upgrade',
        });
      case 'runConfig':
        return runConfigWizardAction(context, item);
      case 'runUninstall':
        return runUninstallAction(context, item, executableActions);
      case 'runCleanup':
        return runCleanupAction(context, item, executableActions);
      case 'resolveDuplicateInstall': {
        const removalTargets = item.locations.filter((entry) =>
          entry.platform === location.platform &&
          !(entry.scope === location.scope && entry.projectKey === location.projectKey) &&
          entry.reasonCodes.includes('duplicateInstall'),
        );
        return removalTargets.length > 0
          ? runResolveDuplicateInstallAction(
              context,
              item,
              removalTargets.map((removalTarget) => ({ action: firstAction, location: removalTarget })),
            )
          : { navigation: 'back' };
      }
      case 'runAdoptExisting':
        return runAdoptExistingAction(context, item, executableActions[0]!);
      case 'runReapplyConfigRefresh':
        return runReapplyAction(context, item, location);
      case 'runReinstall':
        return runReinstallAction(context, item, executableActions);
      default:
        throw new Error(`Unsupported console action "${firstAction.kind}".`);
    }
  } catch (error) {
    const failedOutcomes = executableActions.map((selection) =>
      createFailedExecutionOutcome(
        item.summary.pluginName,
        selection,
        error,
        firstAction?.kind ?? 'consoleAction',
      ));
    return {
      navigation: 'stay',
      item: await reloadConsoleItem(context, item.summary.pluginName, item),
      recentResult: createRecentResult(firstAction?.label ?? '执行失败', failedOutcomes),
    };
  }
}

async function browseFeature(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  featureKind: PluginConsoleFeatureKind,
  recentResult?: ConsoleRecentResult,
): Promise<ConsoleActionResolution> {
  if (featureKind === 'configure') {
    return runConfigWizardAction(context, item, recentResult);
  }

  const executableActions = createPluginConsoleExecutableActions(item, featureKind);
  const feature = item.summary.features.find((entry) => entry.kind === featureKind);
  const enabledActions = executableActions.filter((actionEntry) => !actionEntry.disabledReason);

  if (enabledActions.length === 0) {
    if (feature?.disabledReason) {
      await renderView(context, `${item.summary.title} · ${feature.label}`, [feature.disabledReason]);
    }
    return { navigation: 'back' };
  }

  if (feature?.targetSelection === 'none') {
    return handleExecutableAction(context, item, featureKind, [{
      action: enabledActions[0]!,
      location: item.locations[0]!,
    }]);
  }

  const selections = await selectExecutableTargets(context, item, featureKind, enabledActions);
  if (selections === 'exit') {
    return { navigation: 'exit' };
  }
  if (!selections || selections.length === 0) {
    return { navigation: 'back' };
  }
  return handleExecutableAction(context, item, featureKind, selections);
}

async function browseItem(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  recentResults: Map<string, ConsoleRecentResult>,
): Promise<ConsoleNavigation> {
  let currentItem = item;
  let recentResult = recentResults.get(item.summary.pluginName);
  let pendingNotice: string | undefined;
  while (true) {
    await renderView(context, currentItem.summary.title, renderDetailLines(currentItem, recentResult, pendingNotice));
    pendingNotice = undefined;
    const featureValue = await selectValue(context, {
      message: '选择功能',
      choices: buildFeatureChoices(currentItem),
      defaultValue: currentItem.summary.features[0]?.kind,
    });
    if (isPromptAction(featureValue, 'back') || isPromptAction(featureValue, 'cancel')) {
      return 'back';
    }
    if (isPromptAction(featureValue, 'exit')) {
      return 'exit';
    }
    const result = await browseFeature(
      context,
      currentItem,
      selectedPromptValue(featureValue) as PluginConsoleFeatureKind,
      recentResult,
    );
    if (result.recentResult) {
      recentResults.set(currentItem.summary.pluginName, result.recentResult);
      recentResult = result.recentResult;
    }
    if (result.notice) {
      pendingNotice = result.notice;
    }
    if (result.item) {
      currentItem = result.item;
    } else if (result.navigation === 'reload') {
      currentItem = await reloadConsoleItem(context, currentItem.summary.pluginName, currentItem);
    }
    if (result.navigation === 'exit') {
      return 'exit';
    }
    if (result.navigation === 'stay' || result.navigation === 'back' || result.navigation === 'reload') {
      continue;
    }
  }
}

export function formatInteractiveConsoleUnavailableMessage(context: Pick<CliExecutionContext, 'isCi' | 'isTty'>): string {
  const reasons = [
    context.isCi ? 'CI 环境默认禁用交互控制台。' : undefined,
    !context.isTty ? '当前 stdin/stdout 不是可交互终端。' : undefined,
  ].filter(Boolean);

  return [
    '当前运行环境不可交互，不能直接进入 aw 主控制台。',
    ...reasons,
    '',
    '可复制命令：',
    '- `aw status`',
    '- `aw install <plugin> --platform codex --scope user`',
    '- `aw status --json`',
  ].join('\n');
}

export async function runConsoleController(
  context: CliExecutionContext,
): Promise<number> {
  const recentResults = new Map<string, ConsoleRecentResult>();
  while (true) {
    const homeState = await loadConsoleHomeState(context);
    if (homeState.items.length === 0) {
      await renderView(context, 'AW 控制台', [
        '当前没有可展示的插件。',
        '请先检查当前环境和插件目录是否可用。',
      ]);
      return 0;
    }
    await renderView(context, 'AW 控制台', buildHomeLines(homeState));
    const selection = await selectValue(context, {
      message: '选择插件',
      choices: buildHomeChoices(homeState.items),
      defaultValue: homeState.items[0]?.summary.pluginName,
    });
    if (isPromptAction(selection, 'exit') || isPromptAction(selection, 'cancel')) {
      return 0;
    }
    if (selectedPromptValue(selection) === 'home-refresh') {
      continue;
    }
    const item = homeState.items.find((entry) => entry.summary.pluginName === selectedPromptValue(selection));
    if (!item) {
      continue;
    }
    const result = await browseItem(context, item, recentResults);
    if (result === 'exit') {
      return 0;
    }
  }
}
