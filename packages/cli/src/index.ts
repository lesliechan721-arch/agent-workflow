#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError } from 'commander';

import { initCommand } from './commands/init.js';
import { installCommand } from './commands/install.js';
import {
  createCliExecutionContext,
  emitCommandEvent,
  validateCliConfigPromptResult,
  type CliExecutionContext,
  type CliExecutionContextInput,
  type CliIo,
  type CommandDiagnosticsInput,
} from './commands/runtime.js';
import { statusCommand } from './commands/status.js';
import { uninstallCommand } from './commands/uninstall.js';
import { upgradeCommand } from './commands/upgrade.js';
import {
  createInteractiveInstallPlan,
  createInteractiveUninstallPlan,
  createInteractiveUpgradePlan,
} from './commands/interactive.js';
import {
  resolveConfigReadResolution,
  resolveConfigWriteScope,
  normalizeCommandOptions,
  normalizeInstallCommandOptions,
  normalizeStatusCommandOptions,
  normalizeUpgradeCommandOptions,
  parseSkillTriggerPreference,
} from './commands/options.js';
import {
  type CatalogResolution,
  CommandWarningError,
  type GeneratedArtifact,
  isCommandWarningError,
  type NativePluginsByPlatform,
  type SkippedUpgradeTarget,
} from './types.js';
import { formatWarnings } from './output/reporter.js';
import { resolveAwHome, resolveCliPackageRoot } from './utils/paths.js';
import { resolveCatalogPlugins } from './utils/plugin-catalog.js';
import {
  assertSafePluginConfigSegment,
  coercePluginConfigValue,
  coercePluginConfigUpdates,
  patchPluginConfigStore,
  readPluginConfigStore,
  renderPluginConfigValueForDisplay,
  resetPluginConfigStore,
  resolveEffectivePluginConfig,
  summarizeEffectivePluginConfig,
  type PluginConfigIssue,
} from './utils/plugin-config.js';
import type { PluginManifestSource, Scope } from './types.js';

export type { CliIo } from './commands/runtime.js';
export { parseSkillTriggerPreference } from './commands/options.js';

export type CliRuntimeOptions = CliExecutionContextInput;

function createDefaultIo(): CliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  };
}

function writeLine(write: (text: string) => void, line: string): void {
  write(`${line}\n`);
}

function writeWarnings(write: (text: string) => void, warnings: string[]): void {
  for (const warning of formatWarnings(warnings)) {
    writeLine(write, warning);
  }
}

function resolveCliVersion(): string {
  const packageJsonPath = path.join(resolveCliPackageRoot(), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== 'string' || packageJson.version.trim().length === 0) {
    throw new Error('Unable to resolve @yiliang/aw version from package.json.');
  }
  return packageJson.version;
}

interface CliMarketplaceReceipt {
  rootDir: string;
  changed: boolean;
  mode?: 'readOnly' | 'runtimeWritable';
  catalog: CatalogResolution;
}

function mergeMarketplaceReceipts(
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

function mergeCommandResults(
  results: Array<{
    platforms: string[];
    plugins: string[];
    warnings: string[];
    skipped?: SkippedUpgradeTarget[];
    nativePlugins?: NativePluginsByPlatform;
    repoManagedArtifacts?: GeneratedArtifact[];
    marketplace?: CliMarketplaceReceipt;
  }>,
): {
  platforms: string[];
  plugins: string[];
  warnings: string[];
  skipped: SkippedUpgradeTarget[];
  nativePlugins: NativePluginsByPlatform;
  repoManagedArtifacts: GeneratedArtifact[];
  marketplace?: CliMarketplaceReceipt;
} {
  const nativePlugins: NativePluginsByPlatform = {};
  const repoManagedArtifacts: GeneratedArtifact[] = [];
  const repoManagedArtifactKeys = new Set<string>();
  for (const result of results) {
    for (const [platform, pluginNames] of Object.entries(result.nativePlugins ?? {}) as Array<[keyof NativePluginsByPlatform, string[] | undefined]>) {
      if (!pluginNames || pluginNames.length === 0) {
        continue;
      }
      nativePlugins[platform] ??= [];
      for (const pluginName of pluginNames) {
        if (!nativePlugins[platform].includes(pluginName)) {
          nativePlugins[platform].push(pluginName);
        }
      }
    }
    for (const artifact of result.repoManagedArtifacts ?? []) {
      const key = [
        artifact.platform,
        artifact.kind,
        artifact.path,
        artifact.artifactKey ?? '',
      ].join('\0');
      if (repoManagedArtifactKeys.has(key)) {
        continue;
      }
      repoManagedArtifactKeys.add(key);
      repoManagedArtifacts.push(artifact);
    }
  }

  return {
    platforms: [...new Set(results.flatMap((result) => result.platforms))],
    plugins: [...new Set(results.flatMap((result) => result.plugins))],
    warnings: results.flatMap((result) => result.warnings),
    skipped: results.flatMap((result) => result.skipped ?? []),
    nativePlugins,
    repoManagedArtifacts,
    marketplace: mergeMarketplaceReceipts(results),
  };
}

interface CliCommandResult {
  platforms: string[];
  plugins: string[];
  warnings: string[];
  skipped?: SkippedUpgradeTarget[];
  nativePlugins?: NativePluginsByPlatform;
  repoManagedArtifacts?: GeneratedArtifact[];
  marketplace?: CliMarketplaceReceipt;
}

interface CliCommandReceipt {
  result: CliCommandResult;
  scopes: string[];
}

const PLATFORM_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
};

