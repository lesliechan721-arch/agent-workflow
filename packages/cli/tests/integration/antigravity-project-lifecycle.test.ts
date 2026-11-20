import path from 'node:path';
import fs from 'fs-extra';
import { expect, it } from 'vitest';

import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { runPublicPluginStatus } from '../../src/commands/public-plugin-query.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { getPhysicalKey } from '../../src/platforms/identity.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogGenerationState } from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogStoreLocation } from '../../src/utils/catalog-generation-store.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { SKILL_OWNER_MARKER, type SkillOwnerMarker } from '../../src/utils/ownership.js';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function projectFixture(sourceIds = ['local']) {
  installNativeTestQualification({ platforms: ['antigravity'], discovery: true, executable: process.execPath });
  const { env, layout } = getCurrentSourceTestIsolation();
  const cwd = await fs.realpath(layout.fixtureCwd);
  await git(cwd, ['init', '--quiet']);
  const sources = await Promise.all(sourceIds.map(async (id, index) => {
    const catalog = path.join(cwd, id);
    const skillRoot = path.join(catalog, 'plugins/demo/skills/demo');
    await fs.outputFile(path.join(skillRoot, 'SKILL.md'), `---\nname: demo\ndescription: Use demo.\n---\nFrom ${id}.\n`);
    await fs.outputFile(path.join(skillRoot, 'README.md'), 'Demo skill.\n');
    await createCatalogSnapshotFixture(catalog, 'demo', [], 'Antigravity fixture.\n', (manifest) => {
      manifest.platforms = ['antigravity'];
      manifest.skills = './skills';
    });
    return { id, type: 'path' as const, primary: index === 0, path: catalog };
  }));
  const configured = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ env, expectedDigest: configured.digest, config: { schemaVersion: 2, sources } });
  for (const sourceId of sourceIds) await syncCatalogSourceGeneration({ sourceId, cliVersion: '1.0.0', env });
  await setTargets({ cwd, env, scope: 'user' }, ['antigravity']);

  const pluginsRoot = path.join(cwd, '.agents/plugins');
  const installed = path.join(pluginsRoot, 'demo');
  const legacy = path.join(pluginsRoot, 'aw-local-demo');
  const skill = 'skills/demo/SKILL.md';
  const options = { cwd, env, context: 'project', scope: 'project', cliVersion: '1.0.0', yes: true };
  const apply = (command: 'install' | 'sync' | 'remove', id = 'local/demo') =>
    runPublicLifecycle(command, [id], options);
  const removeOutputs = () => runPublicLifecycle('remove', ['local/demo'], { ...options, only: 'outputs', targets: ['antigravity'] });
  const removeAlternateRequirement = () => runPublicLifecycle('remove', ['alternate/demo'], { ...options, only: 'requirements' });
  const status = () => runPublicPluginStatus(['local/demo'], { cwd, env, context: 'project', cliVersion: '1.0.0', targets: ['antigravity'] });
  const seedLegacy = async (keepShort = false) => {
    const owner: SkillOwnerMarker = await fs.readJson(path.join(installed, SKILL_OWNER_MARKER));
    const physicalIdentity = { ...owner.nativeProjection!.physicalIdentity, resourceKey: 'aw-local-demo' };
    await (keepShort ? fs.copy(installed, legacy) : fs.move(installed, legacy));
    await fs.writeJson(path.join(legacy, SKILL_OWNER_MARKER), { ...owner, artifactKey: 'aw-local-demo',
      physicalKey: getPhysicalKey(physicalIdentity), nativeProjection: { ...owner.nativeProjection, physicalIdentity } });
  };
  const loseActiveSnapshot = async () => {
    const active = (await readCatalogGenerationState(env)).sources.local!.active!;
    const location = resolveCatalogStoreLocation({ logicalIdentity: active.logicalIdentity, snapshotDigest: active.snapshotDigest, env });
    await fs.remove(location.entryDir);
  };
  return { apply, status, seedLegacy, installed, legacy, skill, cwd, removeOutputs, removeAlternateRequirement, loseActiveSnapshot };
}

