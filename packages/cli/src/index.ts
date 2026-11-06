#!/usr/bin/env node
import { describeNativeToolClosure } from './utils/native-tool-review.js';

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { doctorEvalProviders } from '@lesliechan721/agent-skill-eval';
import { compilePluginConfigDefinition, PLATFORM_TARGETS, PORTABLE_PLATFORM_TARGETS } from '@lesliechan721/aw-plugin-core/manifest';

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
  formatInteractiveConsoleUnavailableMessage,
  runConsoleController,
} from './commands/console.js';
import {
  WizardExecutionError,
} from './commands/wizard.js';
import {
  createCliExecutionContext,
  emitCommandEvent,
  type CliExecutionContext,
  type CliExecutionContextInput,
  type CliIo,
  type CommandDiagnosticsInput,
} from './commands/runtime.js';
import {
  parseContextValue,
  parsePlatformTargetValue,
  parseScopeValue,
  resolveScriptTimeoutMs,
} from './commands/options.js';
import {
  isCommandWarningError,
  type RebuildReceiptOverallState,
} from './types.js';
import { formatWarnings } from './output/reporter.js';
import { redactString, redactValue } from './output/redact.js';
import {
  buildInitReceiptJson,
  renderInitReceipt,
} from './output/command-receipt.js';
import { resolveCliPackageRoot } from './utils/paths.js';
import {
  findConfigFieldEntry,
  formatPluginConfigSetRecoveryCommand,
  listNamespacedPluginConfigStores,
  readPluginConfigStore,
  renderPluginConfigValueForDisplay,
  resolveConfigRead,
} from './utils/plugin-config.js';
import {
  applyPluginConfigWrite,
  applyPluginConfig,
  buildConfigMutationReceipt,
  configWriteStateForError,
  resetPluginConfigWithHelper,
} from './utils/plugin-config-write.js';
import { assertStrictSemVer } from './utils/manifest.js';
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
  PlatformTarget,
  PortablePlatformTarget,
  Scope,
} from './types.js';
import { materializePortableSkillsToDirectory, PortableCommandError } from './portable/commands.js';
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
import { prepareSkillEval } from './commands/skill-eval.js';
import { readRecoveryStatus, checkRecovery } from './recovery/status.js';
import { intentAdd, intentRemove, intentList } from './commands/intent-command.js';
import { targetsSet, targetsList, targetsChangeExclusion } from './commands/targets-command.js';
import { runRecovery } from './recovery/coordinator.js';
import { runRetire } from './recovery/retirement.js';
import type { RecoveryReceipt } from './recovery/receipt.js';
import { normalizeAgents } from './intent/deployment-preferences.js';
import { resolveWorkContext } from './intent/work-context.js';
import { registerManagedCommandCli, runManagedCommandCli } from './commands/managed-commands.js';

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

function collectUniqueOption(value: string, previous: string[] = []): string[] {
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
  renderReviewSkills(write, receipt.skills, receipt.issues);
}

function renderReviewPreparation(
  write: (text: string) => void,
  receipt: ReviewPreparationV1,
): void {
  writeLine(write, `Review preparation: ${receipt.ok ? 'complete' : 'failed'}`);
  if (receipt.sourceBindingPath) writeLine(write, `Source binding: ${receipt.sourceBindingPath}`);
  renderReviewSkills(write, receipt.skills, receipt.issues);
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

interface RawDiagnosticsOptions {
  verbose?: boolean;
  debug?: boolean;
  logFile?: string;
}

interface RawConfigOptions extends RawDiagnosticsOptions {
  context?: string;
  platform?: string;
  target?: string[];
  json?: boolean;
  valueJson?: string;
  valueStdin?: boolean;
  preset?: string;
  yes?: boolean;
  apply?: boolean;
  scriptTimeout?: string;
}

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

function recoveryRequest(argv: string[]): { command: string; scope: Scope | null; json: boolean } | null {
  const nested = argv[0] === 'plugin';
  const args = nested ? argv.slice(1) : argv;
  const family = args[0] ?? '';
  if (nested && ['remove', 'status'].includes(family)
    && args.some((value) => value === '--workspace-root' || value.startsWith('--workspace-root='))) return null;
  if (!['intent', 'targets', 'sync', 'install', 'remove', 'reinstall', 'uninstall', 'cleanup', 'status', 'project'].includes(family)) return null;
  let rawScope: string | undefined;
  let json = false;
  for (let index = 1; index < args.length; index++) {
    const value = args[index]!;
    if (value === '--') break;
    if (value === '--scope') rawScope = args[++index];
    else if (value.startsWith('--scope=')) rawScope = value.slice('--scope='.length);
    else if (value === '--json' || (/^-[ajvyD]+$/u.test(value) && value.includes('j'))) json = true;
    else if (['--target', '--context', '--script-timeout', '--log-file'].includes(value)) index++;
  }
  return {
    command: ['intent', 'targets', 'project'].includes(family) ? `${family}:${args[1] ?? ''}` : family,
    scope: rawScope === 'user' || rawScope === 'project' ? rawScope : null,
    json,
  };
}

function recoveryFailureReceipt(command: string, scope: Scope | null, error: unknown) {
  const failure = writeCommandFailure(error);
  return {
    schemaVersion: 1, kind: 'aw-recovery', scope, command, ok: false,
    intent: { state: 'unreadable', roots: null }, requestedRoots: [], requestedTargets: [],
    selection: { agents: [], origin: 'none', preferences: 'unreadable' },
    blockers: [failure], errors: [failure], targetResults: [], remainingTargets: [], recoveryActions: [],
    declarationChanged: false, preferencesChanged: false, configChanged: false, outputsMayHaveChanged: false,
  };
}

interface PreparsedConfigMutationJsonRequest {
  command: ConfigMutationCommand;
  plugin?: string;
}

function scanConfigMutationShortOptions(
  token: string,
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
    if (option === 'v' || option === 'D' || option === 'y') {
      continue;
    }
    break;
  }

  return { json, consumesNextValue: false };
}

