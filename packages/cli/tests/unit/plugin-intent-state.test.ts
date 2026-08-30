import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it } from 'vitest';

import {
  addPluginIntentRoot,
  calculatePluginIntentDigest,
  canonicalizePluginIntentState,
  convergePluginIntentManagedCodexOwnership,
  createEmptyPluginIntentState,
  parsePluginIntentState,
  readPluginIntentState,
  removePluginIntentRoot,
  resolvePluginIntentStatePath,
  serializePluginIntentState,
  upsertPluginIntentRoot,
  widenPluginIntentManagedCodexOwnership,
  writePluginIntentState,
} from '../../src/utils/plugin-intent-state.js';
import { setAtomicConfigBeforeRenameHookForTests } from '../../src/utils/plugin-config.js';
import { git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

afterEach(() => {
  setAtomicConfigBeforeRenameHookForTests(undefined);
});

function state() {
  return canonicalizePluginIntentState({
    schemaVersion: 1,
    kind: 'aw-plugin-intents',
    roots: [
      { pluginId: 'team/root-b', platforms: ['codex'] },
      { pluginId: 'official/root-a', platforms: ['codex', 'claude'] },
    ],
    dependencyScopeOverrides: [
      { pluginId: 'team/dependency', platform: 'codex', scope: 'user' },
    ],
    managed: { codexPluginIds: ['root-b@team', 'root-a@aw'] },
  });
}

async function projectFixture(name: string): Promise<string> {
  const cwd = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
  await fs.ensureDir(cwd);
  await git(cwd, ['init', '--quiet']);
  return cwd;
}

describe('plugin intent state v1', () => {
  it('strictly parses one user/project schema and rejects installed-ledger fields', () => {
    expect(parsePluginIntentState(state())).toEqual(state());
    for (const invalid of [
      { ...state(), schemaVersion: 2 },
      { ...state(), kind: 'aw-user-plugin-intents' },
      { ...state(), version: '1.0.0' },
      { ...state(), roots: [{ pluginId: 'root-a', platforms: ['codex'] }] },
      { ...state(), roots: [{ pluginId: 'official/root-a', platforms: ['both'] }] },
      { ...state(), dependencyScopeOverrides: [
        { pluginId: 'team/dependency', platform: 'codex', scope: 'global' },
      ] },
    ]) {
      expect(() => parsePluginIntentState(invalid)).toThrow();
    }
  });

  it('produces a canonical round trip and digest independent of input order', () => {
    const canonical = state();
    const reordered = canonicalizePluginIntentState({
      ...canonical,
      roots: [...canonical.roots].reverse().map((root) => ({
        ...root,
        platforms: [...root.platforms].reverse(),
      })),
      managed: { codexPluginIds: [...canonical.managed.codexPluginIds].reverse() },
    });

    expect(serializePluginIntentState(reordered)).toBe(serializePluginIntentState(canonical));
    expect(parsePluginIntentState(JSON.parse(serializePluginIntentState(canonical))))
      .toEqual(canonical);
    expect(calculatePluginIntentDigest(reordered)).toBe(calculatePluginIntentDigest(canonical));
    expect(calculatePluginIntentDigest(canonical)).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('upserts and removes roots without recording dependency or success facts', () => {
    const initial = createEmptyPluginIntentState();
    const added = addPluginIntentRoot(initial, {
      pluginId: 'official/demo',
      platforms: ['codex'],
    });
    expect(() => addPluginIntentRoot(added, {
      pluginId: 'official/demo', platforms: ['claude'],
    })).toThrow('already exists');
    const updated = upsertPluginIntentRoot(added, {
      pluginId: 'official/demo',
      platforms: ['claude'],
    });

    expect(updated.roots).toEqual([{
      pluginId: 'official/demo',
      platforms: ['claude'],
    }]);
    expect(removePluginIntentRoot(updated, 'official/demo').roots).toEqual([]);
  });

  it('widens managed ownership before work and converges it after success', () => {
    const initial = {
      ...createEmptyPluginIntentState(),
      managed: { codexPluginIds: ['old@aw'] },
    };
    const widened = widenPluginIntentManagedCodexOwnership(initial, ['next@aw']);
    expect(widened.managed.codexPluginIds).toEqual(['next@aw', 'old@aw']);
    expect(convergePluginIntentManagedCodexOwnership(widened, ['next@aw']).managed.codexPluginIds)
      .toEqual(['next@aw']);
  });

  it('uses fixed user/project paths and does not create a missing state on read', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await projectFixture('intent-paths');
    expect(resolvePluginIntentStatePath({ scope: 'user', cwd, env: isolation.env }))
      .toBe(path.join(isolation.layout.awHomeDir, 'plugin-intents.json'));
    expect(resolvePluginIntentStatePath({ scope: 'project', cwd, env: isolation.env }))
      .toBe(path.join(cwd, '.agent-workflows', 'plugin-intents.json'));
    await expect(readPluginIntentState({ scope: 'project', cwd, env: isolation.env }))
      .resolves.toEqual(createEmptyPluginIntentState());
    await expect(fs.pathExists(path.join(cwd, '.agent-workflows'))).resolves.toBe(false);
  });

  it('writes both scopes atomically and applies the project shared visibility gate', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await projectFixture('intent-write');
    const expected = state();
    await writePluginIntentState({ scope: 'user', cwd, env: isolation.env }, expected);
    await writePluginIntentState({ scope: 'project', cwd, env: isolation.env }, expected);
    await expect(readPluginIntentState({ scope: 'user', cwd, env: isolation.env }))
      .resolves.toEqual(expected);
    await expect(readPluginIntentState({ scope: 'project', cwd, env: isolation.env }))
      .resolves.toEqual(expected);

    const ignored = await projectFixture('intent-ignored');
    await fs.outputFile(
      path.join(ignored, '.gitignore'),
      '.agent-workflows/\n',
    );
    await fs.ensureDir(path.join(ignored, '.agent-workflows'));
    const ignoredTarget = path.join(ignored, '.agent-workflows', 'plugin-intents.json');
    await expect(writePluginIntentState({
      scope: 'project', cwd: ignored, env: isolation.env,
    }, expected)).rejects.toThrow('被 ignore');
    await expect(fs.pathExists(ignoredTarget)).resolves.toBe(false);
  });

  it('rejects symbolic-link path components for reads and writes', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await projectFixture('intent-symlink');
    const outside = path.join(isolation.layout.fixtureCwd, 'intent-outside');
    await fs.ensureDir(outside);
    await fs.symlink(outside, path.join(cwd, '.agent-workflows'), 'dir');

    await expect(readPluginIntentState({ scope: 'project', cwd, env: isolation.env }))
      .rejects.toThrow('符号链接');
    await expect(writePluginIntentState({
      scope: 'project', cwd, env: isolation.env,
    }, state())).rejects.toThrow('符号链接');
  });

  it('rejects a user intent root that is a symlink or non-directory', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = {
      scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    const awHome = isolation.layout.awHomeDir;
    const outside = path.join(isolation.layout.fixtureCwd, 'user-intent-outside');
    await fs.ensureDir(outside);
    await fs.remove(awHome);
    await fs.symlink(outside, awHome, 'dir');
    await expect(readPluginIntentState(location)).rejects.toThrow('regular directory');

    await fs.remove(awHome);
    await fs.outputFile(awHome, 'not a directory\n');
    await expect(readPluginIntentState(location)).rejects.toThrow('regular directory');
  });

  it('preserves the previous state and removes the temporary file on atomic failure', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = {
      scope: 'user' as const,
      cwd: isolation.layout.fixtureCwd,
      env: isolation.env,
    };
    const previous = upsertPluginIntentRoot(createEmptyPluginIntentState(), {
      pluginId: 'official/previous', platforms: ['codex'],
    });
    const next = upsertPluginIntentRoot(previous, {
      pluginId: 'official/next', platforms: ['claude'],
    });
    await writePluginIntentState(location, previous);
    setAtomicConfigBeforeRenameHookForTests(async () => {
      throw new Error('injected intent failure');
    });

    await expect(writePluginIntentState(location, next)).rejects.toThrow('injected intent failure');
    await expect(readPluginIntentState(location)).resolves.toEqual(previous);
    const filePath = resolvePluginIntentStatePath(location);
    expect((await fs.readdir(path.dirname(filePath))).filter((entry) => entry.includes('.tmp-')))
      .toEqual([]);
  });
});
