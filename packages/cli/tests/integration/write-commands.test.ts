import { describe, expect, it, vi } from 'vitest';

import {
  cleanupWriteCommand,
  installWriteCommand,
  reinstallWriteCommand,
  uninstallWriteCommand,
  upgradeWriteCommand,
} from '../../src/commands/write-commands.js';
import { setRebuildCommandTestHooksForTests } from '../../src/commands/rebuild-command.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { runCli } from '../../src/index.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import path from 'node:path';
import fs from 'fs-extra';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { calculateCatalogSourceIdentity } from '../../src/utils/catalog-source-identity.js';
import { readPluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  prepareLifecycleActiveSnapshot,
  promoteLifecycleActiveSnapshot,
  resolveLifecycleActiveTarget,
} from '../../src/utils/lifecycle-active-store.js';
import { updateCatalogSourceCommand } from '../../src/commands/catalog-source.js';
import { writeSkillOwnerMarker } from '../../src/utils/ownership.js';

async function configureCatalog(): Promise<ReturnType<typeof getCurrentSourceTestIsolation>> {
  const isolation = getCurrentSourceTestIsolation();
  const root = path.join(isolation.layout.fixtureCwd, 'write-source');
  await createCatalogSnapshotFixture(root);
  const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 1,
      sources: [{ id: 'local', type: 'path', primary: true, path: root }],
    },
    expectedDigest: snapshot.digest,
    env: isolation.env,
  });
  return isolation;
}

