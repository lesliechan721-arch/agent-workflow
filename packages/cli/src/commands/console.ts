import type { Scope, SkillTriggerPreference } from '../types.js';
import type {
  CliConsoleView,
  CliExecutionContext,
  CliPromptChoice,
  CliPromptAction,
  CliPromptResult,
} from './runtime.js';
import {
  createInstallWizardDecision,
  planConsoleGraphWriteTargets,
  type ConsoleRequiredConfigPrompt,
  type ConsoleWriteWizardOperation,
} from './console-wizard.js';
import {
  type DiagnosePageModel,
  type DiagnoseSupplementalCommand,
  type ConsoleControllerItem,
  createConsolePluginDetailPageModel,
  createPluginConsoleExecutableActions,
  type PluginConsoleExecutableAction,
  type PluginConsoleFeatureKind,
  type PluginConsoleLocation,
} from './console-model.js';
import {
  preparePluginTargetsForCommand,
  type ResolvedPluginTarget,
} from './common.js';
import { diagnoseCommand } from './diagnose.js';
import { installCommand } from './install.js';
import { cleanupCommand, isCleanupExecutionFailure } from './cleanup.js';
import { reinstallCommand } from './reinstall.js';
import { repairCommand } from './repair.js';
import {
  loadConsoleItems as loadConsoleControllerItems,
  statusCommand,
} from './status.js';
import { uninstallCommand } from './uninstall.js';
import { upgradeCommand } from './upgrade.js';
import { formatWarnings } from '../output/reporter.js';
import {
  renderCleanupReceipt,
  renderCommandReceipt,
} from '../output/command-receipt.js';
import { resolveSkillTriggerApplicabilityForPlugin } from '../utils/skill-trigger-preferences.js';
import {
  coercePluginConfigValue,
  createPluginConfigSchemaIdentity,
  createPluginConfigFormModel,
  readPluginConfigStore,
  resetPluginConfigStore,
  resolveEffectivePluginConfig,
  resolvePluginConfigStorePath,
  type PluginConfigFormFieldModel,
  type PluginConfigValue,
} from '../utils/plugin-config.js';
import { applyPluginConfigWrite } from '../utils/plugin-config-write.js';
import { reapplyConfigRefresh } from '../utils/artifact-refresh.js';

type ConsoleNavigation = 'back' | 'reload' | 'exit';

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

interface ConsoleResultPageState {
  pluginName: string;
  title: string;
  lines: string[];
  item?: ConsoleControllerItem;
  focusLocations?: PluginConsoleLocation[];
  diagnoseTargets?: ConsoleResultDiagnoseTarget[];
}

interface ExecutableTargetSelection {
  action: PluginConsoleExecutableAction;
  location: PluginConsoleLocation;
}

interface ConsoleResultDiagnoseTarget {
  location: PluginConsoleLocation;
  description?: string;
  command?: string[];
}

interface ConsoleExecutionOutcome {
  selection: ExecutableTargetSelection;
  status: 'succeeded' | 'failed';
  lines: string[];
  diagnoseDescription?: string;
  diagnoseCommand?: string[];
}

interface ConfigStoreExecutionGroup {
  storePath: string;
  scope: Scope;
  selections: ExecutableTargetSelection[];
}

interface CleanupPlanOutcome {
  selection: ExecutableTargetSelection;
  status: 'planned' | 'failed';
  removeConfig: boolean;
  needsForce?: boolean;
  lines: string[];
}

interface RunCleanupActionOptions {
  resultTitle: string;
  riskTitle: string;
  promptRemoveConfig?: boolean;
  preConfirmed?: boolean;
}

interface ConfigWriteOutcome {
  prompt: ConsoleRequiredConfigPrompt;
  scope: Scope;
  updatedKeys: string[];
  removedKeys: string[];
  artifactRefreshStatus: 'succeeded' | 'failed' | 'skipped';
  artifactRefreshError?: string;
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
      label: `${item.pageItem.statusIcon} ${item.summary.title} · ${item.summary.statusLabel}`,
      description: joinNonEmpty([
        item.pageItem.platformBadges.map((badge) => badge.label).join(' / '),
        item.summary.locationSummary,
        item.pageItem.primaryActionLabel ? `主操作：${item.pageItem.primaryActionLabel}` : undefined,
        item.pageItem.summaryText,
      ]).join(' · '),
      short: item.summary.title,
    })),
    { value: 'home-exit', label: '退出', role: 'exit' },
  ];
}

function buildFeatureChoices(item: ConsoleControllerItem): CliPromptChoice[] {
  return [
    ...item.summary.features.map((feature) => ({
      value: feature.kind,
      label: feature.label,
      description: feature.disabledReason
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
          label: '所有平台',
          description: platforms.map((platform) => platform === 'codex' ? 'Codex' : 'Claude Code').join('、'),
          short: '所有平台',
        } satisfies CliPromptChoice]
      : []),
    ...detail.targetOptions.map((option) => ({
      value: buildTargetChoiceValue(option),
      label: `${option.label} · ${option.status ?? 'unknown'}`,
      description: option.disabledReason,
      short: option.label,
      disabled: option.disabledReason,
    })),
    { value: 'target-back', label: '返回', role: 'back' },
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
    ...state.items.flatMap((item) => [
      `${item.pageItem.statusIcon} ${item.summary.title} · ${item.summary.statusLabel}`,
      `  ${joinNonEmpty([
        item.pageItem.platformBadges.map((badge) => badge.label).join(' / '),
        item.summary.locationSummary,
        item.pageItem.primaryActionLabel ? `主操作：${item.pageItem.primaryActionLabel}` : undefined,
        item.pageItem.summaryText,
      ]).join(' · ')}`,
    ]),
  ]);
}

