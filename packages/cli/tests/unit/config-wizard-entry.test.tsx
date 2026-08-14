import { render } from 'ink-testing-library';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TuiLaunchRequest, TuiRunner } from '../../src/tui/runner.js';
import { createCapturedCliIo, createTtyRuntimeStreams } from '../helpers/cli-entry.js';

const mocks = vi.hoisted(() => ({
  loadConsoleItemsResult: vi.fn(),
  resolveCatalogPlugins: vi.fn(),
  applyPluginConfigWrite: vi.fn(),
  describeResetAffectedFields: vi.fn(),
  resetPluginConfigWithHelper: vi.fn(),
  listPluginConfigStorePluginNames: vi.fn(),
  readPluginConfigStore: vi.fn(),
  resolveConfigRead: vi.fn(),
}));

vi.mock('../../src/commands/status.js', async (importActual) => ({
  ...await importActual<typeof import('../../src/commands/status.js')>(),
  loadConsoleItemsResult: mocks.loadConsoleItemsResult,
}));

vi.mock('../../src/utils/plugin-catalog.js', async (importActual) => ({
  ...await importActual<typeof import('../../src/utils/plugin-catalog.js')>(),
  resolveCatalogPlugins: mocks.resolveCatalogPlugins,
}));

vi.mock('../../src/utils/plugin-config-write.js', async (importActual) => ({
  ...await importActual<typeof import('../../src/utils/plugin-config-write.js')>(),
  applyPluginConfigWrite: mocks.applyPluginConfigWrite,
  describeResetAffectedFields: mocks.describeResetAffectedFields,
  resetPluginConfigWithHelper: mocks.resetPluginConfigWithHelper,
}));

