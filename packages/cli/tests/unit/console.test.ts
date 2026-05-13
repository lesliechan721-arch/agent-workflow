import os from 'node:os';
import path from 'node:path';

import fs from 'fs-extra';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliExecutionContext } from '../../src/commands/runtime.js';
import type {
  ConsoleControllerItem,
  DiagnosePageModel,
  PluginConsoleFeatureSummary,
  PluginConsoleLocation,
  PluginConsoleSummary,
} from '../../src/commands/console-model.js';
import type { PluginMeta } from '../../src/types.js';
import { createFakeConsoleDriver, createFakePrompt } from '../helpers/fake-console.js';

const statusCommand = vi.fn();
const loadConsoleItems = vi.fn();
const diagnoseCommand = vi.fn();
const installCommand = vi.fn();
const upgradeCommand = vi.fn();
const uninstallCommand = vi.fn();
const cleanupCommand = vi.fn();
const repairCommand = vi.fn();
const reinstallCommand = vi.fn();
const preparePluginTargetsForCommand = vi.fn();
const createInstallWizardDecision = vi.fn();
const planConsoleGraphWriteTargets = vi.fn();
const applyPluginConfigWrite = vi.fn();
const reapplyConfigRefresh = vi.fn();
const resolveSkillTriggerApplicabilityForPlugin = vi.fn();
const resolveEffectivePluginConfig = vi.fn();
const readPluginConfigStore = vi.fn();

planConsoleGraphWriteTargets.mockImplementation(async (options: {
  targets: Array<{ pluginName: string }>;
  platforms: string[];
}) => ({
  requestedTargets: options.targets.map((target) => ({
    target,
    platform: options.platforms[0] ?? 'codex',
  })),
  writeTargets: options.targets.map((target) => ({
    target,
    platform: options.platforms[0] ?? 'codex',
    resolvedInstallOptions: undefined,
  })),
}));

vi.mock('../../src/commands/status.js', () => ({ statusCommand, loadConsoleItems }));
vi.mock('../../src/commands/diagnose.js', () => ({ diagnoseCommand }));
vi.mock('../../src/commands/install.js', () => ({ installCommand }));
vi.mock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));
vi.mock('../../src/commands/uninstall.js', () => ({ uninstallCommand }));
vi.mock('../../src/commands/cleanup.js', () => ({ cleanupCommand }));
vi.mock('../../src/commands/repair.js', () => ({ repairCommand }));
vi.mock('../../src/commands/reinstall.js', () => ({ reinstallCommand }));
vi.mock('../../src/commands/common.js', () => ({ preparePluginTargetsForCommand }));
vi.mock('../../src/commands/console-wizard.js', () => ({
  createInstallWizardDecision,
  planConsoleGraphWriteTargets,
}));
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

