import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { syncCommand } from '../../src/commands/sync-command.js';
import { installWriteCommand } from '../../src/commands/write-commands.js';
import { applyCodexConfigTransactionFile, readCodexConfigFile } from '../../src/utils/codex-config.js';
import { readPluginIntentState, writePluginIntentState } from '../../src/utils/plugin-intent-state.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig as replaceCatalogSourcesConfigWithoutActive,
} from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
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
  it('syncs one same-name source without changing the other activation or managed intent', async () => {
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
    const installed = await installWriteCommand(['first/demo', 'second/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const configPath = path.join(isolation.env.AW_CODEX_HOME!, 'config.toml');
    await expect(readCodexConfigFile(configPath)).resolves.toMatchObject({
      snapshot: {
        plugins: {
          'demo@aw-first': { enabled: true },
          'demo@aw-second': { enabled: true },
        },
      },
    });
    await expect(readPluginIntentState({
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({
      managed: { codexPluginIds: ['demo@aw-first', 'demo@aw-second'] },
    });

    const synced = await syncCommand(['first/demo'], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      interactive: false,
    }, runtime);
    expect(synced.overallState, JSON.stringify(synced.rebuildResults)).toBe('succeeded');
    await expect(readCodexConfigFile(configPath)).resolves.toMatchObject({
      snapshot: {
        plugins: {
          'demo@aw-first': { enabled: true },
          'demo@aw-second': { enabled: true },
        },
      },
    });
    await expect(readPluginIntentState({
      scope: 'user',
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    })).resolves.toMatchObject({
      managed: { codexPluginIds: ['demo@aw-first', 'demo@aw-second'] },
    });
  });

  it('sync --all removes one stale same-name native identity and preserves the desired source', async () => {
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
    const installed = await installWriteCommand(['first/demo', 'second/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const intentLocation = {
      scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    const intent = await readPluginIntentState(intentLocation);
    await writePluginIntentState(intentLocation, {
      ...intent,
      roots: intent.roots.filter((root) => root.pluginId === 'second/demo'),
    });

    const synced = await syncCommand([], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      all: true,
      interactive: false,
    }, runtime);

    expect(synced.overallState, JSON.stringify(synced.rebuildResults)).toBe('succeeded');
    expect(synced.dependencyPlan?.requestedPluginIds).toEqual(['first/demo', 'second/demo']);
    const config = await readCodexConfigFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'));
    expect(config.snapshot.plugins['demo@aw-first']?.enabled).toBeUndefined();
    expect(config.snapshot.plugins['demo@aw-second']?.enabled).toBe(true);
    await expect(readPluginIntentState(intentLocation)).resolves.toMatchObject({
      roots: [{ pluginId: 'second/demo', platforms: ['codex'] }],
      managed: { codexPluginIds: ['demo@aw-second'] },
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
    const installed = await installWriteCommand(['first/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const intentLocation = {
      scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await expect(readPluginIntentState(intentLocation)).resolves.toMatchObject({
      roots: [{ pluginId: 'first/demo', platforms: ['codex'] }],
      managed: { codexPluginIds: ['demo@aw'] },
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

    const synced = await syncCommand([], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      all: true,
      interactive: false,
    }, runtime);

    expect(synced.overallState, JSON.stringify(synced.rebuildResults)).toBe('succeeded');
    expect(synced.dependencyPlan?.requestedPluginIds).toEqual(['first/demo']);
    const config = await readCodexConfigFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'));
    expect(config.snapshot.plugins['demo@aw']?.enabled).toBe(true);
    expect(config.snapshot.plugins['demo@aw-first']).toBeUndefined();
    await expect(readPluginIntentState(intentLocation)).resolves.toMatchObject({
      roots: [{ pluginId: 'first/demo', platforms: ['codex'] }],
      managed: { codexPluginIds: ['demo@aw'] },
    });
    expect(runtime.nativeCliRunner.mock.calls.some(([invocation]) => {
      const pluginIndex = invocation.args.indexOf('plugin');
      return invocation.args.slice(pluginIndex)[1] === 'remove';
    })).toBe(false);
  });

  it('sync --all deterministically resolves two rootless same-name managed identities', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const baseRoot = path.join(isolation.layout.fixtureCwd, 'rootless-base-source');
    const firstRoot = path.join(isolation.layout.fixtureCwd, 'rootless-first-source');
    const secondRoot = path.join(isolation.layout.fixtureCwd, 'rootless-second-source');
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
    const installed = await installWriteCommand(['first/demo', 'second/demo'], {
      cwd: isolation.layout.fixtureCwd,
      platform: 'codex',
      scope: 'user',
    }, runtime);
    expect(installed.overallState, JSON.stringify(installed.rebuildResults)).toBe('succeeded');
    const intentLocation = {
      scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    const intent = await readPluginIntentState(intentLocation);
    await writePluginIntentState(intentLocation, { ...intent, roots: [] });

    const synced = await syncCommand([], {
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      platform: 'codex',
      scope: 'user',
      all: true,
      interactive: false,
    }, runtime);

    expect(synced.overallState, JSON.stringify(synced.rebuildResults)).toBe('succeeded');
    expect(synced.dependencyPlan?.requestedPluginIds).toEqual(['first/demo', 'second/demo']);
    const config = await readCodexConfigFile(path.join(isolation.env.AW_CODEX_HOME!, 'config.toml'));
    expect(config.snapshot.plugins['demo@aw-first']?.enabled).toBeUndefined();
    expect(config.snapshot.plugins['demo@aw-second']?.enabled).toBeUndefined();
    await expect(readPluginIntentState(intentLocation)).resolves.toMatchObject({
      roots: [],
      managed: { codexPluginIds: [] },
    });
  });
});
