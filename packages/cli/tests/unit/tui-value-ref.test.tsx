import path from 'node:path';
import fs from 'fs-extra';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePluginConfigDefinition, type PluginConfigValue } from '@lesliechan721/aw-plugin-core';
import type { ConfigProfileKey } from '../../src/tui/model.js';
import { writePreferences } from '../../src/intent/deployment-preferences.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type OperationIntent } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { configCrossLayerDependencies } from '../../src/tui/config-references.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readPluginConfigStore, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { focusAction, input, nextTurn, chooseConfigSave, openConfigSave, escape } from '../helpers/tui-console-app-input.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); });
const ref = { type: 'string', valueRef: { field: 'registry', key: 'key', label: 'label', include: ['native'] } };
const entry = (key: string, label = 'Same') => ({ key, label });
function definition(provider?: string) {
  const reference = provider ? { ...ref, valueRef: { ...ref.valueRef, plugin: provider } } : ref;
  return normalizePluginConfigDefinition({ schemaVersion: 5, fields: {
    registry: { type: 'array', title: '来源', default: [entry('A')], choices: { allowCustom: true, presets: [
      { id: 'add', title: '加入 B', value: [entry('A'), entry('B')] },
      { id: 'change', title: '修改 A', value: [entry('A', 'Changed'), entry('B')] },
    ] }, validation: { uniqueBy: 'key' }, items: {
      type: 'object', properties: { key: { type: 'string', required: true }, label: { type: 'string' } },
    } },
    selected: { ...reference, title: '引用', default: 'native' },
    list: { type: 'array', title: '引用列表', items: reference, default: ['native'] },
    map: { type: 'object', title: '引用键值', additionalProperties: reference, default: { primary: 'native' } },
    records: { type: 'array', title: '记录', items: { type: 'object', properties: { selected: reference } }, default: [{ selected: 'native' }] },
    branch: { type: 'object', title: '分支', properties: { mode: { type: 'string', choices: { allowCustom: false, presets: [
      { id: 'x', title: 'X', value: 'x' }, { id: 'y', title: 'Y', value: 'y' },
    ] } } }, variants: { discriminator: 'mode', cases: { x: { properties: {
      list: { type: 'array', items: reference }, map: { type: 'object', additionalProperties: reference },
    } }, y: { properties: { selected: reference } } } }, default: { mode: 'x', list: ['native'], map: { primary: 'native' } } },
    empty: { type: 'string', title: '空候选', valueRef: { field: 'registry', key: 'key' }, validation: { pattern: '^Z', maxLength: 100 } },
  } });
}
async function setup(initial: Partial<Record<ConfigProfileKey, Record<string, PluginConfigValue>>> = {}, external = false) {
  const isolation = getCurrentSourceTestIsolation();
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'references');
  const config = definition(external ? 'provider' : undefined);
  await createCatalogSnapshotFixture(sourceRoot, 'refs', [], 'reference fixture', (manifest) => {
    manifest.interface = { displayName: '引用测试' };
    manifest.config = config;
    if (external) manifest.dependencies = ['provider'];
  });
  const otherRoot = `${sourceRoot}-other`;
  if (external) {
    const providerRoot = `${sourceRoot}-provider`;
    await createCatalogSnapshotFixture(providerRoot, 'provider', [], 'provider fixture', (manifest) => {
      manifest.interface = { displayName: '来源插件' };
      manifest.config = normalizePluginConfigDefinition({ schemaVersion: 5, fields: { registry: config.fields.registry } });
    });
    await fs.copy(path.join(providerRoot, 'plugins/provider'), path.join(sourceRoot, 'plugins/provider'));
    for (const file of ['catalog-manifest.json', '.agents/plugins/marketplace.json', '.claude-plugin/marketplace.json']) {
      const target = await fs.readJson(path.join(sourceRoot, file));
      const provider = await fs.readJson(path.join(providerRoot, file));
      const key = file === 'catalog-manifest.json' ? 'entries' : 'plugins';
      target[key].push(...provider[key]);
      target[key].sort((left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name, 'en'));
      await fs.writeJson(path.join(sourceRoot, file), target);
    }
    await createCatalogSnapshotFixture(otherRoot, 'provider', [], 'other provider', (manifest) => {
      manifest.config = normalizePluginConfigDefinition({ schemaVersion: 5, fields: {
        registry: { ...config.fields.registry, default: [entry('OTHER')] },
      } });
    });
  }
  const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
    { id: 'team', type: 'path', primary: !external, path: sourceRoot },
    ...(external ? [{ id: 'other', type: 'path' as const, primary: true, path: otherRoot }] : []),
  ] }, expectedDigest: snapshot.digest, env: isolation.env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  if (external) await syncCatalogSourceGeneration({ sourceId: 'other', cliVersion: '1.0.0', env: isolation.env });
  const dependencies = createTuiControllerDependencies(createCliExecutionContext({ cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false }));
  const evidence = await dependencies.captureEvidence({ kind: 'configSaveBatch', pluginId: 'team/refs', apply: false, groups: [{ scope: 'user', updates: { registry: [] } }] });
  const storeOptions = { sourceId: 'team', sourceIdentity: evidence.source!.sourceIdentity, logicalIdentity: evidence.source!.logicalIdentity, pluginName: 'refs', cwd: isolation.layout.fixtureCwd, env: isolation.env };
  for (const profile of ['common', 'codex'] as const) if (initial[profile]) await writePluginConfigStore({
    ...storeOptions, scope: 'user', ...(profile === 'common' ? {} : { platform: profile }), values: initial[profile]!,
  });
  await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
    schemaVersion: 2, kind: 'aw-deployment-preferences', targets: ['codex'], exclusions: [],
  });
  // Ink can restore a route before its config and reference reads finish.
  const pendingConfigReads = new Set<Promise<unknown>>();
  const trackConfigRead = <T,>(promise: Promise<T>): Promise<T> => {
    pendingConfigReads.add(promise);
    void promise.then(
      () => pendingConfigReads.delete(promise),
      () => pendingConfigReads.delete(promise),
    );
    return promise;
  };
  const readConfigPage = dependencies.getConfigPage!;
  const readReferences = dependencies.getConfigReferenceContext!;
  dependencies.getConfigPage = (...args) => trackConfigRead(readConfigPage(...args));
  dependencies.getConfigReferenceContext = (...args) => trackConfigRead(readReferences(...args));
  const waitConfigReads = async () => {
    await nextTurn(4);
    while (pendingConfigReads.size > 0) {
      await Promise.allSettled([...pendingConfigReads]);
      await nextTurn(4);
    }
  };
  const captured: OperationIntent[] = [];
  const prepare = dependencies.prepareReviewEvidence!;
  dependencies.prepareReviewEvidence = async (intent, ...args) => { captured.push(intent); return prepare(intent, ...args); };
  const controller = new TuiController(dependencies);
  await controller.load();
  controller.push({ name: 'configFields', pluginId: 'team/refs', layer: { profile: 'common' } });
  const ui = render(<ConsoleAppV4 controller={controller} size={{ columns: 100, rows: 36 }} />);
  await waitConfigReads();
  await vi.waitFor(() => expect(ui.lastFrame()).toContain('引用列表'), { timeout: 5000 });
  const open = async (fieldKey: string, profile: ConfigProfileKey) => {
    controller.push({ name: 'configFieldEditor', pluginId: 'team/refs', layer: { profile }, fieldKey, editor: config.fields[fieldKey]!.type }, { focusIndex: 0, scrollOffset: 0 });
    await vi.waitFor(() => expect(controller.snapshot.router.current.route).toMatchObject({ name: 'configFieldEditor', layer: { profile } }));
    await vi.waitFor(() => expect(ui.lastFrame()?.split('\n')[0]?.trim()).toBe(`AW / 引用测试 / 设置 / ${config.fields[fieldKey]!.title}`));
    await waitConfigReads();
    await vi.waitFor(() => {
      expect(ui.lastFrame()).not.toContain('正在读取');
      expect(ui.lastFrame()).not.toContain('仅可删除旧值');
    });
    await nextTurn(4);
    if (config.fields[fieldKey]!.type === 'array') await focusAction(ui, '01');
  };
  const choose = async (label: string) => { await vi.waitFor(() => expect(ui.lastFrame()).toContain(label), { timeout: 5000 }); await focusAction(ui, label); await input(ui, '\r'); await nextTurn(4); };
  const stageSource = async (label: string) => {
    controller.push({ name: 'configFieldEditor', pluginId: 'team/refs', layer: { profile: 'common' }, fieldKey: 'registry', editor: 'array', mode: 'choices' }, { focusIndex: 0, scrollOffset: 0 });
    await vi.waitFor(() => expect(ui.lastFrame()).toContain(label));
    await choose(label);
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('configFields'));
  };
  const save = async () => {
    await waitConfigReads();
    await openConfigSave(ui, controller);
    await chooseConfigSave(ui, controller, 'only');
  };
  const profileOptions = (profile: ConfigProfileKey) => profile === 'common' ? {} : { platform: profile };
  const context = async (profile: ConfigProfileKey, updates: Record<string, PluginConfigValue> = {}, removes: string[] = []) =>
    controller.getConfigReferenceContext('team/refs', profileOptions(profile), { updates, removes });
  return { ui, controller, open, choose, context, captured, config, stageSource, save, waitConfigReads,
    writeProvider: (values: Record<string, PluginConfigValue>) => writePluginConfigStore({ ...storeOptions, pluginName: 'provider', scope: 'user', values }),
    store: (profile: ConfigProfileKey) => readPluginConfigStore({ ...storeOptions, scope: 'user', ...profileOptions(profile) }) };

}

