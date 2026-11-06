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
import type { ConfigFieldViewModel, ConfigPageViewModel, ConfigProfileKey, ConfigReadOptions } from '../../src/tui/model.js';

import { chooseConfigProfile, chooseConfigSave, focusAction, openConfigSave } from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

const pluginId = 'team/demo';

function status(): TuiStatusLoadResult {
  return {
    payload: {
      schemaVersion: 8,
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
  profile: ConfigProfileKey,
): ConfigFieldViewModel {
  return {
    key,
    title: key === 'token' ? '访问令牌' : '运行模式',
    description: key === 'mode' ? '插件声明的常用字段' : undefined,
    type: 'string',
    definition: key === 'token' ? { type: 'string', sensitive: true } : { type: 'string' },
    displayValue: profile === 'common' ? '团队值' : '未设置',
    required: false,
    sensitive: key === 'token',
    writable: true,
    canSet: true,
    canUnset: false,
    dirty: false,
    inherited: profile !== 'common',
    configured: profile === 'common',
    sourceLabel: profile === 'common' ? '公共配置' : '未设置',
    effectiveDisplayValue: key === 'token' ? '已设置' : '团队值',
    effectiveSourceLabel: '公共配置',
    ...(key === 'mode' ? { effectiveValue: 'team', draftValue: 'team' } : {}),
    allowCustom: true,
    advanced: false,
  };
}

function page(options: ConfigReadOptions): ConfigPageViewModel {
  const profile = options.platform ?? 'common';
  const context = options.context ?? 'user';
  return {
    pluginId, profile, context, layer: { profile, context },
    storedCount: profile === 'common' ? 2 : 0,
    presets: [{ id: 'declared', title: '插件方案', description: '由 Manifest 声明', values: { mode: 'safe' } }],
    groups: [{
      id: 'main',
      title: '插件设置',
      description: '由 Manifest 声明的分组',
      advanced: false,
      fields: [field('mode', profile), field('token', profile)],
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
              scope: 'user', platform: group.platform,
              targetFingerprint: `sha256:${group.platform ?? 'common'}`,
              config: {
                scope: 'user', platform: group.platform, context: intent.context ?? 'user',
                storeDigest: `sha256:store:${group.platform ?? 'common'}`,
                impactState: options.impactState ?? 'known',
                affectedTargets: options.affectedTargets ?? [{ platform: group.platform ?? 'codex', scope: intent.context ?? 'user' }],
              },
            })),
          },
        };
      }
      return {
        catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
        config: {
          scope: 'user',
          ...(intent.kind === 'configSave' ? { platform: intent.platform, context: intent.context ?? 'user' } : {}),
          storeDigest: 'sha256:store',
          impactState: options.impactState ?? 'known',
          affectedTargets: options.affectedTargets ?? [],
        },
      };
    }),
    getConfigPage: vi.fn(async (_pluginId, layer) => (options.configPage ?? page)(layer)),
    executeIntent: options.executeIntent ?? vi.fn(async (intent: OperationIntent) => intent.kind === 'configSaveBatch'
      ? { status: 'succeeded', groups: intent.groups.map((group) => ({ scope: 'user', platform: group.platform,
          status: 'succeeded', configSaved: true, applyRequested: false, applyStatus: 'notRequested' })) }
      : { configWrite: 'succeeded', overallState: 'succeeded', apply: { state: 'succeeded', targetResults: [] } }),
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