function formatList(values: string[]): string {
  const unique = [...new Set(values)].filter(Boolean);
  return unique.length > 0 ? unique.join(', ') : '无';
}

function formatPlatforms(platforms: string[]): string {
  return formatList(platforms.map((platform) => PLATFORM_LABELS[platform] ?? platform));
}

function formatScopes(scopes: string[]): string {
  return formatList(scopes.map((scope) => `${scope} scope`));
}

function formatCatalogReceipt(
  catalog: CatalogResolution,
  mode: CliMarketplaceReceipt['mode'] = 'runtimeWritable',
): string {
  if (catalog.source === 'local') {
    return mode === 'readOnly'
      ? `本地插件目录（${catalog.rootDir}）`
      : `本地 marketplace（${catalog.rootDir}）`;
  }

  return `embedded catalog（${catalog.rootDir}${catalog.reason ? `，${catalog.reason}` : ''}）`;
}

function formatCodexProjectArtifactSurfaces(
  artifacts: GeneratedArtifact[] | undefined,
): string | undefined {
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

function repoManagedReceiptVerb(action: 'install' | 'uninstall' | 'upgrade'): string {
  return action === 'install'
    ? '已写入'
    : action === 'uninstall'
      ? '已清理'
      : '已刷新';
}

function commandVerb(action: 'install' | 'uninstall' | 'upgrade'): string {
  return action === 'install' ? '已安装' : action === 'uninstall' ? '已卸载' : '已升级';
}

function commandNoun(action: 'install' | 'uninstall' | 'upgrade'): string {
  return action === 'install' ? '安装' : action === 'uninstall' ? '卸载' : '升级';
}

function writeCommandReceipt(
  write: (text: string) => void,
  action: 'install' | 'uninstall' | 'upgrade',
  receipt: CliCommandReceipt,
  context: CliExecutionContext,
): void {
  const { result, scopes } = receipt;
  const awHome = resolveAwHome(context.env);
  const firstPlugin = result.plugins[0];
  const pluginList = formatList(result.plugins);
  const platformList = formatPlatforms(result.platforms);
  const scopeList = formatScopes(scopes);
  const skipped = result.skipped ?? [];

  if (action === 'upgrade' && result.plugins.length === 0 && skipped.length > 0) {
    writeLine(
      write,
      `未升级任何插件，已跳过 ${skipped.length} 个目标：${formatPlatforms(result.platforms)} / ${scopeList}。`,
    );
  } else {
    writeLine(write, `${commandVerb(action)} ${pluginList}：${platformList} / ${scopeList}。`);
  }

  if (action === 'install' || action === 'upgrade') {
    if (result.marketplace) {
      writeLine(write, `使用插件目录：${formatCatalogReceipt(result.marketplace.catalog, result.marketplace.mode)}。`);
      if (result.marketplace.catalog.source === 'local' && result.marketplace.mode !== 'readOnly') {
        writeLine(
          write,
          `${result.marketplace.changed ? '已同步' : '已复用'}本地 marketplace：${result.marketplace.rootDir}。`,
        );
      }
    }
    const codexNativePlugins = result.nativePlugins?.codex ?? [];
    if (codexNativePlugins.length > 0) {
      writeLine(write, `已确认 Codex marketplace 注册：${awHome}。`);
      writeLine(
        write,
        `已通过 Codex app-server 完成原生插件安装并确认启用：${codexNativePlugins.map((plugin) => `${plugin}@aw`).join(', ')}。`,
      );
    }
    if ((result.nativePlugins?.claude ?? []).length > 0) {
      writeLine(write, `已确认 Claude Code marketplace 和插件状态。`);
    }
    const codexProjectArtifacts = formatCodexProjectArtifactSurfaces(result.repoManagedArtifacts);
    if (codexProjectArtifacts) {
      writeLine(write, `${repoManagedReceiptVerb(action)} Codex project repo-managed artifacts：${codexProjectArtifacts}。`);
    }
  } else {
    const codexProjectArtifacts = formatCodexProjectArtifactSurfaces(result.repoManagedArtifacts);
    if (codexProjectArtifacts) {
      writeLine(write, `${repoManagedReceiptVerb(action)} Codex project repo-managed artifacts：${codexProjectArtifacts}。`);
    } else {
      writeLine(write, '已清理匹配的受管状态和生成产物。');
    }
  }

  const platformFlag = result.platforms.length === 1 ? ` -p ${result.platforms[0]}` : '';
  const statusTarget = firstPlugin ? ` ${firstPlugin}` : '';
  if (action === 'upgrade' && skipped.length > 0) {
    writeLine(write, `已跳过 ${skipped.length} 个目标：`);
    for (const entry of skipped) {
      writeLine(
        write,
        `- ${PLATFORM_LABELS[entry.platform] ?? entry.platform} / ${entry.scope} scope / ${entry.plugin} [${entry.code}] ${entry.reason}`,
      );
    }
  }
  writeLine(
    write,
    `完成。下一步：运行 aw status${statusTarget}${platformFlag} 查看${commandNoun(action)}后的状态。`,
  );
}

function resolveCommandReceiptExitCode(
  action: 'install' | 'uninstall' | 'upgrade',
  result: CliCommandResult,
): number {
  if (action === 'upgrade' && result.plugins.length === 0 && (result.skipped?.length ?? 0) > 0) {
    return 1;
  }

  return 0;
}

interface RawDiagnosticsOptions {
  verbose?: boolean;
  debug?: boolean;
  logFile?: string;
  interactive?: boolean;
}

interface RawConfigOptions extends RawDiagnosticsOptions {
  scope?: string;
  json?: boolean;
  valueJson?: boolean;
  yes?: boolean;
}

function toCliDiagnosticsOptions(
  commandName: string,
  rawOptions: RawDiagnosticsOptions,
  runtimeDiagnostics: CommandDiagnosticsInput | undefined,
): CommandDiagnosticsInput {
  return {
    ...runtimeDiagnostics,
    commandName,
    verbose: runtimeDiagnostics?.verbose === true || rawOptions.verbose === true,
    debug: runtimeDiagnostics?.debug === true || rawOptions.debug === true,
    logFile: rawOptions.logFile ?? runtimeDiagnostics?.logFile,
  };
}

function shouldCreateInteractiveInstallPlan(
  pluginNames: string[],
  options: { platform: string; requestedSkillTrigger?: unknown },
  context: CliExecutionContext,
  forcePrompt: boolean,
): boolean {
  if (forcePrompt) {
    return true;
  }
  if (!context.interactive) {
    return false;
  }
  if (pluginNames.length === 0 || options.platform === 'auto') {
    return true;
  }

  return !options.requestedSkillTrigger &&
    typeof context.prompt.selectSkillTrigger === 'function';
}

function shouldCreateInteractiveExistingPlan(
  pluginNames: string[],
  context: CliExecutionContext,
  forcePrompt: boolean,
): boolean {
  return forcePrompt || (context.interactive && pluginNames.length === 0);
}

async function runActionWithContext<T>(
  context: CliExecutionContext,
  action: () => Promise<T>,
): Promise<T> {
  await emitCommandEvent(context, {
    type: 'command:start',
    data: {
      cwd: context.cwd,
      verbose: context.diagnostics.verbose,
      debug: context.diagnostics.debug,
      logFile: context.diagnostics.logFile,
    },
  });
  try {
    const result = await action();
    await emitCommandEvent(context, { type: 'command:success' });
    await context.debugLogger.flush?.();
    if (context.diagnostics.debug && context.debugLogger.logFile) {
      writeLine(context.io.stderr, `调试日志：${context.debugLogger.logFile}`);
    }
    return result;
  } catch (error) {
    await emitCommandEvent(context, {
      type: 'command:error',
      message: error instanceof Error ? error.message : String(error),
      data: error instanceof Error
        ? {
            name: error.name,
            stack: error.stack,
          }
        : undefined,
    });
    await context.debugLogger.flush?.();
    if (context.diagnostics.debug && context.debugLogger.logFile) {
      writeLine(context.io.stderr, `调试日志：${context.debugLogger.logFile}`);
    }
    throw error;
  }
}

async function loadConfigManifest(
  pluginName: string,
  context: CliExecutionContext,
): Promise<PluginManifestSource> {
  assertSafePluginConfigSegment(pluginName);
  let plugins: Awaited<ReturnType<typeof resolveCatalogPlugins>>['plugins'];
  try {
    ({ plugins } = await resolveCatalogPlugins([pluginName], context.env));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === `Unknown plugin "${pluginName}".`) {
      throw new Error(
        `${message} Cannot read schema-aware config without a current catalog entry. ` +
          `Use \`aw config reset ${pluginName} -s user --yes\` or ` +
          `\`aw config reset ${pluginName} -s project --yes\` to clean leftover config stores.`,
      );
    }
    throw error;
  }
  const manifest = plugins[0].manifest;
  if (!manifest.config?.schema) {
    throw new Error(`Plugin "${pluginName}" does not declare an AW config schema.`);
  }
  return manifest;
}

