import { installNativeTestQualification, getNativeTestLayout, createNativeTestExecution, isolateCodexAppDiscoveryQueries } from '../helpers/native-execution-fixture.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { describe, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { runRecovery, prepareRecovery, executeRecovery } from '../../src/recovery/coordinator.js';
import { writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { buildRebuildReceiptJson } from '../../src/output/command-receipt.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { runCli } from '../../src/index.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { projectExecutionDiagnostics } from '../../src/tui/diagnostic-projection.js';
import { createCatalogSnapshotFixture, createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { readPluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { type NativeCliInvocation } from '../../src/utils/native-cli.js';
import { setPrimaryCatalogSourceCommand, updateCatalogSourceCommand } from '../../src/commands/catalog-source.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';
import { deploymentPackageComponent } from '../../src/platforms/inspection.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { setCodexDiscoveryOverridesForTests } from '../../src/utils/codex-executable-discovery.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';

import {
  installWriteCommand,
  syncWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  cleanupWriteCommand,
  installFixturePlugin,
  readFixtureRequirements,
  replaceCatalogSourcesConfig,
  readCatalogLogicalIdentity,
  configureCatalog,
  snapshotRegularTree,
  createCodexNativeTestRuntime,
  createNativeDependencyCatalog,
} from '../helpers/write-command-fixture.js';

function isReadOnlyCodexInvocation(invocation: NativeCliInvocation): boolean {
  const plugin = invocation.args.indexOf('plugin');
  return plugin >= 0 ? invocation.args[plugin + 1] === 'list'
    : invocation.args.includes('--version') || invocation.command === '/usr/bin/plutil' || /powershell/iu.test(invocation.command);
}

let controlledAppRoot: string | undefined;
function appIdentityQuery(invocation: NativeCliInvocation) {
  if (!controlledAppRoot) return undefined;
  if (invocation.command === '/usr/bin/plutil') return { exitCode: 0, stdout: 'com.openai.codex', stderr: '' };
  if (process.platform === 'win32' && /powershell/iu.test(invocation.command)) return { exitCode: 0, stderr: '',
    stdout: invocation.env?.AW_CODEX_DISCOVERY_PATH ? 'true'
      : JSON.stringify([{ family: 'OpenAI.Codex_fixture', root: controlledAppRoot, architecture: process.arch, version: '1.0.0' }]) };
  return undefined;
}

async function createDiscoveredCodexApp(isolation: ReturnType<typeof getCurrentSourceTestIsolation>): Promise<string> {
  const applications = path.join(isolation.layout.homeDir, 'Applications');
  const appRoot = path.join(applications, process.platform === 'win32' ? 'CodexPackage' : 'Codex.app');
  controlledAppRoot = appRoot;
  const command = process.platform === 'win32' ? path.join(appRoot, 'codex.exe')
    : path.join(appRoot, 'Contents', 'Resources', 'codex');
  await fs.outputFile(command, 'controlled native executable\n');
  await fs.chmod(command, 0o755);
  if (process.platform === 'darwin') await fs.outputFile(path.join(appRoot, 'Contents', 'Info.plist'), 'controlled identity\n');
  setCodexDiscoveryOverridesForTests({ macApplicationsDirectories: [applications], queryRunner: async (invocation) => ({
    exitCode: 0, stderr: '', stdout: process.platform === 'darwin' ? 'com.openai.codex'
      : invocation.env?.AW_CODEX_DISCOVERY_PATH ? 'true'
        : JSON.stringify([{ family: 'OpenAI.Codex_fixture', root: appRoot, architecture: process.arch, version: '1.0.0' }]),
  }) });
  return fs.realpath(command);
}

describe('five namespaced write commands', () => {
  let qualification: ReturnType<typeof installNativeTestQualification>;
  let codexLayout: Awaited<ReturnType<typeof getNativeTestLayout>>;
  let nativeId: string;
  let marketplaceName: string;
  afterEach(() => setCodexDiscoveryOverridesForTests({ macApplicationsDirectories: [],
    queryRunner: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }) }));
  beforeEach(async () => {
    controlledAppRoot = undefined;
    setCodexDiscoveryOverridesForTests({ macApplicationsDirectories: [],
      queryRunner: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }) });
    qualification = installNativeTestQualification({ discovery: true, trust: true });
    const isolation = getCurrentSourceTestIsolation();
    await fs.ensureDir(path.join(isolation.layout.fixtureCwd, '.git'));
    codexLayout = await getNativeTestLayout({ platform: 'codex', pluginId: 'team/demo',
      cwd: isolation.layout.fixtureCwd, env: isolation.env });
    nativeId = codexLayout.nativeIdentity.registrationId!;
    marketplaceName = codexLayout.marketplaceName!;
  });

  it('preserves the generated shared marketplace root during ordinary cleanup', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'orphan-root-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'demo\n', (manifest) => {
      manifest.extensions = {
        instructions: [{ name: 'policy', title: 'Policy', content: 'Managed policy.', coverage: ['main'] }],
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
    const nativeCliRunner = (await createCodexNativeTestRuntime(isolation)).nativeCliRunner;
    const installed = await installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const layout = await getNativeTestLayout({ platform: 'codex', pluginId: 'team/demo',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, sourceIdentity });
    const marketplaceRoot = layout.marketplaceRoot!;
    const otherLayout = await getNativeTestLayout({ platform: 'codex', pluginId: 'team/other',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, sourceIdentity });
    const otherConsumer = otherLayout.packageRoot;
    await fs.ensureDir(otherConsumer);
    const component = deploymentPackageComponent(otherLayout.binding, otherLayout);
    if (component.kind !== 'owned-directory') throw new Error('Expected package directory.');
    await writeSkillOwnerMarker({ skillRoot: otherConsumer, allowedRoot: component.allowedRoot,
      identity: component.identity });
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
    const nativeCliRunner = (await createCodexNativeTestRuntime(isolation)).nativeCliRunner;
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
      receiptTargets: [expect.objectContaining({ pluginId: 'local/demo', platform: 'codex', scope: 'user' })],
      rebuildResults: [expect.objectContaining({ status: 'succeeded', cleanupAttempted: false, actions: [], removed: [], residual: [] })],
    });
    const observations = nativeCliRunner.mock.calls.map(([invocation]) => invocation)
      .filter((invocation) => invocation.args.includes('list'));
    expect(observations.length).toBeGreaterThan(0);
    for (const invocation of observations) {
      expect(invocation.args).toEqual(expect.arrayContaining(['plugin', 'list', '--json']));
      expect(invocation.cwd).not.toBe(isolation.layout.fixtureCwd);
    }
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
      nativeCliRunner: (await createCodexNativeTestRuntime(isolation)).nativeCliRunner,
    };
    await expect(installFixturePlugin(['team/demo'], {
      cwd: isolation.layout.fixtureCwd, platform: 'codex', scope: 'project',
    }, runtime)).resolves.toMatchObject({ overallState: 'succeeded' });
    const layout = await getNativeTestLayout({ platform: 'codex', pluginId: 'team/demo',
      cwd: isolation.layout.fixtureCwd, env: isolation.env });
    const installedMarketplaceName = layout.marketplaceName!;
    const marketplaceRoot = layout.marketplaceRoot!;
    const before = await fs.readFile(path.join(marketplaceRoot, 'config.json'));
    await setPrimaryCatalogSourceCommand({
      sourceId: teamInitiallyPrimary ? 'other' : 'team',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });

    const status = await readRecoveryStatus({
      cwd: isolation.layout.fixtureCwd, env: isolation.env,
      cliVersion: '1.0.0', targets: ['codex'], scope: 'project',
      nativeCliRunner: runtime.nativeCliRunner,
    });
    expect(status.observedTargets).toEqual(expect.arrayContaining([expect.objectContaining({
      pluginId: 'team/demo', agent: 'codex', scope: 'project', content: 'satisfied', observation: 'verified',
    })]));
    expect(await fs.readFile(path.join(marketplaceRoot, 'config.json'))).toEqual(before);
    expect(JSON.parse(before.toString('utf8')).marketplaceName).toBe(installedMarketplaceName);
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
        manifest.extensions = { instructions: [{ name: 'codex-policy', title: 'Codex policy', content: 'Codex policy.', coverage: ['main'] }] };
      }),
      createCatalogSnapshotFixture(claudeRoot, 'claude-only', [], 'claude\n', (manifest) => {
        manifest.platforms = ['claude'];
        manifest.extensions = { instructions: [{ name: 'claude-policy', title: 'Claude policy', content: 'Claude policy.', coverage: ['main'] }] };
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
    const isClaudeInvocation = (invocation: NativeCliInvocation): boolean => invocation.agentKind === 'claude'
      || path.basename(invocation.command).replace(/\.(?:cmd|exe)$/iu, '') === 'claude'
      || invocation.args.some((arg) => arg.includes('@anthropic-ai') && arg.includes('claude-code'));
    const nativeCliRunner = vi.fn((invocation: NativeCliInvocation) => isClaudeInvocation(invocation)
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
      const execution = await createNativeTestExecution({ scope: options.scope, cwd: options.cwd, env: isolation.env,
        selectedTargets: commandSelectors.map((pluginId) => ({ pluginId, platform: pluginId.startsWith('codex/') ? 'codex' : 'claude' })) });
      const result = await timing.measure('command', command.name, async () => {
        try { return await command([...commandSelectors], options, { ...runtime, executionInput: execution.executionInput }); }
        finally { await execution.dispose(); }
      });
      expect(result, JSON.stringify({ overallState: result.overallState, targetResults: result.targetResults,
        deployments: result.rebuildResults.flatMap((entry) => entry.deploymentReceipts ?? []).map((receipt) => ({
          ownership: receipt.after.ownership, diagnostics: receipt.diagnostics.map((diagnostic) => diagnostic.code),
        })) })).toMatchObject({
        overallState: commandSelectors.length > 1 ? 'partial' : 'failed',
        targetResults: expect.arrayContaining([
          expect.objectContaining({ errorCode: 'externalOwnershipPresent' }),
        ]),
      });
      expect(nativeCliRunner.mock.calls.filter(([invocation]) => isClaudeInvocation(invocation))
        .every(([invocation]) => invocation.args.includes('--version') || invocation.args.includes('list'))).toBe(true);
      if (commandSelectors.length > 1) expect(result.targetResults).toEqual(expect.arrayContaining([
        expect.objectContaining({ target: expect.objectContaining({ platform: 'codex' }), state: 'completed' }),
      ]));
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
      'console.log(JSON.stringify({ version: 3, omitted: [], unmet: [], components: context.allowedOutputKinds.includes("skill") ? [{',
      '  id: `${context.platform}-mode`, kind: "skill", name: "mode-skill",',

      '  content: { files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, { text }])) }',
      '}] : [] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(dualRoot, 'config-dual', [], 'dual\n', (manifest) => {
      manifest.platforms = ['codex', 'claude'];
      manifest.config = {
        schemaVersion: 5,
        fields: { mode: { type: 'string', default: 'safe' } },
      };
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = { configKeys: ['mode'] };
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
    const nativeCliRunner = vi.fn((invocation: NativeCliInvocation) => claudeNativeRuntime.isClaudeInvocation(invocation)
      ? claudeNativeRuntime.nativeCliRunner(invocation) : codexNativeRuntime.nativeCliRunner(invocation));
    const runtime = { env: isolation.env, nativeCliRunner, codexManagerResolver: codexNativeRuntime.codexManagerResolver };
    const dualInstalled = await timing.measure('command', 'fixture install', () => installFixturePlugin(['dual/config-dual'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'project',
    }, runtime));
    expect(dualInstalled.overallState, JSON.stringify(dualInstalled.rebuildResults)).toBe('succeeded');
    const codexRuntime = path.join([...codexNativeRuntime.packageRoots.values()][0]!, 'skills', 'mode-skill', 'references', 'runtime.md');
    const claudeRuntime = path.join([...claudeNativeRuntime.packageRoots.values()][0]!, 'skills', 'mode-skill', 'references', 'runtime.md');
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
    }))).toBe(4);
    const applyReceipt = JSON.parse(captured.readStdout());
    expect(applyReceipt, JSON.stringify(applyReceipt)).toMatchObject({
      schemaVersion: 1, command: 'plugin.config.set', status: 'partial',
      data: {
        configWrite: 'succeeded',
        apply: {
          state: 'partial',
          targetResults: expect.arrayContaining([
            expect.objectContaining({
              target: expect.objectContaining({ platform: 'claude' }),
              state: 'failed',
            }),
          ]),
        }
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
    }))).toBe(4);
    expect(JSON.parse(lifecycleCaptured.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.sync', status: 'partial',
      data: {
        targetResults: expect.arrayContaining([
          expect.objectContaining({ target: 'codex', execution: 'no-op', observation: 'verified', content: 'satisfied',
            deploymentReceipts: [expect.objectContaining({ effects: [], unmet: [], reload: 'none' })] }),
          expect.objectContaining({ target: 'claude', execution: 'failed' }),
        ])
      },
    });
  }, 30_000);

  it('saves unused config without claiming a same-name unbound Claude record', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'claude-config-collision-source');
    await createCatalogSnapshotFixture(sourceRoot, 'config-native', [], 'config\n', (manifest) => {
      manifest.platforms = ['claude'];
      manifest.config = {
        schemaVersion: 5,
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
    const claudeLayout = await getNativeTestLayout({ platform: 'claude', pluginId: 'team/config-native',
      cwd: isolation.layout.fixtureCwd, env: isolation.env, scope: 'user' });
    const marketplaceRoot = claudeLayout.marketplaceRoot!;
    const marketplaceName = claudeLayout.marketplaceName!;
    const claudeId = claudeLayout.nativeIdentity.registrationId!;
    const sourceIdentity = await calculateCatalogSourceIdentity({
      id: 'team', type: 'path', primary: true, path: sourceRoot,
    });
    await fs.copy(sourceRoot, marketplaceRoot);
    await fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
      schemaVersion: 2,
      sourceId: 'team',
      sourceIdentity,
      marketplaceName,
    });
    for (const manifestPath of [
      path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
      path.join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    ]) {
      const manifest = await fs.readJson(manifestPath) as Record<string, unknown>;
      await fs.writeJson(manifestPath, { ...manifest, name: marketplaceName });
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
        [marketplaceName]: { source: { source: 'directory', path: marketplaceRoot } },
      },
      enabledPlugins: { [claudeId]: true },
    }, null, 2)}\n`);
    const installedBytes = Buffer.from(`${JSON.stringify({
      plugins: {
        [claudeId]: [{ name: 'config-native', scope: 'user', version: '1.0.0' }],
        'config-native': [{ name: 'config-native', scope: 'project', version: '9.9.9' }],
      },
    }, null, 2)}\n`);
    await Promise.all([
      fs.outputFile(settingsPath, settingsBytes),
      fs.outputFile(installedPath, installedBytes),
      fs.outputJson(knownPath, {
        [marketplaceName]: {
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
      schemaVersion: 1, command: 'plugin.config.set', status: 'success',
      data: {
        configWrite: 'succeeded',
        apply: { state: 'skipped', reason: 'noEffectiveConfigChange', targetResults: [] }
      },
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
        instructions: [{ name: 'dedupe', title: 'Dedupe', content: 'One write.', coverage: ['main'] }],
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
      nativeCliRunner: (await createCodexNativeTestRuntime(isolation)).nativeCliRunner,
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
      nativeCliRunner: (await createCodexNativeTestRuntime(isolation)).nativeCliRunner,
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
      nativeCliRunner: (await createCodexNativeTestRuntime(isolation)).nativeCliRunner,
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
          instructions: [{ name: 'first-policy', title: 'First', content: 'First.', coverage: ['main'] }],
        };
      }),
      createCatalogSnapshotFixture(secondRoot, 'demo', [], 'second\n', (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'second-policy', title: 'Second', content: 'Second.', coverage: ['main'] }],
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
    const nativeCliRunner = (await createCodexNativeTestRuntime(isolation)).nativeCliRunner;
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
    const firstLayout = await getNativeTestLayout({ platform: 'codex', pluginId: 'first/demo',
      cwd: isolation.layout.fixtureCwd, env: isolation.env });
    const secondLayout = await getNativeTestLayout({ platform: 'codex', pluginId: 'second/demo',
      cwd: isolation.layout.fixtureCwd, env: isolation.env });
    expect(firstLayout.packageRoot).not.toBe(secondLayout.packageRoot);
    expect(await fs.readFile(path.join(firstLayout.packageRoot, 'scripts', 'aw-instructions.mjs'), 'utf8')).toContain('First.');
    expect(await fs.readFile(path.join(secondLayout.packageRoot, 'scripts', 'aw-instructions.mjs'), 'utf8')).toContain('Second.');

  });

  it.each([
    ['user', 'system'], ['project', 'system'],
    ...((process.platform === 'darwin' || process.platform === 'win32') ? [['user', 'app'], ['project', 'app']] as const : []),
  ] as const)('reinstalls a mixed Codex plugin in %s and retries native failures with a %s CLI', async (scope, managerKind) => {
    // Test Value Gate: shared reinstall must preserve recovery evidence when native removal fails and allow a retry.
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'mixed-uninstall-source');
    await createNativeDependencyCatalog(sourceRoot, [{
      name: 'demo',
      configureManifest: (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'policy', title: 'Policy', content: 'Managed policy.', coverage: ['main'] }],
        };
      },
    }]);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const runtime = await createCodexNativeTestRuntime(isolation, managerKind === 'app' ? '0.151.0' : '0.200.0');
    isolation.env.PATH = isolation.env.PATH!.split(path.delimiter)[0]!;
    qualification.restore();
    installNativeTestQualification({ trust: true });
    const selectedCommand = managerKind === 'app' ? await createDiscoveredCodexApp(isolation) : process.execPath;
    const selectedLauncher = managerKind === 'app' ? selectedCommand : process.platform === 'win32'
      ? path.join(isolation.env.PATH!.split(path.delimiter)[0]!, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
      : await fs.realpath(path.join(isolation.env.PATH!.split(path.delimiter)[0]!, 'codex'));
    const originalRunner = runtime.nativeCliRunner.getMockImplementation()!;
    let failRemove = false;
    runtime.nativeCliRunner.mockImplementation(async (invocation) => {
      const query = appIdentityQuery(invocation); if (query) return query;
      if (managerKind === 'app' && invocation.command === selectedCommand && invocation.args.includes('--version')) {
        return { exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' };
      }
      const pluginArgs = invocation.args.slice(invocation.args.indexOf('plugin'));
      if (pluginArgs.join(' ') === `plugin remove ${nativeId}` && failRemove) {
        return { exitCode: 9, stdout: '', stderr: 'private native failure' };
      }
      return originalRunner(invocation);
    });
    const options = { cwd: isolation.layout.fixtureCwd, platform: 'codex', scope, yes: true } as const;
    const installed = await installWriteCommand(['team/demo'], options, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const configPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    const extensionConfigPath = scope === 'user'
      ? configPath : path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');
    const marketplaceRoot = codexLayout.marketplaceRoot!;
    const marketplaceBefore = await snapshotRegularTree(marketplaceRoot);
    const configBefore = await fs.readFile(extensionConfigPath);
    const packageBeforeFailure = await snapshotRegularTree(codexLayout.packageRoot);
    runtime.nativeCliRunner.mockClear();
    const appRoot = controlledAppRoot;
    if (appRoot) await fs.move(appRoot, `${appRoot}.offline`);
    const missing = await reinstallWriteCommand(['team/demo'], options, {
      env: { ...runtime.env, PATH: '' },
      nativeCliRunner: runtime.nativeCliRunner,
    });
    if (appRoot) await fs.move(`${appRoot}.offline`, appRoot);
    expect(missing.targetResults).toEqual([
      expect.objectContaining({ errorCode: 'platformUnavailable' }),
    ]);
    await expect(fs.readFile(extensionConfigPath)).resolves.toEqual(configBefore);
    await expect(snapshotRegularTree(marketplaceRoot)).resolves.toEqual(marketplaceBefore);
    expect(runtime.nativeCliRunner.mock.calls.every(([invocation]) =>
      !invocation.args.includes('plugin') || invocation.args.includes('list'))).toBe(true);
    expect(runtime.installed.has(nativeId)).toBe(true);

    failRemove = true;
    const writeRuntime = { env: runtime.env, nativeCliRunner: runtime.nativeCliRunner };
    runtime.nativeCliRunner.mockClear();
    const failed = await reinstallWriteCommand(['team/demo'], options, writeRuntime);
    expect(failed.overallState).toBe('partial');
    expect(failed.rebuildResults).toEqual(expect.arrayContaining([expect.objectContaining({
      status: 'failed', target: expect.objectContaining({ pluginId: 'team/demo', platform: 'codex', scope }),
      error: expect.objectContaining({ phase: 'native.write' }),
    })]));
    expect(runtime.nativeCliRunner.mock.calls.some(([invocation]) =>
      invocation.command === selectedCommand
      && invocation.args.slice(invocation.args.indexOf('plugin')).join(' ') === `plugin remove ${nativeId}`)).toBe(true);
    expect(runtime.installed.has(nativeId)).toBe(true);
    await expect(snapshotRegularTree(codexLayout.packageRoot)).resolves.toEqual(packageBeforeFailure);
    expect((await readCodexConfigFile(configPath)).snapshot.marketplaces[marketplaceName]).toBeDefined();
    const diagnostics = projectExecutionDiagnostics(failed, 'reinstall').diagnostics;
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'writeFailed', stage: 'native.write', omitted: { reason: 'unsupportedFormat' },
    }));
    // A nonzero host exit cannot prove no mutation. Keep the exact unfinished effect for recovery.
    expect(failed.rebuildResults.flatMap((result) => result.deploymentReceipts ?? []).flatMap((receipt) => receipt.effects))
      .toEqual(expect.arrayContaining([expect.objectContaining({ status: 'unknown', mutation: 'possible',
        diagnostics: [expect.objectContaining({ code: 'platformMutationFailed' })] })]));
    expect(JSON.stringify(diagnostics)).not.toContain('private native failure');

    failRemove = false;
    runtime.nativeCliRunner.mockClear();
    const retried = await reinstallWriteCommand(['team/demo'], options, writeRuntime);
    expect(retried.overallState, JSON.stringify(retried.rebuildResults)).toBe('succeeded');
    expect(runtime.installed.has(nativeId)).toBe(true);
    expect(runtime.nativeCliRunner.mock.calls.some(([invocation]) =>
      invocation.command === selectedCommand
      && invocation.args.slice(invocation.args.indexOf('plugin')).join(' ') === `plugin remove ${nativeId}`)).toBe(true);
    expect((await readCodexConfigFile(extensionConfigPath)).snapshot.plugins[nativeId]?.enabled).toBe(true);
    expect(runtime.nativeCliRunner.mock.calls.filter(([invocation]) => invocation.args.includes('plugin'))
      .every(([invocation]) => invocation.command === selectedCommand
        && (managerKind === 'app' || invocation.args[0] === selectedLauncher)
        || managerKind === 'system' && invocation.command === selectedLauncher && invocation.args[0] === 'plugin' && invocation.args[1] === 'list')).toBe(true);
    if (scope === 'user') {
      runtime.nativeCliRunner.mockClear();
      await uninstallWriteCommand(['team/demo'], options, writeRuntime);
      expect(runtime.nativeCliRunner.mock.calls.every(([invocation]) =>
        !invocation.args.includes('plugin') || invocation.args.includes('list'))).toBe(true);
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
    qualification.restore();
    installNativeTestQualification({ trust: true });
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
    isolateCodexAppDiscoveryQueries();
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
    })).toBe(4);
    expect(JSON.parse(output.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.install', status: 'partial',
      data: {
        request: { plugins: ['team/demo'], scope: 'user' },
        changes: { requirements: 'changed' },
        targetResults: [expect.objectContaining({
          target: 'codex', execution: 'not-run', blockerCodes: ['platformUnavailable'],
        })],
      },
      diagnostics: expect.arrayContaining([expect.objectContaining({
        code: 'platformUnavailable',
        subject: { pluginId: 'team/demo', target: 'codex', scope: 'user' },
      })]),
    });
    expect(output.readStderr()).toContain('platformUnavailable');
    expect(nativeCliRunner.mock.calls.every(([invocation]) =>
      invocation.agentKind === 'codex'
      && (invocation.args.includes('--version')
        || invocation.args.join(' ') === `plugin list --marketplace ${marketplaceName} --json`))).toBe(true);
    expect(nativeCliRunner.mock.calls.some(([invocation]) =>
      invocation.command.startsWith(oldRuntimeRoot)
      || invocation.args.some((argument) => argument.startsWith(oldRuntimeRoot)))).toBe(false);
    await expect(observeIntent({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    })).resolves.toMatchObject({ state: 'valid', value: { roots: [{ pluginId: 'team/demo' }] } });
    await expect(fs.pathExists(path.join(isolation.env.CODEX_HOME!, 'config.toml'))).resolves.toBe(false);
    await expect(fs.pathExists(codexLayout.marketplaceRoot!)).resolves.toBe(false);
    if (oldRuntimeBefore) {
      await expect(snapshotRegularTree(oldRuntimeRoot)).resolves.toEqual(oldRuntimeBefore);
    } else {
      await expect(fs.pathExists(path.join(isolation.env.AW_HOME!, 'runtimes', 'codex')))
        .resolves.toBe(false);
    }
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'selects a healthy newer App before an older PATH CLI can block native planning', async () => {
      qualification.restore();
      installNativeTestQualification({ trust: true });
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
      controlledAppRoot = appRoot;
      const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
        const query = appIdentityQuery(invocation); if (query) return query;
        if (invocation.args.at(-1) === '--version') {
          return { exitCode: 0, stdout: `codex-cli ${invocation.command === canonicalAppCommand ? '0.200.0' : '0.151.0'}`, stderr: '' };
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
        expect(listCalls.every(([invocation]) => [
          ...[...native.marketplaceRoots.keys()].map((name) => `plugin list --marketplace ${name} --json`),
          'plugin list --marketplace aw --json',
        ].includes(invocation.args.join(' '))), JSON.stringify(listCalls.map(([invocation]) => invocation.args))).toBe(true);
        expect(native.installed.has(nativeId)).toBe(true);
      } finally {
        setCodexDiscoveryOverridesForTests({ macApplicationsDirectories: [],
          queryRunner: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }) });
      }
    }, 30_000);

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    'requires a new Review when a discovered App changes the execution products and preserves offline cleanup', async () => {
    qualification.restore();
    installNativeTestQualification({ trust: true });
    // The reviewed product set is frozen. A newly discovered App requires another Review.
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'app-codex-source');
    await createNativeDependencyCatalog(sourceRoot, [{ name: 'demo' }]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
      expectedDigest: snapshot.digest, env: isolation.env });
    await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
      { ...createEmptyPreferences(), targets: ['codex'] });
    const native = await createCodexNativeTestRuntime(isolation, '0.167.0');
    isolation.env.PATH = isolation.env.PATH!.split(path.delimiter)[0]!;
    let appCommand: string | undefined;
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const query = appIdentityQuery(invocation); if (query) return query;
      if (appCommand && invocation.command === appCommand && invocation.args.includes('--version')) {
        return { exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' };
      }
      return native.nativeCliRunner(invocation);
    });
    const runtime = { env: isolation.env, nativeCliRunner };
    const request = { cwd: isolation.layout.fixtureCwd, env: isolation.env, scope: 'user' as const, targets: ['codex'], cliVersion: '1.0.0', yes: true };
    const reviewed = await prepareRecovery('install', ['team/demo'], request, runtime);
    const beforeApp = (reviewed.joint?.children ?? [reviewed]).flatMap((child) => child.nativeGroups)
      .flatMap((group) => group.preview.operationPlan?.deploymentPlans ?? []);
    expect(beforeApp.flatMap((plan) => plan.binding.consumers).map((product) => product.product),
      JSON.stringify(beforeApp.map((plan) => ({ binding: plan.binding, effects: plan.effects })))).toEqual(['cli']);
    appCommand = await createDiscoveredCodexApp(isolation);
    nativeCliRunner.mockClear();
    const stale = await executeRecovery(reviewed);
    expect(stale).toMatchObject({ ok: false, declarationChanged: false, outputsMayHaveChanged: false,
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'operationReviewStale' })]) });
    expect(nativeCliRunner.mock.calls.every(([invocation]) => isReadOnlyCodexInvocation(invocation))).toBe(true);
    await expect(fs.pathExists(codexLayout.packageRoot)).resolves.toBe(false);
    await expect(observeIntent({ scope: 'user', cwd: request.cwd, env: isolation.env })).resolves.toMatchObject({ state: 'absent' });

    const current = await prepareRecovery('install', ['team/demo'], request, runtime);
    const bindings = (current.joint?.children ?? [current]).flatMap((child) => child.nativeGroups).flatMap((group) => group.preview.operationPlan?.deploymentPlans ?? []);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.binding.consumers.map((product) => product.product).sort()).toEqual(['app', 'cli']);
    nativeCliRunner.mockClear();
    expect(await executeRecovery(current)).toMatchObject({ ok: true });
    const selectedCalls = nativeCliRunner.mock.calls.filter(([invocation]) => invocation.args.includes('plugin'))
      .map(([invocation]) => invocation);
    const selectedEntry = bindings[0]!.binding.consumers.find((product) => product.availability === 'available' && product.entry?.kind === 'cli')!.entry!;
    if (selectedEntry.kind !== 'cli') throw new Error('Expected a reviewed CLI entry.');
    const expectedCommand = selectedEntry.executable.endsWith('.js') ? process.execPath : selectedEntry.executable;
    expect(selectedCalls.every((invocation) => invocation.command === expectedCommand
      && (!selectedEntry.executable.endsWith('.js') || invocation.args[0] === selectedEntry.executable))).toBe(true);
    const add = selectedCalls.findIndex((invocation) => invocation.args.includes('add'));
    expect(add).toBeGreaterThanOrEqual(0);
    expect(selectedCalls.slice(0, add).some((invocation) => invocation.args.includes('list'))).toBe(true);
    expect(selectedCalls.slice(add + 1).some((invocation) => invocation.args.includes('list'))).toBe(true);
    const options = { cwd: request.cwd, platform: 'codex', scope: 'user' } as const;
    const blocked = await reinstallWriteCommand(['team/demo'], options, { ...runtime, directCli: true });
    expect(blocked.targetResults).toEqual([expect.objectContaining({ errorCode: 'sharedNativeImpactAuthorizationRequired' })]);
    const reinstalled = await reinstallWriteCommand(['team/demo'], { ...options, yes: true }, { ...runtime, directCli: true });
    expect(reinstalled.overallState, JSON.stringify(reinstalled.rebuildResults)).toBe('succeeded');

    const offlineRunner = vi.fn(async (_invocation: NativeCliInvocation) => {
      throw Object.assign(new Error('No local Codex CLI is available'), { code: 'ENOENT' });
    });
    const offline = { env: { ...isolation.env, PATH: '' }, nativeCliRunner: offlineRunner };
    const cleaned = await cleanupWriteCommand(['team/demo'], options, offline);
    expect(cleaned.overallState, JSON.stringify(cleaned.rebuildResults)).toBe('succeeded');
    expect(native.installed.has(nativeId)).toBe(true);
    expect(offlineRunner.mock.calls.every(([invocation]) => isReadOnlyCodexInvocation(invocation))).toBe(true);
    expect((await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml'))).snapshot.plugins[nativeId]?.enabled).not.toBe(true);
    await expect(fs.pathExists(codexLayout.packageRoot)).resolves.toBe(true);
    const configFile = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    const configBeforeUninstall = await fs.readFile(configFile);
    const packageBeforeUninstall = await snapshotRegularTree(codexLayout.packageRoot);
    const cacheRoot = path.join(isolation.env.CODEX_HOME!, 'plugins', 'cache', marketplaceName, 'demo');
    const cacheBeforeUninstall = await snapshotRegularTree(cacheRoot);
    const registeredBeforeUninstall = [...native.installed].sort();
    offlineRunner.mockClear();
    const blockedUninstall = await uninstallWriteCommand(['team/demo'], options, offline);
    expect(blockedUninstall).toMatchObject({ overallState: 'failed', targetResults: [expect.objectContaining({
      target: expect.objectContaining({ pluginId: 'team/demo', platform: 'codex', scope: 'user' }),
      state: 'failed', errorCode: 'platformUnavailable', message: 'platformUnavailable: client-missing',
    })] });
    await expect(fs.readFile(configFile)).resolves.toEqual(configBeforeUninstall);
    await expect(snapshotRegularTree(codexLayout.packageRoot)).resolves.toEqual(packageBeforeUninstall);
    await expect(snapshotRegularTree(cacheRoot)).resolves.toEqual(cacheBeforeUninstall);
    expect([...native.installed].sort()).toEqual(registeredBeforeUninstall);
    expect(offlineRunner.mock.calls.every(([invocation]) => isReadOnlyCodexInvocation(invocation))).toBe(true);
    expect(buildRebuildReceiptJson('uninstall', blockedUninstall).targetResults[0]?.recoveryActions)
      .toContain('run aw plugin sync team/demo --target codex --context user');
  }, 30_000);

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('replans with App CLI registration before shared replacement writes', async () => {
    qualification.restore();
    installNativeTestQualification({ trust: true });
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

    const appCommand = await createDiscoveredCodexApp(isolation);
    isolation.env.PATH = '';
    const configPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
    const cacheRoot = path.join(isolation.env.CODEX_HOME!, 'plugins', 'cache', marketplaceName, 'demo');
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      const query = appIdentityQuery(invocation); if (query) return query;
      if (invocation.args.includes('--version')) return { exitCode: 0,
        stdout: `codex-cli ${invocation.command === appCommand ? '0.201.0' : '0.200.0'}`, stderr: '' };
      return installedRuntime.nativeCliRunner(invocation);
    });
    const runtime = { env: isolation.env, nativeCliRunner, directCli: true };
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
    expect(blockedActions).not.toContain(`plugin remove ${nativeId}`);
    expect(blockedActions).not.toContain(`plugin add ${nativeId}`);
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
    expect(authorizedActions.indexOf(`plugin remove ${nativeId}`)).toBeGreaterThanOrEqual(0);
    expect(authorizedActions.indexOf(`plugin add ${nativeId}`))
      .toBeGreaterThan(authorizedActions.indexOf(`plugin remove ${nativeId}`));
    expect(nativeCliRunner.mock.calls.slice(callsBeforeAuthorized).some(([invocation]) =>
      invocation.command === appCommand
      && invocation.args.slice(invocation.args.indexOf('plugin')).join(' ')
        === `plugin list --marketplace ${marketplaceName} --json`)).toBe(true);
    await expect(fs.readJson(path.join(cacheRoot, '2.0.0', '.codex-plugin', 'plugin.json'))).resolves.toMatchObject({ version: '2.0.0' });
  }, 30_000);
});
