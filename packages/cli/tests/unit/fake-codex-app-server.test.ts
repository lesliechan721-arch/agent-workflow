import { describe, expect, it } from 'vitest';

import { createFakeCodexAppServerHarness } from '../helpers/fake-codex-app-server.js';

describe('fake Codex app-server harness', () => {
  it('replies with JSONL frames and records the spawn invocation plus stdin messages', async () => {
    const harness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'initialize' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 1, result: { protocolVersion: '2026-05-04' } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/install' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 2, result: { ok: true } },
          },
        ],
      },
    ]);
    const runner = harness.createRunner();
    const env = {
      PATH: '/tmp/bin',
      AW_HOME: '/tmp/aw-home',
    } as NodeJS.ProcessEnv;
    const process = runner({
      command: 'codex',
      args: ['app-server'],
      cwd: '/tmp/project',
      env,
    });
    env.PATH = '/tmp/changed';

    process.stdin.write('{"id":1,"method":"initialize"}\n');
    process.stdin.write('{"id":2,"method":"plugin/install","params":{"pluginId":"git-commit@aw"}}\n');
    await harness.waitForIdle();

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
    expect(harness.stdinMessages.map((message) => message.json?.method)).toEqual([
      'initialize',
      'plugin/install',
    ]);
    expect(harness.readStdout().trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { id: 1, result: { protocolVersion: '2026-05-04' } },
      { id: 2, result: { ok: true } },
    ]);
  });

  it('can emit stderr without a matching stdout response to simulate timeout paths', async () => {
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
    ]);
    const process = harness.spawn({
      command: 'codex',
      args: ['app-server'],
    });

    process.stdin.write('{"id":1,"method":"plugin/install"}\n');
    await harness.waitForIdle();

    expect(harness.readStderr()).toContain('booting codex app-server');
    expect(harness.readStdout()).toBe('');
    expect(harness.stdinMessages[0]?.json?.method).toBe('plugin/install');
  });

  it('can emit non-JSON stdout lines for parser hardening cases', async () => {
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
    const process = harness.spawn({
      command: 'codex',
      args: ['app-server'],
    });

    process.stdin.write('{"id":1,"method":"initialize"}\n');
    await harness.waitForIdle();

    expect(harness.readStdout()).toBe('not-json\n');
  });

  it('matches read-only plugin RPC methods used by native view diagnostics', async () => {
    const harness = createFakeCodexAppServerHarness([
      {
        when: 'stdin',
        match: { method: 'plugin/installed' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 1, result: { plugins: [{ id: 'git-commit@aw' }] } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/read' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 2, result: { id: 'git-commit@aw', marketplace: 'aw' } },
          },
        ],
      },
      {
        when: 'stdin',
        match: { method: 'plugin/list' },
        actions: [
          {
            type: 'stdout-jsonl',
            value: { id: 3, result: { plugins: [{ id: 'git-commit@aw', mentionable: true }] } },
          },
        ],
      },
    ]);
    const process = harness.spawn({
      command: 'codex',
      args: ['app-server'],
    });

    process.stdin.write('{"id":1,"method":"plugin/installed"}\n');
    process.stdin.write('{"id":2,"method":"plugin/read","params":{"pluginId":"git-commit@aw"}}\n');
    process.stdin.write('{"id":3,"method":"plugin/list","params":{"marketplace":"aw"}}\n');
    await harness.waitForIdle();

    expect(harness.stdinMessages.map((message) => message.json?.method)).toEqual([
      'plugin/installed',
      'plugin/read',
      'plugin/list',
    ]);
    expect(harness.readStdout().trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { id: 1, result: { plugins: [{ id: 'git-commit@aw' }] } },
      { id: 2, result: { id: 'git-commit@aw', marketplace: 'aw' } },
      { id: 3, result: { plugins: [{ id: 'git-commit@aw', mentionable: true }] } },
    ]);
  });

  it('can exit early and records kill signals for cleanup assertions', async () => {
    const harness = createFakeCodexAppServerHarness([
      {
        when: 'start',
        actions: [
          {
            type: 'exit',
            code: 17,
          },
        ],
      },
    ]);
    const process = harness.spawn({
      command: 'codex',
      args: ['app-server'],
    });

    await expect(harness.waitForExit()).resolves.toEqual({
      code: 17,
      signal: null,
    });
    expect(process.kill('SIGTERM')).toBe(false);
    expect(harness.killedSignals).toEqual(['SIGTERM']);
  });
});
