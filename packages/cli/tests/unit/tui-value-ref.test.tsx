import path from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePluginConfigDefinition, type PluginConfigValue, type Scope } from '@lesliechan721/aw-plugin-core';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type OperationIntent } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { configCrossLayerDependencies } from '../../src/tui/config-references.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readPluginConfigStore, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { focusAction, input, nextTurn, chooseConfigSave, escape } from '../helpers/tui-console-app-input.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const mocks = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock('../../src/commands/status-v6.js', async (original) => ({
  ...await original<typeof import('../../src/commands/status-v6.js')>(),
  statusCommandV8: (...args: unknown[]) => mocks.status(...args),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const ref = { type: 'string', valueRef: { field: 'registry', key: 'key', label: 'label', include: ['native'] } };
const entry = (key: string, label = 'Same') => ({ key, label });
function definition() {
  return normalizePluginConfigDefinition({ schemaVersion: 4, fields: {
    registry: { type: 'array', title: '来源', default: [entry('A')], choices: { allowCustom: true, presets: [
      { id: 'add', title: '加入 B', value: [entry('A'), entry('B')] },
      { id: 'change', title: '修改 A', value: [entry('A', 'Changed'), entry('B')] },
    ] }, validation: { uniqueBy: 'key' }, items: {
      type: 'object', properties: { key: { type: 'string', required: true }, label: { type: 'string' } },
    } },
    selected: { ...ref, title: '引用', default: 'native' },
    list: { type: 'array', title: '引用列表', items: ref, default: ['native'] },
    map: { type: 'object', title: '引用键值', additionalProperties: ref, default: { primary: 'native' } },
    records: { type: 'array', title: '记录', items: { type: 'object', properties: { selected: ref } }, default: [{ selected: 'native' }] },
    branch: { type: 'object', title: '分支', properties: { mode: { type: 'string', choices: { allowCustom: false, presets: [
      { id: 'x', title: 'X', value: 'x' }, { id: 'y', title: 'Y', value: 'y' },
    ] } } }, variants: { discriminator: 'mode', cases: { x: { properties: {
      list: { type: 'array', items: ref }, map: { type: 'object', additionalProperties: ref },
    } }, y: { properties: { selected: ref } } } }, default: { mode: 'x', list: ['native'], map: { primary: 'native' } } },
    empty: { type: 'string', title: '空候选', valueRef: { field: 'registry', key: 'key' }, validation: { pattern: '^Z', maxLength: 100 } },
  } });
}
async function setup(initial: Partial<Record<Scope, Record<string, PluginConfigValue>>> = {}) {
  const isolation = getCurrentSourceTestIsolation();
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'references');
  const config = definition();
  await createCatalogSnapshotFixture(sourceRoot, 'refs', [], 'reference fixture', (manifest) => { manifest.config = config; });
  const snapshot = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: snapshot.digest, env: isolation.env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  mocks.status.mockResolvedValue({
    payload: { schemaVersion: 8, catalog: { configDigest: (await readCatalogSourcesConfigSnapshot(isolation.env)).digest, compositeDigest: 'sha256:composite', primarySourceId: 'team', sources: [] }, filters: { plugins: [], platform: 'both', cwd: isolation.layout.fixtureCwd }, targets: [], errors: [] },
    pluginSummaries: [{ pluginId: 'team/refs', pluginName: 'refs', sourceId: 'team', displayName: '引用测试', version: '1.0.0', configFieldCount: 7, supportedTargets: { codex: ['user', 'project'], claude: ['user', 'project'] } }],
    targetRevisions: [], projectIntentObservation: { state: 'absent' },
  });
  const dependencies = createTuiControllerDependencies(createCliExecutionContext({ cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false }));
  const evidence = await dependencies.captureEvidence({ kind: 'configSaveBatch', pluginId: 'team/refs', apply: false, groups: [{ scope: 'user', updates: { registry: [] } }] });
  const storeOptions = { sourceId: 'team', sourceIdentity: evidence.source!.sourceIdentity, logicalIdentity: evidence.source!.logicalIdentity, pluginName: 'refs', cwd: isolation.layout.fixtureCwd, env: isolation.env };
  for (const scope of ['user', 'project'] as const) if (initial[scope]) await writePluginConfigStore({ ...storeOptions, scope, values: initial[scope]! });
  const captured: OperationIntent[] = [];
  const prepare = dependencies.prepareReviewEvidence!;
  dependencies.prepareReviewEvidence = async (intent, ...args) => { captured.push(intent); return prepare(intent, ...args); };
  const controller = new TuiController(dependencies);
  await controller.load();
  controller.push({ name: 'configFields', pluginId: 'team/refs', layer: { scope: 'effective' } });
  const ui = render(<ConsoleAppV4 controller={controller} size={{ columns: 100, rows: 36 }} />);
  await vi.waitFor(() => expect(ui.lastFrame()).toContain('引用列表'));
  const open = async (fieldKey: string, scope: Scope) => {
    controller.push({ name: 'configFieldEditor', pluginId: 'team/refs', layer: { scope: 'effective' }, fieldKey, editor: config.fields[fieldKey]!.type });
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('configLayer'));
    await vi.waitFor(() => expect(ui.lastFrame()).toContain(scope === 'user' ? '个人默认' : '当前项目'), { timeout: 5000 });
    await focusAction(ui, scope === 'user' ? '个人默认' : '当前项目');
    await input(ui, '\r');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route).toMatchObject({ name: 'configFieldEditor', layer: { scope } }));
    await vi.waitFor(() => expect(ui.lastFrame()).not.toContain('正在读取'));
    await nextTurn(4);
  };
  const choose = async (label: string) => { await vi.waitFor(() => expect(ui.lastFrame()).toContain(label), { timeout: 5000 }); await focusAction(ui, label); await input(ui, '\r'); await nextTurn(4); };
  const stageSource = async (label: string) => {
    controller.push({ name: 'configFieldEditor', pluginId: 'team/refs', layer: { scope: 'effective' }, fieldKey: 'registry', editor: 'array', mode: 'choices' });
    await vi.waitFor(() => expect(ui.lastFrame()).toContain(label));
    await choose(label);
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('个人默认'));
    await choose('个人默认');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('configFields'));
  };
  const save = async () => {
    await vi.waitFor(async () => {
      if (controller.snapshot.router.current.route.name === 'configFields') await input(ui, 's');
      expect(controller.snapshot.router.current.route.name, ui.lastFrame()).toBe('review');
    }, { timeout: 5000 });
    await chooseConfigSave(ui, controller, 'only');
    await input(ui, '\r');
    await vi.waitFor(() => expect(controller.snapshot.result).toMatchObject({ state: 'succeeded' }), { timeout: 5000 });
  };
  const context = async (scope: Scope, updates: Record<string, PluginConfigValue> = {}, removes: string[] = []) =>
    controller.getConfigReferenceContext('team/refs', scope, { updates, removes });
  return { ui, controller, open, choose, context, captured, config, stageSource, save, store: (scope: Scope) => readPluginConfigStore({ ...storeOptions, scope }) };
}

