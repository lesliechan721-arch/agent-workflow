import path from 'node:path';
import fs from 'fs-extra';
import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { writePreferences } from '../../src/intent/deployment-preferences.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type OperationIntent } from '../../src/tui/controller.js';
import { createTuiControllerDependencies } from '../../src/tui/controller-runtime.js';
import { readCatalogSourcesConfigSnapshot, replaceCatalogSourcesConfig } from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readPluginConfigStore, writePluginConfigStore } from '../../src/utils/plugin-config.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { createConfigV4Definition } from '../helpers/config-v4-fixture.js';
import { focusAction } from '../helpers/tui-console-app-input.js';
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
const up = '\u001b[A';
const esc = '\u001b';

async function setup(fieldKey = 'labels', size = { columns: 60, rows: 18 }, withSuggestions = false) {
  const isolation = getCurrentSourceTestIsolation();
  const sourceRoot = path.join(isolation.layout.fixtureCwd, 'array-source');
  const probeModePath = path.join(isolation.layout.fixtureCwd, 'probe-mode');
  if (withSuggestions) {
    await fs.outputFile(probeModePath, fieldKey === 'suggested' ? 'slow' : 'ok');
    await fs.outputFile(path.join(sourceRoot, 'plugins', 'arrays', 'scripts', 'suggestions.mjs'), `
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const request = JSON.parse(readFileSync(0, 'utf8'));
const mode = readFileSync(join(request.cwd, 'probe-mode'), 'utf8');
if (mode === 'slow') await delay(8000);
if (mode === 'invalid') {
  while (!existsSync(join(request.cwd, 'release-suggestions'))) await delay(10);
}
const id = request.dependencyValues.id ?? 'top';
const provider = request.providerConfigValues.providers?.[0]?.id ?? 'unknown';
const value = id + '/' + provider;
console.log(JSON.stringify(mode === 'offline'
  ? { schemaVersion: 1, status: 'unavailable', items: [], message: 'Provider offline' }
  : { schemaVersion: 1, status: 'ok', items: [{
    value: mode === 'invalid' ? 123 : value,
    title: mode === 'invalid' ? 'Wrong model type' : value,
  }] }));
`);
  }
  const v4 = fieldKey === 'subagentCommands' || fieldKey === 'advisorProfile';
  await createCatalogSnapshotFixture(sourceRoot, 'arrays', [], 'array fixture', (manifest) => {
    manifest.config = { schemaVersion: 5, fields: {
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
    if (fieldKey === 'workers' || fieldKey === 'worker' || withSuggestions) {
      const suggestion = {
        type: 'string' as const, title: 'Model picker', suggestions: { provider: 'model-list' },
        choices: { allowCustom: true, presets: [{ id: 'baseline', title: 'Static model', value: 'baseline' }] },
      };
      const item = {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, required: true },
          models: {
            type: 'array' as const,
            validation: { minItems: 1, uniqueBy: 'id' },
            items: { type: 'object' as const, properties: {
              id: { type: 'string' as const, required: true },
              efforts: { type: 'array' as const, items: { type: 'string' as const } },
              enabled: { type: 'boolean' as const },
              ...(withSuggestions ? { model: { ...suggestion, suggestions: { provider: 'model-list', dependsOn: ['id'] } } } : {}),
            } },
          },
        },
      };
      const initial = { name: 'worker', models: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }] };
      manifest.config = { schemaVersion: 5, fields: {
        workers: { type: 'array', items: item, default: [initial] },
        worker: { ...item, default: initial },
        ...(withSuggestions ? {
          suggested: suggestion,
          providers: { type: 'array' as const, items: { type: 'object' as const, properties: { id: { type: 'string' as const } } },
            default: [{ id: 'stock' }] },
        } : {}),
      } };
      if (withSuggestions) manifest.scripts = { config: { suggestions: { runner: 'node', path: './scripts/suggestions.mjs' } } };
    }
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
      manifest.config = { ...definition, schemaVersion: 5 };
    }
  });
  const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
  await replaceCatalogSourcesConfig({ config: { schemaVersion: 2, sources: [{ id: 'team', type: 'path', primary: true, path: sourceRoot }] }, expectedDigest: initial.digest, env: isolation.env });
  await syncCatalogSourceGeneration({ sourceId: 'team', cliVersion: '1.0.0', env: isolation.env });
  await writePreferences({ scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env }, {
    schemaVersion: 2, kind: 'aw-deployment-preferences', targets: ['codex'], exclusions: [],
  });
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
  const probeRuns: Array<{ path: (string | number)[]; signal?: AbortSignal }> = [];
  const getSuggestions = dependencies.getConfigSuggestions;
  if (withSuggestions && getSuggestions) {
    dependencies.getConfigSuggestions = (lookup, run, signal) => getSuggestions(lookup, (prepared) => run({
      ...prepared,
      run: (runSignal) => {
        probeRuns.push({ path: lookup.fieldPath, signal: runSignal });
        return prepared.run(runSignal);
      },
    }), signal);
  }
  const controller = new TuiController(dependencies);
  await controller.load();
  controller.push({ name: 'configFields', pluginId: 'team/arrays', layer: { profile: 'codex' } });
  const objectField = fieldKey === 'advisorProfile' || fieldKey === 'worker';
  controller.push({ name: 'configFieldEditor', pluginId: 'team/arrays', layer: { profile: 'codex' }, fieldKey,
    editor: fieldKey === 'suggested' ? 'string' : objectField ? 'object' : 'array',
    ...(fieldKey === 'fixed' || fieldKey === 'suggested' ? { mode: 'choices' as const } : {}) });
  const ui = render(<ConsoleAppV4 controller={controller} size={size} />);
  await vi.waitFor(() => {
    const frame = ui.lastFrame();
    if (fieldKey === 'fixed') expect(frame).toContain('第一方案');
    else if (fieldKey === 'suggested') expect(frame).toContain('Static model');
    else if (objectField) expect(frame).toContain('使用此完整对象');
    else {
      expect(frame).toContain('添加一项');
      // The add action is visible before initial rows load; a real first row proves editing is ready.
      if (fieldKey !== 'empty') expect(frame).toMatch(/\b01 {2}\S/u);
      else expect(frame).toContain('0 项');
    }
  }, { timeout: 5000 });
  if (fieldKey === 'empty') {
    // An empty list has no initial row. A cancelled new-item edit proves readiness without creating a draft.
    await keys(ui, '\r');
    await vi.waitFor(() => {
      expect(controller.snapshot.router.current.route).toMatchObject({
        name: 'configFieldEditor', editor: 'string', arrayItem: { rowId: undefined },
      });
      expect(ui.lastFrame()).toContain('新增项');
    });
    await keys(ui, esc);
    await vi.waitFor(() => {
      expect(controller.snapshot.router.current.route).toMatchObject({ name: 'configFieldEditor', editor: 'array' });
      expect(ui.lastFrame()).toContain('0 项');
      expect(controller.externalDrafts).toHaveLength(0);
    });
  }
  const store = async (profile: 'common' | 'codex') => {
    const platform = profile === 'common' ? undefined : profile;
    const evidence = await dependencies.captureEvidence({ kind: 'configSaveBatch', pluginId: 'team/arrays', apply: false,
      groups: [{ scope: 'user', platform, removeKeys: [fieldKey] }] });
    return readPluginConfigStore({ sourceId: 'team', sourceIdentity: evidence.source!.sourceIdentity, logicalIdentity: evidence.source!.logicalIdentity, pluginName: 'arrays', scope: 'user', platform, cwd: isolation.layout.fixtureCwd, env: isolation.env });
  };
  const record = async (name: string) => {
    if (!process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) return;
    await fs.outputJson(path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `array-${name}-${size.columns}x${size.rows}.json`), {
      synthetic: true, size, route: controller.snapshot.router.current.route, frame: ui.lastFrame(),
    }, { spaces: 2 });
  };
  await record(`list-${fieldKey}`);
  return { ui, controller, dependencies, captured, isolation, store, record, probeRuns, probeModePath };
}

