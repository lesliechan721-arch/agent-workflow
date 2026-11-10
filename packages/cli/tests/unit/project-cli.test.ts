import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { observeIntent, resolveIntentPath, writeIntent } from '../../src/intent/intent-store.js';
import { createEmptyIntent } from '../../src/intent/intent-codec.js';
import {
  observePreferences, writePreferences, createEmptyPreferences,
} from '../../src/intent/deployment-preferences.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(name: string) {
  const cwd = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
  await fs.ensureDir(cwd);
  await git(cwd, ['init', '--quiet']);
  return { cwd, env: getCurrentSourceTestIsolation().env, scope: 'project' as const };
}

async function activeCatalog(location: Awaited<ReturnType<typeof fixture>>) {
  const catalogRoot = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'project-cli-catalog');
  await createCatalogSnapshotFixture(catalogRoot);
  const current = await readCatalogSourcesConfigSnapshot(location.env);
  await replaceCatalogSourcesConfig({
    config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: catalogRoot }] },
    expectedDigest: current.digest, env: location.env,
  });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: location.env });
}

async function jsonCommand(args: string[], location: Awaited<ReturnType<typeof fixture>>) {
  const captured = createCapturedCliIo();
  const exit = await runCli([...(args[0] === 'target' ? [] : ['plugin']), ...args, '--json'], {
    cwd: location.cwd, env: location.env, interactive: false, io: captured.io,
  });
  const stdout = captured.readStdout();
  return { exit, stdout: JSON.parse(stdout) as Record<string, unknown>, stderr: captured.readStderr() };
}

