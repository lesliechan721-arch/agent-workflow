import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandWizardResult } from '../../src/commands/wizard.js';
import { CommandWizard } from '../../src/tui/wizard.js';

afterEach(() => cleanup());

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('command wizard', () => {
  it('keeps platform, multi-plugin selection, confirmation, and execution in one mount', async () => {
    const execute = vi.fn(async (selection) => ({ selection }));
    let completed: CommandWizardResult<unknown> | undefined;
    const instance = render(<CommandWizard
      request={{
        command: 'install',
        candidates: [
          { pluginName: 'alpha', targets: [] },
          { pluginName: 'beta', targets: [] },
        ],
        initial: { plugins: [], scope: 'user' },
        pluginMode: 'multiple',
        promptForPlatform: true,
        equivalentCommand: (selection) => `aw install ${selection.plugins.join(' ')} --platform ${selection.platform}`,
        execute,
      }}
      onComplete={(result) => { completed = result; }}
    />);
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    instance.stdin.write(' ');
    await nextTurn();
    instance.stdin.write('\u001B[B');
    await nextTurn();
    instance.stdin.write(' ');
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    expect(instance.lastFrame()).toContain('等价命令');
    instance.stdin.write('\r');
    await nextTurn();
    await nextTurn();
    expect(instance.lastFrame()).toContain('执行结果');
    instance.stdin.write('\r');
    await nextTurn();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      plugins: ['alpha', 'beta'],
      platform: 'both',
      scope: 'user',
    }));
    expect(completed).toMatchObject({ cancelled: false });
  });

  it('does not render or expose a sensitive config value', async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    let completed: CommandWizardResult<unknown> | undefined;
    const instance = render(<CommandWizard
      request={{
        command: 'config:set',
        candidates: [{
          pluginName: 'secure',
          targets: [],
          configSchema: { token: { type: 'string', sensitive: true } },
        }],
        initial: { plugins: [], scope: 'user', projectLayer: 'shared' },
        pluginMode: 'single',
        promptForKey: true,
        promptForValue: true,
        equivalentCommand: () => 'aw config set secure token <sensitive-value>',
        execute,
      }}
      onComplete={(result) => { completed = result; }}
    />);
    await nextTurn();
    for (const input of ['\r', '\r', 'hunter2', '\r', '\r']) {
      instance.stdin.write(input);
      await nextTurn();
    }
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();

    expect(instance.frames.join('\n')).not.toContain('hunter2');
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ value: 'hunter2' }));
    expect(completed).toMatchObject({ cancelled: false });
  });

  it('cancels before execution', async () => {
    const execute = vi.fn();
    let completed: CommandWizardResult<unknown> | undefined;
    const instance = render(<CommandWizard
      request={{
        command: 'cleanup',
        candidates: [{ pluginName: 'alpha', targets: [] }],
        initial: { plugins: [], platform: 'codex', scope: 'user' },
        pluginMode: 'single',
        destructive: true,
        equivalentCommand: () => 'aw cleanup alpha --platform codex --scope user',
        execute,
      }}
      onComplete={(result) => { completed = result; }}
    />);
    await nextTurn();
    instance.stdin.write('q');
    await nextTurn();

    expect(execute).not.toHaveBeenCalled();
    expect(completed).toEqual({ cancelled: true });
  });

  it('waits for an active write before honoring Ctrl-C', async () => {
    let finish!: () => void;
    const execute = vi.fn(() => new Promise<{ ok: true }>((resolve) => {
      finish = () => resolve({ ok: true });
    }));
    let completed: CommandWizardResult<unknown> | undefined;
    const instance = render(<CommandWizard
      request={{
        command: 'uninstall',
        candidates: [],
        initial: { plugins: ['alpha'], platform: 'codex', scope: 'user' },
        pluginMode: 'none',
        destructive: true,
        equivalentCommand: () => 'aw uninstall alpha --platform codex --scope user',
        execute,
      }}
      onComplete={(result) => { completed = result; }}
    />);
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    expect(instance.lastFrame()).toContain('正在执行');
    instance.stdin.write('\u0003');
    await nextTurn();
    expect(completed).toBeUndefined();
    finish();
    await nextTurn();
    await nextTurn();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(completed).toMatchObject({ cancelled: false });
  });

  it.each([
    { name: 'success', execute: async () => ({ ok: true }), hasError: false },
    { name: 'failure', execute: async () => { throw new Error('write failed'); }, hasError: true },
  ])('returns the settled $name result when Ctrl-C closes the result page', async ({ execute, hasError }) => {
    let completed: CommandWizardResult<unknown> | undefined;
    const instance = render(<CommandWizard
      request={{
        command: 'install',
        candidates: [],
        initial: { plugins: ['alpha'], platform: 'codex', scope: 'user' },
        pluginMode: 'none',
        equivalentCommand: () => 'aw install alpha --platform codex --scope user',
        execute,
      }}
      onComplete={(result) => { completed = result; }}
    />);
    await nextTurn();
    instance.stdin.write('\r');
    await nextTurn();
    await nextTurn();
    expect(instance.lastFrame()).toContain('执行结果');
    instance.stdin.write('\u0003');
    await nextTurn();

    expect(completed).toMatchObject({ cancelled: false });
    expect(completed?.error !== undefined).toBe(hasError);
  });
});
