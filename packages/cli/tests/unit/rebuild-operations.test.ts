import { describe, expect, it } from 'vitest';

import {
  executeRebuildOperation,
  executeRebuildTargets,
  type DesiredTarget,
  type RebuildTargetDriver,
} from '../../src/commands/rebuild-operations.js';
import type { PluginMeta } from '../../src/types.js';

function createPlugin(name = 'demo'): PluginMeta {
  return {
    rootDir: `/plugins/${name}`,
    manifestPath: `/plugins/${name}/.agents-plugin/plugin.json`,
    manifest: {
      schemaVersion: 3,
      name,
      version: '1.0.0',
      description: 'preApply fixture',
      marketplace: {
        category: 'test',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      scripts: { preApply: { path: './scripts/preApply.mjs' } },
    },
  };
}

function createFixture(options: { preApplyFailure?: boolean; preflightFailure?: boolean } = {}): {
  target: DesiredTarget;
  driver: RebuildTargetDriver;
  calls: string[];
} {
  const plugin = createPlugin();
  const calls: string[] = [];
  const target: DesiredTarget = {
    plugin,
    preApplySource: plugin,
    identity: {
      pluginName: 'demo',
      pluginVersion: '1.0.0',
      platform: 'codex',
      scope: 'user',
      cwd: '/project',
    },
    ownedComponents: [],
    desiredOwnedComponents: [],
    requiresNative: false,
    artifacts: [],
  };
  const driver: RebuildTargetDriver = {
    ownership: {
      inspectShared: async () => 'absent',
      removeShared: async () => undefined,
    },
    async preflightMaterialize() {
      calls.push('preflight');
      if (options.preflightFailure) throw new Error('blocked');
    },
    async writeNative() {
      calls.push('native');
    },
    async writeArtifacts() {
      calls.push('artifacts');
    },
    async runPreApply(invocation) {
      calls.push(`preApply:${invocation.plugin.manifest.name}`);
      if (options.preApplyFailure) throw new Error('blocked before mutation');
    },
  };
  return { target, driver, calls };
}

describe('rebuild preApply boundary', () => {
  it('runs preApply once after readonly preflight and before writes', async () => {
    const fixture = createFixture();
    const result = await executeRebuildOperation({
      command: 'install',
      target: fixture.target,
      driver: fixture.driver,
    });
    expect(result.status).toBe('succeeded');
    expect(fixture.calls).toEqual(['preflight', 'preApply:demo', 'artifacts']);
    expect(result.actions).toContainEqual({ name: 'preApply', status: 'succeeded' });
  });

  it('blocks target mutation when preApply fails', async () => {
    const fixture = createFixture({ preApplyFailure: true });
    const result = await executeRebuildOperation({
      command: 'install',
      target: fixture.target,
      driver: fixture.driver,
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: { phase: 'preApply', message: 'blocked before mutation' },
    });
    expect(fixture.calls).toEqual(['preflight', 'preApply:demo']);
    expect(result.cleanupAttempted).toBe(false);
  });

  it('does not run preApply when core preflight is blocked', async () => {
    const fixture = createFixture({ preflightFailure: true });
    const result = await executeRebuildOperation({
      command: 'install',
      target: fixture.target,
      driver: fixture.driver,
    });
    expect(result.status).toBe('failed');
    expect(fixture.calls).toEqual(['preflight']);
  });

  it('runs preApply once for both dependency and root targets', async () => {
    const fixture = createFixture();
    const dependencyPlugin = createPlugin('dependency');
    const dependency: DesiredTarget = {
      ...fixture.target,
      plugin: dependencyPlugin,
      preApplySource: dependencyPlugin,
      identity: {
        ...fixture.target.identity,
        pluginName: 'dependency',
      },
    };
    const results = await executeRebuildTargets({
      command: 'install',
      targets: [dependency, fixture.target],
      driver: fixture.driver,
    });
    expect(results.map((result) => result.status)).toEqual(['succeeded', 'succeeded']);
    expect(fixture.calls.filter((call) => call.startsWith('preApply:'))).toEqual([
      'preApply:dependency',
      'preApply:demo',
    ]);
  });

  it('runs reinstall preApply before cleanup without a second ownership preflight', async () => {
    const fixture = createFixture();
    fixture.target.ownedComponents = [{
      kind: 'shared-config',
      identity: {
        owner: 'agent-workflows', plugin: 'demo', artifactKey: 'owned',
        platform: 'codex', scope: 'user',
      },
      label: 'owned config',
      locator: { kind: 'corrupted', message: 'test fixture' },
    }];
    fixture.target.desiredOwnedComponents = fixture.target.ownedComponents;
    let filePresent = true;
    fixture.driver.ownership.inspectShared = async () => filePresent ? 'present' : 'absent';
    fixture.driver.ownership.removeShared = async () => {
      fixture.calls.push('cleanup');
      filePresent = false;
    };
    fixture.driver.preflightMaterialize = async () => { fixture.calls.push('preflight'); };
    fixture.driver.runPreApply = async () => { fixture.calls.push('preApply'); };
    fixture.driver.writeArtifacts = async () => {
      fixture.calls.push('artifacts');
      filePresent = true;
    };

    const result = await executeRebuildOperation({
      command: 'reinstall', target: fixture.target, driver: fixture.driver,
    });

    expect(result.status).toBe('succeeded');
    expect(fixture.calls).toEqual(['preflight', 'preApply', 'cleanup', 'artifacts']);
    expect(result.actions.filter((entry) => entry.name === 'preflight.inspect')).toHaveLength(1);
  });

  it('does not run preApply for cleanup or uninstall', async () => {
    for (const command of ['cleanup', 'uninstall'] as const) {
      const fixture = createFixture();
      fixture.driver.runPreApply = async () => {
        throw new Error(`${command} must not run preApply`);
      };
      const result = await executeRebuildOperation({
        command, target: fixture.target, driver: fixture.driver,
      });
      expect(result.status).toBe('succeeded');
      expect(result.actions.map((entry) => entry.name)).not.toContain('preApply');
    };
  });

  it('emits ordered action events and ignores diagnostic sink failures', async () => {
    const fixture = createFixture();
    const events: string[] = [];
    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver,
      onActionEvent: (event) => {
        events.push(`${event.data.name}:${event.data.phase}`);
        if (event.data.name === 'artifacts.write' && event.data.phase === 'success') {
          throw new Error('diagnostic sink failed');
        }
      },
    });
    expect(result.status).toBe('succeeded');
    expect(events).toEqual([
      'preflight.inspect:start', 'preflight.inspect:success',
      'preApply:start', 'preApply:success',
      'artifacts.write:start', 'artifacts.write:success',
      'postcheck.inspect:start', 'postcheck.inspect:success',
    ]);
  });

  it('maps a deferred postcheck failure back to its target after all target writes', async () => {
    const fixture = createFixture();
    let deferred: Array<{ target: DesiredTarget; postcheck: () => Promise<void> }> = [];
    fixture.driver.deferPostcheck = (target, postcheck) => {
      deferred.push({ target, postcheck });
      return true;
    };
    fixture.driver.completePostchecks = async () => {
      const failures = deferred.map(({ target }) => ({ target, error: new Error('post failed') }));
      deferred = [];
      return failures;
    };
    const results = await executeRebuildTargets({
      command: 'install', targets: [fixture.target], driver: fixture.driver,
    });
    expect(results[0]).toMatchObject({
      status: 'failed',
      error: { phase: 'postcheck.inspect', message: 'post failed' },
    });
    expect(fixture.calls).toEqual(['preflight', 'preApply:demo', 'artifacts']);
  });

  it('does not run target recovery cleanup after a shared marketplace group failure', async () => {
    const fixture = createFixture();
    fixture.target.writeNativeRequired = true;
    fixture.driver.writeNative = async () => {
      fixture.calls.push('native');
      throw Object.assign(new Error('group commit failed'), { nativeMarketplaceGroupFailure: true });
    };
    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver,
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: { phase: 'native.write', message: 'group commit failed' },
    });
    expect(result.actions.map((action) => action.name)).not.toContain('recovery.cleanup');
    expect(fixture.calls).toEqual(['preflight', 'preApply:demo', 'native']);
  });

  it('continues later targets after an earlier target fails', async () => {
    const fixture = createFixture();
    const blocked = { ...fixture.target, identity: { ...fixture.target.identity, pluginName: 'blocked' },
      plugin: createPlugin('blocked'), preApplySource: createPlugin('blocked') };
    fixture.driver.preflightMaterialize = async (target) => {
      fixture.calls.push(`preflight:${target.identity.pluginName}`);
      if (target.identity.pluginName === 'blocked') throw new Error('blocked');
    };
    const results = await executeRebuildTargets({
      command: 'install', targets: [blocked, fixture.target], driver: fixture.driver,
    });
    expect(results.map((entry) => entry.status)).toEqual(['failed', 'succeeded']);
    expect(fixture.calls).toContain('preApply:demo');
    expect(fixture.calls).not.toContain('preApply:blocked');
  });
});