// Test Value Gate: an interrupted migration can have published the short copy
// before retiring the legacy copy. Status and sync still need to finish it.
it('migrates old Antigravity Project packages to the short name', async () => {
  const { apply, status, seedLegacy, installed, legacy, skill } = await projectFixture();
  const installedResult = await apply('install');
  expect(installedResult.status, JSON.stringify(installedResult)).toBe('success');
  expect(await fs.readJson(path.join(installed, '.antigravity-plugin/plugin.json'))).toMatchObject({ name: 'demo' });
  const installedBytes = await fs.readFile(path.join(installed, skill), 'utf8');
  expect(installedBytes).toContain('From local.');
  for (const keepShort of [false, true]) {
    await seedLegacy(keepShort);
    if (keepShort) {
      const pending = await status();
      expect(pending.data?.inSync).toBe(false);
      expect(pending.nextActions).toContainEqual(expect.objectContaining({ kind: 'command',
        argv: ['aw', 'plugin', 'sync', 'local/demo', '--context', 'project', '--target', 'antigravity'] }));
    }
    const synced = await apply('sync');
    expect(synced.status, JSON.stringify(synced)).toBe('success');
    expect(await fs.pathExists(legacy)).toBe(false);
    expect(await fs.readFile(path.join(installed, skill), 'utf8')).toBe(installedBytes);
  }
  const clean = await status();
  expect(clean.data?.allSatisfied, JSON.stringify(clean)).toBe(true);
}, 30_000);

// Test Value Gate: the source owner inventory must locate the old path when
// loss of the active bundle prevents rendering the current deployment.
it('removes an intact old Antigravity Project package without the active bundle', async () => {
  const { apply, seedLegacy, installed, legacy, removeOutputs, loseActiveSnapshot } = await projectFixture();
  const installedResult = await apply('install');
  expect(installedResult.status, JSON.stringify(installedResult)).toBe('success');
  await seedLegacy();
  await loseActiveSnapshot();
  const removed = await removeOutputs();
  expect(removed.status, JSON.stringify(removed)).toBe('success');
  expect(removed.data.requirements.roots).toEqual(['local/demo']);
  expect(await fs.pathExists(legacy)).toBe(false);
  expect(await fs.pathExists(installed)).toBe(false);
}, 30_000);

// Test Value Gate: same-name Catalog packages, foreign data, and symlink targets
// must survive both normal sync and removal at publicly visible paths.
it('preserves competing owners and local bytes during short-name Antigravity Project sync', async () => {
  const { apply, seedLegacy, installed, legacy, skill, cwd, removeAlternateRequirement } = await projectFixture(['local', 'alternate']);
  const installedResult = await apply('install');
  expect(installedResult.status, JSON.stringify(installedResult)).toBe('success');
  const installedBytes = await fs.readFile(path.join(installed, skill), 'utf8');
  const collision = await apply('install', 'alternate/demo');
  expect(collision.diagnostics, JSON.stringify(collision)).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'artifactCollision' }),
  ]));
  expect(await fs.readFile(path.join(installed, skill), 'utf8')).toBe(installedBytes);
  expect((await removeAlternateRequirement()).status).toBe('success');
  await seedLegacy();
  const extra = path.join(legacy, 'local.txt');
  await fs.outputFile(extra, 'Keep legacy data.\n');
  const external = path.join(cwd, 'manual-plugin');
  await fs.outputFile(path.join(external, skill), 'Keep link target.\n');
  await fs.symlink(external, installed, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await apply('sync');
  expect(linked.status, JSON.stringify(linked)).toBe('blocked');
  expect((await fs.lstat(installed)).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(path.join(external, skill), 'utf8')).toBe('Keep link target.\n');
  await fs.unlink(installed);
  const pending = await apply('sync');
  expect(pending.status, JSON.stringify(pending)).toBe('blocked');
  expect(pending.nextActions).toContainEqual(expect.objectContaining({ kind: 'manual', message: expect.stringContaining(legacy) }));
  expect(await fs.readFile(extra, 'utf8')).toBe('Keep legacy data.\n');
  const backup = path.join(cwd, 'old-plugin-backup');
  await fs.move(legacy, backup);
  await fs.symlink(external, legacy, process.platform === 'win32' ? 'junction' : 'dir');
  const linkedLegacy = await apply('sync');
  expect(linkedLegacy.status, JSON.stringify(linkedLegacy)).toBe('blocked');
  expect((await fs.lstat(legacy)).isSymbolicLink()).toBe(true);
  expect(await fs.readFile(path.join(external, skill), 'utf8')).toBe('Keep link target.\n');
  await fs.unlink(legacy);
  const migrated = await apply('sync');
  expect(migrated.status, JSON.stringify(migrated)).toBe('success');
  expect(await fs.readFile(path.join(backup, 'local.txt'), 'utf8')).toBe('Keep legacy data.\n');
  expect(await fs.readFile(path.join(installed, skill), 'utf8')).toBe(installedBytes);
  await fs.writeFile(path.join(installed, skill), 'Local short edit.\n');
  const rejected = await apply('sync');
  expect(rejected.status, JSON.stringify(rejected)).toBe('blocked');
  await apply('remove');
  expect(await fs.readFile(path.join(installed, skill), 'utf8')).toBe('Local short edit.\n');
  expect(await fs.readFile(path.join(backup, 'local.txt'), 'utf8')).toBe('Keep legacy data.\n');
}, 30_000);
