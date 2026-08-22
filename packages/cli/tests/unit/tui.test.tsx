import { PassThrough } from 'node:stream';

import { cleanup, render } from 'ink-testing-library';
import { Text } from 'ink';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createInkPrompt } from '../../src/tui/prompt.js';
import { resolveTuiKeyAction } from '../../src/tui/keys.js';
import { resolveTuiSizePolicy } from '../../src/tui/layout.js';
import { createInkTuiRunner, type TuiLaunchRequest, type TuiRunner } from '../../src/tui/runner.js';
import { MultiSelectView, SelectView } from '../../src/tui/views.js';

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
  it('applies the standard, compact, and minimum-size policies', () => {
    expect(resolveTuiSizePolicy(120, 30).mode).toBe('single-column');
    expect(resolveTuiSizePolicy(80, 24).mode).toBe('single-column');
    expect(resolveTuiSizePolicy(79, 24).mode).toBe('compact');
    expect(resolveTuiSizePolicy(80, 23).mode).toBe('compact');
    expect(resolveTuiSizePolicy(60, 18).mode).toBe('compact');
    expect(resolveTuiSizePolicy(59, 18)).toMatchObject({
      mode: 'too-small',
      message: expect.stringContaining('至少 60 列 × 18 行'),
    });
    expect(resolveTuiSizePolicy(120, 17).mode).toBe('too-small');
  });

  it('renders only the size hint below the minimum terminal size', async () => {
    const tooNarrow = render(<SelectView
      message="不应显示的标题"
      choices={[{ value: 'a', label: '不应显示的选项' }]}
      size={{ columns: 59, rows: 18 }}
      onComplete={() => undefined}
    />);
    const tooShort = render(<SelectView
      message="另一个不应显示的标题"
      choices={[{ value: 'a', label: '另一个不应显示的选项' }]}
      size={{ columns: 80, rows: 17 }}
      onComplete={() => undefined}
    />);
    await nextTurn();

    expect(tooNarrow.lastFrame()).toContain('请将终端调整到至少 60 列 × 18 行');
    expect(tooNarrow.lastFrame()).not.toContain('不应显示的标题');
    expect(tooNarrow.lastFrame()).not.toContain('不应显示的选项');
    expect(tooShort.lastFrame()).toContain('请将终端调整到至少 60 列 × 18 行');
    expect(tooShort.lastFrame()).not.toContain('另一个不应显示的标题');
  });

  it('ignores hidden select and multi-select business input below the minimum size', async () => {
    const selectComplete = vi.fn();
    const multiComplete = vi.fn();
    const select = render(<SelectView
      message="选择"
      choices={[
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ]}
      size={{ columns: 59, rows: 18 }}
      onComplete={selectComplete}
    />);
    const multi = render(<MultiSelectView
      message="选择多个"
      choices={[
        { value: 'a', label: 'Alpha' },
        { value: 'b', label: 'Beta' },
      ]}
      size={{ columns: 59, rows: 18 }}
      onComplete={multiComplete}
    />);
    await nextTurn();

    for (const input of ['\u001B[B', 'j', ' ', '\r']) {
      select.stdin.write(input);
      multi.stdin.write(input);
      await nextTurn();
    }
    expect(selectComplete).not.toHaveBeenCalled();
    expect(multiComplete).not.toHaveBeenCalled();

    select.stdin.write('q');
    multi.stdin.write('q');
    await nextTurn();
    expect(selectComplete).toHaveBeenCalledWith({ action: 'exit', cancelled: false });
    expect(multiComplete).toHaveBeenCalledWith({ action: 'exit', cancelled: false });
  });

  it('renders descriptions and keeps one focus sequence at 60 and 80 columns', async () => {
    const choices = [
      { value: 'alpha', label: 'Alpha', description: 'Alpha 的用途说明' },
      { value: 'disabled', label: 'Disabled', description: '禁用项仍有说明', disabled: '当前不可用' },
      { value: 'gamma', label: 'Gamma', description: 'Gamma 的用途说明' },
    ];
    const instances = [
      { rows: 24, instance: render(<SelectView
        message="选择插件"
        choices={choices}
        size={{ columns: 80, rows: 24 }}
        onComplete={() => undefined}
      />) },
      { rows: 18, instance: render(<SelectView
        message="选择插件"
        choices={choices}
        size={{ columns: 60, rows: 18 }}
        onComplete={() => undefined}
      />) },
    ];
    await nextTurn();

    for (const { instance, rows } of instances) {
      const initial = instance.lastFrame() ?? '';
      expect(initial).toContain('Alpha 的用途说明');
      expect(initial).toContain('禁用项仍有说明');
      expect(initial).toContain('Disabled（当前不可用）');
      expect(initial.match(/›/g)).toHaveLength(1);
      expect(initial.split('\n').length).toBeLessThanOrEqual(rows);

      instance.stdin.write('\u001B[B');
      await nextTurn();
      const moved = instance.lastFrame() ?? '';
      expect(moved.match(/›/g)).toHaveLength(1);
      expect(moved).toMatch(/›\s+Gamma/);
    }
  });

  it('renders multi-select descriptions with a single focused choice', async () => {
    const instance = render(<MultiSelectView
      message="选择多个"
      choices={[
        { value: 'a', label: 'Alpha', description: '第一个能力说明' },
        { value: 'b', label: 'Beta', description: '第二个能力说明' },
      ]}
      defaultValues={['a']}
      size={{ columns: 60, rows: 18 }}
      onComplete={() => undefined}
    />);
    await nextTurn();

    expect(instance.lastFrame()).toContain('第一个能力说明');
    expect(instance.lastFrame()).toContain('第二个能力说明');
    expect(instance.lastFrame()?.match(/›/g)).toHaveLength(1);
  });

  it('keeps the last described choice and help visible in 60x18 long lists', async () => {
    const choices = Array.from({ length: 18 }, (_, index) => ({
      value: `plugin-${index}`,
      label: `Plugin ${index}`,
      description: `Plugin ${index} 的单行说明`,
    }));
    const instance = render(<SelectView
      message="选择插件"
      choices={choices}
      pageSize={15}
      size={{ columns: 60, rows: 18 }}
      onComplete={() => undefined}
    />);
    const multi = render(<MultiSelectView
      message="选择插件"
      choices={choices}
      pageSize={15}
      size={{ columns: 60, rows: 18 }}
      onComplete={() => undefined}
    />);
    await nextTurn();

    for (let index = 1; index < choices.length; index += 1) {
      instance.stdin.write('\u001B[B');
      multi.stdin.write('\u001B[B');
      await nextTurn();
    }

    expect(instance.lastFrame()).toMatch(/›\s+Plugin 17/);
    expect(instance.lastFrame()).toContain('Plugin 17 的单行说明');
    expect(instance.lastFrame()).toContain('Enter 选择');
    expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(18);
    expect(multi.lastFrame()).toMatch(/›\s+◇ Plugin 17/);
    expect(multi.lastFrame()).toContain('Plugin 17 的单行说明');
    expect(multi.lastFrame()).toContain('Enter 完成');
    expect(multi.lastFrame()?.split('\n').length).toBeLessThanOrEqual(18);
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

  it('keeps the first completion when a real mounted session completes twice', async () => {
    const input = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode: (mode: boolean) => void;
      ref: () => PassThrough;
      unref: () => PassThrough;
    };
    input.isTTY = true;
    input.isRaw = false;
    input.setRawMode = (mode) => { input.isRaw = mode; };
    input.ref = () => input;
    input.unref = () => input;
    const CompleteTwice = (props: { complete: (value: number) => void }) => {
      useEffect(() => {
        props.complete(7);
        props.complete(9);
      }, [props.complete]);
      return <Text>完成</Text>;
    };

    await expect(createInkTuiRunner().launch({
      input,
      output: { isTTY: true, write: () => undefined },
      render: (complete) => <CompleteTwice complete={complete} />,
    })).resolves.toBe(7);
  });
});
