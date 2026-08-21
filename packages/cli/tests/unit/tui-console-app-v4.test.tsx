import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StatusV4Payload, StatusV4PluginSummary } from '../../src/commands/status-v4.js';
import {
  CONSOLE_V4_SCREEN_IDS,
  ConsoleAppV4,
  type ConsoleV4ScreenId,
} from '../../src/tui/console-app-v4.js';
import {
  TuiController,
  type OperationEvidence,
  type TuiControllerDependencies,
} from '../../src/tui/controller.js';
import type { ConfigPageViewModel } from '../../src/tui/model.js';

afterEach(() => cleanup());

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
}): StatusV4Payload['targets'][number] {
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
    errors: options.state === 'partial' ? [{ code: 'missingContent', message: '安全说明' }] : [],
  };
}

function loadResult(): { payload: StatusV4Payload; pluginSummaries: StatusV4PluginSummary[] } {
  const summaries: StatusV4PluginSummary[] = [
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
  return {
    payload: {
      schemaVersion: 4,
      catalog: {
        primarySourceId: 'official',
        configDigest: 'sha256:config',
        compositeDigest: 'sha256:composite',
        sources: [
          { id: 'official', identity: 'identity:official', type: 'path', primary: true, requestedRef: 'path', freshness: 'path' },
          { id: 'team-tools', identity: 'identity:team-tools', type: 'path', primary: false, requestedRef: 'path', freshness: 'path' },
          { id: 'research', identity: 'identity:research', type: 'path', primary: false, requestedRef: 'path', error: 'unavailable', errorCode: 'catalogSourceUnavailable' },
        ],
      },
      filters: { plugins: [], platform: 'both', cwd: '/workspace' },
      targets: allTargets,
      errors: [],
    },
    pluginSummaries: summaries,
  };
}

function controller(overrides: Partial<TuiControllerDependencies> = {}): TuiController {
  return new TuiController({
    loadStatus: vi.fn().mockResolvedValue(loadResult()),
    checkSource: vi.fn().mockResolvedValue(undefined),
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

function configPage(pluginId = 'team-tools/review-gate'): ConfigPageViewModel {
  const field = (
    key: string,
    type: ConfigPageViewModel['groups'][number]['fields'][number]['type'],
    extra: Partial<ConfigPageViewModel['groups'][number]['fields'][number]> = {},
  ): ConfigPageViewModel['groups'][number]['fields'][number] => ({
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
    advanced: false,
    ...extra,
  });
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
  value: TuiController,
): Promise<void> {
  const changes = value.snapshot.activeReview?.changes.length ?? 0;
  await input(instance, ...Array.from({ length: changes }, () => '\u001B[B'), '\r');
}

describe('ConsoleAppV4', () => {
  it('keeps the merged G/P/C design map free of duplicate route identities', () => {
    expect(CONSOLE_V4_SCREEN_IDS).toHaveLength(43);
    expect(new Set(CONSOLE_V4_SCREEN_IDS)).toHaveProperty('size', 43);
    expect(CONSOLE_V4_SCREEN_IDS).toEqual([
      'G01', 'G02', 'G03', 'G04', 'G05',
      'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10',
      'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18', 'P19', 'P20', 'P21',
      'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10',
      'C11', 'C12', 'C13', 'C14', 'C15', 'C16', 'C17',
    ]);
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
    await mountRoute({ name: 'installTools', pluginId: 'official/agent-lab' }, 'P06');
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
    expect(screens).toEqual(expect.arrayContaining(['G01', 'G02', 'G03']));
    expect(screens).not.toContain('G04');
  });

  it('uses G04 only for real dirty state and supports continue editing or discard', async () => {
    const screens: ConsoleV4ScreenId[] = [];
    const value = controller();
    value.push({ name: 'installTools', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onScreenChange={(screen) => screens.push(screen)}
    />);
    await nextTurn(3);

    await input(instance, ' ', 'q');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    expect(screens).toContain('G04');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('选择要添加到哪些工具');
    await input(instance, 'q', '\u001B[B', '\r');

    expect(value.snapshot.router.current.route).toEqual({ name: 'home' });
  });

  it('uses Space only to toggle tools and Enter only to finish a legal selection', async () => {
    const value = controller();
    value.push({ name: 'installPlacement', pluginId: 'official/agent-lab' });
    value.push({ name: 'installTools', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('installTools');
    await input(instance, ' ', '\r');
    expect(value.snapshot.router.current.route.name).toBe('installPlacement');
  });

  it('does not dispose an externally owned controller and exposes initial load failure', async () => {
    const value = controller({ loadStatus: vi.fn().mockRejectedValue(new Error('statusUnavailable: private')) });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    expect(instance.lastFrame()).toContain('无法读取插件状态');
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
    expect(exit).toHaveBeenCalledOnce();
    expect(instance.lastFrame()).toContain('/ 输入搜索内容');
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
    await input(instance, '\u001B[B', '\u001B[B', '\r');
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
      name: 'issueDetail',
      issueId: 'target:official/agent-lab:claude:user:error',
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
      subject: { sourceLabel: 'official' },
      changes: [{ title: 'Claude Code · 所有项目' }],
    });
  });

  it('shows a new review after stale evidence and performs no write', async () => {
    const changed = { ...evidence, targetFingerprint: 'sha256:changed' };
    const executeIntent = vi.fn();
    const value = controller({
      captureEvidence: vi.fn()
        .mockResolvedValueOnce(evidence)
        .mockResolvedValue(changed),
      executeIntent,
    });
    await value.load();
    await value.buildOperationReview({ kind: 'pluginWrite', action: 'install', pluginId: 'official/agent-lab', platform: 'both', scope: 'user' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);
    await confirmReview(instance, value);

    expect(executeIntent).not.toHaveBeenCalled();
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

  it('reaches C01-C14 through real keyboard editing without exposing private values or changing layer with Tab', async () => {
    const reached = new Set<ConsoleV4ScreenId>();
    const exit = vi.fn();
    let finishExecution!: (value: unknown) => void;
    const executeIntent = vi.fn(() => new Promise<unknown>((resolve) => {
      finishExecution = resolve;
    }));
    const getConfigPage = vi.fn(async (
      pluginId: string,
      layer: ConfigPageViewModel['layer'],
    ) => ({ ...configPage(pluginId), layer }));
    const value = controller({ getConfigPage, executeIntent });
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onExit={exit}
      onScreenChange={(screen) => reached.add(screen)}
    />);
    await nextTurn(4);

    await input(instance, '\u001B[B', '\u001B[B', '\r');
    expect(reached).toContain('C01');
    const layerRoute = value.snapshot.router.current.route;
    await input(instance, '\t');
    expect(value.snapshot.router.current.route).toEqual(layerRoute);

    await input(instance, '\r');
    await nextTurn(3);
    expect(reached).toContain('C02');
    expect(instance.lastFrame()).toContain('只读');
    expect(instance.lastFrame()).not.toContain('/Users/private');
    await input(instance, 'b', '\u001B[B', '\r');
    await nextTurn(3);
    expect(reached).toContain('C03');

    await confirmReview(instance, value);
    expect(reached).toContain('C11');
    expect(instance.lastFrame()).toContain('团队默认');
    await input(instance, '\r');

    await input(instance, '\u001B[B', '\r', '\r');
    expect(reached).toContain('C05');
    await input(instance, '\u001B[B', '\r', '\r');
    expect(reached).toContain('C06');
    await input(instance, '\u001B[B', '\r', '\r');
    expect(reached).toContain('C07');
    await input(instance, '\u001B[B', '\r', 'x', '\r');
    expect(reached).toContain('C08');
    await input(instance, '\u001B[B', '\r', './rules.json', '\r');
    expect(reached).toContain('C09');
    await input(instance, '\u001B[B', '\u001B[B', '\r', 'sk-private-value');
    expect(reached).toContain('C10');
    expect(instance.lastFrame()).not.toContain('sk-private-value');
    await input(instance, '\u0003');
    expect(exit).toHaveBeenCalledOnce();
    expect(value.snapshot.router.current.route.name).toBe('configFieldEditor');
    await input(instance, '\r');
    await input(instance, '\u001B[B', '\r');
    expect(reached).toContain('C04');
    await input(instance, 'b', 's');
    await nextTurn(4);
    expect(reached).toContain('C12');
    const reviewFrame = instance.lastFrame() ?? '';
    expect(reviewFrame).not.toContain('保存并应用');
    expect(reviewFrame).not.toContain('sk-private-value');
    expect(reviewFrame).not.toContain('./rules.json');

    await confirmReview(instance, value);
    await nextTurn(4);
    expect(reached).toContain('C13');
    finishExecution({
      configWrite: 'succeeded',
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    await nextTurn(5);
    expect(reached).toContain('C14');
    expect(instance.lastFrame()).toContain('设置已保存并应用');
    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'configSave',
      pluginId: 'team-tools/review-gate',
      scope: 'user',
      projectLayer: 'shared',
    }), evidence);
  });

  it('renders config partial retry, reset Review, unavailable terminal state, and compact field viewport', async () => {
    const partialScreens = new Set<ConsoleV4ScreenId>();
    const partial = controller({
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
    await input(partialInstance, '\u001B[B', '\r', '\r', 's');
    await nextTurn(3);
    await confirmReview(partialInstance, partial);
    await nextTurn(4);
    expect(partialScreens).toContain('C15');
    expect(partialInstance.lastFrame()).toContain('部分应用失败');
    await input(partialInstance, '\u001B[B', '\r');
    expect(partial.snapshot.activeReview?.changes).toEqual([
      expect.objectContaining({ title: 'Claude Code · 所有项目' }),
    ]);

    const resetScreens = new Set<ConsoleV4ScreenId>();
    const reset = controller({ getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })) });
    reset.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'project', projectLayer: 'local' } });
    const resetInstance = render(<ConsoleAppV4 controller={reset} size={{ columns: 80, rows: 24 }} onScreenChange={(screen) => resetScreens.add(screen)} />);
    await nextTurn(4);
    await input(resetInstance, ...Array.from({ length: 9 }, () => '\u001B[B'), '\r');
    await nextTurn(3);
    expect(resetScreens).toContain('C16');
    expect(resetInstance.lastFrame()).toContain('当前项目（仅本机）');
    expect(resetInstance.lastFrame()).toContain('其他设置层保持不变');

    const unavailableScreens = new Set<ConsoleV4ScreenId>();
    const checkSource = vi.fn().mockResolvedValue(undefined);
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
    expect(compactFrame.split('\n').length).toBeLessThanOrEqual(18);

    const effective = controller({ getConfigPage: vi.fn(async (_pluginId, layer) => ({ ...longPage, layer })) });
    effective.push({ name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'effective', projectLayer: 'shared' } });
    const effectiveInstance = render(<ConsoleAppV4 controller={effective} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(4);
    await input(effectiveInstance, ...Array.from({ length: 8 }, () => '\u001B[B'));
    expect(effectiveInstance.lastFrame()).toContain('› 字段 9');
    expect((effectiveInstance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
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
    await input(instance, '\r', '\r', 'b');
    expect(screens).toContain('G04');
    expect(instance.lastFrame()).toContain('放弃未保存修改？');
    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'home' });
  });

  it('treats b as text, normalizes no-op drafts, and disables reset for an empty layer', async () => {
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
    await input(instance, '\u001B[B', '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('当前没有未保存修改');
    value.push({
      name: 'configFieldEditor',
      pluginId: 'team-tools/review-gate',
      layer: { scope: 'user', projectLayer: 'shared' },
      fieldKey: 'note',
      editor: 'string',
    });
    await nextTurn(2);
    await input(instance, '\u0015');
    expect(instance.lastFrame()).toContain('当前没有未保存修改');
    await input(instance, 's');
    expect(value.snapshot.activeReview).toBeUndefined();
    expect(instance.lastFrame()).toContain('本层没有已存值');
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

  it('keeps the owner draft after a safe rollback and never renders a saved result', async () => {
    const screens = new Set<ConsoleV4ScreenId>();
    const value = controller({
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
      executeIntent: vi.fn().mockResolvedValue({
        configWrite: 'rolledBack',
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

    expect(value.snapshot.result).toMatchObject({ state: 'blocked', code: 'configWriteRolledBack' });
    expect(value.snapshot.router.current.route.name).toBe('configFields');
    expect(instance.lastFrame()).toContain('DRAFT-KEEP');
    expect(instance.lastFrame()).toContain('1 项未保存');
    expect(screens).not.toContain('C14');
    expect(screens).not.toContain('C15');
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
    expect(instance.lastFrame()).toContain('› ~ 变更 1');
    expect(instance.lastFrame()).not.toContain('保存并应用');
    await input(instance, '\r');
    expect(executeIntent).not.toHaveBeenCalled();

    const changeCount = value.snapshot.activeReview!.changes.length;
    await input(instance, ...Array.from({ length: changeCount }, () => '\u001B[B'));
    expect(instance.lastFrame()).toContain('› 保存并应用');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, '\r');
    expect(executeIntent).toHaveBeenCalledOnce();
  });
});
