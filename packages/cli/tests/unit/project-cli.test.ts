import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/index.js';
import { observeProjectPreferences, writeProjectPreferences } from '../../src/project/project-preferences.js';
import { addProjectRoot, resolveProjectIntentPath } from '../../src/project/project-state.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import {
  createCatalogSnapshotFixture,
  createDependencyCatalogSnapshotFixture,
  git,
} from '../helpers/catalog-source-fixture.js';
import { createCapturedCliIo, createTtyRuntimeStreams } from '../helpers/cli-entry.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(name: string) {
  const cwd = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, name);
  await fs.ensureDir(cwd);
  await git(cwd, ['init', '--quiet']);
  return { cwd, env: getCurrentSourceTestIsolation().env };
}

async function activeCatalog(location: Awaited<ReturnType<typeof fixture>>, dependency = false) {
  const catalogRoot = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'project-cli-catalog');
  if (dependency) {
    await createDependencyCatalogSnapshotFixture(catalogRoot, [
      { name: 'leaf' }, { name: 'root', dependencies: ['leaf'] },
    ]);
  } else {
    await createCatalogSnapshotFixture(catalogRoot);
  }
  const current = await readCatalogSourcesConfigSnapshot(location.env);
  await replaceCatalogSourcesConfig({
    config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: catalogRoot }] },
    expectedDigest: current.digest, env: location.env,
  });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: location.env });
}

async function activePreApplyCatalog(location: Awaited<ReturnType<typeof fixture>>) {
  const catalogRoot = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'project-cli-pre-apply-catalog');
  const definition = [{
    name: 'demo',
    configureManifest: (manifest: { scripts?: { preApply?: { path: string } } }) => {
      manifest.scripts = { preApply: { path: './scripts/preApply.mjs' } };
    },
  }];
  await createDependencyCatalogSnapshotFixture(catalogRoot, definition);
  await fs.outputFile(path.join(catalogRoot, 'plugins', 'demo', 'scripts', 'preApply.mjs'), [
    'import { writeFile } from "node:fs/promises";',
    'await writeFile(`${process.env.AW_HOME}/project-cli-pre-apply-ran`, "yes");',
  ].join('\n'));
  await createDependencyCatalogSnapshotFixture(catalogRoot, definition);
  const current = await readCatalogSourcesConfigSnapshot(location.env);
  await replaceCatalogSourcesConfig({
    config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: catalogRoot }] },
    expectedDigest: current.digest, env: location.env,
  });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: location.env });
}

async function jsonCommand(args: string[], location: Awaited<ReturnType<typeof fixture>>) {
  const captured = createCapturedCliIo();
  const exit = await runCli([...args, '--json'], {
    ...location, interactive: false, io: captured.io,
  });
  return { exit, stdout: JSON.parse(captured.readStdout()) as Record<string, unknown>,
    stderr: captured.readStderr() };
}

