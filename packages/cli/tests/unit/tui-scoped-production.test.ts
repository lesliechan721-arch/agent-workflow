import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { addRoot, observeIntent } from '../../src/intent/intent-store.js';
import { observePreferences, writePreferences } from '../../src/intent/deployment-preferences.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration, type CatalogGenerationServiceRuntime } from '../../src/utils/catalog-generation-service.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import { createAwPluginRequirementsReceipt, readPluginManifest } from '../../src/utils/manifest.js';
import { readCatalogSnapshotLogicalIdentity } from '../../src/utils/catalog-generation-store.js';
import { createCatalogSnapshotFixture, git } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

async function fixture(portable = false) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = path.join(isolation.layout.fixtureCwd, 'project');
  const source = path.join(isolation.layout.fixtureCwd, 'catalog');
  const env = isolation.env;
  await fs.ensureDir(cwd);
  await git(cwd, ['init', '--quiet']);
  const generation = async (version: string) => {
    for (const platform of ['codex', 'claude', 'agent-skills', '']) {
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
        manifest.distributions = { agentSkills: { skills: './agent-skills/skills' } };
      } else {
        manifest.skills = './skills';
      }
      manifest.config = { fields: {
        greeting: { type: 'string', default: `Schema ${version}` },
      } };
    };
    await createCatalogSnapshotFixture(source, 'demo', [], `Content ${version}`, configure);
    const manifest = await fs.readJson(path.join(source, 'plugins/demo/.agents-plugin/plugin.json'));
    for (const platform of ['codex', 'claude', 'agent-skills']) {
      await fs.outputJson(path.join(source, 'plugins/demo', platform, 'skills/example/aw-plugin-requirements.json'),
        createAwPluginRequirementsReceipt({ name: 'demo', version }, manifest.requires.aw.capabilities));
    }
    await createCatalogSnapshotFixture(source, 'demo', [], `Content ${version}`, configure);
    await fs.outputJson(path.join(source, 'plugins/demo/codex/.app.json'), { apps: {} });
    for (const platform of ['codex', 'claude']) {
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
    await writePreferences({ scope, cwd, env }, { schemaVersion: 1, kind: 'aw-deployment-preferences',
      agents: ['codex'], dependencyScopeOverrides: [] });
  }
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
      const config = await controller.getConfigPage('local/demo', { scope: 'user' });
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
      expect(await controller.getConfigPage('local/demo', { scope: 'user' })).toEqual(config);
      await controller.load();
      await controller.refreshScopedInventory(scope);
      await controller.loadPluginContent('local/demo');
      expect(controller.getPluginContentOverview('local/demo')?.pluginVersion).toBe('2.0.0');
      expect(controller.getPluginContentOverview('local/demo')?.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ description: 'Content 2.0.0' }),
      ]));
      expect(await controller.getConfigPage('local/demo', { scope: 'user' })).not.toEqual(config);
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
    const beforeIntent = await observeIntent({ ...value, scope: 'user' });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let received: AbortSignal | undefined;
    const calls: string[] = [];
    value.context.nativeCliRunner = async (invocation) => {
      calls.push(invocation.command);
      received = invocation.signal;
      started();
      return new Promise((_resolve, reject) => {
        invocation.signal?.addEventListener('abort', () => reject(invocation.signal!.reason), { once: true });
      });
    };
    const controller = new TuiController(createTuiControllerDependencies(value.context));
    const preparing = controller.prepareScopedTask({ kind: 'recovery', command: 'install',
      scope: 'user', selectors: ['local/demo'], targets: ['codex', 'claude-code'] });
    await Promise.race([ready, preparing.then((result) => {
      throw new Error(JSON.stringify(result.kind === 'recovery' ? result.plan.receipt : result.kind));
    })]);
    const rejected = expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    controller.cancelScopedPreparation();
    expect(received?.aborted).toBe(true);
    await rejected;
    expect(calls).toEqual(['codex']);
    expect(await observeIntent({ ...value, scope: 'user' })).toEqual(beforeIntent);
    expect(await fs.pathExists(path.join(value.env.AW_HOME!, 'marketplaces/local'))).toBe(false);
    controller.dispose();
  });

  it.each(['recovery', 'retire'] as const)('cancels the actual Portable probe during %s preparation', async (kind) => {
    const value = await fixture(true);
    const beforeIntent = await observeIntent({ ...value, scope: 'user' });
    const beforePreferences = await observePreferences({ ...value, scope: 'user' });
    const bin = path.join(value.cwd, 'bin');
    const log = path.join(bin, 'calls.jsonl');
    const stopped = path.join(bin, 'stopped');
    await fs.outputFile(path.join(bin, 'skills'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(stopped)}, 'cancelled'); process.exit(0); });
setTimeout(() => process.exit(2), 5000);
`);
    await fs.chmod(path.join(bin, 'skills'), 0o755);
    value.context.env = { ...value.env, PATH: `${bin}${path.delimiter}${value.env.PATH}` };
    const controller = new TuiController(createTuiControllerDependencies(value.context));
    const preparing = controller.prepareScopedTask(kind === 'retire'
      ? { kind, scope: 'user', selector: 'local/removed', targets: ['cursor'] }
      : { kind, command: 'sync', scope: 'user', selectors: ['local/demo'], targets: ['cursor'] });
    const rejected = expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(async () => expect(await fs.pathExists(log)).toBe(true));
    controller.cancelScopedPreparation();
    await rejected;
    await vi.waitFor(async () => expect(await fs.pathExists(stopped)).toBe(true));
    expect((await fs.readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)))
      .toEqual([['--version']]);
    expect(await observeIntent({ ...value, scope: 'user' })).toEqual(beforeIntent);
    expect(await observePreferences({ ...value, scope: 'user' })).toEqual(beforePreferences);
    expect(await fs.pathExists(path.join(value.env.HOME!, '.agents/skills/example'))).toBe(false);
    expect(await controller.cancelAndWaitForReads()).toBe(true);
    controller.dispose();
  });
});
