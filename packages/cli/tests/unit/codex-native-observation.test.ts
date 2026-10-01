import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import { createCodexNativeObservationSession } from '../../src/utils/codex-native-observation.js';
import { bindNativeCliRunnerSignal, NativeCliError, type NativeCliInvocation } from '../../src/utils/native-cli.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

function listResult(pluginIds: readonly string[]) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      installed: pluginIds.map((pluginId) => ({ pluginId, installed: true, enabled: true })),
      available: [],
    }),
    stderr: '',
  };
}

describe('Codex native observation session', () => {
  // Test Value Gate: one cancelled read must not release the neutral cwd while another invalidated read still cleans up.
  it.each([
    ['plugin', false], ['snapshot', false], ['plugin', true], ['snapshot', true],
  ] as const)('drains cancelled %s reads and reports unconfirmed cleanup: %s', async (kind, cleanupUnconfirmed) => {
    const isolation = getCurrentSourceTestIsolation();
    const abort = new AbortController();
    let fastCleanup: (() => void) | undefined;
    let slowCleanup: (() => void) | undefined;
    let neutralCwd: string | undefined;
    let cleanupFailure: NativeCliError | undefined;
    let started = 0;
    const session = await createCodexNativeObservationSession({
      exactCwd: isolation.layout.fixtureCwd, env: isolation.env,
      runner: bindNativeCliRunnerSignal(async (invocation) => {
        started += 1;
        const neutral = invocation.cwd !== isolation.layout.fixtureCwd;
        if (neutral) neutralCwd = invocation.cwd;
        if (neutral && cleanupUnconfirmed) {
          cleanupFailure = new NativeCliError({
            invocation, exitCode: 1, stdout: '', stderr: '', reason: 'aborted',
            cleanupError: new Error('process cleanup unconfirmed'),
          });
        }
        await new Promise<void>((resolve) => invocation.signal!.addEventListener('abort', () => resolve(), { once: true }));
        await new Promise<void>((resolve) => {
          if (neutral) slowCleanup = resolve;
          else fastCleanup = resolve;
        });
        if (neutral && cleanupUnconfirmed) {
          throw cleanupFailure;
        }
        throw new DOMException('cancelled after cleanup', 'AbortError');
      }, abort.signal),
    });
    const reading = kind === 'plugin'
      ? session.inspectPlugin({ pluginId: 'demo@aw', scope: 'project' })
      : session.snapshot('aw', 'both');
    const rejected = expect(reading).rejects.toMatchObject({ name: 'AbortError' });
    let disposing: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(started).toBe(2));
      session.invalidate('aw');
      abort.abort();
      await vi.waitFor(() => expect(fastCleanup).toBeTypeOf('function'));
      expect(slowCleanup).toBeTypeOf('function');
      fastCleanup!();
      await rejected;
      disposing = session.dispose();
      const state = await Promise.race([disposing.then(() => 'disposed'),
        new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 50))]);
      expect(state).toBe('waiting');
      expect(await fs.pathExists(neutralCwd!)).toBe(true);
      await expect(session.snapshot('aw')).rejects.toThrow('codexObservationSessionDisposed');
      slowCleanup!();
      if (cleanupUnconfirmed) {
        await expect(disposing).rejects.toBe(cleanupFailure);
        await expect(session.dispose()).rejects.toBe(cleanupFailure);
      } else {
        await disposing;
      }
      expect(await fs.pathExists(neutralCwd!)).toBe(false);
    } finally {
      abort.abort();
      fastCleanup?.();
      slowCleanup?.();
      await reading.catch(() => undefined);
      await (disposing ?? session.dispose()).catch(() => undefined);
    }
  });

  // Test Value Gate: timeout cleanup failures must survive observation fallback and cache invalidation.
  it.each([
    ['plugin', 'none'], ['snapshot', 'none'],
    ['plugin', 'pending'], ['snapshot', 'pending'],
    ['plugin', 'settled'], ['snapshot', 'settled'],
  ] as const)('retains timeout cleanup failures from %s reads with %s invalidation', async (kind, invalidation) => {
    const isolation = getCurrentSourceTestIsolation();
    let finishRead: (() => void) | undefined;
    let cleanupFailure: NativeCliError | undefined;
    let neutralCwd: string | undefined;
    const session = await createCodexNativeObservationSession({
      exactCwd: isolation.layout.fixtureCwd, env: isolation.env,
      runner: async (invocation) => {
        neutralCwd = invocation.cwd;
        await new Promise<void>((resolve) => { finishRead = resolve; });
        cleanupFailure = new NativeCliError({
          invocation, exitCode: 1, stdout: '', stderr: '', reason: 'timeout',
          cleanupError: new Error('process cleanup unconfirmed'),
        });
        throw cleanupFailure;
      },
    });
    const reading = kind === 'plugin'
      ? session.inspectPlugin({ pluginId: 'demo@aw', scope: 'user' })
      : session.snapshot('aw', 'user');
    const rejected = expect(reading).rejects.toMatchObject({ reason: 'timeout', cleanupError: expect.any(Error) });
    try {
      await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
      if (invalidation === 'pending') session.invalidate('aw');
      finishRead!();
      await rejected;
      if (invalidation === 'settled') session.invalidate('aw');
      await expect(session.dispose()).rejects.toBe(cleanupFailure);
      expect(await fs.pathExists(neutralCwd!)).toBe(false);
    } finally {
      finishRead?.();
      await reading.catch(() => undefined);
      await session.dispose().catch(() => undefined);
    }
  });

  it('serves twenty same-marketplace plugins from one exact and one neutral list', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const calls: NativeCliInvocation[] = [];
    const pluginIds = Array.from({ length: 20 }, (_, index) => `plugin-${index}@aw-team`);
    const session = await createCodexNativeObservationSession({
      exactCwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runner: async (invocation) => {
        calls.push(invocation);
        return listResult(pluginIds);
      },
    });
    try {
      const observations = await Promise.all(pluginIds.map((pluginId) =>
        session.inspectPlugin({ pluginId })));
      expect(observations.every((entry) =>
        entry.observation.state === 'observed'
        && entry.observation.value === 'installed')).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls.every((call) =>
        call.args.join(' ') === 'plugin list --marketplace aw-team --json')).toBe(true);
    } finally {
      await session.dispose();
    }
  });

  it('uses one neutral list for a user-only generation and keeps marketplaces isolated', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const calls: NativeCliInvocation[] = [];
    const session = await createCodexNativeObservationSession({
      exactCwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runner: async (invocation) => {
        calls.push(invocation);
        const marketplace = invocation.args[3]!;
        return listResult([`demo@${marketplace}`]);
      },
    });
    try {
      const [team, other] = await Promise.all([
        session.inspectPlugin({ pluginId: 'demo@aw-team', scope: 'user' }),
        session.inspectPlugin({ pluginId: 'demo@aw-other', scope: 'user' }),
      ]);
      expect(team.observation).toMatchObject({ state: 'observed', value: 'installed' });
      expect(other.observation).toMatchObject({ state: 'observed', value: 'installed' });
      expect(calls).toHaveLength(2);
      expect(new Set(calls.map((call) => call.args[3]))).toEqual(new Set(['aw-team', 'aw-other']));
      expect(calls.every((call) => call.cwd !== isolation.layout.fixtureCwd)).toBe(true);
    } finally {
      await session.dispose();
    }
  });

  it('invalidates one marketplace without discarding another marketplace cache', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const calls: NativeCliInvocation[] = [];
    let teamReads = 0;
    const session = await createCodexNativeObservationSession({
      exactCwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runner: async (invocation) => {
        calls.push(invocation);
        const marketplace = invocation.args[3]!;
        if (marketplace === 'aw-team') {
          teamReads += 1;
          return listResult(teamReads === 1 ? [] : ['demo@aw-team']);
        }
        return listResult([`demo@${marketplace}`]);
      },
    });
    try {
      expect((await session.inspectPlugin({ pluginId: 'demo@aw-team', scope: 'user' })).observation)
        .toMatchObject({ state: 'observed', value: 'absent' });
      expect((await session.inspectPlugin({ pluginId: 'demo@aw-other', scope: 'user' })).observation)
        .toMatchObject({ state: 'observed', value: 'installed' });
      expect(calls).toHaveLength(2);

      session.invalidate('aw-team');
      expect((await session.inspectPlugin({ pluginId: 'demo@aw-other', scope: 'user' })).observation)
        .toMatchObject({ state: 'observed', value: 'installed' });
      expect(calls).toHaveLength(2);

      expect((await session.inspectPlugin({ pluginId: 'demo@aw-team', scope: 'user' })).observation)
        .toMatchObject({ state: 'observed', value: 'installed' });
      expect(calls).toHaveLength(3);

      session.invalidate();
      await session.inspectPlugin({ pluginId: 'demo@aw-team', scope: 'user' });
      await session.inspectPlugin({ pluginId: 'demo@aw-other', scope: 'user' });
      expect(calls).toHaveLength(5);
    } finally {
      await session.dispose();
    }
  });

  it('does not let an invalidated in-flight list replace a newer cache entry', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const calls: NativeCliInvocation[] = [];
    let startFirstRead: (() => void) | undefined;
    let resolveFirstRead: ((result: ReturnType<typeof listResult>) => void) | undefined;
    const firstReadStarted = new Promise<void>((resolve) => {
      startFirstRead = resolve;
    });
    const session = await createCodexNativeObservationSession({
      exactCwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runner: async (invocation) => {
        calls.push(invocation);
        if (calls.length > 1) return listResult(['demo@aw']);
        startFirstRead!();
        return new Promise((resolve) => {
          resolveFirstRead = resolve;
        });
      },
    });
    try {
      const staleRead = session.inspectPlugin({ pluginId: 'demo@aw', scope: 'user' });
      await firstReadStarted;
      session.invalidate('aw');

      expect((await session.inspectPlugin({ pluginId: 'demo@aw', scope: 'user' })).observation)
        .toMatchObject({ state: 'observed', value: 'installed' });
      resolveFirstRead!(listResult([]));
      await staleRead;

      expect((await session.inspectPlugin({ pluginId: 'demo@aw', scope: 'user' })).observation)
        .toMatchObject({ state: 'observed', value: 'installed' });
      expect(calls).toHaveLength(2);
    } finally {
      await session.dispose();
    }
  });

  it('does not share generations between sessions and removes each neutral cwd', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const neutralCwds: string[] = [];
    let installed = false;
    const runner = async (invocation: NativeCliInvocation) => {
      if (invocation.cwd !== isolation.layout.fixtureCwd) neutralCwds.push(invocation.cwd!);
      return listResult(installed ? ['demo@aw'] : []);
    };
    const preview = await createCodexNativeObservationSession({
      exactCwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runner,
    });
    expect((await preview.inspectPlugin({ pluginId: 'demo@aw' })).observation)
      .toMatchObject({ state: 'observed', value: 'absent' });
    await preview.dispose();
    installed = true;
    const locked = await createCodexNativeObservationSession({
      exactCwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runner,
    });
    expect((await locked.inspectPlugin({ pluginId: 'demo@aw' })).observation)
      .toMatchObject({ state: 'observed', value: 'installed' });
    await locked.dispose();

    expect(new Set(neutralCwds).size).toBe(2);
    for (const cwd of new Set(neutralCwds)) {
      expect(path.dirname(cwd)).toBe(await fs.realpath(isolation.env.TMPDIR!));
      await expect(fs.pathExists(cwd)).resolves.toBe(false);
    }
  });

  it('keeps snapshots when manager discovery only adds version metadata', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const calls: NativeCliInvocation[] = [];
    const session = await createCodexNativeObservationSession({
      exactCwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runner: async (invocation) => {
        calls.push(invocation);
        return listResult(['demo@aw']);
      },
    });
    try {
      await session.inspectPlugin({ pluginId: 'demo@aw' });
      session.setManager({
        kind: 'system',
        version: '0.153.0',
        command: 'codex',
        argsPrefix: [],
      });
      await session.inspectPlugin({ pluginId: 'demo@aw' });
      expect(calls).toHaveLength(2);
    } finally {
      await session.dispose();
    }
  });

  it('clears system snapshots when a managed manager is selected', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const calls: NativeCliInvocation[] = [];
    const managedManager = {
      kind: 'aw-managed' as const,
      version: '0.151.0',
      command: '/managed/node',
      argsPrefix: ['/managed/codex.js'],
    };
    const session = await createCodexNativeObservationSession({
      exactCwd: isolation.layout.fixtureCwd,
      env: isolation.env,
      runner: async (invocation) => {
        calls.push(invocation);
        if (invocation.command === 'codex') {
          throw Object.assign(new Error('system Codex is unavailable'), { code: 'ENOENT' });
        }
        return listResult(['demo@aw']);
      },
    });
    try {
      expect((await session.inspectPlugin({ pluginId: 'demo@aw' })).observation)
        .toEqual({ state: 'unobserved' });
      session.setManager(managedManager);
      expect((await session.inspectPlugin({ pluginId: 'demo@aw' })).observation)
        .toMatchObject({ state: 'observed', value: 'installed' });
      expect(calls.filter((call) => call.command === 'codex')).toHaveLength(2);
      expect(calls.filter((call) => call.command === managedManager.command)).toHaveLength(2);
    } finally {
      await session.dispose();
    }
  });
});
