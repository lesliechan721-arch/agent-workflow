import path from 'node:path';
import fs from 'fs-extra';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDependencyCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { getNativeTestLayout, installNativeTestQualification } from '../helpers/native-execution-fixture.js';
import { createCommandTestTiming } from '../helpers/command-timing.js';
import type { RebuildCommandRuntime } from '../../src/commands/rebuild-command.js';
import { runPublicLifecycle } from '../../src/commands/public-lifecycle.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveActiveCatalogGeneration } from '../../src/utils/catalog-generation-resolver.js';
import { resolveCatalogGenerationStatePath } from '../../src/utils/catalog-generation-state.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import { writeIntent, observeIntent, resolveIntentPath } from '../../src/intent/intent-store.js';
import type { RecoveryReceipt } from '../../src/recovery/receipt.js';
import { resolvePreferencesPath, setTargets } from '../../src/intent/deployment-preferences.js';
import { prepareRecovery, executeRecovery, runRecovery } from '../../src/recovery/coordinator.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { readRecoveryStatus } from '../../src/recovery/status.js';
import { SKILL_OWNER_MARKER } from '../../src/utils/ownership.js';
import { snapshotRegularTree } from '../helpers/write-command-fixture.js';

async function fixture(collide = false, platforms: Array<'generic' | 'opencode' | 'cursor'> = ['generic'], switchHook = false, graph: Record<string, string[]> = { a: ['d'], b: ['d'], d: [] }) {
  const names = Object.keys(graph).sort();
  const skill = (name: string) => collide && name === 'b' ? 'a' : name;
  const isolation = getCurrentSourceTestIsolation();
  const cwd = path.join(isolation.layout.fixtureCwd, 'joint-project');
  const source = path.join(isolation.layout.fixtureCwd, 'joint-source');
  const hookTrace = path.join(cwd, 'hook-trace.jsonl');
  const hookFailure = path.join(cwd, 'fail-user-generic');
  await fs.ensureDir(cwd); await git(cwd, ['init', '--quiet']);
  for (const name of names) await fs.outputFile(path.join(source, 'plugins', name, 'skills', skill(name), 'SKILL.md'),
    `---\nname: ${skill(name)}\ndescription: Test ${name}\n---\nUse ${name}.\n`);
  for (const name of names) await fs.outputFile(path.join(source, 'plugins', name, 'skills', skill(name), 'README.md'), `Use ${name}.\n`);
  for (const name of names) for (const platform of platforms) await fs.copy(path.join(source, 'plugins', name, 'skills'), path.join(source, 'plugins', name, platform, 'skills'));
  if (switchHook) for (const name of names) await fs.outputFile(path.join(source, 'plugins', name, 'pre-apply.mjs'), [
    "import fs from 'node:fs'; const c = JSON.parse(fs.readFileSync(0, 'utf8'));",
    `fs.appendFileSync(${JSON.stringify(hookTrace)}, JSON.stringify({ plugin: c.plugin.name, platform: c.target.platform, scope: c.target.scope }) + '\\n');`,
    `if (fs.existsSync(${JSON.stringify(hookFailure)}) && c.plugin.name === 'd' && c.target.platform === 'generic' && c.target.scope === 'user') process.exit(23);`,
  ].join('\n'));
  await createDependencyCatalogSnapshotFixture(source, names.map((name) => ({ name,
    ...(graph[name]!.length ? { dependencies: graph[name] } : {}), configureManifest: (manifest) => {
      manifest.platforms = platforms; manifest.skills = './skills'; delete manifest.extensions;
      if (switchHook) manifest.scripts = { preApply: { path: './pre-apply.mjs' } };
    } })));
  const entries = [];
  for (const name of names) {
    const root = path.join(source, 'plugins', name);
    const plugin = await readPluginManifest(root, { mode: 'bundle' });
    const receipt = createAwPluginRequirementsReceipt({ name, version: '1.0.0' }, plugin.manifest.requires?.aw.capabilities ?? []);
    for (const platform of platforms) await fs.outputJson(path.join(root, platform, 'skills', skill(name), 'aw-plugin-requirements.json'), receipt);
    entries.push(await createCatalogManifestV7Entry(plugin, root));
  }
  const catalogPath = path.join(source, 'catalog-manifest.json');
  await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries });
  const config = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2,
    sources: [{ id: 'team', type: 'path', primary: true, path: source }] }, expectedDigest: config.digest, env: isolation.env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  const generated = await fs.readJson(path.join(source, '.aw-generated.json')) as { workspaceIdentity: string };
  const options = { cwd, env: isolation.env, cliVersion: '1.0.0', yes: true };
  const intent = (name: string) => ({ schemaVersion: 3 as const, kind: 'aw-plugin-intents' as const,
    sources: { team: { logicalIdentity: generated.workspaceIdentity } }, roots: [{ pluginId: `team/${name}` }] });
  await writeIntent({ ...options, scope: 'user' }, intent('a'));
  await writeIntent({ ...options, scope: 'project' }, intent('b'));
  await setTargets({ ...options, scope: 'user' }, ['generic']);
  const nativePaths: Record<string, string> = {};
  for (const scope of ['user', 'project'] as const) for (const platform of platforms.filter((platform) => platform !== 'generic')) for (const name of names) {
    const layout = await getNativeTestLayout({ platform, pluginId: `team/${name}`, scope, cwd, env: isolation.env });
    nativePaths[`${platform}/${scope}/${name}`] = path.join(layout.packageRoot, 'skills', skill(name));
  }
  const nativeSkill = (platform: 'opencode' | 'cursor', scope: 'user' | 'project', name: string) => nativePaths[`${platform}/${scope}/${name}`]!;
  return { options, cwd, source, hookTrace, hookFailure, nativeSkill, userRoot: path.join(isolation.env.HOME!, '.agents', 'skills'), projectRoot: path.join(cwd, '.agents', 'skills') };
}

async function expectSavedIntent(receipt: RecoveryReceipt, location: Parameters<typeof observeIntent>[0]) {
  const saved = await observeIntent(location);
  expect(saved.state).toBe('valid');
  if (saved.state !== 'valid') throw new Error('Expected the saved Intent to be readable.');
  expect(receipt.intent).toEqual({ state: 'valid', digest: saved.digest,
    roots: saved.value.roots.map((root) => root.pluginId) });
}

function failManifestAfterActiveCheck(file: string, stages: string[]) {
  const readJson = fs.readJson.bind(fs);
  let reads: number | undefined;
  const spy = vi.spyOn(fs, 'readJson').mockImplementation(async (...args: Parameters<typeof fs.readJson>) => {
    if (String(args[0]) === file && reads !== undefined && ++reads === 2) {
      throw Object.assign(new Error('read failed'), { code: 'EIO' });
    }
    return readJson(...args);
  });
  const runtime: RebuildCommandRuntime = { debugLogger: { log: (event) => {
    if (event.data?.phase === 'start' && stages.includes(String(event.data.name))) reads = 0;
  } } };
  return { runtime, restore: () => spy.mockRestore() };
}

