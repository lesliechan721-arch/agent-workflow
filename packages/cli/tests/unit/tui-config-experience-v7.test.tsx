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
                affectedTargets: options.affectedTargets ?? [],
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
    getConfigPage: vi.fn(async (_pluginId, layer) => page(layer)),
    executeIntent: vi.fn(),
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
  expect(value.snapshot.router.current.route.name).toBe('configSave');
  await nextTurn(4);
  return instance;
}

describe('TUI config experience v7', () => {
  it.each([[60, 18], [80, 24]] as const)(
    'keeps each current config value and its source readable at %ix%i',
    async (columns, rows) => {
      const { value } = controller();
      await value.load();
      value.push({ name: 'pluginDetail', pluginId });
      value.beginConfigFlow(pluginId);
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(4);

      expect(instance.lastFrame()).toContain('当前生效：团队值（个人默认）');
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
    expect(instance.lastFrame()).toContain('拟保存：当前项目');
    expect(instance.lastFrame()).toContain('strict · 拟保存：当前项目');
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
    expect(instance.lastFrame()).toContain('safe · 拟保存：当前项目');
  });

  it('opens every config group from the pinned basic-key selector', async () => {
    const { value } = controller();
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\t', '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('选择设置分组');
    expect(instance.lastFrame()).toContain('全部分组和快速方案');
    expect(instance.lastFrame()).toContain('插件设置');
    expect(instance.lastFrame()).toContain('快速方案');

    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(value.snapshot.router.current.context.configGroupId).toBe('@presets');
    expect(instance.lastFrame()).toContain('插件方案');
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
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configLayer', fieldKey: 'token' });
    expect(instance.lastFrame()).toContain('个人默认');
    expect(instance.lastFrame()).not.toContain('当前项目');
  });

  it('keeps the project target visible in the compact batch save summary', async () => {
    const { value, captured } = controller();
    await value.load();
    const instance = await openChangedProjectSave(value, 60, 18);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('将按当前项目、个人默认的顺序保存 1');
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
    expect(frame).toContain('保存全部草稿，并重新应用实际使用这些设置的目标');
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
    expect(frame).toContain('保存全部设置层，不重新应用安装目标');
    await input(instance, '\u001B[B', '\r');
    await nextTurn(3);
    expect(captured.at(-1)).toMatchObject({
      kind: 'configSaveBatch', apply: false,
      groups: [expect.objectContaining({ scope: 'project', updates: { mode: expect.any(String) } })],
    });
  });

});
