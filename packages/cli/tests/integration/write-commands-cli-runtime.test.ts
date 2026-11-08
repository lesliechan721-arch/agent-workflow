import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { describe, beforeEach, expect, it, vi } from 'vitest';
import { createClaudeNativeTestRuntime } from '../helpers/claude-native-fixture.js';
import { realpath } from 'node:fs/promises';
import { render } from 'ink-testing-library';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { statusCommandV8 } from '../../src/commands/status-v6.js';
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
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { CodexManagerError } from '../../src/utils/codex-manager.js';
import { setCodexDiscoveryOverridesForTests } from '../../src/utils/codex-executable-discovery.js';
import { applyCodexConfigTransactionFile, readCodexConfigFile } from '../../src/utils/codex-config.js';

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

describe('five namespaced write commands', () => {
  beforeEach(async () => {
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
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
          expect.objectContaining({ target: 'codex', execution: 'applied' }),
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
      schemaVersion: 1, command: 'plugin.config.set', status: 'success',
      data: {
        configWrite: 'succeeded',
        apply: { state: 'skipped', reason: 'noVisibleTarget', targetResults: [] }
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
    })).toBe(4);
    expect(JSON.parse(output.readStdout())).toMatchObject({
      schemaVersion: 1, command: 'plugin.install', status: 'partial',
      data: {
        request: { plugins: ['team/demo'], scope: 'user' },
        changes: { requirements: 'changed' },
        targetResults: [expect.objectContaining({
          target: 'codex', execution: 'failed', blockerCodes: ['codexCliNotFound'],
        })],
      },
      diagnostics: expect.arrayContaining([expect.objectContaining({
        code: 'codexCliNotFound',
        subject: { pluginId: 'team/demo', target: 'codex', scope: 'user' },
      })]),
    });
    expect(output.readStderr()).toContain('codexCliNotFound');
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
});
