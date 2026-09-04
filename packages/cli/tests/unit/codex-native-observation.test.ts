import path from 'node:path';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import { createCodexNativeObservationSession } from '../../src/utils/codex-native-observation.js';
import type { NativeCliInvocation } from '../../src/utils/native-cli.js';
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
      expect(path.dirname(cwd)).toBe(isolation.env.TMPDIR);
      await expect(fs.pathExists(cwd)).resolves.toBe(false);
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