async function openChangedProfileSave(value: TuiController, columns: number, rows: number) {
  value.push({ name: 'configFields', pluginId, layer: { profile: 'codex', context: 'project' } });
  value.push({ name: 'configFieldEditor', pluginId, layer: { profile: 'codex', context: 'project' },
    fieldKey: 'mode', editor: 'string', mode: 'custom' });
  const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
  await nextTurn(5); await input(instance, 'x', '\r');
  expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFields', layer: { profile: 'codex', context: 'project' } });
  await openConfigSave(instance, value);
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
      await value.load(); value.push({ name: 'configFields', pluginId, layer: { profile: 'common', context: 'user' } });
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
      await value.load(); value.push({ name: 'configFields', pluginId, layer: { profile: 'common', context: 'user' } });
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

  it.each([[60, 18], [80, 24]] as const)('keeps saved data after declining an apply at %ix%i', async (columns, rows) => {
    const { value, captured } = controller();
    await value.load();
    const instance = await openChangedProfileSave(value, columns, rows);
    await chooseConfigSave(instance, value, 'only');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).not.toContain('放弃未保存修改？');
    expect(instance.lastFrame()).not.toContain('项待保存');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ kind: 'configSaveBatch', apply: false, context: 'project',
      groups: [{ scope: 'user', platform: 'codex', updates: { mode: 'teamx' } }] });
  });

  it.each([[60, 18], [80, 24]] as const)('keeps each current value and source readable at %ix%i', async (columns, rows) => {
    const { value } = controller(); await value.load();
    value.push({ name: 'pluginDetail', pluginId }); value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />); await nextTurn(5);
    expect(instance.lastFrame()).toContain('公共配置');
    expect((instance.lastFrame() ?? '').match(/团队值/gu)).toHaveLength(1);
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    if (process.env.AW_TUI_ACCEPTANCE_TRACE_DIR) await fs.outputJson(path.join(process.env.AW_TUI_ACCEPTANCE_TRACE_DIR,
      `config-${columns}x${rows}.json`), { synthetic: true, size: { columns, rows }, frame: instance.lastFrame() }, { spaces: 2 });
  });

  it('edits directly in the selected profile while preserving deployment context', async () => {
    const { value } = controller(); await value.load(); value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId, { platform: 'codex', context: 'project' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />); await nextTurn(5);
    expect(instance.lastFrame()).toContain('团队值');
    await input(instance, '\r', '\u0015', 'strict', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFields', layer: { profile: 'codex', context: 'project' } });
    expect(instance.lastFrame()).toContain('strict');
    expect(instance.lastFrame()).toContain('1 项待保存');
  });

  it('returns a preset directly to the anchored overview in the same flow', async () => {
    const { value } = controller(); await value.load(); value.push({ name: 'pluginDetail', pluginId }); value.beginConfigFlow(pluginId);
    const flowId = value.snapshot.router.currentFlowId; const frameId = value.snapshot.router.currentFrameId;
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />); await nextTurn(5);
    await input(instance, '\u001b[C', '\r'); await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(value.snapshot.router.currentFlowId).toBe(flowId); expect(value.snapshot.router.currentFrameId).toBe(frameId);
    expect(instance.lastFrame()).toContain('safe');
  });

  it('switches config groups in place with the basic arrow keys', async () => {
    const { value } = controller(); await value.load(); value.push({ name: 'pluginDetail', pluginId }); value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />); await nextTurn(5);
    const frameId = value.snapshot.router.currentFrameId;
    await input(instance, '\u001b[C');
    expect(value.snapshot.router.currentFrameId).toBe(frameId);
    expect(value.snapshot.router.current.context.configGroupId).toBe('@presets');
    expect(instance.lastFrame()).toContain('插件方案');
    await input(instance, '\u001b[D');
    expect(value.snapshot.router.currentFrameId).toBe(frameId);
    expect(value.snapshot.router.current.context.configGroupId).toBe('main');
  });

  it('keeps a sensitive field private when edited from project context', async () => {
    const { value, captured } = controller(); await value.load(); value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId, { platform: 'claude', context: 'project' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />); await nextTurn(5);
    await input(instance, '\u001b[B', '\r', 'private-value', '\r');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).not.toContain('private-value');
    await openConfigSave(instance, value);
    expect(captured[0]).toMatchObject({ kind: 'configSaveBatch', context: 'project', groups: [
      { scope: 'user', platform: 'claude', updates: { token: 'private-value' }, sensitiveKeys: ['token'] },
    ] });
    expect(JSON.stringify(value.snapshot)).not.toContain('private-value');
  });

  it('offers a compact saved dialog after the selected profile is committed', async () => {
    const { value, captured } = controller(); await value.load();
    const instance = await openChangedProfileSave(value, 60, 18);
    expect(instance.lastFrame()).toContain('已保存，是否更新插件？');
    expect(instance.lastFrame()).toContain('暂不更新');
    expect(captured[0]).toMatchObject({ kind: 'configSaveBatch', apply: false,
      groups: [{ scope: 'user', platform: 'codex' }] });
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
  });

  it('starts a separate apply Review after saving the Codex profile', async () => {
    const { value, captured } = controller({ affectedTargets: [{ platform: 'codex', scope: 'project' }] }); await value.load();
    const instance = await openChangedProfileSave(value, 80, 24);
    await chooseConfigSave(instance, value, 'apply');
    expect(captured[0]).toMatchObject({ kind: 'configSaveBatch', apply: false });
    expect(captured.at(-1)).toMatchObject({ kind: 'configSave', platform: 'codex', context: 'project', apply: true, retryApply: true, updates: {} });
  });

  it('declines an update without writing the saved profile again', async () => {
    const executeIntent = vi.fn(async (intent: OperationIntent) => {
      if (intent.kind !== 'configSaveBatch') throw new Error('unexpected intent');
      return { status: 'succeeded', groups: intent.groups.map((group) => ({ scope: 'user', platform: group.platform,
        status: 'succeeded', configSaved: true, applyRequested: false, applyStatus: 'notRequested' })) };
    });
    const { value, captured } = controller({ executeIntent }); await value.load();
    const instance = await openChangedProfileSave(value, 80, 24); await chooseConfigSave(instance, value, 'only');
    expect(executeIntent).toHaveBeenCalledOnce(); expect(captured).toHaveLength(1);
    expect(value.snapshot.activeReview).toBeUndefined();
  });
});