async function loadConsoleHomeState(context: CliExecutionContext): Promise<ConsoleHomeState> {
  const base = await statusCommand([], {
    cwd: context.cwd,
  }, context);
  const items = await loadConsoleControllerItems({
    cwd: context.cwd,
    includeCatalogOnly: true,
  }, context);
  const catalogUnavailable = base.matrix.cells.length > 0 &&
    base.matrix.cells.every((cell) => cell.report?.currentCatalog?.available !== true);
  return {
    items,
    ...(catalogUnavailable
      ? { banner: '插件目录不可用，仅显示已发现安装；恢复后可安装或升级。' }
      : {}),
  };
}

function filterResultDiagnoseTargets(
  item: ConsoleControllerItem,
  focusLocations: PluginConsoleLocation[] = [],
): PluginConsoleLocation[] {
  const focusKeys = new Set(focusLocations.map((location) => buildTargetChoiceValue(location)));
  const scopedLocations = focusKeys.size > 0
    ? item.locations.filter((location) => focusKeys.has(buildTargetChoiceValue(location)))
    : item.locations;
  const diagnoseable = scopedLocations.filter((location) => location.status === 'abnormal');
  return diagnoseable.length > 0
    ? diagnoseable
    : item.locations.filter((location) => location.status === 'abnormal');
}

function findMatchingLocation(
  item: ConsoleControllerItem,
  location: PluginConsoleLocation,
): PluginConsoleLocation | undefined {
  const targetKey = buildTargetChoiceValue(location);
  return item.locations.find((entry) => buildTargetChoiceValue(entry) === targetKey);
}

