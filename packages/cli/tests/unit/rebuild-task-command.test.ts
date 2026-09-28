import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';

import {
  runRebuildCommand,
  setRebuildCommandTestHooksForTests,
} from '../../src/commands/rebuild-command.js';
import {
  installWriteCommand,
  reinstallWriteCommand,
  syncWriteCommand,
  taskWriteCommand,
} from '../../src/commands/write-commands.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { addProjectRequirements } from '../../src/project/project-commands.js';
import { readNativeIntentProjection } from '../../src/project/project-demand.js';
import { readPluginIntentState } from '../../src/utils/plugin-intent-state.js';
import {
  applyCodexConfigTransactionFile,
  readCodexConfigFile,
  removeCodexMarketplace,
} from '../../src/utils/codex-config.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function configureTaskCatalog(): Promise<{
  cwd: string;
  env: NodeJS.ProcessEnv;
}> {
  const isolation = getCurrentSourceTestIsolation();
  const root = path.join(isolation.layout.fixtureCwd, 'rebuild-task-source');
  await createDependencyCatalogSnapshotFixture(root, [
    { name: 'alpha' },
    { name: 'beta' },
    { name: 'root', dependencies: ['alpha'] },
    {
      name: 'broken',
      configureManifest: (manifest) => {
        manifest.scripts = { preApply: { path: './scripts/fail.mjs' } };
      },
    },
    { name: 'consumer', dependencies: ['broken'] },
    { name: 'a', dependencies: ['z'] },
    {
      name: 'z',
      configureManifest: (manifest) => {
        manifest.scripts = { preApply: { path: './scripts/count.mjs' } };
      },
    },
    {
      name: 'native',
      configureManifest: (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.skills = './skills';
        manifest.extensions = undefined;
      },
    },
  ]);
  await fs.outputFile(
    path.join(root, 'plugins', 'broken', 'scripts', 'fail.mjs'),
    'throw new Error("planned failure");\n',
  );
  await fs.outputFile(
    path.join(root, 'plugins', 'native', 'skills', 'native-skill', 'SKILL.md'),
    '---\nname: native-skill\ndescription: Native test skill.\n---\n',
  );
  await fs.outputFile(
    path.join(root, 'plugins', 'native', 'skills', 'native-skill', 'agents', 'openai.yaml'),
    'policy:\n  allow_implicit_invocation: true\n',
  );
  await fs.outputFile(
    path.join(root, 'plugins', 'z', 'scripts', 'count.mjs'),
    [
      'import { readFile, writeFile } from "node:fs/promises";',
      'const file = `${process.env.AW_HOME}/z-pre-apply-count.txt`;',
      'const count = Number(await readFile(file, "utf8").catch(() => "0"));',
      'await writeFile(file, String(count + 1));',
    ].join('\n'),
  );
  await createDependencyCatalogSnapshotFixture(root, [
    { name: 'alpha' },
    { name: 'beta' },
    { name: 'root', dependencies: ['alpha'] },
    {
      name: 'broken',
      configureManifest: (manifest) => {
        manifest.scripts = { preApply: { path: './scripts/fail.mjs' } };
      },
    },
    { name: 'consumer', dependencies: ['broken'] },
    { name: 'a', dependencies: ['z'] },
    {
      name: 'z',
      configureManifest: (manifest) => {
        manifest.scripts = { preApply: { path: './scripts/count.mjs' } };
      },
    },
    {
      name: 'native',
      configureManifest: (manifest) => {
        manifest.marketplace.policy.products = ['CODEX'];
        manifest.skills = './skills';
        manifest.extensions = undefined;
      },
    },
  ]);
  const current = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: root }],
    },
    expectedDigest: current.digest,
    env: isolation.env,
  });
  await syncCatalogSourceGeneration({
    sourceId: 'team',
    cliVersion: '1.0.0',
    env: isolation.env,
  });
  return { cwd: isolation.layout.fixtureCwd, env: isolation.env };
}

