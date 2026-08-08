import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliExecutionContext } from '../../src/commands/runtime.js';
import type {
  ConsoleControllerItem,
  PluginConsoleConfigProjection,
  PluginConsoleFeatureSummary,
  PluginConsoleLocation,
  PluginConsoleSummary,
} from '../../src/commands/console-model.js';
import type { CatalogResolution, PluginMeta } from '../../src/types.js';
import { createFakeConsoleDriver, createFakePrompt } from '../helpers/fake-console.js';

const loadConsoleItemsResult = vi.fn();
const resolveCurrentCatalog = vi.fn();
const installCommand = vi.fn();
const upgradeCommand = vi.fn();
const uninstallCommand = vi.fn();
const cleanupCommand = vi.fn();
const isCleanupExecutionFailure = vi.fn((payload: {
  dependencyIndex?: boolean;
  blockingReasons?: unknown[];
  residueItems?: unknown[];
  failedItems?: unknown[];
}) =>
  payload.dependencyIndex !== true &&
  (
    (payload.blockingReasons?.length ?? 0) > 0 ||
    (payload.residueItems?.length ?? 0) > 0 ||
    (payload.failedItems?.length ?? 0) > 0
  ));
const reinstallCommand = vi.fn();
const preparePluginTargetsForCommand = vi.fn();
const createInstallWizardDecision = vi.fn();
const createConsoleConfigFormIdentity = vi.fn(async () => 'git-commit\0codex\0token');
const planConsoleGraphWriteTargets = vi.fn();
const applyPluginConfigWrite = vi.fn();
const applyBuiltInConfigWrite = vi.fn();
const replayConfigRuntimeWrites = vi.fn();
const resetPluginConfigWithHelper = vi.fn();
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

vi.mock('../../src/commands/status.js', () => ({ loadConsoleItemsResult }));
vi.mock('../../src/utils/plugin-catalog.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/plugin-catalog.js')>('../../src/utils/plugin-catalog.js');
  return { ...actual, resolveCurrentCatalog };
});
vi.mock('../../src/commands/install.js', () => ({ installCommand }));
vi.mock('../../src/commands/upgrade.js', () => ({ upgradeCommand }));
vi.mock('../../src/commands/uninstall.js', () => ({ uninstallCommand }));
vi.mock('../../src/commands/cleanup.js', () => ({ cleanupCommand, isCleanupExecutionFailure }));
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
  resetPluginConfigWithHelper,
}));
vi.mock('../../src/utils/plugin-config.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/plugin-config.js')>('../../src/utils/plugin-config.js');
  return {
    ...actual,
    resolveEffectivePluginConfig,
    readPluginConfigStore,
  };
});

