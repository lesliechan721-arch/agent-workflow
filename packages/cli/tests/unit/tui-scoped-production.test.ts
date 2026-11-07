import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { addRoot, observeIntent } from '../../src/intent/intent-store.js';
import { observePreferences, writePreferences } from '../../src/intent/deployment-preferences.js';
import { executeRecovery, prepareRecovery } from '../../src/recovery/coordinator.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration, type CatalogGenerationServiceRuntime } from '../../src/utils/catalog-generation-service.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { readCatalogSnapshotLogicalIdentity } from '../../src/utils/catalog-generation-store.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { createCodexNativeTestRuntime } from '../helpers/codex-native-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(portable = false) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = path.join(isolation.layout.fixtureCwd, 'project');
  const source = path.join(isolation.layout.fixtureCwd, 'catalog');
  const env = isolation.env;
  await fs.ensureDir(cwd);
  await git(cwd, ['init', '--quiet']);
  const generation = async (version: string) => {
    for (const platform of ['codex', 'claude', 'cursor', '']) {
      await fs.outputFile(path.join(source, 'plugins/demo', platform, 'skills/example/SKILL.md'),
        `---\nname: example\ndescription: Content ${version}\n---\nContent ${version}\n`);
      await fs.outputFile(path.join(source, 'plugins/demo', platform, 'skills/example/README.md'), `Content ${version}`);
    }
    await fs.outputJson(path.join(source, 'plugins/demo/.app.json'), { apps: {} });
    const configure: NonNullable<Parameters<typeof createCatalogSnapshotFixture>[4]> = (manifest) => {
      manifest.version = version;
      manifest.apps = './.app.json';
      if (portable) {
        manifest.skills = './skills';
        manifest.platforms = ['cursor'];
        delete manifest.apps;
      } else {
        manifest.skills = './skills';
        manifest.platforms = ['codex', 'claude'];
      }
      manifest.config = { fields: {
        greeting: { type: 'string', default: `Schema ${version}` },
      } };
    };
    await createCatalogSnapshotFixture(source, 'demo', [], `Content ${version}`, configure);
    const manifest = await fs.readJson(path.join(source, 'plugins/demo/.agents-plugin/plugin.json'));
    for (const platform of ['codex', 'claude', 'cursor']) {
      await fs.outputJson(path.join(source, 'plugins/demo', platform, 'skills/example/aw-plugin-requirements.json'),
        createAwPluginRequirementsReceipt({ name: 'demo', version }, manifest.requires.aw.capabilities));
    }
    await createCatalogSnapshotFixture(source, 'demo', [], `Content ${version}`, configure);
    await fs.outputJson(path.join(source, 'plugins/demo/codex/.app.json'), { apps: {} });
    for (const platform of portable ? [] : ['codex', 'claude']) {
      const file = path.join(source, 'plugins/demo', `.${platform}-plugin/plugin.json`);
      await fs.writeJson(file, { ...await fs.readJson(file), skills: `./${platform}/skills`,
        ...(platform === 'codex' ? { apps: './codex/.app.json' } : {}) });
    }
    const catalogPath = path.join(source, 'catalog-manifest.json');
    await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries: [
      await createCatalogManifestV7Entry(await readPluginManifest(path.join(source, 'plugins/demo'), { mode: 'bundle' }),
        path.join(source, 'plugins/demo')),
    ] });
    await syncCatalogSourceGeneration({ sourceId: 'local', env, cliVersion: '1.0.0' });
  };
  await createCatalogSnapshotFixture(source);
  await replaceCatalogSourcesConfig({ env, expectedDigest: (await readCatalogSourcesConfigSnapshot(env)).digest,
    config: { schemaVersion: 2, sources: [
    { id: 'local', type: 'path', primary: true, path: source },
  ] } });
  await generation('1.0.0');
  for (const scope of ['user', 'project'] as const) {
    await addRoot({ scope, cwd, env }, 'local/demo', await readCatalogSnapshotLogicalIdentity(source));
  }
  await writePreferences({ cwd, env }, { schemaVersion: 2, kind: 'aw-deployment-preferences',
    targets: [portable ? 'cursor' : 'codex'], exclusions: [] });
  const context = createCliExecutionContext({ cwd, env, interactive: false,
    nativeCliRunner: async (invocation) => ({ exitCode: 0, stderr: '',
      stdout: invocation.args.includes('--version') ? 'codex-cli 0.151.0\n' : '[]' }),
  });
  return { cwd, env, source, generation, context };
}