describe('array editor with real config runtime', () => {
  it('edits a nested model list, validates exact paths and saves the confirmed ordered value', async () => {
    const { ui, captured, store } = await setup('workers', { columns: 80, rows: 24 });
    await keys(ui, '\r');
    expect(ui.lastFrame()).toContain('3 项 · alpha · beta');
    expect(ui.lastFrame()).not.toContain('gamma');
    await keys(ui, down, '\r');
    expect(ui.lastFrame()).toContain('03  id=gamma');

    // Add a duplicate and confirm the error points to the new row's id.
    await keys(ui, 'a', '\r', '\r', 'alpha', '\r', 'c', 'c');
    expect(ui.lastFrame()).toContain('workers[0].models[3].id');
    expect((await store('codex')).exists).toBe(false);

    // Repair the new row, and add a scalar array and boolean in its object editor.
    await keys(ui, '\r', '\r', '\r', '\u0015', 'delta', '\r',
      down, '\r', 'a', '\r', 'high', '\r', 'c', down, '\r', '\r', 'c');
    expect(ui.lastFrame()).not.toContain('workers[0].models[3].id');

    // Move delta up and back down, then remove beta.
    await keys(ui, 'a', down, '\r', '\r');
    expect(ui.lastFrame()).toContain('03  id=delta');
    await keys(ui, 'a', down, '\r', down, '\r');
    expect(ui.lastFrame()).toContain('04  id=delta');
    await keys(ui, up, up, 'a', down, '\r', down, down, '\r');
    await keys(ui, 'c');
    expect(ui.lastFrame()).toContain('3 项 · alpha · gamma');
    expect((await store('codex')).exists).toBe(false);
    await keys(ui, 'c', 'c');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'));
    expect((await store('codex')).exists).toBe(false);
    await keys(ui, 's');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('已保存，是否更新插件？'), { timeout: 5000 });
    const value = [{ name: 'worker', models: [{ id: 'alpha' }, { id: 'gamma' }, {
      id: 'delta', efforts: ['high'], enabled: true,
    }] }];
    expect(captured.at(-1)).toMatchObject({ kind: 'configSaveBatch', groups: [{ updates: { workers: value } }] });
    expect((await store('codex')).values.workers).toEqual(value);
  });

  it('cancels a nested model list while retaining parent and overview drafts', async () => {
    const { ui, store } = await setup('worker');
    await keys(ui, '\r', '\r', '\u0015', 'staged', '\r', 'c');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'));
    await keys(ui, '\r', '\r', '\r', '\u0015', 'parent', '\r');
    await keys(ui, down, '\r', 'a', down, '\r', down, down, '\r');
    expect(ui.lastFrame()).toContain('02  id=gamma');
    await keys(ui, esc);
    expect(ui.lastFrame()).toContain('parent');
    expect(ui.lastFrame()).toContain('3 项 · alpha · beta');
    await keys(ui, esc);
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('staged'));
    expect((await store('codex')).exists).toBe(false);
  });

  it('keeps manual input available during slow suggestions and aborts when the field closes', async () => {
    const { ui, controller, dependencies, probeRuns, probeModePath, store } = await setup('suggested', { columns: 70, rows: 20 }, true);
    await vi.waitFor(() => {
      expect(probeRuns).toHaveLength(1);
      expect(ui.lastFrame()).toContain('正在获取动态建议');
    });
    expect(ui.lastFrame()).toContain('Static model');
    await keys(ui, '\r', 'manual-r', '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'));
    expect(probeRuns[0]!.signal?.aborted).toBe(true);
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    await keys(ui, 's');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('已保存，是否更新插件？'), { timeout: 5000 });
    expect((await store('codex')).values.suggested).toBe('manual-r');

    // Simulate the result of a provider finishing after the cancellation arrived.
    await keys(ui, esc);
    const getSuggestions = dependencies.getConfigSuggestions!;
    let delayed: { signal?: AbortSignal; deliver: () => void } | undefined;
    dependencies.getConfigSuggestions = (lookup, run, signal) => getSuggestions(lookup,
      (prepared) => run({ ...prepared, run: (runSignal) => new Promise((resolve) => {
        delayed = { signal: runSignal, deliver: () => resolve({
          schemaVersion: 1, status: 'ok', items: [{ title: 'Expired model', value: 'expired' }],
        }) };
      }) }), signal);
    const openSuggestions = () => controller.push({
      name: 'configFieldEditor', pluginId: 'team/arrays', layer: { profile: 'codex' },
      fieldKey: 'suggested', editor: 'string', mode: 'choices',
    });
    openSuggestions();
    await vi.waitFor(() => expect(delayed).toBeDefined(), { timeout: 5000 });
    await keys(ui, esc);
    expect(delayed!.signal?.aborted).toBe(true);
    dependencies.getConfigSuggestions = getSuggestions;
    await fs.writeFile(probeModePath, 'ok');
    openSuggestions();
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('top/stock'), { timeout: 5000 });
    delayed!.deliver();
    await turn();
    expect(ui.lastFrame()).toContain('top/stock');
    expect(ui.lastFrame()).not.toContain('Expired model');
  });

  it('uses live sibling and unsaved provider values and refreshes cached suggestions', async () => {
    const { ui, controller, probeRuns, probeModePath, store } = await setup('workers', { columns: 80, rows: 24 }, true);
    const openArray = async (fieldKey: string, value: string) => {
      controller.push({ name: 'configFieldEditor', pluginId: 'team/arrays', layer: { profile: 'codex' }, fieldKey, editor: 'array' });
      await vi.waitFor(() => expect(ui.lastFrame()).toContain(`01  ${value}`));
      await focusAction(ui, `01  ${value}`);
    };
    await keys(ui, esc);
    await openArray('providers', 'id=stock');
    await keys(ui, '\r', '\r', '\r', '\u0015', 'drafted', '\r', 'c', 'c');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'));
    expect((await store('codex')).exists).toBe(false);
    await openArray('workers', 'name=worker');
    await keys(ui, '\r', down, '\r', '\r', down, down, down, '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('alpha/drafted'), { timeout: 5000 });
    expect(ui.lastFrame()).not.toContain('Static model');
    expect(probeRuns.map((run) => run.path)).toEqual([['workers', 0, 'models', 0, 'model']]);

    await keys(ui, esc, '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('alpha/drafted'), { timeout: 5000 });
    expect(probeRuns).toHaveLength(1);
    await keys(ui, esc, up, up, up, '\r', '\r', '\u0015', 'changed', '\r', down, down, down, '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('changed/drafted'), { timeout: 5000 });
    expect(probeRuns).toHaveLength(2);

    await fs.writeFile(probeModePath, 'offline');
    await keys(ui, 'r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('Provider offline'), { timeout: 5000 });
    expect(ui.lastFrame()).toContain('Static model');
    expect(probeRuns).toHaveLength(3);
    await fs.writeFile(probeModePath, 'ok');
    await keys(ui, esc, '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('changed/drafted'), { timeout: 5000 });
    expect(probeRuns).toHaveLength(4);
    await focusAction(ui, 'changed/drafted');
    await keys(ui, '\r');
    expect(ui.lastFrame()).toContain('changed/drafted');
    expect((await store('codex')).exists).toBe(false);

    await fs.writeFile(probeModePath, 'invalid');
    await keys(ui, '\r', '\r', 'r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('正在获取动态建议'));
    await focusAction(ui, 'Static model');
    await fs.ensureFile(path.join(path.dirname(probeModePath), 'release-suggestions'));
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('没有动态建议'), { timeout: 5000 });
    expect(ui.lastFrame()).toMatch(/› [○●◆] Static model/u);
    expect(ui.lastFrame()).not.toContain('Wrong model type');
  });

  it('previews branch removals, cancels a switch and saves a builtin without injecting its fixed mode', async () => {
    const { ui, controller, captured, store } = await setup('subagentCommands', { columns: 80, rows: 24 });
    await keys(ui, '\r', down, down, '\r', '\r', '\r');
    expect(ui.lastFrame()).toContain('确认分支切换');
    expect(ui.lastFrame()).toContain('mode = "bundle"');
    expect(ui.lastFrame()).toContain('command = "/bin/example"');
    expect((await store('codex')).exists).toBe(false);
    await keys(ui, esc);
    expect(controller.snapshot.router.current.route).toMatchObject({ name: 'configFieldEditor', editor: 'object' });
    await keys(ui, '\r', '\r', '\r', '\r');
    expect(controller.snapshot.router.current.route).toMatchObject({ editor: 'object' });
    await keys(ui, down, down, down, down);
    expect(ui.lastFrame()).toContain('workspace');
    await keys(ui, '\r');
    expect(controller.snapshot.router.current.route).toMatchObject({ editor: 'array' });
    await keys(ui, 'c');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'), { timeout: 5000 });
    await keys(ui, 's');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('已保存，是否更新插件？'), { timeout: 5000 });
    const intent = captured.at(-1)!;
    expect(intent).toMatchObject({ groups: [{ updates: { subagentCommands: [{
      key: 'demo', title: '演示', adapter: 'codex', args: ['--engine', 'api'], env: { EMPTY: '' }, envFrom: { TOKEN: 'HOST_TOKEN' },
    }] } }] });
    if (intent.kind !== 'configSaveBatch') throw new Error('Expected config batch');
    expect(intent.groups[0]!.updates!.subagentCommands).toEqual([{
      key: 'demo', title: '演示', adapter: 'codex', args: ['--engine', 'api'], env: { EMPTY: '' }, envFrom: { TOKEN: 'HOST_TOKEN' },
    }]);
    expect(intent.groups[0]!.changes![0]!.after).toContain('"args":["--engine","api"]');
    expect(controller.snapshot.activeReview).toBeUndefined();
    await keys(ui, esc);
    expect((await store('codex')).values.subagentCommands).toEqual(intent.groups[0]!.updates!.subagentCommands);
  });

  it.each([{ columns: 60, rows: 18 }, { columns: 80, rows: 24 }])('edits argv and environment entries as typed containers and saves whole values at $columns x $rows', async (size) => {
    const { ui, controller, store } = await setup('subagentCommands', size);
    await keys(ui, '\r', down, down, down, '\r', '\r');
    expect(ui.lastFrame()).toContain('实际后端 argv');
    await keys(ui, '\r', '\u0015', '  --literal=${VALUE}  ', '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).not.toContain('编辑列表项'));
    await keys(ui, 'a', '\r', '\r');
    expect(ui.lastFrame()).toContain('空字符串');
    await keys(ui, 'c', down, '\r', '\r', '\r', 'literal-value', '\r', 'a', '\r', 'NEW_ENV', '\r', '\r', 'c');
    expect(controller.snapshot.router.current.route, ui.lastFrame()).toMatchObject({ name: 'configFieldEditor', editor: 'object' });
    await keys(ui, down, '\r', '\r', '\r', '\u0015', 'NEW_HOST_TOKEN', '\r', 'c', 'c', 'c');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'), { timeout: 5000 });
    await keys(ui, 's');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('已保存，是否更新插件？'), { timeout: 5000 });
    expect(controller.snapshot.activeReview).toBeUndefined();
    await keys(ui, esc);
    const saved = await store('codex');
    expect(saved.values.subagentCommands).toEqual([{
      key: 'demo', title: '演示', adapter: 'custom', mode: 'bundle', command: '/bin/example', entrypoint: '/tmp/entry.mjs',
      args: ['  --literal=${VALUE}  ', 'api', ''], env: { EMPTY: 'literal-value', NEW_ENV: '' }, envFrom: { TOKEN: 'NEW_HOST_TOKEN' },
    }]);
    expect((await fs.readJson(saved.path)).schemaVersion).toBe(6);
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
    expect((await store('codex')).exists).toBe(false);
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
    await keys(ui, '\r', '\r');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('native'));
    await keys(ui, '\r');
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
    controller.push({ name: 'configFieldEditor', pluginId: 'team/arrays', layer: { profile: 'codex' }, fieldKey: 'empty', editor: 'array' });
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('添加一项'), { timeout: 5000 });
    await keys(ui, 'c');
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
  });

  it('restores item order without making a draft and recalculates invalid duplicate indices after deletion', async () => {
    const { ui, controller } = await setup();
    await keys(ui, down, 'a', down, '\r', '\r');
    expect(ui.lastFrame()).toContain('01  tests');
    await keys(ui, 'a', down, '\r', down, '\r', 'c');
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    expect(ui.lastFrame()).not.toContain('待保存');
    controller.push({ name: 'configFieldEditor', pluginId: 'team/arrays', layer: { profile: 'codex' }, fieldKey: 'labels', editor: 'array' });
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
    expect((await store('codex')).exists).toBe(false);
    await keys(ui, 'c');
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'), { timeout: 5000 });
    await keys(ui, 's');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('已保存，是否更新插件？'), { timeout: 5000 });
    expect(captured.at(-1)).toMatchObject({ kind: 'configSaveBatch', groups: [{ updates: { labels: ['docs', 'tests'] } }] });
    expect((await store('codex')).values.labels).toEqual(['docs', 'tests']);
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
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
  });

  it('retains the previous overview draft when a reopened list is cancelled', async () => {
    const { ui, controller, captured } = await setup();
    await keys(ui, '\r', '\u0015', 'docs', '\r', 'c');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'), { timeout: 5000 });
    await keys(ui, '\r', '\r', '\u0015', 'discard', '\r', esc, 's');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('已保存，是否更新插件？'), { timeout: 5000 });
    expect(captured.at(-1)).toMatchObject({ groups: [{ updates: { labels: ['docs', 'tests'] } }] });
  });

  it('allows temporary deletion below minItems but refuses to stage the empty working value', async () => {
    const { ui, controller, store, record } = await setup();
    for (let index = 0; index < 2; index++) await keys(ui, 'a', down, '\r', down, down, '\r');
    expect(ui.lastFrame()).toContain('空列表');
    await keys(ui, 'c');
    expect(controller.snapshot.router.current.route).toMatchObject({ editor: 'array' });
    expect((await store('codex')).exists).toBe(false);
    await record('min-items-error');
  });

  it('shows full ordered before and after lists for duplicate objects without guessing item identity', async () => {
    const { ui, controller, captured } = await setup('repeat');
    await keys(ui, down, down, 'a', down, '\r', '\r', 'c');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'), { timeout: 5000 });
    await keys(ui, 's');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('已保存，是否更新插件？'), { timeout: 5000 });
    const intent = captured.at(-1)!;
    if (intent.kind !== 'configSaveBatch') throw new Error('Expected config batch');
    expect(intent.groups[0]!.updates!.repeat).toEqual([{ model: 'same' }, { model: 'last' }, { model: 'same' }]);
    expect(intent.groups[0]!.changes![0]!.before).toContain('[{"model":"same"},{"model":"same"},{"model":"last"}]');
    expect(intent.groups[0]!.changes![0]!.after).toBe('[{"model":"same"},{"model":"last"},{"model":"same"}]');
    expect(intent.groups[0]!.changes![0]!.children).toBeUndefined();
  });

  it.each([{ columns: 60, rows: 18 }, { columns: 80, rows: 24 }])('writes the edited array through Controller and the real v6 writer at $columns x $rows', async (size) => {
    const { ui, controller, store, record } = await setup('labels', size);
    await keys(ui, '\r');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', editor: 'string', arrayItem: { rowId: expect.any(String) },
    }));
    await keys(ui, '\u0015', 'docs', '\r');
    await vi.waitFor(() => expect(controller.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', editor: 'array',
    }));
    await keys(ui, 'c');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'), { timeout: 5000 });
    await keys(ui, 's');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('已保存，是否更新插件？'), { timeout: 5000 });
    expect(controller.snapshot.activeReview).toBeUndefined();
    await record('saved');
    await keys(ui, esc);
    expect(controller.snapshot.router.current.route.name).toBe('configFields');
    const saved = await store('codex');
    expect(saved.values.labels).toEqual(['docs', 'tests']);
    const envelope = await fs.readJson(saved.path);
    expect(envelope.schemaVersion).toBe(6);
    expect(envelope.common).toEqual({});
    expect(envelope.platforms).toEqual({ codex: { labels: ['docs', 'tests'] } });
  });

  it('rejects an old working list after an external complete-value change', async () => {
    const { ui, controller, dependencies, isolation, store } = await setup();
    await keys(ui, '\r', '\u0015', 'docs', '\r', 'c');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('待保存'), { timeout: 5000 });
    const evidence = await dependencies.captureEvidence({ kind: 'configSaveBatch', pluginId: 'team/arrays', apply: false, groups: [{ scope: 'user', platform: 'codex', updates: { labels: ['external'] } }] });
    await writePluginConfigStore({ sourceId: 'team', sourceIdentity: evidence.source!.sourceIdentity, logicalIdentity: evidence.source!.logicalIdentity, pluginName: 'arrays', scope: 'user', platform: 'codex', values: { labels: ['external'] }, cwd: isolation.layout.fixtureCwd, env: isolation.env });
    await keys(ui, 's');
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('设置未保存'), { timeout: 5000 });
    expect(controller.snapshot.activeReview).toBeUndefined();
    expect((await store('codex')).values.labels).toEqual(['external']);

  });
});
