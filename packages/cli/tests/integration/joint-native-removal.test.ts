import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import type { PluginMeta, Scope } from '../../src/types.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { applyCodexConfigTransactionFile, readCodexConfigFile } from '../../src/utils/codex-config.js';
import { git } from '../helpers/catalog-source-fixture.js';
import { getNativeTestLayout, installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import {
  createCodexNativeTestRuntime,
  createNativeDependencyCatalog,
  snapshotRegularTree,
  writeDynamicRoleRenderer,
} from '../helpers/write-command-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(scope: Scope) {
  installNativeTestQualification({ platforms: ['codex'], discovery: true, trust: true });
  const isolation = getCurrentSourceTestIsolation();
  const { env, layout } = isolation;
  const cwd = layout.fixtureCwd;
  await git(cwd, ['init', '--quiet']);
  const source = path.join(cwd, 'native-removal-source');
  const role = (name: string) => `${name}-role`;
  const definitions = [
    { name: 'dependency' }, { name: 'parent', dependencies: ['dependency'] },
  ].map((plugin) => ({ ...plugin, configureManifest: (manifest: PluginMeta['manifest']) => {
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './scripts/render.mjs' } } };
    manifest.artifacts = { configKeys: [], scopes: ['user', 'project'] };
  } }));
  for (const { name } of definitions) await writeDynamicRoleRenderer({
    pluginRoot: path.join(source, 'plugins', name), roleKey: role(name),
  });
  await createNativeDependencyCatalog(source, definitions);
  const config = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
    sources: [{ id: 'team', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  const runtime = await createCodexNativeTestRuntime(isolation);
  const location = { cwd, env, cliVersion: '1.0.0', scope, context: scope, yes: true };
  await setTargets(location, ['codex']);
  const installed = await runPublicLifecycle('install', ['team/parent'], location, runtime);
  expect(installed.status, JSON.stringify(installed)).toBe('success');

  const codexRoot = scope === 'user' ? env.CODEX_HOME! : path.join(cwd, '.codex');
  const configPath = path.join(codexRoot, 'config.toml');
  const nativeLayout = await getNativeTestLayout({ platform: 'codex', pluginId: 'team/parent', scope, cwd, env });
  const nativeId = (name: string) => `${name}@${nativeLayout.marketplaceName!}`;
  const rolePath = (name: string) => path.join(codexRoot, 'agents', `aw-team-${name}-${role(name)}.toml`);
  for (const name of ['parent', 'dependency']) {
    expect(await fs.pathExists(rolePath(name))).toBe(true);
    expect((await readCodexConfigFile(configPath)).snapshot.plugins[nativeId(name)]?.enabled).toBe(true);
  }
  const foreignPath = path.join(codexRoot, 'agents', 'foreign.toml');
  const foreignContent = 'name = "foreign"\ndescription = "Foreign role."\ndeveloper_instructions = "Keep this role."\n';
  await fs.outputFile(foreignPath, foreignContent);
  await applyCodexConfigTransactionFile(configPath, {
    upsertAgentRegistrations: { foreign: { description: 'Foreign role.', configFile: 'agents/foreign.toml' } },
    upsertPluginActivations: { 'foreign@elsewhere': true },
  });
  const sharedRoot = path.join(env.CODEX_HOME!, 'plugins', 'cache');
  const sharedBefore = await snapshotRegularTree(sharedRoot);
  const installedBefore = new Set(runtime.installed);
  const expectProtectedContent = async () => {
    expect(await snapshotRegularTree(sharedRoot)).toEqual(sharedBefore);
    expect(runtime.installed).toEqual(installedBefore);
    expect(await fs.readFile(foreignPath, 'utf8')).toBe(foreignContent);
    const current = (await readCodexConfigFile(configPath)).snapshot;
    expect(current.agents.foreign).toMatchObject({ description: 'Foreign role.', configFile: 'agents/foreign.toml' });
    expect(current.plugins['foreign@elsewhere']?.enabled).toBe(true);
  };
  return { location, runtime, configPath, rolePath, nativeId, expectProtectedContent };
}

// Native removal must retire scoped extensions and activation while preserving shared packages and foreign config.
describe('joint Codex removal', () => {
  it.each([
    { scope: 'user', keep: false },
    { scope: 'project', keep: false },
    { scope: 'project', keep: true },
  ] as const)('removes a $scope root with orphan dependency retention=$keep', async ({ scope, keep }) => {
    const value = await fixture(scope);
    const removed = await runPublicLifecycle('remove', ['team/parent'], {
      ...value.location, keepDependencies: keep,
    }, value.runtime);
    expect(removed.status, JSON.stringify(removed)).toBe('success');
    expect(removed.data).toMatchObject({ requirements: { roots: [] }, changes: { requirements: 'changed' } });
    const current = (await readCodexConfigFile(value.configPath)).snapshot;
    expect(current.plugins[value.nativeId('parent')]?.enabled).not.toBe(true);
    expect(await fs.pathExists(value.rolePath('parent'))).toBe(false);
    expect(current.plugins[value.nativeId('dependency')]?.enabled === true).toBe(keep);
    expect(await fs.pathExists(value.rolePath('dependency'))).toBe(keep);
    if (keep) expect(await fs.readFile(value.rolePath('dependency'), 'utf8')).toContain('name = "aw-team-dependency-dependency-role"');
    else expect(current.agents['aw-team-dependency-dependency-role']).toBeUndefined();
    await value.expectProtectedContent();
  }, 30_000);

  it('forces indirect dependency removal while preserving its Native consumer', async () => {
    const value = await fixture('project');
    const parentBefore = await fs.readFile(value.rolePath('parent'));
    const blocked = await runPublicLifecycle('remove', ['team/dependency'], value.location, value.runtime);
    expect(blocked.status, JSON.stringify(blocked)).toBe('blocked');
    expect(blocked.diagnostics).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
    expect(await fs.pathExists(value.rolePath('dependency'))).toBe(true);

    const removed = await runPublicLifecycle('remove', ['team/dependency'], {
      ...value.location, force: true,
    }, value.runtime);
    expect(removed.status, JSON.stringify(removed)).toBe('success');
    expect(removed.data).toMatchObject({ requirements: { roots: ['team/parent'] }, changes: { requirements: 'none' } });
    const current = (await readCodexConfigFile(value.configPath)).snapshot;
    expect(current.plugins[value.nativeId('dependency')]?.enabled).not.toBe(true);
    expect(current.agents['aw-team-dependency-dependency-role']).toBeUndefined();
    expect(await fs.pathExists(value.rolePath('dependency'))).toBe(false);
    expect(current.plugins[value.nativeId('parent')]?.enabled).toBe(true);
    expect(await fs.readFile(value.rolePath('parent'))).toEqual(parentBefore);
    await value.expectProtectedContent();
  }, 30_000);
});