describe('scoped CLI declaration and preference boundaries', () => {
  it('removes one exact root without reading the Catalog or deleting another root', async () => {
    const location = await fixture('intent-remove');
    await writeIntent(location, { ...createEmptyIntent(),
      sources: { team: { logicalIdentity: 'logical-team' } },
      roots: [{ pluginId: 'team/demo' }, { pluginId: 'team/other' }],
    });
    const output = await jsonCommand(['remove', '--only', 'requirements', 'team/demo', '--scope', 'project'], location);
    expect(output).toMatchObject({ exit: 0, stderr: '', stdout: {
      schemaVersion: 1, command: 'plugin.remove', status: 'success', data: {
        request: { scope: 'project', mode: 'requirements-only' },
        changes: { requirements: 'changed', preferences: 'none', outputs: 'none' },
        requirements: { roots: ['team/other'] }, targetResults: [],
      },
    } });
    expect((await observeIntent(location))).toMatchObject({ state: 'valid', value: {
      roots: [{ pluginId: 'team/other' }],
    } });
  });

  it('saves one machine target policy and preserves exclusions when targets are disabled', async () => {
    const location = await fixture('targets-reset');
    await writePreferences(location, { ...createEmptyPreferences(),
      exclusions: [{ plugin: 'team/dependency', target: 'codex' }],
    });
    const set = await jsonCommand(['target', 'set', 'cursor', 'codex', '--force', '--context', 'project'], location);
    expect(set).toMatchObject({ exit: 0, stdout: {
      command: 'target.set', status: 'success', data: { preferencesChanged: true,
        selection: { targets: ['codex', 'cursor'], origin: 'preference' } },
    } });
    expect(await observePreferences(location)).toMatchObject({ state: 'valid', value: {
      schemaVersion: 2, targets: ['codex', 'cursor'], exclusions: [{ plugin: 'team/dependency', target: 'codex' }],
    } });
    expect(await observePreferences({ ...location, scope: 'user' })).toEqual(await observePreferences(location));
    const reset = await jsonCommand(['target', 'set', '--none', '--context', 'project'], location);
    expect(reset).toMatchObject({ exit: 0, stdout: {
      command: 'target.set', status: 'success', data: { preferencesChanged: true, selection: { targets: [] } },
    } });
    expect(await observePreferences(location)).toMatchObject({ state: 'valid', value: {
      targets: [], exclusions: [{ plugin: 'team/dependency', target: 'codex' }],
    } });
  });

  it('adds a root only after verifying local Active and keeps its source binding', async () => {
    const location = await fixture('intent-add');
    await activeCatalog(location);
    const rejected = await jsonCommand(['install', '--only', 'requirements', 'team/demo', 'team/missing', '--scope', 'project'], location);
    expect(rejected).toMatchObject({ exit: 3, stdout: {
      command: 'plugin.install', status: 'blocked', data: { changes: { requirements: 'none' } },
      diagnostics: [{ code: 'pluginUnavailable' }],
    } });
    expect(await fs.pathExists(await resolveIntentPath(location))).toBe(false);
    const output = await jsonCommand(['install', '--only', 'requirements', 'team/demo', '--scope', 'project'], location);
    expect(output).toMatchObject({ exit: 0, stdout: {
      command: 'plugin.install', status: 'success', data: {
        changes: { requirements: 'changed' }, requirements: { roots: ['team/demo'] }, targetResults: [],
      },
    } });
    const stored = await fs.readJson(await resolveIntentPath(location));
    expect(stored).toMatchObject({ schemaVersion: 3, kind: 'aw-plugin-intents',
      sources: { team: { logicalIdentity: expect.any(String) } },
      roots: [{ pluginId: 'team/demo' }],
    });
  });

  it('resolves a unique install short name to a qualified project root', async () => {
    const location = await fixture('install-short');
    await activeCatalog(location);
    await writePreferences(location, { ...createEmptyPreferences(), targets: ['codex'] });
    const result = await jsonCommand(['install', 'demo', '--scope', 'project', '--yes'], location);
    expect(result.stdout).toMatchObject({
      schemaVersion: 1, command: 'plugin.install', data: {
        request: { scope: 'project', plugins: ['team/demo'] },
        changes: { requirements: 'changed' }, requirements: { roots: ['team/demo'] },
      },
    });
    expect((await observeIntent(location))).toMatchObject({ state: 'valid', value: {
      roots: [{ pluginId: 'team/demo' }],
    } });
  });

  it('keeps invalid scoped declarations distinct from an empty demand', async () => {
    const location = await fixture('invalid-intent');
    const intentPath = await resolveIntentPath(location);
    await fs.outputJson(intentPath, {
      schemaVersion: 2, kind: 'aw-plugin-intents', roots: [], dependencyScopeOverrides: [],
    });
    const legacy = await jsonCommand(['status', '--context', 'project'], location);
    expect(legacy).toMatchObject({ exit: 3, stdout: {
      command: 'plugin.status', status: 'blocked', data: { context: 'project',
        requirements: { state: 'unsupported-version' }, allSatisfied: null },
    } });
    await fs.writeFile(intentPath, '{bad');
    const invalid = await jsonCommand(['status', '--context', 'project'], location);
    expect(invalid).toMatchObject({ exit: 3, stdout: {
      command: 'plugin.status', status: 'blocked', data: { requirements: { state: 'invalid' }, allSatisfied: null },
    } });
  });

  it('shows declared roots without treating missing target preference as an empty declaration', async () => {
    const location = await fixture('no-targets');
    await writeIntent(location, { ...createEmptyIntent(),
      sources: { team: { logicalIdentity: 'logical-team' } }, roots: [{ pluginId: 'team/demo' }],
    });
    const status = await jsonCommand(['status', '--context', 'project'], location);
    expect(status).toMatchObject({ exit: 3, stdout: {
      schemaVersion: 1, command: 'plugin.status', status: 'blocked', data: { context: 'project',
        requirements: { state: 'valid' }, allSatisfied: false,
        inventory: [{ pluginId: 'team/demo' }],
        selection: { targets: [], targetOrigin: 'none' },
      },
    } });
    expect(status.stdout.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'targetsNotConfigured' }),
    ]));
  });

  it('requires qualified IDs for offline requirement removal in either scope', async () => {
    const location = await fixture('exact-ids');
    for (const scope of ['project', 'user']) {
      const result = await jsonCommand(['remove', 'demo', '--only', 'requirements', '--scope', scope], location);
      expect(result.exit).toBe(2);
      expect(result.stdout).toMatchObject({
        command: 'plugin.remove', status: 'failed', data: {},
        diagnostics: [{ code: 'invalidArguments' }],
      });
    }
    expect(await fs.pathExists(await resolveIntentPath(location))).toBe(false);
  });
});
