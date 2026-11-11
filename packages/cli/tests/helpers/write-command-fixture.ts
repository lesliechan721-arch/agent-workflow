import { readIntentFixture } from './plugin-intent-fixture.js';
import { expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  cleanupWriteCommand as nativeCleanupWriteCommand,
  installWriteCommand as nativeInstallWriteCommand,
  reinstallWriteCommand as nativeReinstallWriteCommand,
  syncWriteCommand as nativeSyncWriteCommand,
  uninstallWriteCommand as nativeUninstallWriteCommand,
} from '../../src/commands/write-commands.js';
import { readDemand, demandNativeProjection } from '../../src/recovery/demand.js';
import { createScopeContext } from '../../src/intent/scope-context.js';
import { observePreferences, writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { addRoot, observeIntent } from '../../src/intent/intent-store.js';
import { normalizeInstallCommandOptions } from '../../src/commands/options.js';
import { type RebuildCommandRuntime } from '../../src/commands/rebuild-command.js';
import { runCli } from '../../src/index.js';
import { getCurrentSourceTestIsolation, getSourceTestRepositoryCwd } from '../setup/test-isolation.js';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'fs-extra';
import { fileURLToPath } from 'node:url';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture } from './catalog-source-fixture.js';
import { createSyntheticEmbeddedRoot } from './embedded-root.js';
import { stubCodexFileSelectionForNativeFixture } from './codex-enhance-native-fixture.js';
import { createCommandTestTiming } from './command-timing.js';
import type { CommandEvent } from '../../src/output/model.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig as replaceCatalogSourcesConfigWithoutActive,
} from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { createCapturedCliIo } from './cli-entry.js';
import { type NativeCliInvocation } from '../../src/utils/native-cli.js';
import type { PluginMeta } from '../../src/types.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { createEmptyNativeDemandView } from '../../src/utils/native-demand.js';
import {
  applyCodexConfigTransactionFile,
  readCodexConfigFile,
  removeCodexMarketplace,
} from '../../src/utils/codex-config.js';


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

export function installWriteCommand(names: string[], raw: Parameters<typeof nativeInstallWriteCommand>[1],
  runtime: RebuildCommandRuntime = {}) {
  return withNativeExecution(names, raw, runtime, (prepared) => nativeInstallWriteCommand(names, raw, prepared));
}
export function syncWriteCommand(names: string[], raw: Parameters<typeof nativeSyncWriteCommand>[1],
  runtime: RebuildCommandRuntime = {}) {
  return withNativeExecution(names, raw, runtime, (prepared) => nativeSyncWriteCommand(names, raw, prepared));
}
export function reinstallWriteCommand(names: string[], raw: Parameters<typeof nativeReinstallWriteCommand>[1],
  runtime: RebuildCommandRuntime = {}) {
  return withNativeExecution(names, raw, runtime, (prepared) => nativeReinstallWriteCommand(names, raw, prepared));
}
export function uninstallWriteCommand(names: string[], raw: Parameters<typeof nativeUninstallWriteCommand>[1],
  runtime: RebuildCommandRuntime = {}) {
  return withNativeExecution(names, raw, runtime, (prepared) => nativeUninstallWriteCommand(names, raw, prepared));
}
export function cleanupWriteCommand(names: string[], raw: Parameters<typeof nativeCleanupWriteCommand>[1],
  runtime: RebuildCommandRuntime = {}) {
  return withNativeExecution(names, raw, runtime,
    (prepared) => nativeCleanupWriteCommand(names, raw, prepared), true);
}

