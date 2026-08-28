import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StatusV5Payload, StatusV5PluginSummary } from '../../src/commands/status-v5.js';
import type { DependencyOperationPlan } from '../../src/commands/dependency-operation-plan.js';
import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import {
  CONSOLE_V4_SCREEN_IDS,
  ConsoleAppV4,
  resolveConsoleV4ScreenId,
  type ConsoleV4ScreenId,
} from '../../src/tui/console-app-v4.js';
import {
  TuiController,
  userIssueKey,
  type OperationEvidence,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import type { ConfigPageViewModel, PluginDependencyOverviewViewModel } from '../../src/tui/model.js';

afterEach(() => cleanup());

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const evidence: OperationEvidence = {
  catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
  source: {
    sourceId: 'official',
    sourceIdentity: 'identity:official',
    snapshotDigest: 'sha256:snapshot',
    contentDigest: 'sha256:content',
  },
  targetFingerprint: 'sha256:target',
};

function target(options: {
  pluginName: string;
  sourceId?: string;
  platform: 'codex' | 'claude';
  scope: 'user' | 'project';
  state: 'present' | 'absent' | 'partial' | 'error';
  errorCode?: string;
}): StatusV5Payload['targets'][number] {
  const sourceId = options.sourceId ?? 'official';
  return {
    pluginName: options.pluginName,
    pluginId: `${sourceId}/${options.pluginName}`,
    sourceId,
    sourceIdentity: `identity:${sourceId}`,
    version: '0.4.2',
    platform: options.platform,
    scope: options.scope,
    cwd: '/workspace',
    state: options.state,
    components: [],
    errors: options.state === 'partial'
      ? [{ code: 'missingContent', message: '安全说明' }]
      : options.state === 'error' ? [{ code: options.errorCode ?? 'targetError', message: '安全说明' }] : [],
  };
}

function loadResult(): TuiStatusLoadResult {
  const summaries: StatusV5PluginSummary[] = [
    {
      pluginName: 'agent-lab',
      pluginId: 'official/agent-lab',
      displayName: 'Agent Lab',
      description: '用于本地试验的 Agent 工具集合',
      version: '0.4.2',
      supportedTargets: { codex: ['user', 'project'], claude: ['user', 'project'] },
      configFieldCount: 0,
    },
    {
      pluginName: 'review-gate',
      pluginId: 'official/review-gate',
      displayName: 'Review Gate',
      description: '轻量代码审查与合并检查',
      version: '0.2.1',
      supportedTargets: { codex: ['user', 'project'], claude: [] },
      configFieldCount: 1,
    },
    {
      pluginName: 'review-gate',
      pluginId: 'team-tools/review-gate',
      displayName: 'Review Gate',
      description: '团队发布审查、证据检查与发布门禁',
      version: '0.4.2',
      supportedTargets: { codex: ['user', 'project'], claude: ['user', 'project'] },
      configFieldCount: 5,
      configIssues: [{ type: 'missing-required', key: 'rules', title: '规则文件', source: 'missing' }],
    },
  ];
  const allTargets = summaries.flatMap((summary) =>
    (['codex', 'claude'] as const).flatMap((platform) =>
      (summary.supportedTargets?.[platform] ?? []).map((scope) => target({
        pluginName: summary.pluginName,
        sourceId: summary.pluginId.split('/')[0],
        platform,
        scope,
        state: summary.pluginId === 'team-tools/review-gate'
          ? platform === 'codex' && scope === 'user' ? 'present'
            : platform === 'claude' && scope === 'project' ? 'partial' : 'absent'
          : 'absent',
      }))),
  );
  const payload: StatusV5Payload = {
      schemaVersion: 5,
      catalog: {
        primarySourceId: 'official',
        configDigest: 'sha256:config',
        compositeDigest: 'sha256:composite',
        sources: [
          { id: 'official', identity: 'identity:official', type: 'path', primary: true, requestedRef: 'path', freshness: 'path' },
          { id: 'team-tools', identity: 'identity:team-tools', type: 'git', primary: false, requestedRef: 'catalog/stable', resolvedCommit: 'abc123', catalogVersion: '2.4.0', channel: 'latest', freshness: 'cache' },
          { id: 'research', identity: 'identity:research', type: 'path', primary: false, requestedRef: 'path', error: 'unavailable', errorCode: 'catalogSourceUnavailable' },
        ],
      },
      filters: { plugins: [], platform: 'both', cwd: '/workspace' },
      targets: allTargets,
      errors: [],
    };
  return {
    payload,
    pluginSummaries: summaries,
    sourceDetails: payload.catalog.sources.map((source) => ({
      id: source.id,
      type: source.type,
      primary: source.primary,
      locationSummary: source.type === 'git' ? 'https://example.test/team.git' : `已选择本地目录（${source.id}）`,
      ...(source.id === 'team-tools' ? { refPolicy: 'explicit' as const, explicitRef: 'catalog/stable', subdir: 'catalog' } : {}),
      pluginCount: summaries.filter((summary) => summary.pluginId.startsWith(`${source.id}/`)).length,
      sourceIdentity: source.identity,
      requestedRef: source.requestedRef,
      ...(source.resolvedCommit ? { resolvedCommit: source.resolvedCommit } : {}),
      ...(source.catalogVersion ? { catalogVersion: source.catalogVersion } : {}),
      ...(source.channel ? { channel: source.channel } : {}),
      ...(source.freshness ? { freshness: source.freshness } : {}),
      ...(source.errorCode ? { errorCode: source.errorCode } : {}),
      configDigest: 'sha256:config',
    })),
  };
}

function orphanLoadResult(): TuiStatusLoadResult {
  const loaded = loadResult();
  loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
  loaded.payload.targets = [target({
    pluginName: 'retired-tool',
    platform: 'codex',
    scope: 'user',
    state: 'error',
    errorCode: 'bundleUnavailable',
  })];
  loaded.pluginSummaries = [];
  return loaded;
}

function dependencyPlan(): DependencyOperationPlan {
  return {
    dependencyPlanSchemaVersion: 1,
    requestedPluginIds: ['official/agent-lab'],
    resolvedPluginIds: ['official/content-toolkit', 'official/skill-toolkit', 'official/agent-lab'],
    dependencyEdges: [
      { from: 'official/agent-lab', to: 'official/skill-toolkit' },
      { from: 'official/skill-toolkit', to: 'official/content-toolkit' },
    ],
    targets: [
      { pluginId: 'official/content-toolkit', pluginName: 'content-toolkit', platform: 'codex', requestedScope: 'project', resolvedScope: 'user', relation: 'dependency', requiredBy: ['official/skill-toolkit'], state: 'present', action: 'keep', order: 1 },
      { pluginId: 'official/skill-toolkit', pluginName: 'skill-toolkit', platform: 'codex', requestedScope: 'project', resolvedScope: 'project', relation: 'dependency', requiredBy: ['official/agent-lab'], state: 'absent', action: 'install', order: 2 },
      { pluginId: 'official/agent-lab', pluginName: 'agent-lab', platform: 'codex', requestedScope: 'project', resolvedScope: 'project', relation: 'requested', requiredBy: [], state: 'absent', action: 'install', order: 3 },
    ],
  };
}

function dependencyOverview(options: {
  rootState?: 'notInstalled' | 'ready';
  blockers?: PluginDependencyOverviewViewModel['blockers'];
} = {}): PluginDependencyOverviewViewModel[] {
  const rootState = options.rootState ?? 'notInstalled';
  const notInstalled = (platform: 'codex' | 'claude') => ({ platform, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] as const });
  const readyUser = (platform: 'codex' | 'claude') => ({ platform, state: 'installed' as const, scope: 'user' as const, health: 'ready' as const });
  return [
    {
      pluginId: 'official/agent-lab',
      summary: { directCount: 1, transitiveCount: 1, totalCount: 2, readyCount: 1, missingCount: 1, issueCount: options.blockers?.length ?? 0 },
      dependencies: [
        { pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit', relation: 'direct', depth: 1, requiredBy: [{ pluginId: 'official/agent-lab', displayName: 'Agent Lab' }], placements: [notInstalled('codex'), notInstalled('claude')], aggregateStatus: 'notInstalled', placementReferences: [{ consumer: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project', project: 'current' }, dependency: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'user', project: null } }] },
        { pluginId: 'official/content-toolkit', displayName: 'Agent Content Toolkit', relation: 'transitive', depth: 2, requiredBy: [{ pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit' }], placements: [readyUser('codex'), readyUser('claude')], aggregateStatus: 'ready' },
      ],
      dependents: [],
      blockers: options.blockers ?? [],
    },
    {
      pluginId: 'official/skill-toolkit',
      summary: { directCount: 1, transitiveCount: 0, totalCount: 1, readyCount: 1, missingCount: 0, issueCount: 0 },
      dependencies: [
        { pluginId: 'official/content-toolkit', displayName: 'Agent Content Toolkit', relation: 'direct', depth: 1, requiredBy: [{ pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit' }], placements: [readyUser('codex'), readyUser('claude')], aggregateStatus: 'ready' },
      ],
      dependents: [
        { pluginId: 'official/agent-lab', displayName: 'Agent Lab', relation: 'dependent', depth: 1, requiredBy: [], placements: rootState === 'ready' ? [readyUser('codex')] : [notInstalled('codex')], aggregateStatus: rootState, placementReferences: [{ consumer: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project', project: 'current' }, dependency: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'user', project: null } }] },
      ],
      blockers: [],
    },
  ];
}

function dependencyLoadResult(options: {
  rootState?: 'absent' | 'present' | 'error';
  rootErrorCode?: string;
  rootErrorMessage?: string;
  blockers?: PluginDependencyOverviewViewModel['blockers'];
} = {}): TuiStatusLoadResult {
  const initial = loadResult();
  const rootState = options.rootState ?? 'absent';
  initial.payload.catalog.sources = [initial.payload.catalog.sources[0]!];
  initial.pluginSummaries = [
    { ...initial.pluginSummaries[0]!, supportedTargets: { codex: ['user', 'project'], claude: ['user', 'project'] } },
    { pluginName: 'skill-toolkit', pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit', description: '提供 Skill 工具能力', version: '0.3.0', supportedTargets: { codex: ['user', 'project'], claude: [] }, configFieldCount: 0 },
    { pluginName: 'content-toolkit', pluginId: 'official/content-toolkit', displayName: 'Agent Content Toolkit', description: '提供内容工具能力', version: '0.2.0', supportedTargets: { codex: ['user', 'project'], claude: ['user', 'project'] }, configFieldCount: 0 },
  ];
  initial.payload.targets = [
    ...(['codex', 'claude'] as const).flatMap((platform) => (['user', 'project'] as const).map((scope) => ({
      ...target({ pluginName: 'agent-lab', platform, scope, state: rootState }),
      errors: rootState === 'error' ? [{ code: options.rootErrorCode ?? 'targetError', message: options.rootErrorMessage ?? '安全说明' }] : [],
    }))),
    ...(['codex', 'claude'] as const).flatMap((platform) => (['user', 'project'] as const).map((scope) =>
      target({ pluginName: 'skill-toolkit', platform, scope, state: 'absent' }))),
    ...(['codex', 'claude'] as const).flatMap((platform) => (['user', 'project'] as const).map((scope) =>
      target({ pluginName: 'content-toolkit', platform, scope, state: scope === 'user' ? 'present' : 'absent' }))),
  ];
  initial.dependencyOverviews = dependencyOverview({
    rootState: rootState === 'present' ? 'ready' : 'notInstalled',
    blockers: options.blockers,
  });
  return initial;
}

function controller(overrides: Partial<TuiControllerDependencies> = {}): TuiController {
  return new TuiController({
    loadStatus: vi.fn().mockResolvedValue(loadResult()),
    checkSource: vi.fn(async (sourceId: string) => {
      const selected = loadResult().payload.catalog.sources.find((source) => source.id === sourceId)!;
      return { sourceIdentity: selected.identity, requestedRef: selected.requestedRef };
    }),
    inspectSourceRemoval: vi.fn().mockResolvedValue({ blocked: false, inventoryComplete: true, installationCount: 0, configCount: 0, lifecycleCount: 0, marketplaceCount: 0, dependencies: [] }),
    captureEvidence: vi.fn().mockResolvedValue(evidence),
    executeIntent: vi.fn().mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [
        { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
        { target: { platform: 'claude', scope: 'user' }, state: 'completed' },
      ],
    }),
    now: () => 1_000,
    reviewTtlMs: 10_000,
    ...overrides,
  });
}

function platformLoadResult(
  revision: 'current' | 'upgradeAvailable',
): TuiStatusLoadResult {
  const loaded = loadResult();
  loaded.payload.catalog.sources = loaded.payload.catalog.sources.filter((source) => source.id === 'official');
  loaded.sourceDetails = loaded.sourceDetails?.filter((source) => source.id === 'official');
  loaded.pluginSummaries = loaded.pluginSummaries.filter((summary) => summary.pluginId === 'official/review-gate');
  loaded.payload.targets = [target({
    pluginName: 'review-gate',
    platform: 'codex',
    scope: 'user',
    state: 'present',
  })];
  loaded.targetRevisions = [{
    pluginId: 'official/review-gate',
    platform: 'codex',
    scope: 'user',
    revision: {
      state: revision,
      availableVersion: revision === 'current' ? '0.2.1' : '0.3.0',
      installedVersion: '0.2.1',
    },
  }];
  return loaded;
}

function configPage(pluginId = 'team-tools/review-gate'): ConfigPageViewModel {
  const field = (
    key: string,
    type: ConfigPageViewModel['groups'][number]['fields'][number]['type'],
    extra: Partial<ConfigPageViewModel['groups'][number]['fields'][number]> = {},
  ): ConfigPageViewModel['groups'][number]['fields'][number] => {
    const value = {
      key,
      title: key,
      type,
      displayValue: '未设置',
      required: false,
      sensitive: false,
      dirty: false,
      inherited: true,
      configured: false,
      sourceLabel: '未设置',
      effectiveDisplayValue: '未设置',
      effectiveSourceLabel: '未设置',
      advanced: false,
      ...extra,
    };
    return {
      ...value,
      effectiveDisplayValue: extra.effectiveDisplayValue ?? value.displayValue,
      effectiveSourceLabel: extra.effectiveSourceLabel ?? (value.configured ? '个人默认' : '未设置'),
      ...(extra.effectiveValue !== undefined
        ? { effectiveValue: extra.effectiveValue }
        : value.value !== undefined && !value.sensitive && value.type !== 'file' && value.type !== 'directory'
          ? { effectiveValue: value.value }
          : {}),
    };
  };
  return {
    pluginId,
    layer: { scope: 'user', projectLayer: 'shared' },
    storedCount: 2,
    presets: [{
      id: 'team',
      title: '团队默认',
      description: '平衡审查与等待时间',
      values: { level: 'balanced', enabled: true, timeout: 20 },
    }],
    groups: [
      {
        id: 'basic',
        title: '基本设置',
        advanced: false,
        fields: [
          field('level', 'enum', { enumValues: ['fast', 'balanced', 'strict'], valueLabels: { fast: '快速', balanced: '平衡', strict: '严格' }, recommendedValue: 'balanced', value: 'strict', displayValue: '严格', configured: true, inherited: false }),
          field('enabled', 'boolean', { value: true, displayValue: '开启', configured: true, inherited: false }),
          field('timeout', 'number', { min: 1, max: 60, unit: '分钟', value: 15, displayValue: '15', configured: true, inherited: false }),
          field('note', 'string', { placeholder: '输入说明' }),
          field('rules', 'file', { configured: true, inherited: false, displayValue: '已设置' }),
          field('workspace', 'directory'),
          field('token', 'string', { sensitive: true, configured: true, inherited: false, displayValue: '已设置' }),
        ],
      },
      {
        id: 'advanced',
        title: '高级设置',
        description: '模型与内部调优',
        advanced: true,
        fields: [field('model', 'string', { value: 'review-v2', displayValue: 'review-v2', configured: true, inherited: false })],
      },
    ],
  };
}

async function nextTurn(count = 1): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function input(instance: ReturnType<typeof render>, ...values: string[]): Promise<void> {
  for (const value of values) {
    instance.stdin.write(value);
    await nextTurn(2);
  }
}

async function confirmReview(
  instance: ReturnType<typeof render>,
  _value: TuiController,
): Promise<void> {
  await input(instance, '\r');
}

describe('ConsoleAppV4', () => {
  it('keeps the complete 109-state design map free of duplicate route identities', () => {
    expect(CONSOLE_V4_SCREEN_IDS).toHaveLength(109);
    expect(new Set(CONSOLE_V4_SCREEN_IDS)).toHaveProperty('size', 109);
    expect(CONSOLE_V4_SCREEN_IDS).toEqual([
      'G01', 'G02', 'G03', 'G04', 'G05',
      'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10',
      'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21',
      'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10',
      'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17',
      'S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09',
      'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17', 'S18',
      'I01', 'I02', 'I03', 'I04', 'I05', 'I06', 'I07', 'I08', 'I09',
      'I10', 'I11', 'I12', 'I13',
      'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09',
      'D10', 'D11', 'D12', 'D13', 'D14', 'D15', 'D16', 'D17',
      'U01', 'U02', 'U03', 'U04', 'U05', 'U06', 'U07', 'U08', 'U09', 'U10', 'U11',
      'K01', 'K02', 'K03', 'K04', 'K05', 'K06', 'K07',
    ]);
  });

  it('routes typed I01-I09 issues and the empty state through mounted pages', async () => {
    const loaded = loadResult();
    loaded.payload.catalog.sources = loaded.payload.catalog.sources.filter((source) => source.id !== 'research');
    const conflictTarget = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex'
      && entry.scope === 'project');
    if (conflictTarget) conflictTarget.state = 'present';
    loaded.payload.targets.push(
      target({ pluginName: 'missing', sourceId: 'archive', platform: 'codex', scope: 'user', state: 'error', errorCode: 'sourceMissing' }),
      target({ pluginName: 'changed', sourceId: 'team-tools', platform: 'codex', scope: 'project', state: 'error', errorCode: 'sourceChanged' }),
    );
    loaded.payload.errors.push({ code: 'legacyStateUnsupported', message: 'private legacy location' });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      checkSource: vi.fn().mockRejectedValue(new Error('remote unavailable')),
    });
    await value.load();
    const expected = new Map([
      ['incompleteInstallation', 'I03'],
      ['sourceDegraded', 'I04'],
      ['sourceMissing', 'I05'],
      ['sourceIdentityChanged', 'I06'],
      ['requiredConfigMissing', 'I07'],
      ['scopeConflict', 'I08'],
      ['legacyState', 'I09'],
    ] as const);
    const reached = new Set<ConsoleV4ScreenId>();
    value.push({ name: 'issueList' });
    const listInstance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => reached.add(screen)} />);
    await nextTurn(3);
    expect(reached).toContain('I01');
    expect((listInstance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    listInstance.unmount();
    for (const [category, screen] of expected) {
      const selected = value.listUserIssues().find((entry) => entry.category === category);
      expect(selected, category).toBeDefined();
      value.push({ name: 'issueDetail', issueId: selected!.issueId });
      const detailInstance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(current) => reached.add(current)} />);
      await nextTurn(2);
      expect(reached).toContain(screen);
      expect(detailInstance.lastFrame()).not.toContain('private legacy location');
      if (category === 'sourceMissing') {
        expect(detailInstance.lastFrame()).toContain('清理已安装内容');
        expect(detailInstance.lastFrame()).toContain('重新添加同一来源');
        expect(detailInstance.lastFrame()).toContain('技术详情');
        expect(detailInstance.lastFrame()).not.toContain('aw cleanup');
        expect(detailInstance.lastFrame()).not.toContain('--force');
      }
      expect((detailInstance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
      detailInstance.unmount();
      value.back();
    }

    const empty = loadResult();
    empty.payload.catalog.sources = [empty.payload.catalog.sources[0]!];
    empty.payload.targets = empty.payload.targets.map((entry) => ({ ...entry, state: 'absent' as const, errors: [] }));
    empty.payload.errors = [];
    empty.pluginSummaries = empty.pluginSummaries.map(({ configIssues: _issues, ...summary }) => summary);
    const emptyController = controller({ loadStatus: vi.fn().mockResolvedValue(empty) });
    await emptyController.load();
    emptyController.push({ name: 'issueList' });
    const emptyScreens: ConsoleV4ScreenId[] = [];
    const emptyInstance = render(<ConsoleAppV4 controller={emptyController} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => emptyScreens.push(screen)} />);
    await nextTurn(2);
    expect(emptyScreens).toContain('I02');
    expect(emptyInstance.lastFrame()).toContain('当前没有需要处理的问题');
  });

  it.each([
    ['shortcut', 80, 24],
    ['action', 80, 24],
    ['shortcut', 60, 18],
    ['action', 60, 18],
  ] as const)('shows every I09 manual recovery step through %s at %ix%i', async (
    entry,
    columns,
    rows,
  ) => {
    const loaded = loadResult();
    loaded.payload.errors.push({ code: 'legacyStateUnsupported', message: 'private legacy location' });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((candidate) => candidate.category === 'legacyState')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);

    await input(instance, entry === 'shortcut' ? 'd' : '\r');
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('1. 不自动迁移旧版状态。');
    expect(frame).toContain('2. 运行 aw status --json，记录公开错误 code。');
    expect(frame).toContain('3. 备份相关 AW 配置。');
    expect(frame).toContain('4. 按技术详情使用受支持命令或人工处理。');
    expect(frame).toContain('5. 再次运行状态检查。');
    expect(frame).toContain('› 查看手动处理说明');
    expect(frame).toContain('d 技术详情');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    expect(frame).not.toContain('private legacy location');
  });

  it('uses typed issue origin for I10-I12 and reloads the issue list after success', async () => {
    const initial = loadResult();
    initial.payload.catalog.sources = [initial.payload.catalog.sources[0]!];
    initial.payload.targets = [target({ pluginName: 'review-gate', platform: 'codex', scope: 'user', state: 'partial' })];
    initial.pluginSummaries = [initial.pluginSummaries[1]!];
    const resolved = structuredClone(initial);
    resolved.payload.targets[0] = { ...resolved.payload.targets[0]!, state: 'present', errors: [] };
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValue(resolved);
    let completeExecution!: (value: unknown) => void;
    const execution = new Promise((resolve) => { completeExecution = resolve; });
    const executeIntent = vi.fn().mockReturnValue(execution);
    const value = controller({ loadStatus, executeIntent });
    await value.load();
    const selected = value.listUserIssues().find((entry) => entry.category === 'incompleteInstallation')!;
    value.push({ name: 'issueDetail', issueId: selected.issueId });
    const screens: ConsoleV4ScreenId[] = [];
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.push(screen)} />);
    await nextTurn(2);
    await input(instance, '\r');
    expect(value.snapshot.activeReview?.originIssue).toMatchObject({
      issueId: selected.issueId,
      category: 'incompleteInstallation',
      actionId: 'reinstall',
    });
    instance.unmount();
    const reviewInstance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.push(screen)} />);
    await nextTurn(2);
    expect(screens).toContain('I10');
    await confirmReview(reviewInstance, value);
    reviewInstance.unmount();
    const progressInstance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.push(screen)} />);
    await nextTurn(2);
    expect(screens).toContain('I11');
    completeExecution({
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    await nextTurn(4);
    progressInstance.unmount();
    const resultInstance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.push(screen)} />);
    await nextTurn(2);
    expect(screens).toContain('I12');
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      originIssue: expect.objectContaining({ issueId: selected.issueId }),
    }), evidence);
    expect(value.listUserIssues().some((entry) => entry.issueId === selected.issueId)).toBe(false);
    resultInstance.unmount();
  });

  it('cleans a Catalog orphan through ordinary cleanup and removes it from both lists after refresh', async () => {
    const initial = orphanLoadResult();
    const resolved = structuredClone(initial);
    resolved.payload.targets = [];
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(resolved);
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    const value = controller({ loadStatus, executeIntent });
    await value.load();

    expect(value.listPlugins({ mode: 'browse' }).map((plugin) => plugin.pluginId))
      .toEqual(['official/retired-tool']);
    expect(value.listPlugins({ mode: 'installed' }).map((plugin) => plugin.pluginId))
      .toEqual(['official/retired-tool']);
    const issue = value.listUserIssues()[0]!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('当前 Catalog 不再包含此插件');
    expect(instance.lastFrame()).toContain('清理已安装内容');
    expect(instance.lastFrame()).not.toContain('--force');
    await input(instance, '\r');

    const reviewFrame = instance.lastFrame() ?? '';
    expect(value.snapshot.activeReview).toMatchObject({
      pluginAction: 'cleanup',
      originIssue: { actionId: 'cleanup' },
      equivalentCommand: 'aw cleanup official/retired-tool --platform codex --scope user',
    });
    expect(reviewFrame).toContain('只清理可证明属于 AW 的现场内容');
    expect(reviewFrame).toContain('保留插件设置');
    expect(reviewFrame).toContain('不运行 uninstall lifecycle');
    expect(reviewFrame).toContain('等价命令：aw cleanup official/retired-tool --platform codex --scope user');
    expect(reviewFrame).not.toContain('--force');

    await confirmReview(instance, value);
    await nextTurn(4);

    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite',
      action: 'cleanup',
      pluginId: 'official/retired-tool',
      platform: 'codex',
      scope: 'user',
    }), evidence);
    expect(executeIntent.mock.calls[0]?.[0]).not.toHaveProperty('force');
    expect(value.listPlugins({ mode: 'browse' })).toEqual([]);
    expect(value.listPlugins({ mode: 'installed' })).toEqual([]);
    expect(value.listUserIssues()).toEqual([]);
    expect(instance.lastFrame()).toContain('问题已处理');
  });

  it('keeps the Catalog orphan issue when ordinary cleanup is blocked by a dependent', async () => {
    const initial = orphanLoadResult();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(initial),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        targetResults: [{
          target: { pluginId: 'official/retired-tool', platform: 'codex', scope: 'user' },
          action: 'cleanup',
          state: 'failed',
          errorCode: 'dependencyStillRequired',
        }],
      }),
    });
    await value.load();
    const issue = value.listUserIssues()[0]!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await input(instance, '\r');
    await confirmReview(instance, value);
    await nextTurn(4);

    expect(value.snapshot.result).toMatchObject({
      state: 'blocked',
      code: 'dependencyStillRequired',
      originIssue: { issueId: issue.issueId, actionId: 'cleanup' },
    });
    expect(value.listUserIssues()).toContainEqual(expect.objectContaining({ issueId: issue.issueId }));
    expect(value.snapshot.result).not.toHaveProperty('writeMayHaveCompleted');
    expect(instance.lastFrame()).toContain('问题仍未解决');
    expect(instance.lastFrame()).toContain('操作被安全阻止');
    expect(instance.lastFrame()).toContain('dependencyStillRequired');
    expect(instance.lastFrame()).not.toContain('--force');
  });

  it('keeps a failed issue and routes I13 back to its detail with a fixed error', async () => {
    const initial = loadResult();
    initial.payload.catalog.sources = [initial.payload.catalog.sources[0]!];
    initial.payload.targets = [target({ pluginName: 'review-gate', platform: 'codex', scope: 'user', state: 'partial' })];
    initial.pluginSummaries = [initial.pluginSummaries[1]!];
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(initial),
      executeIntent: vi.fn().mockRejectedValue(new Error('/Users/private/raw failure')),
    });
    await value.load();
    const selected = value.listUserIssues().find((entry) => entry.category === 'incompleteInstallation')!;
    value.push({ name: 'issueDetail', issueId: selected.issueId });
    const screens: ConsoleV4ScreenId[] = [];
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.push(screen)} />);
    await nextTurn(2);
    await input(instance, '\r');
    await confirmReview(instance, value);
    await nextTurn(3);
    expect(screens).toContain('I13');
    expect(instance.lastFrame()).not.toContain('/Users/private');
    expect(instance.lastFrame()).toContain('返回问题详情');
    expect(instance.lastFrame()).toContain('重新检查问题');
    expect(instance.lastFrame()).not.toContain('重试失败部分…');
    expect(value.listUserIssues().some((entry) => entry.issueId === selected.issueId)).toBe(true);
  });

  it.each([
    { key: '', actionId: 'keepUserScope', removedScope: 'project' },
    { key: '\u001B[B', actionId: 'keepProjectScope', removedScope: 'user' },
  ] as const)('maps the canonical scope choice $actionId to removing $removedScope', async ({ key, actionId, removedScope }) => {
    const loaded = loadResult();
    loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
    loaded.payload.targets = [
      target({ pluginName: 'review-gate', platform: 'codex', scope: 'user', state: 'present' }),
      target({ pluginName: 'review-gate', platform: 'codex', scope: 'project', state: 'present' }),
    ];
    loaded.pluginSummaries = [loaded.pluginSummaries[1]!];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const conflict = value.listUserIssues().find((entry) => entry.category === 'scopeConflict')!;
    value.push({ name: 'issueDetail', issueId: conflict.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    await input(instance, ...(key ? [key] : []), '\r');
    expect(value.snapshot.activeReview).toMatchObject({
      pluginAction: 'uninstall',
      originIssue: { issueId: conflict.issueId, issueKey: userIssueKey(conflict), category: 'scopeConflict', actionId },
    });
    expect((value.dependencies.captureEvidence as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toMatchObject({
      pluginId: 'official/review-gate',
      scope: removedScope,
    });
  });

  it.each([
    ['present', 'error'],
    ['error', 'present'],
  ] as const)('does not mount keep-one-scope actions for %s + %s', async (userState, projectState) => {
    const loaded = loadResult();
    loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
    loaded.payload.targets = [
      target({ pluginName: 'review-gate', platform: 'codex', scope: 'user', state: userState }),
      target({ pluginName: 'review-gate', platform: 'codex', scope: 'project', state: projectState }),
    ];
    loaded.pluginSummaries = [loaded.pluginSummaries[1]!];
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
      executeIntent,
    });
    await value.load();
    const diagnostic = value.listUserIssues().find((entry) => entry.category === 'diagnostic')!;
    value.push({ name: 'issueDetail', issueId: diagnostic.issueId });

    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).not.toContain('保留所有项目');
    expect(instance.lastFrame()).not.toContain('保留当前项目');
    expect(value.listUserIssues().some((entry) => entry.category === 'scopeConflict')).toBe(false);
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();

    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('targetError');
    await input(instance, 'd');
    const technicalIndex = diagnostic.actions.findIndex((action) => action.id === 'viewTechnical');
    for (let index = 0; index < technicalIndex; index += 1) await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 技术详情');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('targetError');
  });

  it('reaches every P state through a real mounted controller snapshot', async () => {
    const reached = new Set<ConsoleV4ScreenId>();
    const mountRoute = async (
      route: Parameters<TuiController['push']>[0],
      expected: ConsoleV4ScreenId,
      value = controller(),
    ): Promise<void> => {
      value.push(route);
      const instance = render(<ConsoleAppV4
        controller={value}
        size={{ columns: 80, rows: 24 }}
        onScreenChange={(screen) => reached.add(screen)}
      />);
      await nextTurn(3);
      expect(reached.has(expected), `${expected} was not reached`).toBe(true);
      instance.unmount();
      instance.cleanup();
    };

    await mountRoute({ name: 'pluginList', mode: 'browse' }, 'P01');
    const search = controller();
    search.push({ name: 'pluginList', mode: 'browse' });
    const searchInstance = render(<ConsoleAppV4 controller={search} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
    await nextTurn(3);
    await input(searchInstance, '/');
    expect(reached.has('P02')).toBe(true);
    searchInstance.unmount();
    searchInstance.cleanup();
    await mountRoute({ name: 'pluginList', mode: 'browse', sourceId: 'research' }, 'P03');
    await mountRoute({ name: 'pluginPreview', pluginId: 'official/agent-lab' }, 'P04');
    await mountRoute({ name: 'installPlacement', pluginId: 'official/agent-lab' }, 'P05');
    await mountRoute({ name: 'installTargets', pluginId: 'official/agent-lab' }, 'P06');
    await mountRoute({ name: 'pluginList', mode: 'installed' }, 'P11');
    const emptyData = loadResult();
    emptyData.payload.targets = emptyData.payload.targets.map((entry) => ({ ...entry, state: 'absent', errors: [] }));
    await mountRoute({ name: 'pluginList', mode: 'installed' }, 'P12', controller({
      loadStatus: vi.fn().mockResolvedValue(emptyData),
    }));
    await mountRoute({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' }, 'P13');
    await mountRoute({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' }, 'P14');
    await mountRoute({ name: 'platform', pluginId: 'official/agent-lab', platform: 'codex' }, 'P15');
    await mountRoute({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'claude' }, 'P16');
    const unavailableData = loadResult();
    unavailableData.payload.catalog.sources = unavailableData.payload.catalog.sources.map((entry) =>
      entry.id === 'team-tools'
        ? { ...entry, error: 'unavailable', errorCode: 'catalogSourceUnavailable', freshness: undefined }
        : entry);
    await mountRoute({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' }, 'P17', controller({
      loadStatus: vi.fn().mockResolvedValue(unavailableData),
    }));
    await mountRoute({ name: 'pluginAbout', pluginId: 'team-tools/review-gate' }, 'P20');
    await mountRoute({ name: 'pluginTechnical', pluginId: 'team-tools/review-gate' }, 'P21');

    const prepare = async (
      action: 'install' | 'reinstall' | 'uninstall',
      executeIntent: TuiControllerDependencies['executeIntent'] = vi.fn().mockResolvedValue({
        targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
      }),
    ): Promise<{ value: TuiController; token: string }> => {
      const value = controller({ executeIntent });
      await value.load();
      const review = await value.buildOperationReview({
        kind: 'pluginWrite',
        action,
        pluginId: action === 'install' ? 'official/agent-lab' : 'team-tools/review-gate',
        platform: 'codex',
        scope: 'user',
      });
      return { value, token: review.reviewToken };
    };
    for (const [action, expected] of [['install', 'P07'], ['reinstall', 'P18'], ['uninstall', 'P19']] as const) {
      const prepared = await prepare(action);
      const instance = render(<ConsoleAppV4 controller={prepared.value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
      await nextTurn(3);
      expect(reached.has(expected)).toBe(true);
      instance.unmount();
      instance.cleanup();
    }
    const pending = new Promise<unknown>(() => undefined);
    const progress = await prepare('install', vi.fn(() => pending));
    void progress.value.executeOperation(progress.token);
    await nextTurn(2);
    const progressInstance = render(<ConsoleAppV4 controller={progress.value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
    await nextTurn(3);
    expect(reached.has('P08')).toBe(true);
    progressInstance.unmount();
    progressInstance.cleanup();
    const success = await prepare('install');
    await success.value.executeOperation(success.token);
    const successInstance = render(<ConsoleAppV4 controller={success.value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
    await nextTurn(3);
    expect(reached.has('P09')).toBe(true);
    successInstance.unmount();
    successInstance.cleanup();
    const partial = await prepare('install', vi.fn().mockResolvedValue({ targetResults: [
      { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
      { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
    ] }));
    await partial.value.executeOperation(partial.token);
    const partialInstance = render(<ConsoleAppV4 controller={partial.value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => reached.add(screen)} />);
    await nextTurn(3);
    expect(reached.has('P10')).toBe(true);
    partialInstance.unmount();
    partialInstance.cleanup();

    expect([...reached].filter((screen) => screen.startsWith('P')).sort()).toEqual(
      CONSOLE_V4_SCREEN_IDS.filter((screen) => screen.startsWith('P')).sort(),
    );
  }, 30_000);

  it('mounts the loading skeleton and keeps ordinary exit separate from G04 discard', async () => {
    const screens: ConsoleV4ScreenId[] = [];
    const exit = vi.fn();
    const value = controller();
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onExit={exit}
      onScreenChange={(screen) => screens.push(screen)}
    />);
    expect(instance.lastFrame()).toContain('正在检查插件状态');
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('管理你的 Agent 工作流插件');

    await input(instance, '?');
    expect(instance.lastFrame()).toContain('当前页快捷键');
    await input(instance, '?', 'q');
    expect(instance.lastFrame()).toContain('退出控制台？');
    await input(instance, '\u001B[B', '\r');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
    expect(screens).toEqual(expect.arrayContaining(['G01', 'G02', 'G03']));
    expect(screens).not.toContain('G04');
  });

  it('shows the stable primary root cause on an installed plugin row', async () => {
    const loaded = loadResult();
    const consumer = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'team-tools/review-gate' && entry.platform === 'codex');
    expect(consumer).toBeDefined();
    consumer!.state = 'partial';
    consumer!.errors = [{
      code: 'dependencyNotReady',
      message: 'safe dependency symptom',
      dependencyPluginId: 'team-tools/toolkit',
      rootIssueId: 'artifactCollision:team-tools/toolkit:codex:user:agent:toolkit',
      rootIssueCode: 'artifactCollision',
    }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 24 }} />);
    await nextTurn(3);

    expect(instance.lastFrame()).toContain('artifactCollision');
    expect(instance.lastFrame()).toContain('AW 不会覆盖或删除');
    instance.unmount();
  });

  it.each([
    [80, 24],
    [60, 18],
  ] as const)('keeps every G03 shortcut meaning and the single close focus visible at %ix%i', async (columns, rows) => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    await value.load();
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns, rows }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await nextTurn(2);
    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 我的插件');

    await input(instance, '?');
    for (const [key, meaning] of [
      ['↑/↓ · j/k', '移动当前唯一焦点'],
      ['Enter', '打开、选择或继续'],
      ['q / Ctrl-C', '退出控制台'],
      ['?', '关闭帮助'],
    ]) {
      expect(instance.lastFrame()).toContain(`${key}  ${meaning}`);
    }
    for (const direction of ['\u001B[A', '\u001B[B', '\u001B[D', '\u001B[C']) {
      await input(instance, direction);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('› 关闭');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    }
    expect(screens).toContain('G03');

    await input(instance, '\r');
    expect(instance.lastFrame()).not.toContain('当前页快捷键');
    expect(instance.lastFrame()).toContain('› 我的插件');
    await input(instance, '?');
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTurn(2);
    expect(instance.lastFrame()).not.toContain('当前页快捷键');
    expect(instance.lastFrame()).toContain('› 我的插件');
    await input(instance, '?', '?');
    expect(instance.lastFrame()).not.toContain('当前页快捷键');
    expect(instance.lastFrame()).toContain('› 我的插件');

    value.push({ name: 'pluginList', mode: 'browse' });
    await nextTurn(2);
    await input(instance, '?');
    expect(instance.lastFrame()).toContain('←/→ · [ / ]  切换来源');
    expect(instance.lastFrame()).toContain('/  进入搜索');
    await input(instance, '?');

    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    await nextTurn(2);
    expect(instance.lastFrame()).not.toContain('? 帮助');
    await input(instance, '?');
    expect(instance.lastFrame()).not.toContain('当前页快捷键');
    expect(instance.lastFrame()).not.toContain('Space  切换目标平台选择');

    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    await nextTurn(2);
    await input(instance, '?');
    expect(instance.lastFrame()).toContain('d  打开技术详情');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    await input(instance, '?');

    value.replace({ name: 'sourceList' });
    await nextTurn(2);
    await input(instance, '?');
    expect(instance.lastFrame()).toContain('r  重新检查来源');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    await input(instance, '?');

    value.replace({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    await nextTurn(3);
    await input(instance, '?');
    expect(instance.lastFrame()).toContain('s  保存设置');
    expect(instance.lastFrame()).toContain('u  恢复当前字段继承');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    await input(instance, '?');
  });

  it('keeps unfinished loading work active or pending without claiming completion', async () => {
    const pendingLoad = deferred<TuiStatusLoadResult>();
    const value = controller({ loadStatus: vi.fn(() => pendingLoad.promise) });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('● 读取插件来源');
    expect(instance.lastFrame()).toContain('○ 检查当前项目');
    expect(instance.lastFrame()).not.toContain('✓ 读取插件来源');
    pendingLoad.resolve(loadResult());
    await nextTurn(3);
  });

  it('shows cached and unavailable source counts independently on the mounted home page', async () => {
    for (const size of [{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }]) {
      const instance = render(<ConsoleAppV4 controller={controller({
        checkSource: vi.fn().mockRejectedValue(new Error('remote unavailable')),
      })} size={size} />);
      await nextTurn(3);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('1 个来源使用缓存');
      expect(frame).toContain('1 个来源不可用');
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
      instance.unmount();
      instance.cleanup();
    }
  });

  it('shows structured dependency diagnostics when legacy technical details are empty', async () => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: 'dependencyMissing',
      rootErrorMessage: 'dependencyMissing: official/skill-toolkit has changed state.',
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((candidate) =>
      candidate.category === 'dependencyMissing' && candidate.scope === 'project')!;
    const issuesWithoutDetails = value.listUserIssues().map((candidate) => candidate.issueId === issue.issueId
      ? { ...candidate, technicalDetails: [] }
      : candidate);
    vi.spyOn(value, 'listUserIssues').mockReturnValue(issuesWithoutDetails);
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('技术详情');
    expect(frame).toContain('d 技术详情');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('dependencyMissing');
    expect(instance.lastFrame()).toContain('resolve-dependencies');
    expect(instance.lastFrame()).not.toContain('has changed state');
  });

  it('does not treat target platform selection as an unsaved write', async () => {
    const screens: ConsoleV4ScreenId[] = [];
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => screens.push(screen)}
      onExit={exit}
    />);
    await nextTurn(3);

    await input(instance, '\r', 'q');
    expect(instance.lastFrame()).toContain('退出控制台？');
    expect(screens).not.toContain('G04');
    await input(instance, '\u001B[B', '\r');

    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
  });

  it('keeps the same-scope target selection after Back and lets Ctrl-C exit from help', async () => {
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(3);

    await input(instance, '\r', '\r', '\r');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installPlacement', pluginId: 'official/agent-lab' });
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(exit).not.toHaveBeenCalled();

    await input(instance, '?', '\u0003');
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
  });

  it('lets Ctrl-C exit while the ordinary exit overlay is open', async () => {
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(3);
    await input(instance, '\r', 'q', '\u0003');
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
  });

  it('uses Enter for each target and only confirms from the visible confirmation action', async () => {
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ captureEvidence });
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    await input(instance, '\r', '\r');

    expect(instance.lastFrame()).toContain('◇ Codex');
    expect(instance.lastFrame()).toContain('◇ Claude Code');
    expect(instance.lastFrame()).not.toContain('● Codex');
    expect(instance.lastFrame()).toContain('确认目标平台');
    expect(instance.lastFrame()).toContain('返回选择位置');
    expect(instance.lastFrame()).toContain('至少选择一个目标平台');
    expect(instance.lastFrame()).toContain('↑↓ 移动 · Enter 选择/确认 · Esc 返回');

    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('installTargets');
    expect(value.snapshot.activeReview).toBeUndefined();
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(captureEvidence).not.toHaveBeenCalled();

    await input(instance, '\u001B[B', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite', action: 'install', platform: 'codex', scope: 'user',
    }), expect.any(AbortSignal));
  });

  it('mounts ReviewPreparing before deferred validation and lets Esc cancel without creating Review', async () => {
    const validation = deferred<void>();
    const captured = deferred<OperationEvidence>();
    const executeIntent = vi.fn();
    const value = controller({
      validateIntent: vi.fn(() => validation.promise),
      captureEvidence: vi.fn(() => captured.promise),
      executeIntent,
    });
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' }, { focusIndex: 1 });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '\r', '\u001B[B', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('reviewPreparing');
    expect(instance.lastFrame()).toContain('正在准备插件操作确认');
    expect(instance.lastFrame()).toContain('● 验证当前状态');
    expect(instance.lastFrame()).toContain('○ 准备确认信息');
    expect(instance.lastFrame()).toContain('当前');
    expect(instance.lastFrame()).toContain('Agent Lab');
    expect(instance.lastFrame()).toContain('Esc 取消 · Ctrl-C 完成后退出');
    expect(executeIntent).not.toHaveBeenCalled();

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
    expect(value.snapshot.router.current.context).toEqual({
      focusIndex: 2, scrollOffset: 0, query: '', installFilter: 'all', sourceTabId: undefined,
    });
    expect(instance.lastFrame()).toContain('◆ Codex');
    validation.resolve();
    captured.resolve(evidence);
    await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('installTargets');
    expect(value.snapshot.activeReview).toBeUndefined();
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('keeps accepted Progress non-cancellable by Esc', async () => {
    const execution = deferred<unknown>();
    const value = controller({ executeIntent: vi.fn(() => execution.promise) });
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    void value.executeOperation(review.reviewToken);
    await nextTurn(2);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await nextTurn(2);

    expect(value.snapshot.router.current.route).toEqual({ name: 'progress', operationId: review.operationId });
    expect(instance.lastFrame()).toContain('Ctrl-C 完成后退出');
    execution.resolve({
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    await nextTurn(3);
  });

  it('renders a safe failed preparation with focused retry and Back actions', async () => {
    const validateIntent = vi.fn()
      .mockRejectedValueOnce(new Error('/Users/private/raw failure'))
      .mockResolvedValueOnce(undefined);
    const value = controller({ validateIntent });
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    value.startReviewPreparation({
      kind: 'sourceMutation', action: 'setPrimary', sourceId: 'team-tools',
    });
    await nextTurn(2);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('无法准备确认信息');
    expect(frame).toContain('reviewPreparationFailed');
    expect(frame).toContain('› 重试');
    expect(frame).toContain('返回修改');
    expect(frame).not.toContain('/Users/private/raw failure');

    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(validateIntent).toHaveBeenCalledTimes(2);
  });

  it('automatically selects the only compatible target platform after the scope choice', async () => {
    const loaded = loadResult();
    const summary = loaded.pluginSummaries.find((entry) => entry.pluginId === 'official/agent-lab')!;
    summary.supportedTargets = { codex: ['user'], claude: [] };
    loaded.payload.targets = loaded.payload.targets.filter((entry) =>
      entry.pluginId !== 'official/agent-lab'
      || entry.platform === 'codex' && entry.scope === 'user');
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, '\r', '\r');
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(instance.lastFrame()).not.toContain('Claude Code');
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite', action: 'install', platform: 'codex', scope: 'user',
    }), expect.any(AbortSignal));
  });

  it('recomputes and replaces target selection when the scope changes', async () => {
    const loaded = loadResult();
    const summary = loaded.pluginSummaries.find((entry) => entry.pluginId === 'official/agent-lab')!;
    summary.supportedTargets = { codex: ['user', 'project'], claude: ['user'] };
    loaded.payload.targets = loaded.payload.targets.filter((entry) =>
      entry.pluginId !== 'official/agent-lab'
      || entry.platform === 'codex'
      || entry.platform === 'claude' && entry.scope === 'user');
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, '\r', '\r', '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('◆ Claude Code');
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installPlacement', pluginId: 'official/agent-lab' });
    await input(instance, '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('◆ Codex');
    expect(instance.lastFrame()).toContain('Claude Code');
    expect(instance.lastFrame()).toContain('不支持所选位置');
    await input(instance, 'b', '\u001B[A', '\r');
    expect(instance.lastFrame()).toContain('◇ Codex');
    expect(instance.lastFrame()).toContain('◆ Claude Code');
  });

  it('preselects a compatible target platform from its platform detail add action', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/agent-lab', platform: 'claude' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, '\r', '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
    expect(instance.lastFrame()).toContain('◇ Codex');
    expect(instance.lastFrame()).toContain('◆ Claude Code');
  });

  it.each([
    [80, 24],
    [60, 18],
  ] as const)('skips a disabled first target platform while keeping it inert at %ix%i', async (columns, rows) => {
    const loaded = dependencyLoadResult();
    const dependency = loaded.pluginSummaries.find((entry) => entry.pluginId === 'official/skill-toolkit')!;
    dependency.supportedTargets = { codex: [], claude: ['user', 'project'] };
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    value.push({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);

    const initial = instance.lastFrame() ?? '';
    expect(initial).toContain('◇ Codex');
    expect(initial).toContain('Agent Skill Toolkit 不支持Codex');
    expect(initial).toContain('› ◇ Claude Code');
    expect(initial).toContain('确认目标平台');
    expect(initial.match(/›/gu)).toHaveLength(1);
    expect(initial.split('\n').length).toBeLessThanOrEqual(rows);
    await input(instance, ' ');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
    expect(value.snapshot.activeReview).toBeUndefined();
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('◇ Codex');

    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 返回选择位置');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    await input(instance, '\u001B[A');
    expect(instance.lastFrame()).toContain('› ◇ Claude Code');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('◆ Claude Code');
    expect(captureEvidence).not.toHaveBeenCalled();
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
  });

  it('routes a fully incompatible install directly to the blocked target page', async () => {
    const loaded = dependencyLoadResult();
    const dependency = loaded.pluginSummaries.find((entry) => entry.pluginId === 'official/skill-toolkit')!;
    dependency.supportedTargets = { codex: [], claude: [] };
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('所选目标平台不可用');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'installTargets', pluginId: 'official/agent-lab', view: 'blocked',
    });
    expect(value.snapshot.activeReview).toBeUndefined();
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('? 帮助');
    await input(instance, '?');
    expect(instance.lastFrame()).toContain('当前页快捷键');
  });

  it('makes the P05 scope choice enter P06 directly with one visible focus', async () => {
    for (const size of [{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }]) {
      const value = controller();
      value.push({ name: 'installPlacement', pluginId: 'official/agent-lab' });
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(3);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toMatch(/› ● (所有项目|当前项目)/u);
      expect(frame).not.toContain('继续');
      expect(frame).not.toContain('调整目标平台');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame).toContain('↑↓ 移动');
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
      if (size.columns === 80) expect(frame).toContain('适合个人常用能力');
      await input(instance, '\r');
      expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
      instance.unmount();
      instance.cleanup();
    }
  });

  it('does not dispose an externally owned controller and exits initial load failure nonzero', async () => {
    const exit = vi.fn();
    const value = controller({ loadStatus: vi.fn().mockRejectedValue(new Error('statusUnavailable: private')) });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('无法读取插件状态');
    await input(instance, '\u0003');
    expect(exit).toHaveBeenCalledWith({ code: 1, reason: 'initialError' });
    instance.unmount();
    expect(value.snapshot.phase).toBe('error');
  });

  it('handles Ctrl-C before search input and exits without changing the query', async () => {
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(3);
    await input(instance, '/', '\u0003');
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
    expect(instance.lastFrame()).toContain('/ 输入搜索内容');
  });

  it('exits once after a busy stale operation returns to Review', async () => {
    const pending = deferred<unknown>();
    const exit = vi.fn();
    const value = controller({ executeIntent: vi.fn(() => pending.promise) });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    void value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(2);
    expect(value.snapshot.router.current.route.name).toBe('progress');

    await input(instance, '\u0003');
    pending.reject(new Error('operationReviewStale: changed'));
    await nextTurn(4);

    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'stale' });
  });

  it.each([
    ['Ctrl-C', '\u0003'],
    ['q', 'q'],
  ])('defers %s while a busy screen is too small and exits once after completion', async (_label, exitInput) => {
    const pending = deferred<unknown>();
    const exit = vi.fn();
    const value = controller({ executeIntent: vi.fn(() => pending.promise) });
    const dispose = vi.spyOn(value, 'dispose');
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    void value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} ownsController />);
    await nextTurn(2);
    expect(value.snapshot.router.current.route.name).toBe('progress');

    instance.rerender(<ConsoleAppV4 controller={value} size={{ columns: 52, rows: 14 }} onExit={exit} ownsController />);
    await input(instance, exitInput, '\r');
    expect(instance.lastFrame()).toContain('终端空间不足');
    expect(exit).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();

    pending.resolve({
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    await nextTurn(4);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'completed' });
  });

  it('keeps an installed plugin visible when its source is unavailable', async () => {
    const unavailable = loadResult();
    unavailable.payload.catalog.sources = unavailable.payload.catalog.sources.map((entry) =>
      entry.id === 'team-tools'
        ? { ...entry, error: 'unavailable', errorCode: 'catalogSourceUnavailable', freshness: undefined }
        : entry);
    unavailable.pluginSummaries.push({
      pluginName: 'catalog-only',
      pluginId: 'team-tools/catalog-only',
      displayName: 'Catalog Only',
      description: 'Only in the unavailable catalog',
      supportedTargets: { codex: ['user'], claude: [] },
    });
    unavailable.payload.targets = [
      ...unavailable.payload.targets.map((entry) => entry.pluginId === 'team-tools/review-gate'
        ? { ...entry, state: entry.platform === 'codex' && entry.scope === 'user' ? 'error' as const : 'absent' as const,
            errors: entry.platform === 'codex' && entry.scope === 'user'
              ? [{ code: 'nativeStateUnreadable', message: 'safe live owner failure' }]
              : [] }
        : entry),
      target({ pluginName: 'catalog-only', sourceId: 'team-tools', platform: 'codex', scope: 'user', state: 'absent' }),
    ];
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(unavailable),
      checkSource: vi.fn().mockRejectedValue(new Error('remote unavailable')),
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('✓ 1 个插件可用');
    await input(instance, '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('Review Gate');
    expect(instance.lastFrame()).toContain('来源不可用');
    expect(instance.lastFrame()).not.toContain('Catalog Only');
    await input(instance, '\r', '\r');
    expect(screens).toContain('P17');
    expect(instance.lastFrame()).toContain('来源不可用');
  });

  it('counts source tabs from the active browse or installed list mode', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    expect((instance.lastFrame() ?? '').replace(/\s+/gu, ' ')).toContain('[全部 3] official 2 team-tools 1');

    value.replace({ name: 'pluginList', mode: 'installed' });
    await nextTurn(2);
    expect((instance.lastFrame() ?? '').replace(/\s+/gu, ' ')).toContain('[全部 1] official 0 team-tools 1');
  });

  it('normalizes a mounted detail route when refresh removes its current plugin', async () => {
    const initial = loadResult();
    const removed = loadResult();
    initial.payload.catalog.sources = initial.payload.catalog.sources.map((source) => source.id === 'team-tools'
      ? { ...source, type: 'path' as const, requestedRef: 'path', freshness: 'path' as const }
      : source);
    removed.payload.catalog.sources = removed.payload.catalog.sources.map((source) => source.id === 'team-tools'
      ? { ...source, type: 'path' as const, requestedRef: 'path', freshness: 'path' as const }
      : source);
    removed.pluginSummaries = removed.pluginSummaries.filter((entry) => entry.pluginId !== 'team-tools/review-gate');
    removed.payload.targets = removed.payload.targets.filter((entry) => entry.pluginId !== 'team-tools/review-gate');
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(removed),
      checkSource: vi.fn().mockResolvedValue({ sourceIdentity: 'identity:team-tools', requestedRef: 'path' }),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('Review Gate');

    await value.refreshSource('team-tools');
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
    expect(instance.lastFrame()).not.toContain('后续阶段');
  });

  it('routes platform errors to typed issues without offering reinstall or removal', async () => {
    const loaded = loadResult();
    const failed = loaded.payload.targets.find((entry) => entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex' && entry.scope === 'user');
    if (failed) {
      failed.state = 'error';
      failed.errors = [{ code: 'sourceChanged', message: '/private/source changed' }];
    }
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('查看对应问题');
    expect(instance.lastFrame()).not.toContain('重新连接缺失内容');
    expect(instance.lastFrame()).not.toContain('移除');
    expect(instance.lastFrame()).not.toContain('/private/source');
  });

  it('shows the catalog version in the platform upgrade action only from revision sidecar evidence', async () => {
    const loaded = loadResult();
    loaded.targetRevisions = [{
      pluginId: 'team-tools/review-gate',
      platform: 'codex',
      scope: 'user',
      revision: {
        state: 'upgradeAvailable',
        availableVersion: '0.5.0',
        installedVersion: '0.4.2',
      },
    }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'platform', pluginId: 'team-tools/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('升级到 0.5.0…');
    expect(instance.lastFrame()).toContain('已安装版本 0.4.2');
  });

  it('keeps the focused platform action by ID when a live refresh inserts upgrade first', async () => {
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(platformLoadResult('current'))
      .mockResolvedValue(platformLoadResult('upgradeAvailable'));
    const value = controller({ loadStatus });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, '\u001B[B', '\u001B[B');
    expect(instance.lastFrame()).toContain('› 查看安装详情');

    await value.load();
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('升级到 0.3.0…');
    expect(instance.lastFrame()).toContain('› 查看安装详情');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginTechnical',
      pluginId: 'official/review-gate',
    });
  });

  it('focuses and runs the first platform action when a live refresh removes the focused action', async () => {
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(platformLoadResult('upgradeAvailable'))
      .mockResolvedValue(platformLoadResult('current'));
    const value = controller({ loadStatus });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/review-gate', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('› 升级到 0.3.0…');

    await value.load();
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('› 重新安装…');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);

    await input(instance, '\r');
    expect(value.snapshot.activeReview).toMatchObject({
      operationKind: 'pluginWrite',
      pluginAction: 'reinstall',
    });
    expect(value.dependencies.captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite',
      action: 'reinstall',
      pluginId: 'official/review-gate',
      platform: 'codex',
      scope: 'user',
    }), expect.any(AbortSignal));
  });

  it('shows only safe verbose component fields on P21 and keeps non-verbose P21 unchanged', async () => {
    const verbose = loadResult();
    const targetWithComponent = verbose.payload.targets.find((entry) => entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex' && entry.scope === 'user');
    if (targetWithComponent) targetWithComponent.components = [{
      key: 'skill:review', state: 'error', error: { code: 'componentInspectionFailed', message: '/private/raw component label' },
    }];
    const verboseValue = controller({ loadStatus: vi.fn().mockResolvedValue(verbose) });
    await verboseValue.load();
    verboseValue.push({ name: 'pluginTechnical', pluginId: 'team-tools/review-gate' });
    const verboseInstance = render(<ConsoleAppV4 controller={verboseValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(verboseInstance.lastFrame()).toContain('skill:review');
    expect(verboseInstance.lastFrame()).toContain('componentInspectionFailed');
    expect(verboseInstance.lastFrame()).not.toContain('/private/raw');

    const normalValue = controller();
    normalValue.push({ name: 'pluginTechnical', pluginId: 'team-tools/review-gate' });
    const normalInstance = render(<ConsoleAppV4 controller={normalValue} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(normalInstance.lastFrame()).not.toContain('skill:review');
  });

  it.each([
    [60, 18, 10],
    [80, 24, 14],
  ] as const)('prioritizes exceptional P21 components and preserves return at %ix%i with %i items', async (
    columns,
    rows,
    componentCount,
  ) => {
    const loaded = loadResult();
    const selected = loaded.payload.targets.find((entry) => entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex' && entry.scope === 'user')!;
    selected.components = [
      ...Array.from({ length: componentCount - 2 }, (_, index) => ({
        key: `ordinary:${index}`,
        state: 'present' as const,
      })),
      { key: 'error-code', state: 'error' as const, error: { code: 'componentInspectionFailed', message: '/private/component' } },
      { key: 'partial-code', state: 'partial' as const },
    ];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    value.push({ name: 'pluginTechnical', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('error-code');
    expect(frame).toContain('componentInspectionFailed');
    expect(frame).toContain('partial-code');
    expect(frame).toMatch(/另有 \d+ 个组件/u);
    expect(frame).toContain('› 返回插件');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame).toContain('╭');
    expect(frame).toContain('╰');
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    expect(frame).not.toContain('/private/component');

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
  });

  it('keeps source tabs out of the vertical focus and searches same-name plugins by canonical identity', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    const initial = instance.lastFrame() ?? '';
    expect(initial).toContain('全部 3');
    expect(initial.match(/Review Gate/g)?.length).toBeGreaterThanOrEqual(2);
    expect(initial.match(/›/g)).toHaveLength(1);

    await input(instance, '\u001B[C');
    const afterTab = instance.lastFrame() ?? '';
    expect(afterTab).toContain('[official 2]');
    expect(afterTab.match(/›/g)).toHaveLength(1);

    await input(instance, '/', 'review');
    const searched = instance.lastFrame() ?? '';
    expect(searched).toContain('/ review');
    expect(searched).toContain('轻量代码审查与合并检查');
  });

  it('runs the normal install chain through Controller review and execute, then renders a partial result', async () => {
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'failed',
      targetResults: [
        { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
        { target: { platform: 'claude', scope: 'user' }, state: 'failed', errorCode: 'writeFailed' },
      ],
    });
    const value = controller({ executeIntent });
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('你希望在哪里使用 Agent Lab？');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('至少选择一个目标平台');
    await input(instance, '\r', '\u001B[B', '\r', '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('确认添加插件 Agent Lab');
    await confirmReview(instance, value);
    await nextTurn(3);

    expect(executeIntent).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: 'official/agent-lab', platform: 'both', scope: 'user' }),
      evidence,
    );
    expect(instance.lastFrame()).toContain('只完成了一部分');
    expect(instance.lastFrame()).toContain('Claude Code · 所有项目');
    expect(instance.lastFrame()).toContain('失败');
    expect(instance.lastFrame()).toContain('重试失败部分…');
    await confirmReview(instance, value);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'platform',
      pluginId: 'official/agent-lab',
      platform: 'claude',
    });
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'installPlacement', pluginId: 'official/agent-lab',
    });
    expect(value.snapshot.result).toBeUndefined();
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginPreview', pluginId: 'official/agent-lab',
    });
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'home' });
  });

  it.each([
    ['succeeded', {
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    }],
    ['partial', {
      targetResults: [
        { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
        { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
      ],
    }],
    ['blocked', new Error('writeRejected')],
  ] as const)('returns from a mounted %s Result without exposing Progress or a fallback page', async (state, execution) => {
    const value = controller({
      executeIntent: execution instanceof Error
        ? vi.fn().mockRejectedValue(execution)
        : vi.fn().mockResolvedValue(execution),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'upgrade', pluginId: 'team-tools/review-gate', platform: 'both', scope: 'user',
    });
    await expect(value.executeOperation(review.reviewToken)).resolves.toMatchObject({ state });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, 'b');

    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'team-tools/review-gate',
    });
    expect(instance.lastFrame()).not.toContain('后续阶段');
    expect(instance.lastFrame()).not.toContain('正在执行');
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'home' });
    expect(value.snapshot.result).toBeUndefined();
  });

  it.each(['add', 'update'] as const)('renders real feed phase changes and bounded technical messages for source %s', async (sourceAction) => {
    const execution = deferred<unknown>();
    const progress = createRebuildProgressFeed();
    const value = new TuiController({
      ...controller().dependencies,
      captureEvidence: vi.fn().mockResolvedValue({
        catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:candidate' },
        sourceWrite: {
          configDigest: 'sha256:before', candidateDigest: 'sha256:candidate',
          inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true,
        },
      }),
      executeIntent: vi.fn(() => execution.promise),
    }, progress);
    await value.load();
    const review = await value.buildOperationReview(sourceAction === 'add'
      ? {
          kind: 'sourceMutation', action: 'add', sourceId: 'new-source',
          source: { id: 'new-source', type: 'path', primary: false, path: '/fixture/catalog' },
        }
      : {
          kind: 'sourceMutation', action: 'update', sourceId: 'team-tools',
          update: { type: 'path', path: '/fixture/catalog' },
        });
    const running = value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    expect(instance.lastFrame()).not.toContain('d 技术进度');
    expect(instance.lastFrame()).toContain('? 帮助');
    await input(instance, '?');
    expect(instance.lastFrame()).toContain('当前页快捷键');
    expect(instance.lastFrame()).toContain('q / Ctrl-C  操作完成后退出');
    expect(instance.lastFrame()).not.toContain('d  打开技术详情');
    await input(instance, '?');
    expect(instance.lastFrame()).not.toContain('当前页快捷键');

    progress.addEvent({
      type: 'rebuild:action',
      source: { plugin: 'safe-plugin', platform: 'codex', scope: 'user' },
      data: { name: 'preflight.inspect', phase: 'start' },
    });
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('检查当前组件');
    expect(instance.lastFrame()).toContain('safe-plugin · Codex/当前用户');

    progress.addEvent({
      type: 'rebuild:action',
      source: { plugin: 'safe-plugin', platform: 'codex', scope: 'user' },
      data: { name: 'native.write', phase: 'start' },
    });
    for (let index = 0; index < 7; index += 1) {
    progress.addNotice({ level: 'warning', identity: `warning-${index}`, message: '/private/raw-error' });
    }
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('d 技术进度');
    expect(instance.lastFrame()).toContain('? 帮助');
    await input(instance, 'd');
    const technical = instance.lastFrame() ?? '';
    expect(technical).toContain('写入平台插件');
    expect(technical.match(/收到警告/g)).toHaveLength(4);
    expect(technical).not.toContain('/private/raw-error');
    expect(technical.split('\n').length).toBeLessThanOrEqual(18);

    execution.resolve({ targetResults: [] });
    await running;
  });

  it('marks a failed target and current operation step as error instead of active', async () => {
    const execution = deferred<unknown>();
    const progress = createRebuildProgressFeed();
    const plan = dependencyPlan();
    const value = new TuiController({
      ...controller().dependencies,
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      captureEvidence: vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan }),
      executeIntent: vi.fn(() => execution.promise),
    }, progress);
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const running = value.executeOperation(review.reviewToken);
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    progress.addEvent({
      type: 'rebuild:action',
      source: { plugin: 'agent-lab', platform: 'codex', scope: 'project', action: 'install' },
      data: { name: 'postcheck.inspect', phase: 'failure', message: 'safe failure' },
    });
    await nextTurn(2);
    expect(screens).toContain('D06');
    expect(instance.lastFrame()).toContain('× 执行依赖闭包');
    expect(instance.lastFrame()).toContain('× 验证完整结果');
    expect(instance.lastFrame()).not.toContain('● 验证完整结果');
    expect(instance.lastFrame()).toContain('× Agent Lab');
    expect(instance.lastFrame()).toContain('另有 2 个目标');
    expect(instance.lastFrame()).toContain('d 技术进度');
    execution.resolve({ overallState: 'partial', targetResults: [
      { target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project' }, state: 'failed' },
    ] });
    await running;
  });

  it('grows a large dependency progress target viewport from 60x18 through 80x40 without clipping', async () => {
    const execution = deferred<unknown>();
    const loaded = dependencyLoadResult();
    const targetIds = Array.from({ length: 12 }, (_, index) =>
      index === 11 ? 'official/agent-lab' : `official/progress-target-${index + 1}`);
    loaded.pluginSummaries.push(...targetIds.slice(0, -1).map((pluginId, index) => ({
      pluginName: pluginId.split('/')[1]!,
      pluginId,
      displayName: `Progress Target ${index + 1}`,
      description: `Dependency ${index + 1}`,
      supportedTargets: { codex: ['user' as const], claude: [] },
      configFieldCount: 0,
    })));
    loaded.payload.targets.push(...targetIds.slice(0, -1).map((pluginId) => target({
      pluginName: pluginId.split('/')[1]!,
      platform: 'codex',
      scope: 'user',
      state: 'absent',
    })));
    const plan: DependencyOperationPlan = {
      dependencyPlanSchemaVersion: 1,
      requestedPluginIds: ['official/agent-lab'],
      resolvedPluginIds: targetIds,
      dependencyEdges: targetIds.slice(0, -1).map((pluginId) => ({ from: 'official/agent-lab', to: pluginId })),
      targets: targetIds.map((pluginId, index) => ({
        pluginId,
        pluginName: pluginId.split('/')[1]!,
        platform: 'codex' as const,
        requestedScope: 'user' as const,
        resolvedScope: 'user' as const,
        relation: index === targetIds.length - 1 ? 'requested' as const : 'dependency' as const,
        requiredBy: index === targetIds.length - 1 ? [] : ['official/agent-lab'],
        state: 'absent' as const,
        action: 'install' as const,
        order: index + 1,
      })),
    };
    const value = new TuiController({
      ...controller().dependencies,
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence: vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan }),
      executeIntent: vi.fn(() => execution.promise),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    const running = value.executeOperation(review.reviewToken);
    const visibleCounts: number[] = [];
    for (const size of [
      { columns: 60, rows: 18 },
      { columns: 80, rows: 24 },
      { columns: 80, rows: 40 },
    ]) {
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(2);
      const frame = instance.lastFrame() ?? '';
      visibleCounts.push(frame.match(/Progress Target \d+/gu)?.length ?? 0);
      expect(frame).toContain('执行目标');
      expect(frame).toContain('? 帮助');
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
      instance.unmount();
    }
    expect(visibleCounts[0]).toBeLessThan(visibleCounts[1]!);
    expect(visibleCounts[1]).toBeLessThan(visibleCounts[2]!);
    execution.resolve({ targetResults: [] });
    await running;
  });

  it('renders multiple saved result messages with standard and compact viewport budgets', async () => {
    const progress = createRebuildProgressFeed();
    const value = new TuiController({
      ...controller().dependencies,
      executeIntent: vi.fn(async () => {
        for (let index = 1; index <= 10; index += 1) {
          progress.addNotice({ level: 'notice', identity: `message-${index}`, message: `safe ${index}` });
        }
        return { configWrite: 'succeeded', targetResults: [] };
      }),
    }, progress);
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'configSave', pluginId: 'team-tools/review-gate', scope: 'user', projectLayer: 'shared', updates: { mode: 'safe' },
    });
    await value.executeOperation(review.reviewToken);

    const standard = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    const standardFrame = standard.lastFrame() ?? '';
    expect(standardFrame.match(/收到通知/g)).toHaveLength(4);
    expect(standardFrame.match(/›/g)).toHaveLength(1);
    standard.unmount();

    const compact = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    const compactFrame = compact.lastFrame() ?? '';
    expect(compactFrame.match(/收到通知/g)).toHaveLength(2);
    expect(compactFrame.match(/›/g)).toHaveLength(1);
    expect(compactFrame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('bounds many Result targets and keeps the last action with HelpBar at 60x18', async () => {
    const value = controller({
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'succeeded',
        targetResults: Array.from({ length: 12 }, (_, index) => ({
          target: { pluginId: `official/target-${index}`, platform: 'codex' as const, scope: 'user' as const },
          state: 'completed' as const,
        })),
      }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('另有 8 个目标');
    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 返回首页');
    expect(instance.lastFrame()).toContain('↑↓ 移动');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
  });

  it('grows a large dependency result target viewport with available terminal rows', async () => {
    const value = controller({
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'succeeded',
        targetResults: Array.from({ length: 12 }, (_, index) => ({
          target: { pluginId: `official/result-target-${index + 1}`, platform: 'codex' as const, scope: 'user' as const },
          state: 'completed' as const,
        })),
      }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    await value.executeOperation(review.reviewToken);

    const visibleCounts: number[] = [];
    for (const size of [
      { columns: 60, rows: 18 },
      { columns: 80, rows: 24 },
      { columns: 80, rows: 40 },
    ]) {
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(2);
      const frame = instance.lastFrame() ?? '';
      visibleCounts.push(frame.match(/result-target-\d+/gu)?.length ?? 0);
      await input(instance, '\u001B[B');
      expect(instance.lastFrame()).toContain('› 返回首页');
      expect(instance.lastFrame()).toContain('? 帮助');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(size.rows);
      instance.unmount();
    }
    expect(visibleCounts[0]).toBeLessThan(visibleCounts[1]!);
    expect(visibleCounts[1]).toBeLessThan(visibleCounts[2]!);
    expect(visibleCounts[2]).toBe(12);
  });

  it('keeps the last source action visible with HelpBar at 60x18', async () => {
    const value = controller();
    await value.load();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    await input(instance, ...Array.from({ length: 4 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('› 技术详情');
    expect(instance.lastFrame()).toContain('↑↓ 移动');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
  });

  it.each([
    [80, 24],
    [60, 18],
  ] as const)('keeps all source detail actions reachable at %ix%i and opens the focused technical route', async (columns, rows) => {
    const value = controller();
    await value.load();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).not.toContain('远端 Catalog 检查失败');

    for (const [index, label] of ['重新检查来源', '编辑来源…', '设为主来源…', '移除来源…', '技术详情'].entries()) {
      if (index > 0) await input(instance, '\u001B[B');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 移动');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    }

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceTechnical', sourceId: 'team-tools' });
  });

  it('separates degraded and unavailable source diagnostics and redacts every technical field', async () => {
    const privateFailure = 'native stderr Authorization: Bearer bearer-secret '
      + 'https://alice:url-secret@example.test/catalog?access_token=query-secret '
      + '/Users/private-user /workspace/private /tmp/private /private/source/root';
    const unavailableLoad = loadResult();
    unavailableLoad.payload.catalog.sources = unavailableLoad.payload.catalog.sources.map((source) =>
      source.id === 'research' ? {
        ...source,
        type: 'git' as const,
        requestedRef: 'https://alice:url-secret@example.test/catalog?access_token=query-secret',
        error: privateFailure,
        errorCode: 'catalogSourceUnavailable',
      } : source);
    unavailableLoad.sourceDetails = unavailableLoad.sourceDetails?.map((source) =>
      source.id === 'research' ? {
        ...source,
        type: 'git' as const,
        requestedRef: 'https://alice:url-secret@example.test/catalog?access_token=query-secret',
        resolvedCommit: 'Authorization: Bearer commit-secret',
        locationSummary: '/private/source/root',
        errorCode: 'catalogSourceUnavailable',
      } : source);
    const unavailable = controller({ loadStatus: vi.fn().mockResolvedValue(unavailableLoad) });
    await unavailable.load();
    unavailable.push({ name: 'sourceDetail', sourceId: 'research' });
    const unavailableInstance = render(<ConsoleAppV4 controller={unavailable} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    const unavailableDefault = unavailableInstance.lastFrame() ?? '';
    expect(unavailableDefault).toContain('当前不能浏览或安装这个来源中的插件');
    expect(unavailableDefault).toContain('已安装插件和已保存设置不会被删除');
    expect(unavailableDefault).not.toContain('继续使用缓存');
    expect(unavailableDefault).not.toContain('catalogSourceUnavailable');
    for (const privateText of ['native stderr', 'bearer-secret', 'alice', 'url-secret', 'query-secret',
      '/Users/private-user', '/workspace/private', '/tmp/private', '/private/source/root']) {
      expect(unavailableDefault).not.toContain(privateText);
    }
    await input(unavailableInstance, ...Array.from({ length: 4 }, () => '\u001B[B'), '\r');
    expect(unavailable.snapshot.router.current.route).toEqual({ name: 'sourceTechnical', sourceId: 'research' });
    const unavailableTechnical = unavailableInstance.lastFrame() ?? '';
    expect(unavailableTechnical).toContain('catalogSourceUnavailable');
    expect(unavailableTechnical).toContain('resolve-source');
    expect(unavailableTechnical).toMatch(/last good\s+无/u);
    expect(unavailableTechnical).toContain('下面的信息已脱敏，可用于排查或提交 issue');
    expect(unavailableTechnical).not.toContain('sha256:');
    for (const privateText of ['native stderr', 'Authorization', 'Bearer', 'bearer-secret', 'alice', 'url-secret', 'query-secret',
      '/Users/private-user', '/workspace/private', '/tmp/private', '/private/source/root', 'commit-secret']) {
      expect(unavailableTechnical).not.toContain(privateText);
    }
    await input(unavailableInstance, '\r');
    expect(unavailable.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'research' });

    const degradedLoad = loadResult();
    const degraded = controller({
      loadStatus: vi.fn().mockResolvedValue(degradedLoad),
      checkSource: vi.fn().mockRejectedValue(Object.assign(new Error(privateFailure), {
        code: 'catalogSourceRemoteFailed',
      })),
    });
    await degraded.load();
    await nextTurn(4);
    degraded.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const degradedInstance = render(<ConsoleAppV4 controller={degraded} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    const degradedDefault = degradedInstance.lastFrame() ?? '';
    expect(degradedDefault).toContain('匹配缓存中的插件仍可浏览和安装');
    expect(degradedDefault).toContain('继续使用缓存');
    expect(degradedDefault).not.toContain('当前不能浏览或安装这个来源中的插件');
    await input(degradedInstance, ...Array.from({ length: 5 }, () => '\u001B[B'), '\r');
    const degradedTechnical = degradedInstance.lastFrame() ?? '';
    expect(degradedTechnical).toContain('catalogSourceDegraded');
    expect(degradedTechnical).toContain('last good: 可用');
    expect(degradedTechnical).not.toContain('bearer-secret');
    expect(degradedTechnical).toContain('› 返回来源详情');
    expect(degradedTechnical.split('\n').length).toBeLessThanOrEqual(18);
    await input(degradedInstance, '\r');
    expect(degraded.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'team-tools' });
  });

  it('opens source editing from the unavailable source issue edit action', async () => {
    const value = controller();
    await value.load();
    const issue = value.listUserIssues().find((candidate) => candidate.category === 'sourceUnavailable')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('› 编辑来源');
    await input(instance, '\r');

    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceEdit', sourceId: 'research' });
  });

  it('shows platform state diagnostics as a safe product layer before the technical layer', async () => {
    const loaded = loadResult();
    loaded.payload.errors = [{
      code: 'nativeStateUnreadable',
      message: 'stderr Authorization: Bearer platform-secret /Users/private/platform',
    }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((candidate) => candidate.issueId === 'status:nativeStateUnreadable')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    const productFrame = instance.lastFrame() ?? '';
    expect(productFrame).toContain('当前不能安全读取平台状态');
    expect(productFrame).toContain('现有安装和已保存设置不会因本页自动改变');
    expect(productFrame).toContain('下一步');
    expect(productFrame).not.toContain('nativeStateUnreadable');
    expect(productFrame).not.toContain('platform-secret');
    await input(instance, 'd');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('nativeStateUnreadable');
    expect(technicalFrame).toContain('read-platform-state');
    expect(technicalFrame).not.toContain('platform-secret');
    expect(technicalFrame).not.toContain('/Users/private/platform');
  });

  it('uses the shared diagnostic summary from the platform route and preserves its typed issue action', async () => {
    const loaded = loadResult();
    loaded.payload.targets = loaded.payload.targets.map((entry) => entry.pluginId === 'official/agent-lab'
      && entry.platform === 'codex' && entry.scope === 'user'
      ? {
          ...entry,
          state: 'error' as const,
          errors: [{
            code: 'nativeTargetUnreadable',
            message: 'native stderr Bearer platform-route-secret /Users/private/platform-route',
          }],
        }
      : entry);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/agent-lab', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    const productFrame = instance.lastFrame() ?? '';
    expect(productFrame).toContain('现有安装和已保存设置不会因本页自动改变');
    expect(productFrame).toContain('› 查看对应问题');
    expect(productFrame).not.toContain('nativeTargetUnreadable');
    expect(productFrame).not.toContain('platform-route-secret');

    await input(instance, '\r', 'd');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('nativeTargetUnreadable');
    expect(technicalFrame).toContain('read-platform-state');
    expect(technicalFrame).not.toContain('platform-route-secret');
  });

  it('shows dependency diagnostics without exposing the status message and keeps recovery actions', async () => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: 'dependencyMissing',
      rootErrorMessage: 'dependencyMissing: official/skill-toolkit Authorization: Bearer dependency-secret /tmp/source',
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((candidate) => candidate.category === 'dependencyMissing')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    const productFrame = instance.lastFrame() ?? '';
    expect(productFrame).toContain('查看依赖关系');
    expect(productFrame).toContain('现有安装和已保存设置不会因本页自动改变');
    expect(productFrame).not.toContain('dependencyMissing');
    expect(productFrame).not.toContain('dependency-secret');
    await input(instance, 'd');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('dependencyMissing');
    expect(technicalFrame).toContain('resolve-dependencies');
    expect(technicalFrame).not.toContain('dependency-secret');
    expect(technicalFrame).not.toContain('/tmp/source');
  });

  it('keeps typed config failure information without exposing the rejected Error', async () => {
    const getConfigPage = vi.fn().mockRejectedValue(Object.assign(
      new Error('stderr token=config-secret /Users/private/config'),
      { code: 'configReadFailed' },
    ));
    const value = controller({ getConfigPage });
    await value.load();
    value.push({
      name: 'configFields',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configUnavailable',
      diagnosticCode: 'configReadFailed',
      diagnosticStage: 'read-config',
    });
    const productFrame = instance.lastFrame() ?? '';
    expect(productFrame).toContain('当前无法取得可信的字段定义');
    expect(productFrame).toContain('已保存的设置保持不变');
    expect(productFrame).toContain('重新检查来源');
    expect(productFrame).not.toContain('configReadFailed');
    expect(productFrame).not.toContain('config-secret');
    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 技术详情');
    await input(instance, '\r');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('configReadFailed');
    expect(technicalFrame).toContain('read-config');
    expect(technicalFrame).not.toContain('config-secret');
    expect(technicalFrame).not.toContain('sha256:');
  });

  it('uses the shared diagnostic layers for Portable blockers and keeps its recovery flow', async () => {
    const value = controller();
    await value.load();
    value.push({
      name: 'portableBlocker',
      pluginId: 'official/agent-lab',
      code: 'portableValidationFailed',
      diagnosticCode: 'portableSkillInvalid',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    const productFrame = instance.lastFrame() ?? '';
    expect(productFrame).toContain('候选 Skill 没有通过 Portable 安全校验');
    expect(productFrame).toContain('Portable 草稿保持不变');
    expect(productFrame).toContain('重新检查');
    expect(productFrame).toContain('返回插件预览');
    expect(productFrame).not.toContain('portableSkillInvalid');
    await input(instance, '\u001B[B', '\u001B[B');
    expect(instance.lastFrame()).toContain('› 技术详情');
    await input(instance, '\r');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('portableSkillInvalid');
    expect(technicalFrame).toContain('prepare-portable');
    expect(technicalFrame).toContain('下面的信息已脱敏，可用于排查或提交 issue');
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('返回插件预览');
  });

  it('ignores a second Enter after the Review primary action becomes busy', async () => {
    const execution = deferred<unknown>();
    const executeIntent = vi.fn(() => execution.promise);
    const value = controller({
      captureEvidence: vi.fn().mockResolvedValue(evidence),
      executeIntent,
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    instance.stdin.write('\r');
    instance.stdin.write('\r');
    await nextTurn(2);
    expect(value.snapshot.router.current.route.name).toBe('progress');
    expect(instance.lastFrame()).not.toContain('reviewTicketInvalid');
    expect(executeIntent).toHaveBeenCalledTimes(1);
    execution.resolve({
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    await nextTurn(4);

    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(value.snapshot.result).toMatchObject({
      state: 'succeeded', operationId: review.operationId,
    });
  });

  it('retries only the failed target with the canonical plugin identity', async () => {
    const value = controller({
      executeIntent: vi.fn().mockResolvedValue({
        targetResults: [
          { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
          { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
        ],
      }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite',
      action: 'install',
      pluginId: 'official/agent-lab',
      platform: 'both',
      scope: 'user',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.activeReview).toMatchObject({
      pluginAction: 'install',
      subject: { sourceLabel: 'official' },
      changes: [{ title: 'Claude Code · 所有项目' }],
    });
  });

  it.each(['install', 'upgrade'] as const)(
    'retries a reloaded partial target with reinstall after a failed %s',
    async (originalAction) => {
      const before = loadResult();
      const after = loadResult();
      const targetAfterReload = after.payload.targets.find((entry) =>
        entry.pluginId === 'official/agent-lab'
        && entry.platform === 'claude'
        && entry.scope === 'user');
      if (targetAfterReload) targetAfterReload.state = 'partial';
      const value = controller({
        loadStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
        executeIntent: vi.fn().mockResolvedValue({ targetResults: [
          { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
          { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
        ] }),
      });
      await value.load();
      const review = await value.buildOperationReview({
        kind: 'pluginWrite', action: originalAction, pluginId: 'official/agent-lab', platform: 'both', scope: 'user',
      });
      await value.executeOperation(review.reviewToken);
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
      await nextTurn(2);

      await input(instance, '\u001B[B', '\r');

      expect(value.snapshot.activeReview).toMatchObject({
        pluginAction: 'reinstall',
        originIssue: expect.objectContaining({ actionId: 'reinstall' }),
        changes: expect.arrayContaining([expect.objectContaining({ title: 'Claude Code · 所有项目' })]),
      });
      instance.unmount();
      instance.cleanup();
    },
  );

  it('opens the canonical reloaded partial issue instead of a synthesized error route', async () => {
    const before = loadResult();
    const after = loadResult();
    const failed = after.payload.targets.find((entry) =>
      entry.pluginId === 'official/agent-lab'
      && entry.platform === 'claude'
      && entry.scope === 'user');
    if (failed) failed.state = 'partial';
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        targetResults: [
          { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
          { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
        ],
      }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'both', scope: 'user',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await input(instance, '\r');

    expect(value.snapshot.router.current.route).toEqual({
      name: 'issueDetail',
      issueId: 'target:official/agent-lab:claude:user:partial',
    });
  });

  it('shows a new review after the locked executor reports stale evidence before business writes', async () => {
    const changed = { ...evidence, targetFingerprint: 'sha256:changed' };
    const businessWrite = vi.fn();
    const executeIntent = vi.fn(async (
      _intent: Parameters<TuiControllerDependencies['executeIntent']>[0],
      expected: OperationEvidence,
    ) => {
      if (expected.targetFingerprint !== changed.targetFingerprint) {
        throw new Error('operationReviewStale: locked target evidence changed');
      }
      return businessWrite();
    });
    const captureEvidence = vi.fn()
      .mockResolvedValueOnce(evidence)
      .mockResolvedValue(changed);
    const value = controller({
      captureEvidence,
      executeIntent,
    });
    await value.load();
    await value.buildOperationReview({ kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'both', scope: 'user' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    await confirmReview(instance, value);

    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(businessWrite).not.toHaveBeenCalled();
    expect(captureEvidence).toHaveBeenCalledTimes(2);
    expect(instance.lastFrame()).toContain('状态已变化');
    expect(instance.lastFrame()).toContain('再次确认');
  });

  it('restores list context and keeps 60x18 and 80x24 frames within their row budgets', async () => {
    for (const size of [{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }]) {
      const value = controller();
      value.push({ name: 'pluginList', mode: 'browse' }, { focusIndex: 1, query: 'review', sourceTabId: 'all' });
      value.push({ name: 'pluginPreview', pluginId: 'official/review-gate' });
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(3);
      await input(instance, 'b');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('/ review');
      expect(frame).toContain('Review Gate');
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
      if (size.columns === 60) expect(frame).toMatch(/来源\s+\[全部\]\s+1 \/ 4/);
    }
  });

  it('keeps the browse install filter with source, query, preview, and Back navigation', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, 'f', '\u001B[C', ']');
    expect(instance.lastFrame()).toContain('没有匹配插件');
    expect(instance.lastFrame()).not.toContain('团队发布审查');
    await input(instance, '[', '/', 'review');
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('[未安装]');
    expect(instance.lastFrame()).toContain('› Review Gate');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse', sourceId: 'official' });

    await input(instance, ']');
    expect(instance.lastFrame()).toContain('没有匹配插件');
    expect(instance.lastFrame()).not.toContain('团队发布审查');
    await input(instance, '[');
    expect(instance.lastFrame()).toContain('› Review Gate');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginPreview', pluginId: 'official/review-gate' });

    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse', sourceId: 'official' });
    expect(value.snapshot.router.current.context).toMatchObject({
      query: 'review',
      installFilter: 'uninstalled',
      sourceTabId: 'official',
    });
    expect(instance.lastFrame()).toContain('[未安装]');
    expect(instance.lastFrame()).toContain('/ review');
    expect(instance.lastFrame()).toContain('› Review Gate');
  });

  it('treats search shortcut letters as query text and keeps the query after Esc', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '/', 'fjkbq');
    expect(instance.lastFrame()).toContain('fjkbq▌');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse' });
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('fjkbq');
    expect(instance.lastFrame()).toContain('/ 编辑');
    expect(instance.lastFrame()).not.toContain('退出控制台？');
  });

  it.each([
    [60, 18],
    [80, 24],
  ] as const)('keeps a complex search cursor visible and bounded at %i x %i', async (columns, rows) => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(4);

    await input(instance, '/', `${'前'.repeat(35)}😀🇨🇳👨‍👩‍👧‍👦e\u0301中文`, '\u007f');

    const frame = instance.lastFrame()!;
    expect(frame).toContain('▌');
    expect(frame).not.toContain('中文▌');
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    expect(Math.max(...frame.split('\n').map((line) => stringWidth(line)))).toBeLessThanOrEqual(columns);
  });

  it('uses the same Arrow or Enter event to leave search and navigate or open a result', async () => {
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '/', 'review', '\u001B[B');
    expect(instance.lastFrame()).toMatch(/› Review Gate\s+team-tools/u);
    expect(instance.lastFrame()).not.toContain('review▌');
    await input(instance, '/', '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginPreview',
      pluginId: 'team-tools/review-gate',
    });
  });

  it('keeps source and status visible when a plugin name is truncated at 60 columns', async () => {
    const data = loadResult();
    const displayName = 'This Plugin Name Is Intentionally Much Too Long For The Available Width';
    data.pluginSummaries = [{
      pluginName: 'long-name',
      pluginId: 'team-tools/long-name',
      displayName,
      description: '用途说明',
      supportedTargets: { codex: ['user'], claude: [] },
      configFieldCount: 0,
    }];
    data.payload.targets = [target({ pluginName: 'long-name', sourceId: 'team-tools', platform: 'codex', scope: 'user', state: 'absent' })];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('team-tools');
    expect(frame).toContain('未添加');
    expect(frame).not.toContain(displayName);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('keeps the current longest legal source tab and last plugin focus visible on one line at 80x24', async () => {
    const data = loadResult();
    const sourceIds = Array.from({ length: 4 }, (_, index) => `${String(index + 1).repeat(31)}a`);
    data.payload.catalog.sources = sourceIds.map((id, index) => ({
      id,
      identity: `identity:${id}`,
      type: 'path' as const,
      primary: index === 0,
      requestedRef: 'path',
      freshness: 'path' as const,
    }));
    data.payload.catalog.primarySourceId = sourceIds[0]!;
    data.pluginSummaries = sourceIds.flatMap((sourceId, sourceIndex) =>
      Array.from({ length: sourceIndex === sourceIds.length - 1 ? 8 : 1 }, (_, pluginIndex) => ({
        pluginName: `source-${sourceIndex}-plugin-${pluginIndex}`,
        pluginId: `${sourceId}/source-${sourceIndex}-plugin-${pluginIndex}`,
        displayName: `Source ${sourceIndex + 1} Plugin ${pluginIndex + 1}`,
        description: `Description ${pluginIndex + 1}`,
        supportedTargets: { codex: ['user' as const], claude: [] },
        configFieldCount: 0,
      })));
    data.payload.targets = data.pluginSummaries.map((summary) => target({
      pluginName: summary.pluginName,
      sourceId: summary.pluginId.split('/')[0],
      platform: 'codex',
      scope: 'user',
      state: 'absent',
    }));
    data.sourceDetails = data.payload.catalog.sources.map((source) => ({
      id: source.id,
      type: source.type,
      primary: source.primary,
      locationSummary: `已选择本地目录（${source.id}）`,
      pluginCount: data.pluginSummaries.filter((plugin) => plugin.pluginId.startsWith(`${source.id}/`)).length,
      sourceIdentity: source.identity,
      requestedRef: source.requestedRef,
      freshness: source.freshness,
      configDigest: 'sha256:config',
    }));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, ']', ']', ']', ']');
    expect(instance.lastFrame()).toContain(`[${sourceIds.at(-1)}]  5 / 5`);
    await input(instance, ...Array.from({ length: 7 }, () => '\u001B[B'));
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('› Source 4 Plugin 8');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
  });

  it('grows the same plugin viewport with terminal rows and keeps the last focus visible', async () => {
    const sizes = [
      { columns: 60, rows: 18 },
      { columns: 80, rows: 24 },
      { columns: 80, rows: 40 },
    ];
    const visibleCounts: number[] = [];
    for (const size of sizes) {
      const data = loadResult();
      data.pluginSummaries = Array.from({ length: 8 }, (_, index) => ({
        pluginName: `viewport-${index + 1}`,
        pluginId: `official/viewport-${index + 1}`,
        displayName: `Viewport Plugin ${index + 1}`,
        description: `Viewport description ${index + 1}`,
        supportedTargets: { codex: ['user'], claude: [] },
        configFieldCount: 0,
      }));
      data.payload.targets = data.pluginSummaries.map((summary) => target({
        pluginName: summary.pluginName,
        platform: 'codex',
        scope: 'user',
        state: 'absent',
      }));
      data.payload.catalog.sources = [data.payload.catalog.sources[0]!];
      data.sourceDetails = data.sourceDetails?.filter((source) => source.id === 'official');
      const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
      value.push({ name: 'pluginList', mode: 'browse' });
      const instance = render(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(3);

      const initialFrame = instance.lastFrame() ?? '';
      visibleCounts.push(initialFrame.match(/Viewport Plugin \d+/gu)?.length ?? 0);
      expect(initialFrame.split('\n').length).toBeLessThanOrEqual(size.rows);
      await input(instance, ...Array.from({ length: 7 }, () => '\u001B[B'));
      expect(instance.lastFrame()).toContain('› Viewport Plugin 8');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(size.rows);
      instance.unmount();
    }

    expect(visibleCounts[0]).toBeLessThan(visibleCounts[1]!);
    expect(visibleCounts[1]).toBeLessThan(visibleCounts[2]!);
    expect(visibleCounts[2]).toBe(8);
  });

  it('keeps the focused item visible in a 60x18 viewport and opens that exact item', async () => {
    const data = loadResult();
    data.pluginSummaries = Array.from({ length: 8 }, (_, index) => ({
      pluginName: `plugin-${index + 1}`,
      pluginId: `official/plugin-${index + 1}`,
      displayName: `Plugin ${index + 1}`,
      description: `Description ${index + 1}`,
      supportedTargets: { codex: ['user'], claude: [] },
      configFieldCount: 0,
    }));
    data.payload.targets = data.pluginSummaries.map((summary) => target({
      pluginName: summary.pluginName,
      platform: 'codex',
      scope: 'user',
      state: 'absent',
    }));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);

    await input(instance, ...Array.from({ length: 6 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('› Plugin 7');
    expect(instance.lastFrame()).not.toContain('Plugin 1');
    await input(instance, '\r');

    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginPreview',
      pluginId: 'official/plugin-7',
    });
  });

  it('keeps plugin and issue focus visible at item 10 in an 80x24 viewport and opens the exact object', async () => {
    const data = loadResult();
    data.pluginSummaries = Array.from({ length: 12 }, (_, index) => ({
      pluginName: `plugin-${String(index + 1).padStart(2, '0')}`,
      pluginId: `official/plugin-${String(index + 1).padStart(2, '0')}`,
      displayName: `Plugin ${String(index + 1).padStart(2, '0')}`,
      description: `Description ${index + 1}`,
      supportedTargets: { codex: ['user'], claude: [] },
      configFieldCount: 0,
    }));
    data.payload.targets = data.pluginSummaries.map((summary) => target({
      pluginName: summary.pluginName,
      platform: 'codex',
      scope: 'user',
      state: 'partial',
    }));
    data.payload.catalog.sources = [data.payload.catalog.sources[0]!];
    data.sourceDetails = data.sourceDetails?.filter((source) => source.id === 'official');
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    await value.load();
    value.push({ name: 'pluginList', mode: 'browse' });
    const plugins = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await input(plugins, ...Array.from({ length: 9 }, () => '\u001B[B'));
    expect(plugins.lastFrame()).toContain('› Plugin 10');
    expect(plugins.lastFrame()).not.toContain('Plugin 01');
    await input(plugins, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginPreview', pluginId: 'official/plugin-10' });
    plugins.unmount();

    value.push({ name: 'issueList' });
    const issues = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await input(issues, ...Array.from({ length: 9 }, () => '\u001B[B'));
    expect(issues.lastFrame()).toContain('› official/plugin-10');
    expect(issues.lastFrame()).not.toContain('official/plugin-01');
    await input(issues, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'issueDetail',
      issueId: 'target:official/plugin-10:codex:user:partial',
    });
  });

  it.each([
    { columns: 80, rows: 24 },
    { columns: 60, rows: 18 },
  ])('keeps source 10 visible and opens its exact identity at $columns x $rows', async (size) => {
    const data = loadResult();
    data.payload.catalog.sources = Array.from({ length: 10 }, (_, index) => ({
      id: `source-${String(index + 1).padStart(2, '0')}`,
      identity: `identity:source-${index + 1}`,
      type: 'path' as const,
      primary: index === 0,
      requestedRef: 'path',
      freshness: 'path' as const,
    }));
    data.sourceDetails = data.payload.catalog.sources.map((source) => ({
      id: source.id,
      type: source.type,
      primary: source.primary,
      locationSummary: `已选择本地目录（${source.id}）`,
      pluginCount: 0,
      sourceIdentity: source.identity,
      requestedRef: source.requestedRef,
      freshness: source.freshness,
      configDigest: 'sha256:config',
    }));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(data) });
    await value.load();
    value.push({ name: 'sourceList' });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await nextTurn(2);
    await input(instance, ...Array.from({ length: 9 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('› source-10');
    expect(instance.lastFrame()).not.toContain('source-01');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'source-10' });
  });

  it('masks absolute config and source paths in input frames while preserving editing', async () => {
    const value = controller({ getConfigPage: vi.fn().mockResolvedValue(configPage()) });
    await value.load();
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'rules',
      editor: 'path',
    });
    const config = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    const privateConfigPath = '/Users/alice/private/team/rules.json';
    await input(config, ...privateConfigPath.split(''));
    expect(config.lastFrame()).toContain('已选择 / … / rules.json');
    expect(config.lastFrame()).not.toContain('/Users/alice/private');
    await input(config, '\u007f');
    expect(config.lastFrame()).toContain('rules.jso');
    config.unmount();

    value.push({ name: 'sourceList' });
    const source = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    await input(source, '\u001B[B', '\u001B[B', '\u001B[B', '\r', '\u001B[B', '\r', ...'private-source'.split(''), '\r');
    const privateSourcePath = '/Users/alice/private/catalog';
    await input(source, ...privateSourcePath.split(''));
    expect(source.lastFrame()).toContain('已选择 / … / catalog');
    expect(source.lastFrame()).not.toContain('/Users/alice/private');
    expect(source.lastFrame()).toContain('已隐藏父目录');
  });

  it('renders only the minimum-size hint and ignores business input below 60x18', async () => {
    const exit = vi.fn();
    const value = controller();
    value.push({ name: 'pluginList', mode: 'browse' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 59, rows: 18 }} onExit={exit} />);
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('请将终端调整到至少 60 列 × 18 行');
    expect(instance.lastFrame()).not.toContain('添加插件');
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('pluginList');
    await input(instance, 'q');
    expect(exit).toHaveBeenCalledOnce();
  });

  it('uses visible group tabs and opens a focused effective field through layer selection into its editor', async () => {
    const reached = new Set<ConsoleV4ScreenId>();
    const getConfigPage = vi.fn(async (
      pluginId: string,
      layer: ConfigPageViewModel['layer'],
    ) => {
      const page = configPage(pluginId);
      return {
        ...page,
        layer,
        groups: layer.scope === 'effective'
          ? page.groups.map((group) => ({
              ...group,
              fields: group.fields.map((field) => ({
                ...field,
                displayValue: field.effectiveDisplayValue,
                sourceLabel: field.effectiveSourceLabel,
                ...(field.effectiveValue !== undefined ? { value: field.effectiveValue } : {}),
              })),
            }))
          : page.groups,
      };
    });
    const value = controller({ getConfigPage });
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => reached.add(screen)}
    />);
    await nextTurn(4);

    await input(instance, '\u001B[B', '\u001B[B', '\r');
    await nextTurn(3);
    expect(reached).toContain('C02');
    const effectiveFrame = instance.lastFrame() ?? '';
    expect(effectiveFrame).toContain('当前插件设置');
    expect(effectiveFrame).toContain('基本设置');
    expect(effectiveFrame).toContain('来自个人默认');
    expect(effectiveFrame).toContain('没有任何位置提供值');
    expect(effectiveFrame).not.toContain('保存修改');
    expect(effectiveFrame).toContain('快速方案 1');
    expect(effectiveFrame).toContain('› level');
    expect(effectiveFrame).not.toContain('/Users/private');

    const depth = value.snapshot.router.depth;
    await input(instance, '\u001B[C');
    expect(value.snapshot.router.depth).toBe(depth);
    expect(value.snapshot.router.current.context.configGroupId).toBe('advanced');
    expect(instance.lastFrame()).toContain('› model');
    expect(instance.lastFrame()).not.toContain('› level');
    await input(instance, '\u001B[D');
    expect(value.snapshot.router.depth).toBe(depth);
    expect(instance.lastFrame()).toContain('› level');

    await input(instance, '\r');
    expect(reached).toContain('C01');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configLayer', fieldKey: 'level', groupId: 'basic',
    });
    const chooserFrame = instance.lastFrame() ?? '';
    expect(chooserFrame).toContain('修改“level”');
    expect(chooserFrame).toContain('个人默认');
    expect(chooserFrame).toContain('当前项目');
    expect(chooserFrame).toContain('当前项目（仅本机）');
    expect(chooserFrame).not.toContain('有效设置');
    const layerRoute = value.snapshot.router.current.route;
    await input(instance, '\t');
    expect(value.snapshot.router.current.route).toEqual(layerRoute);

    await input(instance, '\r');
    await nextTurn(3);
    expect(reached).toContain('C04');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldAction', fieldKey: 'level',
    });
    await input(instance, '\r');
    expect(reached).toContain('C05');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldEditor', fieldKey: 'level',
    });
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldAction', fieldKey: 'level',
    });
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', layer: { scope: 'user', projectLayer: 'shared' },
    });
    expect(value.snapshot.router.current.context).toMatchObject({ configGroupId: 'basic', focusIndex: 0 });
    expect(instance.lastFrame()).toContain('› level');
    expect(instance.lastFrame()).toContain('平衡');
  });

  it('opens the preview settings action on the effective read-only homepage', async () => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    value.push({ name: 'pluginPreview', pluginId: 'official/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u001B[B', '\r');
    await nextTurn(3);

    expect(value.snapshot.router.current.route).toEqual({
      name: 'configFields',
      pluginId: 'official/review-gate',
      layer: { scope: 'effective', projectLayer: 'shared' },
    });
    expect(instance.lastFrame()).toContain('当前插件设置');
    expect(instance.lastFrame()).not.toContain('保存修改');
  });

  it('returns editor completion or cancellation to the original mutable field and then restores the config origin', async () => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u001B[B', '\u001B[B', '\r');
    await nextTurn(3);
    await input(instance, '\r', '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldAction', fieldKey: 'level' });
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldEditor', fieldKey: 'level' });
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldAction', fieldKey: 'level',
    });
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    expect(value.snapshot.router.current.context).toMatchObject({ configGroupId: 'basic', focusIndex: 0 });

    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields',
      layer: { scope: 'effective', projectLayer: 'shared' },
    });
    expect(value.snapshot.router.current.context.focusIndex).toBe(0);
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail',
      pluginId: 'team-tools/review-gate',
    });
    expect(value.snapshot.router.current.context.focusIndex).toBe(2);
  });

  it.each([
    {
      label: 'preview primary action',
      previous: { name: 'pluginList', mode: 'browse' as const },
      origin: { name: 'pluginPreview', pluginId: 'official/review-gate' } as const,
      openSettings: ['\u001B[B', '\r'],
      leaveResult: '\r',
    },
    {
      label: 'detail Esc',
      previous: { name: 'pluginList', mode: 'installed' as const },
      origin: { name: 'pluginDetail', pluginId: 'team-tools/review-gate' } as const,
      openSettings: ['\u001B[B', '\u001B[B', '\r'],
      leaveResult: '\u001B',
    },
  ])('clears the mounted C14 settings flow for $label and preserves the original Back stack', async ({
    previous,
    origin,
    openSettings,
    leaveResult,
  }) => {
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'succeeded',
        targetResults: [],
      }),
    });
    value.push(previous);
    value.push(origin);
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await nextTurn(4);

    await input(instance, ...openSettings);
    await nextTurn(3);
    await input(instance, '\r', '\r', '\u001B[B', '\r', 's');
    await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('review');
    await input(instance, '\r');
    await nextTurn(5);
    expect(screens).toContain('C14');

    if (leaveResult === '\u001B') {
      instance.stdin.write(leaveResult);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await nextTurn(2);
    } else {
      await input(instance, leaveResult);
    }
    expect(value.snapshot.router.current.route).toEqual(origin);
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual(previous);
  });

  it('treats Advanced as an ordinary tab without adding a route frame', async () => {
    const page = configPage();
    page.presets = [];
    page.groups = [
      { ...page.groups[0]!, fields: [page.groups[0]!.fields[3]!] },
      {
        id: 'advanced', title: '高级设置', advanced: true,
        fields: [{ ...page.groups[1]!.fields[0]!, title: '字段级高级模型' }],
      },
    ];
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...page, layer })) });
    value.push({
      name: 'configFields', pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);

    expect(screens).toContain('C03');
    expect(instance.lastFrame()).toContain('高级设置');
    expect(instance.lastFrame()).not.toContain('字段级高级模型');
    const depth = value.snapshot.router.depth;
    await input(instance, '\u001B[C');
    expect(value.snapshot.router.depth).toBe(depth);
    expect(value.snapshot.router.current.context.configGroupId).toBe('advanced');
    expect(instance.lastFrame()).toContain('字段级高级模型');
    expect(instance.lastFrame()).toContain('› 字段级高级模型');
  });

  it('preserves preset, manifest group, and advanced headings on the mutable settings page', async () => {
    const page = configPage();
    page.groups[0]!.fields = [page.groups[0]!.fields[0]!];
    const value = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...page, layer })) });
    value.push({
      name: 'configFields', pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('快速方案');
    expect(frame).toContain('基本设置');
    expect(frame).toContain('高级设置');
    expect(frame).not.toContain('设置字段');
    expect(frame.split('\n').length).toBeLessThanOrEqual(24);
  });

  it('applies an effective preset to one selected layer, preserves its draft across tabs, and keeps u field-only', async () => {
    const page = configPage();
    page.presets[0]!.privateFieldTitles = ['token'];
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({
      name: 'configFields', pluginId: page.pluginId,
      layer: { scope: 'effective', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u001B[C', '\u001B[C');
    expect(value.snapshot.router.current.context.configGroupId).toBe('@presets');
    expect(instance.lastFrame()).toContain('› 团队默认');
    expect(instance.lastFrame()).toContain('token需手动输入');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configLayer', presetId: 'team' });
    await input(instance, '\r');
    await nextTurn(5);

    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', layer: { scope: 'user', projectLayer: 'shared' },
    });
    expect(value.snapshot.router.current.context).toMatchObject({ configGroupId: 'basic', focusIndex: 0 });
    expect(instance.lastFrame()).toContain('2 项未保存');
    expect(instance.lastFrame()).toContain('token需手动输入');
    await input(instance, '\u001B[C', '\u001B[C');
    expect(value.snapshot.router.current.context.configGroupId).toBe('@presets');
    await input(instance, '\r');
    expect(value.snapshot.router.current.context.configGroupId).toBe('basic');
    expect(instance.lastFrame()).toContain('2 项未保存');
    await input(instance, '\u001B[C');
    expect(instance.lastFrame()).toContain('2 项未保存');
    expect(instance.lastFrame()).toContain('› model');
    await input(instance, '\u001B[D');
    expect(instance.lastFrame()).toContain('平衡');
    await input(instance, 'u');
    expect(instance.lastFrame()).toContain('恢复继承');

    await input(instance, ...Array.from({ length: 7 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('› 保存修改');
    await input(instance, 'u');
    expect(instance.lastFrame()).toContain('2 项未保存');
    await input(instance, 's');
    await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('review');
  });

  it('does not apply a preset after leaving its mutable layer while the page is loading', async () => {
    const page = configPage();
    let resolveUser!: (page: ConfigPageViewModel) => void;
    const userPage = new Promise<ConfigPageViewModel>((resolve) => {
      resolveUser = resolve;
    });
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => layer.scope === 'user'
        ? userPage
        : { ...page, pluginId, layer }),
    });
    value.push({
      name: 'configFields', pluginId: page.pluginId,
      layer: { scope: 'effective', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u001B[C', '\u001B[C', '\r', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', layer: { scope: 'user', projectLayer: 'shared' },
    });
    await input(instance, 'b');
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', layer: { scope: 'effective', projectLayer: 'shared' },
    });

    await input(instance, '\u001B[D', '\u001B[D', '\r', '\r');
    resolveUser({ ...page, layer: { scope: 'user', projectLayer: 'shared' } });
    await nextTurn(5);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFieldAction', fieldKey: 'level',
    });
    await input(instance, 'b');
    expect(instance.lastFrame()).toContain('严格');
    expect(instance.lastFrame()).not.toContain('项未保存');
  });

  it('shows one fallback plugin-settings tab when presentation groups are absent', async () => {
    const page = configPage();
    page.presets = [];
    page.groups = [{
      id: 'general', title: '插件设置', advanced: false,
      fields: [page.groups[0]!.fields[0]!],
    }];
    const value = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...page, layer })) });
    value.push({
      name: 'configFields', pluginId: page.pluginId,
      layer: { scope: 'effective', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    expect(instance.lastFrame()).toContain('[插件设置 1]');
    expect(instance.lastFrame()).not.toContain('高级设置');
    expect(instance.lastFrame()).not.toContain('快速方案');
  });

  it('renders config partial retry, reset Review, unavailable terminal state, and compact field viewport', async () => {
    const partialScreens = new Set<ConsoleV4ScreenId>();
    const partialReload = loadResult();
    const failedTarget = partialReload.payload.targets.find((entry) =>
      entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'claude'
      && entry.scope === 'user');
    if (failedTarget) failedTarget.state = 'partial';
    const partial = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(loadResult()).mockResolvedValue(partialReload),
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'partial',
        targetResults: [
          { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
          { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
        ],
      }),
    });
    partial.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    const partialInstance = render(<ConsoleAppV4 controller={partial} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => partialScreens.add(screen)} />);
    await nextTurn(4);
    await input(partialInstance, '\u001B[B', '\r', '\u001B[B', '\r', 's');
    await nextTurn(3);
    await confirmReview(partialInstance, partial);
    await nextTurn(4);
    expect(partialScreens).toContain('C15');
    expect(partialInstance.lastFrame()).toContain('部分应用失败');
    await input(partialInstance, '\u001B[B', '\r');
    expect(partial.snapshot.activeReview?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: 'Claude Code · 所有项目' }),
    ]));
    await input(
      partialInstance,
      '\u001B[B',
      '\r',
    );
    expect(partial.snapshot.router.current.route).toEqual({
      name: 'configFields', pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    expect(partial.snapshot.result).toBeUndefined();
    expect(partial.snapshot.router.depth).toBe(2);

    const resetScreens = new Set<ConsoleV4ScreenId>();
    const reset = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })) });
    reset.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'project', projectLayer: 'local' } });
    const resetInstance = render(<ConsoleAppV4 controller={reset} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => resetScreens.add(screen)} />);
    await nextTurn(4);
    await input(resetInstance, ...Array.from({ length: 7 }, () => '\u001B[B'), '\r');
    await nextTurn(3);
    expect(resetScreens).toContain('C16');
    expect(resetInstance.lastFrame()).toContain('当前项目（仅本机）');
    expect(resetInstance.lastFrame()).toContain('其他设置层保持不变');

    const unavailableScreens = new Set<ConsoleV4ScreenId>();
    const checkSource = vi.fn().mockResolvedValue({
      sourceIdentity: 'identity:team-tools', requestedRef: 'catalog/stable',
    });
    const unavailable = controller({
      checkSource,
      getConfigPage: vi.fn().mockRejectedValue(new Error('private manifest error /Users/private')),
    });
    unavailable.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    const unavailableInstance = render(<ConsoleAppV4 controller={unavailable} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => unavailableScreens.add(screen)} />);
    await nextTurn(5);
    expect(unavailableScreens).toContain('C17');
    expect(unavailableInstance.lastFrame()).toContain('Manifest 或来源不可用');
    expect(unavailableInstance.lastFrame()).not.toContain('/Users/private');
    expect(unavailableInstance.lastFrame()).not.toContain('重置此设置层');
    await input(unavailableInstance, '\r');
    await nextTurn(4);
    expect(checkSource).toHaveBeenCalledWith('team-tools', expect.any(AbortSignal));

    const longPage = configPage();
    longPage.presets = [];
    longPage.groups = [{
      id: 'long',
      title: '长设置组',
      advanced: false,
      fields: Array.from({ length: 12 }, (_, index) => ({
        ...longPage.groups[0]!.fields[3]!,
        key: `field-${index + 1}`,
        title: `字段 ${index + 1}`,
      })),
    }];
    const compact = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...longPage, layer })) });
    compact.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    const compactInstance = render(<ConsoleAppV4 controller={compact} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    await input(compactInstance, ...Array.from({ length: 8 }, () => '\u001B[B'));
    const compactFrame = compactInstance.lastFrame() ?? '';
    expect(compactFrame).toContain('› 字段 9');
    expect(compactFrame).not.toContain('字段 1\n');
    expect(compactFrame).toContain('保存修改');
    expect(compactFrame).toContain('清空个人默认');
    expect(compactFrame.split('\n').length).toBeLessThanOrEqual(18);

    const effective = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...longPage, layer })) });
    effective.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'effective', projectLayer: 'shared' } });
    const effectiveInstance = render(<ConsoleAppV4 controller={effective} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    await input(effectiveInstance, ...Array.from({ length: 8 }, () => '\u001B[B'));
    expect(effectiveInstance.lastFrame()).toContain('字段 9');
    expect(effectiveInstance.lastFrame()).toContain('› 字段 9');
    expect((effectiveInstance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
  });

  it('keeps C17 read-only for a verified stored layer and keeps its details private', async () => {
    const sourceIdentity = `sha256:${'a'.repeat(64)}`;
    const storeDigest = `sha256:${'b'.repeat(64)}`;
    const value = controller({
      getConfigResetAvailability: vi.fn().mockResolvedValue({
        exists: true,
        sourceIdentityPresent: true,
        sourceIdentity,
        storeDigest,
      }),
      captureEvidence: vi.fn().mockResolvedValue({
        ...evidence,
        source: { sourceId: 'team-tools', sourceIdentity },
        config: { scope: 'user', projectLayer: 'shared', storeDigest },
      }),
    });
    await value.load();
    value.push({
      name: 'configUnavailable',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    expect(instance.lastFrame()).not.toContain('重置此设置层');
    expect(instance.lastFrame()).toContain('技术详情');
    expect(instance.lastFrame()).not.toContain(sourceIdentity);
    expect(instance.lastFrame()).not.toContain(storeDigest);
    expect(instance.lastFrame()).not.toContain('/Users/private');
    await input(instance, 'd');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('configUnavailable');
    expect(technicalFrame).toContain('read-config');
    expect(technicalFrame).not.toContain(sourceIdentity);
    expect(technicalFrame).not.toContain(storeDigest);
  });

  it('does not let an aborted config layer response overwrite the newer layer page', async () => {
    let resolveUser!: (page: ConfigPageViewModel) => void;
    const userPage = new Promise<ConfigPageViewModel>((resolve) => {
      resolveUser = resolve;
    });
    const projectPage = configPage();
    projectPage.groups[0]!.fields[0]!.title = '新项目字段';
    const getConfigPage = vi.fn((_pluginId: string, layer: ConfigPageViewModel['layer']) =>
      layer.scope === 'user' ? userPage : Promise.resolve({ ...projectPage, layer }));
    const value = controller({ getConfigPage });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    value.replace({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'project', projectLayer: 'shared' } });
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('新项目字段');

    const oldPage = configPage();
    oldPage.groups[0]!.fields[0]!.title = '过期个人字段';
    resolveUser(oldPage);
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('新项目字段');
    expect(instance.lastFrame()).not.toContain('过期个人字段');
  });

  it('uses G04 when leaving a dirty config layer and can discard its draft', async () => {
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })) });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);
    await input(instance, '\r', '\r', '\u001B[B', '\r', 'b', 'b');
    expect(screens).toContain('G04');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'home' });
  });

  it('opens a stored field action but sends an unstored field directly to its cursor editor', async () => {
    const page = configPage();
    const level = page.groups[0]!.fields[0]!;
    level.fallbackDisplayValue = '平衡';
    level.fallbackSourceLabel = '默认值';
    const value = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })) });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'user', projectLayer: 'shared' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldAction', fieldKey: 'level' });
    expect(instance.lastFrame()).toContain('当前实际生效');
    expect(instance.lastFrame()).toContain('删除后将恢复');
    expect(instance.lastFrame()).toContain('平衡 · 来自默认值');
    await input(instance, 'b', ...Array.from({ length: 3 }, () => '\u001B[B'), '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldEditor', fieldKey: 'note' });
    expect(instance.lastFrame()).toContain('▌');
  });

  it.each([
    ['configured enum', 'level', 'configFieldAction'],
    ['unstored string', 'note', 'configFieldEditor'],
    ['configured secret', 'token', 'configFieldAction'],
  ] as const)('routes an effective %s through the selected layer stored state', async (_label, fieldKey, expectedRoute) => {
    const page = configPage();
    const value = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })) });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'effective', projectLayer: 'shared' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    value.push({ name: 'configLayer', pluginId: page.pluginId, fieldKey, groupId: 'basic' });
    await nextTurn(2);

    await input(instance, '\r');
    await nextTurn(4);

    expect(value.snapshot.router.current.route).toMatchObject({ name: expectedRoute, fieldKey });
    if (expectedRoute === 'configFieldEditor') expect(instance.lastFrame()).toContain('▌');
    else expect(instance.lastFrame()).toContain('当前实际生效');
  });

  it('stages a stored field removal without executing a write and shows inherited Review text', async () => {
    const page = configPage();
    const level = page.groups[0]!.fields[0]!;
    level.fallbackDisplayValue = '平衡';
    level.fallbackSourceLabel = '个人默认';
    const executeIntent = vi.fn();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
      executeIntent,
    });
    value.push({ name: 'configFields', pluginId: page.pluginId, layer: { scope: 'project', projectLayer: 'shared' } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\r', '\u001B[B', '\r');
    expect(executeIntent).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('1 项未保存');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'configFieldAction', fieldKey: 'level' });
    expect(instance.lastFrame()).toContain('撤销删除');
    await input(instance, 'b');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).toContain('1 项未保存');
    await input(instance, 's');
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('设置变更');
    expect(instance.lastFrame()).toContain('恢复继承（平衡 · 个人默认）');
    expect(instance.lastFrame()).toContain('应用影响');
    expect(instance.lastFrame()).toContain('保持不变');
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it.each([
    ['secret', 'token'],
    ['path', 'rules'],
  ] as const)('renders a %s removal as a redacted inherited change', async (_label, fieldKey) => {
    const page = configPage();
    const field = page.groups.flatMap((group) => group.fields).find((candidate) => candidate.key === fieldKey)!;
    field.fallbackDisplayValue = '已设置';
    field.fallbackSourceLabel = '个人默认';
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    const layer = { scope: 'project' as const, projectLayer: 'shared' as const };
    value.push({ name: 'configFields', pluginId: page.pluginId, layer });
    value.push({ name: 'configFieldAction', pluginId: page.pluginId, layer, fieldKey });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, '\u001B[B', '\r', 's');
    await nextTurn(4);

    const frame = instance.lastFrame()!;
    expect(frame).toContain(`删除 ${fieldKey} 中的值`);
    expect(frame).toContain('已设置 → 恢复继承（已设置 · 个人默认）');
    expect(frame).not.toContain('sk-private');
    expect(frame).not.toContain('/Users/private');
  });

  it('treats b as text, normalizes no-op drafts, and hides reset for an empty layer', async () => {
    const page = configPage();
    page.storedCount = 0;
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...page, pluginId, layer })),
    });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'note',
      editor: 'string',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);

    await input(instance, 'b', '\r');
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).toContain('b');
    expect(instance.lastFrame()).toContain('1 项未保存');

    await input(instance, 'b', '\u001B[B', '\r');
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    await nextTurn(4);
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'level',
      editor: 'enum',
    });
    await input(instance, '\u001B[B', '\u001B[B', '\r', ...Array.from({ length: 8 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('当前没有未保存修改');
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'note',
      editor: 'string',
    });
    await nextTurn(2);
    await input(instance, '\u0015', ...Array.from({ length: 8 }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('当前没有未保存修改');
    await input(instance, 's');
    expect(value.snapshot.activeReview).toBeUndefined();
    expect(instance.lastFrame()).not.toContain('清空个人默认');
  });

  it('isolates private drafts by canonical plugin and layer before the next page renders', async () => {
    const alpha = configPage('team-tools/review-gate');
    const beta = configPage('official/agent-lab');
    beta.presets = [];
    beta.groups = [{
      id: 'basic',
      title: '基本设置',
      advanced: false,
      fields: [{
        ...beta.groups[0]!.fields[3]!,
        key: 'token',
        title: '普通 token 字段',
      }],
    }];
    const getConfigPage = vi.fn(async (pluginId: string, layer: ConfigPageViewModel['layer']) => ({
      ...(pluginId === alpha.pluginId ? alpha : beta),
      pluginId,
      layer,
    }));
    const value = controller({ getConfigPage });
    value.push({ name: 'configFields', pluginId: alpha.pluginId, layer: { scope: 'user', projectLayer: 'shared' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: alpha.pluginId,
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'token',
      editor: 'sensitive',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, 'LEAK-VALUE', '\r');

    value.replace({ name: 'configFields', pluginId: beta.pluginId, layer: { scope: 'user', projectLayer: 'shared' } });
    expect(instance.lastFrame()).not.toContain('LEAK-VALUE');
    await nextTurn(4);
    expect(instance.lastFrame()).toContain('普通 token 字段');
    expect(instance.lastFrame()).not.toContain('LEAK-VALUE');
    await input(instance, 's');
    expect(value.snapshot.activeReview).toBeUndefined();
  });

  it('shows a committed config write with one failed target as partial', async () => {
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'succeeded',
        overallState: 'failed',
        targetResults: [
          { target: { platform: 'codex', scope: 'user' }, state: 'completed' },
          { target: { platform: 'claude', scope: 'user' }, state: 'failed' },
        ],
      }),
    });
    value.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'user', projectLayer: 'shared' } });
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'note',
      editor: 'string',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);
    await input(instance, 'DRAFT-KEEP', '\r', 's');
    await nextTurn(3);
    await confirmReview(instance, value);
    await nextTurn(4);

    expect(value.snapshot.result).toMatchObject({ state: 'partial' });
    expect(value.snapshot.router.current.route.name).toBe('result');
    expect(instance.lastFrame()).toContain('设置已保存，但部分应用失败');
    expect(instance.lastFrame()).toContain('已完成');
    expect(instance.lastFrame()).toContain('失败');
    expect(screens).toContain('C15');
  });

  it('keeps every compact Review change and confirmation in one bounded focus viewport', async () => {
    const executeIntent = vi.fn().mockResolvedValue({ configWrite: 'succeeded', overallState: 'succeeded', targetResults: [] });
    const value = controller({ executeIntent });
    await value.load();
    await value.buildOperationReview({
      kind: 'configSave',
      pluginId: 'official/agent-lab',
      scope: 'user',
      projectLayer: 'shared',
      updates: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`field-${index + 1}`, index + 1])),
      changes: Array.from({ length: 9 }, (_, index) => ({
        key: `field-${index + 1}`,
        title: `变更 ${index + 1}`,
        before: '旧值',
        after: '新值',
      })),
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('~ 变更 1');
    expect(instance.lastFrame()).not.toContain('› ~ 变更 1');
    expect(instance.lastFrame()).toMatch(/另有 \d+ 项/u);
    expect(instance.lastFrame()).toContain('› 保存并应用');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    await input(instance, '\r');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    expect(executeIntent).toHaveBeenCalledOnce();
  });

  it('summarizes many kept and warning Review rows without clipping actions or HelpBar', async () => {
    const value = controller();
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'team-tools/review-gate', platform: 'codex', scope: 'user', force: true,
    });
    const snapshot = structuredClone(value.snapshot);
    if (!snapshot.activeReview) throw new Error('expected active review');
    snapshot.activeReview.changes = [
      { kind: 'remove', group: 'requested', title: 'Codex · 所有项目', description: '目标安装' },
      ...Array.from({ length: 18 }, (_, index) => ({ kind: 'keep' as const, group: 'preserved' as const, title: `保留项 ${index + 1}`, description: '保持安装' })),
      ...Array.from({ length: 12 }, (_, index) => ({ kind: 'warning' as const, group: 'portableWarnings' as const, title: `风险 ${index + 1}`, description: '共同风险原因' })),
    ];
    Object.defineProperty(value, 'snapshot', { configurable: true, get: () => snapshot });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('共同风险原因');
    expect(frame).toContain('保持不变');
    expect(frame).toContain('另有 17 项');
    expect(frame).toContain(`› ${review.primaryLabel}`);
    expect(frame).toContain('↑↓ 移动');
    expect(frame.match(/›/gu)).toHaveLength(1);
  });

  it('reaches S01-S13 through the real Git wizard and treats b as input text', async () => {
    const screens = new Set<ConsoleV4ScreenId>();
    const executeIntent = vi.fn().mockResolvedValue({ ok: true });
    const loaded = loadResult();
    loaded.cliChannel = 'beta';
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), executeIntent });
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 60, rows: 18 }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await nextTurn(5);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('单个来源失败不会阻止其他来源继续工作');
    expect(screens).toContain('S01');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r', '\r');
    expect(screens).toContain('S05');
    await input(instance, 'team-b2', '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'sourceAdd', step: 'location' });
    await input(instance, 'https://example.test/catalog.git', '\r');
    expect(instance.lastFrame()).toContain('当前 CLI beta → catalog/beta');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    expect(screens).toContain('S08');
    await input(instance, 'catalog/stable', '\r', 'catalog', '\r');
    await nextTurn(3);
    expect(screens).toContain('S10');
    expect(instance.lastFrame()).toContain('team-b2');
    expect(instance.lastFrame()).not.toContain('Catalog 版本');
    expect(instance.lastFrame()).not.toContain('resolvedCommit');
    await confirmReview(instance, value);
    await nextTurn(5);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'sourceMutation',
      action: 'add',
      sourceId: 'team-b2',
    }), expect.anything());
    expect(screens).toContain('S12');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
  });

  it('discards the complete add-source route segment from S07 and returns to the source list', async () => {
    const value = controller();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r', '\r');
    await input(instance, 'discard-me', '\r', 'https://example.test/catalog.git', '\r');
    expect(resolveConsoleV4ScreenId(value.snapshot, value)).toBe('S07');

    await input(instance, 'b', '\u001B[B', '\r');

    expect(value.snapshot.router).toMatchObject({
      depth: 2,
      current: { route: { name: 'sourceList' } },
    });
    expect(value.snapshot.activeReview).toBeUndefined();
    value.back();
    expect(value.snapshot.router.current.route).toEqual({ name: 'home' });
  });

  it('discards an add-source draft from S10 but q confirmation still exits', async () => {
    const exit = vi.fn();
    const value = controller();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onExit={exit} />);
    await nextTurn(4);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r', '\r');
    await input(instance, 'review-draft', '\r', 'https://example.test/catalog.git', '\r', '\r', '\r');
    await nextTurn(3);
    expect(resolveConsoleV4ScreenId(value.snapshot, value)).toBe('S10');

    await input(instance, 'q', '\u001B[B', '\r');

    expect(exit).toHaveBeenCalledWith({ code: 0, reason: 'user' });
  });

  it('discards an edit-source Review and returns to the original source detail', async () => {
    const value = controller();
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    value.push({ name: 'sourceEdit', sourceId: 'team-tools' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(4);
    await input(instance, '\r', 'https://example.test/team-v2.git', '\r');
    await nextTurn(3);
    expect(resolveConsoleV4ScreenId(value.snapshot, value)).toBe('S15');

    await input(instance, 'b', '\u001B[B', '\r');

    expect(value.snapshot.router).toMatchObject({
      depth: 2,
      current: { route: { name: 'sourceDetail', sourceId: 'team-tools' } },
    });
    expect(value.snapshot.activeReview).toBeUndefined();
  });

  it('reviews an official HTTPS to SSH transport switch before any source write', async () => {
    const loaded = loadResult();
    loaded.payload.catalog.sources[0] = {
      id: 'official',
      identity: 'identity:official-workspace',
      type: 'git',
      primary: true,
      requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit: 'abc123',
      freshness: 'cache',
    };
    loaded.sourceDetails![0] = {
      id: 'official',
      type: 'git',
      primary: true,
      locationSummary: 'https://github.com/lesliechan721-arch/agent-workflow.git',
      refPolicy: 'cliChannel',
      pluginCount: 2,
      sourceIdentity: 'identity:official-workspace',
      requestedRef: 'refs/heads/catalog/latest',
      resolvedCommit: 'abc123',
      freshness: 'cache',
      configDigest: 'sha256:config',
    };
    const executeIntent = vi.fn().mockResolvedValue({ ok: true });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), executeIntent });
    value.push({ name: 'sourceEdit', sourceId: 'official' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);

    expect(instance.lastFrame()).toContain('HTTPS');
    expect(instance.lastFrame()).toContain('SSH');
    expect(instance.lastFrame()).toContain('BatchMode');
    await input(instance, '\u001B[B', '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(executeIntent).not.toHaveBeenCalled();
    expect(instance.lastFrame()).toContain('Git URL');
    expect(instance.lastFrame()).not.toContain('http://');
  });

  it('renders safe source detail and technical data without raw path, credentials, or failure text', async () => {
    const secretPath = '/Users/private/acme/catalog';
    const secretUrl = 'https://token:secret@example.test/team.git';
    const loaded = loadResult();
    loaded.sourceDetails = loaded.sourceDetails!.map((detail) => detail.id === 'team-tools'
      ? { ...detail, locationSummary: 'https://example.test/team.git' }
      : detail.id === 'research' ? { ...detail, locationSummary: '已选择本地目录（catalog）' } : detail);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(5);
    expect(instance.lastFrame()).toContain('https://example.test/team.git');
    expect(instance.lastFrame()).not.toContain(secretPath);
    expect(instance.lastFrame()).not.toContain(secretUrl);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    expect(screens).toContain('S03');
    expect(instance.lastFrame()).toContain('catalogSourceReady');
    expect(instance.lastFrame()).toContain('requested ref');
    expect(instance.lastFrame()).not.toContain('sourceIdentity');
    expect(instance.lastFrame()).not.toContain('configDigest');
    expect(instance.lastFrame()).not.toContain('/Users/private');
    expect(instance.lastFrame()).not.toContain('token:secret');
  });

  it('never echoes Git credentials or query tokens while S06 is receiving input', async () => {
    const value = controller();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(5);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r', '\r');
    await input(instance, 'safe-input', '\r');
    await input(instance, 'https://user:secret@example.test/catalog.git?token=private#fragment');

    expect(instance.lastFrame()).toContain('https://example.test/catalog.git');
    expect(instance.lastFrame()).not.toMatch(/user:secret|token=private|#fragment/u);
    expect(JSON.stringify(value.snapshot)).not.toMatch(/user:secret|token=private|#fragment/u);
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('Git URL 不符合来源规范');
    expect(instance.lastFrame()).not.toMatch(/user:secret|token=private|#fragment/u);
  });

  it('opens removal Review without consulting an incomplete reference inventory', async () => {
    const inspectSourceRemoval = vi.fn().mockResolvedValue({
      blocked: true,
      inventoryComplete: false,
      dependencies: [{
        category: 'installation',
        pluginId: 'team-tools/review-gate',
        sourceId: 'team-tools',
        platform: 'codex',
        scope: 'project',
      }],
    });
    const value = controller({
      inspectSourceRemoval,
    });
    value.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(5);
    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn(3);
    expect(screens).toContain('S18');
    expect(value.snapshot.activeReview?.sourceAction).toBe('remove');
    expect(inspectSourceRemoval).not.toHaveBeenCalled();
  });

  it('reaches edit, primary, and safe removal Review pages through mounted keyboard actions', async () => {
    const edit = controller();
    edit.push({ name: 'sourceEdit', sourceId: 'team-tools' });
    const editScreens = new Set<ConsoleV4ScreenId>();
    const editView = render(<ConsoleAppV4 controller={edit} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => editScreens.add(screen)} />);
    await nextTurn(5);
    await input(editView, '\r', 'https://example.test/team-v2.git', '\r');
    await nextTurn(3);
    expect(editScreens).toContain('S14');
    expect(editScreens).toContain('S15');
    cleanup();

    const primary = controller();
    primary.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const primaryScreens = new Set<ConsoleV4ScreenId>();
    const primaryView = render(<ConsoleAppV4 controller={primary} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => primaryScreens.add(screen)} />);
    await nextTurn(5);
    await input(primaryView, '\u001B[B', '\u001B[B', '\r');
    await nextTurn(3);
    expect(primaryScreens).toContain('S16');
    cleanup();

    const removal = controller();
    removal.push({ name: 'sourceDetail', sourceId: 'team-tools' });
    const removalScreens = new Set<ConsoleV4ScreenId>();
    const removalView = render(<ConsoleAppV4 controller={removal} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => removalScreens.add(screen)} />);
    await nextTurn(5);
    await input(removalView, '\u001B[B', '\u001B[B', '\u001B[B', '\r');
    await nextTurn(3);
    expect(removalScreens).toContain('S18');
  });

  it('keeps a source draft and reports uncertainty after a sanitized command failure', async () => {
    const rawFailure = 'remote failed https://token:secret@example.test/private.git /Users/private/catalog';
    const value = controller({ executeIntent: vi.fn().mockRejectedValue(new Error(`catalogSourceResolutionFailed: ${rawFailure}`)) });
    await value.load();
    await value.buildOperationReview({
      kind: 'sourceMutation',
      action: 'add',
      sourceId: 'safe-id',
      source: { id: 'safe-id', type: 'git', primary: false, url: 'https://example.test/catalog.git', refPolicy: { type: 'cliChannel' } },
      changes: [{ title: '添加来源 safe-id', after: 'Git 仓库' }],
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(4);
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(screens).toContain('S13');
    expect(instance.lastFrame()).toContain('写入可能已完成，当前无法确认');
    expect(instance.lastFrame()).not.toContain('来源列表没有被修改');
    expect(instance.lastFrame()).not.toContain('token:secret');
    expect(instance.lastFrame()).not.toContain('/Users/private');
  });

  it('renders a plugin write with failed status reload as unconfirmed and keeps its return route', async () => {
    const value = controller({
      loadStatus: vi.fn()
        .mockResolvedValueOnce(loadResult())
        .mockRejectedValueOnce(new Error('/private/reload failed')),
      checkSource: vi.fn(() => new Promise(() => undefined)),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'upgrade', pluginId: 'team-tools/review-gate', platform: 'codex', scope: 'user',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('写入可能已完成，当前无法确认');
    expect(instance.lastFrame()).toContain('结果未确认');
    expect(instance.lastFrame()).not.toContain('插件操作未完成');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'team-tools/review-gate',
    });
  });

  it('renders an all-failed receipt as unconfirmed after showing the refreshed target state', async () => {
    const before = loadResult();
    const after = loadResult();
    const refreshed = after.payload.targets.find((entry) =>
      entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex'
      && entry.scope === 'user');
    if (refreshed) refreshed.state = 'partial';
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'failed',
        targetResults: [{
          target: { platform: 'codex', scope: 'user' },
          state: 'failed',
          errorCode: 'durableCleanupFailed',
        }],
      }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'team-tools/review-gate', platform: 'codex', scope: 'user',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('结果未确认 · operationFailed');
    expect(instance.lastFrame()).toContain('写入可能已完成，当前无法确认');
    expect(instance.lastFrame()).toContain('查看插件');
    expect(value.getTargetState('team-tools/review-gate', 'codex', 'user')).toBe('partial');
  });

  it('does not claim a source list was unchanged after a source write reload fails', async () => {
    const sourceEvidence: OperationEvidence = {
      catalog: { configDigest: 'sha256:before', compositeDigest: 'sha256:candidate' },
      sourceWrite: {
        configDigest: 'sha256:before', candidateDigest: 'sha256:candidate',
        inventoryDigest: 'sha256:inventory', referenceCount: 0, inventoryComplete: true,
      },
    };
    const value = controller({
      loadStatus: vi.fn()
        .mockResolvedValueOnce(loadResult())
        .mockRejectedValueOnce(new Error('/private/reload failed')),
      checkSource: vi.fn(() => new Promise(() => undefined)),
      captureEvidence: vi.fn().mockResolvedValue(sourceEvidence),
    });
    await value.load();
    value.push({ name: 'sourceList' });
    const review = await value.buildOperationReview({
      kind: 'sourceMutation', action: 'setPrimary', sourceId: 'team-tools',
    });
    await value.executeOperation(review.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('写入可能已完成，当前无法确认');
    expect(instance.lastFrame()).not.toContain('来源列表没有被修改');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceList' });
  });

  it('shows dependency installation content, opens the single relation route, and keeps a plugin without dependencies on P04', async () => {
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()) });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D01');
    expect(instance.lastFrame()).toContain('安装内容');
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit');
    expect(instance.lastFrame()).toContain('直接依赖');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect(instance.lastFrame()).not.toContain('› Agent Skill Toolkit');
    expect(instance.lastFrame()).not.toContain('planDigest');
    await input(instance, '\u001B[B', '\r');
    expect(screens).toContain('D02');
    expect(instance.lastFrame()).toContain('安装所需插件');
    expect(instance.lastFrame()).toContain('你选择的插件');
    expect(instance.lastFrame()).toContain('必需依赖');
    expect(instance.lastFrame()).toContain('依赖优先');
    expect(instance.lastFrame()).toContain('› 技术详情');
    expect(instance.lastFrame()).not.toContain('› Agent Skill Toolkit');
    await input(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginPreview', pluginId: 'official/agent-lab' });

    const plain = controller();
    await plain.load();
    plain.push({ name: 'pluginPreview', pluginId: 'official/review-gate' });
    const plainInstance = render(<ConsoleAppV4 controller={plain} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(plainInstance.lastFrame()).not.toContain('安装内容');
    expect(resolveConsoleV4ScreenId(plain.snapshot, plain)).toBe('P04');
  });

  it('keeps Portable capability, dependency summary, primary action, and HelpBar visible on D01 at 60x18', async () => {
    const loaded = dependencyLoadResult();
    loaded.portablePluginIds = ['official/agent-lab'];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    const frame = instance.lastFrame() ?? '';
    expect(screens).toContain('D01');
    expect(frame).toContain('通用 Skills');
    expect(frame).toContain('Agent Skill Toolkit');
    expect(frame).toContain('Agent Content Toolkit');
    expect(frame).toContain('› 添加插件');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);

    await input(instance, ...Array.from({ length: 3 }, () => '\u001B[B'));
    const lastActionFrame = instance.lastFrame() ?? '';
    expect(lastActionFrame).toContain('› 查看来源');
    expect(lastActionFrame).toContain('↑↓ 移动');
    expect(lastActionFrame.match(/›/gu)).toHaveLength(1);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'official' });
  });

  it('keeps every D01 action and HelpBar visible with Portable and eight dependencies at 80x24', async () => {
    const loaded = dependencyLoadResult();
    loaded.portablePluginIds = ['official/agent-lab'];
    const overview = loaded.dependencyOverviews?.find((entry) => entry.pluginId === 'official/agent-lab');
    expect(overview).toBeDefined();
    overview!.summary = { directCount: 4, transitiveCount: 4, totalCount: 8, readyCount: 1, missingCount: 7, issueCount: 0 };
    overview!.dependencies.push(
      ...Array.from({ length: 3 }, (_, index) => ({
        pluginId: `official/direct-${index}`,
        displayName: `Direct ${index}`,
        relation: 'direct' as const,
        depth: 1,
        requiredBy: [{ pluginId: 'official/agent-lab', displayName: 'Agent Lab' }],
        placements: [
          { platform: 'codex' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] as const },
          { platform: 'claude' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] as const },
        ],
        aggregateStatus: index === 2 ? 'needsAttention' as const : 'notInstalled' as const,
      })),
      ...Array.from({ length: 3 }, (_, index) => ({
        pluginId: `official/transitive-${index}`,
        displayName: `Transitive ${index}`,
        relation: 'transitive' as const,
        depth: 2,
        requiredBy: [{ pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit' }],
        placements: [
          { platform: 'codex' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] as const },
          { platform: 'claude' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] as const },
        ],
        aggregateStatus: 'notInstalled' as const,
      })),
    );
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    for (const [index, label] of ['添加插件', '安装通用 Skills…', '查看依赖关系', '查看来源'].entries()) {
      if (index > 0) await input(instance, '\u001B[B');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 移动');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    }
    expect(instance.lastFrame()).toContain('Direct 2');
    expect(instance.lastFrame()).toContain('需要处理');
    expect(instance.lastFrame()).toContain('另有 3 个直接依赖');
    expect(instance.lastFrame()).toContain('另有 3 个间接依赖');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'official' });
  });

  it('renders P04 and P13 Portable capability cards without materializing candidates', async () => {
    const loaded = loadResult();
    loaded.portablePluginIds = ['official/review-gate', 'team-tools/review-gate'];
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    const screens = new Set<ConsoleV4ScreenId>();
    value.push({ name: 'pluginPreview', pluginId: 'official/review-gate' });
    const preview = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    expect(screens).toContain('P04');
    expect(preview.lastFrame()).toContain('通用 Skills');
    expect(preview.lastFrame()).toContain('可安装');
    expect(preview.lastFrame()).not.toContain('候选');
    expect(captureEvidence).not.toHaveBeenCalled();
    preview.unmount();

    value.replace({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const detail = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    const frame = detail.lastFrame() ?? '';
    expect(screens).toContain('P13');
    expect(frame).toContain('通用 Skills');
    expect(frame).toContain('可安装');
    expect(frame).toContain('选择 Skill 和 Agent 后交给 Skills CLI 安装');
    expect(frame).not.toContain('安装状态未知');
    expect(frame).not.toContain('候选');
    expect(captureEvidence).not.toHaveBeenCalled();
  });

  it.each([
    ['D09', dependencyLoadResult({ rootState: 'present' }), 'official/agent-lab', ['Codex', 'Claude Code', '必需依赖', '通用 Skills', '关于与技术详情']],
    ['P13', loadResult(), 'team-tools/review-gate', ['Codex', 'Claude Code', '通用 Skills', '设置', '关于与技术详情']],
  ] as const)('keeps every %s action and HelpBar visible while moving through a mounted 60x18 detail', async (
    expectedScreen,
    loaded,
    pluginId,
    labels,
  ) => {
    loaded.portablePluginIds = [pluginId];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);

    for (const [index, label] of labels.entries()) {
      if (index > 0) await input(instance, '\u001B[B');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 移动');
      expect(frame.match(/›/gu)).toHaveLength(1);
    }
    expect(screens).toContain(expectedScreen);
  });

  it.each([
    ['D09', dependencyLoadResult({ rootState: 'present' }), 'official/agent-lab', ['Codex', 'Claude Code', '必需依赖', '通用 Skills', '关于与技术详情']],
    ['P13', loadResult(), 'team-tools/review-gate', ['Codex', 'Claude Code', '通用 Skills', '设置', '关于与技术详情']],
  ] as const)('keeps every %s action and HelpBar visible while moving through a mounted 80x24 detail', async (
    expectedScreen,
    loaded,
    pluginId,
    labels,
  ) => {
    loaded.portablePluginIds = [pluginId];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);

    for (const [index, label] of labels.entries()) {
      if (index > 0) await input(instance, '\u001B[B');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 移动');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(24);
    }
    expect(screens).toContain(expectedScreen);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginAbout', pluginId });
  });

  it('mounts dependency placement, target platforms, installed detail, and installed relation templates', async () => {
    const available = controller({ loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()) });
    await available.load();
    const availableScreens = new Set<ConsoleV4ScreenId>();
    available.push({ name: 'installPlacement', pluginId: 'official/agent-lab' });
    const placement = render(<ConsoleAppV4 controller={available} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => availableScreens.add(screen)} />);
    await nextTurn(2);
    expect(availableScreens).toContain('D03');
    expect(placement.lastFrame()).toContain('依赖处理');
    expect(placement.lastFrame()).toContain('依赖会复用现有安装');
    expect(placement.lastFrame()?.match(/›/gu)).toHaveLength(1);
    placement.unmount();

    available.replace({ name: 'installTargets', pluginId: 'official/agent-lab' });
    const targetsPage = render(<ConsoleAppV4 controller={available} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => availableScreens.add(screen)} />);
    await nextTurn(2);
    expect(availableScreens).toContain('D04');
    expect(targetsPage.lastFrame()).toContain('目标平台兼容性');
    expect(targetsPage.lastFrame()).toContain('至少选择一个目标平台');
    expect(targetsPage.lastFrame()?.match(/›/gu)).toHaveLength(1);
    targetsPage.unmount();

    const installed = controller({ loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult({ rootState: 'present' })) });
    await installed.load();
    const installedScreens = new Set<ConsoleV4ScreenId>();
    installed.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const detail = render(<ConsoleAppV4 controller={installed} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => installedScreens.add(screen)} />);
    await nextTurn(2);
    expect(installedScreens).toContain('D09');
    expect(detail.lastFrame()).toContain('查看直接、间接依赖和被使用情况');
    expect(detail.lastFrame()).toContain('1 个直接 · 2 个总计');
    detail.unmount();

    installed.replace({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const relations = render(<ConsoleAppV4 controller={installed} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => installedScreens.add(screen)} />);
    await nextTurn(2);
    expect(installedScreens).toContain('D10');
    expect(relations.lastFrame()).toContain('依赖与被使用情况');
    expect(relations.lastFrame()).toContain('根节点');
    expect(relations.lastFrame()).not.toContain('› Agent Skill Toolkit');
  });

  it('groups a dependency Review without giving its headings a separate focus and keeps the primary action reachable', async () => {
    const plan = dependencyPlan();
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      captureEvidence: vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan }),
      executeIntent,
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D05');
    expect(instance.lastFrame()).toContain('根插件');
    expect(instance.lastFrame()).toContain('依赖');
    expect(instance.lastFrame()).toContain('保持');
    expect(instance.lastFrame()).toContain('Codex · 当前项目');
    expect(instance.lastFrame()).toContain('所有项目 · 已可用');
    expect(instance.lastFrame()).toContain('› 添加插件 3 个插件');
    expect(instance.lastFrame()).toContain('↑↓ 移动');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, '\r');
    expect(executeIntent).toHaveBeenCalledOnce();
  });

  it('renders kept, failed, and skipped dependency targets as target-level results', async () => {
    const plan = dependencyPlan();
    const loaded = dependencyLoadResult();
    const executeIntent = vi.fn().mockResolvedValue({
      dependencyPlan: plan,
      overallState: 'failed',
      targetResults: [
        { target: { pluginId: 'official/content-toolkit', platform: 'codex', scope: 'user' }, state: 'completed', action: 'keep' },
        { target: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'project' }, state: 'failed' },
        { target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project' }, state: 'completed', action: 'skipped' },
      ],
    });
    const captureEvidence = vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
      executeIntent,
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    await confirmReview(instance, value);
    await nextTurn(4);
    expect(screens).toContain('D08');
    expect(instance.lastFrame()).toContain('Agent Content Toolkit');
    expect(instance.lastFrame()).toContain('已保留');
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit');
    expect(instance.lastFrame()).toContain('失败');
    expect(instance.lastFrame()).toContain('Agent Lab');
    expect(instance.lastFrame()).toContain('未执行 · 依赖未完成');
    expect(instance.lastFrame()).toContain('已完成或已保留的目标保持可用');
    expect(instance.lastFrame()).not.toContain('根插件没有留下部分安装');

    await input(instance, '\u001B[B', '\r');
    expect(captureEvidence.mock.calls.at(-1)?.[0]).toMatchObject({
      action: 'install', pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'project',
    });
  });

  it('renders a successful dependency result with bounded target rows and visible actions at 60x18', async () => {
    const plan = dependencyPlan();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      captureEvidence: vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan }),
      executeIntent: vi.fn().mockResolvedValue({
        dependencyPlan: plan,
        overallState: 'succeeded',
        targetResults: [
          { target: { pluginId: 'official/content-toolkit', platform: 'codex', scope: 'user' }, state: 'completed', action: 'keep' },
          { target: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'project' }, state: 'completed', action: 'install' },
          { target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project' }, state: 'completed', action: 'install' },
        ],
      }),
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    await confirmReview(instance, value);
    await nextTurn(4);
    const frame = instance.lastFrame() ?? '';
    expect(screens).toContain('D07');
    expect(frame).toContain('操作已完成');
    expect(frame).toContain('Agent Lab');
    expect(frame).toContain('Agent Content Toolkit');
    expect(frame).toContain('Agent Skill Toolkit');
    expect(frame).not.toContain('另有 1 个目标');
    expect(frame).toContain('› 查看插件');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it.each([
    ['dependencyMissing', 'installDependency', 'install', 'absent', 'D14'],
    ['dependencyNotReady', 'reinstallDependency', 'reinstall', 'partial', 'D15'],
  ] as const)('uses the contract dependency placement for a project consumer %s action', async (
    category,
    actionId,
    writeAction,
    dependencyState,
    expectedScreen,
  ) => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: category,
      rootErrorMessage: `${category}: official/skill-toolkit has changed state.`,
    });
    const dependencyTarget = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/skill-toolkit' && entry.platform === 'codex' && entry.scope === 'user')!;
    dependencyTarget.state = dependencyState;
    dependencyTarget.errors = dependencyState === 'partial'
      ? [{ code: 'missingContent', message: '安全说明' }] : [];
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    const issue = value.listUserIssues().find((candidate) =>
      candidate.category === category && candidate.platform === 'codex' && candidate.scope === 'project')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain(expectedScreen);
    expect(instance.lastFrame()).toContain('受影响的根插件');
    expect(instance.lastFrame()).toContain('依赖目标');
    expect(instance.lastFrame()).not.toContain('› Agent Skill Toolkit');

    await input(instance, ...(actionId === 'reinstallDependency' ? ['\u001B[B'] : []), '\r');

    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite',
      action: writeAction,
      pluginId: 'official/skill-toolkit',
      platform: 'codex',
      scope: 'user',
      originIssue: expect.objectContaining({
        actionId,
        consumerPluginId: 'official/agent-lab',
        consumerPlatform: 'codex',
        consumerScope: 'project',
        dependencyPluginId: 'official/skill-toolkit',
        dependencyPlatform: 'codex',
        dependencyScope: 'user',
        dependencyProject: null,
      }),
    }), expect.any(AbortSignal));
  });

  it.each([
    ['dependencyStillRequired', 'codex', 'D12', 80, 24],
    ['dependencyMissing', 'codex', 'D14', 80, 24],
    ['dependencyNotReady', 'codex', 'D15', 80, 24],
    ['dependencyTargetUnsupported', 'claude', 'D16', 80, 24],
    ['dependencyStillRequired', 'codex', 'D12', 60, 18],
    ['dependencyMissing', 'codex', 'D14', 60, 18],
    ['dependencyNotReady', 'codex', 'D15', 60, 18],
    ['dependencyTargetUnsupported', 'claude', 'D16', 60, 18],
  ] as const)('shows bounded safe details for %s on %s as %s at %ix%i', async (
    category,
    platform,
    expectedScreen,
    columns,
    rows,
  ) => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: category,
      rootErrorMessage: `${category}: official/skill-toolkit has changed state.`,
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((candidate) =>
      candidate.category === category && candidate.platform === platform)!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns, rows }}
      onScreenChange={(screen) => screens.add(screen)}
    />);
    await nextTurn(2);

    await input(instance, 'd');
    const frame = instance.lastFrame() ?? '';
    expect(screens).toContain(expectedScreen);
    expect(frame).toContain(category);
    expect(frame).toContain('resolve-dependencies');
    expect(frame).toContain('下面的信息已脱敏，可用于排查或提交 issue');
    expect(frame).toContain('d 技术详情');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows);

    await input(instance, 'd');
    const technicalIndex = category === 'dependencyStillRequired' ? 2
      : category === 'dependencyTargetUnsupported' ? 2
        : issue.actions.findIndex((action) => action.id === 'viewTechnical');
    for (let index = 0; index < technicalIndex; index += 1) await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 技术详情');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain(category);
    expect(instance.lastFrame()).toContain('resolve-dependencies');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
  });

  it.each(['partial', 'blocked'] as const)(
    'uses D08 dependency recovery for an issue-origin %s dependency result',
    async (resultState) => {
      const loaded = dependencyLoadResult();
      const originTarget = loaded.payload.targets.find((entry) =>
        entry.pluginId === 'official/agent-lab'
        && entry.platform === 'codex'
        && entry.scope === 'project')!;
      originTarget.state = 'partial';
      originTarget.errors = [{ code: 'missingContent', message: '安全说明' }];
      const refreshed = structuredClone(loaded);
      const refreshedOrigin = refreshed.payload.targets.find((entry) =>
        entry.pluginId === 'official/agent-lab'
        && entry.platform === 'codex'
        && entry.scope === 'project')!;
      expect(refreshedOrigin.state).toBe('partial');
      const plan = dependencyPlan();
      if (resultState === 'blocked') {
        plan.resolvedPluginIds = ['official/skill-toolkit', 'official/agent-lab'];
        plan.targets = plan.targets.filter((target) => target.pluginId !== 'official/content-toolkit');
      }
      const dependencyEvidence = { ...evidence, dependencyPlan: plan };
      const captureEvidence = vi.fn()
        .mockResolvedValueOnce(dependencyEvidence)
        .mockResolvedValueOnce(dependencyEvidence)
        .mockResolvedValue(evidence);
      const targetResults = resultState === 'partial'
        ? [
            { target: { pluginId: 'official/content-toolkit', platform: 'codex' as const, scope: 'user' as const }, state: 'completed', action: 'keep' },
            { target: { pluginId: 'official/skill-toolkit', platform: 'codex' as const, scope: 'project' as const }, state: 'failed', action: 'install' },
            { target: { pluginId: 'official/agent-lab', platform: 'codex' as const, scope: 'project' as const }, state: 'completed', action: 'skipped' },
          ]
        : [
            { target: { pluginId: 'official/skill-toolkit', platform: 'codex' as const, scope: 'project' as const }, state: 'failed', action: 'install' },
            { target: { pluginId: 'official/agent-lab', platform: 'codex' as const, scope: 'project' as const }, state: 'failed', action: 'skipped' },
          ];
      const executeIntent = vi.fn().mockResolvedValue({
        dependencyPlan: plan,
        overallState: 'failed',
        targetResults,
      });
      const value = controller({
        loadStatus: vi.fn().mockResolvedValueOnce(loaded).mockResolvedValue(refreshed),
        captureEvidence,
        executeIntent,
      });
      await value.load();
      const issue = value.listUserIssues().find((candidate) =>
        candidate.category === 'incompleteInstallation'
        && candidate.pluginId === 'official/agent-lab'
        && candidate.platform === 'codex'
        && candidate.scope === 'project')!;
      value.push({ name: 'issueDetail', issueId: issue.issueId });
      const screens = new Set<ConsoleV4ScreenId>();
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
      await nextTurn(2);
      await input(instance, '\r');
      await confirmReview(instance, value);
      await nextTurn(4);

      const frame = instance.lastFrame() ?? '';
      expect(screens).toContain('D08');
      expect(frame).toContain('Agent Skill Toolkit');
      expect(frame).toContain('失败');
      expect(frame).toContain('查看失败项');
      expect(frame).toContain('重试失败部分…');
      expect(frame).not.toContain('返回问题详情');
      expect(frame).not.toContain('重新检查问题');
      if (resultState === 'partial') {
        expect(frame).toContain('Agent Content Toolkit');
        expect(frame).toContain('已保留');
        expect(frame).toContain('Agent Lab');
        expect(frame).toContain('未执行 · 依赖未完成');
      }

      await input(instance, '\u001B[B', '\r');
      expect(value.snapshot.activeReview).toMatchObject({
        pluginAction: 'install',
        subject: { name: 'Agent Skill Toolkit', sourceLabel: 'official' },
      });
      expect(captureEvidence.mock.calls.at(-1)?.[0]).toMatchObject({
        kind: 'pluginWrite',
        action: 'install',
        pluginId: 'official/skill-toolkit',
        platform: 'codex',
        scope: 'project',
      });
      expect(executeIntent).toHaveBeenCalledTimes(1);
    },
  );

  it('renders failed and skipped dependency targets as a failure without preserved-success claims', async () => {
    const plan = dependencyPlan();
    plan.resolvedPluginIds = ['official/skill-toolkit', 'official/agent-lab'];
    plan.targets = plan.targets.filter((target) => target.pluginId !== 'official/content-toolkit');
    const before = dependencyLoadResult();
    const after = dependencyLoadResult();
    const captureEvidence = vi.fn().mockResolvedValue({ ...evidence, dependencyPlan: plan });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(before).mockResolvedValue(after),
      captureEvidence,
      executeIntent: vi.fn().mockResolvedValue({
        dependencyPlan: plan,
        overallState: 'failed',
        targetResults: [
          { target: { pluginId: 'official/skill-toolkit', platform: 'codex', scope: 'project' }, state: 'failed', action: 'install' },
          { target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'project' }, state: 'failed', action: 'skipped' },
        ],
      }),
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    await confirmReview(instance, value);
    await nextTurn(4);

    expect(screens).toContain('D08');
    expect(value.snapshot.result).toMatchObject({
      state: 'blocked', code: 'operationFailed', summary: { code: 'operationFailed' },
    });
    expect(instance.lastFrame()).toContain('依赖安装没有完成');
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit');
    expect(instance.lastFrame()).toContain('失败');
    expect(instance.lastFrame()).toContain('Agent Lab');
    expect(instance.lastFrame()).toContain('未执行 · 依赖未完成');
    expect(instance.lastFrame()).not.toContain('只完成了一部分');
    expect(instance.lastFrame()).not.toContain('已完成或已保留的目标保持可用');
    expect(instance.lastFrame()).not.toContain('写入可能已完成');
    const captureCalls = captureEvidence.mock.calls.length;
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'platform', pluginId: 'official/skill-toolkit', platform: 'codex',
    });
    expect(captureEvidence).toHaveBeenCalledTimes(captureCalls);
  });

  it('allows an unreferenced Claude placement removal while Codex remains required', async () => {
    const loaded = dependencyLoadResult({ rootState: 'present' });
    for (const platform of ['codex', 'claude'] as const) {
      const target = loaded.payload.targets.find((entry) =>
        entry.pluginId === 'official/skill-toolkit' && entry.platform === platform && entry.scope === 'user')!;
      target.state = 'present';
    }
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/skill-toolkit', platform: 'claude' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '\u001B[B', '\r');

    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      action: 'uninstall', pluginId: 'official/skill-toolkit', platform: 'claude', scope: 'user',
    }), expect.any(AbortSignal));
  });

  it('recomputes target availability after status refresh changes the selected scope support', async () => {
    const permissive = dependencyLoadResult();
    const restricted = structuredClone(permissive);
    restricted.payload.targets = restricted.payload.targets.filter((target) => !(
      target.pluginId === 'official/skill-toolkit'
      && target.platform === 'codex' && target.scope === 'project'));
    const skillSummary = restricted.pluginSummaries.find((summary) => summary.pluginId === 'official/skill-toolkit')!;
    skillSummary.supportedTargets = { codex: ['user'], claude: [] };
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(permissive).mockResolvedValue(restricted),
      captureEvidence,
    });
    await value.load();
    value.push({ name: 'installPlacement', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
    await value.load();
    await nextTurn(3);

    expect(screens).toContain('D04');
    expect(instance.lastFrame()).toContain('所选目标平台不可用');
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit 不支持所选位置');
    expect(captureEvidence).not.toHaveBeenCalled();
  });

  it('shows the requested root and preserved dependencies in the root removal Review', async () => {
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult()),
      captureEvidence: vi.fn().mockResolvedValue(evidence),
    });
    await value.load();
    await value.buildOperationReview({
      kind: 'pluginWrite', action: 'uninstall', pluginId: 'official/agent-lab', platform: 'codex', scope: 'project',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D11');
    expect(instance.lastFrame()).toContain('你选择的插件');
    expect(instance.lastFrame()).toContain('Codex · 当前项目');
    expect(instance.lastFrame()).toContain('保持不变');
    expect(instance.lastFrame()).toContain('Agent Skill Toolkit');
  });

  it('selects force cleanup, reviews its risk and equivalent command, and executes force intent', async () => {
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(dependencyLoadResult({ rootState: 'present' })),
      executeIntent,
    });
    await value.load();
    value.push({
      name: 'pluginDependencies', pluginId: 'official/skill-toolkit', view: 'removeBlocked',
      platform: 'codex', scope: 'user',
    });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D12');
    expect(instance.lastFrame()).toContain('Agent Lab');
    expect(instance.lastFrame()).toContain('强制清理');
    expect(instance.lastFrame()).not.toContain('› Agent Lab');
    expect(instance.lastFrame()).toContain('› 强制清理');
    expect(instance.lastFrame()).toContain('↑↓ 移动');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);

    await input(instance, 'd');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('dependencyStillRequired');
    expect(technicalFrame).toContain('已安装插件仍在使用这个依赖');
    expect(technicalFrame).toContain('› 强制清理');
    expect(technicalFrame).toContain('d 技术详情');
    expect(technicalFrame).toContain('↑↓ 移动');
    expect(technicalFrame.match(/›/gu)).toHaveLength(1);
    expect(technicalFrame.split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, 'd');

    await input(instance, '\u001B[B', '\u001B[B', '\u001B[B');
    expect(instance.lastFrame()).toContain('› 技术详情');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('dependencyStillRequired');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, '\r', '\u001B[A', '\u001B[A', '\u001B[A');

    await input(instance, '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(instance.lastFrame()).toContain('强制清理插件');
    expect(instance.lastFrame()).toContain('跳过依赖保护');
    expect(instance.lastFrame()).toContain('依赖者会变为不完整');
    expect(value.snapshot.activeReview?.equivalentCommand).toBe(
      'aw cleanup official/skill-toolkit --platform codex --scope user --force',
    );
    expect(instance.lastFrame()).toContain('等价命令：aw cleanup official/skill-toolkit');
    expect(instance.lastFrame()).toContain('--force');

    await confirmReview(instance, value);
    await nextTurn(4);
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite', action: 'cleanup', pluginId: 'official/skill-toolkit',
      platform: 'codex', scope: 'user', force: true,
    }), expect.anything());
  });

  it('renders dependency target incompatibility as D16 and only offers compatible target platforms', async () => {
    const loaded = dependencyLoadResult();
    const unsupported = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/agent-lab' && entry.platform === 'claude' && entry.scope === 'user')!;
    unsupported.state = 'error';
    unsupported.errors = [{ code: 'dependencyTargetUnsupported', message: 'official/skill-toolkit 不支持 Claude Code' }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((entry) => entry.category === 'dependencyTargetUnsupported')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(3);
    expect(screens).toContain('D16');
    expect(instance.lastFrame()).toContain('无法添加到 Claude Code');
    expect(instance.lastFrame()).toContain('只添加到 Codex');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'installTargets', pluginId: 'official/agent-lab' });
  });

  it('budgets D10 with dependency and dependent rows and projects mixed placement status consistently', async () => {
    const loaded = dependencyLoadResult({ rootState: 'present' });
    const overview = loaded.dependencyOverviews!.find((entry) => entry.pluginId === 'official/agent-lab')!;
    const mixedDependency = overview.dependencies.find((entry) => entry.pluginId === 'official/skill-toolkit')!;
    mixedDependency.aggregateStatus = 'needsAttention';
    mixedDependency.placements = [
      { platform: 'codex', state: 'installed', scope: 'user', health: 'ready' },
      { platform: 'claude', state: 'installed', scope: 'user', health: 'incomplete' },
    ];
    overview.dependents.push({
      pluginId: 'official/content-toolkit',
      displayName: 'Agent Content Toolkit',
      relation: 'dependent',
      depth: 1,
      requiredBy: [],
      placements: [{ platform: 'codex', state: 'installed', scope: 'user', health: 'ready' }],
      aggregateStatus: 'ready',
      placementReferences: [{
        consumer: { pluginId: 'official/content-toolkit', platform: 'codex', scope: 'user', project: null },
        dependency: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'user', project: null },
      }],
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    const frame = instance.lastFrame() ?? '';
    expect(screens).toContain('D10');
    expect(frame).toContain('根插件 · Agent Lab');
    expect(frame).toContain('需要处理');
    expect(frame).toContain('必需依赖 · Agent Skill Toolkit');
    expect(frame).toContain('被依赖 · Agent Content Toolkit');
    expect(frame).not.toContain('Agent Skill Toolkit             所有项目 · 已可用');
    expect(frame).toContain('› 技术详情');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('mounts the dependency issue list and invalid graph recovery page as D13 and D17', async () => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: 'dependencyGraphInvalid',
      rootErrorMessage: 'dependencyGraphInvalid: cycle in public dependency graph.',
    });
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
      executeIntent,
    });
    await value.load();
    const graphIssue = value.listUserIssues().find((entry) => entry.category === 'dependencyGraphInvalid');
    expect(graphIssue).toBeDefined();
    const screens = new Set<ConsoleV4ScreenId>();
    value.push({ name: 'issueList' });
    const list = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    expect(screens).toContain('D13');
    expect(list.lastFrame()).toContain('4 项');
    expect(list.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect(list.lastFrame()).toContain('↑↓ 移动');
    list.unmount();

    value.push({ name: 'issueDetail', issueId: graphIssue!.issueId });
    const detail = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);
    const frame = detail.lastFrame() ?? '';
    expect(screens).toContain('D17');
    expect(frame).toContain('来源中的依赖关系无效');
    expect(frame).toContain('没有修改任何安');
    expect(frame).not.toContain('dependencyGraphInvalid');
    expect(frame).toContain('› 查看来源问题');
    expect(frame).toContain('查看依赖关系');
    expect(frame).toContain('技术详情');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);

    await input(detail, 'd');
    expect(detail.lastFrame()).toContain('dependencyGraphInvalid');
    expect(detail.lastFrame()).toContain('插件: official/agent-lab');
    await input(detail, 'd');
    const technicalIndex = graphIssue!.actions.findIndex((action) => action.id === 'viewTechnical') + 1;
    for (let index = 0; index < technicalIndex; index += 1) await input(detail, '\u001B[B');
    expect(detail.lastFrame()).toContain('› 技术详情');
    await input(detail, '\r');
    expect(detail.lastFrame()).toContain('dependencyGraphInvalid');
    await input(detail, 'd', ...Array.from({ length: technicalIndex }, () => '\u001B[A'));
    await input(detail, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceDetail', sourceId: 'official' });
    expect(captureEvidence).not.toHaveBeenCalled();
    expect(executeIntent).not.toHaveBeenCalled();
    expect(value.snapshot.activeReview).toBeUndefined();
  });

  it('does not invent a source recovery action for D17 without a source ID', async () => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: 'dependencyGraphInvalid',
      rootErrorMessage: 'dependencyGraphInvalid: cycle in public dependency graph.',
    });
    const targetWithoutSource = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/agent-lab'
      && entry.platform === 'codex'
      && entry.scope === 'user');
    expect(targetWithoutSource).toBeDefined();
    (targetWithoutSource as { sourceId?: string }).sourceId = undefined;

    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const graphIssue = value.listUserIssues().find((entry) =>
      entry.category === 'dependencyGraphInvalid'
      && entry.platform === 'codex'
      && entry.scope === 'user');
    expect(graphIssue).toBeDefined();
    expect(graphIssue!.sourceId).toBeUndefined();
    value.push({ name: 'issueDetail', issueId: graphIssue!.issueId });

    const detail = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    const frame = detail.lastFrame() ?? '';
    expect(frame).not.toContain('查看来源问题');
    expect(frame).toContain('› 查看依赖关系');
    expect(frame).toContain('技术详情');
    expect(frame).toContain('↑↓ 移动');
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
  });

  it('summarizes dependency relations as static rows and keeps the only action visible at 60x18', async () => {
    const loaded = dependencyLoadResult();
    const overview = loaded.dependencyOverviews!.find((entry) => entry.pluginId === 'official/agent-lab')!;
    overview.dependencies.push(...Array.from({ length: 6 }, (_, index) => ({
      pluginId: `official/extra-${index + 1}`,
      displayName: `额外依赖 ${index + 1}`,
      relation: 'transitive' as const,
      depth: 3,
      requiredBy: [{ pluginId: 'official/content-toolkit', displayName: 'Agent Content Toolkit' }],
      placements: [{ platform: 'codex' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] }],
      aggregateStatus: 'notInstalled' as const,
    })));
    overview.summary.totalCount += 6;
    overview.summary.transitiveCount += 6;
    overview.summary.missingCount += 6;
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(3);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('Agent Skill Toolkit');
    expect(frame).toContain('Agent Content Toolkit');
    expect(frame).toMatch(/另有 \d+ 项/u);
    expect(frame).toContain('› 技术详情');
    expect(frame).not.toContain('› Agent Skill Toolkit');
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame).toContain('↑↓ 移动');
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 技术详情');
  });

  it.each([
    ['D02', 'absent', 80, 24],
    ['D10', 'present', 80, 24],
    ['D02', 'absent', 60, 18],
    ['D10', 'present', 60, 18],
  ] as const)('jointly budgets high-volume %s relations with root %s at %ix%i', async (
    expectedScreen,
    rootState,
    columns,
    rows,
  ) => {
    const loaded = dependencyLoadResult({ rootState });
    const overview = loaded.dependencyOverviews!.find((entry) => entry.pluginId === 'official/agent-lab')!;
    overview.summary = { directCount: 1, transitiveCount: 7, totalCount: 8, readyCount: 1, missingCount: 7, issueCount: 1 };
    overview.blockers.push({ code: 'dependencyUnavailable', title: '高优先级阻塞', explanation: '来源中的依赖不可用。' });
    overview.dependencies.push(...Array.from({ length: 6 }, (_, index) => ({
      pluginId: `official/high-dependency-${index}`,
      displayName: `高数量依赖 ${index}`,
      relation: 'transitive' as const,
      depth: 2,
      requiredBy: [{ pluginId: 'official/skill-toolkit', displayName: 'Agent Skill Toolkit' }],
      placements: [{ platform: 'codex' as const, state: 'notInstalled' as const, supportedScopes: ['user', 'project'] }],
      aggregateStatus: index === 5 ? 'needsAttention' as const : 'notInstalled' as const,
    })));
    overview.dependents.push(...Array.from({ length: 5 }, (_, index) => ({
      pluginId: `official/high-dependent-${index}`,
      displayName: `高数量依赖者 ${index}`,
      relation: 'dependent' as const,
      depth: 1,
      requiredBy: [],
      placements: [{ platform: 'codex' as const, state: 'installed' as const, scope: 'user' as const, health: 'ready' as const }],
      aggregateStatus: 'ready' as const,
      placementReferences: [{
        consumer: { pluginId: `official/high-dependent-${index}`, platform: 'codex' as const, scope: 'user' as const, project: null },
        dependency: { pluginId: 'official/agent-lab', platform: 'codex' as const, scope: 'user' as const, project: null },
      }],
    })));
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
    const screens = new Set<ConsoleV4ScreenId>();
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} onScreenChange={(screen) => screens.add(screen)} />);
    await nextTurn(2);

    const initial = instance.lastFrame() ?? '';
    expect(screens).toContain(expectedScreen);
    expect(initial).toContain('› 技术详情');
    expect(initial).toContain('阻塞 · 高优先级阻塞');
    expect(initial).toContain('必需依赖 · 高数量依赖 5');
    expect(initial).toContain('需要处理');
    expect(initial).toContain('被依赖 · 高数量依赖者');
    expect(initial).toContain('↑↓ 移动');
    expect(initial.match(/›/gu)).toHaveLength(1);
    expect(initial.split('\n').length).toBeLessThanOrEqual(rows);

    await input(instance, 'd');
    const technical = instance.lastFrame() ?? '';
    expect(technical).toContain('技术详情');
    expect(technical).toContain('8 依赖 · 5 被依赖 · 已折叠');
    expect(technical).toMatch(/另有 \d+ 项/u);
    expect(technical).toContain('› 技术详情');
    expect(technical).toContain('↑↓ 移动');
    expect(technical.match(/›/gu)).toHaveLength(1);
    expect(technical.split('\n').length).toBeLessThanOrEqual(rows);

    await input(instance, '\r');
    expect(instance.lastFrame()).not.toContain('8 依赖 · 5 被依赖 · 已折叠');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDependencies', pluginId: 'official/agent-lab' });
  });
});