function jsonConfigMutationRequest(argv: string[]): PreparsedConfigMutationJsonRequest | null {
  const args = argv[0] === 'plugin' ? argv.slice(1) : argv;
  if (args[0] !== 'config' || !['set', 'edit', 'unset', 'reset', 'apply'].includes(args[1] ?? '')) {
    return null;
  }
  const command = `config:${args[1]}` as ConfigMutationCommand;
  let json = false;
  let plugin: string | undefined;
  const valueOptions = new Set(['--platform', '--context', '--target', '--value-json', '--preset', '--log-file', '--script-timeout']);

  for (let index = 2; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === '--') break;
    if (valueOptions.has(token)) {
      index += 1;
      continue;
    }
    if (token === '--json') {
      json = true;
      continue;
    }
    const shortOptions = scanConfigMutationShortOptions(token);
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

function jsonConfigReadRequested(argv: readonly string[]): boolean {
  if (argv[0] !== 'plugin' || argv[1] !== 'config'
    || !['schema', 'list', 'get'].includes(argv[2] ?? '')) return false;
  const values = new Set(['--platform', '--context', '--target', '--script-timeout', '--log-file']);
  for (let index = 3; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === '--') break;
    if (values.has(token)) { index++; continue; }
    if (token === '--json' || /^-[jvD]+$/u.test(token) && token.includes('j')) return true;
  }
  return false;
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

function isWizardAvailable(
  context: CliExecutionContext,
  rawOptions: { json?: boolean },
): boolean {
  return context.interactive && context.isTty && !context.isCi && rawOptions.json !== true;
}

async function readUtf8Stdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin as AsyncIterable<string | Buffer | Uint8Array>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
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
    sourceIdentity: match!.binding.sourceIdentity,
  };
}

