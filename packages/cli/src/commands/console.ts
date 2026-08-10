import type {
  CliExecutionContext,
  CliPromptChoice,
  CliPromptResult,
} from './runtime.js';
import {
  loadConsoleItemsResult,
  type LiveConsoleItem,
  type LiveStatusState,
  type LiveStatusTarget,
} from './status.js';
import {
  cleanupWriteCommand,
  installWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  upgradeWriteCommand,
} from './write-commands.js';
import { resolveConfigRead } from '../utils/plugin-config.js';
import {
  applyPluginConfigWrite,
  resetPluginConfigWithHelper,
} from '../utils/plugin-config-write.js';

function statePriority(state: LiveStatusState): number {
  switch (state) {
    case 'error': return 3;
    case 'partial': return 2;
    case 'present': return 1;
    case 'absent': return 0;
  }
}

function itemState(item: LiveConsoleItem): LiveStatusState {
  return [...item.targets]
    .sort((left, right) => statePriority(right.state) - statePriority(left.state))[0]?.state
    ?? 'absent';
}

function stateLabel(state: LiveStatusState): string {
  switch (state) {
    case 'present': return '已就绪';
    case 'absent': return '未安装';
    case 'partial': return '不完整';
    case 'error': return '检查失败';
  }
}

function targetLabel(target: LiveStatusTarget): string {
  return `${target.target.platform}/${target.target.scope} · ${stateLabel(target.state)}`;
}

async function render(
  context: CliExecutionContext,
  title: string,
  lines: string[],
): Promise<void> {
  await context.consoleDriver.render({ title, lines });
}

function requireSelect(context: CliExecutionContext) {
  if (!context.prompt.select) throw new Error('当前交互运行时不支持选择菜单。');
  return context.prompt.select.bind(context.prompt);
}

function selected(result: CliPromptResult<string>): string | undefined {
  return result.action === 'select' && !result.cancelled ? result.value : undefined;
}

function targetKey(target: LiveStatusTarget): string {
  return `${target.target.plugin}\0${target.target.platform}\0${target.target.scope}`;
}

function targetLines(target: LiveStatusTarget): string[] {
  const lines = [
    `位置：${target.target.platform}/${target.target.scope}`,
    `状态：${stateLabel(target.state)}`,
    `组件：${target.components.length}`,
  ];
  for (const error of target.errors) lines.push(`错误：${error.message}`);
  if (target.recommendation) lines.push(`建议：${target.recommendation.command}`);
  return lines;
}

function configApplyLines(receipt: {
  overallState: string;
  targetResults: Array<{
    target: { platform: string; scope: string };
    state: string;
    message?: string;
  }>;
  applySkippedReason?: string;
}): string[] {
  const lines = receipt.targetResults.map((entry) =>
    `应用：${entry.target.platform}/${entry.target.scope}: ${entry.state}`
    + (entry.message ? ` · ${entry.message}` : ''));
  if (receipt.applySkippedReason === 'noVisibleTarget') {
    lines.push('应用：未发现可重装的当前目标；配置只保存，不会安装插件。');
  } else if (receipt.applySkippedReason) {
    lines.push(`应用：已跳过（${receipt.applySkippedReason}）。`);
  }
  if (receipt.overallState === 'failed') {
    lines.push('应用结果：failed。配置已写入；请修复失败目标后重试配置操作。');
  } else if (lines.length > 0) {
    lines.push(`应用结果：${receipt.overallState}。`);
  }
  return lines;
}

function actionChoices(item: LiveConsoleItem, target: LiveStatusTarget): CliPromptChoice[] {
  const choices: CliPromptChoice[] = [];
  if (target.state === 'absent') {
    choices.push({ value: 'install', label: '安装' });
  }
  if (target.state === 'present' || target.state === 'partial') {
    choices.push({ value: 'reinstall', label: '重装' });
  }
  if (target.state === 'present') {
    choices.push(
      { value: 'upgrade', label: '升级' },
      { value: 'uninstall', label: '卸载' },
    );
  }
  if (target.state !== 'absent') {
    choices.push({ value: 'cleanup', label: '清理' });
  }
  if (item.plugin?.manifest.config?.schema) {
    choices.push({
      value: 'config',
      label: target.state === 'absent' ? '配置（不会安装此目标）' : '配置',
    });
  }
  choices.push(
    { value: 'reload', label: '刷新状态' },
    { value: 'back', label: '返回', role: 'back' },
    { value: 'exit', label: '退出', role: 'exit' },
  );
  return choices;
}

