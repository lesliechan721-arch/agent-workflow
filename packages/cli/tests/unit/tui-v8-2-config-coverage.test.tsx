import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import {
  TuiController,
  type OperationEvidence,
  type OperationIntent,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import type { ConfigPageViewModel, ConfigReadOptions } from '../../src/tui/model.js';
import type { ConsoleV4ScreenId } from '../../src/tui/screen-registry.js';

afterEach(() => cleanup());

const pluginId = 'team/config-coverage';

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
        scope: 'user', platform: group.platform,
        targetFingerprint: `sha256:${group.platform ?? 'common'}`,
        config: {
          scope: 'user', platform: group.platform, context: intent.context ?? 'user',
          storeDigest: `sha256:store:${group.platform ?? 'common'}`,
          impactState: 'known',
          affectedTargets: [],
        },
      })),
    },
  };
}

function savedConfigBatch(intent: OperationIntent) {
  if (intent.kind !== 'configSaveBatch') throw new Error(`Unexpected save intent: ${intent.kind}`);
  return { status: 'succeeded', groups: intent.groups.map((group) => ({
    scope: 'user', platform: group.platform, status: 'succeeded', configSaved: true,
    applyRequested: false, applyStatus: 'notRequested',
  })) };
}

function sensitivePage(options: ConfigReadOptions): ConfigPageViewModel {
  const profile = options.platform ?? 'common';
  const context = options.context ?? 'user';
  return {
    pluginId,
    profile, context, layer: { profile, context },
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
        writable: true,
        canSet: true,
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
    'shows pending save state before the completed save dialog at %ix%i',
    async (columns, rows) => {
      let finishExecution!: (result: unknown) => void;
      const executeIntent = vi.fn(() => new Promise((resolve) => {
        finishExecution = resolve;
      }));
      const value = new TuiController({
        loadStatus: vi.fn().mockResolvedValue(status()),
        captureEvidence: vi.fn(async (intent: OperationIntent) => evidence(intent)),
        getConfigPage: vi.fn(async (_pluginId, options) => sensitivePage(options)),
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
      await nextTurn(5);
      await input(instance, '\r', 'private-token-value', '\r', 's');
      await nextTurn(3);
      expect(value.snapshot.router.current.route.name).toBe('configFields');
      expect(reached).toContain('C01');
      expect(instance.lastFrame()).toContain('正在保存设置');
      expect(instance.lastFrame()).not.toContain('已保存，是否更新插件？');
      expect(value.snapshot.result).toBeUndefined();
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);

      finishExecution({
        status: 'succeeded',
        groups: [{
          scope: 'user', status: 'succeeded', configSaved: true,
          applyRequested: false, applyStatus: 'notRequested',
        }],
      });
      await nextTurn(3);
      expect(value.snapshot.router.current.route.name).toBe('configFields');
      expect(instance.lastFrame()).toContain('已保存，是否更新插件？');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    },
  );

  it.each([[60, 18], [80, 24]] as const)(
    'keeps a sensitive value private from input through saving its selected profile at %ix%i',
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
        executeIntent: vi.fn(async (intent: OperationIntent) => savedConfigBatch(intent)),
      });
      await value.load();
      value.push({ name: 'pluginDetail', pluginId });
      value.beginConfigFlow(pluginId, { platform: 'generic', context: 'project' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(4);

      await input(instance, '\r', privateValue);
      expect(value.snapshot.router.current.route).toMatchObject({
        name: 'configFieldEditor', fieldKey: 'token',
      });
      expect(instance.lastFrame()).not.toContain(privateValue);
      expect(JSON.stringify(value.snapshot)).not.toContain(privateValue);

      await input(instance, '\r');
      expect(value.snapshot.router.current.route.name).toBe('configFields');
      expect(value.snapshot.router.current.route).toMatchObject({ layer: { profile: 'generic', context: 'project' } });
      expect(instance.lastFrame()).not.toContain(privateValue);
      expect(JSON.stringify(value.snapshot)).not.toContain(privateValue);

      await nextTurn(3);
      expect(value.snapshot.router.current.route.name).toBe('configFields');
      expect(instance.lastFrame()).toContain('1 项待保存');
      expect(instance.lastFrame()).not.toContain(privateValue);
      await input(instance, 's');
      for (let index = 0; index < 12
        && value.snapshot.router.current.route.name === 'reviewPreparing'; index += 1) {
        await nextTurn();
      }

      expect(value.snapshot.router.current.route.name).toBe('configFields');
      await vi.waitFor(() => expect(captured.at(-1)).toMatchObject({
        kind: 'configSaveBatch',
        apply: false,
        context: 'project',
        groups: [{ scope: 'user', platform: 'generic', updates: { token: privateValue }, sensitiveKeys: ['token'] }],
      }));
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('已保存，是否更新插件？'));
      expect(instance.lastFrame()).not.toContain(privateValue);
      expect(JSON.stringify(value.snapshot)).not.toContain(privateValue);
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    },
  );
});