function plugin(configSchema?: PluginMeta['manifest']['config']): PluginMeta {
  return {
    rootDir: '/synthetic/plugin',
    manifestPath: '/synthetic/plugin/.agents-plugin/plugin.json',
    manifest: {
      name: 'git-commit',
      version: '1.2.3',
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
      cleanup: '清理',
      reinstall: '重新安装',
      adoptExisting: '认领现有安装',
      resolveDuplicateInstall: '处理重复安装',
      reapplyConfigRefresh: '重新应用配置',
      dependencies: '依赖',
      status: '状态',
    }[kind],
    targetSelection: kind === 'status' || kind === 'dependencies'
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
      feature('uninstall', { destructive: true }),
      feature('status'),
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
      fields: [{
        key: 'token',
        title: 'Token',
        kind: 'manifest',
        reserved: false,
        writable: true,
        valueState: 'default',
        effectiveValue: null,
        sourceLayer: null,
      }],
      legacyConfigStores: [],
    }, {
      scope: 'user',
      projectLayer: 'shared',
      fields: [{
        key: 'token',
        title: 'Token',
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
  statusPage?: ConsoleControllerItem['statusPage'];
  dependencyPage?: ConsoleControllerItem['dependencyPage'];
} = {}): ConsoleControllerItem {
  const builtSummary = summary(overrides.summary);
  const locations = overrides.locations ?? [location()];
  const recommendedKind = builtSummary.features.find((entry) =>
    entry.kind !== 'status' && entry.kind !== 'dependencies'
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
      ...(builtSummary.features.find((entry) => entry.kind !== 'status' && entry.kind !== 'dependencies')
        ? { primaryActionLabel: builtSummary.features.find((entry) => entry.kind !== 'status' && entry.kind !== 'dependencies')!.label }
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
    statusPage: overrides.statusPage ?? {
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

const FORBIDDEN_TUI_VISIBLE_TEXT: RegExp[] = [
  /诊断/,
  /查看诊断/,
  /\bdiagnose\b/i,
  /\bopenDiagnose\b/,
  /\brepair\b/i,
  /\bopenRepair\b/,
  /修复/,
  /\baw\s+(install|upgrade|uninstall|cleanup|reinstall|status|config|repair)\b/i,
  /cleanup\s+--plan/i,
  /--takeover-shared-runtime/,
  /下一步/,
  /\bnextSteps\b/,
  /current catalog/i,
  /schema identity/i,
  /install record/i,
];

function collectVisibleTuiText(
  consoleDriver: ReturnType<typeof createFakeConsoleDriver>,
  prompt: ReturnType<typeof createFakePrompt>,
): string {
  const promptText = prompt.calls.flatMap((call) => {
    const options = call.options as {
      message?: string;
      choices?: Array<{
        label?: string;
        description?: string;
        short?: string;
        disabled?: boolean | string;
      }>;
    };
    return [
      options.message,
      ...(options.choices ?? []).flatMap((choice) => [
        choice.label,
        choice.description,
        choice.short,
        typeof choice.disabled === 'string' ? choice.disabled : undefined,
      ]),
    ];
  });
  return [
    ...consoleDriver.views.flatMap((view) => [view.title, ...view.lines]),
    ...promptText,
  ]
    .filter((line): line is string => typeof line === 'string' && line.length > 0)
    .join('\n');
}

function expectNoForbiddenTuiText(
  consoleDriver: ReturnType<typeof createFakeConsoleDriver>,
  prompt: ReturnType<typeof createFakePrompt>,
) {
  const visibleText = collectVisibleTuiText(consoleDriver, prompt);
  for (const forbidden of FORBIDDEN_TUI_VISIBLE_TEXT) {
    expect(visibleText).not.toMatch(forbidden);
  }
}

function catalog(
  state?: NonNullable<CatalogResolution['cacheState']>['state'],
  overrides: Partial<CatalogResolution> = {},
): CatalogResolution {
  return {
    rootDir: '/synthetic/catalog',
    source: state ? 'cache' : 'embedded',
    catalogVersion: '1.0.0',
    ...(state ? {
      cacheState: {
        state,
        validatedAt: '2026-08-01T00:00:00.000Z',
        ageMs: 600_000,
        ttlMs: 300_000,
      },
    } : {}),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mockHomeStates(...states: Array<{
  items: ConsoleControllerItem[];
  catalogUnavailable: boolean;
  catalog?: CatalogResolution;
}>) {
  let index = 0;
  loadConsoleItemsResult.mockImplementation(async () => ({
    catalog: catalog(),
    ...states[Math.min(index++, states.length - 1)]!,
  }));
}

function installDecision(commandAction: 'install' | 'upgrade' = 'install') {
  createInstallWizardDecision.mockResolvedValue({
    blockedReason: undefined,
    configPrompts: [],
    commandAction,
  });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe('console controller stage 8', () => {
  it('renders stale cache first and applies a completed background refresh only after the home prompt returns', async () => {
    const cachedItem = item({ summary: { title: 'Cached Plugin' } });
    const refreshedItem = item({ summary: { title: 'Refreshed Plugin' } });
    const staleCatalog = catalog('stale');
    const freshCatalog = catalog('fresh', {
      source: 'remote',
      rootDir: '/synthetic/catalog-fresh',
      catalogVersion: '1.1.0',
    });
    loadConsoleItemsResult.mockImplementation(async (
      _options: unknown,
      runtime: { catalogResolution?: CatalogResolution },
    ) => runtime.catalogResolution
      ? { items: [refreshedItem], catalog: runtime.catalogResolution, catalogUnavailable: false }
      : { items: [cachedItem], catalog: staleCatalog, catalogUnavailable: false });

    const refresh = deferred<CatalogResolution>();
    resolveCurrentCatalog.mockReturnValue(refresh.promise);
    const homePrompt = deferred<{ action: 'select'; cancelled: false; value: string }>();
    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([]);
    let homeChoices: Array<{ label: string }> = [];
    context.prompt.select = vi.fn(async (options: { message: string; choices: Array<{ label: string }> }) => {
      if (options.message === '选择插件') {
        homeChoices = options.choices;
        return homePrompt.promise;
      }
      return { action: 'exit', cancelled: false } as const;
    });

    const running = runConsoleController(context);
    await vi.waitFor(() => expect(resolveCurrentCatalog).toHaveBeenCalledTimes(1));
    expect(consoleDriver.views).toHaveLength(1);
    expect(consoleDriver.views[0]?.lines).toContain('插件目录缓存已过期，正在后台更新。');
    expect(homeChoices.map((choice) => choice.label)).toContain('Cached Plugin');
    expect(resolveCurrentCatalog).toHaveBeenCalledWith(context.env, {
      freshnessPolicy: 'requireRemote',
    });

    refresh.resolve(freshCatalog);
    await vi.waitFor(() => expect(resolveCurrentCatalog).toHaveBeenCalledTimes(1));
    expect(consoleDriver.views).toHaveLength(1);
    expect(homeChoices.map((choice) => choice.label)).not.toContain('Refreshed Plugin');

    homePrompt.resolve({ action: 'select', cancelled: false, value: 'git-commit' });
    await expect(running).resolves.toBe(0);
    expect(consoleDriver.views[1]?.title).toBe('Refreshed Plugin');
    expect(loadConsoleItemsResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ catalogResolution: freshCatalog }),
    );
  });

  it.each([
    ['fresh cache', catalog('fresh')],
    ['embedded catalog', catalog()],
  ])('does not start a background refresh for %s', async (_label, initialCatalog) => {
    mockHomeStates({
      items: [item()],
      catalog: initialCatalog,
      catalogUnavailable: false,
    });
    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context } = createContext([{ method: 'select', action: 'exit' }]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(resolveCurrentCatalog).not.toHaveBeenCalled();
  });

  it('shows an initial refresh failure without starting an automatic retry', async () => {
    mockHomeStates({
      items: [item()],
      catalog: catalog('refreshFailed'),
      catalogUnavailable: true,
    });
    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([{ method: 'select', action: 'exit' }]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(consoleDriver.views[0]?.lines).toContain('插件目录不可用，仅显示已发现安装；恢复后可安装或升级。');
    expect(consoleDriver.views[0]?.lines).toContain('插件目录更新失败，当前显示缓存；可选择“刷新”重试。');
    expect(resolveCurrentCatalog).not.toHaveBeenCalled();
  });

  it('waits for the stale background request when home refresh selects the same catalog identity', async () => {
    const staleCatalog = catalog('stale');
    const fallbackCatalog = catalog('refreshFailed', { source: 'cache' });
    loadConsoleItemsResult.mockImplementation(async (
      _options: unknown,
      runtime: { catalogResolution?: CatalogResolution },
    ) => ({
      items: [item()],
      catalog: runtime.catalogResolution ?? staleCatalog,
      catalogUnavailable: false,
    }));
    const refresh = deferred<CatalogResolution>();
    resolveCurrentCatalog.mockReturnValue(refresh.promise);
    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([
      { method: 'select', value: 'home-refresh' },
      { method: 'select', action: 'exit' },
    ]);

    const running = runConsoleController(context);
    await vi.waitFor(() => expect(resolveCurrentCatalog).toHaveBeenCalledTimes(1));
    refresh.resolve(fallbackCatalog);
    await expect(running).resolves.toBe(0);

    expect(resolveCurrentCatalog).toHaveBeenCalledTimes(1);
    expect(consoleDriver.views).toHaveLength(2);
    expect(consoleDriver.views[1]?.lines).toContain('插件目录更新失败，当前显示缓存；可选择“刷新”重试。');
    expect(loadConsoleItemsResult).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ catalogResolution: fallbackCatalog }),
    );
  });

  it('consumes a completed background result when home refresh is selected without starting a second request', async () => {
    const staleCatalog = catalog('stale');
    const freshCatalog = catalog('fresh', { source: 'remote', catalogVersion: '1.1.0' });
    loadConsoleItemsResult.mockImplementation(async (
      _options: unknown,
      runtime: { catalogResolution?: CatalogResolution },
    ) => ({
      items: [item()],
      catalog: runtime.catalogResolution ?? staleCatalog,
      catalogUnavailable: false,
    }));
    const refresh = deferred<CatalogResolution>();
    resolveCurrentCatalog.mockReturnValue(refresh.promise);
    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context } = createContext([]);
    let promptCount = 0;
    context.prompt.select = vi.fn(async () => {
      promptCount += 1;
      if (promptCount === 1) {
        await refresh.promise;
        return { action: 'select', cancelled: false, value: 'home-refresh' } as const;
      }
      return { action: 'exit', cancelled: false } as const;
    });

    const running = runConsoleController(context);
    await vi.waitFor(() => expect(resolveCurrentCatalog).toHaveBeenCalledTimes(1));
    refresh.resolve(freshCatalog);
    await expect(running).resolves.toBe(0);

    expect(resolveCurrentCatalog).toHaveBeenCalledTimes(1);
    expect(loadConsoleItemsResult).toHaveBeenCalledTimes(2);
    expect(loadConsoleItemsResult).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ catalogResolution: freshCatalog }),
    );
  });

  it('starts one remote request for an explicit refresh when no request is in flight', async () => {
    const initialCatalog = catalog('fresh');
    const refreshedCatalog = catalog('fresh', {
      source: 'remote',
      rootDir: '/synthetic/catalog-refreshed',
      catalogVersion: '1.1.0',
    });
    loadConsoleItemsResult.mockImplementation(async (
      _options: unknown,
      runtime: { catalogResolution?: CatalogResolution },
    ) => ({
      items: [item()],
      catalog: runtime.catalogResolution ?? initialCatalog,
      catalogUnavailable: false,
    }));
    resolveCurrentCatalog.mockResolvedValue(refreshedCatalog);
    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context } = createContext([
      { method: 'select', value: 'home-refresh' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(resolveCurrentCatalog).toHaveBeenCalledTimes(1);
    expect(loadConsoleItemsResult).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ catalogResolution: refreshedCatalog }),
    );
  });

  it('defers a background exception notice until the next view and does not retry automatically', async () => {
    mockHomeStates({
      items: [item()],
      catalog: catalog('stale'),
      catalogUnavailable: false,
    });
    const refresh = deferred<CatalogResolution>();
    resolveCurrentCatalog.mockReturnValue(refresh.promise);
    const homePrompt = deferred<{ action: 'select'; cancelled: false; value: string }>();
    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([]);
    let homePromptCount = 0;
    context.prompt.select = vi.fn(async () => {
      homePromptCount += 1;
      if (homePromptCount === 1) {
        return homePrompt.promise;
      }
      return { action: 'exit', cancelled: false } as const;
    });

    const running = runConsoleController(context);
    await vi.waitFor(() => expect(resolveCurrentCatalog).toHaveBeenCalledTimes(1));
    refresh.reject(new Error('offline'));
    await vi.waitFor(() => expect(resolveCurrentCatalog).toHaveBeenCalledTimes(1));
    expect(consoleDriver.views).toHaveLength(1);

    homePrompt.resolve({ action: 'select', cancelled: false, value: 'missing-plugin' });
    await expect(running).resolves.toBe(0);
    expect(consoleDriver.views[1]?.lines).toContain('插件目录更新失败，当前显示缓存；可选择“刷新”重试。');
    expect(resolveCurrentCatalog).toHaveBeenCalledTimes(1);
  });

  it('keeps a background failure notice after entering detail and reloading the stale home state', async () => {
    mockHomeStates({
      items: [item()],
      catalog: catalog('stale'),
      catalogUnavailable: false,
    });
    const refresh = deferred<CatalogResolution>();
    const detailPrompt = deferred<{ action: 'back'; cancelled: false }>();
    resolveCurrentCatalog.mockReturnValue(refresh.promise);
    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver } = createContext([]);
    let promptCount = 0;
    context.prompt.select = vi.fn(async () => {
      promptCount += 1;
      switch (promptCount) {
        case 1:
        case 3:
          return { action: 'select', cancelled: false, value: 'git-commit' } as const;
        case 2:
          return detailPrompt.promise;
        case 4:
          return { action: 'back', cancelled: false } as const;
        default:
          return { action: 'exit', cancelled: false } as const;
      }
    });

    const running = runConsoleController(context);
    await vi.waitFor(() => expect(resolveCurrentCatalog).toHaveBeenCalledTimes(1));
    refresh.reject(new Error('offline'));
    detailPrompt.resolve({ action: 'back', cancelled: false });
    await expect(running).resolves.toBe(0);

    const homeViews = consoleDriver.views.filter((view) => view.title === 'AW 控制台');
    expect(homeViews).toHaveLength(3);
    for (const view of homeViews.slice(1)) {
      expect(view.lines).toContain('插件目录更新失败，当前显示缓存；可选择“刷新”重试。');
      expect(view.lines).not.toContain('插件目录缓存已过期，正在后台更新。');
    }
    expect(loadConsoleItemsResult).toHaveBeenCalledTimes(2);
    expect(resolveCurrentCatalog).toHaveBeenCalledTimes(1);
  });

  it('groups home cards by friendly status and limits home actions to refresh and exit', async () => {
    mockHomeStates({
      items: [
        item({
          summary: {
            pluginName: 'broken-plugin',
            title: 'Broken Plugin',
            status: 'abnormal',
            statusLabel: '异常',
            issueSummary: '发现了残留文件或本机状态。',
            features: [feature('cleanup', { destructive: true }), feature('status')],
          },
        }),
        item({
          summary: {
            pluginName: 'upgrade-plugin',
            title: 'Upgrade Plugin',
            status: 'upgradeAvailable',
            statusLabel: '可升级',
            features: [feature('upgrade'), feature('status')],
          },
        }),
        item({
          summary: {
            pluginName: 'installed-plugin',
            title: 'Installed Plugin',
            status: 'installed',
            statusLabel: '已安装',
            features: [feature('uninstall', { destructive: true }), feature('status')],
          },
        }),
        item({
          summary: {
            pluginName: 'catalog-plugin',
            title: 'Catalog Plugin',
            status: 'notInstalled',
            statusLabel: '未安装',
            features: [feature('install'), feature('status')],
          },
          locations: [location({
            status: 'notInstalled',
            statusLabel: '未安装',
            actions: [{ kind: 'openInstallWizard', label: '安装', target: { platform: 'codex', scope: 'user' } }],
          })],
        }),
      ],
      catalogUnavailable: false,
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver, prompt } = createContext([
      { method: 'select', value: '__exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(consoleDriver.views[0]?.lines).toEqual(expect.arrayContaining([
      '异常（1）',
      '可升级（1）',
      '已安装（1）',
      '未安装（1）',
    ]));
    expect(consoleDriver.views[0]?.lines.join('\n')).not.toContain('主操作：');
    const homePrompt = prompt.calls.find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择插件');
    expect((homePrompt!.options as { choices: Array<{ label: string }> }).choices.map((choice) => choice.label))
      .toEqual(expect.arrayContaining(['Broken Plugin', 'Upgrade Plugin', 'Installed Plugin', 'Catalog Plugin', '刷新', '退出']));
    expectNoForbiddenTuiText(consoleDriver, prompt);
  });

  it('uses the detail page as the action center and hides internal metadata lines', async () => {
    mockHomeStates({
      items: [item({
        summary: {
          status: 'abnormal',
          statusLabel: '异常',
          locationSummary: 'Codex（个人 + 当前项目）',
          issueSummary: '同一平台同时存在两个可生效安装。',
          features: [feature('cleanup', { destructive: true }), feature('status')],
        },
        locations: [
          location({
            status: 'abnormal',
            statusLabel: '异常',
            issueSummary: '同一平台同时存在两个可生效安装。',
            actions: [{ kind: 'runCleanup', label: '清理', destructive: true, confirmText: 'cleanup user?', target: { platform: 'codex', scope: 'user' } }],
          }),
          location({
            scope: 'project',
            projectKey: '/workspace',
            locationLabel: 'Codex（当前项目）',
            status: 'abnormal',
            statusLabel: '异常',
            issueSummary: '同一平台同时存在两个可生效安装。',
            actions: [{ kind: 'runCleanup', label: '清理', destructive: true, confirmText: 'cleanup project?', target: { platform: 'codex', scope: 'project', projectKey: '/workspace' } }],
          }),
        ],
      })],
      catalogUnavailable: false,
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('位置');
    expect(detailView?.lines).toContain('! Codex（个人） · 异常');
    expect(detailView?.lines).toContain('! Codex（当前项目） · 异常');
    expect(detailView?.lines.join('\n')).not.toContain('current catalog');
    expect(detailView?.lines.join('\n')).not.toContain('schema identity');
    expect(detailView?.lines.join('\n')).not.toContain('install record');
    const featurePrompt = prompt.calls.find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '选择功能');
    expect((featurePrompt!.options as { choices: Array<{ label: string }> }).choices.map((choice) => choice.label))
      .toEqual(expect.arrayContaining(['清理（推荐）', '状态', '返回', '退出']));
    expectNoForbiddenTuiText(consoleDriver, prompt);
  });

  it('renders status from the structured page model without showing nextSteps or pure catalog-only locations', async () => {
    const statusItem = item({
      summary: {
        features: [feature('status')],
      },
      statusPage: {
        pluginName: 'git-commit',
        summary: summary({
          status: 'abnormal',
          statusLabel: '异常',
          issueSummary: '请先查看状态详情。',
        }),
        locations: [
          {
            key: 'codex:user:-',
            platform: 'codex',
            scope: 'user',
            label: 'Codex（个人）',
            status: 'abnormal',
            statusLabel: '异常',
            statusSymbol: '!',
            statusTone: 'danger',
            hasEvidence: true,
            summary: '存在残留',
            issues: [],
            suggestedFeatures: [],
            nextSteps: [{
              kind: 'cliCommand',
              label: '清理',
              description: '先清理当前状态。',
              command: 'aw cleanup git-commit --platform codex --scope user',
            }],
            diagnostics: [{ label: '说明', value: '有一条 detail line', tone: 'info' }],
          },
          {
            key: 'claude:user:-',
            platform: 'claude',
            scope: 'user',
            label: 'Claude Code（个人）',
            status: 'notInstalled',
            statusLabel: '未安装',
            statusSymbol: '○',
            statusTone: 'neutral',
            hasEvidence: false,
            summary: '未安装',
            issues: [],
            suggestedFeatures: [],
            nextSteps: [],
            diagnostics: [],
          },
        ],
      },
    });
    mockHomeStates({
      items: [statusItem],
      catalogUnavailable: false,
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'status' },
      { method: 'select', value: 'codex:user:-' },
      { method: 'select', value: '__back' },
      { method: 'select', value: '__back' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const summaryView = consoleDriver.views.find((view) => view.title === 'Git Commit 状态');
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit 详情');
    expect(summaryView?.lines).toContain('有证据的位置');
    expect(summaryView?.lines).toContain('! Codex（个人） · 异常');
    expect(summaryView?.lines.join('\n')).not.toContain('Claude Code（个人）');
    expect(detailView?.lines).toContain('说明：有一条 detail line');
    expect(detailView?.lines.join('\n')).not.toContain('aw cleanup');
    expect(detailView?.lines.join('\n')).not.toContain('下一步');
    expect(loadConsoleItemsResult).toHaveBeenCalledTimes(2);
    expect(loadConsoleItemsResult.mock.calls[1]?.[1]).not.toHaveProperty('statusReadSnapshot');
    expectNoForbiddenTuiText(consoleDriver, prompt);
  });

  it('recommends claimable external adoption and calls install --adopt-existing', async () => {
    const adoptItem = item({
      summary: {
        status: 'abnormal',
        statusLabel: '异常',
        features: [feature('adoptExisting', { destructive: true }), feature('status')],
      },
      locations: [location({
        scope: 'project',
        projectKey: '/workspace',
        locationLabel: 'Codex（当前项目）',
        status: 'abnormal',
        statusLabel: '异常',
        reasonCodes: ['claimableProjectArtifacts'],
        actions: [{
          kind: 'runAdoptExisting',
          label: '认领现有安装',
          destructive: true,
          confirmText: 'adopt?',
          target: { platform: 'codex', scope: 'project', projectKey: '/workspace' },
        }],
      })],
    });
    const refreshed = item({
      summary: {
        status: 'installed',
        statusLabel: '已安装',
        features: [feature('uninstall', { destructive: true }), feature('status')],
      },
    });
    mockHomeStates(
      { items: [adoptItem], catalogUnavailable: false },
      { items: [refreshed], catalogUnavailable: false },
      { items: [refreshed], catalogUnavailable: false },
    );
    installCommand.mockResolvedValue({
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'adoptExisting' },
      { method: 'select', value: 'confirm-continue' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(installCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        scope: 'project',
        platform: 'codex',
        adoptExisting: true,
      }),
      context,
    );
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('最近结果 · 认领现有安装');
    expectNoForbiddenTuiText(consoleDriver, prompt);
  });

  it('returns to the refreshed detail page with the latest result after install and does not show a standalone result page', async () => {
    const installItem = item({
      summary: {
        status: 'notInstalled',
        statusLabel: '未安装',
        features: [feature('install'), feature('status')],
      },
      locations: [location({
        status: 'notInstalled',
        statusLabel: '未安装',
        actions: [{ kind: 'openInstallWizard', label: '安装', target: { platform: 'codex', scope: 'user' } }],
      })],
    });
    const refreshed = item({
      summary: {
        status: 'installed',
        statusLabel: '已安装',
        features: [feature('uninstall', { destructive: true }), feature('status')],
      },
    });
    mockHomeStates(
      { items: [installItem], catalogUnavailable: false },
      { items: [refreshed], catalogUnavailable: false },
      { items: [refreshed], catalogUnavailable: false },
    );
    preparePluginTargetsForCommand.mockResolvedValue({
      ledger: { ledgerState: { status: 'available' } },
      targets: [{ pluginName: 'git-commit', plugin: plugin() }],
    });
    installDecision('install');
    installCommand.mockResolvedValue({
      platforms: ['codex'],
      plugins: ['git-commit'],
      warnings: [],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'install' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(installCommand.mock.calls[0]?.[2]).toBe(context);
    expect(installCommand.mock.calls[0]?.[2]).not.toHaveProperty('catalogResolution');
    expect(loadConsoleItemsResult).toHaveBeenCalledTimes(2);
    expect(loadConsoleItemsResult.mock.calls[1]?.[1]).not.toHaveProperty('statusReadSnapshot');
    expect(loadConsoleItemsResult.mock.calls[1]?.[1]).not.toHaveProperty('catalogResolution');
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('最近结果 · 安装');
    expect(consoleDriver.views.some((view) => view.title.includes('结果'))).toBe(false);
    expect(consoleDriver.views.some((view) => view.lines.includes('返回首页'))).toBe(false);
    expect(consoleDriver.views.some((view) => view.lines.some((line) => line.startsWith('状态 · ')))).toBe(false);
    expectNoForbiddenTuiText(consoleDriver, prompt);
  });

  it('returns to detail with a cancel notice after a destructive action is cancelled', async () => {
    const cleanupItem = item({
      summary: {
        status: 'abnormal',
        statusLabel: '异常',
        features: [feature('cleanup', { destructive: true }), feature('status')],
      },
      locations: [location({
        status: 'abnormal',
        statusLabel: '异常',
        actions: [{
          kind: 'runCleanup',
          label: '清理',
          destructive: true,
          confirmText: 'cleanup?',
          target: { platform: 'codex', scope: 'user' },
        }],
      })],
    });
    mockHomeStates({
      items: [cleanupItem],
      catalogUnavailable: false,
    });
    cleanupCommand.mockResolvedValue({
      warnings: [],
      payload: {
        ok: true,
        command: 'cleanup',
        receiptSchemaVersion: 2,
        overallState: 'succeeded',
        generatedAt: '2026-05-23T00:00:00.000Z',
        dependencyIndex: false,
        targetResults: [],
        nextStepsSchemaVersion: 1,
        nextSteps: [],
        force: false,
        removeConfig: false,
        target: {
          plugin: 'git-commit',
          platform: 'codex',
          scope: 'user',
          targetType: 'cleanup-required',
        },
        cleanupScope: [],
        deletedItems: [],
        skippedItems: [],
        failedItems: [],
        residueItems: [],
        configActions: [],
        affectedDependents: [],
        blockingReasons: [],
      },
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'cleanup' },
      { method: 'select', value: 'keep' },
      { method: 'select', value: 'confirm-back' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    expect(cleanupCommand).toHaveBeenCalledTimes(1);
    expect(cleanupCommand).toHaveBeenCalledWith(
      ['git-commit'],
      expect.objectContaining({
        plan: true,
        removeConfig: false,
        platform: 'codex',
        scope: 'user',
      }),
      context,
    );
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('提示：已取消，本次没有写入任何状态。');
    expectNoForbiddenTuiText(consoleDriver, prompt);
  });

  it('keeps the effective config view read-only and hides schema/catalog/install record metadata', async () => {
    const configItem = item({
      summary: {
        features: [feature('configure'), feature('status')],
        config: configProjection({
          schema: {
            source: 'currentCatalog',
            identity: 'schema-identity',
            pluginVersion: '1.2.3',
            manifestDigest: 'digest',
          },
          catalog: {
            available: true,
            source: 'remote',
            channel: 'beta',
            catalogVersion: '2.0.0',
            minAwVersion: '1.0.0',
          },
        }),
      },
    });
    mockHomeStates({
      items: [configItem],
      catalogUnavailable: false,
    });
    preparePluginTargetsForCommand.mockResolvedValue({
      targets: [{ pluginName: 'git-commit', plugin: plugin() }],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'configure' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const configView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit 配置');
    expect(configView?.lines).toContain('目标：个人配置');
    expect(configView?.lines).toContain('作用层：个人');
    expect(configView?.lines.join('\n')).not.toContain('schema identity');
    expect(configView?.lines.join('\n')).not.toContain('current catalog');
    expect(configView?.lines.join('\n')).not.toContain('install record');
    const configPrompt = prompt.calls.find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '配置操作');
    expect((configPrompt!.options as { choices: Array<{ value: string }> }).choices.map((choice) => choice.value))
      .toEqual(expect.arrayContaining(['switch-view', 'config-back', 'config-exit']));
    expect((configPrompt!.options as { choices: Array<{ value: string }> }).choices.map((choice) => choice.value))
      .not.toEqual(expect.arrayContaining(['update-field', 'clear-field', 'reset-layer', 'apply-config', 'reapply-config']));
    expectNoForbiddenTuiText(consoleDriver, prompt);
  });

  it('uses a structured dangerous confirmation page with cancel selected by default', async () => {
    const uninstallItem = item({
      summary: {
        features: [feature('uninstall', { destructive: true, targetSelection: 'multiTargetAllowed' }), feature('status')],
      },
      locations: [
        location({
          platform: 'codex',
          actions: [{ kind: 'runUninstall', label: '卸载', destructive: true, confirmText: 'remove codex?', target: { platform: 'codex', scope: 'user' } }],
        }),
        location({
          platform: 'claude',
          locationLabel: 'Claude Code（个人）',
          actions: [{ kind: 'runUninstall', label: '卸载', destructive: true, confirmText: 'remove claude?', target: { platform: 'claude', scope: 'user' } }],
        }),
      ],
    });
    mockHomeStates({
      items: [uninstallItem],
      catalogUnavailable: false,
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'uninstall' },
      { method: 'select', value: '__all_platforms' },
      { method: 'select', value: 'user' },
      { method: 'select', value: 'confirm-back' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const confirmView = consoleDriver.views.find((view) => view.title === 'Git Commit 确认');
    expect(confirmView?.lines).toEqual(expect.arrayContaining([
      '操作：卸载',
      '对象：',
      '真实目标：',
      '将会处理：',
      '不会影响：',
      '配置：',
      '影响范围：',
    ]));
    const confirmPrompt = prompt.calls.find((call) =>
      call.method === 'select' &&
      (call.options as { message?: string }).message === '确认操作');
    expect((confirmPrompt!.options as { defaultValue?: string }).defaultValue).toBe('confirm-back');
    expectNoForbiddenTuiText(consoleDriver, prompt);
  });

  it('selects install targets in platform-then-scope order and never shows skill-trigger steps', async () => {
    const installItem = item({
      summary: {
        status: 'notInstalled',
        statusLabel: '未安装',
        features: [feature('install', { targetSelection: 'multiTargetAllowed' }), feature('status')],
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
    mockHomeStates({
      items: [installItem],
      catalogUnavailable: false,
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'install' },
      { method: 'select', value: 'codex' },
      { method: 'select', value: '__back' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const messages = prompt.calls
      .filter((call) => call.method === 'select')
      .map((call) => (call.options as { message?: string }).message);
    expect(messages).toEqual(expect.arrayContaining(['选择平台', '选择位置']));
    expect(messages).not.toEqual(expect.arrayContaining(['选择 SkillTrigger', 'selectSkillTrigger']));
    expectNoForbiddenTuiText(consoleDriver, prompt);
  });

  it('renders reapply-config outcomes back on the detail page instead of a standalone result page', async () => {
    const reapplyItem = item({
      summary: {
        features: [feature('reapplyConfigRefresh'), feature('status')],
      },
      locations: [location({
        actions: [{ kind: 'reapplyConfigRefresh', label: '重新应用配置', target: { platform: 'codex', scope: 'user' } }],
      })],
    });
    mockHomeStates(
      { items: [reapplyItem], catalogUnavailable: false },
      { items: [reapplyItem], catalogUnavailable: false },
    );
    preparePluginTargetsForCommand.mockResolvedValue({
      targets: [{ pluginName: 'git-commit', plugin: plugin() }],
    });
    replayConfigRuntimeWrites.mockResolvedValue({
      artifactRefresh: { status: 'skipped' },
      targetResults: [],
    });

    const { runConsoleController } = await import('../../src/commands/console.js');
    const { context, consoleDriver, prompt } = createContext([
      { method: 'select', value: 'git-commit' },
      { method: 'select', value: 'reapplyConfigRefresh' },
      { method: 'select', action: 'exit' },
    ]);

    await expect(runConsoleController(context)).resolves.toBe(0);
    const detailView = [...consoleDriver.views].reverse().find((view) => view.title === 'Git Commit');
    expect(detailView?.lines).toContain('最近结果 · 重新应用配置');
    expect(detailView?.lines).toContain('- 没有需要重新应用的项目文件。');
    expect(consoleDriver.views.some((view) => view.title === 'Git Commit 重新应用配置')).toBe(false);
    expectNoForbiddenTuiText(consoleDriver, prompt);
  });
});