describe('scope-aware value reference choices', () => {
  it('uses writer scope inheritance, confirmed set/unset and complete invalid sources', async () => {
    const { context } = await setup({ user: { registry: [entry('U')] }, project: { registry: [entry('P')] } });
    const choices = (value: Awaited<ReturnType<typeof context>>) => Object.values(value.selections)[0]!.choices.map((choice) => choice.value);
    expect(choices(await context('user', { registry: [entry('B')] }))).toEqual(['native', 'B']);
    expect(choices(await context('project'))).toEqual(['native', 'P']);
    expect(choices(await context('project', {}, ['registry']))).toEqual(['native', 'U']);
    expect(choices(await context('user', {}, ['registry']))).toEqual(['native', 'A']);
    const invalid = await context('user', { registry: [entry('A'), entry('A')] });
    expect(Object.values(invalid.selections)[0]).toMatchObject({ choices: [], issues: [expect.objectContaining({ code: 'uniqueBy' })] });
  });

  it('chooses a layer before a scalar and saves the key without asking the layer twice', async () => {
    const { ui, controller, open, choose, captured, store } = await setup({ user: { registry: [entry('A'), entry('a')] }, project: { registry: [entry('P')], selected: 'P' } });
    await open('selected', 'user');
    expect(ui.lastFrame()).toContain('Same (A)');
    expect(ui.lastFrame()).toContain('Same (a)');
    expect(ui.lastFrame()).not.toContain('Same (P)');
    expect(ui.lastFrame()).toContain('当前项目被覆盖');
    await choose('Same (a)');
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    await vi.waitFor(async () => {
      if (controller.snapshot.router.current.route.name === 'configFields') await input(ui, 's');
      expect(controller.snapshot.router.current.route.name, ui.lastFrame()).toBe('review');
    }, { timeout: 5000 });
    expect(captured.at(-1)).toMatchObject({ groups: [{ scope: 'user', updates: { selected: 'a' } }] });
    await chooseConfigSave(ui, controller, 'only');
    await input(ui, '\r');
    await vi.waitFor(() => expect(controller.snapshot.result).toMatchObject({ state: 'succeeded' }));
    expect((await store('user')).values.selected).toBe('a');
    expect((await store('project')).values.selected).toBe('P');
  });

  it('uses selectors in scalar arrays, KV values, object arrays and branch leaves', async () => {
    const { ui, controller, open, choose, captured } = await setup();
    await open('list', 'project');
    await input(ui, '\r');
    await choose('Same (A)');
    await input(ui, 'c');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('configFields'));
    await open('map', 'project');
    await input(ui, '\r', '\r');
    await choose('Same (A)');
    await input(ui, 'c');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('configFields'));
    await open('records', 'project');
    await input(ui, '\r', '\r', '\r');
    await choose('Same (A)');
    await input(ui, 'c', 'c');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('configFields'));
    await open('branch', 'project');
    await choose('list');
    await input(ui, '\r', '\r');
    await choose('Same (A)');
    await input(ui, 'c');
    await choose('map');
    await input(ui, '\r', '\r');
    await choose('Same (A)');
    await input(ui, 'c', 'c');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('configFields'));
    await vi.waitFor(async () => {
      if (controller.snapshot.router.current.route.name === 'configFields') await input(ui, 's');
      expect(controller.snapshot.router.current.route.name, ui.lastFrame()).toBe('review');
    }, { timeout: 5000 });
    expect(captured.at(-1)).toMatchObject({ groups: [{ updates: {
      list: ['A'], map: { primary: 'A' }, records: [{ selected: 'A' }],
      branch: { mode: 'x', list: ['A'], map: { primary: 'A' } },
    } }] });
  });

  it('retains the working array when changing scope and recomputes the available keys', async () => {
    const { ui, controller, open, choose, captured } = await setup({
      user: { registry: [entry('U')], list: ['U'] }, project: { registry: [entry('P')], list: ['P'] },
    });
    await open('list', 'user');
    expect(ui.lastFrame()).toContain('U');
    await input(ui, '\r');
    await choose('native');
    await escape(ui);
    expect(controller.snapshot.router.current.route.name).toBe('configLayer');
    await choose('当前项目');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('native'));
    await input(ui, '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('Same (P)'));
    expect(ui.lastFrame()).not.toContain('Same (U)');
    await choose('native');
    await input(ui, 'c');
    await vi.waitFor(async () => {
      if (controller.snapshot.router.current.route.name === 'configFields') await input(ui, 's');
      expect(controller.snapshot.router.current.route.name, ui.lastFrame()).toBe('review');
    }, { timeout: 5000 });
    expect(captured.at(-1)).toMatchObject({ groups: [{ scope: 'project', updates: { list: ['native'] } }] });
  });

  it('ends confirmed object working copies while preserving an unconfirmed object during scope selection', async () => {
    const { ui, controller, open, choose, save, store } = await setup({
      user: { registry: [entry('A'), entry('P')], map: { primary: 'native' } },
      project: { map: { primary: 'P', secondary: 'P' } },
    });
    await open('map', 'user');
    await choose('primary');
    await choose('修改值');
    await choose('Same (A)');
    await input(ui, 'c');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('configFields'));

    await open('map', 'project');
    expect(ui.lastFrame()).toContain('secondary');
    await choose('primary');
    await choose('修改值');
    await choose('native');
    await escape(ui);
    expect(controller.snapshot.router.current.route.name).toBe('configLayer');
    await choose('个人默认');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('secondary'));
    expect(ui.lastFrame()).toContain('native');
    await escape(ui);
    await escape(ui);

    await open('map', 'project');
    expect(ui.lastFrame()).toContain('secondary');
    await choose('primary');
    await choose('修改值');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('● Same (P)'));
    await choose('native');
    await input(ui, 'c');
    await save();
    expect((await store('user')).values.map).toEqual({ primary: 'A' });
    expect((await store('project')).values.map).toEqual({ primary: 'native', secondary: 'P' });
  });

  it('reports empty choices and an invalid old value without accepting arbitrary input', async () => {
    const { ui, controller, open, choose } = await setup({ user: { selected: 'gone' } });
    await open('selected', 'user');
    expect(ui.lastFrame()).toContain('gone');
    expect(ui.lastFrame()).toContain('已失效');
    await input(ui, 'arbitrary');
    await choose('Same (A)');
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    await open('empty', 'user');
    expect(ui.lastFrame()).toContain('没有可选值');
    await input(ui, 'Z-anything', '\r');
    expect(controller.snapshot.router.current.route.name).toBe('configFieldEditor');
  });

  it('offers confirmed same-layer additions and requires saving user B before a project reference can choose B', async () => {
    const { ui, controller, open, choose, stageSource, save, store, captured } = await setup();
    await stageSource('加入 B');
    await open('selected', 'user');
    await choose('Same (B)');
    await open('selected', 'project');
    expect(ui.lastFrame()).not.toContain('Same (B)');
    expect(ui.lastFrame()).toContain('请先保存来源配置');
    await escape(ui); await escape(ui);
    await save();
    expect(captured.at(-1)).toMatchObject({ groups: [{ scope: 'user', updates: { registry: [entry('A'), entry('B')], selected: 'B' } }] });
    expect((await store('user')).values.selected).toBe('B');
    controller.push({ name: 'configFields', pluginId: 'team/refs', layer: { scope: 'effective' } });
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('引用列表'));
    await open('selected', 'project');
    await choose('Same (B)');
    await save();
    expect((await store('project')).values.selected).toBe('B');
  });

  it('keeps the source-save path available when a later user source edit affects a project reference draft', async () => {
    const { ui, controller, open, choose, stageSource, save, store } = await setup();
    await open('selected', 'project');
    await choose('Same (A)');
    await stageSource('修改 A');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('取消跨层引用草稿'));
    await input(ui, 's');
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    expect(ui.lastFrame()).toContain('请先保存来源配置');
    await choose('取消跨层引用草稿，保留来源修改');
    await save();
    expect((await store('user')).values.registry).toEqual([entry('A', 'Changed'), entry('B')]);
    expect((await store('project')).exists).toBe(false);
  });

  it('blocks actual cross-layer entry dependencies but permits include values, project overrides and unrelated changes', async () => {
    const { context, config } = await setup();
    const drafts = { user: { updates: { registry: [entry('A', 'Changed'), entry('B')] }, removes: [] }, project: { updates: { selected: 'A' }, removes: [] } };
    const contexts = { user: await context('user', drafts.user.updates), project: await context('project', drafts.project.updates) };
    expect(configCrossLayerDependencies(config.fields, drafts, contexts)).toEqual([{ key: 'selected', source: 'registry' }]);
    expect(configCrossLayerDependencies(config.fields, { ...drafts, project: { updates: { selected: 'native' }, removes: [] } }, contexts)).toEqual([]);
    const unrelated = { ...drafts, user: { updates: { registry: [entry('A'), entry('B')] }, removes: [] } };
    expect(configCrossLayerDependencies(config.fields, unrelated, { ...contexts, user: await context('user', unrelated.user.updates) })).toEqual([]);
    const override = { ...drafts, project: { updates: { registry: [entry('A')], selected: 'A' }, removes: [] } };
    expect(configCrossLayerDependencies(config.fields, override, { ...contexts, project: await context('project', override.project.updates) })).toEqual([]);
  });
});