function collectResultDiagnoseTargets(
  item: ConsoleControllerItem | undefined,
  focusLocations: PluginConsoleLocation[] = [],
  explicitTargets: ConsoleResultDiagnoseTarget[] = [],
): ConsoleResultDiagnoseTarget[] {
  const collected = new Map<string, ConsoleResultDiagnoseTarget>();

  const addTarget = (target: ConsoleResultDiagnoseTarget): void => {
    const key = buildTargetChoiceValue(target.location);
    const existing = collected.get(key);
    if (!existing) {
      collected.set(key, target);
      return;
    }
    collected.set(key, {
      location: target.location,
      description: existing.description ?? target.description,
      command: existing.command ?? target.command,
    });
  };

  for (const target of explicitTargets) {
    addTarget({
      ...target,
      location: item
        ? findMatchingLocation(item, target.location) ?? target.location
        : target.location,
    });
  }

  if (!item) {
    return [...collected.values()];
  }

  for (const location of filterResultDiagnoseTargets(item, focusLocations)) {
    addTarget({ location });
  }

  return [...collected.values()];
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

function repairInstallOperation(location: PluginConsoleLocation): ConsoleWriteWizardOperation {
  if (
    location.status === 'upgradeAvailable' ||
    location.reasonCodes.includes('artifactRefreshFailed') ||
    location.reasonCodes.includes('recordCorrupted')
  ) {
    return 'upgrade';
  }

  return 'install';
}

function commandResultLines(
  command: 'install' | 'uninstall' | 'upgrade',
  scope: Scope,
  result: Parameters<typeof renderCommandReceipt>[1]['result'],
  options: {
    headlineVariant?: 'install' | 'reinstall';
  } = {},
): string[] {
  return renderResultWithWarnings(
    renderCommandReceipt(command, {
      result,
      groups: [{
        scope,
        platforms: result.platforms,
        plugins: result.plugins,
      }],
    }, options),
    result.warnings,
  );
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function indentLines(lines: string[], prefix = '  '): string[] {
  return lines.map((line) => `${prefix}${line}`);
}

function createFailedExecutionOutcome(
  selection: ExecutableTargetSelection,
  error: unknown,
  command?: string[],
): ConsoleExecutionOutcome {
  const message = formatErrorMessage(error);
  return {
    selection,
    status: 'failed',
    lines: [message],
    diagnoseDescription: message,
    ...(command ? { diagnoseCommand: command } : {}),
  };
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

function createOutcomeResultPageState(
  item: ConsoleControllerItem,
  title: string,
  outcomes: ConsoleExecutionOutcome[],
): ConsoleResultPageState {
  return {
    pluginName: item.summary.pluginName,
    title,
    lines: renderExecutionOutcomeLines(outcomes),
    item,
    focusLocations: outcomes.map((outcome) => outcome.selection.location),
    diagnoseTargets: outcomes
      .filter((outcome) => outcome.status === 'failed')
      .map((outcome) => ({
        location: outcome.selection.location,
        description: outcome.diagnoseDescription,
        ...(outcome.diagnoseCommand ? { command: outcome.diagnoseCommand } : {}),
      })),
  };
}

async function showExecutionOutcomePage(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  title: string,
  outcomes: ConsoleExecutionOutcome[],
): Promise<ConsoleNavigation> {
  return showResultPage(context, createOutcomeResultPageState(item, title, outcomes));
}

function describeDestructiveSelections(
  actionLabel: string,
  selections: ExecutableTargetSelection[],
): string[] {
  return [
    `即将执行：${actionLabel}`,
    '',
    '目标：',
    ...selections.map((selection) => `- ${selection.location.locationLabel}`),
  ];
}

async function confirmDestructiveAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  action: PluginConsoleExecutableAction,
  selections: ExecutableTargetSelection[],
): Promise<boolean> {
  if (selections.length > 1) {
    await renderView(context, `${item.summary.title} 确认`, describeDestructiveSelections(action.label, selections));
    return confirmValue(
      context,
      `确定继续处理这 ${selections.length} 个目标吗？`,
      false,
    );
  }

  return confirmValue(
    context,
    action.confirmText ?? `确定执行 ${action.label} 吗？`,
    false,
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

function appendConfigGroupLines(
  outcomes: ConsoleExecutionOutcome[],
  group: ConfigStoreExecutionGroup,
  lines: string[],
): ConsoleExecutionOutcome[] {
  if (lines.length === 0) {
    return outcomes;
  }

  const selectionKeys = new Set(group.selections.map((selection) =>
    buildTargetChoiceValue(selection.location)));
  return outcomes.map((outcome) =>
    selectionKeys.has(buildTargetChoiceValue(outcome.selection.location))
      ? {
          ...outcome,
          lines: [...outcome.lines, '', ...lines],
        }
      : outcome);
}

async function applyGroupedConfigRemoval(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  groups: ConfigStoreExecutionGroup[],
  outcomes: ConsoleExecutionOutcome[],
  removeConfig: boolean,
): Promise<ConsoleExecutionOutcome[]> {
  if (!removeConfig) {
    return outcomes;
  }

  let nextOutcomes = outcomes;
  for (const group of groups) {
    const selectionKeys = new Set(group.selections.map((selection) =>
      buildTargetChoiceValue(selection.location)));
    const groupOutcomes = nextOutcomes.filter((outcome) =>
      selectionKeys.has(buildTargetChoiceValue(outcome.selection.location)));
    if (groupOutcomes.length === 0) {
      continue;
    }

    if (groupOutcomes.some((outcome) => outcome.status === 'failed')) {
      nextOutcomes = appendConfigGroupLines(nextOutcomes, group, [
        `配置处理：已保留${scopeLabel(group.scope)}的 AW 自管配置；同一配置位置仍有主体失败。`,
      ]);
      continue;
    }

    try {
      const reset = await resetPluginConfigStore({
        pluginName: item.summary.pluginName,
        scope: group.scope,
        cwd: context.cwd,
        env: context.env,
      });
      nextOutcomes = appendConfigGroupLines(nextOutcomes, group, [
        reset.deleted
          ? `配置处理：已在${scopeLabel(group.scope)}这一组主体全部成功后删除 AW 自管配置。`
          : `配置处理：${scopeLabel(group.scope)}位置没有可删除的 AW 自管配置。`,
      ]);
    } catch (error) {
      nextOutcomes = appendConfigGroupLines(nextOutcomes, group, [
        `配置处理：未能删除${scopeLabel(group.scope)}的 AW 自管配置：${formatErrorMessage(error)}`,
      ]);
    }
  }

  return nextOutcomes;
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

function renderDetailLines(item: ConsoleControllerItem): string[] {
  const detail = createConsolePluginDetailPageModel(item);
  return joinNonEmpty([
    `状态：${detail.summary.statusLabel}`,
    `安装摘要：${detail.installationSummary}`,
    detail.summary.version ? `版本：${detail.summary.version}` : undefined,
    detail.summary.description ? `说明：${detail.summary.description}` : undefined,
    detail.summary.issueSummary ? `主要原因：${detail.summary.issueSummary}` : undefined,
    detail.recommendation ? `建议：${detail.recommendation}` : undefined,
  ]);
}

function renderSupplementalCommandLines(commands: DiagnoseSupplementalCommand[]): string[] {
  if (commands.length === 0) {
    return [];
  }

  return [
    '',
    '补充命令：',
    ...commands.flatMap((entry) => [
      `- ${entry.command}`,
      `  ${entry.reason}`,
    ]),
  ];
}

function renderStatusPageLines(
  item: ConsoleControllerItem,
  locationLabel?: string,
): string[] {
  const locations = item.statusPage.locations
    .filter((location) => !locationLabel || location.label === locationLabel);
  const scopedLocations = locations.length > 0 ? locations : item.statusPage.locations;

  return joinNonEmpty([
    `状态：${item.statusPage.summary.statusLabel}`,
    item.statusPage.summary.issueSummary ? `主要原因：${item.statusPage.summary.issueSummary}` : undefined,
    ...(scopedLocations.length > 0
      ? [
          '',
          '位置：',
          ...scopedLocations.flatMap((location) => [
            `- ${location.label} · ${location.statusLabel}`,
            ...(location.issue ? [`  问题：${location.issue.summary}`] : []),
            ...(location.nextSteps.length > 0 ? [`  下一步：${location.nextSteps.join('；')}`] : []),
          ]),
        ]
      : []),
  ]);
}

function renderDiagnosePageLines(
  page: DiagnosePageModel,
  locationLabel?: string,
  fallbackCommand?: string[],
): string[] {
  const locations = page.locations
    .filter((location) => !locationLabel || location.label === locationLabel);
  const scopedLocations = locations.length > 0 ? locations : page.locations;
  const primaryIssue = scopedLocations.flatMap((location) => location.issues)[0] ?? page.issues[0];

  return joinNonEmpty([
    `结论：${page.conclusion}`,
    primaryIssue ? `主要问题：${primaryIssue.summary}` : undefined,
    ...(scopedLocations.length > 0
      ? [
          '',
          '位置：',
          ...scopedLocations.flatMap((location) => [
            `- ${location.label} · ${location.statusLabel}`,
            ...(location.issue ? [`  问题：${location.issue.summary}`] : []),
            ...(location.suggestedFeatures.length > 0
              ? [`  建议功能：${location.suggestedFeatures.map((feature) => feature.label).join('、')}`]
              : []),
            ...(location.nextSteps.length > 0
              ? [`  下一步：${location.nextSteps.join('；')}`]
              : []),
          ]),
        ]
      : []),
    ...(primaryIssue?.details?.length
      ? ['', '说明：', ...primaryIssue.details.map((detail) => `- ${detail}`)]
      : []),
    ...renderSupplementalCommandLines(page.supplementalCommands),
    ...(fallbackCommand ? ['', `当前入口命令：${fallbackCommand.join(' ')}`] : []),
  ]);
}

async function selectSkillTrigger(
  context: CliExecutionContext,
  target: ResolvedPluginTarget,
  platform: PluginConsoleLocation['platform'],
): Promise<SkillTriggerPreference | null> {
  const applicability = await resolveSkillTriggerApplicabilityForPlugin(
    target.currentPlugin ?? target.plugin,
    platform,
  );
  if (applicability !== 'overridable') {
    return null;
  }

  const value = await selectValue(context, {
    message: '选择触发方式',
    choices: [
      { value: 'default', label: '默认' },
      { value: 'manual', label: '手动' },
      { value: 'auto', label: '自动' },
      { value: 'skill-trigger-back', label: '返回', role: 'back' },
    ],
    defaultValue: 'default',
  });
  if (isPromptAction(value, 'back') || isPromptAction(value, 'cancel')) {
    return null;
  }
  return selectedPromptValue(value) as SkillTriggerPreference;
}

async function selectSkillTriggerForTargets(
  context: CliExecutionContext,
  targets: Array<{ target: ResolvedPluginTarget; platform: PluginConsoleLocation['platform'] }>,
): Promise<SkillTriggerPreference | undefined> {
  for (const entry of targets) {
    const applicability = await resolveSkillTriggerApplicabilityForPlugin(
      entry.target.currentPlugin ?? entry.target.plugin,
      entry.platform,
    );
    if (applicability !== 'overridable') {
      continue;
    }
    const selected = await selectSkillTrigger(context, entry.target, entry.platform);
    return selected ?? undefined;
  }
  return undefined;
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

async function selectTargetsForAllPlatforms(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  featureKind: PluginConsoleFeatureKind,
  selections: ExecutableTargetSelection[],
): Promise<ExecutableTargetSelection[] | null> {
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
      ],
      defaultValue: firstPlatformEntries[0]?.location.scope,
    });
    if (promptCancelled(scopeValue)) {
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
      ],
      defaultValue: buildTargetChoiceValue(platformEntries[0]!.location),
    });
    if (promptCancelled(selectedValue)) {
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
): Promise<ExecutableTargetSelection[] | null> {
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

  const targetValue = await selectValue(context, {
    message: '选择目标',
    choices: buildTargetChoices(item, featureKind),
    defaultValue: enabledActions[0]?.target
      ? buildTargetChoiceValue(enabledActions[0].target)
      : undefined,
  });
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
): Promise<ConsoleRequiredConfigPrompt | null> {
  const targets = await preparePluginTargetsForCommand(
    context.cwd,
    selection.location.scope,
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
    initialScope: selection.location.scope,
    allowedScopes: [selection.location.scope],
  });

  return {
    pluginName: target.pluginName,
    scope: selection.location.scope,
    storePath: resolvePluginConfigStorePath({
      pluginName: target.pluginName,
      scope: selection.location.scope,
      cwd: context.cwd,
      env: context.env,
    }),
    formIdentity: `${createPluginConfigSchemaIdentity(plugin.manifest)}\0${form.fields.map((field) => field.key).join(',')}`,
    schemaSourceIdentity: createPluginConfigSchemaIdentity(plugin.manifest),
    manifest: plugin.manifest,
    effective,
    form,
    targets: [{
      target,
      platform: selection.location.platform,
      scope: selection.location.scope,
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
      cwd: context.cwd,
      env: context.env,
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

async function maybeHandleConfigRefreshFailure(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  location: PluginConsoleLocation,
  outcomes: ConfigWriteOutcome[],
): Promise<void> {
  const failed = outcomes.find((entry) => entry.artifactRefreshStatus === 'failed');
  if (!failed) {
    return;
  }
  await renderView(context, `${item.summary.title} 配置`, [
    '配置已保存，但相关项目文件刷新失败。你可以重新应用配置，或进入诊断查看原因。',
  ]);
  const followup = await selectValue(context, {
    message: '后续操作',
    choices: [
      { value: 'reapply', label: '重新应用配置' },
      { value: 'diagnose', label: '诊断' },
      { value: 'config-followup-back', label: '返回', role: 'back' },
    ],
    defaultValue: 'reapply',
  });
  if (promptCancelled(followup)) {
    return;
  }
  const followupValue = selectedPromptValue(followup);
  if (followupValue === 'reapply') {
    await runReapplyAction(context, item, location);
  } else if (followupValue === 'diagnose') {
    await runDiagnoseAction(context, item, location, undefined);
  }
}

async function runConfigWizardAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selections: ExecutableTargetSelection[],
): Promise<ConsoleNavigation> {
  const prompts = groupConfigPrompts(
    (await Promise.all(selections.map((selection) => buildConfigPromptForSelection(context, item, selection))))
      .filter((prompt): prompt is ConsoleRequiredConfigPrompt => prompt !== null),
  );
  const outcomes = await applyConfigPrompts(context, prompts, false);
  if (!outcomes) {
    return 'back';
  }

  const lines = outcomes.flatMap((outcome) => [
    `${outcome.prompt.pluginName} · ${configScopeLabel(outcome.scope)}`,
    `更新字段：${outcome.updatedKeys.length > 0 ? outcome.updatedKeys.join('、') : '无'}`,
    `清空字段：${outcome.removedKeys.length > 0 ? outcome.removedKeys.join('、') : '无'}`,
    artifactRefreshLine(outcome.artifactRefreshStatus),
  ]);
  await maybeHandleConfigRefreshFailure(context, item, selections[0]!.location, outcomes);
  return showResultPage(context, {
    pluginName: item.summary.pluginName,
    title: `${item.summary.title} 配置`,
    lines,
    item,
    focusLocations: selections.map((selection) => selection.location),
  });
}

async function runInstallLikeAction(options: {
  context: CliExecutionContext;
  item: ConsoleControllerItem;
  selections: ExecutableTargetSelection[];
  intent: 'install' | 'upgrade' | 'repairInstall';
}): Promise<ConsoleNavigation> {
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
  const graphPlan = intent === 'repairInstall' || selectedPlatforms.length === 1
    ? null
    : await planConsoleGraphWriteTargets({
        operation: intent,
        targets: prepared.targets,
        platforms: selectedPlatforms,
        cwd: context.cwd,
        scope: firstLocation.scope,
        ledger: prepared.ledger,
        env: context.env,
      });
  const skillTargets = graphPlan
    ? graphPlan.requestedTargets.map((entry) => ({ target: entry.target, platform: entry.platform }))
    : prepared.targets.map((target) => ({ target, platform: firstLocation.platform }));
  const requestedSkillTrigger = await selectSkillTriggerForTargets(context, skillTargets);

  const decision = await createInstallWizardDecision({
    intent,
    ...(intent === 'repairInstall'
      ? { repairOperation: repairInstallOperation(firstLocation) }
      : {}),
    targets: graphPlan
      ? graphPlan.writeTargets.map((entry) => entry.target)
      : prepared.targets,
    scopedTargets: graphPlan?.writeTargets,
    platforms: selectedPlatforms,
    cwd: context.cwd,
    scope: firstLocation.scope,
    env: context.env,
    resolvedInstallOptions: graphPlan
      ? graphPlan.writeTargets
        .map((entry) => entry.resolvedInstallOptions
          ? {
              platform: entry.platform,
              pluginName: entry.target.pluginName,
              options: entry.resolvedInstallOptions,
            }
          : null)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      : [{
          platform: firstLocation.platform,
          pluginName: item.summary.pluginName,
          options: requestedSkillTrigger
            ? {
                applicability: 'overridable',
                skillTriggerPreference: requestedSkillTrigger,
                skillTriggerSource: 'cli',
                ledgerTrust: prepared.ledger.ledgerState.status === 'available' ? 'available' : 'degraded',
              }
            : {
                applicability: 'fixed',
                ledgerTrust: prepared.ledger.ledgerState.status === 'available' ? 'available' : 'degraded',
              },
        }],
  });

  if (decision.blockedReason) {
    await renderView(context, `${item.summary.title} 无法继续`, [
      decision.blockedReason.message,
      '',
      ...decision.blockedReason.nextSteps.map((step) => `- ${step}`),
    ]);
    return 'back';
  }

  if (decision.configPrompts.length > 0) {
    const outcomes = await applyConfigPrompts(context, decision.configPrompts, true);
    if (!outcomes) {
      return 'back';
    }
  }

  const commandOptions = {
    cwd: context.cwd,
    scope: firstLocation.scope,
    ...(requestedSkillTrigger ? { requestedSkillTrigger } : {}),
  };
  const outcomes: ConsoleExecutionOutcome[] = [];
  for (const selection of selections) {
    try {
      if (decision.commandAction === 'upgrade') {
        const result = await upgradeCommand([item.summary.pluginName], {
          ...commandOptions,
          platform: selection.location.platform,
        }, context);
        outcomes.push({
          selection,
          status: 'succeeded',
          lines: commandResultLines('upgrade', selection.location.scope, result),
        });
        continue;
      }

      const result = await installCommand([item.summary.pluginName], {
        ...commandOptions,
        platform: selection.location.platform,
      }, context);
      outcomes.push({
        selection,
        status: 'succeeded',
        lines: commandResultLines('install', selection.location.scope, result, {
          headlineVariant: 'reinstall',
        }),
      });
    } catch (error) {
      outcomes.push(createFailedExecutionOutcome(selection, error));
    }
  }

  return showExecutionOutcomePage(
    context,
    item,
    `${item.summary.title} ${decision.commandAction === 'upgrade' ? '升级' : '安装'}`,
    outcomes,
  );
}

async function promptRemoveConfigSelection(
  context: CliExecutionContext,
  message: string,
): Promise<boolean | null> {
  const choice = await selectValue(context, {
    message,
    choices: [
      { value: 'keep', label: '保留配置' },
      { value: 'remove', label: '同时删除配置' },
      { value: 'remove-config-back', label: '返回', role: 'back' },
    ],
    defaultValue: 'keep',
  });
  if (promptCancelled(choice)) {
    return null;
  }
  return selectedPromptValue(choice) === 'remove';
}

async function runUninstallAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selections: ExecutableTargetSelection[],
): Promise<ConsoleNavigation> {
  const removeConfig = await promptRemoveConfigSelection(context, '配置处理');
  if (removeConfig === null) {
    return 'back';
  }
  const configGroups = buildCleanupExecutionSelections(context, item, selections);
  const outcomes: ConsoleExecutionOutcome[] = [];
  for (const group of configGroups) {
    for (const selection of group.selections) {
      try {
        const result = await uninstallCommand([item.summary.pluginName], {
          cwd: context.cwd,
          scope: selection.location.scope,
          platform: selection.location.platform,
          removeConfig: false,
        }, context);
        outcomes.push({
          selection,
          status: 'succeeded',
          lines: commandResultLines('uninstall', selection.location.scope, result),
        });
      } catch (error) {
        outcomes.push(createFailedExecutionOutcome(selection, error));
      }
    }
  }

  return showExecutionOutcomePage(
    context,
    item,
    `${item.summary.title} 卸载`,
    await applyGroupedConfigRemoval(context, item, configGroups, outcomes, removeConfig),
  );
}

async function runCleanupActionInternal(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selections: ExecutableTargetSelection[],
  options: RunCleanupActionOptions,
): Promise<ConsoleNavigation> {
  const removeConfig = options.promptRemoveConfig === false
    ? false
    : await promptRemoveConfigSelection(context, '配置处理');
  if (removeConfig === null) {
    return 'back';
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
      const needsForce = !plan.payload.dependencyIndex && (
        plan.payload.forceReason !== null ||
        plan.payload.blockingReasons.length > 0
      );
      planOutcomes.push({
        ...configured,
        status: 'planned',
        needsForce,
        lines: renderCleanupReceipt({
          payload: plan.payload,
          warnings: plan.warnings,
        }),
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

  if (planOutcomes.length > 0) {
    await renderView(context, options.riskTitle, renderCleanupPlanOutcomeLines(planOutcomes));
  }

  if (executablePlans.length === 0) {
    return showExecutionOutcomePage(
      context,
      item,
      options.resultTitle,
      await applyGroupedConfigRemoval(
        context,
        item,
        configGroups,
        planOutcomes.map((outcome) => ({
          selection: outcome.selection,
          status: 'failed',
          lines: outcome.lines,
          diagnoseDescription: outcome.lines[0],
        })),
        removeConfig,
      ),
    );
  }

  const requiresRiskConfirmation = executablePlans.some((outcome) => outcome.needsForce);
  if (!options.preConfirmed || requiresRiskConfirmation) {
    const confirmed = await confirmValue(
      context,
      requiresRiskConfirmation
        ? `确定继续处理这 ${executablePlans.length} 个清理目标吗？`
        : `确定清理这 ${executablePlans.length} 个目标吗？`,
      false,
    );
    if (!confirmed) {
      await renderView(context, `${item.summary.title}`, ['已取消，本次没有写入任何状态。']);
      return 'back';
    }
  }

  const outcomes: ConsoleExecutionOutcome[] = planOutcomes
    .filter((outcome) => outcome.status === 'failed')
    .map((outcome) => ({
      selection: outcome.selection,
      status: 'failed',
      lines: outcome.lines,
      diagnoseDescription: outcome.lines[0],
    }));

  for (const planned of executablePlans) {
    try {
      const result = await cleanupCommand([item.summary.pluginName], {
        cwd: context.cwd,
        scope: planned.selection.location.scope,
        platform: planned.selection.location.platform,
        force: planned.needsForce,
        removeConfig: false,
      }, context);
      const lines = renderCleanupReceipt({
        payload: result.payload,
        warnings: result.warnings,
      });
      const failed = isCleanupExecutionFailure(result.payload);
      outcomes.push({
        selection: planned.selection,
        status: failed ? 'failed' : 'succeeded',
        lines,
        ...(failed ? { diagnoseDescription: lines[0] ?? 'cleanup 执行失败。' } : {}),
      });
    } catch (error) {
      outcomes.push(createFailedExecutionOutcome(planned.selection, error));
    }
  }

  return showExecutionOutcomePage(
    context,
    item,
    options.resultTitle,
    await applyGroupedConfigRemoval(context, item, configGroups, outcomes, removeConfig),
  );
}

async function runCleanupAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selections: ExecutableTargetSelection[],
): Promise<ConsoleNavigation> {
  return runCleanupActionInternal(context, item, selections, {
    resultTitle: `${item.summary.title} 清理`,
    riskTitle: `${item.summary.title} 清理风险`,
  });
}

async function runResolveDuplicateInstallAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selections: ExecutableTargetSelection[],
): Promise<ConsoleNavigation> {
  return runCleanupActionInternal(context, item, selections, {
    resultTitle: `${item.summary.title} 处理重复安装`,
    riskTitle: `${item.summary.title} 重复安装处理风险`,
    promptRemoveConfig: false,
    preConfirmed: true,
  });
}

async function runRepairAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selections: ExecutableTargetSelection[],
): Promise<ConsoleNavigation> {
  const outcomes: ConsoleExecutionOutcome[] = [];
  for (const selection of selections) {
    try {
      const result = await repairCommand([item.summary.pluginName], {
        cwd: context.cwd,
        scope: selection.location.scope,
        platform: selection.location.platform,
      }, context);
      outcomes.push({
        selection,
        status: 'succeeded',
        lines: [result.output.trim() || '修复完成。'],
      });
    } catch (error) {
      outcomes.push(createFailedExecutionOutcome(selection, error));
    }
  }
  return showExecutionOutcomePage(context, item, `${item.summary.title} 修复`, outcomes);
}

async function runReinstallAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selections: ExecutableTargetSelection[],
): Promise<ConsoleNavigation> {
  const outcomes: ConsoleExecutionOutcome[] = [];
  for (const selection of selections) {
    try {
      const result = await reinstallCommand([item.summary.pluginName], {
        cwd: context.cwd,
        scope: selection.location.scope,
        platform: selection.location.platform,
      }, context);
      outcomes.push({
        selection,
        status: 'succeeded',
        lines: commandResultLines('install', selection.location.scope, result, {
          headlineVariant: 'reinstall',
        }),
      });
    } catch (error) {
      outcomes.push(createFailedExecutionOutcome(selection, error));
    }
  }
  return showExecutionOutcomePage(context, item, `${item.summary.title} 重新安装`, outcomes);
}

async function runAdoptExistingAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selection: ExecutableTargetSelection,
): Promise<ConsoleNavigation> {
  try {
    const result = await repairCommand([item.summary.pluginName], {
      cwd: context.cwd,
      scope: selection.location.scope,
      platform: selection.location.platform,
      adoptExisting: true,
    }, context);
    return showExecutionOutcomePage(context, item, `${item.summary.title} 认领现有安装`, [{
      selection,
      status: 'succeeded',
      lines: [result.output.trim() || '认领完成。'],
    }]);
  } catch (error) {
    return showExecutionOutcomePage(context, item, `${item.summary.title} 认领现有安装`, [
      createFailedExecutionOutcome(selection, error),
    ]);
  }
}

async function runTakeoverSharedRuntimeAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  selection: ExecutableTargetSelection,
): Promise<ConsoleNavigation> {
  try {
    const result = await repairCommand([item.summary.pluginName], {
      cwd: context.cwd,
      scope: selection.location.scope,
      platform: selection.location.platform,
      takeoverSharedRuntime: true,
    }, context);
    return showExecutionOutcomePage(context, item, `${item.summary.title} 接管共享触发策略`, [{
      selection,
      status: 'succeeded',
      lines: [result.output.trim() || '接管完成。'],
    }]);
  } catch (error) {
    return showExecutionOutcomePage(context, item, `${item.summary.title} 接管共享触发策略`, [
      createFailedExecutionOutcome(selection, error),
    ]);
  }
}

