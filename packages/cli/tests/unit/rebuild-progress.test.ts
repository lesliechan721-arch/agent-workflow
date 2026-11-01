import { describe, expect, it, vi } from 'vitest';

import {
  createRebuildProgressFeed,
} from '../../src/output/rebuild-progress.js';
import { createIoReporter } from '../../src/output/reporter.js';

describe('rebuild progress feed', () => {
  it('shows managed command package progress without a platform or arbitrary error text', () => {
    const feed = createRebuildProgressFeed();
    feed.addEvent({ type: 'managed-command:producer', source: { plugin: 'demo', scope: 'user' },
      data: { packageKey: 'tools', phase: 'failure', message: 'private-token-value' } });
    expect(feed.get().current).toEqual({ target: 'demo · 命令包 tools · 个人默认', phase: '命令包失败' });
    expect(feed.get().messages.join('\n')).not.toContain('private-token-value');
  });
  it('keeps at most 50 messages and tracks the latest target and real phase', () => {
    const feed = createRebuildProgressFeed();
    for (let index = 0; index < 60; index += 1) {
      feed.addNotice({ level: 'notice', message: `消息 ${index}` });
    }
    expect(feed.get().messages).toHaveLength(50);
    expect(feed.get().messages[0]).toBe('通知：收到通知，详情请查看退出后的命令结果或调试日志。');

    feed.addEvent({
      type: 'rebuild:action',
      source: { plugin: 'alpha', platform: 'codex', scope: 'user', action: 'install' },
      data: { name: 'native.write', phase: 'start' },
    });
    expect(feed.get().current).toEqual({
      target: 'alpha · Codex/当前用户',
      phase: '写入平台插件',
    });

    feed.addEvent({
      type: 'rebuild:action',
      source: { plugin: 'beta', platform: 'claude', scope: 'project', action: 'install' },
      data: {
        name: 'postcheck.inspect',
        phase: 'failure',
        durationMs: 12,
        message: 'token=plain-secret',
      },
    });
    expect(feed.get().current).toEqual({
      target: 'beta · Claude Code/当前项目',
      phase: '检查写入结果失败',
    });
    expect(feed.get().messages.at(-1)).toContain('检查写入结果失败。');
    expect(feed.get().messages.at(-1)).toContain('详细原因请查看退出后的命令结果或调试日志');
    expect(feed.get().messages.join('\n')).not.toContain('token=');
    expect(feed.get().messages.join('\n')).not.toContain('plain-secret');
  });

  it('deduplicates non-adjacent notices and projects arbitrary notice text to fixed TUI text', () => {
    const feed = createRebuildProgressFeed();
    feed.addNotice({ level: 'notice', identity: 'same', message: '第一次' });
    feed.addNotice({ level: 'notice', message: '中间消息' });
    feed.addNotice({ level: 'notice', identity: 'same', message: '第二次' });
    feed.addNotice({ level: 'notice', message: '中间消息' });

    expect(feed.get().messages).toEqual([
      '通知：收到通知，详情请查看退出后的命令结果或调试日志。',
      '通知：收到通知，详情请查看退出后的命令结果或调试日志。',
    ]);
  });

  it('starts each formal operation without prior messages or notice deduplication state', () => {
    const feed = createRebuildProgressFeed();
    feed.addEvent({
      type: 'rebuild:action',
      source: { plugin: 'first-plugin', platform: 'codex', scope: 'user', action: 'install' },
      data: { name: 'native.write', phase: 'start' },
    });
    feed.addNotice({ level: 'notice', identity: 'reusable', message: 'first operation' });

    feed.clearCurrent();

    expect(feed.get()).toEqual({ messages: [] });
    feed.addNotice({ level: 'notice', identity: 'reusable', message: 'second operation' });
    expect(feed.get().messages).toEqual([
      '通知：收到通知，详情请查看退出后的命令结果或调试日志。',
    ]);
    expect(feed.get().messages.join('\n')).not.toContain('first-plugin');
  });

  it('keeps normal and JSON-style IO silent while verbose writes only to stderr', async () => {
    const event = {
      type: 'rebuild:action',
      source: { plugin: 'alpha', platform: 'codex', scope: 'user', action: 'install' },
      data: { name: 'native.write', phase: 'success', durationMs: 3 },
    } as const;
    const stdout = vi.fn();
    const stderr = vi.fn();
    await createIoReporter({ stdout, stderr }, {
      verbose: false,
      debug: false,
      commandName: 'install',
      runId: 'normal',
    }).event(event);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();

    await createIoReporter({ stdout, stderr }, {
      verbose: true,
      debug: false,
      commandName: 'install',
      runId: 'verbose',
    }).event(event);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('rebuild:action'));
  });
});
