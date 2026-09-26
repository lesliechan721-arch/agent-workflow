import fs from 'fs-extra';
import path from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import {
  TuiController,
  type OperationEvidence,
  type OperationIntent,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import type { ConfigFieldViewModel, ConfigPageViewModel } from '../../src/tui/model.js';

afterEach(() => cleanup());

const pluginId = 'team/demo';

function status(): TuiStatusLoadResult {
  return {
    payload: {
      schemaVersion: 7,
      catalog: {
        primarySourceId: 'team',
        configDigest: 'sha256:config',
        compositeDigest: 'sha256:composite',
        sources: [{
          id: 'team', identity: 'identity:team', type: 'path', primary: true,
          requestedRef: 'path', freshness: 'active',
        }],
      },
      filters: { plugins: [], platform: 'both', cwd: '/workspace' },
      targets: [],
      errors: [],
    },
    pluginSummaries: [{
      pluginName: 'demo',
      pluginId,
      displayName: 'Demo',
      description: '配置体验测试插件',
      version: '1.0.0',
      supportedTargets: { codex: ['user', 'project'], claude: ['user', 'project'] },
      configFieldCount: 2,
    }],
    configuredSources: [{ id: 'team', type: 'path', primary: true, path: '/catalog', autoCheck: true }],
  };
}

function field(
  key: string,
  layer: ConfigPageViewModel['layer']['scope'],
  options: { userOnly?: boolean } = {},
): ConfigFieldViewModel {
  const projectBlocked = layer === 'project' && options.userOnly === true;
  return {
    key,
    title: key === 'token' ? '访问令牌' : '运行模式',
    description: key === 'mode' ? '插件声明的常用字段' : undefined,
    type: 'string',
    definition: key === 'token' ? { type: 'string', sensitive: true } : { type: 'string' },
    displayValue: layer === 'effective' ? '团队值' : '未设置',
    required: false,
    sensitive: key === 'token',
    writable: !projectBlocked,
    canSet: !projectBlocked,
    canUnset: false,
    dirty: false,
    inherited: layer !== 'effective',
    configured: layer === 'effective',
    sourceLabel: layer === 'effective' ? '个人默认' : '未设置',
    effectiveDisplayValue: key === 'token' ? '已设置' : '团队值',
    effectiveSourceLabel: '个人默认',
    ...(key === 'mode' ? { effectiveValue: 'team', draftValue: 'team' } : {}),
    allowCustom: true,
    advanced: false,
  };
}

function page(layer: ConfigPageViewModel['layer']): ConfigPageViewModel {
  return {
    pluginId,
    layer,
    storedCount: layer.scope === 'user' ? 2 : 0,
    presets: [{ id: 'declared', title: '插件方案', description: '由 Manifest 声明', values: { mode: 'safe' } }],
    groups: [{
      id: 'main',
      title: '插件设置',
      description: '由 Manifest 声明的分组',
      advanced: false,
      fields: [field('mode', layer.scope), field('token', layer.scope, { userOnly: true })],
    }],
  };
}

function controller(options: {
  affectedTargets?: NonNullable<OperationEvidence['config']>['affectedTargets'];
  impactState?: 'known' | 'unknown';
  failImpactAttempts?: number;
  configPage?: typeof page;
  executeIntent?: TuiControllerDependencies['executeIntent'];
} = {}): { value: TuiController; captured: OperationIntent[] } {
  const captured: OperationIntent[] = [];
  let configImpactAttempts = 0;
  const dependencies: TuiControllerDependencies = {
    loadStatus: vi.fn().mockResolvedValue(status()),
    captureEvidence: vi.fn(async (intent: OperationIntent) => {
      captured.push(intent);
      if ((intent.kind === 'configSave' || intent.kind === 'configSaveBatch')
        && configImpactAttempts < (options.failImpactAttempts ?? 0)) {
        configImpactAttempts += 1;
        throw new Error('impact read failed');
      }
      if (intent.kind === 'configSaveBatch') {
        return {
          catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
          configBatch: {
            groups: intent.groups.map((group) => ({
              scope: group.scope,
              targetFingerprint: `sha256:${group.scope}`,
              config: {
                scope: group.scope,
                storeDigest: `sha256:store:${group.scope}`,
                impactState: options.impactState ?? 'known',
                affectedTargets: options.affectedTargets ?? [{ platform: 'codex', scope: group.scope }],
              },
            })),
          },
        };
      }
      return {
        catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
        config: {
          scope: intent.kind === 'configSave' ? intent.scope : 'project',
          storeDigest: 'sha256:store',
          impactState: options.impactState ?? 'known',
          affectedTargets: options.affectedTargets ?? [],
        },
      };
    }),
    getConfigPage: vi.fn(async (_pluginId, layer) => (options.configPage ?? page)(layer)),
    executeIntent: options.executeIntent ?? vi.fn(),
  };
  return { value: new TuiController(dependencies), captured };
}

async function nextTurn(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function input(instance: ReturnType<typeof render>, ...values: string[]): Promise<void> {
  for (const value of values) {
    instance.stdin.write(value);
    await nextTurn(2);
    if (value === '\u001b') {
      await new Promise((resolve) => setTimeout(resolve, 80));
      await nextTurn(2);
    }
  }
}

async function openChangedProjectSave(value: TuiController, columns: number, rows: number) {
  value.push({ name: 'configFields', pluginId, layer: { scope: 'effective' } });
  value.push({
    name: 'configFieldEditor', pluginId, layer: { scope: 'effective' },
    fieldKey: 'mode', editor: 'string', mode: 'custom',
  });
  const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
  await nextTurn(4);
  await input(instance, 'x', '\r');
  expect(value.snapshot.router.current.route.name).toBe('configLayer');
  await input(instance, '\r');
  await nextTurn(4);
  expect(value.snapshot.router.current.route).toMatchObject({
    name: 'configFields', layer: { scope: 'effective' },
  });
  await input(instance, 's');
  expect(value.snapshot.router.current.route.name).toBe('review');
  await nextTurn(4);
  return instance;
}

describe('TUI config experience v7', () => {
  it.each([[60, 18], [80, 24]] as const)(
    'reads every line of an oversized description inside its focused card at %ix%i', async (columns, rows) => {
      const { value } = controller({ configPage: (layer) => {
        const result = page(layer);
        result.presets = [];
        result.groups[0]!.fields[0]!.description = Array.from({ length: 20 }, (_, index) => `完整说明第 ${index + 1} 行`).join('\n');
        return result;
      } });
      await value.load(); value.push({ name: 'configFields', pluginId, layer: { scope: 'effective' } });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(6);
      let seen = instance.lastFrame() ?? '';
      expect(seen).toContain('PgUp/PgDn 卡片全文');
      for (let index = 0; index < 12; index += 1) {
        await input(instance, '\u001b[6~');
        const current = instance.lastFrame() ?? '';
        expect(current.split('\n').length).toBeLessThanOrEqual(rows);
        expect(current).toContain('› 运行模式');
        seen += current;
      }
      for (let index = 1; index <= 20; index += 1) expect(seen).toContain(`完整说明第 ${index} 行`);
      await input(instance, '?');
      expect(instance.lastFrame()).toContain('PgUp/PgDn 卡片全文');
      expect(instance.lastFrame()).not.toContain('←→ 分组');
      await input(instance, '\u001b');
      await input(instance, '\u001b[B');
      expect(instance.lastFrame()).toContain('› 访问令牌');
      expect(instance.lastFrame()).not.toContain('PgUp/PgDn 卡片全文');
    },
  );

  it.each([[60, 18], [80, 24]] as const)(
    'keeps descriptions inside their config cards and expands only the focused field at %ix%i',
    async (columns, rows) => {
      const { value } = controller({ configPage: (layer) => {
        const result = page(layer);
        result.presets = [];
        result.groups[0]!.fields.forEach((entry, index) => {
          entry.description = `${index}-说明第一行\n${index}-说明第二行\n${index}-说明全文末尾`;
        });
        return result;
      } });
      await value.load(); value.push({ name: 'configFields', pluginId, layer: { scope: 'effective' } });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(6);
      const first = instance.lastFrame() ?? '';
      expect(first).toContain('0-说明全文末尾');
      const lines = first.split('\n');
      const titleLine = lines.findIndex((line) => line.includes('运行模式') && line.includes('╭'));
      const endLine = lines.findIndex((line, index) => index > titleLine && line.includes('╰'));
      expect(lines.slice(titleLine, endLine).join('\n')).toContain('0-说明全文末尾');
      expect(first).not.toContain('1-说明全文末尾');
      expect(lines.length).toBeLessThanOrEqual(rows);
      await input(instance, '\u001b[B');
      const second = instance.lastFrame() ?? '';
      expect(second).toContain('1-说明全文末尾');
      expect(second).not.toContain('0-说明全文末尾');
      expect(second.split('\n').length).toBeLessThanOrEqual(rows);
    },
  );

  it.each([[60, 18], [80, 24]] as const)(
    'returns from save summary to config editing and preserves the draft at %ix%i',
    async (columns, rows) => {
      const { value, captured } = controller();
      await value.load();
      const instance = await openChangedProjectSave(value, columns, rows);
      await input(instance, '\u001b');
      expect(value.snapshot.router.current.route.name).toBe('configFields');
      expect(instance.lastFrame()).not.toContain('放弃未保存修改？');
      await input(instance, 's', '\u001b[B', '\r');
      await nextTurn(4);
      expect(captured.at(-1)).toMatchObject({
        kind: 'configSaveBatch', groups: [{ scope: 'project', updates: { mode: 'teamx' } }],
      });
    },
  );

  it.each([[60, 18], [80, 24]] as const)(
    'keeps each current config value and its source readable at %ix%i',
    async (columns, rows) => {
      const { value } = controller();
      await value.load();
      value.push({ name: 'pluginDetail', pluginId });
      value.beginConfigFlow(pluginId);
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(4);

      expect(instance.lastFrame()).toContain('[个人默认]');
      if (process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) await fs.outputJson(path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR, `config-${columns}x${rows}.json`), { synthetic: true, size: { columns, rows }, frame: instance.lastFrame() }, { spaces: 2 });
      expect((instance.lastFrame() ?? '').match(/团队值/gu)).toHaveLength(1);
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    },
  );

  it('starts with effective values, edits before choosing an explicit legal destination', async () => {
    const { value } = controller();
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('插件设置');
    expect(instance.lastFrame()).toContain('团队值');
    expect(instance.lastFrame()).toContain('个人默认');
    await input(instance, '\r');
    await nextTurn(4);

    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', layer: { scope: 'effective' }, fieldKey: 'mode',
    });
    await input(instance, 'strict', '\r');
    await nextTurn(4);
    expect(value.snapshot.router.current.route.name).toBe('configLayer');
    expect(instance.lastFrame()).toContain('当前项目');
    expect(instance.lastFrame()).toContain('个人默认');
    expect(instance.lastFrame()).toContain('修改仅对当前项目生效');
    expect(instance.lastFrame()).toContain('影响个人的所有项目');
    await input(instance, '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', layer: { scope: 'effective' },
    });
    expect(instance.lastFrame()).toContain('待保存到当前项目');
    expect(instance.lastFrame()).toContain('strict');
  });

  it('returns a preset target to the original config overview in the same flow', async () => {
    const { value } = controller();
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId);
    const flowId = value.snapshot.router.currentFlowId;
    const overviewFrameId = value.snapshot.router.currentFrameId;
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u001B[C', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configLayer', presetId: 'declared' });
    await input(instance, '\r');
    await nextTurn(3);

    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(value.snapshot.router.currentFrameId).toBe(overviewFrameId);
    expect(value.snapshot.router.currentFlowId).toBe(flowId);
    expect(instance.lastFrame()).toContain('safe');
  });

  it('switches config groups in place with the basic arrow keys', async () => {
    const { value } = controller();
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    const frameId = value.snapshot.router.currentFrameId;
    await input(instance, '\u001B[C');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(value.snapshot.router.currentFrameId).toBe(frameId);
    expect(value.snapshot.router.current.context.configGroupId).toBe('@presets');
    expect(instance.lastFrame()).toContain('插件方案');
    await input(instance, '\u001B[D');
    expect(value.snapshot.router.currentFrameId).toBe(frameId);
    expect(value.snapshot.router.current.context.configGroupId).toBe('main');
    expect(instance.lastFrame()).toContain('运行模式');
  });

  it('keeps a user-only field out of the project destination list', async () => {
    const { value } = controller();
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u001B[B', '\r');
    await nextTurn(4);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', layer: { scope: 'effective' }, fieldKey: 'token',
    });
    await input(instance, 'private-value', '\r');
    await nextTurn(4);
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFields' });
    expect(instance.lastFrame()).toContain('个人默认');
    expect(instance.lastFrame()).toContain('仅可保存到个人默认');
  });

  it('keeps the project target visible in the compact batch save summary', async () => {
    const { value, captured } = controller();
    await value.load();
    const instance = await openChangedProjectSave(value, 60, 18);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('每层独立提交');
    expect(frame).toContain('当前项目');
    expect(frame).toContain('只保存，稍后应用');
    await input(instance, '\u001B[B', '\r');
    await nextTurn(3);
    expect(captured.at(-1)).toMatchObject({
      kind: 'configSaveBatch', apply: false,
      groups: [expect.objectContaining({ scope: 'project', updates: { mode: expect.any(String) } })],
    });
  });

  it('submits the explicit apply choice as a project batch', async () => {
    const { value, captured } = controller({
      affectedTargets: [{ platform: 'codex', scope: 'project' }],
    });
    await value.load();
    const instance = await openChangedProjectSave(value, 80, 24);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('保存并生效');
    expect(frame).toContain('只保存，稍后应用');
    expect(frame).toContain('应用结果单独报告');
    await input(instance, '\r');
    await nextTurn(3);
    expect(captured.at(-1)).toMatchObject({
      kind: 'configSaveBatch', apply: true,
      groups: [expect.objectContaining({ scope: 'project', updates: { mode: expect.any(String) } })],
    });
  });

  it('submits the explicit save-only choice as a project batch', async () => {
    const { value, captured } = controller();
    await value.load();
    const instance = await openChangedProjectSave(value, 80, 24);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('改为只保存，稍后应用');
    await input(instance, '\u001B[B', '\r');
    await nextTurn(3);
    expect(captured.at(-1)).toMatchObject({
      kind: 'configSaveBatch', apply: false,
      groups: [expect.objectContaining({ scope: 'project', updates: { mode: expect.any(String) } })],
    });
  });

});

