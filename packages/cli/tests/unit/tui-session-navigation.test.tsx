import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import type { TuiControllerDependencies, TuiStatusLoadResult } from '../../src/tui/controller.js';
import { SessionConsoleApp } from '../../src/tui/session-console-app.js';
import { SessionHost } from '../../src/tui/session-host.js';
import { attachSafeOperationError } from '../../src/utils/safe-operation-diagnostic.js';
import { controller, deferred, loadResult as status } from '../helpers/tui-console-app-fixture.js';
import { input as send, nextTurn as tick } from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

function sessionController(overrides: Partial<TuiControllerDependencies> = {}) {
  return { value: controller(overrides), progress: createRebuildProgressFeed() };
}

// Test Value Gate: reload must replace the session, drain reads and retain safe diagnostics.
describe('TUI session navigation', () => {
  it('uses h in place and H to remount a fresh controller session', async () => {
    const first = sessionController();
    const second = sessionController();
    const sessions = [first, second];
    const host = new SessionHost({
      createSession: () => {
        const next = sessions.shift();
        if (!next) throw new Error('unexpected session');
        return { controller: next.value, progressFeed: next.progress };
      },
    });
    const instance = render(<SessionConsoleApp host={host} />);
    await tick(4);
    expect(instance.lastFrame()).toContain('插件');
    expect(instance.lastFrame()).toContain('插件来源');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    first.value.push({ name: 'pluginList', mode: 'browse' });

    await send(instance, 'h');
    expect(host.snapshot.epoch).toBe(1);
    expect(first.value.snapshot.router.current.route).toEqual({ name: 'home' });

    first.value.push({ name: 'pluginList', mode: 'browse' });
    await send(instance, 'H');
    expect(host.snapshot.epoch).toBe(2);
    expect(host.snapshot.controller).toBe(second.value);
    expect(first.value.snapshot.phase).toBe('disposed');
    await tick(4);
    expect(second.value.snapshot.phase).toBe('ready');
    host.dispose();
  });

  it('unmounts the old interactive UI while H drains a read', async () => {
    const pending = deferred<TuiStatusLoadResult>();
    const first = sessionController({ loadStatus: vi.fn(() => pending.promise) });
    const second = sessionController();
    const sessions = [first, second];
    const host = new SessionHost({
      createSession: () => {
        const next = sessions.shift();
        if (!next) throw new Error('unexpected session');
        return { controller: next.value, progressFeed: next.progress };
      },
    });
    const instance = render(<SessionConsoleApp host={host} />);
    await tick(2);

    await send(instance, 'H', '\r');
    expect(instance.lastFrame()).toContain('正在安全结束当前会话');
    expect(host.snapshot.epoch).toBe(1);

    pending.resolve(status());
    await tick(4);
    expect(host.snapshot.epoch).toBe(2);
    expect(host.snapshot.controller).toBe(second.value);
    host.dispose();
  });

  it('offers the same home and reload actions from the help menu', async () => {
    const first = sessionController({ now: () => 1_000 });
    const second = sessionController({ now: () => 2_000 });
    const sessions = [first, second];
    const host = new SessionHost({
      createSession: () => {
        const next = sessions.shift();
        if (!next) throw new Error('unexpected session');
        return { controller: next.value, progressFeed: next.progress };
      },
    });
    const instance = render(<SessionConsoleApp host={host} />);
    await tick(4);
    first.value.push({ name: 'pluginList', mode: 'browse' });

    await send(instance, '?');
    expect(instance.lastFrame()).toContain('返回首页并重新加载');
    await send(instance, '\u001B[B', '\r');
    expect(first.value.snapshot.router.current.route).toEqual({ name: 'home' });
    expect(first.value.snapshot.statusReadAtMs).toBe(1_000);

    first.value.push({ name: 'pluginList', mode: 'browse' });
    await send(instance, '?', '\u001B[B', '\u001B[B', '\r');
    await tick(4);
    expect(host.snapshot.epoch).toBe(2);
    expect(second.value.snapshot.statusReadAtMs).toBe(2_000);
    host.dispose();
  });

  it('keeps initial and H-reload failure diagnostics reachable through the real SessionHost', async () => {
    const failedSession = (code: string, safeMessage: string) => sessionController({
      loadStatus: vi.fn().mockRejectedValue(attachSafeOperationError(
        new Error('Authorization=private-token /Users/private/status.json'),
        { code, stage: 'status.load', safeMessage },
      )),
    });
    const first = failedSession('initialStatusFailed', 'The initial status could not be read.');
    const second = failedSession('reloadStatusFailed', 'The reloaded status could not be read.');
    const sessions = [first, second];
    const host = new SessionHost({
      createSession: () => {
        const next = sessions.shift();
        if (!next) throw new Error('unexpected session');
        return { controller: next.value, progressFeed: next.progress };
      },
    });
    const save = vi.spyOn(second.value, 'saveOperationReport').mockResolvedValue({ path: '/private/report.md' });
    const instance = render(<SessionConsoleApp host={host} />);
    await tick(4);

    expect(first.value.snapshot.phase).toBe('error');
    expect(instance.lastFrame()).toContain('无法读取插件状态');
    expect(instance.lastFrame()).not.toContain('添加插件');
    await send(instance, 'H');
    await tick(4);
    expect(host.snapshot).toMatchObject({ epoch: 2, controller: second.value });
    expect(second.value.snapshot.phase).toBe('error');

    await send(instance, '?', 'o');
    expect(second.value.snapshot.router.current.route).toEqual({ name: 'operationHistory' });
    expect(instance.lastFrame()).toContain('最近操作');
    await send(instance, '\r');
    expect(second.value.snapshot.router.current.route.name).toBe('operationDiagnostic');
    expect(instance.lastFrame()).toContain('reloadStatusFailed');
    await send(instance, '\r', '\u001B[B', '\r');
    await tick(2);
    expect(save).toHaveBeenCalledOnce();
    expect(instance.lastFrame()).toContain('报告已保存到临时目录');

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await tick(2);
    expect(second.value.snapshot.router.current.route.name).toBe('operationDiagnostic');
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await tick(2);
    expect(second.value.snapshot.router.current.route).toEqual({ name: 'operationHistory' });
    expect(second.value.snapshot.phase).toBe('error');
    expect(second.value.snapshot.loadError?.code).toBe('reloadStatusFailed');
    expect(JSON.stringify({ snapshot: second.value.snapshot, history: host.history.list() }))
      .not.toContain('private-token');
    host.dispose();
  });

});