function objectAndFlagPage(options: ConfigReadOptions): ConfigPageViewModel {
  const profile = options.platform ?? 'common'; const context = options.context ?? 'user';
  const object = { model: 'alpha', effort: 'high', hidden: 7 };
  const definition: ConfigFieldViewModel['definition'] = { type: 'object', properties: {
    model: { type: 'string', required: true }, effort: { type: 'string', required: true }, hidden: { type: 'number' },
  }, additionalProperties: false };
  return { pluginId, profile, context, layer: { profile, context }, storedCount: 1, presets: [], groups: [{
    id: 'main', title: '常用', advanced: false, fields: [{
      ...field('profile', profile), title: '模型配置', type: 'object', definition, configured: true, canUnset: true,
      value: object, effectiveValue: object, draftValue: object, defaultValue: object,
      displayValue: 'model=alpha · effort=high', effectiveDisplayValue: 'model=alpha · effort=high',
    }, { ...field('enabled', profile), title: '启用', type: 'boolean', definition: { type: 'boolean' },
      configured: false, value: undefined, draftValue: false, effectiveValue: false,
      effectiveDisplayValue: '关闭', effectiveSourceLabel: '默认值',
    }],
  }] };
}

async function editProperty(instance: ReturnType<typeof render>, property: string, next: string): Promise<void> {
  await focusAction(instance, property); await input(instance, '\r', '\r', '\u0015', next, '\r');
}

async function commitObject(instance: ReturnType<typeof render>): Promise<void> {
  await focusAction(instance, '使用此完整对象'); await input(instance, '\r');
}