function createCodexNativeRunner(cwd: string, env: NodeJS.ProcessEnv) {
  const installed = new Set<string>();
  const installedVersions = new Map<string, string>();
  const marketplaceRoots = new Map<string, string>();
  const userConfigPath = path.join(env.AW_CODEX_HOME!, 'config.toml');
  return vi.fn(async (invocation: NativeCliInvocation) => {
    const args = invocation.args;
    if (args.includes('--version')) {
      return { exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' };
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
      await fs.copy(marketplacePluginRoot, path.join(
        env.AW_CODEX_HOME!,
        'plugins',
        'cache',
        marketplaceName,
        pluginName,
        pluginVersion,
      ), { overwrite: true });
      await applyCodexConfigTransactionFile(userConfigPath, {
        upsertPluginActivations: { [pluginId]: true },
      });
    }
    if (pluginArgs[1] === 'list' && pluginArgs.includes('--json')) {
      const [user, project] = await Promise.all([
        readCodexConfigFile(userConfigPath),
        readCodexConfigFile(path.join(cwd, '.codex', 'config.toml')),
      ]);
      const marketplaceName = pluginArgs[pluginArgs.indexOf('--marketplace') + 1];
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          installed: [...installed].filter((pluginId) =>
            pluginId.endsWith(`@${marketplaceName}`)).map((pluginId) => ({
            pluginId,
            installed: true,
            enabled: user.snapshot.plugins[pluginId]?.enabled === true
              || project.snapshot.plugins[pluginId]?.enabled === true,
            version: installedVersions.get(pluginId) ?? '1.0.0',
          })),
          available: [],
        }),
        stderr: '',
      };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

function createClaudeNativeRunner(cwd: string, env: NodeJS.ProcessEnv) {
  const marketplaceRoots = new Map<string, string>();
  return vi.fn(async (invocation: NativeCliInvocation) => {
    if (invocation.command !== 'claude' || invocation.args[0] !== 'plugin') {
      return { exitCode: 0, stdout: 'claude 99.0.0', stderr: '' };
    }
    const scopeIndex = invocation.args.indexOf('--scope');
    const scope = scopeIndex === -1 ? 'user' : invocation.args[scopeIndex + 1]!;
    const projectPath = await fs.realpath(invocation.cwd ?? cwd);
    const settingsPath = scope === 'project'
      ? path.join(projectPath, '.claude', 'settings.json')
      : path.join(env.AW_CLAUDE_HOME!, 'settings.json');
    const pluginsDir = path.join(env.AW_CLAUDE_HOME!, 'plugins');
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
      await fs.outputJson(installedPath, {
        plugins: {
          ...(installed.plugins ?? {}),
          [pluginId]: [{
            name: pluginName,
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
    return { exitCode: 0, stdout: 'claude 99.0.0', stderr: '' };
  });
}

describe('rebuild task command', () => {
  it('keeps mixed root methods and scopes in one plan and one execution', async () => {
    const { cwd, env } = await configureTaskCatalog();
    const targets = [
      { pluginId: 'team/alpha', platform: 'claude', scope: 'user', method: 'sync' },
      { pluginId: 'team/beta', platform: 'claude', scope: 'project', method: 'reinstall' },
    ] as const;
    const runtime = {
      env,
      nativeCliRunner: vi.fn(async () => ({
        exitCode: 0,
        stdout: 'claude 99.0.0',
        stderr: '',
      })),
    };

    const preview = await taskWriteCommand(targets, { cwd }, {
      ...runtime,
      previewOperationPlan: true,
    });

    expect(preview.operationPlan, JSON.stringify(preview.targetResults)).toBeDefined();
    expect(preview.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'team/alpha', platform: 'claude', requestedScope: 'user', action: 'install',
      }),
      expect.objectContaining({
        pluginId: 'team/beta', platform: 'claude', requestedScope: 'project', action: 'reinstall',
      }),
    ]));

    const built = vi.fn();
    setRebuildCommandTestHooksForTests({ afterTargetBuilt: built });
    const executed = await taskWriteCommand(targets, { cwd }, runtime);
    setRebuildCommandTestHooksForTests(undefined);

    expect(executed.operationPlan).toBeDefined();
    expect(executed.rebuildResults.map((result) => result.target)).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/alpha', scope: 'user' }),
      expect.objectContaining({ pluginId: 'team/beta', scope: 'project' }),
    ]));
    expect(built).toHaveBeenCalledTimes(2);
    expect(built.mock.calls.map(([call]) => ({
      command: call.command,
      pluginId: call.identity.pluginId,
      scope: call.identity.scope,
    }))).toEqual([
      { command: 'sync', pluginId: 'team/alpha', scope: 'user' },
      { command: 'reinstall', pluginId: 'team/beta', scope: 'project' },
    ]);
  });

  it('keeps the public sync writer behavior', async () => {
    const { cwd, env } = await configureTaskCatalog();
    const result = await syncWriteCommand(['team/alpha'], {
      cwd,
      platform: 'claude',
      scope: 'project',
    }, {
      env,
      previewOperationPlan: true,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'claude 99.0.0', stderr: '' }),
    });

    expect(result.operationPlan, JSON.stringify(result.targetResults)).toBeDefined();
    expect(result.dependencyPlan?.targets).toEqual([
      expect.objectContaining({
        pluginId: 'team/alpha', platform: 'claude', resolvedScope: 'project', action: 'install',
      }),
    ]);
  });

  it('keeps two scopes for the same plugin as exact roots', async () => {
    const { cwd, env } = await configureTaskCatalog();
    const result = await taskWriteCommand([
      { pluginId: 'team/alpha', platform: 'claude', scope: 'user', method: 'sync' },
      { pluginId: 'team/alpha', platform: 'claude', scope: 'project', method: 'reinstall' },
    ], { cwd }, {
      env,
      previewOperationPlan: true,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'claude 99.0.0', stderr: '' }),
    });

    expect(result.operationPlan, JSON.stringify(result.targetResults)).toBeDefined();
    expect(result.dependencyPlan?.targets.map((target) => ({
      pluginId: target.pluginId,
      scope: target.requestedScope,
      action: target.action,
    }))).toEqual([
      { pluginId: 'team/alpha', scope: 'project', action: 'reinstall' },
      { pluginId: 'team/alpha', scope: 'user', action: 'install' },
    ]);
  });

  it('applies a dependency repair override without widening the root method', async () => {
    const { cwd, env } = await configureTaskCatalog();
    const result = await taskWriteCommand([
      { pluginId: 'team/root', platform: 'claude', scope: 'project', method: 'sync' },
    ], {
      cwd,
      repairTargets: [
        { pluginId: 'team/alpha', platform: 'claude', scope: 'project', method: 'reinstall' },
      ],
    }, {
      env,
      previewOperationPlan: true,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'claude 99.0.0', stderr: '' }),
    });

    expect(result.operationPlan, JSON.stringify(result.targetResults)).toBeDefined();
    expect(result.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'team/alpha', relation: 'dependency', action: 'reinstall',
      }),
      expect.objectContaining({
        pluginId: 'team/root', relation: 'requested', action: 'install',
      }),
    ]));
  });

  it('blocks the matching consumer when dependency execution fails', async () => {
    const { cwd, env } = await configureTaskCatalog();
    const result = await taskWriteCommand([
      { pluginId: 'team/consumer', platform: 'claude', scope: 'project', method: 'sync' },
    ], { cwd, yes: true }, {
      env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'claude 99.0.0', stderr: '' }),
    });

    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/broken', scope: 'project' }),
        state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/consumer', scope: 'project' }),
        action: 'skipped',
        errorCode: 'dependencyInstallFailed',
      }),
    ]));
  });

  it('does not share Codex failure state between exact scopes', async () => {
    const { cwd, env } = await configureTaskCatalog();
    const nativeCliRunner = createCodexNativeRunner(cwd, env);
    const codexManagerResolver = async () => ({
      kind: 'system' as const,
      version: '0.200.0',
      command: 'codex',
      argsPrefix: [] as string[],
    });
    const installed = await taskWriteCommand([
      { pluginId: 'team/native', platform: 'codex', scope: 'user', method: 'sync' },
    ], { cwd, yes: true }, { env, nativeCliRunner, codexManagerResolver });
    expect(installed.overallState, JSON.stringify(installed.targetResults)).toBe('succeeded');
    expect(nativeCliRunner.mock.calls.some(([invocation]) =>
      invocation.args.includes('add')), JSON.stringify(nativeCliRunner.mock.calls)).toBe(true);
    const installedConfig = await readCodexConfigFile(path.join(env.AW_CODEX_HOME!, 'config.toml'));
    const codexPluginId = Object.keys(installedConfig.snapshot.plugins)[0]!;
    expect(codexPluginId).toBeDefined();
    await applyCodexConfigTransactionFile(path.join(env.AW_CODEX_HOME!, 'config.toml'), {
      removePluginActivations: [codexPluginId],
    });
    nativeCliRunner.mockClear();
    setRebuildCommandTestHooksForTests({
      afterTargetBuilt: async ({ identity }) => {
        if (identity.pluginId === 'team/native' && identity.scope === 'user') {
          throw new Error('user scope preparation failed');
        }
      },
    });
    const result = await taskWriteCommand([
      { pluginId: 'team/native', platform: 'codex', scope: 'user', method: 'sync' },
      { pluginId: 'team/native', platform: 'codex', scope: 'project', method: 'sync' },
    ], { cwd, yes: true }, {
      env,
      nativeCliRunner,
      codexManagerResolver,
    });
    setRebuildCommandTestHooksForTests(undefined);

    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/native', scope: 'user' }),
        state: 'failed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/native', scope: 'project' }),
        state: 'completed',
      }),
    ]));
    const [userConfig, projectConfig] = await Promise.all([
      readCodexConfigFile(path.join(env.AW_CODEX_HOME!, 'config.toml')),
      readCodexConfigFile(path.join(cwd, '.codex', 'config.toml')),
    ]);
    expect(userConfig.snapshot.plugins[codexPluginId]).toBeUndefined();
    expect(projectConfig.snapshot.plugins[codexPluginId]?.enabled).toBe(true);
    expect(nativeCliRunner.mock.calls.filter(([invocation]) =>
      invocation.args.includes('--json') && invocation.args.includes('list')).length).toBeGreaterThan(1);
  });

  it('keeps ordinary install, sync, and reinstall intent state', async () => {
    const { cwd, env } = await configureTaskCatalog();
    await addProjectRequirements({ cwd, env, selectors: ['team/alpha'] });
    const requirements = await readNativeIntentProjection({ cwd, env });
    const runtime = {
      env,
      projectExecution: { requirements, selectedTargets: [{ pluginId: 'team/alpha', platform: 'codex' as const, scope: 'project' as const }] },
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 99.0.0', stderr: '' }),
    };
    await installWriteCommand(['team/alpha'], {
      cwd, platform: 'codex', scope: 'project',
    }, runtime);
    await syncWriteCommand(['team/alpha'], {
      cwd, platform: 'codex', scope: 'project',
    }, runtime);
    await reinstallWriteCommand(['team/alpha'], {
      cwd, platform: 'codex', scope: 'project',
    }, runtime);

    await expect(readNativeIntentProjection({ cwd, env })).resolves.toEqual(requirements);
  });

  it('round-trips mixed Codex task scopes through intent and sync all', async () => {
    const { cwd, env } = await configureTaskCatalog();
    await addProjectRequirements({ cwd, env, selectors: ['team/beta'] });
    const projectRequirements = await readNativeIntentProjection({ cwd, env });
    const nativeCliRunner = async () => ({
      exitCode: 0,
      stdout: 'codex-cli 99.0.0',
      stderr: '',
    });
    await taskWriteCommand([
      { pluginId: 'team/alpha', platform: 'codex', scope: 'user', method: 'sync' },
      { pluginId: 'team/beta', platform: 'codex', scope: 'project', method: 'sync' },
    ], { cwd }, { env, nativeCliRunner, projectRequirements });

    const [userIntent, projectIntent] = await Promise.all([
      readPluginIntentState({ cwd, scope: 'user', env }),
      readNativeIntentProjection({ cwd, env }),
    ]);
    expect(userIntent.roots).toContainEqual({ pluginId: 'team/alpha', platforms: ['codex'] });
    expect(projectIntent).toEqual(projectRequirements);

    const [syncedUser, syncedProject] = await Promise.all((['user', 'project'] as const)
      .map((scope) => runRebuildCommand({
        command: 'sync',
        pluginNames: [],
        all: true,
        commandOptions: { cwd, platform: 'codex', scope },
        runtime: { env, nativeCliRunner, previewOperationPlan: true },
      })));
    expect(syncedUser.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/alpha', resolvedScope: 'user' }),
    ]));
    expect(syncedProject.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/beta', resolvedScope: 'project' }),
    ]));
  });

  it('promotes an explicitly requested dependency to one exact root execution', async () => {
    const { cwd, env } = await configureTaskCatalog();
    const built = vi.fn();
    setRebuildCommandTestHooksForTests({ afterTargetBuilt: built });
    const result = await taskWriteCommand([
      { pluginId: 'team/a', platform: 'claude', scope: 'project', method: 'sync' },
      { pluginId: 'team/z', platform: 'claude', scope: 'project', method: 'sync' },
    ], { cwd, yes: true }, {
      env,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'claude 99.0.0', stderr: '' }),
    });
    setRebuildCommandTestHooksForTests(undefined);

    expect(built).toHaveBeenCalledTimes(2);
    expect(result.dependencyPlan?.targets.find((target) => target.pluginId === 'team/z'))
      .toEqual(expect.objectContaining({
        relation: 'requested',
        requestedScope: 'project',
      }));
    expect(result.rebuildResults.filter((entry) => entry.target.pluginId === 'team/z'))
      .toHaveLength(1);
    await expect(fs.readFile(path.join(env.AW_HOME!, 'z-pre-apply-count.txt'), 'utf8'))
      .resolves.toBe('1');
  });

  it('normalizes duplicate dependency repair scopes to one placement', async () => {
    const { cwd, env } = await configureTaskCatalog();
    const built = vi.fn();
    setRebuildCommandTestHooksForTests({ afterTargetBuilt: built });
    const result = await taskWriteCommand([
      { pluginId: 'team/root', platform: 'claude', scope: 'user', method: 'sync' },
      { pluginId: 'team/root', platform: 'claude', scope: 'project', method: 'sync' },
    ], {
      cwd,
      yes: true,
      repairTargets: [
        { pluginId: 'team/alpha', platform: 'claude', scope: 'user', method: 'reinstall' },
        { pluginId: 'team/alpha', platform: 'claude', scope: 'project', method: 'reinstall' },
      ],
    }, {
      env,
      nativeCliRunner: createClaudeNativeRunner(cwd, env),
    });
    setRebuildCommandTestHooksForTests(undefined);

    expect(result.dependencyPlan?.targets.filter((target) =>
      target.pluginId === 'team/alpha')).toEqual([
      expect.objectContaining({
        relation: 'dependency',
        resolvedScope: 'user',
        action: 'reinstall',
      }),
    ]);
    expect(built.mock.calls.filter(([call]) => call.identity.pluginId === 'team/alpha'))
      .toHaveLength(1);
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root', scope: 'user' }),
        state: 'completed',
      }),
      expect.objectContaining({
        target: expect.objectContaining({ pluginId: 'team/root', scope: 'project' }),
        state: 'completed',
      }),
    ]));
  });
});
