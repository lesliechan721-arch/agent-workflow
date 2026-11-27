import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { describe, beforeEach, expect, it } from 'vitest';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { execFileNativeCliRunner } from '../../src/utils/native-cli.js';
import { resolvePreferencesPath, writePreferences, createEmptyPreferences } from '../../src/intent/deployment-preferences.js';
import { observeIntent } from '../../src/intent/intent-store.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import path from 'node:path';
import fs from 'fs-extra';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import type { PluginMeta } from '../../src/types.js';
import { readSkillOwnerMarker } from '../../src/utils/ownership.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { readCodexConfigFile } from '../../src/utils/codex-config.js';
import {
  readFixtureRequirements,
  replaceCatalogSourcesConfig,
  snapshotRegularTree,
  createCodexNativeTestRuntime,
  writeIntentRoundTripCodexPackage,
  runIntentRoundTripCliChild,
  writeDynamicRoleRenderer,
} from '../helpers/write-command-fixture.js';
import { nativeFixtureLayout } from '../helpers/write-command-dependency-placement-fixture.js';

async function createIntentRoundTripFixture(nativeProviders = false) {
  const isolation = getCurrentSourceTestIsolation();
  await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env },
    { ...createEmptyPreferences(), targets: ['codex'] });
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'intent-round-trip-source');
  const dynamicRole = (roleKey: string) => (manifest: PluginMeta['manifest']) => {
    manifest.platforms = ['codex'];
    manifest.extensions = nativeProviders ? { instructions: [{
      name: `${roleKey}-context`, title: 'Provider context', content: `Use provider ${roleKey}.`, coverage: ['main'],
    }] } : undefined;
    manifest.scripts = {
      artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } },
    };
    manifest.artifacts = { configKeys: [], scopes: ['project', 'user'] };
  };
  const definitions = [
    { name: 'c', configureManifest: dynamicRole('c-role') },
    { name: 'b', dependencies: ['c'], configureManifest: dynamicRole('b-role') },
    {
      name: 'a',
      dependencies: ['b'],
      configureManifest: (manifest: PluginMeta['manifest']) => {
        manifest.platforms = ['codex'];
      },
    },
  ];
  await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
  await Promise.all([
    writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'b'),
      roleKey: 'b-role',
    }),
    writeDynamicRoleRenderer({
      pluginRoot: path.join(sourceRoot, 'plugins', 'c'),
      roleKey: 'c-role',
    }),
  ]);
  await createDependencyCatalogSnapshotFixture(sourceRoot, definitions);
  const sourceSnapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: {
      schemaVersion: 2,
      sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }],
    },
    expectedDigest: sourceSnapshot.digest,
    env: isolation.env,
  });
  const fakeCodexBin = await writeIntentRoundTripCodexPackage(path.join(
    isolation.layout.rootDir,
    'intent-round-trip-codex',
  ));
  const childEnv = {
    ...isolation.env,
    PATH: fakeCodexBin,
    npm_config_offline: 'true',
    NPM_CONFIG_OFFLINE: 'true',
  };
  return { isolation, childEnv };
}

