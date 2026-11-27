import path from 'node:path';
import fs from 'fs-extra';
import { expect, it } from 'vitest';

import { setTargets } from '../../src/intent/deployment-preferences.js';
import { resolvePlatformConfigRoot } from '../../src/platforms/discovery.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { runCliEntry } from '../helpers/cli-entry.js';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

// Test Value Gate: a local marketplace exposes its other live entries before
// their packages are published. The batch must still register both roots.
it.each(['user', 'project'] as const)('installs two Copilot %s roots despite the second appearing early in the native list', async (scope) => {
  installNativeTestDiscovery({ platforms: ['copilot'], executable: process.execPath });
  const { env, layout } = getCurrentSourceTestIsolation();
  const cwd = layout.fixtureCwd;
  const source = path.join(cwd, 'catalog');
  const host = resolvePlatformConfigRoot('copilot', { cwd, env });
  const userSettings = path.join(host, 'settings.json');
  const projectSettings = path.join(cwd, '.github', 'copilot', 'settings.local.json');
  const plugins = [{ name: 'helper', roles: ['reviewer'], dependencies: [] },
    { name: 'review', roles: ['reviewer', 'planner'], dependencies: ['helper'] }];
  const ids = plugins.map(({ name }) => `team/${name}`);
  const prompt = (name: string) => `Carry out the ${name} role.`;
  await fs.ensureDir(path.join(cwd, '.git'));
  await createDependencyCatalogSnapshotFixture(source, plugins.map(({ name, roles, dependencies }) => ({ name, dependencies,
    configureManifest(manifest) {
      manifest.platforms = ['copilot'];
      delete manifest.skills;
      manifest.extensions = { agents: roles.map((role) => ({ name: role, description: `${role} role`, prompt: prompt(role) })) };
    },
  })));
  const config = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
    sources: [{ id: 'team', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
  await setTargets({ cwd, env, scope: 'user' }, ['copilot']);

  let market: { root: string; name: string; entries: { name: string; version: string }[] } | undefined;
  const installed: string[] = [];
  let observedUnpublishedSibling = false;
  const readSettings = async (file: string) => await fs.pathExists(file) ? await fs.readJson(file) : {};
  const nativeCliRunner = async ({ args, cwd: observedCwd }: NativeCliInvocation) => {
    let value: unknown = [];
    if (args.join(' ') === 'plugin marketplace list --json') {
      value = market ? [{ name: market.name, source: `Local: ${market.root}` }] : [];
    } else if (args.join(' ') === 'plugin list --json') {
      if (market) {
        const { root, name, entries } = market;
        const user = await readSettings(userSettings);
        const project = observedCwd === cwd ? await readSettings(projectSettings) : {};
        value = await Promise.all(entries.map(async (entry) => {
          const id = `${entry.name}@${name}`;
          const enabled = (project.enabledPlugins?.[id] ?? user.enabledPlugins?.[id]) === true;
          if (entry.name === 'review' && !enabled && installed.includes('helper')
            && !await fs.pathExists(path.join(root, 'plugins', entry.name))) observedUnpublishedSibling = true;
          return { ...entry, marketplace: name, source: 'live', installedFrom: root, enabled };
        }));
      }
    } else if (args.slice(0, 3).join(' ') === 'plugin marketplace add') {
      expect(market).toBeUndefined();
      const root = args[3]!;
      const manifest = await fs.readJson(path.join(root, '.github', 'plugin', 'marketplace.json'));
      market = { root, name: manifest.name, entries: manifest.plugins.map(({ name, version }: { name: string; version: string }) => ({ name, version })) };
    } else if (args.slice(0, 2).join(' ') === 'plugin install') {
      const [name, marketplace] = args[2]!.split('@');
      expect(marketplace).toBe(market!.name);
      expect(await fs.pathExists(path.join(market!.root, 'plugins', name!))).toBe(true);
      installed.push(name!);
    } else throw new Error(`Unexpected Copilot request ${args.join(' ')}`);
    return { exitCode: 0, stdout: JSON.stringify(value), stderr: '' };
  };
  const run = async (...args: string[]) => {
    const result = await runCliEntry(['plugin', ...args, '--context', scope, '--json'], { cwd, env, nativeCliRunner, interactive: false });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    return result.parseJsonStdout();
  };
  const satisfied = (name: string, roleCount: number) => expect.objectContaining({ pluginId: `team/${name}`, target: 'copilot', scope,
    content: 'satisfied', satisfaction: 'installed', installedComponentCount: roleCount });
  await expect(run('install', ...ids, '--scope', scope, '--target', 'copilot', '--yes')).resolves.toMatchObject({ status: 'success', data: {
    remainingTargets: [], targetResults: plugins.map(({ name, roles }) => satisfied(name, roles.length)),
  } });
  expect(observedUnpublishedSibling).toBe(true);
  expect(installed).toEqual(plugins.map(({ name }) => name));
  for (const { name, roles } of plugins) for (const role of roles) {
    expect(await fs.readFile(path.join(market!.root, 'plugins', name, 'com.github.copilot', 'agents', `aw-team-${name}-${role}.agent.md`), 'utf8'))
      .toContain(prompt(role));
  }
  expect(await run('status')).toMatchObject({ status: 'success', data: { allSatisfied: true, inSync: true,
    inventory: expect.arrayContaining(plugins.map(({ name, roles }) => expect.objectContaining({ pluginId: `team/${name}`,
      targetResults: [satisfied(name, roles.length)] }))),
  } });
  expect(await run('sync', '--yes')).toMatchObject({ status: 'success', data: { changes: { outputs: 'none' }, remainingTargets: [] } });
  expect(installed).toEqual(plugins.map(({ name }) => name));
});
