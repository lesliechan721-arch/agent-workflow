import { readIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { realpath } from 'node:fs/promises';
import { render } from 'ink-testing-library';
import { writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent, resolveIntentPath } from '../../src/intent/intent-store.js';
import {
  statusCommandV8,
  statusTargetActivation,
  statusTargetIntent,
  statusTargetSharedNative,
} from '../../src/commands/status-v6.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { runCli } from '../../src/index.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { PassThrough } from 'node:stream';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig as replaceCatalogSourcesConfigWithoutActive,
} from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  readPluginConfigStore,
  resolvePluginConfigStorePath,
  setAtomicConfigBeforeRenameHookForTests,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { createCapturedCliIo, createTtyRuntimeStreams } from '../helpers/cli-entry.js';
import { setNativeCliRunnerOverrideForTests, type NativeCliInvocation } from '../../src/utils/native-cli.js';
import type { PluginMeta } from '../../src/types.js';
import { SKILL_OWNER_MARKER, writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { calculateCodexNativeRenderPayloadDigest } from '../../src/utils/catalog-digests.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import { CODEX_NATIVE_RENDER_RECEIPT_PATH, type CodexNativeRenderReceipt } from '../../src/utils/codex-native-render-receipt.js';

import {
  syncWriteCommand,
  reinstallWriteCommand,
  installFixturePlugin,
  readFixtureRequirements,
  addProjectFixtureRoots,
  replaceCatalogSourcesConfig,
  readCatalogLogicalIdentity,
  snapshotRegularTree,
  createCodexNativeTestRuntime,
  writeStatusSystemCodexPackage,
  createNativeDependencyCatalog,
  writeDynamicRoleRenderer,
} from '../helpers/write-command-fixture.js';

describe('five namespaced write commands', () => {
  beforeEach(async () => {
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

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
});