vi.mock('../../src/utils/plugin-config.js', async (importActual) => ({
  ...await importActual<typeof import('../../src/utils/plugin-config.js')>(),
  listPluginConfigStorePluginNames: mocks.listPluginConfigStorePluginNames,
  readPluginConfigStore: mocks.readPluginConfigStore,
  resolveConfigRead: mocks.resolveConfigRead,
}));

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createRunner(
  frames: string[],
  inputs = ['\r', '\r', 'hunter2', '\r', '\r'],
): TuiRunner {
  return {
    async launch<T>(request: TuiLaunchRequest<T>): Promise<T> {
      let complete!: (result: T) => void;
      const result = new Promise<T>((resolve) => { complete = resolve; });
      const instance = render(request.render(complete));
      await nextTurn();
      for (const input of inputs) {
        instance.stdin.write(input);
        await nextTurn();
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      frames.push(...instance.frames);
      instance.stdin.write('\r');
      await nextTurn();
      const value = await result;
      frames.push(...instance.frames);
      instance.unmount();
      instance.cleanup();
      return value;
    },
  };
}

const plugin = {
  rootDir: '/catalog/secure',
  manifestPath: '/catalog/secure/.agents-plugin/plugin.json',
  manifest: {
    name: 'secure',
    version: '1.0.0',
    description: 'Secure plugin',
    compatibility: { aw: { minVersion: '0.0.0' } },
    marketplace: {
      category: 'test',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    config: {
      schema: {
        token: { type: 'string' as const, title: 'Token', sensitive: true },
      },
    },
  },
};

const pluginWithoutSchema = {
  ...plugin,
  manifest: {
    ...plugin.manifest,
    name: 'git',
    config: undefined,
  },
};

const jsonPlugin = {
  ...plugin,
  manifest: {
    ...plugin.manifest,
    name: 'json-config',
    config: {
      schema: {
        mode: { type: 'enum' as const, title: 'Mode', values: ['slow', 'medium'] },
      },
    },
  },
};

const jsonStringPlugin = {
  ...plugin,
  manifest: {
    ...plugin.manifest,
    name: 'json-string',
    config: {
      schema: {
        value: { type: 'string' as const, title: 'Value' },
      },
    },
  },
};

const jsonNumberPlugin = {
  ...plugin,
  manifest: {
    ...plugin.manifest,
    name: 'json-number',
    config: {
      schema: {
        value: { type: 'number' as const, title: 'Value' },
      },
    },
  },
};

const pathPlugin = {
  ...plugin,
  manifest: {
    ...plugin.manifest,
    name: 'paths',
    config: {
      schema: {
        file: { type: 'file' as const, title: 'File', sensitive: false },
        directory: { type: 'directory' as const, title: 'Directory', sensitive: false },
      },
    },
  },
};

describe('config set wizard entry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPluginConfigStorePluginNames.mockResolvedValue([]);
    mocks.readPluginConfigStore.mockResolvedValue({
      path: '/tmp/config.json',
      exists: false,
      values: {},
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('collects a sensitive value in one session and calls the existing helper once', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [{ pluginName: 'secure', version: '1.0.0', plugin, targets: [] }],
    });
    mocks.resolveCatalogPlugins.mockResolvedValue({ plugins: [plugin] });
    mocks.applyPluginConfigWrite.mockResolvedValue({
      plugin: 'secure',
      scope: 'user',
      projectLayer: 'shared',
      updatedKeys: ['token'],
      removedKeys: [],
      effective: { values: {}, issues: [] },
      configWrite: 'succeeded',
      overallState: 'succeeded',
      targetResults: [],
      applySkippedReason: 'noVisibleTarget',
      otherProjectsRequireReinstall: false,
      warnings: [],
    });
    const captured = createCapturedCliIo();
    const frames: string[] = [];
    const debugEvents: string[] = [];

    const exitCode = await runCli(['config', 'set'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: createRunner(frames),
      ...createTtyRuntimeStreams(),
      debugLogger: {
        log: (event) => { debugEvents.push(JSON.stringify(event)); },
      },
    });

    expect(exitCode).toBe(0);
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledTimes(1);
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'secure',
      scope: 'user',
      projectLayer: 'shared',
      request: { updates: { token: 'hunter2' } },
    }));
    expect(frames.join('\n')).not.toContain('hunter2');
    expect(frames.join('\n')).toContain('命令模板');
    expect(frames.join('\n')).toContain("'<sensitive-value>'");
    expect(frames.join('\n')).toContain('替换占位符');
    expect(captured.readStdout()).not.toContain('hunter2');
    expect(captured.readStderr()).not.toContain('hunter2');
    expect(debugEvents.join('\n')).not.toContain('hunter2');
  });

  it.each([
    { key: 'file', value: '/Users/alice/Private Project/private.json', placeholder: '<file-path>' },
    { key: 'directory', value: 'C:\\Users\\alice\\Private Project', placeholder: '<directory-path>' },
    { key: 'directory', value: '\\\\server\\Private Share', placeholder: '<directory-path>' },
  ])('projects a private $key path before execution', async ({ key, value, placeholder }) => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [{ pluginName: 'paths', version: '1.0.0', plugin: pathPlugin, targets: [] }],
    });
    const captured = createCapturedCliIo();
    const frames: string[] = [];

    const exitCode = await runCli(['config', 'set'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: createRunner(frames, [
        '\r',
        key === 'directory' ? '\u001B[B' : '',
        '\r',
        value,
        '\r',
        'n',
      ].filter(Boolean)),
      ...createTtyRuntimeStreams(),
    });

    const output = frames.join('\n');
    expect(exitCode).toBe(0);
    expect(output).toContain('命令模板');
    expect(output).toContain(placeholder);
    expect(output).not.toContain('alice');
    expect(output).not.toContain('Private');
    expect(output).not.toContain('server');
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(captured.readStdout()).toBe('');
    expect(captured.readStderr()).toBe('');
  });

  it.each([
    { key: 'file', value: '/Users/alice/Private Project/missing.json', fragments: ['/Users/alice', 'Private Project'] },
    { key: 'directory', value: 'C:/Users/alice/Private Project', fragments: ['C:/Users', 'Private Project'] },
    { key: 'directory', value: '\\\\server\\Private Share', fragments: ['\\\\server', 'Private Share'] },
  ])('keeps a missing $key realpath failure private', async ({ key, value, fragments }) => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [{ pluginName: 'paths', version: '1.0.0', plugin: pathPlugin, targets: [] }],
    });
    const captured = createCapturedCliIo();
    const frames: string[] = [];
    const realpathSpy = value.startsWith('\\\\')
      ? vi.spyOn(fs, 'realpath').mockRejectedValueOnce(
          Object.assign(new Error(`ENOENT: no such file or directory, realpath '${value}'`), {
            code: 'ENOENT',
          }),
        )
      : undefined;

    const exitCode = await runCli(['config', 'set'], {
      cwd: '/workspace', env: { CI: undefined }, interactive: true, io: captured.io,
      tuiRunner: createRunner(frames, [
        '\r',
        key === 'directory' ? '\u001B[B' : '',
        '\r',
        value,
        '\r',
        '\r',
      ].filter(Boolean)),
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(1);
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(captured.readStdout()).toBe('');
    expect(captured.readStderr()).toBe('操作失败。详细原因请使用 --debug 查看日志。\n');
    const visible = `${frames.join('\n')}\n${captured.readStderr()}`;
    expect(visible).not.toContain('ENOENT');
    for (const fragment of fragments) expect(visible).not.toContain(fragment);
    realpathSpy?.mockRestore();
  });

  it('shows a failed config apply result and returns its failed receipt', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [{ pluginName: 'secure', version: '1.0.0', plugin, targets: [] }],
    });
    mocks.resolveCatalogPlugins.mockResolvedValue({ plugins: [plugin] });
    mocks.applyPluginConfigWrite.mockResolvedValue({
      plugin: 'secure',
      scope: 'user',
      projectLayer: 'shared',
      updatedKeys: ['token'],
      removedKeys: [],
      effective: { values: {}, issues: [] },
      configWrite: 'succeeded',
      overallState: 'failed',
      targetResults: [{
        target: { pluginName: 'secure', platform: 'codex', scope: 'user' },
        state: 'failed',
        message: 'apply failed',
      }],
      otherProjectsRequireReinstall: false,
      warnings: [],
    });
    const captured = createCapturedCliIo();
    const frames: string[] = [];

    const exitCode = await runCli(['config', 'set'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: createRunner(frames),
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(1);
    expect(frames.join('\n')).toContain('操作失败');
    expect(captured.readStdout()).toBe('');
    expect(captured.readStderr()).toBe('操作失败。详细原因请使用 --debug 查看日志。\n');
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledTimes(1);
  });

  it('parses a JSON enum selection before saving and renders a copyable token', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [{ pluginName: 'json-config', version: '1.0.0', plugin: jsonPlugin, targets: [] }],
    });
    mocks.resolveCatalogPlugins.mockResolvedValue({ plugins: [jsonPlugin] });
    mocks.applyPluginConfigWrite.mockResolvedValue({
      plugin: 'json-config',
      scope: 'user',
      projectLayer: 'shared',
      updatedKeys: ['mode'],
      removedKeys: [],
      effective: { values: {}, issues: [] },
      configWrite: 'succeeded',
      overallState: 'succeeded',
      targetResults: [],
      applySkippedReason: 'noVisibleTarget',
      otherProjectsRequireReinstall: false,
      warnings: [],
    });
    const captured = createCapturedCliIo();
    const frames: string[] = [];

    const exitCode = await runCli(['config', 'set', 'json-config', 'mode', '--value-json'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: createRunner(frames, ['\r', '\r']),
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(0);
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'json-config',
      request: { updates: { mode: 'slow' } },
    }));
    const summary = frames.join('\n').replaceAll(/\s+/g, ' ');
    expect(summary).toContain(`aw config set --scope user --value-json -- json-config mode '\"slow\"'`);
    expect(JSON.parse('"slow"')).toBe('slow');
  });

  it('rejects invalid JSON before calling the helper', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.resolveCatalogPlugins.mockResolvedValue({ plugins: [plugin] });
    const captured = createCapturedCliIo();

    const exitCode = await runCli([
      'config', 'set', 'secure', 'token', 'not-json', '--value-json',
    ], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: false,
      io: captured.io,
    });

    expect(exitCode).toBe(1);
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(captured.readStderr()).toContain('Invalid JSON value for --value-json');
    expect(captured.readStderr()).not.toContain('Unexpected token');
  });

  it('parses a complete JSON argument before calling the helper', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.resolveCatalogPlugins.mockResolvedValue({ plugins: [plugin] });
    mocks.applyPluginConfigWrite.mockResolvedValue({
      plugin: 'secure',
      scope: 'user',
      projectLayer: 'shared',
      updatedKeys: ['token'],
      removedKeys: [],
      effective: { values: {}, issues: [] },
      configWrite: 'succeeded',
      overallState: 'succeeded',
      targetResults: [],
      applySkippedReason: 'noVisibleTarget',
      otherProjectsRequireReinstall: false,
      warnings: [],
    });
    const captured = createCapturedCliIo();

    const exitCode = await runCli([
      'config', 'set', 'secure', 'token', '"hunter2"', '--value-json', '--json',
    ], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: false,
      io: captured.io,
    });

    expect(exitCode).toBe(0);
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'secure',
      request: { updates: { token: 'hunter2' } },
    }));
    expect(captured.readStdout()).not.toContain('hunter2');
  });

  it('shows the original invalid wizard token and fails before calling the helper', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [{ pluginName: 'json-string', version: '1.0.0', plugin: jsonStringPlugin, targets: [] }],
    });
    mocks.resolveCatalogPlugins.mockResolvedValue({ plugins: [jsonStringPlugin] });
    const captured = createCapturedCliIo();
    const frames: string[] = [];

    const exitCode = await runCli(['config', 'set', 'json-string', 'value', '--value-json'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: createRunner(frames, ['not-json', '\r', '\r']),
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(1);
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
    const frameText = frames.join('\n');
    expect(frameText).toContain('aw config set --scope user --value-json -- json-string value not-json');
    expect(frameText).not.toContain('"not-json"');
    expect(frameText).toContain('操作失败。详细原因请使用 --debug 查看日志。');
    expect(frameText).not.toContain('Invalid JSON value for --value-json');
    expect(captured.readStdout()).toBe('');
    expect(captured.readStderr()).toBe('操作失败。详细原因请使用 --debug 查看日志。\n');
  });

  it('keeps an invalid JSON number token and fails before calling the helper', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [{ pluginName: 'json-number', version: '1.0.0', plugin: jsonNumberPlugin, targets: [] }],
    });
    mocks.resolveCatalogPlugins.mockResolvedValue({ plugins: [jsonNumberPlugin] });
    const captured = createCapturedCliIo();
    const frames: string[] = [];

    const exitCode = await runCli(['config', 'set', 'json-number', 'value', '--value-json'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: createRunner(frames, ['not-json', '\r', '\r']),
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(1);
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
    const frameText = frames.join('\n');
    expect(frameText).toContain('aw config set --scope user --value-json -- json-number value not-json');
    expect(frameText).not.toContain('aw config set --scope user --value-json -- json-number value null');
    expect(frameText).toContain('操作失败。详细原因请使用 --debug 查看日志。');
    expect(frameText).not.toContain('Invalid JSON value for --value-json');
    expect(captured.readStdout()).toBe('');
    expect(captured.readStderr()).toBe('操作失败。详细原因请使用 --debug 查看日志。\n');
  });

  it('parses a valid JSON number at the execute boundary', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [{ pluginName: 'json-number', version: '1.0.0', plugin: jsonNumberPlugin, targets: [] }],
    });
    mocks.resolveCatalogPlugins.mockResolvedValue({ plugins: [jsonNumberPlugin] });
    mocks.applyPluginConfigWrite.mockResolvedValue({
      plugin: 'json-number',
      scope: 'user',
      projectLayer: 'shared',
      updatedKeys: ['value'],
      removedKeys: [],
      effective: { values: {}, issues: [] },
      configWrite: 'succeeded',
      overallState: 'succeeded',
      targetResults: [],
      applySkippedReason: 'noVisibleTarget',
      otherProjectsRequireReinstall: false,
      warnings: [],
    });
    const captured = createCapturedCliIo();
    const frames: string[] = [];

    const exitCode = await runCli(['config', 'set', 'json-number', 'value', '--value-json'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: createRunner(frames, ['42', '\r', '\r']),
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(0);
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'json-number',
      request: { updates: { value: 42 } },
    }));
    expect(frames.join('\n')).toContain('aw config set --scope user --value-json -- json-number value 42');
  });

  it('keeps ordinary number wizard input as a number', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [{ pluginName: 'json-number', version: '1.0.0', plugin: jsonNumberPlugin, targets: [] }],
    });
    mocks.resolveCatalogPlugins.mockResolvedValue({ plugins: [jsonNumberPlugin] });
    mocks.applyPluginConfigWrite.mockResolvedValue({
      plugin: 'json-number',
      scope: 'user',
      projectLayer: 'shared',
      updatedKeys: ['value'],
      removedKeys: [],
      effective: { values: {}, issues: [] },
      configWrite: 'succeeded',
      overallState: 'succeeded',
      targetResults: [],
      applySkippedReason: 'noVisibleTarget',
      otherProjectsRequireReinstall: false,
      warnings: [],
    });
    const captured = createCapturedCliIo();

    const exitCode = await runCli(['config', 'set', 'json-number', 'value'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: createRunner([], ['42', '\r', '\r']),
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(0);
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'json-number',
      request: { updates: { value: 42 } },
    }));
  });

  it.each([
    { name: 'empty', input: '' },
    { name: 'whitespace-only', input: '   ' },
    { name: 'NaN', input: 'NaN' },
    { name: 'Infinity', input: 'Infinity' },
  ])('rejects $name ordinary number input before writing', async ({ input }) => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [{ pluginName: 'json-number', version: '1.0.0', plugin: jsonNumberPlugin, targets: [] }],
    });
    mocks.resolveCatalogPlugins.mockResolvedValue({ plugins: [jsonNumberPlugin] });
    const captured = createCapturedCliIo();
    const frames: string[] = [];
    const inputs = [...(input ? [input] : []), '\r', '\r'];

    const exitCode = await runCli(['config', 'set', 'json-number', 'value'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: createRunner(frames, inputs),
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(1);
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(frames.join('\n')).toContain('操作失败。详细原因请使用 --debug 查看日志。');
    expect(frames.join('\n')).not.toContain('Config "value" must be a number.');
    expect(captured.readStdout()).toBe('');
    expect(captured.readStderr()).toBe('操作失败。详细原因请使用 --debug 查看日志。\n');
  });

  it.each([
    '--not-a-real-value',
    "folder path/it's here",
  ])('replays a generated config set token list with value %s through Commander', async (value) => {
    const { buildEquivalentConfigCommandTokens, runCli } = await import('../../src/index.js');
    mocks.resolveCatalogPlugins.mockResolvedValue({ plugins: [jsonStringPlugin] });
    mocks.applyPluginConfigWrite.mockResolvedValue({
      plugin: 'json-string',
      scope: 'user',
      projectLayer: 'shared',
      updatedKeys: ['value'],
      removedKeys: [],
      effective: { values: {}, issues: [] },
      configWrite: 'succeeded',
      overallState: 'succeeded',
      targetResults: [],
      applySkippedReason: 'noVisibleTarget',
      otherProjectsRequireReinstall: false,
      warnings: [],
    });
    const tokens = buildEquivalentConfigCommandTokens({
      command: 'set',
      plugin: 'json-string',
      key: 'value',
      value,
      scope: 'user',
      catalogVersion: '2.0.0-beta.1',
    });
    const captured = createCapturedCliIo();

    const exitCode = await runCli(tokens.slice(1), {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: false,
      io: captured.io,
    });

    expect(tokens).toEqual([
      'aw', 'config', 'set', '--scope', 'user', '--catalog-version', '2.0.0-beta.1',
      '--', 'json-string', 'value', value,
    ]);
    expect(exitCode).toBe(0);
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'json-string',
      request: { updates: { value } },
    }));
  });

  it.each([
    { command: 'list' as const, key: undefined, value: undefined },
    { command: 'get' as const, key: '-key', value: undefined },
    { command: 'set' as const, key: '-key', value: '-value' },
    { command: 'unset' as const, key: '-key', value: undefined },
    { command: 'reset' as const, key: undefined, value: undefined },
  ])('places config $command options before the positional boundary', async ({ command, key, value }) => {
    const { buildEquivalentConfigCommandTokens } = await import('../../src/index.js');
    const tokens = buildEquivalentConfigCommandTokens({
      command,
      plugin: '-plugin',
      key,
      value,
      scope: 'project',
      projectLayer: 'local',
      valueJson: command === 'set',
      confirmed: command === 'reset',
      catalogChannel: 'beta',
    });
    const boundary = tokens.indexOf('--');

    expect(boundary).toBeGreaterThan(2);
    expect(tokens.slice(boundary + 1)).toEqual([
      '-plugin',
      ...(key === undefined ? [] : [key]),
      ...(value === undefined ? [] : [value]),
    ]);
    expect(tokens.slice(0, boundary)).toContain('--scope');
    expect(tokens.slice(0, boundary)).toContain('--local');
    if (command === 'set') expect(tokens.slice(0, boundary)).toContain('--value-json');
    if (command === 'reset') expect(tokens.slice(0, boundary)).toContain('--yes');
  });

  it('keeps a sensitive JSON value out of the template', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [{ pluginName: 'secure', version: '1.0.0', plugin, targets: [] }],
    });
    mocks.resolveCatalogPlugins.mockResolvedValue({ plugins: [plugin] });
    mocks.applyPluginConfigWrite.mockResolvedValue({
      plugin: 'secure',
      scope: 'user',
      projectLayer: 'shared',
      updatedKeys: ['token'],
      removedKeys: [],
      effective: { values: {}, issues: [] },
      configWrite: 'succeeded',
      overallState: 'succeeded',
      targetResults: [],
      applySkippedReason: 'noVisibleTarget',
      otherProjectsRequireReinstall: false,
      warnings: [],
    });
    const captured = createCapturedCliIo();
    const frames: string[] = [];

    const exitCode = await runCli(['config', 'set', 'secure', 'token', '--value-json'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: createRunner(frames, ['"hunter2"', '\r', '\r']),
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(0);
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'secure',
      request: { updates: { token: 'hunter2' } },
    }));
    const output = `${frames.join('\n')}\n${captured.readStdout()}\n${captured.readStderr()}`;
    expect(output).not.toContain('hunter2');
    expect(output).toContain('<sensitive-value>');
    expect(output).toContain('命令模板');
  });

  it('rejects an explicit current plugin without a config schema before mounting', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [{ pluginName: 'git', version: '1.0.0', plugin: pluginWithoutSchema, targets: [] }],
    });
    const captured = createCapturedCliIo();
    const launch = vi.fn();

    const exitCode = await runCli(['config', 'set', 'git'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(1);
    expect(launch).not.toHaveBeenCalled();
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(captured.readStdout()).toBe('');
    expect(captured.readStderr()).toContain('configSchemaUnavailable');
  });

  it('rejects an empty configurable candidate list before mounting', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [],
    });
    const captured = createCapturedCliIo();
    const launch = vi.fn();

    const exitCode = await runCli(['config', 'set'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(1);
    expect(launch).not.toHaveBeenCalled();
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(captured.readStderr()).toContain('configSchemaUnavailable');
  });

  it('rejects a complete unknown plugin write before calling the helper', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.resolveCatalogPlugins.mockRejectedValue(new Error('Unknown plugin "missing".'));
    const captured = createCapturedCliIo();

    const exitCode = await runCli(['config', 'set', 'missing', 'key', 'value'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: false,
      io: captured.io,
    });

    expect(exitCode).toBe(1);
    expect(mocks.applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(captured.readStderr()).toContain('Unknown plugin "missing".');
  });

  it.each([
    {
      name: 'complete',
      argv: ['config', 'unset', 'legacy-plugin', 'old key'],
      inputs: null,
      scope: 'user' as const,
      projectLayer: 'shared' as const,
    },
    {
      name: 'missing-key wizard',
      argv: ['config', 'unset', 'legacy-plugin'],
      inputs: ['\r', '\r', '\r'],
      scope: 'user' as const,
      projectLayer: 'shared' as const,
    },
    {
      name: 'missing-plugin user wizard',
      argv: ['config', 'unset'],
      inputs: ['\r', '\r', '\r'],
      scope: 'user' as const,
      projectLayer: 'shared' as const,
    },
    {
      name: 'missing-plugin project local wizard',
      argv: ['config', 'unset', '--scope', 'project', '--local'],
      inputs: ['\r', '\r', '\r'],
      scope: 'project' as const,
      projectLayer: 'local' as const,
    },
  ])('routes a legacy store $name unset through the remove-only helper', async ({
    argv,
    inputs,
    scope,
    projectLayer,
  }) => {
    const { runCli } = await import('../../src/index.js');
    mocks.resolveCatalogPlugins.mockRejectedValue(new Error('Unknown plugin "legacy-plugin".'));
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [],
    });
    mocks.readPluginConfigStore.mockResolvedValue({
      path: '/tmp/config.json',
      exists: true,
      values: { 'old key': 'secret legacy value' },
    });
    mocks.listPluginConfigStorePluginNames.mockResolvedValue(['legacy-plugin']);
    mocks.applyPluginConfigWrite.mockResolvedValue({
      plugin: 'legacy-plugin',
      scope: 'user',
      projectLayer: 'shared',
      updatedKeys: [],
      removedKeys: ['old key'],
      effective: { values: {}, sources: {}, issues: [], ignoredUnknownKeys: [] },
      configWrite: 'succeeded',
      overallState: 'succeeded',
      targetResults: [],
      applySkippedReason: 'currentCatalogUnavailable',
      otherProjectsRequireReinstall: false,
      warnings: [],
    });
    const captured = createCapturedCliIo();
    const frames: string[] = [];
    const nativeCliRunner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    const exitCode = await runCli(argv, {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      nativeCliRunner,
      ...(inputs
        ? { tuiRunner: createRunner(frames, inputs), ...createTtyRuntimeStreams() }
        : {}),
    });

    expect(exitCode).toBe(0);
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'legacy-plugin',
      scope,
      projectLayer,
      request: { removeKeys: ['old key'] },
    }));
    expect(mocks.applyPluginConfigWrite).toHaveBeenCalledTimes(1);
    expect(nativeCliRunner).not.toHaveBeenCalled();
    if (inputs) {
      expect(mocks.listPluginConfigStorePluginNames).toHaveBeenCalledWith(expect.objectContaining({
        scope,
        ...(scope === 'project' ? { projectLayer } : {}),
      }));
    }
  });

  it('selects and resets a catalog-external user store', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [],
    });
    mocks.listPluginConfigStorePluginNames.mockResolvedValue(['legacy-plugin']);
    mocks.readPluginConfigStore.mockResolvedValue({
      path: '/tmp/config.json',
      exists: true,
      values: { old: 'secret legacy value' },
    });
    mocks.resolveCatalogPlugins.mockRejectedValue(new Error('Unknown plugin "legacy-plugin".'));
    mocks.describeResetAffectedFields.mockResolvedValue([]);
    mocks.resetPluginConfigWithHelper.mockResolvedValue({
      plugin: 'legacy-plugin',
      scope: 'user',
      projectLayer: 'shared',
      existed: true,
      deleted: true,
      removedKeys: ['old'],
      configWrite: 'succeeded',
      overallState: 'succeeded',
      targetResults: [],
      applySkippedReason: 'currentCatalogUnavailable',
      otherProjectsRequireReinstall: false,
      warnings: [],
    });
    const captured = createCapturedCliIo();
    const nativeCliRunner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    const exitCode = await runCli(['config', 'reset', '--scope', 'user'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      nativeCliRunner,
      tuiRunner: createRunner([], ['\r', '\r']),
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(0);
    expect(mocks.resetPluginConfigWithHelper).toHaveBeenCalledTimes(1);
    expect(nativeCliRunner).not.toHaveBeenCalled();
    expect(mocks.resetPluginConfigWithHelper).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'legacy-plugin',
      scope: 'user',
      projectLayer: 'shared',
    }));
  });

  it('updates reset candidates after selecting the project scope', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [],
    });
    mocks.listPluginConfigStorePluginNames.mockImplementation(async (options) =>
      options.scope === 'project' ? ['project-legacy'] : []);
    mocks.readPluginConfigStore.mockResolvedValue({
      path: '/tmp/config.json',
      exists: true,
      values: { old: 'secret legacy value' },
    });
    mocks.resolveCatalogPlugins.mockRejectedValue(new Error('Unknown plugin "project-legacy".'));
    mocks.describeResetAffectedFields.mockResolvedValue([]);
    mocks.resetPluginConfigWithHelper.mockResolvedValue({
      plugin: 'project-legacy',
      scope: 'project',
      projectLayer: 'shared',
      existed: true,
      deleted: true,
      removedKeys: ['old'],
      configWrite: 'succeeded',
      overallState: 'succeeded',
      targetResults: [],
      applySkippedReason: 'currentCatalogUnavailable',
      otherProjectsRequireReinstall: false,
      warnings: [],
    });
    const captured = createCapturedCliIo();

    const exitCode = await runCli(['config', 'reset'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: createRunner([], ['\u001B[B', '\r', '\r', '\r']),
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(0);
    expect(mocks.resetPluginConfigWithHelper).toHaveBeenCalledWith(expect.objectContaining({
      pluginName: 'project-legacy',
      scope: 'project',
      projectLayer: 'shared',
    }));
  });

  it.each(['list', 'get'] as const)('selects a catalog-external store for config %s', async (command) => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [],
    });
    mocks.listPluginConfigStorePluginNames.mockResolvedValue(['legacy-plugin']);
    mocks.readPluginConfigStore.mockResolvedValue({
      path: '/tmp/config.json',
      exists: true,
      values: { old: 'secret legacy value' },
    });
    mocks.resolveCatalogPlugins.mockRejectedValue(new Error('Unknown plugin "legacy-plugin".'));
    mocks.resolveConfigRead.mockResolvedValue({
      pluginName: 'legacy-plugin',
      scope: 'effective',
      projectLayer: 'shared',
      fields: [{
        key: 'old',
        title: 'old',
        kind: 'manifest',
        reserved: false,
        writable: false,
        valueState: 'configured',
        effectiveValue: '[redacted]',
        sourceLayer: 'user',
      }],
    });
    const captured = createCapturedCliIo();

    const exitCode = await runCli(['config', command], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: createRunner([], ['\r', '\r']),
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(0);
    expect(captured.readStdout()).toContain('old: configured');
    expect(captured.readStdout()).toContain('[redacted]');
    expect(captured.readStdout()).not.toContain('secret legacy value');
  });

  it.each(['unset', 'reset'] as const)('rejects empty config %s candidates before mounting', async (command) => {
    const { runCli } = await import('../../src/index.js');
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [],
    });
    const captured = createCapturedCliIo();
    const launch = vi.fn();

    const exitCode = await runCli(['config', command, '--scope', 'user'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(1);
    expect(launch).not.toHaveBeenCalled();
    expect(captured.readStderr()).toContain('No plugin config candidates');
  });

  it('rejects an unknown legacy key without mounting a wizard', async () => {
    const { runCli } = await import('../../src/index.js');
    mocks.resolveCatalogPlugins.mockRejectedValue(new Error('Unknown plugin "legacy-plugin".'));
    mocks.readPluginConfigStore.mockResolvedValue({
      path: '/tmp/config.json',
      exists: true,
      values: { known: 'old' },
    });
    mocks.applyPluginConfigWrite.mockRejectedValue(new Error('Unknown config key "missing".'));
    const captured = createCapturedCliIo();
    const launch = vi.fn();

    const exitCode = await runCli(['config', 'unset', 'legacy-plugin', 'missing'], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: { launch } as never,
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(1);
    expect(launch).not.toHaveBeenCalled();
    expect(captured.readStderr()).toContain('Unknown config key "missing".');
  });

  it('quotes dynamic config arguments and keeps selectors, scope, and local behavior', async () => {
    const { runCli } = await import('../../src/index.js');
    const quotedPlugin = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        name: 'secure',
        config: {
          schema: {
            "path key's": { type: 'string' as const, title: 'Path' },
          },
        },
      },
    };
    mocks.loadConsoleItemsResult.mockResolvedValue({
      catalogUnavailable: false,
      status: {
        schemaVersion: 3,
        catalog: {},
        filters: { plugins: [], platform: 'both', cwd: '/workspace' },
        targets: [],
        errors: [],
      },
      items: [{ pluginName: 'secure', version: '1.0.0', plugin: quotedPlugin, targets: [] }],
    });
    mocks.resolveCatalogPlugins.mockResolvedValue({ plugins: [quotedPlugin] });
    mocks.applyPluginConfigWrite.mockResolvedValue({
      plugin: 'secure',
      scope: 'project',
      projectLayer: 'local',
      updatedKeys: ["path key's"],
      removedKeys: [],
      effective: { values: {}, sources: {}, issues: [], ignoredUnknownKeys: [] },
      configWrite: 'succeeded',
      overallState: 'succeeded',
      targetResults: [],
      applySkippedReason: 'noVisibleTarget',
      otherProjectsRequireReinstall: false,
      warnings: [],
    });
    const captured = createCapturedCliIo();
    const frames: string[] = [];
    const value = "folder path/it's here";

    const exitCode = await runCli([
      'config', 'set', '--scope', 'project', '--local', '--catalog-version', '2.0.0-beta.1',
    ], {
      cwd: '/workspace',
      env: { CI: undefined },
      interactive: true,
      io: captured.io,
      tuiRunner: createRunner(frames, ['\r', '\r', value, '\r', '\r']),
      ...createTtyRuntimeStreams(),
    });

    expect(exitCode).toBe(0);
    expect(frames.join('\n').replaceAll(/\s+/g, ' ')).toContain(
      'aw config set --scope project --local --catalog-version 2.0.0-beta.1',
    );
  });
});
