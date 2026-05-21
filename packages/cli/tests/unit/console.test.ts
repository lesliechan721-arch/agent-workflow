import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliExecutionContext } from '../../src/commands/runtime.js';
import type {
  ConsoleControllerItem,
  DiagnosePageModel,
  PluginConsoleConfigProjection,
  PluginConsoleFeatureSummary,
  PluginConsoleLocation,
  PluginConsoleSummary,
} from '../../src/commands/console-model.js';
import type { PluginMeta } from '../../src/types.js';
import { createFakeConsoleDriver, createFakePrompt } from '../helpers/fake-console.js';

const statusCommand = vi.fn();
const loadConsoleItems = vi.fn();
const loadConsoleItemsResult = vi.fn();
const diagnoseCommand = vi.fn();
const installCommand = vi.fn();
const upgradeCommand = vi.fn();
const uninstallCommand = vi.fn();
const cleanupCommand = vi.fn();
const isCleanupExecutionFailure = vi.fn((payload: {
  dependencyIndex?: boolean;
  dryRun?: boolean;
  blockingReasons?: unknown[];
  remainingItems?: unknown[];
}) =>
  payload.dependencyIndex !== true
  && payload.dryRun !== true
  && (
    (payload.blockingReasons?.length ?? 0) > 0
    || (payload.remainingItems?.length ?? 0) > 0
  ));
const repairCommand = vi.fn();
const reinstallCommand = vi.fn();
const preparePluginTargetsForCommand = vi.fn();
const createInstallWizardDecision = vi.fn();
const createConsoleConfigFormIdentity = vi.fn(async (options: { plugin: PluginMeta; form: { fields: Array<{ key: string }> }; platform: string }) =>
  `${options.plugin.manifest.name}\0${options.platform}\0${options.form.fields.map((field) => field.key).join(',')}`);
const planConsoleGraphWriteTargets = vi.fn();
const applyPluginConfigWrite = vi.fn();
const applyBuiltInConfigWrite = vi.fn();
const replayConfigRuntimeWrites = vi.fn();
const replayBuiltInConfigRuntime = vi.fn();
const resetPluginConfigWithHelper = vi.fn();
const reapplyConfigRefresh = vi.fn();
const resolveEffectivePluginConfig = vi.fn();
const readPluginConfigStore = vi.fn();

planConsoleGraphWriteTargets.mockImplementation(async (options: {
  targets: Array<{ pluginName: string }>;
  platforms: string[];
}) => ({
  requestedTargets: options.targets.map((target) => ({
    target,
    platform: options.platforms[0] ?? 'codex',
    scope: 'user',
    requested: true,
  })),
  writeTargets: options.targets.map((target) => ({
    target,
    platform: options.platforms[0] ?? 'codex',
    scope: 'user',
    requested: true,
    resolvedInstallOptions: undefined,
  })),
}));

vi.mock('../../src/commands/status.js', () => ({ statusCommand, loadConsoleItems, loadConsoleItemsResult }));
vi.mock('../../src/commands/diagnose.js', () => ({ diagnoseCommand }));
vi.mock('../../src/commands/install.js', () => ({ installCommand }));
vi.mock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));
vi.mock('../../src/commands/uninstall.js', () => ({ uninstallCommand }));
vi.mock('../../src/commands/cleanup.js', () => ({ cleanupCommand, isCleanupExecutionFailure }));
vi.mock('../../src/commands/repair.js', () => ({ repairCommand }));
vi.mock('../../src/commands/reinstall.js', () => ({ reinstallCommand }));
vi.mock('../../src/commands/common.js', () => ({ preparePluginTargetsForCommand }));
vi.mock('../../src/commands/console-wizard.js', () => ({
  createInstallWizardDecision,
  createConsoleConfigFormIdentity,
  planConsoleGraphWriteTargets,
}));
vi.mock('../../src/utils/plugin-config-write.js', () => ({
  applyPluginConfigWrite,
  applyBuiltInConfigWrite,
  replayConfigRuntimeWrites,
  replayBuiltInConfigRuntime,
  resetPluginConfigWithHelper,
}));
vi.mock('../../src/utils/artifact-refresh.js', () => ({ reapplyConfigRefresh }));
vi.mock('../../src/utils/plugin-config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/plugin-config.js')>('../../src/utils/plugin-config.js');
  return {
    ...actual,
    resolveEffectivePluginConfig,
    readPluginConfigStore,
  };
});

const tempDirs: string[] = [];

beforeEach(() => {
  loadConsoleItemsResult.mockImplementation(async (...args: Parameters<typeof loadConsoleItems>) => ({
    items: await loadConsoleItems(...args),
    catalogUnavailable: false,
  }));
});

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
      dependencies: '依赖',
      status: '查看状态',
      diagnose: '查看诊断',
    }[kind],
    targetSelection: kind === 'status' || kind === 'diagnose' || kind === 'dependencies'
      ? 'none'
      : 'singleTarget',
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

function configProjection(overrides: Partial<PluginConsoleConfigProjection> = {}): PluginConsoleConfigProjection {
  return {
    configSchemaVersion: 2,
    views: [{
      scope: 'effective',
      projectLayer: 'shared',
      fields: [],
      legacyConfigStores: [],
    }, {
      scope: 'user',
      projectLayer: 'shared',
      fields: [{
        key: 'token',
        title: 'token',
        kind: 'manifest',
        reserved: false,
        writable: true,
        valueState: 'default',
        effectiveValue: null,
        sourceLayer: null,
      }],
      legacyConfigStores: [],
    }],
    ...overrides,
  };
}

function item(overrides: {
  summary?: Partial<PluginConsoleSummary>;
  locations?: PluginConsoleLocation[];
  dependencyPage?: ConsoleControllerItem['dependencyPage'];
} = {}): ConsoleControllerItem {
  const builtSummary = summary(overrides.summary);
  const locations = overrides.locations ?? [location()];
  const recommendedKind = builtSummary.features.find((entry) =>
    entry.kind !== 'status' && entry.kind !== 'diagnose' && entry.kind !== 'dependencies'
  )?.kind;
  return {
    summary: builtSummary,
    pageItem: {
      summary: builtSummary,
      statusSymbol: builtSummary.status === 'abnormal' ? '!' : builtSummary.status === 'notInstalled' ? '○' : builtSummary.status === 'upgradeAvailable' ? '↑' : '✓',
      statusTone: builtSummary.status === 'abnormal' ? 'danger' : builtSummary.status === 'notInstalled' ? 'neutral' : 'success',
      platformSummary: builtSummary.locationSummary ?? 'Codex（个人）',
      ...(builtSummary.description ? { description: builtSummary.description } : {}),
      ...(builtSummary.version ? { version: builtSummary.version } : {}),
      ...(builtSummary.features.find((entry) => entry.kind !== 'status' && entry.kind !== 'diagnose')
        ? { primaryActionLabel: builtSummary.features.find((entry) => entry.kind !== 'status' && entry.kind !== 'diagnose')!.label }
        : {}),
    },
    detailPage: {
      summary: builtSummary,
      statusSymbol: builtSummary.status === 'abnormal' ? '!' : builtSummary.status === 'notInstalled' ? '○' : builtSummary.status === 'upgradeAvailable' ? '↑' : '✓',
      statusTone: builtSummary.status === 'abnormal' ? 'danger' : builtSummary.status === 'notInstalled' ? 'neutral' : builtSummary.status === 'upgradeAvailable' ? 'info' : 'success',
      platformSummary: builtSummary.locationSummary ?? 'Codex（个人）',
      platformDetails: locations.map((entry) => ({
        label: entry.locationLabel,
        status: entry.status,
        statusLabel: entry.statusLabel,
        statusSymbol: entry.status === 'abnormal' ? '!' : entry.status === 'notInstalled' ? '○' : entry.status === 'upgradeAvailable' ? '↑' : '✓',
        statusTone: entry.status === 'abnormal' ? 'danger' : entry.status === 'notInstalled' ? 'neutral' : entry.status === 'upgradeAvailable' ? 'info' : 'success',
      })),
      ...(overrides.dependencyPage?.summary ? { dependencySummary: overrides.dependencyPage.summary } : {}),
      featureMenu: builtSummary.features.map((entry) => ({
        ...entry,
        ...(entry.kind === recommendedKind ? { recommended: true } : {}),
      })),
      targetOptions: [],
    },
    locations,
    statusPage: {
      pluginName: builtSummary.pluginName,
      summary: builtSummary,
      locations: locations.map((entry) => ({
        key: `${entry.platform}:${entry.scope}:${entry.projectKey ?? '-'}`,
        platform: entry.platform,
        scope: entry.scope,
        ...(entry.projectKey ? { projectKey: entry.projectKey } : {}),
        label: entry.locationLabel,
        status: entry.status,
        statusLabel: entry.statusLabel,
        statusSymbol: entry.status === 'abnormal' ? '!' : entry.status === 'notInstalled' ? '○' : entry.status === 'upgradeAvailable' ? '↑' : '✓',
        statusTone: entry.status === 'abnormal' ? 'danger' : entry.status === 'notInstalled' ? 'neutral' : entry.status === 'upgradeAvailable' ? 'info' : 'success',
        hasEvidence: entry.status !== 'notInstalled',
        summary: entry.issueSummary ?? entry.statusLabel,
        issues: [],
        suggestedFeatures: [],
        nextSteps: entry.nextSteps,
        diagnostics: [],
      })),
    },
    ...(overrides.dependencyPage ? { dependencyPage: overrides.dependencyPage } : {}),
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
    recommendedCommand: 'aw cleanup git-commit -p codex -s user',
    nextSteps: [],
    ...overrides,
  };
}

