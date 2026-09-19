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
import type { ConsoleV4ScreenId } from '../../src/tui/screen-registry.js';

afterEach(() => cleanup());

const pluginId = 'team/config-coverage';

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
      pluginName: 'config-coverage',
      pluginId,
      displayName: 'Config Coverage',
      description: '配置覆盖测试插件',
      version: '1.0.0',
      supportedTargets: { codex: ['user', 'project'], claude: ['user', 'project'] },
      configFieldCount: 1,
    }],
    configuredSources: [{ id: 'team', type: 'path', primary: true, path: '/catalog', autoCheck: true }],
  };
}

function evidence(intent: OperationIntent): OperationEvidence {
  if (intent.kind !== 'configSaveBatch') {
    throw new Error(`Unexpected coverage intent: ${intent.kind}`);
  }
  return {
    catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
    configBatch: {
      groups: intent.groups.map((group) => ({
        scope: group.scope,
        targetFingerprint: `sha256:${group.scope}`,
        config: {
          scope: group.scope,
          storeDigest: `sha256:store:${group.scope}`,
          impactState: 'known',
          affectedTargets: [],
        },
      })),
    },
  };
}

function sensitivePage(layer: ConfigPageViewModel['layer']): ConfigPageViewModel {
  const projectBlocked = layer.scope === 'project';
  return {
    pluginId,
    layer,
    storedCount: 0,
    presets: [],
    groups: [{
      id: 'credentials',
      title: '凭据',
      advanced: false,
      fields: [{
        key: 'token',
        title: '访问令牌',
        type: 'string',
        definition: {
          type: 'string',
          sensitive: true,
          validation: { minLength: 8 },
        },
        displayValue: '未设置',
        required: true,
        sensitive: true,
        writable: !projectBlocked,
        canSet: !projectBlocked,
        canUnset: false,
        dirty: false,
        inherited: true,
        configured: false,
        sourceLabel: '未设置',
        effectiveDisplayValue: '未设置',
        effectiveSourceLabel: '未设置',
        allowCustom: true,
        advanced: false,
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

describe('TUI v8.2 config coverage', () => {
  it.each([[60, 18], [80, 24]] as const)(
    'shows pending config Progress and the completed Result at %ix%i',
    async (columns, rows) => {
      let finishExecution!: (result: unknown) => void;
      const executeIntent = vi.fn(() => new Promise((resolve) => {
        finishExecution = resolve;
      }));
      const value = new TuiController({
        loadStatus: vi.fn().mockResolvedValue(status()),
        captureEvidence: vi.fn(async (intent: OperationIntent) => evidence(intent)),
        executeIntent,
      });
      await value.load();
      value.push({ name: 'pluginDetail', pluginId });
      value.beginConfigFlow(pluginId);
      const reached = new Set<ConsoleV4ScreenId>();
      const instance = render(<ConsoleAppV4
        controller={value}
        size={{ columns, rows }}
        onScreenChange={(screen) => reached.add(screen)}
      />);
      const review = await value.buildOperationReview({
        kind: 'configSaveBatch',
        pluginId,
        apply: false,
        groups: [{ scope: 'user', updates: { mode: 'safe' } }],
      });

      const pending = value.executeOperation(review.reviewToken);
      await nextTurn(3);
      expect(value.snapshot.router.current.route.name).toBe('progress');
      expect(reached).toContain('C11');
      expect(instance.lastFrame()).toContain('正在保存设置');
      expect(instance.lastFrame()).toContain('只保存所选设置层');
      expect(value.snapshot.result).toBeUndefined();
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);

      finishExecution({
        status: 'succeeded',
        groups: [{
          scope: 'user', status: 'succeeded', configSaved: true,
          applyRequested: false, applyStatus: 'notRequested',
        }],
      });
      await pending;
      await nextTurn(3);
      expect(value.snapshot.router.current.route.name).toBe('result');
      expect(reached).toContain('C12');
      expect(instance.lastFrame()).toContain('设置已保存');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    },
  );

  it.each([[60, 18], [80, 24]] as const)(
    'keeps a sensitive value private from input through its user-only target and Review at %ix%i',
    async (columns, rows) => {
      const privateValue = 'private-token-value';
      const captured: OperationIntent[] = [];
      const value = new TuiController({
        loadStatus: vi.fn().mockResolvedValue(status()),
        getConfigPage: vi.fn(async (_pluginId, layer) => sensitivePage(layer)),
        captureEvidence: vi.fn(async (intent: OperationIntent) => {
          captured.push(intent);
          return evidence(intent);
        }),
        executeIntent: vi.fn(),
      });
      await value.load();
      value.push({ name: 'pluginDetail', pluginId });
      value.beginConfigFlow(pluginId);
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(4);

      await input(instance, '\r', privateValue);
      expect(value.snapshot.router.current.route).toMatchObject({
        name: 'configFieldEditor', fieldKey: 'token',
      });
      expect(instance.lastFrame()).not.toContain(privateValue);
      expect(JSON.stringify(value.snapshot)).not.toContain(privateValue);

      await input(instance, '\r');
      expect(value.snapshot.router.current.route.name).toBe('configLayer');
      expect(instance.lastFrame()).toContain('个人默认');
      expect(instance.lastFrame()).not.toContain('› 当前项目');
      expect(instance.lastFrame()).not.toContain(privateValue);
      expect(JSON.stringify(value.snapshot)).not.toContain(privateValue);

      await input(instance, '\r');
      await nextTurn(3);
      expect(value.snapshot.router.current.route.name).toBe('configFields');
      expect(instance.lastFrame()).toContain('拟保存：个人默认');
      expect(instance.lastFrame()).toContain('将更新 · 拟保存：个人默认');
      expect(instance.lastFrame()).not.toContain(privateValue);
      await input(instance, 's', '\u001B[B', '\r');
      for (let index = 0; index < 12
        && value.snapshot.router.current.route.name === 'reviewPreparing'; index += 1) {
        await nextTurn();
      }

      expect(value.snapshot.router.current.route.name).toBe('review');
      expect(value.snapshot.activeReview?.operationKind).toBe('configSaveBatch');
      expect(captured.at(-1)).toMatchObject({
        kind: 'configSaveBatch',
        apply: false,
        groups: [{ scope: 'user', updates: { token: privateValue }, sensitiveKeys: ['token'] }],
      });
      expect(instance.lastFrame()).not.toContain(privateValue);
      expect(JSON.stringify(value.snapshot)).not.toContain(privateValue);
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    },
  );
});
