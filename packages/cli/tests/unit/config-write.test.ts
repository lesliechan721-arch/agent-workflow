import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  visible: new Set<string>(),
  states: new Map<string, 'present' | 'partial' | 'absent' | 'error'>(),
  status: vi.fn(),
  configVisibility: vi.fn(async () => ({ state: 'visible' as const })),
}));

vi.mock('../../src/commands/status-v6.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/commands/status-v6.js')>(),
  statusCommandV7: mocks.status,
}));

vi.mock('../../src/utils/project-boundary.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/utils/project-boundary.js')>(),
  assertProjectSharedConfigPathVisible: mocks.configVisibility,
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
  replayConfigRuntimeWrites,
  resetPluginConfigWithHelper,
} from '../../src/utils/plugin-config-write.js';
import {
  readPluginConfigStore,
  resetPluginConfigStore,
  resolveConfigRead,
  resolveEffectivePluginConfig,
  resolvePluginConfigStorePath,
  setAtomicConfigBeforeRenameHookForTests,
  setAtomicConfigAfterRenameHookForTests,
  toCliConfigPromptSchema,
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
        presetCertificate: {
          type: 'string',
          choices: {
            allowCustom: true,
            presets: [{ id: 'nested', title: 'Nested certificate', value: './preset-file' }],
          },
        },
        locations: {
          type: 'object',
          properties: {
            certificate: { type: 'string' },
            workspace: { type: 'string' },
          },
          additionalProperties: false,
        },
        genericPath: { type: 'string' },
      },
    },
    ...(options.codexProjectManaged === false ? {} : { skills: './skills' }),
    ...(options.dynamicTarget
      ? {
          artifacts: {
            targets: [
              {
                id: 'dynamic-instruction',
                platform: 'codex',
                target: 'codex.developerInstructionsBlock',
                kind: 'instruction',
                scopes: ['user', 'project'],
                states: ['present'],
                refreshKeys: [
                  'token', 'mode', 'workspace', 'certificate',
                  'presetCertificate', 'locations', 'genericPath',
                ],
                requiresCodexProjectConfig: true,
              },
              {
                id: 'dynamic-claude-skill',
                platform: 'claude',
                target: 'claude.skill',
                kind: 'skill',
                scopes: ['user', 'project'],
                states: ['present'],
                refreshKeys: ['mode'],
                skillKey: 'dynamic-claude-skill',
              },
            ],
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

function createPreApplyAuthorizationMock(unavailable = false) {
  return vi.fn(async (pluginNames, rawOptions, runtime: RebuildCommandRuntime) => {
    const target: ReceiptTargetIdentity = {
      pluginName: pluginNames[0]!,
      platform: rawOptions.platform as PlatformName,
      scope: rawOptions.scope as Scope,
    };
    const result = rebuildResult(target, unavailable ? 'failed' : 'succeeded');
    if (runtime.resolvePreApplyAuthorization && !unavailable) {
      result.preApplyAuthorization = [{
        pluginId: 'fixture/dependency',
        pluginName: 'dependency',
        sourceId: 'fixture',
        sourceIdentity: 'identity:fixture',
        platform: target.platform,
        scope: target.scope,
        relation: 'direct',
      }];
    }
    return result;
  });
}

beforeEach(() => {
  mocks.visible.clear();
  mocks.states.clear();
  mocks.configVisibility.mockReset();
  mocks.configVisibility.mockResolvedValue({ state: 'visible' });
  mocks.status.mockImplementation(async (options: { scope?: Scope }) => ({
    payload: {
      targets: [...mocks.visible].flatMap((key) => {
        const [platform, scope] = key.split(':') as [PlatformName, Scope];
        if (options.scope && options.scope !== scope) return [];
        const ownership = mocks.states.get(key) ?? 'present';
        return [{
          pluginName: 'configurable-plugin',
          pluginId: 'configurable-plugin',
          sourceId: 'fixture',
          sourceIdentity: 'identity:fixture',
          platform,
          scope,
          cwd: '/workspace',
          state: ownership === 'present' ? 'ready'
            : ownership === 'partial' ? 'needsSync'
              : ownership === 'error' ? 'blocked' : 'absent',
          components: [
            { kind: 'intent', key: 'desired', state: 'desired',
              metadata: { enabled: true, scopes: [scope], relation: 'root' } },
            { kind: 'ownership', key: 'fixture', state: ownership },
          ],
          reasons: [],
          recoveryActions: [],
        }];
      }),
    },
  }));
});

afterEach(async () => {
  setAtomicConfigBeforeRenameHookForTests(undefined);
  setAtomicConfigAfterRenameHookForTests(undefined);
  vi.clearAllMocks();
  while (tempDirs.length > 0) await fs.remove(tempDirs.pop()!);
});

describe('config write full reinstall apply', () => {
  it('keeps closed boolean choices in the legacy prompt enum projection', () => {
    expect(toCliConfigPromptSchema({
      enabled: {
        type: 'boolean',
        choices: {
          allowCustom: false,
          presets: [{ id: 'on', title: 'Only on', value: true, recommended: true }],
        },
      },
      open: {
        type: 'boolean',
        choices: {
          allowCustom: true,
          presets: [{ id: 'on', title: 'On preset', value: true }],
        },
      },
    })).toMatchObject({
      enabled: { type: 'boolean', enum: [true] },
      open: { type: 'boolean', enum: [true, false] },
    });
  });

  it.each(['__proto__', 'constructor', 'prototype'])(
    'preserves a top-level %s own key without applying an absent target',
    async (dangerousKey) => {
      const fixture = await createFixture();
      const sourceIdentity = `sha256:${'d'.repeat(64)}`;
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
      await fs.outputFile(filePath, `${JSON.stringify({
        schemaVersion: 4,
        sourceId: storeOptions.sourceId,
        binding: { kind: 'source', sourceIdentity },
        pluginName: storeOptions.pluginName,
        values: Object.fromEntries([[dangerousKey, 'preserved']]),
      })}\n`);

      const store = await readPluginConfigStore(storeOptions);
      expect(store.state).toBe('ready');
      expect(Object.hasOwn(store.values, dangerousKey)).toBe(true);
      expect(store.values[dangerousKey]).toBe('preserved');

      const effective = await resolveEffectivePluginConfig({
        sourceId: storeOptions.sourceId,
        sourceIdentity,
        pluginName: storeOptions.pluginName,
        manifest: fixture.plugin.manifest,
        targetScope: 'user',
        cwd: fixture.cwd,
        env: fixture.env,
      });
      expect(effective.issues).toContainEqual(expect.objectContaining({
        type: 'invalid-config',
        code: 'dangerousKey',
        key: dangerousKey,
        source: 'user',
      }));
      expect(effective.ignoredUnknownKeys).not.toContainEqual(
        expect.objectContaining({ key: dangerousKey }),
      );

      const reinstall = createReinstallMock();
      const receipt = await applyPluginConfigWrite({
        plugin: fixture.plugin,
        scope: 'user',
        cwd: fixture.cwd,
        env: fixture.env,
        request: { updates: { token: 'saved' } },
        reinstallCommandImpl: reinstall,
      });

      expect(receipt).toMatchObject({
        configWrite: 'succeeded',
        overallState: 'succeeded',
        apply: { state: 'skipped', reason: 'noVisibleTarget', targetResults: [] },
      });
      const patchedStore = await readPluginConfigStore(storeOptions);
      expect(Object.hasOwn(patchedStore.values, dangerousKey)).toBe(true);
      expect(patchedStore.values[dangerousKey]).toBe('preserved');
      expect(reinstall).not.toHaveBeenCalled();
    },
  );

  it('repairs one field while preserving another invalid field and skips apply', async () => {
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
      schemaVersion: 4,
      sourceId: storeOptions.sourceId,
      binding: { kind: 'source', sourceIdentity },
      pluginName: storeOptions.pluginName,
      values: { mode: 42 },
    }, { spaces: 2 });
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { token: 'new-secret' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'noVisibleTarget', targetResults: [] },
      updatedKeys: ['token'],
      effective: {
        fieldStates: {
          mode: {
            invalidOverride: { source: 'user' },
            fallback: { source: 'default', value: 'safe' },
          },
        },
      },
    });
    expect((await readPluginConfigStore(storeOptions)).values).toEqual({
      mode: 42,
      token: 'new-secret',
    });
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('treats a semantic object key reorder as a no-op without rewriting or applying', async () => {
    const fixture = await createFixture();
    const storeOptions = {
      pluginName: fixture.plugin.manifest.name,
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    await writePluginConfigStore({
      ...storeOptions,
      values: { locations: { workspace: 'workspace', certificate: 'certificate' } },
    });
    const filePath = resolvePluginConfigStorePath(storeOptions);
    const before = await fs.readFile(filePath);
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { locations: { certificate: 'certificate', workspace: 'workspace' } } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt).toMatchObject({
      overallState: 'succeeded',
      updatedKeys: [],
      removedKeys: [],
      apply: { state: 'skipped', reason: 'noConfigChange', targetResults: [] },
    });
    expect(await fs.readFile(filePath)).toEqual(before);
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('applies when a same-value set changes the renderer source from default to user', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
    mocks.visible.add('codex:user');
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'safe' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt).toMatchObject({
      updatedKeys: ['mode'],
      apply: { state: 'succeeded' },
    });
    expect(reinstall).toHaveBeenCalledOnce();
  });

  it('does not apply a user change hidden by the visible project override', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
    fixture.plugin.manifest.artifacts!.targets![0]!.scopes = ['user', 'project'];
    mocks.visible.add('codex:project');
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 'fast' },
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

    expect(receipt).toMatchObject({
      updatedKeys: ['mode'],
      apply: { state: 'skipped', reason: 'noEffectiveConfigChange' },
      otherProjectsMayRequireSync: true,
    });
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('applies a project unset that falls back to the manifest default', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
    fixture.plugin.manifest.artifacts!.targets![0]!.scopes = ['user', 'project'];
    mocks.visible.add('codex:project');
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 'fast' },
    });
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { removeKeys: ['mode'] },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt).toMatchObject({
      removedKeys: ['mode'],
      apply: { state: 'succeeded' },
    });
    expect(reinstall).toHaveBeenCalledOnce();
  });

  it('does not apply when an unchanged invalid renderer projection receives an unrelated update', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
    fixture.plugin.manifest.artifacts!.targets![0]!.refreshKeys = ['mode'];
    mocks.visible.add('codex:user');
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 42 },
    });
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { token: 'saved' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'noEffectiveConfigChange' },
      effective: { issues: [expect.objectContaining({ key: 'mode' })] },
    });
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('does not apply when an unrelated invalid issue is repaired', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
    fixture.plugin.manifest.artifacts!.targets![0]!.refreshKeys = ['mode'];
    mocks.visible.add('codex:user');
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 'fast', locations: { unknown: 'invalid' } },
    });
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { locations: { workspace: 'repaired' } } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'noEffectiveConfigChange' },
      effective: { issues: [] },
    });
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('commits an unset that leaves a required field missing and skips apply', async () => {
    const fixture = await createFixture();
    fixture.plugin.manifest.config!.fields.token!.required = true;
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { token: 'configured' },
    });
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { removeKeys: ['token'] },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      removedKeys: ['token'],
      apply: { state: 'skipped', reason: 'noVisibleTarget', targetResults: [] },
      effective: {
        issues: [expect.objectContaining({ type: 'missing-required', key: 'token' })],
      },
    });
    await expect(fs.pathExists(resolvePluginConfigStorePath({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    }))).resolves.toBe(false);
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('writes and resets user config when the project store is invalid', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
    mocks.visible.add('codex:user');
    await fs.outputFile(resolvePluginConfigStorePath({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
    }), '{invalid');
    const reinstall = createReinstallMock();

    const set = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    });

    expect(set).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      effective: {
        values: { mode: 'fast' },
        sources: { mode: 'user' },
        issues: [],
      },
    });

    const reset = await resetPluginConfigWithHelper({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      reinstallCommandImpl: reinstall,
    });

    expect(reset).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      deleted: true,
      removedKeys: ['mode'],
      effective: {
        values: { mode: 'safe' },
        sources: { mode: 'default' },
        issues: [],
      },
    });
    expect(reinstall).toHaveBeenCalledTimes(2);
    expect(reinstall.mock.calls.map((call) => call[1].scope)).toEqual(['user', 'user']);
  });

  it.each(['set', 'unset'] as const)(
    'does not mutate project config when the inherited user store is invalid during %s',
    async (action) => {
      const fixture = await createFixture();
      const projectPath = resolvePluginConfigStorePath({
        pluginName: fixture.plugin.manifest.name,
        scope: 'project',
        cwd: fixture.cwd,
        env: fixture.env,
      });
      await writePluginConfigStore({
        pluginName: fixture.plugin.manifest.name,
        scope: 'project',
        cwd: fixture.cwd,
        env: fixture.env,
        values: { mode: 'safe' },
      });
      await fs.outputFile(resolvePluginConfigStorePath({
        pluginName: fixture.plugin.manifest.name,
        scope: 'user',
        cwd: fixture.cwd,
        env: fixture.env,
      }), '{invalid');
      const before = await fs.readFile(projectPath);
      const reinstall = createReinstallMock();

      const write = action === 'reset'
        ? resetPluginConfigWithHelper({
            pluginName: fixture.plugin.manifest.name,
            plugin: fixture.plugin,
            scope: 'project',
            cwd: fixture.cwd,
            env: fixture.env,
            reinstallCommandImpl: reinstall,
          })
        : applyPluginConfigWrite({
            plugin: fixture.plugin,
            scope: 'project',
            cwd: fixture.cwd,
            env: fixture.env,
            request: action === 'set'
              ? { updates: { mode: 'fast' } }
              : { removeKeys: ['mode'] },
            reinstallCommandImpl: reinstall,
          });

      await expect(write).rejects.toThrow('invalidJson');
      await expect(fs.readFile(projectPath)).resolves.toEqual(before);
      await expect(fs.pathExists(projectPath)).resolves.toBe(true);
      expect(reinstall).not.toHaveBeenCalled();
    },
  );

  it('resets project config even when the inherited user store is invalid', async () => {
    const fixture = await createFixture();
    const projectPath = resolvePluginConfigStorePath({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
    });
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 'safe' },
    });
    await fs.outputFile(resolvePluginConfigStorePath({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    }), '{invalid');
    mocks.configVisibility.mockClear();

    await expect(resetPluginConfigWithHelper({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      apply: false,
    })).resolves.toMatchObject({
      deleted: true,
      resetDisposition: 'deletedFile',
    });
    await expect(fs.pathExists(projectPath)).resolves.toBe(false);
    expect(mocks.configVisibility).not.toHaveBeenCalled();
  });

  it('resets an invalid project store after the inherited user store is ready', async () => {
    const fixture = await createFixture();
    const projectPath = resolvePluginConfigStorePath({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
    });
    await fs.outputFile(projectPath, '{invalid');

    const receipt = await resetPluginConfigWithHelper({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      reinstallCommandImpl: createReinstallMock(),
    });

    expect(receipt).toMatchObject({ deleted: true, configWrite: 'succeeded' });
    await expect(fs.pathExists(projectPath)).resolves.toBe(false);
  });

  it('conservatively applies a readable target after resetting an invalid store', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
    const userPath = resolvePluginConfigStorePath({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    });
    await fs.outputFile(userPath, '{invalid');
    mocks.visible.add('codex:user');
    const reinstall = createReinstallMock();

    const receipt = await resetPluginConfigWithHelper({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      reinstallCommandImpl: reinstall,
    });

    expect(receipt).toMatchObject({
      deleted: true,
      configWrite: 'succeeded',
      apply: { state: 'succeeded' },
    });
    expect(reinstall).toHaveBeenCalledOnce();
    await expect(fs.pathExists(userPath)).resolves.toBe(false);
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

    const projectRead = await resolveConfigRead({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
    });
    expect(projectRead.fields).toContainEqual(expect.objectContaining({
      key: 'token',
      writable: false,
      canSet: false,
    }));
  });

  it('keeps submitted strings literal without a filesystem path contract', async () => {
    const fixture = await createFixture();
    const nestedCwd = path.join(fixture.cwd, 'nested');
    await fs.ensureDir(nestedCwd);

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: nestedCwd,
      env: fixture.env,
      request: {
        updates: {
          workspace: './same-directory',
          certificate: './same-file',
          presetCertificate: './preset-file',
          locations: { certificate: './same-file' },
          genericPath: './not-yet-created',
        },
      },
      reinstallCommandImpl: createReinstallMock(),
    });
    const store = await readPluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    });

    expect(store.values).toMatchObject({
      workspace: './same-directory',
      certificate: './same-file',
      presetCertificate: './preset-file',
      locations: { certificate: './same-file' },
      genericPath: './not-yet-created',
    });
    expect(JSON.stringify(receipt)).toContain('./same-file');
  });

  it('passes the active progress reporter into config-triggered reinstall', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
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

  it.each(['set', 'unset', 'reset'] as const)(
    'requires explicit preApply authorization before %s runtime writes',
    async (action) => {
      const fixture = await createFixture();
      fixture.plugin.manifest.dependencies = ['dependency'];
      const storeOptions = {
        pluginName: fixture.plugin.manifest.name,
        scope: 'user' as const,
        cwd: fixture.cwd,
        env: fixture.env,
      };
      if (action === 'unset' || action === 'reset') {
        await writePluginConfigStore({ ...storeOptions, values: { mode: 'fast' } });
      }
      const reinstall = createPreApplyAuthorizationMock();
      const applyTargets: ReceiptTargetIdentity[] = [{
        pluginName: fixture.plugin.manifest.name,
        platform: 'codex',
        scope: 'user',
      }];
      const operation = action === 'reset'
        ? resetPluginConfigWithHelper({
            ...storeOptions,
            plugin: fixture.plugin,
            applyTargets,
            reinstallCommandImpl: reinstall,
          })
        : applyPluginConfigWrite({
              ...storeOptions,
              plugin: fixture.plugin,
              applyTargets,
              request: action === 'set'
                ? { updates: { mode: 'fast' } }
                : { removeKeys: ['mode'] },
              reinstallCommandImpl: reinstall,
            });

      await expect(operation).rejects.toMatchObject({ code: 'preApplyAuthorizationRequired' });
      expect(reinstall).toHaveBeenCalledOnce();
      expect(reinstall.mock.calls[0]![2]).toMatchObject({ resolvePreApplyAuthorization: true });
      expect((await readPluginConfigStore(storeOptions)).values).toEqual(
        action === 'unset' || action === 'reset' ? { mode: 'fast' } : {},
      );
    },
  );

  it('preserves the saved-config fact when replay lacks preApply authorization', async () => {
    const fixture = await createFixture();
    fixture.plugin.manifest.dependencies = ['dependency'];
    const reinstall = createPreApplyAuthorizationMock();
    const receipt = await replayConfigRuntimeWrites({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      applyTargets: [{
        pluginName: fixture.plugin.manifest.name,
        platform: 'codex',
        scope: 'user',
      }],
      reinstallCommandImpl: reinstall,
    });

    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'partial',
      apply: {
        state: 'partial',
        targetResults: [expect.objectContaining({
          errorCode: 'preApplyAuthorizationRequired',
          state: 'failed',
        })],
      },
    });
    expect(reinstall).toHaveBeenCalledOnce();
  });

  it('applies healthy targets when another preApply authorization scope is unavailable', async () => {
    const fixture = await createFixture();
    fixture.plugin.manifest.dependencies = ['dependency'];
    const reinstall = vi.fn(async (
      pluginNames: string[],
      rawOptions: { platform: PlatformName | 'both'; scope: Scope },
      runtime: RebuildCommandRuntime,
    ) => {
      const target: ReceiptTargetIdentity = {
        pluginName: pluginNames[0]!,
        platform: rawOptions.platform === 'both' ? 'codex' : rawOptions.platform,
        scope: rawOptions.scope,
      };
      if (runtime.resolvePreApplyAuthorization) {
        const result = rebuildResult(target, rawOptions.platform === 'claude'
          || rawOptions.platform === 'both' ? 'failed' : 'succeeded');
        if (rawOptions.platform === 'codex') {
          result.preApplyAuthorization = [{
            pluginId: 'fixture/dependency',
            pluginName: 'dependency',
            sourceId: 'fixture',
            sourceIdentity: 'identity:fixture',
            platform: 'codex',
            scope: rawOptions.scope,
            relation: 'direct',
          }];
        }
        return result;
      }
      return rebuildResult(target, 'succeeded');
    });

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      applyTargets: [
        { pluginName: fixture.plugin.manifest.name, platform: 'codex', scope: 'user' },
        { pluginName: fixture.plugin.manifest.name, platform: 'claude', scope: 'user' },
      ],
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
      preApplyConfirmed: true,
    });

    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'partial',
      apply: {
        state: 'partial',
        targetResults: expect.arrayContaining([
          expect.objectContaining({
            target: expect.objectContaining({ platform: 'codex' }),
            state: 'completed',
          }),
          expect.objectContaining({
            target: expect.objectContaining({ platform: 'claude' }),
            errorCode: 'sourceUnavailable',
          }),
        ]),
      },
    });
    expect(reinstall.mock.calls.map((call) => call[1].platform))
      .toEqual(['both', 'codex', 'claude', 'codex']);
  });

  it('does not treat an empty reviewed preApply scope as general authorization', async () => {
    const fixture = await createFixture();
    fixture.plugin.manifest.dependencies = ['dependency'];
    const reinstall = createPreApplyAuthorizationMock();

    await expect(applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      applyTargets: [{
        pluginName: fixture.plugin.manifest.name,
        platform: 'codex',
        scope: 'user',
      }],
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
      preApplyConfirmed: true,
      preApplyAuthorizedTargets: [],
    })).rejects.toMatchObject({ code: 'preApplyAuthorizationRequired' });
    expect((await readPluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    })).exists).toBe(false);
  });

  it.each(['set', 'reset', 'replay'] as const)(
    'keeps config state and returns typed unavailable when %s authorization scope is unknown',
    async (action) => {
      const fixture = await createFixture();
      fixture.plugin.manifest.dependencies = ['dependency'];
      const storeOptions = {
        pluginName: fixture.plugin.manifest.name,
        scope: 'user' as const,
        cwd: fixture.cwd,
        env: fixture.env,
      };
      if (action === 'reset') {
        await writePluginConfigStore({ ...storeOptions, values: { mode: 'fast' } });
      }
      const reinstall = createPreApplyAuthorizationMock(true);
      const applyTargets: ReceiptTargetIdentity[] = [{
        pluginName: fixture.plugin.manifest.name,
        platform: 'codex',
        scope: 'user',
      }];
      const receipt = action === 'reset'
        ? await resetPluginConfigWithHelper({
            ...storeOptions,
            plugin: fixture.plugin,
            applyTargets,
            reinstallCommandImpl: reinstall,
          })
        : action === 'replay'
          ? await replayConfigRuntimeWrites({
              ...storeOptions,
              plugin: fixture.plugin,
              applyTargets,
              reinstallCommandImpl: reinstall,
            })
          : await applyPluginConfigWrite({
              ...storeOptions,
              plugin: fixture.plugin,
              applyTargets,
              request: { updates: { mode: 'fast' } },
              reinstallCommandImpl: reinstall,
            });

      expect(receipt).toMatchObject({
        configWrite: 'succeeded',
        overallState: 'partial',
        apply: { state: 'unavailable', reason: 'sourceUnavailable' },
      });
      expect(reinstall).toHaveBeenCalledOnce();
      expect(reinstall.mock.calls[0]![2]).toMatchObject({ resolvePreApplyAuthorization: true });
      if (action === 'set') {
        expect((await readPluginConfigStore(storeOptions)).values).toEqual({ mode: 'fast' });
      }
      if (action === 'reset') {
        expect((await readPluginConfigStore(storeOptions)).exists).toBe(false);
      }
    },
  );

  it('rejects a sensitive project update in the writer before creating the project store', async () => {
    const fixture = await createFixture();
    const secret = 'project-secret-must-not-be-written';

    const error = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { token: secret } },
      apply: false,
    }).catch((failure: unknown) => failure as Error & { code?: string });

    expect(error.code).toBe('sensitiveProjectConfigUnsupported');
    expect(error.message).not.toContain(secret);
    expect((await readPluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
    })).exists).toBe(false);
  });

  it('fails closed before config or platform mutation when shared native confirmation is omitted', async () => {
    const fixture = await createFixture();
    fixture.plugin.manifest.artifacts = {
      targets: [{
        id: 'native-skill',
        platform: 'codex',
        target: 'codex.skill',
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        scopes: ['user'],
        states: ['present'],
        refreshKeys: ['mode'],
        skillKey: 'native-skill',
      }],
    };
    const reinstall = createReinstallMock();

    await expect(applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      applyTargets: [{
        pluginName: fixture.plugin.manifest.name,
        platform: 'codex',
        scope: 'user',
      }],
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    })).rejects.toMatchObject({ code: 'sharedNativeConfigApplyConfirmationRequired' });

    expect(reinstall).not.toHaveBeenCalled();
    expect((await readPluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    })).exists).toBe(false);
  });

  it.each([undefined, false])(
    'fails closed before reset or platform mutation when shared native confirmation is %s',
    async (sharedNativeApplyConfirmed) => {
      const fixture = await createFixture();
      fixture.plugin.manifest.artifacts = {
        targets: [{
          id: 'native-skill',
          platform: 'codex',
          target: 'codex.skill',
          delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
          scopes: ['user'],
          states: ['present'],
          refreshKeys: ['mode'],
          skillKey: 'native-skill',
        }],
      };
      await writePluginConfigStore({
        pluginName: fixture.plugin.manifest.name,
        scope: 'user',
        cwd: fixture.cwd,
        env: fixture.env,
        values: { mode: 'fast' },
      });
      const reinstall = createReinstallMock();

      await expect(resetPluginConfigWithHelper({
        pluginName: fixture.plugin.manifest.name,
        plugin: fixture.plugin,
        scope: 'user',
        cwd: fixture.cwd,
        env: fixture.env,
        applyTargets: [{
          pluginName: fixture.plugin.manifest.name,
          platform: 'codex',
          scope: 'user',
        }],
        reinstallCommandImpl: reinstall,
        sharedNativeApplyConfirmed,
      })).rejects.toMatchObject({ code: 'sharedNativeConfigApplyConfirmationRequired' });

      expect((await readPluginConfigStore({
        pluginName: fixture.plugin.manifest.name,
        scope: 'user',
        cwd: fixture.cwd,
        env: fixture.env,
      })).values).toEqual({ mode: 'fast' });
      expect(reinstall).not.toHaveBeenCalled();
    },
  );

  it('allows a confirmed shared native reset and does not require confirmation without apply', async () => {
    const fixture = await createFixture();
    fixture.plugin.manifest.artifacts = {
      targets: [{
        id: 'native-skill',
        platform: 'codex',
        target: 'codex.skill',
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        scopes: ['user'],
        states: ['present'],
        refreshKeys: ['mode'],
        skillKey: 'native-skill',
      }],
    };
    const store = {
      pluginName: fixture.plugin.manifest.name,
      scope: 'user' as const,
      cwd: fixture.cwd,
      env: fixture.env,
    };
    const target = [{
      pluginName: fixture.plugin.manifest.name,
      platform: 'codex' as const,
      scope: 'user' as const,
    }];
    await writePluginConfigStore({ ...store, values: { mode: 'fast' } });
    const reinstall = createReinstallMock();

    await expect(resetPluginConfigWithHelper({
      ...store,
      plugin: fixture.plugin,
      applyTargets: target,
      reinstallCommandImpl: reinstall,
      sharedNativeApplyConfirmed: true,
    })).resolves.toMatchObject({
      deleted: true,
      overallState: 'succeeded',
      apply: { state: 'succeeded' },
    });
    expect(reinstall).toHaveBeenCalledOnce();

    await writePluginConfigStore({ ...store, values: { mode: 'fast' } });
    await expect(resetPluginConfigWithHelper({
      ...store,
      plugin: fixture.plugin,
      apply: false,
    })).resolves.toMatchObject({
      deleted: true,
      apply: { state: 'skipped', reason: 'notRequested' },
    });
  });

  it('does not require shared native confirmation when reset removes only unrelated keys', async () => {
    const fixture = await createFixture();
    fixture.plugin.manifest.artifacts = {
      targets: [{
        id: 'native-skill',
        platform: 'codex',
        target: 'codex.skill',
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        scopes: ['user'],
        states: ['present'],
        refreshKeys: ['mode'],
        skillKey: 'native-skill',
      }],
    };
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { token: 'unrelated' },
    });
    const reinstall = createReinstallMock();

    await expect(resetPluginConfigWithHelper({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      applyTargets: [{
        pluginName: fixture.plugin.manifest.name,
        platform: 'codex',
        scope: 'user',
      }],
      reinstallCommandImpl: reinstall,
    })).resolves.toMatchObject({
      deleted: true,
      overallState: 'succeeded',
      apply: { state: 'skipped', reason: 'noEffectiveConfigChange' },
    });
    expect(reinstall).not.toHaveBeenCalled();
  });

  it.each([undefined, false])(
    'fails closed before replay platform mutation when shared native confirmation is %s',
    async (sharedNativeApplyConfirmed) => {
      const fixture = await createFixture();
      fixture.plugin.manifest.artifacts = {
        targets: [{
          id: 'native-skill',
          platform: 'codex',
          target: 'codex.skill',
          delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
          scopes: ['user'],
          states: ['present'],
          refreshKeys: ['mode'],
          skillKey: 'native-skill',
        }],
      };
      const reinstall = createReinstallMock();

      await expect(replayConfigRuntimeWrites({
        plugin: fixture.plugin,
        scope: 'user',
        cwd: fixture.cwd,
        env: fixture.env,
        applyTargets: [{
          pluginName: fixture.plugin.manifest.name,
          platform: 'codex',
          scope: 'user',
        }],
        reinstallCommandImpl: reinstall,
        sharedNativeApplyConfirmed,
      })).rejects.toMatchObject({ code: 'sharedNativeConfigApplyConfirmationRequired' });
      expect(reinstall).not.toHaveBeenCalled();
    },
  );

  it('requires shared native confirmation when another replay target has invalid config', async () => {
    const fixture = await createFixture();
    fixture.plugin.manifest.artifacts = {
      targets: [{
        id: 'native-skill',
        platform: 'codex',
        target: 'codex.skill',
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        scopes: ['user'],
        states: ['present'],
        refreshKeys: ['mode'],
        skillKey: 'native-skill',
      }],
    };
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 42 },
    });
    const reinstall = createReinstallMock();

    await expect(replayConfigRuntimeWrites({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      applyTargets: [{
        pluginName: fixture.plugin.manifest.name,
        platform: 'codex',
        scope: 'user',
      }, {
        pluginName: fixture.plugin.manifest.name,
        platform: 'claude',
        scope: 'project',
      }],
      reinstallCommandImpl: reinstall,
    })).rejects.toMatchObject({ code: 'sharedNativeConfigApplyConfirmationRequired' });
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('allows a confirmed shared native replay', async () => {
    const fixture = await createFixture();
    fixture.plugin.manifest.artifacts = {
      targets: [{
        id: 'native-skill',
        platform: 'codex',
        target: 'codex.skill',
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        scopes: ['user'],
        states: ['present'],
        refreshKeys: ['mode'],
        skillKey: 'native-skill',
      }],
    };
    const reinstall = createReinstallMock();

    await expect(replayConfigRuntimeWrites({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      applyTargets: [{
        pluginName: fixture.plugin.manifest.name,
        platform: 'codex',
        scope: 'user',
      }],
      reinstallCommandImpl: reinstall,
      sharedNativeApplyConfirmed: true,
    })).resolves.toMatchObject({ overallState: 'succeeded' });
    expect(reinstall).toHaveBeenCalledOnce();
  });

  it('allows project unset to remove a legacy native refresh-key override', async () => {
    const fixture = await createFixture();
    fixture.plugin.manifest.artifacts = {
      targets: [{
        id: 'native-skill',
        platform: 'codex',
        target: 'codex.skill',
        delivery: { mode: 'codex-native', identity: 'shared', renderProfile: 'user' },
        scopes: ['user'],
        states: ['present'],
        refreshKeys: ['mode'],
        skillKey: 'native-skill',
      }],
    };
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user', cwd: fixture.cwd, env: fixture.env,
      values: { mode: 'fast' },
    });
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project', cwd: fixture.cwd, env: fixture.env,
      values: { mode: 'safe' },
    });
    mocks.visible.add('codex:project');
    const reinstall = createReinstallMock();

    await expect(applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { removeKeys: ['mode'] },
      reinstallCommandImpl: reinstall,
    })).resolves.toMatchObject({
      removedKeys: ['mode'],
      configWrite: 'succeeded',
      apply: { state: 'skipped', reason: 'noEffectiveConfigChange' },
    });

    expect((await readPluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project', cwd: fixture.cwd, env: fixture.env,
    })).exists).toBe(false);
    expect((await resolveEffectivePluginConfig({
      pluginName: fixture.plugin.manifest.name,
      manifest: fixture.plugin.manifest,
      targetScope: 'project', cwd: fixture.cwd, env: fixture.env,
    })).values.mode).toBe('fast');
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('reinstalls both user and current-project targets on both platforms after a user write', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
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
    expect(receipt.apply.targetResults).toHaveLength(4);
    expect(reinstall).toHaveBeenCalledTimes(4);
    expect(reinstall.mock.calls.every((call) => call[1].cwd === fixture.cwd)).toBe(true);
    expect(reinstall.mock.calls.every((call) =>
      !Object.hasOwn(call[1], 'catalogChannel') && !Object.hasOwn(call[1], 'catalogVersion'))).toBe(true);
    expect(receipt.otherProjectsMayRequireSync).toBe(true);
    expect(receipt.warnings.join('\n')).toContain('其它项目');
  });

  it('skips every sync when a visible project target has invalid project config', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
    mocks.visible.add('codex:user');
    mocks.visible.add('codex:project');
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 42 },
    });
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { token: 'saved' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'partial',
      apply: {
        state: 'partial',
        targetResults: expect.arrayContaining([
          expect.objectContaining({ state: 'completed', target: expect.objectContaining({ scope: 'user' }) }),
          expect.objectContaining({ state: 'skipped', errorCode: 'invalidConfig' }),
        ]),
      },
    });
    expect(reinstall).toHaveBeenCalledOnce();
  });

  it('does not let invalid project config block a user write with only a user target', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
    mocks.visible.add('codex:user');
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 42 },
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
    expect(receipt.apply.state).toBe('succeeded');
    expect(reinstall).toHaveBeenCalledOnce();
    expect(reinstall.mock.calls[0]?.[1].scope).toBe('user');
  });

  it('does not apply a project target whose invalid override is unchanged by user reset', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
    mocks.visible.add('codex:user');
    mocks.visible.add('codex:project');
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 'fast' },
    });
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 42 },
    });
    const reinstall = createReinstallMock();

    const receipt = await resetPluginConfigWithHelper({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      reinstallCommandImpl: reinstall,
    });

    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      apply: {
        state: 'succeeded',
        targetResults: [
          expect.objectContaining({ state: 'completed', target: expect.objectContaining({ scope: 'user' }) }),
        ],
      },
      deleted: true,
    });
    expect(reinstall).toHaveBeenCalledOnce();
  });

  it('does not apply expanded pure-native scopes without a config consumer', async () => {
    const fixture = await createFixture();
    mocks.status.mockResolvedValueOnce({
      payload: {
        targets: [{
          pluginName: fixture.plugin.manifest.name,
          pluginId: fixture.plugin.manifest.name,
          sourceId: 'fixture',
          sourceIdentity: 'identity:fixture',
          platform: 'codex',
          scope: 'user',
          cwd: fixture.cwd,
          state: 'ready',
          components: [{
            kind: 'intent', key: 'desired', state: 'desired',
            metadata: { enabled: true, scopes: ['project', 'user'], relation: 'root' },
          }],
          reasons: [],
          recoveryActions: [],
        }],
      },
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

    expect(receipt.apply).toEqual({
      state: 'skipped', reason: 'noEffectiveConfigChange', targetResults: [],
    });
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('preserves a failed dependency and skipped root from the normal reinstall receipt', async () => {
    const fixture = await createFixture('root', { dynamicTarget: true });
    fixture.plugin.sourceId = 'team';
    fixture.plugin.sourceIdentity = `sha256:${'1'.repeat(64)}`;
    fixture.plugin.catalogLogicalIdentity = 'catalog.example/team';
    fixture.plugin.pluginId = 'team/root';
    fixture.plugin.marketplaceName = 'aw-team';
    const rootTarget: ReceiptTargetIdentity = {
      sourceId: 'team',
      sourceIdentity: fixture.plugin.sourceIdentity,
      logicalIdentity: fixture.plugin.catalogLogicalIdentity,
      pluginId: 'team/root',
      pluginName: 'root',
      platform: 'codex',
      scope: 'project',
      projectKey: fixture.cwd,
    };
    const leafTarget: ReceiptTargetIdentity = {
      ...rootTarget,
      pluginId: 'team/leaf',
      pluginName: 'leaf',
    };
    await writePluginConfigStore({
      sourceId: 'team',
      sourceIdentity: fixture.plugin.sourceIdentity,
      pluginName: 'root',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { token: 'receipt-secret' },
    });
    const reinstall = vi.fn(async (): Promise<RebuildCommandResult> => ({
      ...rebuildResult(rootTarget, 'failed'),
      targetResults: [
        {
          target: leafTarget,
          action: 'reinstall',
          state: 'failed',
          message: `leaf partial at ${fixture.cwd} with receipt-secret`,
        },
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
      overallState: 'partial',
      apply: { state: 'partial', targetResults: [
        expect.objectContaining({ target: expect.objectContaining({ pluginId: 'team/leaf' }), state: 'failed' }),
        expect.objectContaining({
          target: expect.objectContaining({ pluginId: 'team/root' }),
          action: 'skipped',
          state: 'skipped',
          errorCode: 'dependencyInstallFailed',
        }),
      ] },
    });
    const serializedReceipt = JSON.stringify(receipt);
    expect(serializedReceipt).not.toContain('projectKey');
    expect(serializedReceipt).not.toContain(fixture.cwd);
    expect(serializedReceipt).not.toContain('receipt-secret');
    expect((await readPluginConfigStore({
      sourceId: 'team',
      sourceIdentity: fixture.plugin.sourceIdentity,
      logicalIdentity: fixture.plugin.catalogLogicalIdentity,
      pluginName: 'root',
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
    })).values).toEqual({ mode: 'fast' });
  });

  it('limits a project write to current-project targets', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
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

    expect(receipt.apply.targetResults.map((entry) => entry.target.scope)).toEqual(['project', 'project']);
    expect(reinstall.mock.calls.every((call) => call[1].scope === 'project')).toBe(true);
    expect(receipt.otherProjectsMayRequireSync).toBe(false);
  });

  it('writes project config with an unverified shareability warning when Git evidence is unavailable', async () => {
    const fixture = await createFixture();
    Object.assign(fixture.plugin, {
      sourceId: 'official',
      sourceIdentity: `sha256:${'b'.repeat(64)}`,
      catalogLogicalIdentity: 'catalog.example/official',
      pluginId: `official/${fixture.plugin.manifest.name}`,
    });
    mocks.configVisibility.mockResolvedValue({ state: 'unverified' });

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      apply: false,
    });

    expect(receipt.warnings).toContainEqual(expect.stringContaining(
      'projectConfigShareabilityUnverified',
    ));
    await expect(readPluginConfigStore({
      sourceId: fixture.plugin.sourceId,
      sourceIdentity: fixture.plugin.sourceIdentity,
      logicalIdentity: fixture.plugin.catalogLogicalIdentity,
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
    })).resolves.toMatchObject({ state: 'ready', values: { mode: 'fast' } });
  });

  it('fails before the final write when the project path becomes ignored after the lock-free check', async () => {
    const fixture = await createFixture();
    Object.assign(fixture.plugin, {
      sourceId: 'official',
      sourceIdentity: `sha256:${'c'.repeat(64)}`,
      catalogLogicalIdentity: 'catalog.example/official',
      pluginId: `official/${fixture.plugin.manifest.name}`,
    });
    const ignored = Object.assign(new Error('projectConfigIgnored: ignored after Review'), {
      code: 'projectConfigIgnored',
    });
    mocks.configVisibility
      .mockResolvedValueOnce({ state: 'visible' })
      .mockRejectedValueOnce(ignored);
    const filePath = resolvePluginConfigStorePath({
      sourceId: fixture.plugin.sourceId,
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
    });

    await expect(applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      apply: false,
    })).rejects.toMatchObject({ code: 'projectConfigIgnored' });
    await expect(fs.pathExists(filePath)).resolves.toBe(false);
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
    expect(receipt.apply).toEqual({ state: 'skipped', reason: 'noVisibleTarget', targetResults: [] });
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('does not sync an absent static target without a config consumer', async () => {
    const fixture = await createFixture();
    mocks.visible.add('codex:user');
    mocks.states.set('codex:user', 'absent');
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt.apply).toEqual({
      state: 'skipped', reason: 'noEffectiveConfigChange', targetResults: [],
    });
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('applies only the desired Claude target for a Claude-only manifest', async () => {
    const fixture = await createFixture('configurable-plugin', {
      products: ['CLAUDE'], dynamicTarget: true,
    });
    mocks.visible.add('claude:user');
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
    expect(receipt.apply.targetResults.map((entry) => entry.target.platform)).toEqual(['claude']);
  });

  it('applies only the desired Codex target for a Codex-only manifest', async () => {
    const fixture = await createFixture('configurable-plugin', {
      products: ['CODEX'], dynamicTarget: true,
    });
    mocks.visible.add('codex:user');
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
    expect(receipt.apply.targetResults.map((entry) => entry.target.platform)).toEqual(['codex']);
  });

  it('does not apply a user config write to a native-only target without a config consumer', async () => {
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
    expect(receipt.apply).toEqual({
      state: 'skipped', reason: 'noEffectiveConfigChange', targetResults: [],
    });
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('does not apply a project config write to a native-only target without a config consumer', async () => {
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

    expect(receipt.apply).toEqual({
      state: 'skipped', reason: 'noEffectiveConfigChange', targetResults: [],
    });
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('does not apply a current Codex activation without a config consumer', async () => {
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

    expect(mocks.status).toHaveBeenCalledOnce();
    expect(receipt.apply).toEqual({
      state: 'skipped', reason: 'noEffectiveConfigChange', targetResults: [],
    });
    expect(reinstall).not.toHaveBeenCalled();
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

    expect(receipt.apply).toEqual({ state: 'skipped', reason: 'noVisibleTarget', targetResults: [] });
    expect(mocks.status).toHaveBeenCalledOnce();
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('keeps the saved config and completed target when another reinstall target fails', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
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
    expect(receipt.overallState).toBe('partial');
    expect(receipt.apply.targetResults.map((entry) => entry.state).sort()).toEqual(['completed', 'failed']);
    expect(receipt.otherProjectsMayRequireSync).toBe(true);
    expect(stored.values).toEqual({ mode: 'fast' });
    expect(observedModes).toEqual(['fast', 'fast']);
    expect(reinstall).toHaveBeenCalledTimes(2);
  });

  it('keeps the committed store and returns typed partial when the effective reread fails', async () => {
    const fixture = await createFixture();
    fixture.plugin.sourceId = 'official';
    fixture.plugin.sourceIdentity = `sha256:${'a'.repeat(64)}`;
    fixture.plugin.pluginId = 'official/configurable-plugin';
    const storePath = resolvePluginConfigStorePath({
      sourceId: fixture.plugin.sourceId,
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    });
    setAtomicConfigAfterRenameHookForTests(async (targetPath) => {
      if (targetPath !== storePath) return;
      const envelope = await fs.readJson(storePath) as Record<string, unknown>;
      envelope.binding = { kind: 'source', sourceIdentity: `sha256:${'b'.repeat(64)}` };
      await fs.outputJson(storePath, envelope);
    });

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
    });

    expect((await fs.readJson(storePath)).values).toEqual({ mode: 'fast' });
    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'partial',
      apply: {
        state: 'unavailable',
        reason: 'effectiveConfigUnavailable',
        targetResults: [],
        error: {
          stage: 'effectiveConfig',
          code: 'effectiveConfigUnavailable',
        },
      },
      otherProjectsMayRequireSync: true,
    });
  });

  it('marks an atomic config commit failure as configWrite failed', async () => {
    const fixture = await createFixture();
    setAtomicConfigBeforeRenameHookForTests(async () => {
      throw new Error('injected atomic failure');
    });

    const error = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
    }).catch((failure: unknown) => failure as Error & { configWrite?: string });

    expect(error.configWrite).toBe('failed');
    expect((await readPluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    })).exists).toBe(false);
  });

  it('returns typed partial after commit when target discovery fails without exposing the cause', async () => {
    const fixture = await createFixture();
    const secret = 'discovery-secret';
    mocks.status.mockRejectedValueOnce(new Error(`status failed ${fixture.cwd} ${secret}`));

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { mode: 'fast' } },
    });

    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      overallState: 'partial',
      apply: {
        state: 'unavailable',
        reason: 'targetDiscoveryFailed',
        error: { stage: 'targetDiscovery', code: 'targetDiscoveryFailed' },
      },
      otherProjectsMayRequireSync: true,
    });
    expect(JSON.stringify(receipt)).not.toContain(secret);
    expect(JSON.stringify(receipt)).not.toContain(fixture.cwd);
    expect((await readPluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    })).values).toEqual({ mode: 'fast' });
  });

  it('marks every invalid visible target as skipped and makes apply unavailable', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
    mocks.visible.add('codex:user');
    mocks.visible.add('codex:project');
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 42 },
    });
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 42 },
    });
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { token: 'saved' } },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt.apply).toMatchObject({
      state: 'unavailable',
      reason: 'invalidConfig',
      targetResults: [
        expect.objectContaining({ state: 'skipped', errorCode: 'invalidConfig' }),
        expect.objectContaining({ state: 'skipped', errorCode: 'invalidConfig' }),
      ],
    });
    expect(receipt.overallState).toBe('partial');
    expect(receipt.otherProjectsMayRequireSync).toBe(true);
    expect(reinstall).not.toHaveBeenCalled();
  });

  it('serializes a failed runtime apply and a later successful write for one namespaced store', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
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
    expect(firstReceipt).toMatchObject({ configWrite: 'succeeded', overallState: 'partial' });
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
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
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
      overallState: 'partial',
      apply: { state: 'partial', targetResults: [expect.objectContaining({
          state: 'failed',
          message: 'target failed',
        })] },
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
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
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
      overallState: 'partial',
      deleted: true,
      removedKeys: ['mode'],
    });
    expect(stored).toMatchObject({ exists: false, values: {} });
    expect(reinstall).toHaveBeenCalledOnce();
  });

  it('resets a located store without a catalog plugin or schema', async () => {
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
    })).resolves.toMatchObject({ deleted: true, removedKeys: ['secret'] });

    expect(reinstall).not.toHaveBeenCalled();
    expect((await readPluginConfigStore({
      pluginName: 'unknown-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    }))).toMatchObject({ exists: false, values: {} });
  });

  it('keeps reset committed and reports source unavailable when apply cannot resolve the plugin', async () => {
    const fixture = await createFixture('unknown-plugin');
    await writePluginConfigStore({
      pluginName: 'unknown-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { secret: 'must-not-leak' },
    });

    const receipt = await resetPluginConfigWithHelper({
      pluginName: 'unknown-plugin',
      plugin: null,
      pluginError: new Error(`source failed ${fixture.cwd} must-not-leak`),
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      apply: true,
    });

    expect(receipt).toMatchObject({
      deleted: true,
      configWrite: 'succeeded',
      overallState: 'partial',
      apply: {
        state: 'unavailable',
        reason: 'sourceUnavailable',
        error: { stage: 'source', code: 'sourceUnavailable' },
      },
      otherProjectsMayRequireSync: true,
    });
    expect(JSON.stringify(receipt)).not.toContain('must-not-leak');
    expect(await fs.pathExists(resolvePluginConfigStorePath({
      pluginName: 'unknown-plugin',
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    }))).toBe(false);
  });

  it('unsets an existing stale key, preserves other values, and skips apply as unchanged', async () => {
    const fixture = await createFixture();
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { stale: 'old', mode: 'fast' },
    });
    const reinstall = createReinstallMock();

    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { removeKeys: ['stale'] },
      reinstallCommandImpl: reinstall,
    });

    expect(receipt).toMatchObject({
      configWrite: 'succeeded',
      staleRemovedKeys: ['stale'],
      removedKeys: ['stale'],
      apply: { state: 'skipped', reason: 'noEffectiveConfigChange', targetResults: [] },
      otherProjectsMayRequireSync: true,
    });
    expect((await readPluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    })).values).toEqual({ mode: 'fast' });
    expect(reinstall).not.toHaveBeenCalled();

    await expect(applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { removeKeys: ['absent-stale'] },
    })).rejects.toThrow('Unknown config key');
  });

  it('unlinks a final config symlink without changing its target', async () => {
    const fixture = await createFixture('symlink-reset');
    const configPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'symlink-reset', scope: 'user', cwd: fixture.cwd, env: fixture.env,
    });
    const targetPath = path.join(fixture.root, 'symlink-target.json');
    await fs.outputFile(targetPath, 'keep');
    await fs.ensureDir(path.dirname(configPath));
    await fs.symlink(targetPath, configPath);

    await expect(resetPluginConfigStore({
      sourceId: 'team', pluginName: 'symlink-reset', scope: 'user', cwd: fixture.cwd, env: fixture.env,
    })).resolves.toMatchObject({
      existed: true,
      deleted: true,
      resetDisposition: 'unlinkedSymlink',
    });
    await expect(fs.pathExists(configPath)).resolves.toBe(false);
    await expect(fs.readFile(targetPath, 'utf8')).resolves.toBe('keep');
  });

  it('quarantines a final config directory without recursively deleting it', async () => {
    const fixture = await createFixture('directory-reset');
    const configPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'directory-reset', scope: 'user', cwd: fixture.cwd, env: fixture.env,
    });
    await fs.outputFile(path.join(configPath, 'retained.txt'), 'keep');

    const receipt = await resetPluginConfigStore({
      sourceId: 'team', pluginName: 'directory-reset', scope: 'user', cwd: fixture.cwd, env: fixture.env,
    });
    expect(receipt).toMatchObject({
      existed: true,
      deleted: true,
      resetDisposition: 'quarantinedDirectory',
      quarantineBasename: expect.stringMatching(/^config\.broken-.*\.json$/u),
    });
    expect(receipt.quarantineBasename).not.toContain(path.sep);
    await expect(fs.readFile(
      path.join(path.dirname(configPath), receipt.quarantineBasename!, 'retained.txt'),
      'utf8',
    )).resolves.toBe('keep');
  });

  it('is idempotent when the final config target is absent', async () => {
    const fixture = await createFixture('absent-reset');
    const options = {
      sourceId: 'team', pluginName: 'absent-reset', scope: 'user' as const, cwd: fixture.cwd, env: fixture.env,
    };
    await expect(resetPluginConfigStore(options)).resolves.toMatchObject({
      existed: false, deleted: false, resetDisposition: 'absent',
    });
    await expect(resetPluginConfigStore(options)).resolves.toMatchObject({
      existed: false, deleted: false, resetDisposition: 'absent',
    });
  });

  it('rejects a final special node with a stable relative target message', async () => {
    if (process.platform === 'win32') return;
    const fixture = await createFixture('special-reset');
    const configPath = resolvePluginConfigStorePath({
      sourceId: 'team', pluginName: 'special-reset', scope: 'user', cwd: fixture.cwd, env: fixture.env,
    });
    await fs.ensureDir(path.dirname(configPath));
    await execFileAsync('mkfifo', [configPath]);

    const error = await resetPluginConfigStore({
      sourceId: 'team', pluginName: 'special-reset', scope: 'user', cwd: fixture.cwd, env: fixture.env,
    }).catch((failure: unknown) => failure as Error & { code?: string });
    expect(error).toMatchObject({ code: 'configResetTargetUnsupported' });
    expect(error.message).toContain('user/plugin-config/team/special-reset/config.json');
    expect(error.message).not.toContain(fixture.root);
    expect(await fs.lstat(configPath)).toMatchObject({});
  });

  it('redacts sensitive values and absolute config paths from apply target failures', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
    mocks.visible.add('codex:user');
    const secret = 'plain-sensitive-leaf';
    const configPath = resolvePluginConfigStorePath({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
    });
    const debugEvents: unknown[] = [];
    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { token: secret } },
      rebuildRuntime: {
        debugLogger: { log: (value) => { debugEvents.push(value); } },
      },
      reinstallCommandImpl: async (_plugins, _options, runtime) => {
        await runtime.debugLogger?.log({ message: `debug ${secret} at ${configPath}` });
        throw new Error(`target rejected ${secret} at ${configPath}`);
      },
    });
    const projected = JSON.stringify(receipt);
    expect(projected).not.toContain(secret);
    expect(projected).not.toContain(configPath);
    expect(projected).toContain('user/plugin-config/configurable-plugin/config.json');
    expect(JSON.stringify(debugEvents)).not.toContain(secret);
    expect(JSON.stringify(debugEvents)).not.toContain(configPath);
  });

  it('redacts short secrets only from free-text debug fields', async () => {
    const fixture = await createFixture('configurable-plugin', { dynamicTarget: true });
    mocks.visible.add('codex:user');
    const debugEvents: unknown[] = [];
    const receipt = await applyPluginConfigWrite({
      plugin: fixture.plugin,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      request: { updates: { token: 'q' } },
      rebuildRuntime: {
        debugLogger: { log: (value) => { debugEvents.push(value); } },
      },
      reinstallCommandImpl: async (_plugins, _options, runtime) => {
        await runtime.debugLogger?.log({
          type: 'q',
          commandName: 'q',
          key: 'q',
          message: 'q',
        } as never);
        throw new Error('target rejected q but ordinary data stays intact');
      },
    });

    expect(debugEvents).toEqual([{
      type: 'q',
      commandName: 'q',
      key: 'q',
      message: '[REDACTED]',
    }]);
    expect(JSON.stringify(receipt)).toContain('ordinary data stays intact');
    expect(JSON.stringify(receipt)).not.toContain('rejected q but');
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

  it('projects invalid user fallback when valid project config masks it and a default exists', async () => {
    const fixture = await createFixture();
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'user',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 42 },
    });
    await writePluginConfigStore({
      pluginName: fixture.plugin.manifest.name,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
      values: { mode: 'fast' },
    });
    const read = await resolveConfigRead({
      pluginName: fixture.plugin.manifest.name,
      plugin: fixture.plugin,
      scope: 'project',
      cwd: fixture.cwd,
      env: fixture.env,
    });
    const mode = read.fields.find((field) => field.key === 'mode');

    expect(mode?.fallback).toMatchObject({
      state: 'invalid',
      sourceLayer: 'user',
      issues: [expect.objectContaining({ type: 'invalid-config', source: 'user' })],
    });
    expect(mode?.fallback).not.toHaveProperty('effectiveValue');
    const page = buildConfigPage({
      pluginId: fixture.plugin.manifest.name,
      schema: fixture.plugin.manifest.config!,
      read,
    });
    expect(page.groups.flatMap((group) => group.fields)
      .find((field) => field.key === 'mode')?.fallbackDisplayValue)
      .toContain('应用会被阻止');
    expect(JSON.stringify(page)).not.toContain('42');
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
