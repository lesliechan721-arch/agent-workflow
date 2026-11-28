import { readIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { runCli } from '../../src/index.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import {
  readCatalogSourcesConfigSnapshot,
} from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import {
  readPluginConfigStore,
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { createCapturedCliIo, createTtyRuntimeStreams } from '../helpers/cli-entry.js';
import type { PluginMeta } from '../../src/types.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
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
  createNativeDependencyCatalog,
  writeDynamicRoleRenderer,
} from '../helpers/write-command-fixture.js';

describe('five namespaced write commands', () => {
  beforeEach(async () => {
    installNativeTestDiscovery({ platforms: ['codex', 'claude'] });
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
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
      manifest.extensions = { instructions: [{ name: 'pre-apply', title: 'Pre Apply', coverage: ['main'], content: 'Native.' }] };
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
      manifest.extensions = { instructions: [{ name: 'pre-apply', title: 'Pre Apply', coverage: ['main'], content: 'Native.' }] };
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
    const { marketplaceRoots, nativeCliRunner } = await createClaudeNativeTestRuntime(isolation);

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
    expect(unauthorizedExitCode).toBe(3);
    expect(JSON.parse(unauthorizedOutput.readStdout())).toMatchObject({
      schemaVersion: 2, command: 'plugin.install', status: 'blocked',
      data: {
        changes: { requirements: 'none', outputs: 'none' },
        confirmation: { required: true, provided: false, effects: [expect.objectContaining({ code: 'runPreApply' })] },
        targetResults: [expect.objectContaining({ pluginId: 'team/demo', target: 'claude', scope: 'user', execution: 'not-run' })]
      },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]),
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

    expect(exitCode, output.readStdout()).toBe(4);
    const receipt = JSON.parse(output.readStdout());
    expect(receipt).toMatchObject({
      schemaVersion: 2, command: 'plugin.install', status: 'partial',
      data: {
        changes: { requirements: 'changed' }, targetResults: [expect.objectContaining({
          pluginId: 'team/demo', target: 'claude', scope: 'user', execution: 'failed', blockerCodes: ['preApplyFailed'],
        })]
      },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'preApplyFailed' })]),
    });
    const serializedReceipt = JSON.stringify(receipt);
    const serializedFailures = JSON.stringify({ diagnostics: receipt.diagnostics,
      targetDiagnostics: receipt.data.targetResults.flatMap((target: { diagnostics?: unknown[] }) => target.diagnostics ?? []) });
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
    expect(humanExitCode).toBe(4);
    const humanText = `${humanOutput.readStdout()}\n${humanOutput.readStderr()}`;
    expect(humanText).toContain('preApplyFailed');
    expect(humanText).not.toContain(secret);
    expect(humanText).not.toContain(escapedSecret);
    expect(marketplaceRoots.size).toBe(0);
    await expect(snapshotRegularTree(isolation.env.CLAUDE_CONFIG_DIR!))
      .resolves.toEqual(platformBefore);
    const intentsAfter = await Promise.all(intentPaths.map((intentPath) =>
      fs.readFile(intentPath).catch((error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? null : Promise.reject(error))));
    expect(intentsBefore).toEqual([null, null]);
    expect(JSON.parse(intentsAfter[0]!.toString()).roots).toEqual([{ pluginId: 'team/demo' }]);
    expect(intentsAfter[1]).toBeNull();
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
    expect(unauthorized.exitCode).toBe(3);
    expect(unauthorized.receipt).toMatchObject({
      schemaVersion: 2, command: 'plugin.install', status: 'blocked',
      data: {
        changes: { requirements: 'none', outputs: 'none' },
        targetResults: [expect.objectContaining({ pluginId: 'team/demo', execution: 'not-run' })]
      },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]),
    });
    expect(launch).not.toHaveBeenCalled();
    await expect(fs.pathExists(markerPath)).resolves.toBe(false);

    const authorized = await run(true);
    expect(authorized.exitCode).toBe(0);
    expect(authorized.receipt).toMatchObject({
      schemaVersion: 2, command: 'plugin.install', status: 'success',
      data: { targetResults: [expect.objectContaining({ pluginId: 'team/demo', execution: 'applied' })] },
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
        instructions: [{ name: 'policy', title: 'Policy', coverage: ['main'], content: 'Policy.' }],
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
    ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 2, status: 'success', } });
    const platformRoot = path.join(isolation.layout.fixtureCwd, '.codex');
    const platformBefore = await snapshotRegularTree(platformRoot);
    const failed = await runPublic([
      'config', 'set', 'team/demo', 'mode', '--context', 'project', '--platform', 'codex',
      '--value-json', '"fail"', '--apply', '--yes',
    ]);

    expect(failed, JSON.stringify(failed)).toMatchObject({
      exitCode: 4,
      payload: {
        schemaVersion: 2, status: 'partial', data: {
          configWrite: 'succeeded', effective: { values: { token: '[redacted]' } }, apply: {
            state: 'partial', targetResults: [expect.objectContaining({
              state: 'failed', errorCode: 'preApplyFailed',
            })]
          }
        },
      },
    });
    expect(await fs.readJson(inputObservedPath)).toEqual({ mode: 'fail', tokenMatches: true });
    expect(await snapshotRegularTree(platformRoot)).toEqual(platformBefore);
    const serializedReceipt = JSON.stringify(failed.payload);
    expect(serializedReceipt).not.toContain(privateToken);
    const serializedApply = JSON.stringify(failed.payload.data.apply);
    for (const privatePath of [
      isolation.layout.fixtureCwd,
      isolation.env.AW_HOME!,
    ]) {
      expect(serializedApply).not.toContain(privatePath);
    }
    expect(await runPublic([
      'config', 'set', 'team/demo', 'mode', '--context', 'project', '--platform', 'codex',
      '--value-json', '"safe"', '--apply', '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 2, status: 'success', data: { configWrite: 'succeeded', apply: { state: 'succeeded' } }, } });
  }, 30_000);

  it('requires confirmation before saving apply requests and authorizes dependency preApply after save-only writes', async (test) => {
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
      path.join(isolation.env.AW_HOME!, 'platforms', 'codex')];
    const readOutputs = () => Promise.all(outputRoots.map(async (root) => await fs.pathExists(root)
      ? snapshotRegularTree(root) : null));
    const configFile = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'root', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env
    });
    const saveMode = async (mode: string) => {
      const output = createCapturedCliIo();
      expect(await runCli(['plugin', 'config', 'set', 'team/root', 'mode', '--value-json', JSON.stringify(mode),
        '--context', 'project', '--platform', 'codex', '--json'], {
        cwd: isolation.layout.fixtureCwd, env: isolation.env, io: output.io, interactive: false, nativeCliRunner,
      })).toBe(0);
      expect(JSON.parse(output.readStdout())).toMatchObject({
        status: 'success',
        data: { configWrite: 'succeeded', apply: { reason: 'notRequested' } }
      });
    };
    const configBeforeUnauthorized = await fs.readFile(configFile);
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
    const configAfterUnauthorized = await fs.readFile(configFile);
    expect(unauthorizedExitCode, JSON.stringify({
      result: JSON.parse(unauthorized.readStdout()),
      before: JSON.parse(configBeforeUnauthorized.toString()).platforms.codex,
      after: JSON.parse(configAfterUnauthorized.toString()).platforms.codex
    })).toBe(3);
    expect(JSON.parse(unauthorized.readStdout())).toMatchObject({
      schemaVersion: 2, status: 'blocked',
      data: {
        confirmation: {
          required: true, provided: false, effects: expect.arrayContaining([
            expect.objectContaining({ code: 'runPreApply', subject: { pluginId: 'team/leaf', target: 'codex', scope: 'project' } }),
          ])
        }
      }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })])
    });
    expect(configAfterUnauthorized).toEqual(configBeforeUnauthorized);
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
    })).resolves.toMatchObject({ values: { mode: 7 } });
    await saveMode('fast');

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
      schemaVersion: 2, status: 'success', data: {
        configWrite: 'notStarted', apply: {
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
        }
      }
    });
    await expect(fs.readFile(
      path.join(isolation.env.AW_HOME!, 'config-pre-apply-count.txt'),
      'utf8',
    )).resolves.toBe('1');

    // A script in the closure does not require confirmation for an unchanged candidate.
    const unchanged = createCapturedCliIo();
    expect(await runCli(['plugin', 'config', 'set', 'team/root', 'mode', '--value-json', '"fast"',
      '--context', 'project', '--platform', 'codex', '--apply', '--json'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, io: unchanged.io, interactive: false, nativeCliRunner,
    }), unchanged.readStdout()).toBe(0);
    expect(JSON.parse(unchanged.readStdout())).toMatchObject({ status: 'success', data: { confirmation: { required: false, provided: false, effects: [] } } });
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'config-pre-apply-count.txt'), 'utf8')).resolves.toBe('1');

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
      sourceId: 'team',
      cliVersion: '1.0.0',
      env: isolation.env,
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
    const configBeforeRootUnauthorized = await fs.readFile(configFile);
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
    }))).toBe(3);
    expect(JSON.parse(rootUnauthorized.readStdout())).toMatchObject({
      schemaVersion: 2, status: 'blocked',
      data: {
        confirmation: {
          required: true, provided: false, effects: expect.arrayContaining([
            expect.objectContaining({ code: 'runPreApply', subject: expect.objectContaining({ pluginId: 'team/root' }) }),
            expect.objectContaining({ code: 'runPreApply', subject: expect.objectContaining({ pluginId: 'team/leaf' }) }),
          ])
        }
      }, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })])
    });
    expect(await fs.readFile(configFile)).toEqual(configBeforeRootUnauthorized);
    expect(await readOutputs()).toEqual(outputsBeforeRootUnauthorized);
    await expect(fs.readFile(path.join(isolation.env.AW_HOME!, 'config-pre-apply-count.txt'), 'utf8'))
      .resolves.toBe('1');
    await expect(readPluginConfigStore({
      sourceId: 'team', sourceIdentity: await calculateCatalogSourceIdentity(source),
      logicalIdentity, pluginName: 'root', scope: 'user', platform: 'codex',
      cwd: isolation.layout.fixtureCwd, env: isolation.env
    })).resolves.toMatchObject({ values: { mode: 7 } });
    await expect(fs.pathExists(
      path.join(isolation.env.AW_HOME!, 'root-config-pre-apply.txt'),
    )).resolves.toBe(false);
    await saveMode('strict');
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

  it('runs a shared dependency preApply once per config command across user and project roots', async (test) => {
    const timing = createCommandTestTiming(test);
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'config-shared-pre-apply-source');
    const controlPath = path.join(isolation.env.AW_HOME!, 'config-shared-pre-apply-control.txt');
    const counterPath = path.join(isolation.env.AW_HOME!, 'config-shared-pre-apply-count.txt');
    // Claude exposes the registration scope for both roots that share the dependency.
    const useClaude = (manifest: PluginMeta['manifest']) => { manifest.platforms = ['claude']; };
    const definitions: Array<{
      name: string;
      dependencies?: string[];
      configureManifest?: (manifest: PluginMeta['manifest']) => void;
    }> = [
      { name: 'leaf', configureManifest: useClaude },
      {
        name: 'root',
        dependencies: ['leaf'],
        configureManifest: (manifest) => {
          useClaude(manifest);
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
    const { runtime, nativeCliRunner, claudeHome } = await createClaudeNativeTestRuntime(isolation);
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
      ...createEmptyPreferences(), targets: ['claude'],
    });
    for (const scope of ['user', 'project'] as const) {
      const installed = await timing.measure('command', `fixture install ${scope}`, () => installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'claude',
        scope,
      }, runtime));
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    }
    const visible = await timing.measure('command', 'status', () => readRecoveryStatus({
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', context: 'project', targets: ['claude'], nativeCliRunner }));
    expect(visible.inventory?.filter((entry) => entry.pluginId === 'team/root')
      .flatMap((entry) => entry.targetResults).map((target) => target.scope).sort())
      .toEqual(['project', 'user']);

    definitions[0]!.configureManifest = (manifest) => {
      useClaude(manifest);
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
    await timing.measure('catalog', 'source sync', () => syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    }));

    const applyMode = async (mode: string) => {
      const output = createCapturedCliIo();
      const exitCode = await timing.measure('command', 'plugin config set --apply', () => runCli([
        'plugin', 'config', 'set', 'team/root', 'mode', '--value-json', JSON.stringify(mode),
        '--context', 'project', '--platform', 'claude', '--apply', '--yes', '--json',
      ], {
        cwd: isolation.layout.fixtureCwd,
        env: isolation.env,
        io: output.io,
        interactive: false,
        nativeCliRunner,
      }));
      return {
        exitCode,
        receipt: JSON.parse(output.readStdout()) as {
          schemaVersion: 2; status: string;
          data: { configWrite: string; apply: { targetResults: Array<{ target: { pluginId?: string }; errorCode?: string }> } };
        },
      };
    };

    const succeeded = await applyMode('fast');
    expect(succeeded.exitCode, JSON.stringify(succeeded.receipt)).toBe(0);
    expect(succeeded.receipt, JSON.stringify(succeeded.receipt)).toMatchObject({
      schemaVersion: 2, status: 'success', data: {
        configWrite: 'succeeded', apply: {
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
        }
      }
    });
    expect(succeeded.receipt.data.apply.targetResults.map((result) => `${result.target.pluginId}/${(result.target as { scope: string }).scope}`).sort())
      .toEqual(['team/leaf/project', 'team/leaf/user', 'team/root/project', 'team/root/user']);
    await expect(fs.readFile(counterPath, 'utf8')).resolves.toBe('1');

    const outputRoots = [claudeHome, path.join(isolation.env.AW_HOME!, 'platforms', 'claude'),
      path.join(isolation.layout.fixtureCwd, '.claude')];
    const readOutputs = () => Promise.all(outputRoots.map(async (root) => await fs.pathExists(root)
      ? snapshotRegularTree(root) : null));
    const outputsBeforeFailure = await readOutputs();
    await fs.outputFile(controlPath, 'fail');
    const failed = await applyMode('strict');
    expect(failed.exitCode).toBe(4);
    expect(failed.receipt).toMatchObject({ schemaVersion: 2, status: 'partial', data: { configWrite: 'succeeded' } });
    expect(failed.receipt.data.apply.targetResults, JSON.stringify(failed.receipt)).toEqual(expect.arrayContaining([
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
    expect(nextCommand.exitCode).toBe(4);
    expect(await readOutputs()).toEqual(outputsBeforeFailure);
    await expect(fs.readFile(counterPath, 'utf8')).resolves.toBe('3');
    for (const scope of ['user', 'project'] as const) {
      expect((await readIntentFixture({ scope, cwd: isolation.layout.fixtureCwd, env: isolation.env })).roots)
        .toEqual([expect.objectContaining({ pluginId: 'team/root' })]);
    }
    // Two installs and three real preApply attempts need a wider cross-platform runner window.
  }, 60_000);

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
    }, await createCodexNativeTestRuntime(isolation));

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

  it('reuses each successful renderer batch per render unit during execution', async () => {
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
      manifest.artifacts = { configKeys: [], scopes: ['project'] };
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
        'import fs from "node:fs"; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,"utf8"));',
        'console.log(JSON.stringify({version:3,components:c.allowedOutputKinds.includes("instruction")?[{id:"instruction",name:"instruction",kind:"instruction",content:{title:"Reviewed",content:"reviewed output",coverage:["main"]}}]:[],omitted:[],unmet:[]}));',
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
      manifest.artifacts = { configKeys: [], scopes: ['user', 'project'] };
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
    const { nativeCliRunner } = await createCodexNativeTestRuntime(isolation);
    const runtime = { env: isolation.env, nativeCliRunner };
    const reviewed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { ...runtime, previewOperationPlan: true });

    expect(reviewed.operationPlan?.evidence.configDigests).toEqual(['project', 'user'].map((scope) => ({
      pluginId: 'team/demo', scope, platform: 'codex', digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    })));
    expect(reviewed.operationPlan?.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'runPreApply', pluginId: 'team/demo', platform: 'codex', scope: 'project' }),
    ]));
    expect(reviewed.operationPlan?.deploymentPlans?.flatMap((plan) => plan.effects)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'publish-package' }),
    ]));
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
    expect(JSON.parse(configWrite.readStdout())).toMatchObject({ schemaVersion: 2, status: 'success', data: { configWrite: 'succeeded', apply: { state: 'skipped', reason: 'notRequested', targetResults: [] } } });
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
});
