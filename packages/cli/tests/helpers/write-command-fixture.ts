import { readIntentFixture } from './plugin-intent-fixture.js';
import { expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
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

export async function runIntentRoundTripCliChild(
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
