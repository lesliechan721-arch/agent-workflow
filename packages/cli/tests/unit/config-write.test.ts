import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compilePluginConfigDefinition, normalizePluginConfigDefinition } from '@lesliechan721/aw-plugin-core/manifest';

import type { PluginMeta } from '../../src/types.js';
import { applyPluginConfig, applyPluginConfigWrite, disposePluginConfigApply, preparePluginConfigApply,
  resetPluginConfigWithHelper } from '../../src/utils/plugin-config-write.js';
import { patchPluginConfigStore, readPluginConfigStore, resolveConfigRead,
  resolvePluginConfigStorePath, setAtomicConfigBeforeRenameHookForTests, toCliConfigPromptSchema,
  writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { analyzePluginConfigMutationImpact } from '../../src/utils/plugin-config-impact.js';
import { syncPluginManagedCommandPackage } from '../../src/utils/managed-command-materialization.js';
import { listManagedCommandPackages } from '../../src/utils/managed-command-store.js';
import { createDefaultPluginProcessRunner, defaultPluginProcessRunner, type PluginScriptInvocation } from '../../src/utils/plugin-scripts.js';
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
    schemaVersion: 3, name: 'demo', version: '1.0.0', description: 'Config write fixture',
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
    f.plugin.manifest.artifacts = { targets: [{ id: 'mode', platform: 'codex',
      target: 'codex.developerInstructionsBlock', scopes: ['user'], states: ['present'], refreshKeys: ['mode'] }] };
    const target = { pluginName: 'demo', pluginId: 'team/demo', platform: 'codex' as const, scope: 'user' as const };
    const impact = await analyzePluginConfigMutationImpact({ ...f.options, visibleTargets: [target],
      commandDiscovery: { packages: [], errors: [] }, mutation: { kind: 'patch', updates: { mode: 'safe' } } });
    expect(impact).toMatchObject({ storeChanged: true, noEffectiveChange: false, affectedTargets: [target] });
  });

  // Test Value Gate: a common edit hidden by an explicit platform value must not refresh that platform.
  it('excludes a platform whose final value and source stay unchanged', async () => {
    const f = fixture();
    f.plugin.manifest.artifacts = { targets: [{ id: 'mode', platform: 'codex',
      target: 'codex.developerInstructionsBlock', scopes: ['user'], states: ['present'], refreshKeys: ['mode'] }] };
    await writePluginConfigStore({ ...f.store, platform: 'codex', values: { mode: 'native' } });
    const impact = await analyzePluginConfigMutationImpact({ ...f.options,
      visibleTargets: [{ pluginName: 'demo', platform: 'codex', scope: 'user' }], commandDiscovery: { packages: [], errors: [] },
      mutation: { kind: 'patch', updates: { mode: 'shared-next' } } });
    expect(impact).toMatchObject({ storeChanged: true, noEffectiveChange: true, affectedTargets: [] });
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

async function packageFixture(options: { second?: boolean; project?: boolean } = {}) {
  const isolation = getCurrentSourceTestIsolation();
  const cwd = isolation.layout.fixtureCwd;
  const env = isolation.env;
  if (options.project) execFileSync('git', ['init', '-q'], { cwd });
  const sourceRoot = path.join(cwd, 'catalog');
  const pluginRoot = path.join(sourceRoot, 'plugins/demo');
  const renders = path.join(cwd, 'renders');
  await fs.outputFile(path.join(pluginRoot, 'tools/tool.mjs'), 'process.exit(0);\n');
  await fs.outputFile(path.join(pluginRoot, 'render.mjs'), [
    "import fs from 'node:fs';",
    'const context=JSON.parse(fs.readFileSync(process.env.AW_PLUGIN_CONTEXT,"utf8"));',
    'fs.appendFileSync(' + JSON.stringify(renders) + ',JSON.stringify({event:context.event,keys:context.changedConfigKeys,cwd:process.cwd()})+"\\n");',
    'console.log(JSON.stringify({version:2,artifacts:context.requestedArtifactIds.map(id=>({id,target:"aw.command-package",kind:"commandPackage",state:"present",refreshKeys:["mode"],files:{"config.json":JSON.stringify({mode:context.config.values.mode,source:context.config.sources.mode})}}))}));',
  ].join('\n'));
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'Package config fixture\n', (manifest) => {
    manifest.platforms = ['codex', 'claude'];
    manifest.config = normalizePluginConfigDefinition({ schemaVersion: 5, fields: {
      mode: { type: 'string', default: 'safe' }, token: { type: 'string', sensitive: true },
    } });
    manifest.scripts = { artifacts: { render: { runner: 'node', path: './render.mjs' } } };
    manifest.managedCommands = { packages: [
      { key: 'personal', scope: 'user', platforms: ['codex', 'claude'], sourceDir: './tools', render: true, refreshKeys: ['mode'] },
      { key: 'uninstalled', scope: 'user', platforms: ['codex', 'claude'], sourceDir: './tools', render: true, refreshKeys: ['mode'] },
      ...(options.second ? [{ key: 'another', scope: 'user' as const, platforms: ['codex' as const, 'claude' as const], sourceDir: './tools', render: true, refreshKeys: ['mode'] }] : []),
      ...(options.project ? [{ key: 'workspace', scope: 'project' as const, platforms: ['codex' as const, 'claude' as const], sourceDir: './tools', render: true, refreshKeys: ['mode'] }] : []),
    ], sets: [] };
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
  const store = { sourceId: source.sourceId, sourceIdentity: source.sourceIdentity, logicalIdentity: source.logicalIdentity,
    pluginName: 'demo', scope: 'user' as const, cwd, env };
  const applyOptions = { plugin, scope: 'user' as const, context: 'user' as const, cwd, env, cliVersion: '1.0.0' };
  const sync = (key: string, scope: 'user' | 'project' = 'user') => syncPluginManagedCommandPackage({ plugin, packageKey: key, scope, cwd, env });
  return { cwd, env, plugin, store, renders, options: applyOptions, sync };
}

describe('existing command package apply', () => {
  // Test Value Gate: package-only apply must work without Intent and cannot install a declaration that has no existing output.
  it('refreshes one existing common package and leaves Intent and missing packages unchanged', async () => {
    const f = await packageFixture();
    expect(await f.sync('personal')).toMatchObject({ state: 'completed' });
    const inventory = await listManagedCommandPackages(f.env);
    const resource = inventory.packages[0]!.resourceRoot;
    await fs.remove(f.renders);
    const saved = await applyPluginConfigWrite({ ...f.options, apply: true, request: { updates: { mode: 'fast' } } });
    expect(saved).toMatchObject({ configWrite: 'succeeded', apply: { state: 'succeeded', targetResults: [],
      commandResults: [{ producer: { key: 'personal', platform: null }, state: 'completed' }] } });
    expect(await fs.readJson(path.join(resource, 'config.json'))).toEqual({ mode: 'fast', source: 'common' });
    expect((await listManagedCommandPackages(f.env)).packages.map((entry) => entry.producer.key)).toEqual(['personal']);
    expect((await fs.readFile(f.renders, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(await fs.pathExists(path.join(f.env.AW_HOME!, 'intent.json'))).toBe(false);
  });

  // Test Value Gate: a platform override must never alter a platform-null producer's common values or run its renderer.
  it('keeps common command packages unchanged after a platform-only save and apply', async () => {
    const f = await packageFixture();
    await f.sync('personal');
    const before = await fs.readFile(f.renders, 'utf8');
    const saved = await applyPluginConfigWrite({ ...f.options, platform: 'codex', apply: true, request: { updates: { mode: 'native' } } });
    expect(saved.apply).toMatchObject({ state: 'skipped', reason: 'noVisibleTarget' });
    expect(await fs.readFile(f.renders, 'utf8')).toBe(before);
    const installed = (await listManagedCommandPackages(f.env)).packages[0]!;
    expect(await fs.readJson(path.join(installed.resourceRoot, 'config.json'))).toEqual({ mode: 'safe', source: 'default' });
  });

  // Test Value Gate: Review must bind installed producer and current config evidence, and retry apply must not resave config.
  it('rejects stale Review, then accepts a fresh independent apply without writing the Store', async () => {
    const f = await packageFixture();
    await f.sync('personal');
    await applyPluginConfigWrite({ ...f.options, request: { updates: { mode: 'saved' } } });
    const reviewed = await preparePluginConfigApply(f.options);
    const evidence = structuredClone(reviewed.evidence);
    expect(reviewed.commandPackages).toHaveLength(1);
    await disposePluginConfigApply(reviewed.plan);
    await patchPluginConfigStore({ ...f.store, updates: { mode: 'newer' } });
    const file = resolvePluginConfigStorePath(f.store);
    const before = await fs.readFile(file, 'utf8');
    const stat = await fs.stat(file);
    const rendersBefore = await fs.readFile(f.renders, 'utf8');
    const stale = await applyPluginConfig({ ...f.options, expectedEvidence: evidence });
    expect(stale).toMatchObject({ configWrite: 'notStarted', apply: { state: 'unavailable', error: { code: 'operationPlanStale' } } });
    expect(await fs.readFile(f.renders, 'utf8')).toBe(rendersBefore);
    const current = await preparePluginConfigApply(f.options);
    const currentEvidence = structuredClone(current.evidence);
    await disposePluginConfigApply(current.plan);
    expect(await applyPluginConfig({ ...f.options, expectedEvidence: currentEvidence }))
      .toMatchObject({ configWrite: 'notStarted', apply: { state: 'succeeded' } });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    expect((await fs.stat(file)).mtimeMs).toBe(stat.mtimeMs);
  });

  // Test Value Gate: a damaged ownership marker must report apply discovery failure after a valid save and must retain the output.
  it('keeps the saved value and old output after command ownership discovery fails', async () => {
    const f = await packageFixture();
    await f.sync('personal');
    const installed = (await listManagedCommandPackages(f.env)).packages[0]!;
    const output = await fs.readFile(path.join(installed.resourceRoot, 'config.json'));
    await fs.writeFile(path.join(path.dirname(installed.resourceRoot), 'owner.json'), '{broken');
    const saved = await applyPluginConfigWrite({ ...f.options, apply: true, request: { updates: { mode: 'committed' } } });
    expect(saved).toMatchObject({ configWrite: 'succeeded', overallState: 'partial',
      apply: { state: 'partial', errors: [expect.objectContaining({ stage: 'targetDiscovery' })] } });
    expect((await readPluginConfigStore(f.store)).values.mode).toBe('committed');
    expect(await fs.readFile(path.join(installed.resourceRoot, 'config.json'))).toEqual(output);
  });

  // Test Value Gate: project apply may refresh user and current-project packages, while user-only apply is cwd-neutral.
  it('refreshes user and current-project packages and keeps user render execution outside the repo', async () => {
    const f = await packageFixture({ project: true });
    await f.sync('personal');
    await f.sync('workspace', 'project');
    await fs.remove(f.renders);
    const saved = await applyPluginConfigWrite({ ...f.options, context: 'project', apply: true, request: { updates: { mode: 'joint' } } });
    expect(saved).toMatchObject({ configWrite: 'succeeded', apply: { state: 'succeeded' } });
    if (saved.apply.state !== 'succeeded') throw new Error('Expected a successful package apply.');
    expect(saved.apply.commandResults?.map((entry) => entry.producer.scope).sort()).toEqual(['project', 'user']);
    const records = (await fs.readFile(f.renders, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0].cwd).not.toBe(f.cwd);
    expect(records[1].cwd).toBe(await fs.realpath(f.cwd));
  });

  // Test Value Gate: exact package Review selection must not widen to an unreviewed installed producer.
  it('executes only reviewed package IDs', async () => {
    const f = await packageFixture({ second: true });
    await f.sync('personal');
    await f.sync('another');
    const packages = (await listManagedCommandPackages(f.env)).packages;
    const selected = packages.find((entry) => entry.producer.key === 'personal')!;
    const unselected = packages.find((entry) => entry.producer.key === 'another')!;
    await applyPluginConfigWrite({ ...f.options, request: { updates: { mode: 'selected' } } });
    await fs.remove(f.renders);
    const applied = await applyPluginConfig({ ...f.options, applyCommandPackages: [selected.id] });
    expect(applied).toMatchObject({ apply: { state: 'succeeded', commandResults: [{ producer: { key: 'personal' } }] } });
    expect(await fs.readJson(path.join(unselected.resourceRoot, 'config.json'))).toEqual({ mode: 'safe', source: 'default' });
    expect((await fs.readFile(f.renders, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  // Test Value Gate: cancellation and unconfirmed process cleanup must stop later producers; ordinary renderer failure remains partial.
  it.each(['cancel', 'cleanup', 'ordinary'] as const)('preserves committed config and %s renderer failure semantics', async (mode) => {
    const f = await packageFixture({ second: true });
    const secret = 'private-renderer-token';
    await writePluginConfigStore({ ...f.store, values: { token: secret } });
    const renderSuccess = async (invocation: PluginScriptInvocation) => {
      const context = await fs.readJson(invocation.env.AW_PLUGIN_CONTEXT!);
      return { exitCode: 0, signal: null, timedOut: false, stderr: '', stdout: JSON.stringify({ version: 2,
        artifacts: context.requestedArtifactIds.map((id: string) => ({ id, target: 'aw.command-package', kind: 'commandPackage',
          state: 'present', refreshKeys: ['mode'], files: { 'config.json': JSON.stringify({ mode: context.config.values.mode }) } })) }) };
    };
    const run = vi.spyOn(defaultPluginProcessRunner, 'run').mockImplementation(renderSuccess);
    for (const key of ['personal', 'another']) expect(await f.sync(key)).toMatchObject({ state: 'completed' });
    run.mockClear();
    const controller = new AbortController();
    const failure = mode === 'cancel' ? new DOMException('package refresh cancelled', 'AbortError')
      : new Error('Process tree cleanup unconfirmed: ' + f.cwd + ' ' + secret);
    const child = Object.assign(new EventEmitter(), { pid: 321, exitCode: 0, signalCode: null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    const cleanupRunner = createDefaultPluginProcessRunner({ platform: 'linux',
      spawn: (() => { queueMicrotask(() => child.emit('exit', 0, null)); return child; }) as unknown as typeof import('node:child_process').spawn,
      observeProcessTree: () => ({ pid: 321, onFailure: () => () => undefined, dispose: () => undefined }),
      terminateProcessTree: async () => { throw failure; } });
    const contexts: Array<{ event: string; changedConfigKeys: string[] }> = [];
    run.mockImplementation(async (invocation, options) => {
      contexts.push(await fs.readJson(invocation.env.AW_PLUGIN_CONTEXT!));
      if (contexts.length > 1) return renderSuccess(invocation);
      if (mode === 'cancel') { controller.abort(failure); throw failure; }
      if (mode === 'cleanup') return cleanupRunner.run(invocation, options);
      throw new Error('ordinary renderer preparation failure ' + secret);
    });
    const result = await applyPluginConfigWrite({ ...f.options, apply: true, request: { updates: { mode: 'committed' } },
      rebuildRuntime: { signal: controller.signal, scriptTimeoutMs: 1234 } })
      .then((receipt) => ({ receipt }), (error: unknown) => ({ error }));
    expect(run.mock.calls[0]?.[1]).toMatchObject({ signal: controller.signal, timeoutMs: 1234 });
    expect(contexts[0]).toMatchObject({ event: 'refresh', changedConfigKeys: ['mode'] });
    if (mode === 'ordinary') {
      expect(run).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ receipt: { configWrite: 'succeeded', apply: { state: 'partial',
        commandResults: [expect.objectContaining({ state: 'failed' }), expect.objectContaining({ state: 'completed' })] } } });
      expect(JSON.stringify(result)).not.toContain(secret);
    } else {
      expect(run).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ error: { configWrite: 'succeeded',
        ...(mode === 'cleanup' ? { operationDiagnostic: { code: 'pluginProcessCleanupFailed' } } : { message: 'package refresh cancelled' }) } });
      if ('error' in result) {
        expect((result.error as Error).message).not.toContain(f.cwd);
        expect((result.error as Error).message).not.toContain(secret);
      }
    }
    expect((await readPluginConfigStore(f.store)).values.mode).toBe('committed');
  });
});
