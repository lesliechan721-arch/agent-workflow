import path from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginConfigObject } from '@lesliechan721/aw-plugin-core';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type OperationIntent } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { writePreferences } from '../../src/intent/deployment-preferences.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readPluginConfigStore, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import type { ConfigSuggestionLookup } from '../../src/tui/config-suggestions.js';
import type { ConfigPageViewModel, ConfigReadOptions } from '../../src/tui/model.js';
import type { ConfigSuggestionsResponseV2 } from '../../src/utils/plugin-config-suggestions.js';
import { controller, configPageForProfile } from '../helpers/tui-console-app-fixture.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { confirmReview, escape, focusAction, input, nextTurn, openConfigSave } from '../helpers/tui-console-app-input.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

afterEach(cleanup);
const size = { columns: 100, rows: 34 };
const choose = async (ui: ReturnType<typeof render>, label: string) => {
  await vi.waitFor(() => expect(ui.lastFrame()).toContain(label));
  await focusAction(ui, label);
  await input(ui, '\r');
  await nextTurn(4);
};

async function runtimeFixture(platformOnly: boolean, targets: ('codex' | 'claude')[], excludeClaude = false) {
  const isolation = getCurrentSourceTestIsolation();
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'config-convergence');
  await createCatalogSnapshotFixture(sourceRoot, 'demo', [], 'Layer fixture', (manifest) => {
    manifest.platforms = ['codex', 'claude'];
    manifest.config = { schemaVersion: 5, fields: {
      profile: { title: '任务档位', type: 'string', platformOnly: true },
      ...(platformOnly ? {} : {
        registry: { title: '执行器列表', type: 'array', items: { type: 'string' } },
        token: { type: 'string', sensitive: true },
      }),
    } };
  });
  const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [
    { id: 'team', type: 'path', primary: true, path: sourceRoot },
  ] }, expectedDigest: initial.digest, env: isolation.env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
    schemaVersion: 2, kind: 'aw-deployment-preferences', targets,
    exclusions: excludeClaude ? [{ plugin: 'team/demo', target: 'claude' }] : [],
  });
  const dependencies = createTuiControllerDependencies(createCliExecutionContext({
    cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false,
  }));
  const availability = await dependencies.getConfigResetAvailability!('team/demo', {}, new AbortController().signal);
  const identity = { sourceId: 'team', sourceIdentity: availability.sourceIdentity!, pluginName: 'demo',
    scope: 'user' as const, cwd: isolation.layout.fixtureCwd, env: isolation.env };
  await writePluginConfigStore({ ...identity, values: {
    profile: 'OLD-PRIVATE-VALUE', ...(platformOnly ? {} : { registry: ['keep'] }),
  } });
  await writePluginConfigStore({ ...identity, platform: 'claude', values: {
    profile: 'claude-model', ...(platformOnly ? {} : { token: 'SECRET-TOKEN' }), unknownPrivateKey: 'HIDDEN',
  } });
  const value = new TuiController(dependencies);
  await value.load();
  value.push({ name: 'pluginDetail', pluginId: 'team/demo' });
  value.beginConfigFlow('team/demo');
  const ui = render(<ConsoleAppV4 controller={value} size={size} />);
  return { value, ui, identity };
}