function writeJsonReceipt(write: (text: string) => void, payload: unknown): void {
  writeLine(write, JSON.stringify(payload, null, 2));
}

function formatConfigIssueRepairHint(
  pluginName: string,
  issue: PluginConfigIssue,
): string {
  const sourceScope = issue.source === 'user' || issue.source === 'project'
    ? ` -s ${issue.source}`
    : '';
  const setCommand = `aw config set ${pluginName} ${issue.key} <value>${sourceScope}`;

  if (issue.type === 'invalid-config' && sourceScope) {
    return [
      `可运行 \`${setCommand}\` 重新写入`,
      `\`aw config unset ${pluginName} ${issue.key}${sourceScope}\` 删除该值`,
      `或 \`aw config reset ${pluginName}${sourceScope}\` 清空这一层配置`,
    ].join('，');
  }

  return `可运行 \`${setCommand}\` 写入有效值。`;
}

function formatConfigIssues(
  pluginName: string,
  issues: PluginConfigIssue[],
): string[] {
  return issues.map((issue) => [
    `${issue.key}: ${issue.type} - ${issue.message}`,
    `修复建议：${formatConfigIssueRepairHint(pluginName, issue)}`,
  ].join('。'));
}

function writeConfigList(
  write: (text: string) => void,
  pluginName: string,
  resolved: Awaited<ReturnType<typeof resolveEffectivePluginConfig>>,
): void {
  for (const [key, field] of Object.entries(resolved.schema)) {
    const source = resolved.sources[key] ?? 'missing';
    const configured = source === 'user' || source === 'project';
    const required = field.required ? 'required' : 'optional';
    const fromDefault = source === 'default' ? ', default' : '';
    writeLine(write, `${key}: ${source}${configured ? ', configured' : ''}, ${required}${fromDefault}`);
  }
  if (resolved.issues.length > 0) {
    writeLine(write, `配置存在问题：${formatConfigIssues(pluginName, resolved.issues).join('；')}`);
  }
}

