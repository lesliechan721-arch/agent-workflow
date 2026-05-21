import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  installCodexPluginViaAppServer,
  listCodexPluginsViaAppServer,
  listInstalledCodexPluginsViaAppServer,
  readCodexPluginViaAppServer,
  type CodexAppServerProcess,
  uninstallCodexPluginViaAppServer,
  type CodexAppServerProcessRunner,
} from '../../src/utils/codex-app-server-client.js';
import { createFakeCodexAppServerHarness } from '../helpers/fake-codex-app-server.js';

async function captureErrorMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Expected promise to reject.');
}

class SynchronousReplyCodexAppServerProcess
  extends EventEmitter
  implements CodexAppServerProcess {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 5252;
  readonly messages: Array<Record<string, unknown>> = [];

  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  private stdinBuffer = '';

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.pushStdinChunk(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        callback();
      },
    });
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this.killed) {
      return false;
    }
    this.killed = true;
    this.signalCode = typeof signal === 'string' ? signal : null;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', null, this.signalCode);
    return true;
  }

  private pushStdinChunk(chunk: string): void {
    this.stdinBuffer += chunk;
    let newlineIndex = this.stdinBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stdinBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.stdinBuffer = this.stdinBuffer.slice(newlineIndex + 1);
      this.handleStdinLine(line);
      newlineIndex = this.stdinBuffer.indexOf('\n');
    }
  }

  private handleStdinLine(line: string): void {
    const frame = JSON.parse(line) as Record<string, unknown>;
    this.messages.push(frame);
    if (frame.method === 'initialize') {
      this.stdout.write(`${JSON.stringify({ id: frame.id, result: { protocolVersion: '2026-05-04' } })}\n`);
    }
    if (frame.method === 'plugin/install') {
      this.stdout.write(`${JSON.stringify({ id: frame.id, result: { installed: true } })}\n`);
    }
  }
}

