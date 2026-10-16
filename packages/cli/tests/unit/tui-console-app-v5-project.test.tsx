import path from 'node:path';

import fs from 'fs-extra';
import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  StatusV8Target,
} from '../../src/commands/status-v6.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { createCliExecutionContext } from '../../src/commands/runtime.js';
import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import {
  createTuiControllerDependencies,
} from '../../src/tui/controller-runtime.js';
import {
  ConsoleAppV4,
  type ConsoleV4ScreenId,
} from '../../src/tui/console-app-v4.js';
import {
  TuiController,
  type OperationIntent,
  type PluginWriteBatchExecutionResult,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';
import { copyToClipboard } from '../../src/tui/clipboard.js';
import { SessionConsoleApp } from '../../src/tui/session-console-app.js';
import { SessionHost } from '../../src/tui/session-host.js';
import { createCatalogManifestV7Entry } from '../../src/utils/catalog-manifest-v7.js';
import {
  readCatalogSourcesConfigSnapshot,
  replaceCatalogSourcesConfig,
} from '../../src/utils/catalog-sources.js';
import { syncCatalogSourceGeneration } from '../../src/utils/catalog-generation-service.js';
import { readPluginManifest } from '../../src/utils/manifest.js';
import {
  createEmptyPluginIntentState,
  readPluginIntentState,
  upsertPluginIntentRoot,
  writePluginIntentState,
} from '../../src/utils/plugin-intent-state.js';
import { createCatalogSnapshotFixture } from '../helpers/catalog-source-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

vi.mock('../../src/tui/clipboard.js', () => ({ copyToClipboard: vi.fn() }));

import {
  batchEvidenceForIntent,
  controller,
  deferred,
  dependencyLoadResult,
  evidence,
  evidenceForIntent,
  loadResult,
  placement,
  target,
  updatePlacement,
} from '../helpers/tui-console-app-fixture.js';

import {
  acceptanceTraceStep,
  escape,
  focusAction,
  focusBottomAction,
  input,
  nextTurn,
  writeAcceptanceTrace,
} from '../helpers/tui-console-app-input.js';

afterEach(() => cleanup());

function projectIntentTarget(options: {
  pluginName: string;
  platform?: 'codex' | 'claude';
  state: 'ready' | 'needsSync' | 'blocked' | 'unobserved';
}): StatusV8Target {
  const value = target({
    pluginName: options.pluginName,
    platform: options.platform ?? 'claude',
    scope: 'project',
    state: options.state === 'ready' ? 'present' : 'absent',
  });
  const current = placement(value, 'project');
  current.components.push({
    kind: 'intent',
    key: 'desired',
    state: 'desired',
    metadata: { enabled: true, scopes: ['project'], relation: 'root' },
  });
  if (options.state !== 'ready') {
    current.state = options.state === 'blocked' ? 'blocked' : 'needsSync';
  }
  if (options.state === 'blocked') {
    current.reasons = [{
      code: 'catalogSourceUnavailable',
      message: '来源当前不可用。',
      severity: 'blocking',
    }];
  }
  if (options.state === 'unobserved' && value.platform === 'codex') {
    value.components.push({
      kind: 'sharedNative',
      key: `${options.pluginName}@aw-official`,
      state: 'unobserved',
    });
    current.components.push({
      kind: 'activation',
      key: 'project',
      state: 'unknown',
      metadata: { evidence: 'unobserved' },
    });
    value.reasons = [{
      code: 'codexSharedNativeUnobserved',
      message: '未取得兼容 Codex 状态。',
      severity: 'warning',
    }];
  }
  if (value.platform === 'codex') value.state = current.state;
  return value;
}

function projectStatusLoadResult(targets: StatusV8Target[]): TuiStatusLoadResult {
  const initial = loadResult();
  initial.projectRoot = '/workspace';
  initial.projectIntentRoots = targets.map((entry) => ({
    pluginId: entry.pluginId,
    platforms: [entry.platform],
  }));
  initial.projectIntent = { state: 'ready', roots: initial.projectIntentRoots };
  initial.payload.targets = targets;
  initial.pluginSummaries = targets.map((entry) => ({
    pluginName: entry.pluginName,
    pluginId: entry.pluginId,
    displayName: entry.pluginName,
    description: '项目插件',
    version: entry.version,
    supportedTargets: entry.platform === 'codex'
      ? { codex: ['project'], claude: [] }
      : { codex: [], claude: ['project'] },
    configFieldCount: 0,
  }));
  return initial;
}

function projectReminderLoadResult(options: {
  blocked?: boolean;
  unobservedOnly?: boolean;
} = {}): TuiStatusLoadResult {
  return projectStatusLoadResult(options.unobservedOnly
    ? [projectIntentTarget({ pluginName: 'review-gate', platform: 'codex', state: 'unobserved' })]
    : [
        projectIntentTarget({ pluginName: 'agent-lab', state: 'needsSync' }),
        projectIntentTarget({ pluginName: 'review-gate', state: 'ready' }),
        ...(options.blocked
          ? [projectIntentTarget({ pluginName: 'source-blocked', state: 'blocked' })]
          : []),
      ]);
}

describe('ConsoleAppV4', () => {
  it.each([[80, 24], [60, 18]] as const)(
    'opens the project reminder with Later focused and keeps the banner at %ix%i',
    async (columns, rows) => {
      const loaded = projectReminderLoadResult({ blocked: true });
      const captureEvidence = vi.fn(async (intent: OperationIntent) =>
        intent.kind === 'pluginWriteBatch' ? batchEvidenceForIntent(intent) : evidenceForIntent(intent));
      const value = controller({
        loadStatus: vi.fn().mockResolvedValue(loaded),
        captureEvidence,
      });
      await value.load();
      const claim = vi.fn(() => true);
      const instance = render(<ConsoleAppV4
        controller={value}
        size={{ columns, rows }}
        onClaimProjectIntentReminder={claim}
      />);
      await vi.waitFor(() =>
        expect(instance.lastFrame()).toContain('本项目有 2 个插件尚未就绪'));

      const modal = instance.lastFrame() ?? '';
      expect(modal).toContain('AW / 首页');
      expect(modal).toContain('1 个位置可同步；1 个位置需要先处理');
      expect(modal).toContain('› 稍后处理');
      expect(modal.match(/›/g)).toHaveLength(1);
      expect(modal).toContain('Esc 稍后处理');
      expect(Math.max(...modal.split('\n').map(stringWidth))).toBeLessThanOrEqual(columns);
      expect(modal.split('\n').length).toBeLessThanOrEqual(rows);

      await input(instance, columns === 60 ? '\u001B' : '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).not.toContain('› 稍后处理'));
      expect(instance.lastFrame()).toContain('待同步');
      expect(captureEvidence).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['q', false],
    ['\u0003', true],
  ] as const)('routes %s from a %s project reminder through the safe exit guard', async (key, blockedOnly) => {
    const loaded = projectReminderLoadResult({ blocked: true });
    if (blockedOnly) {
      loaded.payload.targets = loaded.payload.targets.map((target) => target.state === 'needsSync'
        ? { ...target, state: 'blocked' as const, reasons: [{ code: 'sourceUnavailable', message: 'blocked', severity: 'blocking' as const }] }
        : target);
    }
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 60, rows: 18 }}
      onClaimProjectIntentReminder={() => true}
    />);
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('本项目有 2 个插件尚未就绪'));

    await input(instance, key);
    expect(instance.lastFrame()).toContain('退出控制台？');
    expect(instance.lastFrame()).not.toContain('本项目有 2 个插件尚未就绪');
    expect(value.dependencies.captureEvidence).not.toHaveBeenCalled();
  });

  it.each([[60, 18], [80, 24]] as const)(
    'keeps a project declaration issue reachable with healthy home actions at %ix%i',
    async (columns, rows) => {
      const loaded = loadResult();
      loaded.projectRoot = '/workspace';
      loaded.projectIntent = {
        state: 'invalid', code: 'pluginIntentInvalid', message: '声明格式无效。',
      };
      const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
      await value.load();
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);

      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('项目声明需要检查');
      expect(frame).toContain('插件');
      let homeFrames = frame;
      for (let index = 0; index < 4; index += 1) {
        await input(instance, '\u001B[B');
        homeFrames += instance.lastFrame() ?? '';
      }
      expect(homeFrames).toContain('插件来源');
      await focusAction(instance, '项目插件');
      await input(instance, '\r');
      expect(value.snapshot.router.current.route.name).toBe('projectStatus');
      expect(instance.lastFrame()).toContain('项目声明需要检查');
      await input(instance, 'd');
      expect(instance.lastFrame()).toContain('pluginIntentInvalid');
      expect(instance.lastFrame()).toContain('声明格式无效');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    },
  );

  it('connects the home reminder through SessionHost to an exact project Review', async () => {
    const loaded = projectReminderLoadResult({ blocked: true });
    const captureEvidence = vi.fn(async (intent: OperationIntent) =>
      intent.kind === 'pluginWriteBatch' ? batchEvidenceForIntent(intent) : evidenceForIntent(intent));
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
    });
    const host = new SessionHost({
      createSession: () => ({ controller: value, progressFeed: createRebuildProgressFeed() }),
    });
    const instance = render(<SessionConsoleApp host={host} />);
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('› 稍后处理'));

    await input(instance, '\u001B[B', '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWriteBatch',
      action: 'sync',
      scope: 'project',
      selection: {
        kind: 'currentProjectIntentTargets',
        targets: [{
          pluginId: 'official/agent-lab',
          platform: 'claude',
          scope: 'project',
        }],
      },
    }), expect.any(AbortSignal));
    expect(value.snapshot.activeReview?.batch).toMatchObject({
      requestedPluginIds: ['official/agent-lab'],
      executableGroupCount: 1,
    });
  });

  it.each([[60, 18], [80, 24]] as const)(
    'pages every exact project sync target and keeps the source boundary visible at %ix%i',
    async (columns, rows) => {
      const targets = [
        { pluginId: 'official/agent-lab', platform: 'claude' as const, scope: 'project' as const },
        { pluginId: 'official/content-toolkit', platform: 'claude' as const, scope: 'project' as const },
      ];
      const intent = {
        kind: 'pluginWriteBatch' as const,
        action: 'sync' as const,
        selection: { kind: 'currentProjectIntentTargets' as const, targets },
        platform: 'claude' as const,
        scope: 'project' as const,
      };
      const executionPending = new Promise<never>(() => {});
      const value = controller({
        captureEvidence: vi.fn().mockResolvedValue(batchEvidenceForIntent(intent)),
        executeIntent: vi.fn(() => executionPending),
      });
      await value.load();
      await value.buildOperationReview(intent);
      expect(value.snapshot.activeReview?.requiresConfirmation).toBe(false);
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(3);

      let reviewFrames = instance.lastFrame() ?? '';
      for (let page = 0; page < 4 && !reviewFrames.includes('content-toolkit'); page += 1) {
        await input(instance, '\u001B[C');
        reviewFrames += `\n${instance.lastFrame() ?? ''}`;
      }
      expect(reviewFrames).toContain('agent-lab');
      expect(reviewFrames).toContain('content-toolkit');
      expect(reviewFrames).toContain('Claude Code');
      expect(reviewFrames).toContain('当前项目');

      await focusAction(instance, '批量同步插件 2 个插件');
      await input(instance, '\r');
      await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('progress'));
      expect(instance.lastFrame()).toContain('不会自动升级插件来源');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
    },
  );

  it.each([[60, 18], [80, 24]] as const)(
    'requires a second confirmation only for an exact project sync with preApply at %ix%i',
    async (columns, rows) => {
      const target = {
        pluginId: 'official/agent-lab', platform: 'claude' as const, scope: 'project' as const,
      };
      const intent = {
        kind: 'pluginWriteBatch' as const,
        action: 'sync' as const,
        selection: { kind: 'currentProjectIntentTargets' as const, targets: [target] },
        platform: 'claude' as const,
        scope: 'project' as const,
      };
      const reviewEvidence = batchEvidenceForIntent(intent);
      reviewEvidence.groups[0]!.preview.operationPlan = createOperationPlan({
        intentChanges: [], changes: ['project intent sync'], warnings: [],
        actions: [{
          kind: 'runPreApply', pluginId: target.pluginId, platform: target.platform,
          scope: target.scope, script: './scripts/pre-apply.mjs', scriptDigest: 'sha256:script',
        }],
        evidence: { catalogDigests: [], intentDigests: [], configDigests: [], targetOwnerFingerprints: [] },
      });
      const captureEvidence = vi.fn().mockResolvedValue(reviewEvidence);
      const executeIntent = vi.fn(() => new Promise<never>(() => {}));
      const value = controller({ captureEvidence, executeIntent });
      await value.load();
      await value.buildOperationReview(intent);
      expect(value.snapshot.activeReview?.requiresConfirmation).toBe(true);
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(3);

      const reviewFrame = instance.lastFrame() ?? '';
      expect(reviewFrame).toContain('1 个当前项目同步目标将运行 preApply');
      expect(reviewFrame).toContain('需要确认当前项目同步脚本');
      await focusAction(instance, '批量同步插件 1 个插件');
      await input(instance, '\r');
      expect(instance.lastFrame()).toContain('返回检查');
      let confirmationFrames = instance.lastFrame() ?? '';
      for (let page = 0; page < 4 && !confirmationFrames.includes('当前项目位置'); page += 1) {
        await input(instance, '\u001B[C');
        confirmationFrames += `\n${instance.lastFrame() ?? ''}`;
      }
      expect(confirmationFrames).toContain('范围只限本次确认的');
      expect(confirmationFrames).toContain('当前项目位置');
      expect(executeIntent).not.toHaveBeenCalled();

      await focusAction(instance, '返回检查');
      await input(instance, '\r');
      expect(executeIntent).not.toHaveBeenCalled();
      await focusAction(instance, '批量同步插件 1 个插件');
      await input(instance, '\r', '\u001B[B', '\r');
      await vi.waitFor(() => expect(executeIntent).toHaveBeenCalledOnce());
      expect(captureEvidence).toHaveBeenCalledOnce();
      expect(executeIntent).toHaveBeenCalledWith(intent, reviewEvidence);
    },
  );

  it('keeps a partial project result, cancels pending H, and retries with project evidence', async () => {
    const loaded = projectReminderLoadResult({ blocked: true });
    const second = projectIntentTarget({ pluginName: 'content-toolkit', state: 'needsSync' });
    loaded.payload.targets.push(second);
    loaded.pluginSummaries.push({
      pluginName: second.pluginName,
      pluginId: second.pluginId,
      displayName: second.pluginName,
      description: '项目插件',
      version: second.version,
      supportedTargets: { codex: [], claude: ['project'] },
      configFieldCount: 0,
    });
    loaded.projectIntentRoots!.push({
      pluginId: second.pluginId,
      platforms: [second.platform],
    });
    const executionPending = deferred<PluginWriteBatchExecutionResult>();
    const captureEvidence = vi.fn(async (intent: OperationIntent) =>
      intent.kind === 'pluginWriteBatch' ? batchEvidenceForIntent(intent) : evidenceForIntent(intent));
    const first = controller({
      loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence,
      executeIntent: vi.fn(() => executionPending.promise),
    });
    const reloaded = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    const createSession = vi.fn()
      .mockReturnValueOnce({ controller: first, progressFeed: createRebuildProgressFeed() })
      .mockReturnValueOnce({ controller: reloaded, progressFeed: createRebuildProgressFeed() });
    const host = new SessionHost({ createSession });
    const instance = render(<SessionConsoleApp host={host} />);
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('2 个位置可同步；1 个位置需要先处理'));
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('› 稍后处理'));

    await input(instance, '\u001B[B', '\r');
    await vi.waitFor(() => expect(first.snapshot.router.current.route.name).toBe('review'));
    await input(instance, '\r');
    if (first.snapshot.router.current.route.name === 'review') {
      await input(instance, '\u001B[B', '\r');
    }
    await vi.waitFor(() => expect(first.hasActiveWrite).toBe(true));
    await input(instance, 'H');
    expect(host.snapshot.pendingNavigation).toBe('reload');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('已安排完成后重载'));

    const requestedTargets = [
      { pluginId: 'official/agent-lab', platform: 'claude' as const, scope: 'project' as const },
      { pluginId: 'official/content-toolkit', platform: 'claude' as const, scope: 'project' as const },
    ];
    const targetResults = requestedTargets.map((target, index) => ({
      target: {
        ...target,
        pluginName: target.pluginId.split('/').at(-1)!,
        sourceId: 'official',
      },
      action: 'sync',
      state: index === 0 ? 'completed' as const : 'failed' as const,
      requiredBy: [],
      ...(index === 0 ? {} : { errorCode: 'preApplyExited' }),
    }));
    const groupResult = {
      platforms: ['claude'],
      plugins: [],
      warnings: [],
      rebuildResults: [],
      targetResults,
      overallState: 'partial',
      receiptTargets: [],
    } as unknown as PluginWriteBatchExecutionResult['groupResults'][number]['result'];
    executionPending.resolve({
      ...groupResult,
      requestedPluginIds: requestedTargets.map((target) => target.pluginId),
      groupResults: [{
        groupId: 'official\0claude\0project',
        sourceId: 'official',
        platform: 'claude',
        scope: 'project',
        requestedPluginIds: requestedTargets.map((target) => target.pluginId),
        result: groupResult,
      }],
    });
    await vi.waitFor(() => expect(first.snapshot.result?.state).toBe('partial'));

    expect(host.snapshot.pendingNavigation).toBeUndefined();
    expect(host.snapshot.epoch).toBe(1);
    expect(instance.lastFrame()).toContain('仅重试失败目标');
    await focusAction(instance, '仅重试失败目标');
    await input(instance, '\r');
    await vi.waitFor(() => expect(first.snapshot.router.current.route.name).toBe('review'));
    const retryIntent = captureEvidence.mock.calls.at(-1)?.[0];
    expect(retryIntent).toMatchObject({
      kind: 'pluginWriteBatch',
      selection: {
        kind: 'currentProjectIntentTargets',
        targets: [{
          pluginId: 'official/content-toolkit',
          platform: 'claude',
          scope: 'project',
        }],
      },
    });

    await input(instance, 'H');
    await vi.waitFor(() => expect(host.snapshot.epoch).toBe(2));
    await vi.waitFor(() => expect(reloaded.snapshot.phase).toBe('ready'));
    await vi.waitFor(() =>
      expect(instance.lastFrame()).toContain('待同步'));
    expect(instance.lastFrame()).not.toContain('稍后处理');
  });

  it('keeps unobserved project targets out of the missing reminder', async () => {
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(projectReminderLoadResult({ unobservedOnly: true })),
    });
    await value.load();
    const claim = vi.fn(() => true);
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onClaimProjectIntentReminder={claim}
    />);
    await nextTurn(3);

    expect(instance.lastFrame()).toContain('未确认');
    expect(instance.lastFrame()).not.toContain('插件尚未就绪');
    expect(claim).not.toHaveBeenCalled();
  });

  it.each([[80, 24], [60, 18]] as const)(
    'shows actionable, blocked, and unknown project targets before syncing at %ix%i',
    async (columns, rows) => {
      const loaded = projectStatusLoadResult([
        projectIntentTarget({ pluginName: 'agent-lab', state: 'needsSync' }),
        projectIntentTarget({ pluginName: 'source-blocked', state: 'blocked' }),
        projectIntentTarget({ pluginName: 'review-gate', platform: 'codex', state: 'unobserved' }),
      ]);
      const captureEvidence = vi.fn(async (intent: OperationIntent) =>
        intent.kind === 'pluginWriteBatch' ? batchEvidenceForIntent(intent) : evidenceForIntent(intent));
      const executeIntent = vi.fn();
      const value = controller({
        loadStatus: vi.fn().mockResolvedValue(loaded),
        captureEvidence,
        executeIntent,
      });
      await value.load();
      const screens = new Set<ConsoleV4ScreenId>();
      const instance = render(<ConsoleAppV4
        controller={value}
        size={{ columns, rows }}
        onClaimProjectIntentReminder={() => true}
        onScreenChange={(screen) => screens.add(screen)}
      />);
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('› 稍后处理'));

      await input(instance, '\u001B[B', '\u001B[B', '\r');
      expect(value.snapshot.router.current.route.name).toBe('projectStatus');
      expect(screens).toContain('T02');
      let pages = instance.lastFrame() ?? '';
      for (let index = 0; index < 3; index += 1) {
        await input(instance, '\u001B[B');
        pages += `\n${instance.lastFrame() ?? ''}`;
      }
      for (const text of [
        'agent-lab', 'source-blocked', 'review-gate',
        '待同步', '受阻', '未确认', 'official', '当前项目',
      ]) expect(pages).toContain(text);
      expect(value.snapshot.projectInventory?.counts).toMatchObject({ pending: 1, blocked: 1, unknown: 1 });
      expect(Math.max(...(instance.lastFrame() ?? '').split('\n').map(stringWidth))).toBeLessThanOrEqual(columns);
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);

      await focusBottomAction(instance, '同步全部可处理声明（1） [c]');
      await input(instance, '\r');
      await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
      expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'pluginWriteBatch',
        selection: {
          kind: 'currentProjectIntentTargets',
          targets: [{ pluginId: 'official/agent-lab', platform: 'claude', scope: 'project' }],
        },
      }), expect.any(AbortSignal));
      expect(executeIntent).not.toHaveBeenCalled();
    },
  );

  it.each([[80, 24], [60, 18]] as const)(
    'keeps a blocked-only project status out of empty sync at %ix%i',
    async (columns, rows) => {
      const loaded = projectStatusLoadResult([
        projectIntentTarget({ pluginName: 'source-blocked', state: 'blocked' }),
      ]);
      const executeIntent = vi.fn();
      const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), executeIntent });
      await value.load();
      const instance = render(<ConsoleAppV4
        controller={value}
        size={{ columns, rows }}
        onClaimProjectIntentReminder={() => true}
      />);
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('› 稍后处理'));

      await input(instance, '\u001B[B', '\r');
      expect(value.snapshot.router.current.route.name).toBe('projectStatus');
      expect(instance.lastFrame()).toContain('受阻');
      expect(instance.lastFrame()).not.toContain('同步明确的');
      await focusBottomAction(instance, '查看对应问题');
      await input(instance, '\r');
      expect(value.snapshot.router.current.route.name).toBe('issueDetail');
      expect(executeIntent).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['catalogSourceUnavailable', 'sourceDetail'],
    ['sourceMissing', 'sourceDetail'],
    ['bundleUnavailable', 'sourceDetail'],
    ['codexIntentSourceUnavailable', 'sourceDetail'],
    ['sourceChanged', 'sourceDetail'],
    ['awCapabilityUnsupported', 'pluginDetail'],
    ['codexExtensionScopeConflict', 'pluginDetail'],
    ['artifactCollision', 'pluginDetail'],
    ['codexSharedNativeForeign', 'pluginDetail'],
    ['unknownBlocker', 'pluginDetail'],
  ].flatMap(([code, destination]) => [
    { code: code!, destination, columns: 80, rows: 24 },
    { code: code!, destination, columns: 60, rows: 18 },
  ]))('opens the matching recovery for project blocker $code at $columns x $rows', async ({ code, destination, columns, rows }) => {
    const blocked = projectIntentTarget({ pluginName: 'blocked-plugin', state: 'blocked' });
    placement(blocked, 'project').reasons = [{ code, message: '目标需要处理。', severity: 'blocking' }];
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(projectStatusLoadResult([blocked])), executeIntent,
    });
    await value.load();
    value.push({ name: 'projectStatus' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await nextTurn(2);

    expect(instance.lastFrame()).toContain('blocked-plugin');
    expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(rows);
    expect(Math.max(...(instance.lastFrame() ?? '').split('\n').map(stringWidth))).toBeLessThanOrEqual(columns);
    expect(instance.lastFrame()).toContain('总体状态 [! 受阻]');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/blocked-plugin' });
    expect(instance.lastFrame()).not.toContain('项目共享插件');
    await escape(instance);
    expect(value.snapshot.router.current.route.name).toBe('projectStatus');
    expect(instance.lastFrame()).toContain('blocked-plugin');
    await focusBottomAction(instance, '错误详情');
    await input(instance, '\r');
    expect(instance.lastFrame()).toContain('项目状态安全详情');
    expect(instance.lastFrame()).toContain(code);
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('opens source management for a project target whose source was removed', async () => {
    const blocked = projectIntentTarget({ pluginName: 'blocked-plugin', state: 'blocked' });
    placement(blocked, 'project').reasons = [{
      code: 'sourceMissing', message: '来源已移除。', severity: 'blocking',
    }];
    const loaded = projectStatusLoadResult([blocked]);
    loaded.payload.catalog.sources = [];
    const executeIntent = vi.fn();
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded), executeIntent });
    await value.load();
    value.push({ name: 'projectStatus' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('受阻');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('pluginDetail');
    await focusAction(instance, '查看处理建议');
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('issueDetail');
    expect(instance.lastFrame()).toContain('来源');
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it('keeps a blocked project target readable when its plugin detail is unavailable', async () => {
    const blocked = projectIntentTarget({ pluginName: 'blocked-plugin', state: 'blocked' });
    placement(blocked, 'project').reasons = [{
      code: 'artifactCollision', message: '目标需要处理。', severity: 'blocking',
    }];
    const executeIntent = vi.fn();
    const value = controller({
      loadStatus: vi.fn().mockResolvedValue(projectStatusLoadResult([blocked])), executeIntent,
    });
    await value.load();
    vi.spyOn(value, 'getPluginOverview').mockReturnValue(undefined);
    value.push({ name: 'projectStatus' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await nextTurn(2);
    await input(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('pluginDetail');
    expect(instance.lastFrame()).toContain('[项目声明]');
    expect(instance.lastFrame()).toContain('受阻');
    expect(instance.lastFrame()).toContain('查看处理建议');
    expect(instance.lastFrame()).not.toContain('期望 0.4.2');
    expect(executeIntent).not.toHaveBeenCalled();
  });

  it.each([[80, 24], [60, 18]] as const)(
    'copies complete project diagnoses without viewport line breaks at %ix%i',
    async (columns, rows) => {
      const clipboard = vi.mocked(copyToClipboard).mockReset().mockResolvedValue(undefined);
      const pluginName = `unknown-${'long-plugin-name-'.repeat(6)}END`;
      const target = projectIntentTarget({ pluginName, platform: 'codex', state: 'unobserved' });
      const value = controller({
        loadStatus: vi.fn().mockResolvedValue(projectStatusLoadResult([target])),
      });
      await value.load();
      value.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(3);
      await input(instance, 'd');
      expect(instance.lastFrame()).toContain('项目状态安全详情');
      await input(instance, 'y');
      await vi.waitFor(() => expect(clipboard).toHaveBeenCalledTimes(1));
      const copied = clipboard.mock.calls[0]![0];
      expect(copied).toContain(`${target.pluginId} · Codex · 当前项目`);
      expect(copied).toContain('原因 · codexSharedNativeUnobserved');
      await input(instance, '\u001B[C', 'y');
      await vi.waitFor(() => expect(clipboard).toHaveBeenCalledTimes(2));
      expect(clipboard.mock.calls[1]![0]).toBe(copied);
      value.dispose();
    },
  );

  it.each([[80, 24], [60, 18]] as const)(
    'keeps unknown project targets read-only and pages the final diagnosis at %ix%i',
    async (columns, rows) => {
      const targets = Array.from({ length: 10 }, (_, index) => {
        const target = projectIntentTarget({
          pluginName: `unknown-${String(index + 1).padStart(2, '0')}`,
          platform: 'codex',
          state: 'unobserved',
        });
        target.reasons = [{
          code: `unknownReason${String(index + 1).padStart(2, '0')}`,
          message: '平台状态未确认。',
          severity: 'warning',
        }];
        placement(target, 'project').reasons = [...target.reasons];
        return target;
      });
      const executeIntent = vi.fn();
      const onSessionNavigation = vi.fn(async () => 'completed' as const);
      const value = controller({
        loadStatus: vi.fn().mockResolvedValue(projectStatusLoadResult(targets)),
        executeIntent,
      });
      await value.load();
      const screens = new Set<ConsoleV4ScreenId>();
      const instance = render(<ConsoleAppV4
        controller={value}
        size={{ columns, rows }}
        onSessionNavigation={onSessionNavigation}
        onScreenChange={(screen) => screens.add(screen)}
      />);
      await nextTurn(3);

      expect(instance.lastFrame()).toContain('未确认');
      await focusAction(instance, '项目插件');
      await input(instance, '\r');
      expect(value.snapshot.router.current.route.name).toBe('projectStatus');
      expect(screens).toContain('G06');
      expect(instance.lastFrame()).toContain('未确认');
      expect(instance.lastFrame()).not.toContain('同步明确的');
      await focusBottomAction(instance, '重新检查');
      await input(instance, '\r');
      expect(onSessionNavigation).not.toHaveBeenCalled();
      await focusAction(instance, '错误详情');
      await input(instance, '\r');
      expect(instance.lastFrame()).toContain('项目状态安全详情');
      let details = instance.lastFrame() ?? '';
      for (let index = 0; index < 8 && !details.includes('unknownReason10'); index += 1) {
        await input(instance, '\u001B[C');
        details += `\n${instance.lastFrame() ?? ''}`;
      }
      expect(details).toContain('unknownReason01');
      expect(details).toContain('unknownReason10');
      expect(details).toContain('unknown-10');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
      expect(executeIntent).not.toHaveBeenCalled();
      await escape(instance);
      expect(value.snapshot.router.current.route.name).toBe('home');
    },
  );

  it('uses real project roots and treats a confirmed incomplete dependency as actionable', async () => {
    const dependencyOnly = projectIntentTarget({
      pluginName: 'content-toolkit',
      state: 'needsSync',
    });
    const root = projectIntentTarget({ pluginName: 'agent-lab', state: 'needsSync' });
    const rootPlacement = placement(root, 'project');
    rootPlacement.components = [
      { kind: 'ownership', key: 'fixture', state: 'present' },
      {
        kind: 'intent',
        key: 'desired',
        state: 'desired',
        metadata: { enabled: true, scopes: ['project'], relation: 'root' },
      },
      {
        kind: 'dependency',
        key: 'official/review-gate',
        state: 'incomplete',
      },
    ];
    const loaded = projectReminderLoadResult();
    loaded.payload.targets = [dependencyOnly, root];
    loaded.projectIntentRoots = [{
      pluginId: root.pluginId,
      platforms: [root.platform],
    }];
    const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();

    expect(value.snapshot.projectIntentReminder).toMatchObject({
      actionableTargets: [{
        pluginId: 'official/agent-lab',
        platform: 'claude',
        scope: 'project',
      }],
      blockedTargets: [],
    });
    expect(value.snapshot.projectIntentReminder?.actionableTargets).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId: 'official/content-toolkit' }),
      ]),
    );
  });

  it('clears the project reminder after a successful exact sync reload', async () => {
    const pending = projectReminderLoadResult();
    const ready = projectReminderLoadResult();
    ready.payload.targets = ready.payload.targets.map((entry) =>
      entry.pluginId === 'official/agent-lab'
        ? projectIntentTarget({ pluginName: 'agent-lab', state: 'ready' })
        : entry);
    const loadStatus = vi.fn()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(ready);
    const captureEvidence = vi.fn(async (intent: OperationIntent) =>
      intent.kind === 'pluginWriteBatch' ? batchEvidenceForIntent(intent) : evidenceForIntent(intent));
    const completedTarget = {
      target: {
        pluginId: 'official/agent-lab',
        pluginName: 'agent-lab',
        sourceId: 'official',
        platform: 'claude' as const,
        scope: 'project' as const,
      },
      action: 'sync',
      state: 'completed' as const,
      requiredBy: [],
    };
    const groupResult = {
      platforms: ['claude'],
      plugins: [],
      warnings: [],
      rebuildResults: [],
      targetResults: [completedTarget],
      overallState: 'succeeded',
      receiptTargets: [],
    } as unknown as PluginWriteBatchExecutionResult['groupResults'][number]['result'];
    const value = controller({
      loadStatus,
      captureEvidence,
      executeIntent: vi.fn().mockResolvedValue({
        ...groupResult,
        requestedPluginIds: ['official/agent-lab'],
        groupResults: [{
          groupId: 'official\0claude\0project',
          sourceId: 'official',
          platform: 'claude',
          scope: 'project',
          requestedPluginIds: ['official/agent-lab'],
          result: groupResult,
        }],
      }),
    });
    await value.load();
    const review = await value.buildOperationReview({
      kind: 'pluginWriteBatch',
      action: 'sync',
      selection: {
        kind: 'currentProjectIntentTargets',
        targets: [{
          pluginId: 'official/agent-lab',
          platform: 'claude',
          scope: 'project',
        }],
      },
      platform: 'claude',
      scope: 'project',
    });
    await expect(value.executeOperation(review.reviewToken)).resolves.toMatchObject({
      state: 'succeeded',
    });
    expect(value.snapshot.projectIntentReminder).toMatchObject({
      actionableTargets: [],
      blockedTargets: [],
      unconfirmedTargets: [],
    });
  });

  it('does not move focus when the project reminder arrives after leaving home', async () => {
    const pending = deferred<TuiStatusLoadResult>();
    const value = controller({ loadStatus: vi.fn(() => pending.promise) });
    const claim = vi.fn(() => true);
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onClaimProjectIntentReminder={claim}
    />);
    await nextTurn();
    value.push({ name: 'pluginList', mode: 'browse' });
    pending.resolve(projectReminderLoadResult());
    await vi.waitFor(() => expect(value.snapshot.phase).toBe('ready'));

    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'browse' });
    expect(instance.lastFrame()).toContain('插件');
    expect(instance.lastFrame()).not.toContain('稍后处理');
    expect(claim).not.toHaveBeenCalled();
  });

  it('opens a Review for a new clone from the saved project roots without adding user targets', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const sourceRoot = path.join(isolation.layout.fixtureCwd, 'new-clone-review-source');
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'review-gate', 'apps.json'), { apps: {} });
    await fs.outputJson(path.join(sourceRoot, 'plugins', 'review-gate', 'codex', 'apps.json'), { apps: {} });
    await createCatalogSnapshotFixture(sourceRoot, 'review-gate', [], 'review gate\n', (manifest) => {
      manifest.marketplace.policy.products = ['CODEX'];
      manifest.apps = './apps.json';
    });
    const pluginRoot = path.join(sourceRoot, 'plugins', 'review-gate');
    const platformManifestPath = path.join(pluginRoot, '.codex-plugin', 'plugin.json');
    await fs.writeJson(platformManifestPath, {
      ...await fs.readJson(platformManifestPath), apps: './codex/apps.json',
    }, { spaces: 2 });
    const catalogManifest = await fs.readJson(path.join(sourceRoot, 'catalog-manifest.json'));
    const plugin = await readPluginManifest(pluginRoot, { mode: 'bundle' });
    await fs.writeJson(path.join(sourceRoot, 'catalog-manifest.json'), {
      ...catalogManifest, entries: [await createCatalogManifestV7Entry(plugin, pluginRoot)],
    }, { spaces: 2 });
    const initial = await readCatalogSourcesConfigSnapshot(isolation.env);
    await replaceCatalogSourcesConfig({
      config: {
        schemaVersion: 2,
        sources: [{ id: 'team-tools', type: 'path', primary: true, path: sourceRoot }],
      },
      expectedDigest: initial.digest,
      env: isolation.env,
    });
    await syncCatalogSourceGeneration({
      sourceId: 'team-tools', cliVersion: '1.0.0', env: isolation.env,
    });
    await writePluginIntentState({
      scope: 'project', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    }, upsertPluginIntentRoot(createEmptyPluginIntentState(), {
      pluginId: 'team-tools/review-gate', platforms: ['codex'],
    }));
    const userIntentBefore = await readPluginIntentState({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env: isolation.env,
    });
    const systemRoot = path.join(isolation.layout.fixtureCwd, 'system-codex');
    const binRoot = path.join(systemRoot, 'bin');
    const packageRoot = path.join(systemRoot, 'lib', 'node_modules', '@openai', 'codex');
    const launcher = path.join(packageRoot, 'bin', 'codex.js');
    await Promise.all([
      fs.outputJson(path.join(packageRoot, 'package.json'), {
        name: '@openai/codex', version: '0.151.0', bin: { codex: 'bin/codex.js' },
      }),
      fs.outputFile(launcher, '#!/usr/bin/env node\n'),
    ]);
    await fs.chmod(launcher, 0o755);
    await fs.ensureDir(binRoot);
    await fs.symlink(path.relative(binRoot, launcher), path.join(binRoot, 'codex'));
    const env = { ...isolation.env, PATH: `${binRoot}:${isolation.env.PATH ?? ''}` };
    const nativeCliRunner = vi.fn(async (invocation) => ({
      exitCode: 0,
      stdout: invocation.args.at(-1) === '--version'
        ? 'codex-cli 0.151.0'
        : JSON.stringify({ installed: [], available: [] }),
      stderr: '',
    }));
    const dependencies = createTuiControllerDependencies(createCliExecutionContext({
      cwd: isolation.layout.fixtureCwd,
      env,
      interactive: false,
      nativeCliRunner,
    }));
    const captureEvidence = vi.fn(dependencies.captureEvidence);
    const value = new TuiController({
      ...dependencies, prepareReviewEvidence: undefined, captureEvidence,
    });
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' }, { focusIndex: 0, installFilter: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await nextTurn(3);

    value.push({ name: 'projectStatus' });
    await nextTurn(2);
    expect(instance.lastFrame()).toContain('同步全部可处理声明（1）');
    await input(instance, 'c');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    expect(value.snapshot.activeReview?.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pluginId: 'team-tools/review-gate',
        description: expect.stringContaining('新增当前项目安装'),
      }),
    ]));
    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWriteBatch', action: 'sync', scope: 'project', platform: 'codex',
      selection: { kind: 'currentProjectIntentTargets', targets: [{
        pluginId: 'team-tools/review-gate', platform: 'codex', scope: 'project',
      }] },
    }), expect.any(AbortSignal));
    await expect(captureEvidence.mock.results[0]!.value).resolves.toMatchObject({
      groups: [{
        platform: 'codex', scope: 'project', executable: true,
        preview: { overallState: 'succeeded', targetResults: [] },
      }],
      targetVersions: [{
        pluginId: 'team-tools/review-gate', platform: 'codex', scope: 'project',
        presence: 'new', availableVersion: '1.0.0',
      }],
    });
    expect(nativeCliRunner).toHaveBeenCalled();
    expect(await readPluginIntentState({
      scope: 'user', cwd: isolation.layout.fixtureCwd, env,
    })).toEqual(userIntentBefore);
  });

  it.each([
    ['dependencyMissing', 'absent', 'D14'],
    ['dependencyNotReady', 'partial', 'D15'],
  ] as const)('runs the complete project root plan for a desired consumer %s action', async (
    category,
    dependencyState,
    expectedScreen,
  ) => {
    const loaded = dependencyLoadResult({
      rootState: 'error',
      rootErrorCode: category,
      rootErrorMessage: `${category}: official/skill-toolkit has changed state.`,
    });
    const dependencyTarget = loaded.payload.targets.find((entry) =>
      entry.pluginId === 'official/skill-toolkit' && entry.platform === 'codex')!;
    updatePlacement(dependencyTarget, 'user', {
      state: dependencyState === 'partial' ? 'needsSync' : 'absent',
      reasons: dependencyState === 'partial'
        ? [{ code: 'missingContent', message: '安全说明', severity: 'warning' }] : [],
    });
    for (const target of loaded.payload.targets.filter((entry) =>
      entry.pluginId === 'official/agent-lab'
      && entry.platform === 'codex')) {
      placement(target, 'project').components.push({
        kind: 'intent', key: 'desired', state: 'desired',
        metadata: { enabled: true, scopes: ['project'], relation: 'root' },
      });
      updatePlacement(target, 'project', { state: 'needsSync', reasons: [{
        code: category,
        message: `${category}: official/skill-toolkit has changed state.`,
        severity: 'blocking',
        dependencyPluginId: 'official/skill-toolkit',
        dependencyPlatform: 'codex',
        dependencyScope: 'user',
        dependencyProject: null,
      }], recoveryActions: [{
        command: 'sync', scope: 'project', description: '同步完整的根插件依赖计划。',
      }] });
    }
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

    await input(instance, '\r');

    expect(captureEvidence).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'pluginWrite',
      action: 'sync',
      pluginId: 'official/agent-lab',
      platform: 'codex',
      scope: 'project',
      originIssue: expect.objectContaining({
        actionId: 'sync',
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

  it.each([[60, 18], [80, 24]] as const)(
    'keeps mixed project placement facts and root focus on return at %ix%i', async (columns, rows) => {
      const loaded = projectStatusLoadResult([
        projectIntentTarget({ pluginName: 'agent-lab', platform: 'codex', state: 'blocked' }),
        projectIntentTarget({ pluginName: 'agent-lab', platform: 'claude', state: 'needsSync' }),
        projectIntentTarget({ pluginName: 'review-gate', platform: 'codex', state: 'ready' }),
      ]);
      loaded.projectIntentRoots = [
        { pluginId: 'official/agent-lab', platforms: ['codex', 'claude'] },
        { pluginId: 'official/review-gate', platforms: ['codex'] },
      ];
      loaded.projectIntent = { state: 'ready', roots: loaded.projectIntentRoots };
      const value = controller({ loadStatus: vi.fn().mockResolvedValue(loaded) });
      await value.load();
      value.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await nextTurn(2);
      const frames = [acceptanceTraceStep(instance, { columns, rows }, 'mixed root')];
      expect(frames[0]!.frame).toContain('总体状态 [! 受阻]');
      expect(frames[0]!.frame).toContain('Codex [当前项目]');
      expect(frames[0]!.frame).toContain('Claude Code [当前项目]');
      await input(instance, '\u001B[B');
      expect(instance.lastFrame()).toContain('[↻ 待同步]');
      frames.push(acceptanceTraceStep(instance, { columns, rows }, 'second platform', ['down']));
      expect(value.listProjectInventoryRoots()).toHaveLength(2);
      await input(instance, '/', 'review', '\r');
      expect(instance.lastFrame()).toContain('review-gate');
      expect(instance.lastFrame()).not.toContain('agent-lab');
      await input(instance, '\r');
      expect(value.snapshot.router.current.route).toEqual({
        name: 'pluginDetail', pluginId: 'official/review-gate',
      });
      await escape(instance);
      expect(value.snapshot.router.current.route.name).toBe('projectStatus');
      expect(instance.lastFrame()).toMatch(/搜索 review +\[\/\]/u);
      expect(instance.lastFrame()).toContain('› review-gate');
      frames.push(acceptanceTraceStep(instance, { columns, rows }, 'root returned'));
      await writeAcceptanceTrace(`b04/project-mixed-${columns}x${rows}`, frames);
    },
  );
});