function writeConfigGet(
  write: (text: string) => void,
  pluginName: string,
  resolved: Awaited<ReturnType<typeof resolveEffectivePluginConfig>>,
  key?: string,
): void {
  if (key) {
    if (!resolved.schema[key]) {
      throw new Error(`Unknown config key "${key}".`);
    }
    const value = resolved.redactedValues[key];
    writeLine(write, value === undefined ? '' : renderPluginConfigValueForDisplay(value));
  } else {
    for (const [entryKey, value] of Object.entries(resolved.redactedValues)) {
      writeLine(write, `${entryKey}=${renderPluginConfigValueForDisplay(value)}`);
    }
  }
  if (resolved.issues.length > 0) {
    writeLine(write, `配置存在问题：${formatConfigIssues(pluginName, resolved.issues).join('；')}`);
  }
}

async function resolveConfigForRead(options: {
  pluginName: string;
  manifest: PluginManifestSource;
  scopeOrEffective: Scope | 'effective';
  context: CliExecutionContext;
}) {
  const resolved = await resolveEffectivePluginConfig({
    pluginName: options.pluginName,
    manifest: options.manifest,
    cwd: options.context.cwd,
    env: options.context.env,
  });

  if (options.scopeOrEffective === 'effective') {
    return resolved;
  }

  const scopedStore = resolved.stores[options.scopeOrEffective];
  const scopedValues: Record<string, string | number | boolean> = {};
  const scopedRedactedValues: Record<string, string | number | boolean | '[redacted]'> = {};
  const scopedSources: Record<string, Scope | 'default' | 'missing'> = {};
  const scopedIssues = [];
  for (const [key, field] of Object.entries(resolved.schema)) {
    scopedSources[key] = 'missing';
    if (field.default !== undefined) {
      try {
        const coerced = await coercePluginConfigValue({
          key,
          field,
          value: field.default,
          projectRoot: resolved.projectRoot,
        });
        scopedValues[key] = coerced;
        scopedRedactedValues[key] = field.sensitive ? '[redacted]' : coerced;
        scopedSources[key] = 'default';
      } catch (error) {
        scopedIssues.push({
          type: 'invalid-config' as const,
          key,
          source: 'default' as const,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (Object.hasOwn(scopedStore.values, key)) {
      scopedSources[key] = options.scopeOrEffective;
      try {
        const coerced = await coercePluginConfigValue({
          key,
          field,
          value: scopedStore.values[key],
          projectRoot: resolved.projectRoot,
        });
        scopedValues[key] = coerced;
        scopedRedactedValues[key] = field.sensitive ? '[redacted]' : coerced;
      } catch (error) {
        delete scopedValues[key];
        delete scopedRedactedValues[key];
        scopedIssues.push({
          type: 'invalid-config' as const,
          key,
          source: options.scopeOrEffective,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (field.required && scopedValues[key] === undefined) {
      scopedIssues.push({
        type: 'missing-required' as const,
        key,
        source: scopedSources[key],
        message: `Config "${key}" is required.`,
      });
    }
  }

  return {
    ...resolved,
    values: scopedValues,
    redactedValues: scopedRedactedValues,
    sources: scopedSources,
    issues: scopedIssues,
    ignoredUnknownKeys: resolved.ignoredUnknownKeys.filter((entry) => entry.scope === options.scopeOrEffective),
  };
}

export function buildProgram(options: CliRuntimeOptions = {}): Command {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const commandExitState = { exitCode: 0 };
  const io = {
    ...createDefaultIo(),
    ...options.io,
  };

  const createActionContext = (
    commandName: string,
    rawOptions: RawDiagnosticsOptions,
  ): CliExecutionContext =>
    createCliExecutionContext({
      ...options,
      cwd,
      env,
      io,
      interactive: rawOptions.interactive ?? options.interactive,
      diagnostics: toCliDiagnosticsOptions(commandName, rawOptions, options.diagnostics),
    });

  const program = new Command();
  program
    .name('aw')
    .description('Agent workflow marketplace installer')
    .version(resolveCliVersion(), '-V, --version', 'output the current aw cli version')
    .exitOverride()
    .configureOutput({
      writeOut: (text) => io.stdout(text),
      writeErr: (text) => io.stderr(text),
      outputError: (text, write) => write(text),
    });

  program
    .command('init')
    .option('-f, --force', 'refresh the local marketplace bundle', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (rawOptions: { force?: boolean } & RawDiagnosticsOptions) => {
      const context = createActionContext('init', rawOptions);
      const result = await runActionWithContext(context, () =>
        initCommand({ force: rawOptions.force, env: context.env }),
      );
      writeLine(
        io.stdout,
        `${result.changed ? 'Initialized' : 'Reused'} local marketplace at ${result.rootDir}.`,
      );
      writeWarnings(io.stderr, result.warnings);
    });

  program
    .command('install')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user', 'user')
    .option('-p, --platform <platform>', 'codex | claude | both | auto', 'auto')
    .option('-t, --skill-trigger <preference>', 'default | manual | auto', parseSkillTriggerPreference)
    .option('--script-timeout <ms>', 'override plugin lifecycle script timeout in milliseconds')
    .option('-i, --interactive', 'prompt for missing install choices')
    .option('--no-interactive', 'disable interactive prompts')
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(
      async (
        plugins: string[],
        rawOptions: {
          scope?: string;
          platform?: string;
          skillTrigger?: string;
          scriptTimeout?: string;
        } & RawDiagnosticsOptions,
      ) => {
        const context = createActionContext('install', rawOptions);
        const receipt = await runActionWithContext(
          context,
          async () => {
            const commandOptions = normalizeInstallCommandOptions({
              cwd,
              ...rawOptions,
            });
            await emitCommandEvent(context, {
              type: 'options:normalized',
              data: {
                plugins: plugins ?? [],
                options: commandOptions,
              },
            });
            const forcePrompt = rawOptions.interactive === true;
            const plan = shouldCreateInteractiveInstallPlan(
              plugins ?? [],
              commandOptions,
              context,
              forcePrompt,
            )
              ? await createInteractiveInstallPlan(
                  plugins ?? [],
                  commandOptions,
                  context,
                  forcePrompt,
                )
              : null;
            if (!plan) {
              return {
                result: await installCommand(plugins ?? [], commandOptions, context),
                scopes: [commandOptions.scope],
              };
            }

            const results = [];
            for (const group of plan.groups) {
              results.push(await installCommand(group.pluginNames, group.options, context));
            }
            return {
              result: mergeCommandResults(results),
              scopes: plan.groups.map((group) => group.options.scope),
            };
          },
        );
        writeCommandReceipt(io.stdout, 'install', receipt, context);
        writeWarnings(io.stderr, receipt.result.warnings);
        commandExitState.exitCode = resolveCommandReceiptExitCode('install', receipt.result);
      },
    );

  program
    .command('uninstall')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user', 'user')
    .option('-p, --platform <platform>', 'codex | claude | both | auto', 'auto')
    .option('--script-timeout <ms>', 'override plugin lifecycle script timeout in milliseconds')
    .option('-i, --interactive', 'prompt for missing uninstall choices')
    .option('--no-interactive', 'disable interactive prompts')
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      plugins: string[],
      rawOptions: { scope?: string; platform?: string; scriptTimeout?: string } & RawDiagnosticsOptions,
    ) => {
      const context = createActionContext('uninstall', rawOptions);
      const receipt = await runActionWithContext(
        context,
        async () => {
          const commandOptions = normalizeCommandOptions({
            cwd,
            ...rawOptions,
          });
          await emitCommandEvent(context, {
            type: 'options:normalized',
            data: {
              plugins: plugins ?? [],
              options: commandOptions,
            },
          });
          const forcePrompt = rawOptions.interactive === true;
          const plan = shouldCreateInteractiveExistingPlan(
            plugins ?? [],
            context,
            forcePrompt,
          )
            ? await createInteractiveUninstallPlan(
                plugins ?? [],
                commandOptions,
                context,
                forcePrompt,
              )
            : null;
          if (!plan) {
            return {
              result: await uninstallCommand(plugins ?? [], commandOptions, context),
              scopes: [commandOptions.scope],
            };
          }

          const results = [];
          for (const group of plan.groups) {
            results.push(await uninstallCommand(group.pluginNames, group.options, context));
          }
          return {
            result: mergeCommandResults(results),
            scopes: plan.groups.map((group) => group.options.scope),
          };
        },
      );
      writeCommandReceipt(io.stdout, 'uninstall', receipt, context);
      writeWarnings(io.stderr, receipt.result.warnings);
      commandExitState.exitCode = resolveCommandReceiptExitCode('uninstall', receipt.result);
    });

  program
    .command('upgrade')
    .argument('[plugins...]')
    .option('-a, --all', 'upgrade all plugins', false)
    .option('-s, --scope <scope>', 'project or user', 'user')
    .option('-p, --platform <platform>', 'codex | claude | both | auto', 'auto')
    .option('-t, --skill-trigger <preference>', 'default | manual | auto', parseSkillTriggerPreference)
    .option('--script-timeout <ms>', 'override plugin lifecycle script timeout in milliseconds')
    .option('-i, --interactive', 'prompt for missing upgrade choices')
    .option('--no-interactive', 'disable interactive prompts')
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(
      async (
        plugins: string[],
        rawOptions: {
          all?: boolean;
          scope?: string;
          platform?: string;
          skillTrigger?: string;
          scriptTimeout?: string;
        } & RawDiagnosticsOptions,
      ) => {
        const context = createActionContext('upgrade', rawOptions);
        const receipt = await runActionWithContext(
          context,
          async () => {
            const commandOptions = normalizeUpgradeCommandOptions({
              cwd,
              ...rawOptions,
            });
            await emitCommandEvent(context, {
              type: 'options:normalized',
              data: {
                plugins: plugins ?? [],
                options: commandOptions,
              },
            });
            const forcePrompt = rawOptions.interactive === true;
            const plan = shouldCreateInteractiveExistingPlan(
              plugins ?? [],
              context,
              forcePrompt,
            )
              ? await createInteractiveUpgradePlan(
                  plugins ?? [],
                  commandOptions,
                  context,
                  forcePrompt,
                )
              : null;
            if (!plan) {
              return {
                result: await upgradeCommand(plugins ?? [], commandOptions, context),
                scopes: [commandOptions.scope],
              };
            }

            const results = [];
            for (const group of plan.groups) {
              results.push(await upgradeCommand(group.pluginNames, group.options, context));
            }
            return {
              result: mergeCommandResults(results),
              scopes: plan.groups.map((group) => group.options.scope),
            };
          },
        );
        writeCommandReceipt(io.stdout, 'upgrade', receipt, context);
        writeWarnings(io.stderr, receipt.result.warnings);
        commandExitState.exitCode = resolveCommandReceiptExitCode('upgrade', receipt.result);
      },
    );

  const config = program
    .command('config')
    .description('Manage AW plugin configuration');

  config
    .command('list')
    .argument('<plugin>')
    .option('-s, --scope <scope>', 'read only project or user config')
    .option('-j, --json', 'print config as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:list', rawOptions);
      const resolved = await runActionWithContext(context, async () => {
        const manifest = await loadConfigManifest(pluginName, context);
        return resolveConfigForRead({
          pluginName,
          manifest,
          scopeOrEffective: resolveConfigReadResolution(rawOptions.scope),
          context,
        });
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          ok: true,
          command: 'config:list',
          plugin: pluginName,
          summary: summarizeEffectivePluginConfig(resolved),
        });
      } else {
        writeConfigList(io.stdout, pluginName, resolved);
      }
    });

  config
    .command('get')
    .argument('<plugin>')
    .argument('[key]')
    .option('-s, --scope <scope>', 'read only project or user config')
    .option('-j, --json', 'print config as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string, key: string | undefined, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:get', rawOptions);
      const resolved = await runActionWithContext(context, async () => {
        const manifest = await loadConfigManifest(pluginName, context);
        const configForRead = await resolveConfigForRead({
          pluginName,
          manifest,
          scopeOrEffective: resolveConfigReadResolution(rawOptions.scope),
          context,
        });
        if (key && !configForRead.schema[key]) {
          throw new Error(`Unknown config key "${key}".`);
        }
        return configForRead;
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          ok: true,
          command: 'config:get',
          plugin: pluginName,
          key,
          summary: summarizeEffectivePluginConfig(resolved),
          value: key ? resolved.redactedValues[key] : resolved.redactedValues,
          source: key ? resolved.sources[key] : resolved.sources,
        });
      } else {
        writeConfigGet(io.stdout, pluginName, resolved, key);
      }
    });

  config
    .command('set')
    .argument('<plugin>')
    .argument('<key>')
    .argument('<value>')
    .option('-s, --scope <scope>', 'project or user')
    .option('--value-json', 'parse value as a JSON literal', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      pluginName: string,
      key: string,
      rawValue: string,
      rawOptions: RawConfigOptions,
    ) => {
      const context = createActionContext('config:set', rawOptions);
      const receipt = await runActionWithContext(context, async () => {
        const manifest = await loadConfigManifest(pluginName, context);
        const scope = resolveConfigWriteScope(rawOptions.scope);
        const inputValue = rawOptions.valueJson ? JSON.parse(rawValue) : rawValue;
        const updates = await coercePluginConfigUpdates({
          schema: manifest.config!.schema,
          updates: { [key]: inputValue },
          cwd: context.cwd,
        });
        await patchPluginConfigStore({
          pluginName,
          scope,
          cwd: context.cwd,
          env: context.env,
          updates,
        });
        const effective = await resolveEffectivePluginConfig({
          pluginName,
          manifest,
          cwd: context.cwd,
          env: context.env,
        });
        return {
          ok: true,
          command: 'config:set',
          plugin: pluginName,
          scope,
          updatedKeys: [key],
          effective: summarizeEffectivePluginConfig(effective),
        };
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, `已写入 ${receipt.plugin}.${key} (${receipt.scope})。`);
      }
    });

  config
    .command('configure')
    .argument('<plugin>')
    .option('-s, --scope <scope>', 'project or user')
    .option('-i, --interactive', 'prompt for config values')
    .option('--no-interactive', 'disable interactive prompts')
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:configure', rawOptions);
      const receipt = await runActionWithContext(context, async () => {
        if (!context.interactive || !context.prompt.configurePlugin) {
          throw new Error(
            `Interactive config is not available. Run \`aw config set ${pluginName} <key> <value>\` for each required key.`,
          );
        }
        const manifest = await loadConfigManifest(pluginName, context);
        const effective = await resolveEffectivePluginConfig({
          pluginName,
          manifest,
          cwd: context.cwd,
          env: context.env,
        });
        const explicitScope = rawOptions.scope === undefined
          ? undefined
          : resolveConfigWriteScope(rawOptions.scope);
        const allowedScopes: Scope[] = explicitScope ? [explicitScope] : ['user', 'project'];
        const promptSchema = Object.fromEntries(Object.entries(manifest.config!.schema).map(([schemaKey, field]) => [
          schemaKey,
          {
            type: field.type === 'enum' ? 'string' : field.type,
            label: field.title ?? schemaKey,
            description: field.description,
            required: field.required,
            sensitive: field.sensitive,
            default: field.default,
            enum: field.type === 'enum' ? field.values : undefined,
            min: field.min,
            max: field.max,
          },
        ]));
        const promptResult = validateCliConfigPromptResult(
          {
            allowedScopes,
            schema: promptSchema,
          },
          await context.prompt.configurePlugin({
            pluginName,
            schema: promptSchema,
            initialScope: explicitScope ?? 'user',
            allowedScopes,
            currentValues: effective.values,
            requiredKeys: effective.issues
              .filter((issue) => issue.type === 'missing-required' || issue.type === 'invalid-config')
              .map((issue) => issue.key),
          }),
        );
        if (promptResult.cancelled) {
          throw new Error(`Config setup for ${pluginName} was cancelled.`);
        }
        const scope = promptResult.selectedScope;
        if (!allowedScopes.includes(scope)) {
          throw new Error(`Unsupported config scope "${scope}".`);
        }
        const updates = await coercePluginConfigUpdates({
          schema: manifest.config!.schema,
          updates: promptResult.updates,
          cwd: context.cwd,
        });
        await patchPluginConfigStore({
          pluginName,
          scope,
          cwd: context.cwd,
          env: context.env,
          updates,
        });
        const nextEffective = await resolveEffectivePluginConfig({
          pluginName,
          manifest,
          cwd: context.cwd,
          env: context.env,
        });
        return {
          ok: true,
          command: 'config:configure',
          plugin: pluginName,
          scope,
          updatedKeys: promptResult.updatedKeys,
          effective: summarizeEffectivePluginConfig(nextEffective),
        };
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, `已更新 ${receipt.plugin} 配置 (${receipt.scope})。`);
      }
    });

  config
    .command('unset')
    .argument('<plugin>')
    .argument('<key>')
    .option('-s, --scope <scope>', 'project or user')
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string, key: string, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:unset', rawOptions);
      const receipt = await runActionWithContext(context, async () => {
        const manifest = await loadConfigManifest(pluginName, context);
        if (!manifest.config!.schema[key]) {
          throw new Error(`Unknown config key "${key}".`);
        }
        const scope = resolveConfigWriteScope(rawOptions.scope);
        const store = await readPluginConfigStore({
          pluginName,
          scope,
          cwd: context.cwd,
          env: context.env,
        });
        const existed = Object.hasOwn(store.values, key);
        await patchPluginConfigStore({
          pluginName,
          scope,
          cwd: context.cwd,
          env: context.env,
          updates: {},
          removeKeys: [key],
        });
        const effective = await resolveEffectivePluginConfig({
          pluginName,
          manifest,
          cwd: context.cwd,
          env: context.env,
        });
        return {
          ok: true,
          command: 'config:unset',
          plugin: pluginName,
          scope,
          removedKey: key,
          existed,
          effective: summarizeEffectivePluginConfig(effective),
        };
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, receipt.existed
          ? `已删除 ${receipt.plugin}.${receipt.removedKey} (${receipt.scope})。`
          : `${receipt.plugin}.${receipt.removedKey} (${receipt.scope}) 原本不存在。`);
      }
    });

  config
    .command('reset')
    .argument('<plugin>')
    .option('-s, --scope <scope>', 'project or user')
    .option('-i, --interactive', 'prompt for confirmation')
    .option('--no-interactive', 'disable interactive prompts')
    .option('-y, --yes', 'confirm destructive reset', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:reset', rawOptions);
      const receipt = await runActionWithContext(context, async () => {
        assertSafePluginConfigSegment(pluginName);
        const scope = resolveConfigWriteScope(rawOptions.scope);
        const store = await readPluginConfigStore({
          pluginName,
          scope,
          cwd: context.cwd,
          env: context.env,
        });
        if (store.exists && !rawOptions.yes) {
          if (!context.interactive || !context.prompt.confirm) {
            throw new Error(
              `Reset requires confirmation. Re-run \`aw config reset ${pluginName} -s ${scope} --yes\` to delete this store.`,
            );
          }
          const confirmed = await context.prompt.confirm({
            message: `Delete ${scope} config for ${pluginName}?`,
            defaultValue: false,
          });
          if (!confirmed) {
            throw new Error(`Config reset for ${pluginName} was cancelled.`);
          }
        }
        const reset = await resetPluginConfigStore({
          pluginName,
          scope,
          cwd: context.cwd,
          env: context.env,
        });
        return {
          ok: true,
          command: 'config:reset',
          plugin: pluginName,
          scope,
          existed: reset.existed,
          deleted: reset.deleted,
        };
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, receipt.deleted
          ? `已重置 ${receipt.plugin} 的 ${receipt.scope} 配置。`
          : `${receipt.plugin} 没有可重置的 ${receipt.scope} 配置。`);
      }
    });

  program
    .command('status')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'filter by scope')
    .option('-p, --platform <platform>', 'filter by platform')
    .option('-v, --verbose', 'show status details and command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .option('-j, --json', 'print status as JSON', false)
    .action(async (
      plugins: string[],
      rawOptions: {
        scope?: string;
        platform?: string;
        json?: boolean;
      } & RawDiagnosticsOptions,
    ) => {
      const context = createActionContext('status', rawOptions);
      const result = await runActionWithContext(
        context,
        () => statusCommand(
          plugins ?? [],
          normalizeStatusCommandOptions({
            cwd,
            ...rawOptions,
          }),
          context,
        ),
      );
      writeLine(io.stdout, result.output);
    });

  Object.assign(program, { __awCommandExitState: commandExitState });
  return program;
}

