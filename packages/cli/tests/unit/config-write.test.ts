import path from 'node:path';
import { execFileSync } from 'node:child_process';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compilePluginConfigDefinition, normalizePluginConfigDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import type { PluginMeta } from '../../src/types.js';
import { applyPluginConfig, applyPluginConfigWrite, disposePluginConfigApply, preparePluginConfigApply,
  resetPluginConfigWithHelper, resolveConfigPreApplyAuthorization } from '../../src/utils/plugin-config-write.js';
import { patchPluginConfigStore, readPluginConfigStore, resolveConfigRead,
  resolvePluginConfigStorePath, setAtomicConfigBeforeRenameHookForTests, toCliConfigPromptSchema,
  writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { analyzePluginConfigMutationImpact } from '../../src/utils/plugin-config-impact.js';
import { prepareManagedCommandPackage, publishPreparedManagedCommandPackage } from '../../src/utils/managed-command-materialization.js';
import { readManagedCommandPackage } from '../../src/utils/managed-command-store.js';
import { readManagedCommandRuntimeConfigSnapshot } from '../../src/utils/managed-command-snapshots.js';
import { defaultPluginProcessRunner } from '../../src/utils/plugin-scripts.js';
import { replaceCatalogSourcesConfig, readCatalogSourcesConfigSnapshot } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { resolveCatalogOperationContext } from '../../src/utils/catalog-operation-context.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';

function fixture(config: unknown = { schemaVersion: 5, fields: {
  mode: { type: 'string', default: 'safe' }, note: { type: 'string' }, enabled: { type: 'boolean', default: true },
  token: { type: 'string', sensitive: true },
} }) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const manifest: PluginMeta['manifest'] = {
    schemaVersion: 4, name: 'demo', version: '1.0.0', description: 'Config write fixture',
    marketplace: { category: 'test', strict: true, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' } },
    config: normalizePluginConfigDefinition(config),
  };
  const plugin: PluginMeta = { rootDir: path.join(cwd, 'plugin'), manifestPath: path.join(cwd, 'plugin/.agents-plugin/plugin.json'),
    sourceId: 'team', sourceIdentity: 'sha256:' + 'a'.repeat(64), catalogLogicalIdentity: 'fixture/catalog', pluginId: 'team/demo', manifest };
  const store = { pluginName: 'demo', sourceId: plugin.sourceId, sourceIdentity: plugin.sourceIdentity,
    scope: 'user' as const, cwd, env: isolation.env };
  const options = { plugin, scope: 'user' as const, cwd, env: isolation.env };
  return { plugin, store, options, cwd, env: isolation.env, file: resolvePluginConfigStorePath(store) };
}

afterEach(() => {
  setAtomicConfigBeforeRenameHookForTests(undefined);
  vi.restoreAllMocks();
});

describe('configuration saves and explicit apply', () => {
  // Test Value Gate: a save must commit desired values without discovering or changing an installation.
  it('saves by default and keeps sensitive values redacted in the receipt', async () => {
    const f = fixture();
    const run = vi.spyOn(defaultPluginProcessRunner, 'run');
    const saved = await applyPluginConfigWrite({ ...f.options, request: { updates: { mode: 'fast', token: 'private-token' } } });
    expect(saved).toMatchObject({ scope: 'user', context: 'user', configWrite: 'succeeded', overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'notRequested' } });
    expect(JSON.stringify(saved)).not.toContain('private-token');
    expect((await fs.readJson(f.file)).common).toEqual({ mode: 'fast', token: 'private-token' });
    expect(run).not.toHaveBeenCalled();
    expect(await fs.pathExists(path.join(f.cwd, '.agent-workflows'))).toBe(false);
  });

  // Test Value Gate: explicit project context changes the work boundary while every value remains in the user document.
  it.each(['common', 'codex', 'claude', 'generic'] as const)('stores %s values from project context only in AW_HOME', async (profile) => {
    const f = fixture();
    execFileSync('git', ['init', '-q'], { cwd: f.cwd });
    const platform = profile === 'common' ? undefined : profile;
    await applyPluginConfigWrite({ ...f.options, context: 'project', platform, request: { updates: { mode: profile } } });
    const document = await fs.readJson(f.file);
    expect(platform ? document.platforms[platform] : document.common).toEqual({ mode: profile });
    expect(await fs.pathExists(path.join(f.cwd, '.agent-workflows/plugin-config'))).toBe(false);
  });

  // Test Value Gate: validation failures must preserve strong config bytes and must not run renderer scripts.
  it.each([
    { updates: { enabled: 'invalid' }, removeKeys: [] },
    { updates: { unknown: true }, removeKeys: [] },
    { updates: { mode: 'fast' }, removeKeys: ['mode'] },
  ])('rejects invalid mutation $updates before committing', async (request) => {
    const f = fixture();
    await writePluginConfigStore({ ...f.store, values: { mode: 'safe' } });
    const before = await fs.readFile(f.file, 'utf8');
    const run = vi.spyOn(defaultPluginProcessRunner, 'run');
    await expect(applyPluginConfigWrite({ ...f.options, request })).rejects.toThrow();
    expect(await fs.readFile(f.file, 'utf8')).toBe(before);
    expect(run).not.toHaveBeenCalled();
  });

  // Test Value Gate: platform compilation, rather than public common fields, must control the accepted field type and preset.
  it('validates a platform replacement schema before saving', async () => {
    const f = fixture({ schemaVersion: 5, fields: { mode: { type: 'number', default: 1 } }, platforms: {
      codex: { fields: { mode: { type: 'string', choices: { allowCustom: false,
        presets: [{ id: 'native', title: 'Native', value: 'native' }] } } } },
    } });
    await expect(applyPluginConfigWrite({ ...f.options, platform: 'codex', request: { updates: { mode: 2 } } })).rejects.toThrow();
    expect(await fs.pathExists(f.file)).toBe(false);
    expect(await applyPluginConfigWrite({ ...f.options, platform: 'codex', request: { updates: { mode: 'native' } } }))
      .toMatchObject({ effective: { values: { mode: 'native' }, sources: { mode: 'platform' } } });
  });

  // Test Value Gate: ordinary saves allow incremental repair without turning unrelated existing failures into a permanent lockout.
  it('repairs one invalid field while preserving another invalid field', async () => {
    const f = fixture();
    await writePluginConfigStore({ ...f.store, values: { mode: 1, enabled: 'bad' } });
    const saved = await applyPluginConfigWrite({ ...f.options, request: { updates: { mode: 'repaired' } } });
    expect(saved.effective?.issues).toEqual([expect.objectContaining({ key: 'enabled' })]);
    expect((await readPluginConfigStore(f.store)).values).toEqual({ mode: 'repaired', enabled: 'bad' });
    expect(saved.apply).toMatchObject({ reason: 'notRequested' });
  });

  // Test Value Gate: whole-object equality must prevent unnecessary config rewrites and output refreshes.
  it('keeps bytes and mtime when a same-value object only reorders keys', async () => {
    const f = fixture({ schemaVersion: 5, fields: { value: { type: 'object', properties: {
      first: { type: 'string' }, second: { type: 'string' },
    }, additionalProperties: false } } });
    await writePluginConfigStore({ ...f.store, values: { value: { first: 'a', second: 'b' } } });
    const before = await fs.readFile(f.file, 'utf8');
    const stat = await fs.stat(f.file);
    const saved = await applyPluginConfigWrite({ ...f.options, apply: true, request: { updates: { value: { second: 'b', first: 'a' } } } });
    expect(saved).toMatchObject({ updatedKeys: [], apply: { state: 'skipped', reason: 'noConfigChange' } });
    expect(await fs.readFile(f.file, 'utf8')).toBe(before);
    expect((await fs.stat(f.file)).mtimeMs).toBe(stat.mtimeMs);
  });

  // Test Value Gate: renderer source identity is observable even when a newly stored value equals its default.
  it('counts a same-value default-to-common source change as effective impact', async () => {
    const f = fixture();
    f.plugin.manifest.artifacts = { configKeys: ['mode'], scopes: ['user'] };
    const target = { pluginName: 'demo', pluginId: 'team/demo', platform: 'codex' as const, scope: 'user' as const };
    const impact = await analyzePluginConfigMutationImpact({ ...f.options, visibleTargets: [target],
      commandDiscovery: { packages: [], errors: [] }, mutation: { kind: 'patch', updates: { mode: 'safe' } } });
    expect(impact).toMatchObject({ storeChanged: true, noEffectiveChange: false, affectedTargets: [target] });
  });

  // Test Value Gate: a common edit hidden by an explicit platform value must not refresh that platform.
  it('excludes a platform whose final value and source stay unchanged', async () => {
    const f = fixture();
    f.plugin.manifest.artifacts = { configKeys: ['mode'], scopes: ['user'] };
    await writePluginConfigStore({ ...f.store, platform: 'codex', values: { mode: 'native' } });
    const impact = await analyzePluginConfigMutationImpact({ ...f.options,
      visibleTargets: [{ pluginName: 'demo', platform: 'codex', scope: 'user' }], commandDiscovery: { packages: [], errors: [] },
      mutation: { kind: 'patch', updates: { mode: 'shared-next' } } });
    expect(impact).toMatchObject({ storeChanged: true, noEffectiveChange: true, affectedTargets: [] });
  });

  // Test Value Gate: shared user renderers in project context must be reviewed for affected platform inputs.
  it.each(['codex', 'copilot'] as const)('tracks complete %s shared render units', async (platform) => {
    const f = fixture();
    f.plugin.manifest.platforms = [platform];
    f.plugin.manifest.artifacts = { configKeys: ['mode'] };
    const run = vi.spyOn(defaultPluginProcessRunner, 'run');
    const target = { pluginName: 'demo', platform, scope: 'project' as const };
    const impact = await analyzePluginConfigMutationImpact({ ...f.options, context: 'project', visibleTargets: [target],
      commandDiscovery: { packages: [], errors: [] }, mutation: { kind: 'patch', updates: { mode: 'fast', note: 'enabled' } } });
    expect(impact.affectedTargets).toEqual([target]);
    expect(impact.sharedNativeRenderUnits).toEqual([{ pluginName: 'demo', platform, renderScope: 'user',
      configKeys: ['mode'], dynamicComponents: true }]);
    expect(run).not.toHaveBeenCalled();
  });

  // Test Value Gate: two Native platforms must not be widened into the Codex/Claude shorthand while preparing preApply authorization.
  it('keeps non-Codex Native preApply previews bound to their exact platforms', async () => {
    const f = fixture();
    f.plugin.manifest.scripts = { preApply: { path: './pre-apply.mjs' } };
    const targets = (['cursor', 'pi'] as const).map((platform) => ({ pluginName: 'demo', pluginId: 'team/demo', platform, scope: 'user' as const }));
    const preview = vi.fn(async (_names: string[], _options: unknown, runtime?: import('../../src/commands/rebuild-command.js').RebuildCommandRuntime) => ({
      overallState: 'succeeded' as const,
      preApplyAuthorization: runtime!.executionInput!.selectedTargets,
    } as import('../../src/commands/rebuild-command.js').RebuildCommandResult));
    const result = await resolveConfigPreApplyAuthorization({ ...f.options, applyTargets: targets, reinstallCommandImpl: preview });
    expect(result.availableApplyTargets).toEqual(targets);
    expect(result.unavailableTargetResults).toEqual([]);
    expect(preview.mock.calls.map(([, options]) => (options as { platform: string }).platform)).toEqual(['cursor', 'pi']);
    expect(result.targets.map(({ platform }) => platform)).toEqual(['cursor', 'pi']);
  });

  // Test Value Gate: unset can remove unknown stored keys while preserving all unrelated configuration and platform layers.
  it('removes a stale key without resetting the document', async () => {
    const f = fixture();
    await writePluginConfigStore({ ...f.store, values: { stale: true, mode: 'safe' } });
    await writePluginConfigStore({ ...f.store, platform: 'codex', values: { mode: 'native' } });
    const saved = await applyPluginConfigWrite({ ...f.options, request: { removeKeys: ['stale'] } });
    expect(saved).toMatchObject({ staleRemovedKeys: ['stale'], removedKeys: ['stale'] });
    expect(await fs.readJson(f.file)).toMatchObject({ common: { mode: 'safe' }, platforms: { codex: { mode: 'native' } } });
    await expect(applyPluginConfigWrite({ ...f.options, request: { removeKeys: ['unknown'] } })).rejects.toThrow('Unknown config key');
  });

  // Test Value Gate: required values can be added incrementally, but ordinary unset cannot create a new invalid configuration.
  it('rejects required unset and keeps explicit reset available', async () => {
    const f = fixture({ schemaVersion: 5, fields: { first: { type: 'string', required: true }, second: { type: 'string', required: true } } });
    await applyPluginConfigWrite({ ...f.options, request: { updates: { first: 'ready' } } });
    const before = await fs.readFile(f.file, 'utf8');
    await expect(applyPluginConfigWrite({ ...f.options, request: { removeKeys: ['first'] } })).rejects.toThrow('configReferenceInvalid');
    expect(await fs.readFile(f.file, 'utf8')).toBe(before);
    const reset = await resetPluginConfigWithHelper({ ...f.options, pluginName: 'demo' });
    expect(reset.configWrite).toBe('succeeded');
    expect(reset.effective?.issues.map((issue) => issue.key).sort()).toEqual(['first', 'second']);
  });

  // Test Value Gate: input strings have no implicit path or environment expansion contract.
  it('keeps submitted strings literal', async () => {
    const f = fixture();
    const literal = '~/private/$HOME/../certificate.pem';
    await applyPluginConfigWrite({ ...f.options, request: { updates: { note: literal } } });
    expect((await readPluginConfigStore(f.store)).values.note).toBe(literal);
  });

  // Test Value Gate: one AW_HOME lock must serialize complete read-modify-write saves for the same document.
  it('serializes concurrent saves without losing either field', async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const first = applyPluginConfigWrite({ ...f.options, reviewPreflight: async () => { entered(); await blocked; },
      request: { updates: { mode: 'first' } } });
    await started;
    const second = applyPluginConfigWrite({ ...f.options, request: { updates: { note: 'second' } } });
    release();
    await expect(first).resolves.toMatchObject({ configWrite: 'succeeded' });
    await expect(second).resolves.toMatchObject({ configWrite: 'succeeded' });
    expect((await readPluginConfigStore(f.store)).values).toEqual({ mode: 'first', note: 'second' });
  });

  // Test Value Gate: an atomic commit failure must report a failed write and preserve the previous strong document.
  it('marks a failed config commit and retains every existing profile', async () => {
    const f = fixture();
    await writePluginConfigStore({ ...f.store, values: { mode: 'before' } });
    await writePluginConfigStore({ ...f.store, platform: 'generic', values: { mode: 'portable' } });
    const before = await fs.readFile(f.file, 'utf8');
    setAtomicConfigBeforeRenameHookForTests(async () => { throw new Error('commit failed'); });
    await expect(applyPluginConfigWrite({ ...f.options, request: { updates: { mode: 'after' } } }))
      .rejects.toMatchObject({ configWrite: 'failed' });
    expect(await fs.readFile(f.file, 'utf8')).toBe(before);
  });

  // Test Value Gate: unavailable definitions must not cause schema-free ordinary writes or erase the last stale key.
  it('preserves stored values when ordinary write has no schema', async () => {
    const f = fixture();
    await writePluginConfigStore({ ...f.store, values: { stale: true } });
    const before = await fs.readFile(f.file, 'utf8');
    await expect(applyPluginConfigWrite({ pluginName: 'demo', plugin: null, scope: 'user', cwd: f.cwd, env: f.env,
      request: { removeKeys: ['stale'] } })).rejects.toThrow('configSchemaUnavailable');
    expect(await fs.readFile(f.file, 'utf8')).toBe(before);
  });

  // Test Value Gate: schema-independent reset remains available after the source disappears and distinguishes save from apply failure.
  it.each([false, true])('resets an unreadable document without a schema, apply=%s', async (apply) => {
    const f = fixture();
    await fs.outputFile(f.file, '{broken');
    const reset = await resetPluginConfigWithHelper({ pluginName: 'demo', sourceId: f.plugin.sourceId,
      scope: 'user', cwd: f.cwd, env: f.env, plugin: null, apply });
    expect(reset).toMatchObject({ configWrite: 'succeeded', resetDisposition: 'deletedFile',
      overallState: apply ? 'partial' : 'succeeded',
      apply: apply ? { state: 'unavailable', error: { code: 'sourceUnavailable' } } : { state: 'skipped', reason: 'notRequested' } });
    expect(await fs.pathExists(f.file)).toBe(false);
  });

  // Test Value Gate: the public field projection must retain missing values and schema-defined boolean presets.
  it('projects optional/required absence and closed boolean choices', async () => {
    const f = fixture({ schemaVersion: 5, fields: { optional: { type: 'string' }, required: { type: 'string', required: true },
      enabled: { type: 'boolean', choices: { allowCustom: false, presets: [{ id: 'off', title: 'Disabled', value: false }] } } } });
    const read = await resolveConfigRead({ ...f.options, pluginName: 'demo' });
    expect(read.fields.filter((field) => field.key !== 'enabled')).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'optional', value: null, source: 'missing', sourceLayer: null }),
      expect.objectContaining({ key: 'required', value: null, source: 'missing', sourceLayer: null }),
    ]));
    const prompts = toCliConfigPromptSchema(compilePluginConfigDefinition(f.plugin.manifest.config!).fields);
    expect(prompts.enabled?.enum).toEqual([false]);
  });
});

