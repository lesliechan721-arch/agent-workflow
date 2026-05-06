import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliExecutionContext } from '../../src/commands/runtime.js';
import type { PluginConsoleItem, PluginConsoleLocation } from '../../src/commands/console-model.js';
import type { PluginMeta } from '../../src/types.js';
import { createFakeConsoleDriver, createFakePrompt } from '../helpers/fake-console.js';

const statusCommand = vi.fn();
const installCommand = vi.fn();
const upgradeCommand = vi.fn();
const uninstallCommand = vi.fn();
const preparePluginTargetsForCommand = vi.fn();
const createInstallWizardDecision = vi.fn();
const applyPluginConfigWrite = vi.fn();
const reapplyConfigRefresh = vi.fn();
const resolveSkillTriggerApplicabilityForPlugin = vi.fn();
const resolveEffectivePluginConfig = vi.fn();
const readPluginConfigStore = vi.fn();

vi.mock('../../src/commands/status.js', () => ({ statusCommand }));
vi.mock('../../src/commands/install.js', () => ({ installCommand }));
vi.mock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));
vi.mock('../../src/commands/uninstall.js', () => ({ uninstallCommand }));
vi.mock('../../src/commands/common.js', () => ({ preparePluginTargetsForCommand }));
vi.mock('../../src/commands/console-wizard.js', () => ({ createInstallWizardDecision }));
vi.mock('../../src/utils/plugin-config-write.js', () => ({ applyPluginConfigWrite }));
vi.mock('../../src/utils/artifact-refresh.js', () => ({ reapplyConfigRefresh }));
vi.mock('../../src/utils/skill-trigger-preferences.js', () => ({ resolveSkillTriggerApplicabilityForPlugin }));
vi.mock('../../src/utils/plugin-config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/plugin-config.js')>('../../src/utils/plugin-config.js');
  return {
    ...actual,
    resolveEffectivePluginConfig,
    readPluginConfigStore,
  };
});

const tempDirs: string[] = [];

function plugin(configSchema?: PluginMeta['manifest']['config']): PluginMeta {
  return {
    rootDir: '/synthetic/plugin',
    manifestPath: '/synthetic/plugin/.agents-plugin/plugin.json',
    manifest: {
      name: 'git-commit',
      version: '1.0.0',
      description: 'demo',
      marketplace: {
        category: 'test',
        strict: false,
        policy: {
          installation: 'AVAILABLE',
          authentication: 'NONE',
        },
      },
      config: configSchema,
    },
  };
}

function location(overrides: Partial<PluginConsoleLocation> = {}): PluginConsoleLocation {
  return {
    platform: 'codex',
    scope: 'user',
    locationLabel: 'Codex（个人）',
    status: 'installed',
    statusLabel: '已安装',
    actions: [],
    reasonCodes: [],
    nextSteps: [],
    ...overrides,
  };
}

function item(overrides: Partial<PluginConsoleItem> = {}): PluginConsoleItem {
  return {
    pluginName: 'git-commit',
    title: 'git-commit',
    status: 'installed',
    statusLabel: '已安装',
    locationSummary: 'Codex（个人）',
    actions: [],
    locations: [location()],
    reasonCodes: [],
    nextSteps: [],
    ...overrides,
  };
}

function createContext(promptReplies: Parameters<typeof createFakePrompt>[0]) {
  const prompt = createFakePrompt(promptReplies);
  const consoleDriver = createFakeConsoleDriver();
  const context = {
    cwd: '/workspace',
    env: {} as NodeJS.ProcessEnv,
    prompt,
    consoleDriver,
    interactive: true,
    reporter: {
      event: vi.fn(async () => undefined),
      notice: vi.fn(async () => undefined),
    },
    debugLogger: {
      log: vi.fn(async () => undefined),
      flush: vi.fn(async () => undefined),
    },
    diagnostics: {
      verbose: false,
      debug: false,
      commandName: 'console',
      runId: 'test-run',
    },
    adaptersFactory: vi.fn(),
    nativeCliRunner: vi.fn(),
    io: {
      stdout: vi.fn(),
      stderr: vi.fn(),
    },
    isTty: false,
    isCi: false,
  } as unknown as CliExecutionContext;
  return { context, prompt, consoleDriver };
}

