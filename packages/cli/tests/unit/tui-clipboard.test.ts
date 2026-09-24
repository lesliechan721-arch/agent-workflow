import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { copyToClipboard } from '../../src/tui/clipboard.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const text = '第一行 $(不可执行)\n第二行 `保留原文`\n';
const failureMessage = '无法复制到系统剪贴板。请检查剪贴板工具和桌面会话。';
const missing = Object.assign(new Error('missing tool'), { code: 'ENOENT' });

function fakeChild(inputError?: Error) {
  const chunks: Buffer[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 1234,
    exitCode: null as number | null,
    signalCode: null,
    stdin: new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback(inputError);
      },
    }),
    kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  return { child, chunks };
}

describe('TUI clipboard', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('passes the whole text only through stdin and waits for a successful process exit', async () => {
    const { child, chunks } = fakeChild();
    const copied = vi.fn();
    const copying = copyToClipboard(text, { platform: 'darwin', env: {} }).then(copied);
    await new Promise<void>((resolve) => child.stdin.once('finish', resolve));

    expect(copied).not.toHaveBeenCalled();
    expect(Buffer.concat(chunks).toString('utf8')).toBe(text);
    expect(spawn).toHaveBeenCalledWith('pbcopy', [], expect.objectContaining({
      shell: false,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: { LC_ALL: 'en_US.UTF-8' },
    }));
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await copying;
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('uses Windows UTF-8 input with a fixed PowerShell command', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    await copyToClipboard(text, { platform: 'win32', env: {}, runner });
    const invocation = runner.mock.calls[0]![0];
    expect(invocation.command).toBe('powershell.exe');
    expect(invocation.stdin).toBe(text);
    expect(invocation.args).toContain('-NonInteractive');
    expect(invocation.args.at(-1)).toContain('[Console]::In.ReadToEnd()');
    expect(invocation.args.at(-1)).toContain('UTF8Encoding');
    expect(invocation.args.join(' ')).not.toContain(text);
  });

  it('uses the current Wayland session before X11', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    await copyToClipboard(text, {
      platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, runner,
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      command: 'wl-copy', args: ['--type', 'text/plain;charset=utf-8'], stdin: text,
    }));
  });

  it('tries available X11 tools when earlier session candidates are not installed', async () => {
    const runner = vi.fn().mockRejectedValueOnce(missing).mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(undefined);
    await copyToClipboard(text, {
      platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, runner,
    });
    expect(runner.mock.calls.map(([invocation]) => invocation.command))
      .toEqual(['wl-copy', 'xclip', 'xsel']);
    expect(runner.mock.calls.every(([invocation]) => invocation.stdin === text)).toBe(true);
  });

  it('does not select Wayland tools when only an X11 display is present', async () => {
    const runner = vi.fn().mockResolvedValue(undefined);
    await copyToClipboard(text, { platform: 'linux', env: { DISPLAY: ':0' }, runner });
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      command: 'xclip', args: ['-selection', 'clipboard', '-in'],
    }));
  });

  it('reports missing tools and absent desktop sessions as safe failures', async () => {
    const runner = vi.fn().mockRejectedValue(missing);
    await expect(copyToClipboard(text, { platform: 'linux', env: { DISPLAY: ':0' }, runner }))
      .rejects.toThrow(failureMessage);
    runner.mockClear();
    await expect(copyToClipboard(text, { platform: 'linux', env: {}, runner }))
      .rejects.toThrow(failureMessage);
    expect(runner).not.toHaveBeenCalled();
  });

  it('does not retry an already started command or expose its errors', async () => {
    const runner = vi.fn().mockRejectedValue(new Error(`native stderr ${text}`));
    const error = await copyToClipboard(text, { platform: 'linux', env: { DISPLAY: ':0' }, runner })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(failureMessage);
    expect((error as Error).cause).toBeUndefined();
    expect(runner).toHaveBeenCalledOnce();
  });

  it.each([1, null])('rejects an unsuccessful process exit (%s)', async (exitCode) => {
    const { child } = fakeChild();
    const copying = copyToClipboard(text, { platform: 'darwin', env: {} });
    const assertion = expect(copying).rejects.toThrow(failureMessage);
    child.exitCode = exitCode;
    child.emit('exit', exitCode, exitCode === null ? 'SIGTERM' : null);
    await assertion;
  });

  it('rejects incomplete stdin even when the process claims success', async () => {
    const { child } = fakeChild(Object.assign(new Error(text), { code: 'EPIPE' }));
    const copying = copyToClipboard(text, { platform: 'darwin', env: {} });
    const assertion = expect(copying).rejects.toThrow(failureMessage);
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await assertion;
  });

  it('ends a stalled clipboard command and reports failure', async () => {
    vi.useFakeTimers();
    const { child } = fakeChild();
    const copying = copyToClipboard(text, { platform: 'darwin', env: {} });
    const assertion = expect(copying).rejects.toThrow(failureMessage);
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(child.stdin.destroyed).toBe(true);
  });
});