function objectAndFlagPage(layer: ConfigPageViewModel['layer']): ConfigPageViewModel {
  const profile = { model: 'alpha', effort: 'high', hidden: 7 };
  const definition: ConfigFieldViewModel['definition'] = {
    type: 'object', properties: {
      model: { type: 'string', required: true },
      effort: { type: 'string', required: true },
      hidden: { type: 'number' },
    }, additionalProperties: false,
  };
  return { pluginId, layer, storedCount: layer.scope === 'project' ? 1 : 0, presets: [], groups: [{
    id: 'main', title: '常用', advanced: false, fields: [{
      ...field('profile', layer.scope), title: '模型配置', type: 'object', definition,
      configured: layer.scope !== 'user', canUnset: layer.scope === 'project',
      value: layer.scope === 'user' ? undefined : profile,
      effectiveValue: profile, draftValue: profile, defaultValue: profile,
      displayValue: 'model=alpha · effort=high', effectiveDisplayValue: 'model=alpha · effort=high',
      effectiveSourceLabel: '当前项目',
    }, {
      ...field('enabled', layer.scope), title: '启用', type: 'boolean', definition: { type: 'boolean' },
      configured: false, value: undefined, draftValue: false, effectiveValue: false,
      effectiveDisplayValue: '关闭', effectiveSourceLabel: '默认值',
    }],
  }] };
}

