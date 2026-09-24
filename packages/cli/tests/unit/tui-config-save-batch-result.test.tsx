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
import type { ConfigPageViewModel } from '../../src/tui/model.js';

afterEach(() => cleanup());

const pluginId = 'team/demo';

function status(): TuiStatusLoadResult {
  return {
    payload: {
      schemaVersion: 7,
      catalog: {
        primarySourceId: 'team', configDigest: 'sha256:config', compositeDigest: 'sha256:composite',
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
      pluginName: 'demo', pluginId, displayName: 'Demo', description: '设置批次测试', version: '1.0.0',
      supportedTargets: { codex: ['user', 'project'], claude: ['user', 'project'] },
      configFieldCount: 2,
    }],
    configuredSources: [{ id: 'team', type: 'path', primary: true, path: '/catalog', autoCheck: true }],
  };
}

function evidence(intent: OperationIntent): OperationEvidence {
  if (intent.kind === 'configSaveBatch') {
    return {
      catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
      configBatch: { groups: intent.groups.map((group) => ({
        scope: group.scope,
        targetFingerprint: `sha256:${group.scope}`,
        config: {
          scope: group.scope, storeDigest: `sha256:store:${group.scope}`,
          impactState: 'known', affectedTargets: [],
        },
      })) },
    };
  }
  return {
    catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
    config: {
      scope: intent.kind === 'configSave' ? intent.scope : 'user',
      storeDigest: 'sha256:store:user', impactState: 'known', affectedTargets: [],
    },
  };
}

