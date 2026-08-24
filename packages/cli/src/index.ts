#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError, Option } from 'commander';

import { initCommand } from './commands/init.js';
import {
  addCatalogSourceCommand,
  explicitRefPolicy,
  listCatalogSources,
  removeCatalogSourceCommand,
  setPrimaryCatalogSourceCommand,
  updateCatalogSourceCommand,
  type CatalogSourceMutationReceipt,
} from './commands/catalog-source.js';
import {
  cleanupWriteCommand as cleanupCommand,
  installWriteCommand as installCommand,
  reinstallWriteCommand as reinstallCommand,
  uninstallWriteCommand as uninstallCommand,
  upgradeWriteCommand as upgradeCommand,
} from './commands/write-commands.js';
import type { RebuildCommandResult } from './commands/rebuild-command.js';
import {
  formatInteractiveConsoleUnavailableMessage,
  runConsoleController,
} from './commands/console.js';
import {
  runCommandWizard,
  toWizardCandidates,
  WizardExecutionError,
  type CommandWizardCommand,
  type CommandWizardPluginCandidate,
  type CommandWizardSelection,
} from './commands/wizard.js';
import {
  createCliExecutionContext,
  emitCommandEvent,
  type CliExecutionContext,
  type CliExecutionContextInput,
  type CliIo,
  type CommandDiagnosticsInput,
} from './commands/runtime.js';
import { loadConsoleItemsResult } from './commands/status.js';
import { statusCommandV4 } from './commands/status-v4.js';
import {
  normalizeUninstallCommandOptions,
  normalizeCleanupCommandOptions,
  resolveConfigReadResolution,
  resolveConfigProjectLayer,
  resolveConfigWriteScope,
  normalizeInstallCommandOptions,
  normalizeReinstallCommandOptions,
  normalizeUpgradeCommandOptions,
} from './commands/options.js';
import {
  isCommandWarningError,
} from './types.js';
import { formatWarnings } from './output/reporter.js';
import { redactString, redactValue } from './output/redact.js';
import {
  renderShellCommand,
} from './output/equivalent-command.js';
import {
  buildRebuildReceiptJson,
  buildInitReceiptJson,
  renderRebuildReceipt,
  renderInitReceipt,
  type CliCommandResult,
} from './output/command-receipt.js';
import { resolveCliPackageRoot } from './utils/paths.js';
import {
  coercePluginConfigUpdates,
  findConfigFieldEntry,
  listNamespacedPluginConfigStores,
  listPluginConfigStorePluginNames,
  readPluginConfigStore,
  renderPluginConfigValueForDisplay,
  resolveConfigRead,
} from './utils/plugin-config.js';
import {
  applyPluginConfigWrite,
  describeResetAffectedFields,
  resetPluginConfigWithHelper,
} from './utils/plugin-config-write.js';
import { assertStrictSemVer } from './utils/manifest.js';
import { writeCandidateEligibility } from './utils/target-eligibility.js';
import {
  assertCatalogSourceReferencesSupported,
  inventoryLegacyConfigReferences,
} from './utils/catalog-source-references.js';
import {
  parsePluginId,
  withResolvedCatalogPlugin,
  withResolvedMultiSourceCatalog,
  type ResolvedCatalogPlugin,
} from './utils/multi-source-catalog.js';
import { sanitizeCatalogSourceError } from './utils/catalog-public-error.js';
import {
  formatConfigCommandValue,
  parseConfigValue,
} from './utils/config-value.js';
import {
  withAwHomeMutationLock,
  type AwHomeMutationToken,
} from './utils/aw-home-mutation-lock.js';
import type {
  ConfigFieldEntry,
  PlatformSelection,
  PluginConfigSchemaField,
  Scope,
} from './types.js';
import {
  installPortableSkills,
  materializePortableSkillsToDirectory,
  PortableCommandError,
  renderPortableReview,
} from './portable/commands.js';
import { SkillsCliError } from './portable/skills-cli.js';
import {
  runCatalogBuildCommand,
  runCatalogInitCommand,
  runCatalogValidateCommand,
  runCatalogVersionCommand,
  runPluginBuildCommand,
  runPluginTestCommand,
} from './authoring/workspace-commands.js';
import { runCatalogPublishCommand } from './commands/catalog-publish.js';

export type { CliIo } from './commands/runtime.js';
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

function writeWarnings(
  write: (text: string) => void,
  warnings: string[],
  options: { actionableOnly?: boolean } = {},
): void {
  for (const warning of formatWarnings(warnings, options)) {
    writeLine(write, warning);
  }
}

function resolveCliVersion(): string {
  const packageJsonPath = path.join(resolveCliPackageRoot(), 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    version?: unknown;
  };
  return assertStrictSemVer(packageJson.version, 'packages/cli/package.json version');
}

function resolveCommandReceiptExitCode(
  result: CliCommandResult,
): number {
  if (result.overallState === 'failed') {
    return 1;
  }
  return 0;
}

interface RawDiagnosticsOptions {
  verbose?: boolean;
  debug?: boolean;
  logFile?: string;
}

interface RawConfigOptions extends RawDiagnosticsOptions {
  scope?: string;
  json?: boolean;
  valueJson?: boolean;
  yes?: boolean;
  local?: boolean;
}