describe('Config v2 direct editing and complete drafts', () => {
  it.each([[60, 18], [80, 24]] as const)('edits an existing object and a second field, shows both changes, and retries only failed apply at %ix%i', async (columns, rows) => {
    const { value, captured } = controller({ configPage: objectAndFlagPage,
      executeIntent: vi.fn(async (intent: OperationIntent) => intent.kind === 'configSaveBatch' ? {
        status: 'partial', groups: [
          { scope: 'project', status: 'failed', configSaved: true, applyRequested: true, applyStatus: 'failed', errorCode: 'configApplyFailed' },
          { scope: 'user', status: 'failed', configSaved: false, applyRequested: true, applyStatus: 'notRequested', errorCode: 'configWriteFailed' },
        ],
      } : { configWrite: 'succeeded', overallState: 'succeeded', apply: { state: 'succeeded', targetResults: [] } }),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(4);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldEditor', fieldKey: 'profile' });
    await input(instance, '\r', '\r', '\u0015', 'beta', '\r');
    await input(instance, '\u001b[B', '\u001b[B', '\u001b[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('configLayer');
    await input(instance, '\r', '\u001b[B', '\r', '\r', '\u001b[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    await input(instance, 's');
    const firstPage = instance.lastFrame() ?? '';
    const pages = [firstPage];
    for (let index = 0; index < 10; index++) {
      await input(instance, '\u001b[6~');
      const page = instance.lastFrame() ?? '';
      if (page === pages.at(-1)) break;
      pages.push(page);
    }
    const summary = pages.join('\n');
    expect(summary).toContain('模型配置');
    expect(summary).toContain('当前项目');
    expect(summary).toContain('beta');
    expect(summary).toContain('启用');
    expect(summary).toContain('个人默认');
    expect(summary).toContain('开启');
    for (const page of pages) expect(page.split('\n').length).toBeLessThanOrEqual(rows);
    expect(value.snapshot.router.current.route.name).toBe('review');
    for (let index = 1; index < pages.length; index++) await input(instance, '\u001b[5~');
    expect(instance.lastFrame()).toBe(firstPage);
    await nextTurn(4);
    expect(captured.at(-1)).toMatchObject({ kind: 'configSaveBatch', groups: [
      { scope: 'project', updates: { profile: { model: 'beta', effort: 'high', hidden: 7 } } },
      { scope: 'user', updates: { enabled: true } },
    ] });
    const review = value.snapshot.activeReview!;
    await value.executeOperation(review.reviewToken);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('已保存 · 应用失败');
    expect(instance.lastFrame()).toContain('保存失败');
    await input(instance, '\r');
    await nextTurn(4);
    expect(captured.at(-1)).toMatchObject({ kind: 'configSave', scope: 'project', retryApply: true, updates: {}, removeKeys: [] });
    await value.executeOperation(value.snapshot.activeReview!.reviewToken);
    await nextTurn(4);
    expect(value.externalDrafts).toEqual([expect.objectContaining({ kind: 'configDraft', owner: pluginId })]);
  });

  it.each([[60, 18], [80, 24]] as const)('uses the declared join while retaining complete object changes at %ix%i', async (columns, rows) => {
    const { value, captured } = controller({ configPage: (layer) => {
      const result = objectAndFlagPage(layer);
      result.groups[0]!.fields[0]!.summary = { kind: 'join', parts: [{ path: '/model' }, { path: '/effort' }], separator: '/', missing: '未设置' };
      return result;
    } });
    await value.load(); value.push({ name: 'pluginDetail', pluginId }); value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(4);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('configFieldEditor');
    await input(instance, '\r', '\r', '\u0015', 'beta', '\r');
    await input(instance, '\u001b[B', '\u001b[B', '\u001b[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('configLayer');
    expect(instance.lastFrame()).toContain('beta/high');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('beta/high');
    await input(instance, 's', '\r');
    await nextTurn(4);
    expect(captured.at(-1)).toMatchObject({ kind: 'configSaveBatch', groups: [expect.objectContaining({
      updates: { profile: { model: 'beta', effort: 'high', hidden: 7 } },
      changes: [expect.objectContaining({ after: '{"model":"beta","effort":"high","hidden":7}' })],
    })] });
  });

  it('cancels only the current property or object and detects a hidden-property change from complete values', async () => {
    const { value, captured } = controller({ configPage: objectAndFlagPage });
    await value.load(); value.push({ name: 'pluginDetail', pluginId }); value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\u001b[B', '\r', '\r', '\u001b[B', '\r');
    await input(instance, '\u001b[A', '\r', '\r', '\r', '\u0015', 'cancel-property', '\u001b');
    expect(value.snapshot.router.current.route.name).toBe('configFieldEditor');
    expect(instance.lastFrame()).toContain('alpha');
    expect(instance.lastFrame()).not.toContain('cancel-property');
    await input(instance, '\r', '\r', '\u0015', 'cancel-object', '\r', '\u001b');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).toContain('1 项待保存');
    await input(instance, '\r', '\u001b[B', '\u001b[B', '\r', '\r', '\u0015', '8', '\r');
    await input(instance, '\u001b[B', '\r', '\r', 's');
    expect(instance.lastFrame()).toContain('个人默认');
    await input(instance, '\u001b[B', '\r'); await nextTurn(4);
    expect(captured.at(-1)).toMatchObject({ kind: 'configSaveBatch', groups: [
      { scope: 'project', updates: { profile: { model: 'alpha', effort: 'high', hidden: 8 } }, changes: [expect.objectContaining({
        before: '{"model":"alpha","effort":"high","hidden":7}', after: '{"model":"alpha","effort":"high","hidden":8}',
      })] },
      { scope: 'user', updates: { enabled: true } },
    ] });
  });

  it('keeps the project effective value above a user draft and retains both target diffs', async () => {
    const { value, captured } = controller({ configPage: (layer) => {
      const next = page(layer);
      const mode = next.groups[0]!.fields[0]!;
      Object.assign(mode, { configured: true, canUnset: true, value: layer.scope === 'user' ? 'old-user' : 'project-live',
        draftValue: layer.scope === 'user' ? 'old-user' : 'project-live', effectiveValue: 'project-live',
        effectiveDisplayValue: 'project-live', effectiveSourceLabel: '当前项目' });
      return next;
    } });
    await value.load(); value.push({ name: 'pluginDetail', pluginId }); value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\r', '\u0015', 'new-user', '\r', '\u001b[B', '\r');
    expect(instance.lastFrame()).toContain('project-live');
    expect((instance.lastFrame() ?? '').replace(/\s/gu, '')).toContain('个人修改不会影响本项目');
    await input(instance, '\r', '\u0015', 'new-project', '\r', '\r', 's');
    expect(instance.lastFrame()).toContain('new-project');
    expect(instance.lastFrame()).toContain('new-user');
    await input(instance, '\u001b[B', '\r'); await nextTurn(4);
    expect(captured.at(-1)).toMatchObject({ kind: 'configSaveBatch', groups: [
      { scope: 'project', updates: { mode: 'new-project' } }, { scope: 'user', updates: { mode: 'new-user' } },
    ] });
  });
});