async function runReapplyAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  location: PluginConsoleLocation,
): Promise<ConsoleNavigation> {
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
  const receipt = await reapplyConfigRefresh({
    plugin: target.currentPlugin ?? target.plugin,
    commandScope: location.scope,
    cwd: context.cwd,
    env: context.env,
  });
  const lines = receipt.status === 'succeeded'
    ? ['相关项目文件已更新。']
    : receipt.status === 'skipped'
      ? ['没有需要重新应用的项目文件。']
      : ['重新应用配置失败。你可以进入诊断查看原因。'];
  return showResultPage(context, {
    pluginName: item.summary.pluginName,
    title: `${item.summary.title} 重新应用配置`,
    lines,
    item,
    focusLocations: [location],
  });
}

async function runDiagnoseAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  location: PluginConsoleLocation | undefined,
  action?: { command?: string[] },
): Promise<void> {
  const result = await diagnoseCommand([item.summary.pluginName], {
    cwd: context.cwd,
    ...(location ? {
      scope: location.scope,
      platform: location.platform,
    } : {}),
  }, context);
  const page = result.pageModels.find((entry) => entry.pluginName === item.summary.pluginName);
  const lines = page
    ? renderDiagnosePageLines(page, location?.locationLabel, action?.command)
    : action?.command
      ? [`当前入口命令：${action.command.join(' ')}`]
      : ['当前没有可展示的结构化诊断信息。'];
  await renderView(context, `${item.summary.title} 诊断`, lines);
}