describe('profile-aware value reference choices', () => {
  it('opens the exact provider and refreshes saved choices while preserving consumer drafts and the editor anchor', async () => {
    const { ui, controller, open, choose, save, captured, store } = await setup({
      common: { registry: [entry('LOCAL')] },
    }, true);
    await open('selected', 'common');
    expect(ui.lastFrame()).toContain('provider.registry');
    expect(ui.lastFrame()).not.toContain('Same (LOCAL)');
    expect(ui.lastFrame()).not.toContain('Same (OTHER)');
    await choose('Same (A)');
    await open('list', 'common');
    await input(ui, '\r');
    const anchor = controller.snapshot.router.currentFrameId;
    await choose('编辑来源 provider.registry');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', pluginId: 'team/provider', fieldKey: 'registry',
    }));
    expect(controller.externalDrafts).toContainEqual(expect.objectContaining({ owner: 'team/refs' }));
    await choose('加入 B');
    expect((await store('common')).values.selected).toBeUndefined();
    await save();
    expect(captured.at(-1)).toMatchObject({ pluginId: 'team/provider' });
    await escape(ui);
    await vi.waitFor(() => expect(controller.snapshot.router.currentFrameId).toBe(anchor));
    await choose('Same (B)');
    await input(ui, 'c');
    await save();
    expect(captured.at(-1)).toMatchObject({ pluginId: 'team/refs', groups: [{ scope: 'user', updates: {
      selected: 'A', list: ['B'],
    } }] });
    expect((await store('common')).values).toMatchObject({ selected: 'A', list: ['B'] });
  });

  it('revalidates restored nested working values and rejects a confirmed draft after provider keys disappear', async () => {
    const { ui, controller, open, choose, writeProvider, captured, store, waitConfigReads } = await setup({}, true);
    await open('selected', 'common');
    await choose('Same (A)');
    await open('branch', 'common');
    await choose('list');
    await choose('修改值');
    await focusAction(ui, '01');
    await input(ui, '\r');
    await choose('Same (A)');
    await input(ui, '\r');
    const anchor = controller.snapshot.router.currentFrameId;
    await choose('编辑来源 provider.registry');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route).toMatchObject({ pluginId: 'team/provider' }));
    await writeProvider({ registry: [entry('B')] });
    await escape(ui);
    await escape(ui);
    await vi.waitFor(() => expect(controller.snapshot.router.currentFrameId).toBe(anchor));
    await waitConfigReads();
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('已失效'));
    expect(ui.lastFrame()).toContain('provider.registry');
    await escape(ui);
    await input(ui, 'c');
    expect(controller.snapshot.router.current.route.name).toBe('configObjectPropertyEditor');
    await escape(ui);
    await escape(ui);
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('configFields'));
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('请先放弃失效草稿'));
    if (ui.lastFrame()?.includes('放弃未保存修改？')) await input(ui, '\r');
    await input(ui, 's');
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    expect(captured).toEqual([]);
    expect((await store('common')).exists).toBe(false);
  });

  it('uses profile inheritance, confirmed set/unset and complete invalid sources', async () => {
    const { context } = await setup({ common: { registry: [entry('U')] }, codex: { registry: [entry('P')] } });
    const choices = (value: Awaited<ReturnType<typeof context>>) => Object.values(value.selections)[0]!.choices.map((choice) => choice.value);
    expect(choices(await context('common', { registry: [entry('B')] }))).toEqual(['native', 'B']);
    expect(choices(await context('codex'))).toEqual(['native', 'P']);
    expect(choices(await context('codex', {}, ['registry']))).toEqual(['native', 'U']);
    expect(choices(await context('common', {}, ['registry']))).toEqual(['native', 'A']);
    const invalid = await context('common', { registry: [entry('A'), entry('A')] });
    expect(Object.values(invalid.selections)[0]).toMatchObject({ choices: [], issues: expect.arrayContaining([expect.objectContaining({ code: 'uniqueBy' })]) });
  });

  it('saves common references while preserving the platform override', async () => {
    const { ui, controller, open, choose, captured, store, waitConfigReads } = await setup({ common: { registry: [entry('A'), entry('a')] }, codex: { registry: [entry('P')], selected: 'P' } });
    await open('selected', 'common');
    expect(ui.lastFrame()).toContain('Same (A)');
    expect(ui.lastFrame()).toContain('Same (a)');
    expect(ui.lastFrame()).not.toContain('Same (P)');
    await choose('Same (a)');
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    await waitConfigReads();
    await openConfigSave(ui, controller);
    expect(captured.at(-1)).toMatchObject({ groups: [{ scope: 'user', updates: { selected: 'a' } }] });
    await chooseConfigSave(ui, controller, 'only');
    expect((await store('common')).values.selected).toBe('a');
    expect((await store('codex')).values.selected).toBe('P');
  });

  it('uses cross-plugin selectors in scalar arrays, KV values, object arrays and branch leaves', async () => {
    const { ui, controller, open, choose, captured, waitConfigReads } = await setup({}, true);
    await open('list', 'codex');
    await input(ui, '\r');
    await choose('Same (A)');
    await input(ui, 'c');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('configFields'));
    await open('map', 'codex');
    await choose('primary');
    await choose('修改值');
    await choose('Same (A)');
    await input(ui, 'c');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('configFields'));
    await open('records', 'codex');
    await input(ui, '\r');
    await choose('selected');
    await choose('修改值');
    await choose('Same (A)');
    await input(ui, 'c', 'c');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('configFields'));
    await open('branch', 'codex');
    await choose('list');
    await choose('修改值');
    await focusAction(ui, '01');
    await input(ui, '\r');
    await choose('Same (A)');
    await input(ui, 'c');
    await choose('map');
    await choose('修改值');
    await choose('primary');
    await choose('Same (A)');
    await input(ui, 'c', 'c');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('configFields'));
    await waitConfigReads();
    await openConfigSave(ui, controller);
    expect(captured.at(-1)).toMatchObject({ groups: [{ updates: {
      list: ['A'], map: { primary: 'A' }, records: [{ selected: 'A' }],
      branch: { mode: 'x', list: ['A'], map: { primary: 'A' } },
    } }] });
  });

  it('keeps confirmed array drafts separate and resolves reference choices in the selected profile', async () => {
    const { ui, open, choose, save, store } = await setup({
      common: { registry: [entry('U')], list: ['U'] }, codex: { registry: [entry('P')], list: ['P'] },
    });
    await open('list', 'common');
    expect(ui.lastFrame()).toContain('U');
    await input(ui, '\r');
    await choose('native');
    await input(ui, 'c');
    await open('list', 'codex');
    expect(ui.lastFrame()).toContain('P');
    await input(ui, '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('Same (P)'));
    expect(ui.lastFrame()).not.toContain('Same (U)');
    await choose('native');
    await input(ui, 'c');
    await save();
    expect((await store('common')).values.list).toEqual(['native']);
    expect((await store('codex')).values.list).toEqual(['native']);
  });

  it('cancels an unconfirmed platform object while retaining the confirmed common object draft', async () => {
    const { ui, controller, open, choose, save, store } = await setup({
      common: { registry: [entry('A'), entry('P')], map: { primary: 'native' } },
      codex: { map: { primary: 'P', secondary: 'P' } },
    });
    await open('map', 'common');
    await choose('primary');
    await choose('修改值');
    await choose('Same (A)');
    await input(ui, 'c');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('configFields'));

    await open('map', 'codex');
    expect(ui.lastFrame()).toContain('secondary');
    await choose('primary');
    await choose('修改值');
    await choose('native');
    await escape(ui);
    expect(controller.snapshot.router.current.route.name).toBe('configFields');

    await open('map', 'codex');
    expect(ui.lastFrame()).toContain('secondary');
    await choose('primary');
    await choose('修改值');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('● Same (P)'));
    await choose('native');
    await input(ui, 'c');
    await save();
    expect((await store('common')).values.map).toEqual({ primary: 'A' });
    expect((await store('codex')).values.map).toEqual({ primary: 'native', secondary: 'P' });
  });

  it('reports empty choices and an invalid old value without accepting arbitrary input', async () => {
    const { ui, controller, open, choose } = await setup({ common: { selected: 'gone' } });
    await open('selected', 'common');
    expect(ui.lastFrame()).toContain('gone');
    expect(ui.lastFrame()).toContain('已失效');
    await input(ui, 'arbitrary');
    await choose('Same (A)');
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    await open('empty', 'common');
    expect(ui.lastFrame()).toContain('没有可选值');
    await input(ui, 'Z-anything', '\r');
    expect(controller.snapshot.router.current.route.name).toBe('configFieldEditor');
  });

  it('offers confirmed same-layer additions and requires saving common B before a platform reference can choose B', async () => {
    const { ui, controller, open, choose, stageSource, save, store, captured } = await setup();
    await stageSource('加入 B');
    await open('selected', 'common');
    await choose('Same (B)');
    await open('selected', 'codex');
    expect(ui.lastFrame()).not.toContain('Same (B)');
    expect(ui.lastFrame()).toContain('请先保存来源配置');
    await escape(ui);
    await save();
    expect(captured.at(-1)).toMatchObject({ groups: [{ scope: 'user', updates: { registry: [entry('A'), entry('B')], selected: 'B' } }] });
    expect((await store('common')).values.selected).toBe('B');
    controller.push({ name: 'configFields', pluginId: 'team/refs', layer: { profile: 'common' } });
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('引用列表'));
    await open('selected', 'codex');
    await choose('Same (B)');
    await save();
    expect((await store('codex')).values.selected).toBe('B');
  });

  it('keeps the source-save path available when a later common source edit affects a platform reference draft', async () => {
    const { ui, controller, open, choose, stageSource, save, store } = await setup();
    await open('selected', 'codex');
    await choose('Same (A)');
    await stageSource('修改 A');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('取消相关引用草稿'));
    await input(ui, 's');
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    expect(ui.lastFrame()).toContain('请先保存来源配置');
    await choose('取消相关引用草稿');
    await save();
    expect((await store('common')).values.registry).toEqual([entry('A', 'Changed'), entry('B')]);
    expect((await store('codex')).values).toEqual({});
  });

  it('blocks actual cross-layer entry dependencies but permits include values, platform overrides and unrelated changes', async () => {
    const { context, config } = await setup();
    const drafts = { common: { updates: { registry: [entry('A', 'Changed'), entry('B')] }, removes: [] }, codex: { updates: { selected: 'A' }, removes: [] } };
    const contexts = { common: await context('common', drafts.common.updates), codex: await context('codex', drafts.codex.updates) };
    expect(configCrossLayerDependencies({ common: config.fields, codex: config.fields }, drafts, contexts)).toEqual([{ profile: 'codex', key: 'selected', source: 'registry' }]);
    expect(configCrossLayerDependencies({ common: config.fields, codex: config.fields }, { ...drafts, codex: { updates: { selected: 'native' }, removes: [] } }, contexts)).toEqual([]);
    const unrelated = { ...drafts, common: { updates: { registry: [entry('A'), entry('B')] }, removes: [] } };
    expect(configCrossLayerDependencies({ common: config.fields, codex: config.fields }, unrelated, { ...contexts, common: await context('common', unrelated.common.updates) })).toEqual([]);
    const override = { ...drafts, codex: { updates: { registry: [entry('A')], selected: 'A' }, removes: [] } };
    expect(configCrossLayerDependencies({ common: config.fields, codex: config.fields }, override, { ...contexts, codex: await context('codex', override.codex.updates) })).toEqual([]);
  });
});
