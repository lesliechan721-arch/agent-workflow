import path from 'node:path';

import fse from 'fs-extra';
import { describe, expect, it, vi } from 'vitest';

import type {
  DesiredTarget,
  RebuildCommand,
  RebuildActiveStore,
  RebuildTargetDriver,
} from '../../src/commands/rebuild-operations.js';
import {
  createRebuildActiveStore,
  executeRebuildOperation,
  executeRebuildTargets,
} from '../../src/commands/rebuild-operations.js';
import type { GeneratedArtifact, PluginMeta, RebuildActionEvent } from '../../src/types.js';
import type {
  PreparedLifecycleActiveSnapshot,
  ReadLifecycleActiveSnapshot,
} from '../../src/utils/lifecycle-active-store.js';
import { acquireProcessLock } from '../../src/utils/process-lock.js';
import type { OwnedComponent, OwnedProbeResult } from '../../src/utils/ownership.js';
import * as ownershipModule from '../../src/utils/ownership.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const plugin = (name = 'active-plugin', version = '2.0.0'): PluginMeta => ({
  rootDir: `/bundle/${name}/${version}`,
  manifestPath: `/bundle/${name}/${version}/.agents-plugin/plugin.json`,
  manifest: {
    name,
    version,
    description: 'rebuild fixture',
    compatibility: { aw: { minVersion: '0.1.0' } },
    marketplace: {
      category: 'test',
      strict: true,
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    },
    scripts: {
      lifecycle: {
        install: { default: { runner: 'node', path: './install.mjs' } },
        upgrade: { default: { runner: 'node', path: './upgrade.mjs' } },
        uninstall: { default: { runner: 'node', path: './uninstall.mjs' } },
      },
    },
  },
});

interface Fixture {
  target: DesiredTarget;
  driver: RebuildTargetDriver;
  store: RebuildActiveStore;
  log: string[];
  states: Record<'native' | 'artifact', OwnedProbeResult>;
  cleanupCalls: { native: number; artifact: number; active: number };
  fail: Set<string>;
  postcheckAbsent: boolean;
  setActive(value: 'valid' | 'missing' | 'corrupt'): void;
}

function createFixture(options: {
  name?: string;
  initial?: OwnedProbeResult;
  requiresNative?: boolean;
} = {}): Fixture {
  const currentPlugin = plugin(options.name);
  const historicalPlugin = plugin(options.name, '1.0.0');
  const log: string[] = [];
  const states = {
    native: options.initial ?? 'absent',
    artifact: options.initial ?? 'absent',
  } satisfies Record<'native' | 'artifact', OwnedProbeResult>;
  const cleanupCalls = { native: 0, artifact: 0, active: 0 };
  const fail = new Set<string>();
  let postcheckAbsent = false;
  let active: 'valid' | 'missing' | 'corrupt' = 'missing';
  let artifactInspections = 0;

  const identity = (artifactKey: string) => ({
    owner: 'agent-workflows' as const,
    plugin: currentPlugin.manifest.name,
    artifactKey,
    platform: 'codex' as const,
    scope: 'user' as const,
  });
  const native: OwnedComponent = {
    kind: 'native-plugin',
    identity: identity('native'),
    pluginId: `${currentPlugin.manifest.name}@aw`,
  };
  const artifact: OwnedComponent = {
    kind: 'managed-block',
    identity: identity('artifact'),
    label: `${currentPlugin.manifest.name}:artifact`,
    inspect: async () => {
      artifactInspections += 1;
      log.push('inspect.artifact');
      if (fail.has('preflight.inspect') || (fail.has('postcheck.inspect') && artifactInspections > 1)) {
        throw new Error('ownership probe failed');
      }
      if (postcheckAbsent && artifactInspections > 1) {
        states.artifact = 'absent';
        return 'absent';
      }
      return states.artifact;
    },
    remove: async () => {
      cleanupCalls.artifact += 1;
      log.push('remove.artifact');
      if (fail.has('cleanup')) throw new Error('cleanup failed');
      states.artifact = 'absent';
    },
  };
  const artifactDescriptor: GeneratedArtifact = {
    kind: 'instruction',
    path: `/outputs/${currentPlugin.manifest.name}.md`,
    platform: 'codex',
    artifactKey: 'artifact',
  };
  const target: DesiredTarget = {
    plugin: currentPlugin,
    identity: {
      pluginName: currentPlugin.manifest.name,
      pluginVersion: currentPlugin.manifest.version,
      platform: 'codex',
      scope: 'user',
      cwd: '/repo',
    },
    ownedComponents: options.requiresNative === false ? [artifact] : [native, artifact],
    requiresNative: options.requiresNative !== false,
    artifacts: [artifactDescriptor],
    lifecycleSource: currentPlugin,
  };

  const snapshot = {
    plugin: historicalPlugin,
    artifacts: [{ ...artifactDescriptor, path: `/old/${currentPlugin.manifest.name}.md` }],
  } as ReadLifecycleActiveSnapshot;
  const prepared = { status: 'staged' } as PreparedLifecycleActiveSnapshot;
  const store: RebuildActiveStore = {
    prepare: async () => {
      log.push('active.prepare');
      if (fail.has('active.prepare')) throw new Error('active prepare failed');
      return prepared;
    },
    discard: async () => {
      log.push('active.discard');
      if (fail.has('active.discard')) throw new Error('active discard failed');
    },
    promote: async () => {
      log.push('active.promote');
      if (fail.has('active.promote')) throw new Error('active promote failed');
      active = 'valid';
      return snapshot;
    },
    read: async () => {
      log.push('active.read');
      if (active === 'corrupt') throw new Error('bad digest');
      return active === 'valid' ? snapshot : null;
    },
    remove: async () => {
      cleanupCalls.active += 1;
      log.push('active.remove');
      if (fail.has('active.remove')) throw new Error('active remove failed');
      active = 'missing';
    },
  };
  const driver: RebuildTargetDriver = {
    probeNative: async () => {
      log.push('inspect.native');
      return states.native;
    },
    removeNative: async () => {
      cleanupCalls.native += 1;
      log.push('remove.native');
      if (fail.has('cleanup')) throw new Error('cleanup failed');
      states.native = 'absent';
    },
    writeNative: async () => {
      log.push('native.write');
      states.native = 'present';
      if (fail.has('native.write')) throw new Error('native write failed');
    },
    writeArtifacts: async () => {
      log.push('artifacts.write');
      states.artifact = 'present';
      if (fail.has('artifacts.write')) throw new Error('artifact write failed');
    },
    runLifecycle: async ({ event, plugin: source, artifacts }) => {
      log.push(`lifecycle.${event}:${source.manifest.version}:${artifacts[0]?.path}`);
      if (fail.has(`lifecycle.${event}`)) throw new Error(`${event} lifecycle failed`);
    },
  };

  const fixture: Fixture = {
    target,
    driver,
    store,
    log,
    states,
    cleanupCalls,
    fail,
    postcheckAbsent,
    setActive(value) {
      active = value;
    },
  };
  Object.defineProperty(fixture, 'postcheckAbsent', {
    get: () => postcheckAbsent,
    set: (value: boolean) => { postcheckAbsent = value; },
  });
  return fixture;
}