describe('scoped TUI production reads', () => {
  it.each([['user', true], ['user', false], ['project', true], ['project', false]] as const)(
    'requires reload after Active changes for %s (cached content: %s)', async (scope, cached) => {
    const value = await fixture();
    const controller = new TuiController(createTuiControllerDependencies(value.context));
    try {
      await controller.load();
      expect(controller.snapshot.phase).toBe('ready');
      await controller.refreshScopedInventory(scope);
      controller.push({ name: 'intentInventory', scope }, { query: 'demo', focusIndex: 1, scrollOffset: 2 });
      const page = controller.snapshot.router.current;
      if (cached) await controller.loadPluginContent('local/demo');
      const content = controller.getPluginContentOverview('local/demo');
      const subject = controller.getPluginDetailSubject('local/demo');
      const config = await controller.getConfigPage('local/demo', { context: scope });
      if (cached) expect(content?.pluginVersion).toBe('1.0.0');
      expect(subject?.plugin?.version).toBe('1.0.0');
      await value.generation('2.0.0');
      expect(await controller.refreshScopedInventory(scope)).toBe(false);
      expect(controller.snapshot.scopedInventoryRefresh[scope]).toMatchObject({
        state: 'error', errorCode: 'catalogSessionReloadRequired',
      });
      expect(controller.snapshot.router.current).toEqual(page);
      expect(controller.getPluginDetailSubject('local/demo')?.plugin?.version).toBe(subject?.plugin?.version);
      await controller.loadPluginContent('local/demo');
      if (cached) expect(controller.getPluginContentOverview('local/demo')).toEqual(content);
      expect(controller.getPluginContentOverview('local/demo')?.pluginVersion).toBe('1.0.0');
      expect(controller.getPluginContentOverview('local/demo')?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ description: 'Content 1.0.0' }),
      ]));
      expect(await controller.getConfigPage('local/demo', { context: scope })).toEqual(config);
      await controller.load();
      await controller.refreshScopedInventory(scope);
      await controller.loadPluginContent('local/demo');
      expect(controller.getPluginContentOverview('local/demo')?.pluginVersion).toBe('2.0.0');
      expect(controller.getPluginContentOverview('local/demo')?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ description: 'Content 2.0.0' }),
      ]));
      expect(await controller.getConfigPage('local/demo', { context: scope })).not.toEqual(config);
    } finally { controller.dispose(); }
  });

  it('cancels a source probe through the production runtime and does not commit state', async () => {
    const value = await fixture();
    const config = await readCatalogSourcesConfigSnapshot(value.env);
    await replaceCatalogSourcesConfig({ env: value.env, expectedDigest: config.digest,
      config: { ...config.config, sources: [...config.config.sources,
        { id: 'other', type: 'path', primary: false, path: value.source }] } });
    await syncCatalogSourceGeneration({ sourceId: 'other', env: value.env, cliVersion: '1.0.0' });
    await addRoot({ ...value, scope: 'user' }, 'other/demo', await readCatalogSnapshotLogicalIdentity(value.source));
    const beforeIntent = await observeIntent({ ...value, scope: 'user' });
    const beforePreferences = await observePreferences({ ...value, scope: 'user' });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let received: AbortSignal | undefined;
    const sources: string[] = [];
    const runtime: CatalogGenerationServiceRuntime = { providers: {
      path: async (source, options) => {
        sources.push(source.id);
        received = options.signal;
        started();
        return new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
        });
      },
      git: async () => { throw new Error('unexpected git probe'); },
    } };
    const controller = new TuiController(createTuiControllerDependencies(
      Object.assign(value.context, { catalogGenerationRuntime: runtime }),
    ));
    const preparing = controller.prepareScopedTask({ kind: 'recovery', command: 'sync',
      scope: 'user', selectors: ['local/demo', 'other/demo'], refresh: true });
    const rejected = expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    await ready;
    controller.cancelScopedPreparation();
    expect(received?.aborted).toBe(true);
    await rejected;
    expect(sources).toEqual(['local']);
    expect(await controller.cancelAndWaitForReads()).toBe(true);
    expect(await observeIntent({ ...value, scope: 'user' })).toEqual(beforeIntent);
    expect(await observePreferences({ ...value, scope: 'user' })).toEqual(beforePreferences);
    expect(await fs.pathExists(path.join(value.env.AW_HOME!, 'marketplaces', 'local'))).toBe(false);
    controller.dispose();
  });

  it('cancels Native preview before the next platform group starts', async () => {
    const value = await fixture();
    value.env.PATH = '';
    await createCodexNativeTestRuntime(getCurrentSourceTestIsolation());
    const beforeIntent = await observeIntent({ ...value, scope: 'user' });
    const beforePreferences = await observePreferences({ ...value, scope: 'user' });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const calls: NativeCliInvocation[] = [];
    value.context.nativeCliRunner = async (invocation) => {
      calls.push(invocation);
      if (invocation.args.includes('--version')) {
        return { exitCode: 0, stdout: 'codex-cli 0.200.0\n', stderr: '' };
      }
      started();
      return new Promise((_resolve, reject) => {
        invocation.signal?.addEventListener('abort', () => reject(invocation.signal!.reason), { once: true });
      });
    };
    const controller = new TuiController(createTuiControllerDependencies(value.context));
    const preparing = controller.prepareScopedTask({ kind: 'recovery', command: 'sync',
      scope: 'user', selectors: ['local/demo'], targets: ['codex', 'claude'] });
    await Promise.race([ready, preparing.then((result) => {
      throw new Error(JSON.stringify(result.kind === 'recovery' ? result.plan.receipt : result.kind));
    })]);
    const rejected = expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    controller.cancelScopedPreparation();
    await rejected;
    const reads = calls.filter((call) => !call.args.includes('--version'));
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read.args).toEqual(expect.arrayContaining(['plugin', 'list', '--marketplace', 'aw', '--json']));
      expect(read.signal?.aborted).toBe(true);
    }
    expect(calls.every((call) => call.agentKind === 'codex')).toBe(true);
    expect(await observeIntent({ ...value, scope: 'user' })).toEqual(beforeIntent);
    expect(await observePreferences({ ...value, scope: 'user' })).toEqual(beforePreferences);
    expect(await fs.pathExists(path.join(value.env.AW_HOME!, 'marketplaces/local'))).toBe(false);
    expect(await controller.cancelAndWaitForReads()).toBe(true);
    controller.dispose();
  });

  it('releases Native preparation cancellation before confirmed execution', async () => {
    const value = await fixture();
    value.env.PATH = '';
    const runtime = await createCodexNativeTestRuntime(getCurrentSourceTestIsolation());
    const preparation = new AbortController();
    const plan = await prepareRecovery('sync', ['local/demo'], {
      scope: 'user', cwd: value.cwd, env: value.env, cliVersion: '1.0.0',
      targets: ['codex'], signal: preparation.signal,
    }, runtime);
    try {
      preparation.abort();
      const receipt = await executeRecovery(plan, { yes: true });
      expect(receipt.ok).toBe(true);
      expect(runtime.installed.size).toBe(1);
    } finally { await plan.context.dispose(); }
  });

  it.each(['recovery', 'retire'] as const)('cancels a Portable directory read during %s preparation', async (kind) => {
    const value = await fixture(true);
    const beforeIntent = await observeIntent({ ...value, scope: 'user' });
    const beforePreferences = await observePreferences({ ...value, scope: 'user' });
    const outputRoot = path.join(value.env.HOME!, '.cursor', 'skills');
    await fs.ensureDir(outputRoot);
    let started!: () => void;
    let resume!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const readDirectory = fs.readdir.bind(fs);
    const read = vi.spyOn(fs, 'readdir').mockImplementation(async (root, options) => {
      if (path.resolve(String(root)) === outputRoot) { started(); await paused; }
      return readDirectory(root, options);
    });
    const controller = new TuiController(createTuiControllerDependencies(value.context));
    try {
      const outcome = controller.prepareScopedTask(kind === 'retire'
        ? { kind, scope: 'user', selector: 'local/removed', targets: ['cursor'] }
        : { kind, command: 'sync', scope: 'user', selectors: ['local/demo'], targets: ['cursor'] })
        .then(() => ({ state: 'prepared' }), (error: unknown) => ({ state: 'error',
          name: error instanceof Error ? error.name : 'unknown' }));
      await Promise.race([ready, outcome.then((result) => { throw new Error(JSON.stringify(result)); })]);
      controller.cancelScopedPreparation();
      resume();
      expect(await outcome).toEqual({ state: 'error', name: 'AbortError' });
      expect(await observeIntent({ ...value, scope: 'user' })).toEqual(beforeIntent);
      expect(await observePreferences({ ...value, scope: 'user' })).toEqual(beforePreferences);
      expect(await fs.pathExists(path.join(outputRoot, 'example'))).toBe(false);
      expect(await controller.cancelAndWaitForReads()).toBe(true);
    } finally { resume(); read.mockRestore(); controller.dispose(); }
  });

});
