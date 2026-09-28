import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
  createEmptyProjectPreferences,
  observeProjectPreferences,
  parseProjectPreferences,
  resetProjectTargets,
  resolveProjectPreferencesPath,
  selectProjectAgents,
  setProjectAgents,
  writeProjectPreferences,
} from '../../src/project/project-preferences.js';
import { git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function repo(name: string): Promise<string> {
  const cwd = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
  await fs.ensureDir(cwd);
  await git(cwd, ['init', '--quiet']);
  return cwd;
}

describe('project preferences', () => {
  it('validates the schema, Agent IDs and override keys', () => {
    const base = createEmptyProjectPreferences();
    expect(parseProjectPreferences({ ...base, agents: ['cursor', 'codex', 'cursor'] }).agents)
      .toEqual(['codex', 'cursor']);
    for (const value of [
      { ...base, agents: ['all'] },
      { ...base, agents: ['*'] },
      { ...base, agents: ['-codex'] },
      { ...base, agents: ['claude'] },
      { ...base, agents: ['codex\n'] },
      { ...base, dependencyScopeOverrides: [{ pluginId: 'team/demo', platform: 'cursor', scope: 'user' }] },
      { ...base, dependencyScopeOverrides: [{ pluginId: 'team/demo', platform: 'codex', scope: 'global' }] },
      { ...base, dependencyScopeOverrides: [{ pluginId: 'demo', platform: 'codex', scope: 'user' }] },
      { ...base, unknown: true },
    ]) expect(() => parseProjectPreferences(value)).toThrow();
  });

  it('uses exact one-time target selection and never masks invalid local preferences', () => {
    const absent = { state: 'absent' as const };
    expect(selectProjectAgents({ preferences: absent })).toEqual({
      agents: [], origin: 'none', preferences: 'absent',
    });
    expect(selectProjectAgents({ preferences: absent, target: 'claude' }).agents)
      .toEqual(['claude-code']);
    expect(selectProjectAgents({ preferences: absent, platform: 'claude' }).agents)
      .toEqual(['claude-code']);
    expect(() => selectProjectAgents({ preferences: absent, target: 'all' })).toThrow();
    expect(() => selectProjectAgents({ preferences: absent, platform: 'cursor' })).toThrow();
    expect(() => selectProjectAgents({ preferences: absent, target: 'codex', platform: 'claude' }))
      .toThrow('mutually exclusive');
    expect(() => selectProjectAgents({
      preferences: { state: 'invalid', code: 'projectPreferencesInvalid' }, target: 'codex',
    })).toThrow('invalid preferences');
  });

  it('preserves overrides on set and clears both fields on reset', async () => {
    const cwd = await repo('preference-edit');
    const location = { cwd, env: getCurrentSourceTestIsolation().env };
    const withOverride = {
      ...createEmptyProjectPreferences(),
      agents: ['codex' as const],
      dependencyScopeOverrides: [{ pluginId: 'team/dependency', platform: 'codex' as const, scope: 'user' as const }],
    };
    await writeProjectPreferences(location, withOverride);
    expect((await setProjectAgents(location, ['cursor', 'cursor'])).value).toMatchObject({
      agents: ['cursor'], dependencyScopeOverrides: withOverride.dependencyScopeOverrides,
    });
    const filePath = await resolveProjectPreferencesPath(location);
    const bytes = await fs.readFile(filePath);
    expect((await setProjectAgents(location, ['cursor'])).changed).toBe(false);
    expect(await fs.readFile(filePath)).toEqual(bytes);
    expect((await resetProjectTargets(location)).value).toEqual(createEmptyProjectPreferences());
  });

  it('reports corrupt preferences, protects them from set and permits explicit reset', async () => {
    const cwd = await repo('preference-invalid');
    const location = { cwd, env: getCurrentSourceTestIsolation().env };
    const filePath = await resolveProjectPreferencesPath(location);
    await fs.outputFile(filePath, '{bad');
    expect(await observeProjectPreferences(location)).toMatchObject({ state: 'invalid' });
    await expect(setProjectAgents(location, ['codex'])).rejects.toThrow('invalid state');
    expect(await fs.readFile(filePath, 'utf8')).toBe('{bad');
    expect((await resetProjectTargets(location)).changed).toBe(true);
    expect(await observeProjectPreferences(location)).toMatchObject({
      state: 'valid', value: createEmptyProjectPreferences(),
    });
  });

  it('keeps subdirectories and path aliases at one repo key, and separates linked worktrees', async () => {
    const cwd = await repo('preference-worktree');
    const nested = path.join(cwd, 'nested');
    const alias = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'preference-alias');
    const linked = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'preference-linked');
    await fs.ensureDir(nested);
    await fs.symlink(cwd, alias, 'dir');
    await fs.writeFile(path.join(cwd, 'tracked.txt'), 'content');
    await git(cwd, ['add', 'tracked.txt']);
    await git(cwd, ['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '--quiet', '-m', 'fixture']);
    await git(cwd, ['worktree', 'add', '--quiet', '--detach', linked]);
    const env = getCurrentSourceTestIsolation().env;
    const mainPath = await resolveProjectPreferencesPath({ cwd, env });
    expect(await resolveProjectPreferencesPath({ cwd: nested, env })).toBe(mainPath);
    expect(await resolveProjectPreferencesPath({ cwd: path.join(nested, '..'), env })).toBe(mainPath);
    expect(await resolveProjectPreferencesPath({ cwd: alias, env })).toBe(mainPath);
    expect(await resolveProjectPreferencesPath({ cwd: linked, env })).not.toBe(mainPath);
    await setProjectAgents({ cwd, env }, ['codex']);
    expect(await observeProjectPreferences({ cwd: linked, env })).toEqual({ state: 'absent' });
  });
});