async function runStatusAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
): Promise<void> {
  await renderView(context, `${item.summary.title} 状态`, renderStatusPageLines(item));
}

async function loadResultPageItem(
  context: CliExecutionContext,
  pluginName: string,
): Promise<ConsoleControllerItem | undefined> {
  const homeState = await loadConsoleHomeState(context);
  return homeState.items.find((entry) => entry.summary.pluginName === pluginName);
}

async function showResultPage(
  context: CliExecutionContext,
  state: ConsoleResultPageState,
): Promise<ConsoleNavigation> {
  const reloadedItem = await loadResultPageItem(context, state.pluginName) ?? state.item;
  const diagnoseTargets = collectResultDiagnoseTargets(
    reloadedItem,
    state.focusLocations,
    state.diagnoseTargets,
  );

  while (true) {
    await renderView(context, state.title, joinNonEmpty([
      ...state.lines,
      ...(diagnoseTargets.length > 0 ? ['', '可继续查看目标诊断。'] : []),
    ]));
    const selection = await selectValue(context, {
      message: '下一步',
      choices: [
        ...diagnoseTargets.map((target) => ({
          value: buildTargetChoiceValue(target.location),
          label: `诊断 · ${target.location.locationLabel}`,
          description: target.description ?? target.location.issueSummary ?? target.location.statusLabel,
        })),
        { value: 'result-home', label: '返回首页', role: 'back' },
        { value: 'result-exit', label: '退出', role: 'exit' },
      ],
      defaultValue: diagnoseTargets[0]
        ? buildTargetChoiceValue(diagnoseTargets[0].location)
        : 'result-home',
    });
    if (isPromptAction(selection, 'exit')) {
      return 'exit';
    }
    if (isPromptAction(selection, 'back') || isPromptAction(selection, 'cancel')) {
      return 'reload';
    }
    const selected = selectedPromptValue(selection);
    if (!selected) {
      return 'reload';
    }
    const target = diagnoseTargets.find((entry) => buildTargetChoiceValue(entry.location) === selected);
    if (!target || !reloadedItem) {
      return 'reload';
    }
    await runDiagnoseAction(
      context,
      reloadedItem,
      target.location,
      target.command ? { command: target.command } : undefined,
    );
  }
}