function feature(
  kind: PluginConsoleFeatureSummary['kind'],
  overrides: Partial<PluginConsoleFeatureSummary> = {},
): PluginConsoleFeatureSummary {
  return {
    kind,
    label: {
      install: '安装',
      upgrade: '升级',
      configure: '配置',
      uninstall: '卸载',
      repair: '修复安装',
      cleanup: '清理',
      reinstall: '重新安装',
      adoptExisting: '认领现有安装',
      takeoverSharedRuntime: '接管共享触发策略',
      resolveDuplicateInstall: '处理重复安装',
      reapplyConfigRefresh: '重新应用配置',
      status: '查看状态',
      diagnose: '查看诊断',
    }[kind],
    targetSelection: kind === 'status' || kind === 'diagnose' ? 'none' : 'singleTarget',
    ...overrides,
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

function summary(overrides: Partial<PluginConsoleSummary> = {}): PluginConsoleSummary {
  return {
    pluginName: 'git-commit',
    title: 'Git Commit',
    description: '帮助生成 commit 信息',
    version: '1.2.3',
    status: 'installed',
    statusLabel: '已安装',
    locationSummary: 'Codex（个人）',
    supportedPlatforms: ['codex'],
    installedLocations: [{
      platform: 'codex',
      scope: 'user',
      label: 'Codex（个人）',
      status: 'installed',
      statusLabel: '已安装',
      reasonCodes: [],
      nextSteps: [],
    }],
    features: [
      feature('configure'),
      feature('uninstall'),
      feature('status'),
      feature('diagnose'),
    ],
    reasonCodes: [],
    nextSteps: [],
    ...overrides,
  };
}

function item(overrides: {
  summary?: Partial<PluginConsoleSummary>;
  locations?: PluginConsoleLocation[];
} = {}): ConsoleControllerItem {
  const builtSummary = summary(overrides.summary);
  const locations = overrides.locations ?? [location()];
  return {
    summary: builtSummary,
    pageItem: {
      summary: builtSummary,
      statusIcon: builtSummary.status === 'abnormal' ? 'alert-circle' : builtSummary.status === 'notInstalled' ? 'circle' : 'check-circle',
      statusTone: builtSummary.status === 'abnormal' ? 'danger' : builtSummary.status === 'notInstalled' ? 'neutral' : 'success',
      platformBadges: (builtSummary.supportedPlatforms ?? ['codex']).map((platform) => ({
        label: platform === 'codex' ? 'Codex' : 'Claude Code',
        icon: platform === 'codex' ? 'square-terminal' : 'bot',
        tone: 'neutral',
      })),
      ...(builtSummary.features.find((entry) => entry.kind !== 'status' && entry.kind !== 'diagnose')
        ? { primaryActionLabel: builtSummary.features.find((entry) => entry.kind !== 'status' && entry.kind !== 'diagnose')!.label }
        : {}),
      ...(builtSummary.issueSummary ? { summaryText: builtSummary.issueSummary } : {}),
    },
    locations,
    statusPage: {
      pluginName: builtSummary.pluginName,
      summary: builtSummary,
      locations: locations.map((entry) => ({
        platform: entry.platform,
        scope: entry.scope,
        ...(entry.projectKey ? { projectKey: entry.projectKey } : {}),
        label: entry.locationLabel,
        status: entry.status,
        statusLabel: entry.statusLabel,
        issues: [],
        suggestedFeatures: [],
        nextSteps: entry.nextSteps,
      })),
    },
    ...(builtSummary.issueSummary ? { blockingMessage: builtSummary.issueSummary } : {}),
  };
}

function createBaseStatusResult(options: {
  currentCatalogAvailable?: boolean;
} = {}) {
  return {
    output: '',
    matrix: {
      cells: [{
        report: {
          currentCatalog: {
            available: options.currentCatalogAvailable ?? true,
          },
        },
      }],
    },
  };
}

function createDiagnosePage(overrides: Partial<DiagnosePageModel> = {}): DiagnosePageModel {
  return {
    pluginName: 'git-commit',
    conclusion: '当前安装可定位，但有异常需要收口。',
    issues: [{
      code: 'recordCorrupted',
      label: '记录损坏',
      severity: 'error',
      summary: 'AW 记录和当前安装状态对不上。',
      suggestedFeatures: [feature('repair')],
    }],
    locations: [{
      platform: 'codex',
      scope: 'user',
      label: 'Codex（个人）',
      status: 'abnormal',
      statusLabel: '异常',
      issue: {
        code: 'recordCorrupted',
        label: '记录损坏',
        severity: 'error',
        summary: 'AW 记录和当前安装状态对不上。',
        suggestedFeatures: [feature('repair')],
      },
      issues: [{
        code: 'recordCorrupted',
        label: '记录损坏',
        severity: 'error',
        summary: 'AW 记录和当前安装状态对不上。',
        suggestedFeatures: [feature('repair')],
      }],
      suggestedFeatures: [feature('repair'), feature('cleanup')],
      nextSteps: ['aw repair git-commit -p codex -s user'],
    }],
    supplementalCommands: [],
    ...overrides,
  };
}

function cleanupPayload(overrides: Record<string, unknown> = {}) {
  return {
    command: 'cleanup',
    dependencyIndex: false,
    cleanupPlanSchemaVersion: 1,
    dryRun: false,
    force: false,
    removeConfig: false,
    target: {
      plugin: 'git-commit',
      platform: 'codex',
      scope: 'user',
      targetType: 'installed',
    },
    forceReason: null,
    plannedRemovals: [],
    wouldBackups: [],
    wouldRemoveConfig: [],
    skippedForeignItems: [],
    affectedDependents: [],
    blockingReasons: [],
    suggestedCommand: 'aw cleanup git-commit -p codex -s user',
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
  vi.resetAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.remove(dir)));
});

