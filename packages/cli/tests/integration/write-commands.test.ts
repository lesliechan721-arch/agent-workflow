import { writeIntentFixture, readIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { createNativeTestExecution } from '../helpers/native-execution-fixture.js';
import { beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { createElement } from 'react';
import { render } from 'ink-testing-library';

import {
  cleanupWriteCommand as nativeCleanupWriteCommand,
  installWriteCommand as nativeInstallWriteCommand,
  reinstallWriteCommand as nativeReinstallWriteCommand,
  syncWriteCommand as nativeSyncWriteCommand,
  uninstallWriteCommand as nativeUninstallWriteCommand,
} from '../../src/commands/write-commands.js';
import { runRecovery } from '../../src/recovery/coordinator.js';
import * as pluginConfig from '../../src/utils/plugin-config.js';
import { prepareRetire, executeRetire, runRetire } from '../../src/recovery/retirement.js';
import { readDemand, demandNativeProjection } from '../../src/recovery/demand.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { createScopeContext } from '../../src/intent/scope-context.js';
import { observePreferences, resolvePreferencesPath, writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { addRoot, observeIntent, removeRoot, resolveIntentPath } from '../../src/intent/intent-store.js';
import { portableJsonDigest } from '../../src/portable/historical-materialization.js';
import { normalizeInstallCommandOptions } from '../../src/commands/options.js';
import {
  runRebuildCommand,
  setRebuildCommandTestHooksForTests,
  type RebuildCommandRuntime,
} from '../../src/commands/rebuild-command.js';
import {
  setStatusDependencyInspectionHookForTests,
  statusCommandV8,
  statusTargetActivation,
  statusTargetExtensions,
  statusTargetIntent,
  statusTargetSharedNative,
} from '../../src/commands/status-v6.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import type {
  CommandWizardPluginCandidate,
  CommandWizardSelection,
} from '../../src/commands/wizard.js';
import {
  OFFICIAL_CATALOG_SOURCE_SSH_URL,
  OFFICIAL_CATALOG_SOURCE_URL,
} from '../../src/constants.js';
import {
  createTuiControllerDependencies,
  setTuiControllerRuntimeTestHooksForTests,
} from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { buildTuiViewModel } from '../../src/tui/model.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { userIssueKey } from '../../src/tui/controller.js';
import { createCodexNativeObservationSession } from '../../src/utils/codex-native-observation.js';
import { parseCodexRoleFile } from '../../src/utils/codex-roles.js';
import { runArtifactRenderer } from '../../src/utils/artifact-renderer.js';
import { runCli } from '../../src/index.js';
import {
  getCurrentSourceTestIsolation,
  getSourceTestRepositoryCwd,
  registerCurrentTestWritableStateRoot,
} from '../setup/test-isolation.js';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'fs-extra';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildOperationReviewProjection } from '../../src/tui/operation-review-planner.js';
import { projectExecutionDiagnostics } from '../../src/tui/diagnostic-projection.js';
import { sanitizeTestDiagnostic } from '../helpers/test-command-diagnostics.js';
import { listManagedCommands, resolveManagedCommand } from '../../src/utils/managed-command-store.js';
import { PassThrough } from 'node:stream';
import {
  AW_RUNTIME_CONFIG_BINDING_PATH,
  preparePluginNativeTools,
  type RuntimeConfigBinding,
} from '@lesliechan721/aw-plugin-core';
import {
  createCatalogSnapshotFixture,
  createDependencyCatalogSnapshotFixture,
  git,
} from '../helpers/catalog-source-fixture.js';
import { createSyntheticEmbeddedRoot } from '../helpers/embedded-root.js';
import { stubCodexFileSelectionForNativeFixture } from '../helpers/codex-enhance-native-fixture.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import type { CommandEvent } from '../../src/output/model.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig as replaceCatalogSourcesConfigWithoutActive,
  resolveCatalogSourceRef,
} from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  readPluginConfigStore,
  resetPluginConfigStore,
  resolvePluginConfigStorePath,
  setAtomicConfigBeforeRenameHookForTests,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { createCapturedCliIo, createTtyRuntimeStreams } from '../helpers/cli-entry.js';
import {
  setNativeCliRunnerOverrideForTests,
  type NativeCliInvocation,
} from '../../src/utils/native-cli.js';
import type {
  CatalogSource,
  CatalogSourceResolution,
  GeneratedArtifact,
  PluginMeta,
} from '../../src/types.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  setPrimaryCatalogSourceCommand,
  updateCatalogSourceCommand,
} from '../../src/commands/catalog-source.js';
import {
  createSharedOwnerToken,
  parseOwnedTextHeader,
  renderOwnedTextFile,
  SKILL_OWNER_MARKER,
  writeOwnedTextFile,
  writeSkillOwnerMarker,
} from '../../src/utils/ownership.js';
import { withAwHomeMutationLock } from '../../src/utils/aw-home-mutation-lock.js';
import {
  calculateCatalogEntryArtifactDigest,
  calculateCatalogEntryContentDigest,
  calculateCatalogEntryManifestDigest,
  calculateCodexNativeRenderPayloadDigest,
} from '../../src/utils/catalog-digests.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { catalogPathProviderInternal } from '../../src/utils/path-catalog-provider.js';
import { validateCatalogSnapshotTransport } from '../../src/utils/catalog-snapshot.js';
import { CodexManagerError } from '../../src/utils/codex-manager.js';
import { setCodexDiscoveryOverridesForTests } from '../../src/utils/codex-executable-discovery.js';
import { createEmptyNativeDemandView } from '../../src/utils/native-demand.js';

import {
  applyCodexConfigTransactionFile,
  readCodexConfigFile,
  removeCodexMarketplace,
} from '../../src/utils/codex-config.js';
import { renderTrackedHookGroupIdentity } from '../../src/utils/hooks-contract.js';
import {
  CODEX_NATIVE_RENDER_RECEIPT_PATH,
  type CodexNativeRenderReceipt,
} from '../../src/utils/codex-native-render-receipt.js';

// The public recovery service owns declarations. These calls exercise only Native output handling.
async function withNativeExecution(
  names: string[],
  raw: Parameters<typeof nativeInstallWriteCommand>[1],
  runtime: RebuildCommandRuntime,
  execute: (runtime: RebuildCommandRuntime) => ReturnType<typeof nativeInstallWriteCommand>,
  allowDamagedPreferences = false,
) {
  if (runtime.executionInput) return execute(runtime);
  const options = normalizeInstallCommandOptions(raw);
  const env = runtime.env;
  if (options.scope === 'project') await fs.ensureDir(path.join(options.cwd, '.git'));
  const context = await createScopeContext({ scope: options.scope, cwd: options.cwd, env });
  try {
    const demand = await readDemand({ scope: options.scope, cwd: options.cwd, env });
    const requirements = (allowDamagedPreferences
      && (demand.preferences.state === 'invalid' || demand.preferences.state === 'unreadable'))
      ? createEmptyNativeDemandView()
      : demand.intent.state === 'valid' || demand.intent.state === 'absent'
      ? demandNativeProjection(demand) : createEmptyNativeDemandView();
    const configured = await readCatalogSourcesConfigSnapshot(env).catch(() => undefined);
    const primary = configured?.config.sources.find((source) => source.primary)?.id;
    const ids = [...new Set(names.map((name) => name.includes('/') ? name : `${primary}/${name}`))];
    const platforms = options.platform === 'both' ? ['codex', 'claude'] as const : [options.platform];
    return execute({ ...runtime, env: context.env, executionInput: {
      context, requirements,
      selectedTargets: ids.flatMap((pluginId) => platforms.map((platform) => ({
        pluginId, platform, scope: options.scope,
      }))),
      preserveOtherObservedTargets: true,
    } });
  } finally {
    await context.dispose();
  }
}

function installWriteCommand(names: string[], raw: Parameters<typeof nativeInstallWriteCommand>[1],
  runtime: RebuildCommandRuntime = {}) {
  return withNativeExecution(names, raw, runtime, (prepared) => nativeInstallWriteCommand(names, raw, prepared));
}
function syncWriteCommand(names: string[], raw: Parameters<typeof nativeSyncWriteCommand>[1],
  runtime: RebuildCommandRuntime = {}) {
  return withNativeExecution(names, raw, runtime, (prepared) => nativeSyncWriteCommand(names, raw, prepared));
}
function reinstallWriteCommand(names: string[], raw: Parameters<typeof nativeReinstallWriteCommand>[1],
  runtime: RebuildCommandRuntime = {}) {
  return withNativeExecution(names, raw, runtime, (prepared) => nativeReinstallWriteCommand(names, raw, prepared));
}
function uninstallWriteCommand(names: string[], raw: Parameters<typeof nativeUninstallWriteCommand>[1],
  runtime: RebuildCommandRuntime = {}) {
  return withNativeExecution(names, raw, runtime, (prepared) => nativeUninstallWriteCommand(names, raw, prepared));
}
function cleanupWriteCommand(names: string[], raw: Parameters<typeof nativeCleanupWriteCommand>[1],
  runtime: RebuildCommandRuntime = {}) {
  return withNativeExecution(names, raw, runtime,
    (prepared) => nativeCleanupWriteCommand(names, raw, prepared), true);
}

async function installFixturePlugin(names: string[], raw: Parameters<typeof installWriteCommand>[1],
  runtime: RebuildCommandRuntime = {}) {
  const options = normalizeInstallCommandOptions(raw);
  const configured = await readCatalogSourcesConfigSnapshot(runtime.env).catch(() => undefined);
  const primary = configured?.config.sources.find((source) => source.primary)?.id;
  const ids = [...new Set(names.map((name) => name.includes('/') ? name : `${primary}/${name}`))];
  const location = { scope: options.scope, cwd: options.cwd, env: runtime.env };
  const generations = await readCatalogGenerationState(runtime.env);
  for (const pluginId of ids) {
    const existing = await observeIntent(location);
    if (existing.state === 'valid' && existing.value.roots.some((root) => root.pluginId === pluginId)) continue;
    const sourceId = pluginId.split('/')[0]!;
    await addRoot(location, pluginId,
      generations.sources[sourceId]?.active?.logicalIdentity ?? `fixture-${sourceId}`);
  }
  const observed = await observePreferences(location);
  const preferences = observed.state === 'valid' ? observed.value : createEmptyPreferences();
  const platforms = options.platform === 'both' ? ['codex', 'claude'] as const : [options.platform];
  await writePreferences(location, {
    ...preferences,
    targets: [...new Set([...preferences.targets, ...platforms])],
  });
  return installWriteCommand(ids, raw, runtime);
}

async function syncFixturePlugin(names: string[], options: Parameters<typeof syncWriteCommand>[1],
  runtime: RebuildCommandRuntime = {}) {
  const location = { scope: options.scope as 'project' | 'user', cwd: options.cwd!, env: runtime.env };
  const requirements = await readIntentFixture(location);
  const roots = requirements.roots.filter((root) => names.length
    ? names.some((name) => name === root.pluginId || root.pluginId.endsWith(`/${name}`))
    : (options as { all?: boolean }).all);
  return syncWriteCommand(roots.map((root) => root.pluginId), options, runtime);
}

const readFixtureRequirements = readIntentFixture;

async function addProjectFixtureRoots(options: {
  cwd: string; env: NodeJS.ProcessEnv; selectors: string[];
}) {
  const generations = await readCatalogGenerationState(options.env);
  for (const pluginId of options.selectors) {
    const sourceId = pluginId.split('/')[0]!;
    await addRoot({ scope: 'project', cwd: options.cwd, env: options.env }, pluginId,
      generations.sources[sourceId]?.active?.logicalIdentity ?? `fixture-${sourceId}`);
  }
  return { errors: [] };
}

async function replaceCatalogSourcesConfig(
  options: Parameters<typeof replaceCatalogSourcesConfigWithoutActive>[0],
) {
  const result = await replaceCatalogSourcesConfigWithoutActive(options);
  for (const source of options.config.sources.filter((entry) => entry.type === 'path')) {
    await syncCatalogSourceGeneration({
      sourceId: source.id,
      cliVersion: '1.0.0',
      env: options.env,
    }).catch(() => undefined);
  }
  return result;
}

async function readCatalogLogicalIdentity(rootDir: string): Promise<string> {
  const marker = await fs.readJson(path.join(rootDir, '.aw-generated.json')) as {
    workspaceIdentity: string;
  };
  return marker.workspaceIdentity;
}

async function configureCatalog(): Promise<ReturnType<typeof getCurrentSourceTestIsolation>> {
  const isolation = getCurrentSourceTestIsolation();
  const root = path.join(isolation.layout.fixtureCwd, 'write-source');
  await createCatalogSnapshotFixture(root);
  const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 2,
      sources: [{ id: 'local', type: 'path', primary: true, path: root }],
    },
    expectedDigest: snapshot.digest,
    env: isolation.env,
  });
  return isolation;
}

async function snapshotRegularTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        snapshot[`${relative}/`] = 'directory';
        pending.push(absolute);
      } else {
        snapshot[relative] = (await fs.readFile(absolute)).toString('base64');
      }
    }
  }
  return snapshot;
}

async function createCodexNativeTestRuntime(
  isolation: {
    env: NodeJS.ProcessEnv;
    layout: { fixtureCwd: string };
  },
  codexVersion = '0.200.0',
) {
  // Observation and public CLI paths inspect PATH even when mutation uses a fake manager.
  const systemRoot = await fs.mkdtemp(path.join(isolation.layout.fixtureCwd, 'fake-codex-'));
  const binRoot = await writeStatusSystemCodexPackage(systemRoot, codexVersion);
  const inheritedPath = Object.entries(isolation.env).find(([key]) => key.toLowerCase() === 'path')?.[1];
  for (const key of Object.keys(isolation.env)) {
    if (key.toLowerCase() === 'path') delete isolation.env[key];
  }
  isolation.env.PATH = [binRoot, inheritedPath].filter(Boolean).join(path.delimiter);
  const installed = new Set<string>();
  const installedVersions = new Map<string, string>();
  const marketplaceRoots = new Map<string, string>();
  const userConfigPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
  const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
    const args = invocation.args;
    if (args.includes('--version')) {
      return { exitCode: 0, stdout: `codex-cli ${codexVersion}`, stderr: '' };
    }
    const pluginIndex = args.indexOf('plugin');
    const pluginArgs = pluginIndex >= 0 ? args.slice(pluginIndex) : args;
    if (pluginArgs[1] === 'marketplace' && pluginArgs[2] === 'add') {
      const marketplaceRoot = pluginArgs[3]!;
      const config = await fs.readJson(path.join(marketplaceRoot, 'config.json')) as {
        marketplaceName: string;
      };
      marketplaceRoots.set(config.marketplaceName, marketplaceRoot);
      const current = await fs.readFile(userConfigPath, 'utf8').catch(() => '');
      if (!(await readCodexConfigFile(userConfigPath)).snapshot.marketplaces[config.marketplaceName]) {
        await fs.outputFile(userConfigPath, [
          current,
          `[marketplaces.${JSON.stringify(config.marketplaceName)}]`,
          `source = ${JSON.stringify(marketplaceRoot)}`,
          'source_type = "local"',
          '',
        ].filter(Boolean).join('\n'));
      }
    } else if (pluginArgs[1] === 'marketplace' && pluginArgs[2] === 'remove') {
      const marketplaceName = pluginArgs[3]!;
      marketplaceRoots.delete(marketplaceName);
      const current = await fs.readFile(userConfigPath, 'utf8').catch(() => '');
      await fs.outputFile(userConfigPath, removeCodexMarketplace(current, marketplaceName));
    } else if (pluginArgs[1] === 'add') {
      const pluginId = pluginArgs[2]!;
      const separator = pluginId.lastIndexOf('@');
      const pluginName = pluginId.slice(0, separator);
      const marketplaceName = pluginId.slice(separator + 1);
      installed.add(pluginId);
      const marketplacePluginRoot = path.join(
        marketplaceRoots.get(marketplaceName)!,
        'plugins',
        pluginName,
      );
      const pluginVersion = String((await fs.readJson(path.join(
        marketplacePluginRoot,
        '.agents-plugin',
        'plugin.json',
      ))).version);
      installedVersions.set(pluginId, pluginVersion);
      const cacheRoot = path.join(
        isolation.env.CODEX_HOME!,
        'plugins',
        'cache',
        marketplaceName,
        pluginName,
        pluginVersion,
      );
      await fs.copy(
        marketplacePluginRoot,
        cacheRoot,
        { overwrite: true },
      );
      await applyCodexConfigTransactionFile(userConfigPath, {
        upsertPluginActivations: { [pluginId]: true },
      });
    } else if (pluginArgs[1] === 'remove') {
      const pluginId = pluginArgs[2]!;
      const separator = pluginId.lastIndexOf('@');
      installed.delete(pluginId);
      installedVersions.delete(pluginId);
      await fs.remove(path.join(
        isolation.env.CODEX_HOME!,
        'plugins',
        'cache',
        pluginId.slice(separator + 1),
        pluginId.slice(0, separator),
      ));
      await applyCodexConfigTransactionFile(userConfigPath, {
        removePluginActivations: [pluginId],
      });
    }
    if (pluginArgs[1] === 'list' && pluginArgs.includes('--json')) {
      const [user, project] = await Promise.all([
        readCodexConfigFile(userConfigPath),
        readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
      ]);
      const invocationCwd = path.resolve(invocation.cwd ?? '.');
      const exact = invocationCwd === path.resolve(isolation.layout.fixtureCwd);
      const marketplaceName = pluginArgs[pluginArgs.indexOf('--marketplace') + 1];
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          installed: [...installed].filter((pluginId) =>
            pluginId.endsWith(`@${marketplaceName}`)).sort().map((pluginId) => ({
            pluginId,
            installed: true,
            enabled: user.snapshot.plugins[pluginId]?.enabled === true
              || (exact && project.snapshot.plugins[pluginId]?.enabled === true),
            version: installedVersions.get(pluginId) ?? '1.0.0',
          })),
          available: [],
        }),
        stderr: '',
      };
    }
    return {
      exitCode: 0,
      stdout: pluginArgs[1] === 'list' ? [...installed].sort().join('\n') : '',
      stderr: '',
    };
  });
  return {
    env: isolation.env,
    codexVersion,
    nativeCliRunner,
    codexManagerResolver: vi.fn(async () => ({
      kind: 'system' as const,
      version: codexVersion,
      command: 'codex',
      argsPrefix: [] as string[],
    })),
    installed,
  };
}

async function prepareCodexEnhancePublicCommandFixture(timing?: ReturnType<typeof createCommandTestTiming>) {
  const measure = timing?.measure ?? (async <T>(
    _stage: string, _name: string, operation: (sequence: number) => Promise<T>,
  ): Promise<T> => operation(0));
  const isolation = getCurrentSourceTestIsolation();
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
  const sourcePluginRoot = path.join(repositoryRoot, 'plugins', 'codex-enhance');
  const authoringRoot = path.join(isolation.layout.fixtureCwd, 'codex-enhance-authoring');
  await measure('fixture-step', 'copy.marketplace-source', () => fs.copy(
    path.join(repositoryRoot, 'plugins', 'marketplace-source.json'),
    path.join(authoringRoot, 'plugins', 'marketplace-source.json'),
  ));
  const copiedPluginRoot = path.join(authoringRoot, 'plugins', 'codex-enhance');
  await measure('fixture-step', 'copy.codex-enhance', () => fs.copy(sourcePluginRoot, copiedPluginRoot));
  const sourceSubagentPluginRoot = path.join(repositoryRoot, 'plugins', 'agent-subagent');
  const copiedSubagentPluginRoot = path.join(authoringRoot, 'plugins', 'agent-subagent');
  await measure('fixture-step', 'copy.agent-subagent', () => fs.copy(sourceSubagentPluginRoot, copiedSubagentPluginRoot));
  await measure('fixture-step', 'stub.file-selection', () => stubCodexFileSelectionForNativeFixture(copiedSubagentPluginRoot));
  const sourceRoot = await measure('fixture-step', 'bundle.plugins', () => createSyntheticEmbeddedRoot(authoringRoot));
  await fs.outputJson(path.join(sourceRoot, '.aw-generated.json'), {
    schemaVersion: 1,
    kind: 'catalog',
    workspaceIdentity: `fixture:${crypto.createHash('sha256').update(sourceRoot).digest('hex')}`,
    sourceIdentity: `sha256:${crypto.createHash('sha256').update(`source:${sourceRoot}`).digest('hex')}`,
  });
  const manifest = await fs.readJson(path.join(
    sourceRoot, 'plugins', 'codex-enhance', '.agents-plugin', 'plugin.json',
  ));
  const subagentManifest = await fs.readJson(path.join(
    sourceRoot, 'plugins', 'agent-subagent', '.agents-plugin', 'plugin.json',
  ));
  const before = await readCatalogSourcesConfigSnapshot(isolation.env);
  const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
  const sourceIdentity = await calculateCatalogSourceIdentity(source);
  const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
  await measure('fixture-step', 'catalog.config.write', () => replaceCatalogSourcesConfigWithoutActive({
    config: { schemaVersion: 2, sources: [source] },
    expectedDigest: before.digest,
    env: isolation.env,
  }));
  await measure('fixture-step', 'catalog.source.sync', () => syncCatalogSourceGeneration({
    sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
  }));
  const runtime = await measure('fixture-step', 'fake-codex.prepare', () => createCodexNativeTestRuntime(isolation));
  const runPublic = (args: string[]) => measure('command', [
    args[0], args[1],
    args.includes('--scope') ? args[args.indexOf('--scope') + 1] : undefined,
  ].filter(Boolean).join(' '), async (commandSequence) => {
    const captured = createCapturedCliIo();
    const exitCode = await runCli([...args, '--json'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner: timing ? (invocation) => {
        const pluginIndex = invocation.args.indexOf('plugin');
        const name = pluginIndex < 0 ? 'version'
          : invocation.args.slice(pluginIndex, pluginIndex + (
            invocation.args[pluginIndex + 1] === 'marketplace' ? 3 : 2
          )).join(' ');
        return measure('native', name, () => runtime.nativeCliRunner(invocation));
      } : runtime.nativeCliRunner,
      ...(timing ? { debugLogger: { log: (event: CommandEvent) => timing.commandEvent(commandSequence, event) } } : {}),
    });
    timing?.commandEvent(commandSequence, { type: 'command:result', data: { exitCode } });
    return { exitCode, payload: JSON.parse(captured.readStdout()) as Record<string, unknown> };
  });
  return {
    isolation,
    sourcePluginRoot,
    sourceSubagentPluginRoot,
    sourceRoot,
    sourceIdentity,
    logicalIdentity,
    cacheRoot: path.join(
      isolation.env.CODEX_HOME!, 'plugins', 'cache', 'aw', 'codex-enhance', manifest.version,
    ),
    subagentCacheRoot: path.join(
      isolation.env.CODEX_HOME!, 'plugins', 'cache', 'aw', 'agent-subagent', subagentManifest.version,
    ),
    runtime,
    runPublic,
  };
}

function renderCodexNpmShim(): string {
  return [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%',
    ')',
    '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ' +
      '"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    '',
  ].join('\r\n');
}

async function writeStatusSystemCodexPackage(
  root: string,
  version: string,
): Promise<string> {
  const binRoot = process.platform === 'win32' ? root : path.join(root, 'bin');
  const packageRoot = process.platform === 'win32'
    ? path.join(binRoot, 'node_modules', '@openai', 'codex')
    : path.join(root, 'lib', 'node_modules', '@openai', 'codex');
  const launcher = path.join(packageRoot, 'bin', 'codex.js');
  await Promise.all([
    fs.outputJson(path.join(packageRoot, 'package.json'), {
      name: '@openai/codex',
      version,
      bin: { codex: 'bin/codex.js' },
    }),
    fs.outputFile(launcher, '#!/usr/bin/env node\n'),
  ]);
  await fs.chmod(launcher, 0o755);
  await fs.ensureDir(binRoot);
  if (process.platform === 'win32') {
    await fs.outputFile(path.join(binRoot, 'codex.CMD'), renderCodexNpmShim());
  } else {
    await fs.symlink(path.relative(binRoot, launcher), path.join(binRoot, 'codex'));
  }
  return binRoot;
}

async function writeIntentRoundTripCodexPackage(root: string): Promise<string> {
  const binRoot = process.platform === 'win32' ? root : path.join(root, 'bin');
  const packageRoot = process.platform === 'win32'
    ? path.join(binRoot, 'node_modules', '@openai', 'codex')
    : path.join(root, 'lib', 'node_modules', '@openai', 'codex');
  const launcher = path.join(packageRoot, 'bin', 'codex.js');
  await Promise.all([
    fs.outputJson(path.join(packageRoot, 'package.json'), {
      name: '@openai/codex',
      version: '0.200.0',
      bin: { codex: 'bin/codex.js' },
    }),
    fs.outputFile(launcher, [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2);',
      'if (args.includes("--version")) console.log("codex-cli 0.200.0");',
      'if (args[0] === "plugin" && args[1] === "list") console.log(JSON.stringify({ installed: [], available: [] }));',
    ].join('\n')),
  ]);
  await fs.chmod(launcher, 0o755);
  await fs.ensureDir(binRoot);
  if (process.platform === 'win32') {
    await fs.outputFile(
      path.join(binRoot, 'codex.CMD'),
      renderCodexNpmShim(),
    );
  } else {
    await fs.symlink(path.relative(binRoot, launcher), path.join(binRoot, 'codex'));
  }
  return binRoot;
}

async function runIntentRoundTripCliChild(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  expectedExitCode = 0,
): Promise<string> {
  const packageRoot = getSourceTestRepositoryCwd();
  const child = spawn(process.execPath, [
    path.join(packageRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    'run',
    '--config',
    'vitest.intent-round-trip-child.config.ts',
    '--reporter=dot',
  ], {
    cwd: packageRoot,
    env: {
      ...env,
      AW_INTENT_CHILD_ARGV: JSON.stringify(argv),
      AW_INTENT_CHILD_CWD: cwd,
      AW_INTENT_CHILD_EXIT_CODE: String(expectedExitCode),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  expect(code, `aw ${argv.join(' ')} child failed:\n${output}`).toBe(0);
  return output;
}

function parseIntentRoundTripReceipt(output: string): {
  targetResults: Array<{
    target: { pluginId?: string; scope: string };
    state: string;
  }>;
} {
  const start = output.search(/\{\n  "(?:ok|schemaVersion)":/);
  const end = output.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Child receipt is missing:\n${output}`);
  const receipt = JSON.parse(output.slice(start, end + 2));
  if (receipt.kind === 'aw-recovery') {
    return { targetResults: receipt.targetResults.flatMap((entry: { backend?: { targetResults: unknown[] } }) =>
      entry.backend?.targetResults ?? []) } as ReturnType<typeof parseIntentRoundTripReceipt>;
  }
  return receipt;
}

async function createNativeDependencyCatalog(
  rootDir: string,
  plugins: Array<{
    name: string;
    dependencies?: string[];
    configureManifest?: (manifest: PluginMeta['manifest']) => void;
  }>,
): Promise<void> {
  const definitions = plugins.map((plugin) => ({
    ...plugin,
    configureManifest: (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.skills = './skills';
      manifest.extensions = undefined;
      plugin.configureManifest?.(manifest);
    },
  }));
  await createDependencyCatalogSnapshotFixture(rootDir, definitions);
  for (const plugin of plugins) {
    const skillRoot = path.join(rootDir, 'plugins', plugin.name, 'skills', `${plugin.name}-skill`);
    await Promise.all([
      fs.outputFile(
        path.join(skillRoot, 'SKILL.md'),
        `---\nname: ${plugin.name}-skill\ndescription: ${plugin.name} skill.\n---\n`,
      ),
      fs.outputFile(
        path.join(skillRoot, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
  }
  await createDependencyCatalogSnapshotFixture(rootDir, definitions);
}

async function configureCodexAliasCatalog(options: {
  cwd: string;
  userConfig: string;
  sourceName: string;
}) {
  const isolation = getCurrentSourceTestIsolation();
  const env = { ...isolation.env, CODEX_HOME: options.userConfig };
  const sourceRoot = path.join(isolation.layout.fixtureCwd, options.sourceName);
  await fs.ensureDir(options.cwd);
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
    manifest.platforms = ['codex'];
    manifest.extensions = {
      instructions: [{ name: 'policy', title: 'Policy', content: 'Policy.' }],
    };
  });
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
    },
    expectedDigest: snapshot.digest,
    env,
  });
  return {
    env,
    nativeCliRunner: vi.fn(async (_invocation: NativeCliInvocation) => ({
      exitCode: 0,
      stdout: 'codex-cli 99.0.0',
      stderr: '',
    })),
  };
}

async function writeDynamicSkillRenderer(options: {
  pluginRoot: string;
  skillKey: string;
  fail?: boolean;
  counterRoot?: string;
}): Promise<void> {
  await fs.outputFile(path.join(options.pluginRoot, 'scripts', 'render.mjs'), [
    'import { readFile, writeFile } from "node:fs/promises";',
    `const counterRoot = ${options.counterRoot === undefined
      ? 'process.env.AW_HOME'
      : JSON.stringify(options.counterRoot)};`,
    'const counter = `${counterRoot}/render-count-${process.env.AW_PLUGIN_NAME}.txt`;',
    'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
    'await writeFile(counter, String(previous + 1));',
    ...(options.fail ? ['throw new Error("renderer failed");'] : []),
    'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
    'console.log(JSON.stringify({ version: 2, artifacts: [{',
    '  id: "dynamic-skill", kind: "skill", platform: context.platform,',
    '  target: "codex.skill", state: "present", refreshKeys: [],',
    `  skillKey: ${JSON.stringify(options.skillKey)}, content: { files: {`,
    `    "SKILL.md": ${JSON.stringify(`---\nname: ${options.skillKey}\ndescription: Dynamic skill.\n---\n`)},`,
    '    "README.md": "Dynamic skill.\\n",',
    '    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n"',
    '  } }',
    '}] }));',
  ].join('\n'));
}

async function writeDynamicRoleRenderer(options: {
  pluginRoot: string;
  roleKey: string;
  fail?: boolean;
  counterRoot?: string;
}): Promise<void> {
  await fs.outputFile(path.join(options.pluginRoot, 'scripts', 'render.mjs'), [
    'import { readFile, writeFile } from "node:fs/promises";',
    `const counterRoot = ${options.counterRoot === undefined ? 'process.env.AW_HOME' : JSON.stringify(options.counterRoot)};`,
    'const counter = `${counterRoot}/render-count-${process.env.AW_PLUGIN_NAME}.txt`;',
    'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
    'await writeFile(counter, String(previous + 1));',
    ...(options.fail ? ['throw new Error("renderer failed");'] : []),
    'console.log(JSON.stringify({ version: 2, artifacts: [{',
    '  id: "dynamic-role", kind: "codexRole", platform: "codex",',
    '  target: "codex.agentRole", state: "present", refreshKeys: [],',
    `  roleKey: ${JSON.stringify(options.roleKey)}, content: {`,
    '    registration: { description: "Dynamic role." },',
    `    roleFile: { name: ${JSON.stringify(options.roleKey)}, description: "Dynamic role.", developer_instructions: "Use this role." }`,
    '  }',
    '}] }));',
  ].join('\n'));
}

describe('five namespaced write commands', () => {
  beforeEach(async () => {
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  // Test Value Gate: a shared source operation must execute only the selected plugin/platform pairs.
  it('groups exact Native targets without expanding the plugin and platform combinations', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'exact-native-source');
    await createNativeDependencyCatalog(sourceRoot, ['first', 'second'].map((name) => ({
      name, configureManifest(manifest) { manifest.platforms = ['codex', 'claude']; },
    })));
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: before.digest, env: isolation.env,
    });
    const codex = await createCodexNativeTestRuntime(isolation);
    const claude = await createClaudeNativeTestRuntime(isolation);
    await writeIntentFixture({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      roots: [{ pluginId: 'team/first' }, { pluginId: 'team/second' }], targets: ['codex', 'claude'],
    });
    const receipt = await runRecovery('sync', ['team/first', 'team/second'], {
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0',
      targets: ['codex', 'claude'], yes: true,
      exactTargets: [{ pluginId: 'team/first', agent: 'codex' },
        { pluginId: 'team/second', agent: 'claude' }],
    }, { nativeCliRunner: (invocation) => invocation.command === 'claude'
      ? claude.nativeCliRunner(invocation) : codex.nativeCliRunner(invocation) });
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ ok: true });
    expect(receipt.targetResults.map(({ pluginId, agent }) => [pluginId, agent])).toEqual([
      ['team/first', 'codex'], ['team/second', 'claude'],
    ]);
    expect([...codex.installed]).toEqual(['first@aw']);
    expect(Object.keys((await fs.readJson(claude.installedPath)).plugins)).toEqual(['second@aw']);
  });

  it('executes selected project Native demand without writing either intent file or other roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'execution-only-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'first' }, { name: 'second' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env,
    });
    const requirements = {
      roots: ['first', 'second'].map((name) => ({ pluginId: `team/${name}`, platforms: ['codex' as const] })),
      dependencyScopeOverrides: [],
    };
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const intentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    await fs.outputJson(intentPath, {
      schemaVersion: 3, kind: 'aw-plugin-intents',
      sources: { team: { logicalIdentity: await readCatalogLogicalIdentity(sourceRoot) } },
      roots: requirements.roots.map(({ pluginId }) => ({ pluginId })),
    });
    const intentBytes = await fs.readFile(intentPath);
    const runtime = await createCodexNativeTestRuntime(isolation);
    const execute = (pluginId: string) => syncWriteCommand([pluginId], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    const second = await execute('team/second');
    expect(second.overallState, JSON.stringify(second)).toBe('succeeded');
    const first = await execute('team/first');
    expect(first.overallState, JSON.stringify(first)).toBe('succeeded');
    const repeated = await execute('team/first');
    expect(repeated.overallState, JSON.stringify(repeated)).toBe('succeeded');
    expect(repeated.targetResults[0]?.action).toBe('keep');
    expect(await fs.readFile(intentPath)).toEqual(intentBytes);
    expect((await readFixtureRequirements({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env })).roots).toEqual([]);
    const projectConfig = await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'));
    expect(projectConfig.snapshot.plugins['second@aw']?.enabled).toBe(true);
    const publicResult = await runRecovery('sync', ['team/first'], {
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex'], yes: true,
    }, runtime);
    expect(publicResult, JSON.stringify(publicResult)).toMatchObject({
      schemaVersion: 1, kind: 'aw-recovery', ok: true,
      requestedRoots: ['team/first'],
      requestedTargets: [expect.objectContaining({ pluginId: 'team/first', agent: 'codex' })],
    });
    expect((await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .snapshot.plugins['second@aw']?.enabled).toBe(true);
    const activationPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const activationBytes = await fs.readFile(activationPath);
    const context = await createScopeContext({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const noNativeSelection = await nativeSyncWriteCommand(['team/first'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, executionInput: {
      context, requirements, selectedTargets: [], preserveOtherObservedTargets: true,
    } });
    await context.dispose();
    expect(noNativeSelection.overallState).toBe('succeeded');
    expect(await fs.readFile(activationPath)).toEqual(activationBytes);
    const preferencesPath = await resolvePreferencesPath({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env });
    for (const command of [uninstallWriteCommand, cleanupWriteCommand]) {
      if (command === cleanupWriteCommand) await fs.outputFile(preferencesPath, '{broken');
      const removed = await command(['team/first'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime);
      expect(removed.overallState, JSON.stringify(removed)).toBe('succeeded');
      expect(await fs.readFile(intentPath)).toEqual(intentBytes);
    }
    const forced = await cleanupWriteCommand(['team/first'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, runtime);
    expect(forced.overallState, JSON.stringify(forced)).toBe('succeeded');
    expect(await fs.readFile(preferencesPath, 'utf8')).toBe('{broken');
    expect(await fs.readFile(intentPath)).toEqual(intentBytes);
    await fs.remove(preferencesPath);
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const userResult = await installFixturePlugin(['team/first'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(userResult.overallState, JSON.stringify(userResult)).toBe('succeeded');
    expect(await fs.readFile(intentPath)).toEqual(intentBytes);
    expect((await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .snapshot.plugins['second@aw']?.enabled).toBe(true);
  });

  it('runs User Native renderer with only User config from two projects and a non-repo cwd', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'user-neutral-native-source');
    const renderEvents = path.join(isolation.layout.rootDir, 'user-neutral-native.jsonl');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'), [
      'import { appendFile, readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      `await appendFile(${JSON.stringify(renderEvents)}, JSON.stringify({ cwd: process.cwd(), scope: context.scope, mode: context.config.values.mode }) + "\\n");`,
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: "native", kind: "skill", platform: "codex", target: "codex.skill",',
      '  state: "present", skillKey: "user-neutral", refreshKeys: ["mode"],',
      '  content: { files: { "SKILL.md": `mode=${context.config.values.mode}\\n`, "README.md": "native readme\\n",',
      '    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n" } }',
      '}] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'neutral\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'common-default' } },
        platforms: { codex: { fields: { mode: { type: 'string', default: 'codex-default' } } } } };
      manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
      manifest.artifacts = { targets: [{
        id: 'native', platform: 'codex', scopes: ['user'], target: 'codex.skill',
        states: ['present'], refreshKeys: ['mode'], skillKey: 'user-neutral',
      }] };
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [source] },
      expectedDigest: configured.digest, env: isolation.env });
    const callers = ['a', 'b', 'c'].map((name) => path.join(isolation.layout.rootDir, `neutral-${name}`));
    await Promise.all(callers.map((cwd) => fs.ensureDir(cwd)));
    for (const cwd of callers) registerCurrentTestWritableStateRoot(cwd, 'Native user invocation project fixture');
    await Promise.all(callers.slice(0, 2).map((cwd) => fs.ensureDir(path.join(cwd, '.git'))));
    for (const cwd of callers.slice(0, 2)) {
      await fs.outputFile(path.join(cwd, '.agent-workflows', 'plugin-config', 'team', 'demo', 'config.json'),
        '{invalid-project-config');
    }
    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity: await calculateCatalogSourceIdentity(source),
      logicalIdentity: await readCatalogLogicalIdentity(sourceRoot), pluginName: 'demo',
      scope: 'user', cwd: callers[0]!, env: isolation.env, values: { mode: 'common-value' },
    });
    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity: await calculateCatalogSourceIdentity(source),
      logicalIdentity: await readCatalogLogicalIdentity(sourceRoot), pluginName: 'demo',
      platform: 'codex', scope: 'user', cwd: callers[0]!, env: isolation.env, values: { mode: 'user-value' },
    });
    await writeIntentFixture({ scope: 'user', cwd: callers[0]!, env: isolation.env }, {
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    for (const cwd of callers) {
      const result = await runRecovery('reinstall', ['team/demo'], {
        scope: 'user', cwd, env: isolation.env, cliVersion: '1.0.0',
        targets: ['codex'], yes: true,
      }, runtime);
      expect(result, JSON.stringify(result)).toMatchObject({
        schemaVersion: 1, kind: 'aw-recovery', scope: 'user', ok: true,
        requestedTargets: [expect.objectContaining({ pluginId: 'team/demo', agent: 'codex' })],
      });
    }
    const events = (await fs.readFile(renderEvents, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { cwd: string; scope: string; mode: string });
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const event of events) {
      expect(event).toMatchObject({ scope: 'user', mode: 'user-value' });
      expect(callers).not.toContain(event.cwd);
    }
    for (const [invocation] of runtime.nativeCliRunner.mock.calls) {
      if (!invocation.cwd || !callers.includes(invocation.cwd)) continue;
      if (invocation.args.includes('--version')) continue;
      const pluginArgs = invocation.args.slice(invocation.args.indexOf('plugin'));
      expect(pluginArgs.slice(0, 2)).toEqual(['plugin', 'list']);
      expect(pluginArgs).toEqual(expect.arrayContaining(['--marketplace', '--json']));
    }
    expect(runtime.installed.has('demo@aw')).toBe(true);
    for (const cwd of callers.slice(0, 2)) {
      expect((await readCodexConfigFile(path.join(cwd, '.codex', 'config.toml')))
        .snapshot.plugins['demo@aw']).toBeUndefined();
      expect(await fs.readFile(path.join(cwd, '.agent-workflows', 'plugin-config', 'team', 'demo', 'config.json'), 'utf8'))
        .toBe('{invalid-project-config');
    }
  }, 30_000);

  // Test Value Gate: cross-platform writes must preserve the other platform's installed bytes and unapplied configuration.
  it.each([
    ['static', ['codex', 'claude']],
    ['static', ['claude', 'codex']],
    ['dynamic', ['both']],
  ] as const)('preserves both native command platforms for %s Codex with install order %j', async (codexMode, order) => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const authoringRoot = path.join(cwd, 'dual-native-authoring');
    const pluginRoot = path.join(authoringRoot, 'plugins', 'dual-native');
    const trace = path.join(cwd, 'dual-native-render-requests.jsonl');
    const tool = 'import fs from "node:fs";fs.writeFileSync(process.env.CAPTURE_FILE,JSON.stringify(process.argv.slice(2)));\n';
    await fs.copy(path.join(repositoryRoot, 'plugins', 'marketplace-source.json'), path.join(authoringRoot, 'plugins', 'marketplace-source.json'));
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3, name: 'dual-native', version: '1.0.0', description: 'Dual native fixture.', skills: './skills',
      requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      config: { schemaVersion: 5, fields: { codexValue: { type: 'string', default: 'old-codex' }, claudeValue: { type: 'string', default: 'old-claude' } } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      ...(codexMode === 'dynamic' ? { artifacts: { targets: [{ id: 'codex-rendered', platform: 'codex', target: 'codex.skill', scopes: ['user', 'project'], states: ['present'], refreshKeys: ['codexValue'], skillKey: 'codex-rendered' }] } } : {}),
      managedCommands: { sets: [
        { set: 'codex-tools', producer: codexMode === 'dynamic' ? { kind: 'artifact', artifactId: 'codex-rendered' } : { kind: 'static-skill', platform: 'codex', skillKey: 'shared' }, mode: 'dynamic', refreshKeys: ['codexValue'] },
        { set: 'claude-tools', producer: { kind: 'static-skill', platform: 'claude', skillKey: 'shared' }, mode: 'dynamic', refreshKeys: ['claudeValue'] },
      ] },
      buildConfig: { skillRuntimeFiles: (['codex', 'claude'] as const).map((platform) => ({ skill: 'shared', source: `./${platform}-command.md`, target: `references/${platform}-command.md`, platforms: [platform] })) },
    });
    await fs.outputFile(path.join(pluginRoot, 'skills/shared/SKILL.md'), '---\nname: shared\ndescription: Shared native fixture.\n---\nUse the platform command reference.\n');
    await fs.outputFile(path.join(pluginRoot, 'skills/shared/README.md'), '# Shared native\n');
    await fs.outputFile(path.join(pluginRoot, 'skills/shared/agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: true\n');
    await fs.outputFile(path.join(pluginRoot, 'skills/shared/scripts/tool.mjs'), tool);
    for (const platform of ['codex', 'claude']) await fs.outputFile(path.join(pluginRoot, `${platform}-command.md`), `{{aw.command:${platform}-tools/run}} check\n`);
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      `fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify({platform:c.platform,ids:c.requestedArtifactIds})+'\\n');`,
      `const tool=${JSON.stringify(tool)};`,
      "console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>id==='codex-rendered'?{id,target:'codex.skill',kind:'skill',platform:'codex',state:'present',skillKey:'codex-rendered',refreshKeys:['codexValue'],content:{files:{'SKILL.md':'---\\nname: codex-rendered\\ndescription: Rendered native.\\n---\\n{{aw.command:codex-tools/run}} check\\n','README.md':'# Native\\n','agents/openai.yaml':'policy:\\n  allow_implicit_invocation: true\\n','scripts/tool.mjs':tool}}}:{id,target:'aw.command-set',kind:'commandSet',platform:c.platform,state:'present',refreshKeys:[c.platform+'Value'],entries:[{key:'run',runner:'node',entry:'scripts/tool.mjs',args:[c.config.values[c.platform+'Value']]}]})}));",
    ].join('\n'));
    const sourceRoot = await createSyntheticEmbeddedRoot(authoringRoot);
    await fs.outputJson(path.join(sourceRoot, '.aw-generated.json'), { schemaVersion: 1, kind: 'catalog', workspaceIdentity: `fixture:${sourceRoot}`, sourceIdentity: `sha256:${'c'.repeat(64)}` });
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: before.digest, env: isolation.env });
    const codex = await createCodexNativeTestRuntime(isolation, '0.151.0');
    const claude = await createClaudeNativeTestRuntime(isolation);
    const nativeCliRunner = async (invocation: NativeCliInvocation) => invocation.command === 'claude' ? claude.nativeCliRunner(invocation) : codex.nativeCliRunner(invocation);
    const run = async (args: string[]) => {
      const captured = createCapturedCliIo();
      const exitCode = await runCli([...args, '--json'], { cwd, env: isolation.env, io: captured.io, interactive: false, nativeCliRunner });
      return { exitCode, payload: JSON.parse(captured.readStdout()), stderr: captured.readStderr() };
    };
    const ids = new Map<string, string>();
    const assertCommands = async (expected: Record<string, string>) => {
      const commands = (await listManagedCommands(isolation.env)).commands;
      expect(commands).toHaveLength(Object.keys(expected).length);
      for (const [platform, value] of Object.entries(expected)) {
        const command = commands.find((entry) => entry.owner.kind === 'plugin' && entry.owner.producer.platform === platform)!;
        expect(command).toMatchObject({ availability: 'ready' });
        if (ids.has(platform)) expect(command.id).toBe(ids.get(platform));
        ids.set(platform, command.id);
        const record = await fs.readJson(path.join(command.resourceRoot!, '.aw-command-producer.json'));
        expect(record.producer).toMatchObject({ platform, sourceId: 'team', scope: 'user', projectRoot: null });
        expect((await resolveManagedCommand(command.id, isolation.env)).launch.args).toEqual([value]);
        const markdown = platform === 'codex' && codexMode === 'dynamic' ? 'SKILL.md' : `references/${platform}-command.md`;
        expect(await fs.readFile(path.join(command.resourceRoot!, markdown), 'utf8')).toContain(`aw command run ${command.id} -- check`);
        const capture = path.join(cwd, `${platform}-run.json`);
        expect(await runCli(['command', 'run', command.id, '--', 'check'], { cwd, env: { ...isolation.env, CAPTURE_FILE: capture }, io: createCapturedCliIo().io, interactive: false, nativeCliRunner })).toBe(0);
        expect(await fs.readJson(capture)).toEqual([value, 'check']);
      }
    };
    const expected: Record<string, string> = {};
    for (const platform of order) {
      await writePreferences({ scope: 'user', cwd, env: isolation.env }, {
        ...createEmptyPreferences(),
        targets: [...new Set([...Object.keys(expected), ...(platform === 'both' ? ['codex', 'claude'] : [platform])])] as Array<'codex' | 'claude'>,
      });
      const installed = await run(['plugin', 'install', 'team/dual-native', '--scope', 'user']);
      expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0, payload: { ok: true } });
      for (const current of platform === 'both' ? ['codex', 'claude'] : [platform]) expected[current] = `old-${current}`;
      await assertCommands(expected);
    }
    for (const platform of ['codex', 'claude']) expect(await run(['plugin', 'config', 'set', 'team/dual-native', `${platform}Value`, '--context', 'user', '--platform', platform, '--value-json', JSON.stringify(`saved-${platform}`)])).toMatchObject({ exitCode: 0 });
    const selected = order[0] === 'both' ? ['claude', 'codex'] : [order.at(-1)!];
    for (const platform of selected) {
      const oldTrace = (await fs.readFile(trace, 'utf8')).trim().split('\n').length;
      const other = platform === 'codex' ? 'claude' : 'codex';
      const otherCommand = (await listManagedCommands(isolation.env)).commands.find((command) => command.owner.kind === 'plugin' && command.owner.producer.platform === other)!;
      const oldTree = await snapshotRegularTree(otherCommand.resourceRoot!);
      const receiptPath = path.join(isolation.env.AW_HOME!, 'marketplaces/team/plugins/dual-native', CODEX_NATIVE_RENDER_RECEIPT_PATH);
      const previousReceipt = codexMode === 'dynamic' && other === 'codex' ? await fs.readJson(receiptPath) : undefined;
      const synced = await run(['plugin', 'sync', 'team/dual-native', ...(platform === 'both' ? ['--target', 'codex', '--target', 'claude'] : ['--target', platform === 'claude' ? 'claude' : platform]), '--context', 'user', '--yes']);
      expect(synced, JSON.stringify(synced)).toMatchObject({ exitCode: 0, payload: { ok: true } });
      const requests = (await fs.readFile(trace, 'utf8')).trim().split('\n').slice(oldTrace).map((line) => JSON.parse(line));
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((request) => request.platform === platform)).toBe(true);
      expect(await snapshotRegularTree(otherCommand.resourceRoot!)).toEqual(oldTree);
      if (previousReceipt) {
        const afterReceipt = await fs.readJson(receiptPath);
        expect({ ...afterReceipt, payloadDigest: previousReceipt.payloadDigest }).toEqual(previousReceipt);
        expect(afterReceipt.payloadDigest).toBe(await calculateCodexNativeRenderPayloadDigest(path.dirname(path.dirname(receiptPath))));
      }
      expect(synced.payload.commandResults?.flatMap((result: { removedCommandIds: string[] }) => result.removedCommandIds) ?? []).not.toContain(ids.get(other));
      expected[platform] = `saved-${platform}`;
      await assertCommands(expected);
      if (platform === 'codex') {
        const mutations = () => codex.nativeCliRunner.mock.calls.filter(([invocation]) => invocation.args[0] === 'plugin' && ['add', 'remove'].includes(invocation.args[1] ?? '')).length;
        const beforeNoop = mutations();
        expect(await run(['plugin', 'sync', 'team/dual-native', '--target', 'codex', '--context', 'user', '--yes'])).toMatchObject({ exitCode: 0 });
        expect(mutations()).toBe(beforeNoop);
      }
    }
    if (codexMode === 'dynamic') {
      const codexCommand = (await listManagedCommands(isolation.env)).commands.find((command) => command.owner.kind === 'plugin' && command.owner.producer.platform === 'codex')!;
      const recordPath = path.join(codexCommand.resourceRoot!, '.aw-command-producer.json');
      await fs.writeFile(recordPath, '{damaged');
      const other = (await listManagedCommands(isolation.env)).commands.find((command) => command.owner.kind === 'plugin' && command.owner.producer.platform === 'claude')!;
      const otherTree = await snapshotRegularTree(other.resourceRoot!);
      const blocked = await run(['plugin', 'sync', 'team/dual-native', '--target', 'claude', '--context', 'user', '--yes']);
      expect(blocked.exitCode).toBe(1);
      expect(await snapshotRegularTree(other.resourceRoot!)).toEqual(otherTree);
      const repaired = await run(['plugin', 'sync', '--rebuild', 'team/dual-native', '--target', 'codex', '--target', 'claude', '--context', 'user', '--yes']);
      expect(repaired, JSON.stringify(repaired)).toMatchObject({ exitCode: 0, payload: { ok: true } });
      await assertCommands({ codex: 'saved-codex', claude: 'saved-claude' });
    }
  }, 90000);

  // Protects the shared native payload across real scoped installation, config input, recovery, and offline cleanup.
  it('shares one Claude static command across user and two projects without scope cleanup revoking it', async () => {
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['claude'] });
    const isolation = getCurrentSourceTestIsolation();
    const authoringRoot = path.join(isolation.layout.fixtureCwd, 'claude-shared-authoring');
    const pluginRoot = path.join(authoringRoot, 'plugins', 'shared-claude');
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    await fs.copy(path.join(repositoryRoot, 'plugins', 'marketplace-source.json'), path.join(authoringRoot, 'plugins', 'marketplace-source.json'));
    await fs.outputJson(path.join(pluginRoot, '.agents-plugin', 'plugin.json'), {
      schemaVersion: 3, name: 'shared-claude', version: '1.0.0', description: 'Shared Claude command fixture.', skills: './skills',
      requires: { aw: { capabilities: ['aw.managed-commands.v1'] } },
      platforms: ['claude'],
      marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
      config: { schemaVersion: 5, fields: { revision: { type: 'string', default: 'default' } } },
      scripts: { artifacts: { render: { runner: 'node', path: './render.mjs' } } },
      managedCommands: { sets: [{ set: 'native', producer: { kind: 'static-skill', platform: 'claude', skillKey: 'shared-native' }, mode: 'dynamic', refreshKeys: ['revision'] }] },
      extensions: { permissions: [{ name: 'native', allow: [{ command: { set: 'native', key: 'run' }, argsPrefix: ['check'] }] }] },
    });
    await fs.outputFile(path.join(pluginRoot, 'skills', 'shared-native', 'SKILL.md'), '---\nname: shared-native\ndescription: Shared Claude native fixture.\n---\n{{aw.command:native/run}} check\n');
    await fs.outputFile(path.join(pluginRoot, 'skills', 'shared-native', 'README.md'), '# Shared native\n');
    await fs.outputFile(path.join(pluginRoot, 'skills', 'shared-native', 'scripts', 'tool.mjs'), 'import fs from "node:fs"; fs.writeFileSync(process.env.CAPTURE_FILE,JSON.stringify(process.argv.slice(2)));\n');
    await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
      "import fs from 'node:fs'; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,'utf8'));",
      "if(c.scope!=='user')throw new Error('Static command renderer must use user input.');",
      "console.log(JSON.stringify({version:2,artifacts:c.requestedArtifactIds.map(id=>({id,target:'aw.command-set',kind:'commandSet',platform:'claude',state:'present',refreshKeys:['revision'],entries:[{key:'run',runner:'node',entry:'scripts/tool.mjs',args:[c.config.values.revision]}]}))}));",
    ].join('\n'));
    const sourceRoot = await createSyntheticEmbeddedRoot(authoringRoot);
    await fs.outputJson(path.join(sourceRoot, '.aw-generated.json'), {
      schemaVersion: 1, kind: 'catalog',
      workspaceIdentity: `fixture:${crypto.createHash('sha256').update(sourceRoot).digest('hex')}`,
      sourceIdentity: `sha256:${crypto.createHash('sha256').update(`source:${sourceRoot}`).digest('hex')}`,
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [source] }, expectedDigest: before.digest, env: isolation.env });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    const projects = [path.join(isolation.layout.fixtureCwd, 'project-a'), path.join(isolation.layout.fixtureCwd, 'project-b')];
    for (const cwd of projects) { await fs.ensureDir(cwd); await git(cwd, ['init']); }
    const { runtime, nativeCliRunner, installedPath } = await createClaudeNativeTestRuntime(isolation);
    const config = { sourceId: 'team', sourceIdentity, logicalIdentity, pluginName: 'shared-claude', env: isolation.env };
    await writePluginConfigStore({ ...config, scope: 'user', cwd: projects[0]!, values: { revision: 'user-value' } });
    for (const cwd of projects) await fs.outputFile(path.join(cwd,
      '.agent-workflows/plugin-config/team/shared-claude/config.json'), '{legacy project config');
    const runPublic = async (cwd: string, args: string[]) => {
      const captured = createCapturedCliIo();
      const exitCode = await runCli([...args, '--json'], { cwd, env: isolation.env, io: captured.io, interactive: false, nativeCliRunner });
      return { exitCode, payload: JSON.parse(captured.readStdout()), stderr: captured.readStderr() };
    };
    let commandId: string | undefined, resourceRoot: string | undefined;
    for (const [scope, cwd] of [['user', projects[0]!], ['project', projects[0]!], ['project', projects[1]!]] as const) {
      const installed = await runPublic(cwd, ['plugin', 'install', 'team/shared-claude', '--scope', scope]);
      expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0, payload: { ok: true } });
      const commands = (await listManagedCommands(isolation.env)).commands;
      expect(commands).toHaveLength(1);
      commandId ??= commands[0]!.id;
      resourceRoot ??= commands[0]!.resourceRoot!;
      expect(commands[0]).toMatchObject({ id: commandId, resourceRoot, availability: 'ready', owner: { kind: 'plugin', producer: { scope: 'user', projectRoot: null, platform: 'claude', kind: 'static-skill' } } });
      expect((await resolveManagedCommand(commandId, isolation.env)).launch.args).toEqual(['user-value']);
    }
    const registry = await fs.readJson(installedPath);
    const nativeRecords = Object.values(registry.plugins).flat() as Array<{ installPath: string }>;
    expect(nativeRecords).toHaveLength(3);
    expect(new Set(nativeRecords.map((record) => record.installPath)).size).toBe(1);
    expect(await fs.readFile(path.join(resourceRoot!, 'SKILL.md'), 'utf8')).toContain(`aw command run ${commandId} -- check`);
    expect((await fs.readJson(path.join(resourceRoot!, '.aw-command-producer.json'))).producer).toMatchObject({ scope: 'user', projectRoot: null, kind: 'static-skill', platform: 'claude' });
    const userSettings = path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
    const checkRun = async () => {
      const capture = path.join(isolation.layout.fixtureCwd, 'claude-shared-capture.json');
      const output = createCapturedCliIo();
      expect(await runCli(['command', 'run', commandId!, '--', 'check'], { cwd: projects[1]!, env: { ...isolation.env, CAPTURE_FILE: capture }, io: output.io, interactive: false, nativeCliRunner })).toBe(0);
      expect(await fs.readJson(capture)).toEqual(['user-value', 'check']);
    };
    await checkRun();
    const cleaned = await runPublic(projects[0]!, ['plugin', 'cleanup', 'team/shared-claude', '--target', 'claude', '--scope', 'project', '--yes']);
    expect(cleaned, JSON.stringify(cleaned)).toMatchObject({ exitCode: 0, payload: { ok: true } });
    expect((await fs.readJson(path.join(projects[0]!, '.claude', 'settings.json'))).permissions?.allow ?? []).not.toContain(`Bash(aw command run ${commandId} -- check *)`);
    expect((await fs.readJson(userSettings)).permissions.allow).toContain(`Bash(aw command run ${commandId} -- check *)`);
    await checkRun();
    const uninstalled = await runPublic(projects[1]!, ['plugin', 'remove', 'team/shared-claude', '--scope', 'project']);
    expect(uninstalled, JSON.stringify(uninstalled)).toMatchObject({ exitCode: 0, payload: { ok: true } });
    await checkRun();
    const restoredProject = await runPublic(projects[1]!, ['plugin', 'install', 'team/shared-claude', '--scope', 'project', '--yes']);
    expect(restoredProject, JSON.stringify(restoredProject)).toMatchObject({ exitCode: 0 });
    const offline = await cleanupWriteCommand(['team/shared-claude'], { cwd: projects[1]!, platform: 'claude', scope: 'project', yes: true }, { ...runtime, catalogBootstrapError: new Error('Fixture Catalog offline.') });
    expect(offline.overallState, JSON.stringify(offline.rebuildResults)).toBe('succeeded');
    expect(offline.commandResults?.flatMap((result) => result.removedCommandIds) ?? []).not.toContain(commandId);
    await checkRun();
    const mirrorConfigPath = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team', 'config.json');
    const mirrorConfig = await fs.readJson(mirrorConfigPath);
    await fs.writeJson(mirrorConfigPath, { ...mirrorConfig, sourceIdentity: `sha256:${'b'.repeat(64)}` });
    await expect(resolveManagedCommand(commandId!, isolation.env)).rejects.toThrow();
    await fs.writeJson(mirrorConfigPath, mirrorConfig);
    await fs.writeFile(path.join(resourceRoot!, '.aw-command-producer.json'), '{broken');
    await expect(resolveManagedCommand(commandId!, isolation.env)).rejects.toThrow();
    const repairedCommand = await runPublic(projects[0]!, ['plugin', 'sync', '--rebuild', 'team/shared-claude', '--target', 'claude', '--context', 'user', '--yes']);
    expect(repairedCommand, JSON.stringify(repairedCommand)).toMatchObject({ exitCode: 0 });
    expect((await listManagedCommands(isolation.env)).commands.map((entry) => entry.id)).toEqual([commandId]);
    await checkRun();
    await fs.remove(resourceRoot!);
    await expect(resolveManagedCommand(commandId!, isolation.env)).rejects.toThrow();
    const repairedMissingCommand = await runPublic(projects[0]!, ['plugin', 'sync', '--rebuild', 'team/shared-claude', '--target', 'claude', '--context', 'user', '--yes']);
    expect(repairedMissingCommand, JSON.stringify(repairedMissingCommand)).toMatchObject({ exitCode: 0 });
    await checkRun();
  }, 90000);

  it('keeps sensitive config input out of argv and preserves stdin bytes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'sensitive-config-input-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = { fields: { token: { type: 'string', sensitive: true } } };
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    const readStore = () => readPluginConfigStore({
      sourceId: 'team', sourceIdentity, logicalIdentity,
      pluginName: 'demo', scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const runJson = async (args: string[], stdin?: PassThrough) => {
      const captured = createCapturedCliIo();
      const exitCode = await runCli([...args, '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
        ...(stdin ? { stdin } : {}),
      });
      return { exitCode, stdout: captured.readStdout(), stderr: captured.readStderr() };
    };

    for (const args of [
      ['--value-json', 'argv-secret'],
      ['--preset', 'argv-secret'],
    ]) {
      const rejected = await runJson([
        'plugin', 'config', 'set', 'team/demo', 'token', '--context', 'user', ...args,
      ]);
      expect(rejected.exitCode).toBe(1);
      expect(rejected.stdout).not.toContain('argv-secret');
      expect(rejected.stderr).not.toContain('argv-secret');
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        errors: [{ code: 'sensitiveConfigInputUnsupported' }],
      });
    }

    const missing = await runJson([
      'plugin', 'config', 'set', 'team/demo', 'token', '--context', 'user',
    ]);
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      errors: [{
        code: 'invalidArguments',
        message: 'Use exactly one of --value-json, --value-stdin, or --preset.',
      }],
    });

    const stdin = new PassThrough();
    stdin.end('stdin-secret\nwith-newline\n');
    const written = await runJson([
      'plugin', 'config', 'set', 'team/demo', 'token', '--context', 'user', '--value-stdin',
    ], stdin);
    expect(written.exitCode).toBe(0);
    await expect(readStore()).resolves.toMatchObject({
      values: { token: 'stdin-secret\nwith-newline\n' },
    });

    const password = vi.fn(async () => ({
      action: 'select' as const,
      cancelled: false,
      value: 'hidden-prompt-secret',
    }));
    const captured = createCapturedCliIo();
    const exitCode = await runCli([
      'plugin', 'config', 'set', 'team/demo', 'token', '--context', 'user',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: true,
      prompt: { password },
      ...createTtyRuntimeStreams(),
    });
    expect(exitCode).toBe(0);
    expect(password).toHaveBeenCalledOnce();
    expect(captured.readStdout()).not.toContain('hidden-prompt-secret');
    expect(captured.readStderr()).not.toContain('hidden-prompt-secret');
    await expect(readStore()).resolves.toMatchObject({ values: { token: 'hidden-prompt-secret' } });
  });

  it('prints an executable stdin-only repair command for invalid sensitive config', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'sensitive-config-repair-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = {
        fields: {
          token: {
            type: 'string', required: true, sensitive: true,
            validation: { minLength: 5 },
          },
        },
      };
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity: await calculateCatalogSourceIdentity(source),
      logicalIdentity: await readCatalogLogicalIdentity(sourceRoot),
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { token: 'abc' },
    });
    const output = createCapturedCliIo();

    const exitCode = await runCli([
      'plugin', 'config', 'list', 'team/demo', '--context', 'user',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: output.io,
      interactive: false,
    });

    expect(exitCode).toBe(0);
    expect(output.readStdout()).toContain(
      'aw plugin config set team/demo token --context user --value-stdin',
    );
    expect(output.readStdout()).not.toContain('abc');
    expect(output.readStdout()).not.toContain('--value-json');
    expect(output.readStdout()).not.toContain('--preset');
  });

  it.each(['sourceConfig', 'state', 'store'] as const)(
    'keeps cleanup recovery ownership-safe when Catalog %s is damaged',
    async (damagedControl) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `damaged-${damagedControl}-source`);
      await createDependencyCatalogSnapshotFixture(sourceRoot, [
        { name: 'normal' },
        { name: 'forced' },
      ]);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      };
      await expect(installFixturePlugin(['team/normal', 'team/forced'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const intentLocation = {
        scope: 'project' as const,
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      };
      const foreignRole = path.join(
        isolation.layout.fixtureCwd,
        '.codex',
        'agents',
        `foreign-${damagedControl}.toml`,
      );
      await fs.outputFile(foreignRole, 'foreign = true\n');
      const sharedConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      await applyCodexConfigTransactionFile(sharedConfig, {
        upsertMcpServers: { foreign: { command: 'foreign' } },
      });

      if (damagedControl === 'sourceConfig') {
        await fs.outputFile(path.join(isolation.env.AW_HOME!, 'catalog-sources.json'), '{private-data');
      } else if (damagedControl === 'state') {
        await fs.outputFile(path.join(isolation.env.AW_HOME!, 'catalog-state.json'), '{private-data');
      } else {
        const state = await fs.readJson(path.join(isolation.env.AW_HOME!, 'catalog-state.json')) as {
          sources: { team: { active: { logicalIdentity: string; snapshotDigest: string } } };
        };
        const store = resolveCatalogStoreLocation({ ...state.sources.team.active, env: isolation.env });
        await fs.outputFile(store.metadataPath, '{private-data');
      }

      if (damagedControl === 'sourceConfig') {
        const uninstall = await uninstallWriteCommand(['team/normal'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        }, runtime);
        expect(uninstall.targetResults).toEqual([
          expect.objectContaining({ errorCode: 'catalogSourceUnavailable' }),
        ]);
      }
      const normal = await cleanupWriteCommand(['team/normal'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime);
      const forced = await cleanupWriteCommand(['team/forced'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
      }, runtime);

      expect(normal.overallState, JSON.stringify(normal.rebuildResults)).toBe('succeeded');
      expect(forced.overallState, JSON.stringify(forced.rebuildResults)).toBe('succeeded');
      await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/normal' }), expect.objectContaining({ pluginId: 'team/forced' })]) });
      await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('foreign = true\n');
      await expect(readCodexConfigFile(sharedConfig)).resolves.toMatchObject({
        snapshot: { mcpServers: { foreign: { value: { command: 'foreign' } } } },
      });
    },
    30_000,
  );

  it('keeps warm write, config, and status provider-free after the TUI background check', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'warm-active-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'warm\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'warm', title: 'Warm', content: 'Warm.' }],
      };
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    let providerCalls = 0;
    const catalogGenerationRuntime = {
      providers: {
        path: async (...args: Parameters<typeof catalogPathProviderInternal.resolve>) => {
          providerCalls += 1;
          return catalogPathProviderInternal.resolve(...args);
        },
        git: async () => {
          providerCalls += 1;
          throw new Error('warm Active must not invoke the Git provider');
        },
      },
    };
    const nativeCliRunner = async () => ({
      exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '',
    });
    const writeRuntime = {
      env: isolation.env,
      nativeCliRunner,
      catalogGenerationRuntime,
    };

    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, writeRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, writeRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, writeRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(statusCommandV8({
      plugins: ['team/demo'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'codex',
      catalogGenerationRuntime,
    })).resolves.toMatchObject({ hasErrors: false });

    const context = createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner,
      interactive: false,
    });
    const controller = new TuiController(createTuiControllerDependencies(
      context,
      undefined,
      { catalogGenerationRuntime },
    ));
    await controller.load();
    await vi.waitFor(() => expect(providerCalls).toBe(1));
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'project',
      projectLayer: 'shared',
      updates: { mode: 'strict' },
    });
    expect(review.technicalDetails).toContainEqual(
      expect.stringMatching(/^Catalog generation：[0-9a-f]{8}$/u),
    );
    const pinnedGeneration = review.technicalDetails!.find((detail) =>
      detail.startsWith('Catalog generation：'))!;
    await expect(controller.executeOperation(review.reviewToken))
      .resolves.toMatchObject({ state: 'succeeded' });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'changed\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'warm', title: 'Warm', content: 'Changed.' }],
      };
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const staleReview = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'project',
      projectLayer: 'shared',
      updates: { mode: 'new' },
    });
    expect(staleReview.technicalDetails).toContain(pinnedGeneration);
    await expect(controller.executeOperation(staleReview.reviewToken))
      .resolves.toMatchObject({ state: 'stale' });
    controller.dispose();
    expect(providerCalls).toBe(1);
  });

  it('keeps owner and config identity after the official HTTPS transport changes to SSH', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const httpsRoot = path.join(isolation.layout.fixtureCwd, 'official-https-generation');
    const sshRoot = path.join(isolation.layout.fixtureCwd, 'official-ssh-generation');
    const configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'transport', title: 'Transport', content: 'Transport.' }],
      };
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
    };
    await Promise.all([
      createCatalogSnapshotFixture(httpsRoot, 'demo', [], 'https\n', configureManifest),
      createCatalogSnapshotFixture(sshRoot, 'demo', [], 'ssh\n', configureManifest),
    ]);
    const sshManifestPath = path.join(sshRoot, 'catalog-manifest.json');
    const sshManifest = await fs.readJson(sshManifestPath) as Record<string, unknown>;
    sshManifest.catalogVersion = '2.0.0';
    await Promise.all([
      fs.writeJson(sshManifestPath, sshManifest, { spaces: 2 }),
      ...[httpsRoot, sshRoot].map((root) => fs.writeJson(path.join(root, '.aw-generated.json'), {
        schemaVersion: 1,
        kind: 'catalog',
        workspaceIdentity: 'workspace:official-transport',
        sourceIdentity: 'sha256:'.concat('1'.repeat(64)),
      }, { spaces: 2 })),
    ]);
    const httpsSource = {
      id: 'official', type: 'git', primary: true, url: OFFICIAL_CATALOG_SOURCE_URL,
      refPolicy: { type: 'cliChannel' },
    } as const;
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [httpsSource] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    let currentRoot = httpsRoot;
    let commit = '1'.repeat(40);
    const resolvedTransports: string[] = [];
    const gitProvider = async (source: CatalogSource): Promise<CatalogSourceResolution> => {
      if (source.type === 'git') resolvedTransports.push(source.url);
      const validation = await validateCatalogSnapshotTransport(currentRoot);
      return {
        sourceId: source.id,
        sourceIdentity: await calculateCatalogSourceIdentity(source),
        requestedRef: source.type === 'git'
          ? resolveCatalogSourceRef(source.refPolicy, '1.0.0')
          : 'path',
        resolvedCommit: commit,
        rootDir: currentRoot,
        manifest: validation.manifest,
        manifestDigest: validation.manifestDigest,
        snapshotDigest: validation.snapshotDigest,
        cacheEntryKey: commit,
        source: 'remote',
        cacheFallback: false,
        cleanup: async () => undefined,
      };
    };
    const catalogGenerationRuntime = {
      providers: {
        git: gitProvider,
        path: catalogPathProviderInternal.resolve,
      },
    };
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env,
      runtime: catalogGenerationRuntime,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(httpsSource);
    const nativeCliRunner = async () => ({
      exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '',
    });
    await expect(installFixturePlugin(['official/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).resolves.toMatchObject({ overallState: 'succeeded' });
    await writePluginConfigStore({
      sourceId: 'official', sourceIdentity, logicalIdentity: 'workspace:official-transport',
      pluginName: 'demo', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { mode: 'https' },
    });

    currentRoot = sshRoot;
    commit = '2'.repeat(40);
    await expect(updateCatalogSourceCommand({
      sourceId: 'official', update: { url: OFFICIAL_CATALOG_SOURCE_SSH_URL },
      cliVersion: '1.0.0', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      runtime: { generation: catalogGenerationRuntime },
    })).resolves.toMatchObject({ ok: true, changed: true, errors: [] });
    expect(resolvedTransports).toEqual([
      OFFICIAL_CATALOG_SOURCE_URL,
    ]);
    await expect(readCatalogSourcesConfigSnapshot(isolation.env)).resolves.toMatchObject({
      config: { sources: [{ url: OFFICIAL_CATALOG_SOURCE_SSH_URL }] },
    });
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env,
      runtime: catalogGenerationRuntime,
    });
    expect(resolvedTransports).toEqual([
      OFFICIAL_CATALOG_SOURCE_URL,
      OFFICIAL_CATALOG_SOURCE_SSH_URL,
    ]);

    const status = await statusCommandV8({
      plugins: ['official/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    expect(status.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'official/demo', state: 'ready', reasons: [] }),
    ]);
    const captured = createCapturedCliIo();
    await expect(runCli([
      'plugin', 'config', 'set', 'official/demo', 'mode', '--value-json', '"ssh"', '--context', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner,
    })).resolves.toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      receiptSchemaVersion: 7,
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    await expect(readPluginConfigStore({
      sourceId: 'official', sourceIdentity, logicalIdentity: 'workspace:official-transport',
      pluginName: 'demo', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ exists: true, values: { mode: 'ssh' } });
    await expect(reinstallWriteCommand(['official/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).resolves.toMatchObject({ overallState: 'succeeded' });
  });

  it('preserves a saved user profile and requires reset after a path source identity changes', async () => {
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'project-config-first-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'project-config-second-source');
    const otherRoot = path.join(isolation.layout.fixtureCwd, 'project-config-other-source');
    const configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'configured', title: 'Configured', content: 'Configured.' }],
      };
      manifest.config = { fields: { mode: { type: 'string', title: 'Mode' } } };
    };
    await Promise.all([
      createCatalogSnapshotFixture(firstRoot, 'demo', [], 'first\n', configureManifest),
      createCatalogSnapshotFixture(secondRoot, 'demo', [], 'second\n', configureManifest),
      createCatalogSnapshotFixture(otherRoot, 'demo', [], 'other\n', configureManifest),
    ]);
    const logicalIdentity = 'workspace:portable-project-config';
    for (const root of [firstRoot, secondRoot]) {
      const markerPath = path.join(root, '.aw-generated.json');
      const marker = await fs.readJson(markerPath) as Record<string, unknown>;
      await fs.writeJson(markerPath, { ...marker, workspaceIdentity: logicalIdentity });
    }
    const otherMarkerPath = path.join(otherRoot, '.aw-generated.json');
    const otherMarker = await fs.readJson(otherMarkerPath) as Record<string, unknown>;
    await fs.writeJson(otherMarkerPath, {
      ...otherMarker,
      workspaceIdentity: 'workspace:different-project-config',
    });

    const firstSource = { id: 'team', type: 'path', primary: true, path: firstRoot } as const;
    const secondSource = { ...firstSource, path: secondRoot };
    const otherSource = { ...firstSource, path: otherRoot };
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [firstSource] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const nativeRuntime = await createCodexNativeTestRuntime(isolation);
    const runPublic = async (args: string[]) => {
      const captured = createCapturedCliIo();
      const exitCode = await runCli([...args, '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
        nativeCliRunner: nativeRuntime.nativeCliRunner,
      });
      return {
        exitCode,
        stdout: captured.readStdout(),
        stderr: captured.readStderr(),
      };
    };
    expect(await runPublic([
      'plugin', 'config', 'set', 'team/demo', 'mode', '--context', 'project', '--value-json', '"first"',
    ])).toMatchObject({ exitCode: 0 });

    const savedConfigPath = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo',
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env });
    const firstSavedBytes = await fs.readFile(savedConfigPath);
    const firstIdentity = await calculateCatalogSourceIdentity(firstSource);
    const secondIdentity = await calculateCatalogSourceIdentity(secondSource);
    expect(secondIdentity).not.toBe(firstIdentity);
    const beforeSecond = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfigWithoutActive({
      config: { schemaVersion: 2, sources: [secondSource] },
      expectedDigest: beforeSecond.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    await expect(readPluginConfigStore({
      sourceId: 'team', sourceIdentity: secondIdentity, logicalIdentity,
      pluginName: 'demo', scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ state: 'invalid', invalidCode: 'identityMismatch', values: {} });
    await expect(fs.readFile(savedConfigPath)).resolves.toEqual(firstSavedBytes);
    expect(await runPublic(['plugin', 'config', 'reset', 'team/demo', '--context', 'project', '--yes']))
      .toMatchObject({ exitCode: 0 });
    expect(await runPublic([
      'plugin', 'install', 'team/demo', '--scope', 'project',
    ])).toMatchObject({ exitCode: 0 });
    expect(await runPublic([
      'plugin', 'config', 'set', 'team/demo', 'mode', '--context', 'project', '--value-json', '"second"',
      '--apply', '--yes',
    ])).toMatchObject({ exitCode: 0 });

    const beforeOther = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfigWithoutActive({
      config: { schemaVersion: 2, sources: [otherSource] },
      expectedDigest: beforeOther.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const rejected = await runPublic([
      'plugin', 'config', 'list', 'team/demo', '--context', 'project',
    ]);
    expect(rejected.exitCode).toBe(1);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({ code: 'identityMismatch' })]),
    });
  });

  it('pins successful TUI source generations when another source is unavailable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'partial-session-good');
    const writeGoodSource = (version: string, field: string, content: string) =>
      createCatalogSnapshotFixture(sourceRoot, 'demo', [], `${content}\n`, (manifest) => {
        manifest.version = version;
        manifest.platforms = ['codex'];
        manifest.extensions = {
          instructions: [{ name: 'session', title: 'Session', content }],
        };
        manifest.config = { schemaVersion: 5,
          fields: {
            oldMode: { type: 'string', title: 'oldMode' },
            ...(field === 'oldMode' ? {} : { [field]: { type: 'string', title: field } }),
          },
        };
      });
    await writeGoodSource('1.0.0', 'oldMode', 'old generation');
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'good', type: 'path', primary: true, path: sourceRoot },
          {
            id: 'missing', type: 'git', primary: false,
            url: 'https://example.invalid/missing-session.git',
            refPolicy: { type: 'explicit', ref: 'refs/heads/catalog/latest' },
          },
        ],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'good', cliVersion: '1.0.0', env: isolation.env,
    });
    let goodProviderCalls = 0;
    let missingProviderCalls = 0;
    const catalogGenerationRuntime = {
      providers: {
        path: async (...args: Parameters<typeof catalogPathProviderInternal.resolve>) => {
          goodProviderCalls += 1;
          return catalogPathProviderInternal.resolve(...args);
        },
        git: async () => {
          missingProviderCalls += 1;
          throw new Error('missing source is offline');
        },
      },
    };
    const controller = new TuiController(createTuiControllerDependencies(
      createCliExecutionContext({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
        interactive: false,
      }),
      undefined,
      { catalogGenerationRuntime },
    ));
    await controller.load();
    expect(controller.getPluginOverview('good/demo')).toMatchObject({ version: '1.0.0' });
    await vi.waitFor(() => {
      expect(controller.snapshot.sourceHealth).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceId: 'good', state: 'ready' }),
        expect.objectContaining({ sourceId: 'missing', state: 'unavailable' }),
      ]));
    });
    await vi.waitFor(() => {
      expect(goodProviderCalls).toBe(1);
      expect(missingProviderCalls).toBe(1);
    });

    await writeGoodSource('2.0.0', 'newMode', 'new generation');
    await syncCatalogSourceGeneration({
      sourceId: 'good', cliVersion: '1.0.0', env: isolation.env,
    });
    expect(controller.getPluginOverview('good/demo')).toMatchObject({ version: '1.0.0' });
    const page = await controller.getConfigPage(
      'good/demo',
      { context: 'project' },
    );
    expect(page.groups.flatMap((group) => group.fields.map((field) => field.key)))
      .toContain('oldMode');
    expect(page.groups.flatMap((group) => group.fields.map((field) => field.key)))
      .not.toContain('newMode');
    const review = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'good/demo',
      scope: 'user',
      context: 'project',
      updates: { oldMode: 'strict' },
    });
    const executeResult = await controller.executeOperation(review.reviewToken);
    expect(executeResult, JSON.stringify(executeResult)).toMatchObject({ state: 'stale' });
    const sourceIdentity = await calculateCatalogSourceIdentity({
      id: 'good', type: 'path', primary: true, path: sourceRoot,
    });
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    await expect(readPluginConfigStore({
      sourceId: 'good',
      sourceIdentity,
      logicalIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ exists: false });
    const missingPlan = await controller.prepareScopedTask({
      kind: 'recovery', command: 'install', scope: 'project',
      selectors: ['missing/demo'],
    });
    expect(missingPlan).toMatchObject({ kind: 'recovery', scope: 'project' });
    if (missingPlan.kind !== 'recovery') throw new Error('Expected recovery plan.');
    expect(missingPlan.plan.receipt.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sourceActiveUnavailable' }),
    ]));
    expect(goodProviderCalls).toBe(1);
    await vi.waitFor(() => {
      expect(missingProviderCalls).toBe(1);
    });
    controller.dispose();
  });

  it('keeps a Codex user install healthy when the project config aliases the user home', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.layout.fixtureCwd, 'codex-scope-alias-home');
    await fs.ensureDir(path.join(cwd, '.git'));
    const { env, nativeCliRunner } = await configureCodexAliasCatalog({
      cwd,
      userConfig: path.join(cwd, '.codex'),
      sourceName: 'codex-scope-alias-source',
    });

    const installed = await installFixturePlugin(['team/demo'], {
      cwd,
      platform: 'codex',
      scope: 'user',
    }, { env, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');

    const status = await statusCommandV8({
      plugins: ['team/demo'],
      cwd,
      env,
      cliVersion: '1.0.0',
      platform: 'codex',
      json: true,
      verbose: true,
    });
    expect(status.payload.targets).toEqual([
      expect.objectContaining({
        pluginId: 'team/demo',
        state: 'ready',
        placements: expect.arrayContaining([expect.objectContaining({ scope: 'user', state: 'ready' })]),
      }),
    ]);
    await expect(statusCommandV8({
      plugins: ['team/demo'],
      cwd,
      env,
      cliVersion: '1.0.0',
      platform: 'codex',
      scope: 'project',
      json: true,
    })).resolves.toMatchObject({
      payload: {
        targets: [expect.objectContaining({
          state: 'blocked',
          placements: [expect.objectContaining({
            scope: 'project',
            reasons: expect.arrayContaining([
              expect.objectContaining({ code: 'codexScopePathAlias' }),
            ]),
          })],
        })],
      },
    });

    const reinstalled = await reinstallWriteCommand(['team/demo'], {
      cwd,
      platform: 'codex',
      scope: 'user',
    }, { env, nativeCliRunner });
    expect(reinstalled.overallState, JSON.stringify(reinstalled.rebuildResults)).toBe('succeeded');
  });

  it('isolates user lifecycle planning from obsolete project config', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'target-scoped-config-source');
    await createCatalogSnapshotFixture(sourceRoot, 'target-scoped', [], 'config\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'target-scoped', title: 'Target scoped', content: 'Target scoped.' }],
      };
      manifest.config = { fields: { mode: { type: 'string', default: 'default' } } };
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    await writePluginConfigStore({
      sourceId: source.id,
      sourceIdentity,
      logicalIdentity,
      pluginName: 'target-scoped',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { mode: 'user' },
    });
    const legacyProjectPath = path.join(isolation.layout.fixtureCwd,
      '.agent-workflows/plugin-config/team/target-scoped/config.json');
    await fs.outputFile(legacyProjectPath, '{invalid');
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };

    await expect(installFixturePlugin(['team/target-scoped'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(readPluginConfigStore({ sourceId: source.id, sourceIdentity, pluginName: 'target-scoped',
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .resolves.toMatchObject({ state: 'ready', values: { mode: 'user' } });
    await expect(fs.readFile(legacyProjectPath, 'utf8')).resolves.toBe('{invalid');
    const reviewed = await reinstallWriteCommand(['team/target-scoped'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, previewOperationPlan: true });
    expect(reviewed.operationPlan, JSON.stringify(reviewed)).toBeDefined();
    await fs.writeFile(legacyProjectPath, '{different invalid project config');
    await expect(reinstallWriteCommand(['team/target-scoped'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, {
      ...runtime,
      expectedPlanFingerprint: reviewed.operationPlan!.planFingerprint,
    })).resolves.toMatchObject({ overallState: 'succeeded' });
  });

  it.each(['direct', 'symlink'] as const)(
    'blocks Codex project writes when its config has a %s alias to the user home',
    async (alias) => {
      const isolation = getCurrentSourceTestIsolation();
      const cwd = path.join(isolation.layout.fixtureCwd, `codex-project-${alias}-alias`);
      const projectConfig = path.join(cwd, '.codex');
      await fs.ensureDir(projectConfig);
      const userConfig = alias === 'direct'
        ? projectConfig
        : path.join(isolation.layout.fixtureCwd, 'codex-user-home-link');
      if (alias === 'symlink') await fs.symlink(projectConfig, userConfig);
      const { env, nativeCliRunner } = await configureCodexAliasCatalog({
        cwd,
        userConfig,
        sourceName: `codex-project-${alias}-source`,
      });

      const result = await installFixturePlugin(['team/demo'], {
        cwd,
        platform: 'codex',
        scope: 'project',
      }, { env, nativeCliRunner });

      expect(result.overallState).toBe('failed');
      expect(result.targetResults).toEqual([
        expect.objectContaining({
          target: expect.objectContaining({ pluginId: 'team/demo', scope: 'project' }),
          errorCode: 'codexScopePathAlias',
        }),
      ]);
      expect(nativeCliRunner.mock.calls.map(([invocation]) => invocation.args.join(' ')).join('\n'))
        .not.toMatch(/(?:marketplace|plugin) add/u);
    },
  );

  it('keeps cleanup available for a project owner after Codex config paths become aliases', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = path.join(isolation.layout.fixtureCwd, 'codex-project-alias-cleanup');
    const { env: initialEnv, nativeCliRunner } = await configureCodexAliasCatalog({
      cwd,
      userConfig: path.join(isolation.layout.fixtureCwd, 'separate-codex-user-home'),
      sourceName: 'codex-project-alias-cleanup-source',
    });
    const installed = await installFixturePlugin(['team/demo'], {
      cwd,
      platform: 'codex',
      scope: 'project',
    }, { env: initialEnv, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');

    const aliasEnv = { ...initialEnv, CODEX_HOME: path.join(cwd, '.codex') };
    const cleaned = await cleanupWriteCommand(['team/demo'], {
      cwd,
      platform: 'codex',
      scope: 'project',
    }, { env: aliasEnv, nativeCliRunner });

    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    expect(cleaned.receiptTargets).toEqual([
      expect.objectContaining({ pluginId: 'team/demo', scope: 'project' }),
    ]);
  });

  it('rejects a symlinked marketplace parent before first install writes external or native state', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'symlinked-marketplace-source');
    await createCatalogSnapshotFixture(sourceRoot);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const victim = path.join(isolation.layout.rootDir, 'external-marketplace-victim');
    await fs.outputFile(path.join(victim, 'sentinel.txt'), 'unchanged\n');
    const marketplaces = path.join(isolation.env.AW_HOME!, 'marketplaces');
    await fs.symlink(victim, marketplaces);
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'codex-cli 0.200.0',
      stderr: '',
    }));

    const result = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('failed');
    expect(result.rebuildResults[0]?.failures[0]?.phase).toBe('preflight');
    await expect(fs.readFile(path.join(victim, 'sentinel.txt'), 'utf8')).resolves.toBe('unchanged\n');
    await expect(fs.readdir(victim)).resolves.toEqual(['sentinel.txt']);
    expect((await fs.lstat(marketplaces)).isSymbolicLink()).toBe(true);
    expect(nativeCliRunner.mock.calls.map(([invocation]) => invocation.args.join(' ')).join('\n'))
      .not.toMatch(/(?:marketplace|plugin) add/u);
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex'))).resolves.toBe(false);
  });

  it('installs a dependency closure in dependency-first order and keeps present dependencies', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'middle', dependencies: ['leaf'] },
      { name: 'root', dependencies: ['middle'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.dependencyPlan?.resolvedPluginIds).toEqual([
      'team/leaf',
      'team/middle',
      'team/root',
    ]);
    expect(result.rebuildResults.map((entry) => entry.target.pluginName)).toEqual([
      'leaf',
      'middle',
      'root',
    ]);
    const repeated = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    });
    expect(repeated.overallState, JSON.stringify(repeated.rebuildResults)).toBe('succeeded');
    expect(repeated.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/leaf', action: 'keep' }),
      expect.objectContaining({ pluginId: 'team/middle', action: 'keep' }),
      expect.objectContaining({ pluginId: 'team/root', relation: 'requested' }),
    ]));
  });

  it('repairs one shared Native dependency for two reviewed project roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'two-root-shared-dependency');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'first', dependencies: ['leaf'] },
      { name: 'second', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner, interactive: false,
    }));
    const plan = await dependencies.prepareScopedTask({
      kind: 'recovery', command: 'install', scope: 'project',
      selectors: ['team/first', 'team/second'],
    }, new AbortController().signal);
    expect(plan.kind).toBe('recovery');
    const result = await dependencies.executeScopedTask(plan);
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'recovery', receipt: { kind: 'aw-recovery', ok: true } });
    if (result.kind !== 'recovery') throw new Error('Expected recovery receipt.');
    expect(result.receipt.requestedRoots).toEqual(['team/first', 'team/second']);
    const backend = result.receipt.targetResults.find((target) => target.pluginId === 'team/first')
      ?.backend as { targetResults?: Array<{ target: { pluginId: string }; action: string }> } | undefined;
    expect(backend?.targetResults?.filter((target) => target.target.pluginId === 'team/leaf'))
      .toHaveLength(1);
    expect(runtime.installed).toEqual(new Set(['leaf@aw', 'first@aw', 'second@aw']));
    expect((await readIntentFixture({ scope: 'project', cwd: isolation.layout.fixtureCwd,
      env: isolation.env })).roots.map((root) => root.pluginId)).toEqual(['team/first', 'team/second']);
    expect((await readIntentFixture({ scope: 'user', cwd: isolation.layout.fixtureCwd,
      env: isolation.env })).roots).toEqual([]);
  }, 30_000);

  it('updates only selected native plugins and dependencies that require materialization', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'selected-native-update-source');
    const writeCatalog = async (version: string) => createNativeDependencyCatalog(sourceRoot, [
      ...['changed-dependency', 'unrelated'].map((name) => ({
        name,
        configureManifest: (manifest: PluginMeta['manifest']) => { manifest.version = version; },
      })),
      { name: 'kept-dependency' },
      {
        name: 'root',
        dependencies: ['changed-dependency', 'kept-dependency'],
        configureManifest: (manifest: PluginMeta['manifest']) => { manifest.version = version; },
      },
    ]);
    await writeCatalog('1.0.0');
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeRuntime = await createCodexNativeTestRuntime(isolation);
    const runtime = { env: isolation.env, nativeCliRunner: nativeRuntime.nativeCliRunner };
    const commandOptions = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const, yes: true };
    const installed = await installFixturePlugin(['team/root', 'team/unrelated'], commandOptions, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    for (const name of ['unrelated', 'kept-dependency']) {
      await fs.outputFile(path.join(marketplaceRoot, 'plugins', name, 'local.txt'), `${name} retained\n`);
    }
    const before = await snapshotRegularTree(path.join(marketplaceRoot, 'plugins', 'unrelated'));

    await writeCatalog('2.0.0');
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    const callsBeforeSync = nativeRuntime.nativeCliRunner.mock.calls.length;
    const updated = await syncWriteCommand(['team/root'], commandOptions, runtime);

    expect(updated.overallState, JSON.stringify(updated.rebuildResults)).toBe('succeeded');
    expect(updated.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/kept-dependency', action: 'keep' }),
    ]));
    for (const name of ['root', 'changed-dependency']) {
      await expect(fs.readJson(path.join(marketplaceRoot, 'plugins', name, '.codex-plugin', 'plugin.json')))
        .resolves.toMatchObject({ version: '2.0.0' });
    }
    // The installed Native versions must advance; copying candidate manifests alone is insufficient.
    const nativeAdds = nativeRuntime.nativeCliRunner.mock.calls.slice(callsBeforeSync).flatMap(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      return pluginIndex >= 0 && invocation.args[pluginIndex + 1] === 'add'
        ? [invocation.args[pluginIndex + 2]] : [];
    });
    expect(nativeAdds).toEqual(['changed-dependency@aw', 'root@aw']);
    const observed = JSON.parse((await nativeRuntime.nativeCliRunner({ command: 'codex',
      args: ['plugin', 'list', '--marketplace', 'aw', '--json'], cwd: commandOptions.cwd, env: isolation.env,
    })).stdout) as { installed: Array<{ pluginId: string; version: string }> };
    for (const name of ['root', 'changed-dependency']) {
      expect(observed.installed).toContainEqual(expect.objectContaining({ pluginId: `${name}@aw`, version: '2.0.0' }));
    }
    expect(await snapshotRegularTree(path.join(marketplaceRoot, 'plugins', 'unrelated'))).toEqual(before);
    await expect(fs.readFile(path.join(marketplaceRoot, 'plugins', 'kept-dependency', 'local.txt'), 'utf8'))
      .resolves.toBe('kept-dependency retained\n');
  });

  it('materializes one native marketplace generation and one Codex post snapshot for a dependency group', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-group-source');
    const dependencyNames = ['leaf-a', 'leaf-b', 'leaf-c', 'leaf-d', 'leaf-e'];
    const pluginNames = [...dependencyNames, 'root'];
    const configureDynamicNative = (manifest: PluginMeta['manifest']) => {
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-skill',
        platform: 'codex',
        scopes: ['user', 'project'],
        target: 'codex.skill',
        states: ['present'],
        refreshKeys: [],
        skillKey: 'dynamic-skill',
      }] };
    };
    const definitions = [
      ...dependencyNames.map((name) => ({ name })),
      { name: 'root', dependencies: dependencyNames },
    ].map((definition) => ({ ...definition, configureManifest: configureDynamicNative }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    for (const pluginName of pluginNames) {
      await writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', pluginName),
        skillKey: 'dynamic-skill',
      });
    }
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await fs.copy(sourceRoot, marketplaceRoot);
    await fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
      schemaVersion: 2,
      sourceId: 'team',
      sourceIdentity,
      marketplaceName: 'aw',
    });
    for (const manifestPath of [
      path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    ]) {
      const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
      await fs.writeJson(manifestPath, { ...manifest, name: 'aw' });
    }
    const runtime = await createCodexNativeTestRuntime(isolation);
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      interactive: false,
    }));
    const plan = await dependencies.prepareScopedTask({
      kind: 'recovery', command: 'install', selectors: ['team/root'],
      scope: 'project',
    }, new AbortController().signal);
    expect(plan.kind).toBe('recovery');
    const lockedCallsStart = runtime.nativeCliRunner.mock.calls.length;
    const previewLists = runtime.nativeCliRunner.mock.calls.slice(0, lockedCallsStart).filter(([invocation]) =>
      invocation.args.slice(invocation.args.indexOf('plugin')).join(' ')
        === 'plugin list --marketplace aw --json');
    const copy = vi.spyOn(fs, 'copy');
    const move = vi.spyOn(fs, 'move');
    const rename = vi.spyOn(fs, 'rename');
    let result: Awaited<ReturnType<typeof dependencies.executeScopedTask>>;
    let catalogCopyGenerationCount = 0;
    let generationSwapCount = 0;
    let committedBackupCount = 0;
    try {
      result = await dependencies.executeScopedTask(plan);
      catalogCopyGenerationCount = new Set(copy.mock.calls.flatMap(([, destination]) =>
        path.basename(path.dirname(String(destination))).startsWith('.team-staging-')
          ? [path.dirname(String(destination))]
          : [])).size;
      generationSwapCount = move.mock.calls.filter(([sourcePath, destination]) =>
        path.basename(String(sourcePath)).startsWith('.team-staging-')
        && path.resolve(String(destination)) === path.resolve(marketplaceRoot)).length;
      committedBackupCount = rename.mock.calls.filter(([sourcePath]) =>
        path.basename(String(sourcePath)).startsWith('team.backup-')).length;
    } finally {
      copy.mockRestore();
      move.mockRestore();
      rename.mockRestore();
    }

    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'recovery', receipt: { kind: 'aw-recovery', ok: true } });
    expect.soft(catalogCopyGenerationCount).toBe(1);
    expect.soft(generationSwapCount).toBe(1);
    expect.soft(committedBackupCount).toBe(1);
    const lockedCalls = runtime.nativeCliRunner.mock.calls.slice(lockedCallsStart);
    const jsonLists = lockedCalls.filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'list' && args.includes('--json');
    });
    const nonJsonLists = lockedCalls.filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'list' && !args.includes('--json');
    });
    const observationCalls = [...previewLists, ...jsonLists];
    const projectCalls = observationCalls.filter(([invocation]) =>
      path.resolve(invocation.cwd) === path.resolve(isolation.layout.fixtureCwd)).length;
    const observationCounts = JSON.stringify({ preview: previewLists.length, locked: jsonLists.length,
      cwd: { project: projectCalls, userNeutral: observationCalls.length - projectCalls } });
    expect.soft(previewLists.length, observationCounts).toBeLessThanOrEqual(2);
    expect.soft(jsonLists.length, observationCounts).toBeLessThanOrEqual(4);
    expect(nonJsonLists).toHaveLength(0);
    expect.soft(previewLists.length + jsonLists.length, observationCounts).toBeLessThanOrEqual(6);
    expect(runtime.installed).toEqual(new Set([
      ...dependencyNames.map((name) => `${name}@aw`),
      'root@aw',
    ]));
    for (const pluginName of pluginNames) {
      await expect.soft(fs.readFile(path.join(
        marketplaceRoot,
        'plugins',
        pluginName,
        'codex',
        'skills',
        'dynamic-skill',
        'SKILL.md',
      ), 'utf8')).resolves.toContain('name: dynamic-skill');
    }
  }, 30_000);

  it.each(['beforeRename', 'afterQuarantine'] as const)(
    'reports activation-only legacy Skill cleanup failure at %s and supports retry recovery',
    async (failurePoint) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `activation-legacy-cleanup-${failurePoint}`,
      );
      const configureDynamicNative = (manifest: PluginMeta['manifest']) => {
        manifest.scripts = {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        };
        manifest.artifacts = { targets: [{
          id: 'dynamic-skill',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'native-skill',
        }] };
      };
      const definitions = [{ name: 'demo', configureManifest: configureDynamicNative }, {
        name: 'consumer', dependencies: ['demo'],
      }, { name: 'independent' }];
      await createNativeDependencyCatalog(sourceRoot, definitions);
      await writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'demo'),
        skillKey: 'native-skill',
      });
      await createNativeDependencyCatalog(sourceRoot, definitions);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const initialInstall = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, runtime);
      expect(initialInstall.overallState, JSON.stringify(initialInstall.rebuildResults)).toBe('succeeded');

      const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
      const legacySkillRoot = path.join(skillsRoot, 'native-skill');
      await fs.outputFile(path.join(legacySkillRoot, 'SKILL.md'), 'legacy\n');
      await writeSkillOwnerMarker({
        skillRoot: legacySkillRoot,
        allowedRoot: skillsRoot,
        identity: {
          owner: 'agent-workflows',
          sourceId: 'team',
          pluginId: 'team/demo',
          plugin: 'demo',
          artifactKey: 'native-skill',
          platform: 'codex',
          scope: 'project',
        },
      });
      let quarantinedPath: string | undefined;
      setRebuildCommandTestHooksForTests(failurePoint === 'beforeRename'
        ? {
            beforeActivationLegacyCleanupMutation: async () => {
              throw new Error('injected rename precondition failure');
            },
          }
        : {
            afterActivationLegacyCleanupQuarantine: async (_component, candidate) => {
              quarantinedPath = candidate;
              throw new Error('injected quarantined removal failure');
            },
          });
      let failed;
      try {
        failed = await installFixturePlugin(['team/consumer', 'team/independent'], {
          cwd: isolation.layout.fixtureCwd,
          platform: 'codex',
          scope: 'project',
        }, runtime);
      } finally {
        setRebuildCommandTestHooksForTests(undefined);
      }

      expect(failed.overallState, JSON.stringify(failed.rebuildResults)).toBe('partial');
      expect(failed.rebuildResults).toContainEqual(expect.objectContaining({
        status: 'failed',
        target: expect.objectContaining({ pluginName: 'demo' }),
        cleanupAttempted: true,
        residual: ['native-skill'],
        failures: [expect.objectContaining({ phase: 'cleanup.owned' })],
        actions: expect.arrayContaining([
          expect.objectContaining({ name: 'cleanup.owned', status: 'failed' }),
        ]),
      }));
      expect(failed.targetResults).toEqual(expect.arrayContaining([
        expect.objectContaining({
          target: expect.objectContaining({ pluginName: 'consumer' }),
          state: 'failed',
          errorCode: 'dependencyInstallFailed',
        }),
        expect.objectContaining({
          target: expect.objectContaining({ pluginName: 'independent' }),
          state: 'completed',
        }),
      ]));
      const demoFailure = failed.rebuildResults.find((entry) =>
        entry.target.pluginName === 'demo')!;
      if (failurePoint === 'beforeRename') {
        expect(demoFailure.quarantined).toEqual([]);
        await expect(fs.pathExists(legacySkillRoot)).resolves.toBe(true);
      } else {
        expect(quarantinedPath).toBeDefined();
        expect(demoFailure.quarantined).toEqual([path.basename(quarantinedPath!)]);
        await expect(fs.pathExists(legacySkillRoot)).resolves.toBe(false);
        await expect(fs.pathExists(quarantinedPath!)).resolves.toBe(true);
        await fs.move(quarantinedPath!, legacySkillRoot);
      }

      const recovered = await installFixturePlugin(['team/consumer', 'team/independent'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'project',
      }, runtime);
      expect(recovered.overallState, JSON.stringify(recovered.rebuildResults)).toBe('succeeded');
      await expect(fs.pathExists(legacySkillRoot)).resolves.toBe(false);
    },
    30_000,
  );

  it('preflights native render once and excludes a preApply failure from its marketplace group', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-pre-apply-group-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'native-pre-apply-group-counts');
    await fs.ensureDir(counterRoot);
    const configureDynamicNative = (manifest: PluginMeta['manifest']) => {
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        preApply: { path: './scripts/preApply.mjs' },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-skill',
        platform: 'codex',
        scopes: ['user', 'project'],
        target: 'codex.skill',
        states: ['present'],
        refreshKeys: [],
        skillKey: 'dynamic-skill',
      }] };
    };
    const definitions = ['alpha', 'beta'].map((name) => ({
      name,
      configureManifest: configureDynamicNative,
    }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await Promise.all(definitions.flatMap(({ name }) => [
      writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', name),
        skillKey: 'dynamic-skill',
        counterRoot,
      }),
      fs.outputFile(path.join(sourceRoot, 'plugins', name, 'scripts', 'preApply.mjs'), [
        'import { readFile, writeFile } from "node:fs/promises";',
        `const renderCount = await readFile(${JSON.stringify(path.join(
          counterRoot,
          `render-count-${name}.txt`,
        ))}, "utf8");`,
        'if (renderCount !== "1") throw new Error("native renderer was not preflighted once");',
        `await writeFile(${JSON.stringify(path.join(counterRoot, `pre-apply-${name}.txt`))}, "1");`,
        ...(name === 'alpha' ? ['throw new Error("alpha preApply failed");'] : []),
      ].join('\n')),
    ]));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const codexOperationConsumerResolver = vi.fn(async (
      options: Parameters<NonNullable<
        RebuildCommandRuntime['codexOperationConsumerResolver']
      >>[0],
    ) => {
      return {
        support: 'observed' as const,
        manager: {
          kind: 'system' as const,
          version: '0.200.0',
          command: 'codex',
          argsPrefix: [] as string[],
        },
        requirement: options.operationRequirement,
      };
    });

    const unauthorized = await installFixturePlugin(['team/alpha', 'team/beta'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      codexOperationConsumerResolver,
    });
    expect(unauthorized.overallState).toBe('failed');
    expect(unauthorized.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: 'preApplyAuthorizationRequired' }),
    ]));
    expect(runtime.installed).toEqual(new Set());
    expect(runtime.nativeCliRunner.mock.calls.filter(([invocation]) => invocation.args.includes('plugin')
      && !invocation.args.includes('list'))).toEqual([]);
    await expect(fs.pathExists(path.join(counterRoot, 'render-count-alpha.txt')))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(counterRoot, 'pre-apply-alpha.txt')))
      .resolves.toBe(false);

    codexOperationConsumerResolver.mockClear();
    const result = await installFixturePlugin(['team/alpha', 'team/beta'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      yes: true,
    }, {
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      codexOperationConsumerResolver,
    });

    expect(result.overallState, JSON.stringify(result, null, 2)).toBe('partial');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/alpha' }),
        state: 'failed',
        errorCode: 'preApplyFailed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/beta' }),
        state: 'completed',
      }),
    ]));
    expect(codexOperationConsumerResolver).toHaveBeenCalledTimes(1);
    expect(runtime.installed).toEqual(new Set(['beta@aw']));
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'team/alpha', platforms: ['codex'] }, { pluginId: 'team/beta', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });
    for (const name of ['alpha', 'beta']) {
      await expect(fs.readFile(path.join(counterRoot, `render-count-${name}.txt`), 'utf8'))
        .resolves.toBe('1');
      await expect(fs.readFile(path.join(counterRoot, `pre-apply-${name}.txt`), 'utf8'))
        .resolves.toBe('1');
    }
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await expect(fs.pathExists(path.join(
      marketplaceRoot,
      'plugins',
      'alpha',
      'codex',
      'skills',
      'dynamic-skill',
    ))).resolves.toBe(false);
    await expect(fs.readFile(path.join(
      marketplaceRoot,
      'plugins',
      'beta',
      'codex',
      'skills',
      'dynamic-skill',
      'SKILL.md',
    ), 'utf8')).resolves.toContain('name: dynamic-skill');
  }, 30_000);

  it('keeps an immediate preApply failure with large context isolated from another target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'large-pre-apply-input-source');
    const largeConfigFields = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [
      `value${index}`,
      { type: 'string' as const, default: 'x'.repeat(4_096), validation: { maxLength: 4_096 } },
    ]));
    const definitions = ['immediate-failure', 'independent'].map((name) => ({
      name,
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
        manifest.extensions = {
          instructions: [{ name: 'policy', title: 'Policy', content: `${name} policy.` }],
        };
        manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
        if (name === 'immediate-failure') manifest.config = { schemaVersion: 5, fields: largeConfigFields };
      },
    }));
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const independentMarker = path.join(isolation.env.AW_HOME!, 'independent-pre-apply.txt');
    await Promise.all([
      fs.outputFile(
        path.join(sourceRoot, 'plugins', 'immediate-failure', 'scripts', 'preApply.mjs'),
        'process.exit(7);\n',
      ),
      fs.outputFile(
        path.join(sourceRoot, 'plugins', 'independent', 'scripts', 'preApply.mjs'),
        [
          'let input = "";',
          'for await (const chunk of process.stdin) input += chunk;',
          'const context = JSON.parse(input);',
          `await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(independentMarker)}, context.plugin.name));`,
        ].join('\n'),
      ),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installFixturePlugin([
      'team/immediate-failure',
      'team/independent',
    ], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      yes: true,
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({
        exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '',
      }),
    });

    expect(result.overallState, JSON.stringify(result, null, 2)).toBe('partial');
    expect(result.rebuildResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/immediate-failure' }),
        status: 'failed',
        error: expect.objectContaining({
          phase: 'preApply',
          operationDiagnostic: expect.objectContaining({ code: 'preApplyExited', exitCode: 7 }),
        }),
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/independent' }),
        status: 'succeeded',
      }),
    ]));
    expect(JSON.stringify(result)).not.toContain('preApplyStartFailed');
    await expect(fs.readFile(independentMarker, 'utf8')).resolves.toBe('independent');
  }, 30_000);

  it('stops before preApply and native mutations when native render preflight fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-render-preflight-failure-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'native-render-preflight-failure-counts');
    await fs.ensureDir(counterRoot);
    const definitions = [{
      name: 'demo',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.scripts = {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
          preApply: { path: './scripts/preApply.mjs' },
        };
        manifest.artifacts = { targets: [{
          id: 'dynamic-skill',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.skill',
          states: ['present'],
          refreshKeys: [],
          skillKey: 'dynamic-skill',
        }] };
      },
    }];
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await Promise.all([
      writeDynamicSkillRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'demo'),
        skillKey: 'dynamic-skill',
        counterRoot,
        fail: true,
      }),
      fs.outputFile(
        path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'),
        `await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(
          path.join(counterRoot, 'pre-apply.txt'),
        )}, "1"));\n`,
      ),
    ]);
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const codexOperationConsumerResolver = vi.fn(async (
      consumerOptions: Parameters<NonNullable<RebuildCommandRuntime['codexOperationConsumerResolver']>>[0],
    ) => ({ support: 'observed' as const, manager: await runtime.codexManagerResolver(),
      requirement: consumerOptions.operationRequirement }));

    const result = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      yes: true,
    }, {
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      codexOperationConsumerResolver,
    });

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/demo' }),
        state: 'failed',
      }),
    ]);
    await expect(fs.readFile(path.join(counterRoot, 'render-count-demo.txt'), 'utf8'))
      .resolves.toBe('1');
    await expect(fs.pathExists(path.join(counterRoot, 'pre-apply.txt'))).resolves.toBe(false);
    expect(runtime.nativeCliRunner.mock.calls.filter(([invocation]) => invocation.args.includes('plugin')
      && !invocation.args.includes('list'))).toEqual([]);
    expect(runtime.installed).toEqual(new Set());
  }, 30_000);

  it('uses only one neutral Codex list per generation for public user-only writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'user-observation-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const listCalls = (calls: readonly [NativeCliInvocation, ...unknown[]][]) => calls.filter(
      ([invocation]) => {
        const pluginIndex = invocation.args.indexOf('plugin');
        const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
        return args.join(' ') === 'plugin list --marketplace aw --json';
      },
    );
    const assertUserOnlyGenerations = (
      calls: readonly [NativeCliInvocation, ...unknown[]][],
      maximumLists: number,
    ) => {
      const lists = listCalls(calls);
      expect(lists.length, JSON.stringify(calls.map(([invocation]) => ({
        args: invocation.args,
        cwd: invocation.cwd,
      })))).toBeLessThanOrEqual(maximumLists);
      expect(lists.every(([invocation]) =>
        path.resolve(invocation.cwd ?? '.') !== path.resolve(isolation.layout.fixtureCwd))).toBe(true);
      let generationLists = 0;
      for (const [invocation] of calls) {
        const pluginIndex = invocation.args.indexOf('plugin');
        const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
        const generationBoundary = invocation.args.includes('--version')
          || args[1] === 'add' || args[1] === 'remove'
          || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
        if (generationBoundary) {
          expect(generationLists).toBeLessThanOrEqual(1);
          generationLists = 0;
        } else if (args.join(' ') === 'plugin list --marketplace aw --json') {
          generationLists += 1;
        }
      }
      expect(generationLists).toBeLessThanOrEqual(1);
    };

    const success = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(success.overallState, JSON.stringify(success)).toBe('succeeded');
    assertUserOnlyGenerations(runtime.nativeCliRunner.mock.calls, 2);

    runtime.nativeCliRunner.mockClear();
    const noOp = await syncFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(noOp.overallState, JSON.stringify(noOp)).toBe('succeeded');
    assertUserOnlyGenerations(runtime.nativeCliRunner.mock.calls, 2);

    const uncertainRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const result = await runtime.nativeCliRunner(invocation);
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add' && args[2] === 'demo@aw'
        ? { ...result, exitCode: 1, stderr: 'synthetic uncertain add' }
        : result;
    });
    const uncertain = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, nativeCliRunner: uncertainRunner });
    expect(uncertain.overallState, JSON.stringify({
      uncertain,
      calls: uncertainRunner.mock.calls.map(([invocation]) => invocation.args),
    })).not.toBe('succeeded');
    assertUserOnlyGenerations(uncertainRunner.mock.calls, 2);
  }, 30_000);

  it('keeps an earlier native success and the shared marketplace after a later group target fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-group-partial-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf-a' },
      { name: 'leaf-b' },
      { name: 'root', dependencies: ['leaf-a', 'leaf-b'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    let failLeafB = true;
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      if (failLeafB && args[1] === 'add' && args[2] === 'leaf-b@aw') {
        return { exitCode: 1, stdout: '', stderr: 'leaf-b failed' };
      }
      return runtime.nativeCliRunner(invocation);
    });

    const partial = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, nativeCliRunner });

    expect(partial.overallState).toBe('partial');
    expect(partial.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf-a' }),
        state: 'completed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf-b' }),
        state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        state: 'failed',
        action: 'skipped',
      }),
    ]));
    expect(runtime.installed).toContain('leaf-a@aw');
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await expect(fs.readJson(path.join(marketplaceRoot, 'config.json'))).resolves.toMatchObject({
      sourceId: 'team',
      marketplaceName: 'aw',
    });
    await expect(fs.readFile(path.join(
      marketplaceRoot,
      'plugins',
      'leaf-b',
      'skills',
      'leaf-b-skill',
      'SKILL.md',
    ), 'utf8')).resolves.toContain('name: leaf-b-skill');

    failLeafB = false;
    await expect(syncFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, nativeCliRunner })).resolves.toMatchObject({ overallState: 'succeeded' });
    expect(runtime.installed).toEqual(new Set(['leaf-a@aw', 'leaf-b@aw', 'root@aw']));
  }, 30_000);

  it('does not start native mutations when grouped marketplace staging fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-group-stage-failure-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const realCopy = fs.copy.bind(fs);
    const copy = vi.spyOn(fs, 'copy').mockImplementation(async (source, destination, options) => {
      if (path.basename(path.dirname(String(destination))).startsWith('.team-staging-')
        && path.basename(String(destination)) === 'plugins') {
        throw new Error('group staging failed');
      }
      return realCopy(source, destination, options);
    });
    let result: Awaited<ReturnType<typeof installWriteCommand>>;
    try {
      result = await installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'project',
      }, runtime);
    } finally {
      copy.mockRestore();
    }

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf' }),
        state: 'failed',
        message: expect.stringContaining('group staging failed'),
      }),
    ]));
    const nativeMutations = runtime.nativeCliRunner.mock.calls.filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add'
        || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    });
    expect(nativeMutations).toEqual([]);
    expect(runtime.installed).toEqual(new Set());
  }, 30_000);

  it('blocks a reused project activation when its marketplace group fails staging', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-group-reuse-failure-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'a' },
      { name: 'b' },
      { name: 'root', dependencies: ['a', 'b'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/a'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const callsBeforeProjectInstall = runtime.nativeCliRunner.mock.calls.length;
    const realCopy = fs.copy.bind(fs);
    const copy = vi.spyOn(fs, 'copy').mockImplementation(async (source, destination, options) => {
      if (path.basename(path.dirname(String(destination))).startsWith('.team-staging-')
        && path.basename(String(destination)) === 'plugins') {
        throw new Error('reuse group staging failed');
      }
      return realCopy(source, destination, options);
    });
    let result: Awaited<ReturnType<typeof installWriteCommand>>;
    try {
      result = await installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'project',
        dependencyScopeOverrides: [{
          pluginId: 'team/a', platform: 'codex', scope: 'project',
        }],
      }, runtime);
    } finally {
      copy.mockRestore();
    }

    expect(result.codexReconcilePlans?.[0]?.sharedNativeActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/a', action: 'reuse' }),
    ]));
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/a' }),
        state: 'failed',
        message: expect.stringContaining('reuse group staging failed'),
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/b' }),
        state: 'failed',
      }),
    ]));
    const projectConfig = await readCodexConfigFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
    );
    expect(projectConfig.snapshot.plugins['a@aw']).toBeUndefined();
    const projectMutations = runtime.nativeCliRunner.mock.calls
      .slice(callsBeforeProjectInstall)
      .filter(([invocation]) => {
        const pluginIndex = invocation.args.indexOf('plugin');
        const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
        return args[1] === 'add'
          || args[1] === 'remove'
          || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
      });
    expect(projectMutations).toEqual([]);
  }, 30_000);

  it('attributes a shared activation post snapshot failure only to the missing plugin', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-post-attribution-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'a' }, { name: 'b' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/a', 'team/b'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const response = await runtime.nativeCliRunner(invocation);
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      if (args[1] !== 'list' || !args.includes('--json')) return response;
      const projectConfig = await readCodexConfigFile(
        path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      );
      if (projectConfig.snapshot.plugins['b@aw']?.enabled !== true) return response;
      const payload = JSON.parse(response.stdout) as { installed: Array<{ pluginId: string }> };
      return {
        ...response,
        stdout: JSON.stringify({
          ...payload,
          installed: payload.installed.filter((entry) => entry.pluginId !== 'b@aw'),
        }),
      };
    });

    const result = await installFixturePlugin(['team/a', 'team/b'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, nativeCliRunner });

    expect(result.overallState).toBe('partial');
    expect(result.codexReconcilePlans?.[0]?.sharedNativeActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/a', action: 'reuse' }),
      expect.objectContaining({ pluginId: 'team/b', action: 'reuse' }),
    ]));
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/a' }),
        state: 'completed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/b' }),
        state: 'failed',
        errorCode: 'codexActivationPostcheckFailed',
      }),
    ]));
  }, 30_000);

  it('keeps the executed consumer action when its dependency fails the grouped postcheck', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'late-dependency-postcheck-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const response = await runtime.nativeCliRunner(invocation);
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      if (args[1] !== 'list' || !args.includes('--json') || !runtime.installed.has('root@aw')) {
        return response;
      }
      const payload = JSON.parse(response.stdout) as { installed: Array<{ pluginId: string }> };
      return {
        ...response,
        stdout: JSON.stringify({
          ...payload,
          installed: payload.installed.filter((entry) => entry.pluginId !== 'leaf@aw'),
        }),
      };
    });

    const result = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, nativeCliRunner });

    expect(result.overallState).toBe('partial');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf' }),
        state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        action: 'install',
        state: 'failed',
        errorCode: 'dependencyInstallFailed',
        recoveryActions: expect.arrayContaining([
          'run aw plugin sync team/root --target codex --context project',
        ]),
      }),
    ]));
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('install', result);
    expect(receipt.overallState).toBe('partial');
    expect(receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        action: 'install',
        state: 'failed',
        errorCode: 'dependencyInstallFailed',
        recoveryActions: expect.arrayContaining([
          'run aw plugin sync team/root --target codex --context project',
        ]),
      }),
    ]));
    for (const target of receipt.targetResults.filter((entry) =>
      entry.target.pluginId === 'team/leaf' || entry.target.pluginId === 'team/root')) {
      expect(target.actions.map((action) => action.name)).not.toContain('postApply');
    }
    const recoveryAction = receipt.targetResults.find((entry) => entry.target.pluginId === 'team/root')!
      .recoveryActions.find((action) => action.startsWith('run aw plugin sync '))!;
    const captured = createCapturedCliIo();
    expect(await runCli([...recoveryAction.slice('run aw '.length).split(' '), '--json'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, io: captured.io, interactive: false,
      nativeCliRunner: runtime.nativeCliRunner, codexManagerResolver: runtime.codexManagerResolver,
    }), captured.readStdout()).toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      kind: 'aw-recovery', command: 'sync', scope: 'project', ok: true,
      requestedRoots: ['team/root'], selection: { agents: ['codex'] },
    });
  }, 30_000);

  it('preserves project output and one-shot placement when the user scope installs separately', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'protected-project-placement');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'leaf' }, { name: 'root', dependencies: ['leaf'] }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = { env: isolation.env, nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }) };
    const installed = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      dependencyScopeOverrides: [{ pluginId: 'team/leaf', platform: 'codex', scope: 'user' }],
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed)).toBe('succeeded');
    const requirements = await readFixtureRequirements({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const config = await fs.readFile(configPath);
    const user = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(user.overallState, JSON.stringify(user)).toBe('succeeded');
    await expect(fs.pathExists(path.join(isolation.env.CODEX_HOME!, 'config.toml')))
      .resolves.toBe(true);
    expect(await readFixtureRequirements({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env })).toEqual(requirements);
    expect(await fs.readFile(configPath)).toEqual(config);
    expect(requirements.dependencyScopeOverrides).toEqual([]);
  });

  it('repairs missing project output through public sync without changing desired roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'public-sync-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const intentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    const intentBefore = await readFixtureRequirements(intentLocation);
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await fs.remove(configPath);

    await expect(syncFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      interactive: false,
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    await expect(readFixtureRequirements(intentLocation)).resolves.toEqual(intentBefore);
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('demo.');

    await fs.remove(configPath);
    const publicOutput = createCapturedCliIo();
    await expect(runCli([
      'plugin', 'sync', '--target', 'codex', '--context', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: publicOutput.io,
      interactive: false,
    })).resolves.toBe(0);
    expect(JSON.parse(publicOutput.readStdout())).toMatchObject({
      command: 'sync',
      ok: true,
      kind: 'aw-recovery',
    });
    await expect(readFixtureRequirements(intentLocation)).resolves.toEqual(intentBefore);
    await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('demo.');
  });

  it('restores a fresh clone from committed project intent through public sync --all', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.rootDir, 'clone-recovery-source');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.skills = './skills';
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    const nativeSkill = path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-native');
    await Promise.all([
      fs.outputFile(
        path.join(nativeSkill, 'SKILL.md'),
        '---\nname: demo-native\ndescription: Demo native Skill.\n---\n',
      ),
      fs.outputFile(
        path.join(nativeSkill, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);

    const seedRoot = path.join(isolation.layout.fixtureCwd, 'clone-recovery-seed');
    const cloneRoot = path.join(isolation.layout.fixtureCwd, 'clone-recovery-checkout');
    await fs.ensureDir(seedRoot);
    await git(seedRoot, ['init']);
    await git(seedRoot, ['config', 'user.name', 'AW Test']);
    await git(seedRoot, ['config', 'user.email', 'aw-test@example.invalid']);
    const intent = {
      schemaVersion: 1 as const,
      kind: 'aw-plugin-intents' as const,
      roots: [{ pluginId: 'team/demo', platforms: ['codex' as const] }],
      dependencyScopeOverrides: [],
      managed: { codexPluginIds: ['demo@aw'] },
    };
    await writeIntentFixture({
      scope: 'project', cwd: seedRoot, env: isolation.env,
    }, intent);
    await git(seedRoot, ['add', '.agent-workflows/plugin-intents.json']);
    await git(seedRoot, ['commit', '-m', 'Add shared project intent']);
    await git(isolation.layout.fixtureCwd, ['-c', 'core.autocrlf=false', 'clone', seedRoot, cloneRoot]);
    expect(await git(cloneRoot, ['ls-files'])).toBe('.agent-workflows/plugin-intents.json');

    const cloneEnv = {
      ...isolation.env,
      AW_HOME: path.join(isolation.layout.fixtureCwd, 'clone-recovery-aw-home'),
      CODEX_HOME: path.join(isolation.layout.fixtureCwd, 'clone-recovery-codex-home'),
      CLAUDE_CONFIG_DIR: path.join(isolation.layout.fixtureCwd, 'clone-recovery-claude-home'),
    };
    for (const home of [cloneEnv.AW_HOME, cloneEnv.CODEX_HOME, cloneEnv.CLAUDE_CONFIG_DIR]) {
      await expect(fs.pathExists(home)).resolves.toBe(false);
    }
    const sourceConfig = await readCatalogSourcesConfigSnapshot(cloneEnv);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceConfig.digest,
      env: cloneEnv,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: cloneEnv,
    });
    const intentPath = path.join(cloneRoot, '.agent-workflows', 'plugin-intents.json');
    const intentBefore = await fs.readFile(intentPath);
    const runtime = await createCodexNativeTestRuntime({
      env: cloneEnv,
      layout: { fixtureCwd: cloneRoot },
    }, '0.151.0');

    const result = await syncFixturePlugin([], {
      cwd: cloneRoot,
      env: cloneEnv,
      platform: 'codex',
      scope: 'project',
      all: true,
      interactive: false,
      yes: true,
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(runtime.installed.has('demo@aw')).toBe(true);
    await expect(fs.readFile(path.join(
      cloneEnv.CODEX_HOME,
      'plugins', 'cache', 'aw', 'demo', '1.0.0', 'skills', 'demo-native', 'SKILL.md',
    ), 'utf8')).resolves.toContain('name: demo-native');
    const projectConfigPath = path.join(cloneRoot, '.codex', 'config.toml');
    const projectConfig = await readCodexConfigFile(projectConfigPath);
    expect(projectConfig.snapshot.plugins['demo@aw']?.enabled).toBe(true);
    expect(Object.keys(projectConfig.snapshot.developerInstructions.managedBlocks)).toHaveLength(1);
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    await expect(fs.pathExists(path.join(cloneRoot, '.agents', 'skills'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(cloneRoot, '.codex', 'hooks.json'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(cloneRoot, '.codex', 'apps'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(cloneRoot, '.codex-plugin'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(cloneRoot, '.mcp.json'))).resolves.toBe(false);
    await expect(fs.readFile(projectConfigPath, 'utf8')).resolves.not.toContain('mcp_servers');
  }, 30_000);

  it('previews an isolated schema 2 self-hosting project Intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const fixtureIntentPath = path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-intents.json',
    );
    const fixtureIntentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await writeIntentFixture(fixtureIntentLocation, {
      schemaVersion: 2,
      kind: 'aw-plugin-intents',
      roots: [
        { pluginId: 'official/aw-plugin-development', platforms: ['codex'] },
        { pluginId: 'official/aw-skill-eval-runner', platforms: ['codex'] },
      ],
      dependencyScopeOverrides: [],
    });
    const intentBytes = await fs.readFile(fixtureIntentPath);
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'self-hosting-intent-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'aw-plugin-development' },
      { name: 'aw-skill-eval-runner' },
    ]);
    const sourceSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'official', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceSnapshot.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'official',
      cliVersion: '1.0.0',
      env: isolation.env,
      impactConfirmed: true,
    });

    const status = await statusCommandV8({
      plugins: ['official/aw-plugin-development'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'codex',
      scope: 'project',
      json: true,
    });
    const target = status.payload.targets.find((entry) =>
      entry.pluginId === 'official/aw-plugin-development' && entry.platform === 'codex');
    expect(target).toBeDefined();
    expect(statusTargetIntent(target!.placements[0]!)).toEqual({
      enabled: true,
      scopes: ['project'],
      relation: 'root',
    });

    const preview = await syncFixturePlugin([], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      all: true,
      interactive: false,
    }, {
      env: isolation.env,
      previewOperationPlan: true,
    });

    expect(preview.overallState, JSON.stringify(preview)).toBe('succeeded');
    expect(preview.operationPlan).toBeDefined();
    await expect(fs.readFile(fixtureIntentPath)).resolves.toEqual(intentBytes);
    await expect(fs.pathExists(path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'config.toml',
    ))).resolves.toBe(false);
  });

  it('keeps project native activation when user uninstall disables its overlapping root', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-activation-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const projectInstalled = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/leaf', platform: 'codex', scope: 'project',
      }],
    }, runtime);
    expect(projectInstalled.overallState, JSON.stringify(projectInstalled.rebuildResults))
      .toBe('succeeded');
    const userInstalled = await installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(userInstalled.overallState, JSON.stringify(userInstalled.rebuildResults))
      .toBe('succeeded');
    expect((await readCodexConfigFile(path.join(
      isolation.layout.fixtureCwd, '.codex', 'config.toml',
    ))).snapshot.plugins['leaf@aw']?.enabled, JSON.stringify(userInstalled.codexReconcilePlans)).toBe(true);

    const stalePostcheckRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.args.includes('list') && invocation.args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [...runtime.installed].map((pluginId) => ({
              pluginId, installed: true, enabled: true, version: '1.0.0',
            })),
            available: [],
          }),
          stderr: '',
        };
      }
      return runtime.nativeCliRunner(invocation);
    });
    const failedUninstall = await uninstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, nativeCliRunner: stalePostcheckRunner });
    expect(failedUninstall.overallState).toBe('failed');
    await applyCodexConfigTransactionFile(
      path.join(isolation.env.CODEX_HOME!, 'config.toml'),
      { upsertPluginActivations: { 'leaf@aw': true } },
    );
    const uninstalled = await syncFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'project',
      interactive: false,
    }, runtime);
    expect(uninstalled.overallState, JSON.stringify(uninstalled.rebuildResults)).toBe('succeeded');
    expect(uninstalled.codexReconcilePlans?.[0]).toMatchObject({
      activationActions: {
        user: expect.arrayContaining([
          expect.objectContaining({ codexPluginId: 'leaf@aw', action: 'none' }),
        ]),
        project: expect.arrayContaining([
          expect.objectContaining({ codexPluginId: 'leaf@aw', action: 'none' }),
        ]),
      },
      staleActivationRemovals: [],
    });
    const [userConfig, projectConfig] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userConfig.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    expect(projectConfig.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    expect(runtime.installed.has('leaf@aw')).toBe(true);

    const removedProject = await uninstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);
    expect(removedProject.overallState, JSON.stringify(removedProject.rebuildResults)).toBe('succeeded');
    expect(removedProject.rebuildResults.map((result) => result.target.pluginName))
      .toEqual(['root']);
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [expect.objectContaining({ pluginId: 'team/root' })] });
    const [userAfter, projectAfter] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userAfter.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    expect(projectAfter.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    expect(runtime.installed.has('leaf@aw')).toBe(true);

    const movedToUser = await installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(movedToUser.overallState, JSON.stringify(movedToUser.rebuildResults)).toBe('succeeded');
    const movedToProject = await installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);
    expect(movedToProject.overallState, JSON.stringify(movedToProject.rebuildResults)).toBe('succeeded');
    expect(movedToProject.dependencyPlan?.targets).toEqual([
      expect.objectContaining({
        pluginId: 'team/leaf', action: 'reinstall', state: 'partial', resolvedScope: 'project',
      }),
    ]);
    const [userMovedProject, projectMovedProject] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userMovedProject.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    expect(projectMovedProject.snapshot.plugins['leaf@aw']?.enabled).toBe(true);

    const movedBackToUser = await installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(movedBackToUser.overallState, JSON.stringify(movedBackToUser.rebuildResults)).toBe('succeeded');
    expect(movedBackToUser.dependencyPlan?.targets).toEqual([
      expect.objectContaining({ pluginId: 'team/leaf', resolvedScope: 'user' }),
    ]);
    const [userMovedBack, projectMovedBack] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userMovedBack.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    expect(projectMovedBack.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    expect(runtime.installed.has('leaf@aw')).toBe(true);
  });

  it('blocks install and status when both Codex registration lists are unreadable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unreadable-registration-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const pluginArgs = pluginIndex >= 0
        ? invocation.args.slice(pluginIndex)
        : invocation.args;
      if (pluginArgs.join(' ') === 'plugin list --marketplace aw --json') {
        return { exitCode: 0, stdout: '{invalid', stderr: '' };
      }
      return runtime.nativeCliRunner(invocation);
    });

    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, nativeCliRunner });

    expect(installed.overallState).toBe('failed');
    expect(installed.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'codexSharedNativeCorrupt' }),
    ]);
    const mutationCalls = nativeCliRunner.mock.calls.filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add' || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    });
    expect(mutationCalls).toEqual([]);

    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'unreadable-registration-prefix'),
      runtime.codexVersion,
    );
    setNativeCliRunnerOverrideForTests(nativeCliRunner);
    let status;
    try {
      status = await statusCommandV8({
        plugins: ['team/demo'],
        cwd: isolation.layout.fixtureCwd,
        env: { ...isolation.env, PATH: binRoot },
        cliVersion: '1.0.0',
        platform: 'codex',
        scope: 'user',
        json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }
    expect(status.payload.targets).toEqual([
      expect.objectContaining({ state: 'blocked' }),
    ]);
    expect(statusTargetSharedNative(status.payload.targets[0]!)).toMatchObject({
      state: 'blocked', reason: 'unreadable', diagnostic: 'pluginListUnavailable',
    });
  }, 30_000);

  it.each([
    ['reuse', 'ENOENT', 'codexNativeObservationUnavailable'],
    ['reuse', 'absent', 'codexNativeExpectedInstalled'],
    ['none', 'invalid output', 'codexNativeObservationFailed'],
  ] as const)(
    'blocks a mixed Codex %s extension write when the late observation has %s',
    async (sharedAction, failure, errorCode) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `late-${sharedAction}-observation-source`,
      );
      await createNativeDependencyCatalog(sourceRoot, [{
        name: 'demo',
        configureManifest: (manifest) => {
          manifest.extensions = {
            instructions: [{
              name: 'late-gate', title: 'Late gate', content: 'Late observation gate.',
            }],
          };
        },
      }]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      await expect(installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: sharedAction === 'reuse' ? 'project' : 'user',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const targetConfigPath = sharedAction === 'none'
        ? path.join(isolation.env.CODEX_HOME!, 'config.toml')
        : path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      if (sharedAction === 'reuse') await fs.remove(targetConfigPath);
      const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
      const installedPluginId = [...runtime.installed][0]!;
      const marketplaceName = installedPluginId.slice(installedPluginId.lastIndexOf('@') + 1);
      const nativePayloadRoot = path.join(
        isolation.env.CODEX_HOME!, 'plugins', 'cache', marketplaceName, 'demo', '1.0.0',
      );
      const [marketplaceBefore, nativePayloadBefore] = await Promise.all([
        snapshotRegularTree(marketplaceRoot),
        snapshotRegularTree(nativePayloadRoot),
      ]);
      const targetConfigBefore = await fs.readFile(targetConfigPath, 'utf8').catch(() => undefined);
      let rejectObservation = false;
      let callsAtTargetBuild = 0;
      const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
        const pluginIndex = invocation.args.indexOf('plugin');
        const pluginArgs = pluginIndex >= 0
          ? invocation.args.slice(pluginIndex)
          : invocation.args;
        if (rejectObservation && pluginArgs.join(' ') === 'plugin list --marketplace aw --json') {
          if (failure === 'ENOENT') {
            throw Object.assign(new Error('Codex unavailable'), { code: 'ENOENT' });
          }
          if (failure === 'absent') {
            return { exitCode: 0, stdout: JSON.stringify({ installed: [], available: [] }), stderr: '' };
          }
          return { exitCode: 0, stdout: '{invalid', stderr: '' };
        }
        return runtime.nativeCliRunner(invocation);
      });
      const observationSession = await createCodexNativeObservationSession({
        exactCwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        runner: nativeCliRunner,
      });
      setRebuildCommandTestHooksForTests({
        afterTargetBuilt: async ({ identity }) => {
          if (identity.pluginId !== 'team/demo') return;
          callsAtTargetBuild = nativeCliRunner.mock.calls.length;
          rejectObservation = true;
          observationSession.invalidate('aw');
        },
      });
      let result: Awaited<ReturnType<typeof syncWriteCommand>>;
      try {
        result = sharedAction === 'reuse'
          ? await installFixturePlugin(['team/demo'], {
            cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
            }, { ...runtime, nativeCliRunner, codexObservationSession: observationSession })
          : await uninstallWriteCommand(['team/demo'], {
              cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
            }, { ...runtime, nativeCliRunner, codexObservationSession: observationSession });
      } finally {
        setRebuildCommandTestHooksForTests(undefined);
        await observationSession.dispose();
      }

      expect(result.codexReconcilePlans?.[0]?.sharedNativeActions).toContainEqual(
        expect.objectContaining({ action: sharedAction }),
      );
      expect(result.targetResults, JSON.stringify(result.targetResults)).toContainEqual(expect.objectContaining({
        state: 'failed', errorCode,
      }));
      expect(await fs.readFile(targetConfigPath, 'utf8').catch(() => undefined))
        .toBe(targetConfigBefore);
      await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
      await expect(snapshotRegularTree(nativePayloadRoot)).resolves.toEqual(nativePayloadBefore);
      expect(runtime.installed).toEqual(new Set([installedPluginId]));
      if (failure === 'absent') {
        await expect(readFixtureRequirements({
          scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        })).resolves.toMatchObject({
          roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
        });
      }
      const mutationCalls = nativeCliRunner.mock.calls.slice(callsAtTargetBuild)
        .filter(([invocation]) => {
          const pluginIndex = invocation.args.indexOf('plugin');
          const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
          return args[1] === 'add' || args[1] === 'remove'
            || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
        });
      expect(mutationCalls).toEqual([]);
    },
    30_000,
  );

  it('reports a late activation observation failure after the mutation and preserves shared native', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-only-late-gate-source');
    const definitions = [{
      name: 'demo',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
      },
    }];
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'), [
      'import { readFile, writeFile } from "node:fs/promises";',
      'const counter = `${process.env.AW_HOME}/activation-late-pre-apply-count.txt`;',
      'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
      'await writeFile(counter, String(previous + 1));',
    ].join('\n'));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', yes: true,
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const preApplyCounter = path.join(
      isolation.env.AW_HOME!,
      'activation-late-pre-apply-count.txt',
    );
    await expect(fs.readFile(preApplyCounter, 'utf8')).resolves.toBe('1');
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const installedPluginId = [...runtime.installed][0]!;
    const marketplaceName = installedPluginId.slice(installedPluginId.lastIndexOf('@') + 1);
    const nativePayloadRoot = path.join(
      isolation.env.CODEX_HOME!, 'plugins', 'cache', marketplaceName, 'demo', '1.0.0',
    );
    const userConfigPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const [marketplaceBefore, payloadBefore, userConfigBefore, projectConfigBefore] = await Promise.all([
      snapshotRegularTree(marketplaceRoot),
      snapshotRegularTree(nativePayloadRoot),
      fs.readFile(userConfigPath, 'utf8'),
      fs.readFile(projectConfigPath, 'utf8').catch(() => undefined),
    ]);
    let rejectObservation = false;
    const preApplyEvents: string[] = [];
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const pluginArgs = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      if (rejectObservation && pluginArgs.join(' ') === 'plugin list --marketplace aw --json') {
        throw Object.assign(new Error('private native failure'), { code: 'ENOENT' });
      }
      return runtime.nativeCliRunner(invocation);
    });
    setRebuildCommandTestHooksForTests({
      afterTargetBuilt: async ({ identity }) => {
        if (identity.pluginId === 'team/demo' && identity.scope === 'project') {
          rejectObservation = true;
        }
      },
    });
    let result: Awaited<ReturnType<typeof installWriteCommand>>;
    try {
      result = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', yes: true,
      }, {
        ...runtime,
        nativeCliRunner,
        reporter: {
          event: (event) => {
            if (event.type === 'rebuild:action' && event.data?.name === 'preApply') {
              preApplyEvents.push(event.data.phase);
            }
          },
          notice: () => {},
        },
      });
    } finally {
      setRebuildCommandTestHooksForTests(undefined);
    }

    expect(result.targetResults).toContainEqual(expect.objectContaining({
      state: 'failed', errorCode: 'codexActivationPostcheckFailed',
    }));
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
    });
    await expect(fs.readFile(userConfigPath, 'utf8')).resolves.toBe(userConfigBefore);
    expect(projectConfigBefore).toBeUndefined();
    await expect(fs.readFile(projectConfigPath, 'utf8'))
      .resolves.toContain('enabled = true');
    await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
    await expect(snapshotRegularTree(nativePayloadRoot)).resolves.toEqual(payloadBefore);
    expect(runtime.installed).toEqual(new Set([installedPluginId]));
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('install', result);
    expect(receipt).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({
        state: 'failed', errorCode: 'codexActivationPostcheckFailed',
        recoveryActions: expect.arrayContaining(['run aw plugin sync team/demo --target codex --context project']),
      })],
    });
    expect(receipt.targetResults[0]?.actions.map((action) => action.name))
      .toContain('preApply');
    await expect(fs.readFile(preApplyCounter, 'utf8')).resolves.toBe('2');
    expect(preApplyEvents).toEqual(['start', 'success']);
  }, 30_000);

  it('allows an observed mixed Codex reuse target to write its project extension', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'observed-reuse-extension-source');
    await createNativeDependencyCatalog(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'late-gate', title: 'Late gate', content: 'Observed reuse.' }],
        };
      },
    }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const result = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.codexReconcilePlans?.[0]?.sharedNativeActions).toContainEqual(
      expect.objectContaining({ action: 'reuse' }),
    );
    await expect(fs.readFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      'utf8',
    )).resolves.toContain('Observed reuse.');
  }, 30_000);

  it.each(['aw-only', 'mixed'] as const)(
    'blocks a Project %s Codex root that overlaps an observed User extension',
    async (kind) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `cross-scope-${kind}-extension-source`);
      const definition = {
        name: 'demo',
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.extensions = { agents: [{ name: 'shared-role', description: 'Shared.',
            prompt: 'Keep User role.' }] };
        },
      };
      if (kind === 'mixed') await createNativeDependencyCatalog(sourceRoot, [definition]);
      else await createDependencyCatalogSnapshotFixture(sourceRoot, [definition]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [
          { id: 'team', type: 'path', primary: true, path: sourceRoot },
        ] }, expectedDigest: snapshot.digest, env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const user = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
      }, runtime);
      expect(user.overallState, JSON.stringify(user.targetResults)).toBe('succeeded');
      const userRolePath = path.join(isolation.env.CODEX_HOME!, 'agents', 'aw-demo-shared-role.toml');
      const userRoleBefore = await fs.readFile(userRolePath);
      const userConfigPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
      const userConfigBefore = await fs.readFile(userConfigPath).catch(() => undefined);
      const projectRolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents',
        'aw-demo-shared-role.toml');
      const projectInstalled = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime);
      expect(projectInstalled.overallState, JSON.stringify(projectInstalled.targetResults)).toBe('failed');
      expect(projectInstalled.targetResults).toEqual(expect.arrayContaining([
        expect.objectContaining({ errorCode: 'codexExtensionScopeConflict' }),
      ]));
      const projectSynced = await syncFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
        platform: 'codex', scope: 'project', interactive: false,
      }, runtime);
      expect(projectSynced.overallState, JSON.stringify(projectSynced.targetResults)).toBe('failed');
      expect(projectSynced.targetResults).toEqual(expect.arrayContaining([
        expect.objectContaining({ errorCode: 'codexExtensionScopeConflict' }),
      ]));
      await expect(fs.readFile(userRolePath)).resolves.toEqual(userRoleBefore);
      await expect(fs.readFile(userConfigPath).catch(() => undefined))
        .resolves.toEqual(userConfigBefore);
      await expect(fs.pathExists(projectRolePath)).resolves.toBe(false);
    },
  );

  it.each([
    ['absent', 'partial', 'codexNativeInstallIncomplete'],
    ['duplicate', 'partial', 'codexNativeObservationFailed'],
    ['installed-disabled', 'succeeded', undefined],
    ['exact-installed-neutral-absent', 'partial', 'codexNativeInstallIncomplete'],
  ] as const)('handles Codex install when the official postcheck is %s', async (
    postcheck,
    expectedState,
    error,
  ) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'absent-postcheck-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    let addObserved = false;
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const pluginArgs = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      const result = await runtime.nativeCliRunner(invocation);
      if (pluginArgs[1] === 'add') addObserved = true;
      if (addObserved && pluginArgs.join(' ') === 'plugin list --marketplace aw --json') {
        const entry = {
          pluginId: 'demo@aw', installed: true, enabled: true, version: '1.0.0',
        };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: postcheck === 'exact-installed-neutral-absent'
              ? invocation.cwd === isolation.layout.fixtureCwd ? [entry] : []
              : postcheck === 'duplicate' ? [entry, entry]
                : postcheck === 'installed-disabled' ? [{ ...entry, enabled: false }] : [],
            available: [],
          }),
          stderr: '',
        };
      }
      return result;
    });

    const result = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, { ...runtime, nativeCliRunner });

    expect(result.overallState).toBe(expectedState);
    if (error) {
      expect(result.targetResults).toEqual([
        expect.objectContaining({
          state: 'failed',
          message: expect.stringContaining(error),
        }),
      ]);
    }
    if (postcheck === 'installed-disabled') {
      expect(result.rebuildResults.flatMap((entry) => entry.actions))
        .not.toContainEqual(expect.objectContaining({ name: 'preApply' }));
    }
    expect(addObserved).toBe(true);
  }, 30_000);

  it.each([
    ['unobserved', 'partial', 'reinstall'],
    ['failed', 'error', 'block'],
  ] as const)(
    'keeps a %s Codex dependency observation distinct in planner readiness',
    async (observation, state, action) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `dependency-${observation}-source`);
      await createNativeDependencyCatalog(sourceRoot, [
        { name: 'leaf' },
        { name: 'root', dependencies: ['leaf'] },
      ]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
        const pluginIndex = invocation.args.indexOf('plugin');
        const pluginArgs = pluginIndex >= 0
          ? invocation.args.slice(pluginIndex)
          : invocation.args;
        if (pluginArgs.join(' ') === 'plugin list --marketplace aw --json') {
          if (observation === 'unobserved') {
            throw Object.assign(new Error('Codex unavailable'), { code: 'ENOENT' });
          }
          return { exitCode: 1, stdout: '', stderr: 'list failed' };
        }
        return runtime.nativeCliRunner(invocation);
      });

      const result = await installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, { ...runtime, nativeCliRunner, previewOperationPlan: true });
      const dependency = result.dependencyPlan?.targets.find((target) =>
        target.pluginId === 'team/leaf');

      if (observation === 'failed') {
        expect(result).toMatchObject({
          overallState: 'failed',
          targetResults: [expect.objectContaining({
            state: 'failed',
            errorCode: 'codexSharedNativeCorrupt',
          })],
        });
        expect(dependency).toBeUndefined();
      } else {
        expect(dependency).toMatchObject({ relation: 'dependency', state, action });
      }
      expect(nativeCliRunner.mock.calls.every(([invocation]) =>
        invocation.args.includes('--version')
        || invocation.args.join(' ') === 'plugin list --marketplace aw --json')).toBe(true);
    },
  );

  it('ignores private Codex payload drift during status and sync', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-payload-drift-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const payloadReadme = path.join(
      isolation.env.CODEX_HOME!,
      'plugins', 'cache', 'aw', 'demo', '1.0.0', 'README.md',
    );
    const reviewed = await syncFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      interactive: false,
    }, { ...runtime, previewOperationPlan: true });
    const nativeCallsBeforeStaleCheck = runtime.nativeCliRunner.mock.calls.length;
    const stale = await syncFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      interactive: false,
    }, {
      ...runtime,
      expectedPlanFingerprint: reviewed.operationPlan!.planFingerprint,
      reviewPreflight: async () => fs.outputFile(payloadReadme, 'tampered payload\n'),
    });
    expect(stale.targetResults).toEqual([
      expect.objectContaining({ state: 'completed' }),
    ]);
    const staleInspectionCalls = runtime.nativeCliRunner.mock.calls.slice(nativeCallsBeforeStaleCheck);
    expect(staleInspectionCalls).not.toEqual([]);
    expect(staleInspectionCalls.some(([invocation]) =>
      invocation.args.slice(invocation.args.indexOf('plugin')).join(' ')
        === 'plugin list --marketplace aw --json')).toBe(true);
    expect(staleInspectionCalls.some(([invocation]) => {
      const args = invocation.args.slice(invocation.args.indexOf('plugin'));
      return args[1] === 'add' || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    })).toBe(false);
    await expect(fs.readFile(payloadReadme, 'utf8')).resolves.toBe('tampered payload\n');

    const callsBeforeStatus = runtime.nativeCliRunner.mock.calls.length;
    const status = await statusCommandV8({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' },
      cliVersion: '1.0.0', platform: 'codex', scope: 'user', json: true,
    });
    expect(status.payload.targets).toEqual([expect.objectContaining({
      state: 'needsSync',
      reasons: expect.arrayContaining([
        expect.objectContaining({ code: 'codexSharedNativeUnobserved', severity: 'warning' }),
      ]),
    })]);
    expect(statusTargetSharedNative(status.payload.targets[0]!)).toEqual({
      pluginId: 'demo@aw', state: 'unobserved',
    });
    expect(runtime.nativeCliRunner).toHaveBeenCalledTimes(callsBeforeStatus);

    const blockedOutput = createCapturedCliIo();
    const nativeCallsBeforeBlocked = runtime.nativeCliRunner.mock.calls.length;
    expect(await runCli([
      'plugin', 'sync', 'team/demo', '--target', 'codex', '--context', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: blockedOutput.io,
      interactive: false,
      nativeCliRunner: runtime.nativeCliRunner,
      codexManagerResolver: runtime.codexManagerResolver,
    })).toBe(0);
    expect(JSON.parse(blockedOutput.readStdout())).toMatchObject({
      schemaVersion: 1,
      kind: 'aw-recovery',
      scope: 'user',
      command: 'sync',
      ok: true,
      targetResults: [expect.objectContaining({
        pluginId: 'team/demo', agent: 'codex', scope: 'user',
      })],
      recoveryActions: [],
    });
    expect(runtime.nativeCliRunner.mock.calls.slice(nativeCallsBeforeBlocked)
      .some(([invocation]) => invocation.args.includes('remove'))).toBe(false);
    await expect(fs.readFile(payloadReadme, 'utf8')).resolves.toBe('tampered payload\n');

    const repairedOutput = createCapturedCliIo();
    const nativeCallsBeforeRepair = runtime.nativeCliRunner.mock.calls.length;
    const repairedExit = await runCli([
      'plugin', 'sync', 'team/demo', '--target', 'codex', '--context', 'user', '--yes', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: repairedOutput.io,
      interactive: false,
      nativeCliRunner: runtime.nativeCliRunner,
      codexManagerResolver: runtime.codexManagerResolver,
    });
    expect(repairedExit, repairedOutput.readStdout()).toBe(0);
    expect(JSON.parse(repairedOutput.readStdout())).toMatchObject({
      schemaVersion: 1,
      kind: 'aw-recovery',
      scope: 'user',
      command: 'sync',
      ok: true,
      targetResults: [expect.objectContaining({
        pluginId: 'team/demo', agent: 'codex', scope: 'user',
      })],
      recoveryActions: [],
    });
    const repairNativeActions = runtime.nativeCliRunner.mock.calls
      .slice(nativeCallsBeforeRepair)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(repairNativeActions).not.toContain('plugin remove demo@aw');
    expect(repairNativeActions).not.toContain('plugin add demo@aw');
    await expect(fs.readFile(payloadReadme, 'utf8')).resolves.toBe('tampered payload\n');

    await fs.remove(payloadReadme);
    await expect(statusCommandV8({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' },
      cliVersion: '1.0.0', platform: 'codex', scope: 'user', json: true,
    })).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'needsSync' })] },
    });
    const deletedRepairPlan = await syncFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      interactive: false,
    }, { ...runtime, previewOperationPlan: true });
    expect(deletedRepairPlan.codexReconcilePlans).toEqual([
      expect.objectContaining({
        sharedNativeActions: [expect.objectContaining({ action: 'reuse' })],
        review: expect.objectContaining({ requiresConfirmation: false }),
      }),
    ]);
    await expect(fs.pathExists(payloadReadme)).resolves.toBe(false);

    const externalPayload = path.join(isolation.layout.fixtureCwd, 'foreign-payload.txt');
    const payloadLink = path.join(
      isolation.env.CODEX_HOME!,
      'plugins', 'cache', 'aw', 'demo', '1.0.0', 'foreign-link',
    );
    await fs.outputFile(externalPayload, 'foreign\n');
    await fs.symlink(externalPayload, payloadLink);
    const foreignStatus = await statusCommandV8({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' },
      cliVersion: '1.0.0', platform: 'codex', scope: 'user', json: true,
    });
    expect(foreignStatus.payload.targets).toEqual([
      expect.objectContaining({ state: 'needsSync' }),
    ]);
    expect(statusTargetSharedNative(foreignStatus.payload.targets[0]!)).toEqual({
      pluginId: 'demo@aw', state: 'unobserved',
    });
    const foreignOutput = createCapturedCliIo();
    expect(await runCli([
      'plugin', 'sync', 'team/demo', '--target', 'codex', '--context', 'user', '--yes', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: foreignOutput.io,
      interactive: false,
      nativeCliRunner: runtime.nativeCliRunner,
      codexManagerResolver: runtime.codexManagerResolver,
    })).toBe(0);
    expect(JSON.parse(foreignOutput.readStdout())).toMatchObject({
      schemaVersion: 1, kind: 'aw-recovery', scope: 'user', command: 'sync', ok: true,
      targetResults: [expect.objectContaining({
        pluginId: 'team/demo', agent: 'codex', scope: 'user',
      })],
    });
    await expect(fs.readFile(externalPayload, 'utf8')).resolves.toBe('foreign\n');
    await expect(fs.lstat(payloadLink)).resolves.toMatchObject({});
  });

  it('updates a markerless static native plugin after another plugin rebuilds the marketplace', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'static-upgrade-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'alpha' }, { name: 'beta' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const };
    for (const name of ['alpha', 'beta']) {
      const installed = await installFixturePlugin([`team/${name}`], options, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    }
    const skillRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins',
      'alpha', 'skills', 'alpha-skill');
    await expect(fs.pathExists(path.join(skillRoot, '.agent-workflows-owner.json'))).resolves.toBe(false);
    await fs.appendFile(path.join(skillRoot, 'SKILL.md'), '\nlocal edit in rebuildable native copy\n');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'alpha', configureManifest: (manifest) => { manifest.version = '2.0.0'; } },
      { name: 'beta' },
    ]);
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    const preview = await syncWriteCommand(['team/alpha'], options, { ...runtime, previewOperationPlan: true });
    expect(preview.dependencyPlan?.targets).toContainEqual(expect.objectContaining({
      pluginId: 'team/alpha', action: expect.not.stringMatching('block'),
    }));
    const result = await syncWriteCommand(['team/alpha'], { ...options, yes: true }, runtime);
    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    const expectedSkill = await fs.readFile(path.join(sourceRoot, 'plugins', 'alpha', 'skills',
      'alpha-skill', 'SKILL.md'), 'utf8');
    await expect(fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8')).resolves.toBe(expectedSkill);
    await expect(fs.readFile(path.join(isolation.env.CODEX_HOME!, 'plugins', 'cache',
      'aw', 'alpha', '2.0.0', 'skills', 'alpha-skill', 'SKILL.md'), 'utf8')).resolves.toBe(expectedSkill);
    expect(runtime.installed.has('beta@aw')).toBe(true);
  });

  it('installs over cache-only Codex residue with add and no remove or cache deletion', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cache-only-install-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const cacheRoot = path.join(
      isolation.env.CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo', '1.0.0',
    );
    const runtime = await createCodexNativeTestRuntime(isolation);
    const first = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(first.overallState, JSON.stringify(first.rebuildResults)).toBe('succeeded');
    runtime.installed.clear();
    const sentinel = path.join(cacheRoot, 'metadata.json');
    await fs.outputFile(sentinel, '{"cacheOnly":true}\n');
    const callsBeforeCacheOnlyInstall = runtime.nativeCliRunner.mock.calls.length;

    const result = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    const calls = runtime.nativeCliRunner.mock.calls
      .slice(callsBeforeCacheOnlyInstall)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(calls).toContain('plugin add demo@aw');
    expect(calls).not.toContain('plugin remove demo@aw');
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('{"cacheOnly":true}\n');
  });

  it('adds a cache-only user dependency for a project consumer without removing its cache', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cache-only-dependency-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    runtime.installed.delete('leaf@aw');
    const sentinel = path.join(
      isolation.env.CODEX_HOME!,
      'plugins', 'cache', 'aw', 'leaf', '1.0.0', 'metadata.json',
    );
    await fs.outputFile(sentinel, '{"cacheOnly":true}\n');
    const callsBeforeInstall = runtime.nativeCliRunner.mock.calls.length;

    const result = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'team/leaf',
        resolvedScope: 'project',
        assignmentSource: 'default',
        state: 'absent',
        action: 'install',
      }),
    ]));
    const calls = runtime.nativeCliRunner.mock.calls
      .slice(callsBeforeInstall)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(calls).toContain('plugin add leaf@aw');
    expect(calls).not.toContain('plugin remove leaf@aw');
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('{"cacheOnly":true}\n');
  });

  it('projects automatic user dependency providers per platform in joint status', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'status-placement-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'middle', dependencies: ['leaf'] },
      { name: 'root', dependencies: ['middle'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    await writeIntentFixture({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, { roots: [{ pluginId: 'team/middle', platforms: ['claude', 'codex'] }] });
    await writeIntentFixture({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, { roots: [{ pluginId: 'team/root', platforms: ['claude', 'codex'] }] });
    const runtime = await createClaudeNativeTestRuntime(isolation);
    const status = await readRecoveryStatus({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0',
      nativeCliRunner: runtime.nativeCliRunner,
    });
    expect(status.inventory?.map((entry) => entry.pluginId).sort()).toEqual(['team/middle', 'team/root']);
    for (const agent of ['codex', 'claude'] as const) {
      for (const [pluginId, scope] of [
        ['team/root', 'project'],
        ['team/middle', 'user'],
        ['team/leaf', 'user'],
      ] as const) {
        const target = status.observedTargets?.find((entry) => entry.pluginId === pluginId
          && entry.agent === agent && entry.scope === scope);
        expect(target, JSON.stringify(status)).toBeDefined();
        const backend = target?.backend as { live?: { components: Array<{
          kind: string; metadata?: Record<string, unknown>;
        }> } } | undefined;
        expect(backend?.live?.components, JSON.stringify({ pluginId, scope, agent, target })).toContainEqual(expect.objectContaining({
          kind: 'intent', metadata: expect.objectContaining({ enabled: true, scopes: [scope] }),
        }));
      }
      expect(status.inventory?.find((entry) => entry.pluginId === 'team/root')?.targetResults)
        .toContainEqual(expect.objectContaining({ agent, scope: 'project', providerScope: 'project' }));
    }
  });

  it('keeps a project-only pure-native dependency in project scope after install', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'project-native-dependency-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    expect(installed.dependencyPlan?.targets).toContainEqual(expect.objectContaining({
      pluginId: 'team/leaf', resolvedScope: 'project', action: 'install',
    }));

    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'project-native-dependency-prefix'),
      runtime.codexVersion,
    );
    setNativeCliRunnerOverrideForTests(runtime.nativeCliRunner);
    try {
      const publicStatus = await readRecoveryStatus({
        nativeCliRunner: runtime.nativeCliRunner,
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        cliVersion: '1.0.0', targets: ['codex'],
      });
      const live = publicStatus.observedTargets?.find((entry) => entry.pluginId === 'team/root'
        && entry.scope === 'project' && entry.agent === 'codex')?.backend as {
          live?: { state: string; components: Array<{ kind: string; key: string; metadata?: { scope?: string } }> };
        } | undefined;
      expect(live?.live?.state).toBe('ready');
      expect(live?.live?.components).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'dependency', key: 'team/leaf',
          metadata: expect.objectContaining({ scope: 'project' }) }),
      ]));
    } finally {
      setNativeCliRunnerOverrideForTests(undefined);
    }

    const status = await statusCommandV8({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: binRoot }, nativeCliRunner: runtime.nativeCliRunner,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    const root = status.payload.targets.find((target) => target.pluginId === 'team/root');
    const projectRoot = root?.placements.find((placement) => placement.scope === 'project');
    expect(projectRoot, JSON.stringify(status.payload.targets)).toMatchObject({
      state: 'ready',
      components: expect.arrayContaining([expect.objectContaining({
        kind: 'dependency', key: 'team/leaf', state: 'ready',
        metadata: expect.objectContaining({ scope: 'project', project: 'current' }),
      })]),
    });
    expect(statusTargetIntent(projectRoot!)).toEqual({
      enabled: true, scopes: ['project'], relation: 'root',
    });
    expect(statusTargetActivation(projectRoot!)).toMatchObject({ project: true, user: false });

    const synced = await syncFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', interactive: false,
    }, runtime);
    expect(synced.overallState, JSON.stringify(synced.rebuildResults)).toBe('succeeded');
    expect(synced.dependencyPlan?.targets).toContainEqual(expect.objectContaining({
      pluginId: 'team/leaf', resolvedScope: 'project', action: 'keep',
    }));
  }, 30_000);

  it('preserves user actual when a project dependency is reassigned to project scope', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-user-to-project-source');
    await createNativeDependencyCatalog(sourceRoot, [
      {
        name: 'leaf',
        configureManifest: (manifest) => {
          manifest.extensions = {
            agents: [{
              name: 'preserved-role',
              description: 'Preserved role.',
              prompt: 'Keep this role in both scopes until explicit cleanup.',
            }],
          };
        },
      },
      { name: 'bridge', dependencies: ['leaf'] },
      { name: 'root', dependencies: ['bridge'] },
      { name: 'other', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/leaf', platform: 'codex', scope: 'user',
      }],
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(installFixturePlugin(['team/other'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/leaf', platform: 'codex', scope: 'user',
      }],
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const userAgentPath = path.join(
      isolation.env.CODEX_HOME!,
      'agents',
      'aw-leaf-preserved-role.toml',
    );
    const userAgentBeforeReassignment = await fs.readFile(userAgentPath, 'utf8');
    expect(parseOwnedTextHeader(userAgentBeforeReassignment)?.identity).toMatchObject({
      pluginId: 'team/leaf', platform: 'codex', scope: 'user',
    });
    const callsBeforeReassignment = runtime.nativeCliRunner.mock.calls.length;

    const reassigned = await installFixturePlugin(['team/root', 'team/other'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/leaf', platform: 'codex', scope: 'project',
      }],
    }, runtime);

    expect(reassigned.overallState, JSON.stringify(reassigned.rebuildResults)).toBe('succeeded');
    expect(reassigned.dependencyPlan?.targets).toContainEqual(expect.objectContaining({
      pluginId: 'team/leaf', resolvedScope: 'project', action: 'reinstall',
    }));
    expect(reassigned.rebuildResults).not.toContainEqual(expect.objectContaining({
      command: 'cleanup',
      target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }),
    }));
    const [userConfig, projectConfig] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userConfig.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    expect(projectConfig.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
    const nativeCalls = runtime.nativeCliRunner.mock.calls
      .slice(callsBeforeReassignment)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(nativeCalls).not.toContain('plugin remove leaf@aw');
    const projectAgentPath = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-leaf-preserved-role.toml',
    );
    await expect(fs.readFile(userAgentPath, 'utf8')).resolves.toBe(userAgentBeforeReassignment);
    expect(parseOwnedTextHeader(await fs.readFile(userAgentPath, 'utf8'))?.identity)
      .toMatchObject({ pluginId: 'team/leaf', platform: 'codex', scope: 'user' });
    const projectAgent = await fs.readFile(projectAgentPath, 'utf8');
    expect(projectAgent).toContain('Keep this role in both scopes until explicit cleanup.');
    expect(parseOwnedTextHeader(projectAgent)?.identity).toMatchObject({
      pluginId: 'team/leaf', platform: 'codex', scope: 'project',
    });
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [
        { pluginId: 'team/other', platforms: ['codex'] },
        { pluginId: 'team/root', platforms: ['codex'] },
      ],
      dependencyScopeOverrides: [],
    });

    setNativeCliRunnerOverrideForTests(runtime.nativeCliRunner);
    try {
      const status = await readRecoveryStatus({
        nativeCliRunner: runtime.nativeCliRunner,
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        cliVersion: '1.0.0', targets: ['codex'],
      });
      const root = status.observedTargets?.find((entry) => entry.pluginId === 'team/root'
        && entry.scope === 'project' && entry.agent === 'codex');
      expect(root?.backend?.live?.state).toBe('ready');
      expect(root?.backend?.live?.components).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'dependency', key: 'team/bridge', state: 'ready' }),
      ]));
    } finally {
      setNativeCliRunnerOverrideForTests(undefined);
    }

    const projectAgentBeforeUserCleanup = await fs.readFile(projectAgentPath, 'utf8');
    const projectConfigBeforeUserCleanup = await fs.readFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8',
    );
    const removedLeaf = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(removedLeaf.overallState, JSON.stringify(removedLeaf.targetResults)).toBe('succeeded');
    await expect(fs.pathExists(userAgentPath)).resolves.toBe(false);
    await expect(fs.readFile(projectAgentPath, 'utf8')).resolves.toBe(projectAgentBeforeUserCleanup);
    await expect(fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8'))
      .resolves.toBe(projectConfigBeforeUserCleanup);
    expect(runtime.installed.has('leaf@aw')).toBe(true);
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [
        { pluginId: 'team/other', platforms: ['codex'] },
        { pluginId: 'team/root', platforms: ['codex'] },
      ],
      dependencyScopeOverrides: [],
    });
    await expect(readFixtureRequirements({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [] });
    setNativeCliRunnerOverrideForTests(runtime.nativeCliRunner);
    try {
      const finalStatus = await readRecoveryStatus({
        nativeCliRunner: runtime.nativeCliRunner,
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        cliVersion: '1.0.0', targets: ['codex'],
      });
      for (const pluginId of ['team/root', 'team/other']) {
        const target = finalStatus.observedTargets?.find((entry) => entry.pluginId === pluginId
          && entry.scope === 'project' && entry.agent === 'codex');
        expect(target?.backend?.live?.state).toBe('ready');
      }
    } finally {
      setNativeCliRunnerOverrideForTests(undefined);
    }
  }, 60_000);

  it('adds a second pure-native Codex scope without removing the first scope intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'pure-native-second-scope-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const secondScope = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(secondScope.overallState, JSON.stringify(secondScope.rebuildResults)).toBe('succeeded');
    const [userConfig, projectConfig] = await Promise.all([
      readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
    ]);
    expect(userConfig.snapshot.plugins['demo@aw']?.enabled).toBe(true);
    expect(projectConfig.snapshot.plugins['demo@aw']?.enabled).toBe(true);
    expect(secondScope.codexReconcilePlans?.[0]?.sharedNativeActions)
      .toEqual([expect.objectContaining({ action: 'reuse' })]);
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('install', secondScope);
    expect(receipt.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({
        pluginId: 'team/demo', platform: 'codex', scope: 'project',
      }),
      sharedNative: { codexPluginId: 'demo@aw', action: 'reuse' },
    }));
    for (const scope of ['user', 'project'] as const) {
      await expect(readFixtureRequirements({
        scope, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject({
        roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
      });
    }
    const nativeCalls = runtime.nativeCliRunner.mock.calls.map(([invocation]) =>
      invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(nativeCalls.filter((call) => call === 'plugin add demo@aw')).toHaveLength(1);
    expect(nativeCalls).not.toContain('plugin remove demo@aw');
    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'pure-native-second-scope-prefix'), '0.200.0',
    );
    setNativeCliRunnerOverrideForTests(runtime.nativeCliRunner);
    try {
      for (const scope of ['user', 'project'] as const) {
        const status = await readRecoveryStatus({
        nativeCliRunner: runtime.nativeCliRunner,
          scope, cwd: isolation.layout.fixtureCwd, env: { ...isolation.env, PATH: binRoot },
          cliVersion: '1.0.0', targets: ['codex'],
        });
        const target = status.observedTargets?.find((entry) => entry.pluginId === 'team/demo'
          && entry.scope === scope && entry.agent === 'codex');
        expect(target?.backend?.live?.state).toBe('ready');
      }
    } finally {
      setNativeCliRunnerOverrideForTests(undefined);
    }
  });

  it('keeps pure-native intent visible when status only observes cache residue', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dual-native-status-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await writeIntentFixture({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, {
      schemaVersion: 1,
      kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
      managed: { codexPluginIds: ['demo@aw'] },
    });
    await applyCodexConfigTransactionFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      { upsertPluginActivations: { 'demo@aw': true } },
    );

    const status = await statusCommandV8({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' },
      cliVersion: '1.0.0', platform: 'codex', json: true,
    });
    expect(status.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'team/demo', state: 'needsSync' }),
    ]);
    expect(status.payload.targets[0]!.placements.map((placement) => statusTargetIntent(placement)))
      .toEqual([
        { enabled: true, scopes: ['project'], relation: 'root' },
        { enabled: true, scopes: ['user'], relation: 'root' },
      ]);
    expect(statusTargetSharedNative(status.payload.targets[0]!)).toMatchObject({
      pluginId: 'demo@aw', state: 'unobserved',
    });
    expect(statusTargetSharedNative(status.payload.targets[0]!)).not.toHaveProperty(
      'staleCacheObserved',
    );
    for (const placement of status.payload.targets[0]!.placements) {
      expect(statusTargetActivation(placement)).toMatchObject({ user: true, project: true });
    }
  });

  it('requires a local CLI before refreshing a project activation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-cli-gate-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installedRuntime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, installedRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      removePluginActivations: ['demo@aw'],
    });
    const originalRunner = installedRuntime.nativeCliRunner.getMockImplementation()!;
    const observationRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      if (!invocation.args.includes('list')) {
        throw new Error('An unavailable CLI must not perform native mutations');
      }
      return originalRunner(invocation);
    });
    const codexOperationConsumerResolver = vi.fn(async () => {
      throw new CodexManagerError('codexCliNotFound', 'Install or repair the local Codex CLI.');
    });

    const synced = await syncFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' },
      platform: 'codex',
      scope: 'project',
      interactive: false,
    }, {
      env: { ...isolation.env, PATH: '' },
      nativeCliRunner: observationRunner,
      codexOperationConsumerResolver,
    });

    expect(synced.overallState, JSON.stringify(synced.rebuildResults)).toBe('failed');
    expect(synced.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'codexCliNotFound' }),
    ]);
    await expect(readCodexConfigFile(projectConfigPath)).resolves.toMatchObject({
      snapshot: { plugins: {} },
    });
    expect(installedRuntime.installed.has('demo@aw')).toBe(true);
    expect(codexOperationConsumerResolver).toHaveBeenCalledOnce();
    expect(observationRunner.mock.calls.every(([invocation]) => invocation.args.includes('list'))).toBe(true);
  }, 30_000);

  it.each(['absent', 'failed'] as const)(
    'rejects a reviewed activation before writing when the selected App CLI list is %s', async (selectedObservation) => {
      // Test Value Gate: changed CLI observations must not expand an approved activation-only plan into an unapproved native install.
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-selected-cli-source');
      await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const installedRuntime = await createCodexNativeTestRuntime(isolation);
      const options = {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      } as const;
      await expect(installFixturePlugin(['team/demo'], options, installedRuntime))
        .resolves.toMatchObject({ overallState: 'succeeded' });
      const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      await applyCodexConfigTransactionFile(projectConfigPath, { removePluginActivations: ['demo@aw'] });
      const configBefore = await fs.readFile(projectConfigPath);
      const manager = {
        kind: 'app' as const, version: '0.200.0',
        command: path.join(isolation.layout.fixtureCwd, 'Codex.app', 'Contents', 'Resources', 'codex'),
        argsPrefix: [] as string[],
      };
      const originalRunner = installedRuntime.nativeCliRunner.getMockImplementation()!;
      const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
        if (invocation.args.includes('list')) {
          if (invocation.command === manager.command) {
            return selectedObservation === 'absent'
              ? { exitCode: 0, stdout: JSON.stringify({ installed: [], available: [] }), stderr: '' }
              : { exitCode: 1, stdout: '', stderr: 'selected CLI cannot list plugins' };
          }
          return originalRunner(invocation);
        }
        throw new Error('An unconfirmed registration must not trigger a native mutation');
      });
      const codexOperationConsumerResolver = vi.fn(async (
        consumerOptions: Parameters<NonNullable<RebuildCommandRuntime['codexOperationConsumerResolver']>>[0],
      ) => ({ support: 'observed' as const, manager, requirement: consumerOptions.operationRequirement }));
      const reviewedManager = {
        kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [] as string[],
      };
      const preview = await syncFixturePlugin(['team/demo'], options, {
        env: isolation.env,
        nativeCliRunner,
        previewOperationPlan: true,
        codexManagerPreviewer: async () => ({ state: 'system', manager: reviewedManager }),
      });
      expect(preview.codexManagerPreview).toMatchObject({ state: 'system', manager: reviewedManager });
      expect(preview.operationPlan?.actions).toContainEqual(expect.objectContaining({
        kind: 'setActivation', enabled: true,
      }));
      expect(preview.operationPlan?.actions.some((action) => action.kind === 'ensureNativeRegistration')).toBe(false);
      nativeCliRunner.mockClear();

      const result = await syncFixturePlugin(['team/demo'], options, {
        env: isolation.env, nativeCliRunner, codexOperationConsumerResolver,
        expectedPlanFingerprint: preview.operationPlan!.planFingerprint,
      });

      expect(codexOperationConsumerResolver).toHaveBeenCalledOnce();
      expect(nativeCliRunner.mock.calls.some(([invocation]) => invocation.command === manager.command
        && invocation.args.includes('list'))).toBe(true);
      await expect(fs.readFile(projectConfigPath)).resolves.toEqual(configBefore);
      expect(nativeCliRunner.mock.calls.filter(([invocation]) => !invocation.args.includes('list'))
        .map(([invocation]) => invocation.args.slice(0, 3))).toEqual([]);
      expect(result.overallState, JSON.stringify(result.targetResults)).toBe('failed');
      expect(installedRuntime.installed.has('demo@aw')).toBe(true);
    }, 30_000);

  it('repairs public activation and runs preApply when official enabled stays false', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-pre-apply-failure-source');
    const definitions = [{
      name: 'demo',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
      },
    }];
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'), [
      'import { readFile, writeFile } from "node:fs/promises";',
      'const counter = `${process.env.AW_HOME}/activation-pre-apply-count.txt`;',
      'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
      'await writeFile(counter, String(previous + 1));',
    ].join('\n'));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installedRuntime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', yes: true,
    }, installedRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const counterPath = path.join(isolation.env.AW_HOME!, 'activation-pre-apply-count.txt');
    await expect(fs.readFile(counterPath, 'utf8')).resolves.toBe('1');
    await applyCodexConfigTransactionFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      { removePluginActivations: ['demo@aw-team'] },
    );
    const contradictoryOfficialList = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.args[0] === 'plugin' && invocation.args[1] === 'list'
        && invocation.args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [{ pluginId: 'demo@aw', installed: true, enabled: false, version: '1.0.0' }],
            available: [],
          }),
          stderr: '',
        };
      }
      return installedRuntime.nativeCliRunner(invocation);
    });
    const preApplyEvents: string[] = [];
    const reporter: NonNullable<RebuildCommandRuntime['reporter']> = {
      event: (event) => {
        if (event.type === 'rebuild:action'
          && event.data?.name === 'preApply') preApplyEvents.push(event.data.phase);
      },
      notice: () => {},
    };
    const synced = await syncFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', interactive: false, yes: true,
    }, { ...installedRuntime, nativeCliRunner: contradictoryOfficialList, reporter });
    expect(synced.overallState, JSON.stringify(synced, null, 2)).toBe('succeeded');
    expect(synced.targetResults).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/demo', platform: 'codex', scope: 'project' }),
        state: 'completed',
      }),
    ]);
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('sync', synced);
    expect(receipt).toMatchObject({
      ok: true,
      overallState: 'succeeded',
      targetResults: [{
        target: expect.objectContaining({ pluginId: 'team/demo', platform: 'codex', scope: 'project' }),
        state: 'completed',
        actions: expect.any(Array),
      }],
    });
    expect(receipt.targetResults[0]?.actions.map((action) => action.name))
      .toContain('preApply');
    await expect(fs.readFile(counterPath, 'utf8')).resolves.toBe('2');
    expect(preApplyEvents).toEqual(['start', 'success']);
  }, 30_000);

  it('ignores per-plugin official enabled mismatches after public activation repair', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-isolation-source');
    const definitions = ['alpha', 'beta'].map((name) => ({
      name,
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
      },
    }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await Promise.all(definitions.map(({ name }) => fs.outputFile(
      path.join(sourceRoot, 'plugins', name, 'scripts', 'preApply.mjs'),
      [
        'import { readFile, writeFile } from "node:fs/promises";',
        `const counter = \`${'${process.env.AW_HOME}'}/activation-isolation-${name}.txt\`;`,
        'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
        'await writeFile(counter, String(previous + 1));',
      ].join('\n'),
    )));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installedRuntime = await createCodexNativeTestRuntime(isolation);
    const selectors = ['team/alpha', 'team/beta'];
    await expect(installFixturePlugin(selectors, {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', yes: true,
    }, installedRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const alphaCounter = path.join(
      isolation.env.AW_HOME!,
      'activation-isolation-alpha.txt',
    );
    const betaCounter = path.join(
      isolation.env.AW_HOME!,
      'activation-isolation-beta.txt',
    );
    await expect(fs.readFile(alphaCounter, 'utf8')).resolves.toBe('1');
    await expect(fs.readFile(betaCounter, 'utf8')).resolves.toBe('1');
    await applyCodexConfigTransactionFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      { removePluginActivations: ['alpha@aw'] },
    );
    const contradictoryOfficialList = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.args[0] === 'plugin' && invocation.args[1] === 'list'
        && invocation.args.includes('--json')) {
        const exactProject = invocation.cwd === isolation.layout.fixtureCwd;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: [
              {
                pluginId: 'alpha@aw', installed: true,
                enabled: false, version: '1.0.0',
              },
              {
                pluginId: 'beta@aw', installed: true,
                enabled: exactProject, version: '1.0.0',
              },
            ],
            available: [],
          }),
          stderr: '',
        };
      }
      return installedRuntime.nativeCliRunner(invocation);
    });

    const synced = await syncFixturePlugin(selectors, {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', interactive: false, yes: true,
    }, { ...installedRuntime, nativeCliRunner: contradictoryOfficialList });

    expect(synced.overallState, JSON.stringify(synced, null, 2)).toBe('succeeded');
    expect(synced.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/alpha' }),
        state: 'completed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/beta' }),
        state: 'completed',
      }),
    ]));
    expect(synced.rebuildResults.find((entry) => entry.target.pluginId === 'team/alpha')
      ?.actions).toContainEqual({ name: 'preApply', status: 'succeeded' });
    expect(synced.rebuildResults.find((entry) => entry.target.pluginId === 'team/beta')
      ?.actions).toContainEqual({ name: 'preApply', status: 'succeeded' });
    await expect(fs.readFile(alphaCounter, 'utf8')).resolves.toBe('2');
    await expect(fs.readFile(betaCounter, 'utf8')).resolves.toBe('2');
  }, 30_000);

  it('completes Codex activation and preApply when an unrelated Claude target fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'partial-platform-pre-apply-source');
    const definitions = [{
      name: 'demo',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex', 'claude'];
        manifest.skills = './skills';
        manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
      },
    }];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await Promise.all([
      fs.outputFile(
        path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-skill', 'SKILL.md'),
        '---\nname: demo-skill\ndescription: Demo skill.\n---\n',
      ),
      fs.outputFile(
        path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-skill', 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
      fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'), [
        'import { writeFile } from "node:fs/promises";',
        'let input = "";',
        'for await (const chunk of process.stdin) input += chunk;',
        'const context = JSON.parse(input);',
        'await writeFile(`${process.env.AW_HOME}/pre-apply-${context.target.platform}.txt`, "1");',
      ].join('\n')),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const codexRuntime = await createCodexNativeTestRuntime(isolation);
    const preApplyPath = path.join(isolation.env.AW_HOME!, 'pre-apply-codex.txt');
    const preApplyEvents: Array<{ phase: string; outputExists: boolean }> = [];
    const reporter: NonNullable<RebuildCommandRuntime['reporter']> = {
      event: async (event) => {
        if (event.type !== 'rebuild:action'
          || event.source.platform !== 'codex'
          || event.data?.name !== 'preApply') return;
        preApplyEvents.push({
          phase: event.data.phase,
          outputExists: await fs.pathExists(preApplyPath),
        });
      },
      notice: () => {},
    };
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) =>
      invocation.command === 'claude' && invocation.args.includes('--version')
        ? { exitCode: 0, stdout: 'claude-cli 99.0.0', stderr: '' }
        : codexRuntime.nativeCliRunner(invocation));
    setRebuildCommandTestHooksForTests({
      afterTargetBuilt: async ({ identity }) => {
        if (identity.platform === 'claude') throw new Error('injected Claude target failure');
      },
    });
    let result: Awaited<ReturnType<typeof installWriteCommand>>;
    try {
      result = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'both', scope: 'project',
      }, { ...codexRuntime, nativeCliRunner, reporter, preApplyConfirmed: true });
    } finally {
      setRebuildCommandTestHooksForTests(undefined);
    }

    expect(result.overallState, JSON.stringify(result)).toBe('partial');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ platform: 'codex' }), state: 'completed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ platform: 'claude' }), state: 'failed',
      }),
    ]));
    const codexResult = result.rebuildResults.find((entry) => entry.target.platform === 'codex');
    expect(codexResult?.actions).toContainEqual({ name: 'preApply', status: 'succeeded' });
    await expect(readCodexConfigFile(
      path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
    )).resolves.toMatchObject({ snapshot: { plugins: { 'demo@aw': { enabled: true } } } });
    await expect(fs.readFile(preApplyPath, 'utf8')).resolves.toBe('1');
    expect(preApplyEvents).toEqual([
      { phase: 'start', outputExists: false },
      { phase: 'success', outputExists: true },
    ]);
    await expect(fs.pathExists(
      path.join(isolation.env.AW_HOME!, 'pre-apply-claude.txt'),
    )).resolves.toBe(false);
    await expect(readFixtureRequirements({
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'team/demo', platforms: expect.arrayContaining(['claude', 'codex']) }],
    });
  }, 30_000);

  it('requires --yes and reports a preApply failure without platform writes', async () => {
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'claude-pre-apply-warning-source');
    const secret = 'private "pre-apply"\ntoken\\7f3e9c';
    const escapedSecret = JSON.stringify(secret).slice(1, -1);
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['claude'];
      manifest.extensions = { instructions: [{ name: 'pre-apply', title: 'Pre Apply', content: 'Native.' }] };
      manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
      manifest.config = { schemaVersion: 5, fields: { token: { type: 'string', required: true, sensitive: true } } };
    });
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'),
      [
        'let input = "";',
        'for await (const chunk of process.stdin) input += chunk;',
        'const context = JSON.parse(input);',
        'throw new Error([',
        '  `prefix${JSON.stringify(context.config.values.token).slice(1, -1)}Suffix ordinary preApply failed`,',
        '  context.plugin.rootDir, context.target.projectRoot,',
        '  process.env.AW_HOME, process.env.HOME, process.env.TMPDIR,',
        '].filter(Boolean).join(" | "));',
      ].join('\n'),
    );
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['claude'];
      manifest.extensions = { instructions: [{ name: 'pre-apply', title: 'Pre Apply', content: 'Native.' }] };
      manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
      manifest.config = { schemaVersion: 5, fields: { token: { type: 'string', required: true, sensitive: true } } };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity({
      id: 'team', type: 'path', primary: true, path: sourceRoot,
    });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { token: secret },
    });
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['claude'],
    });
    const marketplaceRoots = new Map<string, string>();
    const nativeCliRunner = async (invocation: NativeCliInvocation) => {
      if (invocation.command === 'claude' && invocation.args[0] === 'plugin') {
        const settingsPath = path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'settings.json');
        const pluginsRoot = path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'plugins');
        const knownPath = path.join(pluginsRoot, 'known_marketplaces.json');
        const installedPath = path.join(pluginsRoot, 'installed_plugins.json');
        if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
          const marketplaceRoot = invocation.args[3]!;
          const config = await fs.readJson(path.join(marketplaceRoot, 'config.json')) as {
            marketplaceName: string;
          };
          marketplaceRoots.set(config.marketplaceName, marketplaceRoot);
          await fs.outputJson(settingsPath, {
            extraKnownMarketplaces: {
              [config.marketplaceName]: {
                source: { source: 'directory', path: marketplaceRoot },
              },
            },
          });
          await fs.outputJson(knownPath, {
            [config.marketplaceName]: {
              source: { source: 'directory', path: marketplaceRoot },
              installLocation: marketplaceRoot,
            },
          });
        }
        if (invocation.args[1] === 'install') {
          const pluginId = invocation.args[2]!;
          const separator = pluginId.lastIndexOf('@');
          const pluginName = pluginId.slice(0, separator);
          const marketplaceName = pluginId.slice(separator + 1);
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          await fs.outputJson(settingsPath, {
            ...settings,
            enabledPlugins: { [pluginId]: true },
          });
          await fs.outputJson(installedPath, {
            plugins: { [pluginId]: [{ name: pluginName, scope: 'user', version: '1.0.0' }] },
          });
          await fs.ensureDir(path.join(marketplaceRoots.get(marketplaceName)!, 'plugins', pluginName));
        }
      }
      return { exitCode: 0, stdout: '2.1.88 (Claude Code)', stderr: '' };
    };

    const unauthorizedOutput = createCapturedCliIo();
    const unauthorizedExitCode = await runCli([
      'plugin', 'install', 'team/demo', '--scope', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: unauthorizedOutput.io,
      interactive: false,
      nativeCliRunner,
    });
    expect(unauthorizedExitCode).toBe(1);
    expect(JSON.parse(unauthorizedOutput.readStdout())).toMatchObject({
      schemaVersion: 1,
      kind: 'aw-recovery',
      scope: 'user',
      ok: false,
      declarationChanged: true,
      outputsMayHaveChanged: false,
      targetResults: [expect.objectContaining({
        pluginId: 'team/demo', agent: 'claude', scope: 'user',
        execution: 'failed',
        blockers: [expect.objectContaining({ code: 'preApplyAuthorizationRequired' })],
      })],
    });
    expect(marketplaceRoots.size).toBe(0);

    await fs.ensureDir(isolation.env.CLAUDE_CONFIG_DIR!);
    const platformBefore = await snapshotRegularTree(isolation.env.CLAUDE_CONFIG_DIR!);
    const intentPaths = [
      path.join(isolation.env.AW_HOME!, 'plugin-intents.json'),
      path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json'),
    ];
    const intentsBefore = await Promise.all(intentPaths.map((intentPath) =>
      fs.readFile(intentPath).catch((error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? null : Promise.reject(error))));
    const output = createCapturedCliIo();
    const debugLogPath = path.join(isolation.layout.debugLogsDir, 'pre-apply-redaction.log');
    const exitCode = await runCli([
      'plugin', 'install', 'team/demo', '--scope', 'user', '--yes', '--json',
      '--debug', '--log-file', debugLogPath,
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: output.io,
      interactive: false,
      nativeCliRunner,
    });

    expect(exitCode, output.readStdout()).toBe(1);
    const receipt = JSON.parse(output.readStdout());
    expect(receipt).toMatchObject({
      schemaVersion: 1, kind: 'aw-recovery', scope: 'user', ok: false,
      declarationChanged: false, outputsMayHaveChanged: false,
      targetResults: [expect.objectContaining({
        pluginId: 'team/demo', agent: 'claude', scope: 'user',
        execution: 'failed',
        blockers: [expect.objectContaining({ code: 'preApplyFailed' })],
      })],
    });
    const serializedReceipt = JSON.stringify(receipt);
    const serializedFailures = JSON.stringify(receipt.targetResults);
    expect(serializedReceipt).toContain('prefix[REDACTED]Suffix ordinary preApply failed');
    for (const privateValue of [secret, escapedSecret]) {
      expect(serializedReceipt).not.toContain(privateValue);
    }
    for (const privatePath of [
      isolation.layout.fixtureCwd,
      isolation.env.AW_HOME!,
    ]) {
      expect(serializedFailures).not.toContain(privatePath);
    }
    const debugLog = await fs.readFile(debugLogPath, 'utf8');
    expect(debugLog).not.toContain(secret);
    expect(debugLog).not.toContain(escapedSecret);

    const humanOutput = createCapturedCliIo();
    const humanExitCode = await runCli([
      'plugin', 'install', 'team/demo', '--scope', 'user', '--yes',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: humanOutput.io,
      interactive: false,
      nativeCliRunner,
    });
    expect(humanExitCode).toBe(1);
    const humanText = `${humanOutput.readStdout()}\n${humanOutput.readStderr()}`;
    expect(humanText).toContain('preApplyFailed');
    expect(humanText).not.toContain(secret);
    expect(humanText).not.toContain(escapedSecret);
    expect(marketplaceRoots.size).toBe(0);
    await expect(snapshotRegularTree(isolation.env.CLAUDE_CONFIG_DIR!))
      .resolves.toEqual(platformBefore);
    await expect(Promise.all(intentPaths.map((intentPath) =>
      fs.readFile(intentPath).catch((error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? null : Promise.reject(error)))))
      .resolves.toEqual(intentsBefore);
  }, 30_000);

  it('does not authorize preApply from an interactive install without --yes', async () => {
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'interactive-pre-apply-source');
    const definitions = [{
      name: 'demo',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
        manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
      },
    }];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'),
      'await import("node:fs/promises").then((fs) => fs.writeFile(`${process.env.AW_HOME}/interactive-pre-apply.txt`, "ran"));\n');
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env,
    });
    const markerPath = path.join(isolation.env.AW_HOME!, 'interactive-pre-apply.txt');
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const { nativeCliRunner } = await createCodexNativeTestRuntime(isolation);
    const launch = vi.fn();
    const run = async (yes: boolean) => {
      const captured = createCapturedCliIo();
      const exitCode = await runCli([
        'plugin', 'install', 'team/demo', '--scope', 'user',
        ...(yes ? ['--yes'] : []), '--json',
      ], {
        cwd: isolation.layout.fixtureCwd, env: isolation.env, io: captured.io,
        interactive: true, tuiRunner: { launch } as never,
        nativeCliRunner, ...createTtyRuntimeStreams(),
      });
      return { exitCode, receipt: JSON.parse(captured.readStdout()) };
    };

    const unauthorized = await run(false);
    expect(unauthorized.exitCode).toBe(1);
    expect(unauthorized.receipt).toMatchObject({
      kind: 'aw-recovery', ok: false,
      targetResults: [expect.objectContaining({
        pluginId: 'team/demo', execution: 'failed',
        blockers: [expect.objectContaining({ code: 'preApplyAuthorizationRequired' })],
      })],
    });
    expect(launch).not.toHaveBeenCalled();
    await expect(fs.pathExists(markerPath)).resolves.toBe(false);

    const authorized = await run(true);
    expect(authorized.exitCode).toBe(0);
    expect(authorized.receipt).toMatchObject({
      kind: 'aw-recovery', ok: true,
      targetResults: [expect.objectContaining({ pluginId: 'team/demo', execution: 'applied' })],
    });
    await expect(fs.readFile(markerPath, 'utf8')).resolves.toBe('ran');
  }, 30_000);

  it('redacts private preApply data from a config apply receipt', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const privateToken = 'preapply-private-token-0123456789';
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'config-pre-apply-redaction-source');
    const inputObservedPath = path.join(isolation.layout.fixtureCwd, 'config-pre-apply-input.json');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'), [
      'let input = "";',
      'for await (const chunk of process.stdin) input += chunk;',
      'const context = JSON.parse(input);',
      'if (context.config.values.mode === "fail") {',
      `  await import("node:fs/promises").then(({ writeFile }) => writeFile(${JSON.stringify(inputObservedPath)}, JSON.stringify({ mode: context.config.values.mode, tokenMatches: context.config.values.token === ${JSON.stringify(privateToken)} })));`,
      '  throw new Error([',
      '    `prefix${context.config.values.token}Suffix config preApply failed`,',
      '    context.plugin.rootDir, context.target.projectRoot,',
      '    process.env.AW_HOME, process.env.HOME, process.env.TMPDIR,',
      '  ].filter(Boolean).join(" | "));',
      '}',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'policy', title: 'Policy', content: 'Policy.' }],
      };
      manifest.config = { schemaVersion: 5, fields: {
        mode: { type: 'string', default: 'safe' },
        token: { type: 'string', sensitive: true },
      } };
      manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity, logicalIdentity,
      pluginName: 'demo', scope: 'user', cwd: isolation.layout.fixtureCwd,
      env: isolation.env, values: { token: privateToken },
    });
    await writePreferences({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const { nativeCliRunner } = await createCodexNativeTestRuntime(isolation);
    const runPublic = async (args: string[]) => {
      const output = createCapturedCliIo();
      const exitCode = await runCli(['plugin', ...args, '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: output.io,
        interactive: false,
        nativeCliRunner,
      });
      return { exitCode, payload: JSON.parse(output.readStdout()) as Record<string, unknown> };
    };

    expect(await runPublic([
      'install', 'team/demo', '--scope', 'project', '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { ok: true } });
    const platformRoot = path.join(isolation.layout.fixtureCwd, '.codex');
    const platformBefore = await snapshotRegularTree(platformRoot);
    const failed = await runPublic([
      'config', 'set', 'team/demo', 'mode', '--context', 'project', '--platform', 'codex',
      '--value-json', '"fail"', '--apply', '--yes',
    ]);

    expect(failed, JSON.stringify(failed)).toMatchObject({
      exitCode: 1,
      payload: { configWrite: 'succeeded', overallState: 'partial',
        effective: { values: { token: '[redacted]' } },
        apply: { state: 'partial', targetResults: [expect.objectContaining({
          state: 'failed', errorCode: 'preApplyFailed',
        })] },
      },
    });
    expect(await fs.readJson(inputObservedPath)).toEqual({ mode: 'fail', tokenMatches: true });
    expect(await snapshotRegularTree(platformRoot)).toEqual(platformBefore);
    const serializedReceipt = JSON.stringify(failed.payload);
    expect(serializedReceipt).not.toContain(privateToken);
    const serializedApply = JSON.stringify(failed.payload.apply);
    for (const privatePath of [
      isolation.layout.fixtureCwd,
      isolation.env.AW_HOME!,
    ]) {
      expect(serializedApply).not.toContain(privatePath);
    }
    expect(await runPublic([
      'config', 'set', 'team/demo', 'mode', '--context', 'project', '--platform', 'codex',
      '--value-json', '"safe"', '--apply', '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { configWrite: 'succeeded', apply: { state: 'succeeded' } } });
  }, 30_000);

  it('reports observed registration through the read-only system Codex list', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'status-trust-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installedRuntime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, installedRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'status-system-prefix'),
      installedRuntime.codexVersion,
    );
    const statusRunner = vi.fn(installedRuntime.nativeCliRunner);
    setNativeCliRunnerOverrideForTests(statusRunner);
    let status;
    try {
      status = await statusCommandV8({
        plugins: ['team/demo'],
        cwd: isolation.layout.fixtureCwd,
        env: { ...isolation.env, PATH: binRoot },
        cliVersion: '1.0.0',
        platform: 'codex',
        scope: 'project',
        json: true,
      });
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }

    expect(status.payload.targets).toEqual([
      expect.objectContaining({ state: 'ready' }),
    ]);
    const projectPlacement = status.payload.targets[0]!.placements.find((entry) =>
      entry.scope === 'project')!;
    expect(statusTargetActivation(projectPlacement)).toMatchObject({
      user: false,
      project: true,
      effective: true,
      evidence: 'observed',
    });
    expect(statusTargetActivation(status.payload.targets[0]!)).toMatchObject({
      evidence: 'observed',
      systemConsumer: {
        state: 'compatible',
        detectedVersion: '0.200.0',
        requiredMinVersion: '0.151.0',
      },
    });
    expect(statusTargetSharedNative(status.payload.targets[0]!)).toMatchObject({
      state: 'usable', version: '1.0.0',
    });
    const versionCalls = statusRunner.mock.calls.filter(([invocation]) =>
      invocation.args.at(-1) === '--version');
    expect(versionCalls).toHaveLength(1);
    const versionInvocation = versionCalls[0]![0];
    const selectedPrefix = versionInvocation.args.slice(0, -1);
    const listCalls = statusRunner.mock.calls.filter(([invocation]) =>
      invocation.args.at(-1) !== '--version');
    expect(listCalls).toHaveLength(2);
    expect(listCalls.every(([invocation]) =>
      invocation.command === versionInvocation.command
      && invocation.args.join(' ') === [...selectedPrefix,
        'plugin', 'list', '--marketplace', 'aw', '--json'].join(' '))).toBe(true);
  }, 30_000);

  it('installs and saves ordinary config without parsing an unrelated future bundle', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-future-install-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'root', configureManifest(manifest) {
        manifest.config = { schemaVersion: 4, fields: { mode: { type: 'string', default: 'safe' } } };
      } },
      { name: 'future', requiredCapabilities: ['aw.future-feature.v3'] },
    ]);
    const futureRoot = path.join(sourceRoot, 'plugins', 'future');
    const futureManifestPath = path.join(futureRoot, '.agents-plugin', 'plugin.json');
    const futureManifest = await fs.readJson(futureManifestPath);
    futureManifest.schemaVersion = 99;
    await fs.writeJson(futureManifestPath, futureManifest, { spaces: 2 });
    const catalogManifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const catalogManifest = await fs.readJson(catalogManifestPath);
    const futureEntry = catalogManifest.entries.find((entry: { name: string }) =>
      entry.name === 'future');
    futureEntry.artifactDigest = await calculateCatalogEntryArtifactDigest(futureRoot);
    futureEntry.manifestDigest = calculateCatalogEntryManifestDigest(futureManifest);
    futureEntry.contentDigest = await calculateCatalogEntryContentDigest(futureRoot);
    await fs.writeJson(catalogManifestPath, catalogManifest, { spaces: 2 });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.dependencyPlan?.resolvedPluginIds).toEqual(['team/root']);
    // Test Value Gate: future bundles in a shared Catalog must not block an
    // unrelated supported plugin's ordinary config Review or save.
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    })));
    try {
      await controller.load();
      const review = await controller.buildOperationReview({
        kind: 'configSave', pluginId: 'team/root', scope: 'user', apply: false,
        updates: { mode: 'strict' },
      });
      expect(await controller.executeOperation(review.reviewToken)).toMatchObject({ state: 'succeeded' });
      const stored = await fs.readJson(resolvePluginConfigStorePath({
        sourceId: 'team', pluginName: 'root', scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      }));
      expect(stored.common).toEqual({ mode: 'strict' });
    } finally {
      await controller.cancelAndWaitForReads();
      controller.dispose();
    }
  });

  it('lists supported and future entries in status and TUI without parsing the future bundle', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-future-status-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf', 'future'] },
      { name: 'future', requiredCapabilities: ['aw.future-feature.v3'] },
    ]);
    const futureRoot = path.join(sourceRoot, 'plugins', 'future');
    const futureManifestPath = path.join(futureRoot, '.agents-plugin', 'plugin.json');
    const futureManifest = await fs.readJson(futureManifestPath);
    futureManifest.schemaVersion = 99;
    await fs.writeJson(futureManifestPath, futureManifest, { spaces: 2 });
    const catalogManifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const catalogManifest = await fs.readJson(catalogManifestPath);
    const futureEntry = catalogManifest.entries.find((entry: { name: string }) =>
      entry.name === 'future');
    futureEntry.artifactDigest = await calculateCatalogEntryArtifactDigest(futureRoot);
    futureEntry.manifestDigest = calculateCatalogEntryManifestDigest(futureManifest);
    futureEntry.contentDigest = await calculateCatalogEntryContentDigest(futureRoot);
    await fs.writeJson(catalogManifestPath, catalogManifest, { spaces: 2 });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });

    const status = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      json: true,
    });
    expect(status.payload.catalog.sources).toEqual([
      expect.not.objectContaining({ error: expect.anything() }),
    ]);
    expect(status.pluginSummaries.map((entry) => entry.pluginId).sort()).toEqual([
      'team/future',
      'team/leaf',
      'team/root',
    ]);
    expect(status.pluginSummaries.find((entry) => entry.pluginId === 'team/future'))
      .toMatchObject({ missingCapabilities: ['aw.future-feature.v3'] });
    expect(status.payload.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'team/future',
        state: 'blocked',
        reasons: [expect.objectContaining({ code: 'awCapabilityUnsupported' })],
      }),
    ]));

    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    })));
    await controller.load();
    expect(controller.snapshot.phase).toBe('ready');
    expect(controller.snapshot.viewModel?.plugins.map((entry) => entry.pluginId).sort()).toEqual([
      'team/future',
      'team/leaf',
      'team/root',
    ]);
    expect(controller.snapshot.viewModel?.plugins.find((entry) => entry.pluginId === 'team/future'))
      .toMatchObject({ aggregateStatus: 'unavailable', missingCapabilities: ['aw.future-feature.v3'] });
    expect(controller.snapshot.viewModel?.plugins.find((entry) => entry.pluginId === 'team/root'))
      .toMatchObject({ dependencySummary: { directCount: 2, totalCount: 2 } });
    expect(controller.snapshot.viewModel?.dependencyOverviews.find((entry) =>
      entry.pluginId === 'team/root')?.dependencies.find((entry) =>
        entry.pluginId === 'team/future')).toMatchObject({ aggregateStatus: 'unavailable' });
    for (let attempt = 0; attempt < 100
      && ['notChecked', 'checking'].includes(controller.getCatalogFreshness('team')?.state ?? 'notChecked');
      attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(controller.getCatalogFreshness('team')?.state).toBe('current');
    controller.dispose();
  });

  it('reports an unsupported direct dependency as a stable dependency root', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'future-live-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const leafRoot = path.join(sourceRoot, 'plugins', 'leaf');
    const leafManifestPath = path.join(leafRoot, '.agents-plugin', 'plugin.json');
    const leafManifest = await fs.readJson(leafManifestPath);
    leafManifest.requires.aw.capabilities.push('aw.future-feature.v3');
    await fs.writeJson(leafManifestPath, leafManifest, { spaces: 2 });
    const catalogManifestPath = path.join(sourceRoot, 'catalog-manifest.json');
    const catalogManifest = await fs.readJson(catalogManifestPath);
    const leafEntry = catalogManifest.entries.find((entry: { name: string }) => entry.name === 'leaf');
    leafEntry.requires = leafManifest.requires;
    leafEntry.artifactDigest = await calculateCatalogEntryArtifactDigest(leafRoot);
    leafEntry.manifestDigest = calculateCatalogEntryManifestDigest(leafManifest);
    leafEntry.contentDigest = await calculateCatalogEntryContentDigest(leafRoot);
    await fs.writeJson(catalogManifestPath, catalogManifest, { spaces: 2 });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });

    await expect(statusCommandV8({
      plugins: ['team/root'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'codex',
      scope: 'project',
      json: true,
    })).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({
        pluginId: 'team/root',
        placements: [expect.objectContaining({
          scope: 'project',
          components: expect.arrayContaining([expect.objectContaining({
            kind: 'dependency',
            key: 'team/leaf',
            state: 'error',
            metadata: expect.objectContaining({
              rootIssueId: 'awCapabilityUnsupported:team/leaf',
              rootIssueCode: 'awCapabilityUnsupported',
            }),
          })]),
        })],
        reasons: [expect.objectContaining({
          code: 'awCapabilityUnsupported',
          dependencyPluginId: 'team/leaf',
          rootIssueId: 'awCapabilityUnsupported:team/leaf',
          rootIssueCode: 'awCapabilityUnsupported',
        })],
      })] },
    });
  });

  it('fails a selected dependency closure with the exact unsupported plugin and capabilities', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unsupported-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', requiredCapabilities: ['aw.future-feature.v3'] },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    });

    expect(result.overallState).toBe('failed');
    expect(JSON.stringify(result)).toContain('team/leaf');
    expect(JSON.stringify(result)).toContain('aw.future-feature.v3');
    expect(JSON.stringify(result)).toContain('awCapabilityUnsupported');
  });

  it('rebuilds and cleans a project root with current and offline Catalog evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'inventory-reuse-source');
    const remainingRoot = path.join(isolation.layout.fixtureCwd, 'inventory-reuse-remaining');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };

    const installed = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    expect(installed.dependencyPlan?.resolvedPluginIds).toEqual(['team/leaf', 'team/root']);

    const cleaned = await cleanupWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');

    const installedAgain = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installedAgain.overallState, JSON.stringify(installedAgain.rebuildResults)).toBe('succeeded');
    const upgraded = await syncFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', interactive: false,
    }, runtime);
    expect(upgraded.overallState, JSON.stringify(upgraded.rebuildResults)).toBe('succeeded');

    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    const offline = await cleanupWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(offline.overallState, JSON.stringify(offline.rebuildResults)).toBe('succeeded');
  });

  it('keeps a present user transitive dependency when installing its project consumer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'user-dependency-keep-source');
    const configurePreApply = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        preApply: { path: './scripts/preApply.mjs' },
      };
    };
    const plugins = [
      { name: 'leaf', configureManifest: configurePreApply },
      { name: 'middle', dependencies: ['leaf'], configureManifest: configurePreApply },
      { name: 'root', dependencies: ['middle'], configureManifest: (manifest: PluginMeta['manifest']) => {
        configurePreApply(manifest);
      } },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    const preApplyScript = [
      'import { readFile, writeFile } from "node:fs/promises";',
      'const context = JSON.parse(await new Promise((resolve) => { let data = ""; process.stdin.on("data", (chunk) => { data += chunk; }); process.stdin.on("end", () => resolve(data)); }));',
      'const counter = `${process.env.AW_HOME}/pre-apply-count-${context.plugin.name}.txt`;',
      'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
      'await writeFile(counter, String(previous + 1));',
    ].join('\n');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'leaf', 'scripts', 'preApply.mjs'), preApplyScript);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'middle', 'scripts', 'preApply.mjs'), preApplyScript);
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'root', 'scripts', 'preApply.mjs'), preApplyScript);
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    const leafInstall = await installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', yes: true,
    }, runtime);
    expect(leafInstall.overallState, JSON.stringify(leafInstall.rebuildResults)).toBe('succeeded');
    const leafStatus = await statusCommandV8({
      plugins: ['team/leaf'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'user', json: true,
    });
    const leafUserTarget = leafStatus.payload.targets[0];
    expect(leafUserTarget?.state, JSON.stringify(leafUserTarget)).toBe('ready');

    await writePreferences({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],

    });
    const installedReceipt = await runRecovery('install', ['team/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', scope: 'project', yes: true,
    }, runtime);
    expect(installedReceipt.ok, JSON.stringify(installedReceipt)).toBe(true);
    expect(installedReceipt.targetResults).toContainEqual(expect.objectContaining({
      pluginId: 'team/middle', scope: 'project', providerScope: 'project', observation: 'verified',
    }));
    const leafBackend = installedReceipt.targetResults.find((target) => target.pluginId === 'team/root'
      && target.scope === 'project' && target.agent === 'codex')?.backend as Awaited<ReturnType<typeof installWriteCommand>>;
    expect(leafBackend.targetResults, JSON.stringify(installedReceipt)).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }), action: 'keep', state: 'completed',
    }));
    const installedStatus = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', json: true,
    });
    const leafTarget = installedStatus.payload.targets.find((target) =>
      target.pluginId === 'team/leaf');
    const rootTarget = installedStatus.payload.targets.find((target) =>
      target.pluginId === 'team/root');
    const middleTarget = installedStatus.payload.targets.find((target) =>
      target.pluginId === 'team/middle');
    const leafUserPlacement = leafTarget?.placements.find((placement) => placement.scope === 'user');
    expect(leafUserPlacement).toMatchObject({ scope: 'user', state: 'ready' });
    expect(statusTargetIntent(leafUserPlacement!)).toEqual({
      enabled: true, scopes: ['user'], relation: 'root',
    });
    expect(leafUserPlacement?.reasons).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'codexActivationDrift' }),
    ]));
    expect(rootTarget?.placements).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'project' }),
    ]));
    expect(middleTarget?.placements).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'project', state: 'ready' }),
    ]));
    expect(installedStatus.payload.targets.flatMap((target) => target.reasons)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'dependencyMissing' })]),
    );
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      interactive: false,
    })));
    await controller.load();
    const issues = controller.listUserIssues();
    expect(issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'dependencyMissing',
        rootEntity: expect.objectContaining({ pluginId: 'team/leaf', scope: 'project' }),
      }),
    ]));
    expect(issues.flatMap((issue) => issue.actions)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: expect.stringMatching(/^(install|reinstall)Dependency$/),
        pluginId: 'team/leaf', platform: 'codex', scope: 'project',
      }),
    ]));
    const repeated = await runRecovery('install', ['team/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', scope: 'project', yes: true,
    }, runtime);
    expect(repeated.ok, JSON.stringify(repeated)).toBe(true);
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'pre-apply-count-leaf.txt'), 'utf8'))
      .resolves.toBe('1');
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'pre-apply-count-middle.txt'), 'utf8'))
      .resolves.toBe('2');
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'pre-apply-count-root.txt'), 'utf8'))
      .resolves.toBe('2');

    // Project recovery must not execute the healthy User dependency again.
    const repeatedLeaf = repeated.targetResults.find((entry) => entry.pluginId === 'team/root' && entry.scope === 'project')
      ?.backend as Awaited<ReturnType<typeof installWriteCommand>>;
    expect(repeatedLeaf.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }), action: 'keep', state: 'completed',
    }));
  });

  it('keeps an absent project placement out of extension repair for a healthy user install', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'user-extension-status-source');
    await createNativeDependencyCatalog(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.extensions = {
          agents: [{ name: 'worker', description: 'Worker role.', prompt: 'Work.' }],
        };
      },
    }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [
        { id: 'team', type: 'path', primary: true, path: sourceRoot },
      ] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'user-extension-status-prefix'), runtime.codexVersion,
    );
    setNativeCliRunnerOverrideForTests(runtime.nativeCliRunner);
    try {
      const status = await statusCommandV8({
        cwd: isolation.layout.fixtureCwd, env: { ...isolation.env, PATH: binRoot },
        plugins: ['team/demo'], cliVersion: '1.0.0', platform: 'codex', json: true,
      });
      expect(status.payload.targets).toEqual([expect.objectContaining({
        state: 'ready', reasons: [], recoveryActions: [],
        placements: expect.arrayContaining([
          expect.objectContaining({ scope: 'user', state: 'ready', reasons: [] }),
          expect.objectContaining({ scope: 'project', state: 'absent', reasons: [], recoveryActions: [] }),
        ]),
      })]);
      const view = buildTuiViewModel({ status: status.payload, pluginSummaries: [] });
      expect(view.plugins).toEqual([expect.objectContaining({
        aggregateStatus: 'installed',
        installedPlacements: [expect.objectContaining({
          scope: 'user', health: 'ready', actualScopes: ['user'], desiredScopes: ['user'],
        })],
      })]);
    } finally {
      setNativeCliRunnerOverrideForTests(null);
    }
  });

  it('reuses a user native dependency through a project transitive consumer in status and TUI', async () => {
    // Test Value Gate: distinct roots reuse one indirect User provider; Project false needs activation only.
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-cross-scope-status-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'agent-content-toolkit' },
      { name: 'user-content-tools', dependencies: ['agent-content-toolkit'] },
      { name: 'aw-plugin-development', dependencies: ['agent-content-toolkit'] },
      { name: 'aw-catalog-development', dependencies: ['aw-plugin-development'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'official', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['official/user-content-tools'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const userIntentLocation = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const userIntentBefore = await observeIntent(userIntentLocation);
    const providerPackageRoot = path.join(isolation.env.CODEX_HOME!, 'plugins', 'cache',
      'aw', 'agent-content-toolkit', '1.0.0');
    const providerPackageBefore = await snapshotRegularTree(providerPackageRoot);
    const nativeCallsBefore = runtime.nativeCliRunner.mock.calls.length;
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      upsertPluginActivations: { 'agent-content-toolkit@aw': false },
    });

    const installedReceipt = await runRecovery('install', ['official/aw-catalog-development'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', scope: 'project', yes: true,
    }, runtime);
    expect(installedReceipt.ok, JSON.stringify(installedReceipt)).toBe(true);
    expect((await readCodexConfigFile(projectConfigPath))
      .snapshot.plugins['agent-content-toolkit@aw']?.enabled).toBe(true);
    await expect(observeIntent(userIntentLocation)).resolves.toEqual(userIntentBefore);
    await expect(snapshotRegularTree(providerPackageRoot)).resolves.toEqual(providerPackageBefore);
    expect(runtime.nativeCliRunner.mock.calls.slice(nativeCallsBefore).filter(([invocation]) => {
      const index = invocation.args.indexOf('plugin');
      return index >= 0
        && ['add', 'remove', 'enable', 'disable'].includes(invocation.args[index + 1] ?? '')
        && invocation.args[index + 2] === 'agent-content-toolkit@aw';
    })).toEqual([]);
    const installed = installedReceipt.targetResults.find((target) => target.pluginId === 'official/aw-catalog-development'
      && target.scope === 'project' && target.agent === 'codex')?.backend as Awaited<ReturnType<typeof installWriteCommand>>;

    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    expect(installedReceipt.targetResults, JSON.stringify(installedReceipt)).toContainEqual(expect.objectContaining({
      pluginId: 'official/agent-content-toolkit', scope: 'project', providerScope: 'user',
      content: 'satisfied', blockers: [],
    }));
    await expect(readFixtureRequirements({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'official/user-content-tools', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: [{ pluginId: 'official/aw-catalog-development', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });

    const binRoot = await writeStatusSystemCodexPackage(
      path.join(isolation.layout.fixtureCwd, 'native-cross-scope-status-prefix'),
      runtime.codexVersion,
    );
    const statusEnv = { ...isolation.env, PATH: binRoot };
    setNativeCliRunnerOverrideForTests(runtime.nativeCliRunner);
    let status;
    let issues: ReturnType<TuiController['listUserIssues']>;
    let controller: TuiController | undefined;
    try {
      status = await statusCommandV8({
        cwd: isolation.layout.fixtureCwd, env: statusEnv,
        cliVersion: '1.0.0', platform: 'codex', json: true,
      });
      controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
        cwd: isolation.layout.fixtureCwd,
        env: statusEnv,
        nativeCliRunner: runtime.nativeCliRunner,
        interactive: false,
      })));
      await controller.load();
      issues = controller.listUserIssues();
    } finally {
      controller?.dispose();
      setNativeCliRunnerOverrideForTests(null);
    }
    const toolkit = status.payload.targets.find((target) =>
      target.pluginId === 'official/agent-content-toolkit');
    const toolkitUserPlacement = toolkit?.placements.find((placement) => placement.scope === 'user');
    expect(toolkitUserPlacement, JSON.stringify(toolkit)).toMatchObject({ scope: 'user', state: 'ready' });
    expect(statusTargetIntent(toolkitUserPlacement!)).toEqual({
      enabled: true, scopes: ['user'], relation: 'dependency',
    });
    expect(status.payload.targets.flatMap((target) => target.reasons)).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'dependencyMissing' }),
        expect.objectContaining({ code: 'codexActivationDrift' }),
      ]),
    );

    expect(issues.flatMap((issue) => issue.actions)).not.toEqual(
      expect.arrayContaining([expect.objectContaining({
        id: expect.stringMatching(/^(install|reinstall)Dependency$/),
        pluginId: 'official/agent-content-toolkit', scope: 'project',
      })]),
    );
  });

  it.each([true, false])('preserves project activation %s when restoring a user dependency of a project root', async (projectEnabled) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'stale-project-activation-source');
    await createNativeDependencyCatalog(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'official', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, yes: true };
    await expect(installFixturePlugin(['official/leaf'], {
      ...options, scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(installFixturePlugin(['official/root'], {
      ...options, scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      upsertPluginActivations: { 'leaf@aw': projectEnabled },
    });

    const result = await (projectEnabled ? reinstallWriteCommand : syncWriteCommand)(['official/leaf'], {
      ...options, scope: 'user',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    const project = await readCodexConfigFile(projectConfigPath);
    expect(project.snapshot.plugins['leaf@aw']?.enabled).toBe(projectEnabled);
    expect(project.snapshot.plugins['root@aw']?.enabled).toBe(true);
    const user = await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml'));
    expect(user.snapshot.plugins['leaf@aw']?.enabled).toBe(true);
  });

  it('repairs a missing user extension in an installed native dependency during project sync', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'native-dependency-extension-repair-source');
    await createNativeDependencyCatalog(sourceRoot, [
      {
        name: 'leaf',
        configureManifest: (manifest) => {
          manifest.extensions = {
            agents: [{ name: 'leaf-role', description: 'Leaf role.', prompt: 'Use leaf.' }],
          };
        },
      },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'official', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['official/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const initialReceipt = await runRecovery('install', ['official/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', scope: 'project', yes: true,
    }, runtime);
    expect(initialReceipt.ok, JSON.stringify(initialReceipt)).toBe(true);
    const initialProject = initialReceipt.targetResults.find((target) => target.pluginId === 'official/root'
      && target.scope === 'project' && target.agent === 'codex')?.backend as Awaited<ReturnType<typeof installWriteCommand>>;
    expect(initialProject.overallState, JSON.stringify({
      targetResults: initialProject.targetResults,
      rebuildResults: initialProject.rebuildResults,
      dependencyPlan: initialProject.dependencyPlan,
    })).toBe('succeeded');
    const agentPath = path.join(isolation.env.CODEX_HOME!, 'agents', 'aw-leaf-leaf-role.toml');
    await expect(fs.pathExists(agentPath)).resolves.toBe(true);
    await fs.remove(agentPath);

    const repairedReceipt = await runRecovery('sync', ['official/root'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, cliVersion: '1.0.0', context: 'project', yes: true,
    }, runtime);
    expect(repairedReceipt.ok, JSON.stringify(repairedReceipt)).toBe(true);
    const repaired = repairedReceipt.targetResults.find((target) => target.pluginId === 'official/leaf'
      && target.scope === 'user' && target.agent === 'codex')?.backend as Awaited<ReturnType<typeof installWriteCommand>>;

    expect(repaired.overallState, JSON.stringify(repaired.rebuildResults)).toBe('succeeded');
    expect(repairedReceipt.targetResults).toContainEqual(expect.objectContaining({
      pluginId: 'official/leaf', scope: 'user', providerScope: 'user', observation: 'verified',
    }));
    expect(repaired.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'official/leaf', scope: 'user' }),
        action: 'reinstall', state: 'completed',
      }),
    ]));
    await expect(fs.pathExists(agentPath)).resolves.toBe(true);
  }, 30_000);

  it('keeps project output unchanged when a separate User consumer installs the same dependency', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-user-promotion-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'project-root', dependencies: ['leaf'] },
      { name: 'user-root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/project-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await expect(fs.readFile(projectConfigPath, 'utf8')).resolves.toContain('leaf.');

    const projectBefore = await fs.readFile(projectConfigPath);
    const promoted = await installFixturePlugin(['team/user-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);

    expect(promoted.overallState, JSON.stringify(promoted)).toBe('succeeded');
    expect(promoted.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }), state: 'completed',
    }));
    expect(promoted.rebuildResults).not.toContainEqual(expect.objectContaining({ command: 'cleanup' }));
    await expect(fs.readFile(projectConfigPath)).resolves.toEqual(projectBefore);
  });

  it('repairs partial User output without changing the separate Project output', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(
      isolation.layout.fixtureCwd,
      'partial-dependency-user-promotion-source',
    );
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      {
        name: 'leaf',
        configureManifest: (manifest) => {
          manifest.extensions = {
            ...manifest.extensions,
            agents: [{
              name: 'leaf-role',
              description: 'Leaf role.',
              prompt: 'Use the leaf role.',
            }],
          };
        },
      },
      { name: 'project-root', dependencies: ['leaf'] },
      { name: 'user-root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    const projectInstall = await installFixturePlugin(['team/project-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(projectInstall.overallState, JSON.stringify(projectInstall.rebuildResults))
      .toBe('succeeded');
    const sourceIdentity = projectInstall.rebuildResults.find((result) =>
      result.target.pluginId === 'team/leaf')!.target.sourceIdentity!;
    const userAgentPath = path.join(
      isolation.env.CODEX_HOME!,
      'agents',
      'aw-leaf-leaf-role.toml',
    );
    await writeOwnedTextFile({
      path: userAgentPath,
      allowedRoot: isolation.env.CODEX_HOME!,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity,
        pluginId: 'team/leaf',
        plugin: 'leaf',
        artifactKey: 'aw-leaf-leaf-role',
        platform: 'codex',
        scope: 'user',
      },
      content: 'name = "partial leaf role"\n',
    });
    const projectAgentPath = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-leaf-leaf-role.toml',
    );
    await expect(fs.pathExists(projectAgentPath)).resolves.toBe(true);
    const projectBefore = await fs.readFile(projectAgentPath);
    const promoted = await installFixturePlugin(['team/user-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);

    expect(promoted.overallState, JSON.stringify(promoted)).toBe('succeeded');
    expect(promoted.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }), state: 'completed',
    }));
    await expect(fs.readFile(userAgentPath, 'utf8')).resolves.not.toContain('partial leaf role');
    await expect(fs.pathExists(projectAgentPath)).resolves.toBe(true);
    await expect(fs.readFile(projectAgentPath)).resolves.toEqual(projectBefore);
    await expect(fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8'))
      .resolves.toContain('leaf.');
  });

  it('saves config before authorizing root and dependency preApply for existing outputs', async (test) => {
    const timing = createCommandTestTiming(test);
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-config-source');
    const definitions: Array<{
      name: string;
      dependencies?: string[];
      configureManifest?: (manifest: PluginMeta['manifest']) => void;
    }> = [
      { name: 'leaf' },
      {
        name: 'root',
        dependencies: ['leaf'],
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.config = { schemaVersion: 5,
            fields: { mode: { type: 'string', default: 'safe' } },
          };
        },
      },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const nativeCliRunner = runtime.nativeCliRunner;
    const installed = await timing.measure('command', 'fixture install', () => installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner }));
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    definitions[0]!.configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'leaf', 'scripts', 'preApply.mjs'),
      [
        'import { readFile, writeFile } from "node:fs/promises";',
        'const counter = `${process.env.AW_HOME}/config-pre-apply-count.txt`;',
        'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
        'await writeFile(counter, String(previous + 1));',
      ].join('\n'),
    );
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await timing.measure('catalog', 'source sync', () => syncCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      env: isolation.env,
    }));
    const updatedSourceIdentity = await calculateCatalogSourceIdentity(source);
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity: updatedSourceIdentity,
      logicalIdentity,
      pluginName: 'root',
      scope: 'user',
      platform: 'codex',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { mode: 7 },
    });
    await expect(fs.pathExists(
      path.join(isolation.env.AW_HOME!, 'config-pre-apply-count.txt'),
    )).resolves.toBe(false);
    await expect(readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity: updatedSourceIdentity,
      logicalIdentity,
      pluginName: 'root',
      scope: 'user',
      platform: 'codex',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ values: { mode: 7 } });
    const tuiDependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner,
      interactive: false,
    }));
    const tuiEvidence = await tuiDependencies.captureEvidence({
      kind: 'configSave',
      pluginId: 'team/root',
      scope: 'user',
      context: 'project',
      platform: 'codex',
      apply: true,
      updates: { mode: 'fast' },
      changes: [{ key: 'mode', title: 'mode', before: 7, after: 'fast' }],
    });
    expect(tuiEvidence.config?.preApplyAuthorization, JSON.stringify(tuiEvidence.config?.preApplyAuthorization)).toEqual([
      expect.objectContaining({ pluginId: 'team/leaf', relation: 'direct' }),
    ]);
    await expect(fs.pathExists(
      path.join(isolation.env.AW_HOME!, 'config-pre-apply-count.txt'),
    )).resolves.toBe(false);

    const outputRoots = [path.join(isolation.layout.fixtureCwd, '.codex'), isolation.env.CODEX_HOME!,
      path.join(isolation.env.AW_HOME!, 'marketplaces', 'team')];
    const readOutputs = () => Promise.all(outputRoots.map(async (root) => await fs.pathExists(root)
      ? snapshotRegularTree(root) : null));
    const outputsBeforeUnauthorized = await readOutputs();
    const unauthorized = createCapturedCliIo();
    const unauthorizedExitCode = await timing.measure('command', 'plugin config set', () => runCli([
      'plugin', 'config', 'set', 'team/root', 'mode', '--value-json', '"fast"', '--context', 'project', '--platform', 'codex', '--apply', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: unauthorized.io,
      interactive: false,
      nativeCliRunner,
    }));
    expect(unauthorizedExitCode).toBe(1);
    expect(JSON.parse(unauthorized.readStdout()), unauthorized.readStdout()).toMatchObject({
      receiptSchemaVersion: 7,
      configWrite: 'succeeded',
      overallState: 'partial',
      apply: { state: 'unavailable', targetResults: [],
        error: expect.objectContaining({ code: 'preApplyAuthorizationRequired' }) },
    });
    expect(await readOutputs()).toEqual(outputsBeforeUnauthorized);
    await expect(fs.pathExists(
      path.join(isolation.env.AW_HOME!, 'config-pre-apply-count.txt'),
    )).resolves.toBe(false);
    await expect(readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity: updatedSourceIdentity,
      logicalIdentity,
      pluginName: 'root',
      scope: 'user',
      platform: 'codex',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ values: { mode: 'fast' } });

    const captured = createCapturedCliIo();
    const exitCode = await timing.measure('command', 'plugin config apply', () => runCli([
      'plugin', 'config', 'apply', 'team/root', '--context', 'project', '--target', 'codex', '--yes', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner,
    }));
    const receipt = JSON.parse(captured.readStdout()) as Record<string, unknown>;

    expect(exitCode, captured.readStdout()).toBe(0);
    expect(receipt, JSON.stringify(receipt)).toMatchObject({
      configWrite: 'notStarted',
      overallState: 'succeeded',
      apply: {
        state: 'succeeded',
        targetResults: expect.arrayContaining([
          expect.objectContaining({
            target: expect.objectContaining({ pluginId: 'team/root' }),
            action: 'refresh',
            state: 'completed',
          }),
          expect.objectContaining({
            target: expect.objectContaining({ pluginId: 'team/leaf' }),
            action: 'refresh',
            state: 'completed',
          }),
        ]),
      },
    });
    await expect(fs.readFile(
      path.join(isolation.env.AW_HOME!, 'config-pre-apply-count.txt'),
      'utf8',
    )).resolves.toBe('1');

    definitions[1]!.configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', default: 'safe' } } };
      manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'root', 'scripts', 'preApply.mjs'),
      'await import("node:fs/promises").then((fs) => fs.writeFile(`${process.env.AW_HOME}/root-config-pre-apply.txt`, "ran"));\n',
    );
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await timing.measure('catalog', 'source sync', () => syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    }));
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity: await calculateCatalogSourceIdentity(source),
      logicalIdentity,
      pluginName: 'root',
      scope: 'user',
      platform: 'codex',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { mode: 7 },
    });
    const rootScriptEvidence = await tuiDependencies.captureEvidence({
      kind: 'configSave',
      pluginId: 'team/root',
      scope: 'user',
      context: 'project',
      platform: 'codex',
      apply: true,
      updates: { mode: 'strict' },
      changes: [{ key: 'mode', title: 'mode', before: 7, after: 'strict' }],
    });
    expect(rootScriptEvidence.config?.preApplyAuthorization).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/root', relation: 'requested' }),
      expect.objectContaining({ pluginId: 'team/leaf', relation: 'direct' }),
    ]));
    const outputsBeforeRootUnauthorized = await readOutputs();
    const rootUnauthorized = createCapturedCliIo();
    expect(await timing.measure('command', 'plugin config set', () => runCli([
      'plugin', 'config', 'set', 'team/root', 'mode', '--value-json', '"strict"',
      '--context', 'project', '--platform', 'codex', '--apply', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: rootUnauthorized.io,
      interactive: false,
      nativeCliRunner,
    }))).toBe(1);
    expect(JSON.parse(rootUnauthorized.readStdout()), rootUnauthorized.readStdout()).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'partial',
      apply: { state: 'unavailable', targetResults: [],
        error: expect.objectContaining({ code: 'preApplyAuthorizationRequired' }) },
    });
    expect(await readOutputs()).toEqual(outputsBeforeRootUnauthorized);
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'config-pre-apply-count.txt'), 'utf8'))
      .resolves.toBe('1');
    await expect(readPluginConfigStore({ sourceId: 'team', sourceIdentity: await calculateCatalogSourceIdentity(source),
      logicalIdentity, pluginName: 'root', scope: 'user', platform: 'codex',
      cwd: isolation.layout.fixtureCwd, env: isolation.env })).resolves.toMatchObject({ values: { mode: 'strict' } });
    await expect(fs.pathExists(
      path.join(isolation.env.AW_HOME!, 'root-config-pre-apply.txt'),
    )).resolves.toBe(false);
    const rootAuthorized = createCapturedCliIo();
    expect(await timing.measure('command', 'plugin config apply', () => runCli([
      'plugin', 'config', 'apply', 'team/root', '--context', 'project', '--target', 'codex', '--yes', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: rootAuthorized.io,
      interactive: false,
      nativeCliRunner,
    })), rootAuthorized.readStdout()).toBe(0);
    await expect(fs.readFile(
      path.join(isolation.env.AW_HOME!, 'root-config-pre-apply.txt'),
      'utf8',
    )).resolves.toBe('ran');
  }, 30_000);

  it('runs a shared dependency preApply once per config command across user and project roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'config-shared-pre-apply-source');
    const controlPath = path.join(isolation.env.AW_HOME!, 'config-shared-pre-apply-control.txt');
    const counterPath = path.join(isolation.env.AW_HOME!, 'config-shared-pre-apply-count.txt');
    const definitions: Array<{
      name: string;
      dependencies?: string[];
      configureManifest?: (manifest: PluginMeta['manifest']) => void;
    }> = [
      { name: 'leaf' },
      {
        name: 'root',
        dependencies: ['leaf'],
        configureManifest: (manifest) => {
          manifest.config = { schemaVersion: 5,
            fields: { mode: { type: 'string', default: 'safe' } },
          };
        },
      },
    ];
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const nativeCliRunner = runtime.nativeCliRunner;
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    for (const scope of ['user', 'project'] as const) {
      const installed = await installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope,
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    }
    const visible = await statusCommandV8({
      plugins: ['team/root'],
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      cliVersion: '1.0.0',
      platform: 'codex',
      json: true,
    });
    expect(visible.payload.targets[0]!.placements.map((placement) => statusTargetIntent(placement)))
      .toEqual([
        { enabled: true, scopes: ['project'], relation: 'root' },
        { enabled: true, scopes: ['user'], relation: 'root' },
      ]);

    definitions[0]!.configureManifest = (manifest) => {
      manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
    };
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'leaf', 'scripts', 'preApply.mjs'),
      [
        'import { readFile, writeFile } from "node:fs/promises";',
        'const context = JSON.parse(await new Promise((resolve) => { let data = ""; process.stdin.on("data", (chunk) => { data += chunk; }); process.stdin.on("end", () => resolve(data)); }));',
        'if (context.target.scope !== "user") throw new Error("shared leaf used the wrong scope");',
        `const counter = ${JSON.stringify(counterPath)};`,
        'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
        'await writeFile(counter, String(previous + 1));',
        `if (await readFile(${JSON.stringify(controlPath)}, "utf8").catch(() => "ok") === "fail") {`,
        '  throw new Error("shared dependency preApply failed");',
        '}',
      ].join('\n'),
    );
    await createNativeDependencyCatalog(sourceRoot, definitions);
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });

    const applyMode = async (mode: string) => {
      const output = createCapturedCliIo();
      const exitCode = await runCli([
        'plugin', 'config', 'set', 'team/root', 'mode', '--value-json', JSON.stringify(mode),
        '--context', 'project', '--platform', 'codex', '--apply', '--yes', '--json',
      ], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: output.io,
        interactive: false,
        nativeCliRunner,
      });
      return {
        exitCode,
        receipt: JSON.parse(output.readStdout()) as {
          configWrite: string;
          overallState: string;
          apply: { targetResults: Array<{ target: { pluginId?: string }; errorCode?: string }> };
        },
      };
    };

    const succeeded = await applyMode('fast');
    expect(succeeded.exitCode, JSON.stringify(succeeded.receipt)).toBe(0);
    expect(succeeded.receipt, JSON.stringify(succeeded.receipt)).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: {
        state: 'succeeded',
        targetResults: expect.arrayContaining([
          expect.objectContaining({
            target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }),
            action: 'refresh', state: 'completed',
          }),
          expect.objectContaining({
            target: expect.objectContaining({ pluginId: 'team/root', scope: 'user' }),
            action: 'refresh', state: 'completed',
          }),
        ]),
      },
    });
    expect(succeeded.receipt.apply.targetResults).not.toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ scope: 'project' }),
    }));
    await expect(fs.readFile(counterPath, 'utf8')).resolves.toBe('1');

    const outputRoots = [isolation.env.CODEX_HOME!, path.join(isolation.env.AW_HOME!, 'marketplaces', 'team'),
      path.join(isolation.layout.fixtureCwd, '.codex')];
    const readOutputs = () => Promise.all(outputRoots.map(async (root) => await fs.pathExists(root)
      ? snapshotRegularTree(root) : null));
    const outputsBeforeFailure = await readOutputs();
    await fs.outputFile(controlPath, 'fail');
    const failed = await applyMode('strict');
    expect(failed.exitCode).toBe(1);
    expect(failed.receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'partial',
    });
    expect(failed.receipt.apply.targetResults, JSON.stringify(failed.receipt)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }),
        action: 'refresh', state: 'failed', errorCode: 'preApplyFailed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root', scope: 'user' }),
        action: 'refresh', state: 'skipped', errorCode: 'dependencyApplyFailed',
      }),
    ]));
    expect(await readOutputs()).toEqual(outputsBeforeFailure);
    await expect(fs.readFile(counterPath, 'utf8')).resolves.toBe('2');

    const nextCommand = await applyMode('again');
    expect(nextCommand.exitCode).toBe(1);
    expect(await readOutputs()).toEqual(outputsBeforeFailure);
    await expect(fs.readFile(counterPath, 'utf8')).resolves.toBe('3');
    for (const scope of ['user', 'project'] as const) {
      expect((await readIntentFixture({ scope, cwd: isolation.layout.fixtureCwd, env: isolation.env })).roots)
        .toEqual([expect.objectContaining({ pluginId: 'team/root' })]);
    }
  }, 30_000);

  it('keeps a dual-platform dependency on the platform required by a Codex-only root', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'platform-closure-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      {
        name: 'root',
        dependencies: ['leaf'],
        configureManifest: (manifest) => {
          manifest.platforms = ['codex'];
        },
      },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'agent-cli 99.0.0', stderr: '' }),
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.rebuildResults.every((entry) => entry.target.platform === 'codex')).toBe(true);
    expect(result.receiptTargets).toEqual([
      expect.objectContaining({ pluginId: 'team/leaf', platform: 'codex' }),
      expect.objectContaining({ pluginId: 'team/root', platform: 'codex' }),
    ]);
    expect(result.dependencyPlan?.targets.find((target) => target.pluginId === 'team/leaf'))
      .toMatchObject({ platform: 'codex', requiredBy: ['team/root'] });
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.claude'))).resolves.toBe(false);
  });

  it('reuses one successful renderer result per target during execution', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const runtime = { env: isolation.env, ...await createCodexNativeTestRuntime(isolation) };
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'prepared-renderer-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'prepared-renderer-counts');
    await fs.ensureDir(counterRoot);
    const configure = (roleKey: string) => (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-role', platform: 'codex', scopes: ['project'],
          target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present'], refreshKeys: [], roleKey,
        }],
      };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configure('leaf-role') },
      { name: 'root', dependencies: ['leaf'], configureManifest: configure('root-role') },
    ]);
    await Promise.all([
      writeDynamicRoleRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'leaf'),
        roleKey: 'leaf-role',
        counterRoot,
      }),
      writeDynamicRoleRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'root'),
        roleKey: 'root-role',
        counterRoot,
      }),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configure('leaf-role') },
      { name: 'root', dependencies: ['leaf'], configureManifest: configure('root-role') },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.readFile(path.join(counterRoot, 'render-count-leaf.txt'), 'utf8'))
      .resolves.toBe('1');
    await expect(fs.readFile(path.join(counterRoot, 'render-count-root.txt'), 'utf8'))
      .resolves.toBe('1');
    await expect(syncWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(reinstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    for (const pluginName of ['leaf', 'root']) {
      await expect(fs.readFile(path.join(counterRoot, `render-count-${pluginName}.txt`), 'utf8'))
        .resolves.toBe('3');
    }
  });

  it('rejects a reviewed preApply target after a save-only effective config change', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'reviewed-config-stale-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    await Promise.all([
      fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
        'console.log(JSON.stringify({ version: 2, artifacts: [{',
        '  id: "instruction", kind: "instruction", platform: "codex",',
        '  target: "codex.developerInstructionsBlock", state: "present",',
        '  refreshKeys: [], content: "reviewed output"',
        '}] }));',
      ].join('\n')),
      fs.outputFile(path.join(pluginRoot, 'scripts', 'preApply.mjs'), [
        'import { writeFile } from "node:fs/promises";',
        'await writeFile(`${process.env.AW_HOME}/pre-apply-ran.txt`, "ran\\n");',
      ].join('\n')),
    ]);
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = {
        fields: {
          mode: { type: 'string', default: 'safe' },
        },
      };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        preApply: { path: './scripts/preApply.mjs' },
      };
      manifest.artifacts = {
        targets: [{
          id: 'instruction', platform: 'codex', scopes: ['project'],
          target: 'codex.developerInstructionsBlock', states: ['present'],
          refreshKeys: [], requiresCodexProjectConfig: true,
        }],
      };
      manifest.platforms = ['codex'];
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'codex-cli 0.200.0',
      stderr: '',
    }));
    const runtime = { env: isolation.env, nativeCliRunner };
    const reviewed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, previewOperationPlan: true });

    expect(reviewed.operationPlan?.evidence.configDigests).toEqual([{
      pluginId: 'team/demo',
      scope: 'project',
      platform: 'codex',
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    }]);
    const reviewedActions = reviewed.operationPlan?.actions ?? [];
    const preApplyIndex = reviewedActions.findIndex((action) => action.kind === 'runPreApply');
    const firstTargetWriteIndex = reviewedActions.findIndex((action) =>
      action.kind === 'ensureNativeRegistration'
      || action.kind === 'writeOwnedArtifact'
      || action.kind === 'updateSharedConfig'
      || action.kind === 'setActivation');
    expect(preApplyIndex).toBeGreaterThanOrEqual(0);
    expect(preApplyIndex).toBeLessThan(firstTargetWriteIndex);
    const configWrite = createCapturedCliIo();
    expect(await runCli([
      'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"strict"', '--context', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: configWrite.io,
      interactive: false,
      nativeCliRunner,
    })).toBe(0);
    expect(JSON.parse(configWrite.readStdout())).toMatchObject({
      receiptSchemaVersion: 7,
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested', targetResults: [] },
    });
    const intentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await addProjectFixtureRoots({ cwd: isolation.layout.fixtureCwd, env: isolation.env, selectors: ['team/demo'] });
    const intentBeforeExecution = await readFixtureRequirements(intentLocation);
    const nativeCallsBeforeExecution = nativeCliRunner.mock.calls.length;

    const stale = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      ...runtime,
      expectedPlanFingerprint: reviewed.operationPlan!.planFingerprint,
      preApplyConfirmed: true,
    });

    expect(stale.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'operationPlanStale', state: 'failed' }),
    ]);
    await expect(readFixtureRequirements(intentLocation)).resolves.toEqual(intentBeforeExecution);
    await expect(readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      logicalIdentity,
      pluginName: 'demo',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ values: { mode: 'strict' } });
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'pre-apply-ran.txt')))
      .resolves.toBe(false);
    const nativeWriteCalls = nativeCliRunner.mock.calls.slice(nativeCallsBeforeExecution)
      .filter(([invocation]) => invocation.args.some((arg) =>
        arg === 'add' || arg === 'remove'));
    expect(nativeWriteCalls).toEqual([]);
  });

  it('previews and cleans selected live ownership without running the current Active renderer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-offline-renderer-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-offline-renderer-counts');
    await fs.ensureDir(counterRoot);
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-role', platform: 'codex', scopes: ['user'],
          target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present'], refreshKeys: [], roleKey: 'demo-role',
        }],
      };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    await writeDynamicRoleRenderer({ pluginRoot, roleKey: 'demo-role', counterRoot });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = { env: isolation.env, ...await createCodexNativeTestRuntime(isolation) };
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    await writeDynamicRoleRenderer({ pluginRoot, roleKey: 'demo-role', fail: true, counterRoot });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const rendererCount = path.join(counterRoot, 'render-count-demo.txt');
    const rolePath = path.join(isolation.env.CODEX_HOME!, 'agents', 'aw-demo-demo-role.toml');

    const preview = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, { ...runtime, previewOperationPlan: true });

    expect(preview.overallState).toBe('succeeded');
    await expect(fs.readFile(rendererCount, 'utf8')).resolves.toBe('1');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);

    const cleaned = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(fs.readFile(rendererCount, 'utf8')).resolves.toBe('1');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);

    const intentLocation = {
      scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await writeIntentFixture(intentLocation, {
      ...await readFixtureRequirements(intentLocation),
      roots: [],
    });
    const alreadyClean = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('cleanup', alreadyClean);

    expect(alreadyClean.overallState, JSON.stringify(alreadyClean.rebuildResults)).toBe('succeeded');
    expect(receipt).toMatchObject({ command: 'cleanup', overallState: 'succeeded' });
    await expect(fs.readFile(rendererCount, 'utf8')).resolves.toBe('1');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
  }, 30_000);

  it('cleans a user target without reading or changing a damaged project Intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-damaged-intent-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-role', platform: 'codex', scopes: ['user'],
        target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present'], refreshKeys: [], roleKey: 'demo-role',
      }] };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    await writeDynamicRoleRenderer({ pluginRoot, roleKey: 'demo-role' });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = { env: isolation.env, ...await createCodexNativeTestRuntime(isolation) };
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const rolePath = path.join(isolation.env.CODEX_HOME!, 'agents', 'aw-demo-demo-role.toml');
    const projectIntentPath = path.join(
      isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json',
    );
    await fs.outputFile(projectIntentPath, '{invalid project Intent\n');
    const projectIntentBefore = await fs.readFile(projectIntentPath);
    await fs.remove(sourceRoot);

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(readFixtureRequirements({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [{ pluginId: 'team/demo', platforms: ['codex'] }] });
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntentBefore);
  });

  it('cleans a selected dependency without reading installed edges, providers, or renderers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-installed-edge-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-installed-edge-counts');
    await fs.ensureDir(counterRoot);
    const leafRoot = path.join(sourceRoot, 'plugins', 'leaf');
    const configureLeaf = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-role', platform: 'codex', scopes: ['project'],
          target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present'], refreshKeys: [], roleKey: 'leaf-role',
        }],
      };
    };
    const configureRoot = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configureLeaf },
      { name: 'root', dependencies: ['leaf'], configureManifest: configureRoot },
    ]);
    await writeDynamicRoleRenderer({ pluginRoot: leafRoot, roleKey: 'leaf-role', counterRoot });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configureLeaf },
      { name: 'root', dependencies: ['leaf'], configureManifest: configureRoot },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const { nativeCliRunner } = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-leaf-leaf-role.toml');
    expect(await fs.pathExists(rolePath)).toBe(true);

    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configureLeaf },
      { name: 'root', dependencies: [], configureManifest: configureRoot },
    ]);
    await writeDynamicRoleRenderer({
      pluginRoot: leafRoot,
      roleKey: 'leaf-role',
      fail: true,
      counterRoot,
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: configureLeaf },
      { name: 'root', dependencies: [], configureManifest: configureRoot },
    ]);
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const intentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await writeIntentFixture(intentLocation, {
      ...await readFixtureRequirements(intentLocation),
      roots: [],
    });
    let providerCalls = 0;
    const result = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner,
      catalogGenerationRuntime: {
        providers: {
          path: async (...args: Parameters<typeof catalogPathProviderInternal.resolve>) => {
            providerCalls += 1;
            return catalogPathProviderInternal.resolve(...args);
          },
          git: async () => {
            providerCalls += 1;
            throw new Error('cleanup must not invoke the Catalog provider');
          },
        },
      },
    });

    expect(result).toMatchObject({ overallState: 'succeeded' });
    expect(providerCalls).toBe(0);
    await expect(fs.readFile(
      path.join(counterRoot, 'render-count-leaf.txt'),
      'utf8',
    )).resolves.toBe('1');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
  }, 30_000);

  it('cleans selected Codex output without running preApply or changing Intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'cleanup-desired-pre-apply-source');
    const definitions: Array<{
      name: string;
      configureManifest?: (manifest: PluginMeta['manifest']) => void;
    }> = [{ name: 'demo' }];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    expect(await fs.readFile(configPath, 'utf8')).toContain('aw-owner-v3:');
    const intentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const intentBefore = await fs.readFile(intentPath);

    definitions[0]!.configureManifest = (manifest) => {
      manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'),
      'await import("node:fs/promises").then((fs) => fs.writeFile(`${process.env.AW_HOME}/cleanup-pre-apply-ran.txt`, "ran"));\n',
    );
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect((await fs.readFile(configPath, 'utf8').catch(() => ''))).not.toContain('aw-owner-v3:');
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    await expect(fs.pathExists(
      path.join(isolation.env.AW_HOME!, 'cleanup-pre-apply-ran.txt'),
    )).resolves.toBe(false);
  }, 30_000);

  it('preserves incomplete, all-zero, and path-mismatched owner markers during force cleanup', async () => {
    const isolation = await configureCatalog();
    const skillsRoot = path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'skills');
    const marker = {
      schemaVersion: 2,
      owner: 'agent-workflows',
      sourceId: 'local',
      sourceIdentity: `sha256:${'a'.repeat(64)}`,
      pluginId: 'local/demo',
      plugin: 'demo',
      artifactKey: 'owned-skill',
      platform: 'claude',
      scope: 'user',
    };
    const fixtures = [
      ['incomplete', { ...marker, sourceIdentity: undefined, artifactKey: 'incomplete' }],
      ['all-zero', { ...marker, sourceIdentity: `sha256:${'0'.repeat(64)}`, artifactKey: 'all-zero' }],
      ['path-mismatch', { ...marker, artifactKey: 'different-directory' }],
    ] as const;
    for (const [directory, value] of fixtures) {
      await fs.outputJson(path.join(skillsRoot, directory, '.agent-workflows-owner.json'), value);
    }

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'claude', scope: 'user', force: true,
    }, { env: isolation.env });

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'forceCleanupPathUnavailable' }),
    ]);
    for (const [directory] of fixtures) {
      await expect(fs.pathExists(path.join(skillsRoot, directory))).resolves.toBe(true);
    }
  });

  it('cleans selected ownership without checking historical dependents after source deletion', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const projectA = isolation.layout.fixtureCwd;
    const projectB = path.join(isolation.layout.rootDir, 'historical-cleanup-project-b');
    const sourceRoot = path.join(projectA, 'historical-cleanup-source');
    const otherRoot = path.join(projectA, 'historical-cleanup-other-source');
    await fs.ensureDir(projectB);
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    await createDependencyCatalogSnapshotFixture(otherRoot, [{ name: 'other' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/leaf'], {
      cwd: projectA, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(installFixturePlugin(['team/root'], {
      cwd: projectA, platform: 'codex', scope: 'project',
      dependencyScopeOverrides: [{ pluginId: 'team/leaf', platform: 'codex', scope: 'user' }],
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const userIntent = { scope: 'user' as const, cwd: projectA, env: isolation.env };
    await writeIntentFixture(userIntent, {
      ...await readFixtureRequirements(userIntent),
      roots: [],
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'other', type: 'path', primary: true, path: otherRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });

    const result = await cleanupWriteCommand(['team/leaf'], {
      cwd: projectB, platform: 'codex', scope: 'user',
    }, runtime);

    expect(result).toMatchObject({ overallState: 'succeeded' });
  }, 30_000);

  it.each([false, true])(
    'ignores obsolete store artifact paths during cleanup (force=%s)',
    async (force) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `obsolete-store-artifact-${force ? 'force' : 'normal'}`,
      );
      const configureV1 = (manifest: PluginMeta['manifest']) => {
        manifest.extensions = {
          agents: [
            { name: 'real-role', description: 'Real role.', prompt: 'Real.' },
            { name: 'obsolete-role', description: 'Obsolete role.', prompt: 'Obsolete.' },
          ],
        };
      };
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configureV1 }]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      };
      await expect(installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const agentsRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'agents');
      const realRole = path.join(agentsRoot, 'aw-demo-real-role.toml');
      const obsoleteRole = path.join(agentsRoot, 'aw-demo-obsolete-role.toml');
      await fs.outputFile(obsoleteRole, 'foreign = true\n');
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{
        name: 'demo',
        configureManifest: (manifest) => {
          manifest.extensions = {
            agents: [{ name: 'real-role', description: 'Real role.', prompt: 'Real.' }],
          };
        },
      }]);
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
      const intent = {
        scope: 'project' as const,
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      };
      await writeIntentFixture(intent, {
        ...await readFixtureRequirements(intent),
        roots: [],
      });

      const result = await cleanupWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'project',
        ...(force ? { force: true } : {}),
      }, runtime);

      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      await expect(fs.pathExists(realRole)).resolves.toBe(false);
      await expect(fs.readFile(obsoleteRole, 'utf8')).resolves.toBe('foreign = true\n');
    },
  );

  it('detects collisions from real renderer output before the first platform write', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const runtime = { env: isolation.env, ...await createCodexNativeTestRuntime(isolation) };
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'rendered-collision-source');
    const counterRoot = path.join(isolation.layout.fixtureCwd, 'rendered-collision-counts');
    await fs.ensureDir(counterRoot);
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-role', platform: 'codex', scopes: ['project'],
          target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present', 'disabled'], refreshKeys: [],
          roleKey: 'shared-role',
        }],
      };
    };
    const plugins = [
      { name: 'first', configureManifest: configure },
      { name: 'second', configureManifest: configure },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    await Promise.all(plugins.map((plugin) => writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', plugin.name),
      roleKey: 'shared-role',
      counterRoot,
    })));
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installFixturePlugin(['team/first', 'team/second'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: 'artifactCollision' }),
    ]));
    await expect(fs.pathExists(path.join(
      isolation.layout.fixtureCwd, '.codex', 'agents',
    ))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toBe(false);
    for (const plugin of plugins) {
      await expect(fs.readFile(path.join(counterRoot, `render-count-${plugin.name}.txt`), 'utf8'))
        .resolves.toBe('1');
    }
  });

  it('fails a dependency renderer and skips its consumer without platform writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const runtime = { env: isolation.env, ...await createCodexNativeTestRuntime(isolation) };
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'renderer-failure-source');
    const configure = (roleKey: string) => (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'dynamic-role', platform: 'codex', scopes: ['project'],
          target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present'], refreshKeys: [], roleKey,
        }],
      };
    };
    const plugins = [
      { name: 'leaf', configureManifest: configure('leaf-role') },
      { name: 'root', dependencies: ['leaf'], configureManifest: configure('root-role') },
      { name: 'independent', configureManifest: configure('independent-role') },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    await Promise.all([
      writeDynamicRoleRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'leaf'), roleKey: 'leaf-role', fail: true,
      }),
      writeDynamicRoleRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'root'), roleKey: 'root-role',
      }),
      writeDynamicRoleRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'independent'), roleKey: 'independent-role',
      }),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, plugins);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installFixturePlugin(['team/root', 'team/independent'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState).toBe('partial');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf' }),
        state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        action: 'skipped',
        errorCode: 'dependencyInstallFailed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/independent' }),
        state: 'completed',
      }),
    ]));
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-root-root-role.toml')))
      .resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-independent-independent-role.toml')))
      .resolves.toBe(true);
  });

  it('preserves malformed selected config while cleanup and uninstall remove owned artifacts', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'invalid-removal-config-source');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.config = { schemaVersion: 5, fields: {},
        platforms: { codex: { fields: { mode: { type: 'string', required: true } } } } };
      manifest.extensions!.agents = [{ name: 'reader', description: 'Reader.', prompt: 'Read changes.' }];
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'cleanup-target', configureManifest: configure },
      { name: 'uninstall-target', configureManifest: configure },
      { name: 'guard-target', configureManifest: configure },
      { name: 'unrelated', configureManifest: configure },
      { name: 'config-only', configureManifest: configure },
      { name: 'no-live-other', configureManifest: configure },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    for (const pluginName of ['cleanup-target', 'uninstall-target', 'guard-target']) {
      await writePluginConfigStore({
        sourceId: 'team', sourceIdentity, logicalIdentity, pluginName, platform: 'codex', scope: 'user',
        cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { mode: 'valid' },
      });
    }
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin([
      'team/cleanup-target', 'team/uninstall-target', 'team/guard-target',
    ], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const rolePath = (pluginName: string) => path.join(isolation.layout.fixtureCwd, '.codex',
      'agents', `aw-${pluginName}-reader.toml`);
    for (const pluginName of ['cleanup-target', 'uninstall-target']) {
      await expect(fs.pathExists(rolePath(pluginName))).resolves.toBe(true);
      await fs.outputFile(resolvePluginConfigStorePath({
        sourceId: 'team', pluginName, scope: 'project',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      }), '{malformed');
    }

    const cleaned = await cleanupWriteCommand(['team/cleanup-target'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    const cleanupConfigPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'cleanup-target', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    expect(cleaned.warnings.some((warning) => warning.includes('pluginConfigPreserved')),
      JSON.stringify(cleaned.warnings)).toBe(true);
    expect(cleaned.rebuildResults.some((result) => result.removed.length > 0)).toBe(true);
    await expect(fs.pathExists(rolePath('cleanup-target'))).resolves.toBe(false);
    await expect(fs.readFile(cleanupConfigPath, 'utf8')).resolves.toBe('{malformed');
    await fs.unlink(cleanupConfigPath);

    const uninstalled = await uninstallWriteCommand(['team/uninstall-target'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(uninstalled.overallState, JSON.stringify(uninstalled.rebuildResults)).toBe('succeeded');
    expect(uninstalled.warnings.some((warning) => warning.includes('pluginConfigPreserved')),
      JSON.stringify(uninstalled.warnings)).toBe(true);
    expect(uninstalled.rebuildResults.some((result) => result.removed.length > 0)).toBe(true);
    await expect(fs.pathExists(rolePath('uninstall-target'))).resolves.toBe(false);
    const uninstallConfigPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'uninstall-target', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await expect(fs.readFile(uninstallConfigPath, 'utf8')).resolves.toBe('{malformed');
    await fs.unlink(uninstallConfigPath);

    const configOnlyPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'config-only', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await fs.outputFile(configOnlyPath, '{config-only-malformed');
    const configOnlyPlatformBefore = await snapshotRegularTree(path.join(isolation.layout.fixtureCwd, '.codex'));
    const configOnlyNativeCallsBefore = runtime.nativeCliRunner.mock.calls.length;
    const configOnlyCleanup = await cleanupWriteCommand(['team/config-only'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(configOnlyCleanup.overallState).toBe('succeeded');
    expect(configOnlyCleanup.rebuildResults).toEqual([]);
    expect(configOnlyCleanup.targetResults).toEqual([]);
    await expect(fs.readFile(configOnlyPath, 'utf8')).resolves.toBe('{config-only-malformed');
    await expect(snapshotRegularTree(path.join(isolation.layout.fixtureCwd, '.codex')))
      .resolves.toEqual(configOnlyPlatformBefore);
    expect(runtime.nativeCliRunner.mock.calls.slice(configOnlyNativeCallsBefore)
      .every(([invocation]) => invocation.args.includes('--version')
        || invocation.args[invocation.args.indexOf('plugin') + 1] === 'list'
          && invocation.args.includes('--marketplace') && invocation.args.includes('--json'))).toBe(true);

    const unrelatedNoLive = await cleanupWriteCommand(['team/no-live-other'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(unrelatedNoLive.overallState).toBe('succeeded');
    expect(unrelatedNoLive.targetResults).toEqual([]);
    await expect(fs.readFile(configOnlyPath, 'utf8')).resolves.toBe('{config-only-malformed');

    await fs.outputFile(resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'unrelated', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }), '{unrelated-malformed');
    const guarded = await uninstallWriteCommand(['team/guard-target'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(guarded.overallState).toBe('failed');
    expect(guarded.targetResults).toContainEqual(expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'team/guard-target' }),
      state: 'failed',
      errorCode: 'stateInventoryFailed',
    }));
    await expect(fs.pathExists(rolePath('guard-target'))).resolves.toBe(true);
  });

  it('adds a missing dependency when sync --all starts from intent roots', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'upgrade-all-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root' },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    const projectInstall = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(projectInstall.overallState, JSON.stringify(projectInstall.rebuildResults)).toBe('succeeded');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });

    const upgraded = await syncFixturePlugin([], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      platform: 'codex', scope: 'project', all: true, interactive: false,
    }, runtime);

    expect(upgraded.overallState, JSON.stringify(upgraded.rebuildResults)).toBe('succeeded');
    expect(upgraded.dependencyPlan?.requestedPluginIds).toEqual(['team/root']);
    expect(upgraded.rebuildResults.map((entry) => entry.target.pluginName)).toEqual(['leaf', 'root']);
    expect(upgraded.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/leaf', relation: 'dependency', action: 'install' }),
    ]));
  });

  it('keeps the blocked dependency identity and reason in TUI preparation diagnostics', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-blocked-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf', configureManifest: (manifest) => {
        manifest.extensions = { agents: [{
          name: 'leaf-role', description: 'Leaf role.', prompt: 'Use leaf.',
        }] };
      } },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env,
    });
    const foreignPath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-leaf-leaf-role.toml');
    await fs.outputFile(foreignPath, 'developer_instructions = "foreign"\n');
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    }));
    const controller = new TuiController(dependencies);
    const plan = await controller.prepareScopedTask({
      kind: 'recovery', command: 'install', selectors: ['team/root'],
      scope: 'project',
    });
    expect(plan.kind).toBe('recovery');
    expect(plan.plan.receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/root', blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'artifactCollision' }),
      ]) }),
    ]));
    expect(plan.plan.receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/leaf', blockers: expect.arrayContaining([
        expect.objectContaining({ code: 'artifactCollision' }),
      ]) }),
    ]));
    await controller.discardScopedPlan(plan);
    controller.dispose();
    await expect(fs.readFile(foreignPath, 'utf8')).resolves.toBe('developer_instructions = "foreign"\n');
  });

  it.each([['user', ['codex']], ['project', ['codex']], ['project', ['codex', 'claude']]] as const)('previews the complete dependency closure for saved machine targets in %s %s', async (scope, platforms) => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: [...platforms],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-placement-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'team', type: 'path', primary: true, path: sourceRoot },
    ] }, expectedDigest: snapshot.digest, env: isolation.env });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    }));
    const controller = new TuiController(dependencies);
    const originalPreferences = await observePreferences({ scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env });
    const plan = await controller.prepareScopedTask({ kind: 'recovery', command: 'install',
      selectors: ['team/root'], scope });
    if (plan.kind !== 'recovery') throw new Error('Expected recovery plan');
    expect(plan.plan.receipt.selection).toMatchObject({ agents: [...platforms].sort(), origin: 'preference' });
    expect(plan.plan.receipt.requestedTargets.map(({ pluginId, agent, scope }) =>
      `${pluginId}#${agent}#${scope}`).sort()).toEqual(platforms.flatMap((platform) =>
      ['team/leaf', 'team/root'].map((pluginId) => `${pluginId}#${platform}#${scope}`)).sort());
    expect(await observeIntent({ scope, cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .toMatchObject({ state: 'absent' });
    expect(await observePreferences({ scope, cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .toEqual(originalPreferences);
    await controller.discardScopedPlan(plan);
    controller.dispose();
  });

  it.each(['save', 'cancel', 'stale', 'write-failure'] as const)(
    'preserves machine preferences across a reviewed TUI install %s', async (outcome) => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const sourceRoot = path.join(location.cwd, 'tui-save-placement-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(location.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'team', type: 'path', primary: true, path: sourceRoot },
    ] }, expectedDigest: snapshot.digest, env: location.env });
    const retainedExclusion = { plugin: 'other/retained', target: 'claude' as const };
    await writePreferences(location, { ...createEmptyPreferences(), targets: ['codex'],
      exclusions: [retainedExclusion] });
    const prefsPath = await resolvePreferencesPath(location);
    expect(await resolvePreferencesPath({ ...location, scope: 'user' })).toBe(prefsPath);
    const original = await fs.readFile(prefsPath);
    const intentPath = await resolveIntentPath(location);
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      ...location, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    }));
    const controller = new TuiController(dependencies);
    const plan = await controller.prepareScopedTask({ kind: 'recovery', command: 'install',
      selectors: ['team/root'], scope: 'project' });
    if (plan.kind !== 'recovery') throw new Error('Expected recovery plan');
    expect(plan.plan.plannedImpact.preferences).toBe(false);
    expect(plan.plan.receipt.selection).toMatchObject({ agents: ['codex'], origin: 'preference' });
    expect(await fs.readFile(prefsPath)).toEqual(original);
    expect(await observeIntent(location)).toMatchObject({ state: 'absent' });
    if (outcome === 'cancel') {
      await controller.discardScopedPlan(plan);
      expect(await observeIntent(location)).toMatchObject({ state: 'absent' });
    } else {
      if (outcome === 'stale') await fs.appendFile(prefsPath, '\n');
      if (outcome === 'write-failure') setAtomicConfigBeforeRenameHookForTests(async (filePath) => {
        if (filePath === intentPath) throw new Error('fixtureIntentWriteFailure');
      });
      if (outcome === 'write-failure') {
        try {
          await expect(controller.executeScopedTask(plan)).rejects.toThrow('fixtureIntentWriteFailure');
        } finally {
          setAtomicConfigBeforeRenameHookForTests(undefined);
        }
        expect(await observeIntent(location)).toMatchObject({ state: 'absent' });
      } else {
        const result = await controller.executeScopedTask(plan);
        if (result.kind !== 'recovery') throw new Error('Expected recovery receipt');
        if (outcome === 'stale') {
          expect(result.receipt).toMatchObject({ declarationChanged: false, preferencesChanged: false,
            outputsMayHaveChanged: false, blockers: [expect.objectContaining({ code: 'operationReviewStale' })] });
          expect(await observeIntent(location)).toMatchObject({ state: 'absent' });
        } else {
          expect(result.receipt).toMatchObject({ ok: true, declarationChanged: true, preferencesChanged: false });
          expect(await observeIntent(location)).toMatchObject({ state: 'valid', value: {
            roots: [{ pluginId: 'team/root' }],
          } });
          expect(await observePreferences(location)).toMatchObject({ state: 'valid', value: {
            schemaVersion: 2, targets: ['codex'], exclusions: [retainedExclusion],
          } });
        }
      }
    }
    expect(await fs.readFile(prefsPath)).toEqual(outcome === 'stale'
      ? Buffer.from(original.toString() + '\n') : original);
    if (outcome !== 'save') expect(await fs.pathExists(path.join(location.cwd, '.codex'))).toBe(false);
    controller.dispose();
  });

  it('executes dependency installation through the reviewed TUI backend', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    }));
    const plan = await dependencies.prepareScopedTask({
      kind: 'recovery', command: 'install', selectors: ['team/root'],
      scope: 'project',
    }, new AbortController().signal);
    expect(plan.kind).toBe('recovery');
    const result = await dependencies.executeScopedTask(plan);
    expect(result).toMatchObject({ kind: 'recovery', receipt: { ok: true } });
    if (result.kind !== 'recovery') throw new Error('Expected recovery receipt.');
    expect(result.receipt.targetResults).toEqual([expect.objectContaining({
      pluginId: 'team/leaf', agent: 'codex', scope: 'project', execution: 'applied',
      requiredBy: ['team/root'], blockers: [],
    }), expect.objectContaining({
      pluginId: 'team/root', execution: 'applied',
      backend: expect.objectContaining({
        resolvedPluginIds: ['team/leaf', 'team/root'],
        dependencyEdges: [{ from: 'team/root', to: 'team/leaf', platform: 'codex' }],
      }),
    })]);
  });

  it('fails closed before a dependency write when the operation plan no longer matches', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-dependency-plan-stale-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    const preview = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, previewOperationPlan: true });
    const stalePlan = {
      ...preview.dependencyPlan!,
      resolvedPluginIds: ['team/root'],
    };

    const result = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, expectedPlanFingerprint: 'sha256:stale' });

    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'operationPlanStale', state: 'failed' }),
      expect.objectContaining({ errorCode: 'operationPlanStale', state: 'failed' }),
    ]);
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toBe(false);
  });

  it('runs TUI project install and cleanup while retaining the declared root', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-inventory-owner-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    }));
    const installPlan = await dependencies.prepareScopedTask!({
      kind: 'recovery', scope: 'project', command: 'install', selectors: ['team/demo'],
    }, new AbortController().signal);
    const installed = await dependencies.executeScopedTask!(installPlan);
    expect(installed).toMatchObject({ kind: 'recovery', receipt: { ok: true } });
    const cleanupPlan = await dependencies.prepareScopedTask!({
      kind: 'recovery', scope: 'project', command: 'cleanup', selectors: ['team/demo'],
    }, new AbortController().signal);
    const cleaned = await dependencies.executeScopedTask!(cleanupPlan);
    expect(cleaned).toMatchObject({ kind: 'recovery', receipt: { ok: true } });
    await expect(readFixtureRequirements({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .resolves.toMatchObject({ roots: [{ pluginId: 'team/demo' }] });
  });

  it('rejects a stale TUI recovery plan before changing an already advanced target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-inventory-stale-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const context = createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    });
    const dependencies = createTuiControllerDependencies(context);
    const plan = await dependencies.prepareScopedTask!({
      kind: 'recovery', scope: 'project', command: 'install', selectors: ['team/demo'],
    }, new AbortController().signal);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, context)).resolves.toMatchObject({ overallState: 'succeeded' });
    const targetPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const before = await fs.readFile(targetPath, 'utf8');
    const beforeMtime = (await fs.stat(targetPath)).mtimeMs;
    await expect(dependencies.executeScopedTask!(plan)).resolves.toMatchObject({
      kind: 'recovery', receipt: {
        ok: false, outputsMayHaveChanged: false,
        blockers: [expect.objectContaining({ code: 'operationReviewStale' })],
      },
    });
    await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe(before);
    await expect(fs.stat(targetPath)).resolves.toMatchObject({ mtimeMs: beforeMtime });
  });

  it('reviews exact force cleanup through the real controller and rejects changed output evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const sourceRoot = path.join(location.cwd, 'tui-force-owned-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: (manifest) => {
      manifest.extensions = { agents: [{ name: 'reviewer', description: 'Review.', prompt: 'Review changes.' }] };
    } }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(location.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'team', type: 'path', primary: true, path: sourceRoot },
    ] }, expectedDigest: snapshot.digest, env: location.env });
    const context = createCliExecutionContext({ ...location, interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }) });
    const dependencies = createTuiControllerDependencies(context);
    const controller = new TuiController(dependencies);
    const agentPath = path.join(location.cwd, '.codex', 'agents', 'aw-demo-reviewer.toml');
    const foreignPath = path.join(location.cwd, '.codex', 'agents', 'foreign.toml');
    await fs.outputFile(agentPath, '# agent-workflows-owner: {invalid\nowned damaged output\n');
    await fs.outputFile(foreignPath, 'foreign bytes\n');
    const original = await fs.readFile(agentPath);
    const candidate = await controller.getForceCleanupCandidate('team/demo', 'codex', 'project');
    expect(candidate).toMatchObject({ pluginId: 'team/demo', platform: 'codex', scope: 'project', actionCount: 1 });
    const cancelled = await controller.startForceCleanupReview(candidate!);
    expect(cancelled.kind).toBe('recovery');
    await controller.discardScopedPlan(cancelled);
    expect(await fs.readFile(agentPath)).toEqual(original);
    const stale = await controller.startForceCleanupReview(candidate!);
    await fs.appendFile(agentPath, 'changed\n');
    expect(await controller.executeScopedTask(stale)).toMatchObject({ kind: 'recovery', receipt: {
      ok: false, outputsMayHaveChanged: false, blockers: [expect.objectContaining({ code: 'operationReviewStale' })],
    } });
    expect(await fs.readFile(agentPath, 'utf8')).toBe(original.toString() + 'changed\n');
    const reviewed = await controller.startForceCleanupReview(candidate!);
    if (reviewed.kind !== 'recovery') throw new Error('Expected recovery plan');
    expect(reviewed.plan.receipt.requestedTargets).toEqual([
      expect.objectContaining({ pluginId: 'team/demo', agent: 'codex', scope: 'project' }),
    ]);
    const result = await controller.executeScopedTask(reviewed);
    expect(result).toMatchObject({ kind: 'recovery', receipt: { declarationChanged: false, preferencesChanged: false } });
    expect(await fs.pathExists(agentPath)).toBe(false);
    expect(await fs.readFile(foreignPath, 'utf8')).toBe('foreign bytes\n');
    expect(await observeIntent(location)).toMatchObject({ state: 'absent' });
    controller.dispose();
  });

  it('does not offer shared-only force cleanup without an Intent change or exact path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-force-cleanup-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const context = createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      interactive: false,
    });
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, context)).resolves.toMatchObject({ overallState: 'succeeded' });
    const dependencies = createTuiControllerDependencies(context);
    const controller = new TuiController(dependencies);
    await controller.load();
    await expect(controller.getForceCleanupCandidate('team/leaf', 'codex', 'project'))
      .resolves.toBeUndefined();
    controller.dispose();
    await expect(statusCommandV8({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    })).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'ready' })] },
    });
  });

  it.each(['path', 'git'] as const)(
    'blocks a reviewed %s source update at locked evidence capture without writes',
    async (provider) => {
      const isolation = getCurrentSourceTestIsolation();
      await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
        ...createEmptyPreferences(), targets: ['codex'],
      });
      const workRoot = path.join(isolation.layout.fixtureCwd, `tui-${provider}-review-work`);
      const sourceRoot = provider === 'git' ? path.join(workRoot, 'catalog') : workRoot;
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'review A\n', (manifest) => {
        manifest.platforms = ['codex'];
        manifest.extensions = { instructions: [{ name: 'review', title: 'Review',
          content: 'Review source content.' }] };
      });
      let source: CatalogSource;
      if (provider === 'git') {
        const remote = path.join(isolation.layout.fixtureCwd, 'tui-review-remote.git');
        await git(workRoot, ['init', '--initial-branch=main']);
        await git(workRoot, ['config', 'user.email', 'test@example.test']);
        await git(workRoot, ['config', 'user.name', 'AW Test']);
        await git(workRoot, ['add', '.']);
        await git(workRoot, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'review A']);
        await git(isolation.layout.fixtureCwd, ['clone', '--bare', workRoot, remote]);
        source = {
          id: 'team', type: 'git', primary: true, url: remote, subdir: 'catalog',
          refPolicy: { type: 'explicit', ref: 'refs/heads/main' },
        };
      } else {
        source = { id: 'team', type: 'path', primary: true, path: sourceRoot };
      }
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [source] },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
      const dependencies = createTuiControllerDependencies(createCliExecutionContext({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
        interactive: false,
      }));
      const plan = await dependencies.prepareScopedTask!({
        kind: 'recovery', scope: 'project', command: 'install', selectors: ['team/demo'],
        }, new AbortController().signal);
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'review B\n', (manifest) => {
        manifest.platforms = ['codex'];
        manifest.extensions = { instructions: [{ name: 'review', title: 'Review',
          content: 'Review source content.' }] };
      });
      if (provider === 'git') {
        const manifestPath = path.join(sourceRoot, 'catalog-manifest.json');
        const manifest = await fs.readJson(manifestPath);
        manifest.catalogVersion = '2.0.0';
        await fs.writeJson(manifestPath, manifest, { spaces: 2 });
        await git(workRoot, ['add', '.']);
        await git(workRoot, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'review B']);
        await git(workRoot, ['push', source.url, 'HEAD:refs/heads/main']);
      }
    await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
      await expect(dependencies.executeScopedTask!(plan)).resolves.toMatchObject({
        kind: 'recovery', receipt: {
          ok: false, outputsMayHaveChanged: false,
          blockers: [expect.objectContaining({ code: 'operationReviewStale' })],
        },
      });
      await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
        .resolves.toBe(false);
    },
  );

  it('returns a new Review before plugin or config writes when actual source evidence advances', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'tui-actual-source-review');
    const writeSource = async (content: string): Promise<void> => createCatalogSnapshotFixture(
      sourceRoot,
      'demo',
      [],
      `${content}\n`,
      (manifest) => {
        manifest.platforms = ['codex'];
        manifest.extensions = {
          instructions: [{ name: 'review', title: 'Review', content }],
        };
        manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', title: 'Mode' } } };
      },
    );
    await writeSource('review B');
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
    const context = createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    });
    const executeWithSourceAdvance = async (
      intent: Parameters<TuiController['buildOperationReview']>[0],
    ) => {
      await writeSource('review B');
    await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
      const controller = new TuiController(createTuiControllerDependencies(context));
      await controller.load();
      const review = await controller.buildOperationReview(intent);
      await writeSource('actual C');
    await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
      });
      try {
        return await controller.executeOperation(review.reviewToken);
      } finally {
        controller.dispose();
      }
    };

    await writeSource('review B');
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    const dependencies = createTuiControllerDependencies(context);
    const plan = await dependencies.prepareScopedTask!({
      kind: 'recovery', scope: 'project', command: 'install', selectors: ['team/demo'],
    }, new AbortController().signal);
    await writeSource('actual C');
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
    await expect(dependencies.executeScopedTask!(plan)).resolves.toMatchObject({
      kind: 'recovery', receipt: {
        ok: false, outputsMayHaveChanged: false,
        blockers: [expect.objectContaining({ code: 'operationReviewStale' })],
      },
    });
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toBe(false);

    const saveResult = await executeWithSourceAdvance({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', context: 'project',
      updates: { mode: 'strict' },
    });
    expect(saveResult).toMatchObject({ state: 'stale', review: { title: '保存插件设置' } });
    await expect(readPluginConfigStore({
      sourceId: 'team', sourceIdentity, logicalIdentity,
      pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ exists: false });

    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity, logicalIdentity,
      pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { mode: 'preserved' },
    });
    const resetResult = await executeWithSourceAdvance({
      kind: 'configReset', pluginId: 'team/demo', scope: 'user', context: 'project',
    });
    expect(resetResult).toMatchObject({ state: 'stale', review: { title: '重置插件设置' } });
    await expect(readPluginConfigStore({
      sourceId: 'team', sourceIdentity, logicalIdentity,
      pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ exists: true, values: { mode: 'preserved' } });
  });

  it('blocks removal of a dependency after its known live consumer demand is removed', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-removal-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await removeRoot({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }, 'team/root');
    await expect(readIntentFixture({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .resolves.toMatchObject({ roots: [] });
    const blocked = await uninstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(blocked).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({ errorCode: 'dependencyStillRequired' })],
    });

    const removedRoot = await uninstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(removedRoot.overallState, JSON.stringify(removedRoot.rebuildResults)).toBe('succeeded');
  });

  it('force cleanup preserves a shared-only dependency placement', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'force-dependency-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const removed = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, runtime);
    expect(removed).toMatchObject({
      overallState: 'succeeded',
      targetResults: [expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf' }),
        state: 'completed',
      })],
    });

    const partial = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, platform: 'codex', scope: 'project',
    });
    expect(partial.payload.targets.find((target) => target.pluginId === 'team/root')).toMatchObject({
      components: expect.not.arrayContaining([
        expect.objectContaining({ kind: 'dependency', key: 'team/leaf', state: 'absent' }),
      ]),
    });

    const restored = await reinstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    const healthy = await statusCommandV8({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, platform: 'codex', scope: 'project',
    });
    expect(healthy.payload.targets.find((target) => target.pluginId === 'team/root')).toMatchObject({
      components: expect.not.arrayContaining([
        expect.objectContaining({ kind: 'dependency', state: 'absent' }),
      ]),
    });
  });

  it('executes a complete batch uninstall in consumer-first reverse topology', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'batch-removal-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'middle', dependencies: ['leaf'] },
      { name: 'root', dependencies: ['middle'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const removed = await uninstallWriteCommand(['team/leaf', 'team/root', 'team/middle'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(removed.overallState, JSON.stringify(removed.rebuildResults)).toBe('succeeded');
    expect(removed.rebuildResults.map((entry) => entry.target.pluginName)).toEqual([
      'root', 'middle', 'leaf',
    ]);
  });

  it('allows removal when a catalog consumer is absent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'absent-consumer-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'ghost', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const removed = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(removed.overallState, JSON.stringify(removed.rebuildResults)).toBe('succeeded');
    const replacementRoot = path.join(isolation.layout.fixtureCwd, 'absent-consumer-replacement');
    await createDependencyCatalogSnapshotFixture(replacementRoot, [
      { name: 'leaf' },
      { name: 'ghost', dependencies: ['leaf'] },
    ]);
    await expect(updateCatalogSourceCommand({
      sourceId: 'team', update: { path: replacementRoot }, cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ ok: true });
  });

  it.each(['partial', 'error'] as const)(
    'cleans the selected dependency without inspecting a %s consumer',
    async (consumerState) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `consumer-${consumerState}-source`);
      const agent = (name: string) => ({
        name,
        configureManifest: (manifest: Awaited<ReturnType<typeof readPluginManifest>>['manifest']) => {
          manifest.extensions = {
            agents: [
              { name: `${name}-role`, description: `${name} role.`, prompt: `${name}.` },
              ...(name === 'root' ? [{
                name: `${name}-extra`, description: `${name} extra.`, prompt: `${name} extra.`,
              }] : []),
            ],
          };
        },
      });
      await createDependencyCatalogSnapshotFixture(sourceRoot, [
        agent('leaf'),
        { ...agent('root'), dependencies: ['leaf'] },
      ]);
      const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      };
      await expect(installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const rootAgent = path.join(
        isolation.layout.fixtureCwd,
        '.codex',
        'agents',
        'aw-root-root-role.toml',
      );
      await fs.remove(rootAgent);
      if (consumerState === 'error') await fs.ensureDir(rootAgent);

      const blocked = await cleanupWriteCommand(['team/leaf'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime);

      expect(blocked.overallState, JSON.stringify(blocked.rebuildResults)).toBe('succeeded');
      await expect(fs.pathExists(path.join(
        isolation.layout.fixtureCwd,
        '.codex',
        'agents',
        'aw-leaf-leaf-role.toml',
      ))).resolves.toBe(false);
      await expect(fs.pathExists(rootAgent)).resolves.toBe(consumerState === 'error');
    },
  );

  it('keeps a dependency while multiple live consumers reference it', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'multiple-consumer-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'first', dependencies: ['leaf'] },
      { name: 'second', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/first', 'team/second'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const blocked = await uninstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(blocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'dependencyStillRequired' }),
    ]);
  });

  it('uses current manifest edges for live consumer removal protection', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'missing-consumer-contract-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const blocked = await uninstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(blocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'dependencyStillRequired' }),
    ]);

    const batch = await uninstallWriteCommand(['team/leaf', 'team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(batch.overallState, JSON.stringify(batch.rebuildResults)).toBe('succeeded');
    expect(batch.rebuildResults.map((entry) => entry.target.pluginName)).toEqual(['root', 'leaf']);
  });

  it.each(['uninstall', 'cleanup-all'] as const)(
    'applies the command-specific cleanup boundary when the Active graph disagrees with a bundle (%s)',
    async (command) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `untrusted-removal-graph-${command}-source`,
      );
      await createDependencyCatalogSnapshotFixture(sourceRoot, [
        { name: 'leaf' },
        { name: 'root', dependencies: ['leaf'] },
      ]);
      const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [source] },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      };
      await expect(installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      await expect(installFixturePlugin(['team/leaf'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

      const catalogManifestPath = path.join(sourceRoot, 'catalog-manifest.json');
      const catalogManifest = await fs.readJson(catalogManifestPath);
      const rootEntry = catalogManifest.entries.find((entry: { name: string }) => entry.name === 'root');
      rootEntry.dependencies = [];
      await fs.writeJson(catalogManifestPath, catalogManifest, { spaces: 2 });
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
      });
      const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
      await expect(validateCatalogSnapshotTransport(active.snapshotPath)).resolves.toMatchObject({
        snapshotDigest: active.snapshotDigest,
      });

      const intentPath = path.join(
        isolation.layout.fixtureCwd,
        '.agent-workflows',
        'plugin-intents.json',
      );
      const intentBefore = await fs.readFile(intentPath, 'utf8');
      const platformRoot = path.join(isolation.layout.fixtureCwd, '.codex');
      const platformBefore = await snapshotRegularTree(platformRoot);

      if (command === 'uninstall') {
        await expect(uninstallWriteCommand(['team/leaf'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        }, runtime)).resolves.toMatchObject({ overallState: 'failed' });
        await expect(fs.readFile(intentPath, 'utf8')).resolves.toBe(intentBefore);
        await expect(snapshotRegularTree(platformRoot)).resolves.toEqual(platformBefore);
      } else {
        const cleaned = await runRecovery('cleanup', [], {
          scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
          cliVersion: '1.0.0', all: true, targets: ['codex'], yes: true,
        }, runtime);
        expect(cleaned.ok, JSON.stringify(cleaned.targetResults)).toBe(true);
        expect(cleaned.targetResults.map((target) => target.pluginId).sort())
          .toEqual(['team/leaf', 'team/root']);
        await expect(readFixtureRequirements({
          scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        })).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/root' }), expect.objectContaining({ pluginId: 'team/leaf' })]) });
        await expect(snapshotRegularTree(platformRoot)).resolves.not.toEqual(platformBefore);
      }
    },
  );

  it('does not use another project consumer to block an ordinary uninstall', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const projectA = isolation.layout.fixtureCwd;
    const projectB = path.join(isolation.layout.rootDir, 'dependency-project-b');
    registerCurrentTestWritableStateRoot(projectB, 'secondary current project');
    const sourceRoot = path.join(projectA, 'historical-consumer-source');
    await fs.ensureDir(projectB);
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const marketplaceRoots = new Map<string, string>();
    const runtime = { env: isolation.env, nativeCliRunner: async (invocation: NativeCliInvocation) => {
      if (invocation.command === 'claude' && invocation.args[0] === 'plugin') {
        const scopeIndex = invocation.args.indexOf('--scope');
        const scope = scopeIndex === -1 ? 'user' : invocation.args[scopeIndex + 1]!;
        const projectPath = await fs.realpath(invocation.cwd ?? projectA);
        const settingsPath = scope === 'project'
          ? path.join(projectPath, '.claude', 'settings.json')
          : path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'settings.json');
        const pluginsDir = path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'plugins');
        const knownPath = path.join(pluginsDir, 'known_marketplaces.json');
        const installedPath = path.join(pluginsDir, 'installed_plugins.json');
        if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
          const marketplaceRoot = invocation.args[3]!;
          const config = await fs.readJson(path.join(marketplaceRoot, 'config.json')) as {
            marketplaceName: string;
          };
          marketplaceRoots.set(config.marketplaceName, marketplaceRoot);
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          await fs.outputJson(settingsPath, {
            ...settings,
            extraKnownMarketplaces: {
              ...((settings.extraKnownMarketplaces ?? {}) as Record<string, unknown>),
              [config.marketplaceName]: { source: { source: 'directory', path: marketplaceRoot } },
            },
          });
          const known = await fs.readJson(knownPath).catch(() => ({})) as Record<string, unknown>;
          await fs.outputJson(knownPath, {
            ...known,
            [config.marketplaceName]: {
              source: { source: 'directory', path: marketplaceRoot },
              installLocation: marketplaceRoot,
            },
          });
        }
        if (invocation.args[1] === 'install') {
          const pluginId = invocation.args[2]!;
          const separator = pluginId.lastIndexOf('@');
          const pluginName = pluginId.slice(0, separator);
          const marketplaceName = pluginId.slice(separator + 1);
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          await fs.outputJson(settingsPath, {
            ...settings,
            enabledPlugins: {
              ...((settings.enabledPlugins ?? {}) as Record<string, unknown>),
              [pluginId]: true,
            },
          });
          const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} })) as {
            plugins?: Record<string, unknown>;
          };
          const plugins = { ...(installed.plugins ?? {}) };
          delete plugins[pluginName];
          await fs.outputJson(installedPath, { plugins: {
            ...plugins,
            [pluginId]: [{
              name: pluginName, scope,
              ...(scope === 'project' ? { projectPath } : {}), version: '1.0.0',
            }],
          } });
          await fs.ensureDir(path.join(marketplaceRoots.get(marketplaceName)!, 'plugins', pluginName));
        }
        if (invocation.args[1] === 'uninstall') {
          const pluginId = invocation.args[2]!;
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          const enabledPlugins = { ...((settings.enabledPlugins ?? {}) as Record<string, unknown>) };
          delete enabledPlugins[pluginId];
          await fs.outputJson(settingsPath, { ...settings, enabledPlugins });
          const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} })) as {
            plugins?: Record<string, unknown>;
          };
          const plugins = { ...(installed.plugins ?? {}) };
          delete plugins[pluginId];
          await fs.outputJson(installedPath, { plugins });
        }
      }
      return { exitCode: 0, stdout: 'agent-cli 99.0.0', stderr: '' };
    } };
    const userLeaf = await installFixturePlugin(['team/leaf'], {
      cwd: projectA, platform: 'claude', scope: 'user',
    }, runtime);
    expect(userLeaf.overallState, JSON.stringify(userLeaf.rebuildResults)).toBe('succeeded');
    const projectRoot = await installFixturePlugin(['team/root'], {
      cwd: projectA, platform: 'claude', scope: 'project',
    }, runtime);
    expect(projectRoot.overallState, JSON.stringify(projectRoot.rebuildResults)).toBe('succeeded');

    const removed = await uninstallWriteCommand(['team/leaf'], {
      cwd: projectB, platform: 'claude', scope: 'user',
    }, runtime);

    expect(removed.overallState, JSON.stringify(removed.rebuildResults)).toBe('succeeded');
  });

  it('cleans live ownership after source config deletion while uninstall remains catalog dependent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unavailable-removal-source');
    const remainingSourceRoot = path.join(isolation.layout.fixtureCwd, 'remaining-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingSourceRoot, [{ name: 'other' }]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '',
    }));
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const sourceIdentity = installed.rebuildResults[0]!.target.sourceIdentity!;
    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { retained: true },
    });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const before = await fs.readFile(configPath, 'utf8');
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingSourceRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    nativeCliRunner.mockClear();

    const missing = await statusCommandV8({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    expect(missing.payload.targets).toEqual([
      expect.objectContaining({
        state: 'blocked',
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'sourceMissing' }),
          expect.objectContaining({ code: 'codexIntentSourceUnavailable' }),
        ]),
      }),
    ]);
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner,
      interactive: false,
    }));
    const review = await dependencies.prepareScopedTask({
      kind: 'recovery', scope: 'project', command: 'cleanup',
      selectors: ['team/demo'], targets: ['codex'],
    }, new AbortController().signal);
    const execution = await dependencies.executeScopedTask(review);
    expect(execution).toMatchObject({ kind: 'recovery', receipt: {
      command: 'cleanup', ok: true,
    } });
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toBe(before);
    await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain('aw-owner-v3:');
    await expect(readPluginConfigStore({
      sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ values: { retained: true } });
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/demo' })]) });

    const uninstall = await uninstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(uninstall.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'catalogSourceUnavailable' }),
    ]);
  }, 30_000);

  it('removes a deleted native plugin and its shared user activation', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-native-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'official', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const };
    await expect(installFixturePlugin(['official/demo'], options, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const before = await statusCommandV8({
      ...options, plugins: ['demo'], env: isolation.env,
    });
    expect(before.payload.errors).toEqual([]);
    expect(before.payload.targets).toEqual([expect.objectContaining({
      state: 'blocked', reasons: expect.arrayContaining([expect.objectContaining({ code: 'bundleUnavailable' })]),
    })]);
    const retired = await runRetire({
      scope: 'user', cwd: options.cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true,
    }, runtime);
    expect(retired).toMatchObject({ kind: 'aw-recovery', command: 'intent:retire',
      declarationChanged: true, configChanged: false });
    const config = await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml'));
    expect(config.snapshot.plugins['demo@aw']?.enabled).toBe(false);
    expect((await readFixtureRequirements({ scope: 'user', cwd: options.cwd,
      env: isolation.env })).roots).toEqual([]);
    const after = await statusCommandV8({
      ...options, plugins: ['demo'], env: isolation.env,
    });
    expect(after.payload.errors).toEqual([]);
    expect(after.payload.targets).toEqual([expect.objectContaining({
      pluginId: 'official/demo', state: 'blocked',
      reasons: expect.arrayContaining([expect.objectContaining({ code: 'removedPluginCleanupRequired' })]),
    })]);
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      interactive: false,
    })));
    await controller.load();
    expect(controller.listPlugins({ mode: 'browse' }).map((plugin) => plugin.pluginId))
      .toContain('official/demo');
    expect(controller.listPlugins({ mode: 'browse', installFilter: 'uninstalled' })
      .map((plugin) => plugin.pluginId)).not.toContain('official/demo');
    controller.dispose();
  });

  it('reviews both scopes and deletes only the removed plugin settings and Intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-whole-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    await expect(installFixturePlugin(['official/demo'], {
      cwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const active = await resolveActiveCatalogGeneration({ sourceId: 'official', env: isolation.env });
    await writePluginConfigStore({
      sourceId: 'official', sourceIdentity: active.sourceIdentity, logicalIdentity: active.logicalIdentity,
      pluginName: 'demo', scope: 'user', cwd, env: isolation.env, values: { common: true },
    });
    for (const platform of ['codex', 'claude'] as const) {
      await writePluginConfigStore({
        sourceId: 'official', sourceIdentity: active.sourceIdentity,
        logicalIdentity: active.logicalIdentity, pluginName: 'demo', scope: 'user', platform,
        cwd, env: isolation.env, values: { secret: platform },
      });
    }
    await writePluginConfigStore({
      sourceId: 'official', sourceIdentity: active.sourceIdentity,
      pluginName: 'other', scope: 'user', cwd, env: isolation.env,
      values: { retained: true },
    });
    for (const scope of ['user', 'project'] as const) {
      const location = { scope, cwd, env: isolation.env };
      await writeIntentFixture(location, {
        schemaVersion: 2, kind: 'aw-plugin-intents',
        roots: [
          { pluginId: 'official/demo', platforms: ['codex', 'claude'] },
          { pluginId: 'official/other', platforms: ['codex'] },
        ],
        dependencyScopeOverrides: [],
      });
    }
    const preferencesPath = await resolvePreferencesPath({ scope: 'user', cwd, env: isolation.env });
    const preferencesBefore = await fs.readFile(preferencesPath);
    const projectConfigPath = path.join(cwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      upsertPluginActivations: { 'demo@aw': false },
    });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const projectOptions = { scope: 'project' as const, cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'] as const, deleteConfig: false };
    const preview = await prepareRetire(projectOptions, runtime);
    expect(preview.changes).toEqual(expect.arrayContaining([
      expect.stringContaining('删除 project 声明 official/demo'),
    ]));
    const unauthorized = await executeRetire(preview);
    expect(unauthorized.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewRequired' }),
    ]));
    expect((await readFixtureRequirements({ scope: 'project', cwd, env: isolation.env })).roots)
      .toContainEqual({ pluginId: 'official/demo', platforms: ['claude', 'codex'] });
    const stalePreview = await prepareRetire(projectOptions, runtime);
    const preferenceLocation = { scope: 'project' as const, cwd, env: isolation.env };
    const originalPreferences = await observePreferences(preferenceLocation);
    if (originalPreferences.state !== 'valid') throw new Error('Expected valid project preferences.');
    await writePreferences(preferenceLocation, { ...originalPreferences.value, targets: ['codex'] });
    const stale = await executeRetire(stalePreview, { yes: true });
    expect(stale.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewStale' }),
    ]));
    await writePreferences(preferenceLocation, originalPreferences.value);
    const projectRetired = await runRetire({ ...projectOptions, yes: true }, runtime);
    expect(projectRetired).toMatchObject({ kind: 'aw-recovery', command: 'intent:retire',
      scope: 'project', declarationChanged: true, preferencesChanged: false, configChanged: false });
    expect((await readFixtureRequirements({ scope: 'project', cwd, env: isolation.env })).roots)
      .toEqual([{ pluginId: 'official/other', platforms: ['codex'] }]);
    expect((await readFixtureRequirements({ scope: 'user', cwd, env: isolation.env })).roots)
      .toContainEqual({ pluginId: 'official/demo', platforms: ['claude', 'codex'] });
    expect(await fs.pathExists(resolvePluginConfigStorePath({
      sourceId: 'official', pluginName: 'demo', scope: 'project', cwd, env: isolation.env,
    }))).toBe(true);
    const userRetired = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], deleteConfig: true, yes: true }, runtime);
    expect(userRetired).toMatchObject({ kind: 'aw-recovery', command: 'intent:retire',
      scope: 'user', declarationChanged: true, preferencesChanged: false, configChanged: true });
    for (const scope of ['user', 'project'] as const) {
      const state = await readFixtureRequirements({ scope, cwd, env: isolation.env });
      expect(state.roots).toEqual([{ pluginId: 'official/other', platforms: ['codex'] }]);
      expect(state.dependencyScopeOverrides).toEqual([]);
    }
    expect(await fs.pathExists(resolvePluginConfigStorePath({
      sourceId: 'official', pluginName: 'demo', scope: 'user', cwd, env: isolation.env,
    }))).toBe(false);
    expect(await fs.pathExists(resolvePluginConfigStorePath({
      sourceId: 'official', pluginName: 'demo', scope: 'project', cwd, env: isolation.env,
    }))).toBe(false);
    expect((await readPluginConfigStore({
      sourceId: 'official', sourceIdentity: active.sourceIdentity, pluginName: 'other',
      scope: 'user', cwd, env: isolation.env,
    })).values).toEqual({ retained: true });
    await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
    const repeated = await runRetire({ ...projectOptions, yes: true }, runtime);
    expect(repeated.declarationChanged).toBe(false);
  });

  // Test Value Gate: a receipt retry must retain config deletion and the original output target boundary.
  it('retries config deletion through the retirement receipt without expanding output targets', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const sourceRoot = path.join(cwd, 'removed-config-receipt-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: initial.digest, env: isolation.env });
    const runtime = await createClaudeNativeTestRuntime(isolation);
    for (const platform of ['codex', 'claude'] as const) {
      await expect(installFixturePlugin(['team/demo'], { cwd, platform, scope: 'user' }, runtime.runtime))
        .resolves.toMatchObject({ overallState: 'succeeded' });
    }
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
    await writePluginConfigStore({ sourceId: 'team', sourceIdentity: active.sourceIdentity,
      pluginName: 'demo', scope: 'user', cwd, env: isolation.env, values: { retained: true } });
    const configPath = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo',
      scope: 'user', cwd, env: isolation.env });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0',
      env: isolation.env, impactConfirmed: true });
    const claudeSettingsPath = path.join(runtime.claudeHome, 'settings.json');
    const claudeBefore = await fs.readFile(claudeSettingsPath);
    const reset = vi.spyOn(pluginConfig, 'deletePluginConfigStore').mockRejectedValueOnce(
      Object.assign(new Error('injected config deletion failure'), { code: 'configResetFailed' }));
    const failed = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'team/demo', targets: ['codex'], deleteConfig: true, yes: true }, runtime.runtime)
      .finally(() => reset.mockRestore());
    expect(failed).toMatchObject({ ok: false, declarationChanged: true,
      configChanged: false, outputsMayHaveChanged: false,
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'configResetFailed' })]) });
    expect(await fs.pathExists(configPath)).toBe(true);

    const retry = failed.recoveryActions.find((action) => action.startsWith('aw plugin intent retire '));
    expect(retry).toBeDefined();
    const captured = createCapturedCliIo();
    const exitCode = await runCli([...retry!.split(' ').slice(1), '--yes', '--json'], {
      cwd, env: isolation.env, io: captured.io, interactive: false,
      nativeCliRunner: runtime.nativeCliRunner,
    });
    const recovered = JSON.parse(captured.readStdout());
    expect(exitCode, JSON.stringify(recovered)).not.toBe(2);
    expect(recovered).toMatchObject({ command: 'intent:retire', configChanged: true, declarationChanged: false });
    expect(recovered.requestedTargets.map((target: { agent: string }) => target.agent)).toEqual(['codex']);
    expect(recovered.recoveryActions.join('\n')).not.toContain('--delete-config');
    expect(await fs.pathExists(configPath)).toBe(false);
    expect(await fs.readFile(claudeSettingsPath)).toEqual(claudeBefore);
  });

  it('keeps shared Codex output when official observation fails, then retries retirement', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-native-retry-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const selected = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const };
    await expect(installFixturePlugin(['official/demo'], selected, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const workingRunner = runtime.nativeCliRunner.getMockImplementation()!;
    runtime.nativeCliRunner.mockImplementation(async (invocation) =>
      invocation.args.includes('list') && invocation.args.includes('--json')
        ? { exitCode: 1, stdout: '', stderr: 'simulated failure' }
        : workingRunner(invocation));
    const retireOptions = { scope: 'user' as const, cwd: selected.cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true };
    const failed = await runRetire(retireOptions, runtime);
    expect(failed.ok).toBe(false);
    expect(failed.targetResults[0]?.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'sharedNativePreserved' }),
    ]));
    expect(runtime.installed.has('demo@aw')).toBe(true);
    expect(await fs.pathExists(path.join(isolation.env.AW_HOME!, 'marketplaces', 'official', 'plugins', 'demo')))
      .toBe(true);
    runtime.nativeCliRunner.mockImplementation(workingRunner);
    const recovered = await runRetire(retireOptions, runtime);
    expect(recovered.command).toBe('intent:retire');
    expect(runtime.installed.has('demo@aw')).toBe(true);
    expect((await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')))
      .snapshot.plugins['demo@aw']?.enabled).toBe(false);
    expect((await readFixtureRequirements({ scope: 'user', cwd: selected.cwd, env: isolation.env })).roots)
      .toEqual([]);
  });

  it('keeps declarations and the other scope unchanged during mixed ordinary cleanup', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-mixed-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    const user = { cwd, platform: 'codex' as const, scope: 'user' as const };
    for (const pluginId of ['official/demo', 'official/other']) {
      await expect(installFixturePlugin([pluginId], user, runtime))
        .resolves.toMatchObject({ overallState: 'succeeded' });
    }
    const projectConfigPath = path.join(cwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      upsertPluginActivations: { 'demo@aw': false, 'other@aw': false },
    });
    await writeIntentFixture({ scope: 'project', cwd, env: isolation.env }, {
      schemaVersion: 2, kind: 'aw-plugin-intents',
      roots: [
        { pluginId: 'official/demo', platforms: ['codex'] },
        { pluginId: 'official/other', platforms: ['codex'] },
      ],
      dependencyScopeOverrides: [],
    });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const selectors = ['official/demo', 'other'];
    const projectIntentBefore = await observeIntent({
      scope: 'project', cwd, env: isolation.env,
    });
    const userIntentBefore = await observeIntent({
      scope: 'user', cwd, env: isolation.env,
    });
    const projectConfigBefore = await fs.readFile(projectConfigPath);
    const preview = await cleanupWriteCommand(selectors, user, {
      ...runtime, previewOperationPlan: true,
    });
    expect(preview.operationPlan?.actions.some((action) => action.scope === 'project'))
      .toBe(false);
    const cleaned = await cleanupWriteCommand(selectors, { ...user, yes: true }, {
      ...runtime, expectedPlanFingerprint: preview.operationPlan!.planFingerprint,
    });
    expect(cleaned.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ pluginId: 'official/other', scope: 'user', platform: 'codex' }) }),
    ]));
    await expect(observeIntent({ scope: 'project', cwd, env: isolation.env }))
      .resolves.toEqual(projectIntentBefore);
    await expect(observeIntent({ scope: 'user', cwd, env: isolation.env }))
      .resolves.toEqual(userIntentBefore);
    await expect(fs.readFile(projectConfigPath)).resolves.toEqual(projectConfigBefore);
    expect(runtime.installed.has('demo@aw')).toBe(true);
  });

  it('preserves shared Codex projection when official retirement evidence becomes unknown', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-native-unknown-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const selected = { cwd: isolation.layout.fixtureCwd, platform: 'codex' as const, scope: 'user' as const };
    await expect(installFixturePlugin(['official/demo'], selected, runtime))
      .resolves.toMatchObject({ overallState: 'succeeded' });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const workingRunner = runtime.nativeCliRunner.getMockImplementation()!;
    let listCalls = 0;
    runtime.nativeCliRunner.mockImplementation(async (invocation) => {
      const args = invocation.args;
      if (args.includes('list') && args.includes('--json') && ++listCalls > 2) {
        return { exitCode: 1, stdout: '', stderr: 'simulated postcheck unavailable' };
      }
      return workingRunner(invocation);
    });
    const retireOptions = { scope: 'user' as const, cwd: selected.cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true };
    const failed = await runRetire(retireOptions, runtime);
    expect(failed.ok).toBe(false);
    const projection = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official', 'plugins', 'demo');
    expect(await fs.pathExists(projection)).toBe(true);
    expect(runtime.installed.has('demo@aw')).toBe(true);
    runtime.nativeCliRunner.mockImplementation(workingRunner);
    const recovered = await runRetire(retireOptions, runtime);
    expect(recovered.command).toBe('intent:retire');
    expect((await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')))
      .snapshot.plugins['demo@aw']?.enabled).toBe(false);
    expect(await fs.pathExists(projection)).toBe(true);
  });

  it('retires removed Claude demand one scope at a time and preserves the shared package', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-claude-source');
    const definitions = ['demo', 'other'].map((name) => ({
      name,
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['claude'];
      },
    }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const cwd = isolation.layout.fixtureCwd;
    const { runtime, nativeCliRunner, installedPath, claudeHome, projectRoot }
      = await createClaudeNativeTestRuntime(isolation);
    for (const [pluginId, scope] of [
      ['official/demo', 'user'], ['official/demo', 'project'], ['official/other', 'user'],
    ] as const) {
      const installed = await installFixturePlugin([pluginId], { cwd, platform: 'claude', scope }, runtime);
      expect(installed.overallState, JSON.stringify(installed.targetResults)).toBe('succeeded');
    }
    const before = await fs.readJson(installedPath) as { plugins: Record<string, unknown[]> };
    expect(before.plugins['demo@aw']).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'user' }),
      expect.objectContaining({ scope: 'project', projectPath: projectRoot }),
    ]));
    await createNativeDependencyCatalog(sourceRoot, [definitions[1]!]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const projectRetired = await runRetire({ scope: 'project', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['claude'], yes: true }, runtime);
    expect(projectRetired.declarationChanged).toBe(true);
    expect((await readFixtureRequirements({ scope: 'user', cwd, env: isolation.env })).roots)
      .toContainEqual(expect.objectContaining({ pluginId: 'official/demo' }));
    const userRetired = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['claude'], yes: true }, runtime);
    expect(userRetired.declarationChanged).toBe(true);
    expect((await readFixtureRequirements({ scope: 'project', cwd, env: isolation.env })).roots).toEqual([]);
    expect((await readFixtureRequirements({ scope: 'user', cwd, env: isolation.env })).roots)
      .toEqual([expect.objectContaining({ pluginId: 'official/other' })]);
    const uninstallScopes = nativeCliRunner.mock.calls.filter(([invocation]) =>
      invocation.command === 'claude' && invocation.args[0] === 'plugin'
      && invocation.args[1] === 'uninstall' && invocation.args[2] === 'demo@aw')
      .map(([invocation]) => invocation.args[invocation.args.indexOf('--scope') + 1]);
    expect(uninstallScopes).toEqual([]);
    const after = await fs.readJson(installedPath) as { plugins: Record<string, unknown[]> };
    expect(after.plugins['demo@aw']).toEqual(before.plugins['demo@aw']);
    expect(after.plugins['other@aw']).toEqual([expect.objectContaining({ scope: 'user' })]);
    expect((await fs.readJson(path.join(claudeHome, 'settings.json'))).enabledPlugins)
      .toMatchObject({ 'other@aw': true });
    expect(await fs.pathExists(path.join(isolation.env.AW_HOME!, 'marketplaces', 'official', 'plugins', 'other')))
      .toBe(true);
  });

  it.each([
    ['canonical with bare record', 'canonical'],
    ['foreign registration with bare record', 'foreign'],
    ['unreadable marketplace registration', 'unknown'],
  ] as const)('keeps Claude shared native ownership safe during retirement for %s', async (_label, mode) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, `removed-claude-${mode}-source`);
    const definitions = ['demo', 'other'].map((name) => ({
      name,
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['claude'];
      },
    }));
    await createNativeDependencyCatalog(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const cwd = isolation.layout.fixtureCwd;
    const { runtime, nativeCliRunner, installedPath, claudeHome } = await createClaudeNativeTestRuntime(isolation);
    for (const pluginId of ['official/demo', 'official/other']) {
      const installed = await installFixturePlugin([pluginId], {
        cwd, platform: 'claude', scope: 'user',
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.targetResults)).toBe('succeeded');
    }
    if (mode !== 'unknown') {
      const installed = await fs.readJson(installedPath) as {
        plugins: Record<string, Array<Record<string, unknown>>>;
      };
      installed.plugins.demo = [{ name: 'demo', scope: 'user', version: '1.0.0' }];
      await fs.outputJson(installedPath, installed);
    }
    const settingsPath = path.join(claudeHome, 'settings.json');
    if (mode === 'foreign') {
      const settings = await fs.readJson(settingsPath) as Record<string, unknown>;
      const extraKnownMarketplaces = settings.extraKnownMarketplaces as Record<string, unknown>;
      extraKnownMarketplaces.aw = {
        source: { source: 'directory', path: path.join(cwd, 'foreign-marketplace') },
      };
      await fs.outputJson(settingsPath, settings);
    }
    if (mode === 'unknown') {
      await fs.outputFile(path.join(claudeHome, 'plugins', 'known_marketplaces.json'), '{bad json');
    }
    await createNativeDependencyCatalog(sourceRoot, [definitions[1]!]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    nativeCliRunner.mockClear();
    const retired = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['claude'], yes: true }, runtime);
    expect(retired.configChanged).toBe(false);
    const uninstalls = nativeCliRunner.mock.calls.filter(([invocation]) =>
      invocation.command === 'claude' && invocation.args[0] === 'plugin'
      && invocation.args[1] === 'uninstall' && invocation.args[2] === 'demo@aw');
    expect(uninstalls).toHaveLength(0);
    const records = (await fs.readJson(installedPath)).plugins as Record<string, unknown[]>;
    if (mode !== 'unknown') {
      expect(records.demo).toEqual([expect.objectContaining({ name: 'demo' })]);
    }
    expect(records['demo@aw']).toEqual([expect.objectContaining({ name: 'demo' })]);
    expect(records['other@aw']).toEqual([expect.objectContaining({ name: 'other' })]);
    const projection = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official', 'plugins', 'demo');
    expect(await fs.pathExists(projection)).toBe(true);
    if (mode === 'foreign') {
      expect(JSON.stringify(retired.blockers)).toContain('removedPluginClaudeOwnershipConflict');
    }
    if (mode === 'unknown') {
      expect(JSON.stringify(retired.blockers)).toContain('removedPluginMarketplaceRegistrationUnknown');
    }
  });

  it('preserves project activation when the canonical native registration is missing', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-unbound-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    await expect(installFixturePlugin(['official/demo'], {
      cwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    runtime.installed.delete('demo@aw');
    const userConfigPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    await fs.outputFile(userConfigPath,
      removeCodexMarketplace(await fs.readFile(userConfigPath, 'utf8'), 'aw'));
    await applyCodexConfigTransactionFile(userConfigPath, {
      removePluginActivations: ['demo@aw'],
    });
    const projectConfigPath = path.join(cwd, '.codex', 'config.toml');
    await applyCodexConfigTransactionFile(projectConfigPath, {
      upsertPluginActivations: { 'demo@aw': false },
    });
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const result = await runRetire({ scope: 'project', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true }, runtime);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.blockers)).toContain('removedPluginNativeOwnershipUnavailable');
    expect((await readCodexConfigFile(projectConfigPath)).snapshot.plugins['demo@aw']?.enabled)
      .toBe(false);
    expect(await fs.pathExists(path.join(isolation.env.AW_HOME!, 'marketplaces', 'official', 'plugins', 'demo')))
      .toBe(true);
  });

  it('does not delete shared marketplace projection when its remove operation would fail', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-projection-retry-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    await expect(installFixturePlugin(['official/demo'], {
      cwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const projection = path.join(marketplaceRoot, 'plugins', 'demo');
    await fs.remove(path.join(projection, '.agents-plugin'));
    await fs.remove(path.join(projection, '.codex-plugin'));
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const options = { scope: 'user' as const, cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true };
    const removeOriginal = fs.remove.bind(fs);
    let projectionRemoveAttempted = false;
    const remove = vi.spyOn(fs, 'remove').mockImplementation(async (candidate) => {
      if (path.resolve(String(candidate)) === path.resolve(projection)) {
        projectionRemoveAttempted = true;
        throw new Error('simulated projection delete failure');
      }
      return removeOriginal(candidate);
    });
    const first = await runRetire(options, runtime).finally(() => remove.mockRestore());
    expect(projectionRemoveAttempted).toBe(false);
    expect(first.declarationChanged).toBe(true);
    const manifestPath = path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json');
    const manifestBefore = await fs.readFile(manifestPath);
    expect(await fs.pathExists(projection)).toBe(true);
    const second = await runRetire(options, runtime);
    expect(second.declarationChanged).toBe(false);
    await expect(fs.readFile(manifestPath)).resolves.toEqual(manifestBefore);
    expect(await fs.pathExists(projection)).toBe(true);
  });

  it('preserves a foreign tree behind a symlinked marketplace plugins ancestor', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-symlinked-projection-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'official', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const cwd = isolation.layout.fixtureCwd;
    await expect(installFixturePlugin(['official/demo'], {
      cwd, platform: 'codex', scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'official');
    const pluginsRoot = path.join(marketplaceRoot, 'plugins');
    const foreignRoot = path.join(cwd, 'foreign-marketplace-plugins');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'official', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    await fs.move(pluginsRoot, foreignRoot);
    await fs.symlink(foreignRoot, pluginsRoot, 'dir');
    const foreignFile = path.join(foreignRoot, 'demo', 'preserve.txt');
    await fs.outputFile(foreignFile, 'foreign content\n');
    const cleaned = await cleanupWriteCommand(['official/demo'], {
      cwd, platform: 'codex', scope: 'user', yes: true,
    }, runtime);
    expect(cleaned.overallState).toBe('succeeded');
    expect(await fs.readFile(foreignFile, 'utf8')).toBe('foreign content\n');
    const result = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'official/demo', targets: ['codex'], yes: true }, runtime);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result.blockers)).toContain('removedPluginMarketplaceProjectionUnsafe');
    expect(await fs.readFile(foreignFile, 'utf8')).toBe('foreign content\n');
    expect(runtime.installed.has('demo@aw')).toBe(true);
  });

  it.each([['absent', false], ['unknown', false], ['unknown', true]] as const)('retires User demand without reading caller Project Portable and legacy config state (%s, subdirectory=%s)', async (portableState, fromSubdirectory) => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'removed-config-only-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'team', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const cwd = isolation.layout.fixtureCwd;
    if (fromSubdirectory) await git(cwd, ['init']);
    const invocationCwd = fromSubdirectory ? path.join(cwd, 'nested', 'child') : cwd;
    await fs.ensureDir(invocationCwd);
    const userPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'demo', scope: 'user', cwd, env: isolation.env,
    });
    await fs.outputFile(userPath, '{broken-json');
    expect(resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'demo', scope: 'project', cwd, env: isolation.env,
    })).toBe(userPath);
    const projectPath = path.join(cwd, '.agent-workflows', 'plugin-config', 'team', 'demo', 'config.json');
    await fs.outputFile(projectPath, '{broken-project-json');
    await addProjectFixtureRoots({ cwd, env: isolation.env, selectors: ['team/demo'] });
    await writeIntentFixture({ cwd, env: isolation.env, scope: 'user' }, {
      schemaVersion: 2, kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }], dependencyScopeOverrides: [],
    });
    const providerRoot = path.join(cwd, '.agent-workflows', '.local', 'portable', portableJsonDigest('team/demo').slice(7));
    const portableSkill = path.join(cwd, '.agents', 'skills', 'unverified-demo', 'SKILL.md');
    if (portableState === 'unknown') {
      await fs.outputFile(path.join(providerRoot, 'evidence.txt'), 'unverified provider evidence');
      await fs.outputFile(portableSkill, 'portable bytes must remain');
    }
    const binRoot = path.join(isolation.layout.rootDir, 'unavailable-skills-bin');
    await fs.outputFile(path.join(binRoot, 'skills'), `#!${process.execPath}\nprocess.exit(1);\n`, { mode: 0o755 });
    const env = { ...isolation.env, PATH: `${binRoot}${path.delimiter}${isolation.env.PATH ?? ''}` };

    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const projectIntentBefore = await observeIntent({ cwd, env, scope: 'project' });
    const configBefore = await fs.readFile(userPath);
    const projectConfigBefore = await fs.readFile(projectPath);
    const retirement = { cwd: invocationCwd, env, scope: 'user' as const,
      selector: 'team/demo', targets: ['codex'], yes: true };
    const preview = await prepareRetire(retirement, { nativeCliRunner: async () => ({
      exitCode: 0, stdout: '{"installed":[],"available":[]}', stderr: '',
    }) });
    expect(preview.receipt.command).toBe('intent:retire');
    const receipt = await executeRetire(preview, { yes: true });
    expect(receipt).toMatchObject({ kind: 'aw-recovery', scope: 'user',
      declarationChanged: true, configChanged: false });
    if (portableState === 'unknown') {
      await expect(fs.readFile(portableSkill, 'utf8')).resolves.toBe('portable bytes must remain');
      await expect(fs.readFile(path.join(providerRoot, 'evidence.txt'), 'utf8')).resolves.toBe('unverified provider evidence');
    }
    await expect(fs.readFile(userPath)).resolves.toEqual(configBefore);
    await expect(fs.readFile(projectPath)).resolves.toEqual(projectConfigBefore);
    await expect(observeIntent({ cwd, env, scope: 'project' })).resolves.toEqual(projectIntentBefore);
    await expect(readIntentFixture({ cwd, env, scope: 'user' })).resolves.toMatchObject({ roots: [] });
  });

  it('blocks explicit retirement when Active is unavailable and preserves saved config', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unavailable-config-only-source');
    const remainingRoot = path.join(isolation.layout.fixtureCwd, 'unavailable-config-only-remaining');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'team', type: 'path', primary: true, path: sourceRoot,
      }] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
    const cwd = isolation.layout.fixtureCwd;
    await writePluginConfigStore({
      sourceId: 'team', sourceIdentity: active.sourceIdentity,
      pluginName: 'demo', scope: 'user', cwd, env: isolation.env,
      values: { retained: true },
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{
        id: 'remaining', type: 'path', primary: true, path: remainingRoot,
      }] },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    const result = await runRetire({ scope: 'user', cwd, env: isolation.env,
      selector: 'team/demo', targets: ['claude'], yes: true });
    expect(result.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'removedPluginActiveUnavailable' }),
    ]));
    expect(result.configChanged).toBe(false);
    expect((await readPluginConfigStore({
      sourceId: 'team', sourceIdentity: active.sourceIdentity,
      pluginName: 'demo', scope: 'user', cwd, env: isolation.env,
    })).values).toEqual({ retained: true });
  });

  it.each(['directory', 'binding', 'binding-user-catalog', 'binding-project-source', 'symlink'] as const)(
    'keeps the exact config reset boundary for a deleted plugin (%s)',
    async (mode) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `removed-config-${mode}-source`);
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }, { name: 'other' }]);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [{
          id: 'team', type: 'path', primary: true, path: sourceRoot,
        }] },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
      const cwd = isolation.layout.fixtureCwd;
      const scope = mode === 'directory' || mode === 'binding-project-source' ? 'project' : 'user';
      if (scope === 'project') await fs.ensureDir(path.join(cwd, '.git'));
      const configPath = resolvePluginConfigStorePath({
        sourceId: 'team', pluginName: 'demo', scope, cwd, env: isolation.env,
      });
      const external = path.join(cwd, 'config-link-target.json');
      if (mode === 'directory') {
        await fs.ensureDir(configPath);
      } else if (mode.startsWith('binding')) {
        await fs.outputJson(configPath, {
          schemaVersion: 5, sourceId: 'team', pluginName: 'demo',
          binding: mode === 'binding-user-catalog'
            ? { kind: 'catalog', logicalIdentity: active.logicalIdentity }
            : mode === 'binding-project-source'
              ? { kind: 'source', sourceIdentity: active.sourceIdentity }
              : { kind: 'source', sourceIdentity: `sha256:${'0'.repeat(64)}` },
          values: { retained: true },
        });
      } else {
        await fs.outputFile(external, 'retained\n');
        await fs.ensureDir(path.dirname(configPath));
        await fs.symlink(external, configPath, 'file');
      }
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
      await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
      });
      const result = await runRetire({ scope, cwd, env: isolation.env,
        selector: 'team/demo', targets: ['claude'], deleteConfig: true, yes: true });
      if (mode === 'symlink') {
        expect(result.configChanged).toBe(true);
        expect(await fs.pathExists(configPath)).toBe(false);
        expect(await fs.readFile(external, 'utf8')).toBe('retained\n');
      } else {
        expect(result.ok).toBe(false);
        expect(await fs.pathExists(configPath)).toBe(true);
        expect(JSON.stringify(result.blockers)).toContain(mode === 'directory'
          ? 'removedPluginConfigTargetUnsupported'
          : 'removedPluginConfigIdentityConflict');
      }
    },
  );

  it.each([
    { mode: 'owned-normal', force: false, intentOnly: false },
    { mode: 'owned-force', force: true, intentOnly: false },
    { mode: 'intent-only-normal', force: false, intentOnly: true },
  ] as const)(
    'retires through scoped TUI Review after the Active Catalog drops the plugin ($mode)',
    async ({ force, intentOnly }) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `active-entry-removed-${force ? 'force' : 'normal'}-source`,
      );
      const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
      const configure = (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
        manifest.extensions = undefined;
        manifest.scripts = {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        };
        manifest.artifacts = { targets: [{
          id: 'dynamic-role', platform: 'codex', scopes: ['project'],
          target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present'],
          refreshKeys: [], roleKey: 'demo-role',
        }] };
      };
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
      await writeDynamicRoleRenderer({ pluginRoot, roleKey: 'demo-role' });
      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const installed = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
      const sourceIdentity = installed.rebuildResults[0]!.target.sourceIdentity!;
      const projectIntentLocation = {
        scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      };
      const userIntentLocation = {
        scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      };
      await writeIntentFixture(userIntentLocation, {
        schemaVersion: 2,
        kind: 'aw-plugin-intents',
        roots: [{ pluginId: 'team/other', platforms: ['codex'] }],
        dependencyScopeOverrides: [],
      });
      await writePluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'user',
        cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { retained: true },
      });
      const activeBeforeRemoval = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
      await writePluginConfigStore({
        sourceId: 'team', sourceIdentity, logicalIdentity: activeBeforeRemoval.logicalIdentity,
        pluginName: 'demo', scope: 'user', platform: 'codex', cwd: isolation.layout.fixtureCwd,
        env: isolation.env, values: { selected: true },
      });
      await writePluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName: 'other', scope: 'user',
        cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { retained: 'other' },
      });
      const preferencesPath = await resolvePreferencesPath(userIntentLocation);
      const preferencesBefore = await fs.readFile(preferencesPath);
      const sharedConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      await applyCodexConfigTransactionFile(sharedConfig, {
        upsertMcpServers: { foreign: { command: 'foreign' } },
      });
      const foreignSkill = path.join(
        isolation.layout.fixtureCwd, '.agents', 'skills', 'foreign-skill', 'SKILL.md',
      );
      await fs.outputFile(foreignSkill, 'foreign\n');
      const ownedRole = path.join(
        isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-demo-role.toml',
      );
      await expect(fs.pathExists(ownedRole)).resolves.toBe(true);
      expect(parseOwnedTextHeader(await fs.readFile(ownedRole, 'utf8'))?.identity).toMatchObject({
        sourceId: 'team', pluginId: 'team/demo', plugin: 'demo',
        artifactKey: 'demo-role', platform: 'codex', scope: 'project',
      });
      if (intentOnly) {
        expect((await cleanupWriteCommand(['team/demo'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        }, runtime)).overallState).toBe('succeeded');
        await expect(fs.pathExists(ownedRole)).resolves.toBe(false);
      }

      await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
      await fs.remove(pluginRoot);
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
      });
      const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
      expect(active.manifest.entries.map((entry) => entry.name)).toEqual(['other']);

      const status = await statusCommandV8({
        plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
        cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
      });
      expect(status.payload.targets).toEqual([
        expect.objectContaining({
          pluginId: 'team/demo',
          reasons: expect.arrayContaining([expect.objectContaining({
            code: 'codexIntentSourceUnavailable',
          })]),
        }),
      ]);
      const dependencies = createTuiControllerDependencies(createCliExecutionContext({
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        nativeCliRunner: runtime.nativeCliRunner,
        interactive: false,
      }));
      const review = await dependencies.prepareScopedTask({ kind: 'retire', scope: 'project',
        selector: 'team/demo', targets: ['codex'], deleteConfig: force },
      new AbortController().signal);
      expect(review.kind).toBe('retire');
      const execution = await dependencies.executeScopedTask(review);
      expect(execution).toMatchObject({ kind: 'recovery', receipt: {
        command: 'intent:retire', ok: true, declarationChanged: true, configChanged: force,
      } });

      await expect(readFixtureRequirements(projectIntentLocation)).resolves.toMatchObject({
        schemaVersion: 3,
        kind: 'aw-plugin-intents',
        roots: [],
        dependencyScopeOverrides: [],
      });
      await expect(readFixtureRequirements(userIntentLocation)).resolves.toMatchObject({
        roots: [{ pluginId: 'team/other', platforms: ['codex'] }],
      });
      const refreshed = await readRecoveryStatus({
        nativeCliRunner: runtime.nativeCliRunner,
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        cliVersion: '1.0.0', targets: ['codex'],
      });
      expect(refreshed.intent.state).toBe('valid');
      expect(refreshed.inventory?.some((target) => target.pluginId === 'team/demo')).toBe(false);
      await expect(readPluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName: 'demo', scope: 'user',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject(force ? { state: 'missing', exists: false, values: {} } : { values: { retained: true } });
      expect(await fs.pathExists(resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'demo',
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env }))).toBe(!force);
      expect(await fs.pathExists(ownedRole), JSON.stringify(execution.receipt)).toBe(false);
      await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
      await expect(readPluginConfigStore({
        sourceId: 'team', sourceIdentity, pluginName: 'other', scope: 'user',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject({ values: { retained: 'other' } });
      await expect(fs.readFile(foreignSkill, 'utf8')).resolves.toBe('foreign\n');
      await expect(readCodexConfigFile(sharedConfig)).resolves.toMatchObject({
        snapshot: { mcpServers: { foreign: { value: { command: 'foreign' } } } },
      });
    },
    30_000,
  );

  it('rejects a stale scoped retire Review when owned output appears before the write', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-review-stale-source');
    const remainingSourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-review-stale-remaining');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingSourceRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const nativeCliRunner = async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' });
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState).toBe('succeeded');
    const sourceIdentity = installed.rebuildResults[0]!.target.sourceIdentity!;
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'other' }]);
    await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0',
      env: isolation.env, impactConfirmed: true });
    const review = await prepareRetire({ scope: 'project', cwd: isolation.layout.fixtureCwd,
      env: isolation.env, selector: 'team/demo', targets: ['codex'], yes: true },
    { nativeCliRunner });
    const rulesRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'rules');
    const driftPath = path.join(rulesRoot, 'aw-demo-drift-owner.rules');
    await writeOwnedTextFile({
          path: driftPath,
          allowedRoot: rulesRoot,
          identity: {
            owner: 'agent-workflows', sourceId: 'team', sourceIdentity,
            pluginId: 'team/demo', plugin: 'demo', artifactKey: 'drift-owner',
            platform: 'codex', scope: 'project',
          },
          content: 'prefix_rule(pattern = ["git"], decision = "allow")\n',
    });
    const execution = await executeRetire(review, { yes: true });
    expect(execution.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'operationReviewStale' }),
    ]));
    expect(execution.declarationChanged).toBe(false);
    await expect(fs.pathExists(driftPath)).resolves.toBe(true);
    await expect(fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8'))
      .resolves.toContain('aw-owner-v3:');
  }, 30_000);

  it('previews an exact offline cleanup plan and rejects direct execution after plan drift', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-direct-stale-source');
    const remainingRoot = path.join(isolation.layout.fixtureCwd, 'offline-direct-stale-remaining');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState).toBe('succeeded');
    const sourceIdentity = installed.rebuildResults[0]!.target.sourceIdentity!;
    const projectIntent = {
      scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
    };
    await writeIntentFixture(projectIntent, {
      ...await readFixtureRequirements(projectIntent),
      roots: [],
    });
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const before = await fs.readFile(configPath, 'utf8');
    const preview = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, previewOperationPlan: true });
    const evidence = preview.offlineCleanupPlans?.[0];

    expect(evidence).toMatchObject({
      reason: 'sourceMissing',
      pluginId: 'team/demo',
      plan: {
        schemaVersion: 1,
        pluginId: 'team/demo',
        sourceIdentity: 'unavailable',
        platform: 'codex',
        scope: 'project',
        actions: expect.arrayContaining([
          expect.objectContaining({ action: 'removeOwnedOutput', kind: 'namespacedOwner' }),
        ]),
      },
      planDigest: expect.stringMatching(/^sha256:/u),
    });
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(before);
    const rulesRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'rules');
    const driftPath = path.join(rulesRoot, 'aw-demo-direct-drift.rules');
    await writeOwnedTextFile({
      path: driftPath,
      allowedRoot: rulesRoot,
      identity: {
        owner: 'agent-workflows', sourceId: 'team', sourceIdentity,
        pluginId: 'team/demo', plugin: 'demo', artifactKey: 'direct-drift',
        platform: 'codex', scope: 'project',
      },
      content: 'prefix_rule(pattern = ["git"], decision = "allow")\n',
    });

    await expect(cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { ...runtime, expectedOfflineCleanupEvidence: evidence }))
      .resolves.toMatchObject({
        overallState: 'failed',
        targetResults: [expect.objectContaining({ errorCode: 'operationReviewStale' })],
      });
    await expect(fs.pathExists(driftPath)).resolves.toBe(true);
    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(before);
  }, 30_000);

  it.each(['user', 'project'] as const)(
    'retires only the selected Codex activation for %s scope and retains shared native state',
    async (scope) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `offline-native-${scope}-source`);
      await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const installed = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope,
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
      const intentLocation = { scope, cwd: isolation.layout.fixtureCwd, env: isolation.env };
      if (scope === 'user') {
        const projectIntentLocation = {
          scope: 'project' as const,
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
        };
        await writeIntentFixture(projectIntentLocation, {
          ...await readFixtureRequirements(projectIntentLocation),
          roots: [{ pluginId: 'team/demo', platforms: ['codex'] }],
          managed: { codexPluginIds: ['demo@aw'] },
        });
        await applyCodexConfigTransactionFile(
          path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
          { upsertPluginActivations: { 'demo@aw': true } },
        );
      }
      const activationConfigPath = scope === 'user'
        ? path.join(isolation.env.CODEX_HOME!, 'config.toml')
        : path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      await applyCodexConfigTransactionFile(activationConfigPath, {
        upsertPluginActivations: { 'foreign@outside': true, 'demo@outside': true },
      });
      const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
      const payloadSkill = path.join(
        marketplaceRoot, 'plugins', 'demo', 'skills', 'demo-skill', 'SKILL.md',
      );
      const cacheSkill = path.join(
        isolation.env.CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo', '1.0.0',
        'skills', 'demo-skill', 'SKILL.md',
      );
      const [payloadBefore, cacheBefore] = await Promise.all([
        fs.readFile(payloadSkill),
        fs.readFile(cacheSkill),
      ]);
      await createNativeDependencyCatalog(sourceRoot, [{ name: 'other' }]);
      await fs.remove(path.join(sourceRoot, 'plugins', 'demo'));
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
      });
      const retired = await runRetire({
        scope, cwd: isolation.layout.fixtureCwd, env: isolation.env,
        selector: 'team/demo', targets: ['codex'], yes: true,
      }, runtime);

      expect(retired.command).toBe('intent:retire');
      expect(retired.declarationChanged).toBe(true);
      expect(retired.configChanged).toBe(false);
      const activationConfig = await readCodexConfigFile(activationConfigPath);
      expect(activationConfig.snapshot.plugins['demo@aw']?.enabled).toBe(false);
      expect(activationConfig.snapshot.plugins['foreign@outside']?.enabled).toBe(true);
      expect(activationConfig.snapshot.plugins['demo@outside']?.enabled).toBe(true);
      expect(await fs.pathExists(payloadSkill), JSON.stringify(retired)).toBe(true);
      await expect(fs.readFile(payloadSkill)).resolves.toEqual(payloadBefore);
      await expect(fs.readFile(cacheSkill)).resolves.toEqual(cacheBefore);
      await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(true);
      expect(runtime.installed.has('demo@aw')).toBe(true);
      await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({ roots: [] });
      if (scope === 'user') {
        await expect(readCodexConfigFile(
          path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
        )).resolves.toMatchObject({
          snapshot: { plugins: { 'demo@aw': { enabled: true } } },
        });
      }
    },
    30_000,
  );

  it.each([false, true])(
    'cleans an exact offline Codex extension without changing Intent when native identity is ambiguous (force=%s)',
    async (force) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(
        isolation.layout.fixtureCwd,
        `offline-ambiguous-native-${force ? 'force' : 'normal'}-source`,
      );
      const remainingRoot = path.join(
        isolation.layout.fixtureCwd,
        `offline-ambiguous-native-${force ? 'force' : 'normal'}-remaining`,
      );
      await createNativeDependencyCatalog(sourceRoot, [{
        name: 'demo',
        configureManifest: (manifest) => {
          manifest.extensions = {
            agents: [{ name: 'reviewer', description: 'Reviewer.', prompt: 'Review changes.' }],
          };
        },
      }]);
      await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
      const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: initial.digest,
        env: isolation.env,
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const installed = await installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
      }, runtime);
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
      const extensionPath = path.join(
        isolation.env.CODEX_HOME!, 'agents', 'aw-demo-reviewer.toml',
      );
      await expect(fs.pathExists(extensionPath)).resolves.toBe(true);
      const configPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
      const ambiguousConfig = [
        '[plugins."demo@outside"]',
        'enabled = true',
        '',
        '[plugins."foreign@outside"]',
        'enabled = true',
        '',
      ].join('\n');
      await fs.outputFile(configPath, ambiguousConfig);
      const cacheRoot = path.join(
        isolation.env.CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo',
      );
      const cacheBefore = await snapshotRegularTree(cacheRoot);
      const intentLocation = {
        scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
      };
      await fs.remove(path.join(isolation.env.AW_HOME!, 'marketplaces', 'team'));
      const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
        },
        expectedDigest: configured.digest,
        env: isolation.env,
      });
      runtime.nativeCliRunner.mockClear();

      const result = await cleanupWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', force,
      }, runtime);
      const receipt = (await import('../../src/output/command-receipt.js'))
        .buildRebuildReceiptJson('cleanup', result);

      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      expect(result.warnings).toEqual(expect.arrayContaining([
        expect.stringContaining('nativeMarketplaceIdentityUnresolved'),
      ]));
      expect(receipt.targetResults).toEqual([
        expect.objectContaining({
          state: 'completed',
          residual: expect.arrayContaining(['nativeMarketplaceIdentityUnresolved']),
        }),
      ]);
      await expect(fs.pathExists(extensionPath)).resolves.toBe(false);
      await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(ambiguousConfig);
      await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
        roots: [expect.objectContaining({ pluginId: 'team/demo' })],
      });
      await expect(snapshotRegularTree(cacheRoot)).resolves.toEqual(cacheBefore);
      expect(runtime.installed.has('demo@aw')).toBe(true);
      expect(runtime.nativeCliRunner).not.toHaveBeenCalled();
    },
    30_000,
  );

  it('returns idempotent success for a source-deleted target with no live match', async () => {
      const isolation = await configureCatalog();

      const result = await cleanupWriteCommand(['removed/demo'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, { env: isolation.env });

      expect(result).toMatchObject({
        overallState: 'succeeded',
        targetResults: [],
        rebuildResults: [],
      });
  });

  it('returns idempotent force success with no Intent, live match, or local Active bundle', async () => {
    const isolation = await configureCatalog();
    const result = await cleanupWriteCommand(['removed/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
      force: true,
    }, { env: isolation.env });

    expect(result).toMatchObject({
      overallState: 'succeeded',
      targetResults: [],
      rebuildResults: [],
    });
  });

  it('cleans stale Codex config while preserving cache payload after official absence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-native-no-activation-source');
    const remainingRoot = path.join(isolation.layout.fixtureCwd, 'offline-native-no-activation-remaining');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    await createDependencyCatalogSnapshotFixture(remainingRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const marketplaceSkill = path.join(
      isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins', 'demo',
      'skills', 'demo-skill', 'SKILL.md',
    );
    const cacheSkill = path.join(
      isolation.env.CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo', '1.0.0',
      'skills', 'demo-skill', 'SKILL.md',
    );
    const [marketplaceBefore, cacheBefore] = await Promise.all([
      fs.readFile(marketplaceSkill),
      fs.readFile(cacheSkill),
    ]);
    runtime.installed.delete('demo@aw');
    const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingRoot }],
      },
      expectedDigest: configured.digest,
      env: isolation.env,
    });

    const cleaned = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);

    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(readCodexConfigFile(path.join(
      isolation.env.CODEX_HOME!, 'config.toml',
    ))).resolves.toMatchObject({ snapshot: { plugins: {} } });
    await expect(fs.readFile(marketplaceSkill)).resolves.toEqual(marketplaceBefore);
    await expect(fs.readFile(cacheSkill)).resolves.toEqual(cacheBefore);
  }, 30_000);

  it('shows marker-only Project residue without authorizing ambiguous retirement', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const remainingSourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-identity-remaining');
    await createDependencyCatalogSnapshotFixture(remainingSourceRoot, [{ name: 'other' }]);
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'remaining', type: 'path', primary: true, path: remainingSourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const identities = [
      { identity: `sha256:${'1'.repeat(64)}`, root: path.join(skillsRoot, 'identity-one') },
      { identity: `sha256:${'2'.repeat(64)}`, root: path.join(skillsRoot, 'identity-two') },
    ];
    for (const entry of identities) {
      await fs.ensureDir(entry.root);
      await writeSkillOwnerMarker({
        skillRoot: entry.root,
        allowedRoot: skillsRoot,
        identity: {
          owner: 'agent-workflows', sourceId: 'removed', sourceIdentity: entry.identity,
          pluginId: 'removed/demo', plugin: 'demo', artifactKey: path.basename(entry.root),
          platform: 'codex', scope: 'project',
        },
      });
    }
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    })));
    try {
      await controller.load();
      expect(controller.listUserIssues()).toContainEqual(expect.objectContaining({
        category: 'sourceMissing', pluginId: 'removed/demo', scope: 'project',
      }));
      const plan = await prepareRetire({
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
        selector: 'removed/demo', targets: ['codex'],
      }, { env: isolation.env, nativeCliRunner: async () => ({
        exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '',
      }) });
      try {
        expect(plan.receipt.blockers).toContainEqual(expect.objectContaining({
          code: 'removedPluginActiveUnavailable',
        }));
      } finally {
        await plan.context.dispose();
      }
      for (const entry of identities) {
        await expect(fs.pathExists(entry.root)).resolves.toBe(true);
      }
    } finally {
      controller.dispose();
    }
  });

  it('cleans a valid live owner when the configured path source is unavailable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'offline-cleanup-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '',
    }));
    const runtime = {
      env: isolation.env,
      nativeCliRunner,
    };
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed).toMatchObject({ overallState: 'succeeded' });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const configBefore = await fs.readFile(configPath);
    const intentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const intentBefore = await fs.readFile(intentPath);
    await fs.move(sourceRoot, `${sourceRoot}-unavailable`);
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: isolation.env });
    await fs.remove(active.snapshotPath);

    nativeCliRunner.mockClear();
    const codexManagerPreviewer = vi.fn(async () => ({
      state: 'blocked' as const, code: 'codexCliNotFound' as const,
      diagnostic: 'Install or repair the local Codex CLI.',
    }));
    const codexManagerResolver = vi.fn(async () => ({
      kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [],
    }));
    const removeObsoleteInstallationContracts = vi.fn(async () => undefined);
    const preview = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      ...runtime,
      previewOperationPlan: true,
      codexManagerPreviewer,
      codexManagerResolver,
      removeObsoleteInstallationContracts,
    });

    expect(preview.overallState).toBe('succeeded');
    await expect(fs.readFile(configPath)).resolves.toEqual(configBefore);
    expect(nativeCliRunner).not.toHaveBeenCalled();
    expect(codexManagerPreviewer).not.toHaveBeenCalled();
    expect(codexManagerResolver).not.toHaveBeenCalled();
    expect(removeObsoleteInstallationContracts).not.toHaveBeenCalled();

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      ...runtime,
      removeObsoleteInstallationContracts: async () => {
        throw new Error(`private cleanup failure at ${isolation.env.AW_HOME}`);
      },
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.warnings).toEqual([
      'obsoleteContractsCleanupFailed: Obsolete installation contracts could not be removed.',
    ]);
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    expect(JSON.stringify(result)).not.toContain('private cleanup failure');
    expect(JSON.stringify(result.warnings)).not.toContain(isolation.env.AW_HOME);
  });

  it('preserves project requirements when unrelated shared Codex user config inventory is damaged', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'damaged-user-inventory-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'cleanup-test', title: 'Cleanup test', content: 'owned content' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    const installed = await installFixturePlugin(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const projectConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    await expect(fs.readFile(projectConfig, 'utf8')).resolves.toContain('aw-owner-v3:');
    const damagedUserConfig = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    await fs.outputFile(damagedUserConfig, 'invalid = [\n');
    await fs.remove(projectConfig);

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'local/demo' })]) });
    await expect(fs.readFile(damagedUserConfig, 'utf8')).resolves.toBe('invalid = [\n');
    await expect(fs.pathExists(projectConfig)).resolves.toBe(false);
  });

  it.each([false, true])(
    'cleans the old live identity after a real source A to B update with force=%s',
    async (force) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceA = path.join(isolation.layout.fixtureCwd, `identity-a-${force}`);
      const sourceB = path.join(isolation.layout.fixtureCwd, `identity-b-${force}`);
      await Promise.all([
        createDependencyCatalogSnapshotFixture(sourceA, [{ name: 'demo' }]),
        createDependencyCatalogSnapshotFixture(sourceB, [{ name: 'demo' }]),
      ]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceA }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      };
      await expect(installFixturePlugin(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      const installedConfig = await fs.readFile(configPath, 'utf8');
      expect(installedConfig).toContain('demo.');
      await expect(updateCatalogSourceCommand({
        sourceId: 'team', update: { path: sourceB }, cliVersion: '1.0.0',
        cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject({ ok: true, changed: true });

      const result = await cleanupWriteCommand(['team/demo'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force,
      }, runtime);

      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      if (force) await expect(fs.readFile(configPath, 'utf8')).resolves.toContain('demo.');
      else await expect(fs.readFile(configPath, 'utf8')).resolves.not.toContain('demo.');
      await expect(readFixtureRequirements({
        scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      })).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/demo' })]) });
    },
  );

  it('cleans a source-changed dependency without consulting an old live consumer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceA = path.join(isolation.layout.fixtureCwd, 'dependent-identity-a');
    const sourceB = path.join(isolation.layout.fixtureCwd, 'dependent-identity-b');
    await Promise.all([
      createDependencyCatalogSnapshotFixture(sourceA, [
        { name: 'leaf' },
        { name: 'root', dependencies: ['leaf'] },
      ]),
      createDependencyCatalogSnapshotFixture(sourceB, [{ name: 'leaf' }]),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceA }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await updateCatalogSourceCommand({
      sourceId: 'team', update: { path: sourceB }, cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    await fs.copy(
      path.join(sourceA, 'plugins'),
      path.join(isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins'),
    );
    await expect(fs.pathExists(path.join(
      isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins', 'root', '.agents-plugin', 'plugin.json',
    ))).resolves.toBe(true);

    const result = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result).toMatchObject({ overallState: 'failed' });
    expect(JSON.stringify(result)).toMatch(/cleanup --force|reinstall|sync/u);
    await expect(fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8'))
      .resolves.not.toContain('leaf.');
  });

  it('cleans only the selected marker-owned Codex project Skill', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const identities = [
      { sourceId: 'first', artifactKey: 'first-demo', fill: '1' },
      { sourceId: 'second', artifactKey: 'second-demo', fill: '2' },
    ];
    for (const entry of identities) {
      const skillRoot = path.join(skillsRoot, entry.artifactKey);
      await fs.ensureDir(skillRoot);
      await writeSkillOwnerMarker({
        skillRoot,
        allowedRoot: skillsRoot,
        identity: {
          owner: 'agent-workflows',
          sourceId: entry.sourceId,
          sourceIdentity: `sha256:${entry.fill.repeat(64)}`,
          pluginId: `${entry.sourceId}/demo`,
          plugin: 'demo',
          artifactKey: entry.artifactKey,
          platform: 'codex',
          scope: 'project',
        },
      });
    }
    const result = await cleanupWriteCommand(['first/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env });
    expect(result).toMatchObject({
      overallState: 'succeeded',
      targetResults: [expect.objectContaining({
        state: 'completed',
        target: expect.objectContaining({ pluginId: 'first/demo' }),
      })],
    });
    await expect(fs.pathExists(path.join(skillsRoot, 'first-demo'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(skillsRoot, 'second-demo'))).resolves.toBe(true);
  });

  it('removes a shared Codex Skill when current platform config disables its dynamic target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'project-disabled-skill-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.config = { schemaVersion: 5, fields: {},
        platforms: { codex: { fields: { enabled: { type: 'boolean', default: true } } } } };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-skill', platform: 'codex', scopes: ['project'],
        target: 'codex.skill',
        states: ['present', 'disabled'], refreshKeys: ['enabled'], skillKey: 'config-skill',
      }] };
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      'import { readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const enabled = context.config.values.enabled;',
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: "dynamic-skill", kind: "skill", platform: "codex", target: "codex.skill",',
      '  state: enabled ? "present" : "disabled", skillKey: "config-skill", refreshKeys: ["enabled"],',
      '  ...(enabled ? { content: { files: {',
      '    "SKILL.md": "---\\nname: config-skill\\ndescription: Config Skill.\\n---\\n",',
      '    "README.md": "Config Skill.\\n",',
      '    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n"',
      '  } } } : { disabledReason: "disabled by config" })',
      '}] }));',
    ].join('\n'));
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo', configureManifest: configure }]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', yes: true,
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const skillRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins', 'demo',
      'codex', 'skills', 'config-skill');
    const projectSkillRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills', 'config-skill');
    await expect(fs.pathExists(path.join(skillRoot, 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.pathExists(projectSkillRoot)).resolves.toBe(false);
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity: await calculateCatalogSourceIdentity(source),
      logicalIdentity: await readCatalogLogicalIdentity(sourceRoot),
      pluginName: 'demo',
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { enabled: false },
    });

    const result = await syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', yes: true,
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(skillRoot)).resolves.toBe(false);
    await expect(fs.pathExists(projectSkillRoot)).resolves.toBe(false);
    expect(runtime.installed.has('demo@aw')).toBe(true);
    await expect(readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toMatchObject({ snapshot: { plugins: { 'demo@aw': { enabled: true } } } });
  }, 30_000);

  it.each(['sync', 'uninstall'] as const)('removes a project Codex role removed by the active manifest through %s', async (command) => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'project-skill-v1-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'project-skill-v2-source');
    const configureV1 = (manifest: PluginMeta['manifest']) => {
      manifest.version = '1.0.0';
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-role', platform: 'codex', scopes: ['project'],
        target: 'codex.agentRole', requiresCodexProjectConfig: true,
        states: ['present'], refreshKeys: [], roleKey: 'removed-in-v2',
      }] };
    };
    await createDependencyCatalogSnapshotFixture(firstRoot, [{ name: 'demo', configureManifest: configureV1 }]);
    await writeDynamicRoleRenderer({
      pluginRoot: path.join(firstRoot, 'plugins', 'demo'), roleKey: 'removed-in-v2',
    });
    await createDependencyCatalogSnapshotFixture(firstRoot, [{ name: 'demo', configureManifest: configureV1 }]);
    await createDependencyCatalogSnapshotFixture(secondRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.version = '2.0.0';
        manifest.platforms = ['codex'];
        manifest.extensions = {
          instructions: [{ name: 'current', title: 'Current', content: 'Current instruction.' }],
        };
      },
    }]);
    const firstSource = { id: 'team', type: 'path' as const, primary: true, path: firstRoot };
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [firstSource] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const initialInstall = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(initialInstall.overallState, JSON.stringify(initialInstall.rebuildResults)).toBe('succeeded');
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-removed-in-v2.toml');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    const changed = await updateCatalogSourceCommand({
      sourceId: 'team',
      update: { path: secondRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    expect(changed).toMatchObject({ ok: true, changed: true });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env, impactConfirmed: true,
    });
    const foreignSkillRoot = path.join(
      isolation.layout.fixtureCwd,
      '.agents',
      'skills',
      'foreign-skill',
    );
    await fs.outputFile(path.join(foreignSkillRoot, 'SKILL.md'), 'foreign\n');
    await writeSkillOwnerMarker({
      skillRoot: foreignSkillRoot,
      allowedRoot: path.dirname(foreignSkillRoot),
      identity: {
        owner: 'agent-workflows',
        sourceId: 'other',
        pluginId: 'other/demo',
        plugin: 'demo',
        artifactKey: 'foreign-skill',
        platform: 'codex',
        scope: 'project',
      },
    });
    const intentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const intentBefore = await fs.readFile(intentPath);

    const result = await (command === 'sync' ? syncWriteCommand : uninstallWriteCommand)(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.rebuildResults.some((entry) => entry.removed.some((removed) =>
      removed.includes('removed-in-v2')))).toBe(true);
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(fs.readFile(path.join(foreignSkillRoot, 'SKILL.md'), 'utf8'))
      .resolves.toBe('foreign\n');
  }, 30_000);

  it('only removes direct project Codex Skills with an exact current owner identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'project-stale-safety-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{ name: 'demo' }]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const writeMarker = async (name: string, identity: Parameters<typeof writeSkillOwnerMarker>[0]['identity']) => {
      const skillRoot = path.join(skillsRoot, name);
      await fs.ensureDir(skillRoot);
      await writeSkillOwnerMarker({ skillRoot, allowedRoot: skillsRoot, identity });
      return skillRoot;
    };
    const identity = (artifactKey: string) => ({
      owner: 'agent-workflows' as const,
      sourceId: 'team', pluginId: 'team/demo', plugin: 'demo', artifactKey,
      platform: 'codex' as const, scope: 'project' as const,
    });
    const removable = await writeMarker('stale-owned', identity('stale-owned'));
    const retained = [
      await writeMarker('foreign-source', {
        ...identity('foreign-source'), sourceId: 'foreign', pluginId: 'foreign/demo',
      }),
      await writeMarker('user-scope', { ...identity('user-scope'), scope: 'user' }),
      await writeMarker('claude-skill', { ...identity('claude-skill'), platform: 'claude' }),
    ];
    const malformed = path.join(skillsRoot, 'malformed');
    await fs.outputFile(path.join(malformed, SKILL_OWNER_MARKER), '{invalid\n');
    retained.push(malformed);
    const markerTarget = path.join(isolation.layout.rootDir, 'external-owner-marker.json');
    await fs.outputJson(markerTarget, identity('marker-symlink'));
    const markerSymlink = path.join(skillsRoot, 'marker-symlink');
    await fs.ensureDir(markerSymlink);
    await fs.symlink(markerTarget, path.join(markerSymlink, SKILL_OWNER_MARKER));
    retained.push(markerSymlink);
    const externalSkill = path.join(isolation.layout.rootDir, 'external-skill-directory');
    await fs.outputFile(path.join(externalSkill, 'SKILL.md'), 'foreign\n');
    const skillSymlink = path.join(skillsRoot, 'skill-symlink');
    await fs.symlink(externalSkill, skillSymlink, process.platform === 'win32' ? 'junction' : 'dir');
    retained.push(skillSymlink);
    const nested = path.join(skillsRoot, 'container', 'nested-owned');
    await fs.ensureDir(nested);
    await writeSkillOwnerMarker({
      skillRoot: nested,
      allowedRoot: path.join(skillsRoot, 'container'),
      identity: identity('nested-owned'),
    });
    retained.push(nested);

    const result = await syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(removable)).resolves.toBe(false);
    for (const skillRoot of retained) {
      await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
    }
    await expect(fs.pathExists(markerTarget)).resolves.toBe(true);
    await expect(fs.pathExists(externalSkill)).resolves.toBe(true);
  }, 30_000);

  it('cleans an exact target in an internal multi-selector force request without guessing another path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'force-multi-selector-source');
    const removable = {
      name: 'removable',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
        manifest.scripts = {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        };
        manifest.artifacts = { targets: [{
          id: 'dynamic-role', platform: 'codex', scopes: ['project'],
          target: 'codex.agentRole', requiresCodexProjectConfig: true,
          states: ['present'], refreshKeys: [], roleKey: 'removable-role',
        }] };
      },
    };
    const sharedOnly = {
      name: 'shared-only',
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
        manifest.extensions = {
          instructions: [{ name: 'shared-only', title: 'Shared only', content: 'Shared only.' }],
        };
      },
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [removable, sharedOnly]);
    await writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'removable'),
      roleKey: 'removable-role',
      fail: true,
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [removable, sharedOnly]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-removable-removable-role.toml');
    await fs.outputFile(rolePath, 'description = "Markerless but exact"\n');
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const registration = { description: 'Removable role', configFile: 'agents/aw-removable-removable-role.toml' };
    await applyCodexConfigTransactionFile(configPath, { upsertAgentRegistrations: { 'removable-role': registration } });
    const execution = await createNativeTestExecution({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      selectedTargets: [
        { pluginId: 'local/removable', platform: 'codex' },
        { pluginId: 'local/shared-only', platform: 'codex' },
      ],
    });
    let result: Awaited<ReturnType<typeof runRebuildCommand>>;
    try {
      result = await withAwHomeMutationLock({
        env: isolation.env,
        action: (token) => runRebuildCommand({
          command: 'cleanup',
          pluginNames: ['local/removable', 'local/shared-only'],
          commandOptions: {
            cwd: isolation.layout.fixtureCwd,
            platform: 'codex',
            scope: 'project',
            json: false,
            force: true,
          },
          runtime: { env: isolation.env, awHomeMutationToken: token,
            executionInput: execution.executionInput },
        }),
      });
    } finally {
      await execution.dispose();
    }
    expect(result).toMatchObject({
      overallState: 'succeeded',
      targetResults: [expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'local/removable' }),
        state: 'completed',
      })],
    });
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    expect((await readCodexConfigFile(configPath)).snapshot.agents['removable-role']).toBeUndefined();

    await applyCodexConfigTransactionFile(configPath, { upsertAgentRegistrations: { 'removable-role': registration } });
    const missingFile = await cleanupWriteCommand(['local/removable'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });
    expect(missingFile.overallState, JSON.stringify(missingFile)).toBe('succeeded');
    expect((await readCodexConfigFile(configPath)).snapshot.agents['removable-role'])
      .toMatchObject(registration);
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
  });

  it('force cleanup removes only the exact Active-planned damaged Codex project role', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'force-shallow-source');
    const configureForceManifest = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        preApply: { path: './scripts/pre-apply.mjs' },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-role', platform: 'codex', scopes: ['project'],
        target: 'codex.agentRole', requiresCodexProjectConfig: true,
        states: ['present'], refreshKeys: [], roleKey: 'damaged-demo',
      }] };
    };
    const forcePlugin = {
      name: 'demo',
      configureManifest: configureForceManifest,
    };
    await createDependencyCatalogSnapshotFixture(sourceRoot, [forcePlugin, { name: 'unrelated' }]);
    await writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'demo'),
      roleKey: 'damaged-demo',
      fail: true,
    });
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'pre-apply.mjs'),
      "throw new Error('force cleanup must not run preApply');\n",
    );
    await createDependencyCatalogSnapshotFixture(sourceRoot, [forcePlugin, { name: 'unrelated' }]);
    const sourceSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'local', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceSnapshot.digest,
      env: isolation.env,
    });
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-damaged-demo.toml');
    const otherSkillsRoot = path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'skills');
    const otherSkillRoot = path.join(otherSkillsRoot, 'damaged-demo');
    const invalidSkillRoot = path.join(skillsRoot, 'invalid-json');
    const linkedSkillRoot = path.join(skillsRoot, 'linked-marker');
    const externalMarker = path.join(isolation.layout.rootDir, 'foreign-owner-marker.json');
    const damagedOwner = {
      schemaVersion: 2,
      owner: 'agent-workflows',
      sourceId: 'local',
      sourceIdentity: 'damaged',
      pluginId: 'local/demo',
      plugin: 'demo',
      artifactKey: 'damaged-demo',
      platform: 'codex',
      scope: 'project',
    };
    const damagedRole = `# agent-workflows-owner: ${JSON.stringify(damagedOwner)}\ndescription = "Damaged role"\n`;
    await fs.outputFile(rolePath, damagedRole);
    await fs.ensureDir(otherSkillRoot);
    await writeSkillOwnerMarker({
      skillRoot: otherSkillRoot,
      allowedRoot: otherSkillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'local',
        sourceIdentity: 'damaged',
        pluginId: 'local/demo',
        plugin: 'demo',
        artifactKey: 'damaged-demo',
        platform: 'claude',
        scope: 'user',
      },
    });
    await fs.outputFile(path.join(invalidSkillRoot, '.agent-workflows-owner.json'), '{invalid\n');
    await fs.outputJson(externalMarker, {
      ...damagedOwner,
      artifactKey: 'linked-marker',
    });
    await fs.ensureDir(linkedSkillRoot);
    await fs.symlink(externalMarker, path.join(linkedSkillRoot, '.agent-workflows-owner.json'));
    const sharedConfig = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const foreignRolePath = path.join(isolation.layout.rootDir, 'foreign-role.toml');
    await fs.outputFile(foreignRolePath, 'description = "Foreign role"\n');
    await applyCodexConfigTransactionFile(sharedConfig, {
      upsertPluginActivations: { 'demo@aw': true },
      upsertAgentRegistrations: { 'damaged-demo': {
        description: 'Foreign role', configFile: path.relative(path.dirname(sharedConfig), foreignRolePath),
      } },
    });

    const runtime = await createCodexNativeTestRuntime(isolation);
    const blockedReinstall = await reinstallWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(blockedReinstall.targetResults).toEqual([
      expect.objectContaining({
        errorCode: 'exclusiveOwnerEvidenceInvalid',
        recoveryActions: [
          'run aw plugin cleanup local/demo --target codex --scope project --force',
          'then run aw plugin sync local/demo --target codex --context project --rebuild',
        ],
      }),
    ]);
    const blockedReceipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('reinstall', blockedReinstall);
    expect(blockedReceipt.recoveryActions).toEqual([
      'run aw plugin cleanup local/demo --target codex --scope project --force',
      'then run aw plugin sync local/demo --target codex --context project --rebuild',
    ]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    const activeState = await fs.readJson(path.join(isolation.env.AW_HOME!, 'catalog-state.json')) as {
      sources: { local: { active: { logicalIdentity: string; snapshotDigest: string } } };
    };
    const activeStore = resolveCatalogStoreLocation({
      ...activeState.sources.local.active,
      env: isolation.env,
    });
    await fs.outputFile(
      path.join(activeStore.snapshotRoot, 'plugins', 'unrelated', '.agents-plugin', 'plugin.json'),
      '{damaged unrelated bundle\n',
    );
    const intentLocation = {
      scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
    };
    await writeIntentFixture(intentLocation, {
      schemaVersion: 2,
      kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'local/demo', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });

    const removeObsoleteInstallationContracts = vi.fn(async () => undefined);
    const codexManagerPreviewer = vi.fn(async () => ({
      state: 'blocked' as const, code: 'codexCliNotFound' as const,
      diagnostic: 'Install or repair the local Codex CLI.',
    }));
    const codexManagerResolver = vi.fn(async () => ({
      kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [],
    }));
    let providerCalls = 0;
    const forceRuntime = {
      env: isolation.env,
      catalogGenerationRuntime: {
        providers: {
          path: async (...args: Parameters<typeof catalogPathProviderInternal.resolve>) => {
            providerCalls += 1;
            return catalogPathProviderInternal.resolve(...args);
          },
          git: async () => {
            providerCalls += 1;
            throw new Error('force cleanup must not invoke the Catalog provider');
          },
        },
      },
    };
    const preview = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, {
      ...forceRuntime,
      previewOperationPlan: true,
      removeObsoleteInstallationContracts,
      codexManagerPreviewer,
      codexManagerResolver,
    });

    expect(preview.overallState).toBe('succeeded');
    expect(removeObsoleteInstallationContracts).not.toHaveBeenCalled();
    expect(codexManagerPreviewer).not.toHaveBeenCalled();
    expect(codexManagerResolver).not.toHaveBeenCalled();
    expect(providerCalls).toBe(0);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'render-count-demo.txt')))
      .resolves.toBe(false);
    expect(preview.operationPlan?.actions).toEqual([
      expect.objectContaining({
        kind: 'removeOwnedArtifact',
        path: rolePath,
      }),
    ]);
    await expect(fs.readFile(rolePath, 'utf8')).resolves.toBe(damagedRole);
    await expect(fs.pathExists(otherSkillRoot)).resolves.toBe(true);
    await expect(fs.readFile(path.join(invalidSkillRoot, '.agent-workflows-owner.json'), 'utf8'))
      .resolves.toBe('{invalid\n');
    expect((await fs.lstat(path.join(linkedSkillRoot, '.agent-workflows-owner.json'))).isSymbolicLink())
      .toBe(true);
    await expect(fs.pathExists(externalMarker)).resolves.toBe(true);
    await expect(readCodexConfigFile(sharedConfig)).resolves.toMatchObject({
      snapshot: { plugins: { 'demo@aw': { enabled: true } } },
    });

    const reviewedEvidence = preview.offlineCleanupPlans?.[0];
    expect(reviewedEvidence).toBeDefined();
    const foreignOwner = {
      schemaVersion: 3,
      owner: 'agent-workflows',
      sourceId: 'foreign',
      pluginId: 'foreign/demo',
      plugin: 'demo',
      artifactKey: 'damaged-demo',
      platform: 'codex',
      scope: 'project',
    };
    await fs.outputFile(rolePath, `# agent-workflows-owner: ${JSON.stringify(foreignOwner)}\ndescription = "Foreign role"\n`);
    const stale = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { ...forceRuntime, expectedOfflineCleanupEvidence: reviewedEvidence });
    expect(stale.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'operationReviewStale' }),
    ]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    await fs.outputFile(rolePath, damagedRole);

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, forceRuntime);

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(readCodexConfigFile(sharedConfig)).resolves.toMatchObject({ snapshot: {
      plugins: { 'demo@aw': { enabled: true } },
      agents: { 'damaged-demo': { configFile: path.relative(path.dirname(sharedConfig), foreignRolePath) } },
    } });
    await expect(fs.readFile(foreignRolePath, 'utf8')).resolves.toBe('description = "Foreign role"\n');
    await expect(fs.pathExists(otherSkillRoot)).resolves.toBe(true);
    await expect(fs.readFile(path.join(invalidSkillRoot, '.agent-workflows-owner.json'), 'utf8'))
      .resolves.toBe('{invalid\n');
    expect((await fs.lstat(path.join(linkedSkillRoot, '.agent-workflows-owner.json'))).isSymbolicLink())
      .toBe(true);
    await expect(fs.pathExists(externalMarker)).resolves.toBe(true);
    expect(providerCalls).toBe(0);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'render-count-demo.txt')))
      .resolves.toBe(false);
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({ roots: expect.arrayContaining([expect.objectContaining({ pluginId: 'local/demo' })]) });
  });

  it('recovers a damaged owned-text header through reinstall, force cleanup, and reinstall', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'owned-text-recovery-source');
    const configure = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        agents: [{ name: 'reviewer', description: 'Reviewer.', prompt: 'Review changes.' }],
      };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-role', platform: 'codex', scopes: ['project'],
        target: 'codex.agentRole', requiresCodexProjectConfig: true, states: ['present'], refreshKeys: [], roleKey: 'project-role',
      }] };
    };
    const definition = [{ name: 'demo', configureManifest: configure }];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definition);
    await writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'demo'),
      roleKey: 'project-role',
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, definition);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-project-role.toml');
    const agentPath = path.join(
      isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-reviewer.toml',
    );
    const originalAgent = await fs.readFile(agentPath, 'utf8');
    await fs.outputFile(
      agentPath,
      `# agent-workflows-owner: {invalid\n${originalAgent.split('\n').slice(1).join('\n')}`,
    );

    const blocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(blocked.targetResults).toEqual([
      expect.objectContaining({
        errorCode: 'exclusiveOwnerEvidenceInvalid',
        recoveryActions: [
          'run aw plugin cleanup team/demo --target codex --scope project --force',
          'then run aw plugin sync team/demo --target codex --context project --rebuild',
        ],
      }),
    ]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    await expect(fs.pathExists(agentPath)).resolves.toBe(true);
    const intentPath = path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-intents.json',
    );
    const validIntent = await fs.readFile(intentPath);
    const malformedIntent = Buffer.from('{malformed selected project Intent\n');
    await fs.outputFile(intentPath, malformedIntent);

    const cleaned = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('partial');
    expect(cleaned.rebuildResults).toEqual([expect.objectContaining({
      status: 'failed',
      removed: expect.arrayContaining(['aw-demo-project-role.toml', 'aw-demo-reviewer.toml']),
      residual: expect.arrayContaining(['plugin-intents.json']),
    })]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(fs.pathExists(agentPath)).resolves.toBe(false);
    await expect(fs.readFile(intentPath)).resolves.toEqual(malformedIntent);

    await fs.outputFile(intentPath, validIntent);
    const recovered = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });
    expect(recovered.overallState, JSON.stringify(recovered)).toBe('succeeded');
    expect(recovered.rebuildResults).toEqual([
      expect.objectContaining({ status: 'succeeded', residual: [], failures: [] }),
    ]);
    expect(recovered.targetResults).toEqual([
      expect.objectContaining({
        state: 'completed',
        target: expect.objectContaining({ pluginId: 'team/demo' }),
      }),
    ]);
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(fs.pathExists(agentPath)).resolves.toBe(false);
    const restored = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    expect(parseOwnedTextHeader(await fs.readFile(agentPath, 'utf8'))?.identity).toMatchObject({
      pluginId: 'team/demo', platform: 'codex', scope: 'project',
    });

    const unrelatedUserAgent = path.join(
      isolation.env.CODEX_HOME!, 'agents', 'aw-demo-reviewer.toml',
    );
    await fs.outputFile(unrelatedUserAgent, '# agent-workflows-owner: {invalid\nforeign body\n');
    const unrelatedBlocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(unrelatedBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'stateInventoryFailed' }),
    ]);
    expect(unrelatedBlocked.targetResults).not.toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);
    await expect(fs.pathExists(unrelatedUserAgent)).resolves.toBe(true);
  }, 30_000);

  it('matches a damaged reinstall owned-text target by its full normalized path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'owned-text-exact-path-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['claude'];
      manifest.extensions = {
        instructions: [{ name: 'reviewer', title: 'Reviewer', content: 'Review changes.' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => (
      { exitCode: 0, stdout: 'agent-cli 99.0.0', stderr: '' }
    ));
    const runtime = { env: isolation.env, nativeCliRunner };
    const rulePath = path.join(
      isolation.layout.fixtureCwd, '.claude', 'rules', 'aw-demo-reviewer.md',
    );
    const sourceIdentity = await calculateCatalogSourceIdentity({
      id: 'team', type: 'path', primary: true, path: sourceRoot,
    });
    await writeOwnedTextFile({
      path: rulePath,
      allowedRoot: path.join(isolation.layout.fixtureCwd, '.claude'),
      identity: {
        owner: 'agent-workflows', sourceId: 'team', sourceIdentity,
        pluginId: 'team/demo', plugin: 'demo', artifactKey: 'aw-demo-reviewer',
        platform: 'claude', scope: 'project',
      },
      content: '# Reviewer\n\nReview changes.\n',
    });
    const intentLocation = {
      scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env,
    };
    await writeIntentFixture(intentLocation, {
      ...await readFixtureRequirements(intentLocation),
      roots: [{ pluginId: 'team/demo', platforms: ['claude'] }],
    });
    const settingsPath = path.join(isolation.layout.fixtureCwd, '.claude', 'settings.json');
    await fs.outputJson(settingsPath, { sentinel: true });
    const originalRule = await fs.readFile(rulePath);
    await fs.outputFile(rulePath, '# agent-workflows-owner: {invalid\nowned target\n');

    const exactBlocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'claude', scope: 'project',
    }, runtime);
    expect(exactBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);

    await fs.outputFile(rulePath, originalRule);
    const sameBasenameAgent = path.join(
      isolation.layout.fixtureCwd, '.claude', 'agents', path.basename(rulePath),
    );
    await fs.outputFile(sameBasenameAgent, '# agent-workflows-owner: {invalid\nforeign body\n');
    const intentPath = path.join(
      isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json',
    );
    const before = {
      rule: await fs.readFile(rulePath),
      agent: await fs.readFile(sameBasenameAgent),
      intent: await fs.readFile(intentPath),
      settings: await fs.readFile(settingsPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
      nativeCalls: nativeCliRunner.mock.calls.length,
    };

    const wrongPathBlocked = await reinstallWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'claude', scope: 'project',
    }, runtime);

    expect(wrongPathBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'stateInventoryFailed' }),
    ]);
    expect(wrongPathBlocked.targetResults).not.toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);
    await expect(fs.readFile(rulePath)).resolves.toEqual(before.rule);
    await expect(fs.readFile(sameBasenameAgent)).resolves.toEqual(before.agent);
    await expect(fs.readFile(intentPath)).resolves.toEqual(before.intent);
    await expect(fs.readFile(settingsPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })).resolves.toEqual(before.settings);
    expect(nativeCliRunner.mock.calls).toHaveLength(before.nativeCalls);
  }, 30_000);

  it('invalid shared config does not authorize marker-only Codex project recovery', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const skillRoot = path.join(skillsRoot, 'owned-demo');
    await fs.ensureDir(skillRoot);
    await fs.outputJson(path.join(skillRoot, '.agent-workflows-owner.json'), {
      schemaVersion: 2,
      owner: 'agent-workflows', sourceId: 'team', sourceIdentity: 'damaged',
      pluginId: 'team/demo', plugin: 'demo', artifactKey: 'owned-demo',
      platform: 'codex', scope: 'project',
    });
    const sharedPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const foreignShared = 'invalid = [\n# agent-workflows demo without owner token\n';
    await fs.outputFile(sharedPath, foreignShared);

    const result = await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });

    expect(result.overallState).toBe('failed');
    await expect(fs.readFile(sharedPath, 'utf8')).resolves.toBe(foreignShared);
    await expect(fs.pathExists(skillRoot)).resolves.toBe(true);
  });

  it('matches a damaged project role header through a symlink cwd by its exact canonical path', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'reinstall-exact-owner-source');
    const configureLeaf = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-role', platform: 'codex', scopes: ['project'],
        target: 'codex.agentRole', requiresCodexProjectConfig: true,
        states: ['present'], refreshKeys: [], roleKey: 'shared-name',
      }] };
    };
    const definitions = [
      { name: 'leaf', configureManifest: configureLeaf },
      {
        name: 'root', dependencies: ['leaf'],
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.platforms = ['codex'];
        },
      },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'leaf'),
      roleKey: 'shared-name',
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const sourceSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceSnapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const { nativeCliRunner } = runtime;
    const exactInstalled = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(exactInstalled.overallState, JSON.stringify(exactInstalled)).toBe('succeeded');
    const linkedCwd = path.join(isolation.layout.rootDir, 'linked-project-cwd');
    await fs.symlink(
      isolation.layout.fixtureCwd,
      linkedCwd,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const rolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-leaf-shared-name.toml');
    const originalRole = await fs.readFile(rolePath, 'utf8');
    await fs.outputFile(rolePath, `# agent-workflows-owner: {invalid\n${originalRole.split('\n').slice(1).join('\n')}`);
    const distractors = [
      {
        root: path.join(isolation.env.CODEX_HOME!, 'skills', 'shared-name'),
        sourceId: 'other', platform: 'codex' as const, scope: 'user' as const,
      },
      {
        root: path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'skills', 'shared-name'),
        sourceId: 'team', platform: 'claude' as const, scope: 'user' as const,
      },
    ];
    for (const distractor of distractors) {
      await fs.ensureDir(distractor.root);
      await writeSkillOwnerMarker({
        skillRoot: distractor.root,
        allowedRoot: path.dirname(distractor.root),
        identity: {
          owner: 'agent-workflows',
          sourceId: distractor.sourceId,
          pluginId: `${distractor.sourceId}/leaf`,
          plugin: 'leaf',
          artifactKey: 'shared-name',
          platform: distractor.platform,
          scope: distractor.scope,
        },
      });
    }

    const result = await reinstallWriteCommand(['team/root'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({
          pluginId: 'team/leaf', platform: 'codex', scope: 'project',
        }),
        errorCode: 'exclusiveOwnerEvidenceInvalid',
        recoveryActions: [
          'run aw plugin cleanup team/leaf --target codex --scope project --force',
          'then run aw plugin sync team/leaf --target codex --context project --rebuild',
        ],
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root' }),
        errorCode: 'dependencyInstallFailed',
      }),
    ]));
    expect(result.targetResults.filter((target) => target.recoveryActions)).toHaveLength(1);
    for (const distractor of distractors) {
      await expect(fs.pathExists(distractor.root)).resolves.toBe(true);
    }

    const cleaned = await cleanupWriteCommand(['team/leaf'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project', force: true,
    }, { env: isolation.env });
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    expect((await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .snapshot.agents['shared-name']).toBeUndefined();
    const restored = await reinstallWriteCommand(['team/root'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);

    const unrelatedMarker = path.join(
      distractors[0]!.root,
      '.agent-workflows-owner.json',
    );
    await fs.outputFile(unrelatedMarker, '{invalid unrelated marker\n');
    const selectedRolePath = rolePath;
    const projectIntentPath = path.join(
      isolation.layout.fixtureCwd,
      '.agent-workflows',
      'plugin-intents.json',
    );
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const actualBefore = {
      selectedRole: await fs.readFile(selectedRolePath),
      unrelatedMarker: await fs.readFile(unrelatedMarker),
      projectIntent: await fs.readFile(projectIntentPath),
      projectConfig: await fs.readFile(projectConfigPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }),
      nativeCalls: nativeCliRunner.mock.calls.length,
    };

    const unrelatedBlocked = await reinstallWriteCommand(['team/root'], {
      cwd: linkedCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(unrelatedBlocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'stateInventoryFailed' }),
    ]);
    expect(unrelatedBlocked.targetResults).not.toEqual([
      expect.objectContaining({ errorCode: 'exclusiveOwnerEvidenceInvalid' }),
    ]);
    await expect(fs.readFile(selectedRolePath)).resolves.toEqual(actualBefore.selectedRole);
    await expect(fs.readFile(unrelatedMarker)).resolves.toEqual(actualBefore.unrelatedMarker);
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(actualBefore.projectIntent);
    await expect(fs.readFile(projectConfigPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    })).resolves.toEqual(actualBefore.projectConfig);
    expect(nativeCliRunner.mock.calls).toHaveLength(actualBefore.nativeCalls);
  });

  it('blocks a project override on damaged user dependency ownership and permits exact user recovery', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'reinstall-user-owner-source');
    const configureLeaf = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-role', platform: 'codex', scopes: ['user'],
        target: 'codex.agentRole', requiresCodexProjectConfig: true,
        states: ['present'], refreshKeys: [], roleKey: 'shared-name',
      }] };
    };
    const definitions = [
      { name: 'leaf', configureManifest: configureLeaf },
      {
        name: 'root', dependencies: ['leaf'],
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.platforms = ['codex'];
        },
      },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'leaf'), roleKey: 'shared-name',
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{ pluginId: 'team/leaf', platform: 'codex', scope: 'user' }],
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed)).toBe('succeeded');
    const rolePath = path.join(isolation.env.CODEX_HOME!, 'agents', 'aw-leaf-shared-name.toml');
    const originalRole = await fs.readFile(rolePath, 'utf8');
    await fs.outputFile(rolePath, `# agent-workflows-owner: {invalid\n${originalRole.split('\n').slice(1).join('\n')}`);
    const damagedRole = await fs.readFile(rolePath);
    const projectIntentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const projectIntent = await fs.readFile(projectIntentPath);
    const foreignSkill = path.join(isolation.env.CODEX_HOME!, 'skills', 'foreign-skill', 'SKILL.md');
    await fs.outputFile(foreignSkill, 'foreign\n');

    const result = await reinstallWriteCommand(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);

    expect(result.targetResults).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({
          pluginId: 'team/root', platform: 'codex', scope: 'project',
        }),
        errorCode: 'stateInventoryFailed',
        message: expect.stringContaining(
          `ownerHeaderParse@${path.join('[catalog-source]', 'agents', 'aw-leaf-shared-name.toml')}`,
        ),
      }),
    ]);
    await expect(fs.readFile(rolePath)).resolves.toEqual(damagedRole);
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntent);
    await expect(fs.readFile(foreignSkill, 'utf8')).resolves.toBe('foreign\n');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);

    const cleaned = await cleanupWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', force: true,
    }, runtime);
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(false);
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntent);
    await expect(fs.readFile(foreignSkill, 'utf8')).resolves.toBe('foreign\n');

    const restored = await reinstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, runtime);
    expect(restored.overallState, JSON.stringify(restored.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(rolePath)).resolves.toBe(true);
    expect(parseOwnedTextHeader(await fs.readFile(rolePath, 'utf8'))?.identity)
      .toMatchObject({ pluginId: 'team/leaf', artifactKey: 'shared-name', platform: 'codex', scope: 'user' });
    await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntent);
    await expect(fs.readFile(foreignSkill, 'utf8')).resolves.toBe('foreign\n');
  });

  it('does not touch obsolete contract state during markerless force recovery', async () => {
    const isolation = await configureCatalog();
    const baseRuntime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
    }, baseRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const obsolete = path.join(isolation.env.AW_HOME!, 'installation-contracts');
    await fs.outputFile(path.join(obsolete, 'old.json'), '{}');

    const result = await cleanupWriteCommand(['local/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user', force: true,
    }, {
      ...baseRuntime,
      removeObsoleteInstallationContracts: async () => {
        throw new Error('injected obsolete cleanup failure');
      },
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.warnings).toEqual([]);
    await expect(readFixtureRequirements({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [{ pluginId: 'local/demo', platforms: ['codex'] }] });
    await expect(fs.pathExists(obsolete)).resolves.toBe(true);
  });

  it('repairs a partial user provider before its project consumer and preserves both declarations', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const sourceRoot = path.join(cwd, 'cross-scope-removal-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const env = isolation.env;
    await writeIntentFixture({ scope: 'user', cwd, env },
      { roots: [{ pluginId: 'team/leaf', platforms: ['codex'] }] });
    await writeIntentFixture({ scope: 'project', cwd, env },
      { roots: [{ pluginId: 'team/root', platforms: ['codex'] }] });
    const userBefore = await observeIntent({ scope: 'user', cwd, env });
    const projectBefore = await observeIntent({ scope: 'project', cwd, env });
    const first = await runRecovery('sync', [], { cwd, env, cliVersion: '1.0.0', yes: true }, runtime);
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const userConfig = path.join(env.CODEX_HOME!, 'config.toml');
    await fs.remove(userConfig);
    const repaired = await runRecovery('sync', ['team/root'], { cwd, env, cliVersion: '1.0.0', yes: true }, runtime);
    expect(repaired.ok, JSON.stringify(repaired)).toBe(true);
    expect(repaired.targetResults).toContainEqual(expect.objectContaining({
      pluginId: 'team/leaf', scope: 'user', execution: 'applied', observation: 'verified', providerScope: 'user',
    }));
    expect(Object.values((await readCodexConfigFile(userConfig)).snapshot.developerInstructions.managedBlocks))
      .toContainEqual(expect.objectContaining({ value: expect.stringContaining('leaf.') }));
    await expect(observeIntent({ scope: 'user', cwd, env })).resolves.toEqual(userBefore);
    await expect(observeIntent({ scope: 'project', cwd, env })).resolves.toEqual(projectBefore);
  });

  it('derives user dependency placement again for sync and rebuild without saved overrides', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const sourceRoot = path.join(cwd, 'persistent-placement-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env,
    });
    await writeIntentFixture({ scope: 'user', cwd, env },
      { roots: [{ pluginId: 'team/leaf', platforms: ['codex'] }] });
    await writeIntentFixture({ scope: 'project', cwd, env },
      { roots: [{ pluginId: 'team/root', platforms: ['codex'] }] });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const userBefore = await observeIntent({ scope: 'user', cwd, env });
    const projectBefore = await observeIntent({ scope: 'project', cwd, env });
    const preferencesPath = await resolvePreferencesPath({ scope: 'user', cwd, env });
    const preferencesBefore = await fs.readFile(preferencesPath);
    for (const command of ['sync', 'reinstall'] as const) {
      await fs.remove(path.join(env.CODEX_HOME!, 'config.toml'));
      const result = await runRecovery(command, ['team/root'], { cwd, env, cliVersion: '1.0.0', yes: true }, runtime);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result.targetResults).toContainEqual(expect.objectContaining({
        pluginId: 'team/leaf', scope: 'user', providerScope: 'user', observation: 'verified',
      }));
      await expect(observeIntent({ scope: 'user', cwd, env })).resolves.toEqual(userBefore);
      await expect(observeIntent({ scope: 'project', cwd, env })).resolves.toEqual(projectBefore);
      await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
    }
  });

  it('keeps a failed explicit user Native provider for a prepared AW extension root', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(
      isolation.layout.fixtureCwd,
      'failed-native-manager-intent-source',
    );
    const definitions = [
      {
        name: 'b',
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.platforms = ['codex'];
          manifest.skills = './skills';
          manifest.extensions = undefined;
        },
      },
      {
        name: 'a',
        dependencies: ['b'],
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.platforms = ['codex'];
        },
      },
      {
        name: 'independent',
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.platforms = ['codex'];
        },
      },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const nativeSkillRoot = path.join(sourceRoot, 'plugins', 'b', 'skills', 'b-skill');
    await Promise.all([
      fs.outputFile(
        path.join(nativeSkillRoot, 'SKILL.md'),
        '---\nname: b-skill\ndescription: B skill.\n---\n',
      ),
      fs.outputFile(
        path.join(nativeSkillRoot, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    await writeIntentFixture({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
      { roots: [{ pluginId: 'team/b', platforms: ['codex'] }] });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const listCallsBefore = runtime.nativeCliRunner.mock.calls.length;
    const failingManagerResolver: NonNullable<
      RebuildCommandRuntime['codexManagerResolver']
    > = async (options) => {
      const listed = await options.runner({
        command: 'codex',
        args: ['plugin', 'list', '--marketplace', 'aw', '--json'],
        agentKind: 'codex',
        cwd: options.cwd,
        env: options.env,
      });
      expect(listed.exitCode).toBe(0);
      throw new Error('injected manager resolver failure');
    };

    const first = await installFixturePlugin(['team/a', 'team/independent'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [{
        pluginId: 'team/b', platform: 'codex', scope: 'user',
      }],
    }, {
      ...runtime,
      codexManagerResolver: failingManagerResolver,
    });

    expect(runtime.nativeCliRunner.mock.calls.slice(listCallsBefore).some(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'list' && args.includes('--json');
    }), JSON.stringify(first, null, 2)).toBe(true);
    expect(first.overallState).toBe('partial');
    expect(first.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/b', scope: 'user' }),
        state: 'failed',
        message: expect.stringContaining('injected manager resolver failure'),
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/a', scope: 'project' }),
        action: 'skipped', state: 'failed', errorCode: 'dependencyInstallFailed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/independent', scope: 'project' }),
        state: 'completed',
      }),
    ]));
    const receipt = (await import('../../src/output/command-receipt.js'))
      .buildRebuildReceiptJson('install', first);
    expect(receipt).toMatchObject({
      overallState: 'partial',
      requestedPluginIds: ['team/a', 'team/independent'],
      resolvedPluginIds: ['team/a', 'team/b', 'team/independent'],
      dependencyEdges: [{ from: 'team/a', to: 'team/b', platform: 'codex' }],
    });
    expect(receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/a' }),
        action: 'skipped', errorCode: 'dependencyInstallFailed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/independent' }),
        state: 'completed',
      }),
    ]));
    const intentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
      schemaVersion: 3,
      kind: 'aw-plugin-intents',
      roots: [
        { pluginId: 'team/a', platforms: ['codex'] },
        { pluginId: 'team/independent', platforms: ['codex'] },
      ],
      dependencyScopeOverrides: [],
    });
    await writePreferences(intentLocation, {
      ...createEmptyPreferences(),
      targets: ['codex'],

    });

    const fakeCodexBin = await writeIntentRoundTripCodexPackage(path.join(
      isolation.layout.rootDir,
      'failed-native-manager-intent-codex',
    ));
    const syncOutput = await runIntentRoundTripCliChild([
      'plugin', 'sync',
      '--context',
      'project',
      '--target',
      'codex',
      '--json',
      '--yes',
    ], isolation.layout.fixtureCwd, {
      ...isolation.env,
      PATH: `${fakeCodexBin}${path.delimiter}${isolation.env.PATH ?? ''}`,
      npm_config_offline: 'true',
      NPM_CONFIG_OFFLINE: 'true',
    }, 1);
    const syncReceipt = parseIntentRoundTripReceipt(syncOutput);
    expect(syncReceipt.targetResults.find((target) =>
      target.target.pluginId === 'team/b')).toMatchObject({
      target: { pluginId: 'team/b', scope: 'user' },
    });
    expect(syncReceipt.targetResults.find((target) =>
      target.target.pluginId === 'team/independent')).toMatchObject({
      target: { pluginId: 'team/independent', scope: 'project' },
      state: 'completed',
    });
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
      schemaVersion: 3,
      kind: 'aw-plugin-intents',
      roots: [
        { pluginId: 'team/a', platforms: ['codex'] },
        { pluginId: 'team/independent', platforms: ['codex'] },
      ],
      dependencyScopeOverrides: [],
    });

    await expect(readFixtureRequirements({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .resolves.toMatchObject({ roots: [{ pluginId: 'team/b', platforms: ['codex'] }], dependencyScopeOverrides: [] });
    const projectBeforeOverlap = await readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const overlapping = await installFixturePlugin(
      ['team/a', 'team/b', 'team/independent'],
      { cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user' },
      { ...runtime, codexManagerResolver: failingManagerResolver },
    );
    expect(overlapping.overallState).toBe('partial');
    expect(overlapping.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/b', scope: 'user' }),
        errorCode: 'writeFailed', state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/a', scope: 'user' }),
        errorCode: 'dependencyInstallFailed', state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/independent', scope: 'user' }),
        state: 'completed',
      }),
    ]));
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toEqual(projectBeforeOverlap);
  }, 60_000);

  it('derives user dependency placement through independent CLI processes without saved overrides', async () => {
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'intent-round-trip-source');
    const dynamicRole = (roleKey: string) => (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.extensions = undefined;
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { targets: [{
        id: 'dynamic-role',
        platform: 'codex',
        scopes: ['project', 'user'],
        target: 'codex.agentRole',
        requiresCodexProjectConfig: true,
        states: ['present'],
        refreshKeys: [],
        roleKey,
      }] };
    };
    const definitions = [
      { name: 'c', configureManifest: dynamicRole('c-role') },
      { name: 'b', dependencies: ['c'], configureManifest: dynamicRole('b-role') },
      {
        name: 'a',
        dependencies: ['b'],
        configureManifest: (manifest: PluginMeta['manifest']) => {
          manifest.platforms = ['codex'];
        },
      },
    ];
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    await Promise.all([
      writeDynamicRoleRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'b'),
        roleKey: 'b-role',
      }),
      writeDynamicRoleRenderer({
        pluginRoot: path.join(sourceRoot, 'plugins', 'c'),
        roleKey: 'c-role',
      }),
    ]);
    await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
    const sourceSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: sourceSnapshot.digest,
      env: isolation.env,
    });
    const fakeCodexBin = await writeIntentRoundTripCodexPackage(path.join(
      isolation.layout.rootDir,
      'intent-round-trip-codex',
    ));
    const childEnv = {
      ...isolation.env,
      PATH: `${fakeCodexBin}${path.delimiter}${isolation.env.PATH ?? ''}`,
      npm_config_offline: 'true',
      NPM_CONFIG_OFFLINE: 'true',
    };
    await runIntentRoundTripCliChild([
      'plugin', 'install', 'team/b', '--scope', 'user', '--json', '--yes',
    ], isolation.layout.fixtureCwd, childEnv);
    await runIntentRoundTripCliChild([
      'plugin', 'install',
      'team/a',
      '--scope',
      'project',
      '--json',
      '--yes',
    ], isolation.layout.fixtureCwd, childEnv);
    const intentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
      schemaVersion: 3,
      kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/a', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });
    const userRoleRoot = path.join(isolation.env.CODEX_HOME!, 'agents');
    const projectRoleRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'agents');
    const roleNames = ['aw-b-b-role.toml', 'aw-c-c-role.toml'];
    const preferencesPath = await resolvePreferencesPath(intentLocation);
    const preferencesBefore = await fs.readFile(preferencesPath);
    const projectBefore = await observeIntent(intentLocation);
    const userLocation = { ...intentLocation, scope: 'user' as const };
    const userBefore = await observeIntent(userLocation);
    for (const name of roleNames) {
      const rolePath = path.join(userRoleRoot, name);
      const delivered = await fs.readFile(rolePath, 'utf8');
      expect(delivered).toContain('Use this role.');
      await fs.writeFile(rolePath, delivered.replace('Use this role.', 'Stale provider output.'));
    }
    await runIntentRoundTripCliChild([
      'plugin', 'sync',
      'team/a',
      '--context',
      'project',
      '--target',
      'codex',
      '--json',
      '--yes',
    ], isolation.layout.fixtureCwd, childEnv);
    for (const name of roleNames) {
      await expect(fs.readFile(path.join(userRoleRoot, name), 'utf8')).resolves.toContain('Use this role.');
      await expect(fs.pathExists(path.join(projectRoleRoot, name))).resolves.toBe(false);
    }
    await expect(observeIntent(intentLocation)).resolves.toEqual(projectBefore);
    await expect(observeIntent(userLocation)).resolves.toEqual(userBefore);
    await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
      roots: [{ pluginId: 'team/a', platforms: ['codex'] }], dependencyScopeOverrides: [],
    });

    await runIntentRoundTripCliChild([
      'plugin', 'remove',
      'team/a',
      '--scope',
      'project',
      '--json', '--yes',
    ], isolation.layout.fixtureCwd, childEnv);
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
      schemaVersion: 3,
      kind: 'aw-plugin-intents',
      roots: [], dependencyScopeOverrides: [],
    });
    await expect(observeIntent(userLocation)).resolves.toEqual(userBefore);
    for (const name of roleNames) await expect(fs.pathExists(path.join(userRoleRoot, name))).resolves.toBe(true);
  }, 60_000);

  it('preserves project roots and local overrides during local uninstall', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'intent-prune-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'first-leaf' },
      { name: 'second-leaf' },
      { name: 'shared-leaf' },
      { name: 'first-root', dependencies: ['first-leaf', 'shared-leaf'] },
      { name: 'second-root', dependencies: ['second-leaf', 'shared-leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/first-root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [
        { pluginId: 'team/first-leaf', platform: 'codex', scope: 'user' },
        { pluginId: 'team/shared-leaf', platform: 'codex', scope: 'user' },
      ],
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(installFixturePlugin(['team/second-root'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
      dependencyScopeOverrides: [
        { pluginId: 'team/second-leaf', platform: 'codex', scope: 'user' },
        { pluginId: 'team/shared-leaf', platform: 'codex', scope: 'user' },
      ],
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });

    const requirementsBefore = await readFixtureRequirements({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env });
    await expect(uninstallWriteCommand(['team/first-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toEqual(requirementsBefore);
    await expect(readFixtureRequirements({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ roots: [] });

    await expect(uninstallWriteCommand(['team/second-root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toEqual(requirementsBefore);
  });

  it('reconciles Codex AW extensions from component-specific live evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'component-evidence-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'guide', title: 'Guide', content: 'Guide.' }],
          agents: [{ name: 'worker', description: 'Worker.', prompt: 'Work.' }],
        };
      },
    }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const agentPath = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-demo-worker.toml',
    );
    await fs.remove(agentPath);

    const synced = await syncWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(synced.overallState, JSON.stringify(synced.rebuildResults)).toBe('succeeded');
    expect(synced.codexReconcilePlans?.[0]?.extensionWrites).toEqual([
      expect.objectContaining({
        componentKey: 'extensions.agents:worker', scope: 'project', action: 'write',
      }),
    ]);
    expect(synced.codexReconcilePlans?.[0]?.extensionWrites).not.toContainEqual(
      expect.objectContaining({ componentKey: 'extensions.instructions:guide' }),
    );
  });

  it.each(['uninstall', 'cleanup'] as const)(
    'keeps a Project consumer unchanged during a User %s',
    async (command) => {
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `cross-scope-batch-${command}-source`);
      await createDependencyCatalogSnapshotFixture(sourceRoot, [
        { name: 'leaf' },
        { name: 'root', dependencies: ['leaf'] },
      ]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const runtime = {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      };
      await expect(installFixturePlugin(['team/leaf'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      await expect(installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        dependencyScopeOverrides: [{ pluginId: 'team/leaf', platform: 'codex', scope: 'user' }],
      }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
      const projectIntentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
      const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      const [projectIntentBefore, projectConfigBefore] = await Promise.all([
        fs.readFile(projectIntentPath), fs.readFile(projectConfigPath),
      ]);
      const result = await (command === 'uninstall' ? uninstallWriteCommand : cleanupWriteCommand)(
        ['team/leaf'], { cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user' }, runtime);
      expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
      expect(result.targetResults).toContainEqual(expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/leaf', scope: 'user' }),
        state: 'completed',
      }));
      await expect(fs.readFile(projectIntentPath)).resolves.toEqual(projectIntentBefore);
      await expect(fs.readFile(projectConfigPath)).resolves.toEqual(projectConfigBefore);
    },
  );

  it('keeps a healthy consumer from becoming ready when its live dependency is missing', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-status-source');
    const agentPlugin = (name: string) => ({
      name,
      configureManifest: (manifest: Awaited<ReturnType<typeof readPluginManifest>>['manifest']) => {
        manifest.extensions = {
          agents: [{ name: `${name}-role`, description: `${name} role.`, prompt: `${name}.` }],
        };
      },
    });
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      agentPlugin('leaf'),
      { ...agentPlugin('root'), dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const status = () => statusCommandV8({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    const leafAgent = path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-leaf-leaf-role.toml',
    );
    const canonicalLeafAgent = await fs.realpath(leafAgent);
    const readFile = fs.readFile;
    const unreadableAgent = vi.spyOn(fs, 'readFile').mockImplementation((...args) => {
      if ([leafAgent, canonicalLeafAgent].includes(String(args[0]))) {
        return Promise.reject(Object.assign(new Error('Access denied'), { code: 'EACCES' }));
      }
      return Reflect.apply(readFile, fs, args);
    });
    const driftedLeaf = await statusCommandV8({
      plugins: ['team/leaf'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    }).finally(() => unreadableAgent.mockRestore());
    expect(driftedLeaf.payload.targets).toEqual([expect.objectContaining({
      state: 'blocked',
      placements: [expect.objectContaining({
        reasons: expect.arrayContaining([
          expect.objectContaining({ code: 'componentInspectionFailed', severity: 'blocking' }),
          expect.objectContaining({ code: 'codexExtensionDrift' }),
        ]),
        components: expect.arrayContaining([expect.objectContaining({
          key: 'aw-leaf-leaf-role',
          metadata: { errorCode: 'componentInspectionFailed' },
        })]),
      })],
    })]);
    expect(statusTargetExtensions(driftedLeaf.payload.targets[0]!.placements[0]!))
      .toMatchObject({ state: 'drifted' });
    await fs.remove(leafAgent);
    const missingLeaf = await statusCommandV8({
      plugins: ['team/leaf'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    expect(missingLeaf.payload.targets).toEqual([expect.objectContaining({
      state: 'needsSync',
    })]);
    expect(statusTargetExtensions(missingLeaf.payload.targets[0]!.placements[0]!))
      .toMatchObject({ state: 'missing' });
    await expect(status()).resolves.toMatchObject({
      hasErrors: false,
      payload: { targets: [expect.objectContaining({
        state: 'needsSync',
        placements: [expect.objectContaining({
          scope: 'project',
          state: 'needsSync',
          components: expect.arrayContaining([expect.objectContaining({
            kind: 'dependency',
            key: 'team/leaf',
            state: 'absent',
            metadata: expect.objectContaining({
              rootIssueCode: 'dependencyMissing',
              rootIssueId: 'dependencyMissing:team/leaf:codex:project',
            }),
          })]),
        })],
        reasons: expect.arrayContaining([
          expect.objectContaining({
            code: 'dependencyMissing',
            dependencyPluginId: 'team/leaf',
            rootIssueCode: 'dependencyMissing',
            rootIssueId: 'dependencyMissing:team/leaf:codex:project',
          }),
        ]),
      })] },
    });
    const createController = () => new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: runtime.nativeCliRunner,
      interactive: false,
    })));
    const missingController = createController();
    await missingController.load();
    const missingIssue = missingController.listUserIssues().find((issue) =>
      issue.issueId === 'dependencyMissing:team/leaf:codex:project');
    expect(missingIssue).toMatchObject({
      relationship: 'consumer',
      rootEntity: { pluginId: 'team/leaf', platform: 'codex', scope: 'project' },
      affectedTargets: [expect.objectContaining({
        pluginId: 'team/root', relationship: 'consumer',
      })],
    });
    expect(missingIssue?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'sync', pluginId: 'team/root', platform: 'codex',
        scope: 'project', writeAction: 'sync',
      }),
      expect.objectContaining({ id: 'viewDependencyIssue', pluginId: 'team/leaf' }),
    ]));
    missingController.dispose();

    await expect(reinstallWriteCommand(['team/leaf'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await fs.remove(leafAgent);
    await fs.ensureDir(leafAgent);
    const notReadyController = createController();
    await notReadyController.load();
    const collisionIssue = notReadyController.listUserIssues().find((issue) =>
      issue.category === 'artifactCollision'
      && issue.pluginId === 'team/leaf'
      && issue.platform === 'codex'
      && issue.scope === 'project');
    expect(collisionIssue).toMatchObject({
      group: 'artifactCollision',
      relationship: 'direct',
      rootEntity: { pluginId: 'team/leaf', platform: 'codex', scope: 'project' },
      affectedTargets: expect.arrayContaining([expect.objectContaining({
        pluginId: 'team/root',
        platform: 'codex',
        scope: 'project',
        relationship: 'consumer',
      })]),
      technicalDetails: expect.arrayContaining([expect.objectContaining({ code: 'dependencyNotReady' })]),
    });
    const collisionStatus = await status();
    expect(collisionStatus).toMatchObject({
      hasErrors: false,
      payload: { targets: [expect.objectContaining({
        placements: [expect.objectContaining({
          scope: 'project',
          components: expect.arrayContaining([expect.objectContaining({
            kind: 'dependency',
            key: 'team/leaf',
            state: 'blockedByCollision',
            metadata: expect.objectContaining({
              rootIssueCode: 'artifactCollision',
              rootIssueId: expect.stringContaining('artifactCollision:team/leaf:codex:project:'),
            }),
          })]),
        })],
        reasons: expect.arrayContaining([expect.objectContaining({
          code: 'dependencyNotReady',
          dependencyPluginId: 'team/leaf',
          rootIssueCode: 'artifactCollision',
        })]),
      })] },
    });
    notReadyController.dispose();
  });

  it('projects a dependency target blocker through a real controller load', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const targetRoot = path.join(isolation.layout.fixtureCwd, 'dependency-target-issue-source');
    await createDependencyCatalogSnapshotFixture(targetRoot, [
      {
        name: 'leaf',
        configureManifest: (manifest) => {
          manifest.platforms = ['codex'];
        },
      },
      { name: 'root', dependencies: ['leaf'] },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'target', type: 'path', primary: true, path: targetRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
    })));
    await controller.load();

    expect(controller.listUserIssues()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'dependencyTargetUnsupported',
        group: 'dependency',
        pluginId: 'target/root',
      }),
    ]));
    expect(controller.getPluginOverview('target/root')?.primaryAttention?.code)
      .toBe('dependencyTargetUnsupported');
    controller.dispose();
  });

  it('deduplicates status inspection for one dependency placement shared by consumers', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'status-dedup-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' },
      { name: 'first', dependencies: ['leaf'] },
      { name: 'second', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    };
    const installed = await installFixturePlugin(['team/first', 'team/second'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    let dependencyInspections = 0;
    setStatusDependencyInspectionHookForTests(() => { dependencyInspections += 1; });
    try {
      await statusCommandV8({
        plugins: ['team/first', 'team/second'], cwd: isolation.layout.fixtureCwd,
        env: isolation.env, cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
      });
    } finally {
      setStatusDependencyInspectionHookForTests(undefined);
    }
    expect(dependencyInspections).toBe(1);
  });

  it('uses current manifest edges for status dependency checks', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dependency-contract-drift-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: ['leaf'] },
    ]);
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] }, expectedDigest: snapshot.digest, env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    const installed = await installFixturePlugin(['team/root'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const status = () => statusCommandV8({
      plugins: ['team/root'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    await expect(status()).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'ready', reasons: [] })], errors: [] },
    });

    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: [] },
    ]);
    await expect(status()).resolves.toMatchObject({
      payload: { targets: [expect.objectContaining({ state: 'ready', reasons: [] })] },
    });
  });

  it('checks every requested target for foreign ownership before the first root writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'batch-foreign-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'first' },
      {
        name: 'second',
        configureManifest: (manifest) => {
          manifest.extensions!.agents = [{
            name: 'second-role', description: 'Second role.', prompt: 'Second.',
          }];
        },
      },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const foreignRole = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-second-second-role.toml');
    await fs.outputFile(foreignRole, 'foreign');

    const result = await installFixturePlugin(['team/first', 'team/second'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    });

    expect(result.overallState).toBe('partial');
    expect(result.targetResults.length).toBeGreaterThan(0);
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: 'artifactCollision' }),
    ]));
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'))).resolves.toBe(true);
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('foreign');

    for (const pluginId of ['team/first', 'team/second']) {
      await expect(cleanupWriteCommand([pluginId], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, {
        env: isolation.env,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      })).resolves.toMatchObject({
        overallState: 'succeeded',
      });
    }
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('foreign');
  });

  it('projects dynamic config and saves or resets it only through the real Controller review bridge', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-config-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = {
        fields: {
          level: {
            type: 'string',
            title: '审查级别',
            choices: {
              allowCustom: false,
              presets: [
                { id: 'fast', title: '快速', value: 'fast' },
                { id: 'strict', title: '严格', value: 'strict', recommended: true },
              ],
            },
          },
          count: { type: 'number', validation: { minimum: 1, maximum: 10 }, title: '重试次数' },
          token: { type: 'string', sensitive: true, title: '令牌' },
          rules: { type: 'string', title: '规则文件' },
        },
        presentation: {
          groups: [{ id: 'basic', title: '基本设置', fields: ['level', 'count', 'token', 'rules'] }],
        },
      };
    });
    const source = { id: 'team', type: 'path' as const, primary: true, path: sourceRoot };
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    const page = await dependencies.getConfigPage!(
      'team/demo',
      { scope: 'user', projectLayer: 'shared' },
      new AbortController().signal,
    );
    expect(page.groups).toEqual([
      expect.objectContaining({
        title: '基本设置',
        fields: expect.arrayContaining([
          expect.objectContaining({
            key: 'level',
            choices: expect.arrayContaining([
              expect.objectContaining({ id: 'fast', title: '快速', value: 'fast' }),
              expect.objectContaining({ id: 'strict', title: '严格', value: 'strict', recommended: true }),
            ]),
          }),
          expect.objectContaining({ key: 'count', min: 1, max: 10 }),
          expect.objectContaining({ key: 'token', sensitive: true }),
        ]),
      }),
    ]);
    expect(page.presets).toEqual([]);

    const controller = new TuiController(dependencies);
    await controller.load();
    const save = await controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      projectLayer: 'shared',
      updates: { level: 'strict', count: '7', token: 'sk-private' },
      sensitiveKeys: ['token'],
    });
    expect(JSON.stringify(save)).not.toContain('sk-private');
    await expect(controller.executeOperation(save.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });

    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    await expect(readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ exists: true, values: { level: 'strict', count: 7, token: 'sk-private' } });

    await expect(controller.buildOperationReview({
      kind: 'configSave',
      pluginId: 'team/demo',
      scope: 'user',
      projectLayer: 'shared',
      updates: { count: 99 },
    })).rejects.toThrow('操作未建立。请检查当前设置后重试。');

    const unavailableRoot = `${sourceRoot}-unavailable`;
    await fs.move(sourceRoot, unavailableRoot);
    const availability = await controller.getConfigResetAvailability(
      'team/demo',
      { scope: 'user', projectLayer: 'shared' },
    );
    expect(availability).toMatchObject({
      exists: true,
      sourceIdentityPresent: true,
      sourceIdentity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(availability)).not.toContain('sk-private');
    expect(JSON.stringify(availability)).not.toContain(sourceRoot);

    await expect(controller.buildOperationReview({
      kind: 'configReset',
      pluginId: 'team/demo',
      scope: 'user',
      projectLayer: 'shared',
    })).resolves.toMatchObject({ title: '重置插件设置' });
    await expect(readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'demo',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({
      exists: true,
      values: { level: 'strict', count: 7, token: 'sk-private' },
    });

    await fs.move(unavailableRoot, sourceRoot);
    const restoredSave = await controller.buildOperationReview({
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared', updates: { level: 'fast' },
    });
    await expect(controller.executeOperation(restoredSave.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    const onlineReset = await controller.buildOperationReview({
      kind: 'configReset', pluginId: 'team/demo', scope: 'user', projectLayer: 'shared',
    });
    await expect(controller.executeOperation(onlineReset.reviewToken)).resolves.toMatchObject({ state: 'succeeded' });
    controller.dispose();
  });

  it('executes a real dual-platform TUI write under one complete locked review', async (test) => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex', 'claude'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-both-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    await fs.outputFile(path.join(pluginRoot, 'scripts', 'render.mjs'), [
      'import { readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const files = { "SKILL.md": "---\\nname: review\\ndescription: Review.\\n---\\n", "README.md": "Review.\\n" };',
      'if (context.platform === "codex") files["agents/openai.yaml"] = "policy:\\n  allow_implicit_invocation: true\\n";',
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: `${context.platform}-review`, kind: "skill", platform: context.platform,',
      '  target: `${context.platform}.skill`, state: "present", refreshKeys: [],',
      '  skillKey: "review", content: { files }',
      '}] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex', 'claude'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: (['codex', 'claude'] as const).map((platform) => ({
          id: `${platform}-review`,
          platform,
          scopes: ['user', 'project'],
          target: `${platform}.skill`,
          states: ['present'],
          refreshKeys: [],
          skillKey: 'review',
        })),
      };
      manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string', title: '模式' } } };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const codex = await createCodexNativeTestRuntime(isolation);
    const claude = await createClaudeNativeTestRuntime(isolation);
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: (invocation) => invocation.command === 'claude'
        ? claude.nativeCliRunner(invocation) : codex.nativeCliRunner(invocation),
      interactive: false,
    }));

    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    const request = { kind: 'recovery' as const, command: 'install' as const,
      scope: 'project' as const, selectors: ['team/demo'] };
    const installPlan = await dependencies.prepareScopedTask!(request, new AbortController().signal);
    expect(installPlan).toMatchObject({ kind: 'recovery', scope: 'project' });
    if (installPlan.kind !== 'recovery') throw new Error('Expected recovery plan.');
    expect(installPlan.plan.receipt.requestedTargets.map((target) => target.agent))
      .toEqual(['claude', 'codex']);
    const installed = await dependencies.executeScopedTask!(installPlan);
    expect(installed).toMatchObject({ kind: 'recovery',
      receipt: { scope: 'project', command: 'install' } });
    if (installed.kind !== 'recovery') throw new Error('Expected recovery receipt.');
    expect(installed.receipt.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/demo', agent: 'codex', scope: 'project' }),
      expect.objectContaining({ pluginId: 'team/demo', agent: 'claude', scope: 'project' }),
    ]));
    expect(installed.receipt.targetResults.flatMap((target) =>
      target.blockers.map((blocker) => blocker.code))).not.toContain('operationReviewStale');

    const reinstallRequest = { ...request, command: 'reinstall' as const };
    const failedPlan = await dependencies.prepareScopedTask!(
      reinstallRequest, new AbortController().signal);
    setRebuildCommandTestHooksForTests({
      async afterTargetBuilt() {
        throw new Error('durableCleanupFailed: retained backup cleanup failed');
      },
    });
    try {
      const outcome = await dependencies.executeScopedTask!(failedPlan);
      expect(outcome).toMatchObject({ kind: 'recovery',
        receipt: { scope: 'project', command: 'reinstall', ok: false } });
      if (outcome.kind !== 'recovery') throw new Error('Expected recovery receipt.');
      expect(outcome.receipt.targetResults.map((target) => target.agent))
        .toEqual(expect.arrayContaining(['codex', 'claude']));
    } finally {
      setRebuildCommandTestHooksForTests(undefined);
    }
    const configIntent = {
      kind: 'configSave', pluginId: 'team/demo', scope: 'user', context: 'project',
      updates: { mode: 'strict' },
    } as const;
    const reinstallPlan = await dependencies.prepareScopedTask!(
      reinstallRequest, new AbortController().signal);
    const configController = new TuiController(dependencies);
    await configController.load();
    const configReview = await configController.buildOperationReview(configIntent);
    const concurrentResults = await Promise.race([
      Promise.allSettled([
        dependencies.executeScopedTask!(reinstallPlan),
        configController.executeOperation(configReview.reviewToken),
      ]),
      new Promise<never>((_resolve, reject) => setTimeout(() =>
        reject(new Error('ABBA operation lock timeout')), 5_000)),
    ]);
    const safeMessage = (message: string) => sanitizeTestDiagnostic(message, isolation.env).slice(0, 1000);
    const rejection = (result: PromiseSettledResult<unknown>) => result.status === 'rejected' ? {
      code: typeof result.reason?.code === 'string' ? safeMessage(result.reason.code) : undefined,
      message: safeMessage(result.reason instanceof Error ? result.reason.message : String(result.reason)),
    } : undefined;
    const reinstallReceipt = concurrentResults[0].status === 'fulfilled'
      && concurrentResults[0].value.kind === 'recovery' ? concurrentResults[0].value.receipt : undefined;
    const configResult = concurrentResults[1].status === 'fulfilled' ? concurrentResults[1].value : undefined;
    const configDiagnostics = configResult?.operationRecordId
      ? configController.getOperationDiagnostic(configResult.operationRecordId)?.diagnostics : undefined;
    console.log('AW_TEST_RESULT', JSON.stringify({
      test: test.task.name,
      reinstall: {
        status: concurrentResults[0].status,
        ok: reinstallReceipt?.ok,
        blockers: reinstallReceipt?.blockers.map(({ code }) => code),
        errors: reinstallReceipt?.errors.map(({ code, message }) => ({ code, message: safeMessage(message) })),
        rejection: rejection(concurrentResults[0]),
      },
      configSave: {
        status: concurrentResults[1].status,
        state: configResult?.state,
        code: configResult && 'code' in configResult ? configResult.code : undefined,
        message: configResult && 'message' in configResult ? safeMessage(configResult.message) : undefined,
        summaryCode: configResult && 'summary' in configResult ? configResult.summary?.code : undefined,
        effects: configResult?.effects,
        diagnostics: configDiagnostics?.map(({ code, stage, safeMessage: message }) => ({ code, stage, message: safeMessage(message) })),
        rejection: rejection(concurrentResults[1]),
      },
    }));
    if (concurrentResults[0].status === 'rejected') {
      expect(concurrentResults[0].reason).toMatchObject({ code: 'operationReviewStale' });
    } else {
      expect(concurrentResults[0].value).toMatchObject({ kind: 'recovery',
        receipt: { scope: 'project', command: 'reinstall' } });
    }
    if (concurrentResults[1].status === 'rejected') {
      expect(concurrentResults[1].reason).toMatchObject({ code: 'operationReviewStale' });
    } else {
      expect(concurrentResults[1].value.state).toMatch(/succeeded|stale/);
      if (concurrentResults[1].value.state === 'succeeded') {
        const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
        await expect(readPluginConfigStore({
          sourceId: 'team',
          sourceIdentity: (await calculateCatalogSourceIdentity({
            id: 'team', type: 'path', primary: true, path: sourceRoot,
          })),
          logicalIdentity, pluginName: 'demo', scope: 'user',
          cwd: isolation.layout.fixtureCwd, env: isolation.env,
        })).resolves.toMatchObject({ values: { mode: 'strict' } });
      }
    }
    configController.dispose();
  });

  it('rejects a reviewed User install after concurrent Project demand changes without touching output', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-scope-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'review', title: 'Review', content: 'scope evidence' }],
        agents: [{ name: 'reviewer', description: 'Review.', prompt: 'scope evidence' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' });
    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));

    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, nativeCliRunner, interactive: false,
    }));
    const request = { kind: 'recovery' as const, command: 'install' as const,
      scope: 'user' as const, selectors: ['team/demo'] };
    const review = await dependencies.prepareScopedTask!(request, new AbortController().signal);
    expect(review).toMatchObject({ kind: 'recovery', scope: 'user' });
    const concurrent = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(concurrent.overallState).toBe('succeeded');
    const projectIntent = await readFixtureRequirements({ scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env });
    const projectAgentPath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-reviewer.toml');
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const projectAgent = await fs.readFile(projectAgentPath);
    const projectConfig = await fs.readFile(projectConfigPath);

    const result = await dependencies.executeScopedTask!(review);
    expect(result).toMatchObject({ kind: 'recovery', receipt: {
      scope: 'user', ok: false, declarationChanged: false, outputsMayHaveChanged: false,
      blockers: [expect.objectContaining({ code: 'operationReviewStale' })],
    } });
    await expect(fs.pathExists(path.join(isolation.env.CODEX_HOME!, 'agents', 'aw-demo-reviewer.toml')))
      .resolves.toBe(false);
    await expect(observeIntent({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }))
      .resolves.toMatchObject({ state: 'absent' });
    await expect(readFixtureRequirements({ scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env })).resolves.toEqual(projectIntent);
    await expect(fs.readFile(projectAgentPath)).resolves.toEqual(projectAgent);
    await expect(fs.readFile(projectConfigPath)).resolves.toEqual(projectConfig);
  });

  it('reviews and executes I03 partial removal through the real TUI write bridge', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-partial-remove-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'review', title: 'Review', content: 'Review changes.' }],
        agents: [{ name: 'reviewer', description: 'Review.', prompt: 'Review changes.' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' });
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).resolves.toMatchObject({ overallState: 'succeeded' });
    const agentPath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-demo-reviewer.toml');
    await expect(fs.pathExists(agentPath)).resolves.toBe(true);
    await fs.remove(agentPath);
    const foreignPath = path.join(path.dirname(agentPath), 'foreign.toml');
    await fs.outputFile(foreignPath, 'foreign bytes\n');
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env, nativeCliRunner, interactive: false,
    })));
    await controller.load();
    const issue = controller.listUserIssues().find((entry) =>
      entry.category === 'incompleteInstallation'
      && entry.pluginId === 'team/demo'
      && entry.platform === 'codex'
      && entry.scope === 'project');
    expect(issue, JSON.stringify(controller.snapshot.viewModel?.issues)).toBeDefined();
    const review = await controller.prepareScopedTask({ kind: 'recovery', command: 'uninstall',
      scope: 'project', selectors: ['team/demo'] });
    expect(review).toMatchObject({ kind: 'recovery', scope: 'project' });

    const removal = await controller.executeScopedTask(review);
    expect(removal, JSON.stringify(removal)).toMatchObject({ kind: 'recovery', receipt: {
      scope: 'project', command: 'uninstall', declarationChanged: true,
      preferencesChanged: false, configChanged: false,
    } });
    await expect(readFixtureRequirements({ scope: 'project', cwd: isolation.layout.fixtureCwd,
      env: isolation.env })).resolves.toMatchObject({
        roots: [],
      });
    await expect(fs.pathExists(agentPath)).resolves.toBe(false);
    await expect(fs.readFile(foreignPath, 'utf8')).resolves.toBe('foreign bytes\n');
    controller.dispose();
  });

  it('returns a new Review when source evidence changes before dispatch', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-stale-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'review', title: 'Review', content: 'must not be written' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    }));
    const request = { kind: 'recovery' as const, command: 'install' as const,
      scope: 'project' as const, selectors: ['team/demo'] };
    const review = await dependencies.prepareScopedTask!(request, new AbortController().signal);
    expect(review).toMatchObject({ kind: 'recovery', scope: 'project' });
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'changed\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'review', title: 'Review', content: 'changed content' }],
      };
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    });
    const result = await dependencies.executeScopedTask!(review);
    expect(result).toMatchObject({ kind: 'recovery', receipt: { scope: 'project', ok: false } });
    if (result.kind !== 'recovery') throw new Error('Expected recovery receipt.');
    expect(result.receipt.blockers.concat(result.receipt.errors).map((entry) => entry.code))
      .toContain('operationReviewStale');
    await expect(readFixtureRequirements({ scope: 'project', cwd: isolation.layout.fixtureCwd,
      env: isolation.env })).resolves.toMatchObject({ roots: [] });
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .resolves.toBe(false);
  });

  it('preserves the generated shared marketplace root during ordinary cleanup', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'orphan-root-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.extensions = {
        instructions: [{ name: 'policy', title: 'Policy', content: 'Managed policy.' }],
      };
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = async (invocation: NativeCliInvocation) => ({
      exitCode: 0,
      stdout: invocation.command === 'claude' ? 'claude 99.0.0' : 'codex-cli 99.0.0',
      stderr: '',
    });
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await Promise.all([
      fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity,
        marketplaceName: 'aw',
      }),
      fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
        name: 'aw',
      }),
      fs.outputJson(path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), {
        name: 'aw',
      }),
    ]);
    const skillsRoot = path.join(isolation.layout.fixtureCwd, '.agents', 'skills');
    const otherConsumer = path.join(skillsRoot, 'other-consumer');
    await fs.ensureDir(otherConsumer);
    await writeSkillOwnerMarker({
      skillRoot: otherConsumer,
      allowedRoot: skillsRoot,
      identity: {
        owner: 'agent-workflows',
        sourceId: 'team',
        sourceIdentity,
        pluginId: 'team/other',
        plugin: 'other',
        artifactKey: 'other-consumer',
        platform: 'codex',
        scope: 'project',
      },
    });
    const historicalProject = path.join(isolation.layout.rootDir, 'historical-project-b');
    const installedPluginsPath = path.join(
      isolation.env.CLAUDE_CONFIG_DIR!,
      'plugins',
      'installed_plugins.json',
    );
    await fs.outputJson(installedPluginsPath, {
      plugins: {
        'other-claude@aw': [{
          name: 'other-claude',
          marketplace: 'aw',
          scope: 'project',
          projectPath: historicalProject,
          version: '1.0.0',
        }],
      },
    });

    expect((await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).overallState).toBe('succeeded');
    await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(true);

    await fs.remove(otherConsumer);
    expect((await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).overallState).toBe('succeeded');
    await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(true);
    await expect(fs.pathExists(historicalProject)).resolves.toBe(false);

    await fs.outputJson(installedPluginsPath, { plugins: {} });
    expect((await cleanupWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner })).overallState).toBe('succeeded');
    await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(true);

    const replacementRoot = path.join(isolation.layout.fixtureCwd, 'orphan-root-replacement');
    await createCatalogSnapshotFixture(replacementRoot, 'demo');
    await expect(updateCatalogSourceCommand({
      sourceId: 'team',
      update: { path: replacementRoot },
      cliVersion: '1.0.0',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({ ok: true, changed: true, sourceId: 'team' });
  });

  it('runs every command through the same namespaced runtime with a neutral User Codex observation', async () => {
    const isolation = await configureCatalog();
    const nativeCliRunner = vi.fn(async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }));
    const report = vi.fn();
    const runtime = {
      env: isolation.env,
      nativeCliRunner,
      reporter: { event: report, notice: vi.fn() },
      debugLogger: { log: vi.fn() },
    };
    const options = {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    } as const;

    const results = [
      await installFixturePlugin(['demo'], options, runtime),
      await syncWriteCommand(['demo'], options, runtime),
      await reinstallWriteCommand(['demo'], options, runtime),
      await uninstallWriteCommand(['demo'], options, runtime),
      await cleanupWriteCommand(['demo'], options, runtime),
    ];

    for (const [index, result] of results.slice(0, -1).entries()) {
      expect(result, JSON.stringify({ index, result })).toMatchObject({
        overallState: 'succeeded',
        warnings: [],
        receiptTargets: [{
          pluginName: 'demo',
          pluginId: 'local/demo',
          sourceId: 'local',
          platform: 'codex',
          scope: 'user',
        }],
      });
    }
    expect(results.at(-1)).toMatchObject({
      overallState: 'succeeded',
      warnings: [],
      receiptTargets: [],
    });
    expect(nativeCliRunner).toHaveBeenCalledTimes(1);
    expect(nativeCliRunner.mock.calls[0]![0]).toMatchObject({
      agentKind: 'codex',
      args: expect.arrayContaining(['plugin', 'list', '--json']),
    });
    expect(nativeCliRunner.mock.calls[0]![0].cwd).not.toBe(isolation.layout.fixtureCwd);
    expect(report).toHaveBeenCalled();
  });

  it.each([
    ['secondary installation after becoming primary', false, 'cleanup'],
    ['primary installation after another source becomes primary', true, 'uninstall'],
  ] as const)('keeps the live Codex marketplace for %s', async (_label, teamInitiallyPrimary, command) => {
    const isolation = getCurrentSourceTestIsolation();
    const teamRoot = path.join(isolation.layout.fixtureCwd, `marketplace-team-${command}`);
    const otherRoot = path.join(isolation.layout.fixtureCwd, `marketplace-other-${command}`);
    await Promise.all([
      createDependencyCatalogSnapshotFixture(teamRoot, [{ name: 'demo' }]),
      createDependencyCatalogSnapshotFixture(otherRoot, [{ name: 'other' }]),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'team', type: 'path', primary: teamInitiallyPrimary, path: teamRoot },
          { id: 'other', type: 'path', primary: !teamInitiallyPrimary, path: otherRoot },
        ],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const installedMarketplaceName = teamInitiallyPrimary ? 'aw' : 'aw-team';
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await fs.copy(teamRoot, marketplaceRoot);
    await Promise.all([
      fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
        schemaVersion: 2,
        sourceId: 'team',
        sourceIdentity: await calculateCatalogSourceIdentity({
          id: 'team', type: 'path', primary: teamInitiallyPrimary, path: teamRoot,
        }),
        marketplaceName: installedMarketplaceName,
      }),
      ...[
        path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
        path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
      ].map(async (manifestPath) => {
        const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
        await fs.outputJson(manifestPath, { ...manifest, name: installedMarketplaceName });
      }),
    ]);
    await expect(fs.readJson(path.join(marketplaceRoot, 'config.json'))).resolves.toMatchObject({
      marketplaceName: installedMarketplaceName,
    });
    await setPrimaryCatalogSourceCommand({
      sourceId: teamInitiallyPrimary ? 'other' : 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });

    const status = await statusCommandV8({
      plugins: ['team/demo'], cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', platform: 'codex', scope: 'project', json: true,
    });
    expect(status.payload.targets).toEqual([
      expect.objectContaining({ pluginId: 'team/demo', state: 'ready' }),
    ]);
    const result = command === 'cleanup'
      ? await cleanupWriteCommand(['team/demo'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        }, runtime)
      : await uninstallWriteCommand(['team/demo'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
        }, runtime);
    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(true);
  });

  it('blocks same-name unbound Claude records and preserves different-name records', async (test) => {
    const timing = createCommandTestTiming(test);
    const isolation = getCurrentSourceTestIsolation();
    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    const codexRoot = path.join(isolation.layout.fixtureCwd, 'codex-source');
    const claudeRoot = path.join(isolation.layout.fixtureCwd, 'claude-source');
    await Promise.all([
      createCatalogSnapshotFixture(codexRoot, 'codex-only', [], 'codex\n', (manifest) => {
        manifest.platforms = ['codex'];
      }),
      createCatalogSnapshotFixture(claudeRoot, 'claude-only', [], 'claude\n', (manifest) => {
        manifest.platforms = ['claude'];
      }),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'codex', type: 'path', primary: true, path: codexRoot },
          { id: 'claude', type: 'path', primary: false, path: claudeRoot },
        ],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const codexNativeRuntime = await createCodexNativeTestRuntime(isolation);
    const claudeNativeRuntime = await createClaudeNativeTestRuntime(isolation);
    const nativeCliRunner = vi.fn((invocation: NativeCliInvocation) => invocation.command === 'claude'
      ? claudeNativeRuntime.nativeCliRunner(invocation) : codexNativeRuntime.nativeCliRunner(invocation));
    const runtime = { env: isolation.env, nativeCliRunner, codexManagerResolver: codexNativeRuntime.codexManagerResolver };
    const installedPath = path.join(
      isolation.env.CLAUDE_CONFIG_DIR!,
      'plugins',
      'installed_plugins.json',
    );
    const sameNameUnboundRecord = {
      name: 'claude-only',
      scope: 'user',
      version: '1.0.0',
      installPath: path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'plugins', 'cache', 'claude-only'),
    };
    const settingsPath = path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'settings.json');
    const settingsBytes = Buffer.from('{ "sentinel": true }\n');
    const installedBytes = Buffer.from(`${JSON.stringify({
      plugins: { 'claude-only': [sameNameUnboundRecord] },
    }, null, 4)}\n`);
    await Promise.all([
      fs.outputFile(settingsPath, settingsBytes),
      fs.outputFile(installedPath, installedBytes),
    ]);
    const options = {
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'user',
    } as const;
    const selectors = ['codex/codex-only', 'claude/claude-only'];

    for (const [command, commandSelectors] of [
      [installWriteCommand, selectors],
      [syncWriteCommand, selectors],
      [reinstallWriteCommand, ['claude/claude-only']],
    ] as const) {
      nativeCliRunner.mockClear();
      const result = await timing.measure('command', command.name, () => command([...commandSelectors], options, runtime));
      expect(result).toMatchObject({
        overallState: 'failed',
        targetResults: expect.arrayContaining([
          expect.objectContaining({ errorCode: 'externalOwnershipPresent' }),
        ]),
      });
      expect(nativeCliRunner).not.toHaveBeenCalled();
      await expect(fs.readFile(settingsPath)).resolves.toEqual(settingsBytes);
      await expect(fs.readFile(installedPath)).resolves.toEqual(installedBytes);
    }

    const unboundInstalledRecord = {
      name: 'default-plugin',
      scope: 'project',
      projectPath: await fs.realpath(isolation.layout.fixtureCwd),
      version: '1.0.0',
      installPath: path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'plugins', 'cache', 'default-plugin'),
    };
    await fs.outputJson(installedPath, {
      plugins: { 'default-plugin': [unboundInstalledRecord] },
    });
    for (const [selector, platform] of [
      ['codex/codex-only', 'codex'],
      ['claude/claude-only', 'claude'],
    ] as const) {
      for (const command of [installWriteCommand, syncWriteCommand, reinstallWriteCommand]) {
        const result = await timing.measure('command', command.name, () => command([selector], { ...options, platform }, runtime));
        expect(result, JSON.stringify({ selector, command: command.name, result })).toMatchObject({
          overallState: 'succeeded',
          receiptTargets: [expect.objectContaining({ pluginId: selector, platform })],
        });
        await expect(fs.readJson(installedPath)).resolves.toMatchObject({
          plugins: { 'default-plugin': [unboundInstalledRecord] },
        });
      }
    }

    const claudeOptions = { ...options, platform: 'claude' as const };
    const uninstalled = await timing.measure('command', 'uninstall', () => uninstallWriteCommand(['claude/claude-only'], claudeOptions, runtime));
    expect(uninstalled.overallState, JSON.stringify(uninstalled.rebuildResults)).toBe('succeeded');
    const cleaned = await timing.measure('command', 'cleanup', () => cleanupWriteCommand(['claude/claude-only'], claudeOptions, runtime));
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    await expect(fs.readJson(installedPath)).resolves.toMatchObject({
      plugins: { 'default-plugin': [unboundInstalledRecord] },
    });

    const unsupported = await timing.measure('command', 'fixture install', () => installFixturePlugin(['codex/codex-only'], {
      ...options,
      platform: 'claude',
    }, runtime));
    expect(unsupported).toMatchObject({
      overallState: 'failed',
      receiptTargets: [expect.objectContaining({
        pluginId: 'codex/codex-only',
        platform: 'claude',
      })],
    });
  }, 30_000);

  it('keeps successful Native config output when another platform fails to render', async (test) => {
    const timing = createCommandTestTiming(test);
    const isolation = getCurrentSourceTestIsolation();
    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    const dualRoot = path.join(isolation.layout.fixtureCwd, 'dual-source');
    const dualPluginRoot = path.join(dualRoot, 'plugins', 'config-dual');
    await fs.outputFile(path.join(dualPluginRoot, 'scripts', 'render.mjs'), [
      'import { readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const mode = context.config.values.mode ?? "safe";',
      'if (context.platform === "claude" && mode === "fast") throw new Error("claude render failed");',
      'const files = { "SKILL.md": "---\\nname: mode-skill\\ndescription: Mode skill.\\n---\\n", "README.md": "Mode skill.\\n",',
      '  "references/runtime.md": `mode=${mode}\\n` };',
      'if (context.platform === "codex") files["agents/openai.yaml"] = "policy:\\n  allow_implicit_invocation: true\\n";',
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: `${context.platform}-mode`, kind: "skill", platform: context.platform,',
      '  target: `${context.platform}.skill`, state: "present", refreshKeys: ["mode"],',
      '  skillKey: "mode-skill", content: { files }',
      '}] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(dualRoot, 'config-dual', [], 'dual\n', (manifest) => {
      manifest.platforms = ['codex', 'claude'];
      manifest.config = {
        fields: { mode: { type: 'string', default: 'safe' } },
      };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: (['codex', 'claude'] as const).map((platform) => ({
          id: `${platform}-mode`,
          platform,
          scopes: ['project'],
          target: `${platform}.skill`,
          states: ['present'],
          refreshKeys: ['mode'],
          skillKey: 'mode-skill',
        })),
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'dual', type: 'path', primary: true, path: dualRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const codexNativeRuntime = await createCodexNativeTestRuntime(isolation);
    const claudeNativeRuntime = await createClaudeNativeTestRuntime(isolation);
    const nativeCliRunner = vi.fn((invocation: NativeCliInvocation) => invocation.command === 'claude'
      ? claudeNativeRuntime.nativeCliRunner(invocation) : codexNativeRuntime.nativeCliRunner(invocation));
    const runtime = { env: isolation.env, nativeCliRunner, codexManagerResolver: codexNativeRuntime.codexManagerResolver };
    const dualInstalled = await timing.measure('command', 'fixture install', () => installFixturePlugin(['dual/config-dual'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'project',
    }, runtime));
    expect(dualInstalled.overallState, JSON.stringify(dualInstalled.rebuildResults)).toBe('succeeded');
    const codexRuntime = path.join(isolation.env.CODEX_HOME!, 'plugins', 'cache', 'aw',
      'config-dual', '1.0.0', 'codex', 'skills', 'mode-skill', 'references', 'runtime.md');
    const claudeRuntime = path.join(isolation.env.AW_HOME!, 'marketplaces', 'dual', 'plugins',
      'config-dual', 'claude', 'skills', 'mode-skill', 'references', 'runtime.md');
    expect(await fs.readFile(codexRuntime, 'utf8')).toBe('mode=safe\n');
    expect(await fs.readFile(claudeRuntime, 'utf8')).toBe('mode=safe\n');

    const captured = createCapturedCliIo();
    expect(await timing.measure('command', 'plugin config set', () => runCli([
      'plugin', 'config', 'set', 'dual/config-dual', 'mode', '--value-json', '"fast"', '--context', 'project', '--apply', '--yes', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner,
    }))).toBe(1);
    const applyReceipt = JSON.parse(captured.readStdout());
    expect(applyReceipt, JSON.stringify(applyReceipt)).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'partial',
      apply: {
        state: 'partial',
        targetResults: expect.arrayContaining([
          expect.objectContaining({
            target: expect.objectContaining({ platform: 'claude' }),
            state: 'failed',
          }),
        ]),
      },
    });
    const dualSourceIdentity = await calculateCatalogSourceIdentity({
      id: 'dual', type: 'path', primary: true, path: dualRoot,
    });
    const dualLogicalIdentity = await readCatalogLogicalIdentity(dualRoot);
    expect((await readPluginConfigStore({
      sourceId: 'dual',
      sourceIdentity: dualSourceIdentity,
      logicalIdentity: dualLogicalIdentity,
      pluginName: 'config-dual',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).values).toEqual({ mode: 'fast' });
    expect(await fs.readFile(codexRuntime, 'utf8')).toBe('mode=fast\n');
    expect(await fs.readFile(claudeRuntime, 'utf8')).toBe('mode=safe\n');

    const lifecycleCaptured = createCapturedCliIo();
    expect(await timing.measure('command', 'plugin sync', () => runCli([
      'plugin', 'sync', 'dual/config-dual', '--target', 'codex', '--target', 'claude', '--context', 'project', '--yes', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: lifecycleCaptured.io,
      interactive: false,
      nativeCliRunner,
    }))).toBe(1);
    expect(JSON.parse(lifecycleCaptured.readStdout())).toMatchObject({
      ok: false,
      command: 'sync',
      kind: 'aw-recovery',
      targetResults: expect.arrayContaining([
        expect.objectContaining({ agent: 'codex', execution: 'applied' }),
        expect.objectContaining({ agent: 'claude', execution: 'failed' }),
      ]),
    });
  }, 30_000);

  it('saves unused config without claiming a same-name unbound Claude record', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'claude-config-collision-source');
    await createCatalogSnapshotFixture(sourceRoot, 'config-native', [], 'config\n', (manifest) => {
      manifest.platforms = ['claude'];
      manifest.config = {
        fields: { mode: { type: 'string', default: 'safe' } },
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const sourceIdentity = await calculateCatalogSourceIdentity({
      id: 'team', type: 'path', primary: true, path: sourceRoot,
    });
    await fs.copy(sourceRoot, marketplaceRoot);
    await fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
      schemaVersion: 2,
      sourceId: 'team',
      sourceIdentity,
      marketplaceName: 'aw',
    });
    for (const manifestPath of [
      path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    ]) {
      const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
      await fs.writeJson(manifestPath, { ...manifest, name: 'aw' });
    }
    const settingsPath = path.join(isolation.env.CLAUDE_CONFIG_DIR!, 'settings.json');
    const installedPath = path.join(
      isolation.env.CLAUDE_CONFIG_DIR!,
      'plugins',
      'installed_plugins.json',
    );
    const knownPath = path.join(
      isolation.env.CLAUDE_CONFIG_DIR!,
      'plugins',
      'known_marketplaces.json',
    );
    const settingsBytes = Buffer.from(`${JSON.stringify({
      extraKnownMarketplaces: {
        aw: { source: { source: 'directory', path: marketplaceRoot } },
      },
      enabledPlugins: { 'config-native@aw': true },
    }, null, 2)}\n`);
    const installedBytes = Buffer.from(`${JSON.stringify({
      plugins: {
        'config-native@aw': [{ name: 'config-native', scope: 'user', version: '1.0.0' }],
        'config-native': [{ name: 'config-native', scope: 'project', version: '9.9.9' }],
      },
    }, null, 2)}\n`);
    await Promise.all([
      fs.outputFile(settingsPath, settingsBytes),
      fs.outputFile(installedPath, installedBytes),
      fs.outputJson(knownPath, {
        aw: {
          source: { source: 'directory', path: marketplaceRoot },
          installLocation: marketplaceRoot,
        },
      }),
    ]);
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'claude-cli 99.0.0',
      stderr: '',
    }));
    await writeIntentFixture({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
      { roots: [{ pluginId: 'team/config-native', platforms: ['claude'] }] });
    const captured = createCapturedCliIo();

    expect(await runCli([
      'plugin', 'config', 'set', 'team/config-native', 'mode', '--value-json', '"fast"', '--context', 'user', '--apply', '--yes', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner,
    }), captured.readStdout()).toBe(0);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      configWrite: 'succeeded', overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'noVisibleTarget', targetResults: [] },
    });
    expect(nativeCliRunner).not.toHaveBeenCalled();
    expect((await readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'config-native',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).values).toEqual({ mode: 'fast' });
    await expect(fs.readFile(settingsPath)).resolves.toEqual(settingsBytes);
    await expect(fs.readFile(installedPath)).resolves.toEqual(installedBytes);
  });

  it('deduplicates bare, qualified, and repeated selectors by canonical target identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dedupe-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        instructions: [{ name: 'dedupe', title: 'Dedupe', content: 'One write.' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installFixturePlugin(['demo', 'team/demo', 'team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    });

    expect(result.overallState, JSON.stringify(result.rebuildResults)).toBe('succeeded');
    expect(result.receiptTargets).toEqual([expect.objectContaining({
      pluginId: 'team/demo',
      platform: 'codex',
      scope: 'project',
    })]);
    expect(result.rebuildResults).toHaveLength(1);
  });

  it('reinstalls and ordinarily cleans multiple roots while force cleanup remains single-target', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'multi-lifecycle-source');
    await createDependencyCatalogSnapshotFixture(sourceRoot, [
      { name: 'first' },
      { name: 'second' },
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = {
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    const pluginIds = ['team/first', 'team/second'];
    const installed = await installFixturePlugin(pluginIds, {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.targetResults)).toBe('succeeded');

    const reinstalled = await reinstallWriteCommand(pluginIds, {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(reinstalled.overallState, JSON.stringify(reinstalled.targetResults)).toBe('succeeded');
    expect(reinstalled.receiptTargets.map((target) => target.pluginId).sort()).toEqual(pluginIds);

    const cleaned = await cleanupWriteCommand(pluginIds, {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime);
    expect(cleaned.overallState, JSON.stringify(cleaned.targetResults)).toBe('succeeded');
    expect(cleaned.targetResults.map((target) => target.target.pluginId).sort()).toEqual(pluginIds);

    await expect(cleanupWriteCommand(pluginIds, {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project', force: true,
    }, runtime)).rejects.toThrow('cleanup 命令需要且只接受一个插件名');
  });

  it('executes later source groups after one reviewed batch intent update', async () => {
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['codex'],
    });
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'batch-first-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'batch-second-source');
    await Promise.all([
      createDependencyCatalogSnapshotFixture(firstRoot, [
        { name: 'leaf' },
        { name: 'alpha', dependencies: ['leaf'] },
        { name: 'omega', dependencies: ['leaf'] },
      ]),
      createDependencyCatalogSnapshotFixture(secondRoot, [{ name: 'beta' }]),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'first', type: 'path', primary: true, path: firstRoot },
          { id: 'second', type: 'path', primary: false, path: secondRoot },
        ],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    }));
    const selectors = ['first/alpha', 'first/omega', 'second/beta'];
    const installPlan = await dependencies.prepareScopedTask!({
      kind: 'recovery', scope: 'project', command: 'install', selectors,
    }, new AbortController().signal);
    const installed = await dependencies.executeScopedTask!(installPlan);
    expect(installed).toMatchObject({ kind: 'recovery', receipt: { ok: true, scope: 'project' } });
    if (installed.kind !== 'recovery') throw new Error('Expected recovery receipt.');
    expect(installed.receipt.targetResults.map((target) => [target.pluginId, target.execution]))
      .toEqual(expect.arrayContaining(selectors.map((pluginId) => [pluginId, 'applied'])));
    await expect(readFixtureRequirements({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({
      roots: selectors.map((pluginId) => ({ pluginId })),
    });

    const syncPlan = await dependencies.prepareScopedTask!({
      kind: 'recovery', scope: 'project', command: 'sync', selectors,
    }, new AbortController().signal);
    const synced = await dependencies.executeScopedTask!(syncPlan);
    expect(synced).toMatchObject({ kind: 'recovery', receipt: { ok: true, scope: 'project' } });
    if (synced.kind !== 'recovery') throw new Error('Expected recovery receipt.');
    expect(synced.receipt.targetResults.map((target) => [target.pluginId, target.observation]))
      .toEqual(expect.arrayContaining(selectors.map((pluginId) => [pluginId, 'verified'])));
  });

  it('keeps sync --all without intent roots as an empty recovery', async () => {
    const isolation = await configureCatalog();
    const receipt = await runRecovery('sync', [], {
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', all: true, targets: ['codex'], yes: true,
    });
    expect(receipt).toMatchObject({
      schemaVersion: 1, kind: 'aw-recovery', scope: 'user', command: 'sync', ok: true,
      requestedRoots: [], requestedTargets: [], targetResults: [], blockers: [],
      declarationChanged: false, outputsMayHaveChanged: false,
    });
  });

  it('keeps safely separable same-name project instruction owners namespaced', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'first-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'second-source');
    await Promise.all([
      createCatalogSnapshotFixture(firstRoot, 'demo', [], 'first\n', (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'first-policy', title: 'First', content: 'First.' }],
        };
      }),
      createCatalogSnapshotFixture(secondRoot, 'demo', [], 'second\n', (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'second-policy', title: 'Second', content: 'Second.' }],
        };
      }),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'first', type: 'path', primary: true, path: firstRoot },
          { id: 'second', type: 'path', primary: false, path: secondRoot },
        ],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'codex-cli 0.200.0',
      stderr: '',
    }));
    const codexManagerResolver = vi.fn(async () => ({
      kind: 'system' as const,
      version: '0.200.0',
      command: 'codex',
      argsPrefix: [] as string[],
    }));

    const installed = await installFixturePlugin(['first/demo', 'second/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, {
      env: isolation.env,
      nativeCliRunner,
      codexManagerResolver,
    });
    expect(installed).toMatchObject({ overallState: 'succeeded' });
    const config = await fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8');
    expect(config).toContain('First.');
    expect(config).toContain('Second.');
    expect(nativeCliRunner).not.toHaveBeenCalled();
    expect(codexManagerResolver).not.toHaveBeenCalled();
  });

  it.each([
    ['user', 'system'], ['user', 'app'], ['project', 'system'], ['project', 'app'],
  ] as const)('reinstalls a mixed Codex plugin in %s and retries native failures with a %s CLI', async (scope, managerKind) => {
    // Test Value Gate: shared reinstall must preserve recovery evidence when native removal fails and allow a retry.
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-uninstall-source');
    await createNativeDependencyCatalog(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'policy', title: 'Policy', content: 'Managed policy.' }],
        };
      },
    }]);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'codex', scope, yes: true } as const;
    const installed = await installWriteCommand(['team/demo'], options, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const configPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    const extensionConfigPath = scope === 'user'
      ? configPath : path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const marketplaceBefore = await snapshotRegularTree(marketplaceRoot);
    const configBefore = await fs.readFile(extensionConfigPath);
    runtime.nativeCliRunner.mockClear();
    const missing = await reinstallWriteCommand(['team/demo'], options, {
      env: { ...runtime.env, PATH: '' },
      nativeCliRunner: runtime.nativeCliRunner,
      codexManagerResolver: async () => {
        throw new CodexManagerError('codexCliNotFound', 'Install or repair the local Codex CLI.');
      },
    });
    expect(missing.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'codexCliNotFound' }),
    ]);
    await expect(fs.readFile(extensionConfigPath)).resolves.toEqual(configBefore);
    await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
    expect(runtime.nativeCliRunner.mock.calls.every(([invocation]) =>
      invocation.args.includes('--version') || invocation.args.includes('list'))).toBe(true);
    expect(runtime.installed.has('demo@aw')).toBe(true);

    const manager = {
      kind: managerKind,
      version: '0.200.0',
      command: managerKind === 'system' ? 'codex'
        : path.join(isolation.layout.fixtureCwd, 'Codex.app', 'Contents', 'Resources', 'codex'),
      argsPrefix: [] as string[],
    };
    const originalRunner = runtime.nativeCliRunner.getMockImplementation()!;
    let failRemove = true;
    runtime.nativeCliRunner.mockImplementation(async (invocation) => {
      const pluginArgs = invocation.args.slice(invocation.args.indexOf('plugin'));
      if (pluginArgs.join(' ') === 'plugin remove demo@aw' && failRemove) {
        return { exitCode: 9, stdout: '', stderr: 'private native failure' };
      }
      return originalRunner(invocation);
    });
    const recoveryManagerResolver = vi.fn(async () => manager);
    const writeRuntime = {
      env: runtime.env,
      nativeCliRunner: runtime.nativeCliRunner,
      codexManager: manager,
      codexManagerResolver: recoveryManagerResolver,
    };
    runtime.nativeCliRunner.mockClear();
    const failed = await reinstallWriteCommand(['team/demo'], options, writeRuntime);
    expect(failed.overallState).toBe('failed');
    expect(runtime.nativeCliRunner.mock.calls.some(([invocation]) =>
      invocation.command === manager.command
      && invocation.args.join(' ') === 'plugin remove demo@aw')).toBe(true);
    expect(runtime.installed.has('demo@aw')).toBe(true);
    const remaining = (await readCodexConfigFile(extensionConfigPath)).snapshot;
    expect(Object.keys(remaining.developerInstructions.managedBlocks)).toEqual([]);
    expect((await readCodexConfigFile(configPath)).snapshot.marketplaces.aw).toBeDefined();
    const diagnostics = projectExecutionDiagnostics(failed, 'reinstall').diagnostics;
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'codexNativeRemoveFailed', stage: 'cleanup.owned', exitCode: 9,
      causes: [expect.objectContaining({ code: 'nativeCliFailed' })],
    }));
    expect(JSON.stringify(diagnostics)).not.toContain('private native failure');

    failRemove = false;
    runtime.nativeCliRunner.mockClear();
    const retried = await reinstallWriteCommand(['team/demo'], options, writeRuntime);
    expect(retried.overallState, JSON.stringify(retried.rebuildResults)).toBe('succeeded');
    expect(runtime.installed.has('demo@aw')).toBe(true);
    expect(runtime.nativeCliRunner.mock.calls.some(([invocation]) =>
      invocation.command === manager.command
      && invocation.args.join(' ') === 'plugin remove demo@aw')).toBe(true);
    expect((await readCodexConfigFile(extensionConfigPath)).snapshot.plugins['demo@aw']?.enabled).toBe(true);
    expect(runtime.nativeCliRunner.mock.calls.filter(([invocation]) => invocation.args.includes('plugin'))
      .every(([invocation]) => invocation.command === manager.command)).toBe(true);
    if (scope === 'user') {
      recoveryManagerResolver.mockClear();
      runtime.nativeCliRunner.mockClear();
      await uninstallWriteCommand(['team/demo'], options, writeRuntime);
      expect(recoveryManagerResolver).not.toHaveBeenCalled();
      expect(runtime.nativeCliRunner.mock.calls.every(([invocation]) =>
        invocation.args.includes('list'))).toBe(true);
    }
  });

  it.each([false, true])('fails public install without a local CLI and preserves old runtime residue: %s', async (oldRuntimePresent) => {
    // Test Value Gate: a failed public install may save Intent but must not install Codex or execute an old AW runtime.
    const isolation = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'local-cli-required-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const oldRuntimeRoot = path.join(isolation.env.AW_HOME!, 'runtimes', 'codex',
      '0.151.0', `${process.platform}-${process.arch}`);
    if (oldRuntimePresent) {
      await fs.outputJson(path.join(oldRuntimeRoot, '.aw-managed-runtime.json'), {
        schemaVersion: 1, owner: 'aw', packageName: '@openai/codex', version: '0.151.0',
        platform: process.platform, arch: process.arch,
      });
      await fs.outputJson(path.join(oldRuntimeRoot, 'node_modules', '@openai', 'codex', 'package.json'), {
        name: '@openai/codex', version: '0.151.0', bin: { codex: 'bin/codex.js' },
      });
      await fs.outputFile(path.join(oldRuntimeRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
        'throw new Error("Old runtime must not run");\n');
    }
    const oldRuntimeBefore = oldRuntimePresent ? await snapshotRegularTree(oldRuntimeRoot) : undefined;
    const nativeCliRunner = vi.fn(async (_invocation: NativeCliInvocation) => {
      throw Object.assign(new Error('No local Codex CLI is available'), { code: 'ENOENT' });
    });
    const output = createCapturedCliIo();
    expect(await runCli([
      'plugin', 'install', 'team/demo', '--scope', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: { ...isolation.env, PATH: '' },
      io: output.io,
      interactive: false,
      nativeCliRunner,
    })).toBe(1);
    expect(JSON.parse(output.readStdout())).toMatchObject({
      schemaVersion: 1,
      kind: 'aw-recovery',
      scope: 'user',
      ok: false,
      declarationChanged: true,
      targetResults: [expect.objectContaining({
        agent: 'codex', execution: 'failed',
        blockers: [expect.objectContaining({ code: 'codexCliNotFound' })],
        backend: expect.objectContaining({
          overallState: 'failed',
          targetResults: [expect.objectContaining({ errorCode: 'codexCliNotFound' })],
        }),
      })],
    });
    expect(output.readStderr()).toBe('');
    expect(nativeCliRunner.mock.calls.every(([invocation]) =>
      invocation.agentKind === 'codex'
      && (invocation.args.includes('--version')
        || invocation.args.join(' ') === 'plugin list --marketplace aw --json'))).toBe(true);
    expect(nativeCliRunner.mock.calls.some(([invocation]) =>
      invocation.command.startsWith(oldRuntimeRoot)
      || invocation.args.some((argument) => argument.startsWith(oldRuntimeRoot)))).toBe(false);
    await expect(observeIntent({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ state: 'valid', value: { roots: [{ pluginId: 'team/demo' }] } });
    await expect(fs.pathExists(path.join(isolation.env.CODEX_HOME!, 'config.toml'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'marketplaces', 'team'))).resolves.toBe(false);
    if (oldRuntimeBefore) {
      await expect(snapshotRegularTree(oldRuntimeRoot)).resolves.toEqual(oldRuntimeBefore);
    } else {
      await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'runtimes', 'codex')))
        .resolves.toBe(false);
    }
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'selects a healthy newer App before an older PATH CLI can block native planning', async () => {
      // Test Value Gate: the first native observation must use the highest usable local CLI selected by production discovery.
      const isolation = getCurrentSourceTestIsolation();
      const sourceRoot = path.join(isolation.layout.fixtureCwd, 'app-selected-before-observation-source');
      await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
      const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
        expectedDigest: snapshot.digest,
        env: isolation.env,
      });
      const native = await createCodexNativeTestRuntime(isolation, '0.151.0');
      const applicationsDirectory = path.join(isolation.layout.homeDir, 'Applications');
      const appRoot = path.join(applicationsDirectory, process.platform === 'win32' ? 'CodexPackage' : 'Codex.app');
      const appCommand = process.platform === 'win32'
        ? path.join(appRoot, 'codex.exe')
        : path.join(appRoot, 'Contents', 'Resources', 'codex');
      await fs.outputFile(appCommand, 'controlled native executable\n');
      await fs.chmod(appCommand, 0o755);
      if (process.platform === 'darwin') {
        await fs.outputFile(path.join(appRoot, 'Contents', 'Info.plist'), 'controlled bundle identity query\n');
      }
      const canonicalAppCommand = await fs.realpath(appCommand);
      const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
        if (invocation.args.at(-1) === '--version') {
          return { exitCode: 0, stdout: `codex-cli ${invocation.command === canonicalAppCommand ? '0.153.0' : '0.151.0'}`, stderr: '' };
        }
        if (invocation.command !== canonicalAppCommand) {
          return { exitCode: 1, stdout: 'invalid PATH CLI list', stderr: '' };
        }
        return native.nativeCliRunner(invocation);
      });
      setCodexDiscoveryOverridesForTests({
        macApplicationsDirectories: [applicationsDirectory],
        queryRunner: async (invocation) => ({
          exitCode: 0, stderr: '',
          stdout: process.platform === 'darwin' ? 'com.openai.codex'
            : invocation.env?.AW_CODEX_DISCOVERY_PATH ? 'true'
              : JSON.stringify([{ family: 'OpenAI.Codex_fixture', root: appRoot,
                  architecture: process.arch, version: '1.0.0' }]),
        }),
      });
      try {
        const result = await installFixturePlugin(['team/demo'], {
          cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user',
        }, { env: { ...isolation.env, PATH: isolation.env.PATH!.split(path.delimiter)[0] }, nativeCliRunner });
        expect(result.overallState, JSON.stringify(result.targetResults)).toBe('succeeded');
        const pluginCalls = nativeCliRunner.mock.calls.filter(([invocation]) => invocation.args.includes('plugin'));
        expect(pluginCalls.length).toBeGreaterThan(0);
        expect(pluginCalls.every(([invocation]) => invocation.command === canonicalAppCommand)).toBe(true);
        const listCalls = pluginCalls.filter(([invocation]) => invocation.args.includes('list'));
        expect(listCalls.length).toBeLessThanOrEqual(4);
        expect(listCalls.every(([invocation]) => invocation.args.join(' ')
          === 'plugin list --marketplace aw --json')).toBe(true);
        expect(native.installed.has('demo@aw')).toBe(true);
      } finally {
        setCodexDiscoveryOverridesForTests({ macApplicationsDirectories: [],
          queryRunner: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }) });
      }
    }, 30_000);

  it('selects the execution App CLI after Review while preserving shared impact confirmation and offline cleanup', async () => {
    // Test Value Gate: Review CLI selection must not freeze the executable or make an unchanged plugin plan stale.
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'app-codex-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const native = await createCodexNativeTestRuntime(isolation);
    const manager = {
      kind: 'app' as const,
      version: '0.200.0',
      command: path.join(isolation.layout.fixtureCwd, 'Codex.app', 'Contents', 'Resources', 'codex'),
      argsPrefix: [] as string[],
    };
    const reviewedManager = {
      kind: 'system' as const,
      version: '0.151.0',
      command: path.join(isolation.layout.fixtureCwd, 'reviewed-codex'),
      argsPrefix: [] as string[],
    };
    const codexManagerPreviewer = vi.fn(async () => ({
      state: 'system' as const, manager: reviewedManager,
    }));
    let executionCallOffset = -1;
    const codexManagerResolver = vi.fn(async () => {
      executionCallOffset = native.nativeCliRunner.mock.calls.length;
      return manager;
    });
    const runtime = { ...native, codexManagerPreviewer, codexManagerResolver };
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'user' } as const;
    const preview = await installFixturePlugin(['team/demo'], options,
      { ...runtime, previewOperationPlan: true });
    expect(preview.codexManagerPreview).toMatchObject({ state: 'system', manager: reviewedManager });
    expect(codexManagerPreviewer).toHaveBeenCalledOnce();
    expect(codexManagerResolver).not.toHaveBeenCalled();
    native.nativeCliRunner.mockClear();
    const installed = await installFixturePlugin(['team/demo'], options,
      { ...runtime, expectedPlanFingerprint: preview.operationPlan!.planFingerprint });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    expect(codexManagerResolver).toHaveBeenCalledOnce();
    expect(executionCallOffset).toBeGreaterThanOrEqual(0);
    const selectedCalls = native.nativeCliRunner.mock.calls.slice(executionCallOffset)
      .map(([invocation]) => invocation);
    expect(selectedCalls.every((invocation) => invocation.command === manager.command)).toBe(true);
    const nativeAddIndex = selectedCalls.findIndex((invocation) =>
      invocation.args.join(' ') === 'plugin add demo@aw');
    expect(nativeAddIndex).toBeGreaterThanOrEqual(0);
    expect(selectedCalls.slice(0, nativeAddIndex).some((invocation) => invocation.args.includes('list'))).toBe(true);
    expect(selectedCalls.slice(nativeAddIndex + 1).some((invocation) => invocation.args.includes('list'))).toBe(true);
    const blocked = await reinstallWriteCommand(['team/demo'], options, { ...runtime, directCli: true });
    expect(blocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'sharedNativeImpactAuthorizationRequired' }),
    ]);
    const reinstalled = await reinstallWriteCommand(['team/demo'], { ...options, yes: true },
      { ...runtime, directCli: true });
    expect(reinstalled.overallState, JSON.stringify(reinstalled.rebuildResults)).toBe('succeeded');
    const materializationCalls = native.nativeCliRunner.mock.calls.filter(([invocation]) =>
      invocation.args.includes('plugin') && !invocation.args.includes('list'));
    expect(materializationCalls.length).toBeGreaterThan(0);
    expect(materializationCalls.every(([invocation]) => invocation.command === manager.command)).toBe(true);

    codexManagerResolver.mockClear();
    native.nativeCliRunner.mockClear();
    const offlineRunner = vi.fn(async (_invocation: NativeCliInvocation) => {
      throw Object.assign(new Error('No local Codex CLI is available'), { code: 'ENOENT' });
    });
    const offlineRuntime = {
      ...runtime, env: { ...isolation.env, PATH: '' },
      codexManager: undefined,
      nativeCliRunner: offlineRunner,
      codexManagerResolver: vi.fn(async () => {
        throw new CodexManagerError('codexCliNotFound', 'Install or repair the local Codex CLI.');
      }),
    };
    const cleaned = await cleanupWriteCommand(['team/demo'], options, offlineRuntime);
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    expect(offlineRuntime.codexManagerResolver).not.toHaveBeenCalled();
    expect(native.installed.has('demo@aw')).toBe(true);
    expect(offlineRunner.mock.calls.every(([invocation]) =>
      invocation.args.includes('--version') || invocation.args.includes('list'))).toBe(true);
    const configPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    expect((await readCodexConfigFile(configPath)).snapshot.plugins['demo@aw']?.enabled).not.toBe(true);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins', 'demo')))
      .resolves.toBe(true);

    offlineRunner.mockClear();
    const noOp = await uninstallWriteCommand(['team/demo'], options, offlineRuntime);
    expect(noOp.overallState, JSON.stringify(noOp.rebuildResults)).toBe('succeeded');
    expect(offlineRuntime.codexManagerResolver).not.toHaveBeenCalled();
    expect(offlineRunner.mock.calls.every(([invocation]) =>
      invocation.args.includes('--version') || invocation.args.includes('list'))).toBe(true);
  });

  it('replans with App CLI registration before shared replacement writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'app-replan-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const installedRuntime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, installedRuntime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await createNativeDependencyCatalog(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.version = '2.0.0';
      },
    }]);
    await syncCatalogSourceGeneration({
      sourceId: 'team',
      cliVersion: '1.0.0',
      env: isolation.env,
    });

    const manager = {
      kind: 'app' as const,
      version: '0.200.0',
      command: path.join(isolation.layout.fixtureCwd, 'Codex.app', 'Contents', 'Resources', 'codex'),
      argsPrefix: [] as string[],
    };
    let registeredVersion: string | undefined = '1.0.0';
    const configPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    const cacheRoot = path.join(
      isolation.env.CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo',
    );
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = invocation.args.slice(pluginIndex);
      if (invocation.command === 'codex' && args[1] === 'list' && args.includes('--json')) {
        throw Object.assign(new Error('system Codex is unavailable'), { code: 'ENOENT' });
      }
      if (invocation.command === manager.command && args[1] === 'list' && args.includes('--json')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            installed: registeredVersion ? [{
              pluginId: 'demo@aw',
              installed: true,
              enabled: true,
              version: registeredVersion,
            }] : [],
            available: [],
          }),
          stderr: '',
        };
      }
      if (invocation.command === manager.command && args[1] === 'remove') {
        registeredVersion = undefined;
        installedRuntime.installed.delete('demo@aw');
        await fs.remove(cacheRoot);
        await applyCodexConfigTransactionFile(configPath, {
          removePluginActivations: ['demo@aw'],
        });
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (invocation.command === manager.command && args[1] === 'add') {
        registeredVersion = '2.0.0';
        installedRuntime.installed.add('demo@aw');
        await fs.copy(
          path.join(isolation.env.AW_HOME!, 'marketplaces', 'team', 'plugins', 'demo'),
          path.join(cacheRoot, registeredVersion),
          { overwrite: true },
        );
        await applyCodexConfigTransactionFile(configPath, {
          upsertPluginActivations: { 'demo@aw': true },
        });
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return installedRuntime.nativeCliRunner(invocation);
    });
    const codexManagerResolver = vi.fn(async () => manager);
    const runtime = {
      env: isolation.env,
      nativeCliRunner,
      codexManager: manager,
      codexManagerResolver,
      directCli: true,
    };
    const configBefore = await fs.readFile(configPath);
    const callsBeforeBlocked = nativeCliRunner.mock.calls.length;

    const blocked = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);

    expect(blocked.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'sharedNativeImpactAuthorizationRequired' }),
    ]);
    const blockedActions = nativeCliRunner.mock.calls.slice(callsBeforeBlocked)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(blockedActions).not.toContain('plugin remove demo@aw');
    expect(blockedActions).not.toContain('plugin add demo@aw');
    await expect(fs.readFile(configPath)).resolves.toEqual(configBefore);
    await expect(fs.pathExists(path.join(cacheRoot, '1.0.0'))).resolves.toBe(true);

    const callsBeforeAuthorized = nativeCliRunner.mock.calls.length;
    const authorized = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
      yes: true,
    }, runtime);

    expect(authorized.overallState, JSON.stringify(authorized.rebuildResults)).toBe('succeeded');
    const authorizedActions = nativeCliRunner.mock.calls.slice(callsBeforeAuthorized)
      .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '));
    expect(authorizedActions.indexOf('plugin remove demo@aw')).toBeGreaterThanOrEqual(0);
    expect(authorizedActions.indexOf('plugin add demo@aw'))
      .toBeGreaterThan(authorizedActions.indexOf('plugin remove demo@aw'));
    expect(nativeCliRunner.mock.calls.slice(callsBeforeAuthorized).some(([invocation]) =>
      invocation.command === manager.command
      && invocation.args.slice(invocation.args.indexOf('plugin')).join(' ')
        === 'plugin list --marketplace aw --json')).toBe(true);
    expect(registeredVersion).toBe('2.0.0');
  }, 30_000);

  it.for(['user', 'project'] as const)('refreshes an installed %s Codex role after removing its Intent root', async (scope, test) => {
    const timing = createCommandTestTiming(test);
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'config-role-refresh-source');
    const otherSourceRoot = path.join(isolation.layout.fixtureCwd, 'other-config-role-source');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'), [
      'import { readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const effort = context.config.values.effort ?? "medium";',
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: "helper-role", kind: "codexRole", platform: "codex",',
      '  target: "codex.agentRole", state: "present", roleKey: "helper",',
      '  refreshKeys: ["effort"], content: {',
      '    registration: { description: "Helper role." },',
      '    roleFile: { name: "helper", description: "Helper role.",',
      '      developer_instructions: "Help.", model_reasoning_effort: effort }',
      '  }',
      '}] }));',
    ].join('\n'));
    await Promise.all([
      fs.outputFile(
        path.join(sourceRoot, 'plugins', 'demo', 'skills', 'demo-native', 'SKILL.md'),
        '---\nname: demo-native\ndescription: Native fixture.\n---\n',
      ),
      fs.outputFile(
        path.join(
          sourceRoot,
          'plugins',
          'demo',
          'skills',
          'demo-native',
          'agents',
          'openai.yaml',
        ),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.skills = './skills';
      manifest.config = {
        fields: {
          effort: {
            type: 'string',
            default: 'medium',
            choices: {
              allowCustom: false,
              presets: [
                { id: 'medium', title: 'Medium', value: 'medium' },
                { id: 'high', title: 'High', value: 'high' },
                { id: 'xhigh', title: 'Extra high', value: 'xhigh' },
              ],
            },
          },
        },
      };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [{
          id: 'helper-role',
          platform: 'codex',
          scopes: ['user', 'project'],
          target: 'codex.agentRole',
          states: ['present'],
          refreshKeys: ['effort'],
          requiresCodexProjectConfig: true,
          roleKey: 'helper',
        }],
      };
    });
    await createCatalogSnapshotFixture(otherSourceRoot, 'sentinel', [], 'sentinel\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.extensions = {
        agents: [{ name: 'watcher', description: 'Watcher.', prompt: 'Watch.' }],
      };
    });
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'team', type: 'path', primary: true, path: sourceRoot },
          { id: 'other', type: 'path', primary: false, path: otherSourceRoot },
        ],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const runPublic = async (args: string[]) => {
      const captured = createCapturedCliIo();
      const exitCode = await timing.measure('command', args[1] === 'config' ? `plugin config ${args[2]}` : `plugin ${args[1]}`, () => runCli([...args, '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: captured.io,
        interactive: false,
        nativeCliRunner: runtime.nativeCliRunner,
      }));
      return {
        exitCode,
        payload: JSON.parse(captured.readStdout()) as Record<string, unknown>,
      };
    };
    const rolePath = path.join(scope === 'user' ? isolation.env.CODEX_HOME!
      : path.join(isolation.layout.fixtureCwd, '.codex'), 'agents', 'aw-demo-helper.toml');
    const otherScope = scope === 'user' ? 'project' : 'user';
    const otherHome = otherScope === 'user' ? isolation.env.CODEX_HOME!
      : path.join(isolation.layout.fixtureCwd, '.codex');
    const otherRolePath = path.join(otherHome, 'agents', 'aw-sentinel-watcher.toml');

    expect(await runPublic([
      'plugin', 'install', 'team/demo', '--scope', scope,
    ])).toMatchObject({ exitCode: 0, payload: { ok: true } });
    expect(await runPublic([
      'plugin', 'install', 'other/sentinel', '--scope', otherScope,
    ])).toMatchObject({ exitCode: 0, payload: { ok: true } });
    const otherRoleBefore = await fs.readFile(otherRolePath);
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('model_reasoning_effort = "medium"');

    expect(await runPublic([
      'plugin', 'config', 'set', 'team/demo', 'effort', '--context', scope, '--value-json', '"high"',
    ])).toMatchObject({
      exitCode: 0,
      payload: { apply: { state: 'skipped', reason: 'notRequested' } },
    });
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('model_reasoning_effort = "medium"');
    expect(await runPublic([
      'plugin', 'sync', 'team/demo', '--target', 'codex', '--context', scope,
    ])).toMatchObject({ exitCode: 0, payload: { ok: true } });
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('model_reasoning_effort = "high"');

    expect(await runPublic([
      'plugin', 'config', 'set', 'team/demo', 'effort', '--context', scope,
      '--value-json', '"xhigh"', '--apply',
    ])).toMatchObject({
      exitCode: 0,
      payload: { apply: { state: 'succeeded' } },
    });
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('model_reasoning_effort = "xhigh"');

    const intentLocation = { scope, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const intentPath = await resolveIntentPath(intentLocation);
    const otherIntentPath = await resolveIntentPath({ ...intentLocation, scope: otherScope });
    const intentBeforeRemoval = await fs.readFile(intentPath);
    const otherIntentBefore = await fs.readFile(otherIntentPath);
    expect(await runPublic(['plugin', 'intent', 'remove', 'team/demo', '--scope', scope])).toMatchObject({
      exitCode: 0, payload: { kind: 'aw-recovery', command: 'intent:remove',
        declarationChanged: true, outputsMayHaveChanged: false, intent: { roots: [] } },
    });
    const intentAfterRemoval = await fs.readFile(intentPath);
    expect(intentAfterRemoval).not.toEqual(intentBeforeRemoval);
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('model_reasoning_effort = "xhigh"');

    expect(await runPublic([
      'plugin', 'config', 'set', 'team/demo', 'effort', '--context', scope,
      '--value-json', '"medium"', '--apply',
    ])).toMatchObject({
      exitCode: 0, payload: { apply: { state: 'succeeded' } },
    });
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('model_reasoning_effort = "medium"');
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentAfterRemoval);
    await expect(fs.readFile(otherIntentPath)).resolves.toEqual(otherIntentBefore);
    await expect(fs.readFile(otherRolePath)).resolves.toEqual(otherRoleBefore);
    expect(runtime.installed.has('demo@aw')).toBe(true);
  }, 30_000);

  it('sets and unsets whole platform arrays, rejects v5 bytes, and recreates v6 after reset', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'array-config-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.config = {
        schemaVersion: 5,
        fields: {
          labels: { type: 'array', items: { type: 'string' } },
          counts: { type: 'array', items: { type: 'number' } },
          flags: { type: 'array', items: { type: 'boolean' } },
        },
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const run = async (args: string[]) => {
      const output = createCapturedCliIo();
      const exitCode = await runCli([...args, '--json'], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: output.io,
        interactive: false,
      });
      return { exitCode, payload: JSON.parse(output.readStdout()) as Record<string, unknown> };
    };
    const userPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const projectPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'demo', scope: 'project',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    expect(projectPath).toBe(userPath);

    expect(await run(['plugin', 'config', 'set', 'team/demo', 'labels', '--context', 'user',
      '--value-json', '["user",""]'])).toMatchObject({
      exitCode: 0, payload: { configWrite: 'succeeded' },
    });
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'counts', '--context', 'user',
      '--value-json', '[0,2]'])).toMatchObject({ exitCode: 0 });
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'flags', '--context', 'user',
      '--value-json', '[false,true]'])).toMatchObject({ exitCode: 0 });
    expect(await fs.readJson(userPath)).toMatchObject({
      schemaVersion: 6,
      common: { labels: ['user', ''], counts: [0, 2], flags: [false, true] },
    });
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'labels', '--context', 'project', '--platform', 'cursor',
      '--value-json', '[]'])).toMatchObject({
      exitCode: 0, payload: { configWrite: 'succeeded' },
    });
    expect(await fs.readJson(userPath)).toMatchObject({ schemaVersion: 6,
      common: { labels: ['user', ''], counts: [0, 2], flags: [false, true] }, platforms: { cursor: { labels: [] } } });
    expect(await run(['plugin', 'config', 'get', 'team/demo', 'labels', '--platform', 'cursor'])).toMatchObject({
      exitCode: 0,
      payload: { fields: [expect.objectContaining({ effectiveValue: [], sourceLayer: 'platform' })] },
    });
    expect(await run(['plugin', 'config', 'unset', 'team/demo', 'labels', '--context', 'project', '--platform', 'cursor'])).toMatchObject({
      exitCode: 0, payload: { configWrite: 'succeeded' },
    });
    expect(await run(['plugin', 'config', 'get', 'team/demo', 'labels', '--platform', 'cursor'])).toMatchObject({
      exitCode: 0,
      payload: { fields: [expect.objectContaining({ effectiveValue: ['user', ''], sourceLayer: 'common' })] },
    });

    const validBytes = await fs.readFile(userPath, 'utf8');
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'labels', '--context', 'user',
      '--value-json', '["mixed",0]'])).toMatchObject({ exitCode: 1 });
    expect(await fs.readFile(userPath, 'utf8')).toBe(validBytes);

    const stored = await fs.readJson(userPath) as Record<string, unknown>;
    const oldBytes = `${JSON.stringify({ ...stored, schemaVersion: 5 })}\n`;
    await fs.writeFile(userPath, oldBytes);
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'labels', '--context', 'user',
      '--value-json', '["changed"]'])).toMatchObject({
      exitCode: 1,
      payload: { errors: [expect.objectContaining({ code: 'schemaVersionUnsupported' })] },
    });
    expect(await fs.readFile(userPath, 'utf8')).toBe(oldBytes);
    expect(await run(['plugin', 'config', 'reset', 'team/demo', '--context', 'user', '--yes']))
      .toMatchObject({ exitCode: 0 });
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'labels', '--context', 'user',
      '--value-json', '["changed"]'])).toMatchObject({ exitCode: 0 });
    expect(await fs.readJson(userPath)).toMatchObject({
      schemaVersion: 6, common: { labels: ['changed'] },
    });
  });

  describe('namespaced config replay', () => {
    async function createFixture(test: TestContext) {
      const timing = createCommandTestTiming(test);
      const isolation = getCurrentSourceTestIsolation();
      await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
        { ...createEmptyPreferences(), targets: ['codex'] });
      const sourceRoot = path.join(isolation.layout.fixtureCwd, 'config-replay-source');
      await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'), [
        'import { readFile } from "node:fs/promises";',
        'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
        'const mode = context.config.values.mode ?? "safe";',
        'if (mode === "fail") {',
        '  console.error("file:///C:/Users/RUNNER%7E1/AppData/Local/Temp/private-renderer/render.mjs:4:28");',
        '  throw new Error("renderer requested failure");',
        '}',
        'console.log(JSON.stringify({ version: 2, artifacts: [{',
        '  id: "instruction", kind: "instruction", platform: "codex",',
        '  target: "codex.developerInstructionsBlock", state: "present",',
        '  refreshKeys: ["mode"], content: `mode=${mode}`',
        '}] }));',
      ].join('\n'));
      await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
        manifest.config = {
          schemaVersion: 5,
          fields: {
            mode: {
              type: 'string',
              default: 'safe',
              choices: {
                allowCustom: true,
                presets: [{ id: 'safe', title: 'Safe', value: 'safe' }],
              },
            },
            labels: {
              type: 'object',
              additionalProperties: { type: 'string' },
              validation: { key: { format: 'identifier' } },
            },
          },
        };
        manifest.scripts = {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        };
        manifest.artifacts = {
          targets: [{
            id: 'instruction',
            platform: 'codex',
            scopes: ['project'],
            target: 'codex.developerInstructionsBlock',
            states: ['present'],
            refreshKeys: ['mode'],
            requiresCodexProjectConfig: true,
          }],
        };
        manifest.platforms = ['codex'];
      });
      const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
      const before = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfig({
        config: { schemaVersion: 2, sources: [source] },
        expectedDigest: before.digest,
        env: isolation.env,
      });
      const nativeCliRunner = vi.fn(async () => ({
        exitCode: 0,
        stdout: 'codex-cli 0.200.0',
        stderr: '',
      }));
      const runPublic = (args: string[]) => timing.measure(
        'command',
        args[1] === 'config' ? `plugin config ${args[2]}` : `plugin ${args[1]}`,
        async () => {
          const captured = createCapturedCliIo();
          const exitCode = await runCli([...args, '--json'], {
            cwd: isolation.layout.fixtureCwd,
            env: isolation.env,
            io: captured.io,
            interactive: false,
            nativeCliRunner,
          });
          return {
            exitCode,
            stdout: captured.readStdout(),
            payload: JSON.parse(captured.readStdout()) as Record<string, unknown>,
            stderr: captured.readStderr(),
          };
        },
      );
      const store = {
        sourceId: 'team',
        sourceIdentity,
        logicalIdentity,
        pluginName: 'demo',
        scope: 'user' as const,
        platform: 'codex' as const,
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      };
      const readStore = () => readPluginConfigStore(store);
      const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      const runHumanConfig = async (args: string[]) => timing.measure('command', `human config ${args[2]}`, async () => {
        const output = createCapturedCliIo();
        const exitCode = await runCli(args, {
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
          io: output.io,
          interactive: false,
          nativeCliRunner,
        });
        return { exitCode, stdout: output.readStdout(), stderr: output.readStderr() };
      });
      return { isolation, nativeCliRunner, runPublic, runHumanConfig, readStore, configPath, store };
    }

    // Test Value Gate: config writes refresh existing output; missing output remains absent until explicit sync.
    it('replays presets, unset and reset while requiring sync for missing output', async (test) => {
      const { isolation, nativeCliRunner, runPublic, readStore, configPath, store } = await createFixture(test);
      expect(await runPublic([
        'plugin', 'install', 'team/demo', '--scope', 'project',
      ])).toMatchObject({ exitCode: 0, payload: { ok: true } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      const sourceOnlyPreset = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--preset', 'safe', '--context', 'project', '--platform', 'codex', '--apply',
      ]);
      expect(sourceOnlyPreset).toMatchObject({
        exitCode: 0,
        payload: {
          updatedKeys: ['mode'],
          apply: { state: 'succeeded' },
        },
      });
      const equivalentPreset = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--preset', 'safe', '--context', 'project', '--platform', 'codex', '--apply',
      ]);
      expect(equivalentPreset).toMatchObject({
        exitCode: 0,
        payload: {
          updatedKeys: [],
          apply: { state: 'skipped', reason: 'noConfigChange' },
        },
      });

      await fs.remove(configPath);
      await expect(statusCommandV8({
        recoverySelection: { targets: ['codex'] },
        plugins: ['team/demo'],
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        nativeCliRunner,
        platform: 'codex',
        scope: 'project',
      })).resolves.toMatchObject({
        payload: { targets: [expect.objectContaining({ state: 'needsSync' })] },
      });

      const set = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--context', 'project', '--platform', 'codex', '--apply',
      ]);
      expect(set, JSON.stringify(set)).toMatchObject({
        exitCode: 1,
        payload: {
          receiptSchemaVersion: 7,
          configWrite: 'succeeded',
          overallState: 'partial',
          apply: { state: 'partial', targetResults: [expect.objectContaining({
            target: expect.objectContaining({ pluginId: 'team/demo', platform: 'codex', scope: 'project' }),
            state: 'skipped', errorCode: 'configApplyRequiresExistingOutput',
          })] },
        },
      });
      expect(set.payload).not.toHaveProperty('targetResults');
      expect(JSON.parse(set.stdout)).toEqual(set.payload);
      expect(set.stderr).toBe('');
      expect(JSON.stringify(set.payload)).not.toContain('projectConfigShareabilityUnverified');
      expect(await fs.readJson(resolvePluginConfigStorePath({
        sourceId: 'team', pluginName: 'demo', scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      }))).toMatchObject({ schemaVersion: 6, common: {}, platforms: { codex: { mode: 'fast' } } });
      expect((await readStore()).values).toEqual({ mode: 'fast' });
      await expect(fs.pathExists(configPath)).resolves.toBe(false);
      expect(await runPublic(['plugin', 'sync', 'team/demo', '--target', 'codex', '--context', 'project']))
        .toMatchObject({ exitCode: 0, payload: { ok: true } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=fast');

      const unset = await runPublic([
        'plugin', 'config', 'unset', 'team/demo', 'mode', '--context', 'project', '--platform', 'codex', '--apply',
      ]);
      expect(unset).toMatchObject({
        exitCode: 0,
        payload: { receiptSchemaVersion: 7, configWrite: 'succeeded', overallState: 'succeeded' },
      });
      expect((await readStore()).values).toEqual({});
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      await writePluginConfigStore({ ...store, values: { mode: 'fast' } });
      expect(await runPublic(['plugin', 'sync', 'team/demo', '--target', 'codex', '--context', 'project']))
        .toMatchObject({ exitCode: 0, payload: { ok: true } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=fast');
      const reset = await runPublic([
        'plugin', 'config', 'reset', 'team/demo', '--context', 'project', '--platform', 'codex', '--yes', '--apply',
      ]);
      expect(reset).toMatchObject({
        exitCode: 0,
        payload: {
          receiptSchemaVersion: 7,
          configWrite: 'succeeded',
          overallState: 'succeeded',
          deleted: true,
        },
      });
      expect((await readStore()).exists).toBe(false);
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');
    }, 30_000);

    // Test Value Gate: CLI save notices and atomic failure receipts must agree with the stored values.
    it('saves without apply and preserves the previous store on atomic failure', async (test) => {
      const { runPublic, runHumanConfig, readStore, configPath, store } = await createFixture(test);
      const human = await runHumanConfig([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--context', 'project', '--platform', 'codex',
      ]);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain('已保存 demo.mode');
      expect(human.stderr).toContain('未请求应用');
      expect(human.stderr).not.toContain('projectConfigShareabilityUnverified');
      expect((await readStore()).values).toEqual({ mode: 'fast' });
      await expect(fs.pathExists(configPath)).resolves.toBe(false);

      const userSet = await runHumanConfig([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"user-fast"', '--context', 'user',
      ]);
      const userUnset = await runHumanConfig([
        'plugin', 'config', 'unset', 'team/demo', 'mode', '--context', 'user',
      ]);
      await writePluginConfigStore({ ...store, platform: undefined, values: { mode: 'user-reset' } });
      const userReset = await runHumanConfig([
        'plugin', 'config', 'reset', 'team/demo', '--context', 'user', '--yes',
      ]);
      for (const result of [userSet, userUnset, userReset]) {
        expect(result.exitCode).toBe(0);
        expect(result.stderr.match(/其它项目不会由本次命令扫描或更新/g)).toHaveLength(1);
      }

      setAtomicConfigBeforeRenameHookForTests(async () => {
        throw new Error('injected config commit failure');
      });
      let atomicFailure;
      try {
        atomicFailure = await runPublic([
          'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"safe"', '--context', 'project', '--platform', 'codex',
        ]);
      } finally {
        setAtomicConfigBeforeRenameHookForTests(undefined);
      }
      expect(atomicFailure).toMatchObject({
        exitCode: 1,
        payload: {
          receiptSchemaVersion: 7,
          configWrite: 'failed',
          overallState: 'failed',
        },
      });
      expect((await readStore()).values).toEqual({ mode: 'fast' });
    }, 30_000);

    // Test Value Gate: invalid configuration remains repairable without overwriting valid output or unrelated fields.
    it('removes stale keys and repairs invalid fields without refreshing unrelated output', async (test) => {
      const { runPublic, runHumanConfig, readStore, configPath, store } = await createFixture(test);
      expect(await runPublic(['plugin', 'install', 'team/demo', '--scope', 'project']))
        .toMatchObject({ exitCode: 0, payload: { ok: true } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      await writePluginConfigStore({
        ...store,
        values: { obsolete: 'old' },
      });
      const staleUnset = await runPublic([
        'plugin', 'config', 'unset', 'team/demo', 'obsolete', '--context', 'project', '--platform', 'codex', '--apply',
      ]);
      expect(staleUnset).toMatchObject({
        exitCode: 0,
        payload: {
          receiptSchemaVersion: 7,
          configWrite: 'succeeded',
          staleRemovedKeys: ['obsolete'],
          affectedFields: [expect.objectContaining({ key: 'obsolete', stale: true })],
          apply: { state: 'skipped', reason: 'noEffectiveConfigChange', targetResults: [] },
        },
      });
      expect(staleUnset.payload).not.toHaveProperty('targetResults');
      expect((await readStore()).values).toEqual({});
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      await writePluginConfigStore({
        ...store,
        values: { labels: { 'bad key': 'preserved' } },
      });
      const partial = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--context', 'project', '--platform', 'codex', '--apply',
      ]);
      expect(partial, JSON.stringify(partial)).toMatchObject({
        exitCode: 1,
        payload: {
          receiptSchemaVersion: 7,
          configWrite: 'succeeded',
          overallState: 'partial',
          apply: {
            state: 'partial',
            targetResults: [expect.objectContaining({ state: 'skipped', errorCode: 'invalidConfig' })],
          },
          effective: {
            fieldStates: {
              labels: { invalidOverride: { source: 'platform' } },
              mode: { effective: { source: 'platform', value: 'fast' } },
            },
          },
        },
      });
      expect((await readStore()).values).toEqual({
        labels: { 'bad key': 'preserved' },
        mode: 'fast',
      });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      const unavailableHuman = await runHumanConfig([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"slow"', '--context', 'project', '--platform', 'codex', '--apply',
      ]);
      expect(unavailableHuman).toMatchObject({ exitCode: 1 });
      expect(unavailableHuman.stdout).toContain('已保存 demo.mode');
      expect(unavailableHuman.stderr).toContain('codex/project：[invalidConfig]');
      expect(unavailableHuman.stderr).toContain(
        'aw plugin sync demo --rebuild --target codex --context project',
      );
      expect(unavailableHuman.stderr).not.toContain('bad key');

      const repaired = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'labels', '--value-json', '{"good_key":"repaired"}',
        '--context', 'project', '--platform', 'codex', '--apply',
      ]);
      expect(repaired).toMatchObject({
        exitCode: 0,
        payload: {
          configWrite: 'succeeded',
          overallState: 'succeeded',
          apply: { state: 'skipped', reason: 'noEffectiveConfigChange' },
        },
      });
      expect((await readStore()).values).toEqual({
        labels: { good_key: 'repaired' },
        mode: 'slow',
      });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');
    }, 30_000);

    // Test Value Gate: a real renderer failure preserves the committed store and previous output, with safe recovery guidance.
    it('keeps saved config and previous output when rendering fails', async (test) => {
      const { runPublic, runHumanConfig, readStore, configPath, store } = await createFixture(test);
      await writePluginConfigStore({ ...store, values: { labels: { good_key: 'repaired' }, mode: 'fast' } });
      expect(await runPublic(['plugin', 'install', 'team/demo', '--scope', 'project']))
        .toMatchObject({ exitCode: 0, payload: { ok: true } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=fast');

      const failed = await runHumanConfig([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"fail"', '--context', 'project', '--platform', 'codex', '--apply',
      ]);
      expect(failed).toMatchObject({ exitCode: 1 });
      expect(failed.stderr).toContain('codex/project：[writeFailed]');
      expect(failed.stderr).toContain(
        'aw plugin sync demo --rebuild --target codex --context project',
      );
      expect(failed.stderr).not.toContain('file:///');
      expect((await readStore()).values).toEqual({
        labels: { good_key: 'repaired' },
        mode: 'fail',
      });
      const configAfterFailure = await fs.readFile(configPath, 'utf8');
      expect(configAfterFailure).toContain('mode=fast');
      expect(configAfterFailure).not.toContain('mode=fail');
    }, 30_000);
  });

  it.each([
    ['SKILL.md', 'native-sensitive-skill'],
    ['references/secret.md', 'native-sensitive-reference'],
  ] as const)(
    'blocks sensitive config in native %s before live Codex mutations',
    async (leakPath, pluginName) => {
      const isolation = getCurrentSourceTestIsolation();
      const env = {
        ...isolation.env,
        AW_HOME: path.join(isolation.env.AW_HOME!, 'renderer-process-long-working-directory'),
      };
      const sourceRoot = path.join(isolation.layout.fixtureCwd, `${pluginName}-source`);
      const rendererPath = path.join(sourceRoot, 'plugins', pluginName, 'scripts', 'render.mjs');
      const secret = `secret-${pluginName}-value`;
      const writeRenderer = async (leak: boolean) => {
        const skill = leak && leakPath === 'SKILL.md' ? `native ${secret}` : 'native safe';
        const reference = leak && leakPath === 'references/secret.md'
          ? `, "references/secret.md": ${JSON.stringify(secret)}`
          : '';
        await fs.outputFile(rendererPath, [
          'import assert from "node:assert/strict";',
          'import { readFile, realpath } from "node:fs/promises";',
          'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
          'assert.ok(context.plugin.rootDir.length >= 260);',
          'assert.equal(await realpath(process.cwd()), await realpath(context.plugin.rootDir));',
          'console.log(JSON.stringify({ version: 2, artifacts: context.requestedArtifactIds.map((id) => ({',
          '  id, kind: "skill", platform: "codex", target: "codex.skill", state: "present",',
          `  skillKey: ${JSON.stringify(pluginName)}, refreshKeys: [], content: { files: {`,
          `    "SKILL.md": ${JSON.stringify(skill)}, "README.md": "native readme",`,
          `    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n"${reference}`,
          '  } }',
          '})) }));',
        ].join('\n'));
      };
      const createFixture = () => createCatalogSnapshotFixture(
        sourceRoot,
        pluginName,
        [],
        'native sensitive fixture\n',
        (manifest) => {
          manifest.platforms = ['codex'];
          manifest.config = {
            fields: { secret: { type: 'string', sensitive: true } },
          };
          manifest.scripts = {
            artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
          };
          manifest.artifacts = {
            targets: [{
              id: pluginName,
              platform: 'codex',
              scopes: ['user', 'project'],
              target: 'codex.skill',
              states: ['present'],
              refreshKeys: [],
              skillKey: pluginName,
            }],
          };
        },
      );

      await writeRenderer(false);
      await createFixture();
      const before = await readCatalogSourcesConfigSnapshot(env);
      await replaceCatalogSourcesConfig({
        config: {
          schemaVersion: 2,
          sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
        },
        expectedDigest: before.digest,
        env,
      });
      await writePluginConfigStore({
        sourceId: 'team',
        sourceIdentity: await calculateCatalogSourceIdentity({
          id: 'team', type: 'path', primary: true, path: sourceRoot,
        }),
        pluginName,
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        env,
        values: { secret },
      });
      const runtime = await createCodexNativeTestRuntime({ ...isolation, env });
      const installed = await installFixturePlugin([`team/${pluginName}`], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, runtime);
      expect(installed, JSON.stringify(installed, null, 2))
        .toMatchObject({ overallState: 'succeeded' });

      const marketplaceRoot = path.join(env.AW_HOME, 'marketplaces', 'team');
      const pluginId = `${pluginName}@aw`;
      const marketplaceBefore = await snapshotRegularTree(marketplaceRoot);
      const installedBefore = new Set(runtime.installed);
      const configPath = path.join(env.CODEX_HOME!, 'config.toml');
      const configBefore = await fs.readFile(configPath);
      const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
      const projectConfigBefore = await fs.readFile(projectConfigPath).catch(() => undefined);

      await writeRenderer(true);
      await createFixture();
      await syncCatalogSourceGeneration({
        sourceId: 'team', cliVersion: '1.0.0', env,
      });
      const callsBeforeSync = runtime.nativeCliRunner.mock.calls.length;
      const result = await syncWriteCommand([`team/${pluginName}`], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, runtime);

      expect(result, JSON.stringify(result, null, 2)).toMatchObject({
        overallState: 'failed',
        targetResults: [expect.objectContaining({
          state: 'failed', errorCode: 'artifactRendererSensitiveConfigExposed',
        })],
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
      const mutationCalls = runtime.nativeCliRunner.mock.calls.slice(callsBeforeSync)
        .filter(([invocation]) => {
          const pluginIndex = invocation.args.indexOf('plugin');
          const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
          return args[1] === 'add' || args[1] === 'remove'
            || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
        });
      expect(mutationCalls).toEqual([]);
      await expect(fs.readFile(configPath)).resolves.toEqual(configBefore);
      expect(await fs.readFile(projectConfigPath).catch(() => undefined)).toEqual(projectConfigBefore);
      expect(runtime.installed).toEqual(installedBefore);
      expect(runtime.installed).toContain(pluginId);
    },
    30_000,
  );

  it('blocks a sensitive user override found only in a static native Skill before Codex mutations', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'static-sensitive-source');
    const pluginName = 'static-sensitive';
    const skillKey = 'static-sensitive-skill';
    const secret = 'user-static-sensitive-token';
    const configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.skills = './skills';
      manifest.config = {
        schemaVersion: 5, fields: {},
        platforms: { codex: { fields: { secret: { type: 'string', sensitive: true } } } },
      };
    };
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], 'static sensitive\n', configureManifest);
    await Promise.all([
      fs.outputFile(
        path.join(sourceRoot, 'plugins', pluginName, 'skills', skillKey, 'SKILL.md'),
        `static payload ${secret}\n`,
      ),
      fs.outputFile(
        path.join(sourceRoot, 'plugins', pluginName, 'skills', skillKey, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], 'static sensitive\n', configureManifest);
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { secret },
    });
    const runtime = await createCodexNativeTestRuntime(isolation);

    const result = await installFixturePlugin([`team/${pluginName}`], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({
        state: 'failed', errorCode: 'codexNativeRenderSensitiveValue',
      })],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'marketplaces', 'team')))
      .resolves.toBe(false);
    expect(runtime.installed).toEqual(new Set());
    expect(runtime.nativeCliRunner.mock.calls.filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add' || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    })).toEqual([]);
  }, 30_000);

  it('blocks activation-only reuse when current canonical native Skills contain a sensitive user value', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'activation-sensitive-source');
    const pluginName = 'activation-sensitive';
    const skillKey = 'activation-sensitive-skill';
    const secret = 'existing-static-sensitive-token';
    const safeDefault = 'non-skill-sensitive-default';
    const configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.skills = './skills';
      manifest.config = {
        schemaVersion: 5,
        fields: { secret: { type: 'string', sensitive: true } },
      };
    };
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], `${safeDefault}\n`, configureManifest);
    await Promise.all([
      fs.outputFile(
        path.join(sourceRoot, 'plugins', pluginName, 'skills', skillKey, 'SKILL.md'),
        `static payload ${secret}\n`,
      ),
      fs.outputFile(
        path.join(sourceRoot, 'plugins', pluginName, 'skills', skillKey, 'agents', 'openai.yaml'),
        'policy:\n  allow_implicit_invocation: true\n',
      ),
    ]);
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], `${safeDefault}\n`, configureManifest);
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin([`team/${pluginName}`], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName,
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { secret },
    });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const marketplaceBefore = await snapshotRegularTree(marketplaceRoot);
    const userConfigPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    const userConfigBefore = await fs.readFile(userConfigPath);
    const projectConfigPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const projectConfigBefore = await fs.readFile(projectConfigPath).catch(() => undefined);
    const callsBefore = runtime.nativeCliRunner.mock.calls.length;

    const result = await installFixturePlugin([`team/${pluginName}`], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({
        state: 'failed', errorCode: 'codexNativeRenderSensitiveValue',
      })],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
    await expect(fs.readFile(userConfigPath)).resolves.toEqual(userConfigBefore);
    expect(await fs.readFile(projectConfigPath).catch(() => undefined)).toEqual(projectConfigBefore);
    expect(runtime.nativeCliRunner.mock.calls.slice(callsBefore).filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add' || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    })).toEqual([]);
    expect(runtime.installed).toContain(`${pluginName}@aw`);
  }, 30_000);

  it('rejects a Windows-style parent Skills root before activation-only sensitive scanning', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'unsafe-native-skills-root-source');
    const pluginName = 'unsafe-native-skills-root';
    const configureManifest = (manifest: PluginMeta['manifest']) => {
      manifest.platforms = ['codex'];
      manifest.skills = './skills';
      manifest.config = {
        schemaVersion: 5,
        fields: { secret: { type: 'string', sensitive: true } },
      };
    };
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], 'safe-default\n', configureManifest);
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', pluginName, 'skills', 'safe', 'SKILL.md'),
      '# Safe\n',
    );
    await fs.outputFile(
      path.join(sourceRoot, 'plugins', pluginName, 'skills', 'safe', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    );
    await createCatalogSnapshotFixture(sourceRoot, pluginName, [], 'safe-default\n', configureManifest);
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      logicalIdentity: await readCatalogLogicalIdentity(sourceRoot),
      pluginName,
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { secret: 'safe-default' },
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    await expect(installFixturePlugin([`team/${pluginName}`], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      logicalIdentity: await readCatalogLogicalIdentity(sourceRoot),
      pluginName,
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      values: { secret: 'sensitive-value' },
    });
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    const codexManifestPath = path.join(
      marketplaceRoot,
      'plugins',
      pluginName,
      '.codex-plugin',
      'plugin.json',
    );
    const codexManifest = await fs.readJson(codexManifestPath);
    await fs.outputJson(codexManifestPath, { ...codexManifest, skills: '..\\outside' });
    const callsBefore = runtime.nativeCliRunner.mock.calls.length;

    const result = await installFixturePlugin([`team/${pluginName}`], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);

    expect(result, JSON.stringify(result, null, 2)).toMatchObject({
      overallState: 'failed',
      targetResults: [expect.objectContaining({
        state: 'failed', errorCode: 'codexNativeSkillsRootInvalid',
      })],
    });
    expect(runtime.nativeCliRunner.mock.calls.slice(callsBefore).filter(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
      return args[1] === 'add' || args[1] === 'remove'
        || (args[1] === 'marketplace' && (args[2] === 'add' || args[2] === 'remove'));
    })).toEqual([]);
  }, 30_000);

  describe('project Codex intent with shared user config', () => {
    async function createNativeConfigFixture(
      test: TestContext,
      { initialMode, legacySkills = true }: { initialMode?: string; legacySkills?: boolean } = {},
    ) {
      const timing = createCommandTestTiming(test);
      const isolation = getCurrentSourceTestIsolation();
      await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
        { ...createEmptyPreferences(), targets: ['codex'] });
      const sourceRoot = path.join(isolation.layout.fixtureCwd, 'shared-native-config-source');
      const rendererMarker = path.join(isolation.layout.fixtureCwd, 'native-config-renderer.jsonl');
      await fs.outputFile(path.join(sourceRoot, 'plugins', 'native-config', 'scripts', 'render.mjs'), [
        'import { appendFile, readFile, realpath } from "node:fs/promises";',
        'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
        'const mode = context.config.values.mode;',
        'if (mode === "fail") throw new Error("native renderer requested failure");',
        `await appendFile(${JSON.stringify(rendererMarker)}, JSON.stringify({ cwd: process.cwd(), realCwd: await realpath(process.cwd()), realPluginRoot: await realpath(context.plugin.rootDir), context }) + "\\n");`,
        'console.log(JSON.stringify({ version: 2, artifacts: context.requestedArtifactIds.map((id) => ({',
        '  id, kind: "skill", platform: "codex", target: "codex.skill",',
        '  state: mode === "off" ? "disabled" : "present",',
        '  skillKey: "native-config", refreshKeys: ["mode"],',
        '  ...(mode === "off" ? { disabledReason: "disabled by user config" } : { content: { files: {',
        '    "SKILL.md": `mode=${context.config.values.mode}\\nrequestScope=${context.scope}\\nconfigScope=${context.config.targetScope}\\nsource=${context.config.sources.mode}\\n`,',
        '    "README.md": "native readme",',
        '    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n"',
        '  } } })',
        '})) }));',
      ].join('\n'));
      await createCatalogSnapshotFixture(sourceRoot, 'native-config', [], 'native\n', (manifest) => {
        manifest.platforms = ['codex'];
        manifest.config = {
          schemaVersion: 5,
          fields: {
            mode: { type: 'string', default: 'safe' },
            projectMode: { type: 'string', default: 'project-default' },
          },
        };
        manifest.scripts = {
          artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
        };
        manifest.artifacts = {
          targets: [{
            id: 'native-config',
            platform: 'codex',
            scopes: ['user', 'project'],
            target: 'codex.skill',
            states: ['present', 'disabled'],
            refreshKeys: ['mode'],
            skillKey: 'native-config',
          }],
        };
      });
      const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
      const before = await readCatalogSourcesConfigSnapshot(isolation.env);
      await replaceCatalogSourcesConfigWithoutActive({
        config: { schemaVersion: 2, sources: [source] },
        expectedDigest: before.digest,
        env: isolation.env,
      });
      await timing.measure('catalog', 'source sync', () => syncCatalogSourceGeneration({
        sourceId: 'team',
        cliVersion: '1.0.0',
        env: isolation.env,
      }));
      await addProjectFixtureRoots({
        cwd: isolation.layout.fixtureCwd, env: isolation.env, selectors: ['team/native-config'],
      });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const runPublic = async (args: string[]) => {
        const captured = createCapturedCliIo();
        const exitCode = await timing.measure('command', args[1] === 'config' ? `plugin config ${args[2]}` : `plugin ${args[1]}`, () => runCli([...args, '--json'], {
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
          io: captured.io,
          interactive: false,
          nativeCliRunner: runtime.nativeCliRunner,
        }));
        return {
          exitCode,
          payload: JSON.parse(captured.readStdout()) as Record<string, unknown>,
        };
      };
      const readStore = () => readPluginConfigStore({
        sourceId: 'team',
        sourceIdentity,
        pluginName: 'native-config',
        scope: 'user',
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
      });
      const writeMode = (mode: string) => writePluginConfigStore({
        sourceId: 'team', sourceIdentity, logicalIdentity, pluginName: 'native-config',
        scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env, values: { mode },
      });
      await writePluginConfigStore({
        sourceId: 'team',
        sourceIdentity,
        logicalIdentity,
        pluginName: 'native-config',
        scope: 'user',
        platform: 'codex',
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        values: { projectMode: 'platform-only' },
      });
      if (initialMode !== undefined) await writeMode(initialMode);
      const initialInstalled = await timing.measure('command', 'fixture install', () => installFixturePlugin(['team/native-config'], {
        cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
      }, runtime));
      expect(initialInstalled, JSON.stringify(initialInstalled)).toMatchObject({ overallState: 'succeeded' });
      await fs.writeFile(rendererMarker, '');
      const legacyProjectSkillsRoot = path.join(
        isolation.layout.fixtureCwd,
        '.agents',
        'skills',
      );
      const legacyProjectSkillRoot = path.join(legacyProjectSkillsRoot, 'native-config');
      const legacyUserSkillsRoot = path.join(isolation.env.CODEX_HOME!, 'skills');
      const legacyUserSkillRoot = path.join(legacyUserSkillsRoot, 'native-config');
      if (legacySkills) {
        await fs.outputFile(path.join(legacyProjectSkillRoot, 'SKILL.md'), 'legacy owned\n');
        await writeSkillOwnerMarker({
          skillRoot: legacyProjectSkillRoot,
          allowedRoot: legacyProjectSkillsRoot,
          identity: {
            owner: 'agent-workflows',
            sourceId: 'team',
            sourceIdentity,
            pluginId: 'team/native-config',
            plugin: 'native-config',
            artifactKey: 'native-config',
            platform: 'codex',
            scope: 'project',
          },
        });
        await fs.outputFile(path.join(legacyUserSkillRoot, 'SKILL.md'), 'legacy user owned\n');
        await writeSkillOwnerMarker({
          skillRoot: legacyUserSkillRoot,
          allowedRoot: legacyUserSkillsRoot,
          identity: {
            owner: 'agent-workflows',
            sourceId: 'team',
            sourceIdentity,
            pluginId: 'team/native-config',
            plugin: 'native-config',
            artifactKey: 'native-config',
            platform: 'codex',
            scope: 'user',
          },
        });
      }

      const snapshotOutputs = async () => ({
        marketplace: await snapshotRegularTree(path.join(isolation.env.AW_HOME!, 'marketplaces', 'team')),
        cache: await snapshotRegularTree(path.join(isolation.env.CODEX_HOME!, 'plugins', 'cache', 'aw', 'native-config')),
        userConfig: await fs.readFile(path.join(isolation.env.CODEX_HOME!, 'config.toml')),
        projectConfig: await fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')),
        legacyUser: await fs.pathExists(legacyUserSkillRoot) ? await snapshotRegularTree(legacyUserSkillRoot) : null,
        legacyProject: await fs.pathExists(legacyProjectSkillRoot) ? await snapshotRegularTree(legacyProjectSkillRoot) : null,
      });
      const [canonicalPluginId] = [...runtime.installed];
      expect(canonicalPluginId).toBe('native-config@aw');
      const cachePluginRoot = path.join(
        isolation.env.CODEX_HOME!,
        'plugins',
        'cache',
        'aw',
        'native-config',
        '1.0.0',
      );
      const marketplacePluginRoot = path.join(
        isolation.env.AW_HOME!,
        'marketplaces',
        'team',
        'plugins',
        'native-config',
      );
      const cacheSkillRoot = path.join(cachePluginRoot, 'codex', 'skills', 'native-config');
      const marketplaceSkillRoot = path.join(
        marketplacePluginRoot,
        'codex',
        'skills',
        'native-config',
      );
      const statusBinRoot = await writeStatusSystemCodexPackage(
        path.join(isolation.layout.fixtureCwd, 'native-config-status-prefix'),
        runtime.codexVersion,
      );
      const readNativeStatus = async () => {
        const statusRunner = vi.fn(runtime.nativeCliRunner);
        setNativeCliRunnerOverrideForTests(statusRunner);
        try {
          const status = await timing.measure('observation', 'Native status', () => statusCommandV8({
            recoverySelection: { targets: ['codex'] },
            plugins: ['team/native-config'],
            cwd: isolation.layout.fixtureCwd,
            env: { ...isolation.env, PATH: statusBinRoot },
            cliVersion: '1.0.0',
            platform: 'codex',
            scope: 'project',
            json: true,
          }));
          return { status, statusRunner };
        } finally {
          setNativeCliRunnerOverrideForTests(null);
        }
      };
      const userIntentBeforeSave = await observeIntent({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env });
      expect(userIntentBeforeSave).toMatchObject({ state: 'absent' });
      return {
        timing, isolation, sourceIdentity, runtime, runPublic, readStore, writeMode,
        rendererMarker, legacyProjectSkillsRoot, legacyProjectSkillRoot, legacyUserSkillRoot,
        snapshotOutputs, userIntentBeforeSave, canonicalPluginId, cachePluginRoot,
        marketplacePluginRoot, cacheSkillRoot, marketplaceSkillRoot, readNativeStatus,
      };
    }

    // Test Value Gate: public config writes need consent before changing shared Native output.
    it('saves and authorizes shared native config without creating user intent', async (test) => {
      const {
        isolation, runtime, runPublic, readStore, rendererMarker, legacyUserSkillRoot,
        legacyProjectSkillRoot, snapshotOutputs, userIntentBeforeSave, cachePluginRoot,
        cacheSkillRoot, marketplaceSkillRoot,
      } = await createNativeConfigFixture(test);
      const outputsBeforeSave = await snapshotOutputs();
      const nativeCallsBeforeSave = runtime.nativeCliRunner.mock.calls.length;
      expect(await runPublic([
        'plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"saved"', '--context', 'project',
      ])).toMatchObject({
        exitCode: 0,
        payload: { apply: { state: 'skipped', reason: 'notRequested', targetResults: [] } },
      });

      expect(await snapshotOutputs()).toEqual(outputsBeforeSave);
      expect(await observeIntent({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env })).toEqual(userIntentBeforeSave);
      expect(await fs.readFile(rendererMarker, 'utf8')).toBe('');
      const blocked = await runPublic([
        'plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"blocked"', '--context', 'project', '--apply',
      ]);
      expect(blocked, JSON.stringify(blocked)).toMatchObject({
        exitCode: 1,
        payload: { configWrite: 'succeeded', overallState: 'partial',
          apply: { state: 'unavailable', error: { code: 'sharedNativeConfigApplyConfirmationRequired' } },
        },
      });
      expect((await readStore()).values).toEqual({ mode: 'blocked' });
      expect(await snapshotOutputs()).toEqual(outputsBeforeSave);
      expect(await observeIntent({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env })).toEqual(userIntentBeforeSave);
      expect(runtime.nativeCliRunner.mock.calls.slice(nativeCallsBeforeSave).filter(([invocation]) => {
        const index = invocation.args.indexOf('plugin');
        const args = index < 0 ? invocation.args : invocation.args.slice(index);
        return args[1] === 'add' || args[1] === 'remove' || args[1] === 'marketplace' && ['add', 'remove'].includes(args[2]!);
      })).toEqual([]);
      await fs.writeFile(rendererMarker, '');

      const userConfigBeforeAuthorized = await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml'));
      const projectConfigBeforeAuthorized = await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'));
      const legacyBeforeAuthorized = {
        user: await fs.pathExists(legacyUserSkillRoot),
        project: await fs.pathExists(legacyProjectSkillRoot),
      };
      expect(legacyBeforeAuthorized).toEqual({ user: true, project: true });
      expect(userConfigBeforeAuthorized.snapshot.plugins['native-config@aw']?.enabled).toBe(false);
      expect(projectConfigBeforeAuthorized.snapshot.plugins['native-config@aw']?.enabled).toBe(true);
      const nativeCallsBeforeAuthorized = runtime.nativeCliRunner.mock.calls.length;
      const authorized = await runPublic([
        'plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"authorized"', '--context', 'project', '--apply', '--yes',
      ]);
      expect(authorized, JSON.stringify(authorized, null, 2)).toMatchObject({
        exitCode: 0,
        payload: {
          configWrite: 'succeeded',
          overallState: 'succeeded',
        },
      });
      expect((await readStore()).values).toEqual({ mode: 'authorized' });
      const userConfigAfterAuthorized = await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml'));
      const projectConfigAfterAuthorized = await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'));
      expect(userConfigAfterAuthorized.snapshot.plugins['native-config@aw']?.enabled).toBe(false);
      expect(await observeIntent({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env })).toEqual(userIntentBeforeSave);
      expect(projectConfigAfterAuthorized.snapshot.plugins['native-config@aw']?.enabled).toBe(true);
      // The User result records the shared Native package producer.
      expect((authorized.payload as { apply: { targetResults: unknown[] } }).apply.targetResults).toEqual([
        expect.objectContaining({ target: expect.objectContaining({ pluginId: 'team/native-config', platform: 'codex', scope: 'user' }),
          action: 'refresh', state: 'completed' }),
        expect.objectContaining({ target: expect.objectContaining({ pluginId: 'team/native-config', platform: 'codex', scope: 'project' }),
          action: 'refresh', state: 'completed' }),
      ]);

      const directUserSkillRoot = legacyUserSkillRoot;
      const directProjectSkillRoot = legacyProjectSkillRoot;
      await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toContain('mode=authorized\nrequestScope=user\nconfigScope=user\n');
      await expect(fs.readFile(path.join(marketplaceSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toContain('mode=authorized\nrequestScope=user\nconfigScope=user\n');
      await expect(fs.pathExists(path.join(cacheSkillRoot, SKILL_OWNER_MARKER))).resolves.toBe(false);
      await expect(fs.pathExists(path.join(marketplaceSkillRoot, SKILL_OWNER_MARKER))).resolves.toBe(false);
      expect({
        user: await fs.pathExists(directUserSkillRoot),
        project: await fs.pathExists(directProjectSkillRoot),
      }).toEqual({ user: true, project: true });
      expect(await snapshotRegularTree(directUserSkillRoot)).toEqual(outputsBeforeSave.legacyUser);
      expect(await snapshotRegularTree(directProjectSkillRoot)).toEqual(outputsBeforeSave.legacyProject);
      const firstReceipt = await fs.readJson(
        path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
      ) as { configDigest: string; targets: Array<{ configDigest: string }> };
      expect(firstReceipt.targets).toHaveLength(1);
      const firstRenderEvents = (await fs.readFile(rendererMarker, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as {
          cwd: string; realCwd: string; realPluginRoot: string;
          context: { scope: string; requestedArtifactIds: string[];
            plugin: { rootDir: string }; config: { targetScope: string; schema: object;
              values: Record<string, unknown> } };
        });
      expect(firstRenderEvents, JSON.stringify({
        events: firstRenderEvents.map(({ cwd, context }) => ({
          cwd, scope: context.scope, targetScope: context.config.targetScope,
          requestedArtifactIds: context.requestedArtifactIds, mode: context.config.values.mode,
        })),
        apply: (authorized.payload as { apply?: unknown }).apply,
        nativeWrites: runtime.nativeCliRunner.mock.calls.slice(nativeCallsBeforeAuthorized)
          .map(([invocation]) => invocation.args.slice(invocation.args.indexOf('plugin')).join(' '))
          .filter((args) => args.includes(' add ') || args.includes(' remove ')),
      })).not.toHaveLength(0);
      const projectCwd = await realpath(isolation.layout.fixtureCwd);
      for (const event of firstRenderEvents) {
        expect(event.realCwd).toBe(event.realPluginRoot);
        expect(event.realCwd).not.toBe(projectCwd);
        expect(event.context.scope).toBe('user');
        expect(event.context.config.targetScope).toBe('user');
        expect(['blocked', 'authorized']).toContain(event.context.config.values.mode);
        expect(event.context.requestedArtifactIds).toEqual(['native-config']);
      }
      expect(firstRenderEvents.some(({ context }) => context.config.values.mode === 'authorized')).toBe(true);
      expect(runtime.nativeCliRunner.mock.calls.slice(nativeCallsBeforeAuthorized).filter(([invocation]) => {
        const index = invocation.args.indexOf('plugin');
        return invocation.args[index + 1] === 'add';
      })).toHaveLength(1);
      expect(firstRenderEvents[0]!.context.config.schema).not.toHaveProperty('projectMode');
      expect(firstRenderEvents[0]!.context.config.values).not.toHaveProperty('projectMode');

      expect(await runPublic([
        'plugin', 'config', 'unset', 'team/native-config', 'mode', '--context', 'project', '--apply',
      ])).toMatchObject({
        exitCode: 1,
        payload: { configWrite: 'succeeded', overallState: 'partial',
          apply: { state: 'unavailable', error: { code: 'sharedNativeConfigApplyConfirmationRequired' } },
        },
      });
      expect((await readStore()).values).toEqual({});

      const authorizedUnset = await runPublic([
        'plugin', 'config', 'apply', 'team/native-config', '--context', 'project', '--yes',
      ]);
      expect(authorizedUnset, JSON.stringify(authorizedUnset, null, 2)).toMatchObject({
        exitCode: 0,
        payload: { configWrite: 'notStarted', overallState: 'succeeded' },
      });
      expect((await readStore()).values).toEqual({});
      const finalReceipt = await fs.readJson(
        path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
      ) as { configDigest: string };
      expect(finalReceipt.configDigest).not.toBe(firstReceipt.configDigest);
      await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toContain('mode=safe\nrequestScope=user\nconfigScope=user\n');

      const nativeCallsBeforeSourceOnlySet = runtime.nativeCliRunner.mock.calls.length;
      const sourceOnlySet = await runPublic([
        'plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"safe"',
        '--context', 'project', '--apply', '--yes',
      ]);
      expect(sourceOnlySet, JSON.stringify(sourceOnlySet, null, 2)).toMatchObject({
        exitCode: 0,
        payload: {
          configWrite: 'succeeded',
          updatedKeys: ['mode'],
          apply: { state: 'succeeded' },
        },
      });
      expect(runtime.nativeCliRunner.mock.calls.slice(nativeCallsBeforeSourceOnlySet).filter(([invocation]) => {
        const index = invocation.args.indexOf('plugin');
        return invocation.args[index + 1] === 'add';
      })).toHaveLength(1);
      await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toContain('source=common\n');
      await expect(fs.readFile(path.join(marketplaceSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toContain('source=common\n');
    }, 120_000);

    // Test Value Gate: status rejects foreign evidence and public sync repairs only owned output.
    it('diagnoses and recovers damaged shared native projections without trusting cache evidence', async (test) => {
      const {
        isolation, runtime, runPublic, writeMode, rendererMarker, legacyUserSkillRoot,
        legacyProjectSkillRoot, userIntentBeforeSave, canonicalPluginId, cachePluginRoot,
        marketplacePluginRoot, cacheSkillRoot, marketplaceSkillRoot, readNativeStatus,
      } = await createNativeConfigFixture(test, { initialMode: 'authorized' });
      const firstReceipt = await fs.readJson(
        path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
      ) as CodexNativeRenderReceipt;
      const rendererBeforeStatus = await fs.readFile(rendererMarker, 'utf8');
      const exactStatus = await readNativeStatus();
      expect(exactStatus.status.payload.targets).toEqual([
        expect.objectContaining({
          state: 'needsSync',
          placements: [expect.objectContaining({
            scope: 'project', state: 'needsSync',
            components: expect.arrayContaining([
              expect.objectContaining({ kind: 'intent', state: 'desired' }),
              expect.objectContaining({ kind: 'ownership', key: 'native-config', state: 'partial',
                metadata: expect.objectContaining({ errorCode: 'componentInspectionFailed' }) }),
            ]),
          })],
        }),
      ]);
      expect(statusTargetSharedNative(exactStatus.status.payload.targets[0]!))
        .toMatchObject({ state: 'usable', version: '1.0.0' });
      expect(statusTargetActivation(exactStatus.status.payload.targets[0]!.placements[0]!))
        .toMatchObject({ project: true, effective: true });
      expect(await fs.readFile(rendererMarker, 'utf8')).toBe(rendererBeforeStatus);

      // Public save-only behavior has its own test; this fixture needs only config drift.
      await writeMode('drifted');
      const driftStatus = await readNativeStatus();
      expect(driftStatus.status.payload.targets[0]).toMatchObject({ state: 'needsSync' });
      expect(statusTargetSharedNative(driftStatus.status.payload.targets[0]!))
        .toMatchObject({ state: 'replaceable', reason: 'renderDrift' });
      expect(driftStatus.status.payload.targets[0]!.reasons)
        .toContainEqual(expect.objectContaining({ code: 'codexSharedNativeRenderDrift' }));
      expect(await fs.readFile(rendererMarker, 'utf8')).toBe(rendererBeforeStatus);

      await fs.outputFile(path.join(marketplaceSkillRoot, 'SKILL.md'), 'stale replay overlay\n');
      const refreshed = await runPublic([
        'plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"refreshed"',
        '--context', 'project', '--apply', '--yes',
      ]);
      expect(refreshed, JSON.stringify(refreshed, null, 2)).toMatchObject({
        exitCode: 0,
        payload: { configWrite: 'succeeded', overallState: 'succeeded' },
      });
      const refreshedReceipt = await fs.readJson(
        path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
      ) as CodexNativeRenderReceipt;
      expect(refreshedReceipt.configDigest).not.toBe(firstReceipt.configDigest);
      await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toContain('mode=refreshed\nrequestScope=user\nconfigScope=user\n');
      await expect(fs.readFile(path.join(marketplaceSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toContain('mode=refreshed\nrequestScope=user\nconfigScope=user\n');
      const refreshedConfig = await readCodexConfigFile(
        path.join(isolation.env.CODEX_HOME!, 'config.toml'),
      );
      const refreshedProjectConfig = await readCodexConfigFile(
        path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'),
      );
      expect(refreshedConfig.snapshot.plugins[canonicalPluginId!]?.enabled).toBe(false);
      expect(refreshedProjectConfig.snapshot.plugins[canonicalPluginId!]?.enabled).toBe(true);

      const canonicalReceiptPath = path.join(
        marketplacePluginRoot,
        CODEX_NATIVE_RENDER_RECEIPT_PATH,
      );
      const canonicalReceipt = await fs.readFile(canonicalReceiptPath);
      const canonicalMarketplaceConfigPath = path.join(
        isolation.env.AW_HOME!,
        'marketplaces',
        'team',
        'config.json',
      );
      const canonicalMarketplaceConfig = await fs.readJson(canonicalMarketplaceConfigPath);
      await fs.outputJson(canonicalMarketplaceConfigPath, {
        ...canonicalMarketplaceConfig,
        sourceIdentity: `sha256:${'f'.repeat(64)}`,
      });
      const mismatchedCanonicalStatus = await readNativeStatus();
      expect(statusTargetSharedNative(mismatchedCanonicalStatus.status.payload.targets[0]!))
        .toMatchObject({ state: 'blocked', reason: 'foreign' });
      await fs.outputJson(canonicalMarketplaceConfigPath, canonicalMarketplaceConfig);
      const canonicalSourceManifestPath = path.join(
        marketplacePluginRoot, '.agents-plugin', 'plugin.json',
      );
      const canonicalSourceManifest = await fs.readJson(canonicalSourceManifestPath);
      await fs.remove(canonicalReceiptPath);
      await fs.outputJson(canonicalSourceManifestPath, {
        ...canonicalSourceManifest,
        name: 'foreign-native-config',
      });
      const missingReceiptForeignManifestStatus = await readNativeStatus();
      expect(statusTargetSharedNative(
        missingReceiptForeignManifestStatus.status.payload.targets[0]!,
      )).toMatchObject({
        state: 'blocked', reason: 'foreign', diagnostic: 'manifestIdentityMismatch',
      });
      await fs.outputJson(canonicalSourceManifestPath, canonicalSourceManifest);
      const missingCanonicalStatus = await readNativeStatus();
      expect(statusTargetSharedNative(missingCanonicalStatus.status.payload.targets[0]!))
        .toMatchObject({
          state: 'replaceable', reason: 'damaged', diagnostic: 'projectionReceiptMissing',
        });
      const originalReadJson = fs.readJson.bind(fs);
      const readJson = vi.spyOn(fs, 'readJson').mockImplementation(
        async (...args: Parameters<typeof fs.readJson>) => {
          if (path.resolve(String(args[0])) === path.resolve(canonicalSourceManifestPath)) {
            throw Object.assign(new Error('private manifest read failure'), { code: 'EIO' });
          }
          return originalReadJson(...args);
        },
      );
      const missingReceiptUnreadableManifestStatus = await readNativeStatus();
      expect(statusTargetSharedNative(
        missingReceiptUnreadableManifestStatus.status.payload.targets[0]!,
      )).toMatchObject({
        state: 'blocked', reason: 'unreadable', diagnostic: 'manifestUnreadable',
      });
      expect(JSON.stringify(missingReceiptUnreadableManifestStatus.status.payload))
        .not.toContain('private manifest read failure');
      readJson.mockRestore();
      await fs.outputFile(canonicalReceiptPath, '{invalid');
      await fs.outputFile(path.join(marketplaceSkillRoot, SKILL_OWNER_MARKER), '{}\n');
      const invalidReceiptForeignOwnerStatus = await readNativeStatus();
      expect(statusTargetSharedNative(invalidReceiptForeignOwnerStatus.status.payload.targets[0]!))
        .toMatchObject({
          state: 'blocked', reason: 'foreign', diagnostic: 'payloadPathUnsafe',
        });
      await fs.remove(path.join(marketplaceSkillRoot, SKILL_OWNER_MARKER));
      const invalidCanonicalStatus = await readNativeStatus();
      expect(statusTargetSharedNative(invalidCanonicalStatus.status.payload.targets[0]!))
        .toMatchObject({
          state: 'replaceable', reason: 'damaged', diagnostic: 'projectionReceiptUnreadable',
        });
      await fs.outputFile(canonicalReceiptPath, canonicalReceipt);

      if (process.platform !== 'win32') {
        await fs.chmod(canonicalReceiptPath, 0o000);
        const unreadableCanonicalStatus = await readNativeStatus();
        expect(statusTargetSharedNative(unreadableCanonicalStatus.status.payload.targets[0]!))
          .toMatchObject({
            state: 'blocked', reason: 'unreadable', diagnostic: 'projectionReceiptUnreadable',
          });
        await fs.chmod(canonicalReceiptPath, 0o644);
      }

      await fs.outputJson(canonicalSourceManifestPath, {
        ...canonicalSourceManifest,
        name: 'foreign-native-config',
      });
      const foreignManifestStatus = await readNativeStatus();
      expect(statusTargetSharedNative(foreignManifestStatus.status.payload.targets[0]!))
        .toMatchObject({
          state: 'blocked', reason: 'foreign', diagnostic: 'manifestIdentityMismatch',
        });
      await fs.outputJson(canonicalSourceManifestPath, canonicalSourceManifest);

      const canonicalCodexManifestPath = path.join(
        marketplacePluginRoot, '.codex-plugin', 'plugin.json',
      );
      const canonicalCodexManifest = await fs.readJson(canonicalCodexManifestPath);
      for (const identityChange of [
        { name: 'foreign-native-config' },
        { version: '9.9.9' },
      ]) {
        await fs.outputJson(canonicalCodexManifestPath, {
          ...canonicalCodexManifest,
          ...identityChange,
        });
        const foreignCodexManifestStatus = await readNativeStatus();
        expect(statusTargetSharedNative(foreignCodexManifestStatus.status.payload.targets[0]!))
          .toMatchObject({
            state: 'blocked', reason: 'foreign', diagnostic: 'manifestIdentityMismatch',
          });
      }
      await fs.outputJson(canonicalCodexManifestPath, canonicalCodexManifest);

      const marketplaceSkillContent = await fs.readFile(
        path.join(marketplaceSkillRoot, 'SKILL.md'),
      );
      await fs.outputFile(path.join(marketplaceSkillRoot, 'SKILL.md'), '');
      const malformedSkillStatus = await readNativeStatus();
      expect(statusTargetSharedNative(malformedSkillStatus.status.payload.targets[0]!))
        .toMatchObject({
          state: 'replaceable', reason: 'damaged', diagnostic: 'projectionPayloadDigestMismatch',
        });
      await fs.outputFile(path.join(marketplaceSkillRoot, 'SKILL.md'), marketplaceSkillContent);

      if (process.platform !== 'win32') {
        const outsideSkillRoot = path.join(
          isolation.layout.fixtureCwd, 'foreign-native-config-skill',
        );
        await fs.move(marketplaceSkillRoot, outsideSkillRoot);
        await fs.symlink(outsideSkillRoot, marketplaceSkillRoot, 'dir');
        const unsafeSkillStatus = await readNativeStatus();
        expect(statusTargetSharedNative(unsafeSkillStatus.status.payload.targets[0]!))
          .toMatchObject({
            state: 'blocked', reason: 'foreign', diagnostic: 'payloadPathUnsafe',
          });
        await fs.remove(marketplaceSkillRoot);
        await fs.move(outsideSkillRoot, marketplaceSkillRoot);
      }

      await fs.remove(marketplaceSkillRoot);
      const missingSkillStatus = await readNativeStatus();
      expect(statusTargetSharedNative(missingSkillStatus.status.payload.targets[0]!))
        .toMatchObject({
          state: 'replaceable', reason: 'damaged', diagnostic: 'projectionPayloadDigestMismatch',
        });
      const recoveredProjection = await runPublic([
        'plugin', 'sync', 'team/native-config', '--target', 'codex', '--context', 'project', '--yes',
      ]);
      expect(recoveredProjection, JSON.stringify(recoveredProjection, null, 2))
        .toMatchObject({ exitCode: 0, payload: { ok: true } });
      await expect(fs.pathExists(legacyUserSkillRoot)).resolves.toBe(false);
      await expect(fs.pathExists(legacyProjectSkillRoot)).resolves.toBe(false);
      expect(await observeIntent({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env })).toEqual(userIntentBeforeSave);
      const recoveredProjectionStatus = await readNativeStatus();
      expect(statusTargetSharedNative(recoveredProjectionStatus.status.payload.targets[0]!))
        .toMatchObject({ state: 'usable', version: '1.0.0' });

      await fs.outputFile(path.join(cacheSkillRoot, 'SKILL.md'), 'tampered\n');
      await fs.outputJson(
        path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
        {
          ...refreshedReceipt,
          payloadDigest: await calculateCodexNativeRenderPayloadDigest(cachePluginRoot),
        },
        { spaces: 2 },
      );
      const damagedStatus = await readNativeStatus();
      expect(statusTargetSharedNative(damagedStatus.status.payload.targets[0]!))
        .toMatchObject({ state: 'usable', version: '1.0.0' });
      expect(damagedStatus.status.payload.targets[0]).toMatchObject({ state: 'ready' });
      const callsBeforeRepair = runtime.nativeCliRunner.mock.calls.length;
      const repairedTamper = await runPublic([
        'plugin', 'sync', 'team/native-config', '--target', 'codex', '--context', 'project', '--yes',
      ]);
      expect(repairedTamper, JSON.stringify(repairedTamper, null, 2))
        .toMatchObject({ exitCode: 0, payload: { ok: true } });
      expect(repairedTamper.payload.targetResults).toEqual([
        expect.objectContaining({ backend: expect.objectContaining({ targetResults: [
          expect.objectContaining({ sharedNative: { codexPluginId: canonicalPluginId!, action: 'reuse' } }),
        ] }) }),
      ]);
      const serializedTamperReceipt = JSON.stringify(repairedTamper.payload);
      expect(serializedTamperReceipt).not.toContain('"action":"replace"');
      expect(serializedTamperReceipt).not.toContain('"action":"remove"');
      const repairCalls = runtime.nativeCliRunner.mock.calls
        .slice(callsBeforeRepair)
        .map(([invocation]) => invocation.args.join(' '));
      expect(repairCalls.some((args) => args.includes('plugin remove native-config@aw'))).toBe(false);
      expect(repairCalls.some((args) => args.includes('plugin add native-config@aw'))).toBe(false);
      await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toBe('tampered\n');
      await fs.outputFile(path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH), '{invalid');
      const unreadableStatus = await readNativeStatus();
      expect(statusTargetSharedNative(unreadableStatus.status.payload.targets[0]!))
        .toMatchObject({ state: 'usable', version: '1.0.0' });
      await fs.outputJson(
        path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
        refreshedReceipt,
        { spaces: 2 },
      );
    }, 120_000);

    // Test Value Gate: failure and cancellation preserve outputs; accepted edits restore disabled Skills.
    it('recovers disabled shared native config and preserves scope ownership through interactive changes', async (test) => {
      const {
        timing, isolation, sourceIdentity, runtime, runPublic, readStore, writeMode,
        rendererMarker, legacyProjectSkillsRoot, legacyProjectSkillRoot, snapshotOutputs,
        canonicalPluginId, cachePluginRoot, marketplacePluginRoot, cacheSkillRoot,
        marketplaceSkillRoot, readNativeStatus,
      } = await createNativeConfigFixture(test, { legacySkills: false });
      const disabled = await runPublic([
        'plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"off"',
        '--context', 'project', '--apply', '--yes',
      ]);
      expect(disabled, JSON.stringify(disabled, null, 2)).toMatchObject({
        exitCode: 0,
        payload: { configWrite: 'succeeded', overallState: 'succeeded' },
      });
      await expect(fs.pathExists(cacheSkillRoot)).resolves.toBe(false);
      await expect(fs.pathExists(marketplaceSkillRoot)).resolves.toBe(false);
      await expect(fs.readJson(path.join(cachePluginRoot, '.codex-plugin', 'plugin.json')))
        .resolves.not.toHaveProperty('skills');
      await expect(fs.readJson(path.join(cachePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH)))
        .resolves.toMatchObject({ targets: [{ id: 'native-config', skillKey: 'native-config' }] });
      expect(runtime.installed).toContain(canonicalPluginId!);
      const disabledStatus = await readNativeStatus();
      expect(disabledStatus.status.payload.targets).toEqual([
        expect.objectContaining({ state: 'ready' }),
      ]);
      expect(statusTargetSharedNative(disabledStatus.status.payload.targets[0]!))
        .toMatchObject({ state: 'usable', version: '1.0.0' });

      // Reuse these real disabled outputs only as later interaction prerequisites.
      // Each command still observes Native state and the current activation files.
      const disabledFixtureRoot = path.join(isolation.layout.fixtureCwd, 'disabled-native-output-fixture');
      await fs.copy(marketplacePluginRoot, path.join(disabledFixtureRoot, 'marketplace'));
      await fs.copy(cachePluginRoot, path.join(disabledFixtureRoot, 'cache'));

      const marketplaceReceiptBeforeFailure = await fs.readFile(
        path.join(marketplacePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
      );
      const failedRender = await runPublic([
        'plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"fail"',
        '--context', 'project', '--apply', '--yes',
      ]);
      expect(failedRender).toMatchObject({
        exitCode: 1,
        payload: { configWrite: 'succeeded', overallState: 'partial' },
      });
      expect((await readStore()).values).toEqual({ mode: 'fail' });
      await expect(fs.pathExists(marketplaceSkillRoot)).resolves.toBe(false);
      await expect(fs.readFile(path.join(marketplacePluginRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH)))
        .resolves.toEqual(marketplaceReceiptBeforeFailure);

      await writeMode('off');
      await fs.outputFile(path.join(legacyProjectSkillRoot, 'SKILL.md'), 'legacy project again\n');
      await writeSkillOwnerMarker({
        skillRoot: legacyProjectSkillRoot,
        allowedRoot: legacyProjectSkillsRoot,
        identity: {
          owner: 'agent-workflows',
          sourceId: 'team',
          sourceIdentity,
          pluginId: 'team/native-config',
          plugin: 'native-config',
          artifactKey: 'native-config',
          platform: 'codex',
          scope: 'project',
        },
      });
      const projectSkillBeforeUserInstall = await fs.readFile(path.join(legacyProjectSkillRoot, 'SKILL.md'));
      const projectOwnerBeforeUserInstall = await fs.readFile(path.join(legacyProjectSkillRoot, SKILL_OWNER_MARKER));
      const userInstalled = await timing.measure('command', 'fixture install', () => installFixturePlugin(['team/native-config'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope: 'user',
      }, runtime));
      expect(userInstalled, JSON.stringify(userInstalled, null, 2))
        .toMatchObject({ overallState: 'succeeded' });
      await expect(fs.readFile(path.join(legacyProjectSkillRoot, 'SKILL.md')))
        .resolves.toEqual(projectSkillBeforeUserInstall);
      await expect(fs.readFile(path.join(legacyProjectSkillRoot, SKILL_OWNER_MARKER)))
        .resolves.toEqual(projectOwnerBeforeUserInstall);

      const reset = await runPublic([
        'plugin', 'config', 'reset', 'team/native-config', '--context', 'project', '--apply', '--yes',
      ]);
      expect(reset, JSON.stringify(reset, null, 2)).toMatchObject({
        exitCode: 0,
        payload: { configWrite: 'succeeded', overallState: 'succeeded', deleted: false },
      });
      expect(await readStore()).toMatchObject({ values: {}, platforms: { codex: { projectMode: 'platform-only' } } });
      await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toContain('mode=safe\nrequestScope=user\nconfigScope=user\n');

      const runInteractiveConfig = async (
        command: 'unset' | 'reset',
        cancelled = false,
      ) => {
        const captured = createCapturedCliIo();
        const confirm = vi.fn(async (request: { message: string; defaultValue?: boolean }) => {
          expect(request).toMatchObject({
            message: '删除 team/native-config 的用户 common 覆盖？', defaultValue: false,
          });
          return cancelled
            ? { action: 'cancel' as const, cancelled: true }
            : { action: 'select' as const, cancelled: false, value: true };
        });
        const args = command === 'unset'
          ? ['plugin', 'config', 'unset', 'team/native-config', 'mode', '--context', 'project', '--apply', '--yes']
          : ['plugin', 'config', 'reset', 'team/native-config', '--context', 'project', '--apply'];
        const exitCode = await timing.measure('command', `plugin config ${command}`, () => runCli(args, {
          cwd: isolation.layout.fixtureCwd,
          env: isolation.env,
          io: captured.io,
          interactive: true,
          prompt: { confirm },
          nativeCliRunner: runtime.nativeCliRunner,
          ...createTtyRuntimeStreams(),
        }));
        expect(confirm).toHaveBeenCalledTimes(command === 'reset' ? 1 : 0);
        return { exitCode, confirm, stdout: captured.readStdout(), stderr: captured.readStderr() };
      };

      await writeMode('off');
      await fs.remove(marketplacePluginRoot);
      await fs.copy(path.join(disabledFixtureRoot, 'marketplace'), marketplacePluginRoot);
      await fs.remove(cachePluginRoot);
      await fs.copy(path.join(disabledFixtureRoot, 'cache'), cachePluginRoot);
      expect((await readStore()).values).toEqual({ mode: 'off' });
      await expect(fs.pathExists(cacheSkillRoot)).resolves.toBe(false);
      await expect(fs.pathExists(marketplaceSkillRoot)).resolves.toBe(false);
      const interactiveUnset = await runInteractiveConfig('unset');
      expect(interactiveUnset, JSON.stringify(interactiveUnset)).toMatchObject({ exitCode: 0 });
      expect((await readStore()).values).toEqual({});
      await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toContain('mode=safe\nrequestScope=user\nconfigScope=user\n');
      await expect(fs.readFile(path.join(marketplaceSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toContain('mode=safe\nrequestScope=user\nconfigScope=user\n');

      await writeMode('off');
      await fs.remove(marketplacePluginRoot);
      await fs.copy(path.join(disabledFixtureRoot, 'marketplace'), marketplacePluginRoot);
      await fs.remove(cachePluginRoot);
      await fs.copy(path.join(disabledFixtureRoot, 'cache'), cachePluginRoot);
      expect((await readStore()).values).toEqual({ mode: 'off' });
      await expect(fs.pathExists(cacheSkillRoot)).resolves.toBe(false);
      await expect(fs.pathExists(marketplaceSkillRoot)).resolves.toBe(false);
      const configStorePath = resolvePluginConfigStorePath({ sourceId: 'team', pluginName: 'native-config',
        scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env });
      const storeBeforeCancelledReset = await fs.readFile(configStorePath);
      const outputsBeforeCancelledReset = await snapshotOutputs();
      const rendererBeforeCancelledReset = await fs.readFile(rendererMarker);
      const callsBeforeCancelledReset = runtime.nativeCliRunner.mock.calls.length;
      await expect(runInteractiveConfig('reset', true)).resolves.toMatchObject({ exitCode: 0 });
      expect((await readStore()).values).toEqual({ mode: 'off' });
      await expect(fs.readFile(configStorePath)).resolves.toEqual(storeBeforeCancelledReset);
      expect(await snapshotOutputs()).toEqual(outputsBeforeCancelledReset);
      await expect(fs.readFile(rendererMarker)).resolves.toEqual(rendererBeforeCancelledReset);
      expect(runtime.nativeCliRunner).toHaveBeenCalledTimes(callsBeforeCancelledReset);
      await expect(fs.pathExists(cacheSkillRoot)).resolves.toBe(false);
      await expect(runInteractiveConfig('reset')).resolves.toMatchObject({ exitCode: 0 });
      expect(await readStore()).toMatchObject({ values: {}, platforms: { codex: { projectMode: 'platform-only' } } });
      await expect(fs.readFile(path.join(cacheSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toContain('mode=safe\nrequestScope=user\nconfigScope=user\n');
      await expect(fs.readFile(path.join(marketplaceSkillRoot, 'SKILL.md'), 'utf8'))
        .resolves.toContain('mode=safe\nrequestScope=user\nconfigScope=user\n');
    }, 120_000);
  });

  it('separates mixed native Skill and AW role renderer requests', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-native-render-source');
    const rendererMarker = path.join(isolation.layout.fixtureCwd, 'mixed-native-renderer.jsonl');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'mixed-native', 'scripts', 'render.mjs'), [
      'import { appendFile, readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      `await appendFile(${JSON.stringify(rendererMarker)}, JSON.stringify({ ids: context.requestedArtifactIds, scope: context.scope, configScope: context.config.targetScope }) + "\\n");`,
      'const artifacts = context.requestedArtifactIds.map((id) => id === "native-skill" ? ({',
      '  id, kind: "skill", platform: "codex", target: "codex.skill", state: "present",',
      '  skillKey: "native-skill", refreshKeys: [], content: { files: {',
      '    "SKILL.md": "native mixed", "README.md": "native mixed readme",',
      '    "agents/openai.yaml": "policy:\\n  allow_implicit_invocation: true\\n"',
      '  } }',
      '}) : ({',
      '  id, kind: "codexRole", platform: "codex", target: "codex.agentRole", state: "present",',
      '  roleKey: "helper", refreshKeys: [], content: {',
      '    registration: { description: "Helper role." },',
      '    roleFile: { name: "helper", description: "Helper role.", developer_instructions: "Help." }',
      '  }',
      '}));',
      'console.log(JSON.stringify({ version: 2, artifacts }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'mixed-native', [], 'mixed\n', (manifest) => {
      manifest.platforms = ['codex'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: [
          {
            id: 'native-skill',
            platform: 'codex',
            scopes: ['user', 'project'],
            target: 'codex.skill',
            states: ['present'],
            refreshKeys: [],
            skillKey: 'native-skill',
          },
          {
            id: 'aw-role',
            platform: 'codex',
            scopes: ['project'],
            target: 'codex.agentRole',
            states: ['present'],
            refreshKeys: [],
            roleKey: 'helper',
            requiresCodexProjectConfig: true,
          },
        ],
      };
    });
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation);
    const installed = await installFixturePlugin(['team/mixed-native'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, runtime);
    expect(installed, JSON.stringify(installed, null, 2)).toMatchObject({ overallState: 'succeeded' });

    const events = (await fs.readFile(rendererMarker, 'utf8')).trim().split('\n')
      .map((line) => JSON.parse(line) as { ids: string[]; scope: string; configScope: string });
    expect(events).toContainEqual({ ids: ['aw-role'], scope: 'project', configScope: 'project' });
    expect(events).toContainEqual({ ids: ['native-skill'], scope: 'user', configScope: 'user' });
    expect(events.every((event) => event.ids.length === 1)).toBe(true);
    await expect(fs.readFile(path.join(
      isolation.layout.fixtureCwd,
      '.codex',
      'agents',
      'aw-mixed-native-helper.toml',
    ), 'utf8')).resolves.toContain('developer_instructions = "Help."');
    await expect(fs.readFile(path.join(
      isolation.env.CODEX_HOME!,
      'plugins',
      'cache',
      'aw',
      'mixed-native',
      '1.0.0',
      'codex',
      'skills',
      'native-skill',
      'SKILL.md',
    ), 'utf8')).resolves.toBe('native mixed');

  });

  it('runs the publicly installed Guide cmdp entry through AW into a fake v5 managed adapter', async () => {
    // Test Value Gate: one real public installation closes generated Skill/permission IDs, AW wrapping, and a live fake v5 backend.
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const { isolation, runtime, runPublic } = await prepareCodexEnhancePublicCommandFixture();
    const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const runtimeSourceRoot = path.join(isolation.layout.fixtureCwd, 'guide-runtime-source');
    await fs.copy(path.join(repositoryRoot, 'plugins/agent-subagent'), runtimeSourceRoot);
    await preparePluginNativeTools(runtimeSourceRoot, (await readPluginManifest(runtimeSourceRoot)).manifest);
    const helpers = await import(pathToFileURL(path.join(runtimeSourceRoot, 'scripts/fixtures/subagent-integration.mjs')).href);
    const { openRun, storeContext } = await import(pathToFileURL(path.join(
      runtimeSourceRoot, 'skills/spawn-subagent/scripts/runtime/store.mjs',
    )).href);
    const cleanups: Array<() => Promise<void>> = [() => fs.remove(runtimeSourceRoot)];
    const fixture = await helpers.fixture({ signal: new AbortController().signal, diagnostic: () => {}, after: (cleanup: () => Promise<void>) => { cleanups.push(cleanup); } });
    const cliEntry = path.join(repositoryRoot, 'packages/cli/dist/index.js');
    const scenario = path.join(fixture.directory, 'public-managed-scenario');
    await fs.ensureDir(scenario);
    await fs.writeJson(path.join(scenario, 'scenario.json'), { echo: true, finalText: 'Public Guide final result.', adapterLifetimeMs: 60000, backendLifetimeMs: 60000 });
    const environment = {
      ...isolation.env,
      HOME: fixture.homeRoot,
      USERPROFILE: fixture.homeRoot,
      TMPDIR: fixture.temporaryRoot,
      TMP: fixture.temporaryRoot,
      TEMP: fixture.temporaryRoot,
      FIXTURE_SCENARIO_FILE: path.join(scenario, 'scenario.json'),
      FIXTURE_RUN_DIRECTORY: scenario,
      FIXTURE_GENERATIONS: fixture.generations,
    };
    const invokeGuide = (id: string, args: string[]) => new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [cliEntry, 'command', 'run', id, '--', ...args], { cwd: fixture.workspace, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      const stdout: Buffer[] = [], stderr: Buffer[] = [];
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Public managed Guide command timed out.')); }, 30000);
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (exitCode) => { clearTimeout(timer); resolve({ exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }); });
    });
    let guideId: string | undefined, run: string | undefined;
    try {
      const adapterSource = path.join(isolation.layout.fixtureCwd, 'public-adapter');
      await fs.ensureDir(adapterSource);
      await fs.copyFile(path.join(fixture.directory, 'fake-adapter.mjs'), path.join(adapterSource, 'adapter.mjs'));
      const adapter = await runPublic(['command', 'install', adapterSource, '--name', 'public-v5-adapter', '--runner', 'node', '--entry', 'adapter.mjs', '--args-json', '["fixed-argv"]', '--yes']);
      expect(adapter.exitCode).toBe(0);
      const adapterId = (adapter.payload.commands as Array<{ id: string }>)[0]!.id;
      expect(await runPublic(['plugin', 'config', 'set', 'team/agent-subagent', 'subagentCommands', '--context', 'user', '--value-json', JSON.stringify([{ key: 'fixture', adapter: 'custom-managed', mode: 'workspace', commandId: adapterId, args: ['v5-request-only'] }])])).toMatchObject({ exitCode: 0 });
      const preview = await installWriteCommand(['team/agent-subagent'], { cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project' }, { ...runtime, previewOperationPlan: true });
      const review = buildOperationReviewProjection({ intent: { kind: 'pluginWrite', action: 'install', pluginId: 'team/agent-subagent', platform: 'codex', scope: 'project' }, evidence: { catalog: { configDigest: 'fixture', compositeDigest: 'fixture' }, operationPlan: preview.operationPlan } });
      expect(review.changes).toContainEqual(expect.objectContaining({ title: 'guide/subagent/default', description: expect.stringContaining('node · scripts/subagent.mjs') }));
      const installed = await runPublic(['plugin', 'install', 'team/agent-subagent', '--scope', 'project', '--yes']);
      expect(installed, JSON.stringify(installed)).toMatchObject({ exitCode: 0, payload: { ok: true } });
      const guideCommand = (await listManagedCommands(isolation.env)).commands.find((command) => command.name === 'guide/subagent/default')!;
      expect(guideCommand.owner).toMatchObject({ kind: 'plugin', producer: {
        pluginName: 'agent-subagent', kind: 'artifact', key: 'spawn-subagent-skill',
      } });
      guideId = guideCommand.id;
      expect(guideId).toMatch(/^cmdp_[0-9a-f]{16}$/u);
      expect(review.changes).toContainEqual(expect.objectContaining({ title: expect.stringMatching(/^Codex 权限规则/u), description: expect.stringContaining(guideId) }));
      const permission = await fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex/rules/aw-agent-subagent-subagent-commands.rules'), 'utf8');
      expect(permission).toContain(JSON.stringify(['aw', 'command', 'run', guideId, '--', 'start']));
      await fs.writeFile(path.join(fixture.workspace, 'prompt.txt'), 'Public installation task.\n');
      const started = await invokeGuide(guideId, ['start', '--executor', 'fixture', '--workspace', fixture.workspace, '--prompt-file', 'prompt.txt']);
      run = helpers.field(started.stdout, 'run');
      expect(started, JSON.stringify(started)).toMatchObject({ exitCode: 0, stderr: '' });
      expect(started.stdout).toMatch(/^started \S+ communication=true resume=false\n$/u);
      const observed = await helpers.eventually(async () => fs.readJson(path.join(scenario, 'observed.json')), 'public installed Guide backend');
      process.kill(observed.pid, 0);
      expect(observed.argv).toEqual(['fixed-argv']);
      expect(observed.request.args).toEqual(['v5-request-only']);
      expect(observed.request.prompt).toBe('Public installation task.\n');
      expect(observed.request.resume).toBe(true);
      const sent = await invokeGuide(guideId, ['send', '--run', run!, '--text', 'Continue.']);
      expect(sent).toMatchObject({ exitCode: 0, stdout: `queued ${run}\n` });
      await helpers.eventually(async () => (await fs.readFile(path.join(scenario, 'inputs.jsonl'), 'utf8')).includes('Continue.'), 'public wrapped worker still alive after start');
      await fs.writeFile(path.join(scenario, 'finish'), '');
      const deadline = Date.now() + 10000;
      let final: Awaited<ReturnType<typeof invokeGuide>>;
      do {
        final = await invokeGuide(guideId, ['wait', '--run', run!, '--timeout-ms', String(Math.max(0, deadline - Date.now()))]);
        expect(final).toMatchObject({ exitCode: 0 });
      } while (!helpers.terminalPattern.test(final.stdout) && Date.now() < deadline);
      expect(final.stdout).toContain('Public Guide final result.');
    } finally {
      try {
        if (guideId && run) {
          const stopped = await invokeGuide(guideId, ['stop', '--run', run]);
          expect(stopped, JSON.stringify(stopped)).toMatchObject({ exitCode: 0 });
          // invokeGuide creates this run outside the fixture's tracked commands.
          const { meta } = await openRun(await storeContext({ homeRoot: fixture.homeRoot }), run);
          // A saved final result does not mean the worker has released its cwd.
          // Windows cannot remove that directory until the worker exits.
          await helpers.eventually(() => {
            try {
              process.kill(meta.worker.pid, 0);
              return false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
              return true;
            }
          }, 'public managed Guide worker exit');
        }
      } finally {
        for (const cleanup of cleanups.reverse()) await cleanup();
      }
    }
  }, 90000);

  it('cleans codex-enhance project roles when its shared command binding is missing', async (test) => {
    // Missing weak command state must not block cleanup of exact scoped output.
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const timing = createCommandTestTiming(test);
    const { isolation, subagentCacheRoot, runPublic } = await timing.measure(
      'fixture', 'codex-enhance', () => prepareCodexEnhancePublicCommandFixture(timing),
    );
    expect(await runPublic([
      'plugin', 'install', 'team/codex-enhance', '--scope', 'project', '--yes'])).toMatchObject({ exitCode: 0, payload: { ok: true } });
    // Two plugins each render one shared Skill batch and one project role batch.
    // Lock rechecks and manager resolution must reuse these successful inputs.
    expect(timing.rendererCalls).toBe(4);
    const guideCommand = (await listManagedCommands(isolation.env)).commands
      .find((command) => command.name === 'guide/subagent/default')!;
    await fs.remove(path.join(isolation.env.AW_HOME!, 'commands', 'bindings', `${guideCommand.id}.json`));
    const intentPath = path.join(isolation.layout.fixtureCwd, '.agent-workflows', 'plugin-intents.json');
    const intentBefore = await fs.readFile(intentPath);

    expect(await runPublic([
      'plugin', 'cleanup', 'team/codex-enhance', '--target', 'codex', '--scope', 'project', '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { ok: true } });
    expect(timing.rendererCalls).toBe(4);
    for (const role of ['codex-explore', 'codex-advisor']) {
      await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, '.codex', 'agents',
        `aw-codex-enhance-${role}.toml`))).resolves.toBe(false);
    }
    expect((await readCodexConfigFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml')))
      .snapshot.plugins['codex-enhance@aw']?.enabled).not.toBe(true);
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentBefore);
    await expect(fs.pathExists(path.join(subagentCacheRoot, 'codex', 'skills', 'spawn-subagent', 'SKILL.md')))
      .resolves.toBe(true);
  }, 30_000);

  it('rematerializes codex-enhance shared Skills without changing project roles through public commands', async (test) => {
    // Test Value Gate: real config writes rematerialize only affected shared Skills and bindings, while project roles keep their bytes and scope.
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const timing = createCommandTestTiming(test);
    const { isolation, sourceIdentity, logicalIdentity, cacheRoot, subagentCacheRoot, runPublic } =
      await timing.measure('fixture', 'codex-enhance', () => prepareCodexEnhancePublicCommandFixture(timing));
    const roleKeys = ['codex-explore', 'codex-advisor'];
    const assertRoleInstructions = (roleKey: string, delivered: string | undefined, shared: string) => {
      if (typeof delivered !== 'string') throw new Error('Expected native role developer instructions.');
      if (roleKey === 'subagent') {
        expect(delivered).toBe(shared);
        return;
      }
      const prefix = `${shared.trimEnd()}\n\n`;
      expect(delivered.startsWith(prefix)).toBe(true);
      const local = delivered.slice(prefix.length);
      // Check the native developer-channel scope; this does not prove model compliance.
      expect(local.split(roleKey)).toHaveLength(2);
      const task = roleKey === 'codex-advisor' ? '咨询' : '调查';
      expect(local).toContain(`不要通过 ${roleKey} 将同一${task}重新委派`);
      expect(local).toContain(`只限制重复父级${task}编排`);
      expect(local).toContain('不禁止为不同有界子目标采用本次任务允许的协作方法');
      for (const other of ['codex-advisor', 'codex-explore'].filter((key) => key !== roleKey)) {
        expect(local).not.toContain(other);
      }
    };
    expect(await runPublic([
      'plugin', 'config', 'set', 'team/codex-enhance', 'standardProfile', '--context', 'project',
      '--value-json', '{"model":"project-standard","reasoningEffort":"max"}',
    ])).toMatchObject({ exitCode: 0 });
    expect(await runPublic([
      'plugin', 'config', 'set', 'team/codex-enhance', 'standardProfile', '--context', 'user',
      '--value-json', '{"model":"user-standard","reasoningEffort":"max"}',
    ])).toMatchObject({
      exitCode: 0,
      payload: { apply: { state: 'skipped', reason: 'notRequested', targetResults: [] } },
    });
    const projectInstall = await runPublic([
      'plugin', 'install', 'team/codex-enhance', '--scope', 'project', '--yes']);
    expect(projectInstall, JSON.stringify(projectInstall, null, 2))
      .toMatchObject({ exitCode: 0, payload: { ok: true } });
    const skillKeys = ['codex-explore', 'codex-advisor'];
    const skillPaths = skillKeys.map((skill) =>
      path.join(cacheRoot, 'codex', 'skills', skill, 'SKILL.md'));
    for (const skillPath of skillPaths) await expect(fs.pathExists(skillPath)).resolves.toBe(true);
    for (const skill of skillKeys) {
      await expect(fs.pathExists(path.join(isolation.env.CODEX_HOME!, 'skills', skill)))
        .resolves.toBe(false);
    }
    const initialSkillBytes = await Promise.all(skillPaths.map((skillPath) => fs.readFile(skillPath)));
    const guideBindingPath = path.join(
      subagentCacheRoot, 'codex', 'skills', 'spawn-subagent', AW_RUNTIME_CONFIG_BINDING_PATH,
    );
    const initialBinding = await fs.readJson(guideBindingPath) as RuntimeConfigBinding;
    expect(initialBinding).toMatchObject({
      schemaVersion: 2,
      installedIdentity: { pluginName: 'agent-subagent', skillKey: 'spawn-subagent', scope: 'user', configScope: 'user' },
      allowedKeys: ['subagentCommands', 'subagentRetentionHours'],
    });
    expect(initialBinding.effectiveValues).toEqual({ subagentCommands: [], subagentRetentionHours: 24 });
    for (const skill of ['codex-explore', 'codex-advisor']) {
      await expect(fs.pathExists(path.join(cacheRoot, 'codex', 'skills', skill, AW_RUNTIME_CONFIG_BINDING_PATH)))
        .resolves.toBe(false);
    }
    const initialReceipt = await fs.readJson(
      path.join(cacheRoot, CODEX_NATIVE_RENDER_RECEIPT_PATH),
    ) as CodexNativeRenderReceipt;
    expect(initialReceipt.targets.map((target) => target.skillKey)).toEqual([
      'codex-advisor', 'codex-explore',
    ]);
    const userStore = await readPluginConfigStore({
      sourceId: 'team', sourceIdentity, logicalIdentity,
      pluginName: 'codex-enhance', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    expect(userStore.values.standardProfile).toEqual({
      model: 'user-standard', reasoningEffort: 'max',
    });
    const rolePaths = roleKeys.map((role) => path.join(
      isolation.layout.fixtureCwd, '.codex', 'agents', `aw-codex-enhance-${role}.toml`,
    ));
    const initialRoleBytes = await Promise.all(rolePaths.map((file) => fs.readFile(file, 'utf8')));
    const instructionFiles = ['explore-instructions.md', 'advisor-instructions.md'];
    for (const [index, content] of initialRoleBytes.entries()) {
      const role = parseCodexRoleFile(content);
      expect(role.model).toBeUndefined();
      expect(role.modelReasoningEffort).toBeUndefined();
      const sharedInstructions = await fs.readFile(path.join(
        cacheRoot, 'codex', 'skills', skillKeys[index]!, 'assets', instructionFiles[index]!,
      ), 'utf8');
      assertRoleInstructions(roleKeys[index]!, role.developerInstructions, sharedInstructions);
    }
    const subagentRolePath = path.join(isolation.layout.fixtureCwd, '.codex', 'agents', 'aw-agent-subagent-subagent.toml');
    const initialSubagentRoleBytes = await fs.readFile(subagentRolePath, 'utf8');
    const installedSubagentRole = parseCodexRoleFile(initialSubagentRoleBytes);
    expect(installedSubagentRole.model).toBeUndefined();
    expect(installedSubagentRole.modelReasoningEffort).toBeUndefined();
    assertRoleInstructions('subagent', installedSubagentRole.developerInstructions,
      await fs.readFile(path.join(subagentCacheRoot, 'codex/skills/spawn-subagent/assets/task-instructions.md'), 'utf8'));
    expect(initialSkillBytes[0].toString('utf8')).toContain('"user-standard"');
    expect(initialSkillBytes[1].toString('utf8')).not.toContain('"user-standard"');
    expect(await runPublic([
      'plugin', 'config', 'set', 'team/codex-enhance', 'standardProfile', '--context', 'user',
      '--value-json', '{"model":"saved-standard","reasoningEffort":"medium"}',
    ])).toMatchObject({
      exitCode: 0,
      payload: { apply: { state: 'skipped', reason: 'notRequested' } },
    });
    await expect(fs.readJson(guideBindingPath)).resolves.toEqual(initialBinding);
    for (const [index, file] of skillPaths.entries()) {
      await expect(fs.readFile(file)).resolves.toEqual(initialSkillBytes[index]);
    }
    const rematerialized = await runPublic([
      'plugin', 'config', 'set', 'team/codex-enhance', 'standardProfile', '--context', 'project',
      '--value-json', '{"model":"updated-standard","reasoningEffort":"high"}',
      '--apply', '--yes',
    ]);
    expect(rematerialized, JSON.stringify(rematerialized)).toMatchObject({ exitCode: 0 });
    await expect(fs.readFile(skillPaths[0], 'utf8')).resolves.toContain('"updated-standard"');
    await expect(fs.readFile(skillPaths[0]!)).resolves.not.toEqual(initialSkillBytes[0]);
    for (const index of [1]) {
      await expect(fs.readFile(skillPaths[index]!)).resolves.toEqual(initialSkillBytes[index]);
    }
    const updatedBinding = await fs.readJson(guideBindingPath) as RuntimeConfigBinding;
    expect(updatedBinding).toEqual(initialBinding);
    for (const [index, file] of rolePaths.entries()) {
      await expect(fs.readFile(file, 'utf8')).resolves.toBe(initialRoleBytes[index]);
    }
    await expect(fs.readFile(subagentRolePath, 'utf8')).resolves.toBe(initialSubagentRoleBytes);
    const projectOnlyConfig = await readCodexConfigFile(path.join(
      isolation.layout.fixtureCwd, '.codex', 'config.toml',
    ));
    const projectOnlyUserConfig = await readCodexConfigFile(path.join(
      isolation.env.CODEX_HOME!, 'config.toml',
    ));
    expect(projectOnlyConfig.snapshot.plugins['codex-enhance@aw']?.enabled).toBe(true);
    expect(projectOnlyUserConfig.snapshot.plugins['codex-enhance@aw']?.enabled).not.toBe(true);
    const guideCommand = (await listManagedCommands(isolation.env)).commands.find((command) => command.name === 'guide/subagent/default')!;
    await fs.remove(path.join(isolation.env.AW_HOME!, 'commands', 'bindings', `${guideCommand.id}.json`));
    expect(await runPublic([
      'plugin', 'cleanup', 'team/codex-enhance', '--target', 'codex', '--scope', 'project', '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { ok: true } });
    for (const file of rolePaths) await expect(fs.pathExists(file)).resolves.toBe(false);
    await expect(fs.pathExists(subagentRolePath)).resolves.toBe(true);
    expect(await runPublic([
      'plugin', 'cleanup', 'team/agent-subagent', '--target', 'codex', '--scope', 'project', '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { ok: true } });
    await expect(fs.pathExists(subagentRolePath)).resolves.toBe(false);
    expect((await readCodexConfigFile(path.join(
      isolation.layout.fixtureCwd, '.codex', 'config.toml',
    ))).snapshot.plugins['codex-enhance@aw']?.enabled).not.toBe(true);
  }, 120_000);

  it('restores codex-enhance project providers after removing the user root through public commands', async (test) => {
    // Test Value Gate: both declarations keep their scope while the joint plan switches exact owned providers.
    const machine = getCurrentSourceTestIsolation();
    await writePreferences({ scope: 'user', cwd: machine.layout.fixtureCwd, env: machine.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const timing = createCommandTestTiming(test);
    const { isolation, cacheRoot, runtime, runPublic } = await timing.measure(
      'fixture', 'codex-enhance', () => prepareCodexEnhancePublicCommandFixture(timing),
    );
    const cwd = isolation.layout.fixtureCwd;
    const env = isolation.env;
    const roleNames = ['codex-explore', 'codex-advisor'];
    const projectRoles = roleNames.map((role) => path.join(cwd, '.codex', 'agents', `aw-codex-enhance-${role}.toml`));
    const userRoles = roleNames.map((role) => path.join(env.CODEX_HOME!, 'agents', `aw-codex-enhance-${role}.toml`));
    const projectInstall = await runPublic(['plugin', 'install', 'team/codex-enhance', '--scope', 'project', '--yes']);
    expect(projectInstall, JSON.stringify(projectInstall)).toMatchObject({ exitCode: 0, payload: { ok: true } });
    for (const file of projectRoles) await expect(fs.pathExists(file)).resolves.toBe(true);
    const projectLocation = { scope: 'project' as const, cwd, env };
    const userLocation = { scope: 'user' as const, cwd, env };
    const projectIntentBefore = await observeIntent(projectLocation);
    const preferencesPath = await resolvePreferencesPath(userLocation);
    const preferencesBefore = await fs.readFile(preferencesPath);
    const foreignRole = path.join(cwd, '.codex', 'agents', 'foreign.toml');
    await fs.outputFile(foreignRole, 'developer_instructions = "foreign bytes"\n');
    const userInstall = await runPublic(['plugin', 'install', 'team/codex-enhance', '--scope', 'user', '--yes']);
    expect(userInstall, JSON.stringify(userInstall)).toMatchObject({ exitCode: 0, payload: { ok: true } });
    for (const file of userRoles) await expect(fs.pathExists(file)).resolves.toBe(true);
    for (const file of projectRoles) await expect(fs.pathExists(file)).resolves.toBe(false);
    await expect(observeIntent(projectLocation)).resolves.toEqual(projectIntentBefore);
    const inherited = await readRecoveryStatus({ cwd, env, cliVersion: '1.0.0', targets: ['codex'], nativeCliRunner: runtime.nativeCliRunner });
    expect(inherited.inventory?.filter((entry) => entry.pluginId === 'team/codex-enhance')
      .flatMap((entry) => entry.targetResults), JSON.stringify(inherited)).toContainEqual(expect.objectContaining({
        scope: 'project', providerScope: 'user', content: 'satisfied', satisfaction: 'inherited-user',
      }));
    const userBeforeSync = await observeIntent(userLocation);
    const userRoleBytes = await Promise.all(userRoles.map((file) => fs.readFile(file)));
    const synced = await runPublic(['plugin', 'sync', 'team/codex-enhance', '--context', 'project', '--yes']);
    expect(synced, JSON.stringify(synced)).toMatchObject({ exitCode: 0, payload: { ok: true } });
    await expect(observeIntent(userLocation)).resolves.toEqual(userBeforeSync);
    await expect(observeIntent(projectLocation)).resolves.toEqual(projectIntentBefore);
    for (const [index, file] of userRoles.entries()) await expect(fs.readFile(file)).resolves.toEqual(userRoleBytes[index]);
    const guideCommand = (await listManagedCommands(env)).commands.find((command) => command.name === 'guide/subagent/default')!;
    await fs.writeFile(path.join(env.AW_HOME!, 'commands', 'bindings', `${guideCommand.id}.json`), '{broken');
    const removed = await runPublic(['plugin', 'remove', 'team/codex-enhance', '--scope', 'user', '--yes']);
    expect(removed, JSON.stringify(removed)).toMatchObject({ exitCode: 0, payload: {
      ok: true, declarationChanged: true,
    } });
    await expect(observeIntent(projectLocation)).resolves.toEqual(projectIntentBefore);
    await expect(readFixtureRequirements(userLocation)).resolves.toMatchObject({ roots: [] });
    for (const file of projectRoles) await expect(fs.pathExists(file)).resolves.toBe(true);
    for (const file of userRoles) await expect(fs.pathExists(file)).resolves.toBe(false);
    expect((await readCodexConfigFile(path.join(cwd, '.codex', 'config.toml')))
      .snapshot.plugins['codex-enhance@aw']?.enabled).toBe(true);
    await expect(fs.pathExists(path.join(cacheRoot, 'codex', 'skills', 'codex-explore', 'SKILL.md'))).resolves.toBe(true);
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('developer_instructions = "foreign bytes"\n');
    await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
    for (const pluginId of ['team/codex-enhance', 'team/agent-subagent']) {
      const cleaned = await runPublic(['plugin', 'cleanup', pluginId, '--target', 'codex', '--scope', 'project', '--yes']);
      expect(cleaned, JSON.stringify(cleaned)).toMatchObject({ exitCode: 0, payload: { ok: true } });
    }
    for (const file of projectRoles) await expect(fs.pathExists(file)).resolves.toBe(false);
    await expect(fs.readFile(foreignRole, 'utf8')).resolves.toBe('developer_instructions = "foreign bytes"\n');
    await expect(observeIntent(projectLocation)).resolves.toEqual(projectIntentBefore);
  }, 120_000);

});
