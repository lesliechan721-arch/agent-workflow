import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { addIntentRoot, calculateIntentDigest, createEmptyIntent, parseIntent,
  removeIntentRoot, serializeIntent } from '../../src/intent/intent-codec.js';
import {
  createEmptyPreferences, observePreferences, parsePreferences, resetTargets,
  resolvePreferencesPath, selectAgents, setAgents, writePreferences,
} from '../../src/intent/deployment-preferences.js';
import { addRoot, observeIntent, removeRoot, resolveIntentPath, writeIntent } from '../../src/intent/intent-store.js';
import { setAtomicConfigBeforeRenameHookForTests } from '../../src/utils/plugin-config.js';
import { git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const intent = {
  schemaVersion: 3 as const, kind: 'aw-plugin-intents' as const,
  sources: { team: { logicalIdentity: 'catalog-team' } },
  roots: [{ pluginId: 'team/demo' }],
};

afterEach(() => setAtomicConfigBeforeRenameHookForTests(undefined));

async function repo(name: string): Promise<string> {
  const root = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
  await fs.ensureDir(root);
  await git(root, ['init', '--quiet']);
  return root;
}

describe('scoped intent foundation', () => {
  it('keeps a pure v3 codec with exact roots, bindings and no placement fields', () => {
    expect(parseIntent(intent)).toEqual(intent);
    for (const value of [
      { ...intent, roots: [{ pluginId: 'team/demo', agents: ['codex'] }] },
      { ...intent, roots: [{ pluginId: 'team/demo', platforms: ['codex'] }] },
      { ...intent, roots: [{ pluginId: 'team/demo', distribution: 'agent-skills' }] },
      { ...intent, roots: [{ pluginId: 'other/demo' }] },
      { ...intent, roots: [intent.roots[0], intent.roots[0]] },
    ]) expect(() => parseIntent(value)).toThrow();
    expect(() => addIntentRoot(intent, 'team/other', 'other-identity')).toThrow('sourceIdentityConflict');
    const added = addIntentRoot(createEmptyIntent(), 'team/demo', 'catalog-team');
    expect(removeIntentRoot(added, 'team/demo')).toEqual(createEmptyIntent());
    const reordered = { ...intent, roots: [{ pluginId: 'team/other' }, ...intent.roots] };
    const sorted = { ...intent, roots: [...intent.roots, { pluginId: 'team/other' }] };
    expect(serializeIntent(reordered)).toBe(serializeIntent(sorted));
    expect(calculateIntentDigest(reordered)).toBe(calculateIntentDigest(sorted));
  });

  it('stores the same v3 model independently in User and Project, including a non-repo User cwd', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const ordinary = path.join(isolation.layout.fixtureCwd, 'ordinary');
    const project = await repo('project');
    await fs.ensureDir(ordinary);
    const user = { scope: 'user' as const, cwd: ordinary, env: isolation.env };
    const local = { scope: 'project' as const, cwd: project, env: isolation.env };
    expect(await observeIntent(user)).toEqual({ state: 'absent' });
    await addRoot(user, 'team/demo', 'catalog-team');
    await addRoot(local, 'team/demo', 'catalog-team');
    expect((await observeIntent(user))).toMatchObject({ state: 'valid', value: intent });
    expect((await observeIntent(local))).toMatchObject({ state: 'valid', value: intent });
    expect(await resolveIntentPath(user)).not.toBe(await resolveIntentPath(local));
    const projectBytes = await fs.readFile(await resolveIntentPath(local));
    await addRoot(user, 'team/extra', 'catalog-team');
    expect(await fs.readFile(await resolveIntentPath(local))).toEqual(projectBytes);
  });

  it('does not overwrite invalid or unsupported bytes and keeps raw-byte evidence', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
    const file = await resolveIntentPath(location);
    for (const bytes of ['', '{bad', JSON.stringify({ ...intent, schemaVersion: 2 })]) {
      await fs.outputFile(file, bytes);
      const observed = await observeIntent(location);
      expect(observed.state).toBe(bytes.includes('schemaVersion') ? 'unsupported-version' : 'invalid');
      if ('rawBytes' in observed) expect(observed.rawBytes?.equals(Buffer.from(bytes))).toBe(true);
      await expect(addRoot(location, 'team/other', 'catalog-team')).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    }
  });

  it('removes only the selected root, preserves extra bindings and makes a no-op byte-stable', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const local = { scope: 'project' as const, cwd: await repo('exact-remove'), env: isolation.env };
    const withExtra = { ...intent, sources: { ...intent.sources, unused: { logicalIdentity: 'other' } } };
    await writeIntent(local, withExtra);
    const file = await resolveIntentPath(local);
    const bytes = await fs.readFile(file);
    expect((await addRoot(local, 'team/demo', 'catalog-team')).changed).toBe(false);
    expect(await fs.readFile(file)).toEqual(bytes);
    const removed = await removeRoot(local, 'team/demo');
    expect(removed.value).toEqual({ ...createEmptyIntent(), sources: { unused: { logicalIdentity: 'other' } } });
    expect((await removeRoot(local, 'team/demo')).changed).toBe(false);
  });

  it('preserves bytes on failed atomic write and refuses ignored Project paths', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const local = { scope: 'project' as const, cwd: await repo('atomic-project'), env: isolation.env };
    await addRoot(local, 'team/demo', 'catalog-team');
    const file = await resolveIntentPath(local);
    const bytes = await fs.readFile(file);
    setAtomicConfigBeforeRenameHookForTests(async () => { throw new Error('injected'); });
    await expect(addRoot(local, 'team/other', 'catalog-team')).rejects.toThrow('injected');
    expect(await fs.readFile(file)).toEqual(bytes);
    setAtomicConfigBeforeRenameHookForTests(undefined);
    const ignored = await repo('ignored-project');
    await fs.writeFile(path.join(ignored, '.gitignore'), '.agent-workflows/\n');
    await fs.ensureDir(path.join(ignored, '.agent-workflows'));
    expect(await git(ignored, ['check-ignore', '-v', '.agent-workflows/plugin-intents.json']))
      .toContain('.agent-workflows/');
    await expect(addRoot({ ...local, cwd: ignored }, 'team/demo', 'catalog-team'))
      .rejects.toThrow('projectConfigIgnored');
    expect(await fs.pathExists(await resolveIntentPath({ ...local, cwd: ignored }))).toBe(false);
  });

  it('classifies unsafe or unreadable files and preserves outside bytes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const local = { scope: 'project' as const, cwd: await repo('unsafe-project'), env: isolation.env };
    const file = await resolveIntentPath(local);
    const outside = path.join(isolation.layout.fixtureCwd, 'outside.json');
    await fs.writeFile(outside, JSON.stringify(intent));
    await fs.ensureDir(path.dirname(file));
    await fs.symlink(outside, file);
    expect(await observeIntent(local)).toMatchObject({ state: 'invalid' });
    await expect(addRoot(local, 'team/other', 'catalog-team')).rejects.toThrow(file);
    expect(await fs.readFile(outside, 'utf8')).toBe(JSON.stringify(intent));
    await fs.remove(file);
    await fs.writeFile(file, JSON.stringify(intent));
    const read = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(
      new Error('injected'), { code: 'EACCES' },
    ));
    try { expect(await observeIntent(local)).toMatchObject({ state: 'unreadable' }); }
    finally { read.mockRestore(); }
  });

  it('shares one machine policy across scopes and preserves exclusions when changing targets', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const project = await repo('preferences-project');
    const user = { scope: 'user' as const, cwd: project, env: isolation.env };
    const local = { scope: 'project' as const, cwd: project, env: isolation.env };
    const exclusions = [{ plugin: 'team/dependency', target: 'codex' as const }];
    expect(() => parsePreferences({ ...createEmptyPreferences(), dependencyScopeOverrides: [] })).toThrow();
    await writePreferences(local, { ...createEmptyPreferences(), targets: ['codex'], exclusions });
    expect((await setAgents(user, ['cursor', 'cursor'])).value).toMatchObject({ targets: ['cursor'], exclusions });
    expect(await resolvePreferencesPath(local)).toBe(await resolvePreferencesPath(user));
    expect(await observePreferences(local)).toMatchObject({ state: 'valid', value: { targets: ['cursor'], exclusions } });
    expect(await fs.pathExists(await resolveIntentPath(user))).toBe(false);
    expect(await fs.pathExists(await resolveIntentPath(local))).toBe(false);
    await resetTargets(user);
    expect(await observePreferences(local)).toMatchObject({ value: createEmptyPreferences() });
    expect(selectAgents({ preferences: { state: 'absent' } })).toEqual({ agents: [], origin: 'none', preferences: 'absent' });
  });

  it('preserves legacy kind bytes; only explicit reset replaces invalid preferences', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const project = await repo('legacy-preferences');
    const local = { scope: 'project' as const, cwd: project, env: isolation.env };
    const file = await resolvePreferencesPath(local);
    const legacy = JSON.stringify({ ...createEmptyPreferences(), kind: 'aw-project-preferences' });
    await fs.outputFile(file, legacy);
    expect(await observePreferences(local)).toMatchObject({ state: 'invalid' });
    await expect(setAgents(local, ['codex'])).rejects.toThrow(file);
    expect(() => selectAgents({
      preferences: { state: 'invalid', code: 'deploymentPreferencesInvalid' }, targets: ['codex'],
    })).toThrow('invalid preferences');
    expect(await fs.readFile(file, 'utf8')).toBe(legacy);
    await resetTargets(local);
    expect(await observePreferences(local)).toMatchObject({ state: 'valid', value: createEmptyPreferences() });
  });

  it('shares machine preferences between linked worktrees and rejects Project Intent outside a repository', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const main = path.join(isolation.layout.fixtureCwd, 'worktree-main');
    const linked = path.join(isolation.layout.fixtureCwd, 'worktree-linked');
    await fs.ensureDir(main);
    await git(main, ['init', '--quiet']);
    await fs.writeFile(path.join(main, 'tracked.txt'), 'content');
    await git(main, ['add', 'tracked.txt']);
    await git(main, ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test',
      'commit', '--quiet', '-m', 'fixture']);
    await git(main, ['worktree', 'add', '--quiet', '--detach', linked]);
    const first = { scope: 'project' as const, cwd: main, env: isolation.env };
    const second = { scope: 'project' as const, cwd: linked, env: isolation.env };
    expect(await resolvePreferencesPath(first)).toBe(await resolvePreferencesPath(second));
    await setAgents(first, ['codex']);
    await setAgents(second, ['cursor']);
    expect(await observePreferences(first)).toMatchObject({ value: { targets: ['cursor'] } });
    expect(await observePreferences(second)).toMatchObject({ value: { targets: ['cursor'] } });
    const ordinary = path.join(isolation.layout.fixtureCwd, 'no-repo');
    await fs.ensureDir(ordinary);
    await expect(resolveIntentPath({ scope: 'project', cwd: ordinary, env: isolation.env }))
      .rejects.toThrow('projectRootUnavailable');
  });
});