async function packageFixture(mode: 'static' | 'dynamic' = 'dynamic') {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const env = isolation.env;
  const sourceRoot = path.join(cwd, 'catalog');
  const pluginRoot = path.join(sourceRoot, 'plugins/demo');
  const renders = path.join(cwd, 'renders');
  await fs.outputFile(path.join(pluginRoot, 'tools/safe.mjs'), 'process.exit(0);\n');
  await fs.outputFile(path.join(pluginRoot, 'tools/fast.mjs'), 'process.exit(0);\n');
  await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
    "import fs from 'node:fs';",
    'const context = JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT, "utf8"));',
    'fs.appendFileSync(' + JSON.stringify(renders) + ', JSON.stringify(context.config.values) + "\\n");',
    'const mode = context.config.values.mode;',
    'const routes = { subcommands: mode === "empty" ? [] : [{ name: "check", runner: "node", entry: mode + ".mjs" }] };',
    'console.log(JSON.stringify({ version: 2, artifacts: [{ id: "command-routes", target: "aw.command-routes", kind: "commandRoutes", refreshKeys: ["mode"], routes }] }));',
  ].join('\n'));
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'Package config fixture\n', (manifest) => {
    manifest.platforms = ['codex', 'claude'];
    manifest.config = normalizePluginConfigDefinition({ schemaVersion: 5, fields: {
      mode: { type: 'string', default: 'safe' },
      runtime: { type: 'string', default: 'default' },
      unrelated: { type: 'string', default: 'initial' },
    } });
    const base = { sourceDir: './tools', platforms: ['codex', 'claude'] as const, runtimeConfig: { keys: ['runtime'] } };
    manifest.command = mode === 'dynamic' ? { ...base, platforms: [...base.platforms], mode, refreshKeys: ['mode'] }
      : { ...base, platforms: [...base.platforms], mode, routes: {
        subcommands: [{ name: 'check', runner: 'node', entry: 'safe.mjs', args: [], cwd: 'caller' }],
      } };
    if (mode === 'dynamic') manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
  });
  const snapshot = await readCatalogSourcesConfigSnapshot(env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] },
    expectedDigest: snapshot.digest, env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env });
  const operation = await resolveCatalogOperationContext({ sourceIds: ['team'], env });
  const source = operation.catalog.sources[0]!.resolution!;
  const loaded = await readPluginManifest(path.join(source.rootDir, 'plugins/demo'), { mode: 'bundle' });
  const plugin: PluginMeta = { ...loaded, sourceId: source.sourceId, sourceIdentity: source.sourceIdentity,
    catalogLogicalIdentity: source.logicalIdentity, pluginId: 'team/demo' };
  const producer = { sourceId: source.sourceId, sourceIdentity: source.sourceIdentity, pluginName: 'demo' };
  const store = { ...producer, logicalIdentity: source.logicalIdentity, scope: 'user' as const, cwd, env };
  const options = { plugin, scope: 'user' as const, cwd, env, cliVersion: '1.0.0' };
  const sync = async () => {
    const candidate = await prepareManagedCommandPackage({ ...options, operation: { kind: 'explicit-sync' } });
    try { return await publishPreparedManagedCommandPackage({ ...options, candidate }); }
    finally { await candidate.cleanup(); }
  };
  const installed = async () => (await readManagedCommandPackage(producer, env))!;
  const values = async (platform: 'codex' | 'claude') => {
    const current = await installed();
    return (await readManagedCommandRuntimeConfigSnapshot(current.resourceRoot, current.record, platform)).effectiveValues;
  };
  const countRenders = async () => (await fs.readFile(renders, 'utf8')).trim().split('\n').length;
  return { cwd, env, plugin, store, options, sync, installed, values, countRenders };
}