describe('console controller stage 5', () => {
  it('shows the catalog-unavailable banner while keeping discovered installs on home', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult({
      currentCatalogAvailable: false,
    }));
    loadConsoleItems.mockResolvedValue([item()]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(consoleDriver.views[0]?.lines).toContain('插件目录不可用，仅显示已发现安装；恢复后可安装或升级。');
    expect(consoleDriver.views[0]?.lines.some((line) => line.includes('Git Commit'))).toBe(true);
  });

  it('runs install from the feature menu and skips target selection for a single target', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    loadConsoleItems
      .mockResolvedValueOnce([item({
        summary: {
          status: 'notInstalled',
          statusLabel: '未安装',
          locationSummary: 'Codex（个人）',
          features: [feature('install'), feature('status'), feature('diagnose')],
        },
        locations: [location({
          status: 'notInstalled',
          statusLabel: '未安装',
          actions: [{ kind: 'openInstallWizard', label: '安装', target: { platform: 'codex', scope: 'user' } }],
        })],
      })])
      .mockResolvedValueOnce([item()]);
    preparePluginTargetsForCommand.mockResolvedValue({
      ledger: { ledgerState: { status: 'available' } },
      targets: [{ pluginName: 'git-commit', plugin: plugin() }],
    });
    resolveSkillTriggerApplicabilityForPlugin.mockResolvedValue('fixed');
    createInstallWizardDecision.mockResolvedValue({
      blockedReason: undefined,
      configPrompts: [],
      commandAction: 'install',
    });
    installCommand.mockResolvedValue({
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'install' },
      { method: 'select', action: 'exit' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(installCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        scope: 'user',
        platform: 'codex',
      }),
      context,
    );
    expect(prompt.calls.some((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择目标',
    )).toBe(false);
  });

  it('shows detail summary and feature menu before any target selection', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        status: 'abnormal',
        statusLabel: '异常',
        locationSummary: 'Codex（个人 + 当前项目）',
        issueSummary: '同一平台同时存在两个可生效安装。',
        nextSteps: ['先决定保留哪一侧，再处理另一侧。'],
        features: [
          feature('resolveDuplicateInstall', { targetSelection: 'singleTargetOnly', destructive: true }),
          feature('status'),
          feature('diagnose'),
        ],
      },
      locations: [
        location({
          status: 'abnormal',
          statusLabel: '异常',
          reasonCodes: ['duplicateInstall'],
        }),
        location({
          scope: 'project',
          projectKey: '/workspace',
          locationLabel: 'Codex（当前项目）',
          status: 'abnormal',
          statusLabel: '异常',
          reasonCodes: ['duplicateInstall'],
        }),
      ],
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', action: 'back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('状态：异常');
    expect(detailView?.lines).toContain('安装摘要：Codex（个人 + 当前项目）');
    expect(detailView?.lines).toContain('版本：1.2.3');
    expect(detailView?.lines).toContain('主要原因：同一平台同时存在两个可生效安装。');
    expect(detailView?.lines).toContain('建议：先决定保留哪一侧，再处理另一侧。');

    const selectMessages = prompt.calls
      .filter((call) => call.method === 'select')
      .map((call) => (call.options as { message?: string }).message);
    expect(selectMessages).toContain('选择功能');
    expect(selectMessages).not.toContain('选择位置');
  });

  it('renders dependency-blocked uninstall as a disabled feature', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        features: [
          feature('uninstall', { disabledReason: '当前仍被上游依赖，暂时不能直接卸载。' }),
          feature('status'),
          feature('diagnose'),
        ],
      },
      locations: [location({
        actions: [{
          kind: 'runUninstall',
          label: '卸载',
          target: { platform: 'codex', scope: 'user' },
          destructive: true,
          confirmText: 'remove?',
          disabledReason: '当前仍被上游依赖，暂时不能直接卸载。',
        }],
      })],
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const featurePrompt = prompt.calls.find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择功能',
    );
    expect(featurePrompt).toBeTruthy();
    expect((featurePrompt!.options as { choices: Array<{ value: string; disabled?: boolean | string }> }).choices)
      .toContainEqual(expect.objectContaining({
        value: 'uninstall',
        disabled: '当前仍被上游依赖，暂时不能直接卸载。',
      }));
  });

  it('selects the target only after the feature is chosen', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    loadConsoleItems
      .mockResolvedValueOnce([item({
        summary: {
          status: 'abnormal',
          statusLabel: '异常',
          locationSummary: 'Codex（个人 + 当前项目）',
          features: [
            feature('uninstall', { targetSelection: 'singleTargetOnly', destructive: true }),
            feature('status'),
            feature('diagnose'),
          ],
        },
        locations: [
          location({
            status: 'abnormal',
            statusLabel: '异常',
            actions: [{ kind: 'runUninstall', label: '卸载', destructive: true, confirmText: 'remove user?', target: { platform: 'codex', scope: 'user' } }],
          }),
          location({
            scope: 'project',
            projectKey: '/workspace',
            locationLabel: 'Codex（当前项目）',
            status: 'abnormal',
            statusLabel: '异常',
            actions: [{ kind: 'runUninstall', label: '卸载', destructive: true, confirmText: 'remove project?', target: { platform: 'codex', scope: 'project', projectKey: '/workspace' } }],
          }),
        ],
      })])
      .mockResolvedValueOnce([item()]);
    uninstallCommand.mockResolvedValue({
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'uninstall' },
      { method: 'select', value: 'codex:project:/workspace' },
      { method: 'confirm', value: true },
      { method: 'select', value: 'keep' },
      { method: 'select', action: 'exit' },
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
    expect(prompt.calls
      .filter((call) => call.method === 'select')
      .map((call) => (call.options as { message?: string }).message))
      .toEqual(expect.arrayContaining(['选择插件', '选择功能', '选择目标']));
  });

  it('shows the all-platform option for ordinary cross-platform features', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        supportedPlatforms: ['codex', 'claude'],
        locationSummary: 'Codex、Claude Code',
        features: [
          feature('uninstall', { targetSelection: 'multiTargetAllowed', destructive: true }),
          feature('status'),
          feature('diagnose'),
        ],
      },
      locations: [
        location({
          actions: [{ kind: 'runUninstall', label: '卸载', destructive: true, confirmText: 'remove codex?', target: { platform: 'codex', scope: 'user' } }],
        }),
        location({
          platform: 'claude',
          locationLabel: 'Claude Code（个人）',
          actions: [{ kind: 'runUninstall', label: '卸载', destructive: true, confirmText: 'remove claude?', target: { platform: 'claude', scope: 'user' } }],
        }),
      ],
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'uninstall' },
      { method: 'select', action: 'back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const targetPrompt = prompt.calls.find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择目标',
    );
    expect(targetPrompt).toBeTruthy();
    expect((targetPrompt!.options as { choices: Array<{ value: string }> }).choices)
      .toContainEqual(expect.objectContaining({ value: '__all_platforms' }));
  });

  it('expands all-platform install into concrete platforms and preserves the selected skill trigger', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    const allPlatformItem = item({
      summary: {
        status: 'notInstalled',
        statusLabel: '未安装',
        supportedPlatforms: ['codex', 'claude'],
        locationSummary: 'Codex、Claude Code',
        features: [
          feature('install', { targetSelection: 'multiTargetAllowed' }),
          feature('status'),
          feature('diagnose'),
        ],
      },
      locations: [
        location({
          status: 'notInstalled',
          statusLabel: '未安装',
          actions: [{ kind: 'openInstallWizard', label: '安装', target: { platform: 'codex', scope: 'user' } }],
        }),
        location({
          platform: 'claude',
          locationLabel: 'Claude Code（个人）',
          status: 'notInstalled',
          statusLabel: '未安装',
          actions: [{ kind: 'openInstallWizard', label: '安装', target: { platform: 'claude', scope: 'user' } }],
        }),
      ],
    });
    loadConsoleItems.mockResolvedValue(allPlatformItem ? [allPlatformItem] : []);
    const preparedTarget = { pluginName: 'git-commit', plugin: plugin() };
    preparePluginTargetsForCommand.mockResolvedValue({
      ledger: { ledgerState: { status: 'available' } },
      targets: [preparedTarget],
    });
    planConsoleGraphWriteTargets.mockResolvedValue({
      requestedTargets: [
        { target: preparedTarget, platform: 'codex' },
        { target: preparedTarget, platform: 'claude' },
      ],
      writeTargets: [
        { target: preparedTarget, platform: 'codex', resolvedInstallOptions: undefined },
        { target: preparedTarget, platform: 'claude', resolvedInstallOptions: undefined },
      ],
    });
    resolveSkillTriggerApplicabilityForPlugin.mockResolvedValue('overridable');
    createInstallWizardDecision.mockResolvedValue({
      blockedReason: undefined,
      configPrompts: [],
      commandAction: 'install',
    });
    installCommand.mockResolvedValue({
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'install' },
      { method: 'select', value: '__all_platforms' },
      { method: 'select', value: 'user' },
      { method: 'select', value: 'manual' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(planConsoleGraphWriteTargets).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'install',
      platforms: ['codex', 'claude'],
    }));
    expect(installCommand).toHaveBeenCalledTimes(2);
    expect(installCommand).toHaveBeenNthCalledWith(
      1,
      ['git-commit'],
      expect.objectContaining({ platform: 'codex', requestedSkillTrigger: 'manual' }),
      context,
    );
    expect(installCommand).toHaveBeenNthCalledWith(
      2,
      ['git-commit'],
      expect.objectContaining({ platform: 'claude', requestedSkillTrigger: 'manual' }),
      context,
    );
    const triggerPrompt = prompt.calls.find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择触发方式',
    );
    expect((triggerPrompt!.options as { choices: Array<{ label: string }> }).choices)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ label: '默认' }),
        expect.objectContaining({ label: '手动' }),
        expect.objectContaining({ label: '自动' }),
      ]));
  });

  it('uses per-platform selection for heterogeneous all-platform targets and can skip a platform', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    const repairItem = item({
      summary: {
        status: 'abnormal',
        statusLabel: '异常',
        supportedPlatforms: ['codex', 'claude'],
        locationSummary: 'Codex、Claude Code',
        features: [
          feature('repair', { targetSelection: 'multiTargetAllowed' }),
          feature('status'),
          feature('diagnose'),
        ],
      },
      locations: [
        location({
          status: 'abnormal',
          statusLabel: '异常',
          actions: [{ kind: 'repairInstall', label: '修复安装', target: { platform: 'codex', scope: 'user' } }],
        }),
        location({
          scope: 'project',
          projectKey: '/workspace',
          locationLabel: 'Codex（当前项目）',
          status: 'abnormal',
          statusLabel: '异常',
          actions: [{ kind: 'repairInstall', label: '修复安装', target: { platform: 'codex', scope: 'project', projectKey: '/workspace' } }],
        }),
        location({
          platform: 'claude',
          locationLabel: 'Claude Code（个人）',
          status: 'abnormal',
          statusLabel: '异常',
          actions: [{ kind: 'repairInstall', label: '修复安装', target: { platform: 'claude', scope: 'user' } }],
        }),
      ],
    });
    loadConsoleItems.mockResolvedValue([repairItem]);
    repairCommand.mockResolvedValue({ output: 'done' });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'repair' },
      { method: 'select', value: '__all_platforms' },
      { method: 'select', value: '__skip' },
      { method: 'select', value: 'codex:project:/workspace' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(prompt.calls
      .filter((call) => call.method === 'select')
      .map((call) => (call.options as { message?: string }).message))
      .toEqual(expect.arrayContaining(['选择 Claude Code 位置', '选择 Codex 位置']));
    expect(repairCommand).toHaveBeenCalledTimes(1);
    expect(repairCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({ platform: 'codex', scope: 'project' }),
      context,
    );
  });

  it('supports config writes through the feature menu', async () => {
    const tempRoot = await makeTempDir('aw-console-config-');
    const configFile = path.join(tempRoot, 'token.txt');
    await fs.outputFile(configFile, 'token');

    const configPlugin = plugin({
      schema: {
        token: { type: 'string', sensitive: true },
        workspaceFile: { type: 'file' },
      },
    });
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    loadConsoleItems
      .mockResolvedValueOnce([item({
        summary: {
          features: [feature('configure'), feature('status'), feature('diagnose')],
        },
        locations: [location({
          scope: 'project',
          locationLabel: 'Codex（当前项目）',
          actions: [{ kind: 'openConfigWizard', label: '配置', target: { platform: 'codex', scope: 'project' } }],
        })],
      })])
      .mockResolvedValueOnce([item()]);
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
      updatedKeys: ['token', 'workspaceFile'],
      removedKeys: [],
      artifactRefresh: { status: 'succeeded' },
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'configure' },
      { method: 'select', value: 'set' },
      { method: 'password', value: 'project-token' },
      { method: 'select', value: 'set' },
      { method: 'input', value: configFile },
      { method: 'select', action: 'exit' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'project',
      request: {
        updates: {
          token: 'project-token',
          workspaceFile: expect.stringMatching(/token\.txt$/),
        },
        removeKeys: [],
      },
    }));
  });

  it('shows the config refresh failure follow-up without leaking artifact internals', async () => {
    const tempRoot = await makeTempDir('aw-console-config-refresh-');
    const configPlugin = plugin({
      schema: {
        token: { type: 'string', required: true },
      },
    });
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        features: [feature('configure'), feature('status'), feature('diagnose')],
      },
      locations: [location({
        actions: [{ kind: 'openConfigWizard', label: '配置', target: { platform: 'codex', scope: 'user' } }],
      })],
    })]);
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
      artifactRefresh: { status: 'failed', error: 'renderer stack trace' },
    });
    reapplyConfigRefresh.mockResolvedValue({ status: 'skipped' });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'configure' },
      { method: 'select', value: 'set' },
      { method: 'input', value: 'secret' },
      { method: 'select', value: 'reapply' },
      { method: 'select', action: 'exit' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const failureView = consoleDriver.views.find((view) => view.title === 'Git Commit 配置');
    expect(failureView?.lines).toEqual([
      '配置已保存，但相关项目文件刷新失败。你可以重新应用配置，或进入诊断查看原因。',
    ]);
    expect(JSON.stringify(consoleDriver.views)).not.toContain('renderer stack trace');
    expect(reapplyConfigRefresh).toHaveBeenCalled();
  });

  it('renders cleanup risk details and cancels before the write command', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        features: [feature('cleanup', { destructive: true }), feature('status'), feature('diagnose')],
      },
      locations: [location({
        actions: [{
          kind: 'runCleanup',
          label: '清理',
          target: { platform: 'codex', scope: 'user' },
          destructive: true,
          confirmText: 'cleanup?',
        }],
      })],
    })]);
    cleanupCommand.mockResolvedValue({
      payload: cleanupPayload({
        forceReason: '需要降级清理。',
        plannedRemovals: [{ kind: 'record', label: '安装记录' }],
        wouldBackups: [{ kind: 'file', label: '历史 runtime' }],
        affectedDependents: [{ plugin: 'consumer', platform: 'codex', scope: 'user' }],
        blockingReasons: [{ code: 'foreign', message: '外部归属未确认。' }],
      }),
      warnings: [],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'cleanup' },
      { method: 'select', value: 'keep' },
      { method: 'confirm', value: false },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(cleanupCommand).toHaveBeenCalledTimes(1);
    expect(cleanupCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({ plan: true, removeConfig: false }),
      context,
    );
    const riskView = consoleDriver.views.find((view) => view.title === 'Git Commit 清理风险');
    expect(riskView?.lines).toEqual(expect.arrayContaining([
      '风险来源：需要降级清理。',
      '删除计划：安装记录',
      '受影响依赖：codex/consumer/user',
      '备份：历史 runtime',
      '不可删除项：外部归属未确认。',
    ]));
    expect(consoleDriver.views.some((view) =>
      view.lines.includes('已取消，本次没有写入任何状态。'),
    )).toBe(true);
  });

  it('deduplicates remove-config during all-platform cleanup and only cleanup receives force', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    const cleanupItem = item({
      summary: {
        supportedPlatforms: ['codex', 'claude'],
        locationSummary: 'Codex、Claude Code',
        features: [
          feature('cleanup', { targetSelection: 'multiTargetAllowed', destructive: true }),
          feature('status'),
          feature('diagnose'),
        ],
      },
      locations: [
        location({
          actions: [{
            kind: 'runCleanup',
            label: '清理',
            target: { platform: 'codex', scope: 'user' },
            destructive: true,
            confirmText: 'cleanup codex?',
          }],
        }),
        location({
          platform: 'claude',
          locationLabel: 'Claude Code（个人）',
          actions: [{
            kind: 'runCleanup',
            label: '清理',
            target: { platform: 'claude', scope: 'user' },
            destructive: true,
            confirmText: 'cleanup claude?',
          }],
        }),
      ],
    });
    loadConsoleItems.mockResolvedValue([cleanupItem]);
    cleanupCommand.mockImplementation(async (_plugins: string[], options: { plan?: boolean; platform?: string }) => ({
      payload: cleanupPayload({
        dryRun: options.plan === true,
        platform: options.platform,
        forceReason: '需要恢复清理。',
        plannedRemovals: [],
        wouldBackups: [],
      }),
      warnings: [],
    }));

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'cleanup' },
      { method: 'select', value: '__all_platforms' },
      { method: 'select', value: 'user' },
      { method: 'select', value: 'remove' },
      { method: 'confirm', value: true },
      { method: 'confirm', value: true },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const actualCleanupCalls = cleanupCommand.mock.calls.filter(([, options]) =>
      (options as { plan?: boolean }).plan !== true,
    );
    expect(actualCleanupCalls).toHaveLength(2);
    expect(actualCleanupCalls[0]![1]).toMatchObject({
      platform: 'codex',
      force: true,
      removeConfig: true,
    });
    expect(actualCleanupCalls[1]![1]).toMatchObject({
      platform: 'claude',
      force: true,
      removeConfig: false,
    });
    expect(consoleDriver.views.some((view) =>
      view.lines.includes('备份：当前计划没有可备份项。'),
    )).toBe(true);
  });

  it('opens diagnose from the feature menu without asking for a target', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    diagnoseCommand.mockResolvedValue({
      output: 'misleading human output',
      pageModels: [{
        pluginName: 'git-commit',
        conclusion: '诊断完成',
        issues: [],
        locations: [],
        supplementalCommands: [],
      }],
    });
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        features: [feature('status'), feature('diagnose')],
      },
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'diagnose' },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(diagnoseCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        cwd: '/workspace',
      }),
      context,
    );
    expect(prompt.calls.some((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择目标',
    )).toBe(false);
    expect(consoleDriver.views.some((view) =>
      view.lines.some((line) => line.includes('诊断完成')),
    )).toBe(true);
    expect(consoleDriver.views.some((view) =>
      view.lines.some((line) => line.includes('misleading human output')),
    )).toBe(false);
  });

  it('renders diagnose supplemental commands without promoting them to ordinary features', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    diagnoseCommand.mockResolvedValue({
      output: 'raw output with JSON and debug log path',
      pageModels: [createDiagnosePage({
        supplementalCommands: [{
          command: 'aw cleanup --dependency-index --prune-stale token --yes',
          reason: '全局依赖索引有过期引用。',
        }],
      })],
    });
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        features: [feature('status'), feature('diagnose')],
      },
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'diagnose' },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const featurePrompt = prompt.calls.find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择功能',
    );
    expect((featurePrompt!.options as { choices: Array<{ value: string }> }).choices.map((choice) => choice.value))
      .not.toContain('cleanup');
    const diagnoseView = consoleDriver.views.find((view) => view.title === 'Git Commit 诊断');
    expect(diagnoseView?.lines).toEqual(expect.arrayContaining([
      '补充命令：',
      '- aw cleanup --dependency-index --prune-stale token --yes',
      '  全局依赖索引有过期引用。',
    ]));
    expect(JSON.stringify(consoleDriver.views)).not.toContain('raw output with JSON');
  });

  it('offers diagnose entries on the result page for abnormal targets', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    loadConsoleItems
      .mockResolvedValueOnce([item({
        summary: {
          status: 'notInstalled',
          statusLabel: '未安装',
          features: [feature('install'), feature('status'), feature('diagnose')],
        },
        locations: [location({
          status: 'notInstalled',
          statusLabel: '未安装',
          actions: [{ kind: 'openInstallWizard', label: '安装', target: { platform: 'codex', scope: 'user' } }],
        })],
      })])
      .mockResolvedValueOnce([item({
        summary: {
          status: 'abnormal',
          statusLabel: '异常',
          issueSummary: '安装后仍有异常。',
          features: [feature('repair'), feature('status'), feature('diagnose')],
        },
        locations: [location({
          status: 'abnormal',
          statusLabel: '异常',
          issueSummary: '安装后仍有异常。',
          actions: [{ kind: 'repairInstall', label: '修复安装', target: { platform: 'codex', scope: 'user' } }],
        })],
      })]);
    preparePluginTargetsForCommand.mockResolvedValue({
      ledger: { ledgerState: { status: 'available' } },
      targets: [{ pluginName: 'git-commit', plugin: plugin() }],
    });
    resolveSkillTriggerApplicabilityForPlugin.mockResolvedValue('fixed');
    createInstallWizardDecision.mockResolvedValue({
      blockedReason: undefined,
      configPrompts: [],
      commandAction: 'install',
    });
    installCommand.mockResolvedValue({
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
    });
    diagnoseCommand.mockResolvedValue({
      output: '',
      pageModels: [createDiagnosePage()],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'install' },
      { method: 'select', value: 'codex:user:-' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const resultPrompt = prompt.calls.find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '下一步',
    );
    expect(resultPrompt).toBeTruthy();
    expect((resultPrompt!.options as { choices: Array<{ label: string }> }).choices)
      .toContainEqual(expect.objectContaining({ label: '诊断 · Codex（个人）' }));
    expect(consoleDriver.views.some((view) =>
      view.title === 'Git Commit 诊断' &&
      view.lines.some((line) => line.includes('AW 记录和当前安装状态对不上')),
    )).toBe(true);
  });

  it('renders the status feature from the structured page model', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        status: 'abnormal',
        statusLabel: '异常',
        issueSummary: '同一平台同时存在两个可生效安装。',
        features: [feature('status'), feature('diagnose')],
      },
      locations: [location({
        status: 'abnormal',
        statusLabel: '异常',
        nextSteps: ['先卸载或清理其中一侧，再重新检查状态。'],
      })],
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'status' },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(statusCommand).not.toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({ verbose: true }),
      context,
    );
    expect(consoleDriver.views.some((view) =>
      view.title === 'Git Commit 状态' &&
      view.lines.some((line) => line.includes('同一平台同时存在两个可生效安装。')),
    )).toBe(true);
  });

  it.each([
    ['succeeded', '相关项目文件已更新。'],
    ['skipped', '没有需要重新应用的项目文件。'],
    ['failed', '重新应用配置失败。你可以进入诊断查看原因。'],
  ] as const)('renders reapply-config %s results without writing config', async (status, expectedLine) => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        status: 'abnormal',
        statusLabel: '异常',
        features: [feature('reapplyConfigRefresh'), feature('status'), feature('diagnose')],
      },
      locations: [location({
        status: 'abnormal',
        statusLabel: '异常',
        reasonCodes: ['artifactRefreshFailed'],
        actions: [{
          kind: 'reapplyConfigRefresh',
          label: '重新应用配置',
          target: { platform: 'codex', scope: 'user' },
        }],
      })],
    })]);
    preparePluginTargetsForCommand.mockResolvedValue({
      targets: [{ pluginName: 'git-commit', plugin: plugin() }],
    });
    reapplyConfigRefresh.mockResolvedValue({ status });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'reapplyConfigRefresh' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(consoleDriver.views.some((view) =>
      view.title === 'Git Commit 重新应用配置' &&
      view.lines.includes(expectedLine),
    )).toBe(true);
  });
});
