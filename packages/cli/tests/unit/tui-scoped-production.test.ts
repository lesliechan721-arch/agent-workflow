import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { addRoot, observeIntent, removeRoot } from '../../src/intent/intent-store.js';
import { observePreferences, writePreferences } from '../../src/intent/deployment-preferences.js';
import { executeRecovery, prepareRecovery } from '../../src/recovery/coordinator.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration, type CatalogGenerationServiceRuntime } from '../../src/utils/catalog-generation-service.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { readCatalogSnapshotLogicalIdentity } from '../../src/utils/catalog-generation-store.js';
import { applyCodexConfigTransactionFile, readCodexConfigFile, removeCodexMarketplace } from '../../src/utils/codex-config.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { getAgentPluginAdapter } from '../../src/platforms/registry.js';
import { getPlatformCapabilities } from '../../src/platforms/capabilities.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(portable = false, dependency = false) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = path.join(isolation.layout.fixtureCwd, 'project');
  const source = path.join(isolation.layout.fixtureCwd, 'catalog');
  const env = isolation.env;
  env.PATH = '';
  await fs.ensureDir(cwd);
  await git(cwd, ['init', '--quiet']);
  const generation = async (version: string) => {
    await fs.outputFile(path.join(source, 'plugins/demo/skills/example/SKILL.md'),
      `---\nname: example\ndescription: Content ${version}\n---\nContent ${version}\n`);
    await fs.outputFile(path.join(source, 'plugins/demo/skills/example/README.md'), `Content ${version}`);
    const configure: NonNullable<Parameters<typeof createCatalogSnapshotFixture>[4]> = (manifest) => {
      manifest.version = version;
      if (dependency) manifest.dependencies = ['dependency'];

      if (portable) {
        manifest.skills = './skills';
        manifest.platforms = ['generic'];
      } else {
        manifest.skills = './skills';
        manifest.platforms = ['codex', 'claude'];
      }
      manifest.config = { fields: {
        greeting: { type: 'string', default: `Schema ${version}` },
      } };
    };
    await createCatalogSnapshotFixture(source, 'demo', [], `Content ${version}`, configure);
    if (dependency) {
      const marketplacePath = path.join(source, '.agents/plugins/marketplace.json');
      const claudeMarketplacePath = path.join(source, '.claude-plugin/marketplace.json');
      const marketplace = await fs.readJson(marketplacePath);
      const claudeMarketplace = await fs.readJson(claudeMarketplacePath);
      await fs.outputFile(path.join(source, 'plugins/dependency/skills/example/SKILL.md'), `---\nname: example\ndescription: Dependency ${version}\n---\nDependency ${version}\n`);
      await createCatalogSnapshotFixture(source, 'dependency', [], 'Dependency', (manifest) => {
        manifest.version = version;
        manifest.platforms = ['codex', 'claude'];
        manifest.skills = './skills';
      });
      const dependencyMarketplace = await fs.readJson(marketplacePath);
      const dependencyClaudeMarketplace = await fs.readJson(claudeMarketplacePath);
      await fs.writeJson(marketplacePath, { ...marketplace,
        plugins: [...marketplace.plugins, ...dependencyMarketplace.plugins] });
      await fs.writeJson(claudeMarketplacePath, { ...claudeMarketplace,
        plugins: [...claudeMarketplace.plugins, ...dependencyClaudeMarketplace.plugins] });
    }
    for (const name of dependency ? ['demo', 'dependency'] : ['demo']) {
      const manifest = await fs.readJson(path.join(source, `plugins/${name}/.agents-plugin/plugin.json`));
      for (const platform of portable ? ['generic'] : ['codex', 'claude']) {
        await fs.outputJson(path.join(source, `plugins/${name}`, platform, 'skills/example/aw-plugin-requirements.json'),
          createAwPluginRequirementsReceipt({ name, version }, manifest.requires.aw.capabilities));
      }
    }
    const catalogPath = path.join(source, 'catalog-manifest.json');
    await fs.writeJson(catalogPath, { ...await fs.readJson(catalogPath), entries: [
      await createCatalogManifestV7Entry(await readPluginManifest(path.join(source, 'plugins/demo'), { mode: 'bundle' }),
        path.join(source, 'plugins/demo')),
      ...(dependency ? [await createCatalogManifestV7Entry(await readPluginManifest(
        path.join(source, 'plugins/dependency'), { mode: 'bundle' }), path.join(source, 'plugins/dependency'))] : []),
    ] });
    await syncCatalogSourceGeneration({ sourceId: 'local', env, cliVersion: '1.0.0', impactConfirmed: true });
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
  await writePreferences({ scope: 'user', cwd, env }, { schemaVersion: 2, kind: 'aw-deployment-preferences',
    targets: [portable ? 'generic' : 'codex'], exclusions: [] });
  const context = createCliExecutionContext({ cwd, env, interactive: false,
    nativeCliRunner: async (invocation) => ({ exitCode: 0, stderr: '',
      stdout: invocation.args.includes('--version') ? 'codex-cli 0.167.0\n' : '[]' }),
  });
  return { cwd, env, source, generation, context };
}

