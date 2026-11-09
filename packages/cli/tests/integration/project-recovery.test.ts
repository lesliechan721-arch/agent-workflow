import crypto from 'node:crypto';
import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import * as nativeStatus from '../../src/commands/status-v6.js';
import { prepareRecovery, executeRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { targetsSet, targetsChangeExclusion } from '../../src/commands/targets-command.js';
import { createEmptyPreferences, resolvePreferencesPath, setTargets, type AgentId } from '../../src/intent/deployment-preferences.js';
import { resolveIntentPath } from '../../src/intent/intent-store.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { checkRecovery, readRecoveryStatus } from '../../src/recovery/status.js';
import { readDemand } from '../../src/recovery/demand.js';
import { writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';

import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { createCodexNativeTestRuntime } from '../helpers/codex-native-fixture.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const PORTABLE_TARGETS = ['antigravity', 'cursor', 'generic', 'opencode', 'pi'] as const;
type Agent = AgentId;

async function fixture(plugins: Array<{
  name: string;
  dependencies?: string[];
  native?: boolean;
  portableSkill?: string;
  configurable?: boolean;
}>, scope: 'user' | 'project' = 'project') {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = path.join(isolation.layout.fixtureCwd, 'recovery-project');
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'recovery-source');
  await fs.ensureDir(cwd);
  await git(cwd, ['init', '--quiet']);
  for (const plugin of plugins) {
    const name = plugin.portableSkill ?? plugin.name;
    const pluginRoot = path.join(sourceRoot, 'plugins', plugin.name);
    const skill = path.join(pluginRoot, 'skills', name);
    await fs.outputFile(path.join(skill, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${name} fixture\n---\n${name}\n`);
    await fs.outputFile(path.join(skill, 'README.md'), `# ${plugin.name}\n`);
    for (const target of PORTABLE_TARGETS) {
      await fs.copy(path.join(pluginRoot, 'skills'), path.join(pluginRoot, target, 'skills'));
    }
  }
  await createDependencyCatalogSnapshotFixture(sourceRoot, plugins.map((plugin) => ({
    name: plugin.name,
    ...(plugin.dependencies ? { dependencies: plugin.dependencies } : {}),
    configureManifest: (manifest) => {
      manifest.platforms = [...PORTABLE_TARGETS, ...(plugin.native ? ['codex', 'claude'] as const : [])];
      manifest.skills = './skills';
      if (plugin.native) manifest.extensions = {
        instructions: [{ name: 'native', title: 'Native', content: 'Native.' }],
      };
      else delete manifest.extensions;
      if (plugin.configurable) manifest.config = { schemaVersion: 5, fields: { mode: { type: 'string' } }, platforms: {} };
    },
  })));
  await rebuildCatalogEntries(sourceRoot, plugins.map((plugin) => plugin.name));
  const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({
    config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: snapshot.digest, env: isolation.env,
  });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  const intentPath = await resolveIntentPath({ scope, cwd, env: isolation.env });
  await writeIntentFixture({ scope, cwd, env: isolation.env }, {
    roots: plugins.filter((plugin) => plugin.name !== 'shared').map((plugin) => ({ pluginId: `team/${plugin.name}` })),
    targets: ['cursor'],
  });
  return { cwd, sourceRoot, intentPath, env: isolation.env, scope,
    options: (targets?: Agent[]) => ({ scope, context: scope, cwd, env: isolation.env,
      cliVersion: '1.0.0', ...(targets ? { targets } : {}), all: true, yes: true }),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function rebuildCatalogEntries(sourceRoot: string, names: string[]): Promise<void> {
  const entries = [];
  for (const name of names) {
    const pluginRoot = path.join(sourceRoot, 'plugins', name);
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    const receipt = createAwPluginRequirementsReceipt({ name, version: '1.0.0' }, plugin.manifest.requires?.aw.capabilities ?? []);
    for (const target of PORTABLE_TARGETS) {
      const root = path.join(pluginRoot, target, 'skills');
      for (const skill of await fs.readdir(root)) await fs.outputJson(path.join(root, skill, 'aw-plugin-requirements.json'), receipt);
    }
    entries.push(await createCatalogManifestV7Entry(plugin, pluginRoot));
  }
  const catalogPath = path.join(sourceRoot, 'catalog-manifest.json');
  await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries });
}

function portableRoot(setup: Pick<Fixture, 'cwd' | 'env'>, target: typeof PORTABLE_TARGETS[number], scope: 'user' | 'project' = 'project'): string {
  const roots = scope === 'user' ? {
    antigravity: '.gemini/config/skills', cursor: '.cursor/skills', generic: '.agents/skills',
    opencode: '.config/opencode/skills', pi: '.pi/agent/skills',
  } : {
    antigravity: '.agents/skills', cursor: '.cursor/skills', generic: '.agents/skills',
    opencode: '.opencode/skills', pi: '.pi/skills',
  };
  return path.join(scope === 'user' ? setup.env.HOME! : setup.cwd, roots[target]);
}

// Compare discoverable output bytes, including the AW ownership marker, across recovery operations.
async function portableOutputSnapshot(setup: Pick<Fixture, 'cwd' | 'env'>): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    if (!await fs.pathExists(directory)) return;
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const location = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(location);
      else if (entry.isFile()) files.push(`${location}:${crypto.createHash('sha256').update(await fs.readFile(location)).digest('hex')}`);
    }
  };
  for (const scope of ['user', 'project'] as const) {
    for (const root of new Set(PORTABLE_TARGETS.map((target) => portableRoot(setup, target, scope)))) await visit(root);
  }
  return files.sort();
}