describe('project CLI declaration and preference boundaries', () => {
  it('removes one exact root without reading the Catalog or deleting another root', async () => {
    const location = await fixture('project-cli-remove');
    await addProjectRoot(location, 'team/demo', 'logical-team');
    await addProjectRoot(location, 'team/other', 'logical-team');
    const output = await jsonCommand(['project', 'remove', 'team/demo'], location);
    expect(output.exit).toBe(0);
    expect(output.stdout).toMatchObject({
      schemaVersion: 1, kind: 'aw-project-recovery', command: 'project:remove',
      ok: true, declarationChanged: true, outputsMayHaveChanged: false,
      intent: { roots: ['team/other'] },
    });
    expect(output.stderr).toBe('');
    expect((await fs.readJson(resolveProjectIntentPath(location))).roots).toEqual([
      { pluginId: 'team/other' },
    ]);
  });

  it('resets both local Agent selection and dependency overrides', async () => {
    const location = await fixture('project-cli-targets');
    await writeProjectPreferences(location, {
      schemaVersion: 1, kind: 'aw-project-preferences', agents: [],
      dependencyScopeOverrides: [{ pluginId: 'team/dependency', platform: 'codex', scope: 'user' }],
    });
    const set = await jsonCommand(['project', 'targets', 'set', 'cursor', 'codex'], location);
    expect(set.exit).toBe(0);
    expect(set.stdout).toMatchObject({
      command: 'project:targets:set', preferencesChanged: true,
      selection: { agents: ['codex', 'cursor'] },
    });
    expect(await observeProjectPreferences(location)).toMatchObject({
      state: 'valid', value: { dependencyScopeOverrides: [{ pluginId: 'team/dependency' }] },
    });
    const reset = await jsonCommand(['project', 'targets', 'reset'], location);
    expect(reset.exit).toBe(0);
    expect(reset.stdout).toMatchObject({
      command: 'project:targets:reset', preferencesChanged: true,
      selection: { agents: [] },
    });
    expect(await observeProjectPreferences(location)).toMatchObject({
      state: 'valid', value: { agents: [], dependencyScopeOverrides: [] },
    });
  });

  it('adds a root only after verifying the local Active and keeps its binding', async () => {
    const location = await fixture('project-cli-add');
    await activeCatalog(location);
    const rejected = await jsonCommand(['project', 'add', 'team/demo', 'team/missing'], location);
    expect(rejected.exit).toBe(1);
    expect(rejected.stdout).toMatchObject({
      command: 'project:add', declarationChanged: false,
      blockers: [{ code: 'pluginUnavailable' }],
    });
    expect(await fs.pathExists(resolveProjectIntentPath(location))).toBe(false);
    const output = await jsonCommand(['project', 'add', 'team/demo'], location);
    expect(output.exit).toBe(0);
    expect(output.stdout).toMatchObject({
      command: 'project:add', declarationChanged: true,
      intent: { roots: ['team/demo'] },
    });
    expect((await fs.readJson(resolveProjectIntentPath(location))).sources.team.logicalIdentity)
      .toEqual(expect.any(String));
  });

  it('resolves a unique install short name to a qualified Project root', async () => {
    const location = await fixture('project-cli-install-short');
    await activeCatalog(location);
    const result = await jsonCommand(['install', 'demo', '-s', 'project', '-p', 'codex'], location);
    expect(result.stdout).toMatchObject({
      schemaVersion: 1, kind: 'aw-project-recovery', command: 'install',
      declarationChanged: true, intent: { roots: ['team/demo'] }, requestedRoots: ['team/demo'],
    });
    expect((await fs.readJson(resolveProjectIntentPath(location))).roots).toEqual([{ pluginId: 'team/demo' }]);
  });

  it('rejects an ambiguous install short name without writing a Project root', async () => {
    const location = await fixture('project-cli-install-ambiguous');
    const catalogBase = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'project-cli-ambiguous-catalogs');
    const teamRoot = path.join(catalogBase, 'team');
    const otherRoot = path.join(catalogBase, 'other');
    await Promise.all([createCatalogSnapshotFixture(teamRoot), createCatalogSnapshotFixture(otherRoot)]);
    const current = await readCatalogSourcesConfigSnapshot(location.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [
        { id: 'team', type: 'path', primary: true, path: teamRoot },
        { id: 'other', type: 'path', primary: false, path: otherRoot },
      ] },
      expectedDigest: current.digest, env: location.env,
    });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: location.env });
    await syncCatalogSourceGeneration({ sourceId: 'other', cliVersion: '1.0.0', env: location.env });
    const result = await jsonCommand(['install', 'demo', '-s', 'project', '-p', 'codex'], location);
    expect(result.exit).toBe(1);
    expect(result.stdout).toMatchObject({
      schemaVersion: 1, kind: 'aw-project-recovery', command: 'install', ok: false,
      declarationChanged: false, blockers: expect.arrayContaining([{ code: 'pluginSelectorAmbiguous', message: expect.any(String) }]),
    });
    expect(await fs.pathExists(resolveProjectIntentPath(location))).toBe(false);
  });

  it('does not guess a short name while a configured source has no verifiable Active', async () => {
    const location = await fixture('project-cli-install-source-unavailable');
    await activeCatalog(location);
    const otherRoot = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'project-cli-inactive-catalog');
    await createCatalogSnapshotFixture(otherRoot, 'other');
    const current = await readCatalogSourcesConfigSnapshot(location.env);
    await replaceCatalogSourcesConfig({
      config: { schemaVersion: 2, sources: [
        ...current.config.sources,
        { id: 'other', type: 'path', primary: false, path: otherRoot },
      ] },
      expectedDigest: current.digest, env: location.env,
    });
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: location.env });
    const result = await jsonCommand(['install', 'demo', '-s', 'project', '-p', 'codex'], location);
    expect(result.exit).toBe(1);
    expect(result.stdout).toMatchObject({
      kind: 'aw-project-recovery', command: 'install', ok: false, declarationChanged: false,
      blockers: expect.arrayContaining([{ code: 'sourceActiveUnavailable', message: expect.any(String) }]),
    });
    expect(await fs.pathExists(resolveProjectIntentPath(location))).toBe(false);
  });

  it('keeps project add and remove restricted to qualified IDs', async () => {
    const location = await fixture('project-cli-edit-short');
    await activeCatalog(location);
    for (const action of ['add', 'remove']) {
      const result = await jsonCommand(['project', action, 'demo'], location);
      expect(result.exit).toBe(1);
      expect(result.stdout).toMatchObject({
        schemaVersion: 1, kind: 'aw-project-recovery', command: `project:${action}`, ok: false,
        blockers: [{ code: 'invalidArguments' }], declarationChanged: false,
      });
    }
    expect(await fs.pathExists(resolveProjectIntentPath(location))).toBe(false);
  });

  it('uses one Project receipt for invalid inputs and does not accept broad targets in user mode', async () => {
    const location = await fixture('project-cli-arguments');
    const invalid = await jsonCommand(['project', 'remove', 'demo'], location);
    expect(invalid.exit).toBe(1);
    expect(invalid.stdout).toMatchObject({
      schemaVersion: 1, kind: 'aw-project-recovery', command: 'project:remove',
      ok: false, blockers: [{ code: 'invalidArguments' }],
    });
    const alias = await jsonCommand(['project', 'targets', 'set', 'claude'], location);
    expect(alias.exit).toBe(1);
    expect(alias.stdout).toMatchObject({
      command: 'project:targets:set', ok: false, preferencesChanged: false,
      blockers: [{ code: 'invalidArguments' }],
    });
    const user = await jsonCommand([
      'sync', 'team/demo', '-s', 'user', '-p', 'codex', '--target', 'cursor',
    ], location);
    expect(user.exit).toBe(1);
    expect(user.stdout).toMatchObject({
      command: 'sync', ok: false, errors: [{ code: 'invalidArguments' }],
    });
    expect(await fs.pathExists(resolveProjectIntentPath(location))).toBe(false);
  });

  it('rejects invalid Project install dependency scope before writing a declaration', async () => {
    const location = await fixture('project-cli-dependency-scope');
    const invalid = await jsonCommand([
      'install', 'team/demo', '-s', 'project', '-p', 'codex',
      '--dependency-scope', 'team/leaf#both=user',
    ], location);
    expect(invalid.exit).toBe(1);
    expect(invalid.stdout).toMatchObject({
      schemaVersion: 1, kind: 'aw-project-recovery', command: 'install', ok: false,
      blockers: [{ code: 'invalidArguments' }], declarationChanged: false,
    });
    expect(await fs.pathExists(resolveProjectIntentPath(location))).toBe(false);
  });

  it('saves a Native dependency scope locally while leaving Agent selection empty', async () => {
    const location = await fixture('project-cli-dependency-scope-valid');
    await activeCatalog(location, true);
    const captured = createCapturedCliIo();
    const exit = await runCli([
      'install', 'team/root', '-s', 'project', '-p', 'codex',
      '--dependency-scope', 'team/leaf#codex=user', '--json',
    ], {
      ...location, interactive: false, io: captured.io,
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    });
    const result = JSON.parse(captured.readStdout()) as Record<string, unknown>;
    expect(exit).toBe(result.ok ? 0 : 1);
    expect(result).toMatchObject({
      schemaVersion: 1, kind: 'aw-project-recovery', command: 'install',
      declarationChanged: true, preferencesChanged: true,
      selection: { agents: ['codex'], origin: 'argument' },
    });
    expect(await observeProjectPreferences(location)).toMatchObject({
      state: 'valid', value: {
        agents: [], dependencyScopeOverrides: [{ pluginId: 'team/leaf', platform: 'codex', scope: 'user' }],
      },
    });
  });

  it('requires explicit Project preApply authorization before running its script', async () => {
    const location = await fixture('project-cli-pre-apply');
    await activePreApplyCatalog(location);
    const outputPath = path.join(location.env.AW_HOME!, 'project-cli-pre-apply-ran');
    const invoke = async (yes: boolean) => {
      const captured = createCapturedCliIo();
      await runCli([
        'install', 'team/demo', '-s', 'project', '-p', 'codex',
        ...(yes ? ['--yes'] : []), '--json',
      ], {
        ...location, interactive: false, io: captured.io,
        nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
      });
      return JSON.parse(captured.readStdout()) as Record<string, unknown>;
    };
    const blocked = await invoke(false);
    expect(blocked).toMatchObject({
      kind: 'aw-project-recovery', ok: false, declarationChanged: true,
    });
    expect(await fs.pathExists(outputPath)).toBe(false);
    const authorized = await invoke(true);
    expect(authorized).toMatchObject({ kind: 'aw-project-recovery' });
    expect(await fs.readFile(outputPath, 'utf8')).toBe('yes');
  });

  it('keeps declaration and outputs absent when interactive Project Review is cancelled', async () => {
    const location = await fixture('project-cli-cancel-review');
    await activeCatalog(location);
    const captured = createCapturedCliIo();
    const confirm = vi.fn(async () => ({ cancelled: false, value: false }));
    const exit = await runCli(['install', 'team/demo', '-s', 'project', '-p', 'codex'], {
      ...location, ...createTtyRuntimeStreams(), interactive: true, io: captured.io,
      prompt: { confirm },
      nativeCliRunner: async () => ({ exitCode: 0, stdout: 'codex-cli 0.200.0', stderr: '' }),
    });
    expect(exit).toBe(1);
    expect(confirm).toHaveBeenCalledOnce();
    expect(captured.readStdout()).toContain('operationCancelled');
    expect(await fs.pathExists(resolveProjectIntentPath(location))).toBe(false);
    expect(await fs.pathExists(path.join(location.cwd, '.agents'))).toBe(false);
    expect(await fs.pathExists(path.join(location.cwd, '.claude'))).toBe(false);
  });

  it('keeps declared roots visible when no local targets are configured', async () => {
    const location = await fixture('project-cli-no-targets');
    const empty = await jsonCommand(['sync', '--all', '-s', 'project'], location);
    expect(empty.exit).toBe(0);
    expect(empty.stdout).toMatchObject({
      schemaVersion: 1, kind: 'aw-project-recovery', command: 'sync', ok: true,
      requestedRoots: [], targetResults: [],
    });
    const alias = await jsonCommand(['sync', '--all', '-s', 'project', '-p', 'both'], location);
    expect(alias.stdout).toMatchObject({
      selection: { agents: ['claude-code', 'codex'], origin: 'argument' },
    });

    await addProjectRoot(location, 'team/demo', 'logical-team');
    const blocked = await jsonCommand(['sync', '--all', '-s', 'project'], location);
    expect(blocked.exit).toBe(1);
    expect(blocked.stdout).toMatchObject({
      kind: 'aw-project-recovery', command: 'sync', ok: false,
      requestedRoots: ['team/demo'],
    });
    expect((blocked.stdout.blockers as Array<{ code: string }>).map((entry) => entry.code))
      .toContain('localTargetsRequired');
  });

  it('does not treat unsupported or invalid project declarations as empty demand', async () => {
    const location = await fixture('project-cli-invalid-state');
    const intentPath = resolveProjectIntentPath(location);
    await fs.outputJson(intentPath, {
      schemaVersion: 2, kind: 'aw-plugin-intents',
      roots: [{ pluginId: 'team/demo', platforms: ['codex'] }], dependencyScopeOverrides: [],
    });
    const legacy = await jsonCommand(['sync', '--all', '-s', 'project'], location);
    expect(legacy.exit).toBe(1);
    expect(legacy.stdout).toMatchObject({
      kind: 'aw-project-recovery', ok: false,
      intent: { state: 'unsupported-version', roots: null },
    });
    await fs.writeFile(intentPath, '{bad');
    const invalid = await jsonCommand(['sync', '--all', '-s', 'project'], location);
    expect(invalid.exit).toBe(1);
    expect(invalid.stdout).toMatchObject({
      kind: 'aw-project-recovery', ok: false,
      intent: { state: 'invalid', roots: null },
    });
  });

  it('lets status checking succeed separately from project satisfaction', async () => {
    const location = await fixture('project-cli-status');
    await addProjectRoot(location, 'team/demo', 'logical-team');
    const status = await jsonCommand(['project', 'status'], location);
    expect(status.exit).toBe(0);
    expect(status.stdout).toMatchObject({
      schemaVersion: 1, kind: 'aw-project-status', ok: true,
      intent: { state: 'valid' }, allSatisfied: null, errors: [],
      inventory: [{ pluginId: 'team/demo' }],
    });
    expect(status.stderr).toBe('');
  });
});