describe('scoped TUI production reads', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.spyOn(getAgentPluginAdapter('codex'), 'capabilities').mockImplementation((input) => {
      const capabilities = getPlatformCapabilities(input);
      capabilities.kinds.skill = { ...capabilities.kinds.skill, status: 'supported', reasonCodes: [] };
      return capabilities;
    });
  });
  // Test Value Gate: an exact root removal must retain the reviewed dependency cleanup after the last declaration is removed.
  it('removes an exact last Native root and deactivates its orphan dependency while preserving shared packages', async () => {
    const value = await fixture(false, true);
    await removeRoot({ ...value, scope: 'project' }, 'local/demo');
    const otherIntent = await observeIntent({ ...value, scope: 'project' });
    const runtime = await createCodexNativeTestRuntime(getCurrentSourceTestIsolation());
    value.context.nativeCliRunner = runtime.nativeCliRunner;
    const dependencies = createTuiControllerDependencies(value.context);
    const initial = await dependencies.prepareScopedTask!({ kind: 'recovery', command: 'sync',
      scope: 'user', selectors: ['local/demo'], targets: ['codex'] }, new AbortController().signal);
    try {
      const receipt = await dependencies.executeScopedTask!(initial);
      expect(receipt, JSON.stringify(receipt)).toMatchObject({ kind: 'recovery', receipt: { ok: true } });
      expect(runtime.installed.size).toBe(2);
    } finally { if (initial.kind === 'recovery') await initial.plan.context.dispose(); }
    const installedIds = [...runtime.installed.keys()];
    const configPath = path.join(value.env.CODEX_HOME!, 'config.toml');
    const beforeConfig = await readCodexConfigFile(configPath);
    expect(installedIds.map((id) => beforeConfig.snapshot.plugins[id]?.enabled)).toEqual([true, true]);
    const plan = await dependencies.prepareScopedTask!({ kind: 'recovery', command: 'uninstall',
      scope: 'user', selectors: ['local/demo'], targets: ['codex'],
      exactTargets: [{ pluginId: 'local/demo', agent: 'codex' }] }, new AbortController().signal);
    try {
      if (plan.kind !== 'recovery') throw new Error('Expected a recovery Review.');
      expect(plan.plan.blockExecution).toBe(false);
      expect(plan.plan.receipt.blockers).toEqual([]);
      expect(plan.plan.receipt.errors).toEqual([]);
      expect(plan.plan.dependencyCleanupTargets).toEqual([
        { pluginId: 'local/dependency', agent: 'codex', scope: 'user' },
      ]);
      const removed = await dependencies.executeScopedTask!(plan);
      expect(removed, JSON.stringify(removed)).toMatchObject({ kind: 'recovery', receipt: {
        ok: true, declarationChanged: true, allSatisfied: true, inSync: true,
        targetResults: expect.arrayContaining([
          expect.objectContaining({ pluginId: 'local/demo', agent: 'codex', execution: 'applied' }),
          expect.objectContaining({ pluginId: 'local/dependency', agent: 'codex', execution: 'applied' }),
        ]),
      } });
      if (removed.kind !== 'recovery') throw new Error('Expected recovery execution.');
      const receipts = removed.receipt.targetResults.flatMap((target) => target.deploymentReceipts ?? []);
      expect(receipts).toHaveLength(2);
      for (const receipt of receipts) {
        expect(receipt.diagnostics).toContainEqual(expect.objectContaining({ code: 'sharedReferenceUnknown' }));
        expect(receipt.after).toMatchObject({ package: 'present', registration: 'present',
          consumers: [expect.objectContaining({ activation: 'disabled' })] });
      }
      const afterConfig = await readCodexConfigFile(configPath);
      expect(installedIds.map((id) => afterConfig.snapshot.plugins[id]?.enabled)).toEqual([false, false]);
      expect([...runtime.installed.keys()]).toEqual(installedIds);
      expect(await observeIntent({ ...value, scope: 'user' })).toMatchObject({ state: 'valid', value: { roots: [] } });
      expect(await observeIntent({ ...value, scope: 'project' })).toEqual(otherIntent);
    } finally { if (plan.kind === 'recovery') await plan.plan.context.dispose(); }
  });

  // Test Value Gate: updating an installed dependency must not add it as an Intent root.
  it('updates an exact dependency target without changing either scope declaration', async () => {
    const value = await fixture(false, true);
    const runtime = await createCodexNativeTestRuntime(getCurrentSourceTestIsolation());
    value.context.nativeCliRunner = runtime.nativeCliRunner;
    const dependencies = createTuiControllerDependencies(value.context);
    const initial = await dependencies.prepareScopedTask!({ kind: 'recovery', command: 'sync',
      scope: 'user', selectors: ['local/demo'], targets: ['codex'] }, new AbortController().signal);
    const installed = await dependencies.executeScopedTask!(initial);
    expect(installed, JSON.stringify(installed)).toMatchObject({ kind: 'recovery', receipt: { ok: true } });
    if (initial.kind === 'recovery') await initial.plan.context.dispose();
    await value.generation('2.0.0');
    const beforeUser = await observeIntent({ ...value, scope: 'user' });
    const beforeProject = await observeIntent({ ...value, scope: 'project' });
    const plan = await dependencies.prepareScopedTask!({ kind: 'recovery', command: 'reinstall',
      scope: 'user', selectors: ['local/dependency'], targets: ['codex'],
      exactTargets: [{ pluginId: 'local/dependency', agent: 'codex' }],
      allowDependencySelectors: true }, new AbortController().signal);
    try {
      if (plan.kind !== 'recovery') throw new Error('Expected a recovery Review.');
      expect(plan.plan.blockExecution).toBe(false);
      expect(plan.plan.receipt.blockers).toEqual([]);
      expect(plan.plan.plannedImpact.declaration).toBe(false);
      expect(plan.plan.receipt.requestedTargets).toContainEqual(expect.objectContaining({
        pluginId: 'local/dependency', agent: 'codex', scope: 'user' }));
      expect(await dependencies.executeScopedTask!(plan)).toMatchObject({ kind: 'recovery',
        receipt: { ok: true, declarationChanged: false } });
      expect([...runtime.installed.values()]).toContain('2.0.0');
      expect(await observeIntent({ ...value, scope: 'user' })).toEqual(beforeUser);
      expect(await observeIntent({ ...value, scope: 'project' })).toEqual(beforeProject);
    } finally { if (plan.kind === 'recovery') await plan.plan.context.dispose(); }
  });

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
    expect(await fs.pathExists(path.join(value.env.AW_HOME!, 'platforms', 'codex'))).toBe(false);
    controller.dispose();
  });

  it('cancels Native preview before the next platform group starts', async () => {
    const value = await fixture();
    value.env.PATH = '';
    await createCodexNativeTestRuntime(getCurrentSourceTestIsolation());
    await fs.outputFile(path.join(value.env.PATH!, 'claude'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const beforeIntent = await observeIntent({ ...value, scope: 'user' });
    const beforePreferences = await observePreferences({ ...value, scope: 'user' });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const calls: NativeCliInvocation[] = [];
    value.context.nativeCliRunner = async (invocation) => {
      calls.push(invocation);
      if (invocation.args.includes('--version')) {
        return { exitCode: 0, stdout: 'codex-cli 0.167.0\n', stderr: '' };
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
      expect(read.args.slice(read.args.indexOf('plugin'))).toEqual(['plugin', 'list', '--marketplace', expect.stringMatching(/^aw-local-[a-f0-9]{12}$/u), '--json']);
      expect(read.signal?.aborted).toBe(true);
    }
    expect(calls.every((call) => /codex/u.test(call.command) || call.args.some((arg) => /codex/u.test(arg)))).toBe(true);
    expect(await observeIntent({ ...value, scope: 'user' })).toEqual(beforeIntent);
    expect(await observePreferences({ ...value, scope: 'user' })).toEqual(beforePreferences);
    expect(await fs.pathExists(path.join(value.env.AW_HOME!, 'platforms', 'codex'))).toBe(false);
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
      expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
      expect(runtime.installed.size).toBe(1);
    } finally { await plan.context.dispose(); }
  });

  it.each(['recovery', 'retire'] as const)('cancels a Portable directory read during %s preparation', async (kind) => {
    const value = await fixture(true);
    const beforeIntent = await observeIntent({ ...value, scope: 'user' });
    const beforePreferences = await observePreferences({ ...value, scope: 'user' });
    const outputRoot = path.join(value.env.HOME!, '.agents', 'skills');
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
        ? { kind, scope: 'user', selector: 'local/removed', targets: ['generic'] }
        : { kind, command: 'sync', scope: 'user', selectors: ['local/demo'], targets: ['generic'] })
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

/** Simulate the public Codex CLI while AW writes the real canonical payload. */
async function createCodexNativeTestRuntime(
  isolation: { env: NodeJS.ProcessEnv; layout: { fixtureCwd: string } },
  options: { rejectAdd?: (pluginId: string) => boolean } = {},
) {
  const prefixRoot = path.join(isolation.layout.fixtureCwd, 'codex-native-prefix');
  const binRoot = process.platform === 'win32' ? prefixRoot : path.join(prefixRoot, 'bin');
  {
    const packageRoot = path.join(process.platform === 'win32' ? binRoot : path.join(prefixRoot, 'lib'), 'node_modules/@openai/codex');
    await fs.outputJson(path.join(packageRoot, 'package.json'), {
      name: '@openai/codex', version: '0.167.0', bin: { codex: 'bin/codex.js' },
    });
    await fs.outputFile(path.join(packageRoot, 'bin/codex.js'), '// Native calls use the injected runner.\n');
    if (process.platform === 'win32') await fs.outputFile(path.join(binRoot, 'codex.cmd'), '@echo off\r\n');
    else { await fs.ensureDir(binRoot); await fs.chmod(path.join(packageRoot, 'bin/codex.js'), 0o755); await fs.symlink(path.join(packageRoot, 'bin/codex.js'), path.join(binRoot, 'codex')); }
  }
  for (const key of Object.keys(isolation.env)) if (key.toLowerCase() === 'path') delete isolation.env[key];
  isolation.env.PATH = binRoot;
  const installed = new Map<string, string>();
  const marketplaces = new Map<string, string>();
  const configPath = path.join(isolation.env.CODEX_HOME!, 'config.toml');
  const nativeCliRunner = vi.fn(async (invocation: NativeCliInvocation) => {
    if (invocation.args.includes('--version')) return { exitCode: 0, stdout: 'codex-cli 0.167.0', stderr: '' };
    const index = invocation.args.indexOf('plugin');
    const args = index < 0 ? invocation.args : invocation.args.slice(index);
    if (args[1] === 'marketplace' && args[2] === 'add') {
      const root = args[3]!;
      const { marketplaceName } = await fs.readJson(path.join(root, 'config.json'));
      marketplaces.set(marketplaceName, root);
      const current = await fs.readFile(configPath, 'utf8').catch(() => '');
      if (!(await readCodexConfigFile(configPath)).snapshot.marketplaces[marketplaceName]) {
        await fs.outputFile(configPath, [current, `[marketplaces.${JSON.stringify(marketplaceName)}]`,
          `source = ${JSON.stringify(root)}`, 'source_type = "local"', ''].join('\n'));
      }
    } else if (args[1] === 'marketplace' && args[2] === 'remove') {
      marketplaces.delete(args[3]!);
      await fs.outputFile(configPath, removeCodexMarketplace(await fs.readFile(configPath, 'utf8'), args[3]!));
    } else if (args[1] === 'add') {
      const pluginId = args[2]!;
      if (options.rejectAdd?.(pluginId)) return { exitCode: 1, stdout: '', stderr: 'injected native add failure' };
      const separator = pluginId.lastIndexOf('@');
      const root = marketplaces.get(pluginId.slice(separator + 1));
      if (!root) throw new Error(`Unregistered fixture marketplace: ${pluginId}`);
      const manifest = await fs.readJson(path.join(root, 'plugins', pluginId.slice(0, separator), '.codex-plugin/plugin.json'));
      installed.set(pluginId, manifest.version);
      await applyCodexConfigTransactionFile(configPath, { upsertPluginActivations: { [pluginId]: true } });
    } else if (args[1] === 'remove') {
      installed.delete(args[2]!);
      await applyCodexConfigTransactionFile(configPath, { removePluginActivations: [args[2]!] });
    }
    if (args[1] === 'list' && args.includes('--json')) {
      const [user, project] = await Promise.all([
        readCodexConfigFile(configPath),
        readCodexConfigFile(path.join(invocation.cwd!, '.codex/config.toml')),
      ]);
      const marketplace = args[args.indexOf('--marketplace') + 1];
      return { exitCode: 0, stdout: JSON.stringify({ installed: [...installed]
        .filter(([id]) => id.endsWith(`@${marketplace}`)).map(([pluginId, version]) => ({
          pluginId, installed: true, version,
          enabled: project.snapshot.plugins[pluginId]?.enabled ?? user.snapshot.plugins[pluginId]?.enabled ?? false,
        })), available: [] }), stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
  return { nativeCliRunner, installed, marketplaces };
}
