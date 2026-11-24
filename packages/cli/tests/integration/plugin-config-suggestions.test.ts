import path from 'node:path';
import { Readable } from 'node:stream';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { runCli } from '../../src/index.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { TuiController } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { withResolvedCatalogPlugin } from '../../src/utils/multi-source-catalog.js';
import { resolvePluginConfigStorePath } from '../../src/utils/plugin-config.js';
import { preparePluginConfigSuggestions } from '../../src/utils/plugin-config-suggestions.js';
import { createCapturedCliIo } from '../helpers/cli-entry.js';
import { createDependencyCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const providerId = 'team/provider';
const consumerId = 'team/consumer';
const config = ['plugin', 'config'];
const futureSecret = 'future-fixture-secret';

async function fixture() {
  const { env, layout } = getCurrentSourceTestIsolation();
  const cwd = layout.fixtureCwd;
  const root = path.join(cwd, 'catalog');
  await fs.outputFile(path.join(root, 'plugins/provider/scripts/suggestions.mjs'), `
let wire = '';
for await (const bytes of process.stdin) wire += bytes;
const request = JSON.parse(wire);
if ('token' in request.providerConfigValues || 'secret' in request.dependencyValues) throw Error('Sensitive input');
if ('inventory' in request.providerConfigValues && !Array.isArray(request.providerConfigValues.inventory)) throw Error('Invalid saved input');
if (request.provider === 'slow') await new Promise(resolve => setTimeout(resolve, 60_000));
if (request.provider === 'unsupported' || request.provider === 'unavailable') {
  console.log(JSON.stringify({ schemaVersion: 1, status: request.provider, items: [],
    diagnostics: [{ code: 'providerState', message: 'Provider status.' }] }));
} else if (request.provider === 'unsupported-quiet') {
  console.log(JSON.stringify({ schemaVersion: 1, status: 'unsupported', message: 'No probe for this platform.',
    items: [{ value: 'discarded', title: 'Discarded candidate' }] }));
} else if (request.provider === 'for-cache') {
  const token = ${JSON.stringify(futureSecret)};
  console.log(JSON.stringify({ schemaVersion: 1, status: 'ok',
    message: 'Cached marker ' + token, diagnostics: [{ code: token, message: token }],
    items: [{ value: token, title: 'Marker candidate', recommended: true },
      { value: 'visible', title: 'Known model ' + token, description: token, recommended: true }] }));
} else {
  const { label = 'unset' } = request.providerConfigValues;
  const { 'engine-id': engine = 'none' } = request.dependencyValues;
  const parts = [request.platform ?? '<common>', label, engine];
  if (request.fieldPath[0] === 'profile') {
    const working = request.providerConfigValues.profile?.models?.[request.fieldPath[2]] ?? {};
    if ('secret' in working || 'model-id' in working) throw Error('Invalid draft input');
    parts.push(working['engine-id'] ?? 'unset');
  }
  const value = parts.join(' / ');
  console.log(JSON.stringify({ schemaVersion: 1, status: 'ok', items: [{ value, title: value }] }));
}
`);
  await createDependencyCatalogSnapshotFixture(root, [
    { name: 'provider', configureManifest(manifest) {
      manifest.scripts = { config: { suggestions: { runner: 'node', path: './scripts/suggestions.mjs' } } };
      manifest.config = { schemaVersion: 5, fields: {
        label: { type: 'string', default: 'common-label' }, token: { type: 'string', sensitive: true },
        inventory: { type: 'array', validation: { uniqueBy: 'id' }, items: {
          type: 'object', properties: { id: { type: 'string', required: true } },
        }, default: [{ id: 'fixture-model' }] },
        self: { type: 'string', suggestions: { provider: 'same' } },
        narrow: { type: 'string', validation: { pattern: '^accept-only-this$', maxLength: 256 }, suggestions: { provider: 'same' } },
        cache: { type: 'string', suggestions: { provider: 'for-cache' } },
        profile: { type: 'object', properties: {
          mode: { type: 'string', required: true }, requiredLabel: { type: 'string', required: true },
        }, variants: { discriminator: 'mode', cases: { active: { properties: {
          models: { type: 'array', items: { type: 'object', properties: {
            'engine-id': { type: 'string' },
            'model-id': { type: 'string', required: true, suggestions: { provider: 'models', dependsOn: ['engine-id'] } },
          } } },
        } } } } },
      }, platforms: { codex: { fields: { label: { type: 'string', default: 'codex-label' } } } } };
    } },
    { name: 'consumer', dependencies: ['provider'], configureManifest(manifest) {
      manifest.config = { schemaVersion: 5, fields: {
        workers: { type: 'array', items: { type: 'object', properties: {
          models: { type: 'array', items: { type: 'object', properties: {
            'engine-id': { type: 'string' },
            'model-id': { type: 'string', suggestions: { plugin: 'provider', provider: 'models', dependsOn: ['engine-id'] } },
          } } },
        } }, default: [{ models: [{ 'engine-id': 'default-engine' }, { 'engine-id': 'second-engine' }] }] },
        selected: { type: 'string', default: 'fixture-model', valueRef: { plugin: 'provider', field: 'inventory', key: 'id' } },
        token: { type: 'string', sensitive: true },
        cache: { type: 'string', suggestions: { plugin: 'provider', provider: 'for-cache' } },
        ordinary: { type: 'number' },
        skipped: { type: 'string', suggestions: { plugin: 'provider', provider: 'unsupported' } },
        skippedQuiet: { type: 'string', suggestions: { plugin: 'provider', provider: 'unsupported-quiet' } },
        failed: { type: 'string', suggestions: { plugin: 'provider', provider: 'unavailable' } },
        slow: { type: 'string', suggestions: { plugin: 'provider', provider: 'slow' } },
      } };
    } },
  ]);
  const previous = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ env, expectedDigest: previous.digest, config: {
    schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: root }],
  } });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  const invoke = async (args: string[], input?: string) => {
    const captured = createCapturedCliIo();
    const exitCode = await runCli([...config, ...args, '--json'], { cwd, env, io: captured.io, interactive: false,
      ...(input === undefined ? {} : { stdin: Readable.from([input]) }),
    });
    const stdout = captured.readStdout();
    return { exitCode, data: JSON.parse(stdout), stdout, stderr: captured.readStderr() };
  };
  const store = (pluginName: string) => resolvePluginConfigStorePath({ sourceId: 'team', pluginName, scope: 'user', cwd, env });
  return { run: (...args: string[]) => invoke(args),
    saveSecret: (value: string, pluginId = providerId) => invoke(['set', pluginId, 'token', '--value-stdin'], value), store, cwd, env };
}