async function handleExecutableAction(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  featureKind: PluginConsoleFeatureKind,
  executableActions: ExecutableTargetSelection[],
): Promise<ConsoleNavigation> {
  const firstAction = executableActions[0]?.action;
  if (firstAction?.destructive && firstAction.kind !== 'runCleanup') {
    const confirmed = await confirmDestructiveAction(context, item, firstAction, executableActions);
    if (!confirmed) {
      await renderView(context, `${item.summary.title}`, ['已取消，本次没有写入任何状态。']);
      return 'back';
    }
  }

  if (firstAction?.kind === 'openStatus') {
    await runStatusAction(context, item);
    return 'back';
  }
  if (firstAction?.kind === 'openDiagnose') {
    await runDiagnoseAction(context, item, undefined, undefined);
    return 'back';
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
        return runConfigWizardAction(context, item, executableActions);
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
          : 'back';
      }
      case 'runAdoptExisting':
        return runAdoptExistingAction(context, item, executableActions[0]!);
      case 'runTakeoverSharedRuntime':
        return runTakeoverSharedRuntimeAction(context, item, executableActions[0]!);
      case 'runReapplyConfigRefresh':
        return runReapplyAction(context, item, location);
      case 'runReinstall':
        return runReinstallAction(context, item, executableActions);
      case 'runRepair':
        return runRepairAction(context, item, executableActions);
      default:
        throw new Error(`Unsupported console action "${firstAction.kind}".`);
    }
  } catch (error) {
    return showResultPage(context, {
      pluginName: item.summary.pluginName,
      title: `${item.summary.title} 执行失败`,
      lines: [
        error instanceof Error ? error.message : String(error),
        '你可以进入诊断查看原因。',
      ],
      item,
      focusLocations: executableActions.map((selection) => selection.location),
      diagnoseTargets: executableActions.map((selection) => ({
        location: selection.location,
        description: formatErrorMessage(error),
      })),
    });
  }
}

