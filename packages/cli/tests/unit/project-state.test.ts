import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addProjectRoot,
  observeProjectIntent,
  parseProjectIntent,
  removeProjectRoot,
  resolveProjectIntentPath,
  writeProjectIntent,
} from '../../src/project/project-state.js';
import { setAtomicConfigBeforeRenameHookForTests } from '../../src/utils/plugin-config.js';
import { git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

afterEach(() => setAtomicConfigBeforeRenameHookForTests(undefined));

async function repo(name: string): Promise<string> {
  const cwd = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
  await fs.ensureDir(cwd);
  await git(cwd, ['init', '--quiet']);
  return cwd;
}

function v3() {
  return {
    schemaVersion: 3 as const,
    kind: 'aw-plugin-intents' as const,
    sources: { team: { logicalIdentity: 'catalog-team' } },
    roots: [{ pluginId: 'team/demo' }],
  };
}

function v2() {
  return {
    schemaVersion: 2,
    kind: 'aw-plugin-intents',
    roots: [{ pluginId: 'team/demo', platforms: ['codex', 'claude'] }],
    dependencyScopeOverrides: [],
  };
}

describe('Project v3 state', () => {
  it('distinguishes absent, valid, unsupported, invalid and unreadable files', async () => {
    const cwd = await repo('project-states');
    const location = { cwd, env: getCurrentSourceTestIsolation().env };
    const filePath = resolveProjectIntentPath(location);
    expect(await observeProjectIntent(location)).toEqual({ state: 'absent' });

    await fs.outputFile(filePath, JSON.stringify(v3()));
    expect(await observeProjectIntent(location)).toMatchObject({
      state: 'valid', value: v3(), digest: expect.stringMatching(/^sha256:/u),
    });
    await fs.writeFile(filePath, JSON.stringify(v2()));
    expect(await observeProjectIntent(location)).toMatchObject({ state: 'unsupported-version', schemaVersion: 2 });
    await fs.writeFile(filePath, JSON.stringify({ ...v3(), schemaVersion: 4 }));
    expect(await observeProjectIntent(location)).toMatchObject({ state: 'unsupported-version', schemaVersion: 4 });
    for (const bytes of ['', '{bad', JSON.stringify({ ...v3(), roots: [
      { pluginId: 'team/demo' }, { pluginId: 'team/demo' },
    ] })]) {
      await fs.writeFile(filePath, bytes);
      const observed = await observeProjectIntent(location);
      expect(observed.state).toBe('invalid');
      if (observed.state === 'invalid') expect(observed.rawBytes?.equals(Buffer.from(bytes))).toBe(true);
    }
    const readFile = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(
      new Error('injected'), { code: 'EACCES' },
    ));
    try {
      expect(await observeProjectIntent(location)).toMatchObject({ state: 'unreadable' });
    } finally {
      readFile.mockRestore();
    }
  });

  it('rejects unknown fields, missing bindings and alias identity conflict', async () => {
    for (const value of [
      { ...v3(), installed: true },
      { ...v3(), roots: [{ pluginId: 'team/demo', platforms: ['codex'] }] },
      { ...v3(), sources: {} },
      { ...v3(), sources: { team: { logicalIdentity: '' } } },
    ]) expect(() => parseProjectIntent(value)).toThrow();

    const cwd = await repo('project-conflict');
    const location = { cwd, env: getCurrentSourceTestIsolation().env };
    await addProjectRoot(location, 'team/demo', 'identity-a');
    await expect(addProjectRoot(location, 'team/other', 'identity-b'))
      .rejects.toThrow('sourceIdentityConflict');
    expect((await observeProjectIntent(location)).state).toBe('valid');
  });

  it('removes only the exact root offline and prunes its final binding', async () => {
    const cwd = await repo('project-remove');
    const location = { cwd, env: getCurrentSourceTestIsolation().env };
    await addProjectRoot(location, 'team/demo', 'catalog-team');
    await addProjectRoot(location, 'team/other', 'catalog-team');
    await addProjectRoot(location, 'second/demo', 'catalog-second');
    expect((await removeProjectRoot(location, 'team/demo')).state.roots).toEqual([
      { pluginId: 'second/demo' }, { pluginId: 'team/other' },
    ]);
    const removed = await removeProjectRoot(location, 'team/other');
    expect(removed.state.sources).toEqual({ second: { logicalIdentity: 'catalog-second' } });
    const bytes = await fs.readFile(resolveProjectIntentPath(location));
    expect((await removeProjectRoot(location, 'team/other')).changed).toBe(false);
    expect(await fs.readFile(resolveProjectIntentPath(location))).toEqual(bytes);
  });

  it('keeps prior bytes if atomic replacement fails and rejects ignored shared state', async () => {
    const cwd = await repo('project-atomic');
    const location = { cwd, env: getCurrentSourceTestIsolation().env };
    await writeProjectIntent(location, v3());
    const filePath = resolveProjectIntentPath(location);
    const bytes = await fs.readFile(filePath);
    setAtomicConfigBeforeRenameHookForTests(async () => { throw new Error('injected'); });
    await expect(addProjectRoot(location, 'team/other', 'catalog-team')).rejects.toThrow('injected');
    expect(await fs.readFile(filePath)).toEqual(bytes);
    setAtomicConfigBeforeRenameHookForTests(undefined);

    const ignored = await repo('project-ignored');
    await fs.writeFile(path.join(ignored, '.gitignore'), '.agent-workflows/\n');
    await fs.ensureDir(path.join(ignored, '.agent-workflows'));
    expect(await git(ignored, ['check-ignore', '-v', '.agent-workflows/plugin-intents.json']))
      .toContain('.agent-workflows/');
    await expect(addProjectRoot({ cwd: ignored, env: location.env }, 'team/demo', 'catalog-team'))
      .rejects.toThrow('projectConfigIgnored');
    expect(await fs.pathExists(resolveProjectIntentPath({ cwd: ignored }))).toBe(false);
  });

  it('rejects edits to Project v2 and preserves the original bytes', async () => {
    const location = { cwd: await repo('project-v2-rejected'), env: getCurrentSourceTestIsolation().env };
    const filePath = resolveProjectIntentPath(location);
    const bytes = Buffer.from(JSON.stringify(v2()));
    await fs.outputFile(filePath, bytes);
    await expect(addProjectRoot(location, 'team/other', 'catalog-team')).rejects.toThrow('unsupported-version');
    expect(await fs.readFile(filePath)).toEqual(bytes);
  });

  it('does not follow a symbolic link in the shared declaration path', async () => {
    const cwd = await repo('project-symlink');
    const location = { cwd, env: getCurrentSourceTestIsolation().env };
    const outside = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'project-symlink-outside.json');
    await fs.writeFile(outside, JSON.stringify(v3()));
    await fs.ensureDir(path.dirname(resolveProjectIntentPath(location)));
    await fs.symlink(outside, resolveProjectIntentPath(location));
    expect(await observeProjectIntent(location)).toMatchObject({ state: 'invalid' });
    await expect(addProjectRoot(location, 'team/other', 'catalog-team')).rejects.toThrow('invalid state');
    expect(await fs.readFile(outside, 'utf8')).toBe(JSON.stringify(v3()));
  });

  it('uses the top-level root from a subdirectory and starts empty only when absent', async () => {
    const cwd = await repo('project-top-level');
    const nested = path.join(cwd, 'nested');
    await fs.ensureDir(nested);
    const env = getCurrentSourceTestIsolation().env;
    expect(resolveProjectIntentPath({ cwd: nested })).toBe(resolveProjectIntentPath({ cwd }));
    await addProjectRoot({ cwd: nested, env }, 'team/demo', 'catalog-team');
    expect(await observeProjectIntent({ cwd, env })).toMatchObject({ state: 'valid', value: v3() });
  });
});