describe('joint recovery through real Catalog and owned outputs', () => {
  beforeEach(() => { installNativeTestQualification({ discovery: true }); });
  // Public receipts must identify the saved scope and digest, independently of output execution.
  it.each(['user', 'project'] as const)('reports the saved %s Intent after initial install, add, no-op and remove', async (scope) => {
    const value = await fixture();
    const location = { ...value.options, scope };
    const other = { ...value.options, scope: scope === 'user' ? 'project' as const : 'user' as const };
    const otherBefore = await observeIntent(other);
    await fs.remove(await resolveIntentPath(location));
    const root = scope === 'user' ? 'team/a' : 'team/b';
    const installed = await runRecovery('install', [root], location);
    expect(installed.ok).toBe(true);
    expect(installed.declarationChanged).toBe(true);
    await expectSavedIntent(installed, location);
    const added = await runRecovery('install', ['team/d'], location);
    expect(added.ok).toBe(true);
    expect(added.declarationChanged).toBe(true);
    await expectSavedIntent(added, location);
    expect(added.intent.roots).toEqual([root, 'team/d']);
    const unchanged = await runRecovery('install', ['team/d'], location);
    expect(unchanged.ok).toBe(true);
    expect(unchanged.declarationChanged).toBe(false);
    expect(unchanged.intent).toEqual(added.intent);
    const removed = await runRecovery('uninstall', ['team/d'], { ...location, force: true });
    expect(removed.ok).toBe(true);
    expect(removed.declarationChanged).toBe(true);
    await expectSavedIntent(removed, location);
    expect(removed.intent.roots).toEqual([root]);
    expect(removed.intent.digest).not.toBe(added.intent.digest);
    expect(await observeIntent(other)).toEqual(otherBefore);
  }, 30000);

  // Test Value Gate: the public execution must create one shared dependency and preserve both declarations.
  it('repairs user providers before project consumers without a project dependency copy', async () => {
    const value = await fixture();
    const result = await runRecovery('sync', [], value.options);
    expect(result.errors).toEqual([]);
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.declarationChanged).toBe(false);
    await expectSavedIntent(result, { ...value.options, scope: 'project' });
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'd'))).toBe(false);
    expect(await observeIntent({ ...value.options, scope: 'project' })).toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
    const status = await readRecoveryStatus(value.options);
    expect(status.coverage.scopes).toEqual(['user', 'project']);
    expect(status.allSatisfied).toBe(true);
  }, 30000);
  it.each(['same-path damage', 'new Active', 'new Active with caller context'] as const)('rejects install after %s between Review and confirmation', async (change) => {
    const value = await fixture();
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    // A first install has no saved root from which to derive its Catalog identity.
    await Promise.all([fs.remove(await resolveIntentPath(user)), fs.remove(await resolveIntentPath(project))]);
    const before = await resolveActiveCatalogGeneration({ sourceId: 'team', env: user.env });
    const plan = await prepareRecovery('install', ['team/a'], change === 'new Active with caller context'
      ? { ...user, catalogOperationContext: await resolveCatalogOperationContext({ env: user.env }) } : user);
    expect(plan.receipt.blockers).toEqual([]);
    if (change === 'same-path damage') {
      const file = path.join(before.snapshotPath, 'plugins', 'b', 'generic', 'skills', 'b', 'README.md');
      const times = await fs.stat(file);
      await fs.writeFile(file, 'Use x.\n');
      await fs.utimes(file, times.atime, times.mtime);
    } else {
      await fs.appendFile(path.join(value.source, 'catalog-manifest.json'), '\n');
      const changed = await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: user.cliVersion, env: user.env });
      expect(changed.active?.snapshotDigest).not.toBe(before.snapshotDigest);
    }

    const receipt = await executeRecovery(plan);
    expect(receipt).toMatchObject({ ok: false, declarationChanged: false, outputsMayHaveChanged: false,
      blockers: expect.arrayContaining([expect.objectContaining({ code: 'operationReviewStale' })]) });
    await expect(observeIntent(user)).resolves.toEqual({ state: 'absent' });
    await expect(observeIntent(project)).resolves.toEqual({ state: 'absent' });
    await expect(fs.pathExists(value.userRoot)).resolves.toBe(false);
    await expect(fs.pathExists(value.projectRoot)).resolves.toBe(false);
  });
  it('reports current Active after writing even when the complete reviewed Store is still readable', async () => {
    const value = await fixture();
    const project = { ...value.options, scope: 'project' as const };
    await fs.remove(await resolveIntentPath(project));
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);

    const old = await resolveCatalogOperationContext({ env: project.env });
    const statePath = resolveCatalogGenerationStatePath(project.env);
    const originalState = await fs.readFile(statePath);
    const pluginRoot = path.join(value.source, 'plugins', 'a');
    for (const base of [pluginRoot, path.join(pluginRoot, 'generic')]) {
      await fs.appendFile(path.join(base, 'skills', 'a', 'SKILL.md'), 'New content.\n');
    }
    const entry = await createCatalogManifestV7Entry(await readPluginManifest(pluginRoot, { mode: 'bundle' }), pluginRoot);
    const manifestPath = path.join(value.source, 'catalog-manifest.json');
    const manifest = await fs.readJson(manifestPath);
    await fs.writeJson(manifestPath, { ...manifest, entries: manifest.entries.map((item: typeof entry) =>
      item.name === entry.name ? entry : item) });
    const next = await syncCatalogSourceGeneration({ sourceId: 'team', ...project, impactConfirmed: true });
    expect(next.active?.snapshotDigest).not.toBe(old.generationSet.sources[0]!.snapshotDigest);
    // Prepare the new generation's expected bytes so a read-only status can compare both roots.
    const prepared = await prepareRecovery('install', ['team/b'], project);
    await prepared.context.dispose();
    const nextState = await fs.readFile(statePath);
    await fs.writeFile(statePath, originalState);

    // Switch the real Active pointer only after every confirmed child has finished.
    const receipt = await runRecovery('install', ['team/b'], { ...project, catalogOperationContext: old }, {
      debugLogger: { log: async (event) => {
        if (event.data?.name === 'recovery.status' && event.data.phase === 'start') await fs.writeFile(statePath, nextState);
      } },
    });
    const fresh = await readRecoveryStatus(project);
    const previous = await readRecoveryStatus({ ...project, catalogOperationContext: old });
    expect(previous).toMatchObject({ allSatisfied: true, inSync: true });
    expect(fresh).toMatchObject({ allSatisfied: false, inSync: false, coverage: { scopes: ['user', 'project'] },
      inventory: [expect.objectContaining({ pluginId: 'team/a', targetResults: [expect.objectContaining({ content: 'drifted' })] }),
        expect.objectContaining({ pluginId: 'team/b', targetResults: [expect.objectContaining({ content: 'satisfied' })] })] });
    expect(receipt).toMatchObject({ ok: true, allSatisfied: fresh.allSatisfied, inSync: fresh.inSync,
      coverage: { scopes: fresh.coverage.scopes }, requestedRoots: ['team/b'], remainingTargets: [],
      targetResults: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/b', scope: 'project', execution: 'applied', observation: 'verified' })]) });
  });

  it.each(['project unavailable', 'parent project visible', 'damaged Store'] as const)('preserves completed installation and a read-only recheck after final status finds %s', async (fault) => {
    const value = await fixture();
    const project = { ...value.options, scope: 'project' as const };
    if (fault === 'parent project visible') await git(path.dirname(value.cwd), ['init', '--quiet']);
    await fs.remove(await resolveIntentPath(project));
    const active = await resolveActiveCatalogGeneration({ env: project.env, sourceId: 'team' });
    const marker = fault === 'damaged Store' ? path.join(active.snapshotPath, '.agents', 'plugins', 'marketplace.json')
      : path.join(value.cwd, '.git');
    const saved = path.join(value.cwd, 'saved-marker');
    const result = await runPublicLifecycle('install', ['team/b'], project, {
      debugLogger: { log: async (event) => {
        if (event.data?.name === 'recovery.status' && event.data.phase === 'start') await fs.rename(marker, saved);
      } },
    });
    const current = fault === 'damaged Store' ? await readRecoveryStatus(project) : undefined;
    await fs.rename(saved, marker);
    if (current) expect(current.inventory?.map((entry) => entry.sourceState)).toEqual(['unavailable', 'unavailable']);
    expect(result).toMatchObject({ status: 'partial', data: {
      changes: { requirements: 'changed', outputs: 'changed' }, allSatisfied: current?.allSatisfied ?? null,
      inSync: current?.inSync ?? null, remainingTargets: [],
      targetResults: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/b', target: 'generic', scope: 'project',
        execution: 'applied', observation: 'verified' })]) },
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'statusUnavailable',
        detail: { reasonCode: fault === 'damaged Store' ? 'sourceActiveUnavailable' : 'projectRootUnavailable' } })]),
      nextActions: [{ kind: 'command', argv: ['aw', 'plugin', 'status', '--context', 'project', '--json'],
        requiresConfirmation: false, reason: expect.any(String) }] });
    await expect(fs.readFile(path.join(value.projectRoot, 'b', 'SKILL.md'), 'utf8')).resolves.toContain('Use b.');
    await expect(observeIntent(project)).resolves.toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
  });

  it.each([
    ['requested output', 'portableObservationFailed'],
    ['requested Intent', 'pluginIntentStateInvalid'],
    ['deployment preferences', 'deploymentPreferencesInvalid'],
    ['other scope Intent', null],
    ['other scope output', null],
    ['requested content drift', null],
  ] as const)('reports the completed install against a fresh status read with %s affected', async (fault, failure) => {
    const value = await fixture(false, ['generic'], false, { a: [], b: [] });
    const project = { ...value.options, scope: 'project' as const };
    const user = { ...value.options, scope: 'user' as const };
    const projectIntent = await resolveIntentPath(project);
    await fs.remove(projectIntent);
    if (fault === 'other scope output') expect((await runRecovery('sync', ['team/a'], user)).ok).toBe(true);
    const output = path.join(value.projectRoot, 'b', 'SKILL.md');
    const affected = fault === 'requested Intent' ? projectIntent
      : fault === 'other scope Intent' ? await resolveIntentPath(user)
      : fault === 'deployment preferences' ? await resolvePreferencesPath(project)
      : fault === 'other scope output' ? path.join(value.userRoot, 'a', 'SKILL.md') : output;
    const readFile = fs.readFile.bind(fs);
    const reads = vi.spyOn(fs, 'readFile');
    try {
      const result = await runPublicLifecycle('install', ['team/b'], project, {
        debugLogger: { log: async (event) => {
          if (event.data?.name !== 'recovery.status' || event.data.phase !== 'start') return;
          if (fault === 'requested content drift') await fs.appendFile(output, 'Local edit.\n');
          else reads.mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
            if (String(args[0]) === affected) throw Object.assign(new Error('read failed'), { code: 'EIO' });
            return readFile(...args);
          });
        } },
      });
      const current = await readRecoveryStatus(project);
      expect(result.data).toMatchObject({ changes: { requirements: 'changed', outputs: 'changed' },
        allSatisfied: current.allSatisfied, inSync: current.inSync, remainingTargets: [],
        targetResults: [expect.objectContaining({ pluginId: 'team/b', scope: 'project', target: 'generic',
          execution: 'applied', observation: 'verified' })] });
      if (failure) {
        expect(result).toMatchObject({ status: 'partial',
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'statusUnavailable', detail: { reasonCode: failure } })]),
          nextActions: [{ kind: 'command', argv: ['aw', 'plugin', 'status', '--context', 'project', '--json'],
            requiresConfirmation: false, reason: expect.any(String) }] });
      } else {
        expect(result.status, JSON.stringify(result.diagnostics)).toBe('success');
        expect(result.nextActions).toEqual([]);
        expect(current.allSatisfied).not.toBe(true);
      }
    } finally { reads.mockRestore(); }
    await expect(fs.readFile(output, 'utf8')).resolves.toContain('Use b.');
    await expect(observeIntent(project)).resolves.toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
  });

  it.each(['requested', 'independent'] as const)('attributes a final manifest read failure to its %s dependency closure', async (affected) => {
    const value = await fixture(false, ['generic'], false, { a: ['x'], b: ['c'], c: ['d'], d: [], x: [] });
    const project = { ...value.options, scope: 'project' as const };
    const user = { ...value.options, scope: 'user' as const };
    const userIntent = await observeIntent(user);
    if (userIntent.state !== 'valid') throw new Error('Expected a saved fixture Intent.');
    await writeIntent(project, userIntent.value);
    await fs.remove(await resolveIntentPath(user));
    expect((await runRecovery('sync', ['team/a'], project)).ok).toBe(true);
    await setTargets(user, ['generic', 'cursor']);
    const active = await resolveActiveCatalogGeneration({ env: project.env, sourceId: 'team' });
    const file = path.join(active.snapshotPath, 'plugins', affected === 'requested' ? 'd' : 'x', '.agents-plugin', 'plugin.json');
    const readJson = fs.readJson.bind(fs);
    const reads = vi.spyOn(fs, 'readJson');
    let manifestReads = 0;
    try {
      const result = await runPublicLifecycle('install', ['team/b'], { ...project, targets: ['generic'] }, {
        debugLogger: { log: (event) => {
          if (event.data?.name !== 'recovery.status' || event.data.phase !== 'start') return;
          reads.mockImplementation(async (...args: Parameters<typeof fs.readJson>) => {
            // Let Active validate the file. Fail its subsequent demand-manifest read once.
            if (String(args[0]) === file && ++manifestReads === 2) throw Object.assign(new Error('read failed'), { code: 'EIO' });
            return readJson(...args);
          });
        } },
      });
      expect(result.data).toMatchObject({ changes: { requirements: 'changed', outputs: 'changed' }, remainingTargets: [],
        targetResults: ['d', 'c', 'b'].map((name) => expect.objectContaining({ pluginId: `team/${name}`, scope: 'project',
          target: 'generic', execution: 'applied', observation: 'verified' })) });
      if (affected === 'requested') {
        expect(result).toMatchObject({ status: 'partial',
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'statusUnavailable',
            subject: { pluginId: 'team/b', scope: 'project', target: 'generic' }, detail: { reasonCode: 'pluginManifestUnavailable' } })]),
          nextActions: [{ kind: 'command', argv: ['aw', 'plugin', 'status', '--context', 'project', '--json'],
            requiresConfirmation: false, reason: expect.any(String) }] });
      } else expect(result).toMatchObject({ status: 'success', nextActions: [] });
      manifestReads = 0;
      const current = await readRecoveryStatus(project);
      const independent = affected === 'requested' ? 'team/a' : 'team/b';
      expect(current.inventory?.find((root) => root.pluginId === independent)?.targetResults.find((target) => target.agent === 'generic'))
        .toMatchObject({ content: 'satisfied', blockers: [] });
      const unavailable = current.inventory?.find((root) => root.pluginId !== independent);
      expect(unavailable?.targetResults.find((target) => target.agent === 'generic')).toMatchObject({
        content: 'unknown', blockers: [expect.objectContaining({ code: 'pluginManifestUnavailable' })] });
      expect(unavailable?.targetResults.find((target) => target.agent === 'cursor')).toMatchObject({
        satisfaction: 'unsupported', observation: 'verified', blockers: [] });
      expect(result.data).toMatchObject({ allSatisfied: current.allSatisfied, inSync: current.inSync });
    } finally { reads.mockRestore(); }
    await expect(fs.readFile(path.join(value.projectRoot, 'b', 'SKILL.md'), 'utf8')).resolves.toContain('Use b.');
  });

  it.each([
    ['generic', 'shared'], ['generic', 'disjoint'], ['opencode', 'shared'], ['generic', 'project root'],
  ] as const)('attributes a final User manifest read failure on %s with a %s dependency', async (target, relation) => {
    const sharesDependency = relation !== 'disjoint';
    const ambiguous = target === 'generic' && relation === 'shared';
    const value = await fixture(false, [target], true, { a: ['x'], x: [sharesDependency ? 'd' : 'e'], b: ['d'], d: [], e: [] });
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    await fs.remove(await resolveIntentPath(project));
    await setTargets(user, [target]);
    expect((await runPublicLifecycle('install', ['team/a'], user)).status).toBe('success');
    if (relation === 'project root') expect((await runPublicLifecycle('install', ['team/d'], project)).status).toBe('success');
    await fs.writeFile(value.hookTrace, '');
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: user.env });
    const fault = failManifestAfterActiveCheck(path.join(active.snapshotPath, 'plugins/x/.agents-plugin/plugin.json'), ['recovery.status']);
    try {
      const result = await runPublicLifecycle('install', ['team/b'], project, fault.runtime);
      expect(result).toMatchObject({ status: ambiguous ? 'partial' : 'success', data: { changes: { requirements: 'changed', outputs: 'changed' },
        allSatisfied: null, remainingTargets: [], targetResults: expect.arrayContaining([expect.objectContaining({ pluginId: 'team/b', target,
          scope: 'project', execution: 'applied', observation: 'verified' })]) } });
      if (ambiguous) expect(result).toMatchObject({
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'statusUnavailable',
          subject: { pluginId: 'team/b', scope: 'project', target: 'generic' }, detail: { reasonCode: 'jointDemandUnknown' } })]),
        nextActions: [{ kind: 'command', argv: ['aw', 'plugin', 'status', '--context', 'project', '--json'],
          requiresConfirmation: false, reason: expect.any(String) }] });
      else expect(result.nextActions).toEqual([]);
    } finally { fault.restore(); }
    const hooks: Array<{ plugin: string; scope: string }> = (await fs.readFile(value.hookTrace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(hooks.filter((event) => event.plugin === 'b')).toEqual([{ plugin: 'b', platform: target, scope: 'project' }]);
    const skill = (scope: 'user' | 'project', name: string) => path.join(target === 'opencode'
      ? value.nativeSkill(target, scope, name) : path.join(scope === 'user' ? value.userRoot : value.projectRoot, name), 'SKILL.md');
    await expect(fs.readFile(skill('project', 'b'), 'utf8')).resolves.toContain('Use b.');
    await expect(fs.pathExists(skill('user', 'd'))).resolves.toBe(sharesDependency);
    await expect(fs.pathExists(skill('project', 'd'))).resolves.toBe(!ambiguous);
    await expect(readRecoveryStatus(project)).resolves.toMatchObject({ allSatisfied: true });
  });

  it.each(['required', 'required at recheck', 'independent'] as const)('protects an explicitly removed User provider according to its %s Project dependency', async (relation) => {
    const required = relation !== 'independent';
    const value = await fixture(false, ['generic'], false, { a: [], b: ['x'], x: [required ? 'a' : 'd'], d: [] });
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    expect((await runPublicLifecycle('install', ['team/a'], user)).status).toBe('success');
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: user.env });
    const fault = failManifestAfterActiveCheck(path.join(active.snapshotPath, 'plugins/x/.agents-plugin/plugin.json'),
      [...(relation === 'required at recheck' ? [] : ['recovery.plan']), 'recovery.locked.demand', 'recovery.locked.recheck']);
    const before = await observeIntent(user);
    try {
      const result = await runPublicLifecycle('remove', ['team/a'], user, fault.runtime);
      if (required) {
        expect(result).toMatchObject({ status: 'blocked', data: { changes: { requirements: 'none', outputs: 'none' } },
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: relation === 'required at recheck'
            ? 'operationReviewStale' : 'dependencyStillRequired' })]) });
        expect(await observeIntent(user)).toEqual(before);
      } else expect(result.data).toMatchObject({ changes: { requirements: 'changed', outputs: 'changed' } });
    } finally { fault.restore(); }
    await expect(fs.pathExists(path.join(value.userRoot, 'a/SKILL.md'))).resolves.toBe(required);
    await expect(fs.pathExists(path.join(value.projectRoot, 'a'))).resolves.toBe(false);
    await expect(observeIntent(project)).resolves.toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
  });

  it.each(['verified', 'absent', 'drifted', 'unowned', 'copy lost under lock', 'manifest lost under lock'] as const)('checks the Project copy (%s) before removing a User provider with an unreadable consumer', async (copy) => {
    const value = await fixture(false, ['generic'], false, { a: [], b: ['x'], x: ['a'] });
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    expect((await runPublicLifecycle('install', ['team/a'], user)).status).toBe('success');
    expect((await runPublicLifecycle('install', ['team/b', 'team/a'], project)).status).toBe('success');
    const projectCopy = path.join(value.projectRoot, 'a/SKILL.md');
    const userCopy = path.join(value.userRoot, 'a/SKILL.md');
    const projectFiles = await snapshotRegularTree(path.dirname(projectCopy));
    const before = await fs.readFile(projectCopy, 'utf8');
    expect(await fs.readFile(userCopy, 'utf8')).toBe(before);
    expect(await fs.readFile(path.join(value.projectRoot, 'x/SKILL.md'), 'utf8')).toContain('Use x.');
    if (copy === 'absent') await fs.remove(path.dirname(projectCopy));
    if (copy === 'drifted') await fs.appendFile(projectCopy, 'Local edit.\n');
    if (copy === 'unowned') await fs.remove(path.join(path.dirname(projectCopy), SKILL_OWNER_MARKER));
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: user.env });
    const fault = failManifestAfterActiveCheck(path.join(active.snapshotPath, 'plugins/x/.agents-plugin/plugin.json'),
      [...(copy === 'manifest lost under lock' ? [] : ['recovery.plan']), 'recovery.locked.demand', 'recovery.locked.recheck']);
    const projectIntent = await observeIntent(project);
    const userIntent = await observeIntent(user);
    try {
      const result = await runPublicLifecycle('remove', ['team/a'], user, { debugLogger: { log: async (event) => {
        await fault.runtime.debugLogger!.log(event);
        if (copy === 'copy lost under lock' && event.data?.name === 'recovery.locked.demand' && event.data.phase === 'start') {
          await fs.remove(path.dirname(projectCopy));
        }
      } } });
      if (copy === 'verified') {
        expect(result.data).toMatchObject({ changes: { requirements: 'changed', outputs: 'changed' } });
        expect(await fs.pathExists(userCopy)).toBe(false);
        expect(await snapshotRegularTree(path.dirname(projectCopy))).toEqual(projectFiles);
        await expect(observeIntent(user)).resolves.toMatchObject({ value: { roots: [] } });
      } else {
        expect(result).toMatchObject({ status: 'blocked', data: { changes: { requirements: 'none', outputs: 'none' } },
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: copy.endsWith('under lock')
            ? 'operationReviewStale' : 'dependencyStillRequired' })]) });
        expect(await fs.readFile(userCopy, 'utf8')).toBe(before);
        expect(await observeIntent(user)).toEqual(userIntent);
      }
      expect(await observeIntent(project)).toEqual(projectIntent);
    } finally { fault.restore(); }
  });

  it.each(['changed', 'invalid'] as const)('detects a %s second Intent before any output write', async (state) => {
    const value = await fixture();
    const plan = await prepareRecovery('sync', ['team/a'], value.options);
    const location = { ...value.options, scope: 'project' as const };
    if (state === 'invalid') await fs.writeFile(await resolveIntentPath(location), '{broken');
    else await writeIntent(location, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    const result = await executeRecovery(plan);
    expect(result.ok).toBe(false);
    expect(result.declarationChanged).toBe(false);
    expect(result.blockers.some((item) => item.code === 'operationReviewStale')).toBe(true);
    if (state === 'invalid') {
      expect(result.intent).toMatchObject({ state: 'invalid', roots: null, digest: expect.any(String) });
      expect(result.errors.some((item) => item.code === 'pluginIntentStateInvalid')).toBe(true);
    } else await expectSavedIntent(result, location);
    expect(await fs.pathExists(value.userRoot)).toBe(false);
  }, 30000);
  it('preserves a rejected Intent write diagnostic and creates no outputs', async () => {
    const value = await fixture();
    const location = { ...value.options, scope: 'project' as const };
    await fs.remove(await resolveIntentPath(location));
    const userBefore = await observeIntent({ ...value.options, scope: 'user' });
    await fs.writeFile(path.join(value.cwd, '.gitignore'), '/.agent-workflows/\n');
    await expect(runRecovery('install', ['team/b'], location)).rejects.toThrow('projectConfigIgnored');
    expect(await observeIntent(location)).toEqual({ state: 'absent' });
    expect(await observeIntent({ ...value.options, scope: 'user' })).toEqual(userBefore);
    expect(await fs.pathExists(value.userRoot)).toBe(false);
    expect(await fs.pathExists(value.projectRoot)).toBe(false);
  }, 30000);
  it('clears reviewed target outputs while keeping both Intent documents', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    await setTargets({ ...value.options, scope: 'user' }, []);
    const result = await runRecovery('sync', [], { ...value.options, retireUnselectedTargets: true });
    expect(result.outputsMayHaveChanged).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b'))).toBe(false);
    expect(await observeIntent({ ...value.options, scope: 'user' })).toMatchObject({ value: { roots: [{ pluginId: 'team/a' }] } });
  }, 30000);
  // Test Value Gate: a foreign replacement preserves prior Native output; an independent Native target can still finish.
  it('preserves prior Native outputs when a generic replacement conflicts and still permits safe work', async () => {
    const value = await fixture(false, ['generic', 'opencode', 'cursor']);
    await setTargets({ ...value.options, scope: 'user' }, ['opencode']);
    const initial = await runRecovery('sync', [], value.options);
    expect(initial.ok, JSON.stringify(initial)).toBe(true);
    const oldUser = path.join(value.nativeSkill('opencode', 'user', 'a'), 'SKILL.md');
    const oldProject = path.join(value.nativeSkill('opencode', 'project', 'b'), 'SKILL.md');
    const oldDependencyPaths = (['user', 'project'] as const).map((scope) => path.join(value.nativeSkill('opencode', scope, 'd'), 'SKILL.md'));
    const oldDependencyBytes = await Promise.all(oldDependencyPaths.map((file) => fs.readFile(file)));
    const oldContents = await Promise.all([fs.readFile(oldUser, 'utf8'), fs.readFile(oldProject, 'utf8')]);
    const foreignUser = path.join(value.userRoot, 'a', 'SKILL.md');
    const foreignProject = path.join(value.projectRoot, 'b', 'SKILL.md');
    await fs.outputFile(foreignUser, 'Foreign User replacement.');
    await fs.outputFile(foreignProject, 'Foreign Project replacement.');
    await setTargets({ ...value.options, scope: 'user' }, ['generic']);
    const conflicted = await runRecovery('sync', [], { ...value.options, retireUnselectedTargets: true });
    expect(conflicted.ok).toBe(false);
    expect(conflicted.errors.some((error) => error.code === 'portableOutputConflict')).toBe(true);
    expect(conflicted.outputsMayHaveChanged, JSON.stringify(conflicted)).toBe(true);
    expect(conflicted.targetResults).toContainEqual(expect.objectContaining({
      pluginId: 'team/d', agent: 'generic', scope: 'user', execution: 'applied',
      observation: 'verified', content: 'satisfied', blockers: [],
    }));
    await expect(fs.readFile(path.join(value.userRoot, 'd', 'SKILL.md'), 'utf8')).resolves.toContain('Use d.');
    expect(conflicted.targetResults).not.toContainEqual(expect.objectContaining({ agent: 'opencode', execution: 'applied' }));
    expect(await Promise.all(oldDependencyPaths.map((file) => fs.readFile(file)))).toEqual(oldDependencyBytes);
    await expect(fs.readFile(foreignUser, 'utf8')).resolves.toBe('Foreign User replacement.');
    expect(await Promise.all([fs.readFile(oldUser, 'utf8'), fs.readFile(oldProject, 'utf8')])).toEqual(oldContents);
    expect(await fs.readFile(foreignProject, 'utf8')).toBe('Foreign Project replacement.');

    await setTargets({ ...value.options, scope: 'user' }, ['generic', 'cursor']);
    const partial = await runRecovery('sync', [], { ...value.options, context: 'user', retireUnselectedTargets: true });
    expect(partial.ok).toBe(false);
    const safeOutput = path.join(value.nativeSkill('cursor', 'user', 'a'), 'SKILL.md');
    expect(await fs.pathExists(safeOutput)).toBe(true);
    expect(await fs.readFile(oldUser, 'utf8')).toBe(oldContents[0]);

    await setTargets({ ...value.options, scope: 'user' }, []);
    await runRecovery('sync', [], { ...value.options, retireUnselectedTargets: true });
    expect(await fs.pathExists(oldUser)).toBe(false);
    expect(await fs.pathExists(oldProject)).toBe(false);
    expect(await fs.pathExists(safeOutput)).toBe(false);
    expect(await fs.readFile(foreignUser, 'utf8')).toBe('Foreign User replacement.');
    expect(await fs.readFile(foreignProject, 'utf8')).toBe('Foreign Project replacement.');
    expect(await observeIntent({ ...value.options, scope: 'user' })).toMatchObject({ value: { roots: [{ pluginId: 'team/a' }] } });
  }, 30000);
  // Test Value Gate: scope switch hooks must run before deleting a working
  // provider, and failure must not prevent another target from switching.
  it('retains project providers when user preApply fails and switches an independent target once', async (test) => {
    const timing = createCommandTestTiming(test);
    const runtime = (commandSequence: number): RebuildCommandRuntime => ({
      debugLogger: { log: (event) => timing.commandEvent(commandSequence, event) },
    });
    const value = await timing.measure('fixture', 'provider switch', async () => {
      const value = await fixture(false, ['generic', 'opencode'], true);
      await writeIntent({ ...value.options, scope: 'user' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
      await setTargets({ ...value.options, scope: 'user' }, ['generic', 'opencode']);
      return value;
    });
    expect((await timing.measure('command', 'initial sync', (sequence) =>
      runRecovery('sync', [], value.options, runtime(sequence)))).ok).toBe(true);
    const oldProvider = path.join(value.projectRoot, 'd', 'SKILL.md');
    const oldConsumer = path.join(value.projectRoot, 'b', 'SKILL.md');
    const projectNative = path.join(value.nativeSkill('opencode', 'project', 'b'), 'SKILL.md');
    const projectNativeBefore = await fs.readFile(projectNative);
    const oldContents = await Promise.all([fs.readFile(oldProvider, 'utf8'), fs.readFile(oldConsumer, 'utf8')]);
    await fs.writeFile(value.hookTrace, '');
    const denied = await timing.measure('command', 'unauthorized install', async (sequence) => {
      const unauthorized = await prepareRecovery('install', ['team/b'], { ...value.options, scope: 'user', yes: false }, runtime(sequence));
      return executeRecovery(unauthorized, { yes: false });
    });
    expect(denied.ok).toBe(false);
    expect(denied.declarationChanged).toBe(true);
    await expectSavedIntent(denied, { ...value.options, scope: 'user' });
    expect(denied.errors.some((error) => error.code === 'preApplyAuthorizationRequired')).toBe(true);
    expect(await fs.readFile(value.hookTrace, 'utf8')).toBe('');
    expect(await Promise.all([fs.readFile(oldProvider, 'utf8'), fs.readFile(oldConsumer, 'utf8')])).toEqual(oldContents);
    await fs.writeFile(value.hookFailure, 'fail User generic provider');

    const result = await timing.measure('command', 'install with failing preApply', (sequence) =>
      runRecovery('install', ['team/b'], { ...value.options, scope: 'user' }, runtime(sequence)));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === 'providerSwitchPreApplyFailed'), JSON.stringify(result)).toBe(true);
    expect(result.declarationChanged).toBe(false);
    await expectSavedIntent(result, { ...value.options, scope: 'user' });
    expect(await Promise.all([fs.readFile(oldProvider, 'utf8'), fs.readFile(oldConsumer, 'utf8')])).toEqual(oldContents);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'b'))).toBe(false);
    const userNative = (name: string) => value.nativeSkill('opencode', 'user', name);
    expect(await fs.pathExists(path.join(userNative('d'), 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(userNative('b'), 'SKILL.md'))).toBe(true);
    await expect(fs.readFile(projectNative)).resolves.toEqual(projectNativeBefore);
    const events = (await fs.readFile(value.hookTrace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(events, JSON.stringify(events)).toHaveLength(5);
    expect(events).toEqual(expect.arrayContaining([
      { plugin: 'd', platform: 'generic', scope: 'user' },
      { plugin: 'd', platform: 'opencode', scope: 'user' },
      { plugin: 'b', platform: 'opencode', scope: 'user' },
      { plugin: 'd', platform: 'opencode', scope: 'project' },
      { plugin: 'b', platform: 'opencode', scope: 'project' },
    ]));
  }, process.platform === 'win32' ? 60_000 : 30_000);
  it('keeps a failed user provider at user scope and blocks its project consumer', async () => {
    const value = await fixture();
    const foreign = path.join(value.userRoot, 'd', 'SKILL.md');
    await fs.outputFile(foreign, 'Foreign content.');
    const result = await runRecovery('sync', [], value.options);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.code === 'userProviderNotSatisfied'), JSON.stringify(result, null, 2)).toBe(true);
    expect(await fs.readFile(foreign, 'utf8')).toBe('Foreign content.');
    expect(await fs.pathExists(path.join(value.projectRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b'))).toBe(false);
  }, 30000);
  it('moves a shared dependency to project and cleans it after the last project root is removed', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const removed = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user',
      exactTargets: [{ pluginId: 'team/a', agent: 'generic', scope: 'user' }] });
    expect(removed.ok, JSON.stringify(removed, null, 2)).toBe(true);
    await expectSavedIntent(removed, { ...value.options, scope: 'user' });
    expect(removed.intent.roots).toEqual([]);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await observeIntent({ ...value.options, scope: 'project' })).toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
    const last = await runRecovery('uninstall', ['team/b'], { ...value.options, scope: 'project',
      exactTargets: [{ pluginId: 'team/b', agent: 'generic', scope: 'project' }] });
    expect(last.ok).toBe(true);
    await expectSavedIntent(last, { ...value.options, scope: 'project' });
    expect(last.intent.roots).toEqual([]);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'd'))).toBe(false);
    expect(last.inSync).toBe(true);
  }, 30000);
  // Test Value Gate: independent Native scopes cannot replace or protect each
  // other's released dependencies; keep and a same-scope declaration retain them.
  it.each([
    { scope: 'user', keep: false, directRoot: 'none' },
    { scope: 'user', keep: true, directRoot: 'none' },
    { scope: 'project', keep: false, directRoot: 'none' },
    { scope: 'project', keep: true, directRoot: 'none' },
    { scope: 'user', keep: false, directRoot: 'other' },
    { scope: 'user', keep: true, directRoot: 'other' },
    { scope: 'project', keep: false, directRoot: 'other' },
    { scope: 'project', keep: true, directRoot: 'other' },
    { scope: 'user', keep: false, directRoot: 'selected' },
    { scope: 'project', keep: false, directRoot: 'selected' },
  ] as const)('removes only the selected independent Native scope with retention=$keep ($scope, direct root=$directRoot)', async ({ scope, keep, directRoot }) => {
    const value = await fixture(false, ['opencode']);
    await setTargets({ ...value.options, scope: 'user' }, ['opencode']);
    const otherScope = scope === 'user' ? 'project' : 'user';
    if (directRoot !== 'none') {
      const location = { ...value.options, scope: directRoot === 'other' ? otherScope : scope };
      const intent = await observeIntent(location);
      if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
      await writeIntent(location, { ...intent.value,
        roots: [...(directRoot === 'selected' ? intent.value.roots : []), { pluginId: 'team/d' }],
      });
    }
    const initial = await runRecovery('sync', [], value.options);
    expect(initial.ok, JSON.stringify(initial)).toBe(true);
    const root = scope === 'user' ? 'a' : 'b';
    const otherRoot = directRoot === 'other' ? 'd' : scope === 'user' ? 'b' : 'a';
    const retainDependency = keep || directRoot === 'selected';
    const packageRoot = (currentScope: 'user' | 'project', name: string) =>
      path.resolve(value.nativeSkill('opencode', currentScope, name), '../..');
    const otherIntent = await observeIntent({ ...value.options, scope: otherScope });
    const protectedRoots = [...new Set([otherRoot, 'd'])].map((name) => packageRoot(otherScope, name));
    const protectedBefore = await Promise.all(protectedRoots.map(snapshotRegularTree));
    const dependencyBefore = await snapshotRegularTree(packageRoot(scope, 'd'));
    expect(Object.keys(dependencyBefore).length).toBeGreaterThan(0);
    const foreign = path.join(path.dirname(packageRoot(scope, root)), 'foreign.txt');
    await fs.outputFile(foreign, 'Keep foreign content.');
    const plan = await prepareRecovery('uninstall', [`team/${root}`], {
      ...value.options, scope, keepDependencies: keep,
    });
    try {
      expect(plan.dependencyCleanupTargets).toEqual(retainDependency ? [] : [{ pluginId: 'team/d', agent: 'opencode', scope }]);
      expect(plan.joint?.children.flatMap((child) => child.receipt.requestedTargets)
        .map((target) => `${target.pluginId}@${target.scope}`).sort())
        .toEqual((retainDependency ? [`team/${root}@${scope}`] : [`team/${root}@${scope}`, `team/d@${scope}`]).sort());
      const removed = await executeRecovery(plan, { yes: true });
      expect(removed.ok, JSON.stringify(removed)).toBe(true);
      expect(removed.intent.roots).toEqual(directRoot === 'selected' ? ['team/d'] : []);
      expect(removed.remainingTargets).toEqual([]);
      if (!keep) expect((await readRecoveryStatus(value.options)).extraObserved).toEqual([]);
      expect(await fs.pathExists(packageRoot(scope, root))).toBe(false);
      if (retainDependency) expect(await snapshotRegularTree(packageRoot(scope, 'd'))).toEqual(dependencyBefore);
      else {
        expect(await fs.pathExists(packageRoot(scope, 'd'))).toBe(false);
        expect(removed.targetResults).toContainEqual(expect.objectContaining({
          pluginId: 'team/d', agent: 'opencode', scope, relation: 'dependency', execution: 'applied',
        }));
      }
      expect(await Promise.all(protectedRoots.map(snapshotRegularTree))).toEqual(protectedBefore);
      expect(await observeIntent({ ...value.options, scope: otherScope })).toEqual(otherIntent);
      expect(await fs.readFile(foreign, 'utf8')).toBe('Keep foreign content.');
    } finally { await plan.context.dispose(); }
  }, 30000);
  // Removing a root must preserve independent declarations and live consumers,
  // while a dependency-only update must not create an Intent root.
  it('updates a precise indirect dependency without changing either Intent', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const before = await Promise.all(['user', 'project'].map((scope) => observeIntent({ ...value.options, scope: scope as 'user' | 'project' })));
    const updated = await runRecovery('reinstall', ['team/d'], { ...value.options, scope: 'user', allowDependencySelectors: true,
      exactTargets: [{ pluginId: 'team/d', agent: 'generic' }] });
    expect(updated.ok, JSON.stringify(updated)).toBe(true);
    expect(updated.targetResults.map((target) => target.pluginId)).toEqual(['team/d']);
    expect(updated.declarationChanged).toBe(false);
    expect(await Promise.all(['user', 'project'].map((scope) => observeIntent({ ...value.options, scope: scope as 'user' | 'project' })))).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('blocks indirect dependency removal and allows force without removing its consumers', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const location = { ...value.options, scope: 'user' as const };
    const before = await observeIntent(location);
    const blocked = await runRecovery('uninstall', ['team/d'], location);
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
    expect(await observeIntent(location)).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(true);
    const forced = await runRecovery('uninstall', ['team/d'], { ...location, force: true });
    expect(forced.ok, JSON.stringify(forced)).toBe(true);
    expect(forced.declarationChanged).toBe(false);
    expect(await observeIntent(location)).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
    expect(forced.allSatisfied).toBe(false);
  }, 30000);

  it('cleans a transitive orphan closure but preserves a directly declared dependency', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['b'], b: ['d'], d: [] });
    const project = { ...value.options, scope: 'project' as const };
    await writeIntent(project, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    const user = { ...value.options, scope: 'user' as const };
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const planned = await prepareRecovery('uninstall', ['team/a'], user);
    try {
      expect(planned.dependencyCleanupTargets?.map((target) => target.pluginId).sort()).toEqual(['team/b', 'team/d']);
      const result = await executeRecovery(planned, { yes: true });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(await Promise.all(['a', 'b', 'd'].map((name) => fs.pathExists(path.join(value.userRoot, name))))).toEqual([false, false, false]);
    } finally { await planned.context.dispose(); }
    expect((await runRecovery('install', ['team/a', 'team/d'], user)).ok).toBe(true);
    expect((await runRecovery('uninstall', ['team/a'], user)).ok).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'b'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('preserves an orphan dependency needed by an installed consumer whose Intent was removed', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    const result = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('keeps an installed dependency out of removal when the other scope cannot read its provider manifest', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['d'], b: ['x'], x: ['d'], d: [] });
    const user = { ...value.options, scope: 'user' as const };
    const project = { ...value.options, scope: 'project' as const };
    // Only the user root is installed. The saved project requirement still protects its provider.
    expect((await runRecovery('install', ['team/a'], user)).ok).toBe(true);
    const active = await resolveActiveCatalogGeneration({ sourceId: 'team', env: project.env });
    const file = path.join(active.snapshotPath, 'plugins', 'x', '.agents-plugin', 'plugin.json');
    const readJson = fs.readJson.bind(fs);
    let manifestReads = 0;
    const reads = vi.spyOn(fs, 'readJson').mockImplementation(async (...args: Parameters<typeof fs.readJson>) => {
      if (String(args[0]) === file && ++manifestReads === 2) throw Object.assign(new Error('read failed'), { code: 'EIO' });
      return readJson(...args);
    });
    try {
      const plan = await prepareRecovery('uninstall', ['team/a'], user);
      try {
        expect(plan.joint?.demand.roots).toContainEqual(expect.objectContaining({ pluginId: 'team/b', scope: 'project',
          state: 'unknown', blockers: [expect.objectContaining({ code: 'pluginManifestUnavailable' })] }));
        expect(plan.joint?.demand.complete).toBe(false);
        expect(plan.dependencyCleanupTargets).toEqual([]);
        expect(plan.receipt.requestedTargets.map((target) => target.pluginId)).toEqual(['team/a']);
        const removed = await executeRecovery(plan, { yes: true, runtime: { debugLogger: { log: (event) => {
          if (event.data?.phase === 'start' && ['recovery.locked.demand', 'recovery.locked.recheck'].includes(String(event.data.name))) {
            manifestReads = 0;
          }
        } } } });
        expect(removed).toMatchObject({ declarationChanged: true,
          targetResults: [expect.objectContaining({ pluginId: 'team/a', execution: 'applied' })] });
      } finally { await plan.context.dispose(); }
    } finally { reads.mockRestore(); }
    await expect(fs.pathExists(path.join(value.userRoot, 'a'))).resolves.toBe(false);
    await expect(fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).resolves.toBe(true);
    await expect(observeIntent(project)).resolves.toMatchObject({ value: { roots: [{ pluginId: 'team/b' }] } });
  });

  it('retains the transitive dependencies when deleting their consumer fails', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['b'], b: ['d'], d: [] });
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (source === path.join(value.userRoot, 'a')) throw new Error('EACCES');
      return rename(source, destination);
    });
    try {
      const result = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user' });
      expect(result.ok).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
      expect(await Promise.all(['a', 'b', 'd'].map((name) => fs.pathExists(path.join(value.userRoot, name, 'SKILL.md'))))).toEqual([true, true, true]);
    } finally { failure.mockRestore(); }
  }, 30000);

  it('retains a shared leaf when a consumer on the second dependency path fails to delete', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['b', 'c'], b: ['d'], c: ['d'], d: [] });
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const rename = fs.rename.bind(fs);
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (source === path.join(value.userRoot, 'c')) throw new Error('EACCES');
      return rename(source, destination);
    });
    try {
      const result = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user' });
      expect(result.ok).toBe(false);
      expect(result.targetResults.find((target) => target.pluginId === 'team/d')?.blockers)
        .toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
      expect(await Promise.all(['a', 'b', 'c', 'd'].map((name) => fs.pathExists(path.join(value.userRoot, name, 'SKILL.md')))))
        .toEqual([false, false, true, true]);
    } finally { failure.mockRestore(); }
  }, 30000);

  it('retains dependencies when a possible current-project consumer cannot be identified', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    await fs.writeFile(path.join(value.projectRoot, 'b', SKILL_OWNER_MARKER), '{broken');
    expect((await readRecoveryStatus(value.options)).coverage.portable).toBe(false);
    const result = await runRecovery('uninstall', ['team/a'], { ...value.options, scope: 'user' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
  }, 30000);

  it.for([false, true])('keeps exact removal pairs and protects unselected consumers (shared=%s)', async (shared, test) => {
    const timing = createCommandTestTiming(test);
    const runtime = (sequence: number): RebuildCommandRuntime => ({
      debugLogger: { log: (event) => timing.commandEvent(sequence, event) },
    });
    const graph = shared ? { a: ['d'], b: ['d'], d: [] } : { a: ['d'], b: ['e'], d: [], e: [] };
    const value = await timing.measure('fixture', 'exact removal catalog', () => fixture(false, ['generic', 'opencode'], false, graph));
    await setTargets({ ...value.options, scope: 'user' }, ['generic', 'opencode']);
    await writeIntent({ ...value.options, scope: 'user' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    const project = { ...value.options, scope: 'project' as const };
    const intent = await observeIntent(project);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(project, { ...intent.value, roots: [{ pluginId: 'team/a' }, { pluginId: 'team/b' }] });
    expect((await timing.measure('command', 'initial sync', (sequence) => runRecovery('sync', [], value.options, runtime(sequence)))).ok).toBe(true);
    const plan = await timing.measure('command', 'prepare exact removal', (sequence) =>
      prepareRecovery('uninstall', ['team/a', 'team/b'], { ...project, targets: ['generic', 'opencode'],
        exactTargets: [{ pluginId: 'team/a', agent: 'generic' }, { pluginId: 'team/b', agent: 'opencode' }] }, runtime(sequence)));
    try {
      expect(plan.dependencyCleanupTargets?.map((target) => `${target.pluginId}@${target.agent}`).sort())
        .toEqual(shared ? [] : ['team/d@generic', 'team/e@opencode']);
      expect(plan.receipt.requestedTargets.map((target) => `${target.pluginId}@${target.agent}`).sort())
        .toEqual(shared ? ['team/a@generic', 'team/b@opencode'] : ['team/a@generic', 'team/b@opencode', 'team/d@generic', 'team/e@opencode']);
      const result = await timing.measure('command', 'execute exact removal', (sequence) =>
        executeRecovery(plan, { yes: true, runtime: runtime(sequence) }));
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const exists = (name: string, agent: 'generic' | 'opencode') => fs.pathExists(path.join(
        agent === 'generic' ? path.join(value.projectRoot, name) : value.nativeSkill('opencode', 'project', name), 'SKILL.md'));
      expect(await Promise.all([exists('a', 'generic'), exists('a', 'opencode'), exists('b', 'generic'), exists('b', 'opencode')]))
        .toEqual([false, true, true, false]);
      expect(await Promise.all([exists('d', 'generic'), exists('d', 'opencode')])).toEqual([shared, true]);
      if (!shared) expect(await Promise.all([exists('e', 'generic'), exists('e', 'opencode')])).toEqual([true, false]);
    } finally { await plan.context.dispose(); }
  }, process.platform === 'win32' ? 60_000 : 30_000);

  it.each([false, true])('removes a root and selected leaf while respecting intermediate retention (keep=%s)', async (keep) => {
    const value = await fixture(false, ['generic'], false, { a: ['b'], b: ['d'], d: [] });
    await writeIntent({ ...value.options, scope: 'project' }, { schemaVersion: 3, kind: 'aw-plugin-intents', sources: {}, roots: [] });
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const result = await runRecovery('uninstall', ['team/a', 'team/d'], { ...value.options, scope: 'user', keepDependencies: keep });
    expect(result.ok, JSON.stringify(result)).toBe(!keep);
    if (keep) expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
    expect(await Promise.all(['a', 'b', 'd'].map((name) => fs.pathExists(path.join(value.userRoot, name, 'SKILL.md')))))
      .toEqual([keep, keep, keep]);
  }, 30000);

  it('removes a project declaration while preserving the user provider used by a user consumer', async () => {
    const value = await fixture();
    const project = { ...value.options, scope: 'project' as const };
    const intent = await observeIntent(project);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(project, { ...intent.value, roots: [{ pluginId: 'team/d' }] });
    const initial = await runRecovery('sync', [], value.options);
    expect(initial.ok, JSON.stringify(initial)).toBe(true);
    const projectProvider = path.join(value.projectRoot, 'd', 'SKILL.md');
    await expect(fs.readFile(projectProvider, 'utf8')).resolves.toContain('Use d.');
    const userProvider = await fs.readFile(path.join(value.userRoot, 'd', 'SKILL.md'));
    const userIntent = await observeIntent({ ...value.options, scope: 'user' });
    const result = await runRecovery('uninstall', ['team/d'], project);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.intent.roots).toEqual([]);
    expect(result.targetResults).toContainEqual(expect.objectContaining({
      pluginId: 'team/d', agent: 'generic', scope: 'project', execution: 'applied', observation: 'missing', content: 'absent',
    }));
    await expect(fs.pathExists(path.dirname(projectProvider))).resolves.toBe(false);
    await expect(fs.readFile(path.join(value.userRoot, 'd', 'SKILL.md'))).resolves.toEqual(userProvider);
    expect(await observeIntent({ ...value.options, scope: 'user' })).toEqual(userIntent);
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('does not replace a live user consumer dependency with a project-only provider', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const user = { ...value.options, scope: 'user' as const };
    const intent = await observeIntent(user);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(user, { ...intent.value, roots: [{ pluginId: 'team/d' }] });
    const before = await observeIntent(user);
    const result = await runRecovery('uninstall', ['team/d'], user);
    expect(result.ok).toBe(false);
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
    expect(await observeIntent(user)).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
  }, 30000);

  it('blocks an indirect provider switch that would strand an existing user consumer', async () => {
    const value = await fixture(false, ['generic'], false, { a: ['d'], b: ['d'], d: [], x: ['d'] });
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const user = { ...value.options, scope: 'user' as const };
    expect((await runRecovery('install', ['team/x'], user)).ok).toBe(true);
    const intent = await observeIntent(user);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(user, { ...intent.value, roots: [{ pluginId: 'team/a' }] });
    const before = await observeIntent(user);
    for (const force of [false, true]) {
      const result = await runRecovery('uninstall', ['team/a'], { ...user, force });
      expect(result.ok).toBe(false);
      expect(result.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
      expect(await observeIntent(user)).toEqual(before);
      expect(await Promise.all(['a', 'd', 'x'].map((name) => fs.pathExists(path.join(value.userRoot, name, 'SKILL.md')))))
        .toEqual([true, true, true]);
    }
  }, 30000);

  it('requires force when a live consumer dependency graph is no longer available in Active', async () => {
    const value = await fixture();
    expect((await runRecovery('sync', [], value.options)).ok).toBe(true);
    const user = { ...value.options, scope: 'user' as const };
    const intent = await observeIntent(user);
    if (intent.state !== 'valid') throw new Error('fixtureIntentMissing');
    await writeIntent(user, { ...intent.value, roots: [{ pluginId: 'team/d' }] });
    await fs.remove(path.join(value.source, 'plugins', 'a'));
    await createDependencyCatalogSnapshotFixture(value.source, [
      { name: 'b', dependencies: ['d'] }, { name: 'd' },
    ].map((entry) => ({ ...entry, configureManifest: (manifest) => {
      manifest.platforms = ['generic']; manifest.skills = './skills'; delete manifest.extensions;
    } })));
    await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: value.options.env });
    const status = await readRecoveryStatus(value.options);
    expect(status.coverage.portable).toBe(true);
    expect(status.existingTargets).toContainEqual({ pluginId: 'team/a', agent: 'generic', scope: 'user' });
    const before = await observeIntent(user);
    const blocked = await runRecovery('uninstall', ['team/d'], user);
    expect(blocked.ok).toBe(false);
    expect(blocked.blockers).toContainEqual(expect.objectContaining({ code: 'dependencyStillRequired' }));
    expect(await observeIntent(user)).toEqual(before);
    expect(await fs.pathExists(path.join(value.userRoot, 'd', 'SKILL.md'))).toBe(true);
    const forced = await runRecovery('uninstall', ['team/d'], { ...user, force: true });
    expect(forced.ok, JSON.stringify(forced)).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
  }, 30000);
  it('does not install missing outputs during configuration apply', async () => {
    const value = await fixture();
    const result = await runRecovery('sync', ['team/a', 'team/d', 'team/b'], { ...value.options, existingOnly: true });
    expect(result.ok).toBe(false);
    expect(await fs.pathExists(value.userRoot)).toBe(false);
    expect(await fs.pathExists(value.projectRoot)).toBe(false);
  }, 30000);

  it('blocks cross-scope Skill names from different plugins before creating outputs', async () => {
    const value = await fixture(true);
    const result = await runRecovery('sync', [], value.options);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.code === 'crossScopeSkillCollision')).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'a'))).toBe(false);
  }, 30000);

  it('continues an independent source while a missing source and its project consumer remain blocked', async () => {
    const value = await fixture();
    for (const scope of ['user', 'project'] as const) {
      const observed = await observeIntent({ ...value.options, scope });
      if (observed.state !== 'valid') throw new Error('fixtureIntentMissing');
      await writeIntent({ ...value.options, scope }, { ...observed.value,
        sources: { ...observed.value.sources, missing: { logicalIdentity: 'catalog:missing' } },
        roots: [...observed.value.roots, { pluginId: scope === 'user' ? 'missing/provider' : 'missing/consumer' }],
      });
    }
    const result = await runRecovery('sync', [], value.options);
    expect(result.ok).toBe(false);
    expect(result.errors.some((item) => item.code === 'sourceMissing')).toBe(true);
    expect(await fs.pathExists(path.join(value.userRoot, 'a', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'b', 'SKILL.md'))).toBe(true);
    expect(await fs.pathExists(path.join(value.projectRoot, 'd'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'provider'))).toBe(false);
    expect(await fs.pathExists(path.join(value.projectRoot, 'consumer'))).toBe(false);
    const status = await readRecoveryStatus(value.options);
    expect(status.allSatisfied).toBeNull();
    expect(status.inventory?.find((entry) => entry.pluginId === 'missing/consumer')?.targetResults[0]).toMatchObject({
      content: 'unknown', blockers: [expect.objectContaining({ code: 'sourceMissing' })],
    });
  }, 30000);

});