describe('Config direct editing and complete drafts', () => {
  it.each([[60, 18], [80, 24]] as const)('keeps complete object changes and a second profile through a separate failed apply at %ix%i', async (columns, rows) => {
    const executeIntent = vi.fn(async (intent: OperationIntent) => intent.kind === 'configSaveBatch'
      ? { status: 'succeeded', groups: intent.groups.map((group) => ({ scope: 'user', platform: group.platform,
          status: 'succeeded', configSaved: true, applyRequested: false, applyStatus: 'notRequested' })) }
      : { configWrite: 'succeeded', overallState: 'partial', apply: { state: 'partial',
          targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'failed', errorCode: 'runtimeApplyFailed' }] } });
    const { value, captured } = controller({ configPage: objectAndFlagPage, executeIntent });
    await value.load(); value.push({ name: 'pluginDetail', pluginId }); value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />); await nextTurn(5);
    await input(instance, '\r'); await editProperty(instance, 'model', 'beta'); await commitObject(instance);
    await chooseConfigProfile(instance, value, 'codex'); await focusAction(instance, '启用'); await input(instance, '\r', '\r');
    await openConfigSave(instance, value);
    expect(captured[0]).toMatchObject({ kind: 'configSaveBatch', apply: false, groups: [
      { scope: 'user', updates: { profile: { model: 'beta', effort: 'high', hidden: 7 } } },
      { scope: 'user', platform: 'codex', updates: { enabled: true } },
    ] });
    await chooseConfigSave(instance, value, 'apply');
    await value.executeOperation(value.snapshot.activeReview!.reviewToken); await nextTurn(5);
    expect(value.snapshot.result).toMatchObject({ state: 'partial', summary: { configApplyRetryAvailable: true } });
    await input(instance, '\r'); await nextTurn(5);
    expect(captured.at(-1)).toMatchObject({ kind: 'configSave', retryApply: true, updates: {} });
    expect(executeIntent).toHaveBeenCalledTimes(2);
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
  });

  it.each([[60, 18], [80, 24]] as const)('uses a declared join while submitting complete object values at %ix%i', async (columns, rows) => {
    const { value, captured } = controller({ configPage: (options) => {
      const result = objectAndFlagPage(options);
      result.groups[0]!.fields[0]!.summary = { kind: 'join', parts: [{ path: '/model' }, { path: '/effort' }], separator: '/', missing: '未设置' };
      return result;
    } });
    await value.load(); value.push({ name: 'pluginDetail', pluginId }); value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />); await nextTurn(5);
    await input(instance, '\r'); await editProperty(instance, 'model', 'beta'); await commitObject(instance);
    expect(instance.lastFrame()).toContain('beta/high'); await openConfigSave(instance, value);
    expect(captured[0]).toMatchObject({ kind: 'configSaveBatch', groups: [expect.objectContaining({
      updates: { profile: { model: 'beta', effort: 'high', hidden: 7 } },
      changes: [expect.objectContaining({ before: '{"model":"alpha","effort":"high","hidden":7}', after: '{"model":"beta","effort":"high","hidden":7}' })],
    })] });
  });

  it('cancels only the current property or object and compares complete hidden-property values', async () => {
    const { value, captured } = controller({ configPage: objectAndFlagPage }); await value.load();
    value.push({ name: 'pluginDetail', pluginId }); value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />); await nextTurn(5);
    await focusAction(instance, '启用'); await input(instance, '\r', '\r');
    await focusAction(instance, '模型配置'); await input(instance, '\r', '\r', '\r', '\u0015', 'cancel-property', '\u001b');
    expect(value.snapshot.router.current.route.name).toBe('configFieldEditor');
    expect(instance.lastFrame()).not.toContain('cancel-property');
    await editProperty(instance, 'model', 'cancel-object'); await input(instance, '\u001b');
    expect(value.snapshot.router.current.route.name).toBe('configFields'); expect(instance.lastFrame()).toContain('1 项待保存');
    await focusAction(instance, '模型配置'); await input(instance, '\r'); await editProperty(instance, 'hidden', '8'); await commitObject(instance);
    await openConfigSave(instance, value);
    expect(captured[0]).toMatchObject({ kind: 'configSaveBatch', groups: [{ scope: 'user', updates: {
      profile: { model: 'alpha', effort: 'high', hidden: 8 }, enabled: true,
    }, changes: expect.arrayContaining([expect.objectContaining({ key: 'profile',
      before: '{"model":"alpha","effort":"high","hidden":7}', after: '{"model":"alpha","effort":"high","hidden":8}',
    })]) }] });
  });

  it('keeps an existing Codex override independent from a common draft', async () => {
    const { value, captured } = controller({ configPage: (options) => {
      const result = page(options); const current = options.platform === 'codex' ? 'codex-live' : 'common-live';
      Object.assign(result.groups[0]!.fields[0]!, { configured: true, canUnset: true, value: current, draftValue: current,
        effectiveValue: current, effectiveDisplayValue: current, effectiveSourceLabel: options.platform ?? '公共配置' }); return result;
    } });
    await value.load(); value.push({ name: 'pluginDetail', pluginId }); value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />); await nextTurn(5);
    await input(instance, '\r', '\u0015', 'new-common', '\r'); await chooseConfigProfile(instance, value, 'codex');
    expect(instance.lastFrame()).toContain('codex-live'); expect(instance.lastFrame()).not.toContain('new-common');
    await input(instance, '\r', '\u0015', 'new-codex', '\r'); await openConfigSave(instance, value);
    expect(captured[0]).toMatchObject({ kind: 'configSaveBatch', groups: [
      { scope: 'user', updates: { mode: 'new-common' } }, { scope: 'user', platform: 'codex', updates: { mode: 'new-codex' } },
    ] });
  });
});