export async function installFixturePlugin(names: string[], raw: Parameters<typeof installWriteCommand>[1],
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

export async function syncFixturePlugin(names: string[], options: Parameters<typeof syncWriteCommand>[1],
  runtime: RebuildCommandRuntime = {}) {
  const location = { scope: options.scope as 'project' | 'user', cwd: options.cwd!, env: runtime.env };
  const requirements = await readIntentFixture(location);
  const roots = requirements.roots.filter((root) => names.length
    ? names.some((name) => name === root.pluginId || root.pluginId.endsWith(`/${name}`))
    : (options as { all?: boolean }).all);
  return syncWriteCommand(roots.map((root) => root.pluginId), options, runtime);
}

export const readFixtureRequirements = readIntentFixture;

export async function addProjectFixtureRoots(options: {
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

export async function replaceCatalogSourcesConfig(
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

export async function readCatalogLogicalIdentity(rootDir: string): Promise<string> {
  const marker = await fs.readJson(path.join(rootDir, '.aw-generated.json')) as {
    workspaceIdentity: string;
  };
  return marker.workspaceIdentity;
}

export async function configureCatalog(): Promise<ReturnType<typeof getCurrentSourceTestIsolation>> {
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

export async function snapshotRegularTree(root: string): Promise<Record<string, string>> {
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

export async function createCodexNativeTestRuntime(
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
  const packageRoots = new Map<string, string>();
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
      packageRoots.set(pluginId, marketplacePluginRoot);
      const pluginVersion = String((await fs.readJson(path.join(
        marketplacePluginRoot,
        '.codex-plugin',
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
      packageRoots.delete(pluginId);
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
    marketplaceRoots,
    packageRoots,
  };
}

export async function prepareCodexEnhancePublicCommandFixture(timing?: ReturnType<typeof createCommandTestTiming>) {
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

export async function writeStatusSystemCodexPackage(
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

export async function writeIntentRoundTripCodexPackage(root: string): Promise<string> {
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
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const args = process.argv.slice(2);',
      'if (args.includes("--version")) { console.log("codex-cli 0.200.0"); process.exit(0); }',
      `const { parseTOML, getStaticTOMLValue } = require(${JSON.stringify(createRequire(import.meta.url).resolve('toml-eslint-parser'))});`,
      'const parse = (text) => getStaticTOMLValue(parseTOML(text));',
      'const scalar = (value) => Array.isArray(value) ? `[${value.map(scalar).join(", ")}]`',
      '  : value && typeof value === "object" ? `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${scalar(item)}`).join(", ")} }` : JSON.stringify(value);',
      'const stringify = (value) => { const lines = []; const table = (object, keys = []) => {',
      '  if (keys.length) lines.push(`[${keys.map((key) => JSON.stringify(key)).join(".")}]`);',
      '  const entries = Object.entries(object); const nested = (item) => item && typeof item === "object" && !Array.isArray(item);',
      '  for (const [key, item] of entries) if (!nested(item)) lines.push(`${JSON.stringify(key)} = ${scalar(item)}`);',
      '  for (const [key, item] of entries) if (nested(item)) table(item, [...keys, key]);',
      '}; table(value); return lines.join("\\n") + "\\n"; };',
      'const home = process.env.CODEX_HOME;',
      'if (!home) throw new Error("The controlled Codex fixture requires CODEX_HOME.");',
      'fs.mkdirSync(home, { recursive: true });',
      'const statePath = path.join(home, "controlled-native-state.json");',
      'const configPath = path.join(home, "config.toml");',
      'const read = (file, fallback) => fs.existsSync(file) ? fs.readFileSync(file, "utf8") : fallback;',
      'const state = JSON.parse(read(statePath, JSON.stringify({ marketplaces: {}, installed: {} })));',
      'const config = parse(read(configPath, ""));',
      'for (const [name, value] of Object.entries(config.marketplaces ?? {})) {',
      '  if (value.source_type === "local" && typeof value.source === "string") state.marketplaces[name] ??= value.source;',
      '}',
      'if (args[0] !== "plugin") throw new Error("Unexpected controlled Codex invocation.");',
      'if (args[1] === "marketplace" && args[2] === "add") {',
      '  const root = args[3]; const name = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")).marketplaceName;',
      '  state.marketplaces[name] = root; (config.marketplaces ??= {})[name] = { source: root, source_type: "local" };',
      '} else if (args[1] === "marketplace" && args[2] === "remove") {',
      '  delete state.marketplaces[args[3]]; if (config.marketplaces) delete config.marketplaces[args[3]];',
      '} else if (args[1] === "add" || args[1] === "remove") {',
      '  const id = args[2]; const at = id.lastIndexOf("@"); const name = id.slice(0, at); const marketplace = id.slice(at + 1);',
      '  const cache = path.join(home, "plugins", "cache", marketplace, name);',
      '  if (args[1] === "add") {',
      '    const root = path.join(state.marketplaces[marketplace], "plugins", name);',
      '    const version = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"), "utf8")).version;',
      '    fs.mkdirSync(cache, { recursive: true }); fs.cpSync(root, path.join(cache, version), { recursive: true, force: true });',
      '    state.installed[id] = version; (config.plugins ??= {})[id] = { enabled: true };',
      '  } else { delete state.installed[id]; if (config.plugins) delete config.plugins[id]; fs.rmSync(cache, { recursive: true, force: true }); }',
      '} else if (args[1] === "list") {',
      '  const marketplace = args[args.indexOf("--marketplace") + 1];',
      '  const project = parse(read(path.join(process.cwd(), ".codex", "config.toml"), ""));',
      '  console.log(JSON.stringify({ installed: Object.entries(state.installed).filter(([id]) => id.endsWith(`@${marketplace}`)).map(([id, version]) => ({',
      '    pluginId: id, installed: true, enabled: config.plugins?.[id]?.enabled === true || project.plugins?.[id]?.enabled === true, version,',
      '  })), available: [] })); process.exit(0);',
      '} else throw new Error("Unexpected controlled Codex plugin command.");',
      'fs.writeFileSync(configPath, stringify(config)); fs.writeFileSync(statePath, JSON.stringify(state));',
    ].join('\n')),
  ]);
  await fs.chmod(launcher, 0o755);
  await fs.ensureDir(binRoot);
  if (process.platform !== 'win32') {
    // The isolated PATH must still permit the real read-only process-tree audit.
    const processInspector = await fs.realpath('/bin/ps').catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return fs.realpath('/usr/bin/ps');
    });
    await fs.symlink(processInspector, path.join(binRoot, 'ps'));
  }
  const nodeEntry = path.join(binRoot, process.platform === 'win32' ? 'node.exe' : 'node');
  try { await fs.symlink(process.execPath, nodeEntry, 'file'); }
  catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    await fs.copyFile(process.execPath, nodeEntry);
  }
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

export async function runIntentRoundTripCliChild(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  expectedExitCode = 0,
): Promise<string> {
  const packageRoot = getSourceTestRepositoryCwd();
  const startedAt = performance.now();
  let output = '';
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
  const emit = (event: string, fields: Record<string, unknown> = {}) => {
    console.log('AW_TEST_CHILD_TIMING', JSON.stringify({
      parentPid: process.pid, childPid: child.pid,
      elapsedMs: Math.round(performance.now() - startedAt), event, ...fields,
    }));
  };
  emit('spawn-requested');
  child.once('spawn', () => emit('spawn'));
  child.once('exit', (exitCode, signal) => emit('exit', { exitCode, signal }));
  const buffers = { stdout: '', stderr: '' };
  let forwarded = 0;
  // Forward only bounded timing metadata. Receipts, paths and error bodies stay
  // in the original captured output and are not copied into timing records.
  const capture = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
    const text = String(chunk);
    output += text;
    buffers[stream] += text;
    let index: number;
    while ((index = buffers[stream].indexOf('\n')) >= 0) {
      const line = buffers[stream].slice(0, index);
      buffers[stream] = buffers[stream].slice(index + 1);
      if (forwarded >= 64 || line.length > 4096) continue;
      const marker = 'AW_TEST_TIMING ';
      const position = line.indexOf(marker);
      if (position < 0) continue;
      try {
        const data = JSON.parse(line.slice(position + marker.length).replace(/\u001b\[[0-9;]*m/gu, ''));
        if (!['fixture', 'command', 'renderer'].includes(data?.stage)
          || !['start', 'finish', 'unfinished'].includes(data?.event)
          || !Number.isSafeInteger(data?.pid) || data.pid <= 0
          || !Number.isFinite(data?.elapsedMs) || data.elapsedMs < 0) continue;
        const fields: Record<string, unknown> = {
          sourcePid: data.pid, childElapsedMs: data.elapsedMs, stage: data.stage, phase: data.event,
        };
        for (const key of ['durationMs', 'sequence']) {
          if (Number.isFinite(data[key]) && data[key] >= 0) fields[key] = data[key];
        }
        if (['succeeded', 'failed'].includes(data.outcome)) fields.outcome = data.outcome;
        emit('child-stage', fields);
        forwarded += 1;
      } catch { /* Other child output is not a timing record. */ }
    }
    buffers[stream] = buffers[stream].slice(-8192);
  };
  child.stdout.on('data', (chunk: Buffer) => capture(chunk, 'stdout'));
  child.stderr.on('data', (chunk: Buffer) => capture(chunk, 'stderr'));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', (error) => { emit('spawn-error'); reject(error); });
    child.on('close', (exitCode, signal) => { emit('close', { exitCode, signal }); resolve(exitCode); });
  });
  expect(code, `aw ${argv.join(' ')} child failed:\n${output}`).toBe(0);
  return output;
}

export function parseIntentRoundTripReceipt(output: string): {
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

export async function createNativeDependencyCatalog(
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

export async function configureCodexAliasCatalog(options: {
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
      instructions: [{ name: 'policy', title: 'Policy', content: 'Policy.', coverage: ['main'] }],
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
  return createCodexNativeTestRuntime({ env, layout: { fixtureCwd: options.cwd } });
}

export async function writeDynamicSkillRenderer(options: {
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
    'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
    'if (context.surface !== "agent-plugin") throw new Error("Expected the agent-plugin surface.");',
    'const plan = { version: 3, components: [], omitted: [], unmet: [] };',
    'if (context.allowedOutputKinds.includes("skill")) {',
    'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
    'await writeFile(counter, String(previous + 1));',
    ...(options.fail ? ['throw new Error("renderer failed");'] : []),
    'const fact = context.platformCapabilities.kinds.skill;',
    'if (fact.status !== "supported") plan.unmet.push({ id: "dynamic-skill", kind: "skill",',
    `  name: ${JSON.stringify(options.skillKey)}, requiredFeatures: [{ feature: "component.kind.skill" }], reasonCode: fact.reasonCodes[0] ?? "capability-unverified" });`,
    'else plan.components.push({ id: "dynamic-skill", kind: "skill",',
    `  name: ${JSON.stringify(options.skillKey)}, content: { files: {`,
    `    "SKILL.md": { text: ${JSON.stringify(`---\nname: ${options.skillKey}\ndescription: Dynamic skill.\n---\n`)} },`,
    '    "README.md": { text: "Dynamic skill.\\n" },',
    '    "agents/openai.yaml": { text: "policy:\\n  allow_implicit_invocation: true\\n" }',
    '  } } });',
    '}',
    'console.log(JSON.stringify(plan));',
  ].join('\n'));
}

export async function writeDynamicRoleRenderer(options: {
  pluginRoot: string;
  roleKey: string;
  fail?: boolean;
  counterRoot?: string;
}): Promise<void> {
  await fs.outputFile(path.join(options.pluginRoot, 'scripts', 'render.mjs'), [
    'import { readFile, writeFile } from "node:fs/promises";',
    `const counterRoot = ${options.counterRoot === undefined ? 'process.env.AW_HOME' : JSON.stringify(options.counterRoot)};`,
    'const counter = `${counterRoot}/render-count-${process.env.AW_PLUGIN_NAME}.txt`;',
    'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
    'if (context.surface !== "agent-plugin") throw new Error("Expected the agent-plugin surface.");',
    'const plan = { version: 3, components: [], omitted: [], unmet: [] };',
    'if (context.allowedOutputKinds.includes("agent")) {',
    'const previous = Number(await readFile(counter, "utf8").catch(() => "0"));',
    'await writeFile(counter, String(previous + 1));',
    ...(options.fail ? ['throw new Error("renderer failed");'] : []),
    'const requirements = [{ feature: "component.kind.agent" }, { feature: "agent.execution", values: ["isolated-context"] }, { feature: "agent.prompt-mode", values: ["host-default"] }];',
    'const factFor = (feature) => feature === "component.kind.agent" ? context.platformCapabilities.kinds.agent : context.platformCapabilities.features[feature];',
    'const missing = requirements.filter((required) => { const fact = factFor(required.feature); return fact?.status !== "supported" || required.values?.some((value) => !fact.values?.includes(value)); });',
    'if (missing.length) plan.unmet.push({ id: "dynamic-role", kind: "agent",',
    `  name: ${JSON.stringify(options.roleKey)}, requiredFeatures: missing, reasonCode: factFor(missing[0].feature)?.reasonCodes[0] ?? "interface-unsupported" });`,
    'else plan.components.push({ id: "dynamic-role", kind: "agent",',
    `  name: ${JSON.stringify(options.roleKey)}, content: { description: "Dynamic role.", prompt: "Use this role." } });`,
    '}',
    'console.log(JSON.stringify(plan));',
  ].join('\n'));
}