async function makeTempDir(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  return root;
}

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('console controller', () => {
  it('runs install after required-config writes, then reloads home', async () => {
    const order: string[] = [];
    statusCommand
      .mockResolvedValueOnce({ consoleItems: [item({
        status: 'notInstalled',
        statusLabel: '未安装',
        locations: [location({
          status: 'notInstalled',
          statusLabel: '未安装',
          actions: [{ kind: 'openInstallWizard', label: '安装', target: { platform: 'codex', scope: 'user' } }],
        })],
      })] })
      .mockResolvedValueOnce({ consoleItems: [item()] });
    preparePluginTargetsForCommand.mockResolvedValue({
      ledger: { ledgerState: { status: 'available' } },
      targets: [{ pluginName: 'git-commit', plugin: plugin() }],
    });
    resolveSkillTriggerApplicabilityForPlugin.mockResolvedValue('fixed');
    createInstallWizardDecision.mockImplementation(async () => {
      order.push('decision');
      return {
        blockedReason: undefined,
        configPrompts: [{
          pluginName: 'git-commit',
          schemaSourceIdentity: 'git-commit:test',
          manifest: plugin({
            schema: {
              token: { type: 'string', required: true, sensitive: true },
            },
          }).manifest,
          effective: { projectRoot: '/workspace' },
          form: {
            pluginName: 'git-commit',
            allowedScopes: ['user'],
            initialScope: 'user',
            requiredKeys: ['token'],
            fields: [{
              key: 'token',
              type: 'string',
              label: 'Token',
              required: true,
              sensitive: true,
              configured: false,
            }],
          },
        }],
        commandAction: 'install',
      };
    });
    applyPluginConfigWrite.mockImplementation(async () => {
      order.push('config');
      return {
        updatedKeys: ['token'],
        removedKeys: [],
        artifactRefresh: { status: 'succeeded' },
      };
    });
    installCommand.mockImplementation(async () => {
      order.push('install');
      return {
        platforms: ['codex'],
        plugins: ['git-commit'],
        warnings: [],
      };
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'openInstallWizard' },
      { method: 'password', value: 'secret-token' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(order).toEqual(['decision', 'config', 'install']);
    expect(applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      request: { updates: { token: 'secret-token' }, removeKeys: [] },
    }));
  });

  it('dispatches repairInstall through upgrade semantics for drifted locations', async () => {
    statusCommand
      .mockResolvedValueOnce({ consoleItems: [item({
        status: 'needsAction',
        statusLabel: '需要处理',
        locations: [location({
          status: 'needsAction',
          statusLabel: '需要处理',
          reasonCodes: ['artifactDrift'],
          actions: [{ kind: 'repairInstall', label: '重新安装/升级', target: { platform: 'codex', scope: 'user' } }],
        })],
      })] })
      .mockResolvedValueOnce({ consoleItems: [item()] });
    preparePluginTargetsForCommand.mockResolvedValue({
      ledger: { ledgerState: { status: 'available' } },
      targets: [{ pluginName: 'git-commit', plugin: plugin() }],
    });
    resolveSkillTriggerApplicabilityForPlugin.mockResolvedValue('fixed');
    createInstallWizardDecision.mockResolvedValue({
      blockedReason: undefined,
      configPrompts: [],
      commandAction: 'upgrade',
    });
    upgradeCommand.mockResolvedValue({
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'repairInstall' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(createInstallWizardDecision).toHaveBeenCalledWith(expect.objectContaining({
      intent: 'repairInstall',
      repairOperation: 'upgrade',
    }));
    expect(upgradeCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        scope: 'user',
        platform: 'codex',
      }),
      context,
    );
    expect(installCommand).not.toHaveBeenCalled();
  });

  it('forces multi-location selection before uninstalling and uses the chosen location target', async () => {
    statusCommand
      .mockResolvedValueOnce({ consoleItems: [item({
        locationSummary: '多个位置',
        locations: [
          location({
            actions: [{ kind: 'runUninstall', label: '卸载', destructive: true, confirmText: 'remove user?', target: { platform: 'codex', scope: 'user' } }],
          }),
          location({
            scope: 'project',
            locationLabel: 'Codex（当前项目）',
            actions: [{ kind: 'runUninstall', label: '卸载', destructive: true, confirmText: 'remove project?', target: { platform: 'codex', scope: 'project' } }],
          }),
        ],
      })] })
      .mockResolvedValueOnce({ consoleItems: [item()] });
    uninstallCommand.mockResolvedValue({
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'codex:project:-' },
      { method: 'select', value: 'runUninstall' },
      { method: 'confirm', value: true },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(uninstallCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        scope: 'project',
        platform: 'codex',
      }),
      context,
    );
  });

  it('supports full config edits including explicit clear', async () => {
    const tempRoot = await makeTempDir('aw-console-config-');
    const configFile = path.join(tempRoot, 'token.txt');
    const configDir = path.join(tempRoot, 'workspace');
    await fs.outputFile(configFile, 'token');
    await fs.ensureDir(configDir);

    const configPlugin = plugin({
      schema: {
        token: { type: 'string', sensitive: true },
        workspaceFile: { type: 'file' },
        workspaceDir: { type: 'directory' },
        retries: { type: 'number' },
        enabled: { type: 'boolean' },
        mode: { type: 'enum', values: ['fast', 'safe'] },
      },
    });
    statusCommand
      .mockResolvedValueOnce({ consoleItems: [item({
        locations: [location({
          actions: [{ kind: 'openConfigWizard', label: '配置', target: { platform: 'codex', scope: 'user' } }],
        })],
      })] })
      .mockResolvedValueOnce({ consoleItems: [item()] });
    preparePluginTargetsForCommand.mockResolvedValue({
      targets: [{ pluginName: 'git-commit', plugin: configPlugin, currentPlugin: configPlugin }],
    });
    resolveEffectivePluginConfig.mockResolvedValue({
      pluginName: 'git-commit',
      projectRoot: tempRoot,
      values: {},
      redactedValues: {},
      sources: {},
      issues: [],
      ignoredUnknownKeys: [],
      schema: configPlugin.manifest.config!.schema,
      stores: {
        user: { path: '', exists: true, values: {} },
        project: { path: '', exists: true, values: { token: 'old-secret', retries: 2 } },
      },
    });
    readPluginConfigStore.mockResolvedValue({
      path: '',
      exists: true,
      values: { token: 'old-secret', retries: 2 },
    });
    applyPluginConfigWrite.mockResolvedValue({
      updatedKeys: ['token', 'workspaceFile', 'workspaceDir', 'enabled', 'mode'],
      removedKeys: ['retries'],
      artifactRefresh: { status: 'succeeded' },
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'openConfigWizard' },
      { method: 'select', value: 'project' },
      { method: 'select', value: 'update' },
      { method: 'password', value: 'new-secret' },
      { method: 'select', value: 'set' },
      { method: 'input', value: configFile },
      { method: 'select', value: 'set' },
      { method: 'input', value: configDir },
      { method: 'select', value: 'clear' },
      { method: 'select', value: 'set' },
      { method: 'select', value: 'true' },
      { method: 'select', value: 'set' },
      { method: 'select', value: 'fast' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'project',
      request: {
        updates: {
          token: 'new-secret',
          workspaceFile: expect.stringMatching(/token\.txt$/),
          workspaceDir: expect.stringMatching(/workspace$/),
          enabled: true,
          mode: 'fast',
        },
        removeKeys: ['retries'],
      },
    }));
  });

  it('shows skipped reapply refresh feedback', async () => {
    const consoleItem = item({
      locations: [location({
        actions: [{ kind: 'reapplyConfigRefresh', label: '重新应用配置', target: { platform: 'codex', scope: 'user' } }],
      })],
    });
    statusCommand
      .mockResolvedValueOnce({ consoleItems: [consoleItem] })
      .mockResolvedValueOnce({ consoleItems: [consoleItem] });
    preparePluginTargetsForCommand.mockResolvedValue({
      targets: [{ pluginName: 'git-commit', plugin: plugin(), currentPlugin: plugin() }],
    });
    reapplyConfigRefresh.mockResolvedValue({
      status: 'skipped',
      attempted: false,
      artifacts: [],
      triggerKeys: [],
      reason: 'no tracked artifacts',
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'reapplyConfigRefresh' },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(consoleDriver.views.some((view) =>
      view.lines.some((line) => line.includes('没有需要重新应用的项目文件')),
    )).toBe(true);
  });

  it('defaults config writes to the current installation location', async () => {
    const configPlugin = plugin({
      schema: {
        token: { type: 'string', sensitive: true },
      },
    });
    statusCommand
      .mockResolvedValueOnce({ consoleItems: [item({
        locations: [location({
          scope: 'project',
          locationLabel: 'Codex（当前项目）',
          actions: [{ kind: 'openConfigWizard', label: '配置', target: { platform: 'codex', scope: 'project' } }],
        })],
      })] })
      .mockResolvedValueOnce({ consoleItems: [item()] });
    preparePluginTargetsForCommand.mockResolvedValue({
      targets: [{ pluginName: 'git-commit', plugin: configPlugin, currentPlugin: configPlugin }],
    });
    resolveEffectivePluginConfig.mockResolvedValue({
      pluginName: 'git-commit',
      projectRoot: '/workspace',
      values: {},
      redactedValues: {},
      sources: {},
      issues: [],
      ignoredUnknownKeys: [],
      schema: configPlugin.manifest.config!.schema,
      stores: {
        user: { path: '', exists: false, values: {} },
        project: { path: '', exists: false, values: {} },
      },
    });
    readPluginConfigStore.mockResolvedValue({
      path: '',
      exists: false,
      values: {},
    });
    applyPluginConfigWrite.mockResolvedValue({
      updatedKeys: ['token'],
      removedKeys: [],
      artifactRefresh: { status: 'succeeded' },
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'openConfigWizard' },
      { method: 'select', value: 'project' },
      { method: 'select', value: 'set' },
      { method: 'password', value: 'project-token' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const scopeSelectCall = prompt.calls.find((call) =>
      call.method === 'select' &&
      typeof (call.options as { message?: string }).message === 'string' &&
      (call.options as { message: string }).message.includes('选择配置写入位置'),
    );
    expect(scopeSelectCall).toBeTruthy();
    expect(scopeSelectCall?.options).toMatchObject({
      defaultValue: 'project',
    });
  });

  it('does not write state when uninstall confirmation is cancelled', async () => {
    const consoleItem = item({
      locations: [location({
        actions: [{ kind: 'runUninstall', label: '卸载', destructive: true, confirmText: 'confirm uninstall', target: { platform: 'codex', scope: 'user' } }],
      })],
    });
    statusCommand
      .mockResolvedValueOnce({ consoleItems: [consoleItem] })
      .mockResolvedValueOnce({ consoleItems: [consoleItem] });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'runUninstall' },
      { method: 'confirm', value: false },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(uninstallCommand).not.toHaveBeenCalled();
    expect(consoleDriver.views.some((view) =>
      view.lines.some((line) => line.includes('没有写入任何状态')),
    )).toBe(true);
  });

  it('runs the diagnose action with verbose status output', async () => {
    const consoleItem = item({
      locations: [location({
        actions: [{
          kind: 'diagnoseCommand',
          label: '查看诊断命令',
          target: { platform: 'codex', scope: 'user' },
          command: ['aw', 'status', 'git-commit', '-p', 'codex', '-s', 'user', '--verbose'],
        }],
      })],
    });
    statusCommand
      .mockResolvedValueOnce({ consoleItems: [consoleItem] })
      .mockResolvedValueOnce({ output: 'verbose diagnostics', consoleItems: [consoleItem] })
      .mockResolvedValueOnce({ consoleItems: [consoleItem] });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'diagnoseCommand' },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(statusCommand).toHaveBeenNthCalledWith(
      2,
      ['git-commit'],
      expect.objectContaining({
        verbose: true,
        scope: 'user',
        platform: 'codex',
      }),
      context,
    );
  });
});