describe('active configuration layers and read-only history', () => {
  it('cycles only active layers, redacts residuals, and can reset the excluded layer without removing common values', async () => {
    const { value, ui, identity } = await runtimeFixture(false, ['codex', 'claude'], true);
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('执行器列表'), { timeout: 5000 });
    await input(ui, '\t');
    await vi.waitFor(() => expect(value.snapshot.router.current.route).toMatchObject({ layer: { profile: 'codex' } }));
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('任务档位'), { timeout: 5000 });
    await input(ui, '\t');
    await vi.waitFor(() => expect(value.snapshot.router.current.route).toMatchObject({ layer: { profile: 'common' } }));
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('历史残留层（1 个）'), { timeout: 5000 });
    await choose(ui, '历史残留层（1 个）');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('重置Claude'));
    expect(ui.lastFrame()).toContain('[redacted]');
    expect(ui.lastFrame()).not.toMatch(/SECRET-TOKEN|unknownPrivateKey|HIDDEN/);
    await input(ui, '\t');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFields', layer: { profile: 'common' }, view: 'residuals' });
    await choose(ui, '重置Claude');
    await vi.waitFor(() => expect(value.snapshot.activeReview?.operationKind).toBe('configReset'), { timeout: 5000 });
    await confirmReview(ui, value);
    await vi.waitFor(async () => expect((await readPluginConfigStore({ ...identity, platform: 'claude' })).values).toEqual({}), { timeout: 5000 });
    expect((await readPluginConfigStore(identity)).values).toEqual({ registry: ['keep'], profile: 'OLD-PRIVATE-VALUE' });
    value.dispose();
  });

  it('only unsets the stale common key and keeps the valid registry', async () => {
    const { value, ui, identity } = await runtimeFixture(false, ['codex']);
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('旧设置'));
    await input(ui, '\u001b[C');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('[redacted]'));
    expect(ui.lastFrame()).not.toContain('OLD-PRIVATE-VALUE');
    await choose(ui, 'profile');
    await choose(ui, '删除此覆盖并恢复继承');
    await openConfigSave(ui, value);
    expect((await readPluginConfigStore(identity)).values).toEqual({ registry: ['keep'] });
    value.dispose();
  });

  it('skips empty common and offers Agent management and history when no active layer remains', async () => {
    const first = await runtimeFixture(true, ['claude']);
    await vi.waitFor(() => expect(first.value.snapshot.router.current.route).toMatchObject({ layer: { profile: 'claude' } }), { timeout: 5000 });
    await vi.waitFor(() => expect(first.ui.lastFrame()).toContain('历史残留层（1 个）'), { timeout: 5000 });
    await input(first.ui, '\t');
    expect(first.value.snapshot.router.current.route).toMatchObject({ layer: { profile: 'claude' } });
    first.value.dispose();
    first.ui.unmount();
  });

  it('shows an empty state and the remaining read-only reset route when targets are empty', async () => {
    const { value, ui } = await runtimeFixture(true, []);
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('没有可配置的设置层'));
    expect(ui.lastFrame()).toContain('打开 Agent 管理');
    expect(ui.lastFrame()).toContain('历史残留层（2 个）');
    await choose(ui, '历史残留层（2 个）');
    expect(ui.lastFrame()).toContain('重置公共设置');
    expect(ui.lastFrame()).toContain('重置Claude');
    value.dispose();
  });
});

const objectDefinition = {
  type: 'object' as const, additionalProperties: false as const,
  properties: {
    executor: { type: 'string' as const, title: '执行器', clearsOnChange: ['model', 'effort'], choices: {
      allowCustom: false, presets: [{ id: 'native', title: '原生', value: 'native' }, { id: 'ext', title: '外部', value: 'ext' }],
    } },
    model: { type: 'string' as const, title: '模型', clearsOnChange: ['effort'] },
    effort: { type: 'string' as const, title: '推理强度', choices: { allowCustom: true,
      presets: [{ id: 'low', title: 'low', value: 'low' }, { id: 'high', title: 'high', value: 'high' }] },
      suggestions: { provider: 'effort', dependsOn: ['model'] } },
  },
  variants: { discriminator: 'executor', missing: 'native',
    cases: { native: { properties: { oldOnly: { type: 'string' as const, title: '旧分支属性' } } }, ext: { properties: {} } } },
  suggestions: { title: '推荐组合', provider: 'combo', dependsOn: ['executor'], targets: ['model', 'effort'] },
  choices: { allowCustom: true, presets: [
    { id: 'native', title: '原生静态方案', value: { executor: 'native', model: 'static', effort: 'low' } },
  ] },
};
function objectPage(options: ConfigReadOptions, draft?: PluginConfigObject): ConfigPageViewModel {
  const pluginId = 'team-tools/review-gate';
  return configPageForProfile({
    pluginId, context: 'user', profile: 'common', layer: { profile: 'common', context: 'user' },
    configurableLayers: ['common'], storedCount: draft ? 1 : 0, presets: [],
    groups: [{ id: 'main', title: '任务配置', advanced: false, fields: [{
      key: 'profile', title: '任务配置', type: 'object', definition: objectDefinition,
      displayValue: draft ? JSON.stringify(draft) : '未设置', required: false, sensitive: false,
      writable: true, canSet: true, canUnset: Boolean(draft), dirty: false, inherited: !draft,
      configured: Boolean(draft), sourceLabel: '本层', effectiveDisplayValue: draft ? JSON.stringify(draft) : '未设置',
      effectiveSourceLabel: '本层', allowCustom: true, advanced: false,
      choices: objectDefinition.choices.presets,
      ...(draft ? { value: draft, draftValue: draft, effectiveValue: draft } : {}),
    }] }],
  }, options);
}
async function objectFixture(draft?: PluginConfigObject, response?: ConfigSuggestionsResponseV2, array = false) {
  const getConfigSuggestions = vi.fn(async (_lookup: ConfigSuggestionLookup): Promise<ConfigSuggestionsResponseV2> =>
    response ?? { schemaVersion: 2, status: 'ok', message: '离线内置别名', items: [
      { title: '沿用宿主默认', unset: ['model', 'effort'], source: 'builtin' },
      { title: '推荐模型', set: { model: 'gpt-demo' }, source: 'dynamic', children: { title: '选择强度', items: [
        { title: '强', set: { effort: 'high' }, recommended: true },
        { title: '默认强度', unset: ['effort'] },
      ] } },
    ] });
  const executeIntent = vi.fn(async (intent: OperationIntent) => {
    if (intent.kind !== 'configSaveBatch') throw new Error('unexpected operation');
    return { status: 'succeeded', groups: intent.groups.map((group) => ({
      scope: 'user', platform: group.platform, status: 'succeeded', configSaved: true, applyStatus: 'notRequested', applyRequested: false,
    })) };
  });
  const value = controller({ getConfigPage: async (_pluginId, options) => {
    const page = objectPage(options, draft);
    if (array) {
      const field = page.groups[0]!.fields[0]!;
      page.groups[0]!.fields = [{ ...field, type: 'array', definition: { type: 'array', items: objectDefinition },
        choices: undefined, canUnset: false, configured: false, value: undefined, draftValue: undefined, effectiveValue: undefined }];
    }
    return page;
  }, getConfigSuggestions, executeIntent });
  await value.load();
  value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
  value.beginConfigFlow('team-tools/review-gate');
  const ui = render(<ConsoleAppV4 controller={value} size={size} />);
  await choose(ui, '任务配置');
  return { value, ui, getConfigSuggestions, executeIntent };
}

