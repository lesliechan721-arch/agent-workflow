import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createCliExecutionContext } from '../../src/commands/runtime.js';
import type { LiveConsoleItem } from '../../src/commands/status.js';
import { createFakeConsoleDriver, createFakePrompt } from '../helpers/fake-console.js';

const mocks = vi.hoisted(() => ({
  loadConsoleItemsResult: vi.fn(),
  installWriteCommand: vi.fn(),
  reinstallWriteCommand: vi.fn(),
  cleanupWriteCommand: vi.fn(),
  upgradeWriteCommand: vi.fn(),
  uninstallWriteCommand: vi.fn(),
  resolveConfigRead: vi.fn(),
  applyPluginConfigWrite: vi.fn(),
  resetPluginConfigWithHelper: vi.fn(),
}));

vi.mock('../../src/commands/status.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/commands/status.js')>(
    '../../src/commands/status.js',
  );
  return { ...actual, loadConsoleItemsResult: mocks.loadConsoleItemsResult };
});

vi.mock('../../src/commands/write-commands.js', () => ({
  installWriteCommand: mocks.installWriteCommand,
  reinstallWriteCommand: mocks.reinstallWriteCommand,
  cleanupWriteCommand: mocks.cleanupWriteCommand,
  upgradeWriteCommand: mocks.upgradeWriteCommand,
  uninstallWriteCommand: mocks.uninstallWriteCommand,
}));

vi.mock('../../src/utils/plugin-config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/plugin-config.js')>(
    '../../src/utils/plugin-config.js',
  );
  return { ...actual, resolveConfigRead: mocks.resolveConfigRead };
});

vi.mock('../../src/utils/plugin-config-write.js', () => ({
  applyPluginConfigWrite: mocks.applyPluginConfigWrite,
  resetPluginConfigWithHelper: mocks.resetPluginConfigWithHelper,
}));

function item(state: 'present' | 'absent' | 'partial' | 'error'): LiveConsoleItem {
  return {
    pluginName: 'demo',
    version: '1.0.0',
    plugin: {
      rootDir: '/catalog/demo',
      manifestPath: '/catalog/demo/.agents-plugin/plugin.json',
      manifest: {
        name: 'demo',
        version: '1.0.0',
        description: 'demo',
        marketplace: {
          category: 'test',
          strict: true,
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        },
        config: { schema: { token: { type: 'string', title: 'Token' } } },
      },
    },
    targets: [{
      target: {
        plugin: 'demo',
        version: '1.0.0',
        platform: 'codex',
        scope: 'user',
        cwd: '/workspace',
      },
      state,
      components: [],
      errors: [],
      ...(state === 'partial' ? {
        recommendation: {
          command: 'aw reinstall demo -p codex -s user',
          reason: 'partial',
        },
      } : {}),
    }],
  };
}

