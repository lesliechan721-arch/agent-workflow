import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import fs from 'fs-extra';

import {
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
import { createScopeContext } from '../../src/intent/scope-context.js';
import { readDemand, demandNativeProjection } from '../../src/recovery/demand.js';
import { resolveIntentPath } from '../../src/intent/intent-store.js';
import { resolvePreferencesPath } from '../../src/intent/deployment-preferences.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { git } from '../helpers/catalog-source-fixture.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function configureTaskCatalog(): Promise<{
  cwd: string;
  env: NodeJS.ProcessEnv;
}> {
  const isolation = getCurrentSourceTestIsolation();
  const root = path.join(isolation.layout.fixtureCwd, 'rebuild-task-source');
  await git(isolation.layout.fixtureCwd, ['init', '--quiet']);
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

async function withExecutionInput<T>(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  scope: 'user' | 'project';
  selectedTargets: Array<{ pluginId: string; platform: 'codex' | 'claude'; scope: 'user' | 'project' }>;
}, run: (input: NonNullable<NonNullable<Parameters<typeof taskWriteCommand>[2]>['executionInput']>) => Promise<T>): Promise<T> {
  const context = await createScopeContext({ scope: options.scope, cwd: options.cwd, env: options.env });
  try {
    const demand = await readDemand({ scope: options.scope, cwd: context.executionCwd, env: context.env });
    return await run({ context, requirements: demandNativeProjection(demand),
      selectedTargets: options.selectedTargets, preserveOtherObservedTargets: true });
  } finally { await context.dispose(); }
}

describe('Native rebuild task execution input', () => {
  it('requires an explicit scope context and complete demand before any native write', async () => {
    const { cwd, env } = await configureTaskCatalog();
    const result = await taskWriteCommand([
      { pluginId: 'team/alpha', platform: 'claude', scope: 'project', method: 'sync' },
    ], { cwd }, { env, nativeCliRunner: createClaudeNativeRunner(cwd, env) });
    expect(result).toMatchObject({ overallState: 'failed', targetResults: [
      expect.objectContaining({ errorCode: 'nativeExecutionInputRequired', state: 'failed' }),
    ] });
  });

  // Test Value Gate: selecting one root cannot make another declared root an execution target.
  it('plans only an exact selected root and keeps independent declaration bytes', async () => {
    const { cwd, env } = await configureTaskCatalog();
    await writeIntentFixture({ scope: 'project', cwd, env }, {
      roots: [{ pluginId: 'team/alpha', platforms: ['claude'] },
        { pluginId: 'team/beta', platforms: ['claude'] }],
    });
    const intentPath = await resolveIntentPath({ scope: 'project', cwd, env });
    const preferencesPath = await resolvePreferencesPath({ scope: 'project', cwd, env });
    const before = await Promise.all([fs.readFile(intentPath), fs.readFile(preferencesPath)]);
    const selected = [{ pluginId: 'team/alpha', platform: 'claude' as const, scope: 'project' as const }];
    const result = await withExecutionInput({ cwd, env, scope: 'project', selectedTargets: selected },
      (executionInput) => taskWriteCommand([
        { ...selected[0]!, method: 'sync' },
      ], { cwd }, { env, executionInput, previewOperationPlan: true,
        nativeCliRunner: createClaudeNativeRunner(cwd, env) }));
    expect(result.dependencyPlan?.targets).toEqual([
      expect.objectContaining({ pluginId: 'team/alpha', requestedScope: 'project', action: 'install' }),
    ]);
    expect(result.targetResults.every((entry) => entry.target.pluginId !== 'team/beta')).toBe(true);
    expect(await Promise.all([fs.readFile(intentPath), fs.readFile(preferencesPath)])).toEqual(before);
  });

  it('repairs an exact dependency without widening the root method', async () => {
    const { cwd, env } = await configureTaskCatalog();
    await writeIntentFixture({ scope: 'project', cwd, env }, {
      roots: [{ pluginId: 'team/root', platforms: ['claude'] }],
    });
    const selected = [{ pluginId: 'team/root', platform: 'claude' as const, scope: 'project' as const }];
    const result = await withExecutionInput({ cwd, env, scope: 'project', selectedTargets: selected },
      (executionInput) => taskWriteCommand([
        { ...selected[0]!, method: 'sync' },
      ], { cwd, repairTargets: [
        { pluginId: 'team/alpha', platform: 'claude', scope: 'project', method: 'reinstall' },
      ] }, { env, executionInput, previewOperationPlan: true,
        nativeCliRunner: createClaudeNativeRunner(cwd, env) }));
    expect(result.dependencyPlan?.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/alpha', relation: 'dependency', action: 'reinstall' }),
      expect.objectContaining({ pluginId: 'team/root', relation: 'requested', action: 'install' }),
    ]));
  });

  it('blocks only the consumer whose dependency execution fails', async () => {
    const { cwd, env } = await configureTaskCatalog();
    await writeIntentFixture({ scope: 'project', cwd, env }, {
      roots: [{ pluginId: 'team/consumer', platforms: ['claude'] }],
    });
    const selected = [{ pluginId: 'team/consumer', platform: 'claude' as const, scope: 'project' as const }];
    const result = await withExecutionInput({ cwd, env, scope: 'project', selectedTargets: selected },
      (executionInput) => taskWriteCommand([
        { ...selected[0]!, method: 'sync' },
      ], { cwd, yes: true }, { env, executionInput,
        nativeCliRunner: createClaudeNativeRunner(cwd, env) }));
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: expect.objectContaining({ pluginId: 'team/broken' }), state: 'failed' }),
      expect.objectContaining({ target: expect.objectContaining({ pluginId: 'team/consumer' }),
        action: 'skipped', errorCode: 'dependencyInstallFailed' }),
    ]));
  });

  // Test Value Gate: a selected dependency is executed once even when another selected root requires it.
  it('promotes a requested dependency to one exact root execution', async () => {
    const { cwd, env } = await configureTaskCatalog();
    await writeIntentFixture({ scope: 'project', cwd, env }, {
      roots: [{ pluginId: 'team/a', platforms: ['claude'] },
        { pluginId: 'team/z', platforms: ['claude'] }],
    });
    const selected = ['team/a', 'team/z'].map((pluginId) => ({
      pluginId, platform: 'claude' as const, scope: 'project' as const,
    }));
    const result = await withExecutionInput({ cwd, env, scope: 'project', selectedTargets: selected },
      (executionInput) => taskWriteCommand(selected.map((target) => ({ ...target, method: 'sync' })),
        { cwd, yes: true }, { env, executionInput,
          nativeCliRunner: createClaudeNativeRunner(cwd, env) }));
    expect(result.dependencyPlan?.targets.find((target) => target.pluginId === 'team/z'))
      .toEqual(expect.objectContaining({ relation: 'requested', requestedScope: 'project' }));
    expect(result.targetResults.some((entry) => entry.target.pluginId === 'team/z'
      && entry.state === 'completed')).toBe(true);
    await expect(fs.readFile(path.join(env.AW_HOME!, 'z-pre-apply-count.txt'), 'utf8'))
      .resolves.toBe('1');
  });

  it('rejects a mixed-scope task before mutating either scope', async () => {
    const { cwd, env } = await configureTaskCatalog();
    const selected = [{ pluginId: 'team/alpha', platform: 'claude' as const,
      scope: 'project' as const }];
    const result = await withExecutionInput({ cwd, env, scope: 'project', selectedTargets: selected },
      (executionInput) => taskWriteCommand([
        { ...selected[0]!, method: 'sync' },
        { pluginId: 'team/alpha', platform: 'claude', scope: 'user', method: 'reinstall' },
      ], { cwd }, { env, executionInput, nativeCliRunner: createClaudeNativeRunner(cwd, env) }));
    expect(result.overallState).toBe('failed');
    expect(result.targetResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: 'nativeExecutionTargetScopeInvalid' }),
    ]));
    expect(await fs.pathExists(await resolveIntentPath({ scope: 'user', cwd, env }))).toBe(false);
    expect(await fs.pathExists(await resolveIntentPath({ scope: 'project', cwd, env }))).toBe(false);
  });

  // Test Value Gate: direct Native execution changes outputs, not strong requirement or preference files.
  it('leaves strong state unchanged across install, sync and reinstall', async () => {
    const { cwd, env } = await configureTaskCatalog();
    await writeIntentFixture({ scope: 'project', cwd, env }, {
      roots: [{ pluginId: 'team/alpha', platforms: ['claude'] }],
    });
    const intentPath = await resolveIntentPath({ scope: 'project', cwd, env });
    const preferencesPath = await resolvePreferencesPath({ scope: 'project', cwd, env });
    const before = await Promise.all([fs.readFile(intentPath), fs.readFile(preferencesPath)]);
    const selected = [{ pluginId: 'team/alpha', platform: 'claude' as const, scope: 'project' as const }];
    await withExecutionInput({ cwd, env, scope: 'project', selectedTargets: selected }, async (executionInput) => {
      const runtime = { env, executionInput, nativeCliRunner: createClaudeNativeRunner(cwd, env) };
      await installWriteCommand(['team/alpha'], { cwd, platform: 'claude', scope: 'project' }, runtime);
      await syncWriteCommand(['team/alpha'], { cwd, platform: 'claude', scope: 'project' }, runtime);
      await reinstallWriteCommand(['team/alpha'], { cwd, platform: 'claude', scope: 'project' }, runtime);
    });
    expect(await Promise.all([fs.readFile(intentPath), fs.readFile(preferencesPath)])).toEqual(before);
  });
});
