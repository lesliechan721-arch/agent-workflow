import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  visible: new Set<string>(),
  states: new Map<string, 'present' | 'partial' | 'absent' | 'error'>(),
  discover: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock('../../src/commands/rebuild-integration.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/rebuild-integration.js')>(),
  discoverRebuildTargetNames: mocks.discover,
  inspectRebuildTarget: mocks.inspect,
}));

vi.mock('../../src/utils/project-boundary.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/project-boundary.js')>(),
  assertProjectSharedConfigPathVisible: vi.fn(async () => undefined),
  ensureProjectPrivateStateIgnore: vi.fn(async () => ({ updated: false })),
}));

import type {
  RebuildCommandResult,
  RebuildCommandRuntime,
} from '../../src/commands/rebuild-command.js';
import type { CommandEvent } from '../../src/output/model.js';
import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import type { PlatformName, PluginMeta, ReceiptTargetIdentity, Scope } from '../../src/types.js';
import {
  applyPluginConfigWrite,
  resetPluginConfigWithHelper,
} from '../../src/utils/plugin-config-write.js';
import {
  readPluginConfigStore,
  resolveConfigFileLockPath,
  resolveConfigRead,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { buildConfigGroups } from '../../src/tui/model.js';
import { acquireLifecycleOperationLock } from '../../src/utils/lifecycle-active-store.js';
import { registerCurrentTestWritableStateRoot } from '../setup/test-isolation.js';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

function locationKey(platform: PlatformName, scope: Scope): string {
  return `${platform}:${scope}`;
}

function rebuildResult(target: ReceiptTargetIdentity, state: 'succeeded' | 'failed'): RebuildCommandResult {
  return {
    platforms: [target.platform],
    plugins: state === 'succeeded' ? [target.pluginName] : [],
    warnings: [],
    rebuildResults: [],
    targetResults: [{
      target,
      action: 'reinstall',
      state: state === 'succeeded' ? 'completed' : 'failed',
      ...(state === 'failed' ? { message: 'target failed' } : {}),
    }],
    overallState: state,
    nativePlugins: {},
    repoManagedArtifacts: [],
    receiptTargets: [{
      pluginName: target.pluginName,
      platform: target.platform,
      scope: target.scope,
    }],
  };
}

async function createFixture(
  pluginName = 'configurable-plugin',
  options: {
    products?: string[];
    codexProjectManaged?: boolean;
    dynamicTarget?: boolean;
  } = {},
): Promise<{
  root: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  plugin: PluginMeta;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aw-config-reinstall-'));
  tempDirs.push(root);
  registerCurrentTestWritableStateRoot(root);
  const cwd = path.join(root, 'repo');
  await fs.ensureDir(cwd);
  await execFileAsync('git', ['init', '-q'], { cwd });
  const pluginRoot = path.join(root, 'plugin');
  const manifestPath = path.join(pluginRoot, '.agents-plugin', 'plugin.json');
  const manifest: PluginMeta['manifest'] = {
    name: pluginName,
    version: '1.0.0',
    description: 'Config apply test plugin',
    compatibility: { aw: { minVersion: '0.0.0' } },
    marketplace: {
      category: 'test',
      strict: true,
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
        ...(options.products ? { products: options.products } : {}),
      },
    },
    config: {
      schema: {
        token: { type: 'string', sensitive: true },
        mode: { type: 'enum', values: ['fast', 'safe'], default: 'safe' },
        workspace: { type: 'directory' },
        certificate: { type: 'file' },
      },
    },
    ...(options.codexProjectManaged === false ? {} : { skills: './skills' }),
    ...(options.dynamicTarget
      ? {
          artifacts: {
            targets: [{
              id: 'dynamic-skill',
              platform: 'codex',
              target: 'codex.skill',
              kind: 'skill',
              scopes: ['user'],
              states: ['present'],
              refreshKeys: ['mode'],
              skillKey: 'dynamic-skill',
            }],
          },
        }
      : {}),
  };
  await fs.outputJson(manifestPath, manifest);
  return {
    root,
    cwd,
    env: { AW_HOME: path.join(root, 'aw-home') },
    plugin: { rootDir: pluginRoot, manifestPath, manifest },
  };
}