async function nativeRuntime(setup: Fixture) {
  const native = await createCodexNativeTestRuntime({ env: setup.env, layout: { fixtureCwd: setup.cwd } });
  return {
    nativeCliRunner: native.nativeCliRunner,
    codexManagerResolver: async () => ({
      kind: 'system' as const, version: '0.200.0', command: 'codex', argsPrefix: [] as string[],
    }),
  };
}

describe('scoped recovery integration', () => {
  // Test Value Gate: preparation must retain a useful failure stage and known errno without exposing arbitrary error data.
  it.each(['ENAMETOOLONG', 'private-config-value'])('reports safe Portable preparation diagnostics (%s)', async (code) => {
    const setup = await fixture([{ name: 'alpha' }]);
    const privateMessage = 'renderer-secret-value C:\\private\\sensitive-config.json';
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (String(source).includes('.aw-stage-')
        && String(target).startsWith(path.join(setup.cwd, '.agent-workflows', '.local', 'portable'))) {
        throw Object.assign(new Error(privateMessage, { cause: new Error('private-cause') }), {
          code, path: 'private-path', syscall: 'private-syscall', stack: 'private-stack',
        });
      }
      return rename(source, target);
    });
    try {
      const plan = await prepareRecovery('sync', [], setup.options());
      const blocker = plan.receipt.targetResults[0]?.blockers.find((entry) => entry.code === 'portablePreparationFailed');
      expect(blocker?.message).toContain('materialize');
      if (code === 'ENAMETOOLONG') expect(blocker?.message).toContain(code);
      const serialized = JSON.stringify(plan.receipt);
      for (const secret of [privateMessage, 'private-config-value', 'private-cause', 'private-path', 'private-syscall', 'private-stack']) {
        expect(serialized).not.toContain(secret);
      }
      expect(plan.receipt.targetResults[0]).toMatchObject({ execution: 'not-run', observation: 'unknown' });
      expect(await portableOutputSnapshot(setup)).toEqual([]);
    } finally {
      failure.mockRestore();
    }
    expect((await runRecovery('sync', [], setup.options())).ok).toBe(true);
  });

  // Test Value Gate: read-only status must preserve the same safe failure context and must not prepare or publish output.
  it('reports the Portable generation path failure in status', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const generationRoot = path.join(setup.cwd, '.agent-workflows', '.local', 'portable');
    await fs.ensureDir(generationRoot);
    const lstat = fs.lstat.bind(fs);
    const failure = vi.spyOn(fs, 'lstat').mockImplementation(async (candidate) => {
      if (String(candidate) === generationRoot) {
        throw Object.assign(new Error('private-config-value'), { code: 'EIO' });
      }
      return lstat(candidate);
    });
    try {
      const status = await readRecoveryStatus({ ...setup.options(), nativeObservations: [] });
      const blocker = status.inventory?.[0]?.targetResults[0]?.blockers
        .find((entry) => entry.code === 'portablePreparationFailed');
      expect(blocker, JSON.stringify(status)).toBeDefined();
      expect(blocker?.message).toContain('generation-path');
      expect(blocker?.message).toContain('EIO');
      expect(JSON.stringify(status)).not.toContain('private-config-value');
      expect(await portableOutputSnapshot(setup)).toEqual([]);
    } finally {
      failure.mockRestore();
    }
    expect(await fs.readdir(generationRoot)).toEqual([]);
  });

  it('reads complete Native inventory before filtering a User check and retains an unreadable inventory error', async () => {
    const setup = await fixture([{ name: 'alpha', native: true }, { name: 'beta', native: true }], 'user');
    await setTargets(setup.options(), ['claude']);
    const native = vi.spyOn(nativeStatus, 'statusCommandV8').mockImplementation(async (input) => ({
      payload: { schemaVersion: 8, catalog: { primarySourceId: 'team', configDigest: 'config',
        compositeDigest: 'catalog', sources: [] },
      filters: { plugins: input.plugins ?? [], platform: 'both', cwd: input.cwd }, targets: [],
      errors: [{ code: 'stateInventoryFailed', message: 'Native inventory unreadable' }] },
      nativeObservations: [{ pluginId: 'team/alpha', platform: 'claude', content: 'satisfied', blockers: [] }],
      nativeExtraObserved: [],
    }) as never);
    try {
      const checked = await checkRecovery(['team/alpha'], { ...setup.options(), all: false });
      expect(checked.ok).toBe(false);
      expect(checked.requestedRoots).toEqual(['team/alpha']);
      expect(checked.errors).toContainEqual(expect.objectContaining({ code: 'stateInventoryFailed' }));
      expect(native).toHaveBeenCalledWith(expect.objectContaining({ scope: 'user' }));
      expect(native.mock.calls.every(([input]) => input.plugins === undefined)).toBe(true);
      expect(await portableOutputSnapshot(setup)).toEqual([]);
    } finally { native.mockRestore(); }
  });

  // Test Value Gate: a selected root must include its dependencies without turning another root into its requirement.
  it.each([false, true])('checks only the selected root closure while retaining complete User inventory (dependency=%s)', async (dependsOnBeta) => {
    const setup = await fixture([{ name: 'alpha', ...(dependsOnBeta ? { dependencies: ['beta'] } : {}) },
      { name: 'beta' }], 'user');
    const options = { ...setup.options(), all: false, nativeObservations: [] };
    expect((await runRecovery('sync', ['team/alpha'], options)).ok).toBe(true);
    await fs.remove(path.join(portableRoot(setup, 'cursor', 'user'), 'beta'));
    const before = await portableOutputSnapshot(setup);
    const alpha = await checkRecovery(['team/alpha'], options);
    expect(alpha.requestedRoots).toEqual(['team/alpha']);
    expect(alpha.ok).toBe(!dependsOnBeta);
    expect(alpha.intent.roots).toEqual(['team/alpha', 'team/beta']);
    expect(alpha.coverage?.scopes).toEqual(['user']);
    expect((await checkRecovery(['team/beta'], options)).ok).toBe(false);
    expect((await checkRecovery([], { ...options, all: true })).ok).toBe(false);
    expect(await portableOutputSnapshot(setup)).toEqual(before);
  });

  // Test Value Gate: unreadable demand and a missing Agent selection must never appear as an empty success.
  it('keeps no-target, empty and invalid declarations distinct', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    await setTargets(setup.options(), []);
    const before = await fs.readFile(setup.intentPath);
    const missing = await runRecovery('sync', [], setup.options());
    expect(missing).toMatchObject({ kind: 'aw-recovery', scope: 'project', ok: false,
      intent: { roots: ['team/alpha'] }, requestedRoots: ['team/alpha'] });
    expect(missing.blockers.map((entry) => entry.code)).toContain('targetsNotConfigured');
    expect(await fs.readFile(setup.intentPath)).toEqual(before);

    await fs.writeJson(setup.intentPath, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    expect(await runRecovery('sync', [], setup.options())).toMatchObject({
      ok: true, requestedRoots: [], targetResults: [],
    });
    await fs.writeFile(setup.intentPath, '{broken');
    const invalid = await runRecovery('sync', [], setup.options());
    expect(invalid).toMatchObject({ ok: false, intent: { state: 'invalid' } });
    expect(invalid.blockers.map((entry) => entry.code)).toContain('pluginIntentStateInvalid');
    expect(await portableOutputSnapshot(setup)).toEqual([]);
  });

  // Test Value Gate: Native failure cannot silently install a Portable copy.
  it('retains Native delivery when the Native tool fails', async () => {
    const setup = await fixture([{ name: 'alpha', native: true }]);
    await setTargets(setup.options(), ['codex']);
    const nativeCliRunner = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'failed' }));
    const result = await runRecovery('sync', [], setup.options(), {
      nativeCliRunner, codexManagerResolver: async () => { throw new Error('native-fixture-failure'); },
    });
    expect(result.targetResults).toEqual([expect.objectContaining({
      pluginId: 'team/alpha', agent: 'codex', delivery: { kind: 'native', platform: 'codex' },
    })]);
    expect(result.ok).toBe(false);
    expect(await portableOutputSnapshot(setup)).toEqual([]);
  });

  // Test Value Gate: owned Portable cleanup must preserve foreign files and shared declaration bytes.
  it('cleans an owned Portable target without inventing a Native cleanup', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    expect((await runRecovery('sync', [], setup.options())).ok).toBe(true);
    const owned = path.join(portableRoot(setup, 'cursor'), 'alpha');
    const foreign = path.join(portableRoot(setup, 'cursor'), 'foreign', 'SKILL.md');
    await fs.outputFile(foreign, 'Foreign.\n');
    const before = await fs.readFile(setup.intentPath);
    const nativeCliRunner = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'must not run' }));
    const result = await runRecovery('cleanup', ['team/alpha'], { ...setup.options(), all: false }, { nativeCliRunner });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.targetResults).toEqual([expect.objectContaining({
      pluginId: 'team/alpha', agent: 'cursor', delivery: expect.objectContaining({ kind: 'agent-skills', provider: 'aw' }),
      execution: 'applied', blockers: [],
    })]);
    expect(nativeCliRunner).not.toHaveBeenCalled();
    expect(await fs.pathExists(owned)).toBe(false);
    expect(await fs.readFile(foreign, 'utf8')).toBe('Foreign.\n');
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
  });

  // Test Value Gate: bounded ownership must permit offline cleanup even when strong configuration is damaged.
  it('cleans owned Portable output offline with damaged local state and preserves its bytes', async () => {
    const setup = await fixture([{ name: 'alpha', configurable: true }]);
    const plugin = (await readDemand(setup.options())).roots![0]!.plugin!;
    await writePluginConfigStore({ sourceId: 'team', sourceIdentity: plugin.sourceIdentity,
      pluginName: 'alpha', scope: 'user', cwd: setup.cwd, env: setup.env, values: { mode: 'saved' } });
    expect((await runRecovery('sync', [], setup.options())).ok).toBe(true);
    const preferencesPath = await resolvePreferencesPath(setup.options());
    const configPath = path.join(setup.env.AW_HOME!, 'plugin-config', 'team', 'alpha', 'config.json');
    const files = [setup.intentPath, preferencesPath, configPath];
    await Promise.all(files.map((file) => fs.writeFile(file, '{broken')));
    const before = await Promise.all(files.map((file) => fs.readFile(file)));
    await fs.remove(setup.sourceRoot);
    await fs.remove(path.join(setup.env.AW_HOME!, 'catalog-store'));
    const result = await runRecovery('cleanup', ['team/alpha'], { ...setup.options(['cursor']), all: false });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await fs.pathExists(path.join(portableRoot(setup, 'cursor'), 'alpha'))).toBe(false);
    expect(await Promise.all(files.map((file) => fs.readFile(file)))).toEqual(before);
  });

  // Test Value Gate: narrowing a sync cannot remove a dependency still contributed by an unselected root and target.
  it('protects shared Portable dependencies outside the selected root and target', async (test) => {
    const timing = createCommandTestTiming(test);
    const setup = await timing.measure('fixture', 'shared Portable dependencies', () =>
      fixture([{ name: 'alpha' }, { name: 'beta', dependencies: ['alpha'], configurable: true }]));
    await setTargets(setup.options(), ['cursor', 'pi']);
    const options = { ...setup.options(), all: false };
    expect((await timing.measure('command', 'sync Cursor consumer', () =>
      runRecovery('sync', ['team/beta'], { ...options, targets: ['cursor'] }))).ok).toBe(true);
    const shared = path.join(portableRoot(setup, 'cursor'), 'alpha', 'SKILL.md');
    const consumer = path.join(portableRoot(setup, 'cursor'), 'beta', 'SKILL.md');
    const before = await Promise.all([fs.readFile(shared), fs.readFile(consumer)]);
    const independent = await timing.measure('command', 'sync Pi provider', () =>
      runRecovery('sync', ['team/alpha'], { ...options, targets: ['pi'] }));
    expect(independent.ok, JSON.stringify(independent)).toBe(true);
    expect(independent.targetResults.map((target) => target.agent)).toEqual(['pi']);
    expect(await Promise.all([fs.readFile(shared), fs.readFile(consumer)])).toEqual(before);
    expect(await fs.pathExists(path.join(portableRoot(setup, 'pi'), 'beta'))).toBe(false);

    const reviewed = await timing.measure('review', 'prepare Pi provider', () =>
      prepareRecovery('sync', ['team/alpha'], { ...options, targets: ['pi'] }));
    await setTargets(setup.options(), ['cursor']);
    const stale = await timing.measure('review', 'reject changed targets', () => executeRecovery(reviewed));
    expect(stale.blockers.map((entry) => entry.code)).toContain('operationReviewStale');
    expect(stale.outputsMayHaveChanged).toBe(false);
    expect(await Promise.all([fs.readFile(shared), fs.readFile(consumer)])).toEqual(before);
    expect(await fs.pathExists(path.join(portableRoot(setup, 'pi'), 'alpha', 'SKILL.md'))).toBe(true);
  }, 30_000);

  // Test Value Gate: Native refresh and Portable cleanup must preserve each other's valid output.
  it.for(['project', 'user'] as const)(
    'keeps mixed Native and Portable delivery idempotent in separate owned directories (%s)', async (scope, test) => {
      const timing = createCommandTestTiming(test);
      const setup = await timing.measure('fixture', 'mixed Native and Portable', () =>
        fixture([{ name: 'dual', native: true }], scope));
      const runtime = await nativeRuntime(setup);
      await fs.remove(setup.intentPath);
      await setTargets(setup.options(), ['codex', 'cursor']);
      const options = { ...setup.options(), all: false };
      const installed = await timing.measure('command', 'install mixed output', () =>
        runRecovery('install', ['team/dual'], options, runtime));
      expect(installed.ok, JSON.stringify(installed)).toBe(true);
      expect(installed.targetResults.map(({ agent, delivery }) => [agent, delivery?.kind]))
        .toEqual([['codex', 'native'], ['cursor', 'agent-skills']]);
      const portablePath = path.join(portableRoot(setup, 'cursor', scope), 'dual', 'SKILL.md');
      const portableBytes = await fs.readFile(portablePath);
      const writes = await portableOutputSnapshot(setup);
      const owner = await fs.readJson(path.join(path.dirname(portablePath), SKILL_OWNER_MARKER));
      expect(owner).toMatchObject({ owner: 'agent-workflows', kind: 'portable-skill', platform: 'cursor', scope });
      const repeated = await timing.measure('command', 'sync mixed output', () =>
        runRecovery('sync', ['team/dual'], options, runtime));
      expect(repeated.ok, JSON.stringify(repeated)).toBe(true);
      expect(repeated.remainingTargets).toEqual([]);
      expect(repeated.targetResults.find((target) => target.agent === 'cursor')?.execution).toBe('no-op');
      expect(await portableOutputSnapshot(setup)).toEqual(writes);

      for (const narrowed of [
        { targets: ['codex'] },
        { exactTargets: [{ pluginId: 'team/dual', agent: 'codex' as const }] },
      ]) {
        const nativeOnly = await timing.measure('command', 'sync selected Native output', () =>
          runRecovery('sync', ['team/dual'], { ...options, ...narrowed }, runtime));
        expect(nativeOnly.ok, JSON.stringify(nativeOnly)).toBe(true);
        expect(nativeOnly.targetResults.map((target) => target.agent)).toEqual(['codex']);
        expect(await fs.readFile(portablePath)).toEqual(portableBytes);
        expect(await portableOutputSnapshot(setup)).toEqual(writes);
      }
      await fs.appendFile(portablePath, 'External edit.\n');
      const changedBytes = await fs.readFile(portablePath);
      const nativeOnly = await timing.measure('command', 'sync Native with edited Portable output', () =>
        runRecovery('sync', ['team/dual'], { ...options, targets: ['codex'] }, runtime));
      expect(nativeOnly.ok, JSON.stringify(nativeOnly)).toBe(true);
      expect(await fs.readFile(portablePath)).toEqual(changedBytes);
      expect((await timing.measure('command', 'check edited Portable output', () =>
        checkRecovery(['team/dual'], { ...options, targets: ['cursor'], nativeObservations: [] }))).ok).toBe(false);
      const nativeConfig = scope === 'user'
        ? path.join(setup.env.AW_CODEX_HOME!, 'config.toml')
        : path.join(setup.cwd, '.codex', 'config.toml');
      const nativeConfigBytes = await fs.readFile(nativeConfig);
      const cleaned = await timing.measure('command', 'cleanup Portable output', () =>
        runRecovery('cleanup', ['team/dual'], { ...options, targets: ['cursor'], force: true }, runtime));
      expect(cleaned.ok, JSON.stringify(cleaned)).toBe(true);
      expect(await fs.pathExists(portablePath)).toBe(false);
      expect(await fs.readFile(nativeConfig)).toEqual(nativeConfigBytes);
      expect((await timing.measure('command', 'sync Native after Portable cleanup', () =>
        runRecovery('sync', ['team/dual'], { ...options, targets: ['codex'] }, runtime))).ok).toBe(true);
  }, 30_000);

  // Test Value Gate: changing selected targets must preserve prior output while the replacement conflicts.
  it.each([false, true])('preserves a prior target while foreign output blocks its replacement (renamed Skill=%s)', async (renamedSkill) => {
    const setup = await fixture([{ name: 'alpha' }]);
    await setTargets(setup.options(), ['pi']);
    expect((await runRecovery('sync', [], setup.options())).ok).toBe(true);
    const prior = path.join(portableRoot(setup, 'pi'), 'alpha', 'SKILL.md');
    const priorBytes = await fs.readFile(prior);
    const skillName = renamedSkill ? 'current' : 'alpha';
    if (renamedSkill) {
      const pluginRoot = path.join(setup.sourceRoot, 'plugins', 'alpha');
      for (const root of ['skills', ...PORTABLE_TARGETS.map((target) => `${target}/skills`)]) {
        await fs.move(path.join(pluginRoot, root, 'alpha'), path.join(pluginRoot, root, skillName));
        await fs.writeFile(path.join(pluginRoot, root, skillName, 'SKILL.md'),
          `---\nname: ${skillName}\ndescription: Current fixture\n---\nCurrent.\n`);
      }
      await rebuildCatalogEntries(setup.sourceRoot, ['alpha']);
      await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: setup.env, impactConfirmed: true });
    }
    await setTargets(setup.options(), ['cursor']);
    const replacement = path.join(portableRoot(setup, 'cursor'), skillName);
    const foreign = path.join(replacement, 'SKILL.md');
    await fs.outputFile(foreign, 'Foreign replacement.\n');
    const before = await portableOutputSnapshot(setup);
    const blocked = await runRecovery('sync', [], setup.options());
    expect(blocked).toMatchObject({ ok: false, outputsMayHaveChanged: false });
    expect(blocked.targetResults[0]?.blockers.map((entry) => entry.code)).toContain('portableOutputConflict');
    expect(await portableOutputSnapshot(setup)).toEqual(before);
    expect(await fs.readFile(prior)).toEqual(priorBytes);

    const saved = path.join(setup.cwd, 'saved-foreign');
    await fs.move(replacement, saved);
    const reviewed = await prepareRecovery('sync', [], setup.options());
    expect(reviewed.receipt.targetResults[0]?.blockers).toEqual([]);
    await fs.move(saved, replacement);
    const stale = await executeRecovery(reviewed);
    expect(stale.blockers.map((entry) => entry.code)).toContain('operationReviewStale');
    expect(stale.outputsMayHaveChanged).toBe(false);
    expect(await fs.readFile(foreign, 'utf8')).toBe('Foreign replacement.\n');
    await fs.move(replacement, saved);
    const recovered = await runRecovery('sync', [], setup.options());
    expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
    expect(await fs.readJson(path.join(replacement, SKILL_OWNER_MARKER)))
      .toMatchObject({ pluginId: 'team/alpha', platform: 'cursor', skill: skillName });
    expect(await fs.readFile(prior)).toEqual(priorBytes);
    expect(await fs.readFile(path.join(saved, 'SKILL.md'), 'utf8')).toBe('Foreign replacement.\n');
  });

  // Test Value Gate: changed Review evidence prevents all backend writes.
  it.each(['intent', 'preferences', 'footprint'])('rejects changed %s after Review', async (change) => {
    const setup = await fixture([{ name: 'alpha' }]);
    const plan = await prepareRecovery('sync', [], setup.options());
    expect(plan.receipt.targetResults[0]?.blockers).toEqual([]);
    if (change === 'intent') await fs.appendFile(setup.intentPath, '\n');
    else if (change === 'preferences') {
      const filePath = await resolvePreferencesPath(setup.options());
      await fs.outputFile(filePath, JSON.stringify(createEmptyPreferences()));
    } else await fs.outputFile(path.join(portableRoot(setup, 'cursor'), 'alpha', 'SKILL.md'), 'Foreign.\n');
    const before = await portableOutputSnapshot(setup);
    const result = await executeRecovery(plan);
    expect(result.blockers.map((entry) => entry.code)).toContain('operationReviewStale');
    expect(result.outputsMayHaveChanged).toBe(false);
    expect(await portableOutputSnapshot(setup)).toEqual(before);
  });

  it.each(['source-config', 'active', 'plugin-config'])(
    'rejects changed %s before the first backend write', async (change) => {
      const setup = await fixture([{ name: 'alpha', configurable: true }]);
      const plan = await prepareRecovery('sync', [], setup.options());
      expect(plan.receipt.targetResults[0]?.blockers).toEqual([]);
      if (change === 'source-config') {
        const snapshot = await readCatalogSourcesConfigSnapshot(setup.env);
        await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
          { id: 'team', type: 'path', primary: true, path: setup.sourceRoot, autoCheck: false },
        ] }, expectedDigest: snapshot.digest, env: setup.env });
      } else if (change === 'active') {
        await fs.writeFile(path.join(setup.sourceRoot, 'plugins', 'alpha', 'README.md'), 'Changed bundle.\n');
        await rebuildCatalogEntries(setup.sourceRoot, ['alpha']);
        await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: setup.env, impactConfirmed: true });
      } else {
        const plugin = (await readDemand(setup.options())).roots![0]!.plugin!;
        await writePluginConfigStore({ sourceId: 'team', sourceIdentity: plugin.sourceIdentity,
          pluginName: 'alpha', scope: 'user', cwd: setup.cwd, env: setup.env, values: { mode: 'second' } });
      }
      const result = await executeRecovery(plan);
      expect(result.blockers.map((entry) => entry.code)).toContain('operationReviewStale');
      expect(result.outputsMayHaveChanged).toBe(false);
      expect(await portableOutputSnapshot(setup)).toEqual([]);
    });

  // Test Value Gate: an unavailable source must not stop an independent source from recovering.
  it('keeps an independent success when refresh of another source fails', async () => {
    const setup = await fixture([{ name: 'alpha' }, { name: 'beta' }]);
    const offlineRoot = path.join(getCurrentSourceTestIsolation().layout.fixtureCwd, 'offline-source');
    await fs.copy(setup.sourceRoot, offlineRoot);
    const markerPath = path.join(offlineRoot, '.aw-generated.json');
    const marker = await fs.readJson(markerPath) as { workspaceIdentity: string };
    await fs.writeJson(markerPath, { ...marker, workspaceIdentity: 'fixture:offline-refresh' });
    const sourceConfig = await readCatalogSourcesConfigSnapshot(setup.env);
    await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
      { id: 'team', type: 'path', primary: true, path: setup.sourceRoot },
      { id: 'offline', type: 'path', primary: false, path: offlineRoot },
    ] }, expectedDigest: sourceConfig.digest, env: setup.env });
    await syncCatalogSourceGeneration({ sourceId: 'offline', cliVersion: '1.0.0', env: setup.env });
    const intent = await fs.readJson(setup.intentPath) as {
      sources: Record<string, { logicalIdentity: string }>; roots: Array<{ pluginId: string }>;
    };
    intent.sources.offline = { logicalIdentity: 'fixture:offline-refresh' };
    intent.roots = [{ pluginId: 'team/alpha' }, { pluginId: 'offline/beta' }];
    await fs.writeJson(setup.intentPath, intent);
    const before = await fs.readFile(setup.intentPath);
    await fs.remove(offlineRoot);
    const result = await runRecovery('sync', [], { ...setup.options(), refresh: true });
    expect(result.ok).toBe(false);
    expect(result.targetResults.find((target) => target.pluginId === 'offline/beta')?.blockers.length).toBeGreaterThan(0);
    expect(result.targetResults.find((target) => target.pluginId === 'team/alpha')?.execution).toBe('applied');
    expect(result.remainingTargets.map((target) => target.pluginId)).toContain('offline/beta');
    expect(await fs.pathExists(path.join(portableRoot(setup, 'cursor'), 'alpha', 'SKILL.md'))).toBe(true);
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
  });

  // Test Value Gate: exact retry pairs cannot turn into a Cartesian product of roots and Agents.
  it('runs only exact non-rectangular retry pairs and preserves declaration bytes', async () => {
    const setup = await fixture([{ name: 'alpha' }, { name: 'beta' }]);
    await setTargets(setup.options(), ['cursor', 'pi']);
    const before = await fs.readFile(setup.intentPath);
    const result = await runRecovery('sync', [], {
      ...setup.options(), exactTargets: [
        { pluginId: 'team/alpha', agent: 'cursor' }, { pluginId: 'team/beta', agent: 'pi' },
      ],
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.targetResults.map(({ pluginId, agent }) => [pluginId, agent])).toEqual([
      ['team/alpha', 'cursor'], ['team/beta', 'pi'],
    ]);
    expect(await fs.pathExists(path.join(portableRoot(setup, 'cursor'), 'alpha', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(portableRoot(setup, 'pi'), 'beta', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(portableRoot(setup, 'cursor'), 'beta'))).toBe(false);
    expect(await fs.pathExists(path.join(portableRoot(setup, 'pi'), 'alpha'))).toBe(false);
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
  });

  it('rejects an exact retry pair outside the selected roots before output writes', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const before = await fs.readFile(setup.intentPath);
    const result = await runRecovery('sync', [], {
      ...setup.options(), exactTargets: [{ pluginId: 'team/misspelled', agent: 'cursor' }],
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toContain('invalidExactTargets');
    expect(result.outputsMayHaveChanged).toBe(false);
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
    expect(await portableOutputSnapshot(setup)).toEqual([]);
  });

  // Test Value Gate: machine Agent policy cannot rewrite shared Intent or silently delete another target's output.
  it('keeps shared bytes and prior output when local Agent selection changes', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const before = await fs.readFile(setup.intentPath);
    expect((await targetsSet({ cwd: setup.cwd, env: setup.env, targets: ['cursor'] })).ok).toBe(true);
    expect((await runRecovery('sync', [], setup.options())).ok).toBe(true);
    const cursorSkill = path.join(portableRoot(setup, 'cursor'), 'alpha', 'SKILL.md');
    const cursorBytes = await fs.readFile(cursorSkill);
    expect((await targetsSet({ cwd: setup.cwd, env: setup.env, targets: ['pi'] })).ok).toBe(true);
    const second = await runRecovery('sync', [], setup.options());
    expect(second.selection.agents).toEqual(['pi']);
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(await fs.pathExists(path.join(portableRoot(setup, 'pi'), 'alpha', 'SKILL.md'))).toBe(true);
    expect(await fs.readFile(cursorSkill)).toEqual(cursorBytes);
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
  });

  // Test Value Gate: CLI policy apply must obtain deletion authorization before any preference or output write.
  it.each(['set', 'exclude'] as const)('does not save a candidate policy for CLI %s --apply without confirmation', async (action) => {
    const setup = await fixture([{ name: 'alpha' }]);
    expect((await runRecovery('sync', [], setup.options())).ok).toBe(true);
    const preferencesPath = await resolvePreferencesPath(setup.options());
    const before = await fs.readFile(preferencesPath);
    const outputs = await portableOutputSnapshot(setup);
    const options = { cwd: setup.cwd, env: setup.env, context: setup.scope,
      cliVersion: '1.0.0', apply: true, runtime: { directCli: true } };
    const result = action === 'set'
      ? await targetsSet({ ...options, targets: ['pi'] })
      : await targetsChangeExclusion({ ...options, selector: 'team/alpha', target: 'cursor', excluded: true });
    expect(result.ok).toBe(false);
    expect(result.preferencesChanged).toBe(false);
    expect(result.outputsMayHaveChanged).toBe(false);
    expect(result.confirmation).toMatchObject({ required: true, provided: false,
      effects: expect.arrayContaining([expect.objectContaining({ code: 'removeOwnedOutput' })]) });
    expect(result.blockers.map((entry) => entry.code)).toContain('confirmationRequired');
    expect(await fs.readFile(preferencesPath)).toEqual(before);
    expect(await portableOutputSnapshot(setup)).toEqual(outputs);
  });

  it('saves an authorized CLI candidate policy and applies its new target', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    expect((await runRecovery('sync', [], setup.options())).ok).toBe(true);
    const intentBefore = await fs.readFile(setup.intentPath);
    const result = await targetsSet({ cwd: setup.cwd, env: setup.env, context: setup.scope,
      cliVersion: '1.0.0', apply: true, yes: true, targets: ['pi'], runtime: { directCli: true } });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.preferencesChanged).toBe(true);
    expect(result.policy?.targets).toEqual(['pi']);
    expect(await fs.pathExists(path.join(portableRoot(setup, 'pi'), 'alpha', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(portableRoot(setup, 'cursor'), 'alpha'))).toBe(false);
    expect(await fs.readFile(setup.intentPath)).toEqual(intentBefore);
  });

  it('rejects a CLI candidate policy when preferences change after preparation', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    expect((await runRecovery('sync', [], setup.options())).ok).toBe(true);
    const outputs = await portableOutputSnapshot(setup);
    let changed = false;
    const result = await targetsSet({ cwd: setup.cwd, env: setup.env, context: setup.scope,
      cliVersion: '1.0.0', apply: true, yes: true, targets: ['pi'], runtime: { directCli: true,
        debugLogger: { log: async (event) => {
          if (!changed && event.type === 'performance:stage' && event.data?.name === 'recovery.plan'
            && event.data.phase === 'success') {
            changed = true;
            await setTargets(setup.options(), ['opencode']);
          }
        } },
      } });
    expect(changed).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.preferencesChanged).toBe(false);
    expect(result.blockers.map((entry) => entry.code)).toContain('operationReviewStale');
    expect((await fs.readJson(await resolvePreferencesPath(setup.options()))).targets).toEqual(['opencode']);
    expect(await portableOutputSnapshot(setup)).toEqual(outputs);
    expect(await fs.pathExists(path.join(portableRoot(setup, 'pi'), 'alpha'))).toBe(false);
  });

  // Test Value Gate: missing machine targets reject install before declaration; a later output failure retains its verified root.
  it('rejects install before declaration without targets and retains a verified root after an output conflict', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const installOptions = { ...setup.options(), all: false };
    await fs.remove(setup.intentPath);
    const planned = await prepareRecovery('install', ['team/alpha'], installOptions);
    expect(planned.plannedImpact).toMatchObject({ declaration: true });
    expect(await fs.pathExists(setup.intentPath)).toBe(false);
    expect(await portableOutputSnapshot(setup)).toEqual([]);
    await planned.context.dispose();
    await setTargets(setup.options(), []);
    const noTarget = await runRecovery('install', ['team/alpha'], installOptions);
    expect(noTarget.blockers.map((entry) => entry.code)).toContain('targetsNotConfigured');
    expect(noTarget.declarationChanged).toBe(false);
    expect(await fs.pathExists(setup.intentPath)).toBe(false);
    expect(await portableOutputSnapshot(setup)).toEqual([]);
    await setTargets(setup.options(), ['cursor']);
    const foreign = path.join(portableRoot(setup, 'cursor'), 'alpha', 'SKILL.md');
    await fs.outputFile(foreign, 'Foreign.\n');
    const failed = await runRecovery('install', ['team/alpha'], installOptions);
    expect(failed.ok).toBe(false);
    expect(failed.declarationChanged).toBe(true);
    expect((await fs.readJson(setup.intentPath)).roots).toEqual([{ pluginId: 'team/alpha' }]);
    expect(await fs.readFile(foreign, 'utf8')).toBe('Foreign.\n');
  });

  // Test Value Gate: an unreadable owner must remain unknown; retained identity permits bounded damaged-output cleanup.
  it('distinguishes missing output from unreadable ownership and permits bounded damaged-owner cleanup', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    const options = { ...setup.options(), nativeObservations: [] };
    const missing = await readRecoveryStatus(options);
    expect(missing.inventory?.[0]?.targetResults[0]).toMatchObject({ content: 'absent', observation: 'missing' });
    expect((await runRecovery('sync', [], setup.options())).ok).toBe(true);
    const owned = path.join(portableRoot(setup, 'cursor'), 'alpha');
    const ownerPath = path.join(owned, SKILL_OWNER_MARKER);
    const owner = await fs.readJson(ownerPath);
    const before = await fs.readFile(setup.intentPath);
    await fs.writeFile(ownerPath, '{broken');
    const unknown = await readRecoveryStatus(options);
    expect(unknown.inventory?.[0]?.targetResults[0]).toMatchObject({ observation: 'unknown', content: 'unknown' });
    expect(unknown.inventory?.[0]?.targetResults[0]?.blockers.map((entry) => entry.code)).toContain('portableOwnerInvalid');
    const unsafe = await runRecovery('cleanup', ['team/alpha'], { ...setup.options(), all: false, force: true });
    expect(unsafe.ok).toBe(false);
    expect(await fs.pathExists(owned)).toBe(true);
    await fs.writeJson(ownerPath, { ...owner, filesDigest: 'damaged' });
    const foreign = path.join(portableRoot(setup, 'cursor'), 'foreign', 'SKILL.md');
    await fs.outputFile(foreign, 'Foreign.\n');
    const cleaned = await runRecovery('cleanup', ['team/alpha'], { ...setup.options(), all: false, force: true });
    expect(cleaned.ok, JSON.stringify(cleaned)).toBe(true);
    expect(await fs.pathExists(owned)).toBe(false);
    expect(await fs.readFile(foreign, 'utf8')).toBe('Foreign.\n');
    expect(await fs.readFile(setup.intentPath)).toEqual(before);
  });

  // Test Value Gate: equivalent paths to one repository must show the same status without modifying outputs or declarations.
  it('observes one satisfied target from root, subdirectory and alias', async () => {
    const setup = await fixture([{ name: 'alpha' }]);
    expect((await runRecovery('sync', [], setup.options())).ok).toBe(true);
    const subdirectory = path.join(setup.cwd, 'src');
    const alias = path.join(path.dirname(setup.cwd), 'recovery-project-alias');
    await fs.ensureDir(subdirectory);
    await fs.symlink(setup.cwd, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const intentBytes = await fs.readFile(setup.intentPath);
    const writes = await portableOutputSnapshot(setup);
    const statuses = [];
    for (const cwd of [setup.cwd, subdirectory, alias]) statuses.push(await readRecoveryStatus({
      cwd, env: setup.env, cliVersion: '1.0.0', nativeObservations: [],
    }));
    for (const status of statuses) expect(status).toMatchObject({
      schemaVersion: 1, kind: 'aw-recovery-status', scope: 'project', ok: true,
      allSatisfied: true, errors: [], inventory: [{ pluginId: 'team/alpha', targetResults: [{
        agent: 'cursor', content: 'satisfied', observation: 'verified', blockers: [],
      }] }],
    });
    expect(statuses[1]).toEqual(statuses[0]);
    expect(statuses[2]).toEqual(statuses[0]);
    expect(await portableOutputSnapshot(setup)).toEqual(writes);
    expect(await fs.readFile(setup.intentPath)).toEqual(intentBytes);
  });
});
