import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  addPluginIntentRoot,
  calculatePluginIntentDigest,
  canonicalizePluginIntentState,
  createEmptyPluginIntentState,
  mergePluginIntentRootPlatforms,
  observePluginIntentState,
  parsePluginIntentState,
  readPluginIntentState,
  removePluginIntentRoot,
  removePluginIntentRootPlatforms,
  resolvePluginIntentStatePath,
  serializePluginIntentState,
  upsertPluginIntentRoot,
  writePluginIntentState,
} from '../../src/utils/plugin-intent-state.js';
import { setAtomicConfigBeforeRenameHookForTests } from '../../src/utils/plugin-config.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

afterEach(() => {
  setAtomicConfigBeforeRenameHookForTests(undefined);
});

function state() {
  return canonicalizePluginIntentState({
    schemaVersion: 2,
    kind: 'aw-plugin-intents',
    roots: [
      { pluginId: 'team/root-b', platforms: ['codex'] },
      { pluginId: 'official/root-a', platforms: ['codex', 'claude'] },
    ],
    dependencyScopeOverrides: [
      { pluginId: 'team/dependency', platform: 'codex', scope: 'user' },
    ],
  });
}

async function projectFixture(name: string): Promise<string> {
  const cwd = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
  await fs.ensureDir(cwd);
  await git(cwd, ['init', '--quiet']);
  return cwd;
}

describe('plugin intent state v2', () => {
  it('strictly parses the user schema and rejects installed-ledger fields', () => {
    expect(parsePluginIntentState(state())).toEqual(state());
    for (const invalid of [
      { ...state(), schemaVersion: 1 },
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

  it('merges and removes only selected root platforms', () => {
    const initial = upsertPluginIntentRoot(createEmptyPluginIntentState(), {
      pluginId: 'official/demo',
      platforms: ['claude'],
    });
    const merged = mergePluginIntentRootPlatforms(initial, {
      pluginId: 'official/demo',
      platforms: ['codex'],
    });
    expect(merged.roots).toEqual([{
      pluginId: 'official/demo',
      platforms: ['claude', 'codex'],
    }]);
    expect(removePluginIntentRootPlatforms(merged, {
      pluginId: 'official/demo',
      platforms: ['codex'],
    }).roots).toEqual([{ pluginId: 'official/demo', platforms: ['claude'] }]);
  });

  it('rejects project reads and writes through the User v2 API', async () => {
    const location = { scope: 'project' as const, cwd: await projectFixture('intent-scope'),
      env: getCurrentSourceTestIsolation().env };
    await expect(readPluginIntentState(location)).rejects.toThrow('Project declarations require schemaVersion 3');
    await expect(writePluginIntentState(location, state())).rejects.toThrow('Project declarations require schemaVersion 3');
    expect(await fs.pathExists(resolvePluginIntentStatePath(location))).toBe(false);
  });

  it('distinguishes absent, valid empty, invalid JSON/schema, unsafe path, and unavailable reads', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await projectFixture('intent-observation');
    const location = { scope: 'user' as const, cwd, env: isolation.env };
    const directory = isolation.layout.awHomeDir;
    const filePath = path.join(directory, 'plugin-intents.json');

    await expect(observePluginIntentState(location)).resolves.toEqual({ state: 'absent' });
    await writePluginIntentState(location, createEmptyPluginIntentState());
    await expect(observePluginIntentState(location)).resolves.toEqual({
      state: 'ready', value: createEmptyPluginIntentState(),
    });

    await fs.writeFile(filePath, '{broken');
    await expect(observePluginIntentState(location)).resolves.toMatchObject({ state: 'invalid' });
    await fs.writeJson(filePath, { ...createEmptyPluginIntentState(), schemaVersion: 1 });
    await expect(observePluginIntentState(location)).resolves.toMatchObject({ state: 'invalid' });

    await fs.remove(directory);
    const outside = path.join(isolation.layout.fixtureCwd, 'intent-observation-outside');
    await fs.ensureDir(outside);
    await fs.symlink(outside, directory, 'dir');
    await expect(observePluginIntentState(location)).resolves.toMatchObject({ state: 'invalid' });

    await fs.remove(directory);
    await fs.ensureDir(directory);
    await fs.writeJson(filePath, createEmptyPluginIntentState());
    const unavailable = Object.assign(new Error('injected read failure'), { code: 'EACCES' });
    const readFile = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(unavailable);
    try {
      await expect(observePluginIntentState(location)).resolves.toMatchObject({ state: 'unavailable' });
    } finally {
      readFile.mockRestore();
    }

    const abortError = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const abortedRead = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(abortError);
    try {
      await expect(observePluginIntentState(location)).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      abortedRead.mockRestore();
    }
  });

  it('keeps the production TUI status load available when the project declaration is invalid', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const cwd = await projectFixture('intent-status-invalid');
    await fs.outputFile(path.join(cwd, '.agent-workflows', 'plugin-intents.json'), '{broken');
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd,
      env: isolation.env,
      interactive: false,
      nativeCliRunner: async (invocation) => ({
        exitCode: 0,
        stdout: invocation.args.includes('--version')
          ? 'codex-cli 99.0.0'
          : JSON.stringify({ installed: [], available: [] }),
        stderr: '',
      }),
    }));

    await expect(dependencies.loadStatus(new AbortController().signal)).resolves.toMatchObject({
      projectIntent: {
        state: 'invalid',
        code: 'pluginIntentStateInvalid',
      },
      payload: {
        schemaVersion: 8,
        errors: expect.arrayContaining([
          expect.objectContaining({ code: 'pluginIntentStateInvalid' }),
        ]),
      },
    });
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