function createContext(
  promptReplies: Parameters<typeof createFakePrompt>[0],
  options: {
    stdin?: NodeJS.ReadableStream;
  } = {},
) {
  const prompt = createFakePrompt(promptReplies);
  const consoleDriver = createFakeConsoleDriver();
  const stdin = options.stdin ?? new PassThrough();
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
    stdin,
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
    loadConsoleItemsResult.mockResolvedValue({
      items: [item()],
      catalogUnavailable: true,
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(consoleDriver.views[0]?.lines).toContain('插件目录不可用，仅显示已发现安装；恢复后可安装或升级。');
    expect(consoleDriver.views[0]?.lines.some((line) => line.includes('Git Commit'))).toBe(true);
  });

  it('loads the home page through a single consolidated status pass', async () => {
    loadConsoleItemsResult.mockResolvedValue({
      items: [item()],
      catalogUnavailable: false,
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context } = createContext([
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(loadConsoleItemsResult).toHaveBeenCalledTimes(1);
    expect(loadConsoleItemsResult).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/workspace',
        includeCatalogOnly: true,
      }),
      context,
    );
    expect(statusCommand).not.toHaveBeenCalled();
  });

  it('shows actionable agent version blockers on the read-only home page', async () => {
    loadConsoleItemsResult.mockResolvedValue({
      items: [item({
        summary: {
          agentVersionSummary: [{
            platform: 'codex',
            command: 'codex',
            status: 'tooOld',
            detectedVersion: '0.130.0',
            requiredMinVersion: '0.131.0',
            reasonCode: 'agentVersionTooLow',
            suggestedAction: '请将 Codex 升级到 >= 0.131.0 后重试。',
          }],
        },
      })],
      catalogUnavailable: false,
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(consoleDriver.views[0]?.lines).toContain(
      '  Codex 写入会被版本门禁阻断：当前 0.130.0，需要 >= 0.131.0。请将 Codex 升级到 >= 0.131.0 后重试。',
    );
    expect(installCommand).not.toHaveBeenCalled();
    expect(upgradeCommand).not.toHaveBeenCalled();
    expect(uninstallCommand).not.toHaveBeenCalled();
    expect(cleanupCommand).not.toHaveBeenCalled();
  });

  it('renders legacy config placeholders on home without install-style primary actions', async () => {
    const legacyConfig = {
      configSchemaVersion: 2,
      views: [{
        scope: 'effective',
        projectLayer: 'shared',
        fields: [],
        legacyConfigStores: [{
          plugin: 'legacy-plugin',
          storeKind: 'user',
          reason: 'pluginRemoved',
          fieldVisibility: 'storeOnly',
          cleanupOnly: true,
        }],
      }],
    } satisfies PluginConsoleConfigProjection;
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        pluginName: 'legacy-plugin',
        title: 'legacy-plugin',
        status: 'abnormal',
        statusLabel: '异常',
        locationSummary: '个人配置残留',
        installedLocations: [],
        features: [],
        reasonCodes: [],
        issueSummary: '检测到旧配置残留。',
        config: legacyConfig,
      },
      locations: [],
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(consoleDriver.views[0]?.lines).toContain('异常');
    expect(consoleDriver.views[0]?.lines.some((line) => line.includes('! legacy-plugin'))).toBe(true);
    expect(consoleDriver.views[0]?.lines.join('\n')).not.toContain('主操作：安装');
  });

  it('runs install from the feature menu and skips target selection for a single target', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
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
    expect(detailView?.lines).toContain('! 异常');
    expect(detailView?.lines).toContain('Git Commit 1.2.3');
    expect(detailView?.lines).toContain('帮助生成 commit 信息');
    expect(detailView?.lines).toContain('Codex（个人 + 当前项目）');
    expect(detailView?.lines).toContain('同一平台同时存在两个可生效安装。');
    expect(detailView?.lines.join('\n')).not.toContain('建议：');
    expect(detailView?.lines.join('\n')).not.toContain('aw ');

    const selectMessages = prompt.calls
      .filter((call) => call.method === 'select')
      .map((call) => (call.options as { message?: string }).message);
    expect(selectMessages).toContain('选择功能');
    expect(selectMessages).not.toContain('选择位置');
  });

  it('renders current catalog audit lines on the detail page', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    const auditedItem = item();
    auditedItem.statusPage.locations[0]!.diagnostics = [
      { label: '已安装版本', value: '1.0.0', tone: 'info' },
      { label: 'current catalog', value: '来源 remote · channel beta · catalog 1.1.0 · 插件 1.1.0 · 最低 CLI 1.0.0', tone: 'info' },
      { label: 'selector', value: '显式 channel beta', tone: 'info' },
    ];
    loadConsoleItems.mockResolvedValue([auditedItem]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', action: 'back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('已安装版本：1.0.0');
    expect(detailView?.lines).toContain('current catalog：来源 remote · channel beta · catalog 1.1.0 · 插件 1.1.0 · 最低 CLI 1.0.0');
    expect(detailView?.lines).toContain('selector：显式 channel beta');
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
      { method: 'select', value: 'keep' },
      { method: 'confirm', value: true },
      { method: 'select', action: 'exit' },
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

  it('selects install targets in platform-then-scope order and renders all-platform in Chinese', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
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
          scope: 'project',
          projectKey: '/workspace',
          locationLabel: 'Codex（当前项目）',
          status: 'notInstalled',
          statusLabel: '未安装',
          actions: [{ kind: 'openInstallWizard', label: '安装', target: { platform: 'codex', scope: 'project', projectKey: '/workspace' } }],
        }),
        location({
          platform: 'claude',
          locationLabel: 'Claude Code（个人）',
          status: 'notInstalled',
          statusLabel: '未安装',
          actions: [{ kind: 'openInstallWizard', label: '安装', target: { platform: 'claude', scope: 'user' } }],
        }),
      ],
    })]);
    preparePluginTargetsForCommand.mockResolvedValue({
      ledger: { ledgerState: { status: 'available' } },
      targets: [{ pluginName: 'git-commit', plugin: plugin() }],
    });
    planConsoleGraphWriteTargets.mockResolvedValue({
      requestedTargets: [{ target: { pluginName: 'git-commit', plugin: plugin() }, platform: 'claude', scope: 'user' }],
      writeTargets: [{ target: { pluginName: 'git-commit', plugin: plugin() }, platform: 'claude', scope: 'user', requested: true, resolvedInstallOptions: undefined }],
    });
    createInstallWizardDecision.mockResolvedValue({
      blockedReason: undefined,
      configPrompts: [],
      commandAction: 'install',
    });
    installCommand.mockResolvedValue({
      platforms: ['claude'],
      plugins: ['git-commit'],
      warnings: [],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'install' },
      { method: 'select', value: 'claude' },
      { method: 'select', value: 'user' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(prompt.calls
      .filter((call) => call.method === 'select')
      .map((call) => (call.options as { message?: string }).message))
      .toEqual(expect.arrayContaining(['选择平台', '选择位置']));
    const platformPrompt = prompt.calls.find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择平台',
    );
    expect((platformPrompt!.options as { choices: Array<{ value: string; label: string }> }).choices)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ value: 'codex', label: 'Codex' }),
        expect.objectContaining({ value: 'claude', label: 'Claude Code' }),
        expect.objectContaining({ value: '__all_platforms', label: '全部支持平台' }),
      ]));
    expect(installCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({ platform: 'claude', scope: 'user' }),
      context,
    );
  });

  it('runs all-platform install through the direct both-platform transaction', async () => {
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
        { target: preparedTarget, platform: 'codex', scope: 'user', requested: true },
        { target: preparedTarget, platform: 'claude', scope: 'user', requested: true },
      ],
      writeTargets: [
        { target: preparedTarget, platform: 'codex', scope: 'user', requested: true, resolvedInstallOptions: undefined },
        { target: preparedTarget, platform: 'claude', scope: 'user', requested: true, resolvedInstallOptions: undefined },
      ],
    });
    createInstallWizardDecision.mockResolvedValue({
      blockedReason: undefined,
      configPrompts: [],
      commandAction: 'install',
    });
    installCommand.mockResolvedValue({
      platforms: ['codex', 'claude'],
      plugins: ['git-commit'],
      warnings: [],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'install' },
      { method: 'select', value: '__all_platforms' },
      { method: 'select', value: 'user' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(planConsoleGraphWriteTargets).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'install',
      platforms: ['codex', 'claude'],
    }));
    expect(installCommand).toHaveBeenCalledTimes(1);
    expect(installCommand).toHaveBeenNthCalledWith(
      1,
      ['git-commit'],
      expect.objectContaining({ platform: 'both', scope: 'user' }),
      context,
    );
    expect(prompt.calls.some((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择触发方式',
    )).toBe(false);
  });

  it('cancels dependency confirmation before any install write', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    const preparedTarget = { pluginName: 'git-commit', plugin: plugin() };
    const dependencyTarget = { pluginName: 'skill-a', plugin: plugin() };
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        status: 'notInstalled',
        statusLabel: '未安装',
        supportedPlatforms: ['codex'],
        locationSummary: 'Codex',
        features: [feature('install'), feature('status'), feature('diagnose')],
      },
      locations: [
        location({
          status: 'notInstalled',
          statusLabel: '未安装',
          actions: [{ kind: 'openInstallWizard', label: '安装', target: { platform: 'codex', scope: 'user' } }],
        }),
      ],
    })]);
    preparePluginTargetsForCommand.mockResolvedValue({
      ledger: { ledgerState: { status: 'available' } },
      targets: [preparedTarget],
    });
    planConsoleGraphWriteTargets.mockResolvedValue({
      requestedTargets: [{ target: preparedTarget, platform: 'codex', scope: 'user', requested: true }],
      writeTargets: [
        { target: dependencyTarget, platform: 'codex', scope: 'user', requested: false, resolvedInstallOptions: undefined },
        { target: preparedTarget, platform: 'codex', scope: 'user', requested: true, resolvedInstallOptions: undefined },
      ],
      dependencyPlan: {
        writeOrder: [
          { plugin: 'skill-a', platform: 'codex', scope: 'user' },
          { plugin: 'git-commit', platform: 'codex', scope: 'user' },
        ],
      },
    });
    createInstallWizardDecision.mockResolvedValue({
      blockedReason: undefined,
      configPrompts: [],
      commandAction: 'install',
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'install' },
      { method: 'select', action: 'back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const dependencyPrompt = prompt.calls.find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '确认操作',
    );
    expect(dependencyPrompt).toBeTruthy();
    expect(installCommand).not.toHaveBeenCalled();
    expect(applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(consoleDriver.views.some((view) =>
      view.title === 'Git Commit 安装依赖确认' &&
      view.lines.some((line) => line.includes('会一并处理以下依赖')),
    )).toBe(true);
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

  it('supports config writes through the feature menu with explicit layer and field selection', async () => {
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
          config: {
            configSchemaVersion: 2,
            schema: {
              source: 'currentCatalog',
              identity: 'git-commit@1.0.0#schema',
              pluginVersion: '1.0.0',
              manifestDigest: 'sha256:config',
            },
            views: [{
              scope: 'effective',
              projectLayer: 'shared',
              fields: [],
              legacyConfigStores: [],
            }, {
              scope: 'project',
              projectLayer: 'shared',
              fields: [{
                key: 'token',
                title: 'token',
                kind: 'manifest',
                reserved: false,
                writable: true,
                valueState: 'default',
                effectiveValue: null,
                sourceLayer: null,
              }],
              legacyConfigStores: [],
            }],
          },
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
      updatedKeys: ['token'],
      removedKeys: [],
      artifactRefresh: { status: 'succeeded' },
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'configure' },
      { method: 'select', value: 'switch-view' },
      { method: 'select', value: 'project:shared' },
      { method: 'select', value: 'update-field' },
      { method: 'select', value: 'token' },
      { method: 'password', value: 'project-token' },
      { method: 'select', value: 'confirm' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(applyPluginConfigWrite).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'project',
      projectLayer: 'shared',
      request: {
        updates: {
          token: 'project-token',
        },
      },
    }));
  });

  it('renders config refresh failures without leaking artifact internals', async () => {
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
        config: {
          configSchemaVersion: 2,
          schema: {
            source: 'currentCatalog',
            identity: 'git-commit@1.0.0#schema',
            pluginVersion: '1.0.0',
            manifestDigest: 'sha256:config',
          },
          views: [{
            scope: 'effective',
            projectLayer: 'shared',
            fields: [],
            legacyConfigStores: [],
          }, {
            scope: 'user',
            projectLayer: 'shared',
            fields: [{
              key: 'token',
              title: 'token',
              kind: 'manifest',
              reserved: false,
              writable: true,
              valueState: 'default',
              effectiveValue: null,
              sourceLayer: null,
            }],
            legacyConfigStores: [],
          }],
        },
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
      { method: 'select', value: 'location:codex:user:-' },
      { method: 'select', value: 'switch-view' },
      { method: 'select', value: 'user:shared' },
      { method: 'select', value: 'update-field' },
      { method: 'select', value: 'token' },
      { method: 'input', value: 'secret' },
      { method: 'select', value: 'confirm' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(consoleDriver.views.some((view) =>
      view.lines.some((line) => line.includes('相关项目文件：刷新失败')))).toBe(true);
    expect(JSON.stringify(consoleDriver.views)).not.toContain('renderer stack trace');
    expect(reapplyConfigRefresh).not.toHaveBeenCalled();
  });

  it('asks for an explicit config target when multiple configure targets are available', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    preparePluginTargetsForCommand.mockResolvedValue({ targets: [] });
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        features: [feature('configure'), feature('status')],
        config: configProjection(),
      },
      locations: [
        location({
          actions: [{ kind: 'openConfigWizard', label: '配置', target: { platform: 'codex', scope: 'user' } }],
        }),
        location({
          platform: 'claude',
          locationLabel: 'Claude Code（个人）',
          actions: [{ kind: 'openConfigWizard', label: '配置', target: { platform: 'claude', scope: 'user' } }],
        }),
      ],
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'configure' },
      { method: 'select', value: 'location:claude:user:-' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(prompt.calls
      .filter((call) => call.method === 'select')
      .map((call) => (call.options as { message?: string }).message))
      .toContain('选择配置目标');
    expect(consoleDriver.views.some((view) => view.title === 'Git Commit 配置目标')).toBe(true);
  });

  it('renders store-only config targets without exposing raw keys or values', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    preparePluginTargetsForCommand.mockResolvedValue({ targets: [] });
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        status: 'abnormal',
        statusLabel: '异常',
        features: [feature('configure'), feature('status')],
        config: configProjection({
          views: [{
            scope: 'project',
            projectLayer: 'shared',
            fields: [],
            legacyConfigStores: [{
              plugin: 'git-commit',
              storeKind: 'projectShared',
              projectRoot: '/workspace',
              reason: 'schemaUnavailable',
              fieldVisibility: 'storeOnly',
              cleanupOnly: true,
            }],
          }],
        }),
      },
      locations: [],
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'configure' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const configView = consoleDriver.views.find((view) => view.title === 'Git Commit 配置');
    expect(configView?.lines).toContain('当前层存在 store-only 旧配置，只能整层清理。');
    expect(configView?.lines.join('\n')).not.toContain('legacy-secret');
    expect(configView?.lines.join('\n')).not.toContain('raw key');
  });

  it('shows schema conflict audit and blocks schema-aware config writes', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    preparePluginTargetsForCommand.mockResolvedValue({
      targets: [{
        pluginName: 'git-commit',
        plugin: plugin({
          schema: {
            token: { type: 'string', required: true },
          },
        }),
      }],
    });
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        features: [feature('configure'), feature('status')],
        config: {
          configSchemaVersion: 2,
          state: 'configSchemaConflict',
          issueMessage: 'git-commit 的同一配置 store 被多个已安装 consumer 使用，但 schema identity 不一致。',
          issueDetails: [
            'codex/user · 1.0.0 · schema-a',
            'claude/user · 1.1.0 · schema-b',
          ],
          catalog: {
            available: true,
            catalogVersion: '1.1.0',
            channel: 'beta',
          },
          views: [],
        },
      },
      locations: [location({
        actions: [{ kind: 'openConfigWizard', label: '配置', target: { platform: 'codex', scope: 'user' } }],
      })],
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'configure' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const configView = consoleDriver.views.find((view) => view.title === 'Git Commit 配置');
    expect(configView?.lines).toContain('当前状态：git-commit 的同一配置 store 被多个已安装 consumer 使用，但 schema identity 不一致。');
    expect(configView?.lines).toContain('- codex/user · 1.0.0 · schema-a');
    expect(configView?.lines).toContain('- claude/user · 1.1.0 · schema-b');

    const configActionPrompt = prompt.calls.find((call) =>
      call.method === 'select' && (call.options as { message?: string }).message === '配置操作');
    const labels = ((configActionPrompt?.options as { choices?: Array<{ label: string }> })?.choices ?? [])
      .map((choice) => choice.label);
    expect(labels).not.toContain('更新字段');
    expect(labels).not.toContain('清空字段');
    expect(labels).not.toContain('应用');
  });

  it('replays config from the config page without writing config stores', async () => {
    const configPlugin = plugin({
      schema: {
        token: { type: 'string', sensitive: true },
      },
    });
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        features: [feature('configure'), feature('status')],
        status: 'notInstalled',
        statusLabel: '未安装',
        config: configProjection(),
      },
      locations: [location({
        status: 'notInstalled',
        statusLabel: '未安装',
        actions: [{ kind: 'openConfigWizard', label: '配置', target: { platform: 'codex', scope: 'user' } }],
      })],
    })]);
    preparePluginTargetsForCommand.mockResolvedValue({
      targets: [{ pluginName: 'git-commit', plugin: configPlugin, currentPlugin: configPlugin }],
    });
    replayConfigRuntimeWrites.mockResolvedValue({
      artifactRefresh: { status: 'skipped' },
      targetResults: [],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'configure' },
      { method: 'select', value: 'apply-config' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(applyBuiltInConfigWrite).not.toHaveBeenCalled();
    expect(resetPluginConfigWithHelper).not.toHaveBeenCalled();
    expect(replayConfigRuntimeWrites).toHaveBeenCalledWith(expect.objectContaining({
      plugin: configPlugin,
      scope: 'user',
    }));
    expect(consoleDriver.views.some((view) =>
      view.title === 'Git Commit 应用配置' &&
      view.lines.some((line) => line.includes('当前没有可重放的 runtime 写入。')))).toBe(true);
  });

  it('defaults uninstalled personal preconfigure targets to the personal layer', async () => {
    const configPlugin = plugin({
      schema: {
        token: { type: 'string', sensitive: true },
      },
    });
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        features: [feature('configure'), feature('status')],
        status: 'notInstalled',
        statusLabel: '未安装',
        config: configProjection(),
      },
      locations: [location({
        status: 'notInstalled',
        statusLabel: '未安装',
        actions: [{ kind: 'openConfigWizard', label: '配置', target: { platform: 'codex', scope: 'user' } }],
      })],
    })]);
    preparePluginTargetsForCommand.mockResolvedValue({
      targets: [{ pluginName: 'git-commit', plugin: configPlugin, currentPlugin: configPlugin }],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'configure' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const configView = consoleDriver.views.find((view) => view.title === 'Git Commit 配置');
    expect(configView?.lines).toContain('作用层：个人');
  });

  it('splits same-store config writes into separate groups when form identity differs', async () => {
    const configPlugin = plugin({
      schema: {
        token: { type: 'string', sensitive: true },
      },
    });
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        features: [feature('configure'), feature('status')],
        config: configProjection(),
      },
      locations: [
        location({
          actions: [{ kind: 'openConfigWizard', label: '配置', target: { platform: 'codex', scope: 'user' } }],
        }),
        location({
          platform: 'claude',
          locationLabel: 'Claude Code（个人）',
          actions: [{ kind: 'openConfigWizard', label: '配置', target: { platform: 'claude', scope: 'user' } }],
        }),
      ],
    })]);
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
    createConsoleConfigFormIdentity
      .mockResolvedValueOnce('form-codex')
      .mockResolvedValueOnce('form-claude');
    applyPluginConfigWrite
      .mockResolvedValueOnce({
        updatedKeys: ['token'],
        removedKeys: [],
        artifactRefresh: { status: 'skipped' },
        targetResults: [{
          target: { pluginName: 'git-commit', platform: 'codex', scope: 'user' },
          action: 'configApply',
          state: 'notRun',
          message: '当前没有可重放的 runtime 写入。',
        }],
      })
      .mockResolvedValueOnce({
        updatedKeys: ['token'],
        removedKeys: [],
        artifactRefresh: { status: 'skipped' },
        targetResults: [{
          target: { pluginName: 'git-commit', platform: 'claude', scope: 'user' },
          action: 'configApply',
          state: 'notRun',
          message: '当前没有可重放的 runtime 写入。',
        }],
      });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'configure' },
      { method: 'select', value: 'location:codex:user:-' },
      { method: 'select', value: 'switch-view' },
      { method: 'select', value: 'user:shared' },
      { method: 'select', value: 'update-field' },
      { method: 'select', value: 'token' },
      { method: 'password', value: 'codex-secret' },
      { method: 'select', value: 'confirm' },
      { method: 'password', value: 'claude-secret' },
      { method: 'select', value: 'confirm' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(applyPluginConfigWrite).toHaveBeenCalledTimes(2);
    expect(applyPluginConfigWrite).toHaveBeenNthCalledWith(1, expect.objectContaining({
      applyTargets: [{
        pluginName: 'git-commit',
        platform: 'codex',
        scope: 'user',
      }],
      request: {
        updates: {
          token: 'codex-secret',
        },
      },
    }));
    expect(applyPluginConfigWrite).toHaveBeenNthCalledWith(2, expect.objectContaining({
      applyTargets: [{
        pluginName: 'git-commit',
        platform: 'claude',
        scope: 'user',
      }],
      request: {
        updates: {
          token: 'claude-secret',
        },
      },
    }));
    expect(consoleDriver.views.some((view) =>
      view.lines.some((line) => line.includes('个人配置 · Codex（个人）')))).toBe(true);
    expect(consoleDriver.views.some((view) =>
      view.lines.some((line) => line.includes('个人配置 · Claude Code（个人）')))).toBe(true);
  });

  it('shows helper-provided per-target config apply results on the detail page', async () => {
    const configPlugin = plugin({
      schema: {
        token: { type: 'string', sensitive: true },
      },
    });
    const configuredItem = item({
      summary: {
        features: [feature('configure'), feature('status')],
        config: configProjection(),
      },
      locations: [
        location({
          actions: [{ kind: 'openConfigWizard', label: '配置', target: { platform: 'codex', scope: 'user' } }],
        }),
        location({
          platform: 'claude',
          locationLabel: 'Claude Code（个人）',
          actions: [{ kind: 'openConfigWizard', label: '配置', target: { platform: 'claude', scope: 'user' } }],
        }),
      ],
    });
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([configuredItem]);
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
    createConsoleConfigFormIdentity.mockResolvedValue('shared-form');
    applyPluginConfigWrite.mockResolvedValue({
      updatedKeys: ['token'],
      removedKeys: [],
      artifactRefresh: { status: 'skipped' },
      targetResults: [
        {
          target: { pluginName: 'git-commit', platform: 'codex', scope: 'user' },
          action: 'configApply',
          state: 'completed',
        },
        {
          target: { pluginName: 'git-commit', platform: 'claude', scope: 'user' },
          action: 'configApply',
          state: 'notRun',
          message: '当前 target 没有可重放的 dynamic artifact。',
        },
      ],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'configure' },
      { method: 'select', value: 'location:codex:user:-' },
      { method: 'select', value: 'switch-view' },
      { method: 'select', value: 'user:shared' },
      { method: 'select', value: 'update-field' },
      { method: 'select', value: 'token' },
      { method: 'password', value: 'shared-secret' },
      { method: 'select', value: 'confirm' },
      { method: 'select', value: 'result-home' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const detailView = consoleDriver.views.find((view) =>
      view.title === 'Git Commit' &&
      view.lines.includes('最近结果 · 配置'));
    expect(detailView?.lines).toContain('- Codex（个人） · 已完成');
    expect(detailView?.lines).toContain('- Claude Code（个人） · 未执行：当前 target 没有可重放的 dynamic artifact。');
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
        dryRun: true,
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
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(cleanupCommand).toHaveBeenCalledTimes(1);
    expect(cleanupCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({ plan: true, removeConfig: false }),
      context,
    );
    const planView = consoleDriver.views.find((view) => view.title === 'Git Commit 清理计划');
    expect(planView?.lines).toEqual(expect.arrayContaining([
      'Codex：',
      '- Codex（个人） · 已评估',
      '  cleanup 评估完成：git-commit。',
      '  目标类型：installed。',
      '  force 语义：未启用；需要降级清理。',
      '  计划删除项：',
      '  - 安装记录',
      '  备份项：',
      '  - 历史 runtime',
      '  受影响依赖：',
      '  - codex/user/consumer',
      '  阻断原因：',
      '  - [foreign] 外部归属未确认。',
    ]));
    expect(consoleDriver.views.some((view) => view.title === 'Git Commit 清理风险')).toBe(false);
    expect(consoleDriver.views.some((view) =>
      view.lines.includes('已取消，本次没有写入任何状态。'),
    )).toBe(true);
  });

  it('shows the full target list before confirming destructive all-platform uninstall', async () => {
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
          actions: [{
            kind: 'runUninstall',
            label: '卸载',
            target: { platform: 'codex', scope: 'user' },
            destructive: true,
            confirmText: 'remove codex?',
          }],
        }),
        location({
          platform: 'claude',
          locationLabel: 'Claude Code（个人）',
          actions: [{
            kind: 'runUninstall',
            label: '卸载',
            target: { platform: 'claude', scope: 'user' },
            destructive: true,
            confirmText: 'remove claude?',
          }],
        }),
      ],
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'uninstall' },
      { method: 'select', value: '__all_platforms' },
      { method: 'select', value: 'user' },
      { method: 'select', value: 'keep' },
      { method: 'confirm', value: false },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const confirmView = consoleDriver.views.find((view) => view.title === 'Git Commit 确认');
    expect(confirmView?.lines).toEqual(expect.arrayContaining([
      '即将执行：卸载',
      '目标：',
      '- Codex（个人）',
      '- Claude Code（个人）',
    ]));
    expect(uninstallCommand).not.toHaveBeenCalled();
  });

  it('removes grouped config only after all-platform cleanup succeeds for the same store', async () => {
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

    const root = await makeTempDir('aw-console-cleanup-remove-config-');
    const cwd = path.join(root, 'workspace');
    const awHome = path.join(root, 'aw-home');
    await fs.ensureDir(cwd);
    const { resolvePluginConfigStorePath } = await import('../../src/utils/plugin-config.js');
    const configStorePath = resolvePluginConfigStorePath({
      pluginName: 'git-commit',
      scope: 'user',
      cwd,
      env: { AW_HOME: awHome },
    });
    await fs.outputJson(configStorePath, { token: 'keep-me-until-done' }, { spaces: 2 });

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
    context.cwd = cwd;
    context.env = { AW_HOME: awHome } as NodeJS.ProcessEnv;

    await expect(runConsoleController(context)).resolves.toBe(0);
    const plannedCleanupCalls = cleanupCommand.mock.calls.filter(([, options]) =>
      (options as { plan?: boolean }).plan === true,
    );
    expect(plannedCleanupCalls).toHaveLength(2);
    expect(plannedCleanupCalls[0]![1]).toMatchObject({
      platform: 'codex',
      removeConfig: true,
    });
    expect(plannedCleanupCalls[1]![1]).toMatchObject({
      platform: 'claude',
      removeConfig: false,
    });

    const actualCleanupCalls = cleanupCommand.mock.calls.filter(([, options]) =>
      (options as { plan?: boolean }).plan !== true,
    );
    expect(actualCleanupCalls).toHaveLength(1);
    expect(actualCleanupCalls[0]![1]).toMatchObject({
      platform: 'both',
      force: true,
      removeConfig: false,
    });
    await expect(fs.pathExists(configStorePath)).resolves.toBe(false);
    const riskView = consoleDriver.views.find((view) => view.title === 'Git Commit 清理风险');
    expect(riskView?.lines).toEqual(expect.arrayContaining([
      'Codex：',
      '- Codex（个人） · 已评估',
      'Claude Code：',
      '- Claude Code（个人） · 已评估',
    ]));
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('最近结果 · 清理');
    expect(detailView?.lines).toContain('- 个人 AW 自管配置 · 已删除 · 主体：Codex（个人）、Claude Code（个人）');
  });

  it('keeps grouped config when all-platform uninstall fails before partial writes', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
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
          actions: [{
            kind: 'runUninstall',
            label: '卸载',
            target: { platform: 'codex', scope: 'user' },
            destructive: true,
            confirmText: 'remove codex?',
          }],
        }),
        location({
          platform: 'claude',
          locationLabel: 'Claude Code（个人）',
          actions: [{
            kind: 'runUninstall',
            label: '卸载',
            target: { platform: 'claude', scope: 'user' },
            destructive: true,
            confirmText: 'remove claude?',
          }],
        }),
      ],
    })]);
    uninstallCommand.mockImplementation(async (_plugins: string[], options: { platform?: string }) => {
      if (options.platform === 'both') {
        throw new Error('claude version too low');
      }
      return {
        platforms: [options.platform ?? 'codex'],
        plugins: ['git-commit'],
        warnings: [],
      };
    });

    const root = await makeTempDir('aw-console-uninstall-remove-config-');
    const cwd = path.join(root, 'workspace');
    const awHome = path.join(root, 'aw-home');
    await fs.ensureDir(cwd);
    const { resolvePluginConfigStorePath } = await import('../../src/utils/plugin-config.js');
    const configStorePath = resolvePluginConfigStorePath({
      pluginName: 'git-commit',
      scope: 'user',
      cwd,
      env: { AW_HOME: awHome },
    });
    await fs.outputJson(configStorePath, { token: 'keep-me' }, { spaces: 2 });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'uninstall' },
      { method: 'select', value: '__all_platforms' },
      { method: 'select', value: 'user' },
      { method: 'select', value: 'remove' },
      { method: 'confirm', value: true },
      { method: 'select', action: 'exit' },
    ]);
    context.cwd = cwd;
    context.env = { AW_HOME: awHome } as NodeJS.ProcessEnv;

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(uninstallCommand).toHaveBeenCalledTimes(1);
    expect(uninstallCommand).toHaveBeenNthCalledWith(
      1,
      ['git-commit'],
      expect.objectContaining({ platform: 'both', removeConfig: false }),
      context,
    );
    await expect(fs.pathExists(configStorePath)).resolves.toBe(true);
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('最近结果 · 卸载');
    expect(detailView?.lines).toContain('- 个人 AW 自管配置 · 已保留 · 主体：Codex（个人）、Claude Code（个人）：已保留当前用户的 AW 自管配置；同一配置位置仍有主体失败。');
  });

  it('resolves duplicate installs through cleanup and returns to the plugin detail with the latest result', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        status: 'abnormal',
        statusLabel: '异常',
        locationSummary: 'Codex（个人 + 当前项目）',
        duplicateInstallGroups: [{
          pluginName: 'git-commit',
          platform: 'codex',
          locations: [
            {
              platform: 'codex',
              scope: 'user',
              label: 'Codex（个人）',
              status: 'abnormal',
              statusLabel: '异常',
              reasonCodes: ['duplicateInstall'],
              nextSteps: [],
            },
            {
              platform: 'codex',
              scope: 'project',
              projectKey: '/workspace',
              label: 'Codex（当前项目）',
              status: 'abnormal',
              statusLabel: '异常',
              reasonCodes: ['duplicateInstall'],
              nextSteps: [],
            },
          ],
        }],
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
    cleanupCommand.mockImplementation(async (_plugins: string[], options: { plan?: boolean; scope?: string }) => ({
      payload: cleanupPayload({
        dryRun: options.plan === true,
        target: {
          plugin: 'git-commit',
          platform: 'codex',
          scope: (options.scope ?? 'project') as 'project',
          projectKey: '/workspace',
          targetType: 'installed',
        },
        plannedRemovals: [{ kind: 'record', label: '安装记录' }],
        ...(options.plan
          ? {}
          : { actualRemovals: [{ kind: 'record', label: '安装记录' }] }),
      }),
      warnings: [],
    }));

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'resolveDuplicateInstall' },
      { method: 'select', value: 'codex:user:-' },
      { method: 'confirm', value: true },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(uninstallCommand).not.toHaveBeenCalled();
    expect(cleanupCommand).toHaveBeenCalledTimes(2);
    expect(cleanupCommand).toHaveBeenNthCalledWith(
      1,
      ['git-commit'],
      expect.objectContaining({
        scope: 'project',
        platform: 'codex',
        plan: true,
        removeConfig: false,
      }),
      context,
    );
    expect(cleanupCommand).toHaveBeenNthCalledWith(
      2,
      ['git-commit'],
      expect.objectContaining({
        scope: 'project',
        platform: 'codex',
        force: false,
        removeConfig: false,
      }),
      context,
    );
    expect(consoleDriver.views.some((view) => view.title === 'Git Commit 重复安装处理计划')).toBe(true);
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('最近结果 · 处理重复安装');
    expect(detailView?.lines).toContain('- Codex（当前项目） · 已完成');
  });

  it('fails all-platform installs as one direct transaction and keeps status available for failed targets', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    loadConsoleItems
      .mockResolvedValueOnce([item({
        summary: {
          status: 'notInstalled',
          statusLabel: '未安装',
          supportedPlatforms: ['codex', 'claude'],
          locationSummary: 'Codex、Claude Code',
          features: [feature('install', { targetSelection: 'multiTargetAllowed' }), feature('status'), feature('diagnose')],
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
      })])
      .mockResolvedValueOnce([item({
        summary: {
          status: 'installed',
          statusLabel: '已安装',
          supportedPlatforms: ['codex', 'claude'],
          locationSummary: 'Claude Code（个人）',
          features: [feature('status'), feature('diagnose')],
        },
        locations: [
          location({
            status: 'notInstalled',
            statusLabel: '未安装',
            actions: [],
          }),
          location({
            platform: 'claude',
            locationLabel: 'Claude Code（个人）',
            status: 'installed',
            statusLabel: '已安装',
            actions: [],
          }),
        ],
      })]);
    preparePluginTargetsForCommand.mockResolvedValue({
      ledger: { ledgerState: { status: 'available' } },
      targets: [{ pluginName: 'git-commit', plugin: plugin() }],
    });
    createInstallWizardDecision.mockResolvedValue({
      blockedReason: undefined,
      configPrompts: [],
      commandAction: 'install',
    });
    installCommand.mockImplementation(async (_plugins: string[], options: { platform?: string }) => {
      if (options.platform === 'both') {
        throw new Error('codex install failed');
      }
      return {
        platforms: [options.platform ?? 'codex'],
        plugins: ['git-commit'],
        warnings: [],
      };
    });
    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'install' },
      { method: 'select', value: '__all_platforms' },
      { method: 'select', value: 'user' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(installCommand).toHaveBeenCalledTimes(1);
    expect(installCommand).toHaveBeenNthCalledWith(
      1,
      ['git-commit'],
      expect.objectContaining({ platform: 'both', scope: 'user' }),
      context,
    );
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('最近结果 · 安装');
    expect(detailView?.lines).toContain('- Codex（个人） · 失败：codex install failed');
    expect(detailView?.lines).toContain('- Claude Code（个人） · 失败：codex install failed');
  });

  it('renders cleanup failure when actual cleanup still has skipped items and remaining items', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
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
    cleanupCommand.mockImplementation(async (_plugins: string[], options: { plan?: boolean }) => ({
      payload: cleanupPayload(options.plan
        ? {
            dryRun: true,
            plannedRemovals: [{ kind: 'record', label: '计划删除的记录' }],
            wouldBackups: [{ kind: 'backup', label: '计划备份' }],
          }
        : {
            dryRun: false,
            force: true,
            actualRemovals: [{ kind: 'record', label: '真正删除的记录' }],
            actualBackups: [{ kind: 'backup', label: '真正生成的备份' }],
            skippedItems: [{ kind: 'skip', label: '跳过的条目' }],
            remainingItems: [{ kind: 'remain', label: '仍然保留的条目' }],
            plannedRemovals: [{ kind: 'record', label: '计划删除的记录' }],
          }),
      warnings: [],
    }));

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'cleanup' },
      { method: 'select', value: 'keep' },
      { method: 'confirm', value: true },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('最近结果 · 清理');
    expect(detailView?.lines).toContain('- Codex（个人） · 失败');
  });

  it('shows affected dependents in the cleanup force flow and executes the confirmed force cleanup', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
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
    cleanupCommand.mockImplementation(async (_plugins: string[], options: { plan?: boolean; force?: boolean }) => ({
      payload: cleanupPayload(options.plan
        ? {
            dryRun: true,
            force: false,
            forceReason: '目标仍被 verified dependents 引用，`--force` 会保留 dependent 本身，只清理当前目标；这些 dependent 后续可能需要 repair、reinstall 或 cleanup。',
            affectedDependents: [{
              plugin: 'helper-local-dependent',
              platform: 'codex',
              scope: 'user',
            }],
            blockingReasons: [{
              code: 'verifiedDependents',
              message: '目标仍被 helper-local-dependent 引用。',
            }],
          }
        : {
            dryRun: false,
            force: true,
            forceReason: '目标仍被 verified dependents 引用，`--force` 会保留 dependent 本身，只清理当前目标；这些 dependent 后续可能需要 repair、reinstall 或 cleanup。',
            affectedDependents: [{
              plugin: 'helper-local-dependent',
              platform: 'codex',
              scope: 'user',
            }],
            actualRemovals: [{ kind: 'record', label: '真正删除的记录' }],
            remainingItems: [],
          }),
      warnings: [],
    }));

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'cleanup' },
      { method: 'select', value: 'keep' },
      { method: 'confirm', value: true },
      { method: 'confirm', value: true },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(cleanupCommand).toHaveBeenNthCalledWith(2, ['git-commit'], expect.objectContaining({
      force: true,
      removeConfig: false,
    }), expect.anything());
    const riskView = consoleDriver.views.find((view) => view.title === 'Git Commit 清理风险');
    expect(riskView?.lines.join('\n')).toContain('受影响依赖：');
    expect(riskView?.lines.join('\n')).toContain('helper-local-dependent');
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('最近结果 · 清理');
  });

  it('renders reinstall outcome lines with a reinstall headline instead of an install headline', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    reinstallCommand.mockResolvedValue({
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
    });
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        status: 'abnormal',
        statusLabel: '异常',
        features: [feature('reinstall', { destructive: true }), feature('status'), feature('diagnose')],
      },
      locations: [location({
        status: 'abnormal',
        statusLabel: '异常',
        actions: [{
          kind: 'runReinstall',
          label: '重新安装',
          target: { platform: 'codex', scope: 'user' },
          destructive: true,
          confirmText: 'reinstall?',
        }],
      })],
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'reinstall' },
      { method: 'confirm', value: true },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('最近结果 · 重新安装');
    expect(detailView?.lines).not.toContain('最近结果 · 安装');
  });

  it.each([
    {
      name: 'repair',
      featureKind: 'repair',
      expectedLabel: '最近结果 · 修复安装',
      replies: [
        { method: 'select', value: 'git-commit' },
        { method: 'select', value: 'repair' },
        { method: 'select', action: 'exit' },
      ],
      setup() {
        repairCommand.mockResolvedValue({ output: 'repair done' });
        return item({
          summary: {
            status: 'abnormal',
            statusLabel: '异常',
            features: [feature('repair'), feature('status'), feature('diagnose')],
          },
          locations: [location({
            status: 'abnormal',
            statusLabel: '异常',
            actions: [{ kind: 'repairInstall', label: '修复安装', target: { platform: 'codex', scope: 'user' } }],
          })],
        });
      },
    },
    {
      name: 'reinstall',
      featureKind: 'reinstall',
      expectedLabel: '最近结果 · 重新安装',
      replies: [
        { method: 'select', value: 'git-commit' },
        { method: 'select', value: 'reinstall' },
        { method: 'confirm', value: true },
        { method: 'select', action: 'exit' },
      ],
      setup() {
        reinstallCommand.mockResolvedValue({
          platforms: ['codex'],
          plugins: ['git-commit'],
          warnings: [],
        });
        return item({
          summary: {
            status: 'abnormal',
            statusLabel: '异常',
            features: [feature('reinstall', { destructive: true }), feature('status'), feature('diagnose')],
          },
          locations: [location({
            status: 'abnormal',
            statusLabel: '异常',
            actions: [{
              kind: 'runReinstall',
              label: '重新安装',
              target: { platform: 'codex', scope: 'user' },
              destructive: true,
              confirmText: 'reinstall?',
            }],
          })],
        });
      },
    },
    {
      name: 'adoptExisting',
      featureKind: 'adoptExisting',
      expectedLabel: '最近结果 · 认领现有安装',
      replies: [
        { method: 'select', value: 'git-commit' },
        { method: 'select', value: 'adoptExisting' },
        { method: 'confirm', value: true },
        { method: 'select', action: 'exit' },
      ],
      setup() {
        repairCommand.mockResolvedValue({ output: 'adopt done' });
        return item({
          summary: {
            status: 'abnormal',
            statusLabel: '异常',
            features: [feature('adoptExisting', { destructive: true }), feature('status'), feature('diagnose')],
          },
          locations: [location({
            status: 'abnormal',
            statusLabel: '异常',
            reasonCodes: ['adoptableInstall'],
            actions: [{
              kind: 'runAdoptExisting',
              label: '认领现有安装',
              target: { platform: 'codex', scope: 'user' },
              destructive: true,
              confirmText: 'adopt?',
            }],
          })],
        });
      },
    },
    {
      name: 'takeoverSharedRuntime',
      featureKind: 'takeoverSharedRuntime',
      expectedLabel: '最近结果 · 接管共享触发策略',
      replies: [
        { method: 'select', value: 'git-commit' },
        { method: 'select', value: 'takeoverSharedRuntime' },
        { method: 'confirm', value: true },
        { method: 'select', action: 'exit' },
      ],
      setup() {
        repairCommand.mockResolvedValue({ output: 'takeover done' });
        return item({
          summary: {
            status: 'abnormal',
            statusLabel: '异常',
            features: [feature('takeoverSharedRuntime', { destructive: true }), feature('status'), feature('diagnose')],
          },
          locations: [location({
            status: 'abnormal',
            statusLabel: '异常',
            reasonCodes: ['foreignOwnershipConflict'],
            actions: [{
              kind: 'runTakeoverSharedRuntime',
              label: '接管共享触发策略',
              target: { platform: 'codex', scope: 'user' },
              destructive: true,
              confirmText: 'takeover?',
            }],
          })],
        });
      },
    },
  ] as const)('returns to the detail page with the latest result for $name', async ({ setup, replies, expectedLabel }) => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([setup()]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt, consoleDriver } = createContext(replies as Parameters<typeof createFakePrompt>[0]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(prompt.calls.some((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '下一步',
    )).toBe(false);
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain(expectedLabel);
  });

  it('keeps only the latest result on the detail page after multiple writes', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        status: 'abnormal',
        statusLabel: '异常',
        features: [
          feature('repair'),
          feature('reinstall', { destructive: true }),
          feature('status'),
        ],
      },
      locations: [location({
        status: 'abnormal',
        statusLabel: '异常',
        actions: [
          { kind: 'repairInstall', label: '修复安装', target: { platform: 'codex', scope: 'user' } },
          {
            kind: 'runReinstall',
            label: '重新安装',
            target: { platform: 'codex', scope: 'user' },
            destructive: true,
            confirmText: 'reinstall?',
          },
        ],
      })],
    })]);
    repairCommand.mockResolvedValue({ output: 'repair done' });
    reinstallCommand.mockResolvedValue({
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'repair' },
      { method: 'select', value: 'reinstall' },
      { method: 'confirm', value: true },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('最近结果 · 重新安装');
    expect(detailView?.lines).not.toContain('最近结果 · 修复安装');
  });

  it('refreshes the plugin detail after upgrade and drops the stale upgrade state', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    loadConsoleItems
      .mockResolvedValueOnce([item({
        summary: {
          status: 'upgradeAvailable',
          statusLabel: '可升级',
          features: [feature('upgrade'), feature('status'), feature('diagnose')],
        },
        locations: [location({
          status: 'upgradeAvailable',
          statusLabel: '可升级',
          actions: [{ kind: 'runUpgrade', label: '升级', target: { platform: 'codex', scope: 'user' } }],
        })],
      })])
      .mockResolvedValueOnce([item({
        summary: {
          status: 'installed',
          statusLabel: '已安装',
          features: [feature('status'), feature('diagnose')],
        },
        locations: [location({
          status: 'installed',
          statusLabel: '已安装',
          actions: [],
        })],
      })]);
    preparePluginTargetsForCommand.mockResolvedValue({
      ledger: { ledgerState: { status: 'available' } },
      targets: [{ pluginName: 'git-commit', plugin: plugin() }],
    });
    planConsoleGraphWriteTargets.mockResolvedValue({
      requestedTargets: [{ target: { pluginName: 'git-commit', plugin: plugin() }, platform: 'codex', scope: 'user', requested: true }],
      writeTargets: [{ target: { pluginName: 'git-commit', plugin: plugin() }, platform: 'codex', scope: 'user', requested: true, resolvedInstallOptions: undefined }],
    });
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
    const { context, prompt, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'upgrade' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('✓ 已安装');
    expect(detailView?.lines).not.toContain('↑ 可升级');
    const featurePrompt = [...prompt.calls].reverse().find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择功能',
    );
    expect((featurePrompt!.options as { choices: Array<{ value: string }> }).choices.map((choice) => choice.value))
      .not.toContain('upgrade');
  });

  it('records a deferred exit request during a write and exits only after the write finishes', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
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
    })]);
    preparePluginTargetsForCommand.mockResolvedValue({
      ledger: { ledgerState: { status: 'available' } },
      targets: [{ pluginName: 'git-commit', plugin: plugin() }],
    });
    createInstallWizardDecision.mockResolvedValue({
      blockedReason: undefined,
      configPrompts: [],
      commandAction: 'install',
    });
    let resolveInstall: (() => void) | undefined;
    installCommand.mockImplementation(async () => new Promise<void>((resolve) => {
      resolveInstall = resolve;
    }).then(() => ({
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
    })));

    const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
    stdin.isTTY = true;
    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'install' },
    ], { stdin });

    const controllerPromise = runConsoleController(context);
    await vi.waitFor(() => {
      expect(consoleDriver.views.some((view) => view.title === 'Git Commit 安装中')).toBe(true);
    });
    stdin.write('q');
    await vi.waitFor(() => {
      expect(consoleDriver.views.some((view) =>
        view.title === 'Git Commit 安装中' &&
        view.lines.includes('已收到退出请求；当前操作完成后会安全退出。'),
      )).toBe(true);
    });
    resolveInstall?.();

    await expect(controllerPromise).resolves.toBe(0);
    expect(installCommand).toHaveBeenCalledTimes(1);
    expect(prompt.calls
      .filter((call) => call.method === 'select')
      .map((call) => (call.options as { message?: string }).message))
      .toEqual(['选择插件', '选择功能']);
  });

  it('opens status from the feature menu without asking for a target', async () => {
    statusCommand
      .mockResolvedValueOnce(createBaseStatusResult())
      .mockResolvedValueOnce(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        features: [feature('status'), feature('diagnose')],
      },
      locations: [location({
        status: 'abnormal',
        statusLabel: '异常',
        issueSummary: '安装后仍有异常。',
        nextSteps: ['先修复安装，再重新检查状态。'],
      })],
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'status' },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(prompt.calls.some((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择目标',
    )).toBe(false);
    expect(consoleDriver.views.some((view) => view.title === 'Git Commit 状态')).toBe(true);
  });

  it('loads verbose read details before showing Codex native view diagnostics', async () => {
    const homeItem = item({
      summary: {
        features: [feature('status'), feature('diagnose')],
      },
    });
    const detailItem = item({
      summary: {
        features: [feature('status'), feature('diagnose')],
      },
    });
    detailItem.statusPage.locations[0]!.diagnostics = [{
      label: 'Codex native view',
      value: 'nativeViewUnknown via plugin/read',
      tone: 'info',
    }];
    loadConsoleItemsResult
      .mockResolvedValueOnce({ items: [homeItem], catalogUnavailable: false })
      .mockResolvedValueOnce({ items: [detailItem], catalogUnavailable: false });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'status' },
      { method: 'select', value: 'codex:user:-' },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(loadConsoleItemsResult).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ verbose: true, includeCatalogOnly: true }),
      context,
    );
    expect(consoleDriver.views.some((view) =>
      view.title === 'Git Commit 状态' &&
      view.lines.includes('Codex native view：nativeViewUnknown via plugin/read'),
    )).toBe(true);
  });

  it('hides the legacy diagnose entry from the feature menu', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        features: [feature('status'), feature('diagnose')],
      },
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'status' },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const featurePrompt = prompt.calls.find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择功能',
    );
    expect((featurePrompt!.options as { choices: Array<{ value: string }> }).choices.map((choice) => choice.value))
      .not.toContain('diagnose');
    expect((featurePrompt!.options as { choices: Array<{ value: string }> }).choices.map((choice) => choice.value))
      .not.toContain('cleanup');
  });

  it('opens the dependency page from the feature menu when dependency data is present', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        features: [feature('dependencies'), feature('status')],
      },
      dependencyPage: {
        pluginName: 'git-commit',
        groups: [{
          platform: 'codex',
          scope: 'user',
          label: 'Codex（个人）',
          entries: [{
            pluginName: 'helper-plugin',
            locationLabel: 'Codex（个人）',
            symbol: '✓',
            tone: 'success',
            summary: '正常',
          }],
        }],
      },
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'dependencies' },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(consoleDriver.views.some((view) =>
      view.title === 'Git Commit 依赖' &&
      view.lines.some((line) => line.includes('helper-plugin')),
    )).toBe(true);
  });

  it('shows the latest result on the detail page and keeps status available for abnormal targets', async () => {
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
    const { context, prompt, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'install' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('最近结果 · 安装');
    expect(detailView?.lines).toContain('- Codex（个人） · 已完成');
    const featurePrompt = [...prompt.calls].reverse().find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择功能',
    );
    expect((featurePrompt!.options as { choices: Array<{ value: string }> }).choices)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ value: 'repair' }),
        expect.objectContaining({ value: 'status' }),
      ]));
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

  it('hides pure catalog-only locations from the status summary by default', async () => {
    statusCommand.mockResolvedValue(createBaseStatusResult());
    loadConsoleItems.mockResolvedValue([item({
      summary: {
        status: 'installed',
        statusLabel: '已安装',
        locationSummary: 'Codex（个人）',
        features: [feature('status')],
      },
      locations: [
        location({
          status: 'installed',
          statusLabel: '已安装',
        }),
        location({
          platform: 'claude',
          locationLabel: 'Claude Code（个人）',
          status: 'notInstalled',
          statusLabel: '未安装',
        }),
      ],
    })]);

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'status' },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const statusView = consoleDriver.views.find((view) => view.title === 'Git Commit 状态');
    expect(statusView?.lines.some((line) => line.includes('Codex（个人）'))).toBe(true);
    expect(statusView?.lines.some((line) => line.includes('Claude Code（个人）'))).toBe(false);
  });

  it.each([
    ['succeeded', '相关项目文件已更新。'],
    ['skipped', '没有需要重新应用的项目文件。'],
    ['failed', '重新应用配置失败。你可以进入状态页查看原因。'],
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
    replayConfigRuntimeWrites.mockResolvedValue({
      artifactRefresh: {
        attempted: status !== 'skipped',
        status,
        triggerKeys: [],
        artifacts: [],
      },
      targetResults: [],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'reapplyConfigRefresh' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(applyPluginConfigWrite).not.toHaveBeenCalled();
    expect(replayConfigRuntimeWrites).toHaveBeenCalledWith(expect.objectContaining({
      includeBuiltIn: false,
      includeDynamicArtifacts: true,
      nativeCliRunner: context.nativeCliRunner,
    }));
    expect(consoleDriver.views.some((view) =>
      view.title === 'Git Commit 重新应用配置' &&
      view.lines.includes(expectedLine),
    )).toBe(true);
  });
});
