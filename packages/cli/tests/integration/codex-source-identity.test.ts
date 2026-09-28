import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { runRecovery } from '../../src/recovery/coordinator.js';
import { applyCodexConfigTransactionFile, readCodexConfigFile } from '../../src/utils/codex-config.js';
import { observeIntent, resolveIntentPath, writeIntent } from '../../src/intent/intent-store.js';
import { resolvePreferencesPath } from '../../src/intent/deployment-preferences.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig as replaceCatalogSourcesConfigWithoutActive,
} from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import type { PluginMeta } from '../../src/types.js';

async function replaceCatalogSourcesConfig(
  options: Parameters<typeof replaceCatalogSourcesConfigWithoutActive>[0],
) {
  const result = await replaceCatalogSourcesConfigWithoutActive(options);
  for (const source of options.config.sources) {
    await syncCatalogSourceGeneration({
      sourceId: source.id, cliVersion: '1.0.0', env: options.env,
    });
  }
  return result;
}

async function createNativeSource(root: string): Promise<void> {
  const configure = (manifest: PluginMeta['manifest']) => {
    manifest.marketplace.policy.products = ['CODEX'];
    manifest.skills = './skills';
  };
  await createCatalogSnapshotFixture(root, 'demo', [], 'demo\n', configure);
  await Promise.all([
    fs.outputFile(
      path.join(root, 'plugins', 'demo', 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Demo.\n---\n',
    ),
    fs.outputFile(
      path.join(root, 'plugins', 'demo', 'skills', 'demo-skill', 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: true\n',
    ),
  ]);
  await createCatalogSnapshotFixture(root, 'demo', [], 'demo\n', configure);
}

async function createTwoNativeSource(root: string): Promise<void> {
  const plugins = ['alpha', 'beta'].map((name) => ({ name, configureManifest: (manifest: PluginMeta['manifest']) => {
    manifest.marketplace.policy.products = ['CODEX'];
    manifest.skills = './skills';
  } }));
  await createDependencyCatalogSnapshotFixture(root, plugins);
  for (const { name } of plugins) await fs.outputFile(
    path.join(root, 'plugins', name, 'skills', `${name}-skill`, 'SKILL.md'),
    `---\nname: ${name}-skill\ndescription: ${name}.\n---\n`,
  );
  await createDependencyCatalogSnapshotFixture(root, plugins);
}

function createNativeRuntime(isolation: ReturnType<typeof getCurrentSourceTestIsolation>) {
  const installed = new Set<string>();
  const marketplaceRoots = new Map<string, string>();
  const configPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
  const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
    if (invocation.args.includes('--version')) {
      return { exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' };
    }
    const pluginIndex = invocation.args.indexOf('plugin');
    const args = pluginIndex >= 0 ? invocation.args.slice(pluginIndex) : invocation.args;
    if (args[1] === 'marketplace' && args[2] === 'add') {
      const marketplaceRoot = args[3]!;
      const config = await fs.readJson(path.join(marketplaceRoot, 'config.json')) as {
        marketplaceName: string;
      };
      marketplaceRoots.set(config.marketplaceName, marketplaceRoot);
      const current = await fs.readFile(configPath, 'utf8').catch(() => '');
      if (!(await readCodexConfigFile(configPath)).snapshot.marketplaces[config.marketplaceName]) {
        await fs.outputFile(configPath, [
          current,
          `[marketplaces.${JSON.stringify(config.marketplaceName)}]`,
          `source = ${JSON.stringify(marketplaceRoot)}`,
          'source_type = "local"',
          '',
        ].filter(Boolean).join('\n'));
      }
    } else if (args[1] === 'add') {
      const pluginId = args[2]!;
      const separator = pluginId.lastIndexOf('@');
      const pluginName = pluginId.slice(0, separator);
      const marketplaceName = pluginId.slice(separator + 1);
      installed.add(pluginId);
      const cacheRoot = path.join(
        isolation.env.AW_CODEX_HOME!,
        'plugins',
        'cache',
        marketplaceName,
        pluginName,
        '1.0.0',
      );
      await fs.copy(
        path.join(marketplaceRoots.get(marketplaceName)!, 'plugins', pluginName),
        cacheRoot,
        { overwrite: true },
      );
      await applyCodexConfigTransactionFile(configPath, {
        upsertPluginActivations: { [pluginId]: true },
      });
    } else if (args[1] === 'remove') {
      const pluginId = args[2]!;
      const separator = pluginId.lastIndexOf('@');
      installed.delete(pluginId);
      await fs.remove(path.join(
        isolation.env.AW_CODEX_HOME!,
        'plugins',
        'cache',
        pluginId.slice(separator + 1),
        pluginId.slice(0, separator),
      ));
      await applyCodexConfigTransactionFile(configPath, {
        removePluginActivations: [pluginId],
      });
    }
    if (args[1] === 'list' && args.includes('--json')) {
      const config = await readCodexConfigFile(configPath);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          installed: [...installed].sort().map((pluginId) => ({
            pluginId,
            installed: true,
            enabled: config.snapshot.plugins[pluginId]?.enabled === true,
            version: '1.0.0',
          })),
          available: [],
        }),
        stderr: '',
      };
    }
    return {
      exitCode: 0,
      stdout: args[1] === 'list' ? [...installed].sort().join('\n') : '',
      stderr: '',
    };
  });
  return {
    env: isolation.env,
    nativeCliRunner,
    codexManagerResolver: vi.fn(async () => ({
      kind: 'system' as const,
      version: '0.200.0',
      command: 'codex',
      argsPrefix: [] as string[],
    })),
  };
}

