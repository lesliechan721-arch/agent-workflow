import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  StatusV8CodexTarget,
} from '../../src/commands/status-v6.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import {
  ConsoleAppV4,
  type ConsoleV4ScreenId,
} from '../../src/tui/console-app-v4.js';
import {
  userIssueKey,
  type OperationEvidence,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import { copyToClipboard } from '../../src/tui/clipboard.js';

vi.mock('../../src/tui/clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import {
  aggregateCodexTargets,
  configPage,
  controller,
  dependencyLoadResult,
  evidence,
  loadResult,
  placement,
  platformLoadResult,
  setAllPlacementsAbsent,
  target,
  updatePlacement,
} from '../helpers/tui-console-app-fixture.js';

import {
  acceptanceTraceStep,
  confirmReview,
  focusAction,
  input,
  nextTurn,
  type AcceptanceTraceStep,
  writeAcceptanceTrace,
} from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

function mixedScopeConflictTarget(
  pluginName: string,
  sourceId = 'official',
): StatusV8CodexTarget {
  const value = target({ pluginName, sourceId, platform: 'codex', scope: 'user', state: 'present' }) as StatusV8CodexTarget;
  value.placements.push(structuredClone(value.placements[0]!), { ...structuredClone(value.placements[0]!), scope: 'project' });
  value.placements.shift();
  value.state = 'blocked';
  value.components.push(
    { kind: 'sharedNative', key: `${pluginName}@aw-${sourceId}`, state: 'usable', metadata: { shared: true } },
  );
  for (const entry of value.placements) entry.components.push(
    {
      kind: 'intent', key: 'desired', state: 'desired',
      metadata: { enabled: true, scopes: ['project', 'user'], relation: 'root' },
    },
    { kind: 'extension', key: 'aw', state: 'conflict', metadata: { kinds: ['instruction'] } },
  );
  value.reasons = [{
    code: 'codexExtensionScopeConflict',
    message: 'codexExtensionScopeConflict: mixed scope overlap',
    severity: 'blocking',
  }];
  value.recoveryActions = [
    {
      command: 'uninstall',
      scope: 'user',
      description: `运行 aw uninstall ${sourceId}/${pluginName} --platform codex --scope user，再运行 aw sync ${sourceId}/${pluginName} --platform codex --scope project。`,
    },
    {
      command: 'uninstall',
      scope: 'project',
      description: `运行 aw uninstall ${sourceId}/${pluginName} --platform codex --scope project，再运行 aw sync ${sourceId}/${pluginName} --platform codex --scope user。`,
    },
  ];
  return value;
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

describe('ConsoleAppV4', () => {
  it('routes typed I01-I09 issues and the empty state through mounted pages', async () => {
    const loaded = loadResult();
    const conflictTargetIndex = loaded.payload.targets.findIndex((entry) =>
      entry.pluginId === 'team-tools/review-gate'
      && entry.platform === 'codex');
    loaded.payload.targets.splice(
      conflictTargetIndex,
      1,
      mixedScopeConflictTarget('review-gate', 'team-tools'),
    );
    loaded.payload.targets.push(
      target({ pluginName: 'missing', sourceId: 'archive', platform: 'codex', scope: 'user', state: 'error', errorCode: 'sourceMissing' }),
      target({ pluginName: 'changed', sourceId: 'team-tools', platform: 'codex', scope: 'project', state: 'error', errorCode: 'sourceChanged' }),
    );
    loaded.payload.errors.push({ code: 'legacyStateUnsupported', message: 'private legacy location' });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const expected = new Map([
      ['incompleteInstallation', 'I03'],
      ['sourceUnavailable', 'I04'],
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
        expect(detailInstance.lastFrame()).toContain('清理 AW 管理内容');
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
    empty.payload.targets = empty.payload.targets.map(setAllPlacementsAbsent);
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
    ['codexSharedNativeCorrupt', 'Codex 平台由多个项目共用的生成内容缺失或损坏。'],
    ['codexSharedNativeRenderDrift', 'Codex 平台由多个项目共用的生成内容与当前渲染输入不一致。'],
    ['codexSharedNativeUnobserved', '未取得有效的 Codex 状态证据，暂时无法确认插件是否可用。'],
    ['codexNativeObservationFailed', '未取得有效的 Codex 状态证据，暂时无法确认插件是否可用。'],
    ['codexActivationDrift', 'Codex 激活配置与期望的使用范围不一致。'],
    ['codexSharedNativeUpdateRequired', '已安装的 Codex 由平台共用的内容版本与当前插件版本不一致。'],
  ] as const)('shows typed shared-native reason %s in a mounted issue page', async (
    code,
    explanation,
  ) => {
    const loaded = loadResult();
    loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
    loaded.pluginSummaries = [loaded.pluginSummaries[1]!];
    loaded.payload.targets = [{
      ...target({
        pluginName: 'review-gate', platform: 'codex', scope: 'project', state: 'partial',
      }),
      reasons: [{ code, message: 'stable detail', severity: 'warning' }],
    }];
    const reasonTarget = loaded.payload.targets[0]!;
    updatePlacement(reasonTarget, 'project', {
      reasons: [{ code, message: 'stable detail', severity: 'warning' }],
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues()[0]!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain(explanation);
    if (code === 'codexSharedNativeCorrupt' || code === 'codexSharedNativeRenderDrift') {
      expect(instance.lastFrame()).toContain('运行同步可重新生成由平台共用的 Skill。');
    } else {
      expect(instance.lastFrame()).not.toContain('安装不完整');
      expect(instance.lastFrame()).not.toContain('必要内容缺失');
    }
    expect(instance.lastFrame()).not.toContain('个人默认已变化');
    expect(instance.lastFrame()).not.toContain('这不是缓存损坏');
    value.push({ name: 'platform', pluginId: issue.pluginId!, platform: 'codex' });
    await nextTurn(2);
    expect(instance.lastFrame()).toContain(explanation);
    expect(instance.lastFrame()).not.toContain('缺少一项必要内容');
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
    let allTechnicalPages = frame;
    for (let page = 0; page < 8; page += 1) {
      await input(instance, '\u001B[C');
      allTechnicalPages += instance.lastFrame() ?? '';
    }
    expect(allTechnicalPages).toContain('建议 1');
    expect(allTechnicalPages).toContain('运行 aw status --json，记录公开错误 code。');
    expect(allTechnicalPages).toContain('备份相关 AW 配置。');
    expect(allTechnicalPages).toContain('按技术详情使用受支持命令或人工处理。');
    expect(allTechnicalPages).toContain('再次运行状态检查。');
    expect(frame).toContain('› 查看手动处理说明');
    expect(frame).toMatch(/d\s+返回摘要/u);
    expect(frame).toMatch(/↑↓(?:\s+移动|\/Enter\s+菜单)/u);
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
    updatePlacement(resolved.payload.targets[0]!, 'user', { state: 'ready', reasons: [] });
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
      actionId: 'sync',
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
    await nextTurn(10);
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
    const cleanupEvidence: OperationEvidence = {
      ...evidence,
      operationPlan: createOperationPlan({
        intentChanges: [{ scope: 'user', beforeDigest: 'sha256:before', afterDigest: 'sha256:after' }],
        actions: [],
        changes: ['official/retired-tool:codex:user:removeIntent'],
        warnings: ['inventoryUnreadable: sha256:residual'],
        evidence: {
          catalogDigests: [],
          intentDigests: [{ scope: 'user', digest: 'sha256:intent' }],
          configDigests: [],
          targetOwnerFingerprints: [],
        },
      }),
      offlineCleanupPlans: [{
        reason: 'bundleUnavailable',
        pluginId: 'official/retired-tool',
        pluginName: 'retired-tool',
        sourceId: 'official',
        sourceIdentity: 'identity:official',
        platform: 'codex',
        scope: 'user',
        plan: {
          schemaVersion: 1,
          pluginId: 'official/retired-tool',
          sourceIdentity: 'identity:official',
          platform: 'codex',
          scope: 'user',
          actions: [{
            action: 'removeOwnedOutput',
            kind: 'owned-text-file',
            target: '/private/aw-home/managed/retired-tool.md',
          }],
        },
        planDigest: 'sha256:offline-plan',
        targetFingerprint: 'sha256:offline-plan',
      }],
    };
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(resolved);
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [{ target: { platform: 'codex', scope: 'user' }, state: 'completed' }],
    });
    const value = controller({
      loadStatus,
      captureEvidence: vi.fn().mockResolvedValue(cleanupEvidence),
      executeIntent,
    });
    await value.load();

    expect(value.listPlugins({ mode: 'browse', installFilter: 'uninstalled' }).map((plugin) => plugin.pluginId))
      .toEqual([]);
    expect(value.listPlugins({ mode: 'installed', installFilter: 'installed' }).map((plugin) => plugin.pluginId))
      .toEqual(['official/retired-tool']);
    const issue = value.listUserIssues()[0]!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('当前插件目录不再包含此插件');
    expect(instance.lastFrame()).toContain('清理 AW 管理内容');
    expect(instance.lastFrame()).not.toContain('--force');
    await input(instance, '\r');

    const reviewFrame = instance.lastFrame() ?? '';
    expect(value.snapshot.activeReview).toMatchObject({
      pluginAction: 'cleanup',
      originIssue: { actionId: 'cleanup' },
      equivalentCommand: 'aw cleanup official/retired-tool --platform codex --scope user',
    });
    expect(reviewFrame).toContain('先核验所选位置，再取消其使用设置，并尽力清理可验证的 AW 输出');
    expect(reviewFrame).toContain('核验当前 AW 管理现场');
    expect(reviewFrame).toContain('取消已保存的使用设置');
    expect(reviewFrame).toContain('移除可验证的 AW 输出');
    expect(reviewFrame).toContain('部分现场残留无法完整核验');
    expect(reviewFrame).toContain('保留不属于插件或被共用的内容、插件设置、依赖使用范围和其他平台或位置');
    expect(reviewFrame).toContain('其他根插件仍可按自己的设置使用或安装此依赖');
    expect(reviewFrame).not.toContain('/private/aw-home/managed/retired-tool.md');
    expect(reviewFrame).not.toContain('inventoryUnreadable');
    expect(reviewFrame).not.toContain('lifecycle');
    expect(reviewFrame).not.toContain('等价命令：');
    expect(reviewFrame).not.toContain('--force');
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('等价命令：aw cleanup official/retired-tool --platform codex --scope user');
    expect(instance.lastFrame()).not.toContain('/private/aw-home/managed/retired-tool.md');

    const clipboard = vi.mocked(copyToClipboard).mockReset().mockResolvedValue(undefined);
    for (const size of [{ columns: 60, rows: 18 }, { columns: 80, rows: 24 }]) {
      instance.rerender(<ConsoleAppV4 controller={value} size={size} />);
      await nextTurn(2);
      await input(instance, 'y');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('全文已复制'));
      expect(clipboard).toHaveBeenLastCalledWith(expect.stringContaining(
        '等价命令：aw cleanup official/retired-tool --platform codex --scope user',
      ));
      expect(clipboard.mock.lastCall?.[0]).not.toContain('/private/aw-home/managed/retired-tool.md');
      expect(executeIntent).not.toHaveBeenCalled();
    }

    await confirmReview(instance, value);
    await nextTurn(4);

    expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite',
      action: 'cleanup',
      pluginId: 'official/retired-tool',
      platform: 'codex',
      scope: 'user',
    }), cleanupEvidence);
    expect(executeIntent.mock.calls[0]?.[0]).not.toHaveProperty('force');
    expect(value.listPlugins({ mode: 'browse', installFilter: 'uninstalled' })).toEqual([]);
    expect(value.listPlugins({ mode: 'installed', installFilter: 'installed' })).toEqual([]);
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
    expect(instance.lastFrame()).not.toContain('dependencyStillRequired');
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
    expect(instance.lastFrame()).not.toContain('重试失败部分');
    expect(value.listUserIssues().some((entry) => entry.issueId === selected.issueId)).toBe(true);
  });

  it.each([
    { key: '', actionId: 'keepProjectScope', removedScope: 'user' },
    { key: '\u001B[B', actionId: 'keepUserScope', removedScope: 'project' },
  ] as const)('maps the canonical scope choice $actionId to removing $removedScope', async ({ key, actionId, removedScope }) => {
    const loaded = loadResult();
    loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
    loaded.payload.targets = [mixedScopeConflictTarget('review-gate')];
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
    expect(frame).toMatch(/d\s+技术详情/u);
    expect(frame.match(/›/gu)).toHaveLength(1);
    expect(frame.split('\n').length).toBeLessThanOrEqual(18);
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('dependencyMissing');
    expect(instance.lastFrame()).not.toContain('has changed state');
  });

  it('keeps shared-native recovery visible when its version evidence conflicts with the update', async () => {
    const loaded = platformLoadResult('upgradeAvailable');
    const native = loaded.payload.targets.find((entry): entry is StatusV8CodexTarget =>
      entry.pluginId === 'official/review-gate' && entry.platform === 'codex')!;
    native.components = [{ kind: 'sharedNative', key: 'review-gate@aw',
      state: 'replaceable', metadata: {
        reason: 'outdated', version: '2.0.0', desiredVersion: '0.3.0',
      } }];
    updatePlacement(native, 'user', { state: 'needsSync', reasons: [{
      code: 'codexSharedNativeUpdateRequired', message: 'update required', severity: 'warning',
    }] });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: native.pluginId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 120, rows: 40 }} />);
    await nextTurn(2);

    expect(value.listUserIssues().some((issue) => issue.issueId === `sharedNative:${native.pluginId}`))
      .toBe(true);
    expect(instance.lastFrame()).toContain('查看处理建议');
    expect(instance.lastFrame()).toContain('更新到 0.3.0');
  });

  it('keeps the shared-native issue when installed Codex scopes disagree about the update', async () => {
    const loaded = platformLoadResult('upgradeAvailable');
    const native = loaded.payload.targets.find((entry): entry is StatusV8CodexTarget =>
      entry.pluginId === 'official/review-gate' && entry.platform === 'codex')!;
    native.components = [{ kind: 'sharedNative', key: 'review-gate@aw',
      state: 'replaceable', metadata: {
        reason: 'outdated', version: '0.2.1', desiredVersion: '0.3.0',
      } }];
    const reason = {
      code: 'codexSharedNativeUpdateRequired', message: 'update required', severity: 'warning' as const,
    };
    updatePlacement(native, 'user', { state: 'needsSync', reasons: [reason] });
    native.placements.push({ ...structuredClone(native.placements[0]!), scope: 'project' });
    updatePlacement(native, 'project', { state: 'needsSync', reasons: [reason] });
    loaded.targetRevisions.push({
      pluginId: native.pluginId, platform: 'codex', scope: 'project',
      revision: { state: 'unknown', installedVersion: '0.4.0', availableVersion: '0.3.0' },
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();

    expect(value.listUserIssues().some((issue) => issue.issueId === `sharedNative:${native.pluginId}`))
      .toBe(true);
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
    const failedTarget = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/agent-lab' && entry.platform === 'codex')!;
    updatePlacement(failedTarget, 'user', {
      state: 'blocked',
      reasons: [{
        code: 'nativeTargetUnreadable',
        message: 'native stderr Bearer platform-route-secret /Users/private/platform-route',
        severity: 'blocking',
      }],
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/agent-lab', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    const productFrame = instance.lastFrame() ?? '';
    expect(productFrame).toContain('当前目标不能安全分类为正常安装');
    expect(productFrame).toContain('查看对应问题');
    expect(productFrame).not.toContain('nativeTargetUnreadable');
    expect(productFrame).not.toContain('platform-route-secret');

    await focusAction(instance, '查看对应问题');
    await input(instance, '\r', 'd');
    let technicalFrames = instance.lastFrame() ?? '';
    for (let page = 0; page < 8; page += 1) {
      await input(instance, '\u001B[C');
      technicalFrames += `\n${instance.lastFrame() ?? ''}`;
    }
    expect(technicalFrames).toContain('nativeTargetUnreadable');
    expect(technicalFrames).toContain('read-platform-state');
    expect(technicalFrames).not.toContain('platform-route-secret');
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
    const firstTechnicalFrame = instance.lastFrame() ?? '';
    await input(instance, '\u001B[6~');
    const technicalFrame = `${firstTechnicalFrame}\n${instance.lastFrame() ?? ''}`;
    expect(technicalFrame).toContain('dependencyMissing');
    expect(issue.diagnostic.technical?.stage).toBe('resolve-dependencies');
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
    expect(productFrame).toContain('修复插件来源');
    expect(productFrame).not.toContain('aw catalog source sync team-tools');
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
    expect(productFrame).toContain('返回插件详情');
    expect(productFrame).not.toContain('portableSkillInvalid');
    await input(instance, '\u001B[B', '\u001B[B');
    expect(instance.lastFrame()).toContain('› 技术详情');
    await input(instance, '\r');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('portableSkillInvalid');
    expect(technicalFrame).toContain('prepare-portable');
    expect(technicalFrame).toContain('下面的信息已脱敏，可用于排查或提交 issue');
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain('返回插件详情');
  });

  it('opens the canonical reloaded partial issue instead of a synthesized error route', async () => {
    const before = loadResult();
    const after = loadResult();
    const failed = after.payload.targets.find((entry) =>
      entry.pluginId === 'official/agent-lab'
      && entry.platform === 'claude'
      && entry.scope === 'user');
    if (failed) updatePlacement(failed, 'user', {
      state: 'needsSync',
      reasons: [{ code: 'missingContent', message: '安全说明', severity: 'warning' }],
    });
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
      issueId: 'incompleteInstallation:official/agent-lab:claude:user',
    });
  });

  it.each(['project', 'user'] as const)('offers recovery for ineffective or orphaned %s activation from plugin issues', async (scope) => {
    // Risk: orphaned activation marks the plugin unhealthy but leaves its issue page without recovery.
    const loaded = loadResult();
    const projectOverride = scope === 'project';
    const desiredScope = scope === 'project' ? 'user' : 'project';
    const codex = aggregateCodexTargets((['project', 'user'] as const).map((targetScope) => target({
      pluginName: 'agent-lab', platform: 'codex', scope: targetScope, state: 'present',
    })))[0] as StatusV8CodexTarget;
    codex.components = [{ kind: 'sharedNative', key: 'agent-lab@aw-official', state: 'usable' }];
    for (const targetScope of ['project', 'user'] as const) {
      updatePlacement(codex, targetScope, {
        state: targetScope === scope ? projectOverride ? 'needsSync' : 'orphaned' : 'ready',
        components: [
          { kind: 'intent', key: 'desired', state: targetScope === scope ? 'absent' : 'desired',
            metadata: { enabled: targetScope === desiredScope, scopes: [desiredScope], relation: 'root' } },
          { kind: 'activation', key: 'user', state: 'enabled',
            metadata: { effective: !projectOverride, evidence: 'observed' } },
          { kind: 'activation', key: 'project', state: projectOverride ? 'disabled' : 'enabled',
            metadata: { effective: !projectOverride, evidence: 'observed' } },
        ],
        reasons: targetScope === scope ? [{
          code: 'codexActivationDrift', severity: 'warning',
          message: `${targetScope} expected=false, actual=true.`,
        }] : [],
        recoveryActions: targetScope === scope ? [{
          command: projectOverride ? 'sync' : 'cleanup', scope: 'user', description: 'Restore selected activation.',
        }] : [],
      });
    }
    loaded.payload.targets = [codex];
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    expect(value.getPluginOverview('official/agent-lab')?.aggregateStatus).toBe('needsAttention');
    value.push({ name: 'pluginDetail', pluginId: 'official/agent-lab' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 100, rows: 32 }} />);
    await nextTurn(2);
    await focusAction(instance, '查看处理建议');
    await input(instance, '\r');
    await nextTurn(2);

    expect(value.snapshot.router.current.route.name).toBe('issueDetail');
    expect(instance.lastFrame()).toContain(projectOverride
      ? '插件在当前项目被关闭' : '所有项目有多余的启用记录');
    await focusAction(instance, projectOverride ? '恢复在当前项目使用' : '清理多余的启用记录');
    await input(instance, '\r');
    await nextTurn(3);
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite', action: projectOverride ? 'sync' : 'cleanup',
      pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    }), expect.any(AbortSignal));
    expect(value.snapshot.router.current.route.name).toBe('review');
  });

  it.each([
    ['project', '当前项目'],
    ['user', '所有项目'],
  ] as const)('enters Review for the %s scope from dual needsSync actions', async (scope, scopeLabel) => {
    const loaded = loadResult();
    loaded.payload.targets = loaded.payload.targets.filter((entry) =>
      entry.pluginId !== 'official/agent-lab');
    const needsSync = aggregateCodexTargets((['project', 'user'] as const).map((targetScope) => target({
      pluginName: 'agent-lab', platform: 'codex', scope: targetScope, state: 'partial',
    })))[0] as StatusV8CodexTarget;
    needsSync.components = [{ kind: 'sharedNative', key: 'agent-lab@aw-official', state: 'usable' }];
    for (const targetScope of ['project', 'user'] as const) {
      updatePlacement(needsSync, targetScope, {
        components: [
        { kind: 'intent', key: 'desired', state: 'desired', metadata: {
          enabled: true, scopes: ['project', 'user'], relation: 'root',
        } },
        { kind: 'ownership', key: 'fixture', state: 'partial' },
        { kind: 'activation', key: targetScope, state: 'disabled', metadata: {
          effective: false, evidence: 'observed',
        } },
        ],
        recoveryActions: [{
          command: 'sync',
          scope: targetScope,
          description: `同步${targetScope === 'user' ? '所有项目' : '当前项目'} desired intent`,
        }],
      });
    }
    loaded.payload.targets.push(needsSync);
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
    });
    await value.load();
    value.push({ name: 'platform', pluginId: 'official/agent-lab', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);

    const initial = instance.lastFrame() ?? '';
    expect(initial).toContain('Codex [当前项目]');
    expect(initial).toContain('Codex [所有项目]');
    expect(initial).toContain('待同步');
    expect(initial.split('\n').length).toBeLessThanOrEqual(18);

    if (scope === 'user') await input(instance, '\u001B[B');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain(`› ${scopeLabel} [选定]`);
    await focusAction(instance, `同步${scopeLabel}的使用位置`);
    await input(instance, '\r');
    await nextTurn(3);

    expect(captureEvidence).toHaveBeenCalledWith({
      kind: 'pluginWrite',
      action: 'sync',
      pluginId: 'official/agent-lab',
      platform: 'codex',
      scope,
    }, expect.any(AbortSignal));
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(instance.lastFrame()).toContain(`Codex · ${scopeLabel}`);
  });

  it('shows two real mixed-conflict recovery paths in issue and platform, then executes only the selected uninstall', async () => {
    const recovery = [
      {
        command: 'uninstall' as const,
        scope: 'user' as const,
        description: '运行 aw uninstall official/agent-lab --platform codex --scope user，再运行 aw sync official/agent-lab --platform codex --scope project。',
      },
      {
        command: 'uninstall' as const,
        scope: 'project' as const,
        description: '运行 aw uninstall official/agent-lab --platform codex --scope project，再运行 aw sync official/agent-lab --platform codex --scope user。',
      },
    ];
    const loaded = loadResult();
    loaded.pluginSummaries = [loaded.pluginSummaries[0]!];
    loaded.payload.catalog.sources = [loaded.payload.catalog.sources[0]!];
    const conflictTarget = mixedScopeConflictTarget('agent-lab');
    conflictTarget.recoveryActions = recovery;
    for (const conflictPlacement of conflictTarget.placements) conflictPlacement.components.push({
      kind: 'activation', key: conflictPlacement.scope, state: 'enabled',
      metadata: { effective: true, evidence: 'observed' },
    });
    loaded.payload.targets = [conflictTarget];
    const resolved = structuredClone(loaded);
    const resolvedTarget = resolved.payload.targets[0] as StatusV8CodexTarget;
    resolvedTarget.reasons = [];
    resolvedTarget.recoveryActions = [];
    updatePlacement(resolvedTarget, 'user', { state: 'absent', reasons: [], recoveryActions: [], components: [
      { kind: 'intent', key: 'desired', state: 'disabled', metadata: {
        enabled: false, scopes: ['project'], relation: 'none',
      } },
      { kind: 'activation', key: 'user', state: 'disabled', metadata: { effective: false, evidence: 'observed' } },
    ] });
    updatePlacement(resolvedTarget, 'project', { state: 'ready', reasons: [], recoveryActions: [], components: [
      { kind: 'intent', key: 'desired', state: 'desired', metadata: {
        enabled: true, scopes: ['project'], relation: 'root',
      } },
      { kind: 'ownership', key: 'fixture', state: 'present' },
      { kind: 'activation', key: 'project', state: 'enabled', metadata: { effective: true, evidence: 'observed' } },
      { kind: 'extension', key: 'aw', state: 'ready', metadata: { kinds: ['instruction'] } },
    ] });
    const loadStatus = vi.fn().mockResolvedValueOnce(loaded).mockResolvedValue(resolved);
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const executeIntent = vi.fn().mockResolvedValue({
      overallState: 'succeeded',
      targetResults: [{
        target: { pluginId: 'official/agent-lab', platform: 'codex', scope: 'user' },
        state: 'completed',
      }],
    });
    const value = controller({ loadStatus, captureEvidence, executeIntent });
    await value.load();
    const issue = value.listUserIssues().find((entry) => entry.category === 'scopeConflict')!;
    expect(issue).toBeDefined();
    value.push({ name: 'platform', pluginId: 'official/agent-lab', platform: 'codex' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('Codex [当前项目]');
    expect(instance.lastFrame()).toContain('Codex [所有项目]');
    expect(instance.lastFrame()).toContain('查看位置冲突问题');
    expect(instance.lastFrame()).not.toContain('重新安装…');
    expect(instance.lastFrame()).not.toContain('从所有项目移除…');
    expect(instance.lastFrame()).not.toContain('从当前项目移除…');

    await focusAction(instance, '查看位置冲突问题');
    await input(instance, '\r');
    await nextTurn(2);
    expect(value.snapshot.router.current.route).toEqual({ name: 'issueDetail', issueId: issue.issueId });
    expect(instance.lastFrame()).toContain('保留当前项目');
    expect(instance.lastFrame()).toContain('保留所有项目');
    await input(instance, '\r');
    await nextTurn(4);
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(instance.lastFrame()).toContain('后续：同步当前项目位置');
    expect(value.snapshot.activeReview?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: '完成此操作后，同步要保留的使用位置。' }),
    ]));
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      action: 'uninstall', pluginId: 'official/agent-lab', platform: 'codex', scope: 'user',
    }), expect.any(AbortSignal));

    await confirmReview(instance, value);
    await nextTurn(5);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(executeIntent.mock.calls[0]?.[0]).toMatchObject({ action: 'uninstall', scope: 'user' });
    expect(instance.lastFrame()).toContain('后续：同步当前项目位置');
  });

  it('opens a plugin config issue from detail and enters its correction flow', async () => {
    // Risk: config issues have no target scope and previously fell back to technical details.
    const loaded = loadResult();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      getConfigPage: vi.fn(async (pluginId, layer) => ({ ...configPage(pluginId), layer })),
    });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'team-tools/review-gate' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await focusAction(instance, '查看处理建议');
    expect(instance.lastFrame()).toContain('› 查看处理建议');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'issueDetail', issueId: 'config:team-tools/review-gate:required',
    });
    expect(instance.lastFrame()).toContain('完成设置');
    await input(instance, '\r');
    await nextTurn(3);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'configFields', pluginId: 'team-tools/review-gate', layer: { scope: 'effective' },
    });
  });

  it('uses the selected merged consumer as cleanup origin', async () => {
    // Risk: cleanup for the second consumer can otherwise verify the first consumer after success.
    const loaded = dependencyLoadResult();
    const rootIssueId = 'incompleteInstallation:official/skill-toolkit:codex:user';
    const consumers = (['consumer-a', 'consumer-b'] as const).map((pluginName, index) => {
      const value = target({
        pluginName, platform: 'codex', scope: index === 0 ? 'user' : 'project', state: 'present',
      });
      if (value.platform !== 'codex') throw new Error('Expected Codex fixture.');
      const entry = value.placements[0]!;
      entry.state = 'orphaned';
      entry.reasons = [{
        code: 'dependencyNotReady', message: 'safe dependency evidence', severity: 'warning',
        dependencyPluginId: 'official/skill-toolkit', dependencyPlatform: 'codex',
        dependencyScope: 'user', dependencyProject: null,
        rootIssueId, rootIssueCode: 'incompleteInstallation',
      }];
      entry.recoveryActions = [{
        command: 'cleanup', scope: entry.scope, description: `Clean ${pluginName}.`,
      }];
      value.state = 'orphaned';
      value.reasons = entry.reasons;
      value.recoveryActions = entry.recoveryActions;
      return value;
    });
    loaded.payload.targets = aggregateCodexTargets(consumers);
    loaded.pluginSummaries = [
      { pluginName: 'consumer-a', pluginId: 'official/consumer-a', description: 'A' },
      { pluginName: 'consumer-b', pluginId: 'official/consumer-b', description: 'B' },
      { pluginName: 'skill-toolkit', pluginId: 'official/skill-toolkit', description: 'Toolkit' },
    ];
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    const issue = value.listUserIssues().find((entry) => entry.issueId === rootIssueId)!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 40 }} />);
    await nextTurn(2);

    expect(issue.actions.filter((entry) => entry.id === 'cleanup').map((entry) => entry.pluginId))
      .toEqual(['official/consumer-a', 'official/consumer-b']);
    const secondCleanupIndex = issue.actions.findIndex((entry) =>
      entry.id === 'cleanup' && entry.pluginId === 'official/consumer-b');
    expect(secondCleanupIndex).toBeGreaterThan(0);
    for (let index = 0; index < secondCleanupIndex; index += 1) {
      await input(instance, '\u001B[B');
    }
    await input(instance, '\r');
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      action: 'cleanup', pluginId: 'official/consumer-b', platform: 'codex', scope: 'project',
      originIssue: expect.objectContaining({
        consumerPluginId: 'official/consumer-b', consumerSourceIdentity: 'identity:official',
        consumerPlatform: 'codex', consumerScope: 'project',
      }),
    }), expect.any(AbortSignal));
  });

  it('completes cleanup for the selected target while its source issue remains', async () => {
    // Risk: the surviving source root can make a completed target cleanup look failed.
    const loaded = loadResult();
    const offlineTargets = (['user', 'project'] as const).map((scope) => target({
      pluginName: `offline-${scope}`,
      sourceId: 'team-tools',
      platform: 'codex',
      scope,
      state: 'error',
      errorCode: 'catalogSourceUnavailable',
      recoveryActions: [{
        command: 'cleanup', scope, description: `Clean ${scope} target.`,
      }],
    }));
    loaded.payload.targets = aggregateCodexTargets(offlineTargets);
    loaded.pluginSummaries = offlineTargets.map((entry) => ({
      pluginName: entry.pluginName,
      pluginId: entry.pluginId,
      description: entry.pluginName,
    }));
    loaded.payload.catalog.sources = loaded.payload.catalog.sources.map((entry) =>
      entry.id === 'team-tools'
        ? { ...entry, error: 'unavailable', errorCode: 'catalogSourceUnavailable', freshness: undefined }
        : entry);
    const after = structuredClone(loaded);
    after.payload.targets = after.payload.targets.filter((entry) =>
      entry.pluginId !== 'team-tools/offline-project');
    const captureEvidence = vi.fn().mockResolvedValue(evidence);
    const value = controller({
      loadStatus: vi.fn().mockResolvedValueOnce(loaded).mockResolvedValue(after),
      captureEvidence,
      executeIntent: vi.fn().mockResolvedValue({
        overallState: 'succeeded',
        targetResults: [{
          target: {
            pluginId: 'team-tools/offline-project', platform: 'codex', scope: 'project',
          },
          action: 'cleanup',
          state: 'completed',
        }],
      }),
    });
    await value.load();
    const issue = value.listUserIssues().find((entry) =>
      entry.issueId === 'source:team-tools:unavailable')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 40 }} />);
    await nextTurn(2);

    const projectCleanupIndex = issue.actions.findIndex((entry) =>
      entry.id === 'cleanup' && entry.pluginId === 'team-tools/offline-project');
    expect(projectCleanupIndex).toBeGreaterThan(0);
    for (let index = 0; index < projectCleanupIndex; index += 1) {
      await input(instance, '\u001B[B');
    }
    await input(instance, '\r');

    expect(value.snapshot.router.current.route).toMatchObject({ name: 'review' });
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      action: 'cleanup', pluginId: 'team-tools/offline-project', platform: 'codex', scope: 'project',
      originIssue: expect.objectContaining({
        issueId: issue.issueId, actionId: 'cleanup',
        consumerPluginId: 'team-tools/offline-project',
        consumerSourceIdentity: 'identity:team-tools',
        consumerPlatform: 'codex', consumerScope: 'project',
      }),
    }), expect.any(AbortSignal));
    await confirmReview(instance, value);
    await nextTurn(4);

    expect(value.snapshot.result).toMatchObject({ state: 'succeeded' });
    expect(value.snapshot.result).not.toHaveProperty('code', 'issueStillPresent');
    expect(value.listUserIssues()).toContainEqual(expect.objectContaining({
      issueId: issue.issueId,
      affectedTargets: [expect.objectContaining({
        pluginId: 'team-tools/offline-user', platform: 'codex', scope: 'user',
      })],
    }));
  });

  it('keeps current dependency evidence visible when the exact dependency scope has no issue', async () => {
    // Risk: project evidence must not replace a missing user dependency issue target.
    const loaded = dependencyLoadResult({ rootState: 'error', rootErrorCode: 'dependencyNotReady' });
    const root = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/agent-lab' && entry.platform === 'codex')!;
    placement(root, 'project').components.push({
      kind: 'intent', key: 'desired', state: 'desired',
      metadata: { enabled: true, scopes: ['project'], relation: 'root' },
    });
    updatePlacement(root, 'project', {
      state: 'needsSync',
      reasons: [{
        code: 'dependencyNotReady', message: 'safe dependency evidence', severity: 'warning',
        dependencyPluginId: 'official/skill-toolkit', dependencyPlatform: 'codex',
        dependencyScope: 'user', dependencyProject: null,
      }],
      recoveryActions: [{ command: 'sync', scope: 'project', description: '同步完整依赖计划。' }],
    });
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const issue = value.listUserIssues().find((entry) =>
      entry.category === 'dependencyNotReady' && entry.platform === 'codex' && entry.scope === 'project')!;
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(2);

    await input(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'issueDetail', issueId: issue.issueId });
    expect(instance.lastFrame()).toContain('dependencyNotReady');
    expect(instance.lastFrame()).toContain('查看依赖插件问题');
  });

  // Review repair: real Ink entry points protect complete safe reading and first-screen decisions.
  it.each([[60, 18], [80, 24]] as const)('review repair reads every issue field segment safely at %ix%i', async (columns, rows) => {
    const value = controller();
    await value.load();
    const issue = structuredClone(value.listUserIssues()[0]!);
    const requestedRef = `release/${Array.from({ length: 24 }, (_, index) => `r${String(index).padStart(2, '0')}-`).join('')}END_SENTINEL`;
    issue.diagnostic.technical = {
      code: 'fixtureFailure', requestedRef,
      context: [{ key: 'field', value: 'token=ISSUE_SECRET /private/fixture/hidden.txt' }],
      sanitizedCause: 'Error: git stderr RAW_CAUSE_SECRET /private/fixture/cause',
      checks: ['git stderr: fatal: RAW_CHECK_SECRET /private/fixture/check'],
    };
    vi.spyOn(value, 'listUserIssues').mockReturnValue([issue]);
    value.push({ name: 'issueDetail', issueId: issue.issueId });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(3);
    const action = issue.actions.find((entry) => entry.id === 'viewTechnical')!;
    await focusAction(instance, action.label);
    await input(instance, '\r');
    const trace: AcceptanceTraceStep[] = [];
    const chunks = new Set<string>();
    for (let index = 0; index < 30; index += 1) {
      const frame = instance.lastFrame() ?? '';
      trace.push(acceptanceTraceStep(instance, { columns, rows }, `issue page ${index}`, []));
      expect(frame).not.toContain('ISSUE_SECRET');
      expect(frame).not.toContain('/private/fixture');
      expect(frame).not.toMatch(/RAW_CAUSE_SECRET|RAW_CHECK_SECRET|Error:|git stderr|fatal:/u);
      for (const match of frame.matchAll(/requested ref: ([^\n]+)/gu)) chunks.add(match[1]!.replace(/\s*│$/u, '').trim());
      const page = frame.match(/← 上一页\s+(\d+) \/ (\d+)/u);
      expect(page).toBeTruthy();
      if (page?.[1] === page?.[2]) break;
      await input(instance, '\u001B[6~');
    }
    await writeAcceptanceTrace(`review-repair/issue-${columns}x${rows}`, trace);
    expect([...chunks].join('')).toBe(requestedRef);
    await input(instance, ...Array.from({ length: 30 }, () => '\u001B[5~'));
    expect(instance.lastFrame()).toContain('code: fixtureFailure');
  });

  it.each([
    ['portableBlocker', 60, 18], ['portableBlocker', 80, 24],
    ['configUnavailable', 60, 18], ['configUnavailable', 80, 24],
  ] as const)('review repair reads wrapped codes in %s at %ix%i', async (name, columns, rows) => {
    const value = controller();
    await value.load();
    const diagnosticCode = `fixture${Array.from({ length: 18 }, (_, index) => `_${index}`).join('')}_END`;
    value.push(name === 'portableBlocker' ? {
      name, pluginId: 'official/agent-lab', code: 'portableValidationFailed', diagnosticCode,
    } : {
      name, pluginId: 'official/agent-lab', diagnosticCode, diagnosticStage: 'read-config',
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(3);
    await input(instance, 'd');
    const first = instance.lastFrame();
    const chunks = new Set<string>();
    const trace: AcceptanceTraceStep[] = [];
    for (let index = 0; index < 20; index += 1) {
      const frame = instance.lastFrame() ?? '';
      trace.push(acceptanceTraceStep(instance, { columns, rows }, `page ${index}`, []));
      for (const match of frame.matchAll(/code: ([^\n]+)/gu)) chunks.add(match[1]!.replace(/\s*│$/u, '').trim());
      const page = frame.match(/← 上一页\s+(\d+) \/ (\d+)/u);
      expect(page).toBeTruthy();
      if (page?.[1] === page?.[2]) break;
      await input(instance, '\u001B[6~');
    }
    expect([...chunks].join('')).toBe(diagnosticCode);
    await input(instance, ...Array.from({ length: 20 }, () => '\u001B[5~'));
    expect(instance.lastFrame()).toBe(first);
    await input(instance, 'd');
    expect(instance.lastFrame()).toContain(name === 'portableBlocker'
      ? '修复来源内容或修改选择，然后重新检查。' : '查看技术详情，确认字段定义不可用的原因。');
    await writeAcceptanceTrace(`review-repair/${name}-${columns}x${rows}`, trace);
  });
});