describe('codex-app-server-client', () => {
  it('blocks real codex app-server by default in tests', async () => {
    const message = await captureErrorMessage(
      installCodexPluginViaAppServer({
        cwd: '/tmp/project',
        env: {
          PATH: '/tmp/bin',
          AW_HOME: '/tmp/aw-home',
        } as NodeJS.ProcessEnv,
        marketplacePath: '/tmp/aw-home/.agents/plugins/marketplace.json',
        pluginName: 'git-commit',
      }),
    );

    expect(message).toContain('测试默认禁止启动真实 `codex app-server`');
    expect(message).toContain('fake app-server harness');
    expect(message).toContain('command="codex"');
    expect(message).toContain('args=["app-server"]');
    expect(message).toContain(
      'cwdSource="installCodexPluginViaAppServer()/uninstallCodexPluginViaAppServer() invocation.cwd"',
    );
    expect(message).toContain(
      'envSource="installCodexPluginViaAppServer()/uninstallCodexPluginViaAppServer() invocation.env"',
    );
  });

  it('registers pending requests before writing so synchronous app-server replies are matched', async () => {
    const child = new SynchronousReplyCodexAppServerProcess();
    const runner: CodexAppServerProcessRunner = () => child;

    await expect(
      installCodexPluginViaAppServer({
        cwd: '/tmp/project',
        env: { PATH: '/tmp/bin' } as NodeJS.ProcessEnv,
        marketplacePath: '/tmp/aw/.agents/plugins/marketplace.json',
        pluginName: 'git-commit',
        timeoutMs: 25,
        runner,
      }),
    ).resolves.toMatchObject({
      method: 'plugin/install',
      requestId: 'install-1',
      result: { installed: true },
    });
    expect(child.messages.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'plugin/install',
    ]);
  });

  it('runs initialize -> initialized -> plugin/install over stdio JSONL, ignores unrelated frames, and captures stderr', async () => {
    const harness = createFakeCodexAppServerHarness([
      {
        when: 'start',
        actions: [
          {
            type: 'stderr',
            value: 'booting codex app-server\n',
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { method: 'log', params: { phase: 'boot' } },
          },
          {
            type: 'stdout-jsonl',
            value: { id: 'other-request', result: { ignored: true } },
          },
          {
            type: 'stdout-jsonl',
            value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { method: 'progress', params: { percent: 50 } },
          },
          {
            type: 'stdout-jsonl',
            value: { id: 'someone-else', result: { ignored: true } },
          },
          {
            type: 'stdout-jsonl',
            value: { id: 'install-1', result: { installed: true } },
          },
        ],
      },
    ]);

    const result = await installCodexPluginViaAppServer({
      cwd: '/tmp/project',
      env: {
        PATH: '/tmp/bin',
        AW_HOME: '/tmp/aw-home',
      } as NodeJS.ProcessEnv,
      marketplacePath: '/tmp/aw/.agents/plugins/marketplace.json',
      pluginName: 'git-commit',
      clientVersion: '1.2.3',
      runner: harness.createRunner(),
    });

    expect(harness.invocations).toEqual([
      {
        command: 'codex',
        args: ['app-server'],
        cwd: '/tmp/project',
        env: {
          PATH: '/tmp/bin',
          AW_HOME: '/tmp/aw-home',
        },
      },
    ]);
    expect(harness.stdinMessages.map((message) => message.json)).toEqual([
      {
        id: 'init-1',
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'aw',
            version: '1.2.3',
          },
          capabilities: {},
        },
      },
      {
        method: 'initialized',
      },
      {
        id: 'install-1',
        method: 'plugin/install',
        params: {
          marketplacePath: '/tmp/aw/.agents/plugins/marketplace.json',
          pluginName: 'git-commit',
        },
      },
    ]);
    expect(harness.stdinMessages.every((message) => !('jsonrpc' in (message.json ?? {})))).toBe(true);
    expect(result).toEqual({
      method: 'plugin/install',
      requestId: 'install-1',
      result: { installed: true },
      stderr: 'booting codex app-server\n',
    });
    expect(harness.killedSignals).toEqual(['SIGTERM']);
  });

  it('runs initialize -> initialized -> plugin/uninstall over stdio JSONL', async () => {
    const harness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/uninstall' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'uninstall-1', result: { removed: true } },
          },
        ],
      },
    ]);

    const result = await uninstallCodexPluginViaAppServer({
      cwd: '/tmp/project',
      env: { PATH: '/tmp/bin' },
      pluginId: 'git-commit@aw',
      runner: harness.createRunner(),
    });

    expect(harness.stdinMessages.map((message) => message.json)).toEqual([
      {
        id: 'init-1',
        method: 'initialize',
        params: {
          clientInfo: {
            name: 'aw',
            version: '0.0.0',
          },
          capabilities: {},
        },
      },
      {
        method: 'initialized',
      },
      {
        id: 'uninstall-1',
        method: 'plugin/uninstall',
        params: {
          pluginId: 'git-commit@aw',
        },
      },
    ]);
    expect(result.result).toEqual({ removed: true });
  });

  it('reads plugin/list, plugin/installed, and plugin/read as read-only RPC calls', async () => {
    const makeHarness = () => createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/list' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'plugin-list-1', result: { plugins: [{ id: 'git-commit@aw' }] } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/installed' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'plugin-installed-1', result: { plugins: [{ id: 'git-commit@aw', enabled: true }] } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/read' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'plugin-read-1', result: { id: 'git-commit@aw', marketplace: 'aw' } },
          },
        ],
      },
    ]);
    const listHarness = makeHarness();
    const installedHarness = makeHarness();
    const readHarness = makeHarness();

    await expect(listCodexPluginsViaAppServer({
      cwd: '/tmp/project',
      env: { PATH: '/tmp/bin' },
      marketplace: 'aw',
      runner: listHarness.createRunner(),
    })).resolves.toMatchObject({
      method: 'plugin/list',
      requestId: 'plugin-list-1',
      result: { plugins: [{ id: 'git-commit@aw' }] },
    });
    await expect(listInstalledCodexPluginsViaAppServer({
      cwd: '/tmp/project',
      env: { PATH: '/tmp/bin' },
      runner: installedHarness.createRunner(),
    })).resolves.toMatchObject({
      method: 'plugin/installed',
      requestId: 'plugin-installed-1',
      result: { plugins: [{ id: 'git-commit@aw', enabled: true }] },
    });
    await expect(readCodexPluginViaAppServer({
      cwd: '/tmp/project',
      env: { PATH: '/tmp/bin' },
      pluginId: 'git-commit@aw',
      runner: readHarness.createRunner(),
    })).resolves.toMatchObject({
      method: 'plugin/read',
      requestId: 'plugin-read-1',
      result: { id: 'git-commit@aw', marketplace: 'aw' },
    });

    const stdinMessages = [
      ...listHarness.stdinMessages,
      ...installedHarness.stdinMessages,
      ...readHarness.stdinMessages,
    ];
    expect(stdinMessages.map((message) => message.json).filter((message) =>
      message?.method !== 'initialize' && message?.method !== 'initialized',
    )).toEqual([
      {
        id: 'plugin-list-1',
        method: 'plugin/list',
        params: {
          marketplace: 'aw',
        },
      },
      {
        id: 'plugin-installed-1',
        method: 'plugin/installed',
        params: {},
      },
      {
        id: 'plugin-read-1',
        method: 'plugin/read',
        params: {
          pluginId: 'git-commit@aw',
        },
      },
    ]);
  });

  it('restores the default guard after a previous test injected a fake harness', async () => {
    const message = await captureErrorMessage(
      uninstallCodexPluginViaAppServer({
        cwd: '/tmp/project',
        env: {
          PATH: '/tmp/bin',
          AW_HOME: '/tmp/aw-home',
        } as NodeJS.ProcessEnv,
        pluginId: 'git-commit@aw',
      }),
    );

    expect(message).toContain('测试默认禁止启动真实 `codex app-server`');
    expect(message).toContain('fake app-server harness');
  });

  it('maps spawn failures to actionable AW errors', async () => {
    const runner: CodexAppServerProcessRunner = () => {
      const error = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
      throw error;
    };

    const message = await captureErrorMessage(
      installCodexPluginViaAppServer({
        cwd: '/tmp/project',
        env: { PATH: '/tmp/bin' },
        marketplacePath: '/tmp/aw/.agents/plugins/marketplace.json',
        pluginName: 'git-commit',
        runner,
      }),
    );

    expect(message).toContain('无法启动 `codex app-server`');
    expect(message).toContain('升级到支持 app-server 插件 RPC 的版本');
  });

  it('maps timeout failures and cleans up the child process', async () => {
    const harness = createFakeCodexAppServerHarness([
      {
        when: 'start',
        actions: [
          {
            type: 'stderr',
            value: 'still booting\n',
          },
        ],
      },
    ]);

    const message = await captureErrorMessage(
      installCodexPluginViaAppServer({
        cwd: '/tmp/project',
        env: { PATH: '/tmp/bin' },
        marketplacePath: '/tmp/aw/.agents/plugins/marketplace.json',
        pluginName: 'git-commit',
        timeoutMs: 10,
        runner: harness.createRunner(),
      }),
    );

    expect(message).toContain('响应 `initialize` 超时');
    expect(message).toContain('still booting');
    expect(harness.killedSignals).toContain('SIGTERM');
  });

  it('maps read-only RPC timeout, unknown method, protocol error, spawn failure, and early exit with debug context', async () => {
    await expect(captureErrorMessage(listInstalledCodexPluginsViaAppServer({
      cwd: '/tmp/project',
      env: { PATH: '/tmp/bin' },
      timeoutMs: 10,
      runner: createFakeCodexAppServerHarness([
        {
          when: 'stdin',
          match: { method: 'initialize' },
          actions: [
            {
              type: 'stdout-jsonl',
              value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } },
            },
          ],
        },
      ]).createRunner(),
    }))).resolves.toContain('响应 `plugin/installed` 超时');

    await expect(captureErrorMessage(readCodexPluginViaAppServer({
      cwd: '/tmp/project',
      env: { PATH: '/tmp/bin' },
      pluginId: 'git-commit@aw',
      runner: createFakeCodexAppServerHarness([
        {
          when: 'stdin',
          match: { method: 'initialize' },
          actions: [
            {
              type: 'stdout-jsonl',
              value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } },
            },
          ],
        },
        {
          when: 'stdin',
          match: { method: 'plugin/read' },
          actions: [
            {
              type: 'stdout-jsonl',
              value: {
                id: 'plugin-read-1',
                error: {
                  code: -32601,
                  message: 'unknown method plugin/read',
                },
              },
            },
          ],
        },
      ]).createRunner(),
    }))).resolves.toContain('不支持 `plugin/read`');

    await expect(captureErrorMessage(listCodexPluginsViaAppServer({
      cwd: '/tmp/project',
      env: { PATH: '/tmp/bin' },
      runner: createFakeCodexAppServerHarness([
        {
          when: 'stdin',
          match: { method: 'initialize' },
          actions: [
            {
              type: 'stdout-raw',
              value: 'not-json\n',
            },
          ],
        },
      ]).createRunner(),
    }))).resolves.toContain('rawLine="not-json"');

    await expect(captureErrorMessage(listCodexPluginsViaAppServer({
      cwd: '/tmp/project',
      env: { PATH: '/tmp/bin' },
      runner: () => {
        throw new Error('spawn codex ENOENT');
      },
    }))).resolves.toContain('无法启动 `codex app-server`');

    await expect(captureErrorMessage(readCodexPluginViaAppServer({
      cwd: '/tmp/project',
      env: { PATH: '/tmp/bin' },
      pluginId: 'git-commit@aw',
      runner: createFakeCodexAppServerHarness([
        {
          when: 'stdin',
          match: { method: 'initialize' },
          actions: [
            {
              type: 'stdout-jsonl',
              value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } },
            },
          ],
        },
        {
          when: 'stdin',
          match: { method: 'plugin/read' },
          actions: [
            {
              type: 'stderr',
              value: 'fatal before read\n',
            },
            {
              type: 'exit',
              code: 17,
            },
          ],
        },
      ]).createRunner(),
    }))).resolves.toContain('提前退出');
  });

  it('maps unknown method errors to upgrade guidance', async () => {
    const harness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: {
              id: 'install-1',
              error: {
                code: -32601,
                message: 'unknown method plugin/install',
              },
            },
          },
        ],
      },
    ]);

    const message = await captureErrorMessage(
      installCodexPluginViaAppServer({
        cwd: '/tmp/project',
        env: { PATH: '/tmp/bin' },
        marketplacePath: '/tmp/aw/.agents/plugins/marketplace.json',
        pluginName: 'git-commit',
        runner: harness.createRunner(),
      }),
    );

    expect(message).toContain('不支持 `plugin/install`');
    expect(message).toContain('升级 Codex CLI');
  });

  it('maps invalid request errors to protocol mismatch guidance', async () => {
    const harness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: {
              id: 'install-1',
              error: {
                code: -32600,
                message: 'invalid request: expected plugin/install params',
              },
            },
          },
        ],
      },
    ]);

    const message = await captureErrorMessage(
      installCodexPluginViaAppServer({
        cwd: '/tmp/project',
        env: { PATH: '/tmp/bin' },
        marketplacePath: '/tmp/aw/.agents/plugins/marketplace.json',
        pluginName: 'git-commit',
        runner: harness.createRunner(),
      }),
    );

    expect(message).toContain('invalid request');
    expect(message).toContain('协议与 AW 期望不兼容');
  });

  it('maps plugins disabled errors to feature enable guidance', async () => {
    const harness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: {
              id: 'install-1',
              error: {
                message: 'Codex plugins are disabled for this workspace',
              },
            },
          },
        ],
      },
    ]);

    const message = await captureErrorMessage(
      installCodexPluginViaAppServer({
        cwd: '/tmp/project',
        env: { PATH: '/tmp/bin' },
        marketplacePath: '/tmp/aw/.agents/plugins/marketplace.json',
        pluginName: 'git-commit',
        runner: harness.createRunner(),
      }),
    );

    expect(message).toContain('当前 workspace 被禁用');
    expect(message).toContain('启用 plugins feature');
  });

  it('maps install policy denials to actionable guidance', async () => {
    const harness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: {
              id: 'install-1',
              error: {
                message: 'install policy denied: plugin is not allowed in this workspace',
              },
            },
          },
        ],
      },
    ]);

    const message = await captureErrorMessage(
      installCodexPluginViaAppServer({
        cwd: '/tmp/project',
        env: { PATH: '/tmp/bin' },
        marketplacePath: '/tmp/aw/.agents/plugins/marketplace.json',
        pluginName: 'git-commit',
        runner: harness.createRunner(),
      }),
    );

    expect(message).toContain('install policy');
    expect(message).toContain('workspace 限制');
  });

  it('fails on non-JSON stdout lines with debug context', async () => {
    const harness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [
          {
            type: 'stdout-raw',
            value: 'not-json\n',
          },
        ],
      },
    ]);

    const message = await captureErrorMessage(
      installCodexPluginViaAppServer({
        cwd: '/tmp/project',
        env: { PATH: '/tmp/bin' },
        marketplacePath: '/tmp/aw/.agents/plugins/marketplace.json',
        pluginName: 'git-commit',
        runner: harness.createRunner(),
      }),
    );

    expect(message).toContain('无法解析的输出');
    expect(message).toContain('rawLine="not-json"');
  });

  it('fails clearly when the app-server exits before replying', async () => {
    const harness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 'init-1', result: { protocolVersion: '2026-05-04' } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [
          {
            type: 'stderr',
            value: 'fatal: crashed before reply\n',
          },
          {
            type: 'exit',
            code: 17,
          },
        ],
      },
    ]);

    const message = await captureErrorMessage(
      installCodexPluginViaAppServer({
        cwd: '/tmp/project',
        env: { PATH: '/tmp/bin' },
        marketplacePath: '/tmp/aw/.agents/plugins/marketplace.json',
        pluginName: 'git-commit',
        runner: harness.createRunner(),
      }),
    );

    expect(message).toContain('提前退出');
    expect(message).toContain('exitCode=17');
  });
});