function handleCliError(
  error: unknown,
  writeError: (text: string) => void,
): number {
  if (error instanceof CommanderError) {
    return error.exitCode;
  }

  if (isCommandWarningError(error)) {
    writeWarnings(writeError, error.warnings);
    writeLine(writeError, error.message);
    return error.exitCode;
  }

  writeLine(writeError, error instanceof Error ? error.message : String(error));
  return 1;
}

export async function runCli(
  argv: string[],
  options: CliRuntimeOptions = {},
): Promise<number> {
  const io = {
    ...createDefaultIo(),
    ...options.io,
  };

  try {
    const program = buildProgram({
      ...options,
      io,
      diagnostics: {
        ...options.diagnostics,
        metadata: {
          ...options.diagnostics?.metadata,
          rawArgv: argv,
        },
      },
    });
    await program.parseAsync(['node', 'aw', ...argv]);
    return (program as Command & {
      __awCommandExitState?: { exitCode: number };
    }).__awCommandExitState?.exitCode ?? 0;
  } catch (error) {
    return handleCliError(error, io.stderr);
  }
}

export async function main(
  argv = process.argv.slice(2),
  options: CliRuntimeOptions = {},
): Promise<number> {
  return runCli(argv, options);
}

const currentEntryPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (invokedPath === currentEntryPath) {
  void main().then((exitCode) => {
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  });
}