async function selectConfigField(
  context: CliExecutionContext,
  item: LiveConsoleItem,
  message: string,
): Promise<string | undefined> {
  const schema = item.plugin?.manifest.config?.schema;
  if (!schema) return undefined;
  const result = await requireSelect(context)({
    message,
    choices: [
      ...Object.entries(schema).map(([key, field]) => ({
        value: key,
        label: field.title ?? key,
      })),
      { value: 'back', label: '返回', role: 'back' },
    ],
  });
  const value = selected(result);
  return value === 'back' ? undefined : value;
}

async function promptConfigValue(
  context: CliExecutionContext,
  item: LiveConsoleItem,
  key: string,
): Promise<unknown> {
  const field = item.plugin?.manifest.config?.schema?.[key];
  if (!field) throw new Error(`未知配置字段 ${key}。`);
  if (field.type === 'enum' && field.values && field.values.length > 0) {
    const result = await requireSelect(context)({
      message: `设置 ${field.title ?? key}`,
      choices: field.values.map((value) => ({ value, label: value })),
    });
    return selected(result);
  }
  if (field.type === 'boolean') {
    const result = await requireSelect(context)({
      message: `设置 ${field.title ?? key}`,
      choices: [
        { value: 'true', label: 'true' },
        { value: 'false', label: 'false' },
      ],
    });
    return selected(result);
  }
  const prompt = field.sensitive ? context.prompt.password : context.prompt.input;
  if (!prompt) throw new Error('当前交互运行时不支持配置值输入。');
  const result = await prompt({
    message: `设置 ${field.title ?? key}`,
    ...(field.sensitive ? { mask: true } : {}),
  } as never);
  return result.action === 'select' && !result.cancelled ? result.value : undefined;
}

async function runConfigAction(
  context: CliExecutionContext,
  item: LiveConsoleItem,
  target: LiveStatusTarget,
): Promise<void> {
  const config = await resolveConfigRead({
    pluginName: target.target.plugin,
    plugin: item.plugin,
    scope: target.target.scope,
    projectLayer: 'shared',
    cwd: context.cwd,
    env: context.env,
  });
  await render(context, `${target.target.plugin} 配置`, [
    ...config.fields.map((field) =>
      `${field.key}: ${field.valueState}${field.sourceLayer ? ` (${field.sourceLayer})` : ''}`),
  ]);
  const operation = selected(await requireSelect(context)({
    message: '选择配置操作',
    choices: [
      { value: 'set', label: '设置字段' },
      { value: 'unset', label: '清除字段' },
      { value: 'reset', label: '重置当前层' },
      { value: 'back', label: '返回', role: 'back' },
    ],
  }));
  if (!operation || operation === 'back') return;
  if (operation === 'reset') {
    if (!context.prompt.confirm) return;
    const confirmation = await context.prompt.confirm({
      message: `确认重置 ${target.target.plugin} 的 ${target.target.scope} 配置？`,
      defaultValue: false,
    });
    if (confirmation.action !== 'select' || confirmation.value !== true) return;
    const receipt = await resetPluginConfigWithHelper({
      pluginName: target.target.plugin,
      plugin: item.plugin,
      scope: target.target.scope,
      cwd: context.cwd,
      env: context.env,
      nativeCliRunner: context.nativeCliRunner,
      rebuildRuntime: context,
    });
    await render(context, `${target.target.plugin} 配置`, [
      receipt.deleted ? '配置已重置。' : '当前层没有配置。',
      ...configApplyLines(receipt),
    ]);
    return;
  }
  const key = await selectConfigField(
    context,
    item,
    operation === 'set' ? '选择要设置的字段' : '选择要清除的字段',
  );
  if (!key) return;
  const value = operation === 'set' ? await promptConfigValue(context, item, key) : undefined;
  if (operation === 'set' && value === undefined) return;
  const receipt = await applyPluginConfigWrite({
    pluginName: target.target.plugin,
    plugin: item.plugin,
    scope: target.target.scope,
    cwd: context.cwd,
    env: context.env,
    nativeCliRunner: context.nativeCliRunner,
    rebuildRuntime: context,
    request: operation === 'set' ? { updates: { [key]: value } } : { removeKeys: [key] },
  });
  await render(context, `${target.target.plugin} 配置`, [
    operation === 'set' ? `已设置 ${key}。` : `已清除 ${key}。`,
    ...configApplyLines(receipt),
  ]);
}