describe('Codex source-qualified native identity', () => {
  // Test Value Gate: a selected User root cannot replace a sibling shared package or read caller project state.
  it('keeps a sibling package and ignores poisoned caller project state during User recovery', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    await git(cwd, ['init', '--quiet']);
    const sourceRoot = path.join(cwd, 'same-marketplace-source');
    await createTwoNativeSource(sourceRoot);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'team', type: 'path', primary: true, path: sourceRoot },
    ] }, expectedDigest: snapshot.digest, env: isolation.env });
    const runtime = createNativeRuntime(isolation);
    const options = { cwd, env: isolation.env, scope: 'user' as const,
      cliVersion: '1.0.0', targets: ['codex'], yes: true };
    const installed = await runRecovery('install', ['team/alpha', 'team/beta'], options, runtime);
    expect(installed.ok, JSON.stringify(installed.targetResults)).toBe(true);
    const betaCache = path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', 'beta', '1.0.0');
    const betaManifest = path.join(betaCache, '.codex-plugin', 'plugin.json');
    const betaBytes = await fs.readFile(betaManifest);
    const userIntentPath = path.join(isolation.env.AW_HOME!, 'plugin-intents.json');
    const userIntentBytes = await fs.readFile(userIntentPath);
    await fs.outputFile(path.join(cwd, '.agent-workflows', 'plugin-intents.json'), '{invalid project state');
    await fs.outputFile(path.join(cwd, '.codex', 'config.toml'), 'invalid = [ project config');
    const synced = await runRecovery('sync', ['team/alpha'], options, runtime);
    expect(synced.ok, JSON.stringify(synced.targetResults)).toBe(true);
    expect(await fs.readFile(betaManifest)).toEqual(betaBytes);
    expect(await fs.readFile(userIntentPath)).toEqual(userIntentBytes);
    const cleaned = await runRecovery('cleanup', ['team/alpha'], options, runtime);
    expect(cleaned.ok, JSON.stringify(cleaned.targetResults)).toBe(true);
    expect(await fs.readFile(betaManifest)).toEqual(betaBytes);
    expect((await readCodexConfigFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml')))
      .snapshot.plugins['beta@aw']?.enabled).toBe(true);
    expect(await fs.readFile(userIntentPath)).toEqual(userIntentBytes);
  });

  // Test Value Gate: scope-specific cleanup must preserve the other activation and shared package.
  it('cleans only the selected Codex activation in each scope', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = isolation.layout.fixtureCwd;
    await git(cwd, ['init', '--quiet']);
    const sourceRoot = path.join(cwd, 'two-scope-source');
    await createNativeSource(sourceRoot);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'team', type: 'path', primary: true, path: sourceRoot },
    ] }, expectedDigest: snapshot.digest, env: isolation.env });
    const runtime = createNativeRuntime(isolation);
    const options = (scope: 'user' | 'project') => ({ cwd, env: isolation.env, scope,
      cliVersion: '1.0.0', targets: ['codex'], yes: true });
    expect((await runRecovery('install', ['team/demo'], options('user'), runtime)).ok).toBe(true);
    const projectInstall = await runRecovery('install', ['team/demo'], options('project'), runtime);
    expect(projectInstall.ok, JSON.stringify(projectInstall.targetResults)).toBe(true);
    const strongPaths = await Promise.all((['user', 'project'] as const).flatMap((scope) => [
      resolveIntentPath({ scope, cwd, env: isolation.env }),
      resolvePreferencesPath({ scope, cwd, env: isolation.env }),
    ]));
    const strongBytes = await Promise.all(strongPaths.map((file) => fs.readFile(file).catch(() => null)));
    const cacheManifest = path.join(isolation.env.AW_CODEX_HOME!, 'plugins', 'cache', 'aw', 'demo',
      '1.0.0', '.codex-plugin', 'plugin.json');
    const packageBytes = await fs.readFile(cacheManifest);
    const projectCleanup = await runRecovery('cleanup', ['team/demo'], options('project'), runtime);
    expect(projectCleanup.ok, JSON.stringify(projectCleanup.targetResults)).toBe(true);
    expect((await readCodexConfigFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml')))
      .snapshot.plugins['demo@aw']?.enabled).toBe(true);
    expect(await fs.readFile(cacheManifest)).toEqual(packageBytes);
    expect(await Promise.all(strongPaths.map((file) => fs.readFile(file).catch(() => null))))
      .toEqual(strongBytes);

    expect((await runRecovery('sync', ['team/demo'], options('project'), runtime)).ok).toBe(true);
    const projectConfigPath = path.join(cwd, '.codex', 'config.toml');
    expect((await readCodexConfigFile(projectConfigPath)).snapshot.plugins['demo@aw']?.enabled).toBe(true);
    const userCleanup = await runRecovery('cleanup', ['team/demo'], options('user'), runtime);
    expect(userCleanup.ok, JSON.stringify(userCleanup.targetResults)).toBe(true);
    expect((await readCodexConfigFile(projectConfigPath)).snapshot.plugins['demo@aw']?.enabled).toBe(true);
    expect(await fs.readFile(cacheManifest)).toEqual(packageBytes);
    expect(await Promise.all(strongPaths.map((file) => fs.readFile(file).catch(() => null))))
      .toEqual(strongBytes);
  });

  it('syncs one same-name source without changing the other activation or root intent', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const baseRoot = path.join(isolation.layout.fixtureCwd, 'base-source');
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'first-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'second-source');
    await Promise.all([
      createCatalogSnapshotFixture(baseRoot, 'anchor'),
      createNativeSource(firstRoot),
      createNativeSource(secondRoot),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'base', type: 'path', primary: true, path: baseRoot },
          { id: 'first', type: 'path', primary: false, path: firstRoot },
          { id: 'second', type: 'path', primary: false, path: secondRoot },
        ],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createNativeRuntime(isolation);
    const installed = await runRecovery('install', ['first/demo', 'second/demo'], {
      cwd: isolation.layout.fixtureCwd, scope: 'user', cliVersion: '1.0.0',
      targets: ['codex'], yes: true,
    }, runtime);
    expect(installed.ok, JSON.stringify(installed.targetResults)).toBe(true);
    const configPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    await expect(readCodexConfigFile(configPath)).resolves.toMatchObject({
      snapshot: {
        plugins: {
          'demo@aw-first': { enabled: true },
          'demo@aw-second': { enabled: true },
        },
      },
    });
    await expect(observeIntent({
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({
      state: 'valid', value: { roots: [
        { pluginId: 'first/demo' },
        { pluginId: 'second/demo' },
      ] },
    });

    const synced = await runRecovery('sync', ['first/demo'], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, scope: 'user',
      cliVersion: '1.0.0', targets: ['codex'], yes: true,
    }, runtime);
    expect(synced.ok, JSON.stringify(synced.targetResults)).toBe(true);
    await expect(readCodexConfigFile(configPath)).resolves.toMatchObject({
      snapshot: {
        plugins: {
          'demo@aw-first': { enabled: true },
          'demo@aw-second': { enabled: true },
        },
      },
    });
    await expect(observeIntent({
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({
      state: 'valid', value: { roots: [
        { pluginId: 'first/demo' },
        { pluginId: 'second/demo' },
      ] },
    });
  });

  it('sync --all reconciles only intent roots and leaves other actual state orphaned', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const baseRoot = path.join(isolation.layout.fixtureCwd, 'all-base-source');
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'all-first-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'all-second-source');
    await Promise.all([
      createCatalogSnapshotFixture(baseRoot, 'anchor'),
      createNativeSource(firstRoot),
      createNativeSource(secondRoot),
    ]);
    const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'base', type: 'path', primary: true, path: baseRoot },
          { id: 'first', type: 'path', primary: false, path: firstRoot },
          { id: 'second', type: 'path', primary: false, path: secondRoot },
        ],
      },
      expectedDigest: snapshot.digest,
      env: isolation.env,
    });
    const runtime = createNativeRuntime(isolation);
    const installed = await runRecovery('install', ['first/demo', 'second/demo'], {
      cwd: isolation.layout.fixtureCwd, scope: 'user', cliVersion: '1.0.0',
      targets: ['codex'], yes: true,
    }, runtime);
    expect(installed.ok, JSON.stringify(installed.targetResults)).toBe(true);
    const intentLocation = {
      scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    const intent = await observeIntent(intentLocation);
    expect(intent.state).toBe('valid');
    if (intent.state !== 'valid') throw new Error('Fixture intent missing');
    await writeIntent(intentLocation, {
      ...intent.value, roots: intent.value.roots.filter((root) => root.pluginId === 'second/demo'),
    });

    const synced = await runRecovery('sync', [], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, scope: 'user',
      cliVersion: '1.0.0', targets: ['codex'], all: true, yes: true,
    }, runtime);

    expect(synced.ok, JSON.stringify(synced.targetResults)).toBe(true);
    expect(synced.requestedRoots).toEqual(['second/demo']);
    const config = await readCodexConfigFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'));
    expect(config.snapshot.plugins['demo@aw-first']?.enabled).toBe(true);
    expect(config.snapshot.plugins['demo@aw-second']?.enabled).toBe(true);
    await expect(observeIntent(intentLocation)).resolves.toMatchObject({
      state: 'valid', value: { roots: [{ pluginId: 'second/demo' }] },
    });
  });

  it('sync --all keeps the live canonical identity after the primary source changes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'primary-first-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'primary-second-source');
    await Promise.all([
      createNativeSource(firstRoot),
      createNativeSource(secondRoot),
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
    const runtime = createNativeRuntime(isolation);
    const installed = await runRecovery('install', ['first/demo'], {
      cwd: isolation.layout.fixtureCwd, scope: 'user', cliVersion: '1.0.0',
      targets: ['codex'], yes: true,
    }, runtime);
    expect(installed.ok, JSON.stringify(installed.targetResults)).toBe(true);
    const intentLocation = {
      scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await expect(observeIntent(intentLocation)).resolves.toMatchObject({
      state: 'valid', value: { roots: [{ pluginId: 'first/demo' }] },
    });

    const current = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [
          { id: 'first', type: 'path', primary: false, path: firstRoot },
          { id: 'second', type: 'path', primary: true, path: secondRoot },
        ],
      },
      expectedDigest: current.digest,
      env: isolation.env,
    });

    const synced = await runRecovery('sync', [], {
      cwd: isolation.layout.fixtureCwd, env: isolation.env, scope: 'user',
      cliVersion: '1.0.0', targets: ['codex'], all: true, yes: true,
    }, runtime);

    expect(synced.ok, JSON.stringify(synced.targetResults)).toBe(true);
    expect(synced.requestedRoots).toEqual(['first/demo']);
    const config = await readCodexConfigFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'));
    expect(config.snapshot.plugins['demo@aw']?.enabled).toBe(true);
    expect(config.snapshot.plugins['demo@aw-first']).toBeUndefined();
    await expect(observeIntent(intentLocation)).resolves.toMatchObject({
      state: 'valid', value: { roots: [{ pluginId: 'first/demo' }] },
    });
    expect(runtime.nativeCliRunner.mock.calls.some(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      return invocation.args.slice(pluginIndex)[1] === 'remove';
    })).toBe(false);
  });

});