function load(itemValue: LiveConsoleItem) {
  mocks.loadConsoleItemsResult.mockResolvedValue({
    items: [itemValue],
    catalogUnavailable: false,
    status: {
      schemaVersion: 3,
      catalog: {},
      filters: { plugins: [], platform: 'both', cwd: '/workspace' },
      targets: itemValue.targets,
      errors: [],
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.installWriteCommand.mockResolvedValue({
    overallState: 'succeeded',
    targetResults: [{
      target: { pluginName: 'demo', platform: 'codex', scope: 'user' },
      action: 'install',
      state: 'completed',
    }],
  });
  mocks.resolveConfigRead.mockResolvedValue({
    pluginName: 'demo',
    scope: 'user',
    projectLayer: 'shared',
    fields: [],
    legacyConfigStores: [],
  });
  mocks.applyPluginConfigWrite.mockResolvedValue({
    overallState: 'succeeded', targetResults: [], updatedKeys: [], removedKeys: [],
  });
  mocks.resetPluginConfigWithHelper.mockResolvedValue({
    overallState: 'succeeded', targetResults: [], deleted: true, removedKeys: [],
  });
  mocks.upgradeWriteCommand.mockResolvedValue({ overallState: 'succeeded', targetResults: [] });
  mocks.uninstallWriteCommand.mockResolvedValue({ overallState: 'succeeded', targetResults: [] });
});

describe('live console', () => {
  it('offers install for an absent live target and reloads from status after execution', async () => {
    load(item('absent'));
    const prompt = createFakePrompt([
      { method: 'select', value: 'demo' },
      { method: 'select', value: 'demo\0codex\0user' },
      { method: 'select', value: 'install' },
      { method: 'select', value: '__exit' },
    ]);
    const consoleDriver = createFakeConsoleDriver();
    const context = createCliExecutionContext({
      cwd: '/workspace',
      interactive: true,
      prompt,
      consoleDriver,
    });
    const { runConsoleController } = await import('../../src/commands/console.js');

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(mocks.installWriteCommand).toHaveBeenCalledWith(
      ['demo'],
      { cwd: '/workspace', platform: 'codex', scope: 'user' },
      context,
    );
    expect(mocks.loadConsoleItemsResult).toHaveBeenCalledTimes(2);
  });

  it('uses only reinstall, cleanup, config, and status actions for a partial target', async () => {
    load(item('partial'));
    const prompt = createFakePrompt([
      { method: 'select', value: 'demo' },
      { method: 'select', value: 'demo\0codex\0user' },
      { method: 'select', value: 'config' },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);
    const consoleDriver = createFakeConsoleDriver();
    const context = createCliExecutionContext({
      cwd: '/workspace', interactive: true, prompt, consoleDriver,
    });
    const { runConsoleController } = await import('../../src/commands/console.js');

    await expect(runConsoleController(context)).resolves.toBe(0);
    const actionCall = prompt.calls.find((call) =>
      call.method === 'select'
      && (call.options as { message?: string }).message === '选择操作');
    const serialized = JSON.stringify(actionCall?.options);
    expect(serialized).toContain('reinstall');
    expect(serialized).toContain('cleanup');
    expect(serialized).toContain('config');
    expect(serialized).toContain('reload');
    expect(serialized).not.toMatch(/repair|adopt|dependenc|force|prune|diagnose/iu);
    expect(mocks.resolveConfigRead).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'demo', scope: 'user', projectLayer: 'shared',
    }));
  });

  it('offers upgrade and confirmed uninstall for a present target', async () => {
    load(item('present'));
    const prompt = createFakePrompt([
      { method: 'select', value: 'demo' },
      { method: 'select', value: 'demo\0codex\0user' },
      { method: 'select', value: 'uninstall' },
      { method: 'confirm', value: true },
      { method: 'select', value: '__exit' },
    ]);
    const context = createCliExecutionContext({
      cwd: '/workspace', interactive: true, prompt, consoleDriver: createFakeConsoleDriver(),
    });
    const { runConsoleController } = await import('../../src/commands/console.js');

    await expect(runConsoleController(context)).resolves.toBe(0);
    const actionCall = prompt.calls.find((call) =>
      call.method === 'select'
      && (call.options as { message?: string }).message === '选择操作');
    const actions = JSON.stringify(actionCall?.options);
    expect(actions).toContain('upgrade');
    expect(actions).toContain('uninstall');
    expect(prompt.calls.some((call) => call.method === 'confirm')).toBe(true);
    expect(mocks.uninstallWriteCommand).toHaveBeenCalledTimes(1);
  });

  it('sets a manifest config field through the new config helper', async () => {
    load(item('present'));
    const prompt = createFakePrompt([
      { method: 'select', value: 'demo' },
      { method: 'select', value: 'demo\0codex\0user' },
      { method: 'select', value: 'config' },
      { method: 'select', value: 'set' },
      { method: 'select', value: 'token' },
      { method: 'input', value: 'value' },
      { method: 'select', value: '__exit' },
    ]);
    const context = createCliExecutionContext({
      cwd: '/workspace', interactive: true, prompt, consoleDriver: createFakeConsoleDriver(),
    });
    const { runConsoleController } = await import('../../src/commands/console.js');

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'demo', request: { updates: { token: 'value' } },
    }));
    expect(mocks.applyPluginConfigWrite.mock.calls[0]?.[0]).not.toHaveProperty('applyTargets');
  });

  it('unsets a manifest config field through the new config helper', async () => {
    load(item('present'));
    const prompt = createFakePrompt([
      { method: 'select', value: 'demo' },
      { method: 'select', value: 'demo\0codex\0user' },
      { method: 'select', value: 'config' },
      { method: 'select', value: 'unset' },
      { method: 'select', value: 'token' },
      { method: 'select', value: '__exit' },
    ]);
    const context = createCliExecutionContext({
      cwd: '/workspace', interactive: true, prompt, consoleDriver: createFakeConsoleDriver(),
    });
    const { runConsoleController } = await import('../../src/commands/console.js');

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'demo', request: { removeKeys: ['token'] },
    }));
  });

  it('resets the selected config layer only after confirmation', async () => {
    load(item('present'));
    const prompt = createFakePrompt([
      { method: 'select', value: 'demo' },
      { method: 'select', value: 'demo\0codex\0user' },
      { method: 'select', value: 'config' },
      { method: 'select', value: 'reset' },
      { method: 'confirm', value: true },
      { method: 'select', value: '__exit' },
    ]);
    const context = createCliExecutionContext({
      cwd: '/workspace', interactive: true, prompt, consoleDriver: createFakeConsoleDriver(),
    });
    const { runConsoleController } = await import('../../src/commands/console.js');

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(mocks.resetPluginConfigWithHelper).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'demo', scope: 'user',
    }));
    expect(mocks.resetPluginConfigWithHelper.mock.calls[0]?.[0]).not.toHaveProperty('applyTargets');
  });

  it('saves absent-target config without installing the target', async () => {
    load(item('absent'));
    mocks.applyPluginConfigWrite.mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [],
      updatedKeys: ['token'],
      removedKeys: [],
      applySkippedReason: 'noVisibleTarget',
    });
    const prompt = createFakePrompt([
      { method: 'select', value: 'demo' },
      { method: 'select', value: 'demo\0codex\0user' },
      { method: 'select', value: 'config' },
      { method: 'select', value: 'set' },
      { method: 'select', value: 'token' },
      { method: 'input', value: 'saved' },
      { method: 'select', value: '__exit' },
    ]);
    const consoleDriver = createFakeConsoleDriver();
    const context = createCliExecutionContext({
      cwd: '/workspace', interactive: true, prompt, consoleDriver,
    });
    const { runConsoleController } = await import('../../src/commands/console.js');

    await expect(runConsoleController(context)).resolves.toBe(0);
    const actionCall = prompt.calls.find((call) =>
      call.method === 'select'
      && (call.options as { message?: string }).message === '选择操作');
    expect(JSON.stringify(actionCall?.options)).toContain('不会安装此目标');
    expect(mocks.applyPluginConfigWrite.mock.calls[0]?.[0]).not.toHaveProperty('applyTargets');
    expect(mocks.installWriteCommand).not.toHaveBeenCalled();
    expect(consoleDriver.views.some((view) =>
      view.lines.some((line) => line.includes('只保存，不会安装插件')))).toBe(true);
  });

  it('shows all config apply consumers even when the selected location is absent', async () => {
    load(item('absent'));
    mocks.applyPluginConfigWrite.mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [
        {
          target: { pluginName: 'demo', platform: 'codex', scope: 'user' },
          action: 'reinstall', state: 'completed',
        },
        {
          target: { pluginName: 'demo', platform: 'claude', scope: 'user' },
          action: 'reinstall', state: 'completed',
        },
      ],
      updatedKeys: ['token'],
      removedKeys: [],
    });
    const prompt = createFakePrompt([
      { method: 'select', value: 'demo' },
      { method: 'select', value: 'demo\0codex\0user' },
      { method: 'select', value: 'config' },
      { method: 'select', value: 'set' },
      { method: 'select', value: 'token' },
      { method: 'input', value: 'saved' },
      { method: 'select', value: '__exit' },
    ]);
    const consoleDriver = createFakeConsoleDriver();
    const context = createCliExecutionContext({
      cwd: '/workspace', interactive: true, prompt, consoleDriver,
    });
    const { runConsoleController } = await import('../../src/commands/console.js');

    await expect(runConsoleController(context)).resolves.toBe(0);
    const lines = consoleDriver.views.flatMap((view) => view.lines);
    expect(lines).toContain('应用：codex/user: completed');
    expect(lines).toContain('应用：claude/user: completed');
    expect(lines.join('\n')).not.toContain('只保存，不会安装插件');
  });

  it('shows reset success and failed apply targets with retry guidance', async () => {
    load(item('present'));
    mocks.resetPluginConfigWithHelper.mockResolvedValue({
      overallState: 'failed',
      targetResults: [{
        target: { pluginName: 'demo', platform: 'codex', scope: 'project' },
        action: 'reinstall', state: 'failed', message: 'postcheck failed',
      }],
      deleted: true,
      removedKeys: ['token'],
    });
    const prompt = createFakePrompt([
      { method: 'select', value: 'demo' },
      { method: 'select', value: 'demo\0codex\0user' },
      { method: 'select', value: 'config' },
      { method: 'select', value: 'reset' },
      { method: 'confirm', value: true },
      { method: 'select', value: '__exit' },
    ]);
    const consoleDriver = createFakeConsoleDriver();
    const context = createCliExecutionContext({
      cwd: '/workspace', interactive: true, prompt, consoleDriver,
    });
    const { runConsoleController } = await import('../../src/commands/console.js');

    await expect(runConsoleController(context)).resolves.toBe(0);
    const lines = consoleDriver.views.flatMap((view) => view.lines);
    expect(lines).toContain('配置已重置。');
    expect(lines).toContain('应用：codex/project: failed · postcheck failed');
    expect(lines.join('\n')).toContain('请修复失败目标后重试配置操作');
  });

  it('hides config when the current manifest has no config schema', async () => {
    const withoutConfig = item('present');
    delete withoutConfig.plugin!.manifest.config;
    load(withoutConfig);
    const prompt = createFakePrompt([
      { method: 'select', value: 'demo' },
      { method: 'select', value: 'demo\0codex\0user' },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);
    const context = createCliExecutionContext({
      cwd: '/workspace', interactive: true, prompt, consoleDriver: createFakeConsoleDriver(),
    });
    const { runConsoleController } = await import('../../src/commands/console.js');

    await expect(runConsoleController(context)).resolves.toBe(0);
    const actionCall = prompt.calls.find((call) =>
      call.method === 'select'
      && (call.options as { message?: string }).message === '选择操作');
    expect(JSON.stringify(actionCall?.options)).not.toContain('config');
  });
});