async function runAuthoringScript(options: {
  scriptName: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  io: CliIo;
}): Promise<number> {
  const scriptPath = path.join(
    resolveCliPackageRoot(),
    'dist',
    'authoring',
    'scripts',
    options.scriptName,
  );
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer | string) => options.io.stdout(String(chunk)));
    child.stderr.on('data', (chunk: Buffer | string) => options.io.stderr(String(chunk)));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) {
        reject(new Error(`Plugin authoring command terminated by signal ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
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

type WriteWizardCommand = Extract<
  CommandWizardCommand,
  'install' | 'upgrade' | 'reinstall' | 'uninstall' | 'cleanup'
>;

function isWizardAvailable(
  context: CliExecutionContext,
  rawOptions: { json?: boolean },
): boolean {
  return context.interactive && context.isTty && !context.isCi && rawOptions.json !== true;
}

function shellCommand(tokens: string[]): string {
  return renderShellCommand(tokens, 'posix');
}

function optionTokens(flag: string, value: string | undefined): string[] {
  return value === undefined ? [] : [flag, value];
}

function writeCommandUsage(command: WriteWizardCommand): string {
  const cardinality = command === 'reinstall' || command === 'cleanup' ? '<plugin>' : '<plugin...>';
  const scope = command === 'cleanup' ? ' --scope <project|user>' : ' [--scope <project|user>]';
  const all = command === 'upgrade' ? ' 或 aw upgrade --all --platform both --scope user' : '';
  return [
    `${command} 命令缺少必要参数。`,
    `Usage: aw ${command} ${cardinality} --platform <codex|claude|both>${scope}`,
    `Example: aw ${command} example-plugin --platform codex --scope user${all}`,
  ].join('\n');
}

function configCommandUsage(command: 'list' | 'get' | 'set' | 'unset' | 'reset'): string {
  const argumentsByCommand = {
    list: '<plugin>',
    get: '<plugin> [key]',
    set: '<plugin> <key> <value>',
    unset: '<plugin> <key>',
    reset: '<plugin> --scope <project|user> --yes',
  } as const;
  return [
    `config ${command} 命令缺少必要参数。`,
    `Usage: aw config ${command} ${argumentsByCommand[command]}`,
    `Example: aw config ${command} example-plugin${command === 'set' ? ' key value' : command === 'unset' ? ' key' : command === 'reset' ? ' --scope user --yes' : ''}`,
  ].join('\n');
}

function assertUpgradeAllConflict(pluginNames: string[], all: boolean): void {
  if (all && pluginNames.length > 0) {
    throw new Error('upgrade 命令不能同时使用插件名和 `--all`。');
  }
}

function equivalentWriteCommand(
  command: WriteWizardCommand,
  selection: CommandWizardSelection,
  rawOptions: RawWriteWizardOptions,
): string {
  return shellCommand(buildEquivalentWriteCommandTokens(command, selection, rawOptions));
}

export function buildEquivalentWriteCommandTokens(
  command: WriteWizardCommand,
  selection: CommandWizardSelection,
  rawOptions: RawWriteWizardOptions,
): string[] {
  const all = command === 'upgrade' && rawOptions.all === true;
  return [
    'aw',
    command,
    ...(all ? ['--all'] : []),
    '--platform',
    selection.platform ?? 'both',
    '--scope',
    selection.scope ?? 'user',
    ...(command === 'cleanup' ? [] : optionTokens('--script-timeout', rawOptions.scriptTimeout)),
    ...(!all && selection.plugins.length > 0 ? ['--', ...selection.plugins] : []),
  ];
}

interface EquivalentConfigCommandOptions {
  command: 'list' | 'get' | 'set' | 'unset' | 'reset';
  plugin: string;
  key?: string;
  value?: string;
  scope?: string;
  projectLayer?: 'shared' | 'local';
  valueJson?: boolean;
  confirmed?: boolean;
}

function equivalentConfigCommand(options: EquivalentConfigCommandOptions): string {
  return shellCommand(buildEquivalentConfigCommandTokens(options));
}

function equivalentConfigCommandProjection(
  resolve: (selection: CommandWizardSelection) => EquivalentConfigCommandOptions,
): {
  equivalentCommand: (selection: CommandWizardSelection) => string;
  equivalentCommandTokens: (selection: CommandWizardSelection) => string[];
} {
  return {
    equivalentCommand: (selection) => equivalentConfigCommand(resolve(selection)),
    equivalentCommandTokens: (selection) => buildEquivalentConfigCommandTokens(resolve(selection)),
  };
}

function configSetEquivalentOptions(
  selection: CommandWizardSelection,
  candidates: CommandWizardPluginCandidate[],
  rawOptions: RawConfigOptions,
): EquivalentConfigCommandOptions {
  const field = candidates.find((entry) => entry.pluginName === selection.plugins[0])
    ?.configSchema?.[selection.key ?? ''];
  const placeholder = configFieldPlaceholder(field);
  return {
    command: 'set',
    plugin: selection.plugins[0]!,
    key: selection.key!,
    value: placeholder
      ? rawOptions.valueJson ? JSON.stringify(placeholder) : placeholder
      : formatConfigCommandValue(selection.value, rawOptions.valueJson === true),
    scope: selection.scope ?? 'user',
    projectLayer: selection.projectLayer,
    valueJson: rawOptions.valueJson,
  };
}

function configFieldPlaceholder(field: PluginConfigSchemaField | undefined): string | undefined {
  if (field?.sensitive) return '<sensitive-value>';
  if (field?.type === 'file') return '<file-path>';
  if (field?.type === 'directory') return '<directory-path>';
  return undefined;
}

export function buildEquivalentConfigCommandTokens(
  options: EquivalentConfigCommandOptions,
): string[] {
  return [
    'aw',
    'config',
    options.command,
    ...optionTokens('--scope', options.scope),
    ...(options.projectLayer === 'local' ? ['--local'] : []),
    ...(options.valueJson ? ['--value-json'] : []),
    ...(options.confirmed ? ['--yes'] : []),
    '--',
    options.plugin,
    ...(options.key === undefined ? [] : [options.key]),
    ...(options.value === undefined ? [] : [options.value]),
  ];
}

function hasSelectableWriteCandidate(
  command: WriteWizardCommand,
  candidates: CommandWizardPluginCandidate[],
  selection: CommandWizardSelection,
  options: { missingPlatform: boolean; missingScope: boolean },
): boolean {
  const platforms: PlatformSelection[] = options.missingPlatform
    ? ['codex', 'claude', 'both']
    : [selection.platform ?? 'both'];
  const scopes: Scope[] = options.missingScope ? ['user', 'project'] : [selection.scope ?? 'user'];
  return candidates.some((candidate) => platforms.some((platform) => scopes.some((scope) =>
    writeCandidateEligibility(command, candidate, { ...selection, platform, scope }).selectable)));
}

function hasConfigSchemaKeys(candidate: CommandWizardPluginCandidate): boolean {
  return candidate.configSchema !== undefined && Object.keys(candidate.configSchema).length > 0;
}

async function loadWizardCandidates(
  context: CliExecutionContext,
  rawOptions: { scope?: string; platform?: string },
): Promise<CommandWizardPluginCandidate[]> {
  const loaded = await loadConsoleItemsResult({
    cwd: context.cwd,
    scope: rawOptions.scope as Scope | undefined,
    platform: rawOptions.platform as PlatformSelection | undefined,
    includeCatalogOnly: true,
  }, context);
  return toWizardCandidates(loaded.items);
}

interface ConfigWizardStoreLocation {
  scope: Scope;
  projectLayer: 'shared' | 'local';
}

function mergeWizardCandidates(
  current: CommandWizardPluginCandidate[],
  stored: CommandWizardPluginCandidate[],
): CommandWizardPluginCandidate[] {
  const merged = new Map(current.map((candidate) => [candidate.pluginName, candidate]));
  for (const candidate of stored) {
    const existing = merged.get(candidate.pluginName);
    if (!existing) {
      merged.set(candidate.pluginName, candidate);
    } else if (!existing.configSchema) {
      merged.set(candidate.pluginName, { ...candidate, ...existing });
    }
  }
  return [...merged.values()];
}

async function loadStoredConfigWizardCandidates(
  context: CliExecutionContext,
  locations: ConfigWizardStoreLocation[],
  options: { includeEmptyStores?: boolean } = {},
): Promise<CommandWizardPluginCandidate[]> {
  const legacy = await listPluginConfigStorePluginNames({ cwd: context.cwd, env: context.env });
  if (legacy.length > 0) {
    throw new Error('legacyStateUnsupported: legacy bare-name config stores are not supported.');
  }
  const storesByPlugin = new Map<string, {
    sourceId: string;
    sourceIdentity: string;
    keys: Set<string>;
  }>();
  for (const location of locations) {
    const stores = await listNamespacedPluginConfigStores({
      cwd: context.cwd,
      env: context.env,
      scope: location.scope,
      ...(location.scope === 'project' ? { projectLayer: location.projectLayer } : {}),
    });
    for (const store of stores) {
      const keys = Object.keys(store.values);
      if (keys.length === 0 && options.includeEmptyStores !== true) continue;
      const existing = storesByPlugin.get(store.pluginId) ?? {
        sourceId: store.sourceId,
        sourceIdentity: store.sourceIdentity,
        keys: new Set<string>(),
      };
      if (existing.sourceIdentity !== store.sourceIdentity) {
        throw new Error(`sourceChanged: ${store.pluginId} config stores have different source identities.`);
      }
      for (const key of keys) existing.keys.add(key);
      storesByPlugin.set(store.pluginId, existing);
    }
  }
  return [...storesByPlugin]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pluginId, store]) => ({
      pluginName: pluginId,
      pluginId,
      sourceId: store.sourceId,
      sourceIdentity: store.sourceIdentity,
      targets: [],
      configKeys: [...store.keys].sort((left, right) => left.localeCompare(right)),
    }));
}

function configReadStoreLocations(rawOptions: RawConfigOptions): ConfigWizardStoreLocation[] {
  if (rawOptions.local) return [{ scope: 'project', projectLayer: 'local' }];
  if (rawOptions.scope === 'user') return [{ scope: 'user', projectLayer: 'shared' }];
  if (rawOptions.scope === 'project') return [{ scope: 'project', projectLayer: 'shared' }];
  return [
    { scope: 'user', projectLayer: 'shared' },
    { scope: 'project', projectLayer: 'shared' },
    { scope: 'project', projectLayer: 'local' },
  ];
}

function overallResultState(value: { overallState: 'succeeded' | 'failed' }): 'succeeded' | 'failed' {
  return value.overallState;
}

async function resolveStoredOnlyConfigIdentity(options: {
  selector: string;
  context: CliExecutionContext;
  locations: ConfigWizardStoreLocation[];
}): Promise<{ pluginName: string; pluginId: string; sourceId: string; sourceIdentity: string }> {
  const parsed = parsePluginId(options.selector);
  if (!parsed.sourceId) throw new Error(`Plugin "${options.selector}" is not a qualified stored config target.`);
  const stores = (await Promise.all(options.locations.map((location) =>
    listNamespacedPluginConfigStores({
      cwd: options.context.cwd,
      env: options.context.env,
      scope: location.scope,
      ...(location.scope === 'project' ? { projectLayer: location.projectLayer } : {}),
    })))).flat().filter((store) => store.pluginId === options.selector);
  if (stores.length === 0) throw new Error(`Plugin "${options.selector}" does not have a namespaced config store.`);
  const identities = new Set(stores.map((store) => store.sourceIdentity));
  if (identities.size !== 1) throw new Error(`sourceChanged: ${options.selector} config stores have different source identities.`);
  const sourceIdentity = [...identities][0]!;
  await withResolvedMultiSourceCatalog({
    cliVersion: resolveCliVersion(),
    freshnessPolicy: 'cacheFirst',
    sourceIds: [parsed.sourceId],
    env: options.context.env,
    consume: async (catalog) => {
      const source = catalog.sources.find((entry) => entry.sourceId === parsed.sourceId);
      if (!source?.resolution) throw source?.error ?? new Error(`Catalog source "${parsed.sourceId}" is unavailable.`);
      if (source.resolution.sourceIdentity !== sourceIdentity) {
        throw new Error(`sourceChanged: ${options.selector} config source identity does not match the current source.`);
      }
    },
  });
  return {
    pluginName: parsed.pluginName,
    pluginId: options.selector,
    sourceId: parsed.sourceId,
    sourceIdentity,
  };
}

async function resolveMultiSourceConfigRead(options: {
  selector: string;
  key?: string;
  rawOptions: RawConfigOptions;
  context: CliExecutionContext;
}): Promise<{
  pluginName: string;
  pluginId: string;
  sourceId: string;
  sourceIdentity: string;
  result: Awaited<ReturnType<typeof resolveConfigRead>>;
}> {
  const inventory = await inventoryLegacyConfigReferences({
    cwd: options.context.cwd,
    env: options.context.env,
  });
  assertCatalogSourceReferencesSupported(inventory);
  const projectLayer = resolveConfigProjectLayer(options.rawOptions);
  return withResolvedCatalogPlugin({
    selector: options.selector,
    cliVersion: resolveCliVersion(),
    freshnessPolicy: 'cacheFirst',
    env: options.context.env,
    consume: async ({ pluginId, source, plugin }) => {
      const result = await resolveConfigRead({
        pluginName: plugin.manifest.name,
        plugin,
        scope: options.rawOptions.local
          ? 'project'
          : resolveConfigReadResolution(options.rawOptions.scope),
        projectLayer,
        cwd: options.context.cwd,
        env: options.context.env,
      });
      if (options.key !== undefined) {
        const field = findConfigFieldEntry(result.fields, options.key);
        if (!field && plugin.manifest.config?.schema?.[options.key] === undefined) {
          throw new Error(`Unknown config key "${options.key}".`);
        }
        if (field) result.fields = [field];
      }
      return {
        pluginName: plugin.manifest.name,
        pluginId,
        sourceId: source.sourceId,
        sourceIdentity: source.sourceIdentity,
        result,
      };
    },
  }).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('does not exist in the required catalog source set')) throw error;
    const stored = await resolveStoredOnlyConfigIdentity({
      selector: options.selector,
      context: options.context,
      locations: configReadStoreLocations(options.rawOptions),
    });
    const result = await resolveConfigRead({
      sourceId: stored.sourceId,
      sourceIdentity: stored.sourceIdentity,
      pluginName: stored.pluginName,
      plugin: null,
      scope: options.rawOptions.local
        ? 'project'
        : resolveConfigReadResolution(options.rawOptions.scope),
      projectLayer,
      cwd: options.context.cwd,
      env: options.context.env,
    });
    if (options.key !== undefined) {
      const field = findConfigFieldEntry(result.fields, options.key);
      if (!field) throw new Error(`Unknown config key "${options.key}".`);
      result.fields = [field];
    }
    return { ...stored, result };
  });
}

interface RawWriteWizardOptions extends RawDiagnosticsOptions {
  all?: boolean;
  scope?: string;
  platform?: string;
  scriptTimeout?: string;
  json?: boolean;
  force?: boolean;
}

async function executeWriteCommand(
  command: WriteWizardCommand,
  pluginNames: string[],
  rawOptions: RawWriteWizardOptions,
  context: CliExecutionContext,
): Promise<RebuildCommandResult> {
  const raw = { cwd: context.cwd, ...rawOptions };
  const commandOptions = command === 'install'
    ? normalizeInstallCommandOptions(raw)
    : command === 'upgrade'
      ? normalizeUpgradeCommandOptions(raw)
      : command === 'uninstall'
        ? normalizeUninstallCommandOptions(raw)
        : command === 'cleanup'
          ? normalizeCleanupCommandOptions(raw)
          : normalizeReinstallCommandOptions(raw);
  await emitCommandEvent(context, {
    type: 'options:normalized',
    data: { plugins: pluginNames, options: commandOptions },
  });
  switch (command) {
    case 'install': return installCommand(pluginNames, commandOptions, context);
    case 'upgrade': return upgradeCommand(pluginNames, commandOptions, context);
    case 'uninstall': return uninstallCommand(pluginNames, commandOptions, context);
    case 'cleanup': return cleanupCommand(pluginNames, commandOptions, context);
    case 'reinstall': return reinstallCommand(pluginNames, commandOptions, context);
  }
}

async function runWriteCommandAction(
  command: WriteWizardCommand,
  pluginNames: string[],
  rawOptions: RawWriteWizardOptions,
  context: CliExecutionContext,
): Promise<{ cancelled: true } | { cancelled: false; result: RebuildCommandResult }> {
  if ((command === 'cleanup' || command === 'reinstall') && pluginNames.length > 1) {
    throw new Error(`${command} 命令当前只支持单个插件目标。`);
  }
  if (command === 'upgrade') assertUpgradeAllConflict(pluginNames, rawOptions.all === true);

  const missingPlugin = pluginNames.length === 0 && !(command === 'upgrade' && rawOptions.all === true);
  const missingPlatform = rawOptions.platform === undefined;
  const missingScope = command === 'cleanup' && rawOptions.scope === undefined;
  const missing = missingPlugin || missingPlatform || missingScope;

  // Validate every value already supplied by the caller before opening the TUI.
  const validationOptions = {
    cwd: context.cwd,
    ...rawOptions,
    platform: rawOptions.platform ?? 'both',
    ...(command === 'cleanup' ? { scope: rawOptions.scope ?? 'user' } : {}),
  };
  void validationOptions;
  if (!missing) {
    return {
      cancelled: false,
      result: await executeWriteCommand(command, pluginNames, rawOptions, context),
    };
  }
  if (!isWizardAvailable(context, rawOptions)) {
    throw new Error(writeCommandUsage(command));
  }

  const loaded = await loadConsoleItemsResult({
    cwd: context.cwd,
    scope: rawOptions.scope,
    platform: rawOptions.platform,
    includeCatalogOnly: true,
  }, context);
  if (loaded.catalogUnavailable) {
    throw new Error(
      '插件目录不可用。请运行 `aw init` 或 `aw init --force`，或使用完整参数重试。',
    );
  }
  const candidates = missingPlugin ? toWizardCandidates(loaded.items) : [];
  const initialSelection: CommandWizardSelection = {
    plugins: pluginNames,
    platform: rawOptions.platform as PlatformSelection | undefined,
    scope: (rawOptions.scope ?? 'user') as Scope,
  };
  if (missingPlugin && !hasSelectableWriteCandidate(command, candidates, initialSelection, {
    missingPlatform,
    missingScope,
  })) {
    throw new Error('没有可执行此操作的目标。请运行 `aw status` 检查当前状态。');
  }
  const result = await runCommandWizard(context, {
    command,
    candidates,
    initial: initialSelection,
    pluginMode: missingPlugin
      ? command === 'cleanup' || command === 'reinstall' ? 'single' : 'multiple'
      : 'none',
    promptForPlatform: missingPlatform,
    promptForScope: missingScope,
    destructive: command === 'uninstall' || command === 'cleanup',
    equivalentCommand: (selection) => equivalentWriteCommand(
      command,
      selection,
      rawOptions,
    ),
    equivalentCommandTokens: (selection) => buildEquivalentWriteCommandTokens(
      command,
      selection,
      rawOptions,
    ),
    isPluginSelectable: (candidate, selection) =>
      writeCandidateEligibility(command, candidate, selection),
    resultState: overallResultState,
    execute: (selection) => executeWriteCommand(command, selection.plugins, {
      ...rawOptions,
      platform: selection.platform,
      scope: selection.scope,
    }, context),
  });
  if (result.cancelled) return { cancelled: true };
  return { cancelled: false, result: result.value! };
}

function parseBareConsoleOptions(
  argv: string[],
): RawDiagnosticsOptions | null {
  if (argv.length === 0) {
    return {};
  }

  const parsed: RawDiagnosticsOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token === '--help' || token === '-h' || token === '--version' || token === '-V') {
      return null;
    }
    if (token === '-v' || token === '--verbose') {
      parsed.verbose = true;
      continue;
    }
    if (token === '-D' || token === '--debug') {
      parsed.debug = true;
      continue;
    }
    if (token === '--log-file') {
      parsed.logFile = readBareConsoleOptionValue(argv[index + 1], '--log-file <path>');
      index += 1;
      continue;
    }
    if (token.startsWith('--log-file=')) {
      parsed.logFile = readBareConsoleOptionValue(
        token.slice('--log-file='.length),
        '--log-file <path>',
      );
      continue;
    }
    return null;
  }

  return parsed;
}

function readBareConsoleOptionValue(
  value: string | undefined,
  option: string,
): string {
  if (!value || value.startsWith('-')) {
    throw new Error(`option '${option}' argument missing`);
  }
  return value;
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
    await Promise.allSettled([
      Promise.resolve().then(() => context.debugLogger.flush?.()),
    ]);
    if (context.diagnostics.debug && context.debugLogger.logFile) {
      writeLine(context.io.stderr, `调试日志：${context.debugLogger.logFile}`);
    }
    return result;
  } catch (error) {
    if (error instanceof WizardExecutionError) {
      const diagnostic = error.diagnostic;
      await Promise.allSettled([
        Promise.resolve().then(() => context.reporter.event({
          type: 'command:error',
          commandName: context.diagnostics.commandName,
          message: error.message,
          data: { name: error.name },
        })),
        Promise.resolve().then(() => context.debugLogger.log(redactValue({
          type: 'command:error',
          commandName: context.diagnostics.commandName,
          message: diagnostic instanceof Error ? diagnostic.message : error.message,
          data: diagnostic instanceof Error
            ? { name: diagnostic.name, stack: diagnostic.stack }
            : { result: diagnostic },
        }) as Parameters<typeof context.debugLogger.log>[0])),
      ]);
    } else {
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
    }
    await Promise.allSettled([
      Promise.resolve().then(() => context.debugLogger.flush?.()),
    ]);
    if (context.diagnostics.debug && context.debugLogger.logFile) {
      writeLine(context.io.stderr, `调试日志：${context.debugLogger.logFile}`);
    }
    throw error;
  }
}

function writeJsonReceipt(write: (text: string) => void, payload: unknown): void {
  writeLine(write, JSON.stringify(payload, null, 2));
}

function configLayerLabel(scope: Scope, projectLayer: 'shared' | 'local' = 'shared'): string {
  if (scope === 'user') {
    return '个人';
  }
  return projectLayer === 'local' ? '当前项目（本机私有覆盖）' : '当前项目';
}

function writeConfigApplyNotice(
  write: (text: string) => void,
  receipt: {
    plugin: string;
    overallState: 'succeeded' | 'failed';
    targetResults: Array<{
      target: { platform: string; scope: Scope };
      state: string;
      message?: string;
    }>;
    applySkippedReason?: string;
    otherProjectsRequireReinstall: boolean;
  },
): void {
  if (receipt.targetResults.length === 0) {
    const message = receipt.applySkippedReason === 'noConfigChange'
      ? '配置内容没有变化，因此没有运行 reinstall。'
      : '配置已保存。当前没有可见的 AW 安装目标，因此没有应用配置。';
    writeLine(write, message);
  } else {
    const completed = receipt.targetResults.filter((entry) => entry.state === 'completed').length;
    const failed = receipt.targetResults.filter((entry) => entry.state === 'failed');
    writeLine(write, `配置已保存。已重装 ${completed} 个当前可见目标；失败 ${failed.length} 个。`);
    for (const entry of failed) {
      writeLine(
        write,
        `${entry.target.platform}/${entry.target.scope}：${entry.message ?? 'reinstall 失败。'} `
        + `请重试 aw reinstall ${receipt.plugin} -p ${entry.target.platform} -s ${entry.target.scope}。`,
      );
    }
  }
  if (receipt.otherProjectsRequireReinstall) {
    writeLine(write, '其它项目没有被扫描。请进入每个项目目录并运行对应的 aw reinstall 命令。');
  }
}

function writeProjectLocalConfigNotice(write: (text: string) => void): void {
  writeLine(write, '当前显示的是当前项目的本机私有覆盖层，不作为 repo-visible artifact 渲染输入。');
}
function renderConfigFieldState(field: ConfigFieldEntry): string {
  if (field.valueState === 'invalid') {
    return 'invalid-config';
  }
  return field.valueState;
}

function writeConfigReadHuman(
  write: (text: string) => void,
  resolved: Awaited<ReturnType<typeof resolveConfigRead>>,
  pluginName: string,
): void {
  for (const field of resolved.fields) {
    const effectiveValue = field.effectiveValue === null
      ? '<unset>'
      : renderPluginConfigValueForDisplay(field.effectiveValue);
    const source = field.sourceLayer ?? 'none';
    writeLine(write, `${field.key}: ${renderConfigFieldState(field)} (source=${source}, effective=${effectiveValue})`);
    if (field.storedValue !== undefined && field.storedSourceLayer) {
      writeLine(
        write,
        `  stored=${field.storedSourceLayer} ${renderPluginConfigValueForDisplay(field.storedValue)}`,
      );
    }
    if (field.kind === 'manifest' && field.valueState === 'invalid') {
      const sourceScope = field.sourceLayer === 'project'
        ? ' -s project'
        : field.sourceLayer === 'local'
          ? ' -s project --local'
          : ' -s user';
      writeLine(write, `  aw config set ${pluginName} ${field.key} <value>${sourceScope}`);
      writeLine(write, `  aw config unset ${pluginName} ${field.key}${sourceScope}`);
      writeLine(write, `  aw config reset ${pluginName}${sourceScope}`);
    }
  }
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
      interactive: options.interactive,
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

  const plugin = program
    .command('plugin')
    .description('Create and validate AW plugin source');

  const skill = program
    .command('skill')
    .description('Install, materialize, or validate Agent Skills');

  skill
    .command('install')
    .description('Install portable Skills through the skills CLI')
    .argument('<plugin>', 'plugin or source/plugin selector')
    .requiredOption('-s, --scope <scope>', 'project or user')
    .option('--skill <name...>', 'install only selected Skill names')
    .option('--agent <id...>', 'install to explicit Agent IDs')
    .option('-y, --yes', 'confirm the reviewed install', false)
    .option('-j, --json', 'emit one receipt v4 JSON object', false)
    .action(async (selector: string, rawOptions: {
      scope: string;
      skill?: string[];
      agent?: string[];
      yes?: boolean;
      json?: boolean;
    }) => {
      const context = createActionContext('skill:install', {});
      const writeFailure = (error: unknown): void => {
        const code = error instanceof PortableCommandError || error instanceof SkillsCliError
          ? error.code
          : 'portableInstallFailed';
        writeJsonReceipt(io.stdout, {
          receiptSchemaVersion: 4,
          command: 'skill:install',
          ok: false,
          status: 'failed',
          plugin: { id: selector },
          scope: rawOptions.scope,
          selectedSkills: [],
          ...(rawOptions.skill ? { requestedSkills: rawOptions.skill } : {}),
          agentMode: rawOptions.agent ? 'explicit' : 'automatic',
          requestedAgents: rawOptions.agent ?? [],
          skillsCliVersion: null,
          collisions: [],
          dependencies: [],
          materializationDigest: null,
          verification: { records: [], missing: [] },
          warnings: [],
          failures: [{ code, message: `${code}: portable Skill 安装未执行。` }],
        });
      };
      if (rawOptions.json && !rawOptions.yes) {
        writeFailure(new PortableCommandError(
          'confirmationRequired',
          '写入型 --json 必须同时使用 --yes。',
        ));
        commandExitState.exitCode = 1;
        return;
      }
      try {
        const receipt = await runActionWithContext(context, () => installPortableSkills({
          selector,
          scope: rawOptions.scope,
          ...(rawOptions.skill ? { requestedSkills: rawOptions.skill } : {}),
          ...(rawOptions.agent ? { requestedAgents: rawOptions.agent } : {}),
          yes: rawOptions.yes,
          cwd: context.cwd,
          cliVersion: resolveCliVersion(),
          env: context.env,
          ...(context.interactive && context.prompt.confirm ? {
            confirm: async () => context.prompt.confirm!({
              message: '确认按以上 Review 安装 portable Skills？',
              defaultValue: false,
            }),
          } : {}),
          ...(!rawOptions.json ? {
            onReview: (review) => {
              for (const line of renderPortableReview(review)) writeLine(io.stdout, line);
            },
          } : {}),
        }));
        if (rawOptions.json) writeJsonReceipt(io.stdout, receipt);
        else if (receipt.ok) writeLine(io.stdout, `portable Skill 安装完成：${receipt.selectedSkills.length} 项。`);
        else {
          const sanitize = (value: string): string => redactString(value)
            .replace(/https?:\/\/\S+/giu, '[REDACTED URL]')
            .replace(/(?:file:\/\/)?(?:\/[\w.@+-]+){2,}/gu, '[REDACTED PATH]')
            .replace(/[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s\\]*/gu, '[REDACTED PATH]');
          const lines = new Set<string>();
          for (const failure of receipt.failures) {
            lines.add(`${failure.code}: ${sanitize(failure.message)}`);
          }
          for (const warning of receipt.warnings) lines.add(`警告：${sanitize(warning)}`);
          const recoveries = receipt.failures.map((failure) => failure.recovery).filter(Boolean);
          const recovery = recoveries.find((entry) => entry.includes('aw skill install')
            && entry.includes('skills remove'))
            ?? '重新运行 aw skill install；如需清理外部写入，请使用 skills remove。';
          lines.add(`恢复：${sanitize(recovery)}`);
          for (const line of lines) writeLine(io.stderr, line);
        }
        commandExitState.exitCode = receipt.ok ? 0 : 1;
      } catch (error) {
        if (!rawOptions.json) throw error;
        writeFailure(error);
        commandExitState.exitCode = 1;
      }
    });

  skill
    .command('materialize')
    .description('Write portable Skills to a safe output directory')
    .argument('<plugin>', 'plugin or source/plugin selector')
    .requiredOption('-s, --scope <scope>', 'project or user')
    .requiredOption('--out <dir>', 'output directory')
    .option('--skill <name...>', 'write only selected Skill names')
    .option('-j, --json', 'emit one receipt v4 JSON object', false)
    .action(async (selector: string, rawOptions: {
      scope: string;
      out: string;
      skill?: string[];
      json?: boolean;
    }) => {
      const context = createActionContext('skill:materialize', {});
      try {
        const receipt = await runActionWithContext(context, () =>
          materializePortableSkillsToDirectory({
            selector,
            scope: rawOptions.scope,
            out: rawOptions.out,
            ...(rawOptions.skill ? { requestedSkills: rawOptions.skill } : {}),
            cwd: context.cwd,
            cliVersion: resolveCliVersion(),
            env: context.env,
          }));
        if (rawOptions.json) writeJsonReceipt(io.stdout, receipt);
        else writeLine(io.stdout, `portable Skill 已写入 ${receipt.out}：${receipt.selectedSkills.length} 项。`);
      } catch (error) {
        if (!rawOptions.json) throw error;
        const code = error instanceof PortableCommandError || error instanceof SkillsCliError
          ? error.code
          : 'portableMaterializeFailed';
        writeJsonReceipt(io.stdout, {
          receiptSchemaVersion: 4,
          command: 'skill:materialize',
          ok: false,
          plugin: { id: selector },
          scope: rawOptions.scope,
          out: path.resolve(context.cwd, rawOptions.out),
          selectedSkills: [],
          ...(rawOptions.skill ? { requestedSkills: rawOptions.skill } : {}),
          dependencies: [],
          configDigest: null,
          materializationDigest: null,
          outputDigest: null,
          errors: [{ code, message: `${code}: portable Skill 导出未执行。` }],
        });
        commandExitState.exitCode = 1;
      }
    });

  plugin
    .command('init')
    .description('Create a new deterministic plugin scaffold')
    .addHelpText('after', [
      '',
      'During development, keep the current stable target when production content changes.',
      'In this repository, run `pnpm release -- beta|release --catalog|--all --plugin <name>=patch`; the bump can also be major or minor.',
      'In another workspace, use its release workflow to set the target.',
      '',
    ].join('\n'))
    .argument('<plugin-name>', 'lowercase hyphen-case plugin name')
    .option('--description <text>', 'plugin description (required)')
    .option('--display-name <text>', 'human-facing plugin display name')
    .option('--short-description <text>', 'short plugin UI description')
    .option('--skill-name <name>', 'initial static Skill name')
    .option('--skill-description <text>', 'initial Skill goal and discovery description')
    .option('--skill-short-description <text>', 'initial Skill UI summary (25-64 characters)')
    .option('--skill-invocation <mode>', 'model | manual | claude-model-only (default: model)')
    .option('--version <semver>', 'initial stable plugin version (default: 0.1.0)')
    .option('--min-version <semver>', 'compatibility.aw.minVersion')
    .option('--catalog-min-version <semver>', 'target catalog compatibility minimum')
    .option('--workspace-root <path>', 'workspace root (default: current directory)')
    .option('--plugin-root <path>', 'plugin root, relative to --workspace-root by default')
    .option('--no-skills', 'create the plugin without a skills directory')
    .option('--with-mcp', 'add a minimal .mcp.json', false)
    .option('--with-apps', 'add a minimal .app.json', false)
    .option('--with-config-api', 'add AW config schema and helper', false)
    .option('--with-lifecycle', 'add a lifecycle script sample', false);

  plugin
    .command('add-skill')
    .description('Add one static Skill scaffold to an existing plugin')
    .addHelpText('after', [
      '',
      'During development, keep the current stable target when production content changes.',
      'In this repository, run `pnpm release -- beta|release --catalog|--all --plugin <name>=patch`; the bump can also be major or minor.',
      'In another workspace, use its release workflow to set the target.',
      '',
    ].join('\n'))
    .argument('<plugin-name>', 'existing lowercase hyphen-case plugin name')
    .option('--skill-name <name>', 'new static Skill name (required)')
    .option('--skill-description <text>', 'Skill goal and discovery description (required)')
    .option('--skill-short-description <text>', 'Skill UI summary (25-64 characters)')
    .option('--skill-invocation <mode>', 'model | manual | claude-model-only (default: model)')
    .option('--workspace-root <path>', 'workspace root (default: current directory)')
    .option('--plugin-root <path>', 'plugin root, relative to --workspace-root by default');

  plugin
    .command('validate')
    .description('Validate one source plugin directory')
    .argument('<plugin-directory>', 'source plugin directory')
    .option('--catalog-min-version <semver>', 'validate compatibility against a target catalog')
    .option('--strict-agent-skills', 'allow only Agent Skills portable core frontmatter', false)
    .option('--claude-skill-profile <profile>', 'minimum | current (default: minimum)')
    .option('--version-base <git-ref>', 'production bundle comparison base (default: HEAD)')
    .option('--workspace-root <path>', 'workspace root (default: current directory)')
    .option('--json', 'emit one machine-readable JSON result', false);

  plugin
    .command('test')
    .description('Run deterministic Node tests declared by one source plugin')
    .argument('<plugin-directory>', 'source plugin directory')
    .option('--workspace-root <path>', 'workspace root (default: current directory)')
    .option('--json', 'emit one machine-readable JSON result', false)
    .action(async (pluginDirectory: string, rawOptions: {
      workspaceRoot?: string;
      json?: boolean;
    }) => {
      try {
        commandExitState.exitCode = await runPluginTestCommand({
          workspaceRoot: path.resolve(cwd, rawOptions.workspaceRoot ?? '.'),
          pluginDirectory,
          json: rawOptions.json,
          io,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rawOptions.json) writeJsonReceipt(io.stdout, { command: 'plugin:test', ok: false, errors: [{ message }] });
        writeLine(io.stderr, message);
        commandExitState.exitCode = 1;
      }
    });

  plugin
    .command('build')
    .description('Build and inspect one source plugin bundle')
    .argument('<plugin-directory>', 'source plugin directory')
    .option('--workspace-root <path>', 'workspace root (default: current directory)')
    .option('--out <path>', 'output path inside the workspace')
    .option('--force', 'replace an existing generated output', false)
    .option('--json', 'emit one machine-readable JSON result', false)
    .action(async (pluginDirectory: string, rawOptions: {
      workspaceRoot?: string;
      out?: string;
      force?: boolean;
      json?: boolean;
    }) => {
      try {
        await runPluginBuildCommand({
          workspaceRoot: path.resolve(cwd, rawOptions.workspaceRoot ?? '.'),
          pluginDirectory,
          out: rawOptions.out,
          force: rawOptions.force,
          json: rawOptions.json,
          io,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rawOptions.json) writeJsonReceipt(io.stdout, { command: 'plugin:build', ok: false, errors: [{ message }] });
        writeLine(io.stderr, message);
        commandExitState.exitCode = 1;
      }
    });

  plugin
    .command('status')
    .description('Show current plugin status or compare against an explicit Git base')
    .argument('[plugin-name]', 'one explicit plugin name')
    .option('--all', 'check every current workspace plugin', false)
    .option('--base <git-ref>', 'explicit Git comparison base')
    .option('--json', 'emit one schema v3 JSON document', false)
    .option('--workspace-root <path>', 'workspace root (default: current directory)')
    .option('--plugin-root <path>', 'single plugin root, relative to --workspace-root by default');

  plugin
    .command('check-versions')
    .description('Deprecated alias for plugin status')
    .argument('[plugin-name]', 'one explicit plugin name')
    .option('--all', 'check every plugin changed relative to the Git base', false)
    .option('--base <git-ref>', 'explicit Git comparison base')
    .option('--json', 'emit one schema v3 JSON document', false)
    .option('--workspace-root <path>', 'workspace root (default: current directory)')
    .option('--plugin-root <path>', 'single plugin root, relative to --workspace-root by default');

  skill
    .command('validate')
    .description('Validate one Agent Skill directory')
    .argument('<skill-directory>', 'Agent Skill directory')
    .option(
      '--frontmatter-profile <profile>',
      'portable-agent-skills | claude-2.1.88 | claude-current (default: portable-agent-skills)',
    )
    .option('--codex-metadata <policy>', 'required | optional | ignore (default: optional)')
    .option('--json', 'emit one machine-readable JSON result', false);

  const catalog = program
    .command('catalog')
    .description('Build and manage catalogs');

  catalog
    .command('init')
    .description('Initialize a local AW plugin workspace')
    .option('--workspace-root <path>', 'workspace root (default: current directory)')
    .option('--owner-name <name>', 'catalog owner name')
    .option('--owner-url <url>', 'catalog owner URL')
    .option('--display-name <name>', 'catalog display name')
    .option('--catalog-version <semver>', 'initial catalog version (default: 0.1.0)')
    .option('--force', 'repair a matching managed workspace scaffold', false)
    .option('--json', 'emit one machine-readable JSON result', false)
    .action(async (rawOptions: {
      workspaceRoot?: string;
      ownerName?: string;
      ownerUrl?: string;
      displayName?: string;
      catalogVersion?: string;
      force?: boolean;
      json?: boolean;
    }) => {
      try {
        await runCatalogInitCommand({
          ...rawOptions,
          workspaceRoot: path.resolve(cwd, rawOptions.workspaceRoot ?? '.'),
          io,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rawOptions.json) writeJsonReceipt(io.stdout, { command: 'catalog:init', ok: false, errors: [{ message }] });
        writeLine(io.stderr, message);
        commandExitState.exitCode = 1;
      }
    });

  catalog
    .command('version')
    .description('Read or set the workspace catalog version')
    .argument('[version]', 'strict SemVer catalog version')
    .option('--workspace-root <path>', 'workspace root (default: current directory)')
    .option('--json', 'emit one machine-readable JSON result', false)
    .action(async (version: string | undefined, rawOptions: { workspaceRoot?: string; json?: boolean }) => {
      try {
        await runCatalogVersionCommand({
          workspaceRoot: path.resolve(cwd, rawOptions.workspaceRoot ?? '.'),
          version,
          json: rawOptions.json,
          io,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rawOptions.json) writeJsonReceipt(io.stdout, { command: 'catalog:version', ok: false, errors: [{ message }] });
        writeLine(io.stderr, message);
        commandExitState.exitCode = 1;
      }
    });

  catalog
    .command('build')
    .description('Build a deterministic development Catalog snapshot')
    .option('--workspace-root <path>', 'workspace root (default: current directory)')
    .option('--out <path>', 'output path inside the workspace')
    .option('--force', 'replace an existing generated output', false)
    .option('--json', 'emit one machine-readable JSON result', false)
    .action(async (rawOptions: { workspaceRoot?: string; out?: string; force?: boolean; json?: boolean }) => {
      try {
        await runCatalogBuildCommand({
          workspaceRoot: path.resolve(cwd, rawOptions.workspaceRoot ?? '.'),
          out: rawOptions.out,
          force: rawOptions.force,
          json: rawOptions.json,
          io,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rawOptions.json) writeJsonReceipt(io.stdout, { command: 'catalog:build', ok: false, errors: [{ message }] });
        writeLine(io.stderr, message);
        commandExitState.exitCode = 1;
      }
    });

  catalog
    .command('validate')
    .description('Validate a schema 4 Catalog snapshot')
    .argument('<snapshot-directory>', 'Catalog snapshot directory')
    .option('--json', 'emit one machine-readable JSON result', false)
    .action(async (snapshotDirectory: string, rawOptions: { json?: boolean }) => {
      try {
        await runCatalogValidateCommand({
          snapshotDirectory: path.resolve(cwd, snapshotDirectory),
          json: rawOptions.json,
          io,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rawOptions.json) writeJsonReceipt(io.stdout, { command: 'catalog:validate', ok: false, errors: [{ message }] });
        writeLine(io.stderr, message);
        commandExitState.exitCode = 1;
      }
    });

  catalog
    .command('publish')
    .description('Publish a versioned Catalog snapshot to a configured Git remote')
    .option('--workspace-root <path>', 'workspace root (default: current directory)')
    .option('--remote <name>', 'configured Git remote name (default: origin)')
    .option('--branch <name>', 'dedicated Catalog branch (default: catalog)')
    .option('-y, --yes', 'confirm publication without a prompt', false)
    .option('--json', 'emit one machine-readable JSON result', false)
    .action(async (rawOptions: {
      workspaceRoot?: string;
      remote?: string;
      branch?: string;
      yes?: boolean;
      json?: boolean;
    }) => {
      try {
        const context = createActionContext('catalog:publish', {});
        const result = await runCatalogPublishCommand({
          workspaceRoot: path.resolve(cwd, rawOptions.workspaceRoot ?? '.'),
          remote: rawOptions.remote,
          branch: rawOptions.branch,
          yes: rawOptions.yes,
          json: rawOptions.json,
          env,
          interactive: context.interactive,
          ...(context.prompt.confirm ? {
            confirm: async (message: string) => {
              const response = await context.prompt.confirm!({ message, defaultValue: false });
              return !response.cancelled && response.value === true;
            },
          } : {}),
          io,
        });
        if (!result) return;
        if (rawOptions.json) writeJsonReceipt(io.stdout, result);
        else {
          writeLine(io.stdout, `Published Catalog ${result.catalogVersion} to ${result.remote} (${result.pushUrl}).`);
          writeLine(io.stdout, `Branch: refs/heads/${result.branch}`);
          writeLine(io.stdout, `Tag: refs/tags/${result.tag}`);
          writeLine(io.stdout, `Commit: ${result.commit}`);
          writeLine(io.stdout, `Add it as a source: aw catalog source add <id> --git ${result.fetchUrl} --ref refs/heads/${result.branch}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (rawOptions.json) writeJsonReceipt(io.stdout, {
          command: 'catalog:publish',
          ok: false,
          errors: [{ message }],
        });
        writeLine(io.stderr, message);
        commandExitState.exitCode = 1;
      }
    });

  const catalogSource = catalog
    .command('source')
    .description('Manage catalog sources');

  const writeCatalogSourceFailure = async (
    command: CatalogSourceMutationReceipt['command'],
    sourceId: string,
    json: boolean,
    error: unknown,
    sensitiveRoots: readonly string[] = [],
  ): Promise<void> => {
    const failure = sanitizeCatalogSourceError(error, env, sensitiveRoots) as Error & {
      code?: string;
      inventory?: { references?: CatalogSourceMutationReceipt['references'] };
    };
    const message = failure instanceof Error ? failure.message : String(error);
    if (json) {
      writeJsonReceipt(io.stdout, {
        receiptSchemaVersion: 4,
        command,
        ok: false,
        changed: false,
        sourceId,
        references: failure.inventory?.references ?? [],
        errors: [{ code: failure.code ?? failure.name ?? 'catalogSourceMutationFailed', message }],
      });
    }
    writeLine(io.stderr, message);
    commandExitState.exitCode = 1;
  };

  const writeConfigMutationFailure = (
    command: 'config:set' | 'config:unset' | 'config:reset',
    plugin: string | undefined,
    json: boolean,
    error: unknown,
  ): void => {
    const message = error instanceof Error ? error.message : String(error);
    const code = message.includes('legacyStateUnsupported')
      ? 'legacyStateUnsupported'
      : message.includes('sourceChanged')
        ? 'sourceChanged'
        : message.includes('sourceMissing')
          ? 'sourceMissing'
          : message.startsWith('Cannot resolve required catalog sources:')
            ? 'catalogSourceUnavailable'
            : message.split(':', 1)[0] || 'configMutationFailed';
    if (json && !message.includes('Usage:')) {
      writeJsonReceipt(io.stdout, {
        receiptSchemaVersion: 4,
        command,
        ok: false,
        overallState: 'failed',
        ...(plugin ? { plugin } : {}),
        errors: [{ code, message }],
      });
    }
    writeLine(io.stderr, message);
    commandExitState.exitCode = 1;
  };

  const withResolvedConfigMutationPlugin = <T>(
    context: CliExecutionContext,
    selector: string,
    consume: (
      resolution: ResolvedCatalogPlugin,
      awHomeMutationToken: AwHomeMutationToken,
    ) => Promise<T> | T,
  ) => withAwHomeMutationLock({
    env: context.env,
    action: (awHomeMutationToken) => withResolvedCatalogPlugin({
      selector,
      cliVersion: resolveCliVersion(),
      freshnessPolicy: 'requireRemote',
      env: context.env,
      consume: (resolution) => consume(resolution, awHomeMutationToken),
    }),
  });

  catalogSource
    .command('list')
    .option('-j, --json', 'print catalog sources as JSON', false)
    .action(async (rawOptions: { json?: boolean }) => {
      const payload = await listCatalogSources({ env });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, payload);
        return;
      }
      writeLine(io.stdout, `Primary source: ${payload.primarySourceId}`);
      for (const source of payload.sources) {
        writeLine(io.stdout, `${source.primary ? '*' : '-'} ${source.id} ${source.type} ${source.sourceIdentity}`);
      }
    });

  catalogSource
    .command('add')
    .argument('<id>')
    .addOption(new Option('--git <url>', 'add a Git catalog source'))
    .addOption(new Option('--path <path>', 'add a local path catalog source'))
    .addOption(new Option('--ref <ref>', 'use an explicit Git ref'))
    .addOption(new Option('--default-ref', 'select the Git ref from the CLI release channel'))
    .option('--subdir <path>', 'use a catalog snapshot below the Git repository root')
    .option('--primary', 'make this source primary', false)
    .option('-j, --json', 'print mutation receipt as JSON', false)
    .action(async (id: string, rawOptions: {
      git?: string;
      path?: string;
      ref?: string;
      defaultRef?: boolean;
      subdir?: string;
      primary?: boolean;
      json?: boolean;
    }) => {
      try {
        if ((rawOptions.git === undefined) === (rawOptions.path === undefined)) {
          throw new Error('catalog source add requires exactly one of `--git` or `--path`.');
        }
        if (rawOptions.git !== undefined && ((rawOptions.ref === undefined) === (rawOptions.defaultRef !== true))) {
          throw new Error('Git catalog source add requires exactly one of `--ref` or `--default-ref`.');
        }
        if (rawOptions.path !== undefined && (
          rawOptions.ref !== undefined || rawOptions.defaultRef === true || rawOptions.subdir !== undefined
        )) {
          throw new Error('Path catalog source add only accepts `--path` and `--primary`.');
        }
        const source = rawOptions.git !== undefined
          ? {
              id,
              type: 'git' as const,
              primary: rawOptions.primary === true,
              url: rawOptions.git,
              refPolicy: explicitRefPolicy(rawOptions.ref, rawOptions.defaultRef === true),
              ...(rawOptions.subdir ? { subdir: rawOptions.subdir } : {}),
            }
          : {
              id,
              type: 'path' as const,
              primary: rawOptions.primary === true,
              path: rawOptions.path!,
            };
        const receipt = await addCatalogSourceCommand({
          source,
          cliVersion: resolveCliVersion(),
          cwd,
          env,
        });
        if (rawOptions.json) writeJsonReceipt(io.stdout, receipt);
        else writeLine(io.stdout, `Catalog source ${id} added.`);
        for (const diagnostic of receipt.errors) writeLine(io.stderr, `Warning: ${diagnostic.message}`);
      } catch (error) {
        await writeCatalogSourceFailure(
          'catalog:source:add',
          id,
          rawOptions.json === true,
          error,
          rawOptions.path === undefined ? [] : [rawOptions.path, path.resolve(cwd, rawOptions.path)],
        );
      }
    });

  catalogSource
    .command('update')
    .argument('<id>')
    .addOption(new Option('--git <url>', 'update a Git catalog URL'))
    .addOption(new Option('--path <path>', 'update a local catalog path'))
    .addOption(new Option('--ref <ref>', 'use an explicit Git ref'))
    .addOption(new Option('--default-ref', 'select the Git ref from the CLI release channel'))
    .addOption(new Option('--subdir <path>', 'update the Git catalog subdirectory'))
    .addOption(new Option('--no-subdir', 'remove the Git catalog subdirectory'))
    .option('-j, --json', 'print mutation receipt as JSON', false)
    .action(async (id: string, rawOptions: {
      git?: string;
      path?: string;
      ref?: string;
      defaultRef?: boolean;
      subdir?: string | false;
      json?: boolean;
    }) => {
      try {
        if (rawOptions.git !== undefined && rawOptions.path !== undefined) {
          throw new Error('catalog source update cannot combine `--git` and `--path`.');
        }
        if (rawOptions.ref !== undefined && rawOptions.defaultRef === true) {
          throw new Error('catalog source update cannot combine `--ref` and `--default-ref`.');
        }
        const hasUpdate = rawOptions.git !== undefined
          || rawOptions.path !== undefined
          || rawOptions.ref !== undefined
          || rawOptions.defaultRef === true
          || rawOptions.subdir !== undefined;
        if (!hasUpdate) throw new Error('catalog source update requires at least one update option.');
        if (rawOptions.path !== undefined && (
          rawOptions.ref !== undefined || rawOptions.defaultRef === true || rawOptions.subdir !== undefined
        )) throw new Error('Path catalog source update only accepts `--path`.');
        const update = rawOptions.path !== undefined
          ? { type: 'path' as const, path: rawOptions.path }
          : {
              type: 'git' as const,
              ...(rawOptions.git !== undefined ? { url: rawOptions.git } : {}),
              ...(rawOptions.ref !== undefined || rawOptions.defaultRef === true
                ? { refPolicy: explicitRefPolicy(rawOptions.ref, rawOptions.defaultRef === true) }
                : {}),
              ...(rawOptions.subdir !== undefined
                ? { subdir: rawOptions.subdir === false ? null : rawOptions.subdir }
                : {}),
            };
        const receipt = await updateCatalogSourceCommand({
          sourceId: id,
          update,
          cliVersion: resolveCliVersion(),
          cwd,
          env,
        });
        if (rawOptions.json) writeJsonReceipt(io.stdout, receipt);
        else writeLine(io.stdout, `Catalog source ${id} updated.`);
        for (const diagnostic of receipt.errors) writeLine(io.stderr, `Warning: ${diagnostic.message}`);
      } catch (error) {
        await writeCatalogSourceFailure(
          'catalog:source:update',
          id,
          rawOptions.json === true,
          error,
          rawOptions.path === undefined ? [] : [rawOptions.path, path.resolve(cwd, rawOptions.path)],
        );
      }
    });

  catalogSource
    .command('set-primary')
    .argument('<id>')
    .option('-j, --json', 'print mutation receipt as JSON', false)
    .action(async (id: string, rawOptions: { json?: boolean }) => {
      try {
        const receipt = await setPrimaryCatalogSourceCommand({ sourceId: id, cwd, env });
        if (rawOptions.json) writeJsonReceipt(io.stdout, receipt);
        else writeLine(io.stdout, `Primary catalog source set to ${id}.`);
      } catch (error) {
        await writeCatalogSourceFailure('catalog:source:set-primary', id, rawOptions.json === true, error);
      }
    });

  catalogSource
    .command('remove')
    .argument('<id>')
    .option('-j, --json', 'print mutation receipt as JSON', false)
    .action(async (id: string, rawOptions: { json?: boolean }) => {
      try {
        const receipt = await removeCatalogSourceCommand({ sourceId: id, cwd, env });
        if (rawOptions.json) writeJsonReceipt(io.stdout, receipt);
        else writeLine(io.stdout, `Catalog source ${id} removed.`);
      } catch (error) {
        await writeCatalogSourceFailure('catalog:source:remove', id, rawOptions.json === true, error);
      }
    });

  program
    .command('init')
    .option('-f, --force', 're-fetch and rebuild the current catalog cache entry', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (rawOptions: {
      force?: boolean;
      json?: boolean;
    } & RawDiagnosticsOptions) => {
      const context = createActionContext('init', rawOptions);
      const result = await runActionWithContext(context, () =>
        initCommand({
          force: rawOptions.force,
          cliVersion: resolveCliVersion(),
          env: context.env,
        }),
      );
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, buildInitReceiptJson(result));
      } else {
        for (const line of renderInitReceipt(result)) {
          writeLine(io.stdout, line);
        }
      }
      writeWarnings(io.stderr, result.warnings, { actionableOnly: true });
      for (const source of result.sources) {
        if (!source.ok && source.error) writeLine(io.stderr, `${source.id}: ${source.error}`);
      }
      commandExitState.exitCode = result.ok ? 0 : 1;
    });

  program
    .command('install')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option('--script-timeout <ms>', 'override plugin lifecycle script timeout in milliseconds')
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(
      async (
        plugins: string[],
        rawOptions: {
          scope?: string;
          platform?: string;
          scriptTimeout?: string;
          json?: boolean;
        } & RawDiagnosticsOptions,
      ) => {
        const context = createActionContext('install', rawOptions);
        const outcome = await runActionWithContext(context, () =>
          runWriteCommandAction('install', plugins ?? [], rawOptions, context));
        if (outcome.cancelled) return;
        const receipt = outcome.result;
        if (rawOptions.json) {
          writeJsonReceipt(io.stdout, buildRebuildReceiptJson('install', receipt));
        } else {
          for (const line of renderRebuildReceipt('install', receipt)) {
            writeLine(io.stdout, line);
          }
        }
        writeWarnings(io.stderr, receipt.warnings, { actionableOnly: true });
        commandExitState.exitCode = resolveCommandReceiptExitCode(receipt);
      },
    );

  program
    .command('uninstall')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option('--script-timeout <ms>', 'override plugin lifecycle script timeout in milliseconds')
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      plugins: string[],
      rawOptions: {
        scope?: string;
        platform?: string;
        scriptTimeout?: string;
        json?: boolean;
      } & RawDiagnosticsOptions,
    ) => {
      const context = createActionContext('uninstall', rawOptions);
      const outcome = await runActionWithContext(context, () =>
        runWriteCommandAction('uninstall', plugins ?? [], rawOptions, context));
      if (outcome.cancelled) return;
      const receipt = outcome.result;
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, buildRebuildReceiptJson('uninstall', receipt));
      } else {
        for (const line of renderRebuildReceipt('uninstall', receipt)) {
          writeLine(io.stdout, line);
        }
      }
      writeWarnings(io.stderr, receipt.warnings, { actionableOnly: true });
      commandExitState.exitCode = resolveCommandReceiptExitCode(receipt);
    });

  program
    .command('upgrade')
    .argument('[plugins...]')
    .option('-a, --all', 'upgrade all plugins', false)
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option('--script-timeout <ms>', 'override plugin lifecycle script timeout in milliseconds')
    .option('-j, --json', 'print receipt as JSON', false)
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
          scriptTimeout?: string;
          json?: boolean;
        } & RawDiagnosticsOptions,
      ) => {
        const context = createActionContext('upgrade', rawOptions);
        const outcome = await runActionWithContext(context, () =>
          runWriteCommandAction('upgrade', plugins ?? [], rawOptions, context));
        if (outcome.cancelled) return;
        const receipt = outcome.result;
        if (rawOptions.json) {
          writeJsonReceipt(io.stdout, buildRebuildReceiptJson('upgrade', receipt));
        } else {
          for (const line of renderRebuildReceipt('upgrade', receipt)) {
            writeLine(io.stdout, line);
          }
        }
        writeWarnings(io.stderr, receipt.warnings, { actionableOnly: true });
        commandExitState.exitCode = resolveCommandReceiptExitCode(receipt);
      },
    );

  program
    .command('cleanup')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option('-j, --json', 'print cleanup result as JSON', false)
    .option('--force', 'remove exclusively owned plugin output without dependency protection', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      plugins: string[],
      rawOptions: {
        scope?: string;
        platform?: string;
        json?: boolean;
        force?: boolean;
      } & RawDiagnosticsOptions,
    ) => {
      const context = createActionContext('cleanup', rawOptions);
      const outcome = await runActionWithContext(context, () =>
        runWriteCommandAction('cleanup', plugins ?? [], rawOptions, context));
      if (outcome.cancelled) return;
      const result = outcome.result;
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, buildRebuildReceiptJson('cleanup', result));
      } else {
        for (const line of renderRebuildReceipt('cleanup', result)) {
          writeLine(io.stdout, line);
        }
      }
      writeWarnings(io.stderr, result.warnings, { actionableOnly: true });
      commandExitState.exitCode = result.overallState === 'failed' ? 1 : 0;
    });

  program
    .command('reinstall')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option('--script-timeout <ms>', 'override plugin lifecycle script timeout in milliseconds')
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      plugins: string[],
      rawOptions: {
        scope?: string;
        platform?: string;
        scriptTimeout?: string;
        json?: boolean;
      } & RawDiagnosticsOptions,
    ) => {
      const context = createActionContext('reinstall', rawOptions);
      const outcome = await runActionWithContext(context, () =>
        runWriteCommandAction('reinstall', plugins ?? [], rawOptions, context));
      if (outcome.cancelled) return;
      const receipt = outcome.result;
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, buildRebuildReceiptJson('reinstall', receipt));
      } else {
        const lines = renderRebuildReceipt('reinstall', receipt);
        for (const line of lines) {
          writeLine(io.stdout, line);
        }
      }
      writeWarnings(io.stderr, receipt.warnings, { actionableOnly: true });
      commandExitState.exitCode = resolveCommandReceiptExitCode(receipt);
    });

  const config = program
    .command('config')
    .description('Manage AW plugin configuration');

  config
    .command('list')
    .argument('[plugin]')
    .option('-s, --scope <scope>', 'read only project or user config')
    .option('--local', 'read only the current project local override layer', false)
    .option('-j, --json', 'print config as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string | undefined, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:list', rawOptions);
      const outcome = await runActionWithContext(context, async () => {
        resolveConfigProjectLayer(rawOptions);
        if (!rawOptions.local) resolveConfigReadResolution(rawOptions.scope);
        const execute = async (selectedPlugin: string) => resolveMultiSourceConfigRead({
          selector: selectedPlugin,
          rawOptions,
          context,
        });
        if (pluginName) return { cancelled: false as const, pluginName, value: await execute(pluginName) };
        if (!isWizardAvailable(context, rawOptions)) throw new Error(configCommandUsage('list'));
        const currentCandidates = await loadWizardCandidates(context, {});
        const storedCandidates = await loadStoredConfigWizardCandidates(
          context,
          configReadStoreLocations(rawOptions),
        );
        const candidates = mergeWizardCandidates(currentCandidates, storedCandidates);
        if (candidates.length === 0) {
          throw new Error('No plugin config candidates exist in the selected location.');
        }
        const result = await runCommandWizard(context, {
          command: 'config:list',
          candidates,
          initial: { plugins: [], scope: rawOptions.scope as Scope | undefined },
          pluginMode: 'single',
          ...equivalentConfigCommandProjection((selection) => ({
            command: 'list',
            plugin: selection.plugins[0]!,
            scope: rawOptions.scope,
            projectLayer: rawOptions.local ? 'local' : 'shared',
          })),
          execute: (selection) => execute(selection.plugins[0]!),
        });
        return result.cancelled
          ? { cancelled: true as const }
          : { cancelled: false as const, pluginName: result.selection!.plugins[0]!, value: result.value! };
      });
      if (outcome.cancelled) return;
      const resolved = outcome.value;
      const selectedPluginName = resolved.pluginName;
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          ok: true,
          configSchemaVersion: 4,
          command: 'config:list',
          plugin: selectedPluginName,
          pluginName: selectedPluginName,
          pluginId: resolved.pluginId,
          sourceId: resolved.sourceId,
          sourceIdentity: resolved.sourceIdentity,
          scope: rawOptions.local ? 'project' : rawOptions.scope ?? 'effective',
          projectLayer: rawOptions.local ? 'local' : 'shared',
          ...(resolved.result.schema ? { schema: resolved.result.schema } : {}),
          fields: resolved.result.fields,
        });
      } else {
        writeConfigReadHuman(io.stdout, resolved.result, resolved.pluginId);
      }
    });

  config
    .command('get')
    .argument('[plugin]')
    .argument('[key]')
    .option('-s, --scope <scope>', 'read only project or user config')
    .option('--local', 'read only the current project local override layer', false)
    .option('-j, --json', 'print config as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string | undefined, key: string | undefined, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:get', rawOptions);
      const outcome = await runActionWithContext(context, async () => {
        resolveConfigProjectLayer(rawOptions);
        if (!rawOptions.local) resolveConfigReadResolution(rawOptions.scope);
        const execute = async (selectedPlugin: string) => resolveMultiSourceConfigRead({
          selector: selectedPlugin,
          ...(key === undefined ? {} : { key }),
          rawOptions,
          context,
        });
        if (pluginName) return { cancelled: false as const, pluginName, value: await execute(pluginName) };
        if (!isWizardAvailable(context, rawOptions)) throw new Error(configCommandUsage('get'));
        const currentCandidates = await loadWizardCandidates(context, {});
        const storedCandidates = await loadStoredConfigWizardCandidates(
          context,
          configReadStoreLocations(rawOptions),
        );
        const candidates = mergeWizardCandidates(currentCandidates, storedCandidates);
        if (candidates.length === 0) {
          throw new Error('No plugin config candidates exist in the selected location.');
        }
        const result = await runCommandWizard(context, {
          command: 'config:get',
          candidates,
          initial: { plugins: [], key, scope: rawOptions.scope as Scope | undefined },
          pluginMode: 'single',
          ...equivalentConfigCommandProjection((selection) => ({
            command: 'get',
            plugin: selection.plugins[0]!,
            key,
            scope: rawOptions.scope,
            projectLayer: rawOptions.local ? 'local' : 'shared',
          })),
          execute: (selection) => execute(selection.plugins[0]!),
        });
        return result.cancelled
          ? { cancelled: true as const }
          : { cancelled: false as const, pluginName: result.selection!.plugins[0]!, value: result.value! };
      });
      if (outcome.cancelled) return;
      const resolved = outcome.value;
      const selectedPluginName = resolved.pluginName;
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          ok: true,
          configSchemaVersion: 4,
          command: 'config:get',
          plugin: selectedPluginName,
          pluginName: selectedPluginName,
          pluginId: resolved.pluginId,
          sourceId: resolved.sourceId,
          sourceIdentity: resolved.sourceIdentity,
          key,
          scope: rawOptions.local ? 'project' : rawOptions.scope ?? 'effective',
          projectLayer: rawOptions.local ? 'local' : 'shared',
          ...(resolved.result.schema ? { schema: resolved.result.schema } : {}),
          fields: resolved.result.fields,
        });
      } else {
        writeConfigReadHuman(io.stdout, resolved.result, resolved.pluginId);
      }
    });

  config
    .command('set')
    .argument('[plugin]')
    .argument('[key]')
    .argument('[value]')
    .option('-s, --scope <scope>', 'project or user')
    .option('--local', 'write only the current project local override layer', false)
    .option('--value-json', 'parse value as a JSON literal', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      pluginName: string | undefined,
      key: string | undefined,
      rawValue: string | undefined,
      rawOptions: RawConfigOptions,
    ) => {
      const context = createActionContext('config:set', rawOptions);
      let outcome;
      try {
        outcome = await runActionWithContext(context, async () => {
        const scope = resolveConfigWriteScope(rawOptions.scope);
        const projectLayer = resolveConfigProjectLayer(rawOptions);
        const execute = async (selectedPlugin: string, selectedKey: string, inputValue: unknown) =>
          withResolvedConfigMutationPlugin(
            context,
            selectedPlugin,
            async ({ pluginId, source, plugin }, awHomeMutationToken) => {
        if (!plugin.manifest.config?.schema) {
          throw new Error(`configSchemaUnavailable: Plugin "${selectedPlugin}" does not declare an AW config schema.`);
        }
        if (!plugin.manifest.config.schema[selectedKey]) {
          throw new Error(`Unknown config key "${selectedKey}".`);
        }
        const writeReceipt = await applyPluginConfigWrite({
          plugin,
          pluginName: plugin.manifest.name,
          scope,
          projectLayer,
          cwd: context.cwd,
          env: context.env,
          nativeCliRunner: context.nativeCliRunner,
          rebuildRuntime: { ...context, awHomeMutationToken },
          awHomeMutationToken,
          request: {
            updates: { [selectedKey]: inputValue },
          },
        });
        return {
          ok: writeReceipt.overallState === 'succeeded',
          receiptSchemaVersion: 4,
          command: 'config:set',
          ...writeReceipt,
          plugin: plugin.manifest.name,
          pluginName: plugin.manifest.name,
          pluginId,
          sourceId: source.sourceId,
          sourceIdentity: source.sourceIdentity,
          affectedFields: [{
            key: selectedKey,
            title: plugin?.manifest.config?.schema?.[selectedKey]?.title ?? selectedKey,
            kind: 'manifest' as const,
            reserved: false,
            action: 'set' as const,
            scope,
            ...(scope === 'project' ? { projectLayer } : {}),
          }],
        };
            },
          );

        if (pluginName && key && rawValue !== undefined) {
          const inputValue = parseConfigValue(rawValue, rawOptions.valueJson === true);
          return {
            cancelled: false as const,
            key,
            value: await execute(pluginName, key, inputValue),
          };
        }
        if (!isWizardAvailable(context, rawOptions)) throw new Error(configCommandUsage('set'));
        const candidates = await loadWizardCandidates(context, {});
        if (pluginName) {
          const candidate = candidates.find((entry) => entry.pluginName === pluginName);
          if (!candidate) throw new Error(`Unknown plugin "${pluginName}".`);
          if (!hasConfigSchemaKeys(candidate)) {
            throw new Error(`configSchemaUnavailable: Plugin "${pluginName}" does not declare an AW config schema.`);
          }
          if (key && !candidate.configSchema?.[key]) throw new Error(`Unknown config key "${key}".`);
        }
        const configurableCandidates = candidates.filter(hasConfigSchemaKeys);
        if (configurableCandidates.length === 0) {
          throw new Error('configSchemaUnavailable: No current plugin declares an AW config schema.');
        }
        const result = await runCommandWizard(context, {
          command: 'config:set',
          candidates: configurableCandidates,
          initial: {
            plugins: pluginName ? [pluginName] : [],
            key,
            ...(rawValue !== undefined ? { value: rawValue } : {}),
            scope,
            projectLayer,
          },
          pluginMode: pluginName ? 'none' : 'single',
          valueJson: rawOptions.valueJson === true,
          promptForKey: key === undefined,
          promptForValue: rawValue === undefined,
          ...equivalentConfigCommandProjection((selection) =>
            configSetEquivalentOptions(selection, candidates, rawOptions)),
          commandIsTemplate: (selection) => candidates.find(
            (entry) => entry.pluginName === selection.plugins[0],
          )?.configSchema?.[selection.key ?? ''] !== undefined
            && configFieldPlaceholder(candidates.find(
              (entry) => entry.pluginName === selection.plugins[0],
            )?.configSchema?.[selection.key ?? '']) !== undefined,
          resultState: overallResultState,
          execute: async (selection) => {
            const selectedPlugin = selection.plugins[0]!;
            const selectedKey = selection.key!;
            const schema = candidates.find((entry) => entry.pluginName === selectedPlugin)!.configSchema!;
            const updates = await coercePluginConfigUpdates({
              schema,
              updates: {
                [selectedKey]: parseConfigValue(selection.value, rawOptions.valueJson === true),
              },
              cwd: context.cwd,
            });
            return execute(selectedPlugin, selectedKey, updates[selectedKey]);
          },
        });
        return result.cancelled
          ? { cancelled: true as const }
          : { cancelled: false as const, key: result.selection!.key!, value: result.value! };
        });
      } catch (error) {
        writeConfigMutationFailure('config:set', pluginName, rawOptions.json === true, error);
        return;
      }
      if (outcome.cancelled) return;
      const receipt = outcome.value;
      const selectedKey = outcome.key;
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, `已写入 ${receipt.plugin}.${selectedKey}（${configLayerLabel(receipt.scope, receipt.projectLayer)}配置）。`);
        if (receipt.projectLayer === 'local') {
          writeProjectLocalConfigNotice(io.stdout);
        }
        writeConfigApplyNotice(io.stderr, receipt);
      }
      commandExitState.exitCode = receipt.overallState === 'failed' ? 1 : 0;
    });

  config
    .command('unset')
    .argument('[plugin]')
    .argument('[key]')
    .option('-s, --scope <scope>', 'project or user')
    .option('--local', 'write only the current project local override layer', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string | undefined, key: string | undefined, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:unset', rawOptions);
      let outcome;
      try {
        outcome = await runActionWithContext(context, async () => {
        const scope = resolveConfigWriteScope(rawOptions.scope);
        const projectLayer = resolveConfigProjectLayer(rawOptions);
        const execute = async (selectedPlugin: string, selectedKey: string) =>
          withResolvedConfigMutationPlugin(
            context,
            selectedPlugin,
            async ({ pluginId, source, plugin }, awHomeMutationToken) => {
        if (plugin.manifest.config?.schema && !plugin.manifest.config.schema[selectedKey]) {
          throw new Error(`Unknown config key "${selectedKey}".`);
        }
        const store = await readPluginConfigStore({
          sourceId: source.sourceId,
          sourceIdentity: source.sourceIdentity,
          pluginName: plugin.manifest.name,
          scope,
          ...(scope === 'project' ? { projectLayer } : {}),
          cwd: context.cwd,
          env: context.env,
        });
        const existed = Object.hasOwn(store.values, selectedKey);
        if (!existed) throw new Error(`Unknown config key "${selectedKey}".`);
        const writeReceipt = await applyPluginConfigWrite({
          plugin,
          pluginName: plugin.manifest.name,
          scope,
          projectLayer,
          cwd: context.cwd,
          env: context.env,
          nativeCliRunner: context.nativeCliRunner,
          rebuildRuntime: { ...context, awHomeMutationToken },
          awHomeMutationToken,
          request: {
            removeKeys: [selectedKey],
          },
        });
        return {
          ok: writeReceipt.overallState === 'succeeded',
          receiptSchemaVersion: 4,
          command: 'config:unset',
          ...writeReceipt,
          plugin: plugin.manifest.name,
          pluginName: plugin.manifest.name,
          pluginId,
          sourceId: source.sourceId,
          sourceIdentity: source.sourceIdentity,
          removedKey: selectedKey,
          existed,
          affectedFields: [{
            key: selectedKey,
            title: plugin?.manifest.config?.schema?.[selectedKey]?.title ?? selectedKey,
            kind: 'manifest' as const,
            reserved: false,
            action: 'unset' as const,
            scope,
            ...(scope === 'project' ? { projectLayer } : {}),
          }],
        };
            },
          );
        if (pluginName && key) {
          return { cancelled: false as const, value: await execute(pluginName, key) };
        }
        if (!isWizardAvailable(context, rawOptions)) throw new Error(configCommandUsage('unset'));
        const loadedCurrentCandidates = await loadWizardCandidates(context, {});
        const currentCandidates = loadedCurrentCandidates.filter(hasConfigSchemaKeys);
        const candidates = currentCandidates;
        if (pluginName && !candidates.some((entry) => entry.pluginName === pluginName)) {
          throw new Error(`Unknown plugin "${pluginName}".`);
        }
        if (candidates.length === 0) {
          throw new Error('No plugin config candidates exist in the selected location.');
        }
        const result = await runCommandWizard(context, {
          command: 'config:unset',
          candidates,
          initial: { plugins: pluginName ? [pluginName] : [], key, scope, projectLayer },
          pluginMode: pluginName ? 'none' : 'single',
          promptForKey: key === undefined,
          destructive: true,
          ...equivalentConfigCommandProjection((selection) => ({
            command: 'unset',
            plugin: selection.plugins[0]!,
            key: selection.key!,
            scope: selection.scope ?? 'user',
            projectLayer: selection.projectLayer,
          })),
          resultState: overallResultState,
          execute: (selection) => execute(selection.plugins[0]!, selection.key!),
        });
        return result.cancelled
          ? { cancelled: true as const }
          : { cancelled: false as const, value: result.value! };
        });
      } catch (error) {
        writeConfigMutationFailure('config:unset', pluginName, rawOptions.json === true, error);
        return;
      }
      if (outcome.cancelled) return;
      const receipt = outcome.value;
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, receipt.existed
          ? `已删除 ${receipt.plugin}.${receipt.removedKey}（${configLayerLabel(receipt.scope, receipt.projectLayer)}配置）。`
          : `${receipt.plugin}.${receipt.removedKey}（${configLayerLabel(receipt.scope, receipt.projectLayer)}配置）原本不存在。`);
        if (receipt.projectLayer === 'local') {
          writeProjectLocalConfigNotice(io.stdout);
        }
        writeConfigApplyNotice(io.stderr, receipt);
      }
      commandExitState.exitCode = receipt.overallState === 'failed' ? 1 : 0;
    });

  config
    .command('reset')
    .argument('[plugin]')
    .option('-s, --scope <scope>', 'project or user')
    .option('--local', 'reset only the current project local override layer', false)
    .option('-y, --yes', 'confirm destructive reset', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string | undefined, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:reset', rawOptions);
      let outcome;
      try {
        outcome = await runActionWithContext(context, async () => {
        const execute = async (
          selectedPlugin: string,
          selectedScope: Scope,
          projectLayer: 'shared' | 'local',
          confirmed: boolean,
        ) => {
          if (!confirmed) {
            throw new Error(
              `Reset requires confirmation. Re-run \`aw config reset ${selectedPlugin} -s ${selectedScope}${projectLayer === 'local' ? ' --local' : ''} --yes\` to delete this store.`,
            );
          }
          return withResolvedConfigMutationPlugin(
            context,
            selectedPlugin,
            async ({ pluginId, source, plugin }, awHomeMutationToken) => {
        const affectedFields = await describeResetAffectedFields({
          pluginName: plugin.manifest.name,
          plugin,
          scope: selectedScope,
          projectLayer,
          cwd: context.cwd,
          env: context.env,
        });
        const resetReceipt = await resetPluginConfigWithHelper({
          pluginName: plugin.manifest.name,
          scope: selectedScope,
          projectLayer,
          cwd: context.cwd,
          env: context.env,
          nativeCliRunner: context.nativeCliRunner,
          rebuildRuntime: { ...context, awHomeMutationToken },
          awHomeMutationToken,
          plugin,
        });
        return {
          ok: resetReceipt.overallState === 'succeeded',
          receiptSchemaVersion: 4,
          command: 'config:reset',
          ...resetReceipt,
          plugin: plugin.manifest.name,
          pluginName: plugin.manifest.name,
          pluginId,
          sourceId: source.sourceId,
          sourceIdentity: source.sourceIdentity,
          affectedFields,
        };
            },
          ).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes('Catalog source')
            || message.startsWith('Cannot resolve required catalog sources:')) {
            throw new Error(`sourceMissing: ${selectedPlugin} source is unavailable; config store was not changed.`);
          }
          if (message.includes('does not exist in the required catalog source set')) {
            throw new Error(`configSchemaUnavailable: Plugin "${selectedPlugin}" is unavailable; config store was not changed.`);
          }
          throw error;
          });
        };

        const scope = resolveConfigWriteScope(rawOptions.scope);
        const projectLayer = resolveConfigProjectLayer(rawOptions);
        const needsWizard = pluginName === undefined || rawOptions.yes !== true;
        if (!needsWizard) {
          return {
            cancelled: false as const,
            value: await execute(pluginName, scope, projectLayer, true),
          };
        }
        if (!isWizardAvailable(context, rawOptions)) {
          if (!pluginName) throw new Error(configCommandUsage('reset'));
          return {
            cancelled: false as const,
            value: await execute(pluginName, scope, projectLayer, false),
          };
        }
        const currentCandidates = pluginName ? [] : await loadWizardCandidates(context, {});
        const candidatesByScope = new Map<Scope, CommandWizardPluginCandidate[]>();
        if (!pluginName && (rawOptions.scope === undefined || scope === 'user')) {
          candidatesByScope.set('user', mergeWizardCandidates(
            currentCandidates,
            await loadStoredConfigWizardCandidates(
              context,
              [{ scope: 'user', projectLayer: 'shared' }],
              { includeEmptyStores: true },
            ),
          ));
        }
        if (!pluginName && (rawOptions.scope === undefined || scope === 'project')) {
          candidatesByScope.set('project', mergeWizardCandidates(
            currentCandidates,
            await loadStoredConfigWizardCandidates(
              context,
              [{ scope: 'project', projectLayer }],
              { includeEmptyStores: true },
            ),
          ));
        }
        const candidates = mergeWizardCandidates(
          candidatesByScope.get('user') ?? [],
          candidatesByScope.get('project') ?? [],
        );
        if (!pluginName && candidates.length === 0) {
          throw new Error('No plugin config candidates exist in the selected location.');
        }
        const result = await runCommandWizard(context, {
          command: 'config:reset',
          candidates,
          initial: { plugins: pluginName ? [pluginName] : [], scope, projectLayer },
          pluginMode: pluginName ? 'none' : 'single',
          promptForScope: rawOptions.scope === undefined,
          destructive: true,
          isPluginVisible: (candidate, selection) => candidatesByScope
            .get(selection.scope ?? 'user')
            ?.some((entry) => entry.pluginName === candidate.pluginName) !== false,
          ...equivalentConfigCommandProjection((selection) => ({
            command: 'reset',
            plugin: selection.plugins[0]!,
            scope: selection.scope ?? 'user',
            projectLayer: selection.projectLayer,
            confirmed: true,
          })),
          resultState: overallResultState,
          execute: (selection) => execute(
            selection.plugins[0]!,
            selection.scope ?? 'user',
            selection.projectLayer ?? 'shared',
            true,
          ),
        });
        return result.cancelled
          ? { cancelled: true as const }
          : { cancelled: false as const, value: result.value! };
        });
      } catch (error) {
        writeConfigMutationFailure('config:reset', pluginName, rawOptions.json === true, error);
        return;
      }
      if (outcome.cancelled) return;
      const receipt = outcome.value;
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, receipt.deleted
          ? `已重置 ${receipt.plugin} 的${configLayerLabel(receipt.scope, receipt.projectLayer)}配置。`
          : `${receipt.plugin} 没有可重置的${configLayerLabel(receipt.scope, receipt.projectLayer)}配置。`);
        if (receipt.projectLayer === 'local') {
          writeProjectLocalConfigNotice(io.stdout);
        }
        writeConfigApplyNotice(io.stderr, receipt);
      }
      commandExitState.exitCode = receipt.overallState === 'failed' ? 1 : 0;
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
        () => statusCommandV4({
          plugins: plugins ?? [],
          cwd,
          env: context.env,
          cliVersion: resolveCliVersion(),
          platform: rawOptions.platform,
          scope: rawOptions.scope,
          json: rawOptions.json,
          verbose: rawOptions.verbose,
        }),
      );
      commandExitState.exitCode = result.hasErrors ? 1 : 0;
      writeLine(io.stdout, result.output);
      for (const source of result.payload.catalog.sources) {
        if (source.error) writeLine(io.stderr, `${source.id}: ${source.error}`);
      }
      for (const error of result.payload.errors) {
        if (error.code !== 'nativeStateUnreadable' && error.code !== 'stateInventoryFailed') {
          writeLine(io.stderr, error.message);
        }
      }
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
  const jsonAuthoringCommand = argv.includes('--json')
    && (
      (argv[0] === 'catalog' && ['init', 'version', 'build', 'validate', 'publish'].includes(argv[1] ?? ''))
      || (argv[0] === 'plugin' && ['build', 'test'].includes(argv[1] ?? ''))
    )
    ? `${argv[0]}:${argv[1]}`
    : null;

  try {
    const authoringScriptByCommand: Record<string, string> = {
      init: 'init-plugin.mjs',
      'add-skill': 'add-skill.mjs',
      validate: 'validate-plugin.mjs',
      status: 'plugin-status.mjs',
      'check-versions': 'check-plugin-versions.mjs',
    };
    const authoringScript = argv[0] === 'plugin'
      ? authoringScriptByCommand[argv[1] ?? '']
      : argv[0] === 'skill' && argv[1] === 'validate'
        ? 'validate-skill.mjs'
        : undefined;
    if (authoringScript && !argv.includes('--help') && !argv.includes('-h')) {
      const authoringArgs = argv.slice(2);
      if (
        argv[0] === 'plugin'
        && argv[1] === 'validate'
        && !path.isAbsolute(authoringArgs[0] ?? '')
        && !authoringArgs.some((token) => token === '--workspace-root' || token.startsWith('--workspace-root='))
      ) {
        authoringArgs.push('--workspace-root', options.cwd ?? process.cwd());
      }
      return runAuthoringScript({
        scriptName: authoringScript,
        args: authoringArgs,
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        io,
      });
    }
    if (argv.some((token) => token === '--subdir' || token.startsWith('--subdir='))
      && argv.includes('--no-subdir')) {
      const message = 'option --subdir cannot be used with option --no-subdir';
      if (argv.includes('--json') && argv[0] === 'catalog' && argv[1] === 'source' && argv[2] === 'update') {
        writeJsonReceipt(io.stdout, {
          receiptSchemaVersion: 4,
          command: 'catalog:source:update',
          ok: false,
          changed: false,
          sourceId: argv[3] ?? '',
          references: [],
          errors: [{ code: 'catalogSourceOptionConflict', message }],
        });
      }
      writeLine(io.stderr, `error: ${message}`);
      return 1;
    }
    const bareConsoleOptions = parseBareConsoleOptions(argv);
    if (bareConsoleOptions) {
      const context = createCliExecutionContext({
        ...options,
        io,
        env: options.env ?? process.env,
        diagnostics: {
          ...toCliDiagnosticsOptions('console', bareConsoleOptions, options.diagnostics),
          metadata: {
            ...options.diagnostics?.metadata,
            argCount: argv.length,
          },
        },
      });
      if (!context.interactive) {
        writeLine(io.stderr, formatInteractiveConsoleUnavailableMessage(context));
        return 1;
      }
      return await runActionWithContext(context, () => runConsoleController(context));
    }
    const program = buildProgram({
      ...options,
      io,
      diagnostics: {
        ...options.diagnostics,
        metadata: {
          ...options.diagnostics?.metadata,
          argCount: argv.length,
        },
      },
    });
    await program.parseAsync(['node', 'aw', ...argv]);
    return (program as Command & {
      __awCommandExitState?: { exitCode: number };
    }).__awCommandExitState?.exitCode ?? 0;
  } catch (error) {
    if (jsonAuthoringCommand && error instanceof CommanderError) {
      writeJsonReceipt(io.stdout, {
        command: jsonAuthoringCommand,
        ok: false,
        errors: [{ code: 'invalidArguments', message: error.message }],
      });
    }
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