function createReinstallMock(options: {
  fail?: (platform: PlatformName, scope: Scope) => boolean;
  beforeReturn?: (runtime: RebuildCommandRuntime) => Promise<void> | void;
} = {}) {
  return vi.fn(async (pluginNames, rawOptions, runtime: RebuildCommandRuntime) => {
    await options.beforeReturn?.(runtime);
    const target: ReceiptTargetIdentity = {
      pluginName: pluginNames[0]!,
      platform: rawOptions.platform as PlatformName,
      scope: rawOptions.scope as Scope,
    };
    return rebuildResult(
      target,
      options.fail?.(target.platform, target.scope) ? 'failed' : 'succeeded',
    );
  });
}

beforeEach(() => {
  mocks.visible.clear();
  mocks.states.clear();
  mocks.discover.mockImplementation(async (options: { platform: PlatformName; scope: Scope }) =>
    mocks.visible.has(locationKey(options.platform, options.scope)) ? ['configurable-plugin'] : []);
  mocks.inspect.mockImplementation(async (options: { platform: PlatformName; scope: Scope }) => ({
    target: {},
    inspection: {
      state: mocks.states.get(locationKey(options.platform, options.scope)) ?? 'present',
      components: [],
      errors: [],
    },
  }));
});

afterEach(async () => {
  vi.clearAllMocks();
  while (tempDirs.length > 0) await fs.remove(tempDirs.pop()!);
});

