import type { Scope, SkillTriggerPreference } from '../types.js';
import type {
  CliConsoleView,
  CliExecutionContext,
  CliPromptChoice,
  CliPromptResult,
} from './runtime.js';
import {
  createInstallWizardDecision,
  type ConsoleRequiredConfigPrompt,
} from './console-wizard.js';
import {
  type PluginConsoleAction,
  type PluginConsoleItem,
  type PluginConsoleLocation,
} from './console-model.js';
import {
  preparePluginTargetsForCommand,
  type ResolvedPluginTarget,
} from './common.js';
import { installCommand } from './install.js';
import { statusCommand } from './status.js';
import { uninstallCommand } from './uninstall.js';
import { upgradeCommand } from './upgrade.js';
import { formatWarnings } from '../output/reporter.js';
import { renderCommandReceipt } from '../output/command-receipt.js';
import { resolveSkillTriggerApplicabilityForPlugin } from '../utils/skill-trigger-preferences.js';
import {
  coercePluginConfigValue,
  createPluginConfigFormModel,
  readPluginConfigStore,
  resolveEffectivePluginConfig,
  type PluginConfigFormFieldModel,
  type PluginConfigValue,
} from '../utils/plugin-config.js';
import { applyPluginConfigWrite } from '../utils/plugin-config-write.js';
import { reapplyConfigRefresh } from '../utils/artifact-refresh.js';

type ConsoleNavigation = 'back' | 'reload' | 'exit';

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

function renderView(context: CliExecutionContext, title: string, lines: string[]): Promise<unknown> {
  const view: CliConsoleView = { title, lines };
  return Promise.resolve(context.consoleDriver.render(view));
}

function joinNonEmpty(lines: Array<string | undefined>): string[] {
  return lines.filter((line): line is string => Boolean(line && line.trim() !== ''));
}

function promptCancelled<T>(result: CliPromptResult<T>): boolean {
  return result.cancelled || result.value === undefined;
}

async function selectValue(
  context: CliExecutionContext,
  options: {
    message: string;
    choices: CliPromptChoice[];
    defaultValue?: string;
    pageSize?: number;
  },
): Promise<string | null> {
  const result = await context.prompt.select!({
    ...options,
    pageSize: options.pageSize ?? Math.min(Math.max(options.choices.length, 6), 12),
  });
  return promptCancelled(result) ? null : result.value!;
}

async function confirmValue(
  context: CliExecutionContext,
  message: string,
  defaultValue = false,
): Promise<boolean> {
  const result = await context.prompt.confirm!({ message, defaultValue });
  return !promptCancelled(result) && result.value === true;
}

function buildHomeChoices(items: PluginConsoleItem[]): CliPromptChoice[] {
  return [
    ...items.map((item) => ({
      value: item.pluginName,
      label: `${item.title} · ${item.statusLabel}`,
      description: `${item.locationSummary}${item.description ? ` · ${item.description}` : ''}`,
      short: item.title,
    })),
    { value: '__exit', label: '退出' },
  ];
}

function buildLocationChoices(item: PluginConsoleItem): CliPromptChoice[] {
  return [
    ...item.locations.map((location) => ({
      value: `${location.platform}:${location.scope}:${location.projectKey ?? '-'}`,
      label: `${location.locationLabel} · ${location.statusLabel}`,
      description: location.issueSummary ?? location.nextSteps[0] ?? '',
      short: location.locationLabel,
    })),
    { value: '__back', label: '返回' },
  ];
}

function buildActionChoices(location: PluginConsoleLocation): CliPromptChoice[] {
  return [
    ...location.actions.map((action) => ({
      value: action.kind,
      label: action.label,
      description: action.disabledReason ?? action.command?.join(' ') ?? '',
      short: action.label,
      disabled: action.disabledReason,
    })),
    { value: '__back', label: '返回' },
  ];
}