async function runTargetAction(
  context: CliExecutionContext,
  item: LiveConsoleItem,
  target: LiveStatusTarget,
  action: string,
): Promise<'reload' | 'back' | 'exit'> {
  if (action === 'back') return 'back';
  if (action === 'exit') return 'exit';
  if (action === 'reload') return 'reload';
  if (action === 'config') {
    try {
      await runConfigAction(context, item, target);
    } catch (error) {
      await render(context, `${target.target.plugin} 配置`, [
        `配置读取失败：${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
    return 'back';
  }

  if (action === 'cleanup' || action === 'uninstall') {
    if (!context.prompt.confirm) return 'back';
    const confirmation = await context.prompt.confirm({
      message: action === 'uninstall'
        ? `确认卸载 ${target.target.plugin} ${target.target.platform}/${target.target.scope}？`
        : `确认清理 ${target.target.plugin} ${target.target.platform}/${target.target.scope}？`,
      defaultValue: false,
    });
    if (confirmation.action !== 'select' || confirmation.value !== true) return 'back';
  }

  const commandOptions = {
    cwd: context.cwd,
    platform: target.target.platform,
    scope: target.target.scope,
  };
  try {
    const result = action === 'install'
      ? await installWriteCommand([target.target.plugin], commandOptions, context)
      : action === 'reinstall'
        ? await reinstallWriteCommand([target.target.plugin], commandOptions, context)
        : action === 'upgrade'
          ? await upgradeWriteCommand([target.target.plugin], commandOptions, context)
          : action === 'uninstall'
            ? await uninstallWriteCommand([target.target.plugin], commandOptions, context)
            : await cleanupWriteCommand([target.target.plugin], commandOptions, context);
    await render(context, `${target.target.plugin} ${action}`, [
      `结果：${result.overallState}`,
      ...result.targetResults.map((entry) =>
        `${entry.target.platform}/${entry.target.scope}: ${entry.state}${entry.message ? ` · ${entry.message}` : ''}`),
    ]);
  } catch (error) {
    await render(context, `${target.target.plugin} ${action}`, [
      `失败：${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  return 'reload';
}

async function browseItem(
  context: CliExecutionContext,
  item: LiveConsoleItem,
): Promise<'reload' | 'back' | 'exit'> {
  const choose = requireSelect(context);
  const targetResult = await choose({
    message: `选择 ${item.pluginName} 的目标`,
    choices: [
      ...item.targets.map((target) => ({
        value: targetKey(target),
        label: targetLabel(target),
      })),
      { value: 'back', label: '返回', role: 'back' },
      { value: 'exit', label: '退出', role: 'exit' },
    ],
  });
  const value = selected(targetResult);
  if (!value || value === 'back') return 'back';
  if (value === 'exit') return 'exit';
  const target = item.targets.find((entry) => targetKey(entry) === value);
  if (!target) return 'back';
  await render(context, item.pluginName, targetLines(target));
  const actionResult = await choose({
    message: '选择操作',
    choices: actionChoices(item, target),
  });
  const action = selected(actionResult);
  if (!action) return actionResult.action === 'exit' ? 'exit' : 'back';
  return runTargetAction(context, item, target, action);
}

export function formatInteractiveConsoleUnavailableMessage(
  context: Pick<CliExecutionContext, 'isCi' | 'isTty'>,
): string {
  const reasons = [
    context.isCi ? 'CI 环境默认禁用交互控制台。' : undefined,
    !context.isTty ? '当前 stdin/stdout 不是可交互终端。' : undefined,
  ].filter(Boolean);
  return [
    '当前运行环境不可交互，不能进入 aw 控制台。',
    ...reasons,
    '',
    '可用命令：',
    '- `aw status`',
    '- `aw install <plugin> --platform codex --scope user`',
    '- `aw status --json`',
  ].join('\n');
}

export async function runConsoleController(context: CliExecutionContext): Promise<number> {
  const choose = requireSelect(context);
  while (true) {
    const loaded = await loadConsoleItemsResult({
      cwd: context.cwd,
      includeCatalogOnly: true,
    }, context);
    const catalogError = loaded.status.catalog.error?.message;
    await render(context, 'AW 控制台', [
      ...(catalogError ? [`Catalog 错误：${catalogError}`] : []),
      ...loaded.items.map((item) => `${item.pluginName}: ${stateLabel(itemState(item))}`),
    ]);
    if (loaded.items.length === 0) return loaded.catalogUnavailable ? 1 : 0;
    const result = await choose({
      message: '选择插件',
      choices: [
        ...loaded.items.map((item) => ({
          value: item.pluginName,
          label: `${item.pluginName} · ${stateLabel(itemState(item))}`,
        })),
        { value: 'exit', label: '退出', role: 'exit' },
      ],
      defaultValue: loaded.items[0]?.pluginName,
    });
    const pluginName = selected(result);
    if (!pluginName || pluginName === 'exit') return 0;
    const item = loaded.items.find((entry) => entry.pluginName === pluginName);
    if (!item) continue;
    const navigation = await browseItem(context, item);
    if (navigation === 'exit') return 0;
  }
}
