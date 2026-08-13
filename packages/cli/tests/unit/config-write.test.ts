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

vi.mock('../../src/utils/plugin-catalog.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/plugin-catalog.js')>(),
  resolveCurrentCatalog: vi.fn(async () => ({
    rootDir: '/catalog',
    manifestPath: '/catalog/catalog.json',
    catalogVersion: '1.0.0',
    channel: 'latest',
    source: 'embedded',
  })),
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
  resolveConfigRead,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
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
      plugin: target.pluginName,
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
      catalogChannel: 'beta',
      catalogVersion: '2.0.0-beta.1',
    });

    expect(receipt.configWrite).toBe('succeeded');
    expect(receipt.overallState).toBe('succeeded');
    expect(receipt.targetResults).toHaveLength(4);
    expect(reinstall).toHaveBeenCalledTimes(4);
    expect(reinstall.mock.calls.every((call) => call[1].cwd === fixture.cwd)).toBe(true);
    expect(reinstall.mock.calls.every((call) =>
      call[1].catalogChannel === 'beta' && call[1].catalogVersion === '2.0.0-beta.1')).toBe(true);
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

  it('keeps the saved config and successful targets when another target fails', async () => {
    const fixture = await createFixture();
    mocks.visible.add('codex:user');
    mocks.visible.add('claude:user');
    const reinstall = createReinstallMock({
      fail: (platform) => platform === 'claude',
      beforeReturn: async () => {
        const stored = await readPluginConfigStore({
          pluginName: fixture.plugin.manifest.name,
          scope: 'user',
          cwd: fixture.cwd,
          env: fixture.env,
        });
        expect(stored.values.mode).toBe('fast');
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

    expect(receipt.configWrite).toBe('succeeded');
    expect(receipt.overallState).toBe('failed');
    expect(receipt.targetResults.map((entry) => entry.state).sort()).toEqual(['completed', 'failed']);
    expect(stored.values.mode).toBe('fast');
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
