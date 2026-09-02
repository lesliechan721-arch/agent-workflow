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
      description: 'postApply fixture',
      marketplace: {
        category: 'test',
        strict: true,
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      },
      scripts: { postApply: { path: './scripts/postApply.mjs' } },
    },
  };
}

function createFixture(options: { postApplyFailure?: boolean; preflightFailure?: boolean } = {}): {
  target: DesiredTarget;
  driver: RebuildTargetDriver;
  calls: string[];
} {
  const plugin = createPlugin();
  const calls: string[] = [];
  const target: DesiredTarget = {
    plugin,
    postApplySource: plugin,
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
    async runPostApply(invocation) {
      calls.push(`postApply:${invocation.plugin.manifest.name}`);
      if (options.postApplyFailure) throw new Error('warning only');
    },
  };
  return { target, driver, calls };
}

describe('rebuild postApply boundary', () => {
  it('runs postApply for an explicit no-op reconcile after verify', async () => {
    const fixture = createFixture();
    const result = await executeRebuildOperation({
      command: 'install',
      target: fixture.target,
      driver: fixture.driver,
    });
    expect(result.status).toBe('succeeded');
    expect(fixture.calls).toEqual(['preflight', 'artifacts', 'postApply:demo']);
    expect(result.actions).toContainEqual({ name: 'postApply', status: 'succeeded' });
  });

  it('keeps the core result succeeded when postApply fails', async () => {
    const fixture = createFixture({ postApplyFailure: true });
    const result = await executeRebuildOperation({
      command: 'install',
      target: fixture.target,
      driver: fixture.driver,
    });
    expect(result.status).toBe('succeeded');
    expect(result.actions).toContainEqual({ name: 'postApply', status: 'failed' });
    expect(result.failures).toEqual([]);
  });

  it('does not run postApply when core preflight is blocked', async () => {
    const fixture = createFixture({ preflightFailure: true });
    const result = await executeRebuildOperation({
      command: 'install',
      target: fixture.target,
      driver: fixture.driver,
    });
    expect(result.status).toBe('failed');
    expect(fixture.calls).toEqual(['preflight']);
  });

  it('runs postApply for both dependency and root targets', async () => {
    const fixture = createFixture();
    const dependencyPlugin = createPlugin('dependency');
    const dependency: DesiredTarget = {
      ...fixture.target,
      plugin: dependencyPlugin,
      postApplySource: dependencyPlugin,
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
    expect(fixture.calls.filter((call) => call.startsWith('postApply:'))).toEqual([
      'postApply:dependency',
      'postApply:demo',
    ]);
  });

  it('reports a present optional component as unchanged in the exact postApply context', async () => {
    const fixture = createFixture();
    const optional = {
      kind: 'shared-config' as const,
      identity: {
        owner: 'agent-workflows' as const,
        plugin: 'demo', artifactKey: 'optional', platform: 'codex' as const, scope: 'user' as const,
      },
      label: 'optional',
      locator: { kind: 'corrupted' as const, message: 'test-only locator' },
    };
    fixture.target.ownedComponents = [optional];
    fixture.target.desiredOwnedComponents = [];
    fixture.target.optionalOwnedComponents = [optional];
    fixture.driver.ownership.inspectShared = async () => 'present';
    let components: unknown;
    fixture.driver.runPostApply = async (invocation) => {
      components = invocation.components;
    };
    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver,
    });
    expect(result.status).toBe('succeeded');
    expect(components).toEqual([{ kind: 'shared-config', key: 'optional', outcome: 'unchanged' }]);
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
      'artifacts.write:start', 'artifacts.write:success',
      'postcheck.inspect:start', 'postcheck.inspect:success',
      'postApply:start', 'postApply:success',
    ]);
  });

  it('commits only after postcheck and runs postApply after the commit', async () => {
    const fixture = createFixture();
    fixture.driver.commitMaterialize = async () => { fixture.calls.push('commit'); };
    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver,
    });
    expect(result.status).toBe('succeeded');
    expect(result.actions.map((entry) => entry.name)).toEqual([
      'preflight.inspect', 'artifacts.write', 'postcheck.inspect', 'marketplace.commit', 'postApply',
    ]);
    expect(fixture.calls).toEqual(['preflight', 'artifacts', 'commit', 'postApply:demo']);
  });

  it('continues later targets after an earlier target fails', async () => {
    const fixture = createFixture();
    const blocked = { ...fixture.target, identity: { ...fixture.target.identity, pluginName: 'blocked' },
      plugin: createPlugin('blocked'), postApplySource: createPlugin('blocked') };
    fixture.driver.preflightMaterialize = async (target) => {
      fixture.calls.push(`preflight:${target.identity.pluginName}`);
      if (target.identity.pluginName === 'blocked') throw new Error('blocked');
    };
    const results = await executeRebuildTargets({
      command: 'install', targets: [blocked, fixture.target], driver: fixture.driver,
    });
    expect(results.map((entry) => entry.status)).toEqual(['failed', 'succeeded']);
    expect(fixture.calls).toContain('postApply:demo');
    expect(fixture.calls).not.toContain('postApply:blocked');
  });
});
