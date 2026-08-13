import { PassThrough } from 'node:stream';

import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createInkPrompt } from '../../src/tui/prompt.js';
import { resolveTuiKeyAction } from '../../src/tui/keys.js';
import { resolveTuiSizePolicy } from '../../src/tui/layout.js';
import type { TuiLaunchRequest, TuiRunner } from '../../src/tui/runner.js';

afterEach(() => {
  cleanup();
});

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createTestingRunner(sessions: string[][]): {
  runner: TuiRunner;
  frames: string[];
} {
  const queue = [...sessions];
  const frames: string[] = [];
  return {
    frames,
    runner: {
      async launch<T>(request: TuiLaunchRequest<T>): Promise<T> {
        const inputs = queue.shift();
        if (!inputs) {
          throw new Error('Missing TUI test session.');
        }
        let complete!: (result: T) => void;
        const resultPromise = new Promise<T>((resolve) => {
          complete = resolve;
        });
        const instance = render(request.render(complete));
        await nextTurn();
        for (const input of inputs) {
          instance.stdin.write(input);
          await nextTurn();
        }
        const result = await resultPromise;
        frames.push(...instance.frames);
        instance.unmount();
        instance.cleanup();
        return result;
      },
    },
  };
}

function createPrompt(sessions: string[][]): {
  prompt: ReturnType<typeof createInkPrompt>;
  frames: string[];
} {
  const testing = createTestingRunner(sessions);
  return {
    frames: testing.frames,
    prompt: createInkPrompt({
      input: new PassThrough(),
      outputSink: { isTTY: true, write: () => undefined },
      runner: testing.runner,
    }),
  };
}

