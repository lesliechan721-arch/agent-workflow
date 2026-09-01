import crypto from 'node:crypto';
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
  resolveConfigRead,
  resolvePluginConfigStorePath,
  writePluginConfigStore,
} from '../../src/utils/plugin-config.js';
import { buildConfigGroups, buildConfigPage } from '../../src/tui/model.js';
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
    schemaVersion: 3,
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
      fields: {
        token: { type: 'string', sensitive: true },
        mode: {
          type: 'string',
          choices: {
            allowCustom: false,
            presets: [
              { id: 'fast', title: 'Fast', value: 'fast' },
              { id: 'safe', title: 'Safe', value: 'safe' },
            ],
          },
          default: 'safe',
        },
        workspace: { type: 'string', sensitive: true },
        certificate: { type: 'string', sensitive: true },
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
  it('does not change an invalid schema-aware store when setting another field', async () => {
    const fixture = await createFixture();
    const sourceIdentity = `sha256:${'a'.repeat(64)}`;
    Object.assign(fixture.plugin, {
      sourceId: 'official',
      sourceIdentity,
      pluginId: `official/${fixture.plugin.manifest.name}`,
    });
    const storeOptions = {
      sourceId: 'official',
      sourceIdentity,
      pluginName: fixture.plugin.manifest.name,
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    const filePath = resolvePluginConfigStorePath(storeOptions);
    await fs.outputJson(filePath, {
      schemaVersion: 3,
      sourceId: storeOptions.sourceId,
      sourceIdentity,
      pluginName: storeOptions.pluginName,
      values: { mode: 42 },
    }, { spaces: 2 });
    const before = await fs.readFile(filePath);
    const beforeDigest = crypto.createHash('sha256').update(before).digest('hex');
    const reinstall = createReinstallMock();

    await expect(applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { token: 'new-secret' } },
      reinstallCommandImpl: reinstall,
    })).rejects.toThrow('invalidValues');

    const after = await fs.readFile(filePath);
    expect(after).toEqual(before);
    expect(crypto.createHash('sha256').update(after).digest('hex')).toBe(beforeDigest);
    expect(reinstall).not.toHaveBeenCalled();
  });

  it.each(['save', 'reset'] as const)(
    'rejects a stale Review for config %s once under the config transaction without a write',
    async (action) => {
      const fixture = await createFixture();
      await writePluginConfigStore({
        pluginName: fixture.plugin.manifest.name,
        scope: 'user',
        cwd: fixture.cwd,
        env: fixture.env,
        values: { mode: 'safe' },
      });
      const reviewPreflight = vi.fn(async () => {
        throw new Error('operationReviewStale: locked evidence changed');
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
      expect((await readPluginConfigStore({
        pluginName: fixture.plugin.manifest.name,
        scope: 'user',
        cwd: fixture.cwd,
        env: fixture.env,
      })).values).toEqual({ mode: 'safe' });
      expect(reinstall).not.toHaveBeenCalled();
      expect(reviewPreflight).toHaveBeenCalledOnce();
    },
  );

  it('projects sensitive string values without exposing stored bytes', async () => {
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
    expect(JSON.stringify(read)).not.toContain(privateDirectory);
    expect(JSON.stringify(read)).not.toContain(privateFile);
    expect(JSON.stringify(read)).not.toContain('private-token');
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
    })).rejects.toThrow('Expected a declared preset value');

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

  it('preserves a failed dependency and skipped root from the normal reinstall receipt', async () => {
    const fixture = await createFixture('root');
    fixture.plugin.sourceId = 'team';
    fixture.plugin.sourceIdentity = `sha256:${'1'.repeat(64)}`;
    fixture.plugin.pluginId = 'team/root';
    fixture.plugin.marketplaceName = 'aw-team';
    const rootTarget: ReceiptTargetIdentity = {
      sourceId: 'team',
      sourceIdentity: fixture.plugin.sourceIdentity,
      pluginId: 'team/root',
      pluginName: 'root',
      platform: 'codex',
      scope: 'project',
    };
    const leafTarget: ReceiptTargetIdentity = {
      ...rootTarget,
      pluginId: 'team/leaf',
      pluginName: 'leaf',
    };
    const reinstall = vi.fn(async (): Promise<RebuildCommandResult> => ({
      ...rebuildResult(rootTarget, 'failed'),
      targetResults: [
        { target: leafTarget, action: 'reinstall', state: 'failed', message: 'leaf partial' },
        {
          target: rootTarget,
          action: 'skipped',
          state: 'failed',
          errorCode: 'dependencyInstallFailed',
        },
      ],
    }));

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      applyTargets: [rootTarget],
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    });

    expect(reinstall).toHaveBeenCalledOnce();
    expect(reinstall.mock.calls[0]?.[0]).toEqual(['team/root']);
    expect(reinstall.mock.calls[0]?.[2]).not.toHaveProperty('bypassDependencyPlan');
    expect(reinstall.mock.calls[0]?.[2]).not.toHaveProperty('catalogResolution');
    expect(reinstall.mock.calls[0]?.[2]).not.toHaveProperty('namespacedSource');
    expect(reinstall.mock.calls[0]?.[2].awHomeMutationToken).toBeDefined();
    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'failed',
      targetResults: [
        expect.objectContaining({ target: expect.objectContaining({ pluginId: 'team/leaf' }), state: 'failed' }),
        expect.objectContaining({
          target: expect.objectContaining({ pluginId: 'team/root' }),
          action: 'skipped',
          state: 'failed',
        }),
      ],
    });
    expect((await readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity: fixture.plugin.sourceIdentity,
      pluginName: 'root',
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
    })).values).toEqual({ mode: 'fast' });
  });

  it('limits a project write to current-project targets', async () => {
    const fixture = await createFixture();
    for (const platform of ['codex', 'claude'] as const) {
      mocks.visible.add(locationKey(platform, 'user'));
      mocks.visible.add(locationKey(platform, 'project'));
    }
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'project',
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

  it('discovers a current Codex project activation without legacy project-managed capability', async () => {
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

    expect(mocks.discover).toHaveBeenCalledTimes(2);
    expect(mocks.discover.mock.calls.map((call) => call[0].scope)).toEqual(['user', 'project']);
    expect(receipt.targetResults.map((entry) => entry.target.scope)).toEqual(['user', 'project']);
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

  it('keeps the saved config and completed target when another reinstall target fails', async () => {
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

    expect(receipt.configWrite).toBe('succeeded');
    expect(receipt.overallState).toBe('failed');
    expect(receipt.targetResults.map((entry) => entry.state).sort()).toEqual(['completed', 'failed']);
    expect(stored.values).toEqual({ mode: 'fast' });
    expect(observedModes).toEqual(['fast', 'fast']);
    expect(reinstall).toHaveBeenCalledTimes(2);
  });

  it('serializes a failed runtime apply and a later successful write for one namespaced store', async () => {
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
      firstStarted();
      await firstCanFinish;
      return rebuildResult(target, 'failed');
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
    expect(firstReceipt).toMatchObject({ configWrite: 'succeeded', overallState: 'failed' });
    expect(secondReceipt.configWrite).toBe('succeeded');
    expect(observed).toEqual(['A:fast', 'B:safe']);
    expect(firstReinstall).toHaveBeenCalledOnce();
    expect((await readPluginConfigStore({
      sourceId: fixture.plugin.sourceId,
      sourceIdentity: fixture.plugin.sourceIdentity,
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    })).values).toEqual({ mode: 'safe' });
  });

  it('reports one failed runtime apply while keeping the committed config', async () => {
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
      configWrite: 'succeeded',
      overallState: 'failed',
      targetResults: [expect.objectContaining({
        state: 'failed',
        message: 'target failed',
      })],
    });
    expect((await readPluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    })).values).toEqual({ mode: 'fast' });
    expect(reinstall).toHaveBeenCalledOnce();
  });

  it('keeps a reset committed when reinstall fails', async () => {
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
      configWrite: 'succeeded',
      overallState: 'failed',
      deleted: true,
      removedKeys: ['mode'],
    });
    expect(stored).toMatchObject({ exists: false, values: {} });
    expect(reinstall).toHaveBeenCalledOnce();
  });

  it('keeps an unknown catalog plugin store when reset cannot validate the plugin', async () => {
    const fixture = await createFixture('unknown-plugin');
    await writePluginConfigStore({
      pluginName: 'unknown-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { secret: 'kept-only-in-store' },
    });
    const reinstall = createReinstallMock();

    await expect(resetPluginConfigWithHelper({
      pluginName: 'unknown-plugin',
      plugin: null,
      pluginError: new Error('not in catalog'),
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      reinstallCommandImpl: reinstall,
    })).rejects.toThrow('sourceMissing');

    expect(reinstall).not.toHaveBeenCalled();
    expect((await readPluginConfigStore({
      pluginName: 'unknown-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    }))).toMatchObject({ exists: true, values: { secret: 'kept-only-in-store' } });
  });

  it.each([
    { scope: 'user' as const },
    { scope: 'project' as const },
  ])('keeps legacy $scope values when the catalog is unavailable', async ({ scope }) => {
    const fixture = await createFixture('legacy-plugin');
    await writePluginConfigStore({
      pluginName: 'legacy-plugin',
      scope,
      cwd: fixture.cwd,
      env: fixture.env,
      values: { removeMe: 'old', keepMe: 'kept' },
    });
    const reinstall = createReinstallMock();

    await expect(applyPluginConfigWrite({
      plugin: null,
      pluginError: new Error('catalog unavailable'),
      pluginName: 'legacy-plugin',
      scope,
      cwd: fixture.cwd,
      env: fixture.env,
      request: { removeKeys: ['removeMe'] },
      reinstallCommandImpl: reinstall,
    })).rejects.toThrow('catalog unavailable');
    const store = await readPluginConfigStore({
      pluginName: 'legacy-plugin',
      scope,
      cwd: fixture.cwd,
      env: fixture.env,
    });

    expect(reinstall).not.toHaveBeenCalled();
    expect(store.exists).toBe(true);
    expect(store.values).toEqual({ removeMe: 'old', keepMe: 'kept' });
  });

  it('keeps the last legacy key when no schema is available', async () => {
    const fixture = await createFixture('legacy-plugin');
    await writePluginConfigStore({
      pluginName: 'legacy-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { only: 'old' },
    });

    await expect(applyPluginConfigWrite({
      plugin: null,
      pluginName: 'legacy-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { removeKeys: ['only'] },
    })).rejects.toThrow('configSchemaUnavailable');
    const store = await readPluginConfigStore({
      pluginName: 'legacy-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    });

    expect(store.exists).toBe(true);
    expect(store.values).toEqual({ only: 'old' });
  });

  it('keeps user and project values separate and applies project precedence', async () => {
    const fixture = await createFixture();
    fixture.plugin.manifest.config!.fields.label = { type: 'string' };
    fixture.plugin.manifest.config!.fields.count = { type: 'number' };
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { label: 'user-label', count: 7 },
    });
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { label: 'shared-label', count: 42 },
    });

    const result = await resolveConfigRead({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
    });
    const userResult = await resolveConfigRead({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    });
    const effectiveResult = await resolveConfigRead({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'effective',
      cwd: fixture.cwd,
      env: fixture.env,
    });

    expect(result.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'label',
        effectiveValue: 'shared-label',
        sourceLayer: 'project',
        storedValue: 'shared-label',
        storedSourceLayer: 'project',
      }),
      expect.objectContaining({
        key: 'count',
        effectiveValue: 42,
        sourceLayer: 'project',
        storedValue: 42,
        storedSourceLayer: 'project',
      }),
    ]));
    expect(userResult.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'label',
        effectiveValue: 'user-label',
        sourceLayer: 'user',
        storedValue: 'user-label',
        storedSourceLayer: 'user',
      }),
    ]));
    expect(buildConfigPage({
      pluginId: 'official/configurable-plugin',
      schema: fixture.plugin.manifest.config!,
      read: userResult,
      effectiveRead: effectiveResult,
    }).groups.flatMap((group) => group.fields).find((field) => field.key === 'label')).toMatchObject({
      displayValue: 'user-label',
      effectiveDisplayValue: 'shared-label',
      effectiveSourceLabel: '当前项目',
    });
  });

  it('keeps missing optional and required fields unset through the real read-to-page projection', async () => {
    const fixture = await createFixture();
    fixture.plugin.manifest.config!.fields.optional = { type: 'string' };
    fixture.plugin.manifest.config!.fields.required = { type: 'string', required: true };

    const effectiveRead = await resolveConfigRead({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'effective',
      cwd: fixture.cwd,
      env: fixture.env,
    });
    const userRead = await resolveConfigRead({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    });
    const page = buildConfigPage({
      pluginId: 'official/configurable-plugin',
      schema: fixture.plugin.manifest.config!,
      read: effectiveRead,
    });

    expect(effectiveRead.fields.find((field) => field.key === 'optional')).toMatchObject({
      valueState: 'default', effectiveValue: null, sourceLayer: null,
    });
    expect(userRead.fields.find((field) => field.key === 'optional')).toMatchObject({
      valueState: 'default', effectiveValue: null, sourceLayer: null,
    });
    expect(page.groups.flatMap((group) => group.fields)
      .find((field) => field.key === 'optional')).toMatchObject({
      displayValue: '未设置', configured: false, sourceLabel: '未设置',
    });
    expect(effectiveRead.fields.find((field) => field.key === 'required')).toMatchObject({
      valueState: 'invalid', effectiveValue: null, sourceLayer: null,
    });
    expect(userRead.fields.find((field) => field.key === 'required')).toMatchObject({
      valueState: 'default', effectiveValue: null, sourceLayer: null,
    });
    expect(page.groups.flatMap((group) => group.fields)
      .find((field) => field.key === 'required')).toMatchObject({
      displayValue: '未设置', configured: false, sourceLabel: '未设置',
    });
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
    })).rejects.toThrow('configSchemaUnavailable');
    expect((await readPluginConfigStore({
      pluginName: 'legacy-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    })).values).toEqual({ known: 'old' });
  });
});
