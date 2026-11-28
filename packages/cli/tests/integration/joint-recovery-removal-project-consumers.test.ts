import path from 'node:path';
import fs from 'fs-extra';
import { expect, it } from 'vitest';
import { installNativeTestDiscovery } from '../helpers/native-execution-fixture.js';
import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { writeIntent, observeIntent } from '../../src/intent/intent-store.js';
import { setTargets } from '../../src/intent/deployment-preferences.js';
import { runRecovery } from '../../src/recovery/coordinator.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { fixture } from '../helpers/joint-recovery-fixture.js';

// A requirements-only exit leaves the installed Project consumer able to use its dependency.
it.each(['inherited skills', 'healthy project copy', 'damaged project copy', 'missing declared copy', 'removed consumer'] as const)(
  'removes a User root while accounting for %s in the current project', async (scenario) => {
    installNativeTestDiscovery();
    const value = await fixture(false, ['opencode']);
    const user = { ...value.options, scope: 'user' as const, context: 'user' as const };
    const project = { ...value.options, scope: 'project' as const, context: 'project' as const };
    const userDependency = path.join(value.nativeSkill('opencode', 'user', 'd'), 'SKILL.md');
    const projectDependency = path.join(value.nativeSkill('opencode', 'project', 'd'), 'SKILL.md');
    const projectConsumer = path.join(value.nativeSkill('opencode', 'project', 'b'), 'SKILL.md');
    await setTargets(user, ['opencode']);
    const hasProjectCopy = scenario === 'healthy project copy' || scenario === 'damaged project copy';
    if (hasProjectCopy) expect((await runRecovery('sync', ['team/b'], project)).ok).toBe(true);
    expect((await runRecovery('sync', ['team/a'], user)).ok).toBe(true);
    if (!hasProjectCopy) expect((await runRecovery('sync', ['team/b'], project)).ok).toBe(true);
    await expect(fs.readFile(userDependency, 'utf8')).resolves.toContain('Use d.');
    expect(await fs.pathExists(projectDependency)).toBe(hasProjectCopy);
    if (scenario === 'damaged project copy') await fs.appendFile(projectDependency, '\nOut of date.\n');

    expect((await runPublicLifecycle('remove', ['team/b'], { ...project, only: 'requirements' })).status).toBe('success');
    if (scenario === 'missing declared copy') {
      expect((await runPublicLifecycle('install', ['team/d'], { ...project, only: 'requirements' })).status).toBe('success');
    }
    if (scenario === 'removed consumer') {
      expect((await runPublicLifecycle('remove', ['team/b'], { ...project, only: 'outputs', targets: ['opencode'] })).status).toBe('success');
    } else await expect(fs.readFile(projectConsumer, 'utf8')).resolves.toContain('Use b.');

    const removed = await runPublicLifecycle('remove', ['team/a'], { ...project, scope: 'user' });
    expect(removed.status, JSON.stringify(removed.diagnostics)).toBe('success');
    expect(await fs.pathExists(path.join(value.nativeSkill('opencode', 'user', 'a'), 'SKILL.md'))).toBe(false);
    expect(await fs.pathExists(projectConsumer)).toBe(scenario !== 'removed consumer');
    expect(await fs.pathExists(userDependency)).toBe(scenario !== 'healthy project copy' && scenario !== 'removed consumer');
    if (hasProjectCopy) await expect(fs.readFile(projectDependency, 'utf8')).resolves.toContain('Use d.');
  }, 30_000,
);

it.each(['owned consumer', 'foreign consumer', 'removed consumer', 'healthy project copy'] as const)(
  'protects only dependencies still needed by a delisted %s', async (scenario) => {
    installNativeTestDiscovery();
    const value = await fixture(false, ['opencode']);
    const user = { ...value.options, scope: 'user' as const, context: 'user' as const };
    const project = { ...value.options, scope: 'project' as const, context: 'project' as const };
    const removeFromProject = { ...project, scope: 'user' as const };
    const projectB = path.join(value.nativeSkill('opencode', 'project', 'b'), 'SKILL.md');
    const userD = path.join(value.nativeSkill('opencode', 'user', 'd'), 'SKILL.md');
    const projectD = path.join(value.nativeSkill('opencode', 'project', 'd'), 'SKILL.md');
    const hasProjectCopy = scenario === 'healthy project copy';
    const userRoot = hasProjectCopy ? 'team/d' : 'team/a';
    await setTargets(user, ['opencode']);
    if (hasProjectCopy) {
      const intent = await observeIntent(user);
      if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
      await writeIntent(user, { ...intent.value, roots: [{ pluginId: userRoot }] });
      expect((await runRecovery('sync', ['team/b'], project)).ok).toBe(true);
    }
    expect((await runRecovery('sync', [userRoot], user)).ok).toBe(true);
    if (!hasProjectCopy) expect((await runRecovery('sync', ['team/b'], project)).ok).toBe(true);
    expect(await fs.pathExists(projectD)).toBe(hasProjectCopy);
    expect((await runPublicLifecycle('remove', ['team/b'], { ...project, only: 'requirements' })).status).toBe('success');

    const indexPath = path.join(value.source, 'catalog-manifest.json');
    const index = await fs.readJson(indexPath) as { entries: Array<{ name: string }> };
    await fs.writeJson(indexPath, { ...index, entries: index.entries.filter(({ name }) => name !== 'b') });
    await fs.remove(path.join(value.source, 'plugins', 'b'));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: user.env });
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: user.env });
    expect(active.manifest.entries.map(({ name }) => name)).not.toContain('b');

    const cleanProjectB = () => runPublicLifecycle('remove', ['team/b'], { ...project, only: 'outputs', targets: ['opencode'] });
    if (scenario === 'removed consumer') expect((await cleanProjectB()).status).toBe('success');
    if (scenario === 'foreign consumer') await fs.remove(path.join(path.resolve(projectB, '../../..'), SKILL_OWNER_MARKER));
    const before = await observeIntent(user);
    const removed = await runPublicLifecycle('remove', [userRoot], removeFromProject);
    if (scenario === 'owned consumer') {
      expect(removed.status).toBe('blocked');
      expect(removed.diagnostics).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
      expect(await observeIntent(user)).toEqual(before);
      await expect(fs.readFile(userD, 'utf8')).resolves.toContain('Use d.');
      await expect(fs.readFile(projectB, 'utf8')).resolves.toContain('Use b.');
      expect((await cleanProjectB()).status).toBe('success');
      expect((await runPublicLifecycle('remove', [userRoot], removeFromProject)).status).toBe('success');
    } else {
      expect(removed.status, JSON.stringify(removed.diagnostics)).toBe('success');
    }
    expect(await fs.pathExists(userD)).toBe(false);
    expect(await fs.pathExists(projectB)).toBe(hasProjectCopy || scenario === 'foreign consumer');
    if (hasProjectCopy) await expect(fs.readFile(projectD, 'utf8')).resolves.toContain('Use d.');
  }, 30_000,
);
