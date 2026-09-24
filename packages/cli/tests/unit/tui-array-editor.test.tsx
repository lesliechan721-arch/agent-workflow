import path from 'node:path';
import fs from 'fs-extra';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type OperationIntent } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readPluginConfigStore, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const mocks = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock('../../src/commands/status-v6.js', async (original) => ({
  ...await original<typeof import('../../src/commands/status-v6.js')>(),
  statusCommandV8: (...args: unknown[]) => mocks.status(...args),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function turn(): Promise<void> {
  for (let index = 0; index < 4; index++) await new Promise((resolve) => setImmediate(resolve));
}
async function keys(ui: ReturnType<typeof render>, ...values: string[]): Promise<void> {
  for (const value of values) {
    ui.stdin.write(value);
    await turn();
    if (value === '\u001b') await new Promise((resolve) => setTimeout(resolve, 80));
  }
}
const down = '\u001b[B';
const esc = '\u001b';

async function setup(fieldKey = 'labels', size = { columns: 60, rows: 18 }) {
  const isolation = getCurrentSourceTestIsolation();
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'array-source');
  await createCatalogSnapshotFixture(sourceRoot, 'arrays', [], 'array fixture', (manifest) => {
    manifest.config = { schemaVersion: 3, fields: {
      labels: { type: 'array', title: '检查标签', items: { type: 'string', validation: { minLength: 1 } }, default: ['security', 'tests'], validation: { minItems: 1, uniqueItems: true } },
      pipeline: { type: 'array', title: '模型顺序', items: { type: 'object', properties: {
        model: { type: 'string', title: '模型', required: true },
        effort: { type: 'string', title: '推理强度', required: true, choices: { allowCustom: false, presets: [{ id: 'high', title: 'high', value: 'high' }, { id: 'low', title: 'low', value: 'low' }] } },
      } }, default: [{ model: 'fast', effort: 'high' }, { model: 'review', effort: 'low' }] },
      numbers: { type: 'array', title: '数字', items: { type: 'number' }, default: [0, 2] },
      empty: { type: 'array', title: '空值', items: { type: 'string' } },
      repeat: { type: 'array', title: '重复对象', items: { type: 'object', properties: { model: { type: 'string' } } }, default: [{ model: 'same' }, { model: 'same' }, { model: 'last' }] },
      switches: { type: 'array', title: '开关', items: { type: 'boolean' }, default: [false] },
      options: { type: 'array', title: '键值', items: { type: 'object', additionalProperties: { type: 'string' } }, default: [{ mode: 'safe' }] },
      fixed: { type: 'array', title: '固定列表', items: { type: 'string' }, default: ['one'], choices: { allowCustom: false, presets: [{ id: 'one', title: '第一方案', value: ['one'] }, { id: 'two', title: '第二方案', value: ['two'] }] } },
    }, presentation: {
      summaries: { profile: { kind: 'join', parts: [{ path: '/model' }, { path: '/effort' }], separator: '/', missing: '未设置' } },
      fieldViews: { pipeline: { itemSummary: 'profile' } },
    } };
  });
  const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env: isolation.env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  const configured = await readCatalogSourcesConfigSnapshot(isolation.env);
  mocks.status.mockResolvedValue({
    payload: { schemaVersion: 8, catalog: { configDigest: configured.digest, compositeDigest: 'sha256:composite', primarySourceId: 'team', sources: [] }, filters: { plugins: [], platform: 'both', cwd: isolation.layout.fixtureCwd }, targets: [], errors: [] },
    pluginSummaries: [{ pluginId: 'team/arrays', pluginName: 'arrays', sourceId: 'team', displayName: '数组测试', version: '1.0.0', configFieldCount: 6, supportedTargets: { codex: ['user', 'project'], claude: ['user', 'project'] } }],
    targetRevisions: [], projectIntentObservation: { state: 'absent' },
  });
  const dependencies = createTuiControllerDependencies(createCliExecutionContext({ cwd: isolation.layout.fixtureCwd, env: isolation.env, interactive: false }));
  const captured: OperationIntent[] = [];
  const prepare = dependencies.prepareReviewEvidence!;
  dependencies.prepareReviewEvidence = async (intent, ...args) => { captured.push(intent); return prepare(intent, ...args); };
  const controller = new TuiController(dependencies);
  await controller.load();
  controller.push({ name: 'configFields', pluginId: 'team/arrays', layer: { scope: 'effective' } });
  controller.push({ name: 'configFieldEditor', pluginId: 'team/arrays', layer: { scope: 'effective' }, fieldKey, editor: 'array', ...(fieldKey === 'fixed' ? { mode: 'choices' as const } : {}) });
  const ui = render(<ConsoleAppV4 controller={controller} size={size} />);
  await vi.waitFor(() => expect(ui.lastFrame()).toContain(fieldKey === 'fixed' ? '第一方案' : '添加一项'), { timeout: 5000 });
  const store = async (scope: 'user' | 'project') => {
    const evidence = await dependencies.captureEvidence({ kind: 'configSaveBatch', pluginId: 'team/arrays', apply: false, groups: [{ scope, updates: { labels: ['safe'] } }] });
    return readPluginConfigStore({ sourceId: 'team', sourceIdentity: evidence.source!.sourceIdentity, logicalIdentity: evidence.source!.logicalIdentity, pluginName: 'arrays', scope, cwd: isolation.layout.fixtureCwd, env: isolation.env });
  };
  const record = async (name: string) => {
    if (!process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) return;
    await fs.outputJson(path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `array-${name}-${size.columns}x${size.rows}.json`), {
      synthetic: true, size, route: controller.snapshot.router.current.route, frame: ui.lastFrame(),
    }, { spaces: 2 });
  };
  await record(`list-${fieldKey}`);
  return { ui, controller, dependencies, captured, isolation, store, record };
}

describe('array editor with real config runtime', () => {
  it('does not create a draft by opening an unset list, but can explicitly stage an empty list', async () => {
    const { ui, controller } = await setup('empty');
    expect(controller.externalDrafts).toHaveLength(0);
    await keys(ui, esc);
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    expect(ui.lastFrame()).not.toContain('放弃');
    controller.push({ name: 'configFieldEditor', pluginId: 'team/arrays', layer: { scope: 'effective' }, fieldKey: 'empty', editor: 'array' });
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('添加一项'), { timeout: 5000 });
    await keys(ui, 'c');
    expect(controller.snapshot.router.current.route.name).toBe('configLayer');
  });

  it('restores item order without making a draft and recalculates invalid duplicate indices after deletion', async () => {
    const { ui, controller } = await setup();
    await keys(ui, down, 'a', down, '\r', '\r');
    expect(ui.lastFrame()).toContain('01  tests');
    await keys(ui, 'a', down, '\r', down, '\r', 'c');
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    expect(ui.lastFrame()).not.toContain('待保存');
    controller.push({ name: 'configFieldEditor', pluginId: 'team/arrays', layer: { scope: 'effective' }, fieldKey: 'labels', editor: 'array' });
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('添加一项'), { timeout: 5000 });
    await keys(ui, down, down, '\r', 'tests', '\r');
    expect(ui.lastFrame()).toContain('第 3 项');
    await keys(ui, '\u001b[A', '\u001b[A', 'a', down, '\r', down, down, '\r');
    expect(ui.lastFrame()).toContain('第 2 项');
  });

  it.each(['numbers', 'switches', 'options'] as const)('uses the shared typed editor for %s items', async (field) => {
    const { ui, controller, record } = await setup(field);
    await keys(ui, '\r');
    if (field === 'numbers') {
      await keys(ui, '\u0015', '\r');
      expect(ui.lastFrame()).toContain('空输入不会保存为 0');
      await record('number-error');
      await keys(ui, '3', '\r');
      expect(ui.lastFrame()).toContain('01  3');
    } else if (field === 'switches') {
      await keys(ui, '\r');
      expect(ui.lastFrame()).toContain('开启');
    } else {
      await keys(ui, '\r', '\r', '\u0015', 'fast', '\r', 'c');
      expect(ui.lastFrame()).toContain('mode=fast');
    }
    expect(controller.snapshot.router.current.route).toMatchObject({ editor: 'array' });
  });

  it('edits an item, cancels another item and stages only the confirmed complete list', async () => {
    const { ui, controller, captured, store } = await setup();
    await keys(ui, '\r', '\u0015', 'docs', '\r');
    expect(controller.snapshot.router.current.route).toMatchObject({ editor: 'array' });
    await keys(ui, down, '\r', '\u0015', 'discard', esc);
    expect(ui.lastFrame()).toContain('docs');
    expect(ui.lastFrame()).toContain('tests');
    expect((await store('project')).exists).toBe(false);
    await keys(ui, 'c');
    expect(controller.snapshot.router.current.route.name).toBe('configLayer');
    await keys(ui, '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'), { timeout: 5000 });
    await keys(ui, 's');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('review'), { timeout: 5000 });
    expect(captured.at(-1)).toMatchObject({ kind: 'configSaveBatch', groups: [{ updates: { labels: ['docs', 'tests'] } }] });
    expect((await store('project')).exists).toBe(false);
  });

  it.each([{ columns: 60, rows: 18 }, { columns: 80, rows: 24 }])('reuses object property editors and cancels an object at $columns x $rows', async (size) => {
    const { ui, controller, record } = await setup('pipeline', size);
    expect(ui.lastFrame()).toContain('fast/high');
    await keys(ui, '\r');
    await record('object-item');
    await keys(ui, '\r', '\r', '\u0015', 'changed', '\r', esc);
    expect(controller.snapshot.router.current.route).toMatchObject({ editor: 'array' });
    expect(ui.lastFrame()).toContain('fast/high');
    expect(ui.lastFrame()).toContain('review/low');
    await keys(ui, '\r', '\r', '\r', '\u0015', 'changed', '\r', 'c');
    expect(ui.lastFrame()).toContain('changed/high');
    await keys(ui, esc);
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    expect(ui.lastFrame()).not.toContain('待保存');
  });

  it('only offers complete presets for a fixed list', async () => {
    const { ui, controller } = await setup('fixed');
    expect(ui.lastFrame()).not.toContain('添加一项');
    expect(ui.lastFrame()).not.toContain('自定义');
    await keys(ui, down, '\r');
    expect(controller.snapshot.router.current.route.name).toBe('configLayer');
  });

  it('retains the previous overview draft when a reopened list is cancelled', async () => {
    const { ui, controller, captured } = await setup();
    await keys(ui, '\r', '\u0015', 'docs', '\r', 'c', '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'), { timeout: 5000 });
    await keys(ui, '\r', '\r', '\u0015', 'discard', '\r', esc, 's');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('review'), { timeout: 5000 });
    expect(captured.at(-1)).toMatchObject({ groups: [{ updates: { labels: ['docs', 'tests'] } }] });
  });

  it('allows temporary deletion below minItems but refuses to stage the empty working value', async () => {
    const { ui, controller, store, record } = await setup();
    for (let index = 0; index < 2; index++) await keys(ui, 'a', down, '\r', down, down, '\r');
    expect(ui.lastFrame()).toContain('空列表');
    await keys(ui, 'c');
    expect(controller.snapshot.router.current.route).toMatchObject({ editor: 'array' });
    expect((await store('project')).exists).toBe(false);
    await record('min-items-error');
  });

  it('shows full ordered before and after lists for duplicate objects without guessing item identity', async () => {
    const { ui, controller, captured } = await setup('repeat');
    await keys(ui, down, down, 'a', down, '\r', '\r', 'c', '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'), { timeout: 5000 });
    await keys(ui, 's');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('review'), { timeout: 5000 });
    const intent = captured.at(-1)!;
    if (intent.kind !== 'configSaveBatch') throw new Error('Expected config batch');
    expect(intent.groups[0]!.updates!.repeat).toEqual([{ model: 'same' }, { model: 'last' }, { model: 'same' }]);
    expect(intent.groups[0]!.changes![0]!.before).toContain('[{"model":"same"},{"model":"same"},{"model":"last"}]');
    expect(intent.groups[0]!.changes![0]!.after).toBe('[{"model":"same"},{"model":"last"},{"model":"same"}]');
    expect(intent.groups[0]!.changes![0]!.children).toBeUndefined();
  });

  it.each([{ columns: 60, rows: 18 }, { columns: 80, rows: 24 }])('writes the edited array through Controller and the real v5 writer at $columns x $rows', async (size) => {
    const { ui, controller, store, record } = await setup('labels', size);
    await keys(ui, '\r', '\u0015', 'docs', '\r', 'c', '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'), { timeout: 5000 });
    await keys(ui, 's');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('review'), { timeout: 5000 });
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('只保存'), { timeout: 5000 });
    await record('review');
    await keys(ui, '\r');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('result'), { timeout: 5000 });
    expect(controller.snapshot.result).toMatchObject({ state: 'succeeded' });
    await record('result');
    const saved = await store('project');
    expect(saved.values.labels).toEqual(['docs', 'tests']);
    const envelope = await fs.readJson(saved.path);
    expect(envelope.schemaVersion).toBe(5);
    expect(envelope.values).toEqual({ labels: ['docs', 'tests'] });
  });

  it('rejects an old working list after an external complete-value change', async () => {
    const { ui, controller, dependencies, isolation, store } = await setup();
    await keys(ui, '\r', '\u0015', 'docs', '\r', 'c', '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'), { timeout: 5000 });
    const evidence = await dependencies.captureEvidence({ kind: 'configSaveBatch', pluginId: 'team/arrays', apply: false, groups: [{ scope: 'project', updates: { labels: ['external'] } }] });
    await writePluginConfigStore({ sourceId: 'team', sourceIdentity: evidence.source!.sourceIdentity, logicalIdentity: evidence.source!.logicalIdentity, pluginName: 'arrays', scope: 'project', values: { labels: ['external'] }, cwd: isolation.layout.fixtureCwd, env: isolation.env });
    await keys(ui, 's');
    await vi.waitFor(() => expect(controller.snapshot.reviewPreparation?.state).toBe('failed'), { timeout: 5000 });
    expect(controller.snapshot.activeReview).toBeUndefined();
    expect((await store('project')).values.labels).toEqual(['external']);

  });
});