function actionNames(result: Awaited<ReturnType<typeof executeRebuildOperation>>): string[] {
  return result.actions.map((entry) => `${entry.name}:${entry.status}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

describe('rebuild operation happy paths', () => {
  it('emits one ordered start and terminal event for every successful action', async () => {
    const fixture = createFixture();
    const events: RebuildActionEvent[] = [];
    let clock = 0;
    const result = await executeRebuildOperation({
      command: 'install',
      target: fixture.target,
      driver: fixture.driver,
      activeStore: fixture.store,
      onActionEvent: (event) => events.push(event),
      now: () => { clock += 7; return clock; },
    });

    expect(result.status).toBe('succeeded');
    expect(events.map((event) => `${event.data.name}:${event.data.phase}`)).toEqual(
      result.actions.flatMap((entry) => [
        `${entry.name}:start`,
        `${entry.name}:${entry.status === 'succeeded' ? 'success' : 'failure'}`,
      ]),
    );
    expect(events.every((event) => event.source.plugin === 'active-plugin'
      && event.source.platform === 'codex'
      && event.source.scope === 'user'
      && event.source.action === 'install')).toBe(true);
    expect(events.filter((event) => event.data.phase !== 'start').every(
      (event) => event.data.durationMs === 7,
    )).toBe(true);
  });

  it('emits a safe failure before preserving recovery cleanup semantics', async () => {
    const fixture = createFixture();
    const events: RebuildActionEvent[] = [];
    fixture.driver.writeNative = async () => {
      fixture.states.native = 'present';
      throw new Error(
        'codex plugin add --path /Users/alice/plugin C:\\Users\\alice\\plugin token=plain-secret',
      );
    };
    const result = await executeRebuildOperation({
      command: 'install',
      target: fixture.target,
      driver: fixture.driver,
      activeStore: fixture.store,
      onActionEvent: (event) => events.push(event),
    });

    expect(result.status).toBe('failed');
    expect(events).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({
        name: 'native.write',
        phase: 'failure',
        message: '写入平台插件失败。',
      }),
    }));
    expect(JSON.stringify(events)).not.toContain('plain-secret');
    expect(JSON.stringify(events)).not.toContain('/Users/alice');
    expect(JSON.stringify(events)).not.toContain('C:\\Users');
    expect(JSON.stringify(events)).not.toContain('codex plugin add');
    expect(events.some((event) => event.data.name === 'recovery.cleanup')).toBe(true);
    expect(fixture.cleanupCalls.native).toBe(1);
    for (const name of new Set(events.map((event) => event.data.name))) {
      expect(events.filter((event) => event.data.name === name).map((event) => event.data.phase))
        .toEqual(['start', expect.stringMatching(/^(?:success|failure)$/)]);
    }
  });

  it('keeps sequential target event sources separate', async () => {
    const first = createFixture({ name: 'first', requiresNative: false });
    const second = createFixture({ name: 'second', requiresNative: false });
    const fixtures = new Map([
      ['first', first],
      ['second', second],
    ]);
    const events: RebuildActionEvent[] = [];
    const driver: RebuildTargetDriver = {
      writeNative: async () => {},
      writeArtifacts: async (target) => {
        fixtures.get(target.identity.pluginName)!.states.artifact = 'present';
      },
      runLifecycle: async () => {},
    };
    const results = await executeRebuildTargets({
      command: 'install',
      targets: [first.target, second.target],
      driver,
      activeStore: first.store,
      onActionEvent: (event) => events.push(event),
    });

    expect(results.map((result) => result.status)).toEqual(['succeeded', 'succeeded']);
    const sources = events.map((event) => event.source.plugin);
    expect(sources.slice(0, sources.lastIndexOf('first') + 1).every((name) => name === 'first')).toBe(true);
    expect(sources.slice(sources.indexOf('second')).every((name) => name === 'second')).toBe(true);
  });

  it('keeps a successful write when a terminal diagnostic event fails', async () => {
    const fixture = createFixture();
    const result = await executeRebuildOperation({
      command: 'install',
      target: fixture.target,
      driver: fixture.driver,
      activeStore: fixture.store,
      onActionEvent: async (event) => {
        if (event.data.name === 'artifacts.write' && event.data.phase === 'success') {
          throw new Error('diagnostic sink failed');
        }
      },
    });

    expect(result.status).toBe('succeeded');
    expect(result.actions).toContainEqual({ name: 'artifacts.write', status: 'succeeded' });
    expect(result.actions).not.toContainEqual({ name: 'recovery.cleanup', status: 'succeeded' });
  });

  it('serializes the complete operation window for one target', async () => {
    const fixture = createFixture();
    const lockPath = path.join(
      getCurrentSourceTestIsolation().layout.fixtureCwd,
      'same-target.operation.lock',
    );
    const firstLifecycleEntered = deferred();
    const releaseFirstLifecycle = deferred();
    const secondAcquireEntered = deferred();
    let acquireCalls = 0;
    let lifecycleCalls = 0;
    const originalLifecycle = fixture.driver.runLifecycle;
    fixture.driver.runLifecycle = async (invocation) => {
      lifecycleCalls += 1;
      if (lifecycleCalls === 1) {
        firstLifecycleEntered.resolve();
        await releaseFirstLifecycle.promise;
      }
      await originalLifecycle(invocation);
    };
    fixture.store.acquireOperation = async () => {
      acquireCalls += 1;
      if (acquireCalls === 2) secondAcquireEntered.resolve();
      return acquireProcessLock({ lockPath, pollMs: 1, timeoutMs: 500 });
    };

    const first = executeRebuildOperation({
      command: 'upgrade', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    await firstLifecycleEntered.promise;
    const second = executeRebuildOperation({
      command: 'upgrade', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    await secondAcquireEntered.promise;
    expect(fixture.log.filter((entry) => entry === 'native.write')).toHaveLength(1);

    releaseFirstLifecycle.resolve();
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status)).toEqual(['succeeded', 'succeeded']);
    expect(fixture.log.filter((entry) => entry === 'native.write')).toHaveLength(2);
    expect(results.every((result) => result.actions.some(
      (entry) => entry.name === 'operation.release' && entry.status === 'succeeded',
    ))).toBe(true);
  });

  it('releases the operation lock after a failed operation', async () => {
    const fixture = createFixture();
    const lockPath = path.join(
      getCurrentSourceTestIsolation().layout.fixtureCwd,
      'failed-target.operation.lock',
    );
    fixture.fail.add('lifecycle.upgrade');
    fixture.store.acquireOperation = () => acquireProcessLock({ lockPath });

    const result = await executeRebuildOperation({
      command: 'upgrade', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.phase).toBe('lifecycle.upgrade');

    const reacquired = await acquireProcessLock({ lockPath, timeoutMs: 50, pollMs: 1 });
    await reacquired.release();
  });

  it('keeps command success when a contender completes its release claim', async () => {
    const fixture = createFixture();
    const lockPath = path.join(
      getCurrentSourceTestIsolation().layout.fixtureCwd,
      'completed-release-claim.operation.lock',
    );
    let contender: Awaited<ReturnType<typeof acquireProcessLock>> | undefined;
    fixture.store.acquireOperation = () => acquireProcessLock({
      lockPath,
      testHooks: {
        async afterReleaseClaim() {
          const old = new Date(Date.now() - 2_000);
          await fse.utimes(lockPath, old, old);
          contender = await acquireProcessLock({
            lockPath,
            malformedOwnerGraceMs: 1,
            pollMs: 1,
            timeoutMs: 100,
          });
        },
      },
    });

    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('succeeded');
    expect(result.actions).toContainEqual({ name: 'operation.release', status: 'succeeded' });
    await contender?.release();
  });

  it('keeps command success during contender owner publication', async () => {
    const fixture = createFixture();
    const lockPath = path.join(
      getCurrentSourceTestIsolation().layout.fixtureCwd,
      'release-publication-window.operation.lock',
    );
    const contenderCreated = deferred();
    const resumeContender = deferred();
    let contenderAcquiring: ReturnType<typeof acquireProcessLock> | undefined;
    fixture.store.acquireOperation = () => acquireProcessLock({
      lockPath,
      testHooks: {
        async afterReleaseClaim() {
          const old = new Date(Date.now() - 2_000);
          await fse.utimes(lockPath, old, old);
          contenderAcquiring = acquireProcessLock({
            lockPath,
            malformedOwnerGraceMs: 1,
            pollMs: 1,
            timeoutMs: 100,
            testHooks: {
              async afterMkdir() {
                contenderCreated.resolve();
                await resumeContender.promise;
              },
            },
          });
          await contenderCreated.promise;
        },
      },
    });

    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('succeeded');
    expect(result.actions).toContainEqual({ name: 'operation.release', status: 'succeeded' });
    resumeContender.resolve();
    const contender = await contenderAcquiring;
    await contender?.release();
  });

  it('installs, promotes after lifecycle, and post-inspects after promote', async () => {
    const fixture = createFixture();
    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });

    expect(result.status).toBe('succeeded');
    expect(actionNames(result)).toEqual([
      'preflight.inspect:succeeded',
      'native.write:succeeded',
      'artifacts.write:succeeded',
      'active.prepare:succeeded',
      'lifecycle.install:succeeded',
      'active.promote:succeeded',
      'postcheck.inspect:succeeded',
    ]);
    expect(fixture.log.indexOf('active.promote')).toBeLessThan(fixture.log.lastIndexOf('inspect.artifact'));
  });

  it('upgrades with the current bundle without reading installed state', async () => {
    const fixture = createFixture();
    const result = await executeRebuildOperation({
      command: 'upgrade', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('succeeded');
    expect(fixture.log).toContain('lifecycle.upgrade:2.0.0:/outputs/active-plugin.md');
    expect(fixture.log).not.toContain('active.read');
  });

  it('cleans ownership and active snapshot without lifecycle and is absent-idempotent', async () => {
    const fixture = createFixture({ initial: 'present' });
    fixture.setActive('valid');
    const first = await executeRebuildOperation({
      command: 'cleanup', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    const second = await executeRebuildOperation({
      command: 'cleanup', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    expect(fixture.log.some((entry) => entry.startsWith('lifecycle.'))).toBe(false);
  });

  it('reinstalls by cleanup then install without uninstall lifecycle', async () => {
    const fixture = createFixture({ initial: 'present' });
    fixture.setActive('valid');
    const result = await executeRebuildOperation({
      command: 'reinstall', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('succeeded');
    expect(fixture.log).toContain('lifecycle.install:2.0.0:/outputs/active-plugin.md');
    expect(fixture.log.some((entry) => entry.startsWith('lifecycle.uninstall'))).toBe(false);
    expect(fixture.log.indexOf('active.remove')).toBeLessThan(fixture.log.indexOf('native.write'));
  });

  it('uninstalls with the historical plugin and artifacts before cleanup', async () => {
    const fixture = createFixture({ initial: 'present' });
    fixture.setActive('valid');
    const result = await executeRebuildOperation({
      command: 'uninstall', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('succeeded');
    expect(fixture.log).toContain('lifecycle.uninstall:1.0.0:/old/active-plugin.md');
    expect(fixture.log.indexOf('lifecycle.uninstall:1.0.0:/old/active-plugin.md'))
      .toBeLessThan(fixture.log.indexOf('remove.native'));
  });

  it('promotes and consumes a real active store snapshot', async () => {
    const bundleRoot = path.join(
      getCurrentSourceTestIsolation().layout.fixtureCwd,
      'rebuild-real-active-bundle',
    );
    const manifest = plugin().manifest;
    await fse.outputJson(path.join(bundleRoot, '.agents-plugin', 'plugin.json'), manifest);
    for (const event of ['install', 'upgrade', 'uninstall']) {
      await fse.outputFile(path.join(bundleRoot, `${event}.mjs`), 'export default true;\n');
    }
    const realPlugin = await readPluginManifest(bundleRoot, { mode: 'bundle' });
    let state: OwnedProbeResult = 'absent';
    const component: OwnedComponent = {
      kind: 'managed-block',
      identity: {
        owner: 'agent-workflows',
        plugin: realPlugin.manifest.name,
        artifactKey: 'real-output',
        platform: 'codex',
        scope: 'user',
      },
      label: 'real-output',
      inspect: async () => state,
      remove: async () => { state = 'absent'; },
    };
    const target: DesiredTarget = {
      plugin: realPlugin,
      identity: {
        pluginName: realPlugin.manifest.name,
        pluginVersion: realPlugin.manifest.version,
        platform: 'codex',
        scope: 'user',
        cwd: getCurrentSourceTestIsolation().layout.fixtureCwd,
      },
      ownedComponents: [component],
      requiresNative: false,
      artifacts: [],
      lifecycleSource: realPlugin,
    };
    const lifecycleSources: string[] = [];
    let lifecycleFailure = false;
    const driver: RebuildTargetDriver = {
      writeNative: async () => undefined,
      writeArtifacts: async () => { state = 'present'; },
      runLifecycle: async ({ event, plugin: source }) => {
        lifecycleSources.push(`${event}:${source.rootDir}`);
        if (lifecycleFailure) throw new Error('real lifecycle failure');
      },
    };
    const loadPlugin = (bundleRoot: string) => readPluginManifest(bundleRoot, { mode: 'bundle' });
    const activeStore = createRebuildActiveStore({ env: process.env, loadPlugin });

    const install = await executeRebuildOperation({ command: 'install', target, driver, activeStore });
    expect(install.status).toBe('succeeded');
    await expect(activeStore.read(target)).resolves.not.toBeNull();

    const uninstall = await executeRebuildOperation({ command: 'uninstall', target, driver, activeStore });
    expect(uninstall.status).toBe('succeeded');
    expect(lifecycleSources).toEqual([
      `install:${bundleRoot}`,
      expect.stringMatching(/^uninstall:.*lifecycle-active.*\/active\/bundle$/u),
    ]);
    await expect(activeStore.read(target)).resolves.toBeNull();

    lifecycleFailure = true;
    const failedInstall = await executeRebuildOperation({
      command: 'install', target, driver, activeStore,
    });
    expect(failedInstall.status).toBe('failed');
    expect(failedInstall.actions).toContainEqual({ name: 'active.discard', status: 'succeeded' });
    lifecycleFailure = false;
    await expect(executeRebuildOperation({ command: 'install', target, driver, activeStore }))
      .resolves.toMatchObject({ status: 'succeeded' });
    await executeRebuildOperation({ command: 'cleanup', target, driver, activeStore });
  });

  it('uses the injected formal loader to reject an invalid staged manifest', async () => {
    const bundleRoot = path.join(
      getCurrentSourceTestIsolation().layout.fixtureCwd,
      'rebuild-invalid-active-bundle',
    );
    const currentPlugin = plugin();
    currentPlugin.rootDir = bundleRoot;
    currentPlugin.manifestPath = path.join(bundleRoot, '.agents-plugin', 'plugin.json');
    await fse.outputJson(currentPlugin.manifestPath, {
      ...currentPlugin.manifest,
      version: 1,
    });
    for (const event of ['install', 'upgrade', 'uninstall']) {
      await fse.outputFile(path.join(bundleRoot, `${event}.mjs`), 'export default true;\n');
    }
    let state: OwnedProbeResult = 'absent';
    const target: DesiredTarget = {
      plugin: currentPlugin,
      identity: {
        pluginName: currentPlugin.manifest.name,
        pluginVersion: currentPlugin.manifest.version,
        platform: 'codex',
        scope: 'user',
        cwd: getCurrentSourceTestIsolation().layout.fixtureCwd,
      },
      ownedComponents: [{
        kind: 'managed-block',
        identity: {
          owner: 'agent-workflows',
          plugin: currentPlugin.manifest.name,
          artifactKey: 'invalid-loader-output',
          platform: 'codex',
          scope: 'user',
        },
        label: 'invalid-loader-output',
        inspect: async () => state,
        remove: async () => { state = 'absent'; },
      }],
      requiresNative: false,
      artifacts: [],
      lifecycleSource: currentPlugin,
    };
    let loaderCalls = 0;
    const activeStore = createRebuildActiveStore({
      env: process.env,
      loadPlugin: async (stagedRoot) => {
        loaderCalls += 1;
        return readPluginManifest(stagedRoot, { mode: 'bundle' });
      },
    });
    const driver: RebuildTargetDriver = {
      writeNative: async () => undefined,
      writeArtifacts: async () => { state = 'present'; },
      runLifecycle: async () => undefined,
    };

    const result = await executeRebuildOperation({
      command: 'install', target, driver, activeStore,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.phase).toBe('active.prepare');
    expect(loaderCalls).toBeGreaterThan(0);
    expect(state).toBe('absent');
  });
});

describe('rebuild operation failures', () => {
  it.each<RebuildCommand>(['install', 'upgrade', 'cleanup', 'reinstall', 'uninstall'])(
    'validates %s before inspection or cleanup',
    async (command) => {
      const fixture = createFixture();
      fixture.target.identity.pluginVersion = '9.9.9';
      const result = await executeRebuildOperation({
        command, target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
      });
      expect(result.status).toBe('failed');
      expect(fixture.log).toEqual([]);
      expect(result.cleanupAttempted).toBe(false);
    },
  );

  it.each([
    ['lifecycle version', (target: DesiredTarget) => {
      target.lifecycleSource = plugin(target.identity.pluginName, '8.0.0');
    }],
    ['component owner', (target: DesiredTarget) => {
      target.ownedComponents[0]!.identity.plugin = 'foreign-plugin';
    }],
    ['artifact platform', (target: DesiredTarget) => {
      target.artifacts[0]!.platform = 'claude';
    }],
    ['native requirement', (target: DesiredTarget) => {
      target.requiresNative = false;
    }],
    ['native id', (target: DesiredTarget) => {
      const native = target.ownedComponents[0];
      if (native?.kind === 'native-plugin') native.pluginId = 'foreign@aw';
    }],
    ['duplicate identity', (target: DesiredTarget) => {
      target.ownedComponents = [...target.ownedComponents, target.ownedComponents[1]!];
    }],
    ['duplicate path', (target: DesiredTarget) => {
      const identity = target.ownedComponents[1]!.identity;
      target.requiresNative = false;
      target.ownedComponents = [
        {
          kind: 'owned-text-file',
          path: '/outputs/same',
          allowedRoot: '/outputs',
          identity,
        },
        {
          kind: 'owned-text-file',
          path: '/outputs/./same',
          allowedRoot: '/outputs',
          identity: { ...identity, artifactKey: 'other' },
        },
      ];
    }],
  ] as const)('rejects invalid %s with zero writes', async (_name, mutate) => {
    const fixture = createFixture();
    mutate(fixture.target);
    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    expect(fixture.log).toEqual([]);
  });

  it.each<RebuildCommand>(['install', 'upgrade', 'reinstall', 'uninstall'])(
    'reports a %s ownership collision as one failed preflight inspection',
    async (command) => {
      const fixture = createFixture({ initial: 'foreign' });
      const events: RebuildActionEvent[] = [];
      const result = await executeRebuildOperation({
        command,
        target: fixture.target,
        driver: fixture.driver,
        activeStore: fixture.store,
        onActionEvent: (event) => events.push(event),
      });

      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error.phase).toBe('preflight.inspect');
      expect(result.actions).toEqual([{ name: 'preflight.inspect', status: 'failed' }]);
      expect(events.map((event) => `${event.data.name}:${event.data.phase}`)).toEqual([
        'preflight.inspect:start',
        'preflight.inspect:failure',
      ]);
      expect(fixture.log).toEqual(['inspect.native', 'inspect.artifact']);
      expect(result.cleanupAttempted).toBe(false);
    },
  );

  it('fails a foreign collision with zero writes', async () => {
    const fixture = createFixture({ initial: 'foreign' });
    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    expect(fixture.log).toEqual(['inspect.native', 'inspect.artifact']);
    expect(result.cleanupAttempted).toBe(false);
  });

  it('fails a probe error with zero writes', async () => {
    const fixture = createFixture({ requiresNative: false });
    fixture.fail.add('preflight.inspect');
    const events: RebuildActionEvent[] = [];
    const result = await executeRebuildOperation({
      command: 'install',
      target: fixture.target,
      driver: fixture.driver,
      activeStore: fixture.store,
      onActionEvent: (event) => events.push(event),
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.phase).toBe('preflight.inspect');
    expect(result.actions).toEqual([{ name: 'preflight.inspect', status: 'failed' }]);
    expect(events.map((event) => `${event.data.name}:${event.data.phase}`)).toEqual([
      'preflight.inspect:start',
      'preflight.inspect:failure',
    ]);
    expect(fixture.log).toEqual(['inspect.artifact']);
    expect(result.cleanupAttempted).toBe(false);
  });

  it('reports a partial ownership inspection as a failed preflight action', async () => {
    const fixture = createFixture({ initial: 'partial', requiresNative: false });
    const result = await executeRebuildOperation({
      command: 'install',
      target: fixture.target,
      driver: fixture.driver,
      activeStore: fixture.store,
    });

    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.phase).toBe('preflight.inspect');
    expect(result.actions).toEqual([{ name: 'preflight.inspect', status: 'failed' }]);
  });

  it('stops after stale cleanup fails and does not start materialization', async () => {
    const fixture = createFixture({ initial: 'present' });
    fixture.target.desiredOwnedComponents = [fixture.target.ownedComponents[0]!];
    fixture.fail.add('cleanup');
    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    expect(result.actions).toContainEqual({ name: 'stale.cleanup', status: 'failed' });
    expect(fixture.log).not.toContain('native.write');
    expect(fixture.cleanupCalls.active).toBe(0);
  });

  it.each([
    ['native.write', 'native.write'],
    ['artifacts.write', 'artifacts.write'],
    ['active.prepare', 'active.prepare'],
    ['lifecycle.install', 'lifecycle.install'],
    ['active.promote', 'active.promote'],
  ])('cleans once when %s fails and keeps that primary error', async (failure, phase) => {
    const fixture = createFixture();
    fixture.fail.add(failure);
    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.phase).toBe(phase);
    expect(result.actions.filter((entry) => entry.name === 'recovery.cleanup')).toHaveLength(1);
    expect(fixture.cleanupCalls.active).toBe(1);
  });

  it('promotes before postcheck, then removes active and outputs when postcheck fails', async () => {
    const fixture = createFixture();
    fixture.postcheckAbsent = true;
    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.phase).toBe('postcheck.inspect');
    expect(result.actions).toContainEqual({ name: 'active.discard', status: 'succeeded' });
    expect(result.failures.some((failure) => failure.phase === 'active.discard')).toBe(false);
    expect(fixture.log.indexOf('active.promote')).toBeLessThan(fixture.log.indexOf('active.remove'));
    expect(fixture.states.native).toBe('absent');
    expect(fixture.states.artifact).toBe('absent');
  });

  it('keeps postcheck inspection diagnostics and residual labels', async () => {
    const fixture = createFixture();
    fixture.fail.add('postcheck.inspect');
    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.message).toContain('ownership probe failed');
    expect(result.residual).toContain('active-plugin:artifact');
  });

  it('discards a prepared stage before one recovery cleanup and keeps discard failure secondary', async () => {
    const fixture = createFixture();
    fixture.fail.add('lifecycle.install');
    fixture.fail.add('active.discard');
    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.message).toBe('install lifecycle failed');
    expect(fixture.log.indexOf('active.discard')).toBeLessThan(fixture.log.indexOf('remove.native'));
    expect(result.actions.filter((entry) => entry.name === 'recovery.cleanup')).toHaveLength(1);
    expect(result.failures).toContainEqual({
      phase: 'active.discard', message: 'active discard failed',
    });
  });

  it('attempts recovery cleanup once, keeps the write error primary, and appends cleanup failures', async () => {
    const fixture = createFixture();
    fixture.fail.add('artifacts.write');
    fixture.fail.add('cleanup');
    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.message).toBe('artifact write failed');
    expect(fixture.cleanupCalls.native).toBe(1);
    expect(fixture.cleanupCalls.artifact).toBe(1);
    expect(fixture.cleanupCalls.active).toBe(0);
    expect(result.failures.some((failure) => failure.message === 'cleanup failed')).toBe(true);
  });

  it('retains active when cleanup has an owner removal failure', async () => {
    const fixture = createFixture({ initial: 'present' });
    fixture.setActive('valid');
    fixture.fail.add('cleanup');
    const result = await executeRebuildOperation({
      command: 'cleanup', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.phase).toBe('cleanup.owned');
    expect(fixture.cleanupCalls.native).toBe(1);
    expect(fixture.cleanupCalls.artifact).toBe(1);
    expect(fixture.cleanupCalls.active).toBe(0);
    expect(fixture.log).not.toContain('active.remove');
  });

  it('retains active when cleanup leaves a foreign residual', async () => {
    const fixture = createFixture({ initial: 'foreign' });
    fixture.setActive('valid');
    const result = await executeRebuildOperation({
      command: 'cleanup', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.phase).toBe('cleanup.owned');
    expect(result.residual).toEqual(['active-plugin@aw', 'active-plugin:artifact']);
    expect(fixture.cleanupCalls.active).toBe(0);
  });

  it('retains active when cleanup reports a quarantine without another failure', async () => {
    const fixture = createFixture();
    fixture.setActive('valid');
    const cleanupSpy = vi.spyOn(ownershipModule, 'cleanupOwnedComponents').mockResolvedValueOnce({
      removed: [],
      absent: [],
      residual: [],
      quarantined: ['/quarantine/owned-output'],
      failures: [],
    });
    try {
      const result = await executeRebuildOperation({
        command: 'cleanup', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.error.phase).toBe('cleanup.owned');
      expect(result.quarantined).toEqual(['/quarantine/owned-output']);
      expect(fixture.cleanupCalls.active).toBe(0);
    } finally {
      cleanupSpy.mockRestore();
    }
  });

  it('retains promoted active when postcheck recovery cleanup fails', async () => {
    const fixture = createFixture();
    fixture.postcheckAbsent = true;
    fixture.fail.add('cleanup');
    const result = await executeRebuildOperation({
      command: 'install', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.phase).toBe('postcheck.inspect');
    expect(result.actions.filter((entry) => entry.name === 'recovery.cleanup')).toHaveLength(1);
    expect(fixture.cleanupCalls.native).toBe(1);
    expect(fixture.cleanupCalls.active).toBe(0);
    expect(fixture.log).not.toContain('active.remove');
  });

  it('reports active snapshot removal failure without retrying ownership cleanup', async () => {
    const fixture = createFixture({ initial: 'present' });
    fixture.fail.add('active.remove');
    const result = await executeRebuildOperation({
      command: 'cleanup', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.phase).toBe('active.remove');
    expect(fixture.cleanupCalls.native).toBe(1);
    expect(fixture.cleanupCalls.artifact).toBe(1);
    expect(fixture.cleanupCalls.active).toBe(1);
  });

  it('continues later targets and does not roll back an earlier success', async () => {
    const first = createFixture({ name: 'first-plugin' });
    const second = createFixture({ name: 'second-plugin' });
    const third = createFixture({ name: 'third-plugin' });
    second.fail.add('artifacts.write');
    const driver: RebuildTargetDriver = {
      writeNative: (target) => target === second.target
        ? second.driver.writeNative(target)
        : target === first.target ? first.driver.writeNative(target) : third.driver.writeNative(target),
      writeArtifacts: (target) => target === second.target
        ? second.driver.writeArtifacts(target)
        : target === first.target ? first.driver.writeArtifacts(target) : third.driver.writeArtifacts(target),
      probeNative: async (component) => component.identity.plugin === 'second-plugin'
        ? second.driver.probeNative!(component)
        : component.identity.plugin === 'first-plugin'
          ? first.driver.probeNative!(component)
          : third.driver.probeNative!(component),
      removeNative: async (component) => component.identity.plugin === 'second-plugin'
        ? second.driver.removeNative!(component)
        : component.identity.plugin === 'first-plugin'
          ? first.driver.removeNative!(component)
          : third.driver.removeNative!(component),
      runLifecycle: (invocation) => invocation.target === second.target
        ? second.driver.runLifecycle(invocation)
        : invocation.target === first.target
          ? first.driver.runLifecycle(invocation)
          : third.driver.runLifecycle(invocation),
    };
    const stores = new Map([
      [first.target, first.store], [second.target, second.store], [third.target, third.store],
    ]);
    const store: RebuildActiveStore = {
      prepare: (target) => stores.get(target)!.prepare(target),
      discard: async () => undefined,
      promote: async (prepared) => {
        if ((prepared as { owner?: string }).owner === 'none') return null;
        return null;
      },
      read: (target) => stores.get(target)!.read(target),
      remove: (target) => stores.get(target)!.remove(target),
    };
    const results = await executeRebuildTargets({
      command: 'install', targets: [first.target, second.target, third.target], driver, activeStore: store,
    });
    expect(results.map((result) => result.status)).toEqual(['succeeded', 'failed', 'succeeded']);
    expect(first.cleanupCalls.active).toBe(0);
    expect(third.log).toContain('artifacts.write');
  });
});

describe('uninstall safety and dependency boundary', () => {
  it('is idempotent only when live ownership and active snapshot are absent', async () => {
    const fixture = createFixture();
    const result = await executeRebuildOperation({
      command: 'uninstall', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('succeeded');
    expect(fixture.cleanupCalls.active).toBe(0);
  });

  it('fails without mutation when a live target has no snapshot', async () => {
    const fixture = createFixture({ initial: 'present' });
    const result = await executeRebuildOperation({
      command: 'uninstall', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.message).toContain('Run cleanup');
    expect(fixture.cleanupCalls).toEqual({ native: 0, artifact: 0, active: 0 });
  });

  it('directly cleans a live target without a snapshot when uninstall lifecycle is not declared', async () => {
    const fixture = createFixture({ initial: 'present' });
    delete fixture.target.plugin.manifest.scripts?.lifecycle?.uninstall;
    const result = await executeRebuildOperation({
      command: 'uninstall', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('succeeded');
    expect(fixture.states).toEqual({ native: 'absent', artifact: 'absent' });
    expect(fixture.log.some((entry) => entry.startsWith('lifecycle.'))).toBe(false);
  });

  it('fails without mutation when the active snapshot is corrupt', async () => {
    const fixture = createFixture({ initial: 'present' });
    fixture.setActive('corrupt');
    const result = await executeRebuildOperation({
      command: 'uninstall', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.message).toContain('bad digest');
    expect(fixture.cleanupCalls).toEqual({ native: 0, artifact: 0, active: 0 });
  });

  it('retains target and snapshot when historical uninstall lifecycle fails', async () => {
    const fixture = createFixture({ initial: 'present' });
    fixture.setActive('valid');
    fixture.fail.add('lifecycle.uninstall');
    const result = await executeRebuildOperation({
      command: 'uninstall', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    expect(fixture.states).toEqual({ native: 'present', artifact: 'present' });
    expect(fixture.cleanupCalls).toEqual({ native: 0, artifact: 0, active: 0 });
  });

  it('retains snapshot when historical lifecycle succeeds but owner cleanup fails', async () => {
    const fixture = createFixture({ initial: 'present' });
    fixture.setActive('valid');
    fixture.fail.add('cleanup');
    const result = await executeRebuildOperation({
      command: 'uninstall', target: fixture.target, driver: fixture.driver, activeStore: fixture.store,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.phase).toBe('cleanup.owned');
    expect(fixture.log).toContain('lifecycle.uninstall:1.0.0:/old/active-plugin.md');
    expect(fixture.cleanupCalls.native).toBe(1);
    expect(fixture.cleanupCalls.artifact).toBe(1);
    expect(fixture.cleanupCalls.active).toBe(0);
    expect(fixture.log).not.toContain('active.remove');
  });

});
