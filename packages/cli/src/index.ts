#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { doctorEvalProviders } from '@lesliechan721/agent-skill-eval';

import { initCommand } from './commands/init.js';
import { resolveCatalogWorkspaceRoot } from './commands/catalog-workspace-resolution.js';
import {
  addCatalogSourceCommand,
  preflightCatalogSourceMutation,
  explicitRefPolicy,
  listCatalogSources,
  removeCatalogSourceCommand,
  setPrimaryCatalogSourceCommand,
  updateCatalogSourceCommand,
  type CatalogSourceMutationReceipt,
} from './commands/catalog-source.js';
import {
  catalogSourceStatusCommand,
  syncCatalogSourceCommand,
} from './commands/catalog-generation.js';
import {
  catalogStoreErrorCode,
  catalogStorePrune,
  catalogStoreStatus,
} from './commands/catalog-store.js';
import {
  cleanupWriteCommand as cleanupCommand,
  installWriteCommand as installCommand,
  reinstallWriteCommand as reinstallCommand,
  uninstallWriteCommand as uninstallCommand,
} from './commands/write-commands.js';
import { syncCommand } from './commands/sync-command.js';
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
import { loadConsoleItemsResult, statusCommandV8 } from './commands/status-v6.js';
import {
  normalizeUninstallCommandOptions,
  normalizeCleanupCommandOptions,
  resolveConfigReadResolution,
  resolveConfigWriteScope,
  normalizeInstallCommandOptions,
  normalizeReinstallCommandOptions,
  resolveScriptTimeoutMs,
} from './commands/options.js';
import {
  isCommandWarningError,
  type RebuildReceiptOverallState,
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
  type RebuildReceiptJson,
} from './output/command-receipt.js';
import { resolveCliPackageRoot } from './utils/paths.js';
import {
  findConfigFieldEntry,
  formatPluginConfigSetRecoveryCommand,
  listNamespacedPluginConfigStores,
  listPluginConfigStorePluginNames,
  readPluginConfigStore,
  renderPluginConfigValueForDisplay,
  resolveConfigRead,
} from './utils/plugin-config.js';
import {
  applyPluginConfigWrite,
  buildConfigMutationReceipt,
  configWriteStateForError,
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
import {
  sanitizeCatalogSourceError,
  sanitizeCatalogSourceErrorMessage,
} from './utils/catalog-public-error.js';
import { catalogGenerationErrorCode } from './utils/catalog-generation-error.js';
import {
  resolveCatalogOperationContext,
  type CatalogOperationContext,
} from './utils/catalog-operation-context.js';
import {
  withAwHomeMutationLock,
  type AwHomeMutationToken,
} from './utils/aw-home-mutation-lock.js';
import type {
  ConfigFieldEntry,
  ConfigMutationCommand,
  PlatformName,
  PlatformSelection,
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
  computeReviewComponentDigest,
  listReviewRecords,
  parseReviewAttachment,
  publishReviewRecord,
  showReviewRecord,
  verifyReviewRecord,
  type ReviewAttachmentInput,
  type ReviewPublicationKind,
  type ReviewRecord,
} from './commands/review-publication.js';
import {
  createReviewInspectionFailure,
  getReviewInspectionExitCode,
  inspectReviewTarget,
  type ReviewInspectionPlatform,
  type ReviewInspectionFailureReceipt,
  type ReviewInspectionReceipt,
  type ReviewInspectionView,
} from './commands/review-inspection.js';
import {
  prepareReviewTarget,
  type ReviewPreparationV1,
} from './commands/review-preparation.js';
import { resolveRepoRoot } from './utils/state-paths.js';
import {
  runCatalogBuildCommand,
  runCatalogInitCommand,
  runCatalogValidateCommand,
  runCatalogVersionCommand,
  runPluginBuildCommand,
  runPluginTestCommand,
} from './authoring/workspace-commands.js';
import {
  runCatalogPublishApplyCommand,
  runCatalogPublishPlanCommand,
} from './commands/catalog-publish.js';
import {
  catalogPublicationFailure,
  CatalogPublicationInspectionError,
} from './commands/catalog-publication-inspection.js';
import { getCatalogStatus, renderCatalogStatus } from './commands/catalog-status.js';
import {
  activateCatalogDevSource,
  catalogDevSourceError,
  createCatalogDevFailureReceipt,
  deactivateCatalogDevSource,
  getCatalogDevSourceStatus,
} from './commands/catalog-dev-source.js';
import {
  getPluginCapabilitiesResult,
  parsePluginCapabilitySurface,
  renderPluginCapabilities,
} from './commands/plugin-capabilities.js';
import {
  AwCapabilityUnsupportedError,
  checkCurrentAw,
  describeCurrentAw,
  inspectPluginRequirements,
} from './commands/aw-capabilities.js';
import type { ManagedCodexAuthorizer } from './utils/codex-manager.js';
import { prepareSkillEval } from './commands/skill-eval.js';

export type { CliIo } from './commands/runtime.js';
export type {
  CatalogStoreEntryCategory,
  CatalogStoreEntryStatus,
  CatalogStoreInspectionEntry,
  CatalogStorePruneFailureResult,
  CatalogStorePruneResult,
  CatalogStoreStatusFailureResult,
  CatalogStoreStatusResult,
} from './commands/catalog-store.js';
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

function strictValueOption(
  flags: string,
  description: string,
  choices?: readonly string[],
): Option {
  let seen = false;
  const option = new Option(flags, description);
  return option.argParser((value: string) => {
    if (seen) throw new InvalidArgumentError(`${option.long} can be specified only once.`);
    if (choices && !choices.includes(value)) {
      throw new InvalidArgumentError(`${option.long} must be one of: ${choices.join(', ')}.`);
    }
    seen = true;
    return value;
  });
}

function collectUniqueOption(value: string, previous: string[]): string[] {
  return previous.includes(value) ? previous : [...previous, value];
}

function renderReviewSkills(
  write: (text: string) => void,
  skills: Array<{
    skill: string;
    profile: { platform: string; scope: string };
    state: string;
    finalPath: string | null;
  }>,
  issues: Array<{ code: string; message: string }>,
): void {
  for (const skill of skills) {
    writeLine(
      write,
      `${skill.skill}\t${skill.profile.platform}/${skill.profile.scope}\t${skill.state}\t${skill.finalPath ?? '-'}`,
    );
  }
  for (const issue of issues) writeLine(write, `${issue.code}: ${issue.message}`);
}

function renderReviewInspection(
  write: (text: string) => void,
  receipt: ReviewInspectionReceipt | ReviewInspectionFailureReceipt,
): void {
  writeLine(write, `Review inspection (${receipt.view}): ${receipt.ok ? 'ok' : 'failed'}`);
  if (receipt.view === 'review') {
    renderReviewSkills(write, receipt.skills, receipt.issues);
    return;
  }
  for (const issue of receipt.issues) writeLine(write, `${issue.code}: ${issue.message}`);
}

function renderReviewPreparation(
  write: (text: string) => void,
  receipt: ReviewPreparationV1,
): void {
  writeLine(write, `Review preparation: ${receipt.ok ? 'complete' : 'failed'}`);
  if (receipt.sourceBindingPath) writeLine(write, `Source binding: ${receipt.sourceBindingPath}`);
  renderReviewSkills(write, receipt.skills, receipt.issues);
}

function requestedReviewView(argv: readonly string[]): ReviewInspectionView {
  const inline = argv.find((token) => token.startsWith('--view='));
  if (inline === '--view=release') return 'release';
  const index = argv.indexOf('--view');
  return index >= 0 && argv[index + 1] === 'release' ? 'release' : 'review';
}

function createReviewPreparationFailure(
  message: string,
  code = 'invalidArguments',
): ReviewPreparationV1 {
  return {
    schemaVersion: 1,
    command: 'review:prepare',
    ok: false,
    target: null,
    sourceBindingPath: null,
    skills: [],
    issues: [{ code, path: null, message }],
  };
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
  return result.overallState === 'succeeded' ? 0 : 1;
}

interface RawDiagnosticsOptions {
  verbose?: boolean;
  debug?: boolean;
  logFile?: string;
}

interface RawConfigOptions extends RawDiagnosticsOptions {
  scope?: string;
  json?: boolean;
  valueJson?: string;
  valueStdin?: boolean;
  preset?: string;
  yes?: boolean;
  apply?: boolean;
  scriptTimeout?: string;
}

type ReceiptWriteCommand = RebuildReceiptJson['command'];

class WriteCommandRequestError extends Error {
  readonly code = 'invalidArguments';
}

function normalizeWriteRequest<T>(normalize: () => T): T {
  try {
    return normalize();
  } catch (error) {
    throw new WriteCommandRequestError(error instanceof Error ? error.message : String(error));
  }
}

function writeCommandFailure(error: unknown): { code: string; message: string } {
  const message = redactString(error instanceof Error ? error.message : String(error));
  if (error instanceof CommanderError || error instanceof WriteCommandRequestError) {
    return { code: 'invalidArguments', message };
  }
  const explicitCode = (error as { code?: unknown })?.code;
  if (typeof explicitCode === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(explicitCode)) {
    return { code: explicitCode, message };
  }
  const separator = message.indexOf(':');
  const prefix = separator > 0 ? message.slice(0, separator) : '';
  return {
    code: /^[A-Za-z][A-Za-z0-9]*$/u.test(prefix) ? prefix : 'writeCommandFailed',
    message,
  };
}

interface PreparsedWriteReceiptRequest {
  json: boolean;
  plugins: string[];
  platform?: string;
  scope?: string;
}

function preparseWriteReceiptRequest(argv: string[]): PreparsedWriteReceiptRequest {
  const request: PreparsedWriteReceiptRequest = { json: false, plugins: [] };
  let positionalOnly = false;

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (positionalOnly) {
      request.plugins.push(token);
      continue;
    }
    if (token === '--') {
      positionalOnly = true;
      continue;
    }
    if (token === '--json') {
      request.json = true;
      continue;
    }
    if (token === '--platform' || token === '--scope') {
      const value = argv[index + 1];
      if (token === '--platform') request.platform = value;
      else request.scope = value;
      index += 1;
      continue;
    }
    if (token.startsWith('--platform=')) {
      request.platform = token.slice('--platform='.length);
      continue;
    }
    if (token.startsWith('--scope=')) {
      request.scope = token.slice('--scope='.length);
      continue;
    }
    if (token === '--dependency-scope' || token === '--script-timeout' || token === '--log-file') {
      index += 1;
      continue;
    }
    if (token.startsWith('--')) continue;
    if (token.startsWith('-') && token !== '-') {
      const shortOptions = token.slice(1);
      for (let offset = 0; offset < shortOptions.length; offset += 1) {
        const option = shortOptions[offset]!;
        if (option === 'j') {
          request.json = true;
          continue;
        }
        if (option === 'p' || option === 's') {
          const value = shortOptions.slice(offset + 1) || argv[index + 1];
          if (option === 'p') request.platform = value;
          else request.scope = value;
          if (shortOptions.length === offset + 1) index += 1;
          break;
        }
      }
      continue;
    }
    request.plugins.push(token);
  }

  return request;
}

function jsonWriteCommandRequest(argv: string[]): {
  command: ReceiptWriteCommand;
  plugins: string[];
  platform: PlatformSelection;
  scope: Scope;
} | null {
  const command = argv[0];
  if (!['install', 'reinstall', 'uninstall', 'cleanup', 'sync'].includes(command ?? '')) {
    return null;
  }
  const request = preparseWriteReceiptRequest(argv);
  if (!request.json) return null;
  const rawPlatform = request.platform;
  const platform = rawPlatform === 'codex' || rawPlatform === 'claude' || rawPlatform === 'both'
    ? rawPlatform
    : 'codex';
  return {
    command: command as ReceiptWriteCommand,
    plugins: request.plugins,
    platform,
    scope: request.scope === 'project' ? 'project' : 'user',
  };
}

function writeCommandFailureReceipt(
  write: (text: string) => void,
  request: NonNullable<ReturnType<typeof jsonWriteCommandRequest>>,
  error: unknown,
): void {
  const platforms: PlatformName[] = request.platform === 'both'
    ? ['codex', 'claude']
    : [request.platform];
  writeJsonReceipt(write, buildRebuildReceiptJson(request.command, {
    platforms,
    plugins: request.plugins,
    warnings: [],
    overallState: 'failed',
    errors: [writeCommandFailure(error)],
    receiptTargets: request.plugins.flatMap((selector) => platforms.map((platform) => {
      let pluginName = selector;
      let sourceId: string | undefined;
      try {
        const parsed = parsePluginId(selector);
        pluginName = parsed.pluginName;
        sourceId = parsed.sourceId;
      } catch {
        // Keep the raw selector in the failed receipt.
      }
      return {
        pluginName,
        pluginId: selector,
        ...(sourceId ? { sourceId } : {}),
        platform,
        scope: request.scope,
      };
    })),
  }));
}

interface PreparsedConfigMutationJsonRequest {
  command: ConfigMutationCommand;
  plugin?: string;
}

function scanConfigMutationShortOptions(
  token: string,
  command: ConfigMutationCommand,
): { json: boolean; consumesNextValue: boolean } {
  if (!/^-[^-].*/u.test(token)) return { json: false, consumesNextValue: false };
  let json = false;

  for (let index = 1; index < token.length; index += 1) {
    const option = token[index]!;
    if (option === 's') {
      return {
        json,
        consumesNextValue: index === token.length - 1,
      };
    }
    if (option === 'j') {
      json = true;
      continue;
    }
    if (option === 'v' || option === 'D' || (option === 'y' && command === 'config:reset')) {
      continue;
    }
    break;
  }

  return { json, consumesNextValue: false };
}

function jsonConfigMutationRequest(argv: string[]): PreparsedConfigMutationJsonRequest | null {
  if (argv[0] !== 'config' || !['set', 'unset', 'reset'].includes(argv[1] ?? '')) {
    return null;
  }
  const command = `config:${argv[1]}` as ConfigMutationCommand;
  let json = false;
  let plugin: string | undefined;
  const valueOptions = new Set(['--scope', '--value-json', '--preset', '--log-file']);

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--') break;
    if (valueOptions.has(token)) {
      index += 1;
      continue;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    const shortOptions = scanConfigMutationShortOptions(token, command);
    if (shortOptions.json) json = true;
    if (shortOptions.consumesNextValue) index += 1;
    if (token.startsWith('-')) continue;
    plugin ??= token;
  }

  if (!json) return null;
  return {
    command,
    ...(plugin ? { plugin } : {}),
  };
}