describe('composite object suggestions and linked clears', () => {
  it('applies parent and child patches atomically, initializes dependencies and preserves draft across refresh and custom return', async () => {
    const { value, ui, getConfigSuggestions, executeIntent } = await objectFixture();
    await choose(ui, '推荐组合');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('离线内置别名'));
    expect(ui.lastFrame()).not.toContain('原生静态方案');
    await choose(ui, '沿用宿主默认');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('宿主默认'));
    await choose(ui, '推荐组合');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('推荐模型'));
    const before = getConfigSuggestions.mock.calls.length;
    await input(ui, 'r');
    await vi.waitFor(() => expect(getConfigSuggestions.mock.calls.length).toBeGreaterThan(before));
    await choose(ui, '推荐模型');
    await escape(ui);
    await choose(ui, '推荐模型');
    await choose(ui, '强（推荐）');
    expect(ui.lastFrame()).toContain('gpt-demo / high');
    await choose(ui, '推荐组合');
    await choose(ui, '自定义（逐项编辑）');
    expect(ui.lastFrame()).toContain('gpt-demo / high');
    await choose(ui, '使用此完整对象');
    await openConfigSave(ui, value);
    expect(executeIntent.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'configSaveBatch', groups: [{ updates: { profile: { executor: 'native', model: 'gpt-demo', effort: 'high' } } }],
    });
    value.dispose();
  });

  it('selects the correct same-title grouping parent even when a refresh reorders the groups', async () => {
    const response: ConfigSuggestionsResponseV2 = { schemaVersion: 2, status: 'ok', items: [
      { title: '同名模型家族', children: { items: [{ title: '第一个模型', set: { model: 'first' } }] } },
      { title: '同名模型家族', children: { items: [{ title: '第二个模型', set: { model: 'second' } }] } },
    ] };
    const { value, ui, getConfigSuggestions } = await objectFixture(undefined, response);
    await choose(ui, '推荐组合');
    await vi.waitFor(() => expect(ui.lastFrame()?.match(/同名模型家族/gu)).toHaveLength(2));
    await input(ui, '\u001b[B', '\u001b[B', '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('第二个模型'));
    expect(ui.lastFrame()).not.toContain('第一个模型');
    const previousCalls = getConfigSuggestions.mock.calls.length;
    getConfigSuggestions.mockResolvedValue({ ...response, items: [...response.items].reverse() });
    await input(ui, 'r');
    await vi.waitFor(() => expect(getConfigSuggestions.mock.calls.length).toBeGreaterThan(previousCalls));
    await choose(ui, '第二个模型');
    expect(ui.lastFrame()).toContain('second');
    value.dispose();
  });

  it.each(['no-probe', 'unavailable', 'ok'] as const)('uses only same-dependency static fallback for %s', async (status) => {
    const response: ConfigSuggestionsResponseV2 = { schemaVersion: 2, status, items: [], message: '建议说明' };
    const native = await objectFixture({ executor: 'native', model: 'existing' }, response);
    await choose(native.ui, '推荐组合');
    await vi.waitFor(() => expect(native.ui.lastFrame()).toContain('原生静态方案'));
    await choose(native.ui, '原生静态方案');
    expect(native.ui.lastFrame()).toContain('static / low');
    native.value.dispose();
    native.ui.unmount();

    const external = await objectFixture({ executor: 'ext', model: 'existing' }, response);
    await choose(external.ui, '推荐组合');
    await vi.waitFor(() => expect(external.ui.lastFrame()).toContain('建议说明'));
    expect(external.ui.lastFrame()).not.toContain('原生静态方案');
    expect(external.ui.lastFrame()).toContain('自定义（逐项编辑）');
    external.value.dispose();
  });

  it('edits an unset top-level array item with its exact object lookup path', async () => {
    const { value, ui, getConfigSuggestions, executeIntent } = await objectFixture(undefined, undefined, true);
    await choose(ui, '添加一项');
    await choose(ui, '推荐组合');
    await choose(ui, '沿用宿主默认');
    expect(getConfigSuggestions.mock.calls[0]?.[0]).toMatchObject({
      fieldPath: ['profile', 0], dependencyValues: { executor: 'native' },
      draftValues: { profile: [{ executor: 'native' }] },
    });
    await choose(ui, '使用这一项');
    await choose(ui, '使用此列表');
    await openConfigSave(ui, value);
    expect(executeIntent.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'configSaveBatch', groups: [{ updates: { profile: [{ executor: 'native' }] } }],
    });
    value.dispose();
  });

  it('shows the not-applicable explanation without static reasoning presets', async () => {
    const { value, ui } = await objectFixture({ executor: 'native', model: 'existing' },
      { schemaVersion: 2, status: 'not-applicable', items: [] });
    await choose(ui, '推理强度');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('当前选择不支持此项'));
    expect(ui.lastFrame()).not.toContain(' low');
    expect(ui.lastFrame()).not.toContain(' high');
    expect(ui.lastFrame()).toContain('自定义');
    value.dispose();
  });

  it('merges clears and variant changes in one confirmation, supports cancellation and saves only confirmed changes', async () => {
    const { value, ui, executeIntent } = await objectFixture({ executor: 'native', model: 'old-model', effort: 'high', oldOnly: 'branch-old' });
    await choose(ui, '执行器');
    await choose(ui, '修改值');
    await choose(ui, '外部');
    expect(ui.lastFrame()).toContain('确认分支切换');
    expect(ui.lastFrame()).toContain('old-model');
    expect(ui.lastFrame()).toContain('high');
    expect(ui.lastFrame()).toContain('branch-old');
    await choose(ui, '取消切换');
    expect(ui.lastFrame()).toContain('old-model / high');
    await choose(ui, '执行器');
    await choose(ui, '修改值');
    await choose(ui, '外部');
    await choose(ui, '使用此候选草稿');
    expect(ui.lastFrame()).toContain('后端默认');
    expect(ui.lastFrame()).not.toContain('old-model');
    await choose(ui, '模型');
    await input(ui, 'new-model', '\r');
    expect(ui.lastFrame()).not.toContain('确认关联设置清理');
    await choose(ui, '使用此完整对象');
    await openConfigSave(ui, value);
    expect(executeIntent.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'configSaveBatch', groups: [{ updates: { profile: { executor: 'ext', model: 'new-model' } } }],
    });
    value.dispose();
  });

  it('clears linked properties only after confirming deletion', async () => {
    const { value, ui, executeIntent } = await objectFixture({ executor: 'native', model: 'old-model', effort: 'high' });
    await choose(ui, '模型');
    await choose(ui, '修改值');
    await input(ui, '\u0015', 'new-model', '\r');
    expect(ui.lastFrame()).toContain('确认关联设置清理');
    expect(ui.lastFrame()).toContain('high');
    await choose(ui, '取消修改');
    expect(ui.lastFrame()).toContain('old-model / high');
    await choose(ui, '模型');
    await choose(ui, '删除属性');
    expect(ui.lastFrame()).toContain('确认关联设置清理');
    expect(ui.lastFrame()).toContain('high');
    await choose(ui, '取消修改');
    expect(ui.lastFrame()).toContain('old-model / high');
    await choose(ui, '模型');
    await choose(ui, '删除属性');
    await choose(ui, '使用此候选草稿');
    expect(ui.lastFrame()).toContain('宿主默认');
    await choose(ui, '使用此完整对象');
    await openConfigSave(ui, value);
    expect(executeIntent.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'configSaveBatch', groups: [{ updates: { profile: { executor: 'native' } } }],
    });
    value.dispose();
  });
});
