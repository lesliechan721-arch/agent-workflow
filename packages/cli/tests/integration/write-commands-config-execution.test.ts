import { readIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { beforeEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { realpath } from 'node:fs/promises';
import { writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent, resolveIntentPath } from '../../src/intent/intent-store.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { canonicalNamespaceRoot, getPhysicalKey } from '../../src/platforms/identity.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { runCli } from '../../src/index.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { PassThrough } from 'node:stream';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getNativeTestLayout, installNativeTestQualification } from '../helpers/native-execution-fixture.js';
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
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';

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
    installNativeTestQualification({ platforms: ['codex', 'claude'], discovery: true, trust: true });
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
      expect(rejected.exitCode).toBe(2);
      expect(rejected.stdout).not.toContain('argv-secret');
      expect(rejected.stderr).not.toContain('argv-secret');
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        schemaVersion: 1, command: 'plugin.config.set', status: 'failed', data: {},
        diagnostics: [{ code: 'sensitiveConfigInputUnsupported' }],
      });
    }

    const missing = await runJson([
      'plugin', 'config', 'set', 'team/demo', 'token', '--context', 'user',
    ]);
    expect(missing.exitCode).toBe(2);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      schemaVersion: 1, command: 'plugin.config.set', status: 'failed', data: {},
      diagnostics: [{ code: 'invalidArguments' }],
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
    const configFile = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'demo', scope: 'user',
      cwd: isolation.layout.fixtureCwd, env: isolation.env
    });
    const bytesBeforeMissingInput = await fs.readFile(configFile);

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
    expect(exitCode).toBe(2);
    expect(password).not.toHaveBeenCalled();
    expect(captured.readStdout()).not.toContain('hidden-prompt-secret');
    expect(captured.readStderr()).not.toContain('hidden-prompt-secret');
    await expect(readStore()).resolves.toMatchObject({ values: { token: 'stdin-secret\nwith-newline\n' } });
    expect(await fs.readFile(configFile)).toEqual(bytesBeforeMissingInput);
  });

  it('prints an executable stdin-only repair command for invalid sensitive config', async () => {
    const isolation = getCurrentSourceTestIsolation();
    // Keep the invalid token distinct from hexadecimal source identity digests.
    const invalidToken = 'x!?';
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
      values: { token: invalidToken },
    });
    const output = createCapturedCliIo();

    const exitCode = await runCli([
      'plugin', 'config', 'get', 'team/demo', '--context', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: output.io,
      interactive: false,
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(output.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.config.get', status: 'success',
      nextActions: expect.arrayContaining([expect.objectContaining({
        kind: 'command',
        argv: ['aw', 'plugin', 'config', 'set', 'team/demo', 'token', '--context', 'user', '--value-stdin'],
        requiresConfirmation: false
      })])
    });
    expect(output.readStdout()).not.toContain(invalidToken);
    expect(output.readStdout()).not.toContain('--value-json');
    expect(output.readStdout()).not.toContain('--preset');
    // Both formats must use the same safe action and preserve the selected profile.
    for (const platform of [undefined, 'codex']) {
      const profileArgs = platform ? ['--platform', platform] : [];
      const expectedArgv = ['aw', 'plugin', 'config', 'set', 'team/demo', 'token', '--context', 'project', ...profileArgs, '--value-stdin'];
      for (const json of [false, true]) {
        const captured = createCapturedCliIo();
        expect(await runCli(['plugin', 'config', 'get', 'team/demo', '--context', 'project', ...profileArgs, ...(json ? ['--json'] : [])], {
          cwd: isolation.layout.fixtureCwd, env: isolation.env, io: captured.io, interactive: false,
        })).toBe(0);
        const stdout = captured.readStdout();
        if (json) expect(JSON.parse(stdout).nextActions).toContainEqual(expect.objectContaining({ kind: 'command', argv: expectedArgv, requiresConfirmation: false }));
        else expect(stdout).toContain(`Next: ${expectedArgv.join(' ')}`);
        for (const forbidden of [invalidToken, '--value-json', '--preset', '--apply', '--yes']) expect(stdout).not.toContain(forbidden);
      }
    }
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
      schemaVersion: 1, command: 'plugin.install', status: 'blocked',
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
      schemaVersion: 1, command: 'plugin.install', status: 'partial',
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
      schemaVersion: 1, command: 'plugin.install', status: 'blocked',
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
      schemaVersion: 1, command: 'plugin.install', status: 'success',
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
    ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success', } });
    const platformRoot = path.join(isolation.layout.fixtureCwd, '.codex');
    const platformBefore = await snapshotRegularTree(platformRoot);
    const failed = await runPublic([
      'config', 'set', 'team/demo', 'mode', '--context', 'project', '--platform', 'codex',
      '--value-json', '"fail"', '--apply', '--yes',
    ]);

    expect(failed, JSON.stringify(failed)).toMatchObject({
      exitCode: 4,
      payload: {
        schemaVersion: 1, status: 'partial', data: {
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
    ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success', data: { configWrite: 'succeeded', apply: { state: 'succeeded' } }, } });
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
      schemaVersion: 1, status: 'blocked',
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
      schemaVersion: 1, status: 'success', data: {
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
      schemaVersion: 1, status: 'blocked',
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
      const installed = await timing.measure('command', `fixture install ${scope}`, () => installFixturePlugin(['team/root'], {
        cwd: isolation.layout.fixtureCwd,
        platform: 'codex',
        scope,
      }, runtime));
      expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    }
    const visible = await timing.measure('command', 'status', () => readRecoveryStatus({
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', context: 'project', targets: ['codex'], nativeCliRunner }));
    expect(visible.inventory?.filter((entry) => entry.pluginId === 'team/root')
      .flatMap((entry) => entry.targetResults).map((target) => target.scope).sort())
      .toEqual(['project', 'user']);

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
    await timing.measure('catalog', 'source sync', () => syncCatalogSourceGeneration({
      sourceId: 'team', cliVersion: '1.0.0', env: isolation.env,
    }));

    const applyMode = async (mode: string) => {
      const output = createCapturedCliIo();
      const exitCode = await timing.measure('command', 'plugin config set --apply', () => runCli([
        'plugin', 'config', 'set', 'team/root', 'mode', '--value-json', JSON.stringify(mode),
        '--context', 'project', '--platform', 'codex', '--apply', '--yes', '--json',
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
          schemaVersion: 1; status: string;
          data: { configWrite: string; apply: { targetResults: Array<{ target: { pluginId?: string }; errorCode?: string }> } };
        },
      };
    };

    const succeeded = await applyMode('fast');
    expect(succeeded.exitCode, JSON.stringify(succeeded.receipt)).toBe(0);
    expect(succeeded.receipt, JSON.stringify(succeeded.receipt)).toMatchObject({
      schemaVersion: 1, status: 'success', data: {
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
      .toEqual(['team/leaf/user', 'team/root/project', 'team/root/user']);
    await expect(fs.readFile(counterPath, 'utf8')).resolves.toBe('1');

    const outputRoots = [isolation.env.CODEX_HOME!, path.join(isolation.env.AW_HOME!, 'platforms', 'codex'),
      path.join(isolation.layout.fixtureCwd, '.codex')];
    const readOutputs = () => Promise.all(outputRoots.map(async (root) => await fs.pathExists(root)
      ? snapshotRegularTree(root) : null));
    const outputsBeforeFailure = await readOutputs();
    await fs.outputFile(controlPath, 'fail');
    const failed = await applyMode('strict');
    expect(failed.exitCode).toBe(4);
    expect(failed.receipt).toMatchObject({ schemaVersion: 1, status: 'partial', data: { configWrite: 'succeeded' } });
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
    expect(JSON.parse(configWrite.readStdout())).toMatchObject({ schemaVersion: 1, status: 'success', data: { configWrite: 'succeeded', apply: { state: 'skipped', reason: 'notRequested', targetResults: [] } } });
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

  // Windows needs a completion window for seven sequential public commands.
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
      'console.log(JSON.stringify({version:3,components:context.allowedOutputKinds.includes("agent")?[{id:"helper-role",name:"helper",kind:"agent",content:{description:"Helper role.",prompt:`Help with effort=${effort}.`}}]:[],omitted:[],unmet:[]}));',
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
      manifest.artifacts = { configKeys: ['effort'], scopes: ['user', 'project'] };
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
      : path.join(isolation.layout.fixtureCwd, '.codex'), 'agents', 'aw-team-demo-helper.toml');
    const otherScope = scope === 'user' ? 'project' : 'user';
    const otherHome = otherScope === 'user' ? isolation.env.CODEX_HOME!
      : path.join(isolation.layout.fixtureCwd, '.codex');
    const otherRolePath = path.join(otherHome, 'agents', 'aw-other-sentinel-watcher.toml');

    expect(await runPublic([
      'plugin', 'install', 'team/demo', '--scope', scope, '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success', } });
    expect(await runPublic([
      'plugin', 'install', 'other/sentinel', '--scope', otherScope, '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success', } });
    const otherRoleBefore = await fs.readFile(otherRolePath);
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('effort=medium');

    expect(await runPublic([
      'plugin', 'config', 'set', 'team/demo', 'effort', '--context', scope, '--value-json', '"high"',
    ])).toMatchObject({
      exitCode: 0,
      payload: { schemaVersion: 1, status: 'success', data: { apply: { state: 'skipped', reason: 'notRequested' } }, },
    });
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('effort=medium');
    expect(await runPublic([
      'plugin', 'sync', 'team/demo', '--target', 'codex', '--context', scope, '--yes',
    ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success', } });
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('effort=high');

    const extraHighApply = await runPublic([
      'plugin', 'config', 'set', 'team/demo', 'effort', '--context', scope,
      '--value-json', '"xhigh"', '--apply', '--yes',
    ]);
    expect(extraHighApply, JSON.stringify(extraHighApply)).toMatchObject({
      exitCode: 0,
      payload: { schemaVersion: 1, status: 'success', data: { apply: { state: 'succeeded' } }, },
    });
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('effort=xhigh');

    const intentLocation = { scope, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const intentPath = await resolveIntentPath(intentLocation);
    const otherIntentPath = await resolveIntentPath({ ...intentLocation, scope: otherScope });
    const intentBeforeRemoval = await fs.readFile(intentPath);
    const otherIntentBefore = await fs.readFile(otherIntentPath);
    expect(await runPublic(['plugin', 'remove', 'team/demo', '--scope', scope, '--only', 'requirements'])).toMatchObject({
      exitCode: 0, payload: {
        schemaVersion: 1, command: 'plugin.remove', status: 'success',
        data: { changes: { requirements: 'changed', outputs: 'none' }, requirements: { roots: [] }, targetResults: [] }
      },
    });
    const intentAfterRemoval = await fs.readFile(intentPath);
    expect(intentAfterRemoval).not.toEqual(intentBeforeRemoval);
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('effort=xhigh');

    expect(await runPublic([
      'plugin', 'config', 'set', 'team/demo', 'effort', '--context', scope,
      '--value-json', '"medium"', '--apply', '--yes',
    ])).toMatchObject({
      exitCode: 0, payload: { schemaVersion: 1, status: 'success', data: { apply: { state: 'succeeded' } }, },
    });
    await expect(fs.readFile(rolePath, 'utf8'))
      .resolves.toContain('effort=medium');
    await expect(fs.readFile(intentPath)).resolves.toEqual(intentAfterRemoval);
    await expect(fs.readFile(otherIntentPath)).resolves.toEqual(otherIntentBefore);
    await expect(fs.readFile(otherRolePath)).resolves.toEqual(otherRoleBefore);
    expect([...runtime.installed].some((id) => id.startsWith('demo@'))).toBe(true);
  }, process.platform === 'win32' ? 60_000 : 30_000);

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
        exitCode: 0, payload: { schemaVersion: 1, status: 'success', data: { configWrite: 'succeeded' }, },
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
        exitCode: 0, payload: { schemaVersion: 1, status: 'success', data: { configWrite: 'succeeded' }, },
      });
    expect(await fs.readJson(userPath)).toMatchObject({ schemaVersion: 6,
      common: { labels: ['user', ''], counts: [0, 2], flags: [false, true] }, platforms: { cursor: { labels: [] } } });
    expect(await run(['plugin', 'config', 'get', 'team/demo', 'labels', '--platform', 'cursor'])).toMatchObject({
      exitCode: 0,
      payload: { schemaVersion: 1, status: 'success', data: { fields: [expect.objectContaining({ effectiveValue: [], sourceLayer: 'platform' })] }, },
    });
    expect(await run(['plugin', 'config', 'unset', 'team/demo', 'labels', '--context', 'project', '--platform', 'cursor'])).toMatchObject({
      exitCode: 0, payload: { schemaVersion: 1, status: 'success', data: { configWrite: 'succeeded' }, },
    });
    expect(await run(['plugin', 'config', 'get', 'team/demo', 'labels', '--platform', 'cursor'])).toMatchObject({
      exitCode: 0,
      payload: { schemaVersion: 1, status: 'success', data: { fields: [expect.objectContaining({ effectiveValue: ['user', ''], sourceLayer: 'common' })] }, },
    });

    const validBytes = await fs.readFile(userPath, 'utf8');
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'labels', '--context', 'user',
      '--value-json', '["mixed",0]'])).toMatchObject({ exitCode: 2 });
    expect(await fs.readFile(userPath, 'utf8')).toBe(validBytes);

    const stored = await fs.readJson(userPath) as Record<string, unknown>;
    const oldBytes = `${JSON.stringify({ ...stored, schemaVersion: 5 })}\n`;
    await fs.writeFile(userPath, oldBytes);
    expect(await run(['plugin', 'config', 'set', 'team/demo', 'labels', '--context', 'user',
      '--value-json', '["changed"]'])).toMatchObject({
        exitCode: 1,
        payload: { schemaVersion: 1, status: 'failed', diagnostics: [expect.objectContaining({ code: 'schemaVersionUnsupported' })] },
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
        'console.log(JSON.stringify({version:3,components:context.allowedOutputKinds.includes("instruction")?[{id:"instruction",name:"instruction",kind:"instruction",content:{title:"Config",content:`mode=${mode}`,coverage:["main"]}}]:[],omitted:[],unmet:[]}));',
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
        manifest.artifacts = { configKeys: ['mode'], scopes: ['user'] };
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
      const { nativeCliRunner } = await createCodexNativeTestRuntime(isolation);
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
      const layout = await getNativeTestLayout({ platform: 'codex', pluginId: 'team/demo', sourceIdentity, cwd: isolation.layout.fixtureCwd, env: isolation.env });
      const configPath = path.join(layout.packageRoot, 'scripts', 'aw-instructions.mjs');
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
    // Keep the eight-command state chain intact with a Windows completion window.
    it('replays presets, unset and reset while requiring sync for missing output', async (test) => {
      const { isolation, nativeCliRunner, runPublic, readStore, configPath, store } = await createFixture(test);
      expect(await runPublic([
        'plugin', 'install', 'team/demo', '--scope', 'project', '--yes',
      ])).toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success', } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      const sourceOnlyPreset = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--preset', 'safe', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(sourceOnlyPreset).toMatchObject({
        exitCode: 0,
        payload: { schemaVersion: 1, status: 'success', data: { updatedKeys: ['mode'], apply: { state: 'succeeded' } }, },
      });
      const equivalentPreset = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--preset', 'safe', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(equivalentPreset).toMatchObject({
        exitCode: 0,
        payload: { schemaVersion: 1, status: 'success', data: { updatedKeys: [], apply: { state: 'skipped', reason: 'noConfigChange' } }, },
      });

      await fs.remove(path.dirname(path.dirname(configPath)));
      const missing = await readRecoveryStatus({ cwd: isolation.layout.fixtureCwd, env: isolation.env,
        nativeCliRunner, context: 'project', targets: ['codex'] });
      expect(missing.observedTargets).toEqual(expect.arrayContaining([expect.objectContaining({
        pluginId: 'team/demo', agent: 'codex', scope: 'project', content: 'unknown', observation: 'unknown',
        blockers: expect.arrayContaining([expect.objectContaining({ code: 'dynamicExpectationUnconfirmed' })]),
        deploymentObservations: expect.arrayContaining([expect.objectContaining({
          after: expect.objectContaining({ package: 'absent', ownership: 'absent', registration: 'present' }),
        })]),
      })]));

      const set = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(set, JSON.stringify(set)).toMatchObject({
        exitCode: 4,
        payload: {
          schemaVersion: 1, status: 'partial', data: {
            configWrite: 'succeeded', apply: {
              state: 'partial', targetResults: [expect.objectContaining({
                target: expect.objectContaining({ pluginId: 'team/demo', platform: 'codex', scope: 'project' }),
                state: 'skipped', errorCode: 'configApplyRequiresExistingOutput',
              })]
            }
          },
        },
      });
      expect(set.payload).not.toHaveProperty('targetResults');
      expect(JSON.parse(set.stdout)).toEqual(set.payload);
      expect(JSON.stringify(set.payload)).not.toContain('projectConfigShareabilityUnverified');
      expect(await fs.readJson(resolvePluginConfigStorePath({
        sourceId: 'team', pluginName: 'demo', scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
      }))).toMatchObject({ schemaVersion: 6, common: {}, platforms: { codex: { mode: 'fast' } } });
      expect((await readStore()).values).toEqual({ mode: 'fast' });
      await expect(fs.pathExists(configPath)).resolves.toBe(false);
      expect(await runPublic(['plugin', 'sync', 'team/demo', '--target', 'codex', '--context', 'project', '--yes']))
        .toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success', } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=fast');

      const unset = await runPublic([
        'plugin', 'config', 'unset', 'team/demo', 'mode', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(unset).toMatchObject({
        exitCode: 0,
        payload: { schemaVersion: 1, status: 'success', data: { configWrite: 'succeeded' }, },
      });
      expect((await readStore()).values).toEqual({});
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      await writePluginConfigStore({ ...store, values: { mode: 'fast' } });
      expect(await runPublic(['plugin', 'sync', 'team/demo', '--target', 'codex', '--context', 'project', '--yes']))
        .toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success', } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=fast');
      const reset = await runPublic([
        'plugin', 'config', 'reset', 'team/demo', '--context', 'project', '--platform', 'codex', '--yes', '--apply',
      ]);
      expect(reset).toMatchObject({
        exitCode: 0,
        payload: { schemaVersion: 1, status: 'success', data: { configWrite: 'succeeded', deleted: true }, },
      });
      expect((await readStore()).exists).toBe(false);
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');
    }, process.platform === 'win32' ? 60_000 : 30_000);

    // Test Value Gate: CLI save notices and atomic failure receipts must agree with the stored values.
    it('saves without apply and preserves the previous store on atomic failure', async (test) => {
      const { runPublic, runHumanConfig, readStore, configPath, store } = await createFixture(test);
      const human = await runHumanConfig([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--context', 'project', '--platform', 'codex',
      ]);
      expect(human.exitCode).toBe(0);
      expect(human.stdout).toContain('configWrite: succeeded');
      expect(human.stdout).toContain('Apply: skipped (notRequested)');
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
        expect(result.stdout).toContain('scope: user');
        expect(result.stdout + result.stderr).not.toMatch(/[\u3400-\u9fff]/u);
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
        payload: { schemaVersion: 1, status: 'failed', data: { configWrite: 'failed' }, },
      });
      expect((await readStore()).values).toEqual({ mode: 'fast' });
    }, 30_000);

    // Test Value Gate: invalid configuration remains repairable without overwriting valid output or unrelated fields.
    it('removes stale keys and repairs invalid fields without refreshing unrelated output', async (test) => {
      const { runPublic, runHumanConfig, readStore, configPath, store } = await createFixture(test);
      expect(await runPublic(['plugin', 'install', 'team/demo', '--scope', 'project', '--yes']))
        .toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success', } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      await writePluginConfigStore({
        ...store,
        values: { obsolete: 'old' },
      });
      const staleUnset = await runPublic([
        'plugin', 'config', 'unset', 'team/demo', 'obsolete', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(staleUnset).toMatchObject({
        exitCode: 0,
        payload: { schemaVersion: 1, status: 'success', data: { configWrite: 'succeeded', staleRemovedKeys: ['obsolete'], affectedFields: [expect.objectContaining({ key: 'obsolete', stale: true })], apply: { state: 'skipped', reason: 'noEffectiveConfigChange', targetResults: [] } }, },
      });
      expect(staleUnset.payload).not.toHaveProperty('targetResults');
      expect((await readStore()).values).toEqual({});
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      await writePluginConfigStore({
        ...store,
        values: { labels: { 'bad key': 'preserved' } },
      });
      const partial = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"fast"', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(partial, JSON.stringify(partial)).toMatchObject({
        exitCode: 4,
        payload: {
          schemaVersion: 1, status: 'partial', data: {
            configWrite: 'succeeded', apply: {
              state: 'partial',
              targetResults: [expect.objectContaining({ state: 'skipped', errorCode: 'invalidConfig' })],
            }, effective: {
              fieldStates: {
                labels: { invalidOverride: { source: 'platform' } },
                mode: { effective: { source: 'platform', value: 'fast' } },
              },
            }
          },
        },
      });
      expect((await readStore()).values).toEqual({
        labels: { 'bad key': 'preserved' },
        mode: 'fast',
      });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

      const unavailableHuman = await runHumanConfig([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"slow"', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(unavailableHuman).toMatchObject({ exitCode: 4 });
      expect(unavailableHuman.stdout).toContain('configWrite: succeeded');
      expect(unavailableHuman.stdout).toContain('codex/project: skipped');
      expect(unavailableHuman.stderr).toContain('invalidConfig');
      expect(unavailableHuman.stdout).toContain(
        'aw plugin sync team/demo --context project --target codex',
      );
      expect(unavailableHuman.stderr).not.toContain('preserved');

      const repaired = await runPublic([
        'plugin', 'config', 'set', 'team/demo', 'labels', '--value-json', '{"good_key":"repaired"}',
        '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(repaired).toMatchObject({
        exitCode: 0,
        payload: { schemaVersion: 1, status: 'success', data: { configWrite: 'succeeded', apply: { state: 'skipped', reason: 'noEffectiveConfigChange' } }, },
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
      expect(await runPublic(['plugin', 'install', 'team/demo', '--scope', 'project', '--yes']))
        .toMatchObject({ exitCode: 0, payload: { schemaVersion: 1, status: 'success', } });
      expect(await fs.readFile(configPath, 'utf8')).toContain('mode=fast');

      const failed = await runHumanConfig([
        'plugin', 'config', 'set', 'team/demo', 'mode', '--value-json', '"fail"', '--context', 'project', '--platform', 'codex', '--apply', '--yes',
      ]);
      expect(failed).toMatchObject({ exitCode: 4 });
      expect(failed.stdout).toContain('codex/project: failed');
      expect(failed.stderr).toContain('writeFailed');
      expect(failed.stdout).toContain(
        'aw plugin sync team/demo --context project --target codex',
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
        const skill = `---\nname: ${pluginName}\ndescription: Sensitive boundary fixture.\n---\n${leak && leakPath === 'SKILL.md' ? `native ${secret}` : 'native safe'}\n`;
        const reference = leak && leakPath === 'references/secret.md'
          ? `, "references/secret.md": ${JSON.stringify(secret)}`
          : '';
        await fs.outputFile(rendererPath, [
          'import assert from "node:assert/strict";',
          'import { readFile } from "node:fs/promises";',
          'import { fileURLToPath } from "node:url";',
          'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
          'assert.ok(fileURLToPath(import.meta.url).length >= 260);',
          `const files={"SKILL.md":${JSON.stringify(skill)},"README.md":"native readme"${reference}};`,
          `console.log(JSON.stringify({version:3,components:context.allowedOutputKinds.includes('skill')?[{id:${JSON.stringify(pluginName)},kind:'skill',name:${JSON.stringify(pluginName)},content:{files:Object.fromEntries(Object.entries(files).map(([p,text])=>[p,{text}]))}}]:[],omitted:[],unmet:[]}));`,
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
          manifest.artifacts = { configKeys: [], scopes: ['user'] };
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

      const marketplaceRoot = [...runtime.marketplaceRoots.values()][0]!;
      const pluginId = [...runtime.installed][0]!;
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
        `---\nname: ${skillKey}\ndescription: Sensitive boundary fixture.\n---\nstatic payload ${secret}\n`,
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
        state: 'failed', errorCode: 'componentSensitiveConfigExposed',
      })],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'platforms', 'codex')))
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
        `---\nname: ${skillKey}\ndescription: Sensitive boundary fixture.\n---\nstatic payload ${secret}\n`,
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
    const marketplaceRoot = [...runtime.marketplaceRoots.values()][0]!;
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
        state: 'failed', errorCode: 'componentSensitiveConfigExposed',
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
    expect([...runtime.installed].some((id) => id.startsWith(`${pluginName}@`))).toBe(true);
  }, 30_000);

  it('repairs an owned damaged Native manifest only after authorization without reading outside Skills or changing foreign siblings', async () => {
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
      '---\nname: safe\ndescription: Safe fixture.\n---\n# Safe\n',
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
    const marketplaceRoot = [...runtime.marketplaceRoots.values()][0]!;
    const codexManifestPath = path.join(
      marketplaceRoot,
      'plugins',
      pluginName,
      '.codex-plugin',
      'plugin.json',
    );
    const codexManifest = await fs.readJson(codexManifestPath);
    await fs.outputJson(codexManifestPath, { ...codexManifest, skills: '..\\outside' });
    const packageRoot = path.dirname(path.dirname(codexManifestPath));
    const outsideRoot = path.join(path.dirname(packageRoot), 'outside');
    const foreignRoot = path.join(path.dirname(packageRoot), 'foreign-sibling');
    const sentinel = path.join(outsideRoot, 'SKILL.md');
    await fs.outputFile(sentinel, '---\nname: outside\ndescription: Foreign sentinel.\n---\nsensitive-value\n');
    await fs.outputFile(path.join(foreignRoot, 'foreign.txt'), 'foreign sibling must remain\n');
    const outsideBefore = await snapshotRegularTree(outsideRoot);
    const foreignBefore = await snapshotRegularTree(foreignRoot);
    const sentinelBefore = await fs.stat(sentinel);
    const damagedBefore = await fs.readFile(codexManifestPath);
    const intentBefore = await observeIntent({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env });
    const callsBefore = runtime.nativeCliRunner.mock.calls.length;
    const outsideReads: string[] = [];
    const readFile = fs.readFile.bind(fs);
    const spy = vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const file = path.resolve(String(args[0]));
      const relative = path.relative(outsideRoot, file);
      const insideOutsideRoot = relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      // Discovery can inspect this fixed owner marker, but must not read foreign Skill resources.
      if (insideOutsideRoot && file !== path.join(outsideRoot, SKILL_OWNER_MARKER)) outsideReads.push(file);
      return readFile(...args);
    });
    const run = async (yes: boolean) => {
      const output = createCapturedCliIo();
      const exitCode = await runCli(['plugin', 'install', `team/${pluginName}`, '--scope', 'project', '--target', 'codex',
        ...(yes ? ['--yes'] : []), '--json'], { cwd: isolation.layout.fixtureCwd, env: isolation.env,
        nativeCliRunner: runtime.nativeCliRunner, io: output.io, interactive: false });
      return { exitCode, payload: JSON.parse(output.readStdout()) };
    };
    try {
      const blocked = await run(false);
      expect(blocked, JSON.stringify(blocked)).toMatchObject({ exitCode: 3, payload: { status: 'blocked',
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'confirmationRequired' })]) } });
      expect(await fs.readFile(codexManifestPath)).toEqual(damagedBefore);
      expect(await observeIntent({ scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env })).toEqual(intentBefore);
      expect(runtime.nativeCliRunner.mock.calls.slice(callsBefore).filter(([invocation]) => {
        const index = invocation.args.indexOf('plugin');
        return ['add', 'remove'].includes(invocation.args[index + 1] ?? '');
      })).toEqual([]);
      const repaired = await run(true);
      expect(repaired, JSON.stringify(repaired)).toMatchObject({ exitCode: 0, payload: { status: 'success' } });
      expect(JSON.stringify(repaired)).not.toContain('sensitive-value');
      expect((await fs.readJson(codexManifestPath)).skills).toBe('./skills/');
      expect(await fs.readFile(path.join(packageRoot, 'skills/safe/SKILL.md'), 'utf8')).toContain('name: safe');
      expect(outsideReads).toEqual([]);
    } finally { spy.mockRestore(); }
    expect(await snapshotRegularTree(outsideRoot)).toEqual(outsideBefore);
    expect(await snapshotRegularTree(foreignRoot)).toEqual(foreignBefore);
    expect((await fs.stat(sentinel)).mtimeMs).toBe(sentinelBefore.mtimeMs);
  }, 30_000);

  describe('project Codex intent with shared user config', () => {
    async function createNativeConfigFixture(test: TestContext) {
      const timing = createCommandTestTiming(test);
      const isolation = getCurrentSourceTestIsolation();
      const cwd = isolation.layout.fixtureCwd;
      const env = isolation.env;
      await writePreferences({ scope: 'user', cwd, env }, { ...createEmptyPreferences(), targets: ['codex'] });
      const sourceRoot = path.join(cwd, 'shared-native-config-source');
      const rendererMarker = path.join(cwd, 'native-config-renderer.jsonl');
      await fs.outputFile(path.join(sourceRoot, 'plugins/native-config/scripts/render.mjs'), [
        'import fs from "node:fs"; const c=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,"utf8"));',
        'import { fileURLToPath } from "node:url";',
        'const mode=c.config.values.mode;if(mode==="fail")throw new Error("native renderer requested failure");',
        `fs.appendFileSync(${JSON.stringify(rendererMarker)},JSON.stringify({cwd:process.cwd(),realCwd:fs.realpathSync(process.cwd()),entryPath:fs.realpathSync(fileURLToPath(import.meta.url)),bundleRoot:fs.realpathSync(process.env.AW_PLUGIN_ROOT),home:process.env.HOME,awHome:process.env.AW_HOME,contextPath:process.env.AW_PLUGIN_CONTEXT,context:c})+'\\n');`,
        'const allowed=c.allowedOutputKinds.includes("skill");',
        'const text=`---\nname: native-config\ndescription: Shared config fixture.\n---\nmode=${mode}\nrequestScope=${c.scope}\nsource=${c.config.sources.mode}\n`;',
        'console.log(JSON.stringify({version:3,components:allowed&&mode!=="off"?[{id:"native-config",kind:"skill",name:"native-config",content:{files:{"SKILL.md":{text},"README.md":{text:"Native config fixture.\\n"}}}}]:[],omitted:allowed&&mode==="off"?[{id:"native-config",kind:"skill",reason:"config-disabled"}]:[],unmet:[]}));',
      ].join('\n'));
      await createCatalogSnapshotFixture(sourceRoot, 'native-config', [], 'native\n', (manifest) => {
        manifest.platforms = ['codex'];
        manifest.config = { schemaVersion: 5, fields: {
          mode: { type: 'string', default: 'safe' }, projectMode: { type: 'string', default: 'project-default' },
        } };
        manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
        manifest.artifacts = { configKeys: ['mode'], scopes: ['user'] };
        manifest.extensions = { instructions: [{ name: 'package-anchor', title: 'Shared config',
          content: 'Keep the independent plugin context when its optional Skill is disabled.', coverage: ['main'] }] };
      });
      const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
      const sourceIdentity = await calculateCatalogSourceIdentity(source);
      const logicalIdentity = await readCatalogLogicalIdentity(sourceRoot);
      const before = await readCatalogSourcesConfigSnapshot(env);
      await replaceCatalogSourcesConfigWithoutActive({ config: { schemaVersion: 2, sources: [source] }, expectedDigest: before.digest, env });
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
      const runtime = await createCodexNativeTestRuntime(isolation);
      const runPublic = async (args: string[], interactive = false) => {
        const captured = createCapturedCliIo();
        const confirm = vi.fn(async () => ({ action: 'select' as const, cancelled: false, value: true }));
        const exitCode = await timing.measure('command', args.slice(0, 3).join(' '), () => runCli([...args, '--json'], {
          cwd, env, io: captured.io, interactive, nativeCliRunner: runtime.nativeCliRunner,
          ...(interactive ? { prompt: { confirm }, ...createTtyRuntimeStreams() } : {}),
        }));
        expect(confirm).not.toHaveBeenCalled();
        return { exitCode, payload: JSON.parse(captured.readStdout()), stdout: captured.readStdout(), stderr: captured.readStderr() };
      };
      const store = { sourceId: 'team', sourceIdentity, logicalIdentity, pluginName: 'native-config', scope: 'user' as const, cwd, env };
      const writeMode = (mode: string) => writePluginConfigStore({ ...store, values: { mode } });
      await writePluginConfigStore({ ...store, platform: 'codex', values: { projectMode: 'platform-only' } });
      const initial = await runPublic(['plugin', 'install', 'team/native-config', '--scope', 'project', '--yes']);
      expect(initial, JSON.stringify(initial)).toMatchObject({ exitCode: 0, payload: { status: 'success' } });
      const layout = await getNativeTestLayout({ platform: 'codex', pluginId: 'team/native-config', sourceIdentity, cwd, env });
      const packageRoot = layout.packageRoot;
      const skillRoot = path.join(packageRoot, 'skills/native-config');
      const ownerPath = path.join(packageRoot, SKILL_OWNER_MARKER);
      const canonicalPluginId = layout.nativeIdentity.registrationId!;
      const cacheRoot = path.join(env.CODEX_HOME!, 'plugins/cache', layout.marketplaceName!, 'native-config/1.0.0');
      const userConfig = path.join(env.CODEX_HOME!, 'config.toml');
      const projectConfig = path.join(cwd, '.codex/config.toml');
      const userIntentBefore = await observeIntent({ scope: 'user', cwd, env });
      expect(userIntentBefore).toMatchObject({ state: 'absent' });
      await fs.writeFile(rendererMarker, '');
      const readStore = () => readPluginConfigStore(store);
      const configFile = resolvePluginConfigStorePath(store);
      const snapshotOutputs = async () => ({ package: await snapshotRegularTree(packageRoot),
        user: await fs.readFile(userConfig), project: await fs.readFile(projectConfig) });
      const readStatus = () => runPublic(['plugin', 'status', '--context', 'project']);
      const assertActivation = async () => {
        expect((await readCodexConfigFile(userConfig)).snapshot.plugins[canonicalPluginId]?.enabled).toBe(false);
        expect((await readCodexConfigFile(projectConfig)).snapshot.plugins[canonicalPluginId]?.enabled).toBe(true);
        expect(await observeIntent({ scope: 'user', cwd, env })).toEqual(userIntentBefore);
      };
      return { isolation, cwd, env, runtime, runPublic, sourceIdentity, rendererMarker, readStore, writeMode,
        layout, packageRoot, skillRoot, ownerPath, canonicalPluginId, cacheRoot, configFile, snapshotOutputs, readStatus, assertActivation };
    }

    // Test Value Gate: saving and consent are separate; project apply shares bytes but never adds user intent.
    it('saves and authorizes shared native config without creating user intent', async (test) => {
      const f = await createNativeConfigFixture(test);
      const outputsBefore = await f.snapshotOutputs();
      expect(await f.runPublic(['plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"saved"', '--context', 'project']))
        .toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'succeeded', apply: { reason: 'notRequested', targetResults: [] } } } });
      expect(await f.snapshotOutputs()).toEqual(outputsBefore);
      expect(await fs.readFile(f.rendererMarker, 'utf8')).toBe('');
      const storeBefore = await fs.readFile(f.configFile);
      const blocked = await f.runPublic(['plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"blocked"', '--context', 'project', '--apply']);
      expect(blocked, JSON.stringify(blocked)).toMatchObject({ exitCode: 3, payload: { status: 'blocked', data: {
        confirmation: { required: true, provided: false, effects: expect.arrayContaining([expect.objectContaining({ code: 'replaceSharedOutput', impact: 'shared' })]) },
      } } });
      expect(await fs.readFile(f.configFile)).toEqual(storeBefore);
      expect(await f.snapshotOutputs()).toEqual(outputsBefore);
      await f.assertActivation();
      const applied = await f.runPublic(['plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"authorized"', '--context', 'project', '--apply', '--yes']);
      expect(applied, JSON.stringify(applied)).toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'succeeded', apply: {
        state: 'succeeded', targetResults: [expect.objectContaining({ target: expect.objectContaining({ platform: 'codex', scope: 'project' }), state: 'completed' })],
      } } } });
      await f.assertActivation();
      expect((await f.readStore()).values).toEqual({ mode: 'authorized' });
      expect(await fs.readFile(path.join(f.skillRoot, 'SKILL.md'), 'utf8')).toContain('mode=authorized\nrequestScope=user\n');
      const events = (await fs.readFile(f.rendererMarker, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        const projectRoot = path.toNamespacedPath(await realpath(f.cwd));
        const bundleRoot = path.toNamespacedPath(event.bundleRoot);
        expect(path.toNamespacedPath(event.realCwd)).toBe(projectRoot);
        expect(path.toNamespacedPath(event.entryPath)).toBe(path.join(bundleRoot, 'scripts/render.mjs'));
        expect(bundleRoot).not.toBe(projectRoot);
        expect(path.relative(path.toNamespacedPath(await realpath(f.env.AW_HOME!)), bundleRoot)).toMatch(/^catalog-store[/\\]/u);
        const isolatedRoot = path.dirname(event.contextPath);
        expect(event.home).toBe(path.join(isolatedRoot, 'home'));
        expect(event.awHome).toBe(path.join(isolatedRoot, 'aw-home'));
        expect(event.home).not.toBe(f.env.HOME);
        expect(event.awHome).not.toBe(f.env.AW_HOME);
        expect(await fs.pathExists(isolatedRoot)).toBe(false);
        expect(event.context).toMatchObject({ surface: 'agent-plugin', scope: 'user' });
        expect(event.context.allowedOutputKinds).toEqual(event.context.allowedOutputKinds.includes('skill')
          ? ['skill'] : ['mcp', 'hook', 'instruction']);
        expect(event.context.config.schema.fields).not.toHaveProperty('projectMode');
        expect(event.context.config.values).not.toHaveProperty('projectMode');
      }
      const ownerBefore = await fs.readFile(f.ownerPath);
      expect(await f.runPublic(['plugin', 'config', 'unset', 'team/native-config', 'mode', '--context', 'project', '--apply']))
        .toMatchObject({ exitCode: 3 });
      expect(await fs.readFile(f.ownerPath)).toEqual(ownerBefore);
      expect(await f.runPublic(['plugin', 'config', 'unset', 'team/native-config', 'mode', '--context', 'project']))
        .toMatchObject({ exitCode: 0, payload: { data: { apply: { reason: 'notRequested' } } } });
      const savedBytes = await fs.readFile(f.configFile);
      expect(await f.runPublic(['plugin', 'config', 'apply', 'team/native-config', '--context', 'project', '--yes']))
        .toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'notStarted', apply: { state: 'succeeded' } } } });
      expect(await fs.readFile(f.configFile)).toEqual(savedBytes);
      expect(await fs.readFile(path.join(f.skillRoot, 'SKILL.md'), 'utf8')).toContain('mode=safe\n');
      expect(await f.runPublic(['plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"safe"', '--context', 'project', '--apply', '--yes']))
        .toMatchObject({ exitCode: 0, payload: { data: { updatedKeys: ['mode'], apply: { state: 'succeeded' } } } });
      expect(await fs.readFile(path.join(f.skillRoot, 'SKILL.md'), 'utf8')).toContain('source=common\n');
      await f.assertActivation();
    }, 120_000);

    // Test Value Gate: package ownership, unsafe paths and missing output are observed without executing the renderer.
    it('diagnoses and recovers damaged shared native projections without trusting cache evidence', async (test) => {
      const f = await createNativeConfigFixture(test);
      const ownerBytes = await fs.readFile(f.ownerPath);
      const owner = JSON.parse(ownerBytes.toString());
      const rendererBefore = await fs.readFile(f.rendererMarker);
      const status = await f.readStatus();
      expect(status, JSON.stringify(status)).toMatchObject({ exitCode: 0 });
      expect(await fs.readFile(f.rendererMarker)).toEqual(rendererBefore);
      await f.writeMode('drifted');
      await f.readStatus();
      expect(await fs.readFile(f.rendererMarker)).toEqual(rendererBefore);
      const applied = await f.runPublic(['plugin', 'config', 'apply', 'team/native-config', '--context', 'project', '--yes']);
      expect(applied, JSON.stringify(applied)).toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'notStarted', apply: { state: 'succeeded' } } } });
      expect(await fs.readFile(path.join(f.skillRoot, 'SKILL.md'), 'utf8')).toContain('mode=drifted\n');
      const currentOwner = await fs.readFile(f.ownerPath);
      await fs.outputJson(f.ownerPath, { ...JSON.parse(currentOwner.toString()), sourceIdentity: `sha256:${'f'.repeat(64)}` });
      const foreignBytes = await f.snapshotOutputs();
      const foreign = await f.runPublic(['plugin', 'sync', 'team/native-config', '--target', 'codex', '--context', 'project', '--yes']);
      expect(foreign, JSON.stringify(foreign)).toMatchObject({ exitCode: 3, payload: {
        status: 'blocked', data: { changes: { outputs: 'none' } },
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'stateInventoryFailed' })]),
      } });
      expect(await f.snapshotOutputs()).toEqual(foreignBytes);
      await fs.outputFile(f.ownerPath, currentOwner);
      if (process.platform !== 'win32') {
        const outside = path.join(f.cwd, 'foreign-native-config-skill');
        await fs.move(f.skillRoot, outside);
        await fs.symlink(outside, f.skillRoot, 'dir');
        const unsafeBefore = await fs.readFile(path.join(outside, 'SKILL.md'));
        const unsafe = await f.runPublic(['plugin', 'sync', 'team/native-config', '--target', 'codex', '--context', 'project', '--yes']);
        expect(unsafe, JSON.stringify(unsafe)).toMatchObject({ exitCode: 3, payload: {
          status: 'blocked', data: { changes: { outputs: 'none' } },
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'stateInventoryFailed' })]),
        } });
        expect((await fs.lstat(f.skillRoot)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(path.join(outside, 'SKILL.md'))).toEqual(unsafeBefore);
        await fs.remove(f.skillRoot);
        await fs.move(outside, f.skillRoot);
      }
      await fs.remove(f.skillRoot);
      const missing = await f.readStatus();
      expect(JSON.stringify(missing.payload)).toContain('componentOutputMissing');
      const rendererBeforeStatus = await fs.readFile(f.rendererMarker);
      await f.readStatus();
      expect(await fs.readFile(f.rendererMarker)).toEqual(rendererBeforeStatus);
      const recovered = await f.runPublic(['plugin', 'sync', 'team/native-config', '--target', 'codex', '--context', 'project', '--yes']);
      expect(recovered, JSON.stringify(recovered)).toMatchObject({ exitCode: 0 });
      expect(await fs.readFile(path.join(f.skillRoot, 'SKILL.md'), 'utf8')).toContain('mode=drifted\n');
      // Client cache files are not AW ownership evidence for the canonical package.
      const cacheSkill = path.join(f.cacheRoot, 'skills/native-config/SKILL.md');
      await fs.outputFile(cacheSkill, 'foreign cache bytes\n');
      const cacheBefore = await fs.readFile(cacheSkill);
      const canonicalBefore = await snapshotRegularTree(f.packageRoot);
      await f.readStatus();
      expect(await snapshotRegularTree(f.packageRoot)).toEqual(canonicalBefore);
      expect(await fs.readFile(cacheSkill)).toEqual(cacheBefore);
      expect(owner.nativeProjection.components).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'native-config', nativeName: 'native-config' })]));
      await f.assertActivation();
    }, 120_000);

    // Test Value Gate: omitting the optional Skill retains independent Instructions; failure and missing consent preserve bytes.
    it('recovers disabled shared native config and preserves scope ownership through interactive changes', async (test) => {
      const f = await createNativeConfigFixture(test);
      const disabled = await f.runPublic(['plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"off"', '--context', 'project', '--apply', '--yes']);
      expect(disabled, JSON.stringify(disabled)).toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'succeeded', apply: { state: 'succeeded' } } } });
      expect(await fs.pathExists(f.skillRoot)).toBe(false);
      expect(await fs.pathExists(f.ownerPath)).toBe(true);
      expect(f.runtime.installed.has(f.canonicalPluginId)).toBe(true);
      const disabledOutput = await f.snapshotOutputs();
      const failed = await f.runPublic(['plugin', 'config', 'set', 'team/native-config', 'mode', '--value-json', '"fail"', '--context', 'project', '--apply', '--yes']);
      expect(failed, JSON.stringify(failed)).toMatchObject({ exitCode: 4, payload: { data: { configWrite: 'succeeded', apply: { state: 'partial' } } } });
      expect((await f.readStore()).values).toEqual({ mode: 'fail' });
      expect(await f.snapshotOutputs()).toEqual(disabledOutput);
      await f.writeMode('off');
      const configBefore = await fs.readFile(f.configFile);
      const renderBefore = await fs.readFile(f.rendererMarker);
      const callsBefore = f.runtime.nativeCliRunner.mock.calls.length;
      const cancelled = await f.runPublic(['plugin', 'config', 'reset', 'team/native-config', '--context', 'project', '--apply'], true);
      expect(cancelled).toMatchObject({ exitCode: 3 });
      expect(await fs.readFile(f.configFile)).toEqual(configBefore);
      expect(await f.snapshotOutputs()).toEqual(disabledOutput);
      expect(await fs.readFile(f.rendererMarker)).toEqual(renderBefore);
      const mutations = f.runtime.nativeCliRunner.mock.calls.slice(callsBefore).filter(([invocation]) => {
        const index = invocation.args.indexOf('plugin');
        return ['add', 'remove'].includes(invocation.args[index + 1] ?? '');
      });
      expect(mutations).toEqual([]);
      const restored = await f.runPublic(['plugin', 'config', 'unset', 'team/native-config', 'mode', '--context', 'project', '--apply', '--yes'], true);
      expect(restored, JSON.stringify(restored)).toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'succeeded', apply: { state: 'succeeded' } } } });
      expect((await f.readStore()).values).toEqual({});
      expect(await fs.readFile(path.join(f.skillRoot, 'SKILL.md'), 'utf8')).toContain('mode=safe\nrequestScope=user\n');
      const legacyRoot = path.join(f.cwd, '.agents/skills/native-config');
      await fs.outputFile(path.join(legacyRoot, 'SKILL.md'), 'project legacy bytes\n');
      await writeSkillOwnerMarker({ skillRoot: legacyRoot, allowedRoot: path.dirname(legacyRoot), identity: {
        owner: 'agent-workflows', sourceId: 'team', sourceIdentity: f.sourceIdentity, pluginId: 'team/native-config',
        plugin: 'native-config', artifactKey: 'native-config', platform: 'codex', scope: 'project',
        physicalKey: getPhysicalKey({ sourceIdentity: f.sourceIdentity, pluginId: 'team/native-config', platform: 'codex',
          route: 'codex-marketplace', namespaceRoot: await canonicalNamespaceRoot(path.dirname(legacyRoot)), resourceKey: 'aw-team-native-config:legacy-skill' }),
      } });
      const legacyBefore = await snapshotRegularTree(legacyRoot);
      const userInstall = await installFixturePlugin(['team/native-config'], { cwd: f.cwd, platform: 'codex', scope: 'user' }, f.runtime);
      expect(userInstall, JSON.stringify(userInstall)).toMatchObject({ overallState: 'succeeded' });
      expect(await snapshotRegularTree(legacyRoot)).toEqual(legacyBefore);
      const reset = await f.runPublic(['plugin', 'config', 'reset', 'team/native-config', '--context', 'project', '--apply', '--yes'], true);
      expect(reset, JSON.stringify(reset)).toMatchObject({ exitCode: 0, payload: { data: { configWrite: 'succeeded' } } });
      expect(await f.readStore()).toMatchObject({ values: {}, platforms: { codex: { projectMode: 'platform-only' } } });
      expect(await snapshotRegularTree(legacyRoot)).toEqual(legacyBefore);
    }, 120_000);
  });
});
