import path from 'node:path';
import fs from 'fs-extra';
import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type OperationIntent } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readPluginConfigStore, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createConfigV4Definition } from '../helpers/config-v4-fixture.js';
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
  const v4 = fieldKey === 'subagentCommands' || fieldKey === 'advisorProfile';
  await createCatalogSnapshotFixture(sourceRoot, 'arrays', [], 'array fixture', (manifest) => {
    manifest.config = { schemaVersion: v4 ? 4 : 3, fields: {
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
    if (v4) {
      const definition = createConfigV4Definition();
      const commands = definition.fields.subagentCommands!;
      if (commands.type !== 'array') throw new Error('Expected array fixture');
      definition.fields.subagentCommands = { ...commands, title: '执行器', default: [{
        key: 'demo', title: '演示', adapter: 'custom', mode: 'bundle', command: '/bin/example', entrypoint: '/tmp/entry.mjs',
        args: ['--engine', 'api'], env: { EMPTY: '' }, envFrom: { TOKEN: 'HOST_TOKEN' },
      }] };
      const profile = definition.fields.advisorProfile!;
      if (profile.type !== 'object') throw new Error('Expected object fixture');
      definition.fields.advisorProfile = { ...profile, title: '角色', default: { executor: 'demo' } };
      manifest.config = definition;
    }
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
  controller.push({ name: 'configFieldEditor', pluginId: 'team/arrays', layer: { scope: 'effective' }, fieldKey, editor: fieldKey === 'advisorProfile' ? 'object' : 'array', ...(fieldKey === 'fixed' ? { mode: 'choices' as const } : {}) });
  const ui = render(<ConsoleAppV4 controller={controller} size={size} />);
  await vi.waitFor(() => expect(ui.lastFrame()).toContain(fieldKey === 'fixed' ? '第一方案' : fieldKey === 'advisorProfile' ? '使用此完整对象' : '添加一项'), { timeout: 5000 });
  const store = async (scope: 'user' | 'project') => {
    const evidence = await dependencies.captureEvidence({ kind: 'configSaveBatch', pluginId: 'team/arrays', apply: false,
      groups: [{ scope, updates: v4 ? { subagentCommands: [] } : { labels: ['safe'] } }] });
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
  it('previews branch removals, cancels a switch and saves a builtin without injecting its fixed mode', async () => {
    const { ui, controller, captured, store } = await setup('subagentCommands', { columns: 80, rows: 24 });
    await keys(ui, '\r', down, down, '\r', '\r', '\r');
    expect(ui.lastFrame()).toContain('确认分支切换');
    expect(ui.lastFrame()).toContain('mode = "bundle"');
    expect(ui.lastFrame()).toContain('command = "/bin/example"');
    expect((await store('project')).exists).toBe(false);
    await keys(ui, esc);
    expect(controller.snapshot.router.current.route).toMatchObject({ name: 'configFieldEditor', editor: 'object' });
    await keys(ui, '\r', '\r', '\r', '\r');
    expect(controller.snapshot.router.current.route).toMatchObject({ editor: 'object' });
    await keys(ui, down, down, down, down);
    expect(ui.lastFrame()).toContain('workspace');
    await keys(ui, '\r');
    expect(controller.snapshot.router.current.route).toMatchObject({ editor: 'array' });
    await keys(ui, 'c', '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'), { timeout: 5000 });
    await keys(ui, 's');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('review'), { timeout: 5000 });
    const intent = captured.at(-1)!;
    expect(intent).toMatchObject({ groups: [{ updates: { subagentCommands: [{
      key: 'demo', title: '演示', adapter: 'codex', args: ['--engine', 'api'], env: { EMPTY: '' }, envFrom: { TOKEN: 'HOST_TOKEN' },
    }] } }] });
    if (intent.kind !== 'configSaveBatch') throw new Error('Expected config batch');
    expect(intent.groups[0]!.updates!.subagentCommands).toEqual([{
      key: 'demo', title: '演示', adapter: 'codex', args: ['--engine', 'api'], env: { EMPTY: '' }, envFrom: { TOKEN: 'HOST_TOKEN' },
    }]);
    expect(intent.groups[0]!.changes![0]!.after).toContain('"args":["--engine","api"]');
    expect((await store('project')).exists).toBe(false);
    await keys(ui, '\r');
    await vi.waitFor(() => expect(controller.snapshot.result).toMatchObject({ state: 'succeeded' }), { timeout: 5000 });
    expect((await store('project')).values.subagentCommands).toEqual(intent.groups[0]!.updates!.subagentCommands);
  });

  it.each([{ columns: 60, rows: 18 }, { columns: 80, rows: 24 }])('edits argv and environment entries as typed containers and saves whole values at $columns x $rows', async (size) => {
    const { ui, controller, store } = await setup('subagentCommands', size);
    await keys(ui, '\r', down, down, down, '\r', '\r');
    expect(ui.lastFrame()).toContain('实际后端 argv');
    await keys(ui, '\r', '\u0015', '  --literal=${VALUE}  ', '\r', 'a', '\r', '\r');
    expect(ui.lastFrame()).toContain('空字符串');
    await keys(ui, 'c', down, '\r', '\r', '\r', 'literal-value', '\r', 'a', '\r', 'NEW_ENV', '\r', '\r', 'c');
    expect(controller.snapshot.router.current.route, ui.lastFrame()).toMatchObject({ name: 'configFieldEditor', editor: 'object' });
    await keys(ui, down, '\r', '\r', '\r', '\u0015', 'NEW_HOST_TOKEN', '\r', 'c', 'c', 'c', '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'), { timeout: 5000 });
    await keys(ui, 's');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route.name, ui.lastFrame()).toBe('review'), { timeout: 5000 });
    expect((await store('project')).exists).toBe(false);
    await keys(ui, '\r');
    await vi.waitFor(() => expect(controller.snapshot.result).toMatchObject({ state: 'succeeded' }), { timeout: 5000 });
    const saved = await store('project');
    expect(saved.values.subagentCommands).toEqual([{
      key: 'demo', title: '演示', adapter: 'custom', mode: 'bundle', command: '/bin/example', entrypoint: '/tmp/entry.mjs',
      args: ['  --literal=${VALUE}  ', 'api', ''], env: { EMPTY: 'literal-value', NEW_ENV: '' }, envFrom: { TOKEN: 'NEW_HOST_TOKEN' },
    }]);
    expect((await fs.readJson(saved.path)).schemaVersion).toBe(5);
  });

  it('cancels row, nested container, parent object and complete-array working copies independently', async () => {
    const { ui, controller, store } = await setup('subagentCommands');
    await keys(ui, '\r', down, down, down, '\r', '\r', '\r', '\u0015', 'discard-row', esc);
    expect(ui.lastFrame()).toContain('--engine');
    await keys(ui, '\r', '\u0015', 'discard-property', '\r', esc);
    expect(controller.snapshot.router.current.route).toMatchObject({ editor: 'object' });
    await keys(ui, '\r', '\r');
    expect(ui.lastFrame()).toContain('--engine');
    expect(ui.lastFrame()).not.toContain('discard-property');
    await keys(ui, '\r', '\u0015', 'discard-object', '\r', 'c', esc, '\r', down, down, down, '\r', '\r');
    expect(ui.lastFrame()).toContain('--engine');
    expect(ui.lastFrame()).not.toContain('discard-object');
    await keys(ui, '\r', '\u0015', 'discard-array', '\r', 'c', 'c', esc);
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    expect(controller.externalDrafts).toHaveLength(0);
    expect((await store('project')).exists).toBe(false);
  });

  it('rejects an invalid environment key in the real KV editor before it enters the parent draft', async () => {
    const { ui, controller } = await setup('subagentCommands');
    await keys(ui, '\r', down, down, down, down, down, '\r', '\r', 'a', '\r', 'BAD-NAME', '\r');
    expect(ui.lastFrame()).toContain('输入新键名');
    expect(ui.lastFrame()).toContain('BAD-NAME');
    await keys(ui, esc, 'c');
    expect(controller.snapshot.router.current.route).toMatchObject({ editor: 'object' });
  });

  it('uses missing/native and otherwise/external branches to change required profile fields', async () => {
    const { ui, controller } = await setup('advisorProfile');
    expect(ui.lastFrame()).not.toContain('必填');
    await keys(ui, '\r', '\r', '\u0015', 'native', '\r');
    expect(ui.lastFrame()).toContain('确认分支切换');
    await keys(ui, '\r', 'c');
    expect(controller.snapshot.router.current.route).toMatchObject({ editor: 'object' });
    expect(ui.lastFrame()).toContain('model');
    expect(ui.lastFrame()).toContain('必填');
    await keys(ui, '\r', down, '\r');
    expect(ui.lastFrame()).toContain('确认分支切换');
    await keys(ui, '\r', 'c');
    expect(controller.snapshot.router.current.route).toMatchObject({ editor: 'object' });
    expect(ui.lastFrame()).toContain('必填');
  });

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
    const longValue = `${'model-'.repeat(Math.floor(size.columns / 6))}中文属性完整末尾`;
    await keys(ui, '\r', '\r', '\u0015', longValue, '\r');
    const lines = ui.lastFrame()!.split('\n');
    expect(lines.length).toBeLessThanOrEqual(size.rows);
    expect(lines.filter((line) => line.trimStart().startsWith('╭'))).toHaveLength(2);
    for (const line of lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(size.columns);
      const trimmed = line.trim();
      if (trimmed.startsWith('╭')) expect(trimmed.endsWith('╮')).toBe(true);
      if (trimmed.startsWith('│')) expect(trimmed.endsWith('│')).toBe(true);
      if (trimmed.startsWith('╰')) expect(trimmed.endsWith('╯')).toBe(true);
    }
    const firstCardEnd = lines.findIndex((line) => line.trimStart().startsWith('╰'));
    const valueLines = lines.slice(0, firstCardEnd).filter((line) => line.trimStart().startsWith('│'));
    expect(valueLines).toHaveLength(2);
    expect(valueLines.map((line) => line.trim().slice(1, -1).trim()).join('')).toBe(longValue);
    await record('object-item');
    await keys(ui, esc);
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