function configMutationFailure(
  error: unknown,
  env: NodeJS.ProcessEnv,
  cwd: string,
): { code: string; message: string; configWrite: 'notStarted' | 'failed' } {
  const configWrite = configWriteStateForError(error);
  if (error instanceof CommanderError) {
    return {
      code: 'invalidArguments',
      message: 'error: invalid config mutation arguments',
      configWrite,
    };
  }
  const message = catalogPublicationFailure({
    error,
    env,
    sensitiveRoots: [cwd],
  }).message;
  if (message.includes('Usage:')) return { code: 'invalidArguments', message, configWrite };
  const generationCode = catalogGenerationErrorCode(error);
  if (generationCode === 'catalogGenerationUnavailable'
    || generationCode === 'catalogGenerationSourceMissing') {
    return { code: 'catalogSourceUnavailable', message, configWrite };
  }
  if (generationCode !== 'catalogGenerationFailed') return { code: generationCode, message, configWrite };
  const explicitCode = (error as { code?: unknown })?.code;
  if (typeof explicitCode === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(explicitCode)) {
    return { code: explicitCode, message, configWrite };
  }
  if (message.includes('legacyStateUnsupported')) return { code: 'legacyStateUnsupported', message, configWrite };
  if (message.includes('sourceChanged')) return { code: 'sourceChanged', message, configWrite };
  if (message.includes('sourceMissing')) return { code: 'sourceMissing', message, configWrite };
  if (message.startsWith('Cannot resolve required catalog sources:')) {
    return { code: 'catalogSourceUnavailable', message, configWrite };
  }
  const prefix = message.match(/^([A-Za-z][A-Za-z0-9]*):/u)?.[1];
  return { code: prefix ?? 'configMutationFailed', message, configWrite };
}

function writeConfigMutationFailureReceipt(
  write: (text: string) => void,
  request: PreparsedConfigMutationJsonRequest,
  failure: { code: string; message: string; configWrite: 'notStarted' | 'failed' },
): void {
  let plugin: string | undefined;
  try {
    if (request.plugin) {
      parsePluginId(request.plugin);
      plugin = request.plugin;
    }
  } catch {
    // Do not echo an invalid selector from raw argv in an early failure receipt.
  }
  writeJsonReceipt(write, buildConfigMutationReceipt(request.command, {
    ok: false,
    overallState: 'failed',
    configWrite: failure.configWrite,
    ...(plugin ? { plugin } : {}),
    errors: [failure],
  }));
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
  'install' | 'reinstall' | 'uninstall' | 'cleanup'
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
  return [
    `${command} 命令缺少必要参数。`,
    `Usage: aw ${command} ${cardinality} --platform <codex|claude|both>${scope}`,
    `Example: aw ${command} example-plugin --platform codex --scope user`,
  ].join('\n');
}

function configCommandUsage(command: 'list' | 'get' | 'set' | 'unset' | 'reset'): string {
  const argumentsByCommand = {
    list: '<plugin>',
    get: '<plugin> [key]',
    set: '<plugin> <field> --scope <project|user> (--value-json <json> | --value-stdin | --preset <id>)',
    unset: '<plugin> <key>',
    reset: '<plugin> --scope <project|user> --yes',
  } as const;
  return [
    `config ${command} 命令缺少必要参数。`,
    `Usage: aw config ${command} ${argumentsByCommand[command]}`,
    `Example: aw config ${command} example-plugin${command === 'set' ? ' mode --scope user --value-json \'"safe"\'' : command === 'unset' ? ' key' : command === 'reset' ? ' --scope user --yes' : ''}`,
  ].join('\n');
}

async function readUtf8Stdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin as AsyncIterable<string | Buffer | Uint8Array>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
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
  return [
    'aw',
    command,
    '--platform',
    selection.platform ?? 'both',
    '--scope',
    selection.scope ?? 'user',
    ...(rawOptions.allowManagedCodexInstall === true
      ? ['--allow-managed-codex-install']
      : []),
    ...(command === 'cleanup' ? ['--yes'] : []),
    ...(command === 'install'
      ? (rawOptions.dependencyScope ?? []).flatMap((value) => ['--dependency-scope', value])
      : []),
    ...((command === 'install' || command === 'reinstall')
      ? optionTokens('--script-timeout', rawOptions.scriptTimeout)
      : []),
    ...(selection.plugins.length > 0 ? ['--', ...selection.plugins] : []),
  ];
}

interface EquivalentConfigCommandOptions {
  command: 'list' | 'get' | 'set' | 'unset' | 'reset';
  plugin: string;
  key?: string;
  value?: string;
  scope?: string;
  valueJson?: string;
  preset?: string;
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

export function buildEquivalentConfigCommandTokens(
  options: EquivalentConfigCommandOptions,
): string[] {
  return [
    'aw',
    'config',
    options.command,
    ...optionTokens('--scope', options.scope),
    ...optionTokens('--value-json', options.valueJson),
    ...optionTokens('--preset', options.preset),
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
  }, context);
  return toWizardCandidates(loaded.items);
}

interface ConfigWizardStoreLocation {
  scope: Scope;
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
    sourceIdentity?: string;
    keys: Set<string>;
  }>();
  for (const location of locations) {
    const stores = await listNamespacedPluginConfigStores({
      cwd: context.cwd,
      env: context.env,
      scope: location.scope,
    });
    for (const store of stores) {
      const keys = Object.keys(store.values);
      if (keys.length === 0 && options.includeEmptyStores !== true) continue;
      const existing = storesByPlugin.get(store.pluginId) ?? {
        sourceId: store.sourceId,
        ...(store.binding.kind === 'source'
          ? { sourceIdentity: store.binding.sourceIdentity }
          : {}),
        keys: new Set<string>(),
      };
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
      ...(store.sourceIdentity ? { sourceIdentity: store.sourceIdentity } : {}),
      targets: [],
      configKeys: [...store.keys].sort((left, right) => left.localeCompare(right)),
    }));
}

function configReadStoreLocations(rawOptions: RawConfigOptions): ConfigWizardStoreLocation[] {
  if (rawOptions.scope === 'user') return [{ scope: 'user' }];
  if (rawOptions.scope === 'project') return [{ scope: 'project' }];
  return [
    { scope: 'user' },
    { scope: 'project' },
  ];
}

function overallResultState(value: { overallState: RebuildReceiptOverallState }): 'succeeded' | 'failed' {
  return value.overallState === 'succeeded' ? 'succeeded' : 'failed';
}