describe('five namespaced write commands', () => {
  it('executes a real dual-platform TUI write under one complete locked review', async () => {
    const isolation = getCurrentSourceTestIsolation();
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
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX', 'CLAUDE'];
      manifest.scripts = {
        artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
      };
      manifest.artifacts = {
        targets: (['codex', 'claude'] as const).map((platform) => ({
          id: `${platform}-review`,
          platform,
          scopes: ['project'],
          target: `${platform}.skill`,
          states: ['present'],
          refreshKeys: [],
          skillKey: 'review',
        })),
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async (invocation) => ({
        exitCode: 0,
        stdout: invocation.command === 'claude' ? 'claude 99.0.0' : 'codex-cli 99.0.0',
        stderr: '',
      }),
      interactive: false,
    }));
    const intent = {
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'team/demo',
      platform: 'both',
      scope: 'project',
    } as const;
    await dependencies.validateIntent!(intent, new AbortController().signal);
    const evidence = await dependencies.captureEvidence(intent);

    const result = await dependencies.executeIntent(intent, evidence) as Awaited<ReturnType<typeof installWriteCommand>>;

    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ platform: 'codex', scope: 'project' }) }),
      expect.objectContaining({ target: expect.objectContaining({ platform: 'claude', scope: 'project' }) }),
    ]));
    expect(result.targetResults.map((target) => target.errorCode)).not.toContain('operationReviewStale');
  });

  it('blocks a reviewed install when the other scope is installed concurrently', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-scope-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = {
        instructions: [{ name: 'review', title: 'Review', content: 'scope evidence' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' });
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner,
      interactive: false,
    })));
    const review = await controller.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'team/demo',
      platform: 'codex',
      scope: 'user',
    });
    const concurrent = await installWriteCommand(['team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(concurrent.overallState).toBe('succeeded');

    const result = await controller.executeOperation(review.reviewToken);

    expect(result).toMatchObject({ state: 'blocked', code: 'scopeConflict' });
    expect(controller.snapshot.router.current.route).toEqual({ name: 'home' });
    controller.dispose();
  });

  it('returns a new Review when the real write bridge detects changed source and target evidence under its operation lock', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'review-stale-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = {
        instructions: [{ name: 'review', title: 'Review', content: 'must not be written' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const controller = new TuiController(createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
      interactive: false,
    })));
    let hookRuns = 0;
    setRebuildCommandTestHooksForTests({
      async afterTargetBuilt({ identity }) {
        hookRuns += 1;
        const target = await resolveLifecycleActiveTarget({
          sourceId: identity.sourceId,
          sourceIdentity: identity.sourceIdentity,
          pluginName: identity.pluginName,
          platform: identity.platform,
          scope: identity.scope,
          cwd: identity.cwd,
          env: isolation.env,
        });
        await expect(fs.pathExists(target.operationLockPath)).resolves.toBe(true);
        await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'changed\n', (manifest) => {
          manifest.marketplace.policy.products = ['CODEX'];
          manifest.extensions = {
            instructions: [{ name: 'review', title: 'Review', content: 'changed content' }],
          };
        });
      },
    });
    try {
      const review = await controller.buildOperationReview({
        kind: 'pluginWrite',
        action: 'install',
        pluginId: 'team/demo',
        platform: 'codex',
        scope: 'project',
      });
      const result = await controller.executeOperation(review.reviewToken);

      expect(result, JSON.stringify(result)).toMatchObject({
        state: 'stale',
        review: { title: '添加插件' },
      });
      expect(hookRuns).toBe(1);
      await expect(fs.pathExists(path.join(
        isolation.layout.fixtureCwd,
        '.codex',
        'config.toml',
      ))).resolves.toBe(false);
    } finally {
      setRebuildCommandTestHooksForTests(undefined);
      controller.dispose();
    }
  });

  it('removes the generated marketplace root only after the last platform consumer', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'orphan-root-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.extensions = {
        instructions: [{ name: 'policy', title: 'Policy', content: 'Managed policy.' }],
      };
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const nativeCliRunner = async (invocation: NativeCliInvocation) => ({
      exitCode: 0,
      stdout: invocation.command === 'claude' ? 'claude 99.0.0' : 'codex-cli 99.0.0',
      stderr: '',
    });
    const installed = await installWriteCommand(['team/demo'], {
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
      isolation.env.AW_CLAUDE_HOME!,
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
    await expect(fs.pathExists(marketplaceRoot)).resolves.toBe(false);

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

  it('runs every command through the same namespaced runtime', async () => {
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
      await installWriteCommand(['demo'], options, runtime),
      await upgradeWriteCommand(['demo'], options, runtime),
      await reinstallWriteCommand(['demo'], options, runtime),
      await uninstallWriteCommand(['demo'], options, runtime),
      await cleanupWriteCommand(['demo'], options, runtime),
    ];

    for (const result of results) {
      expect(result).toMatchObject({
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
    expect(nativeCliRunner).toHaveBeenCalled();
    expect(report).toHaveBeenCalled();
  });

  it('treats platform both as every platform supported by each selected plugin', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const codexRoot = path.join(isolation.layout.fixtureCwd, 'codex-source');
    const claudeRoot = path.join(isolation.layout.fixtureCwd, 'claude-source');
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
    await Promise.all([
      createCatalogSnapshotFixture(codexRoot, 'codex-only', '0.0.0', 'codex\n', (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
      }),
      createCatalogSnapshotFixture(claudeRoot, 'claude-only', '0.0.0', 'claude\n', (manifest) => {
        manifest.marketplace.policy.products = ['CLAUDE'];
      }),
      createCatalogSnapshotFixture(dualRoot, 'config-dual', '0.0.0', 'dual\n', (manifest) => {
        manifest.marketplace.policy.products = ['CODEX', 'CLAUDE'];
        manifest.config = {
          schema: { mode: { type: 'enum', values: ['safe', 'fast'], default: 'safe' } },
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
      }),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [
          { id: 'codex', type: 'path', primary: true, path: codexRoot },
          { id: 'claude', type: 'path', primary: false, path: claudeRoot },
          { id: 'dual', type: 'path', primary: false, path: dualRoot },
        ],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const marketplaceRoots = new Map<string, string>();
    const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
      if (invocation.command === 'claude' && invocation.args[0] === 'plugin') {
        const pluginsDir = path.join(isolation.env.AW_CLAUDE_HOME!, 'plugins');
        const scopeIndex = invocation.args.indexOf('--scope');
        const scope = scopeIndex === -1 ? 'user' : invocation.args[scopeIndex + 1]!;
        const projectPath = await fs.realpath(invocation.cwd ?? isolation.layout.fixtureCwd);
        const settingsPath = scope === 'project'
          ? path.join(projectPath, '.claude', 'settings.json')
          : path.join(isolation.env.AW_CLAUDE_HOME!, 'settings.json');
        const knownPath = path.join(pluginsDir, 'known_marketplaces.json');
        const installedPath = path.join(pluginsDir, 'installed_plugins.json');
        if (invocation.args[1] === 'marketplace' && invocation.args[2] === 'add') {
          const marketplaceRoot = invocation.args[3]!;
          const config = await fs.readJson(path.join(marketplaceRoot, 'config.json')) as {
            marketplaceName: string;
          };
          marketplaceRoots.set(config.marketplaceName, marketplaceRoot);
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          const extraKnownMarketplaces = (settings.extraKnownMarketplaces ?? {}) as Record<string, unknown>;
          extraKnownMarketplaces[config.marketplaceName] = {
            source: { source: 'directory', path: marketplaceRoot },
          };
          await fs.outputJson(settingsPath, { ...settings, extraKnownMarketplaces });
          const known = await fs.readJson(knownPath).catch(() => ({})) as Record<string, unknown>;
          known[config.marketplaceName] = {
            source: { source: 'directory', path: marketplaceRoot },
            installLocation: marketplaceRoot,
          };
          await fs.outputJson(knownPath, known);
        }
        if (invocation.args[1] === 'install') {
          const pluginId = invocation.args[2]!;
          const separator = pluginId.lastIndexOf('@');
          const pluginName = pluginId.slice(0, separator);
          const marketplaceName = pluginId.slice(separator + 1);
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          const enabledPlugins = (settings.enabledPlugins ?? {}) as Record<string, unknown>;
          enabledPlugins[pluginId] = true;
          await fs.outputJson(settingsPath, { ...settings, enabledPlugins });
          const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} })) as {
            plugins?: Record<string, unknown>;
          };
          await fs.outputJson(installedPath, {
            plugins: {
              ...(installed.plugins ?? {}),
              [pluginId]: [{
                name: pluginName,
                marketplace: marketplaceName,
                scope,
                ...(scope === 'project' ? { projectPath } : {}),
                version: '1.0.0',
              }],
            },
          });
          await fs.ensureDir(path.join(marketplaceRoots.get(marketplaceName)!, 'plugins', pluginName));
        }
        if (invocation.args[1] === 'uninstall') {
          const pluginId = invocation.args[2]!;
          const settings = await fs.readJson(settingsPath).catch(() => ({})) as Record<string, unknown>;
          const enabledPlugins = (settings.enabledPlugins ?? {}) as Record<string, unknown>;
          delete enabledPlugins[pluginId];
          await fs.outputJson(settingsPath, { ...settings, enabledPlugins });
          const installed = await fs.readJson(installedPath).catch(() => ({ plugins: {} })) as {
            plugins?: Record<string, unknown>;
          };
          const plugins = installed.plugins ?? {};
          delete plugins[pluginId];
          await fs.outputJson(installedPath, { plugins });
        }
      }
      return { exitCode: 0, stdout: 'agent-cli 99.0.0', stderr: '' };
    });
    const runtime = { env: isolation.env, nativeCliRunner };
    const options = {
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'user',
    } as const;
    const selectors = ['codex/codex-only', 'claude/claude-only'];

    for (const command of [installWriteCommand, upgradeWriteCommand]) {
      const result = await command(selectors, options, runtime);
      expect(result).toMatchObject({
        overallState: 'succeeded',
        receiptTargets: expect.arrayContaining([
          expect.objectContaining({ pluginId: 'codex/codex-only', platform: 'codex' }),
          expect.objectContaining({ pluginId: 'claude/claude-only', platform: 'claude' }),
        ]),
      });
      expect(result.receiptTargets).toHaveLength(2);
    }

    for (const [selector, platform] of [
      ['codex/codex-only', 'codex'],
      ['claude/claude-only', 'claude'],
    ] as const) {
      const result = await reinstallWriteCommand([selector], options, runtime);
      expect(result).toMatchObject({
        overallState: 'succeeded',
        receiptTargets: [expect.objectContaining({ pluginId: selector, platform })],
      });
    }

    const unsupported = await installWriteCommand(['codex/codex-only'], {
      ...options,
      platform: 'claude',
    }, runtime);
    expect(unsupported).toMatchObject({
      overallState: 'failed',
      receiptTargets: [expect.objectContaining({
        pluginId: 'codex/codex-only',
        platform: 'claude',
      })],
    });

    const dualInstalled = await installWriteCommand(['dual/config-dual'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'project',
    }, runtime);
    expect(dualInstalled.overallState, JSON.stringify(dualInstalled.rebuildResults)).toBe('succeeded');
    const codexRuntime = path.join(
      isolation.layout.fixtureCwd,
      '.agents',
      'skills',
      'mode-skill',
      'references',
      'runtime.md',
    );
    const claudeRuntime = path.join(
      isolation.layout.fixtureCwd,
      '.claude',
      'skills',
      'mode-skill',
      'references',
      'runtime.md',
    );
    expect(await fs.readFile(codexRuntime, 'utf8')).toBe('mode=safe\n');
    expect(await fs.readFile(claudeRuntime, 'utf8')).toBe('mode=safe\n');

    const captured = createCapturedCliIo();
    expect(await runCli([
      'config', 'set', 'dual/config-dual', 'mode', 'fast', '--scope', 'project', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner,
    })).toBe(1);
    expect(JSON.parse(captured.readStdout())).toMatchObject({
      configWrite: 'rolledBack',
      overallState: 'failed',
      targetResults: expect.arrayContaining([
        expect.objectContaining({ target: expect.objectContaining({ platform: 'codex' }) }),
        expect.objectContaining({ target: expect.objectContaining({ platform: 'claude' }) }),
      ]),
    });
    expect(await fs.readFile(codexRuntime, 'utf8')).toBe('mode=safe\n');
    expect(await fs.readFile(claudeRuntime, 'utf8')).toBe('mode=safe\n');
  });

  it('deduplicates bare, qualified, and repeated selectors by canonical target identity', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'dedupe-source');
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.extensions = {
        instructions: [{ name: 'dedupe', title: 'Dedupe', content: 'One write.' }],
      };
    });
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
        sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });

    const result = await installWriteCommand(['demo', 'team/demo', 'team/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
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

  it('accepts upgrade --all when no live namespaced targets exist', async () => {
    const isolation = await configureCatalog();
    const result = await upgradeWriteCommand([], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'both',
      scope: 'user',
      all: true,
    });
    expect(result.overallState).toBe('succeeded');
    expect(result.warnings).toEqual([]);
    expect(result.receiptTargets).toEqual([]);
  });

  it('public uninstall rejects an orphan lifecycle snapshot when only an empty marketplace is live', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'orphan-lifecycle-source');
    const pluginRoot = path.join(sourceRoot, 'plugins', 'demo');
    await fs.outputFile(
      path.join(pluginRoot, 'scripts', 'uninstall.mjs'),
      'await import("node:fs/promises").then((fs) => fs.writeFile("uninstall-ran", "ran"));\n',
    );
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.scripts = {
        lifecycle: {
          uninstall: { default: { runner: 'node', path: './scripts/uninstall.mjs' } },
        },
      };
    });
    const source = { id: 'team', type: 'path', primary: true, path: await fs.realpath(sourceRoot) } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    plugin.sourceId = 'team';
    plugin.sourceIdentity = sourceIdentity;
    plugin.pluginId = 'team/demo';
    const prepared = await prepareLifecycleActiveSnapshot({
      sourceId: 'team',
      sourceIdentity,
      plugin,
      platform: 'codex',
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      artifacts: [],
      env: isolation.env,
      loadPlugin: (bundleRoot) => readPluginManifest(bundleRoot, { mode: 'bundle' }),
    });
    expect(prepared.status).toBe('staged');
    await promoteLifecycleActiveSnapshot(prepared);
    const marketplaceRoot = path.join(isolation.env.AW_HOME!, 'marketplaces', 'team');
    await Promise.all([
      fs.outputJson(path.join(marketplaceRoot, 'config.json'), {
        schemaVersion: 2, sourceId: 'team', sourceIdentity, marketplaceName: 'aw-team',
      }),
      fs.outputJson(path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'), {
        name: 'aw-team',
      }),
      fs.outputFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'), [
        '[marketplaces.aw-team]',
        `source = ${JSON.stringify(marketplaceRoot)}`,
        'source_type = "local"',
        '',
      ].join('\n')),
    ]);
    const captured = createCapturedCliIo();

    expect(await runCli([
      'uninstall', 'team/demo', '--platform', 'codex', '--scope', 'user', '--json',
    ], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      io: captured.io,
      interactive: false,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    })).toBe(1);
    const payload = JSON.parse(captured.readStdout());
    expect(payload.errors).toEqual([]);
    expect(payload).toMatchObject({
      overallState: 'failed',
      targets: [expect.objectContaining({ errorCode: 'liveOwnershipRequired' })],
    });
    await expect(fs.pathExists(path.join(isolation.layout.fixtureCwd, 'uninstall-ran'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(
      isolation.env.AW_HOME!, 'lifecycle-active', 'team', 'codex', 'user', 'user', 'demo', 'active',
    ))).resolves.toBe(true);
  });

  it('keeps safely separable same-name project instruction owners namespaced', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'first-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'second-source');
    await Promise.all([
      createCatalogSnapshotFixture(firstRoot, 'demo', '0.0.0', 'first\n', (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'first-policy', title: 'First', content: 'First.' }],
        };
      }),
      createCatalogSnapshotFixture(secondRoot, 'demo', '0.0.0', 'second\n', (manifest) => {
        manifest.extensions = {
          instructions: [{ name: 'second-policy', title: 'Second', content: 'Second.' }],
        };
      }),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 1,
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

    const installed = await installWriteCommand(['first/demo', 'second/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'project',
    }, { env: isolation.env, nativeCliRunner });
    expect(installed).toMatchObject({ overallState: 'succeeded' });
    const config = await fs.readFile(path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml'), 'utf8');
    expect(config).toContain('First.');
    expect(config).toContain('Second.');
    expect(nativeCliRunner).toHaveBeenCalledTimes(1);
  });

  it('replays public namespaced config writes and rolls the store back when rendering fails', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'config-replay-source');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'demo', 'scripts', 'render.mjs'), [
      'import { readFile } from "node:fs/promises";',
      'const context = JSON.parse(await readFile(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
      'const mode = context.config.values.mode ?? "safe";',
      'if (mode === "fail") throw new Error("renderer requested failure");',
      'console.log(JSON.stringify({ version: 2, artifacts: [{',
      '  id: "instruction", kind: "instruction", platform: "codex",',
      '  target: "codex.developerInstructionsBlock", state: "present",',
      '  refreshKeys: ["mode"], content: `mode=${mode}`',
      '}] }));',
    ].join('\n'));
    await createCatalogSnapshotFixture(sourceRoot, 'demo', '0.0.0', 'demo\n', (manifest) => {
      manifest.config = {
        schema: {
          mode: { type: 'enum', values: ['safe', 'fast', 'fail'], default: 'safe' },
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
      manifest.marketplace.policy.products = ['CODEX'];
    });
    const source = { id: 'team', type: 'path', primary: true, path: sourceRoot } as const;
    const sourceIdentity = await calculateCatalogSourceIdentity(source);
    const before = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 1, sources: [source] },
      expectedDigest: before.digest,
      env: isolation.env,
    });
    const nativeCliRunner = vi.fn(async () => ({
      exitCode: 0,
      stdout: 'codex-cli 0.200.0',
      stderr: '',
    }));
    const runPublic = async (args: string[]) => {
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
        payload: JSON.parse(captured.readStdout()) as Record<string, unknown>,
        stderr: captured.readStderr(),
      };
    };
    const readStore = () => readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity,
      pluginName: 'demo',
      scope: 'project',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    });
    const configPath = path.join(isolation.layout.fixtureCwd, '.codex', 'config.toml');

    expect(await runPublic([
      'install', 'team/demo', '--platform', 'codex', '--scope', 'project',
    ])).toMatchObject({ exitCode: 0, payload: { overallState: 'succeeded' } });
    expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

    const set = await runPublic([
      'config', 'set', 'team/demo', 'mode', 'fast', '--scope', 'project',
    ]);
    expect(set).toMatchObject({
      exitCode: 0,
      payload: { configWrite: 'succeeded', overallState: 'succeeded' },
    });
    expect((await readStore()).values).toEqual({ mode: 'fast' });
    expect(await fs.readFile(configPath, 'utf8')).toContain('mode=fast');

    const unset = await runPublic([
      'config', 'unset', 'team/demo', 'mode', '--scope', 'project',
    ]);
    expect(unset).toMatchObject({
      exitCode: 0,
      payload: { configWrite: 'succeeded', overallState: 'succeeded' },
    });
    expect((await readStore()).values).toEqual({});
    expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

    await runPublic(['config', 'set', 'team/demo', 'mode', 'fast', '--scope', 'project']);
    const reset = await runPublic([
      'config', 'reset', 'team/demo', '--scope', 'project', '--yes',
    ]);
    expect(reset).toMatchObject({
      exitCode: 0,
      payload: { configWrite: 'succeeded', overallState: 'succeeded', deleted: true },
    });
    expect((await readStore()).exists).toBe(false);
    expect(await fs.readFile(configPath, 'utf8')).toContain('mode=safe');

    await runPublic(['config', 'set', 'team/demo', 'mode', 'fast', '--scope', 'project']);
    const failed = await runPublic([
      'config', 'set', 'team/demo', 'mode', 'fail', '--scope', 'project',
    ]);
    expect(failed).toMatchObject({
      exitCode: 1,
      payload: { configWrite: 'rolledBack', overallState: 'failed' },
    });
    expect((await readStore()).values).toEqual({ mode: 'fast' });
    const configAfterFailure = await fs.readFile(configPath, 'utf8');
    expect(configAfterFailure).toContain('mode=fast');
    expect(configAfterFailure).not.toContain('mode=fail');
  });
});