describe('TUI foundation', () => {
  it('applies the three-column, single-column, and minimum-size policies', () => {
    expect(resolveTuiSizePolicy(110, 18).mode).toBe('three-column');
    expect(resolveTuiSizePolicy(109, 18).mode).toBe('single-column');
    expect(resolveTuiSizePolicy(60, 16).mode).toBe('single-column');
    expect(resolveTuiSizePolicy(59, 16)).toMatchObject({
      mode: 'too-small',
      message: expect.stringContaining('至少 60 列 × 16 行'),
    });
    expect(resolveTuiSizePolicy(120, 15).mode).toBe('too-small');
  });

  it('maps global navigation keys without consuming normal text input', () => {
    const key = (ctrl = false, escape = false) => ({ ctrl, escape });
    expect(resolveTuiKeyAction({ input: 'c', key: key(true) }, { mode: 'text' })).toBe('exit');
    expect(resolveTuiKeyAction({ input: '', key: key(false, true) }, {
      mode: 'menu',
      allowBack: true,
    })).toBe('back');
    expect(resolveTuiKeyAction({ input: '', key: key(false, true) }, { mode: 'text' })).toBe('cancel');
    expect(resolveTuiKeyAction({ input: 'q', key: key() }, { mode: 'menu' })).toBe('exit');
    expect(resolveTuiKeyAction({ input: 'q', key: key() }, { mode: 'text' })).toBeNull();
    expect(resolveTuiKeyAction({ input: 'b', key: key() }, { mode: 'text' })).toBeNull();
  });

  it('returns stable select, confirm, text, and password contracts', async () => {
    const selectPrompt = createPrompt([['\r']]).prompt;
    await expect(selectPrompt.select!({
      message: '选择',
      choices: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      defaultValue: 'b',
    })).resolves.toEqual({ action: 'select', cancelled: false, value: 'b' });

    const confirmPrompt = createPrompt([['\r']]).prompt;
    await expect(confirmPrompt.confirm!({
      message: '确认',
      defaultValue: false,
    })).resolves.toEqual({ action: 'select', cancelled: false, value: false });

    const textPrompt = createPrompt([['hello', '\r']]).prompt;
    await expect(textPrompt.input!({ message: '名称' })).resolves.toEqual({
      action: 'select',
      cancelled: false,
      value: 'hello',
    });

    const password = createPrompt([['hunter2', '\r']]);
    await expect(password.prompt.password!({ message: '密钥' })).resolves.toEqual({
      action: 'select',
      cancelled: false,
      value: 'hunter2',
    });
    expect(password.frames.join('\n')).not.toContain('hunter2');
    expect(password.frames.join('\n')).toContain('*');
  });

  it('supports multi-select and filters disabled choices', async () => {
    const { prompt } = createPrompt([['\u001B[B', ' ', '\r']]);
    await expect(prompt.multiSelect!({
      message: '选择多个',
      choices: [
        { value: 'a', label: 'A' },
        { value: 'disabled', label: 'Disabled', disabled: true },
        { value: 'b', label: 'B' },
      ],
      defaultValues: ['a'],
    })).resolves.toEqual({
      action: 'select',
      cancelled: false,
      value: ['a', 'b'],
    });
  });

  it('returns back, exit, cancel, and Ctrl-C results', async () => {
    const choices = [
      { value: 'a', label: 'A' },
      { value: 'back', label: '返回', role: 'back' as const },
    ];
    await expect(createPrompt([['\u001B']]).prompt.select!({
      message: '菜单',
      choices,
    })).resolves.toEqual({ action: 'back', cancelled: false });
    await expect(createPrompt([['q']]).prompt.select!({
      message: '菜单',
      choices,
    })).resolves.toEqual({ action: 'exit', cancelled: false });
    await expect(createPrompt([['\u001B']]).prompt.input!({
      message: '文本',
    })).resolves.toEqual({ action: 'cancel', cancelled: true });
    await expect(createPrompt([['\u0003']]).prompt.password!({
      message: '密钥',
    })).resolves.toEqual({ action: 'exit', cancelled: false });
  });

  it('keeps the platform, scope, plugin, upgrade, and config convenience contracts', async () => {
    await expect(createPrompt([['\r']]).prompt.selectPlatform!({
      available: ['codex', 'claude', 'both'],
      defaultValue: 'both',
    })).resolves.toBe('both');
    await expect(createPrompt([['\r']]).prompt.selectScope!({
      defaultValue: 'project',
    })).resolves.toBe('project');
    await expect(createPrompt([['\u001B[B', ' ', '\r']]).prompt.selectPlugins!({
      command: 'install',
      candidates: [
        { id: 'a', pluginName: 'A', selectable: true },
        { id: 'b', pluginName: 'B', selectable: true },
      ],
      defaultValues: ['a'],
      allowMultiple: true,
    })).resolves.toEqual(['a', 'b']);
    await expect(createPrompt([['\r']]).prompt.selectUpgradeMode!({
      canUpgradeAll: false,
      candidates: [],
    })).resolves.toBe('select');

    const config = createPrompt([['secret-value', '\r']]);
    await expect(config.prompt.configurePlugin!({
      pluginName: 'secure',
      schema: {
        token: {
          type: 'string',
          label: 'Token',
          required: true,
          sensitive: true,
        },
      },
      initialScope: 'user',
      allowedScopes: ['user'],
    })).resolves.toEqual({
      selectedScope: 'user',
      updates: { token: 'secret-value' },
      updatedKeys: ['token'],
      removeKeys: [],
      cancelled: false,
    });
    expect(config.frames.join('\n')).not.toContain('secret-value');

    await expect(createPrompt([['\u001B']]).prompt.configurePlugin!({
      pluginName: 'secure',
      schema: {
        token: { type: 'string', required: true, sensitive: true },
      },
      initialScope: 'user',
      allowedScopes: ['user'],
    })).resolves.toMatchObject({
      selectedScope: 'user',
      updates: {},
      updatedKeys: [],
      cancelled: true,
    });
  });

  it('restores raw mode and leaves the alternate screen after a real session', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode: (mode: boolean) => void;
      ref: () => PassThrough;
      unref: () => PassThrough;
    };
    input.isTTY = true;
    input.isRaw = false;
    const setRawMode = vi.fn((mode: boolean) => {
      input.isRaw = mode;
    });
    input.setRawMode = setRawMode;
    input.ref = () => input;
    input.unref = () => input;
    const output: string[] = [];
    const context = createCliExecutionContext({
      stdin: input,
      stdout: { isTTY: true },
      promptOutputSink: {
        isTTY: true,
        write: (text) => output.push(text),
      },
      env: { ...process.env, CI: undefined },
      diagnostics: { commandName: 'tui-test' },
    });
    const resultPromise = context.prompt.select!({
      message: '选择',
      choices: [{ value: 'a', label: 'A' }],
    });
    await nextTurn();
    input.write('\r');

    await expect(resultPromise).resolves.toEqual({
      action: 'select',
      cancelled: false,
      value: 'a',
    });
    expect(setRawMode).toHaveBeenCalledWith(true);
    expect(setRawMode).toHaveBeenLastCalledWith(false);
    expect(input.isRaw).toBe(false);
    expect(output.join('')).toContain('\u001B[?1049h');
    expect(output.join('')).toContain('\u001B[?1049l');
  });
});