async function resolveStoredConfigResetIdentity(options: {
  selector: string;
  context: CliExecutionContext;
  scope: Scope;
}): Promise<{
  pluginName: string;
  pluginId: string;
  sourceId: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
}> {
  const parsed = parsePluginId(options.selector);
  if (parsed.sourceId) {
    return {
      pluginName: parsed.pluginName,
      pluginId: options.selector,
      sourceId: parsed.sourceId,
    };
  }
  const matches = (await listNamespacedPluginConfigStores({
    cwd: options.context.cwd,
    env: options.context.env,
    scope: options.scope,
  })).filter((store) => store.pluginName === parsed.pluginName);
  if (matches.length === 0) {
    throw new Error(`configStoreMissing: ${options.selector} has no config in the selected store.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `configTargetAmbiguous: ${options.selector} exists in multiple source namespaces: ${matches.map((store) => store.pluginId).join(', ')}. Use a full pluginId.`,
    );
  }
  const [match] = matches;
  return {
    pluginName: match!.pluginName,
    pluginId: match!.pluginId,
    sourceId: match!.sourceId,
    ...(match!.binding.kind === 'source'
      ? { sourceIdentity: match!.binding.sourceIdentity }
      : { logicalIdentity: match!.binding.logicalIdentity }),
  };
}

async function resolveStoredOnlyConfigIdentity(options: {
  selector: string;
  context: CliExecutionContext;
  locations: ConfigWizardStoreLocation[];
}): Promise<{
  pluginName: string;
  pluginId: string;
  sourceId: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
}> {
  const parsed = parsePluginId(options.selector);
  if (!parsed.sourceId) throw new Error(`Plugin "${options.selector}" is not a qualified stored config target.`);
  const stores = (await Promise.all(options.locations.map((location) =>
    listNamespacedPluginConfigStores({
      cwd: options.context.cwd,
      env: options.context.env,
      scope: location.scope,
    })))).flat().filter((store) => store.pluginId === options.selector);
  if (stores.length === 0) throw new Error(`Plugin "${options.selector}" does not have a namespaced config store.`);
  const sourceBindings = stores.flatMap((store) => store.binding.kind === 'source'
    ? [store.binding.sourceIdentity] : []);
  const catalogBindings = stores.flatMap((store) => store.binding.kind === 'catalog'
    ? [store.binding.logicalIdentity] : []);
  if (new Set(sourceBindings).size > 1 || new Set(catalogBindings).size > 1) {
    throw new Error(`identityMismatch: ${options.selector} config stores have different bindings.`);
  }
  const currentSource = await withResolvedMultiSourceCatalog({
    cliVersion: resolveCliVersion(),
    sourceIds: [parsed.sourceId],
    env: options.context.env,
    consume: async (catalog) => {
      const source = catalog.sources.find((entry) => entry.sourceId === parsed.sourceId);
      if (!source?.resolution) {
        throw source?.error ?? new Error(`Catalog source "${parsed.sourceId}" is unavailable.`);
      }
      return {
        sourceIdentity: source.resolution.sourceIdentity,
        logicalIdentity: source.resolution.logicalIdentity,
      };
    },
  });
  if (sourceBindings[0] && sourceBindings[0] !== currentSource.sourceIdentity) {
    throw new Error(`identityMismatch: ${options.selector} user config does not match the current source identity.`);
  }
  if (catalogBindings[0] && catalogBindings[0] !== currentSource.logicalIdentity) {
    throw new Error(`identityMismatch: ${options.selector} project config does not match the current Catalog logical identity.`);
  }
  return {
    pluginName: parsed.pluginName,
    pluginId: options.selector,
    sourceId: parsed.sourceId,
    sourceIdentity: currentSource.sourceIdentity,
    logicalIdentity: currentSource.logicalIdentity,
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
  sourceIdentity?: string;
  result: Awaited<ReturnType<typeof resolveConfigRead>>;
}> {
  const inventory = await inventoryLegacyConfigReferences({
    cwd: options.context.cwd,
    env: options.context.env,
  });
  assertCatalogSourceReferencesSupported(inventory);
  return withResolvedCatalogPlugin({
    selector: options.selector,
    cliVersion: resolveCliVersion(),
    env: options.context.env,
    consume: async ({ pluginId, source, plugin }) => {
      const result = await resolveConfigRead({
        pluginName: plugin.manifest.name,
        plugin,
        scope: resolveConfigReadResolution(options.rawOptions.scope),
        cwd: options.context.cwd,
        env: options.context.env,
      });
      if (options.key !== undefined) {
        const field = findConfigFieldEntry(result.fields, options.key);
        if (!field && plugin.manifest.config?.fields?.[options.key] === undefined) {
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
      logicalIdentity: stored.logicalIdentity,
      pluginName: stored.pluginName,
      plugin: null,
      scope: resolveConfigReadResolution(options.rawOptions.scope),
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
  allowManagedCodexInstall?: boolean;
  dependencyScope?: string[];
  yes?: boolean;
}

export function createManagedCodexAuthorizer(
  rawOptions: Pick<RawWriteWizardOptions, 'allowManagedCodexInstall' | 'json'>,
  context: Pick<CliExecutionContext, 'interactive' | 'isTty' | 'isCi' | 'prompt'>,
): ManagedCodexAuthorizer | undefined {
  if (rawOptions.allowManagedCodexInstall === true) return async () => true;
  if (!(context.interactive && context.isTty && !context.isCi && rawOptions.json !== true)
    || !context.prompt.confirm) return undefined;
  return async () => {
    const response = await context.prompt.confirm!({
      message: '系统中没有可用的 Codex CLI。是否获取本次操作所需的 AW-managed Codex runtime？',
      defaultValue: false,
    });
    return !response.cancelled && response.value === true;
  };
}

async function executeWriteCommand(
  command: WriteWizardCommand,
  pluginNames: string[],
  rawOptions: RawWriteWizardOptions,
  context: CliExecutionContext,
  directCli = false,
  expectedPlanFingerprint?: string,
): Promise<RebuildCommandResult> {
  const raw = { cwd: context.cwd, ...rawOptions };
  const commandOptions = normalizeWriteRequest(() => command === 'install'
    ? normalizeInstallCommandOptions(raw)
    : command === 'uninstall'
        ? normalizeUninstallCommandOptions(raw)
        : command === 'cleanup'
          ? normalizeCleanupCommandOptions(raw)
          : normalizeReinstallCommandOptions(raw));
  await emitCommandEvent(context, {
    type: 'options:normalized',
    data: { plugins: pluginNames, options: commandOptions },
  });
  const managedCodexAuthorizer = createManagedCodexAuthorizer(rawOptions, context);
  const runtime = {
    ...context,
    directCli,
    preApplyConfirmed: rawOptions.yes === true,
    ...(expectedPlanFingerprint ? { expectedPlanFingerprint } : {}),
    ...(managedCodexAuthorizer ? { managedCodexAuthorizer } : {}),
  };
  switch (command) {
    case 'install': return installCommand(pluginNames, commandOptions, runtime);
    case 'uninstall': return uninstallCommand(pluginNames, commandOptions, runtime);
    case 'cleanup': return cleanupCommand(pluginNames, commandOptions, runtime);
    case 'reinstall': return reinstallCommand(pluginNames, commandOptions, runtime);
  }
}

async function runWriteCommandAction(
  command: WriteWizardCommand,
  pluginNames: string[],
  rawOptions: RawWriteWizardOptions,
  context: CliExecutionContext,
): Promise<{ cancelled: true } | { cancelled: false; result: RebuildCommandResult }> {
  if ((command === 'cleanup' || command === 'reinstall') && pluginNames.length > 1) {
    throw new WriteCommandRequestError(`${command} 命令当前只支持单个插件目标。`);
  }
  const missingPlugin = pluginNames.length === 0;
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
    if (command === 'cleanup' && rawOptions.force !== true && rawOptions.yes !== true
      && isWizardAvailable(context, rawOptions) && context.prompt.confirm) {
      const preview = await cleanupCommand(pluginNames, normalizeCleanupCommandOptions({
        cwd: context.cwd,
        ...rawOptions,
      }), { ...context, previewOperationPlan: true });
      if ((preview.removedPluginCleanupIds?.length ?? 0) > 0) {
        if (!preview.operationPlan) {
          throw new WriteCommandRequestError('cleanupPlanUnavailable: 无法建立可信的整体清理预览。');
        }
        const response = await context.prompt.confirm({
          message: `清理已删除插件 ${preview.removedPluginCleanupIds!.join('、')}：将处理 Codex、Claude Code 的用户与当前项目位置，删除保存设置、安装意图、专属输出和共享原生安装。其他项目可能因此无法继续使用该插件；其本地记录不会修改。即使指定了 --platform 或 --scope，本次仍覆盖上述全部位置。继续？`,
          defaultValue: false,
        });
        if (response.cancelled || response.value !== true) return { cancelled: true };
        return {
          cancelled: false,
          result: await executeWriteCommand(command, pluginNames, {
            ...rawOptions, yes: true,
          }, context, true, preview.operationPlan.planFingerprint),
        };
      }
    }
    return {
      cancelled: false,
      result: await executeWriteCommand(command, pluginNames, rawOptions, context, true),
    };
  }
  if (!isWizardAvailable(context, rawOptions)) {
    throw new WriteCommandRequestError(writeCommandUsage(command));
  }

  const loaded = await loadConsoleItemsResult({
    cwd: context.cwd,
    scope: rawOptions.scope,
    platform: rawOptions.platform,
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
    ...(command === 'cleanup' ? {
      reviewDetails: async (selection: CommandWizardSelection) => {
        const preview = await cleanupCommand(selection.plugins, normalizeCleanupCommandOptions({
          cwd: context.cwd,
          ...rawOptions,
          platform: selection.platform,
          scope: selection.scope,
        }), { ...context, previewOperationPlan: true });
        if ((preview.removedPluginCleanupIds?.length ?? 0) === 0) return { lines: [] };
        if (!preview.operationPlan) {
          throw new WriteCommandRequestError('cleanupPlanUnavailable: 无法建立可信的整体清理预览。');
        }
        return {
          lines: [
            `已删除插件：${preview.removedPluginCleanupIds!.join('、')}`,
            '实际清理范围：Codex、Claude Code；用户与当前项目。',
            '将删除保存设置、安装意图、专属输出和共享原生安装。',
            '其他项目可能失去此插件；其本地记录不会修改。',
            '当前 --platform / --scope 选择不会限制整体清理范围。',
          ],
          expectedPlanFingerprint: preview.operationPlan.planFingerprint,
        };
      },
    } : {}),
    execute: (selection, expectedPlanFingerprint) => executeWriteCommand(command, selection.plugins, {
      ...rawOptions,
      platform: selection.platform,
      scope: selection.scope,
      ...(command === 'cleanup' ? { yes: true } : {}),
    }, context, false, expectedPlanFingerprint),
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

function configLayerLabel(scope: Scope): string {
  if (scope === 'user') {
    return '个人';
  }
  return '当前项目';
}

function writeConfigApplyNotice(
  write: (text: string) => void,
  receipt: {
    plugin: string;
    overallState: RebuildReceiptOverallState;
    apply: import('./types.js').ConfigApplyResult;
    otherProjectsMayRequireSync: boolean;
    warnings: string[];
  },
): void {
  const sanitizeMessage = (message: string): string => redactString(message)
    .replace(/https?:\/\/\S+/giu, '[REDACTED URL]')
    .replace(/file:\/\/\S+/giu, '[REDACTED PATH]')
    .replace(/(?:file:\/\/)?(?:\/[\w.@+-]+){2,}/gu, '[REDACTED PATH]')
    .replace(/[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s\\]*/gu, '[REDACTED PATH]');
  const writeTargetFailures = (): void => {
    for (const entry of receipt.apply.targetResults.filter((target) =>
      target.state === 'failed' || target.state === 'skipped')) {
      const reason = entry.message
        ? `${entry.errorCode ? `[${entry.errorCode}] ` : ''}${sanitizeMessage(entry.message)}`
        : entry.errorCode
          ? `失败原因：${entry.errorCode}。`
          : '未提供安全失败原因。';
      const command = `aw reinstall ${receipt.plugin} -p ${entry.target.platform} -s ${entry.target.scope}`;
      const recovery = entry.errorCode === 'invalidConfig'
        ? ' 请修复无效配置后运行 aw sync。'
        : entry.errorCode === 'preApplyAuthorizationRequired'
          || entry.errorCode === 'sharedNativeConfigApplyConfirmationRequired'
          || entry.errorCode === 'sharedNativeImpactAuthorizationRequired'
          ? ` 请运行 ${command} --yes 重试。`
          : entry.state === 'failed'
            ? ` 请在解决失败原因后运行 ${command}。`
            : '';
      writeLine(write, `${entry.target.platform}/${entry.target.scope}：${reason}${recovery}`);
    }
  };
  const targetResults = receipt.apply.targetResults;
  if (receipt.apply.state === 'skipped') {
    const message = receipt.apply.reason === 'noConfigChange'
      ? '配置内容没有变化，因此没有运行 reinstall。'
      : receipt.apply.reason === 'noEffectiveConfigChange'
        ? '配置存储已更新，但有效配置没有变化，因此没有运行 reinstall。'
      : receipt.apply.reason === 'notRequested'
        ? '配置已保存，但未请求应用配置。'
        : '配置已保存。当前没有可见的 AW 安装目标，因此没有应用配置。';
    writeLine(write, message);
  } else if (receipt.apply.state === 'unavailable') {
    const fallbackMessages: Record<typeof receipt.apply.reason, string> = {
      invalidConfig: '可见目标的有效配置无效。',
      schemaUnavailable: '配置 schema 不可用。',
      sourceUnavailable: '插件来源不可用。',
      effectiveConfigUnavailable: '无法读取有效配置。',
      targetDiscoveryFailed: '无法发现可应用配置的目标。',
    };
    const detail = receipt.apply.error
      ? `${receipt.apply.error.code}：${sanitizeMessage(receipt.apply.error.message)}`
      : `${receipt.apply.reason}：${fallbackMessages[receipt.apply.reason]}`;
    const recovery = receipt.apply.reason === 'invalidConfig'
      ? '请修复无效配置后运行 aw sync。'
      : receipt.apply.reason === 'effectiveConfigUnavailable'
        ? '请修复配置后运行 aw sync。'
        : receipt.apply.reason === 'schemaUnavailable' || receipt.apply.reason === 'sourceUnavailable'
          ? '请修复插件来源或配置后运行 aw sync。'
          : '请修复来源或配置后运行 aw sync。';
    writeLine(write, `配置已保存，但当前无法应用配置。${detail} ${recovery}`);
    writeTargetFailures();
  } else {
    const completed = targetResults.filter((entry) => entry.state === 'completed').length;
    const failed = targetResults.filter((entry) => entry.state === 'failed').length;
    const skipped = targetResults.filter((entry) => entry.state === 'skipped').length;
    writeLine(write, `配置已保存。已重装 ${completed} 个当前可见目标；失败 ${failed} 个；跳过 ${skipped} 个。`);
    writeTargetFailures();
  }
  writeWarnings(write, receipt.warnings);
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
        ? 'project'
        : 'user';
      const definition = resolved.fieldDefinitions?.[field.key];
      if (definition) {
        writeLine(write, `  ${formatPluginConfigSetRecoveryCommand(
          pluginName,
          field.key,
          definition,
          sourceScope,
        )}`);
      }
      const scopeOption = ` -s ${sourceScope}`;
      writeLine(write, `  aw config unset ${pluginName} ${field.key}${scopeOption}`);
      writeLine(write, `  aw config reset ${pluginName}${scopeOption}`);
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

  const self = program
    .command('self')
    .description('Describe and check this AW executable');

  self
    .command('describe')
    .description('Describe implemented AW capabilities')
    .requiredOption('--json', 'emit one machine-readable JSON object')
    .action(() => {
      writeJsonReceipt(io.stdout, describeCurrentAw(resolveCliVersion()));
    });

  self
    .command('check')
    .description('Check nearby plugin requirements against this AW executable')
    .option('--from <path>', 'start discovery from this file or directory')
    .requiredOption('--json', 'emit one machine-readable JSON object')
    .action(async (rawOptions: { from?: string }) => {
      const result = await checkCurrentAw({
        awVersion: resolveCliVersion(),
        from: path.resolve(cwd, rawOptions.from ?? '.'),
      });
      writeJsonReceipt(io.stdout, result);
      commandExitState.exitCode = result.ok ? 0 : 1;
    });

  plugin
    .command('capabilities')
    .description('Show the current plugin manifest authoring surface')
    .option('--surface <surface>', 'manifest | build-config | extensions | slash-commands | mcp-apps | config | pre-apply | artifacts')
    .option('--json', 'emit one machine-readable JSON object', false)
    .action((rawOptions: { surface?: string; json?: boolean }) => {
      try {
        const surface = rawOptions.surface === undefined
          ? undefined
          : parsePluginCapabilitySurface(rawOptions.surface);
        const result = getPluginCapabilitiesResult({
          awVersion: resolveCliVersion(),
          ...(surface ? { surface } : {}),
        });
        if (rawOptions.json) writeJsonReceipt(io.stdout, result);
        else for (const line of renderPluginCapabilities(result)) writeLine(io.stdout, line);
      } catch (error) {
        writeLine(io.stderr, error instanceof Error ? error.message : String(error));
        commandExitState.exitCode = 1;
      }
    });

  plugin
    .command('requirements')
    .description('Inspect or update effective AW capabilities required by a plugin')
    .argument('<plugin-directory>', 'plugin source directory')
    .option('--workspace-root <root>', 'Catalog Workspace root (default: nearest ancestor from plugin directory)')
    .option('--add <capability>', 'add one declared AW capability')
    .option('--remove <capability>', 'remove one declared AW capability')
    .requiredOption('--json', 'emit one machine-readable JSON object')
    .action(async (pluginDirectory: string, rawOptions: {
      workspaceRoot?: string;
      add?: string;
      remove?: string;
    }) => {
      try {
        const result = await inspectPluginRequirements({
          pluginDirectory,
          ...(rawOptions.workspaceRoot ? { workspaceRoot: rawOptions.workspaceRoot } : {}),
          ...(rawOptions.add ? { add: rawOptions.add } : {}),
          ...(rawOptions.remove ? { remove: rawOptions.remove } : {}),
          cwd,
        });
        writeJsonReceipt(io.stdout, result);
        if (result.observations.some((observation) => observation.blocking)) {
          commandExitState.exitCode = 1;
        }
      } catch (error) {
        writeJsonReceipt(io.stdout, {
          schemaVersion: 1,
          command: 'plugin:requirements',
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        commandExitState.exitCode = 1;
      }
    });

  const skill = program
    .command('skill')
    .description('Install, materialize, or validate Agent Skills');

  const skillEval = skill
    .command('eval')
    .description('Prepare or diagnose deterministic Agent Skill Eval inputs');

  skillEval
    .command('doctor')
    .description('Inspect Agent Skill Eval provider readiness without model execution')
    .requiredOption('--json', 'emit one provider doctor JSON object')
    .action(async () => {
      try {
        writeJsonReceipt(io.stdout, await doctorEvalProviders({ sourceEnv: env }));
      } catch (error) {
        writeJsonReceipt(io.stdout, {
          ok: false,
          error: redactString(error instanceof Error ? error.message : String(error)),
        });
        commandExitState.exitCode = 1;
      }
    });

  skillEval
    .command('prepare')
    .description('Prepare one complete Agent Skill Eval input directory')
    .argument('<plugin>', 'canonical Workspace plugin name')
    .argument('<skill>', 'owner Skill name')
    .option('--suite <suite>', 'Eval suite ID')
    .option('--profile <profile>', 'Eval profile ID')
    .option('--config-file <path>', 'non-sensitive plugin config overrides for the Eval profile')
    .option('--workspace-root <root>', 'Catalog Workspace root')
    .option('--split <split>', 'case split filter')
    .option('--case <id>', 'case ID filter')
    .option('--runs <count>', 'runs per selected case')
    .option('--timeout-ms <milliseconds>', 'timeout for each provider attempt')
    .option('--baseline <mode>', 'append without-skill comparison')
    .option('--previous-version <runtime-skill-root>', 'append a previous-version comparison')
    .option('--keep-workspace', 'retain the preparation materialization workspace', false)
    .requiredOption('--output <spec-directory>', 'new EvalSpec directory')
    .requiredOption('--json', 'emit one preparation receipt JSON object')
    .action(async (pluginName: string, skillName: string, rawOptions: {
      suite?: string;
      profile?: string;
      configFile?: string;
      workspaceRoot?: string;
      split?: string;
      case?: string;
      runs?: string;
      timeoutMs?: string;
      baseline?: string;
      previousVersion?: string;
      keepWorkspace?: boolean;
      output: string;
    }) => {
      try {
        const workspace = await resolveCatalogWorkspaceRoot({
          cwd,
          ...(rawOptions.workspaceRoot === undefined ? {} : { explicitRoot: rawOptions.workspaceRoot }),
          mode: 'existing',
          env,
        });
        const runs = rawOptions.runs === undefined
          ? undefined
          : (/^[1-9][0-9]*$/u.test(rawOptions.runs) ? Number(rawOptions.runs) : Number.NaN);
        const timeoutMs = rawOptions.timeoutMs === undefined
          ? undefined
          : (/^[1-9][0-9]*$/u.test(rawOptions.timeoutMs) ? Number(rawOptions.timeoutMs) : Number.NaN);
        const receipt = await prepareSkillEval({
          workspaceRoot: workspace.workspaceRoot,
          workspaceRootResolvedFrom: workspace.workspaceRootResolvedFrom,
          pluginName,
          skillName,
          ...(rawOptions.suite === undefined ? {} : { suiteId: rawOptions.suite }),
          ...(rawOptions.profile === undefined ? {} : { profileId: rawOptions.profile }),
          ...(rawOptions.configFile === undefined ? {} : { configFile: path.resolve(cwd, rawOptions.configFile) }),
          output: rawOptions.output,
          cwd,
          env,
          ...(rawOptions.split === undefined ? {} : { split: rawOptions.split }),
          ...(rawOptions.case === undefined ? {} : { caseId: rawOptions.case }),
          ...(runs === undefined ? {} : { runs }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(rawOptions.baseline === undefined ? {} : {
            baseline: rawOptions.baseline as 'without-skill',
          }),
          ...(rawOptions.previousVersion === undefined ? {} : {
            previousVersion: rawOptions.previousVersion,
          }),
          ...(rawOptions.keepWorkspace === true ? { keepWorkspace: true } : {}),
        });
        writeJsonReceipt(io.stdout, receipt);
      } catch (error) {
        writeJsonReceipt(io.stdout, {
          schemaVersion: 1,
          command: 'skill:eval:prepare',
          ok: false,
          errors: [{
            code: 'evalPreparationFailed',
            message: redactString(error instanceof Error ? error.message : String(error)),
          }],
        });
        commandExitState.exitCode = 1;
      }
    });

  const review = program
    .command('review')
    .description('Publish and inspect immutable review records');

  const reviewRecordDir = (repoRoot: string, record: ReviewRecord): string =>
    path.relative(fs.realpathSync(repoRoot), record.root).split(path.sep).join('/');

  const reviewJsonRecord = (repoRoot: string, record: ReviewRecord) => ({
    recordDir: reviewRecordDir(repoRoot, record),
    manifest: record.manifest,
  });

  review
    .command('inspect')
    .description('Inspect current AW Review source and materialization facts')
    .argument('<target>', 'Catalog Workspace, Plugin, or source Skill path')
    .addOption(strictValueOption('--workspace-root <root>', 'explicit Catalog Workspace root'))
    .option(
      '--skill <name>',
      'select one declared Skill',
      collectUniqueOption,
      [],
    )
    .addOption(strictValueOption(
      '--platform <platform>',
      'select codex, claude, or agent-skills',
      ['codex', 'claude', 'agent-skills'],
    ))
    .addOption(strictValueOption(
      '--scope <scope>',
      'select user or project scope',
      ['user', 'project'],
    ))
    .addOption(strictValueOption('--config <file>', 'review config JSON file'))
    .option(
      '--materialization <receipt>',
      'validate one aw-source-binding receipt',
      collectUniqueOption,
      [],
    )
    .addOption(strictValueOption(
      '--view <view>',
      'select review or release view',
      ['review', 'release'],
    ).default('review'))
    .option('--json', 'emit one Review inspection JSON object', false)
    .action(async (target: string, rawOptions: {
      workspaceRoot?: string;
      skill: string[];
      platform?: ReviewInspectionPlatform;
      scope?: Scope;
      config?: string;
      materialization: string[];
      view: ReviewInspectionView;
      json: boolean;
    }) => {
      try {
        const receipt = await inspectReviewTarget({
          cwd,
          target,
          ...(rawOptions.workspaceRoot === undefined
            ? {}
            : { workspaceRoot: rawOptions.workspaceRoot }),
          skills: rawOptions.skill,
          ...(rawOptions.platform === undefined ? {} : { platform: rawOptions.platform }),
          ...(rawOptions.scope === undefined ? {} : { scope: rawOptions.scope }),
          ...(rawOptions.config === undefined ? {} : { configFile: rawOptions.config }),
          materializations: [...new Set(rawOptions.materialization
            .map((entry) => path.resolve(cwd, entry)))],
          view: rawOptions.view,
          env,
        });
        if (rawOptions.json) writeJsonReceipt(io.stdout, receipt);
        else renderReviewInspection(io.stdout, receipt);
        commandExitState.exitCode = 0;
      } catch (error) {
        const receipt = createReviewInspectionFailure(error, rawOptions.view);
        if (rawOptions.json) writeJsonReceipt(io.stdout, receipt);
        else renderReviewInspection(io.stdout, receipt);
        commandExitState.exitCode = getReviewInspectionExitCode(error);
      }
    });

  review
    .command('prepare')
    .description('Prepare deterministic Skill finals for AW Review')
    .argument('<target>', 'Plugin or source Skill path')
    .addOption(strictValueOption('--workspace-root <root>', 'explicit Catalog Workspace root'))
    .option(
      '--skill <name>',
      'select one declared Skill',
      collectUniqueOption,
      [],
    )
    .addOption(strictValueOption(
      '--platform <platform>',
      'select codex, claude, or agent-skills',
      ['codex', 'claude', 'agent-skills'],
    ).makeOptionMandatory())
    .addOption(strictValueOption(
      '--scope <scope>',
      'select user or project scope',
      ['user', 'project'],
    ).makeOptionMandatory())
    .addOption(strictValueOption('--config <file>', 'review config JSON file'))
    .addOption(strictValueOption('--out <new-dir>', 'new output directory').makeOptionMandatory())
    .option('--json', 'emit one Review preparation JSON object', false)
    .action(async (target: string, rawOptions: {
      workspaceRoot?: string;
      skill: string[];
      platform: ReviewInspectionPlatform;
      scope: Scope;
      config?: string;
      out: string;
      json: boolean;
    }) => {
      const result = await prepareReviewTarget({
        cwd,
        target,
        ...(rawOptions.workspaceRoot === undefined
          ? {}
          : { workspaceRoot: rawOptions.workspaceRoot }),
        skills: rawOptions.skill,
        platform: rawOptions.platform,
        scope: rawOptions.scope,
        ...(rawOptions.config === undefined ? {} : { configFile: rawOptions.config }),
        out: rawOptions.out,
        env,
      });
      if (rawOptions.json) writeJsonReceipt(io.stdout, result.receipt);
      else renderReviewPreparation(io.stdout, result.receipt);
      commandExitState.exitCode = result.exitCode;
    });

  review
    .command('digest')
    .description('Compute one canonical workflow component digest')
    .argument('<path>', 'repository file or directory')
    .option('--json', 'emit one component digest JSON object', false)
    .action(async (componentPath: string, rawOptions: { json?: boolean }) => {
      const repoRoot = await resolveRepoRoot(cwd);
      const result = await computeReviewComponentDigest({ repoRoot, path: componentPath });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          schemaVersion: 1,
          command: 'review:digest',
          ok: true,
          ...result,
        });
        return;
      }
      writeLine(io.stdout, `${result.path}: ${result.digest}`);
    });

  review
    .command('publish')
    .description('Publish one immutable review record')
    .requiredOption('--kind <skill|workflow|aw-plugin|aw-workflow>', 'review target kind')
    .requiredOption('--target <path-or-id>', 'review target path or ID')
    .requiredOption('--report <report.md>', 'review report Markdown file')
    .option('--scope <scope.json>', 'workflow scope JSON file')
    .option('--result <review-result.json>', 'review result JSON file')
    .option(
      '--check <kind=path>',
      'archive one JSON check attachment',
      (value: string, previous: ReviewAttachmentInput[]) => [
        ...previous,
        parseReviewAttachment(value, 'Check'),
      ],
      [],
    )
    .option(
      '--evidence <kind=path>',
      'archive one JSON evidence attachment',
      (value: string, previous: ReviewAttachmentInput[]) => [
        ...previous,
        parseReviewAttachment(value, 'Evidence'),
      ],
      [],
    )
    .option('--release-check <release-check.json>', 'release check JSON file')
    .option('--supersedes <review-id>', 'review ID that this record supersedes')
    .option('--json', 'emit one review record JSON object', false)
    .action(async (rawOptions: {
      kind: string;
      target: string;
      report: string;
      scope?: string;
      result?: string;
      check: ReviewAttachmentInput[];
      evidence: ReviewAttachmentInput[];
      releaseCheck?: string;
      supersedes?: string;
      json?: boolean;
    }) => {
      const repoRoot = await resolveRepoRoot(cwd);
      const record = await publishReviewRecord({
        repoRoot,
        kind: rawOptions.kind as ReviewPublicationKind,
        target: rawOptions.target,
        report: rawOptions.report,
        ...(rawOptions.scope === undefined ? {} : { scope: rawOptions.scope }),
        ...(rawOptions.result === undefined ? {} : { result: rawOptions.result }),
        ...(rawOptions.check.length === 0 ? {} : { checks: rawOptions.check }),
        ...(rawOptions.evidence.length === 0 ? {} : { evidence: rawOptions.evidence }),
        ...(rawOptions.releaseCheck === undefined ? {} : { releaseCheck: rawOptions.releaseCheck }),
        ...(rawOptions.supersedes === undefined ? {} : { supersedes: rawOptions.supersedes }),
      });
      const recordDir = reviewRecordDir(repoRoot, record);
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          schemaVersion: 1,
          command: 'review:publish',
          ok: true,
          ...reviewJsonRecord(repoRoot, record),
          existing: record.existing,
        });
        return;
      }
      writeLine(
        io.stdout,
        `${record.existing ? 'Existing' : 'Published'} review ${record.manifest.reviewId}: ${recordDir}`,
      );
    });

  review
    .command('verify')
    .description('Verify one archived review record')
    .argument('<report-dir>', 'review record directory')
    .option('--json', 'emit one review record JSON object', false)
    .action(async (reportDir: string, rawOptions: { json?: boolean }) => {
      const repoRoot = await resolveRepoRoot(cwd);
      const record = await verifyReviewRecord({ repoRoot, reportDir });
      const relativeRecordDir = reviewRecordDir(repoRoot, record);
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          schemaVersion: 1,
          command: 'review:verify',
          ok: true,
          ...reviewJsonRecord(repoRoot, record),
        });
        return;
      }
      writeLine(io.stdout, `Verified review ${record.manifest.reviewId}: ${relativeRecordDir}`);
    });

  review
    .command('list')
    .description('List immutable review records')
    .option('--kind <kind>', 'filter by review target kind')
    .option('--target <id>', 'filter by review target ID')
    .option('--json', 'emit one review records JSON object', false)
    .action(async (rawOptions: { kind?: string; target?: string; json?: boolean }) => {
      const repoRoot = await resolveRepoRoot(cwd);
      const records = await listReviewRecords({
        repoRoot,
        ...(rawOptions.kind === undefined ? {} : { kind: rawOptions.kind as ReviewPublicationKind }),
        ...(rawOptions.target === undefined ? {} : { targetId: rawOptions.target }),
      });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          schemaVersion: 1,
          command: 'review:list',
          ok: true,
          records: records.map((record) => reviewJsonRecord(repoRoot, record)),
        });
        return;
      }
      for (const record of records) {
        writeLine(
          io.stdout,
          [
            record.manifest.reviewId,
            record.manifest.target.kind,
            record.manifest.target.id,
            record.manifest.publishedAt,
          ].join(' '),
        );
      }
    });

  review
    .command('show')
    .description('Show one immutable review record')
    .argument('<review-id>', 'review record ID')
    .option('--json', 'emit one review record JSON object', false)
    .action(async (reviewId: string, rawOptions: { json?: boolean }) => {
      const repoRoot = await resolveRepoRoot(cwd);
      const record = await showReviewRecord({ repoRoot, reviewId });
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, {
          schemaVersion: 1,
          command: 'review:show',
          ok: true,
          ...reviewJsonRecord(repoRoot, record),
        });
        return;
      }
      const manifest = record.manifest;
      writeLine(io.stdout, `Review: ${manifest.reviewId}`);
      writeLine(io.stdout, `Target: ${manifest.target.kind} ${manifest.target.id}`);
      writeLine(io.stdout, `Published: ${manifest.publishedAt}`);
      writeLine(io.stdout, `Report: ${manifest.report.path}`);
      writeLine(io.stdout, `Result: ${manifest.result?.path ?? 'none'}`);
      writeLine(io.stdout, `Checks: ${manifest.checks.map((entry) => entry.kind).join(', ') || 'none'}`);
      writeLine(io.stdout, `Evidence: ${manifest.evidence.map((entry) => entry.kind).join(', ') || 'none'}`);
      writeLine(io.stdout, `Release check: ${manifest.releaseCheck?.path ?? 'none'}`);
      writeLine(io.stdout, `Supersedes: ${manifest.supersedes ?? 'none'}`);
    });

  skill
    .command('install')
    .description('Install portable Skills through the skills CLI')
    .argument('<plugin>', 'plugin or source/plugin selector')
    .requiredOption('-s, --scope <scope>', 'project or user')
    .option('--skill <name...>', 'install only selected Skill names')
    .option('--agent <id...>', 'install to explicit Agent IDs')
    .option('-y, --yes', 'confirm the reviewed install', false)
    .option('-j, --json', 'emit one receipt v5 JSON object', false)
    .action(async (selector: string, rawOptions: {
      scope: string;
      skill?: string[];
      agent?: string[];
      yes?: boolean;
      json?: boolean;
    }) => {
      const context = createActionContext('skill:install', {});
      const writeFailure = (error: unknown): void => {
        const capabilityError = error instanceof AwCapabilityUnsupportedError ? error : undefined;
        const code = capabilityError?.code
          ?? (error instanceof PortableCommandError || error instanceof SkillsCliError
          ? error.code
          : 'portableInstallFailed');
        writeJsonReceipt(io.stdout, {
          receiptSchemaVersion: 5,
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
          failures: [{
            code,
            message: capabilityError?.message ?? `${code}: portable Skill 安装未执行。`,
            ...(capabilityError ? {
              plugin: capabilityError.plugin,
              missingCapabilities: capabilityError.missingCapabilities,
              availableCapabilities: capabilityError.availableCapabilities,
            } : {}),
          }],
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
            .replace(/file:\/\/\S+/giu, '[REDACTED PATH]')
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
    .option('-j, --json', 'emit one receipt v5 JSON object', false)
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
        const capabilityError = error instanceof AwCapabilityUnsupportedError ? error : undefined;
        const code = capabilityError?.code
          ?? (error instanceof PortableCommandError || error instanceof SkillsCliError
          ? error.code
          : 'portableMaterializeFailed');
        writeJsonReceipt(io.stdout, {
          receiptSchemaVersion: 5,
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
          errors: [{
            code,
            message: capabilityError?.message ?? `${code}: portable Skill 导出未执行。`,
            ...(capabilityError ? {
              plugin: capabilityError.plugin,
              missingCapabilities: capabilityError.missingCapabilities,
              availableCapabilities: capabilityError.availableCapabilities,
            } : {}),
          }],
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
      'Next, run `aw plugin validate`, `aw plugin test`, `aw plugin build`, and `aw catalog build`.',
      'Publish only as an explicit later step; inspect `aw catalog publish plan --help` first.',
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
    .option('--workspace-root <path>', 'Catalog Workspace root (default: nearest ancestor from current directory)')
    .option('--no-skills', 'create the plugin without a skills directory')
    .option('--with-mcp', 'add a minimal .mcp.json', false)
    .option('--with-apps', 'add a minimal .app.json', false)
    .option('--with-config-api', 'add AW config schema and helper', false)
    .option('--with-pre-apply', 'add an idempotent Node preApply environment check', false);

  plugin
    .command('add-skill')
    .description('Add one static Skill scaffold to an existing plugin')
    .addHelpText('after', [
      '',
      'During development, keep the current stable target when production content changes.',
      'Next, run `aw plugin validate`, `aw plugin test`, `aw plugin build`, and `aw catalog build`.',
      'Publish only as an explicit later step; inspect `aw catalog publish plan --help` first.',
      '',
    ].join('\n'))
    .argument('<plugin-name>', 'existing lowercase hyphen-case plugin name')
    .option('--skill-name <name>', 'new static Skill name (required)')
    .option('--skill-description <text>', 'Skill goal and discovery description (required)')
    .option('--skill-short-description <text>', 'Skill UI summary (25-64 characters)')
    .option('--skill-invocation <mode>', 'model | manual | claude-model-only (default: model)')
    .option('--workspace-root <path>', 'Catalog Workspace root (default: nearest ancestor from current directory)');

  plugin
    .command('remove')
    .description('Remove one committed and unchanged canonical plugin source tree')
    .argument('<plugin-name>', 'existing lowercase hyphen-case plugin name')
    .option('--workspace-root <path>', 'Catalog Workspace root (default: nearest ancestor from current directory)')
    .option('--yes', 'confirm plugin source deletion', false)
    .option('--json', 'emit one schema 1 JSON object', false);

  plugin
    .command('validate')
    .description('Validate one source plugin directory')
    .argument('<plugin-directory>', 'source plugin directory')
    .option('--strict-agent-skills', 'allow only Agent Skills portable core frontmatter', false)
    .option('--claude-skill-profile <profile>', 'minimum | current (default: minimum)')
    .option('--version-base <git-ref>', 'production bundle comparison base (default: HEAD)')
    .option('--workspace-root <path>', 'Catalog Workspace root (default: nearest ancestor from plugin directory)')
    .option('--json', 'emit one machine-readable JSON result', false);

  plugin
    .command('test')
    .description('Run deterministic Node tests declared by one source plugin')
    .argument('<plugin-directory>', 'source plugin directory')
    .option('--workspace-root <path>', 'Catalog Workspace root (default: nearest ancestor from plugin directory)')
    .option('--json', 'emit one machine-readable JSON result', false)
    .action(async (pluginDirectory: string, rawOptions: {
      workspaceRoot?: string;
      json?: boolean;
    }) => {
      try {
        const workspace = await resolveCatalogWorkspaceRoot({
          cwd: path.resolve(cwd, pluginDirectory),
          ...(rawOptions.workspaceRoot === undefined ? {} : { explicitRoot: path.resolve(cwd, rawOptions.workspaceRoot) }),
          mode: 'existing',
        });
        commandExitState.exitCode = await runPluginTestCommand({
          ...workspace,
          pluginDirectory: path.resolve(cwd, pluginDirectory),
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
    .option('--workspace-root <path>', 'Catalog Workspace root (default: nearest ancestor from plugin directory)')
    .option('--out <path>', 'output path inside the Catalog Workspace')
    .option('--force', 'replace an existing generated output', false)
    .option('--json', 'emit one machine-readable JSON result', false)
    .action(async (pluginDirectory: string, rawOptions: {
      workspaceRoot?: string;
      out?: string;
      force?: boolean;
      json?: boolean;
    }) => {
      try {
        const workspace = await resolveCatalogWorkspaceRoot({
          cwd: path.resolve(cwd, pluginDirectory),
          ...(rawOptions.workspaceRoot === undefined ? {} : { explicitRoot: path.resolve(cwd, rawOptions.workspaceRoot) }),
          mode: 'existing',
        });
        await runPluginBuildCommand({
          ...workspace,
          pluginDirectory: path.resolve(cwd, pluginDirectory),
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
    .option('--all', 'check every current Catalog Workspace plugin', false)
    .option('--base <git-ref>', 'explicit Git comparison base')
    .option('--json', 'emit one schema v3 JSON document', false)
    .option('--workspace-root <path>', 'Catalog Workspace root (default: nearest ancestor from current directory)');

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
    .description('Initialize a local AW Catalog Workspace')
    .option('--workspace-root <path>', 'Catalog Workspace root (default: nearest ancestor, then Git worktree root, then current directory)')
    .option('--owner-name <name>', 'catalog owner name')
    .option('--owner-url <url>', 'catalog owner URL')
    .option('--display-name <name>', 'catalog display name')
    .option('--catalog-version <version>', 'initial stable or x.y.z-beta.N catalog version (default: 0.1.0)')
    .option('--force', 'repair a matching managed Catalog Workspace scaffold', false)
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
        const workspace = await resolveCatalogWorkspaceRoot({
          cwd,
          ...(rawOptions.workspaceRoot === undefined ? {} : { explicitRoot: rawOptions.workspaceRoot }),
          mode: 'initialize',
          env,
        });
        await runCatalogInitCommand({
          ...rawOptions,
          ...workspace,
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
    .description('Read or set the Catalog version')
    .argument('[version]', 'stable or x.y.z-beta.N catalog version')
    .option('--bump <level>', 'bump the stable SemVer base: patch, minor, or major')
    .option('--workspace-root <path>', 'Catalog Workspace root (default: nearest ancestor from current directory)')
    .option('--json', 'emit one machine-readable JSON result', false)
    .action(async (version: string | undefined, rawOptions: {
      workspaceRoot?: string;
      bump?: 'major' | 'minor' | 'patch';
      json?: boolean;
    }) => {
      try {
        const workspace = await resolveCatalogWorkspaceRoot({
          cwd,
          ...(rawOptions.workspaceRoot === undefined ? {} : { explicitRoot: rawOptions.workspaceRoot }),
          mode: 'existing',
        });
        await runCatalogVersionCommand({
          ...workspace,
          version,
          bump: rawOptions.bump,
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
    .option('--workspace-root <path>', 'Catalog Workspace root (default: nearest ancestor from current directory)')
    .option('--out <path>', 'output path inside the Catalog Workspace')
    .option('--force', 'replace an existing generated output', false)
    .option('--json', 'emit one machine-readable JSON result', false)
    .action(async (rawOptions: { workspaceRoot?: string; out?: string; force?: boolean; json?: boolean }) => {
      try {
        const workspace = await resolveCatalogWorkspaceRoot({
          cwd,
          ...(rawOptions.workspaceRoot === undefined ? {} : { explicitRoot: rawOptions.workspaceRoot }),
          mode: 'existing',
        });
        await runCatalogBuildCommand({
          ...workspace,
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
    .description('Validate a schema 7 Catalog snapshot')
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
    .command('status')
    .description('Inspect static Catalog Workspace, snapshot, and Git facts')
    .option('--workspace-root <path>', 'Catalog Workspace root (default: nearest ancestor from current directory)')
    .option('--json', 'emit one machine-readable JSON status object', false)
    .action(async (rawOptions: {
      workspaceRoot?: string;
      json?: boolean;
    }) => {
      const receipt = await getCatalogStatus({
        cwd,
        workspaceRoot: rawOptions.workspaceRoot,
        env,
      });
      if (rawOptions.json) writeJsonReceipt(io.stdout, receipt);
      else io.stdout(renderCatalogStatus(receipt));
      commandExitState.exitCode = receipt.ok ? 0 : 1;
    });

  const catalogPublish = catalog
    .command('publish')
    .description('Plan or apply a versioned Catalog publication');

  catalogPublish
    .command('plan')
    .description('Prepare and inspect the exact Catalog publication plan')
    .option('--workspace-root <path>', 'Catalog Workspace root (default: nearest ancestor from current directory)')
    .option('--remote <name>', 'Git remote (default: origin, otherwise sole remote; explicit if ambiguous)')
    .option('--branch <name>', 'dedicated Catalog branch (default: catalog)')
    .option('--json', 'emit one machine-readable JSON result', false)
    .action(async (rawOptions: {
      workspaceRoot?: string;
      remote?: string;
      branch?: string;
      json?: boolean;
    }) => {
      try {
        const result = await runCatalogPublishPlanCommand({
          cwd,
          workspaceRoot: rawOptions.workspaceRoot,
          remote: rawOptions.remote,
          branch: rawOptions.branch,
          env,
          io,
        });
        if (rawOptions.json) writeJsonReceipt(io.stdout, result);
        else {
          writeLine(io.stdout, `Workspace identity: ${result.workspaceIdentity}`);
          writeLine(io.stdout, `Source HEAD: ${result.sourceHead}`);
          writeLine(io.stdout, `Remote identity: ${result.descriptor.remote.identityDigest}`);
          writeLine(io.stdout, `Remote: ${result.remote} (${result.remoteUrl})`);
          writeLine(io.stdout, `Branch: refs/heads/${result.branch}`);
          writeLine(io.stdout, `Parent: ${result.parent ?? '<root>'}`);
          writeLine(io.stdout, `Tag: refs/tags/${result.tag}`);
          writeLine(io.stdout, `Snapshot digest: ${result.snapshotDigest}`);
          writeLine(io.stdout, `Expected commit: ${result.expectedCommit}`);
          writeLine(io.stdout, `Plan digest: ${result.planDigest}`);
        }
      } catch (error) {
        const failure = catalogPublicationFailure({
          error,
          env,
          sensitiveRoots: [
            cwd,
            ...(rawOptions.workspaceRoot ? [path.resolve(cwd, rawOptions.workspaceRoot)] : []),
          ],
        });
        if (rawOptions.json) writeJsonReceipt(io.stdout, failure);
        writeLine(io.stderr, failure.message);
        commandExitState.exitCode = 1;
      }
    });

  catalogPublish
    .command('apply')
    .description('Apply an authorized Catalog publication plan')
    .option('--workspace-root <path>', 'Catalog Workspace root (default: nearest ancestor from current directory)')
    .option('--remote <name>', 'Git remote (default: origin, otherwise sole remote; explicit if ambiguous)')
    .option('--branch <name>', 'dedicated Catalog branch (default: catalog)')
    .requiredOption('--expected-plan-digest <sha256>', 'exact plan digest returned by catalog publish plan')
    .option('-y, --yes', 'confirm publication without a prompt', false)
    .option('--json', 'emit one machine-readable JSON result', false)
    .action(async (rawOptions: {
      workspaceRoot?: string;
      remote?: string;
      branch?: string;
      expectedPlanDigest: string;
      yes?: boolean;
      json?: boolean;
    }) => {
      try {
        const context = createActionContext('catalog:publish:apply', {});
        const result = await runCatalogPublishApplyCommand({
          cwd,
          workspaceRoot: rawOptions.workspaceRoot,
          remote: rawOptions.remote,
          branch: rawOptions.branch,
          expectedPlanDigest: rawOptions.expectedPlanDigest,
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
        const failure = catalogPublicationFailure({
          error,
          env,
          sensitiveRoots: [
            cwd,
            ...(rawOptions.workspaceRoot ? [path.resolve(cwd, rawOptions.workspaceRoot)] : []),
          ],
        });
        if (rawOptions.json) writeJsonReceipt(io.stdout, failure);
        writeLine(io.stderr, failure.message);
        commandExitState.exitCode = 1;
      }
    });

  const catalogDev = catalog
    .command('dev')
    .description('Manage the current Catalog Workspace development source');

  catalogDev
    .command('activate')
    .option('--workspace-root <path>', 'explicit Catalog Workspace root')
    .option('--source-id <id>', 'explicit managed source ID')
    .option('--primary', 'make the development source primary', false)
    .option('--force-build', 'rebuild a current snapshot', false)
    .option('-y, --yes', 'confirm affected or unknown source references', false)
    .requiredOption('--json', 'emit one schema 2 JSON receipt')
    .action(async (rawOptions: {
      workspaceRoot?: string;
      sourceId?: string;
      primary?: boolean;
      forceBuild?: boolean;
      yes?: boolean;
    }) => {
      try {
        const receipt = await activateCatalogDevSource({
          cwd,
          workspaceRoot: rawOptions.workspaceRoot,
          sourceId: rawOptions.sourceId,
          primary: rawOptions.primary,
          forceBuild: rawOptions.forceBuild,
          yes: rawOptions.yes,
          cliVersion: resolveCliVersion(),
          env,
        });
        writeJsonReceipt(io.stdout, receipt);
        commandExitState.exitCode = receipt.ok ? 0 : 1;
      } catch (error) {
        const failure = catalogDevSourceError(error);
        writeJsonReceipt(io.stdout, createCatalogDevFailureReceipt({
          command: 'activate', cwd, workspaceRoot: rawOptions.workspaceRoot,
          sourceId: rawOptions.sourceId, ...failure,
        }));
        commandExitState.exitCode = 1;
      }
    });

  catalogDev
    .command('status')
    .option('--workspace-root <path>', 'explicit Catalog Workspace root')
    .requiredOption('--json', 'emit one schema 4 JSON receipt')
    .action(async (rawOptions: { workspaceRoot?: string }) => {
      const receipt = await getCatalogDevSourceStatus({
        cwd,
        workspaceRoot: rawOptions.workspaceRoot,
        cliVersion: resolveCliVersion(),
        env,
      });
      writeJsonReceipt(io.stdout, receipt);
      commandExitState.exitCode = receipt.ok ? 0 : 1;
    });

  catalogDev
    .command('deactivate')
    .option('--workspace-root <path>', 'explicit Catalog Workspace root')
    .option('--source-id <id>', 'recover one managed source by exact ID')
    .option('--replacement-primary <id>', 'replacement when the target source is primary')
    .option('-y, --yes', 'confirm source impact or recovery by source ID', false)
    .requiredOption('--json', 'emit one schema 4 JSON receipt')
    .action(async (rawOptions: {
      workspaceRoot?: string;
      sourceId?: string;
      replacementPrimary?: string;
      yes?: boolean;
    }) => {
      try {
        const receipt = await deactivateCatalogDevSource({
          cwd,
          workspaceRoot: rawOptions.workspaceRoot,
          sourceId: rawOptions.sourceId,
          replacementPrimary: rawOptions.replacementPrimary,
          yes: rawOptions.yes,
          env,
        });
        writeJsonReceipt(io.stdout, receipt);
        commandExitState.exitCode = receipt.ok ? 0 : 1;
      } catch (error) {
        const failure = catalogDevSourceError(error);
        writeJsonReceipt(io.stdout, createCatalogDevFailureReceipt({
          command: 'deactivate', cwd, workspaceRoot: rawOptions.workspaceRoot,
          sourceId: rawOptions.sourceId, ...failure,
        }));
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
      impact?: {
        primaryChange?: CatalogSourceMutationReceipt['primaryChange'];
        references?: CatalogSourceMutationReceipt['references'];
      };
    };
    const message = failure instanceof Error ? failure.message : String(error);
    if (json) {
      writeJsonReceipt(io.stdout, {
        receiptSchemaVersion: 6,
        command,
        ok: false,
        changed: false,
        sourceId,
        primaryChange: failure.impact?.primaryChange ?? null,
        references: failure.impact?.references ?? failure.inventory?.references ?? [],
        errors: [{ code: failure.code ?? failure.name ?? 'catalogSourceMutationFailed', message }],
      });
    }
    writeLine(io.stderr, message);
    commandExitState.exitCode = 1;
  };

  const writeCatalogGenerationFailure = (
    command: 'catalog:source:sync' | 'catalog:source:status',
    sourceId: string | undefined,
    json: boolean,
    error: unknown,
  ): void => {
    const failure = sanitizeCatalogSourceError(error, env) as Error & {
      impact?: import('./types.js').CatalogSourceImpact;
    };
    const message = redactString(failure.message);
    if (json) {
      writeJsonReceipt(io.stdout, {
        ...(command === 'catalog:source:sync'
          ? { catalogGenerationSchemaVersion: 1 }
          : { catalogGenerationStatusSchemaVersion: 2 }),
        command,
        ok: false,
        ...(sourceId ? { sourceId } : {}),
        ...(failure.impact ? { impact: failure.impact } : {}),
        errors: [{ code: catalogGenerationErrorCode(error), message }],
      });
    }
    writeLine(io.stderr, message);
    commandExitState.exitCode = 1;
  };

  const writeConfigMutationFailure = (
    command: ConfigMutationCommand,
    plugin: string | undefined,
    json: boolean,
    error: unknown,
  ): void => {
    const failure = configMutationFailure(error, env, cwd);
    if (json) {
      writeConfigMutationFailureReceipt(io.stdout, {
        command,
        ...(plugin ? { plugin } : {}),
      }, failure);
    }
    const message = json
      ? failure.message
      : redactString(sanitizeCatalogSourceErrorMessage(
          error instanceof Error ? error.message : String(error),
          env,
          [cwd],
        ));
    writeLine(io.stderr, message);
    commandExitState.exitCode = 1;
  };

  const withResolvedConfigMutationPlugin = <T>(
    context: CliExecutionContext,
    selector: string,
    consume: (
      resolution: ResolvedCatalogPlugin,
      awHomeMutationToken: AwHomeMutationToken,
      catalogOperationContext: CatalogOperationContext,
    ) => Promise<T> | T,
  ) => (async () => {
    const parsed = parsePluginId(selector);
    return withAwHomeMutationLock({
      env: context.env,
      action: async (awHomeMutationToken) => {
        const catalogOperationContext = await resolveCatalogOperationContext({
          ...(parsed.sourceId ? { sourceIds: [parsed.sourceId] } : {}),
          env: context.env,
        });
        return withResolvedCatalogPlugin({
          selector,
          cliVersion: resolveCliVersion(),
          operationContext: catalogOperationContext,
          env: context.env,
          consume: (resolution) => consume(
            resolution,
            awHomeMutationToken,
            catalogOperationContext,
          ),
        });
      },
    });
  })();

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
    .command('sync')
    .argument('<id>')
    .option('--check', 'fetch and validate without changing the Catalog store or Active state', false)
    .option('--replace-damaged', 'replace a damaged Active entry with the current candidate', false)
    .option('-y, --yes', 'confirm affected, unknown, or damaged Active replacement impact', false)
    .option('-j, --json', 'print the source sync result as JSON', false)
    .action(async (id: string, rawOptions: {
      check?: boolean;
      replaceDamaged?: boolean;
      yes?: boolean;
      json?: boolean;
    }) => {
      try {
        if (rawOptions.check && rawOptions.replaceDamaged) {
          throw new Error('catalog source sync --check cannot use --replace-damaged.');
        }
        const result = await syncCatalogSourceCommand({
          sourceId: id,
          cliVersion: resolveCliVersion(),
          cwd,
          check: rawOptions.check === true,
          impactConfirmed: rawOptions.yes === true,
          replaceDamaged: rawOptions.replaceDamaged === true,
          env,
        });
        if (rawOptions.json) {
          writeJsonReceipt(io.stdout, {
            ...result,
            command: 'catalog:source:sync',
            ok: true,
          });
        } else {
          writeLine(io.stdout, rawOptions.check
            ? `Catalog source ${id} is valid.`
            : `Catalog source ${id}: ${result.outcome}.`);
        }
      } catch (error) {
        writeCatalogGenerationFailure(
          'catalog:source:sync',
          id,
          rawOptions.json === true,
          error,
        );
      }
    });

  catalogSource
    .command('status')
    .argument('[id]')
    .option('-j, --json', 'print offline Catalog source status schema 2 as JSON', false)
    .action(async (id: string | undefined, rawOptions: { json?: boolean }) => {
      try {
        const result = await catalogSourceStatusCommand({ sourceId: id, env });
        if (rawOptions.json) {
          writeJsonReceipt(io.stdout, result);
        } else {
          for (const source of result.sources) {
            const active = source.active
              ? `Active ${source.active.snapshotDigest}`
              : 'no Active';
            const readiness = source.compatibility?.state === 'unsupported'
              ? `incompatible (required: ${source.compatibility.requiredCapabilities.join(', ')}; missing: ${source.compatibility.missingCapabilities.join(', ')})`
              : source.activeReady ? 'ready' : 'not ready';
            writeLine(io.stdout, `${source.sourceId}: ${active}, ${readiness}`);
          }
        }
      } catch (error) {
        writeCatalogGenerationFailure(
          'catalog:source:status',
          id,
          rawOptions.json === true,
          error,
        );
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
    .option('--no-auto-check', 'disable automatic update checks for this source')
    .option('--primary', 'make this source primary', false)
    .option('-y, --yes', 'confirm affected or unknown primary source references', false)
    .option('-j, --json', 'print mutation receipt as JSON', false)
    .action(async (id: string, rawOptions: {
      git?: string;
      path?: string;
      ref?: string;
      defaultRef?: boolean;
      subdir?: string;
      autoCheck?: boolean;
      primary?: boolean;
      yes?: boolean;
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
          throw new Error('Path catalog source add only accepts `--path`, `--primary`, `--no-auto-check`, and `--yes`.');
        }
        const source = rawOptions.git !== undefined
          ? {
              id,
              type: 'git' as const,
              primary: rawOptions.primary === true,
              url: rawOptions.git,
              refPolicy: explicitRefPolicy(rawOptions.ref, rawOptions.defaultRef === true),
              ...(rawOptions.subdir ? { subdir: rawOptions.subdir } : {}),
              ...(rawOptions.autoCheck === false ? { autoCheck: false } : {}),
            }
          : {
              id,
              type: 'path' as const,
              primary: rawOptions.primary === true,
              path: rawOptions.path!,
              ...(rawOptions.autoCheck === false ? { autoCheck: false } : {}),
            };
        const preview = source.primary
          ? await preflightCatalogSourceMutation({
              request: { action: 'add', source }, cwd, env,
            })
          : undefined;
        const receipt = await addCatalogSourceCommand({
          source,
          cliVersion: resolveCliVersion(),
          cwd,
          env,
          ...(preview ? {
            expectedConfigDigest: preview.configDigest,
            expectedProposedConfigDigest: preview.proposedConfigDigest,
            expectedImpactDigest: preview.impactDigest,
          } : {}),
          requireImpactConfirmation: true,
          confirmImpact: rawOptions.yes === true,
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
    .addOption(new Option('--auto-check', 'enable automatic update checks for this source'))
    .addOption(new Option('--no-auto-check', 'disable automatic update checks for this source'))
    .option('-y, --yes', 'confirm a source identity change', false)
    .option('-j, --json', 'print mutation receipt as JSON', false)
    .action(async (id: string, rawOptions: {
      git?: string;
      path?: string;
      ref?: string;
      defaultRef?: boolean;
      subdir?: string | false;
      autoCheck?: boolean;
      yes?: boolean;
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
          || rawOptions.subdir !== undefined
          || rawOptions.autoCheck !== undefined;
        if (!hasUpdate) throw new Error('catalog source update requires at least one update option.');
        if (rawOptions.path !== undefined && (
          rawOptions.ref !== undefined || rawOptions.defaultRef === true || rawOptions.subdir !== undefined
        )) throw new Error('Path catalog source update only accepts `--path` and auto-check options.');
        const hasGitUpdate = rawOptions.git !== undefined
          || rawOptions.ref !== undefined
          || rawOptions.defaultRef === true
          || rawOptions.subdir !== undefined;
        const update = rawOptions.path !== undefined
          ? {
              type: 'path' as const,
              path: rawOptions.path,
              ...(rawOptions.autoCheck !== undefined ? { autoCheck: rawOptions.autoCheck } : {}),
            }
          : hasGitUpdate ? {
              type: 'git' as const,
              ...(rawOptions.autoCheck !== undefined ? { autoCheck: rawOptions.autoCheck } : {}),
              ...(rawOptions.git !== undefined ? { url: rawOptions.git } : {}),
              ...(rawOptions.ref !== undefined || rawOptions.defaultRef === true
                ? { refPolicy: explicitRefPolicy(rawOptions.ref, rawOptions.defaultRef === true) }
                : {}),
              ...(rawOptions.subdir !== undefined
                ? { subdir: rawOptions.subdir === false ? null : rawOptions.subdir }
                : {}),
            }
            : { autoCheck: rawOptions.autoCheck! };
        const preview = await preflightCatalogSourceMutation({
          request: { action: 'update', sourceId: id, update }, cwd, env,
        });
        const receipt = await updateCatalogSourceCommand({
          sourceId: id,
          update,
          cliVersion: resolveCliVersion(),
          cwd,
          env,
          expectedConfigDigest: preview.configDigest,
          expectedProposedConfigDigest: preview.proposedConfigDigest,
          expectedImpactDigest: preview.impactDigest,
          requireIdentityChangeConfirmation: true,
          confirmIdentityChange: rawOptions.yes === true,
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
    .option('-y, --yes', 'confirm affected or unknown primary source references', false)
    .option('-j, --json', 'print mutation receipt as JSON', false)
    .action(async (id: string, rawOptions: { yes?: boolean; json?: boolean }) => {
      try {
        const receipt = await setPrimaryCatalogSourceCommand({
          sourceId: id,
          cwd,
          env,
          requireImpactConfirmation: true,
          confirmImpact: rawOptions.yes === true,
        });
        if (rawOptions.json) writeJsonReceipt(io.stdout, receipt);
        else writeLine(io.stdout, `Primary catalog source set to ${id}.`);
      } catch (error) {
        await writeCatalogSourceFailure('catalog:source:set-primary', id, rawOptions.json === true, error);
      }
    });

  catalogSource
    .command('remove')
    .argument('<id>')
    .option('-y, --yes', 'confirm affected or unknown source references', false)
    .option('-j, --json', 'print mutation receipt as JSON', false)
    .action(async (id: string, rawOptions: { yes?: boolean; json?: boolean }) => {
      try {
        const receipt = await removeCatalogSourceCommand({
          sourceId: id,
          cwd,
          env,
          requireImpactConfirmation: true,
          confirmImpact: rawOptions.yes === true,
        });
        if (rawOptions.json) writeJsonReceipt(io.stdout, receipt);
        else writeLine(io.stdout, `Catalog source ${id} removed.`);
      } catch (error) {
        await writeCatalogSourceFailure('catalog:source:remove', id, rawOptions.json === true, error);
      }
    });

  const catalogStore = catalog
    .command('store')
    .description('Inspect or prune the immutable Catalog store');

  catalogStore
    .command('status')
    .option('-j, --json', 'print Catalog store status as JSON', false)
    .action(async (rawOptions: { json?: boolean }) => {
      try {
        const result = await catalogStoreStatus({ env });
        if (rawOptions.json) {
          writeJsonReceipt(io.stdout, result);
        } else if (result.entries.length === 0) {
          writeLine(io.stdout, 'Catalog store is empty.');
        } else {
          for (const entry of result.entries) {
            const bytes = entry.reclaimableBytes === null ? 'unknown bytes' : `${entry.reclaimableBytes} bytes`;
            writeLine(io.stdout, `${entry.storeKey}: ${entry.category}, ${entry.status}, ${entry.reason}, ${bytes}`);
          }
          writeLine(io.stdout, `Reclaimable: ${result.totals.reclaimableEntries} item(s).`);
          if (result.errors.length > 0) {
            writeLine(io.stderr, `${result.errors.length} item(s) could not be fully inspected and were retained.`);
          }
        }
        commandExitState.exitCode = result.ok ? 0 : 1;
      } catch (error) {
        const failure = sanitizeCatalogSourceError(error, env);
        const message = redactString(failure.message);
        if (rawOptions.json) writeJsonReceipt(io.stdout, {
          catalogStoreSchemaVersion: 2,
          command: 'catalog:store:status',
          ok: false,
          entries: [],
          errors: [{ code: catalogStoreErrorCode(error), message }],
        });
        writeLine(io.stderr, message);
        commandExitState.exitCode = 1;
      }
    });

  catalogStore
    .command('prune')
    .option('--dry-run', 'inspect reclaimable items without deleting them', false)
    .option('-y, --yes', 'delete items classified as safely reclaimable', false)
    .option('-j, --json', 'print the prune receipt as JSON', false)
    .action(async (rawOptions: { dryRun?: boolean; yes?: boolean; json?: boolean }) => {
      const dryRun = rawOptions.yes !== true;
      try {
        if (rawOptions.dryRun === true && rawOptions.yes === true) {
          throw Object.assign(new Error('catalog store prune cannot combine `--dry-run` and `--yes`.'), {
            code: 'invalidArguments',
          });
        }
        const result = await catalogStorePrune({ dryRun, env });
        if (rawOptions.json) {
          writeJsonReceipt(io.stdout, result);
        } else if (dryRun) {
          writeLine(io.stdout, `Dry run: ${result.entries.filter((entry) => entry.status === 'reclaimable').length} item(s) are reclaimable.`);
          writeLine(io.stdout, 'Run `aw catalog store prune --yes` to delete them.');
          if (result.errors.length > 0) writeLine(io.stderr, `${result.errors.length} item(s) could not be fully inspected and were retained.`);
        } else {
          writeLine(io.stdout, `Deleted ${result.deleted.length} Catalog store item(s) (${result.deletedBytes} bytes).`);
          if (result.errors.length > 0) writeLine(io.stderr, `${result.errors.length} item(s) could not be fully inspected or deleted and were retained.`);
        }
        commandExitState.exitCode = result.ok ? 0 : 1;
      } catch (error) {
        const failure = sanitizeCatalogSourceError(error, env);
        const message = redactString(failure.message);
        const code = catalogStoreErrorCode(error);
        if (rawOptions.json) writeJsonReceipt(io.stdout, {
          catalogStoreSchemaVersion: 2,
          command: 'catalog:store:prune',
          ok: false,
          overallState: 'failed',
          dryRun,
          entries: [],
          deleted: [],
          retained: [],
          errors: [{ code, message }],
          reclaimableBytes: null,
          deletedBytes: 0,
        });
        writeLine(io.stderr, message);
        commandExitState.exitCode = 1;
      }
    });

  program
    .command('init')
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (rawOptions: {
      json?: boolean;
    } & RawDiagnosticsOptions) => {
      const context = createActionContext('init', rawOptions);
      const result = await runActionWithContext(context, () =>
        initCommand({
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
      for (const source of result.sources) {
        if (!source.ok && source.error) writeLine(io.stderr, `${source.id}: ${source.error}`);
      }
      commandExitState.exitCode = result.ok ? 0 : 1;
    });

  program
    .command('sync')
    .description('Reconcile actual state from existing desired intent')
    .argument('[plugins...]')
    .requiredOption('-s, --scope <scope>', 'project or user')
    .requiredOption('-p, --platform <platform>', 'codex, claude, or both')
    .option('-a, --all', 'reconcile every desired plugin in the selected scope', false)
    .option('--refresh', 'refresh only Catalog sources required by selected intent roots', false)
    .option('--script-timeout <ms>', 'override plugin preApply script timeout in milliseconds')
    .option('-y, --yes', 'authorize preApply and shared native replacement or forced repair', false)
    .option('--allow-managed-codex-install', 'allow this command to acquire or rebuild the pinned AW-managed Codex runtime', false)
    .option('-j, --json', 'print sync receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      plugins: string[],
      rawOptions: {
        scope: string;
        platform: string;
        all?: boolean;
        refresh?: boolean;
        scriptTimeout?: string;
        yes?: boolean;
        allowManagedCodexInstall?: boolean;
        json?: boolean;
      } & RawDiagnosticsOptions,
    ) => {
      const context = createActionContext('sync', rawOptions);
      const normalized = normalizeWriteRequest(() => normalizeInstallCommandOptions({
          cwd: context.cwd,
          scope: rawOptions.scope,
          platform: rawOptions.platform,
          scriptTimeout: rawOptions.scriptTimeout,
          allowManagedCodexInstall: rawOptions.allowManagedCodexInstall,
        }));
      const syncPlatform = normalized.platform;
      const result = await runActionWithContext(context, () => syncCommand(
        plugins ?? [],
        {
          cwd: context.cwd,
          env: context.env,
          platform: syncPlatform,
          scope: normalized.scope,
          all: rawOptions.all,
          refresh: rawOptions.refresh,
          cliVersion: resolveCliVersion(),
          yes: rawOptions.yes,
          json: rawOptions.json,
          interactive: context.interactive && context.isTty && !context.isCi,
          prompt: context.prompt,
          allowManagedCodexInstall: rawOptions.allowManagedCodexInstall,
          scriptTimeoutMs: normalized.scriptTimeoutMs,
        },
        context,
      ));
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, buildRebuildReceiptJson('sync', result));
      } else {
        for (const line of renderRebuildReceipt('sync', result)) writeLine(io.stdout, line);
      }
      writeWarnings(io.stderr, result.warnings, { actionableOnly: true });
      commandExitState.exitCode = resolveCommandReceiptExitCode(result);
    });

  program
    .command('install')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option(
      '--dependency-scope <pluginId[#platform]=scope>',
      'place one dependency at project or user scope; repeat for more dependencies',
      (value: string, previous: string[]) => [...previous, value],
      [],
    )
    .option('--script-timeout <ms>', 'override plugin preApply script timeout in milliseconds')
    .option('--allow-managed-codex-install', 'allow this command to acquire or rebuild the pinned AW-managed Codex runtime', false)
    .option('-y, --yes', 'authorize preApply and shared Codex native replacement', false)
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
          dependencyScope?: string[];
          scriptTimeout?: string;
          allowManagedCodexInstall?: boolean;
          yes?: boolean;
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
    .option('--allow-managed-codex-install', 'allow this command to acquire or rebuild the pinned AW-managed Codex runtime', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      plugins: string[],
      rawOptions: {
        scope?: string;
        platform?: string;
        allowManagedCodexInstall?: boolean;
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
    .command('cleanup')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option('-j, --json', 'print cleanup result as JSON', false)
    .option('--force', 'use exact shallow evidence for exclusively owned damaged output; preserve foreign/shared content; no deleted-plugin-wide cleanup', false)
    .option('-y, --yes', 'authorize cleanup of a deleted plugin across Codex, Claude Code, user and current project, including saved settings and shared native install', false)
    .option('--allow-managed-codex-install', 'allow this command to acquire or rebuild the pinned AW-managed Codex runtime', false)
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
        allowManagedCodexInstall?: boolean;
        yes?: boolean;
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
      commandExitState.exitCode = resolveCommandReceiptExitCode(result);
    });

  program
    .command('reinstall')
    .argument('[plugins...]')
    .option('-s, --scope <scope>', 'project or user')
    .option('-p, --platform <platform>', 'codex | claude | both')
    .option('--script-timeout <ms>', 'override plugin preApply script timeout in milliseconds')
    .option('--allow-managed-codex-install', 'allow this command to acquire or rebuild the pinned AW-managed Codex runtime', false)
    .option('-y, --yes', 'authorize preApply and shared Codex native replacement or forced reinstall', false)
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
        allowManagedCodexInstall?: boolean;
        yes?: boolean;
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
    .option('-j, --json', 'print config as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string | undefined, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:list', rawOptions);
      const outcome = await runActionWithContext(context, async () => {
        resolveConfigReadResolution(rawOptions.scope);
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
          scope: rawOptions.scope ?? 'effective',
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
    .option('-j, --json', 'print config as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (pluginName: string | undefined, key: string | undefined, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:get', rawOptions);
      const outcome = await runActionWithContext(context, async () => {
        resolveConfigReadResolution(rawOptions.scope);
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
          scope: rawOptions.scope ?? 'effective',
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
    .argument('[field]')
    .option('-s, --scope <scope>', 'project or user')
    .option('--value-json <json>', 'set the field to an exact JSON value')
    .option('--value-stdin', 'read the exact string value from stdin until EOF', false)
    .option('--preset <id>', 'set the field to the current manifest preset value')
    .option('--apply', 'apply the saved config to visible desired placements', false)
    .option('--script-timeout <ms>', 'override plugin preApply script timeout in milliseconds')
    .option('-y, --yes', 'confirm preApply and shared Codex native config apply', false)
    .option('-j, --json', 'print receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file')
    .action(async (
      pluginName: string | undefined,
      key: string | undefined,
      rawOptions: RawConfigOptions,
    ) => {
      if (!pluginName || !key) throw new Error(configCommandUsage('set'));
      const context = createActionContext('config:set', rawOptions);
      let outcome;
      try {
        outcome = await runActionWithContext(context, async () => {
        const scope = resolveConfigWriteScope(rawOptions.scope);
        const scriptTimeoutMs = resolveScriptTimeoutMs(rawOptions);
        const explicitValueCount = [
          rawOptions.valueJson !== undefined,
          rawOptions.valueStdin === true,
          rawOptions.preset !== undefined,
        ].filter(Boolean).length;
        if (explicitValueCount > 1
          || (explicitValueCount === 0
            && !(context.interactive && context.isTty && !context.isCi && rawOptions.json !== true))) {
          throw new Error('Use exactly one of --value-json <json>, --value-stdin, or --preset <id>.');
        }
        return withResolvedConfigMutationPlugin(
            context,
            pluginName,
            async ({ pluginId, source, plugin }, awHomeMutationToken, catalogOperationContext) => {
        if (!plugin.manifest.config?.fields) {
          throw new Error(`configSchemaUnavailable: Plugin "${pluginName}" does not declare an AW config schema.`);
        }
        const field = plugin.manifest.config.fields[key];
        if (!field) {
          throw new Error(`Unknown config key "${key}".`);
        }
        const sensitive = field.sensitive === true;
        if (sensitive && scope !== 'user') {
          const error = new Error(
            'sensitiveProjectConfigUnsupported: Sensitive config can only be set in user scope.',
          ) as Error & { code: string };
          error.code = 'sensitiveProjectConfigUnsupported';
          throw error;
        }
        if (sensitive && (rawOptions.valueJson !== undefined || rawOptions.preset !== undefined)) {
          const error = new Error(
            'sensitiveConfigInputUnsupported: Sensitive config cannot use --value-json or --preset.',
          ) as Error & { code: string };
          error.code = 'sensitiveConfigInputUnsupported';
          throw error;
        }
        if (!sensitive && explicitValueCount !== 1) {
          throw new Error('Use exactly one of --value-json <json>, --value-stdin, or --preset <id>.');
        }
        let inputValue: unknown;
        if (rawOptions.valueStdin === true) {
          inputValue = await readUtf8Stdin(context.stdin);
        } else if (sensitive) {
          if (!(context.interactive && context.isTty && !context.isCi && rawOptions.json !== true)
            || !context.prompt.password) {
            const error = new Error(
              'sensitiveConfigStdinRequired: Use --value-stdin for sensitive config outside an interactive terminal.',
            ) as Error & { code: string };
            error.code = 'sensitiveConfigStdinRequired';
            throw error;
          }
          const response = await context.prompt.password({
            message: `输入 ${field.title ?? key}`,
            mask: true,
          });
          if (response.cancelled || response.action !== 'select' || response.value === undefined) {
            const error = new Error(
              'sensitiveConfigInputCancelled: Sensitive config input was cancelled.',
            ) as Error & { code: string };
            error.code = 'sensitiveConfigInputCancelled';
            throw error;
          }
          inputValue = response.value;
        } else if (rawOptions.valueJson !== undefined) {
          try {
            inputValue = JSON.parse(rawOptions.valueJson) as unknown;
          } catch {
            throw new Error('--value-json must contain valid JSON.');
          }
        } else {
          const preset = field.choices?.presets.find((entry) => entry.id === rawOptions.preset);
          if (!preset) throw new Error(`Unknown preset "${rawOptions.preset}" for config key "${key}".`);
          inputValue = structuredClone(preset.value);
        }
        const writeReceipt = await applyPluginConfigWrite({
          plugin,
          pluginName: plugin.manifest.name,
          scope,
          cwd: context.cwd,
          env: context.env,
          nativeCliRunner: context.nativeCliRunner,
          rebuildRuntime: {
            ...context,
            awHomeMutationToken,
            catalogOperationContext,
            expectedGenerationSetDigest: catalogOperationContext.generationSetDigest,
            ...(scriptTimeoutMs === undefined ? {} : { scriptTimeoutMs }),
          },
          awHomeMutationToken,
          request: {
            updates: { [key]: inputValue },
          },
          apply: rawOptions.apply === true,
          sharedNativeApplyConfirmed: rawOptions.yes === true,
          preApplyConfirmed: rawOptions.yes === true,
        });
        return buildConfigMutationReceipt('config:set', {
          ok: writeReceipt.overallState === 'succeeded',
          ...writeReceipt,
          plugin: plugin.manifest.name,
          pluginName: plugin.manifest.name,
          pluginId,
          sourceId: source.sourceId,
          sourceIdentity: source.sourceIdentity,
          affectedFields: [{
            key,
            title: field.title ?? key,
            kind: 'manifest' as const,
            reserved: false,
            action: 'set' as const,
            scope,
          }],
        });
            },
          );
        });
      } catch (error) {
        writeConfigMutationFailure('config:set', pluginName, rawOptions.json === true, error);
        return;
      }
      const receipt = outcome;
      if (rawOptions.json) {
        writeJsonReceipt(io.stdout, receipt);
      } else {
        writeLine(io.stdout, `已写入 ${receipt.plugin}.${key}（${configLayerLabel(receipt.scope)}配置）。`);
        writeConfigApplyNotice(io.stderr, receipt);
      }
      commandExitState.exitCode = receipt.overallState === 'succeeded' ? 0 : 1;
    });

  config
    .command('unset')
    .argument('[plugin]')
    .argument('[key]')
    .option('-s, --scope <scope>', 'project or user')
    .option('--apply', 'apply the saved config to visible desired placements', false)
    .option('--script-timeout <ms>', 'override plugin preApply script timeout in milliseconds')
    .option('-y, --yes', 'confirm preApply and shared Codex native config apply', false)
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
        const scriptTimeoutMs = resolveScriptTimeoutMs(rawOptions);
        const execute = async (
          selectedPlugin: string,
          selectedKey: string,
          confirmed: boolean,
        ) =>
          withResolvedConfigMutationPlugin(
            context,
            selectedPlugin,
            async ({ pluginId, source, plugin }, awHomeMutationToken, catalogOperationContext) => {
        const store = await readPluginConfigStore({
          sourceId: source.sourceId,
          sourceIdentity: source.sourceIdentity,
          logicalIdentity: source.logicalIdentity,
          pluginName: plugin.manifest.name,
          scope,
          cwd: context.cwd,
          env: context.env,
          schema: plugin.manifest.config?.fields,
        });
        const existed = Object.hasOwn(store.values, selectedKey);
        if (!existed) throw new Error(`Unknown config key "${selectedKey}".`);
        const writeReceipt = await applyPluginConfigWrite({
          plugin,
          pluginName: plugin.manifest.name,
          scope,
          cwd: context.cwd,
          env: context.env,
          nativeCliRunner: context.nativeCliRunner,
          rebuildRuntime: {
            ...context,
            awHomeMutationToken,
            catalogOperationContext,
            expectedGenerationSetDigest: catalogOperationContext.generationSetDigest,
            ...(scriptTimeoutMs === undefined ? {} : { scriptTimeoutMs }),
          },
          awHomeMutationToken,
          request: {
            removeKeys: [selectedKey],
          },
          apply: rawOptions.apply === true,
          sharedNativeApplyConfirmed: confirmed,
          preApplyConfirmed: rawOptions.yes === true,
        });
        return buildConfigMutationReceipt('config:unset', {
          ok: writeReceipt.overallState === 'succeeded',
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
            title: plugin?.manifest.config?.fields?.[selectedKey]?.title ?? selectedKey,
            kind: 'manifest' as const,
            reserved: false,
            action: 'unset' as const,
            scope,
            ...(!plugin.manifest.config?.fields?.[selectedKey] ? { stale: true as const } : {}),
          }],
        });
            },
          );
        if (pluginName && key) {
          return {
            cancelled: false as const,
            value: await execute(pluginName, key, rawOptions.yes === true),
          };
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
          initial: { plugins: pluginName ? [pluginName] : [], key, scope },
          pluginMode: pluginName ? 'none' : 'single',
          promptForKey: key === undefined,
          destructive: true,
          ...equivalentConfigCommandProjection((selection) => ({
            command: 'unset',
            plugin: selection.plugins[0]!,
            key: selection.key!,
            scope: selection.scope ?? 'user',
          })),
          resultState: overallResultState,
          execute: (selection) => execute(selection.plugins[0]!, selection.key!, true),
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
          ? `已删除 ${receipt.plugin}.${receipt.removedKey}（${configLayerLabel(receipt.scope)}配置）。`
          : `${receipt.plugin}.${receipt.removedKey}（${configLayerLabel(receipt.scope)}配置）原本不存在。`);
        writeConfigApplyNotice(io.stderr, receipt);
      }
      commandExitState.exitCode = receipt.overallState === 'succeeded' ? 0 : 1;
    });

  config
    .command('reset')
    .argument('[plugin]')
    .option('-s, --scope <scope>', 'project or user')
    .option('--apply', 'apply the saved config to visible desired placements', false)
    .option('--script-timeout <ms>', 'override plugin preApply script timeout in milliseconds')
    .option('-y, --yes', 'confirm destructive reset and preApply/shared Codex native config apply', false)
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
          confirmed: boolean,
        ) => {
          const scriptTimeoutMs = resolveScriptTimeoutMs(rawOptions);
          if (!confirmed) {
            throw new Error(
              `Reset requires confirmation. Re-run \`aw config reset ${selectedPlugin} -s ${selectedScope} --yes\` to delete this store.`,
            );
          }
          const located = await resolveStoredConfigResetIdentity({
            selector: selectedPlugin,
            context,
            scope: selectedScope,
          });
          const resetLocatedStore = async (
            plugin: ResolvedCatalogPlugin['plugin'] | null,
            pluginError: Error | null,
          ) => {
            const affectedFields = await describeResetAffectedFields({
              sourceId: located.sourceId,
              sourceIdentity: located.sourceIdentity,
              logicalIdentity: located.logicalIdentity,
              pluginName: located.pluginName,
              plugin,
              pluginError,
              scope: selectedScope,
              cwd: context.cwd,
              env: context.env,
            }).catch(() => []);
            const resetReceipt = await resetPluginConfigWithHelper({
              sourceId: located.sourceId,
              sourceIdentity: located.sourceIdentity,
              logicalIdentity: located.logicalIdentity,
              pluginName: located.pluginName,
              scope: selectedScope,
              cwd: context.cwd,
              env: context.env,
              nativeCliRunner: context.nativeCliRunner,
              plugin,
              pluginError,
              apply: rawOptions.apply === true,
              rebuildRuntime: scriptTimeoutMs === undefined ? undefined : { scriptTimeoutMs },
              sharedNativeApplyConfirmed: confirmed,
              preApplyConfirmed: rawOptions.yes === true,
            });
            return buildConfigMutationReceipt('config:reset', {
              ok: resetReceipt.overallState === 'succeeded',
              ...resetReceipt,
              plugin: located.pluginName,
              pluginName: located.pluginName,
              pluginId: located.pluginId,
              sourceId: located.sourceId,
              ...(located.sourceIdentity ? { sourceIdentity: located.sourceIdentity } : {}),
              affectedFields,
            });
          };
          let resetStarted = false;
          try {
            return await withResolvedCatalogPlugin({
              selector: located.pluginId,
              cliVersion: resolveCliVersion(),
              env: context.env,
              consume: async ({ plugin }) => {
                resetStarted = true;
                return resetLocatedStore(plugin, null);
              },
            });
          } catch (error) {
            if (resetStarted) throw error;
            return resetLocatedStore(
              null,
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        };

        const scope = resolveConfigWriteScope(rawOptions.scope);
        const needsWizard = pluginName === undefined || rawOptions.yes !== true;
        if (!needsWizard) {
          return {
            cancelled: false as const,
            value: await execute(pluginName, scope, true),
          };
        }
        if (!isWizardAvailable(context, rawOptions)) {
          if (!pluginName) throw new Error(configCommandUsage('reset'));
          return {
            cancelled: false as const,
            value: await execute(pluginName, scope, false),
          };
        }
        const currentCandidates = pluginName ? [] : await loadWizardCandidates(context, {});
        const candidatesByScope = new Map<Scope, CommandWizardPluginCandidate[]>();
        if (!pluginName && (rawOptions.scope === undefined || scope === 'user')) {
          candidatesByScope.set('user', mergeWizardCandidates(
            currentCandidates,
            await loadStoredConfigWizardCandidates(
              context,
              [{ scope: 'user' }],
              { includeEmptyStores: true },
            ),
          ));
        }
        if (!pluginName && (rawOptions.scope === undefined || scope === 'project')) {
          candidatesByScope.set('project', mergeWizardCandidates(
            currentCandidates,
            await loadStoredConfigWizardCandidates(
              context,
              [{ scope: 'project' }],
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
          initial: { plugins: pluginName ? [pluginName] : [], scope },
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
            confirmed: true,
          })),
          resultState: overallResultState,
          execute: (selection) => execute(
            selection.plugins[0]!,
            selection.scope ?? 'user',
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
          ? `已重置 ${receipt.plugin} 的${configLayerLabel(receipt.scope)}配置。`
          : `${receipt.plugin} 没有可重置的${configLayerLabel(receipt.scope)}配置。`);
        writeConfigApplyNotice(io.stderr, receipt);
      }
      commandExitState.exitCode = receipt.overallState === 'succeeded' ? 0 : 1;
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
        () => statusCommandV8({
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
        if (rawOptions.json && source.error) writeLine(io.stderr, `${source.id}: ${source.error}`);
      }
      for (const error of result.payload.errors) {
        if (rawOptions.json && error.code !== 'nativeStateUnreadable' && error.code !== 'stateInventoryFailed') {
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
  const reviewCommand = argv[0] === 'review' && ['inspect', 'prepare'].includes(argv[1] ?? '')
    ? argv[1] as 'inspect' | 'prepare'
    : null;
  const jsonReviewCommand = reviewCommand !== null && argv.includes('--json');
  const jsonAuthoringCommand = argv.includes('--json')
    && (
      (argv[0] === 'catalog' && ['init', 'context', 'version', 'build', 'validate', 'status', 'publish'].includes(argv[1] ?? ''))
      || (argv[0] === 'plugin' && ['build', 'test', 'validate', 'status', 'remove'].includes(argv[1] ?? ''))
      || reviewCommand !== null
    )
    ? `${argv[0]}:${argv[1]}`
    : null;
  const jsonCatalogDevCommand = argv.includes('--json')
    && argv[0] === 'catalog'
    && argv[1] === 'dev'
    && ['activate', 'status', 'deactivate'].includes(argv[2] ?? '')
    ? argv[2] as 'activate' | 'status' | 'deactivate'
    : null;
  const jsonWriteRequest = jsonWriteCommandRequest(argv);
  const jsonConfigMutation = jsonConfigMutationRequest(argv);

  try {
    const authoringScriptByCommand: Record<string, string> = {
      init: 'init-plugin.mjs',
      'add-skill': 'add-skill.mjs',
      remove: 'remove-plugin.mjs',
      validate: 'validate-plugin.mjs',
      status: 'plugin-status.mjs',
    };
    const authoringScript = argv[0] === 'plugin'
      ? authoringScriptByCommand[argv[1] ?? '']
      : argv[0] === 'skill' && argv[1] === 'validate'
        ? 'validate-skill.mjs'
        : undefined;
    if (authoringScript && !argv.includes('--help') && !argv.includes('-h')) {
      const authoringArgs = argv.slice(2);
      let authoringEnv = options.env ?? process.env;
      if (
        argv[0] === 'plugin'
        && !authoringArgs.some((token) => token === '--plugin-root' || token.startsWith('--plugin-root='))
      ) {
        let explicitRoot: string | undefined;
        for (let index = 0; index < authoringArgs.length; index += 1) {
          const token = authoringArgs[index]!;
          if (token.startsWith('--workspace-root=')) explicitRoot = token.slice('--workspace-root='.length);
          if (token === '--workspace-root') explicitRoot = authoringArgs[index + 1];
        }
        const originalCwd = options.cwd ?? process.cwd();
        let discoveryCwd = originalCwd;
        if (argv[1] === 'validate') {
          const valueOptions = new Set(['--workspace-root', '--claude-skill-profile', '--version-base']);
          for (let index = 0; index < authoringArgs.length; index += 1) {
            const token = authoringArgs[index]!;
            if (valueOptions.has(token)) {
              index += 1;
              continue;
            }
            if (!token.startsWith('-')) {
              discoveryCwd = path.resolve(originalCwd, token);
              authoringArgs[index] = discoveryCwd;
              break;
            }
          }
        }
        const workspace = await resolveCatalogWorkspaceRoot({
          cwd: discoveryCwd,
          ...(explicitRoot === undefined ? {} : { explicitRoot: path.resolve(options.cwd ?? process.cwd(), explicitRoot) }),
          mode: 'existing',
        });
        authoringEnv = {
          ...authoringEnv,
          AW_AUTHORING_WORKSPACE_ROOT: workspace.workspaceRoot,
          AW_AUTHORING_WORKSPACE_ROOT_RESOLVED_FROM: workspace.workspaceRootResolvedFrom,
        };
        if (explicitRoot === undefined) authoringArgs.push('--workspace-root', workspace.workspaceRoot);
      }
      return runAuthoringScript({
        scriptName: authoringScript,
        args: authoringArgs,
        cwd: options.cwd ?? process.cwd(),
        env: authoringEnv,
        io,
      });
    }
    if (!jsonConfigMutation
      && argv.some((token) => token === '--subdir' || token.startsWith('--subdir='))
      && argv.includes('--no-subdir')) {
      const message = 'option --subdir cannot be used with option --no-subdir';
      if (argv.includes('--json') && argv[0] === 'catalog' && argv[1] === 'source' && argv[2] === 'update') {
        writeJsonReceipt(io.stdout, {
          receiptSchemaVersion: 6,
          command: 'catalog:source:update',
          ok: false,
          changed: false,
          sourceId: argv[3] ?? '',
          primaryChange: null,
          references: [],
          errors: [{ code: 'catalogSourceOptionConflict', message }],
        });
      }
      writeLine(io.stderr, `error: ${message}`);
      return 1;
    }
    if (argv[0] === 'catalog' && argv[1] === 'source' && argv[2] === 'update'
      && argv.includes('--auto-check') && argv.includes('--no-auto-check')) {
      const message = 'option --auto-check cannot be used with option --no-auto-check';
      if (argv.includes('--json') || argv.includes('-j')) {
        writeJsonReceipt(io.stdout, {
          receiptSchemaVersion: 6,
          command: 'catalog:source:update',
          ok: false,
          changed: false,
          sourceId: argv[3] ?? '',
          primaryChange: null,
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
    let catalogPublicationActionStarted = false;
    let configMutationActionStarted = false;
    const programIo = jsonCatalogDevCommand || jsonWriteRequest || jsonReviewCommand
      ? { ...io, stderr: () => undefined }
      : jsonConfigMutation
        ? {
            ...io,
            stderr: (text: string) => {
              if (configMutationActionStarted) io.stderr(text);
            },
          }
      : jsonAuthoringCommand === 'catalog:publish'
        ? {
            ...io,
            stderr: (text: string) => {
              if (catalogPublicationActionStarted) io.stderr(text);
            },
          }
        : io;
    const program = buildProgram({
      ...options,
      io: programIo,
      diagnostics: {
        ...options.diagnostics,
        metadata: {
          ...options.diagnostics?.metadata,
          argCount: argv.length,
        },
      },
    });
    if (jsonAuthoringCommand === 'catalog:publish') {
      program.hook('preAction', () => {
        catalogPublicationActionStarted = true;
      });
    }
    if (jsonConfigMutation) {
      program.hook('preAction', () => {
        configMutationActionStarted = true;
      });
    }
    await program.parseAsync(['node', 'aw', ...argv]);
    return (program as Command & {
      __awCommandExitState?: { exitCode: number };
    }).__awCommandExitState?.exitCode ?? 0;
  } catch (error) {
    if (reviewCommand && error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      if (jsonReviewCommand) {
        const receipt = reviewCommand === 'inspect'
          ? createReviewInspectionFailure(
              new Error(error.message),
              requestedReviewView(argv),
              'invalidArguments',
            )
          : createReviewPreparationFailure(error.message);
        writeJsonReceipt(io.stdout, receipt);
      }
      return 2;
    }
    if (jsonCatalogDevCommand) {
      const workspaceRootIndex = argv.findIndex((token) => token === '--workspace-root');
      const workspaceRootOption = argv.find((token) => token.startsWith('--workspace-root='));
      const workspaceRoot = workspaceRootOption?.slice('--workspace-root='.length)
        ?? (workspaceRootIndex >= 0 ? argv[workspaceRootIndex + 1] : undefined);
      const sourceIdIndex = argv.findIndex((token) => token === '--source-id');
      const sourceIdOption = argv.find((token) => token.startsWith('--source-id='));
      const sourceId = sourceIdOption?.slice('--source-id='.length)
        ?? (sourceIdIndex >= 0 ? argv[sourceIdIndex + 1] : undefined);
      const failure = error instanceof CommanderError
        ? { code: 'invalidArguments', message: error.message }
        : catalogDevSourceError(error);
      writeJsonReceipt(io.stdout, createCatalogDevFailureReceipt({
        command: jsonCatalogDevCommand,
        cwd: options.cwd ?? process.cwd(),
        workspaceRoot,
        sourceId,
        ...failure,
      }));
      return 1;
    }
    if (jsonWriteRequest) {
      writeCommandFailureReceipt(io.stdout, jsonWriteRequest, error);
      return 1;
    }
    if (jsonConfigMutation) {
      if (error instanceof CommanderError && error.exitCode === 0) return 0;
      const failure = configMutationFailure(
        error,
        options.env ?? process.env,
        options.cwd ?? process.cwd(),
      );
      writeConfigMutationFailureReceipt(
        io.stdout,
        error instanceof CommanderError
          ? { command: jsonConfigMutation.command }
          : jsonConfigMutation,
        failure,
      );
      writeLine(io.stderr, failure.message);
      return 1;
    }
    if (jsonAuthoringCommand === 'catalog:publish' && error instanceof CommanderError) {
      const failure = catalogPublicationFailure({
        error: new CatalogPublicationInspectionError('invalidArguments', error.message),
        env: options.env,
        sensitiveRoots: [options.cwd ?? process.cwd()],
      });
      writeJsonReceipt(io.stdout, failure);
      writeLine(io.stderr, failure.message);
      return 1;
    }
    if (jsonAuthoringCommand && !(error instanceof CommanderError)) {
      const message = error instanceof Error ? error.message : String(error);
      if (jsonAuthoringCommand === 'plugin:validate') {
        writeJsonReceipt(io.stdout, {
          ok: false,
          profile: 'unknown',
          warnings: [],
          errors: [message],
        });
      } else if (jsonAuthoringCommand === 'plugin:status') {
        writeJsonReceipt(io.stdout, {
          schemaVersion: 3,
          policy: 'development',
          ok: false,
          base: null,
          requestedBase: null,
          baseCommit: null,
          checkedPlugins: 0,
          checks: [],
          workspaceRoot: null,
          workspaceRootResolvedFrom: null,
          errors: [{ code: 'workspaceResolutionFailed', message }],
        });
      } else if (jsonAuthoringCommand === 'plugin:remove') {
        writeJsonReceipt(io.stdout, {
          schemaVersion: 1,
          command: 'plugin:remove',
          ok: false,
          workspaceRoot: null,
          workspaceRootResolvedFrom: null,
          baseCommit: null,
          plugin: null,
          removed: false,
          errors: [{ code: 'workspaceResolutionFailed', message }],
        });
      } else if (jsonAuthoringCommand === 'review:inspect') {
        writeJsonReceipt(io.stdout, createReviewInspectionFailure(
          error,
          requestedReviewView(argv),
        ));
      } else if (jsonAuthoringCommand === 'review:prepare') {
        writeJsonReceipt(io.stdout, createReviewPreparationFailure(message, 'reviewPreparationFailed'));
      } else {
        writeJsonReceipt(io.stdout, {
          command: jsonAuthoringCommand,
          ok: false,
          errors: [{ code: 'workspaceResolutionFailed', message }],
        });
      }
      return 1;
    }
    if (jsonAuthoringCommand && error instanceof CommanderError) {
      writeJsonReceipt(io.stdout, jsonAuthoringCommand === 'review:inspect'
        ? createReviewInspectionFailure(
            new Error(error.message),
            requestedReviewView(argv),
            'invalidArguments',
          )
        : jsonAuthoringCommand === 'review:prepare'
          ? createReviewPreparationFailure(error.message)
        : {
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