function configPage(layer: ConfigPageViewModel['layer']): ConfigPageViewModel {
  return {
    pluginId,
    layer,
    storedCount: 0,
    presets: [],
    groups: [{
      id: 'main', title: '常用', advanced: false, fields: [{
        key: 'mode', title: '运行模式', type: 'string', definition: { type: 'string' },
        displayValue: layer.scope === 'effective' ? '默认' : '未设置',
        required: false, sensitive: false, writable: true, canSet: true, canUnset: false,
        dirty: false, inherited: true, configured: false, sourceLabel: '插件默认',
        effectiveDisplayValue: '默认', effectiveSourceLabel: '插件默认', effectiveValue: 'default',
        draftValue: layer.scope === 'effective' ? 'default' : undefined,
        allowCustom: true, advanced: false,
      }],
    }],
  };
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

async function escape(instance: ReturnType<typeof render>): Promise<void> {
  instance.stdin.write('\u001b');
  await new Promise((resolve) => setTimeout(resolve, 80));
  await nextTurn(2);
}

describe('TUI config save batch result', () => {
  it('opens the usable settings overview from a portable missing-config blocker', async () => {
    const dependencies: TuiControllerDependencies = {
      loadStatus: vi.fn().mockResolvedValue(status()),
      captureEvidence: vi.fn(async (intent: OperationIntent) => evidence(intent)),
      executeIntent: vi.fn(),
      getConfigPage: vi.fn(async (_pluginId, layer) => configPage(layer)),
    };
    const value = new TuiController(dependencies);
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    value.push({ name: 'portableBlocker', pluginId, code: 'requiredConfigMissing' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'configFields', pluginId, layer: { scope: 'effective' },
    });
    expect(instance.lastFrame()).toContain('插件设置');
    expect(instance.lastFrame()).not.toContain('正在检查可用保存位置');
  });

  it('keeps a target-cancelled value private and discards only that candidate', async () => {
    const captured: OperationIntent[] = [];
    const dependencies: TuiControllerDependencies = {
      loadStatus: vi.fn().mockResolvedValue(status()),
      captureEvidence: vi.fn(async (intent: OperationIntent) => {
        captured.push(intent);
        return evidence(intent);
      }),
      executeIntent: vi.fn(),
      getConfigPage: vi.fn(async (_pluginId, layer) => configPage(layer)),
    };
    const value = new TuiController(dependencies);
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\r', 'candidate-only', '\r');
    expect(value.snapshot.router.current.route.name).toBe('configLayer');
    expect(JSON.stringify(value.snapshot)).not.toContain('candidate-only');

    await escape(instance);
    expect(value.snapshot.router.current.route.name).toBe('configFieldEditor');
    expect(instance.lastFrame()).toContain('candidate-only');
    expect(JSON.stringify(value.snapshot)).not.toContain('candidate-only');

    await escape(instance);
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).not.toContain('查看保存汇总');
  });

  it('keeps drafts for the same field in two scopes and submits project before user', async () => {
    const captured: OperationIntent[] = [];
    const dependencies: TuiControllerDependencies = {
      loadStatus: vi.fn().mockResolvedValue(status()),
      captureEvidence: vi.fn(async (intent: OperationIntent) => {
        captured.push(intent);
        return evidence(intent);
      }),
      executeIntent: vi.fn(),
      getConfigPage: vi.fn(async (_pluginId, layer) => configPage(layer)),
    };
    const value = new TuiController(dependencies);
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\r', '\u0015', 'project-value', '\r', '\r');

    await input(instance, '\r', '\u0015', 'user-value', '\r', '\u001b[B', '\r');
    expect(instance.lastFrame()).toContain('待保存到当前项目：project-value');
    expect(instance.lastFrame()).toContain('待保存到个人默认：user-value');
    expect(instance.lastFrame()).toContain('保存设置（2）');

    await input(instance, 's', '\u001b[B', '\r');
    expect(captured.at(-1)).toMatchObject({
      kind: 'configSaveBatch', apply: false,
      groups: [
        { scope: 'project', updates: { mode: 'project-value' } },
        { scope: 'user', updates: { mode: 'user-value' } },
      ],
    });
  });

  it('keeps the failed user draft after a successful project apply retry', async () => {
    const captured: OperationIntent[] = [];
    const dependencies: TuiControllerDependencies = {
      loadStatus: vi.fn().mockResolvedValue(status()),
      captureEvidence: vi.fn(async (intent: OperationIntent) => {
        captured.push(intent);
        return evidence(intent);
      }),
      executeIntent: vi.fn(async (intent: OperationIntent) => intent.kind === 'configSaveBatch'
        ? {
            status: 'partial',
            groups: [{
              scope: 'project', status: 'failed', configSaved: true,
              applyRequested: true, applyStatus: 'failed', errorCode: 'configApplyFailed',
            }, {
              scope: 'user', status: 'failed', configSaved: false,
              applyRequested: true, applyStatus: 'notRequested', errorCode: 'configWriteFailed',
            }],
          }
        : {
            configWrite: 'succeeded', overallState: 'succeeded',
            apply: { state: 'succeeded', targetResults: [] },
          }),
      getConfigPage: vi.fn(async (_pluginId, layer) => configPage(layer)),
    };
    const value = new TuiController(dependencies);
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\r', '\u0015', 'project-value', '\r', '\r');
    await input(instance, '\r', '\u0015', 'user-value', '\r', '\u001b[B', '\r');
    await input(instance, 's', '\r');
    await nextTurn(5);
    const batchReview = value.snapshot.activeReview;
    expect(batchReview?.operationKind).toBe('configSaveBatch');
    await value.executeOperation(batchReview!.reviewToken);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('当前项目');
    expect(instance.lastFrame()).toContain('已保存 · 应用失败');
    expect(instance.lastFrame()).toContain('个人默认');
    expect(instance.lastFrame()).toContain('保存失败');

    await input(instance, '\r');
    await nextTurn(5);
    const retryReview = value.snapshot.activeReview;
    expect(retryReview?.operationKind).toBe('configSave');
    expect(captured.at(-1)).toMatchObject({
      kind: 'configSave', scope: 'project', retryApply: true, updates: {}, removeKeys: [],
    });
    await value.executeOperation(retryReview!.reviewToken);
    await nextTurn(4);
    expect(value.externalDrafts).toEqual([
      expect.objectContaining({ kind: 'configDraft', owner: pluginId }),
    ]);
  });

  it('shows each scope result and retries only apply for the saved failed-apply scope', async () => {
    const captured: OperationIntent[] = [];
    const dependencies: TuiControllerDependencies = {
      loadStatus: vi.fn().mockResolvedValue(status()),
      captureEvidence: vi.fn(async (intent: OperationIntent) => {
        captured.push(intent);
        return evidence(intent);
      }),
      executeIntent: vi.fn(async (intent: OperationIntent) => {
        if (intent.kind === 'configSaveBatch') {
          return {
            status: 'partial',
            groups: [{
              scope: 'project', status: 'failed', configSaved: false,
              applyRequested: true, applyStatus: 'notRequested', errorCode: 'configWriteFailed',
            }, {
              scope: 'user', status: 'failed', configSaved: true,
              applyRequested: true, applyStatus: 'failed', errorCode: 'configApplyFailed',
            }],
          };
        }
        return {
          configWrite: 'succeeded', overallState: 'succeeded',
          apply: { state: 'succeeded', targetResults: [] },
        };
      }),
    };
    const value = new TuiController(dependencies);
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    value.beginConfigFlow(pluginId);
    const review = await value.buildOperationReview({
      kind: 'configSaveBatch', pluginId, apply: true,
      groups: [{ scope: 'project', updates: { mode: 'strict' } }, {
        scope: 'user', updates: { token: 'secret' }, sensitiveKeys: ['token'],
      }],
    });
    await value.executeOperation(review.reviewToken);

    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('当前项目');
    expect(instance.lastFrame()).toContain('保存失败');
    expect(instance.lastFrame()).toContain('个人默认');
    expect(instance.lastFrame()).toContain('已保存 · 应用失败');
    expect(instance.lastFrame()).toContain('重试应用');

    await input(instance, '\r');
    expect(captured.at(-1)).toEqual(expect.objectContaining({
      kind: 'configSave', pluginId, scope: 'user', apply: true, retryApply: true,
      updates: {}, removeKeys: [],
    }));
    expect(JSON.stringify(captured.at(-1))).not.toContain('secret');
  });
});