describe('config write full reinstall apply', () => {
  it.each(['save', 'reset'] as const)(
    'rejects a stale Review for config %s under the store and target locks without a write',
    async (action) => {
      const fixture = await createFixture();
      await writePluginConfigStore({
        pluginName: fixture.plugin.manifest.name,
        scope: 'user',
        cwd: fixture.cwd,
        env: fixture.env,
        values: { mode: 'safe' },
      });
      const store = await readPluginConfigStore({
        pluginName: fixture.plugin.manifest.name,
        scope: 'user',
        cwd: fixture.cwd,
        env: fixture.env,
      });
      let checks = 0;
      let contender: ReturnType<typeof acquireLifecycleOperationLock> | undefined;
      let contenderAcquired = false;
      const reviewPreflight = vi.fn(async () => {
        checks += 1;
        if (checks === 2) {
          contender = acquireLifecycleOperationLock({
            pluginName: fixture.plugin.manifest.name,
            platform: 'claude',
            scope: 'project',
            cwd: fixture.cwd,
            env: fixture.env,
          });
          void contender.then(() => { contenderAcquired = true; });
          await new Promise((resolve) => setImmediate(resolve));
          expect(contenderAcquired).toBe(false);
        }
        if (checks === 3) {
          await expect(fs.pathExists(resolveConfigFileLockPath(store.path))).resolves.toBe(true);
          throw new Error('operationReviewStale: locked evidence changed');
        }
      });
      const reinstall = createReinstallMock();

      const operation = action === 'save'
        ? applyPluginConfigWrite({
            plugin: fixture.plugin,
            scope: 'user',
            cwd: fixture.cwd,
            env: fixture.env,
            request: { updates: { mode: 'fast' } },
            reinstallCommandImpl: reinstall,
            reviewPreflight,
          })
        : resetPluginConfigWithHelper({
            plugin: fixture.plugin,
            pluginName: fixture.plugin.manifest.name,
            scope: 'user',
            cwd: fixture.cwd,
            env: fixture.env,
            reinstallCommandImpl: reinstall,
            reviewPreflight,
          });

      await expect(operation).rejects.toThrow('operationReviewStale');
      const contenderLease = await contender;
      expect(contenderAcquired).toBe(true);
      await contenderLease?.release();
      expect((await readPluginConfigStore({
        pluginName: fixture.plugin.manifest.name,
        scope: 'user',
        cwd: fixture.cwd,
        env: fixture.env,
      })).values).toEqual({ mode: 'safe' });
      expect(reinstall).not.toHaveBeenCalled();
      expect(reviewPreflight).toHaveBeenCalledTimes(3);
    },
  );

  it('projects sensitive, file, and directory values without exposing stored bytes or paths', async () => {
    const fixture = await createFixture();
    const privateDirectory = path.join(fixture.root, 'private-workspace');
    const privateFile = path.join(fixture.root, 'private-certificate.pem');
    await Promise.all([fs.ensureDir(privateDirectory), fs.outputFile(privateFile, 'private-certificate')]);
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: {
        token: 'private-token',
        workspace: privateDirectory,
        certificate: privateFile,
      },
    });
    const read = await resolveConfigRead({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'user',
      projectLayer: 'shared',
      cwd: fixture.cwd,
      env: fixture.env,
    });

    const groups = buildConfigGroups({ schema: fixture.plugin.manifest.config!, read });
    const projected = Object.fromEntries(groups.flatMap((group) =>
      group.fields.map((field) => [field.key, field.displayValue])));

    expect(projected).toMatchObject({
      token: '已设置',
      workspace: '已设置',
      certificate: '已设置',
    });
    expect(JSON.stringify(groups)).not.toContain(privateDirectory);
    expect(JSON.stringify(groups)).not.toContain(privateFile);
    expect(JSON.stringify(groups)).not.toContain('private-token');
  });

  it('passes the active progress reporter into config-triggered reinstall', async () => {
    const fixture = await createFixture();
    mocks.visible.add('codex:user');
    const events: CommandEvent[] = [];
    const progress = createRebuildProgressFeed();
    const reinstall = createReinstallMock({
      beforeReturn: async (runtime) => runtime.reporter?.event({
        type: 'rebuild:action',
        source: {
          plugin: fixture.plugin.manifest.name,
          platform: 'codex',
          scope: 'user',
          action: 'reinstall',
        },
        data: { name: 'artifacts.write', phase: 'start' },
      }),
    });

    await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
      rebuildRuntime: {
        reporter: {
          event: (event) => { events.push(event); progress.addEvent(event); },
          notice: (notice) => progress.addNotice(notice),
        },
      },
    });

    expect(events).toEqual([expect.objectContaining({
      type: 'rebuild:action',
      source: expect.objectContaining({ action: 'reinstall' }),
    })]);
    expect(progress.get().current).toEqual({
      target: 'configurable-plugin · Codex/当前用户',
      phase: '写入插件文件',
    });
  });

  it('validates before creating a config store or running reinstall', async () => {
    const fixture = await createFixture();
    const reinstall = createReinstallMock();

    await expect(applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'invalid' } },
      reinstallCommandImpl: reinstall,
    })).rejects.toThrow('must be one of');

    expect(reinstall).not.toHaveBeenCalled();
    expect((await readPluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    })).exists).toBe(false);
  });

  it('reinstalls both user and current-project targets on both platforms after a user write', async () => {
    const fixture = await createFixture();
    for (const platform of ['codex', 'claude'] as const) {
      for (const scope of ['user', 'project'] as const) mocks.visible.add(locationKey(platform, scope));
    }
    mocks.states.set('claude:project', 'partial');
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt.configWrite).toBe('succeeded');
    expect(receipt.overallState).toBe('succeeded');
    expect(receipt.targetResults).toHaveLength(4);
    expect(reinstall).toHaveBeenCalledTimes(4);
    expect(reinstall.mock.calls.every((call) => call[1].cwd === fixture.cwd)).toBe(true);
    expect(reinstall.mock.calls.every((call) =>
      !Object.hasOwn(call[1], 'catalogChannel') && !Object.hasOwn(call[1], 'catalogVersion'))).toBe(true);
    expect(receipt.otherProjectsRequireReinstall).toBe(true);
    expect(receipt.warnings.join('\n')).toContain('其它项目');
  });

  it.each([
    ['shared' as const, undefined],
    ['local' as const, 'local' as const],
  ])('limits a project %s write to current-project targets', async (_label, projectLayer) => {
    const fixture = await createFixture();
    for (const platform of ['codex', 'claude'] as const) {
      mocks.visible.add(locationKey(platform, 'user'));
      mocks.visible.add(locationKey(platform, 'project'));
    }
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'project',
      ...(projectLayer ? { projectLayer } : {}),
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt.targetResults.map((entry) => entry.target.scope)).toEqual(['project', 'project']);
    expect(reinstall.mock.calls.every((call) => call[1].scope === 'project')).toBe(true);
    expect(receipt.otherProjectsRequireReinstall).toBe(false);
  });

  it('does not install an absent target', async () => {
    const fixture = await createFixture();
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt.overallState).toBe('succeeded');
    expect(receipt.applySkippedReason).toBe('noVisibleTarget');
    expect(receipt.targetResults).toEqual([]);
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('does not probe Codex for a Claude-only manifest when Codex CLI is unavailable', async () => {
    const fixture = await createFixture('configurable-plugin', { products: ['CLAUDE'] });
    mocks.visible.add('claude:user');
    mocks.discover.mockImplementation(async (options: { platform: PlatformName; scope: Scope }) => {
      if (options.platform === 'codex') throw new Error('Codex CLI is unavailable');
      return mocks.visible.has(locationKey(options.platform, options.scope)) ? ['configurable-plugin'] : [];
    });
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt.overallState).toBe('succeeded');
    expect(mocks.discover.mock.calls.every((call) => call[0].platform === 'claude')).toBe(true);
    expect(receipt.targetResults.map((entry) => entry.target.platform)).toEqual(['claude']);
  });

  it('does not probe Claude for a Codex-only manifest when Claude CLI is unavailable', async () => {
    const fixture = await createFixture('configurable-plugin', { products: ['CODEX'] });
    mocks.visible.add('codex:user');
    mocks.discover.mockImplementation(async (options: { platform: PlatformName; scope: Scope }) => {
      if (options.platform === 'claude') throw new Error('Claude CLI is unavailable');
      return mocks.visible.has(locationKey(options.platform, options.scope)) ? ['configurable-plugin'] : [];
    });
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt.overallState).toBe('succeeded');
    expect(mocks.discover.mock.calls.every((call) => call[0].platform === 'codex')).toBe(true);
    expect(receipt.targetResults.map((entry) => entry.target.platform)).toEqual(['codex']);
  });

  it('applies a user config write to a visible Claude project native-only target', async () => {
    const fixture = await createFixture('configurable-plugin', {
      products: ['CLAUDE'],
      codexProjectManaged: false,
    });
    mocks.visible.add('claude:project');
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt.overallState).toBe('succeeded');
    expect(receipt.targetResults).toHaveLength(1);
    expect(receipt.targetResults[0]?.target).toMatchObject({
      platform: 'claude',
      scope: 'project',
    });
    expect(reinstall).toHaveBeenCalledWith(
      ['configurable-plugin'],
      expect.objectContaining({ platform: 'claude', scope: 'project', cwd: fixture.cwd }),
      expect.any(Object),
    );
  });

  it('limits a project config write to the visible Claude project native-only target', async () => {
    const fixture = await createFixture('configurable-plugin', {
      products: ['CLAUDE'],
      codexProjectManaged: false,
    });
    mocks.visible.add('claude:user');
    mocks.visible.add('claude:project');
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt.targetResults).toHaveLength(1);
    expect(receipt.targetResults[0]?.target).toMatchObject({
      platform: 'claude',
      scope: 'project',
    });
    expect(reinstall).toHaveBeenCalledTimes(1);
  });

  it('does not inspect a Codex project target when the manifest has no project-managed capability', async () => {
    const fixture = await createFixture('configurable-plugin', {
      products: ['CODEX'],
      codexProjectManaged: false,
    });
    mocks.visible.add('codex:user');
    mocks.visible.add('codex:project');
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    });

    expect(mocks.discover).toHaveBeenCalledTimes(1);
    expect(mocks.discover).toHaveBeenCalledWith(expect.objectContaining({
      platform: 'codex',
      scope: 'user',
    }));
    expect(receipt.targetResults.map((entry) => entry.target.scope)).toEqual(['user']);
  });

  it('does not inspect or render an absent dynamic plugin target', async () => {
    const fixture = await createFixture('configurable-plugin', {
      products: ['CODEX'],
      dynamicTarget: true,
    });
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt.applySkippedReason).toBe('noVisibleTarget');
    expect(mocks.discover.mock.calls.every((call) => call[0].nativeFailureMode === 'ignore')).toBe(true);
    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('rolls back the saved config when any reinstall target fails', async () => {
    const fixture = await createFixture();
    mocks.visible.add('codex:user');
    mocks.visible.add('claude:user');
    let claudeAttempts = 0;
    const observedModes: unknown[] = [];
    const reinstall = createReinstallMock({
      fail: (platform) => platform === 'claude' && claudeAttempts++ === 0,
      beforeReturn: async () => {
        const stored = await readPluginConfigStore({
          pluginName: fixture.plugin.manifest.name,
          scope: 'user',
          cwd: fixture.cwd,
          env: fixture.env,
        });
        observedModes.push(stored.values.mode);
      },
    });

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    });
    const stored = await readPluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    });

    expect(receipt.configWrite).toBe('rolledBack');
    expect(receipt.overallState).toBe('failed');
    expect(receipt.targetResults.map((entry) => entry.state).sort()).toEqual(['completed', 'failed']);
    expect(stored.values).toEqual({});
    expect(observedModes).toEqual(['fast', 'fast', undefined, undefined]);
    expect(reinstall).toHaveBeenCalledTimes(4);
  });

  it('serializes a failed rollback and a later successful write for one namespaced store', async () => {
    const fixture = await createFixture();
    fixture.plugin.sourceId = 'team';
    fixture.plugin.sourceIdentity = `sha256:${'1'.repeat(64)}`;
    fixture.plugin.pluginId = 'team/configurable-plugin';
    fixture.plugin.marketplaceName = 'aw-team';
    const target: ReceiptTargetIdentity = {
      pluginName: fixture.plugin.manifest.name,
      platform: 'codex',
      scope: 'user',
    };
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const firstAttemptStarted = new Promise<void>((resolve) => { firstStarted = resolve; });
    const observed: string[] = [];
    let firstCalls = 0;
    const firstReinstall = vi.fn(async () => {
      const store = await readPluginConfigStore({
        sourceId: fixture.plugin.sourceId,
        sourceIdentity: fixture.plugin.sourceIdentity,
        pluginName: fixture.plugin.manifest.name,
        scope: 'user',
        cwd: fixture.cwd,
        env: fixture.env,
      });
      observed.push(`A:${String(store.values.mode)}`);
      firstCalls += 1;
      if (firstCalls === 1) {
        firstStarted();
        await firstCanFinish;
        return rebuildResult(target, 'failed');
      }
      return rebuildResult(target, 'succeeded');
    });
    let secondEntered = false;
    const secondReinstall = vi.fn(async () => {
      secondEntered = true;
      const store = await readPluginConfigStore({
        sourceId: fixture.plugin.sourceId,
        sourceIdentity: fixture.plugin.sourceIdentity,
        pluginName: fixture.plugin.manifest.name,
        scope: 'user',
        cwd: fixture.cwd,
        env: fixture.env,
      });
      observed.push(`B:${String(store.values.mode)}`);
      return rebuildResult(target, 'succeeded');
    });
    const first = applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      applyTargets: [target],
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: firstReinstall,
    });
    await firstAttemptStarted;
    const second = applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      applyTargets: [target],
      request: { updates: { mode: 'safe' } },
      reinstallCommandImpl: secondReinstall,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    expect(secondEntered).toBe(false);
    releaseFirst();

    const [firstReceipt, secondReceipt] = await Promise.all([first, second]);
    expect(firstReceipt.configWrite).toBe('rolledBack');
    expect(secondReceipt.configWrite).toBe('succeeded');
    expect(observed).toEqual(['A:fast', 'A:undefined', 'B:safe']);
    expect((await readPluginConfigStore({
      sourceId: fixture.plugin.sourceId,
      sourceIdentity: fixture.plugin.sourceIdentity,
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    })).values).toEqual({ mode: 'safe' });
  });

  it('reports rollbackFailed when runtime compensation cannot restore an affected target', async () => {
    const fixture = await createFixture();
    mocks.visible.add('codex:user');
    const reinstall = createReinstallMock({ fail: () => true });

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt).toMatchObject({
      configWrite: 'rollbackFailed',
      overallState: 'failed',
      targetResults: [expect.objectContaining({
        state: 'failed',
        message: expect.stringContaining('rollbackFailed:'),
      })],
    });
    expect((await readPluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    })).values).toEqual({});
    expect(reinstall).toHaveBeenCalledTimes(2);
  });

  it('rolls back a reset when reinstall fails', async () => {
    const fixture = await createFixture();
    mocks.visible.add('codex:user');
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 'fast' },
    });
    let attempts = 0;
    const reinstall = createReinstallMock({ fail: () => attempts++ === 0 });

    const receipt = await resetPluginConfigWithHelper({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      reinstallCommandImpl: reinstall,
    });
    const stored = await readPluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    });

    expect(receipt).toMatchObject({
      configWrite: 'rolledBack',
      overallState: 'failed',
      deleted: false,
      removedKeys: [],
    });
    expect(stored.values).toEqual({ mode: 'fast' });
    expect(reinstall).toHaveBeenCalledTimes(2);
  });

  it('resets an unknown catalog plugin store without trying to apply it', async () => {
    const fixture = await createFixture('unknown-plugin');
    await writePluginConfigStore({
      pluginName: 'unknown-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { secret: 'kept-only-in-store' },
    });
    const reinstall = createReinstallMock();

    const receipt = await resetPluginConfigWithHelper({
      pluginName: 'unknown-plugin',
      plugin: null,
      pluginError: new Error('not in catalog'),
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      reinstallCommandImpl: reinstall,
    });

    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      deleted: true,
      applySkippedReason: 'currentCatalogUnavailable',
      targetResults: [],
    });
    expect(reinstall).not.toHaveBeenCalled();
    expect((await readPluginConfigStore({
      pluginName: 'unknown-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    })).exists).toBe(false);
  });

  it.each([
    { scope: 'user' as const, projectLayer: undefined },
    { scope: 'project' as const, projectLayer: 'shared' as const },
    { scope: 'project' as const, projectLayer: 'local' as const },
  ])('removes one legacy $scope/$projectLayer key without deleting the store', async ({ scope, projectLayer }) => {
    const fixture = await createFixture('legacy-plugin');
    await writePluginConfigStore({
      pluginName: 'legacy-plugin',
      scope,
      ...(projectLayer ? { projectLayer } : {}),
      cwd: fixture.cwd,
      env: fixture.env,
      values: { removeMe: 'old', keepMe: 'kept' },
    });
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: null,
      pluginError: new Error('catalog unavailable'),
      pluginName: 'legacy-plugin',
      scope,
      ...(projectLayer ? { projectLayer } : {}),
      cwd: fixture.cwd,
      env: fixture.env,
      request: { removeKeys: ['removeMe'] },
      reinstallCommandImpl: reinstall,
    });
    const store = await readPluginConfigStore({
      pluginName: 'legacy-plugin',
      scope,
      ...(projectLayer ? { projectLayer } : {}),
      cwd: fixture.cwd,
      env: fixture.env,
    });

    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      removedKeys: ['removeMe'],
      applySkippedReason: 'currentCatalogUnavailable',
      targetResults: [],
    });
    expect(reinstall).not.toHaveBeenCalled();
    expect(store.exists).toBe(true);
    expect(store.values).toEqual({ keepMe: 'kept' });
  });

  it('keeps an empty legacy store after removing its last key', async () => {
    const fixture = await createFixture('legacy-plugin');
    await writePluginConfigStore({
      pluginName: 'legacy-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { only: 'old' },
    });

    await applyPluginConfigWrite({
      plugin: null,
      pluginName: 'legacy-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { removeKeys: ['only'] },
    });
    const store = await readPluginConfigStore({
      pluginName: 'legacy-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    });

    expect(store.exists).toBe(true);
    expect(store.values).toEqual({});
  });

  it('keeps selected project shared values separate from project local effective values', async () => {
    const fixture = await createFixture();
    fixture.plugin.manifest.config!.schema.label = { type: 'string' };
    fixture.plugin.manifest.config!.schema.count = { type: 'number' };
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      projectLayer: 'shared',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { label: 'shared-label', count: 42 },
    });
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      projectLayer: 'local',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { label: 'local-label', count: 99 },
    });

    const result = await resolveConfigRead({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'project',
      projectLayer: 'shared',
      cwd: fixture.cwd,
      env: fixture.env,
    });

    expect(result.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'label',
        effectiveValue: 'local-label',
        sourceLayer: 'local',
        storedValue: 'shared-label',
        storedSourceLayer: 'project',
      }),
      expect.objectContaining({
        key: 'count',
        effectiveValue: 99,
        sourceLayer: 'local',
        storedValue: 42,
        storedSourceLayer: 'project',
      }),
    ]));
  });

  it('reads only legacy keys from the selected project local store and redacts their values', async () => {
    const fixture = await createFixture('legacy-plugin');
    await writePluginConfigStore({
      pluginName: 'legacy-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { userOnly: 'user secret' },
    });
    await writePluginConfigStore({
      pluginName: 'legacy-plugin',
      scope: 'project',
      projectLayer: 'local',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { localOnly: 'local secret' },
    });

    const result = await resolveConfigRead({
      pluginName: 'legacy-plugin',
      plugin: null,
      scope: 'project',
      projectLayer: 'local',
      cwd: fixture.cwd,
      env: fixture.env,
    });

    expect(result.fields).toEqual([expect.objectContaining({
      key: 'localOnly',
      effectiveValue: '[redacted]',
      sourceLayer: 'local',
    })]);
    expect(JSON.stringify(result)).not.toContain('user secret');
    expect(JSON.stringify(result)).not.toContain('local secret');
  });

  it('rejects an unknown legacy key without changing the store', async () => {
    const fixture = await createFixture('legacy-plugin');
    await writePluginConfigStore({
      pluginName: 'legacy-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { known: 'old' },
    });

    await expect(applyPluginConfigWrite({
      plugin: null,
      pluginName: 'legacy-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { removeKeys: ['missing'] },
    })).rejects.toThrow('Unknown config key "missing".');
    expect((await readPluginConfigStore({
      pluginName: 'legacy-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    })).values).toEqual({ known: 'old' });
  });
});