describe('plugin config suggestions', () => {
  it('queries an uninstalled same-source provider using selection and saved dependency values', async () => {
    const { run, store, saveSecret } = await fixture();
    const personal = await saveSecret('fixture-development-secret');
    expect(personal.exitCode, personal.stdout).toBe(0);
    const providerStore = await fs.readFile(store('provider'), 'utf8');
    const field = 'workers.0.models.1.model-id';
    const result = await run('suggestions', consumerId, field, '--platform', 'codex');
    expect(result, result.stdout).toMatchObject({ exitCode: 0, data: { schemaVersion: 2,
      command: 'plugin.config.suggestions', status: 'success', diagnostics: [], data: {
        pluginId: consumerId, providerPluginId: providerId, provider: 'models', profile: 'codex', fieldPath: ['workers', 0, 'models', 1, 'model-id'],
        status: 'ok', items: [{ value: 'codex / codex-label / second-engine', title: 'codex / codex-label / second-engine' }],
      } } });
    const unindexed = await run('suggestions', consumerId, 'workers.0.models.model-id');
    expect(unindexed, unindexed.stdout).toMatchObject({ exitCode: 0, data: { data: {
      fieldPath: ['workers', 0, 'models', 'model-id'], items: [{ value: '<common> / common-label / none' }],
    } } });
    const outerUnindexed = await run('suggestions', consumerId, 'workers.models.1.model-id');
    expect(outerUnindexed, outerUnindexed.stdout).toMatchObject({ exitCode: 0, data: { data: {
      fieldPath: ['workers', 'models', 1, 'model-id'], items: [{ value: '<common> / common-label / none' }],
    } } });
    const overridden = await run('suggestions', consumerId, 'workers.models.model-id', '--dep', 'engine-id=custom=one');
    expect(overridden, overridden.stdout).toMatchObject({ exitCode: 0, data: { data: {
      profile: 'common', fieldPath: ['workers', 'models', 'model-id'], items: [{ value: '<common> / common-label / custom=one' }],
    } } });
    expect(await fs.readFile(store('provider'), 'utf8')).toBe(providerStore);
    expect(await fs.pathExists(store('consumer'))).toBe(false);
    expect(result.stdout).not.toContain('fixture-development-secret');
    expect(overridden.stdout).not.toContain('fixture-development-secret');
    const schema = await run('schema', consumerId);
    expect(schema.data.data.fields.workers.items.properties.models.items.properties['model-id'].suggestions)
      .toEqual({ plugin: 'provider', provider: 'models', dependsOn: ['engine-id'] });
    expect(await run('suggestions', providerId, 'narrow')).toMatchObject({
      exitCode: 0, data: { data: { status: 'ok', items: [] } },
    });
  });

  it('distinguishes argument errors, unsupported providers, unavailable providers, and timeouts', async () => {
    const { run } = await fixture();
    const query = (field: string, ...options: string[]) => run('suggestions', consumerId, field, ...options);
    for (const [field, options] of [
      ['ordinary', []], ['workers..models.model-id', []], ['workers.models.model-id', ['--dep', 'missing=yes']],
      ['workers.models.model-id', ['--dep', 'engine-id=x', '--dep', 'engine-id=x']], ['skipped', ['--timeout-ms', '999']],
      ...['1e3', '0x3e8', '1000.0', ' 1000 ', '30001'].map((value) => ['skipped', ['--timeout-ms', value]] as const),
      ['skipped', ['--platform', 'unknown']], ['skipped', ['--dep', 'engine']],
    ] as const) {
      const result = await query(field, ...options);
      expect(result, result.stdout).toMatchObject({ exitCode: 2, data: {
        status: 'failed', diagnostics: [{ code: 'invalidArguments', severity: 'error' }],
      } });
      expect(result.data.data).toEqual({});
    }
    for (const [field, status, exitCode, severity] of [
      ['skipped', 'unsupported', 0, 'warning'], ['failed', 'unavailable', 1, 'error'],
    ] as const) {
      const result = await query(field);
      expect(result, result.stdout).toMatchObject({ exitCode, data: {
        status: exitCode === 0 ? 'success' : 'failed',
        data: { status, items: [], diagnostics: [{ code: 'providerState', message: 'Provider status.' }] },
        diagnostics: [{ code: 'providerState', severity, subject: { pluginId: providerId, field } }],
      } });
    }
    const skippedQuiet = await query('skippedQuiet');
    expect(skippedQuiet, skippedQuiet.stdout).toMatchObject({ exitCode: 0, stderr: '', data: {
      status: 'success', diagnostics: [], data: { status: 'unsupported', items: [], message: 'No probe for this platform.' },
    } });
    const timeout = await query('slow', '--timeout-ms', '1000');
    expect(timeout, timeout.stdout).toMatchObject({ exitCode: 1, data: {
      status: 'failed', data: { status: 'unavailable', items: [] },
      diagnostics: [{ code: 'configSuggestionsTimeout', severity: 'error', subject: { pluginId: providerId, field: 'slow' } }],
    } });
  });

  it('uses legal same-plugin drafts even when the saved document is invalid', async () => {
    const { cwd, env, store } = await fixture();
    await fs.outputFile(store('provider'), 'invalid JSON');
    const [first, nested] = await withResolvedCatalogPlugin({ selector: providerId, cliVersion: '1.0.0', env, consume: async ({ plugin }) => {
      const prepare = (label: string) => preparePluginConfigSuggestions({
        plugin, fieldPath: ['self'], context: 'user', cwd, env,
        draftValues: { label, token: 'private-draft-token' },
      });
      const left = await prepare('draft-label');
      const right = await prepare('other-label');
      expect(left.cacheKey).not.toBe(right.cacheKey);
      const narrow = await preparePluginConfigSuggestions({
        plugin, fieldPath: ['narrow'], context: 'user', cwd, env, draftValues: { label: 'draft-label' },
      });
      expect(narrow.cacheKey).toBe(left.cacheKey);
      const cached = await narrow.run();
      expect(narrow.project(cached).items).toEqual([]);
      expect(left.project(cached).items).toEqual(cached.items);
      const edits = await preparePluginConfigSuggestions({
        plugin, fieldPath: ['profile', 'models', 1, 'model-id'], context: 'user', cwd, env,
        draftValues: {
          label: 'draft-label', token: 'private-draft-token', profile: { mode: 'active', models: [
            { 'engine-id': 'first-engine', 'model-id': 'first-model' },
            { 'engine-id': 'draft-engine', 'model-id': 42, secret: 'unknown-draft-token' },
          ] },
        },
      });
      return [cached, await edits.run()] as const;
    } });
    expect(first).toMatchObject({ status: 'ok', items: [{ value: '<common> / draft-label / none' }] });
    expect(nested).toMatchObject({ status: 'ok', items: [{ value: '<common> / draft-label / draft-engine / draft-engine' }] });
    expect(await fs.readFile(store('provider'), 'utf8')).toBe('invalid JSON');
  });

  it('retains valid provider values when another saved field is invalid', async () => {
    const { run, store } = await fixture();
    const saved = await run('set', providerId, 'label', '--value-json', JSON.stringify('saved-label'));
    expect(saved.exitCode, saved.stdout).toBe(0);
    const file = store('provider');
    const document = await fs.readJson(file);
    document.common.inventory = 'invalid-for-array';
    await fs.writeJson(file, document);
    const self = await run('suggestions', providerId, 'self');
    expect(self, self.stdout).toMatchObject({ exitCode: 0, data: { data: {
      items: [{ value: '<common> / saved-label / none' }],
    } } });
    const crossPlugin = await run('suggestions', consumerId, 'workers.0.models.0.model-id');
    expect(crossPlugin, crossPlugin.stdout).toMatchObject({ exitCode: 0, data: { data: {
      items: [{ value: '<common> / saved-label / default-engine' }],
    } } });
    expect(await fs.readJson(file)).toEqual(document);
  });

  it.each(['invalid JSON', 'directory'])('uses empty provider values for a %s store also used by a valueRef', async (damage) => {
    const { run, store } = await fixture();
    const file = store('provider');
    if (damage === 'directory') await fs.ensureDir(file);
    else await fs.outputFile(file, damage);
    const crossPlugin = await run('suggestions', consumerId, 'workers.0.models.0.model-id');
    expect(crossPlugin, crossPlugin.stdout).toMatchObject({ exitCode: 0, data: { data: {
      items: [{ value: '<common> / unset / default-engine' }],
    } } });
    const self = await run('suggestions', providerId, 'self');
    expect(self, self.stdout).toMatchObject({ exitCode: 0, data: { data: {
      items: [{ value: '<common> / unset / none' }],
    } } });
    if (damage === 'directory') expect((await fs.lstat(file)).isDirectory()).toBe(true);
    else expect(await fs.readFile(file, 'utf8')).toBe(damage);
  });

  it('redacts newly sensitive values and text when the TUI reuses a successful suggestion response', async () => {
    const { cwd, env, run, saveSecret } = await fixture();
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({ cwd, env, interactive: false }));
    const original = dependencies.getConfigSuggestions!;
    let launches = 0;
    dependencies.getConfigSuggestions = (lookup, use, signal) => original(lookup, (prepared) => use({
      ...prepared,
      run: (runSignal) => {
        launches++;
        return prepared.run(runSignal);
      },
    }), signal);
    const controller = new TuiController(dependencies);
    const query = (pluginId: string) => controller.getConfigSuggestions({ pluginId, options: {}, fieldPath: ['cache'] },
      false, new AbortController().signal);
    try {
      const first = await query(providerId);
      expect(first.items.map(({ value }) => value)).toEqual([futureSecret, 'visible']);
      expect(first.items.map(({ recommended }) => recommended)).toEqual([true, false]);
      const saved = await saveSecret(futureSecret, consumerId);
      expect(saved.exitCode, saved.stdout).toBe(0);
      const cached = await query(consumerId);
      expect(cached.items).toMatchObject([{ value: 'visible', recommended: true }]);
      expect(cached.diagnostics).toEqual([{ code: 'configSuggestionsProviderDiagnostic', message: '[REDACTED]' }]);
      expect(JSON.stringify(cached)).not.toContain(futureSecret);
      expect(await query(providerId)).toEqual(cached);
      expect(launches).toBe(1);
      const fresh = await run('suggestions', consumerId, 'cache');
      expect(fresh, fresh.stdout).toMatchObject({ exitCode: 0, data: { data: {
        status: 'ok', items: [{ value: 'visible' }],
      } } });
      expect(fresh.stdout).not.toContain(futureSecret);
    } finally {
      controller.dispose();
    }
  });
});