async function resolveStoredOnlyConfigIdentity(options: {
  selector: string;
  context: CliExecutionContext;
}): Promise<{
  pluginName: string;
  pluginId: string;
  sourceId: string;
  sourceIdentity?: string;
  logicalIdentity?: string;
}> {
  const parsed = parsePluginId(options.selector);
  if (!parsed.sourceId) throw new Error(`Plugin "${options.selector}" is not a qualified stored config target.`);
  const stores = (await listNamespacedPluginConfigStores({
    cwd: options.context.cwd, env: options.context.env, scope: 'user',
  })).filter((store) => store.pluginId === options.selector);
  if (stores.length === 0) throw new Error(`Plugin "${options.selector}" does not have a namespaced config store.`);
  const sourceBindings = stores.flatMap((store) => store.binding.kind === 'source'
    ? [store.binding.sourceIdentity] : []);
  if (new Set(sourceBindings).size > 1) {
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
    scope: options.rawOptions.context === 'project' ? 'project' : 'user',
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
        scope: options.rawOptions.context === 'project' ? 'project' : 'user',
        platform: options.rawOptions.platform as PlatformTarget | undefined,
        cwd: options.context.cwd,
        env: options.context.env,
      });
      if (options.key !== undefined) {
        const field = findConfigFieldEntry(result.fields, options.key);
        if (!field && compilePluginConfigDefinition(plugin.manifest.config,
          options.rawOptions.platform as PlatformTarget | undefined).fields[options.key] === undefined) {
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
    });
    const result = await resolveConfigRead({
      sourceId: stored.sourceId,
      sourceIdentity: stored.sourceIdentity,
      logicalIdentity: stored.logicalIdentity,
      pluginName: stored.pluginName,
      plugin: null,
      scope: options.rawOptions.context === 'project' ? 'project' : 'user',
        platform: options.rawOptions.platform as PlatformTarget | undefined,
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

interface RawRecoveryOptions extends RawDiagnosticsOptions {
  context?: string;
  apply?: boolean;
  none?: boolean;
  rebuild?: boolean;
  all?: boolean;
  check?: boolean;
  refresh?: boolean;
  scope?: string;
  target?: string[] | string;
  scriptTimeout?: string;
  json?: boolean;
  force?: boolean;
  dependencyScope?: string[];
  deleteConfig?: boolean;
  yes?: boolean;
}

function renderRecoveryReceipt(write: (text: string) => void, value: RecoveryReceipt): void {
  writeLine(write, `${value.command} [${value.scope}]: ${value.ok ? 'ok' : 'failed'}`);
  writeLine(write, `需求：${value.intent.roots?.join('、') || (value.intent.roots === null ? '不可读' : '无')}`);
  writeLine(write, `本机工具：${value.selection.agents.join('、') || '未配置'}`);
  writeLine(write, `变化：声明 ${value.declarationChanged ? '已保存' : '无'}；偏好 ${value.preferencesChanged ? '已保存' : '无'}；配置 ${value.configChanged ? '已保存' : '无'}；输出 ${value.outputsMayHaveChanged ? '可能已变更' : '无'}`);
  for (const target of value.targetResults) {
    writeLine(write, `${target.pluginId} / ${target.agent} [${target.scope}]: ${target.execution}; ${target.content ?? target.observation}`);
  }
  for (const result of value.commandResults ?? []) {
    const producer = result.producer;
    writeLine(write, `托管命令 ${producer.sourceId}/${producer.pluginName}/${producer.key} [${producer.scope}]: ${result.state}`);
  }
  for (const change of value.nativeToolChanges ?? []) {
    for (const phase of ['before', 'after'] as const) {
      const closure = change[phase];
      if (closure) for (const description of describeNativeToolClosure(closure)) {
        writeLine(write, `原生工具 ${change.producer.sourceId}/${change.producer.pluginName} ${phase}: ${description}`);
      }
    }
  }
  const diagnostics = new Map([...value.blockers, ...value.errors,
    ...value.targetResults.flatMap((target) => target.blockers),
    ...(value.commandResults ?? []).flatMap((result) => result.errors),
  ].map((item) => [`${item.code}:${item.message}`, item]));
  for (const item of diagnostics.values()) writeLine(write, `${item.code}: ${item.message}`);
  for (const action of value.recoveryActions) writeLine(write, action);
}

function renderRecoveryStatus(write: (text: string) => void, value: Awaited<ReturnType<typeof readRecoveryStatus>>): void {
  writeLine(write, `status [${value.scope}]: ${value.ok ? 'ok' : 'failed'}`);
  writeLine(write, `本机工具：${value.selection.agents.join('、') || '未配置'}`);
  writeLine(write, `全部满足：${value.allSatisfied === null ? '未知' : value.allSatisfied ? '是' : '否'}`);
  for (const root of value.inventory ?? []) {
    writeLine(write, `${root.pluginId}: ${root.targetResults.length ? root.targetResults.map((target) =>
      `${target.agent}/${target.content ?? target.observation}`).join(', ') : 'localTargetsRequired'}`);
  }
  for (const error of value.errors) writeLine(write, `${error.code}: ${error.message}`);
}

function recoveryRuntime(
  context: CliExecutionContext,
  rawOptions: RawRecoveryOptions,
  directCli: boolean,
) {
  return {
    ...context,
    directCli,
    preApplyConfirmed: rawOptions.yes === true,
  };
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
      const command = `aw plugin sync ${receipt.plugin} --rebuild --target ${entry.target.platform} --context ${entry.target.scope}`;
      const recovery = entry.errorCode === 'invalidConfig'
        ? ` 请修复无效配置后运行 ${command}。`
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
      ? '配置内容没有变化，因此没有刷新输出。'
      : receipt.apply.reason === 'noEffectiveConfigChange'
        ? '配置存储已更新，但有效配置没有变化，因此没有刷新输出。'
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
      ? '请修复无效配置，再运行 aw plugin sync <source/plugin>。'
      : receipt.apply.reason === 'effectiveConfigUnavailable'
        ? '请修复配置，再运行 aw plugin sync <source/plugin>。'
        : receipt.apply.reason === 'schemaUnavailable' || receipt.apply.reason === 'sourceUnavailable'
          ? '请修复插件来源或配置，再运行 aw plugin sync <source/plugin>。'
          : '请修复来源或配置，再运行 aw plugin sync <source/plugin>。';
    writeLine(write, `配置已保存，但当前无法应用配置。${detail} ${recovery}`);
    writeTargetFailures();
  } else {
    const completed = targetResults.filter((entry) => entry.state === 'completed').length;
    const failed = targetResults.filter((entry) => entry.state === 'failed').length;
    const skipped = targetResults.filter((entry) => entry.state === 'skipped').length;
    writeLine(write, `配置已保存。已刷新 ${completed} 个当前可见目标；失败 ${failed} 个；跳过 ${skipped} 个。`);
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
      const context = resolved.context ?? 'user';
      const definition = resolved.fieldDefinitions?.[field.key];
      if (definition) {
        writeLine(write, `  ${formatPluginConfigSetRecoveryCommand(
          pluginName,
          field.key,
          definition,
          context,
          resolved.platform,
        )}`);
      }
      const profileOptions = ` --context ${context}${resolved.platform ? ` --platform ${resolved.platform}` : ''}`;
      writeLine(write, `  aw plugin config unset ${pluginName} ${field.key}${profileOptions}`);
      writeLine(write, `  aw plugin config reset ${pluginName}${profileOptions} --yes`);
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
    .description('Manage plugin demand, outputs, configuration, and author sources');

  registerManagedCommandCli(program, () => createActionContext('command', {}), {
    cliEntry: fileURLToPath(import.meta.url),
    cliVersion: resolveCliVersion(),
  }, (code) => { commandExitState.exitCode = code; });

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
        writeJsonReceipt(io.stdout, await doctorEvalProviders({
          sourceEnv: env,
        }));
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
    .description('Inspect and prepare Skill review materializations');

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
      'select a canonical platform target',
      PLATFORM_TARGETS,
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
      'select the review navigation view',
      ['review'],
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
        const receipt = createReviewInspectionFailure(error);
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
      'select a canonical platform target',
      PLATFORM_TARGETS,
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

  skill
    .command('materialize')
    .description('Write portable Skills to a safe output directory')
    .argument('<plugin>', 'plugin or source/plugin selector')
    .addOption(strictValueOption('--platform <target>', 'Portable platform target', PORTABLE_PLATFORM_TARGETS).makeOptionMandatory())
    .addOption(strictValueOption('-s, --scope <scope>', 'artifact scope', ['user', 'project']).makeOptionMandatory())
    .requiredOption('--out <dir>', 'output directory')
    .option('--skill <name...>', 'write only selected Skill names')
    .option('-j, --json', 'emit one receipt v5 JSON object', false)
    .action(async (selector: string, rawOptions: {
      scope: string;
      platform: PortablePlatformTarget;
      out: string;
      skill?: string[];
      json?: boolean;
    }) => {
      const context = createActionContext('skill:materialize', {});
      try {
        const receipt = await runActionWithContext(context, () =>
          materializePortableSkillsToDirectory({
            selector,
            platform: rawOptions.platform,
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
          ?? (error instanceof PortableCommandError
          ? error.code
          : 'portableMaterializeFailed');
        writeJsonReceipt(io.stdout, {
          receiptSchemaVersion: 5,
          command: 'skill:materialize',
          ok: false,
          plugin: { id: selector },
          scope: rawOptions.scope,
          platform: rawOptions.platform,
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
    .option('--native-mode <mode>', 'fixture | installed | source-candidate (default: fixture)')
    .option('--native-context <path>', 'explicit tool context JSON for fixture or source-candidate mode')
    .option('--json', 'emit one machine-readable JSON result', false)
    .action(async (pluginDirectory: string, rawOptions: {
      workspaceRoot?: string;
      nativeMode?: string;
      nativeContext?: string;
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
          nativeMode: rawOptions.nativeMode,
          nativeContext: rawOptions.nativeContext ? path.resolve(cwd, rawOptions.nativeContext) : undefined,
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
    commandExitState.exitCode = failure.code === 'invalidArguments' ? 2 : 1;
  };

  const withResolvedConfigMutationPlugin = <T>(
    context: CliExecutionContext,
    selector: string,
    consume: (
      resolution: ResolvedCatalogPlugin,
      awHomeMutationToken: AwHomeMutationToken,
      catalogOperationContext: CatalogOperationContext,
    ) => Promise<T> | T,
    _apply = false,
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

  const recoveryCommand = (command: Command): Command => command
    .option('-j, --json', 'print one recovery receipt as JSON', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file');
  const scopedCommand = (command: Command): Command => recoveryCommand(command)
    .addOption(strictValueOption('--scope <scope>', 'requirement or physical scope', ['user', 'project']).makeOptionMandatory());
  const contextualCommand = (command: Command): Command => recoveryCommand(command)
    .addOption(strictValueOption('--context <context>', 'user only, or user and current project', ['user', 'project']));
  const recoveryScope = (rawOptions: RawRecoveryOptions): Scope =>
    normalizeWriteRequest(() => parseScopeValue(rawOptions.scope));
  const recoveryTargets = (rawOptions: RawRecoveryOptions) => rawOptions.target === undefined
    ? undefined : normalizeWriteRequest(() => normalizeAgents(typeof rawOptions.target === 'string' ? [rawOptions.target] : rawOptions.target!));
  const recoveryContext = (rawOptions: RawRecoveryOptions): Scope | undefined => rawOptions.context === undefined
    ? undefined : normalizeWriteRequest(() => parseContextValue(rawOptions.context));
  const runRecoveryAction = async (
    command: string,
    rawOptions: RawRecoveryOptions,
    action: (context: CliExecutionContext) => Promise<RecoveryReceipt>,
  ): Promise<void> => {
    const context = createActionContext(command, rawOptions);
    const result = await runActionWithContext(context, () => action(context));
    if (rawOptions.json) writeJsonReceipt(io.stdout, result);
    else renderRecoveryReceipt(io.stdout, result);
    commandExitState.exitCode = result.ok ? 0
      : result.errors.some((error) => error.code === 'invalidArguments') ? 2 : 1;
  };
  const showWorkContext = async (context: CliExecutionContext, rawOptions: RawRecoveryOptions) => {
    if (rawOptions.scope === 'project' && rawOptions.context === 'user') {
      throw new WriteCommandRequestError('--scope project cannot be combined with --context user.');
    }
    const work = await resolveWorkContext({ cwd: context.cwd, context: recoveryContext(rawOptions),
      ...(rawOptions.scope === undefined ? {} : { scope: recoveryScope(rawOptions) }) });
    if (!rawOptions.json) writeLine(io.stdout, work.projectRoot
      ? `工作上下文：用户与当前项目 ${work.projectRoot}` : '工作上下文：仅用户');
    return work;
  };

  const intent = plugin.command('intent').description('Manage user or project plugin requirements');
  scopedCommand(intent.command('add').argument('<plugins...>'))
    .action(async (plugins: string[], rawOptions: RawRecoveryOptions) =>
      runRecoveryAction('intent:add', rawOptions, (context) =>
        intentAdd({ scope: recoveryScope(rawOptions), cwd: context.cwd, env: context.env, selectors: plugins })));
  scopedCommand(intent.command('remove').argument('<plugins...>'))
    .action(async (plugins: string[], rawOptions: RawRecoveryOptions) =>
      runRecoveryAction('intent:remove', rawOptions, (context) =>
        intentRemove({ scope: recoveryScope(rawOptions), cwd: context.cwd, env: context.env, selectors: plugins })));
  scopedCommand(intent.command('list'))
    .action(async (rawOptions: RawRecoveryOptions) =>
      runRecoveryAction('intent:list', rawOptions, (context) =>
        intentList({ scope: recoveryScope(rawOptions), cwd: context.cwd, env: context.env })));
  scopedCommand(intent.command('retire').argument('<plugin>'))
    .description('Retire a plugin proven absent from its healthy Catalog')
    .option('--target <target>', 'limit output changes to a platform target', collectUniqueOption)
    .option('--delete-config', 'also delete saved user plugin configuration', false)
    .option('-y, --yes', 'confirm the reviewed retirement changes', false)
    .action(async (selector: string, rawOptions: RawRecoveryOptions) =>
      runRecoveryAction('intent:retire', rawOptions, (context) =>
        runRetire({ scope: recoveryScope(rawOptions), cwd: context.cwd, env: context.env, selector,
          cliVersion: resolveCliVersion(), targets: recoveryTargets(rawOptions),
          deleteConfig: rawOptions.deleteConfig, yes: rawOptions.yes,
          interactive: isWizardAvailable(context, rawOptions), prompt: context.prompt,
        }, recoveryRuntime(context, rawOptions, true))));

  const targets = plugin.command('targets').description('Manage the local platform policy');
  contextualCommand(targets.command('set').argument('[targets...]'))
    .option('--none', 'save an empty target set', false)
    .option('--apply', 'apply the saved target policy in this work context', false)
    .option('-y, --yes', 'confirm reviewed output changes', false)
    .action(async (agents: string[], rawOptions: RawRecoveryOptions) => {
      if (rawOptions.none ? agents.length > 0 : agents.length === 0) {
        throw new WriteCommandRequestError('Use target IDs or --none, but not both.');
      }
      const normalized = normalizeWriteRequest(() => normalizeAgents(agents));
      await runRecoveryAction('targets:set', rawOptions, async (context) => {
        await showWorkContext(context, rawOptions);
        return targetsSet({ cwd: context.cwd, env: context.env, targets: normalized,
          context: recoveryContext(rawOptions), apply: rawOptions.apply, yes: rawOptions.yes,
          cliVersion: resolveCliVersion(), runtime: recoveryRuntime(context, rawOptions, true) });
      });
    });
  contextualCommand(targets.command('list'))
    .action(async (rawOptions: RawRecoveryOptions) =>
      runRecoveryAction('targets:list', rawOptions, (context) =>
        targetsList({ cwd: context.cwd, env: context.env, context: recoveryContext(rawOptions) })));
  for (const action of ['exclude', 'include'] as const) {
    contextualCommand(targets.command(action).argument('<plugin>'))
      .addOption(strictValueOption('--target <target>', 'one canonical platform target', PLATFORM_TARGETS).makeOptionMandatory())
      .option('--apply', 'apply the saved exclusion policy in this work context', false)
      .option('-y, --yes', 'confirm reviewed output changes', false)
      .action(async (selector: string, rawOptions: RawRecoveryOptions & { target: string }) => {
        await runRecoveryAction(`targets:${action}`, rawOptions, async (context) => {
          await showWorkContext(context, rawOptions);
          return targetsChangeExclusion({ cwd: context.cwd, env: context.env, context: recoveryContext(rawOptions),
            selector, target: rawOptions.target, excluded: action === 'exclude', apply: rawOptions.apply,
            yes: rawOptions.yes, cliVersion: resolveCliVersion(), runtime: recoveryRuntime(context, rawOptions, true) });
        });
      });
  }

  for (const command of ['sync', 'install', 'remove', 'cleanup'] as const) {
    const entry = command === 'cleanup'
      ? scopedCommand(plugin.command(command).argument('[plugins...]'))
      : contextualCommand(plugin.command(command).argument(command === 'sync' ? '[plugins...]' : '<plugins...>'));
    entry.option('-y, --yes', 'authorize reviewed scripts or output changes', false);
    if (command === 'install' || command === 'remove') entry
      .addOption(strictValueOption('--scope <scope>', 'requirement document to edit', ['user', 'project']));
    if (command === 'remove') entry.option('--workspace-root <path>', 'delete plugin source from this explicit Catalog Workspace');
    if (command === 'sync') entry
      .option('--target <target>', 'limit execution to a canonical platform target', collectUniqueOption)
      .option('--rebuild', 'rebuild selected desired outputs', false)
      .option('--check', 'observe without preparing or writing', false)
      .option('--refresh', 'refresh required Catalog sources before review', false);
    if (command === 'cleanup') entry
      .addOption(strictValueOption('--target <target>', 'physical platform target to clean', PLATFORM_TARGETS).makeOptionMandatory())
      .option('--force', 'clean provably owned output despite damaged weak state', false);
    if (command === 'install' || command === 'sync') entry
      .option('--script-timeout <ms>', 'override plugin preApply timeout in milliseconds');
    entry.action(async (plugins: string[], rawOptions: RawRecoveryOptions) => {
      if (rawOptions.check && (rawOptions.refresh || rawOptions.rebuild)) {
        throw new WriteCommandRequestError('--check cannot be combined with --refresh or --rebuild.');
      }
      await runRecoveryAction(command, rawOptions, async (context) => {
        if (command !== 'cleanup') await showWorkContext(context, rawOptions);
        const targetValues = typeof rawOptions.target === 'string' ? [rawOptions.target] : rawOptions.target;
        const options = {
          ...(rawOptions.scope === undefined ? {} : { scope: recoveryScope(rawOptions) }),
          context: recoveryContext(rawOptions), cwd: context.cwd, env: context.env, cliVersion: resolveCliVersion(),
          targets: targetValues === undefined ? undefined : normalizeWriteRequest(() => normalizeAgents(targetValues)),
          all: command === 'sync' && plugins.length === 0,
          yes: rawOptions.yes, force: rawOptions.force, refresh: rawOptions.refresh,
          scriptTimeoutMs: normalizeWriteRequest(() => resolveScriptTimeoutMs(rawOptions)),
          interactive: isWizardAvailable(context, rawOptions), prompt: context.prompt,
        };
        const backendCommand = command === 'remove' ? 'uninstall'
          : command === 'sync' && rawOptions.rebuild ? 'reinstall' : command;
        const result = rawOptions.check ? await checkRecovery(plugins, options)
          : await runRecovery(backendCommand, plugins, options, recoveryRuntime(context, rawOptions, true));
        return { ...result, command };
      });
    });
  }

  const config = plugin.command('config').description('Manage user common and platform configuration');
  const configCommand = (command: Command): Command => command
    .addOption(strictValueOption('--platform <target>', 'configuration platform; omitted means common', PLATFORM_TARGETS))
    .addOption(strictValueOption('--context <context>', 'definition and reference context', ['user', 'project']))
    .option('-j, --json', 'print one JSON object', false)
    .option('-v, --verbose', 'show command diagnostics', false)
    .option('-D, --debug', 'write debug diagnostics to a log file', false)
    .option('--log-file <path>', 'write debug diagnostics to the specified file');
  const configMutation = (command: Command): Command => configCommand(command)
    .option('--apply', 'refresh existing affected outputs after saving', false)
    .option('--script-timeout <ms>', 'override plugin preApply timeout in milliseconds')
    .option('-y, --yes', 'confirm reviewed output changes', false);
  const configContext = async (context: CliExecutionContext, rawOptions: RawConfigOptions, apply = rawOptions.apply === true) => {
    const requested = rawOptions.context === undefined ? apply ? undefined : 'user'
      : normalizeWriteRequest(() => parseContextValue(rawOptions.context));
    const work = await resolveWorkContext({ cwd: context.cwd, context: requested });
    if (apply && !rawOptions.json) writeLine(io.stdout, work.projectRoot
      ? `工作上下文：用户与当前项目 ${work.projectRoot}` : '工作上下文：仅用户');
    return work;
  };
  const configPlatform = (rawOptions: RawConfigOptions): PlatformTarget | undefined => rawOptions.platform === undefined
    ? undefined : normalizeWriteRequest(() => parsePlatformTargetValue(rawOptions.platform));

  for (const command of ['schema', 'list', 'get'] as const) {
    const entry = configCommand(config.command(command).argument('<plugin>'));
    if (command === 'get') entry.argument('[key]');
    entry.action(async (...args: unknown[]) => {
      const selector = args[0] as string;
      const key = command === 'get' ? args[1] as string | undefined : undefined;
      const rawOptions = args[command === 'get' ? 2 : 1] as RawConfigOptions;
      const context = createActionContext(`config:${command}`, rawOptions);
      const work = await configContext(context, rawOptions);
      const resolved = await runActionWithContext(context, () => resolveMultiSourceConfigRead({
        selector, key, rawOptions: { ...rawOptions, context: work.context }, context,
      }));
      if (rawOptions.json) writeJsonReceipt(io.stdout, {
        ok: true, configSchemaVersion: 5, command: `config:${command}`,
        plugin: resolved.pluginName, pluginName: resolved.pluginName, pluginId: resolved.pluginId,
        sourceId: resolved.sourceId, sourceIdentity: resolved.sourceIdentity,
        context: work, platform: configPlatform(rawOptions) ?? 'common',
        ...(resolved.result.schema ? { schema: resolved.result.schema } : {}),
        fields: command === 'schema' ? resolved.result.fieldDefinitions ?? {} : resolved.result.fields,
        ...(key === undefined ? {} : { key }),
      });
      else if (command === 'schema') writeJsonReceipt(io.stdout, resolved.result.fieldDefinitions ?? {});
      else writeConfigReadHuman(io.stdout, resolved.result, resolved.pluginId);
    });
  }

  for (const command of ['set', 'edit', 'unset'] as const) {
    const entry = configMutation(config.command(command).argument('<plugin>'));
    if (command !== 'edit') entry.argument('<field>');
    if (command === 'set') entry
      .option('--value-json <json>', 'set an exact JSON value')
      .option('--value-stdin', 'read the exact string value until stdin EOF', false)
      .option('--preset <id>', 'use a declared preset');
    entry.action(async (...args: unknown[]) => {
      const selector = args[0] as string;
      const rawOptions = args[command === 'edit' ? 1 : 2] as RawConfigOptions;
      let key = command === 'edit' ? undefined : args[1] as string;
      const context = createActionContext(`config:${command}`, rawOptions);
      try {
        const work = await configContext(context, rawOptions);
        const platform = configPlatform(rawOptions);
        const scriptTimeoutMs = normalizeWriteRequest(() => resolveScriptTimeoutMs(rawOptions));
        if (command === 'edit' && (!isWizardAvailable(context, rawOptions) || !context.prompt.select || !context.prompt.input)) {
          throw new WriteCommandRequestError('config edit requires an interactive terminal. Use config set for scripts.');
        }
        const explicitValueCount = [rawOptions.valueJson !== undefined, rawOptions.valueStdin === true,
          rawOptions.preset !== undefined].filter(Boolean).length;
        if (command === 'set' && (explicitValueCount > 1 || explicitValueCount === 0
          && !(context.interactive && context.isTty && !context.isCi && !rawOptions.json))) {
          throw new WriteCommandRequestError('Use exactly one of --value-json, --value-stdin, or --preset.');
        }
        const receipt = await runActionWithContext(context, () => withResolvedConfigMutationPlugin(
          context, selector, async ({ pluginId, source, plugin }, awHomeMutationToken, catalogOperationContext) => {
            if (!plugin.manifest.config) throw Object.assign(new Error(
              `configSchemaUnavailable: Plugin "${plugin.manifest.name}" does not declare an AW config schema.`),
            { code: 'configSchemaUnavailable' });
            const fields = compilePluginConfigDefinition(plugin.manifest.config, platform).fields;
            if (command === 'edit') {
              const selected = await context.prompt.select!({ message: `编辑用户${platform ?? 'common'}配置`,
                choices: Object.entries(fields).map(([value, field]) => ({ value, label: field.title ?? value })) });
              if (selected.cancelled || selected.action !== 'select' || selected.value === undefined) return undefined;
              key = selected.value;
            }
            const field = fields[key!];
            const store = await readPluginConfigStore({ sourceId: source.sourceId,
              sourceIdentity: source.sourceIdentity, logicalIdentity: source.logicalIdentity,
              pluginName: plugin.manifest.name, scope: 'user', platform, cwd: context.cwd, env: context.env,
              schema: fields });
            if (command === 'unset') {
              if (!Object.hasOwn(store.values, key!)) throw new WriteCommandRequestError(`Unknown config key "${key}" in the selected layer.`);
            } else if (!field) throw new WriteCommandRequestError(`Unknown config key "${key}".`);
            let inputValue: unknown;
            if (command !== 'unset') {
              const sensitive = field!.sensitive === true;
              if (sensitive && (rawOptions.valueJson !== undefined || rawOptions.preset !== undefined)) {
                throw new Error('sensitiveConfigInputUnsupported: Sensitive config requires --value-stdin.');
              }
              if (rawOptions.valueStdin) inputValue = await readUtf8Stdin(context.stdin);
              else if (sensitive) {
                if (!context.interactive || !context.isTty || context.isCi || rawOptions.json || !context.prompt.password) {
                  throw new Error('sensitiveConfigStdinRequired: Use --value-stdin outside an interactive terminal.');
                }
                const response = await context.prompt.password({ message: `输入 ${field!.title ?? key}`, mask: true });
                if (response.cancelled || response.action !== 'select' || response.value === undefined) return undefined;
                inputValue = response.value;
              } else if (command === 'edit' || explicitValueCount === 0) {
                if (!context.prompt.input) throw new WriteCommandRequestError('Use --value-json, --value-stdin, or --preset.');
                const response = await context.prompt.input({ message: `输入 ${field!.title ?? key} 的 JSON 值`,
                  defaultValue: JSON.stringify(store.values[key!]) });
                if (response.cancelled || response.action !== 'select' || response.value === undefined) return undefined;
                try { inputValue = JSON.parse(response.value) as unknown; }
                catch { throw new WriteCommandRequestError('Enter a valid JSON value.'); }
              } else if (rawOptions.valueJson !== undefined) {
                try { inputValue = JSON.parse(rawOptions.valueJson) as unknown; }
                catch { throw new WriteCommandRequestError('--value-json must contain valid JSON.'); }
              } else {
                const preset = field!.choices?.presets.find((candidate) => candidate.id === rawOptions.preset);
                if (!preset) throw new WriteCommandRequestError(`Unknown preset "${rawOptions.preset}".`);
                inputValue = structuredClone(preset.value);
              }
            }
            const writeReceipt = await applyPluginConfigWrite({ plugin, pluginName: plugin.manifest.name,
              scope: work.context, context: work.context, platform, cliVersion: resolveCliVersion(),
              cwd: context.cwd, env: context.env, nativeCliRunner: context.nativeCliRunner,
              rebuildRuntime: { ...context, awHomeMutationToken, catalogOperationContext,
                expectedGenerationSetDigest: catalogOperationContext.generationSetDigest,
                ...(scriptTimeoutMs === undefined ? {} : { scriptTimeoutMs }) },
              awHomeMutationToken, request: command === 'unset' ? { removeKeys: [key!] } : { updates: { [key!]: inputValue } },
              apply: rawOptions.apply === true, sharedNativeApplyConfirmed: rawOptions.yes === true,
              preApplyConfirmed: rawOptions.yes === true });
            return buildConfigMutationReceipt(`config:${command}`, {
              ...writeReceipt, ok: writeReceipt.overallState === 'succeeded', plugin: plugin.manifest.name,
              pluginName: plugin.manifest.name, pluginId, sourceId: source.sourceId, sourceIdentity: source.sourceIdentity,
              context: work, platform: platform ?? 'common',
              ...(command === 'unset' ? { removedKey: key, existed: true } : {}),
              affectedFields: [{ key: key!, title: field?.title ?? key!, kind: 'manifest' as const, reserved: false,
                action: command === 'unset' ? 'unset' as const : 'set' as const, scope: 'user' as const,
                ...(writeReceipt.staleRemovedKeys?.includes(key!) ? { stale: true as const } : {}) }],
            });
          }, rawOptions.apply === true));
        if (!receipt) return;
        if (rawOptions.json) writeJsonReceipt(io.stdout, receipt);
        else {
          writeLine(io.stdout, `已保存 ${receipt.plugin}.${key}（用户 ${platform ?? 'common'} 配置）。`);
          writeConfigApplyNotice(io.stderr, receipt);
        }
        commandExitState.exitCode = receipt.overallState === 'succeeded' ? 0 : 1;
      } catch (error) {
        writeConfigMutationFailure(`config:${command}`, selector, rawOptions.json === true, error);
      }
    });
  }

  configMutation(config.command('reset').argument('<plugin>'))
    .action(async (selector: string, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:reset', rawOptions);
      try {
        const work = await configContext(context, rawOptions);
        const platform = configPlatform(rawOptions);
        if (!rawOptions.yes) {
          if (!isWizardAvailable(context, rawOptions) || !context.prompt.confirm) throw new WriteCommandRequestError('config reset requires --yes.');
          const confirmed = await context.prompt.confirm({ message: `删除 ${selector} 的用户 ${platform ?? 'common'} 覆盖？`, defaultValue: false });
          if (confirmed.cancelled || confirmed.value !== true) return;
        }
        const located = await resolveStoredConfigResetIdentity({ selector, context, scope: 'user' });
        const resetStore = async (plugin: ResolvedCatalogPlugin['plugin'] | null, pluginError: Error | null) =>
          resetPluginConfigWithHelper({ ...located, plugin, pluginError, platform, scope: work.context,
            context: work.context, cliVersion: resolveCliVersion(), cwd: context.cwd, env: context.env,
            nativeCliRunner: context.nativeCliRunner, apply: rawOptions.apply === true,
            rebuildRuntime: { ...context, scriptTimeoutMs: resolveScriptTimeoutMs(rawOptions) },
            sharedNativeApplyConfirmed: true, preApplyConfirmed: rawOptions.yes === true });
        let started = false;
        const resetReceipt = await runActionWithContext(context, async () => {
          try { return await withResolvedCatalogPlugin({ selector: located.pluginId, cliVersion: resolveCliVersion(), env: context.env,
            consume: ({ plugin }) => { started = true; return resetStore(plugin, null); } }); }
          catch (error) {
            if (started) throw error;
            return resetStore(null, error instanceof Error ? error : new Error(String(error)));
          }
        });
        const receipt = buildConfigMutationReceipt('config:reset', { ...resetReceipt,
          ok: resetReceipt.overallState === 'succeeded', ...located, plugin: located.pluginName,
          context: work, platform: platform ?? 'common' });
        if (rawOptions.json) writeJsonReceipt(io.stdout, receipt);
        else {
          writeLine(io.stdout, `已恢复 ${receipt.plugin} 的用户 ${platform ?? 'common'} 默认配置。`);
          writeConfigApplyNotice(io.stderr, receipt);
        }
        commandExitState.exitCode = receipt.overallState === 'succeeded' ? 0 : 1;
      } catch (error) { writeConfigMutationFailure('config:reset', selector, rawOptions.json === true, error); }
    });

  contextualCommand(config.command('apply').argument('<plugin>'))
    .option('--target <target>', 'limit existing-output refresh to this platform target', collectUniqueOption)
    .option('-y, --yes', 'confirm reviewed output changes', false)
    .option('--script-timeout <ms>', 'override plugin preApply timeout in milliseconds')
    .action(async (selector: string, rawOptions: RawConfigOptions) => {
      const context = createActionContext('config:apply', rawOptions);
      const work = await configContext(context, rawOptions, true);
      const targets = rawOptions.target?.map((target) => normalizeWriteRequest(() => parsePlatformTargetValue(target)));
      const receipt = await runActionWithContext(context, () => withResolvedConfigMutationPlugin(context, selector,
        async ({ plugin, pluginId, source }, awHomeMutationToken) => ({
          ...await applyPluginConfig({ plugin, scope: work.context, context: work.context, targets,
            cliVersion: resolveCliVersion(), cwd: context.cwd, env: context.env, awHomeMutationToken,
            nativeCliRunner: context.nativeCliRunner, sharedNativeApplyConfirmed: rawOptions.yes === true,
            preApplyConfirmed: rawOptions.yes === true, rebuildRuntime: { ...context, scriptTimeoutMs: resolveScriptTimeoutMs(rawOptions) } }),
          command: 'config:apply', plugin: plugin.manifest.name, pluginId, sourceId: source.sourceId,
          context: work,
        }), true));
      const result = buildConfigMutationReceipt('config:apply', { ...receipt,
        ok: receipt.overallState === 'succeeded' });
      if (rawOptions.json) writeJsonReceipt(io.stdout, result);
      else {
        writeLine(io.stdout, `配置应用：${result.ok ? '完成' : '部分失败'}。`);
        writeConfigApplyNotice(io.stderr, { ...result, warnings: [] });
      }
      commandExitState.exitCode = result.ok ? 0 : 1;
    });

  contextualCommand(plugin.command('status'))
    .description('Observe user and current project demand and output state')
    .action(async (rawOptions: RawRecoveryOptions) => {
      const context = createActionContext('status', rawOptions);
      await showWorkContext(context, rawOptions);
      const result = await runActionWithContext(context, () => readRecoveryStatus({
        context: recoveryContext(rawOptions), cwd: context.cwd, env: context.env, cliVersion: resolveCliVersion(),
        nativeCliRunner: context.nativeCliRunner,
      }));
      if (rawOptions.json) writeJsonReceipt(io.stdout, result);
      else renderRecoveryStatus(io.stdout, result);
      commandExitState.exitCode = result.errors.length ? 1 : 0;
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
  if (argv[0] === 'command') {
    return runManagedCommandCli(argv.slice(1), createCliExecutionContext({ ...options, io }), {
      cliEntry: fileURLToPath(import.meta.url),
      cliVersion: resolveCliVersion(),
    });
  }
  const reviewCommand = argv[0] === 'review' && ['inspect', 'prepare'].includes(argv[1] ?? '')
    ? argv[1] as 'inspect' | 'prepare'
    : null;
  const jsonReviewCommand = reviewCommand !== null && argv.includes('--json');
  const jsonMaterialize = argv[0] === 'skill' && argv[1] === 'materialize'
    && (argv.includes('--json') || argv.includes('-j'));
  const jsonConfigCommand = jsonConfigReadRequested(argv);
  const explicitWorkspace = argv.some((token) => token === '--workspace-root' || token.startsWith('--workspace-root='));
  const authoringPluginCommand = argv[0] === 'plugin'
    && (['build', 'test', 'validate', 'init', 'add-skill'].includes(argv[1] ?? '')
      || ['remove', 'status'].includes(argv[1] ?? '') && explicitWorkspace);
  const jsonAuthoringCommand = argv.includes('--json')
    && (
      (argv[0] === 'catalog' && ['init', 'context', 'version', 'build', 'validate', 'status', 'publish'].includes(argv[1] ?? ''))
      || authoringPluginCommand
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
  const recovery = recoveryRequest(argv);
  const jsonRecoveryRequest = recovery?.json ? recovery : null;
  const jsonConfigMutation = jsonConfigMutationRequest(argv);

  try {
    const authoringScriptByCommand: Record<string, string> = {
      init: 'init-plugin.mjs',
      'add-skill': 'add-skill.mjs',
      remove: 'remove-plugin.mjs',
      validate: 'validate-plugin.mjs',
      status: 'plugin-status.mjs',
    };
    const authoringScript = authoringPluginCommand
      ? authoringScriptByCommand[argv[1] ?? '']
      : argv[0] === 'skill' && argv[1] === 'validate'
        ? 'validate-skill.mjs'
        : undefined;
    if (authoringScript && ((!argv.includes('--help') && !argv.includes('-h'))
      || explicitWorkspace && ['remove', 'status'].includes(argv[1] ?? ''))) {
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
    const programIo = jsonCatalogDevCommand || jsonRecoveryRequest || jsonReviewCommand || jsonMaterialize || jsonConfigCommand
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
    if (jsonMaterialize && error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      writeJsonReceipt(io.stdout, {
        receiptSchemaVersion: 5, command: 'skill:materialize', ok: false,
        selectedSkills: [], dependencies: [], configDigest: null, materializationDigest: null,
        outputDigest: null, errors: [{ code: 'invalidArguments', message: error.message }],
      });
      return 2;
    }
    if (reviewCommand && error instanceof CommanderError) {
      if (error.exitCode === 0) return 0;
      if (jsonReviewCommand) {
        const receipt = reviewCommand === 'inspect'
          ? createReviewInspectionFailure(
              new Error(error.message),
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
    if (jsonConfigCommand && !jsonConfigMutation) {
      if (error instanceof CommanderError && error.exitCode === 0) return 0;
      const failure = configMutationFailure(error, options.env ?? process.env, options.cwd ?? process.cwd());
      writeJsonReceipt(io.stdout, { ok: false, command: `config:${argv[2] ?? ''}`, errors: [failure] });
      return failure.code === 'invalidArguments' ? 2 : 1;
    }
    if (recovery) {
      if (error instanceof CommanderError && error.exitCode === 0) return 0;
      const failure = writeCommandFailure(error);
      if (argv[0] === 'project' || argv.some((value) => value === '-p' || value === '--platform' || value.startsWith('--platform='))) {
        failure.message += '\n使用 aw plugin intent、aw plugin targets 或 aw plugin install/remove/sync/cleanup/status。安装归属使用 --scope；工作上下文使用 --context。';
      }
      if (jsonRecoveryRequest) {
        if (recovery.command === 'status') writeJsonReceipt(io.stdout, {
          schemaVersion: 1, kind: 'aw-recovery-status', scope: recovery.scope, ok: false,
          intent: { state: 'unreadable', roots: null },
          selection: { agents: [], origin: 'none', preferences: 'unreadable' },
          inventory: null, extraObserved: [], coverage: null, counts: null, allSatisfied: null,
          errors: [failure],
        });
        else writeJsonReceipt(io.stdout, { ...recoveryFailureReceipt(recovery.command, recovery.scope, error),
          blockers: [failure], errors: [failure] });
      } else writeLine(io.stderr, failure.message);
      return failure.code === 'invalidArguments' ? 2 : 1;
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
      return failure.code === 'invalidArguments' ? 2 : 1;
    }
    if ((argv[0] === 'plugin' && argv[1] === 'config'
      || argv[0] === 'skill' && argv[1] === 'materialize')
      && (error instanceof CommanderError || error instanceof WriteCommandRequestError)) {
      if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
      writeLine(io.stderr, error.message);
      return 2;
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