describe('existing command package apply', () => {
  // Test Value Gate: common package-only apply refreshes the existing package exactly once without creating Intent.
  it('reviews and applies one shared route update without rerendering', async () => {
    const f = await packageFixture();
    await f.sync();
    await applyPluginConfigWrite({ ...f.options, request: { updates: { mode: 'fast' } } });
    expect(await f.countRenders()).toBe(1);
    const reviewed = await preparePluginConfigApply(f.options);
    expect(reviewed.commandPackageReviews).toMatchObject([{
      routeChanges: ['codex', 'claude'].map((platform) => ({
        argv: ['aw', 'command', 'run', `team/demo/${platform}`, '--', 'check'],
        before: { entry: 'safe.mjs' }, after: { entry: 'fast.mjs' },
      })),
      otherProjects: 'unobserved',
    }]);
    await disposePluginConfigApply(reviewed.plan);
    const applied = await applyPluginConfig({ ...f.options, expectedEvidence: reviewed.evidence });
    expect(applied).toMatchObject({ configWrite: 'notStarted', apply: { state: 'succeeded', targetResults: [],
      commandResults: [{ selector: 'team/demo', action: 'updated', availability: 'ready',
        subcommands: ['check'], hasFallback: false, state: 'completed' }] } });
    expect((await f.installed()).record.routes.subcommands[0]?.entry).toBe('fast.mjs');
    expect(await f.countRenders()).toBe(2);
    expect(await fs.pathExists(path.join(f.env.AW_HOME!, 'intent.json'))).toBe(false);
  });

  // Test Value Gate: applying one platform cannot render a pending common route or publish another platform's queued override.
  it('updates only the requested platform snapshot', async () => {
    const f = await packageFixture();
    await f.sync();
    await patchPluginConfigStore({ ...f.store, updates: { mode: 'fast' } });
    await patchPluginConfigStore({ ...f.store, platform: 'claude', updates: { runtime: 'claude-pending' } });
    const saved = await applyPluginConfigWrite({ ...f.options, platform: 'codex', apply: true, request: { updates: { runtime: 'codex-now' } } });
    expect(saved.apply).toMatchObject({ state: 'succeeded', commandResults: [{ state: 'completed' }] });
    expect(await f.values('codex')).toEqual({ runtime: 'codex-now' });
    expect(await f.values('claude')).toEqual({ runtime: 'default' });
    expect((await f.installed()).record.routes.subcommands[0]?.entry).toBe('safe.mjs');
    expect(await f.countRenders()).toBe(1);
  });

  // Test Value Gate: common snapshot Review must disclose saved platform overrides when applying them together.
  it('reviews all affected platform snapshots, including a pending override, before publishing', async () => {
    const f = await packageFixture('static');
    await f.sync();
    await patchPluginConfigStore({ ...f.store, platform: 'claude', updates: { runtime: 'claude-pending' } });
    await patchPluginConfigStore({ ...f.store, updates: { unrelated: 'irrelevant' } });
    expect((await applyPluginConfig(f.options)).apply).toMatchObject({ state: 'succeeded', commandResults: [] });
    expect(await f.values('claude')).toEqual({ runtime: 'default' });
    await patchPluginConfigStore({ ...f.store, updates: { runtime: 'common-now' } });
    const reviewed = await preparePluginConfigApply(f.options);
    expect(reviewed.commandPackageReviews).toMatchObject([{ runtimeConfigChanges: [
      { platform: 'codex', before: { runtime: 'default' }, after: { runtime: 'common-now' } },
      { platform: 'claude', before: { runtime: 'default' }, after: { runtime: 'claude-pending' } },
    ] }]);
    await disposePluginConfigApply(reviewed.plan);
    expect((await applyPluginConfig({ ...f.options, expectedEvidence: reviewed.evidence })).apply.state).toBe('succeeded');
    expect(await f.values('claude')).toEqual({ runtime: 'claude-pending' });
    expect(await f.values('codex')).toEqual({ runtime: 'common-now' });
  });

  // Test Value Gate: Review binds approved config and route inputs. A stale review cannot rerender, publish or rewrite the Store.
  it('preserves old output and the currently saved config when the reviewed inputs drift', async () => {
    const f = await packageFixture();
    await f.sync();
    await patchPluginConfigStore({ ...f.store, updates: { mode: 'fast' } });
    const reviewed = await preparePluginConfigApply(f.options);
    await disposePluginConfigApply(reviewed.plan);
    await patchPluginConfigStore({ ...f.store, updates: { mode: 'empty' } });
    const file = resolvePluginConfigStorePath(f.store);
    const before = await fs.readFile(file);
    const renders = await f.countRenders();
    expect(await applyPluginConfig({ ...f.options, expectedEvidence: reviewed.evidence })).toMatchObject({
      configWrite: 'notStarted', apply: { state: 'unavailable', error: { code: 'operationReviewStale' } },
    });
    expect(await f.countRenders()).toBe(renders);
    expect(await fs.readFile(file)).toEqual(before);
    expect((await f.installed()).record.routes.subcommands[0]?.entry).toBe('safe.mjs');
  });

  // Test Value Gate: approvals can start matching a new route between Review and publication.
  it('binds user-scope Review to user permissions and excludes project settings', async () => {
    const f = await packageFixture();
    await fs.ensureDir(path.join(f.cwd, '.git'));
    await f.sync();
    await patchPluginConfigStore({ ...f.store, updates: { mode: 'fast' } });
    const rules = { permissions: { allow: ['Bash(aw command run team/demo/claude -- check *)'] } };
    await fs.outputJson(path.join(f.cwd, '.claude/settings.local.json'), rules);
    const reviewed = await preparePluginConfigApply(f.options);
    expect(reviewed.commandPackageReviews).toMatchObject([{ affectedPermissions: [] }]);
    await disposePluginConfigApply(reviewed.plan);
    const renders = await f.countRenders();
    await fs.outputJson(path.join(f.env.AW_CLAUDE_HOME!, 'settings.json'), rules);
    expect(await applyPluginConfig({ ...f.options, expectedEvidence: reviewed.evidence })).toMatchObject({
      configWrite: 'notStarted', apply: { state: 'unavailable', error: { code: 'operationReviewStale' } },
    });
    expect(await f.countRenders()).toBe(renders);
    expect((await f.installed()).record.routes.subcommands[0]?.entry).toBe('safe.mjs');
  });

  // Test Value Gate: a disappeared reviewed package must block a combined mutation before the Store commit.
  it('rejects a reviewed save-and-apply when the command package is removed', async () => {
    const f = await packageFixture();
    await f.sync();
    const request = { updates: { mode: 'fast' } };
    const reviewed = await preparePluginConfigApply({ ...f.options, mutation: { kind: 'patch', ...request } });
    await disposePluginConfigApply(reviewed.plan);
    expect(reviewed.commandPackageEvidence).toHaveLength(1);
    const installed = await f.installed();
    await fs.move(path.resolve(installed.resourceRoot, '../..'), path.join(f.cwd, 'detached-package'));
    await expect(applyPluginConfigWrite({ ...f.options, apply: true, request,
      expectedCommandPackageEvidence: reviewed.commandPackageEvidence })).rejects.toMatchObject({ code: 'operationReviewStale' });
    expect((await readPluginConfigStore(f.store)).exists).toBe(false);
  });

  // Test Value Gate: a damaged owner marker reports discovery failure after saving and preserves existing output.
  it('keeps the saved value and old output after command ownership discovery fails', async () => {
    const f = await packageFixture();
    await f.sync();
    const { resourceRoot } = await f.installed();
    await fs.writeFile(path.resolve(resourceRoot, '../../owner.json'), '{broken');
    const saved = await applyPluginConfigWrite({ ...f.options, apply: true, request: { updates: { mode: 'fast' } } });
    expect(saved).toMatchObject({ configWrite: 'succeeded', overallState: 'partial',
      apply: { state: 'partial', errors: [expect.objectContaining({ stage: 'targetDiscovery' })] } });
    expect((await readPluginConfigStore(f.store)).values.mode).toBe('fast');
    expect(await fs.pathExists(resourceRoot)).toBe(true);
  });

  // Test Value Gate: a failed renderer must preserve a successful config save and the previously published revision.
  it('keeps the applied package after the saved config selects an invalid entry', async () => {
    const f = await packageFixture();
    await f.sync();
    const old = await f.installed();
    const saved = await applyPluginConfigWrite({ ...f.options, apply: true, request: { updates: { mode: 'missing-entry' } } });
    expect(saved).toMatchObject({ configWrite: 'succeeded', overallState: 'partial',
      apply: { state: 'partial', commandResults: [{ state: 'failed' }] } });
    expect((await readPluginConfigStore(f.store)).values.mode).toBe('missing-entry');
    expect((await f.installed()).resourceRoot).toBe(old.resourceRoot);
  });
});