async function browseFeature(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
  featureKind: PluginConsoleFeatureKind,
): Promise<ConsoleNavigation> {
  const executableActions = createPluginConsoleExecutableActions(item, featureKind);
  const feature = item.summary.features.find((entry) => entry.kind === featureKind);
  const enabledActions = executableActions.filter((actionEntry) => !actionEntry.disabledReason);

  if (enabledActions.length === 0) {
    if (feature?.disabledReason) {
      await renderView(context, `${item.summary.title} · ${feature.label}`, [feature.disabledReason]);
    }
    return 'back';
  }

  if (feature?.targetSelection === 'none') {
    return handleExecutableAction(context, item, featureKind, [{
      action: enabledActions[0]!,
      location: item.locations[0]!,
    }]);
  }

  const selections = await selectExecutableTargets(context, item, featureKind, enabledActions);
  if (!selections || selections.length === 0) {
    return 'back';
  }
  return handleExecutableAction(context, item, featureKind, selections);
}

async function browseItem(
  context: CliExecutionContext,
  item: ConsoleControllerItem,
): Promise<ConsoleNavigation> {
  while (true) {
    await renderView(context, item.summary.title, renderDetailLines(item));
    const featureValue = await selectValue(context, {
      message: '选择功能',
      choices: buildFeatureChoices(item),
      defaultValue: item.summary.features[0]?.kind,
    });
    if (isPromptAction(featureValue, 'back') || isPromptAction(featureValue, 'cancel')) {
      return 'back';
    }
    if (isPromptAction(featureValue, 'exit')) {
      return 'exit';
    }
    const result = await browseFeature(
      context,
      item,
      selectedPromptValue(featureValue) as PluginConsoleFeatureKind,
    );
    if (result !== 'back') {
      return result;
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
  while (true) {
    const homeState = await loadConsoleHomeState(context);
    if (homeState.items.length === 0) {
      await renderView(context, 'AW 控制台', [
        '当前没有可展示的插件。',
        '可以先运行 `aw status` 检查当前环境。',
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
    const item = homeState.items.find((entry) => entry.summary.pluginName === selectedPromptValue(selection));
    if (!item) {
      continue;
    }
    const result = await browseItem(context, item);
    if (result === 'exit') {
      return 0;
    }
  }
}