describe('five namespaced write commands', () => {
  let defaultNativeRuntime: Awaited<ReturnType<typeof createCodexNativeTestRuntime>>;
  beforeEach(async () => {
    installNativeTestDiscovery();
    defaultNativeRuntime = await createCodexNativeTestRuntime(getCurrentSourceTestIsolation());
    await fs.ensureDir(path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, '.git'));
  });

  it('derives user dependency placement through independent CLI processes without saved overrides', async (test) => {
    const timing = createCommandTestTiming(test);
    const { isolation, childEnv } = await timing.measure('fixture', 'prepare independent CLI', () =>
      createIntentRoundTripFixture());
    const installedUser = await timing.measure('command', 'install user provider', () => runRecovery('install', ['team/b'], {
      cwd: isolation.layout.fixtureCwd, env: childEnv, scope: 'user', context: 'user',
      cliVersion: '1.0.0', targets: ['codex'], yes: true,
    }, { nativeCliRunner: execFileNativeCliRunner }));
    expect(installedUser.ok, JSON.stringify(installedUser)).toBe(true);
    await timing.measure('command', 'child install project consumer', () => runIntentRoundTripCliChild([
      'plugin', 'install',
      'team/a',
      '--scope',
      'project',
      '--json',
      '--yes',
    ], isolation.layout.fixtureCwd, childEnv));
    const intentLocation = {
      scope: 'project' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
      schemaVersion: 3,
      kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/a', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });
    const userRoleRoot = path.join(isolation.env.CODEX_HOME!, 'agents');
    const projectRoleRoot = path.join(isolation.layout.fixtureCwd, '.codex', 'agents');
    const roleNames = ["aw-team-b-b-role.toml", "aw-team-c-c-role.toml"];
    const preferencesPath = await resolvePreferencesPath(intentLocation);
    const preferencesBefore = await fs.readFile(preferencesPath);
    const projectBefore = await observeIntent(intentLocation);
    const userLocation = { ...intentLocation, scope: 'user' as const };
    const userBefore = await observeIntent(userLocation);
    for (const name of roleNames) {
      const rolePath = path.join(userRoleRoot, name);
      const delivered = await fs.readFile(rolePath, 'utf8');
      expect(delivered).toContain('Use this role.');
      await fs.writeFile(rolePath, delivered.replace('Use this role.', 'Stale provider output.'));
    }
    await timing.measure('command', 'child sync project consumer', () => runIntentRoundTripCliChild([
      'plugin', 'sync',
      'team/a',
      '--context',
      'project',
      '--target',
      'codex',
      '--json',
      '--yes',
    ], isolation.layout.fixtureCwd, childEnv));
    for (const name of roleNames) {
      await expect(fs.readFile(path.join(userRoleRoot, name), 'utf8')).resolves.toContain('Use this role.');
      await expect(fs.pathExists(path.join(projectRoleRoot, name))).resolves.toBe(false);
    }
    await expect(observeIntent(intentLocation)).resolves.toEqual(projectBefore);
    await expect(observeIntent(userLocation)).resolves.toEqual(userBefore);
    await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
    await expect(readFixtureRequirements(intentLocation)).resolves.toMatchObject({
      roots: [{ pluginId: 'team/a', platforms: ['codex'] }], dependencyScopeOverrides: [],
    });

    // Hosted macOS and Windows need room for the install and two independent CLI processes.
    // Keep a bounded orchestration deadline; product timeouts and perf budgets stay separate.
  }, process.platform === 'win32' || process.platform === 'darwin' ? 120_000 : 60_000);

  // Test Value Gate: an independent remove process must retain the User providers' real owned outputs.
  it('preserves User providers when an independent CLI process removes its Project consumer', async () => {
    const { isolation, childEnv } = await createIntentRoundTripFixture(true);
    await runIntentRoundTripCliChild([
      'plugin', 'install', 'team/b', '--scope', 'user', '--json', '--yes',
    ], isolation.layout.fixtureCwd, childEnv);
    const installedProject = await runRecovery('install', ['team/a'], {
      cwd: isolation.layout.fixtureCwd, env: childEnv, scope: 'project', context: 'project',
      cliVersion: '1.0.0', targets: ['codex'], yes: true,
    }, { nativeCliRunner: execFileNativeCliRunner });
    expect(installedProject.ok, JSON.stringify(installedProject)).toBe(true);
    const projectLocation = { scope: 'project' as const, cwd: isolation.layout.fixtureCwd, env: childEnv };
    const userLocation = { ...projectLocation, scope: 'user' as const };
    await expect(readFixtureRequirements(projectLocation)).resolves.toMatchObject({
      schemaVersion: 3, kind: 'aw-plugin-intents', roots: [{ pluginId: 'team/a', platforms: ['codex'] }],
      dependencyScopeOverrides: [],
    });
    const userBefore = await observeIntent(userLocation);
    expect(userBefore).toMatchObject({ state: 'valid', value: { roots: [{ pluginId: 'team/b' }] } });
    const preferencesPath = await resolvePreferencesPath(userLocation);
    const preferencesBefore = await fs.readFile(preferencesPath);
    const sourceIdentity = (await readCatalogGenerationState(childEnv)).sources.team?.active?.sourceIdentity;
    expect(sourceIdentity).toMatch(/^sha256:/u);
    const providers = await Promise.all(['b', 'c'].map(async (name) => {
      const native = await nativeFixtureLayout(name, 'team', 'user', 'codex', sourceIdentity);
      const rolePath = path.join(isolation.env.CODEX_HOME!, 'agents', `aw-team-${name}-${name}-role.toml`);
      const role = await fs.readFile(rolePath);
      expect(role.toString('utf8')).toContain('Use this role.');
      await expect(fs.pathExists(path.join(native.packageRoot, '.codex-plugin', 'plugin.json'))).resolves.toBe(true);
      expect(await readSkillOwnerMarker({ skillRoot: native.packageRoot, allowedRoot: path.dirname(native.packageRoot) }))
        .toMatchObject({ pluginId: `team/${name}`, sourceIdentity, physicalKey: native.binding.physicalKey });
      return { native, rolePath, role, packageBefore: await snapshotRegularTree(native.packageRoot) };
    }));
    await runIntentRoundTripCliChild([
      'plugin', 'remove', 'team/a', '--scope', 'project', '--json', '--yes',
    ], isolation.layout.fixtureCwd, childEnv);
    await expect(readFixtureRequirements(projectLocation)).resolves.toMatchObject({
      schemaVersion: 3, kind: 'aw-plugin-intents', roots: [], dependencyScopeOverrides: [],
    });
    await expect(observeIntent(userLocation)).resolves.toEqual(userBefore);
    await expect(fs.readFile(preferencesPath)).resolves.toEqual(preferencesBefore);
    const userConfig = (await readCodexConfigFile(path.join(isolation.env.CODEX_HOME!, 'config.toml'))).snapshot;
    for (const provider of providers) {
      await expect(fs.readFile(provider.rolePath)).resolves.toEqual(provider.role);
      await expect(snapshotRegularTree(provider.native.packageRoot)).resolves.toEqual(provider.packageBefore);
      expect(userConfig.plugins[provider.native.nativeIdentity.registrationId!]?.enabled).toBe(true);
    }
  }, 60_000);
});