function findLocation(
  item: PluginConsoleItem,
  value: string,
): PluginConsoleLocation | undefined {
  return item.locations.find((location) =>
    `${location.platform}:${location.scope}:${location.projectKey ?? '-'}` === value,
  );
}

function findAction(
  location: PluginConsoleLocation,
  value: string,
): PluginConsoleAction | undefined {
  return location.actions.find((action) => action.kind === value);
}

async function loadConsoleItems(context: CliExecutionContext): Promise<PluginConsoleItem[]> {
  const result = await statusCommand([], {
    cwd: context.cwd,
  }, context);
  return result.consoleItems;
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

function commandResultLines(
  command: 'install' | 'uninstall' | 'upgrade',
  scope: Scope,
  result: Parameters<typeof renderCommandReceipt>[1]['result'],
): string[] {
  return renderResultWithWarnings(
    renderCommandReceipt(command, {
      result,
      groups: [{
        scope,
        platforms: result.platforms,
        plugins: result.plugins,
      }],
    }),
    result.warnings,
  );
}

function renderItemLines(item: PluginConsoleItem): string[] {
  return joinNonEmpty([
    `状态：${item.statusLabel}`,
    `位置：${item.locationSummary}`,
    item.description ? `说明：${item.description}` : undefined,
    item.issueSummary ? `原因：${item.issueSummary}` : undefined,
    ...(item.detailHints ?? []).map((hint) => `- ${hint}`),
    ...(item.nextSteps.length > 0 ? ['', '下一步：', ...item.nextSteps.map((step) => `- ${step}`)] : []),
  ]);
}

function renderLocationLines(location: PluginConsoleLocation): string[] {
  return joinNonEmpty([
    `状态：${location.statusLabel}`,
    `位置：${location.locationLabel}`,
    location.issueSummary ? `原因：${location.issueSummary}` : undefined,
    ...(location.detailHints ?? []).map((hint) => `- ${hint}`),
    ...(location.nextSteps.length > 0 ? ['', '下一步：', ...location.nextSteps.map((step) => `- ${step}`)] : []),
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
      { value: '__back', label: '返回' },
    ],
    defaultValue: 'default',
  });
  if (value === null || value === '__back') {
    return null;
  }
  return value as SkillTriggerPreference;
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
    if (selected === null || (!required && selected === '__skip')) {
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
      value: selected,
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
    if (selected === null || (!required && selected === '__skip')) {
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
      value: selected === 'true',
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
          { value: '__back', label: '返回' },
        ],
        defaultValue: form.initialScope,
      })
    : form.initialScope;
  if (chosenScope === null || chosenScope === '__back') {
    return null;
  }

  const scope = chosenScope as Scope;
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
    const needsFix = form.requiredKeys.includes(field.key) || Boolean(state.issueMessage);
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
            { value: '__back', label: '返回' },
          ],
          defaultValue: 'keep',
        })
      : await selectValue(context, {
          message: field.label,
          choices: [
            { value: 'skip', label: '跳过' },
            { value: 'set', label: '设置' },
            { value: '__back', label: '返回' },
          ],
          defaultValue: 'skip',
        });
    if (action === null || action === '__back') {
      return null;
    }
    if (action === 'keep' || action === 'skip') {
      continue;
    }
    if (action === 'clear') {
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
  const chosenScope = form.allowedScopes.length > 1
    ? await selectValue(context, {
        message: `选择 ${prompt.pluginName} 配置写入位置`,
        choices: [
          { value: 'user', label: '个人' },
          { value: 'project', label: '当前项目' },
          { value: '__back', label: '返回' },
        ],
        defaultValue: form.initialScope,
      })
    : form.initialScope;
  if (chosenScope === null || chosenScope === '__back') {
    return null;
  }

  const scope = chosenScope as Scope;
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

async function runConfigWizardAction(
  context: CliExecutionContext,
  item: PluginConsoleItem,
  location: PluginConsoleLocation,
): Promise<boolean> {
  const targets = await preparePluginTargetsForCommand(
    context.cwd,
    location.scope,
    [item.pluginName],
    {
      catalogMode: 'readOnly',
      allowHistoricalFallback: true,
      env: context.env,
    },
  );
  const target = targets.targets[0];
  if (!target) {
    throw new Error(`无法加载 ${item.pluginName} 的当前 catalog 信息。`);
  }

  const submission = await promptFullConfigSubmission(context, target, location.scope);
  if (!submission) {
    return false;
  }
  const receipt = await applyPluginConfigWrite({
    plugin: target.currentPlugin ?? target.plugin,
    pluginName: item.pluginName,
    scope: submission.scope,
    cwd: context.cwd,
    env: context.env,
    request: {
      updates: submission.updates,
      removeKeys: submission.removeKeys,
    },
  });
  const lines = [
    `已保存 ${item.pluginName} 的${submission.scope === 'user' ? '个人' : '当前项目'}配置。`,
    `更新字段：${receipt.updatedKeys.length > 0 ? receipt.updatedKeys.join('、') : '无'}`,
    `清空字段：${receipt.removedKeys.length > 0 ? receipt.removedKeys.join('、') : '无'}`,
    `artifact refresh：${receipt.artifactRefresh.status}`,
  ];
  if (receipt.artifactRefresh.status === 'failed' && receipt.artifactRefresh.error) {
    lines.push(`失败原因：${receipt.artifactRefresh.error}`);
  }
  await renderView(context, `${item.title} 配置`, lines);
  return true;
}

async function runInstallLikeAction(options: {
  context: CliExecutionContext;
  item: PluginConsoleItem;
  defaultLocation: PluginConsoleLocation;
  intent: 'install' | 'upgrade' | 'repairInstall';
}): Promise<boolean> {
  const { context, item, defaultLocation, intent } = options;
  const installableLocations = item.locations.filter((location) =>
    location.actions.some((action) =>
      action.kind === 'openInstallWizard' ||
      action.kind === 'runUpgrade' ||
      action.kind === 'repairInstall',
    ),
  );
  const platformValue = installableLocations.length > 1
    ? await selectValue(context, {
        message: '选择目标平台',
        choices: [
          ...Array.from(new Set(installableLocations.map((location) => location.platform))).map((platform) => ({
            value: platform,
            label: platform === 'codex' ? 'Codex' : 'Claude Code',
          })),
          { value: '__back', label: '返回' },
        ],
        defaultValue: defaultLocation.platform,
      })
    : defaultLocation.platform;
  if (platformValue === null || platformValue === '__back') {
    return false;
  }

  const scopedLocations = installableLocations.filter((location) => location.platform === platformValue);
  const locationValue = scopedLocations.length > 1
    ? await selectValue(context, {
        message: '选择安装位置',
        choices: [
          ...scopedLocations.map((location) => ({
            value: `${location.platform}:${location.scope}:${location.projectKey ?? '-'}`,
            label: location.scope === 'user' ? '个人' : '当前项目',
            description: location.issueSummary ?? '',
          })),
          { value: '__back', label: '返回' },
        ],
        defaultValue: `${defaultLocation.platform}:${defaultLocation.scope}:${defaultLocation.projectKey ?? '-'}`,
      })
    : `${scopedLocations[0].platform}:${scopedLocations[0].scope}:${scopedLocations[0].projectKey ?? '-'}`;
  if (locationValue === null || locationValue === '__back') {
    return false;
  }
  const selectedLocation = scopedLocations.find((location) =>
    `${location.platform}:${location.scope}:${location.projectKey ?? '-'}` === locationValue,
  ) ?? defaultLocation;

  const prepared = await preparePluginTargetsForCommand(
    context.cwd,
    selectedLocation.scope,
    [item.pluginName],
    {
      catalogMode: 'readOnly',
      allowHistoricalFallback: false,
      env: context.env,
    },
  );
  const target = prepared.targets[0];
  if (!target) {
    throw new Error(`无法加载 ${item.pluginName}。`);
  }
  const requestedSkillTrigger = await selectSkillTrigger(
    context,
    target,
    selectedLocation.platform,
  );
  if (
    requestedSkillTrigger === null &&
    await resolveSkillTriggerApplicabilityForPlugin(target.currentPlugin ?? target.plugin, selectedLocation.platform) === 'overridable'
  ) {
    return false;
  }

  const decision = await createInstallWizardDecision({
    intent,
    repairOperation: defaultLocation.status === 'upgradeAvailable' ? 'upgrade' : 'install',
    targets: prepared.targets,
    platforms: [selectedLocation.platform],
    cwd: context.cwd,
    scope: selectedLocation.scope,
    env: context.env,
    resolvedInstallOptions: [{
      platform: selectedLocation.platform,
      pluginName: item.pluginName,
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
    await renderView(context, `${item.title} 无法继续`, [
      decision.blockedReason.message,
      '',
      ...decision.blockedReason.nextSteps.map((step) => `- ${step}`),
    ]);
    return false;
  }

  for (const prompt of decision.configPrompts) {
    const submission = await promptRequiredConfigSubmission(context, prompt);
    if (!submission) {
      return false;
    }
    await applyPluginConfigWrite({
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
  }

  const commandOptions = {
    cwd: context.cwd,
    scope: selectedLocation.scope,
    platform: selectedLocation.platform,
    ...(requestedSkillTrigger ? { requestedSkillTrigger } : {}),
  };

  if (decision.commandAction === 'upgrade') {
    const result = await upgradeCommand([item.pluginName], commandOptions, context);
    await renderView(context, `${item.title} 升级`, commandResultLines('upgrade', selectedLocation.scope, result));
    return true;
  }

  const result = await installCommand([item.pluginName], commandOptions, context);
  await renderView(context, `${item.title} 安装`, commandResultLines('install', selectedLocation.scope, result));
  return true;
}

async function runUninstallAction(
  context: CliExecutionContext,
  item: PluginConsoleItem,
  location: PluginConsoleLocation,
): Promise<boolean> {
  const result = await uninstallCommand([item.pluginName], {
    cwd: context.cwd,
    scope: location.scope,
    platform: location.platform,
  }, context);
  await renderView(context, `${item.title} 卸载`, commandResultLines('uninstall', location.scope, result));
  return true;
}

async function runReapplyAction(
  context: CliExecutionContext,
  item: PluginConsoleItem,
  location: PluginConsoleLocation,
): Promise<boolean> {
  const prepared = await preparePluginTargetsForCommand(
    context.cwd,
    location.scope,
    [item.pluginName],
    {
      catalogMode: 'readOnly',
      allowHistoricalFallback: true,
      env: context.env,
    },
  );
  const target = prepared.targets[0];
  if (!target) {
    throw new Error(`无法加载 ${item.pluginName}。`);
  }
  const receipt = await reapplyConfigRefresh({
    plugin: target.currentPlugin ?? target.plugin,
    commandScope: location.scope,
    cwd: context.cwd,
    env: context.env,
  });
  const lines = [
    `artifact refresh：${receipt.status}`,
    ...(receipt.status === 'skipped'
      ? ['没有需要重新应用的项目文件']
      : []),
    ...(receipt.error ? [`失败原因：${receipt.error}`] : []),
  ];
  await renderView(context, `${item.title} 重新应用配置`, lines);
  return receipt.status !== 'skipped';
}

async function runDiagnoseAction(
  context: CliExecutionContext,
  item: PluginConsoleItem,
  location: PluginConsoleLocation,
  action: PluginConsoleAction,
): Promise<void> {
  const result = await statusCommand([item.pluginName], {
    cwd: context.cwd,
    scope: location.scope,
    platform: location.platform,
    verbose: true,
  }, context);
  const lines = action.command
    ? [`可复制命令：${action.command.join(' ')}`, '', ...result.output.split('\n')]
    : result.output.split('\n');
  await renderView(context, `${item.title} 诊断`, lines);
}

async function handleAction(
  context: CliExecutionContext,
  item: PluginConsoleItem,
  location: PluginConsoleLocation,
  action: PluginConsoleAction,
): Promise<ConsoleNavigation> {
  if (action.destructive) {
    const confirmed = await confirmValue(
      context,
      action.confirmText ?? `确定执行 ${action.label} 吗？`,
      false,
    );
    if (!confirmed) {
      await renderView(context, `${item.title}`, ['已取消，本次没有写入任何状态。']);
      return 'back';
    }
  }

  switch (action.kind) {
    case 'openInstallWizard':
      return await runInstallLikeAction({
        context,
        item,
        defaultLocation: location,
        intent: 'install',
      }) ? 'reload' : 'back';
    case 'runUpgrade':
      return await runInstallLikeAction({
        context,
        item,
        defaultLocation: location,
        intent: 'upgrade',
      }) ? 'reload' : 'back';
    case 'repairInstall':
      return await runInstallLikeAction({
        context,
        item,
        defaultLocation: location,
        intent: 'repairInstall',
      }) ? 'reload' : 'back';
    case 'openConfigWizard':
      return await runConfigWizardAction(context, item, location) ? 'reload' : 'back';
    case 'runUninstall':
    case 'cleanupRecovery':
      return await runUninstallAction(context, item, location) ? 'reload' : 'back';
    case 'reapplyConfigRefresh':
      return await runReapplyAction(context, item, location) ? 'reload' : 'back';
    case 'diagnoseCommand':
      await runDiagnoseAction(context, item, location, action);
      return 'back';
    case 'back':
      return 'back';
    default:
      throw new Error(`Unsupported console action "${action.kind}".`);
  }
}

async function browseLocation(
  context: CliExecutionContext,
  item: PluginConsoleItem,
  location: PluginConsoleLocation,
): Promise<ConsoleNavigation> {
  while (true) {
    await renderView(context, `${item.title} · ${location.locationLabel}`, renderLocationLines(location));
    const actionValue = await selectValue(context, {
      message: '选择操作',
      choices: buildActionChoices(location),
      defaultValue: location.actions[0]?.kind,
    });
    if (actionValue === null || actionValue === '__back') {
      return 'back';
    }
    const action = findAction(location, actionValue);
    if (!action) {
      continue;
    }
    const result = await handleAction(context, item, location, action);
    if (result === 'reload') {
      return 'reload';
    }
  }
}

async function browseItem(
  context: CliExecutionContext,
  item: PluginConsoleItem,
): Promise<ConsoleNavigation> {
  while (true) {
    await renderView(context, item.title, renderItemLines(item));
    if (item.locations.length === 1) {
      const result = await browseLocation(context, item, item.locations[0]);
      if (result !== 'back') {
        return result;
      }
      return 'back';
    }
    const locationValue = await selectValue(context, {
      message: '选择位置',
      choices: buildLocationChoices(item),
      defaultValue: `${item.locations[0].platform}:${item.locations[0].scope}:${item.locations[0].projectKey ?? '-'}`,
    });
    if (locationValue === null || locationValue === '__back') {
      return 'back';
    }
    const location = findLocation(item, locationValue);
    if (!location) {
      continue;
    }
    const result = await browseLocation(context, item, location);
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
    const items = await loadConsoleItems(context);
    if (items.length === 0) {
      await renderView(context, 'AW 控制台', [
        '当前没有可展示的插件。',
        '可以先运行 `aw status` 检查当前环境。',
      ]);
      return 0;
    }
    const selection = await selectValue(context, {
      message: '选择插件',
      choices: buildHomeChoices(items),
      defaultValue: items[0]?.pluginName,
    });
    if (selection === null || selection === '__exit') {
      return 0;
    }
    const item = items.find((entry) => entry.pluginName === selection);
    if (!item) {
      continue;
    }
    const result = await browseItem(context, item);
    if (result === 'exit') {
      return 0;
    }
  }
}
