import path from 'node:path';

import fs from 'fs-extra';
import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type OperationEvidence, type OperationIntent, type TuiControllerSnapshot,
  type TuiStatusLoadResult } from '../../src/tui/controller.js';
import type { PluginDetailPlacement, PluginDetailSubject } from '../../src/tui/plugin-detail.js';
import type { PluginListItemViewModel, UserIssueViewModel } from '../../src/tui/model.js';
import type { TuiPageContext, TuiRoute } from '../../src/tui/router.js';

afterEach(() => cleanup());

const pluginId = 'official/demo';
const platform = 'codex' as const;

function placement(scope: 'project' | 'user', observation: 'known' | 'unknown' = 'known'): PluginDetailPlacement {
  return {
    platform, scope, platformLabel: 'Codex', scopeLabel: scope,
    observation, declared: true, actual: true, sharedWithCurrentProject: false,
    statusState: 'ready', installedVersion: scope === 'project' ? '1.0.0' : '2.0.0', reasonCodes: [],
  };
}

function overview(): PluginListItemViewModel {
  return {
    pluginId, sourceId: 'official', displayName: '双位置插件', description: '位置维护测试',
    version: '2.0.0', configFieldCount: 0, sourceLabel: 'official',
    supportedPlatforms: [platform], installedPlacements: [{
      platform, state: 'installed', scope: 'project', health: 'ready',
      revision: { state: 'current', installedVersion: '1.0.0' },
      scopedPlacements: [
        { scope: 'project', health: 'ready', revision: { state: 'current', installedVersion: '1.0.0' }, actualState: 'ready' },
        { scope: 'user', health: 'ready', revision: { state: 'current', installedVersion: '2.0.0' }, actualState: 'ready' },
      ],
    }], aggregateStatus: 'installed', portableSkills: false,
    savedConfigScopes: [], technicalComponents: [
      { platform, scope: 'project', key: 'project-component', state: 'ready' },
      { platform, scope: 'user', key: 'user-component', state: 'ready' },
    ], update: { pluginId, state: 'notChecked', targets: [] },
  } as PluginListItemViewModel;
}

function sourceRecoveryStatus(activated: boolean): TuiStatusLoadResult {
  return {
    pluginSummaries: [{ pluginId, pluginName: 'demo', displayName: '示例插件',
      description: '来源恢复复现', version: '1.0.0',
      supportedTargets: { codex: [], claude: ['user'] }, configFieldCount: 0 }],
    payload: {
      schemaVersion: 8,
      catalog: { primarySourceId: 'official', configDigest: 'config', compositeDigest: 'catalog',
        sources: [{ id: 'official', identity: 'identity:official', type: 'path', primary: true,
          requestedRef: 'local', ...(activated ? { catalogVersion: '1.0.0', freshness: 'active' as const }
            : { error: 'No Active snapshot', errorCode: 'catalogGenerationUnavailable' }) }] },
      filters: { plugins: [], platform: 'both', cwd: '/tmp/platform-source-recovery-test' },
      targets: [{ pluginId, pluginName: 'demo', sourceId: 'official', sourceIdentity: 'identity:official',
        version: '1.0.0', platform: 'claude', scope: 'user', state: activated ? 'ready' : 'blocked',
        components: [
          { kind: 'intent', key: 'desired', state: 'desired', metadata: {
            enabled: true, scopes: ['user'], relation: 'root',
          } },
          { kind: 'ownership', key: 'fixture', state: 'present' },
        ],
        reasons: activated ? [] : [{ code: 'catalogSourceUnavailable', message: '来源不可用', severity: 'blocking' }],
        recoveryActions: activated ? [
          { command: 'reinstall', scope: 'user', description: '重新安装' },
          { command: 'uninstall', scope: 'user', description: '移除' },
        ] : [],
      }], errors: [],
    },
    sourceDetails: [{ id: 'official', type: 'path', primary: true, autoCheck: false,
      locationSummary: '隔离本地来源', refPolicy: 'explicit', requestedRef: 'local',
      sourceIdentity: 'identity:official', configDigest: 'config',
      ...(activated ? { catalogVersion: '1.0.0' } : { errorCode: 'catalogGenerationUnavailable' }) }],
    configuredSources: [{ id: 'official', type: 'path', primary: true, autoCheck: false,
      path: '/tmp/isolated-catalog-test' }],
    catalogGenerations: [{ sourceId: 'official', sourceType: 'path',
      ...(activated ? { state: 'ready', active: { catalogVersion: '1.0.0', channel: 'latest',
        requestedRef: 'local', resolvedCommit: 'local', storeKey: 'official-active', digestShort: 'abc' } }
        : { errorCode: 'catalogGenerationUnavailable' }) }],
  };
}

class PlatformControllerStub {
  plugin = overview();
  facts: PluginDetailPlacement[] = [placement('project'), placement('user')];
  route: TuiRoute = { name: 'platform', pluginId, platform };
  context: TuiPageContext = {};
  previous: Array<{ route: TuiRoute; context: TuiPageContext }> = [];
  intents: OperationIntent[] = [];
  issues: UserIssueViewModel[] = [];
  forceChecks = 0;
  forceTargets: Array<{ pluginId: string; platform: string; scope: string }> = [];
  listeners = new Set<(snapshot: TuiControllerSnapshot) => void>();

  get snapshot(): TuiControllerSnapshot {
    return { phase: 'ready', router: { current: { route: this.route, context: this.context },
      currentFrameId: 'platform-frame', depth: 2 }, sourceHealth: [], catalogGenerations: [],
      catalogFreshness: [], reloadRequiredSourceIds: [], operationHistorySummaries: [],
      progress: { messages: [] }, progressTargets: [],
      viewModel: { plugins: [this.plugin], dependencyOverviews: [] },
    } as unknown as TuiControllerSnapshot;
  }
  get externalDrafts(): [] { return []; }
  subscribe(listener: (snapshot: TuiControllerSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }
  publish(): void { for (const listener of this.listeners) listener(this.snapshot); }
  getPluginOverview(id: string) { return id === pluginId ? this.plugin : undefined; }
  getPluginDetailSubject(id: string): PluginDetailSubject | undefined {
    if (id !== pluginId) return undefined;
    return { pluginId, sourceId: 'official', displayName: '双位置插件',
      definitionAvailable: true, savedConfigScopes: [], placements: this.facts,
      relations: { outgoing: [], incoming: [], checkState: 'checked', hasKnownRelations: false } };
  }
  getPlatformPlacement() { return this.plugin.installedPlacements[0]; }
  getBlockingDependents() { return []; }
  listUserIssues() { return this.issues; }
  listPluginWriteTaskCandidates() { return []; }
  listPluginDependencyOverviews() { return []; }
  listSources() { return []; }
  setExternalDraftState(): void {}
  updatePageContext(update: Partial<TuiPageContext>): void {
    this.context = { ...this.context, ...update };
    this.publish();
  }
  startReviewPreparation(intent: OperationIntent): void { this.intents.push(intent); }
  async getForceCleanupCandidate(candidatePluginId: string, candidatePlatform: string,
    candidateScope: string) {
    this.forceChecks += 1;
    this.forceTargets.push({ pluginId: candidatePluginId, platform: candidatePlatform,
      scope: candidateScope });
    return undefined;
  }
  push(route: TuiRoute): void {
    this.previous.push({ route: this.route, context: this.context });
    this.route = route;
    this.context = {};
    this.publish();
  }
  replace(route: TuiRoute): void { this.route = route; this.publish(); }
  back(): void {
    const previous = this.previous.pop();
    if (previous) { this.route = previous.route; this.context = previous.context; }
    this.publish();
  }
}

async function input(instance: ReturnType<typeof render>, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    instance.stdin.write(key);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function checkedFrame(instance: ReturnType<typeof render>, size: { columns: number; rows: number }): string {
  const result = instance.lastFrame() ?? '';
  expect(result.split('\n').length).toBeLessThanOrEqual(size.rows);
  expect(result.split('\n').every((line) => stringWidth(line) <= size.columns)).toBe(true);
  return result;
}

async function focusAction(instance: ReturnType<typeof render>, label: string): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    if ((instance.lastFrame() ?? '').includes(`› ${label}`)) return;
    await input(instance, '\u001b[B');
  }
  throw new Error(`动作不可达：${label}\n${instance.lastFrame()}`);
}

async function writeAcceptanceTrace(
  name: string, size: { columns: number; rows: number }, frames: Record<string, string>,
  intent?: OperationIntent,
): Promise<void> {
  const outputDir = process.env.AW_TUI_ACCEPTANCE_TRACE_DIR;
  if (!outputDir) return;
  await fs.outputJson(path.join(outputDir, `b05-${name}-${size.columns}x${size.rows}.json`), {
    schemaVersion: 1, synthetic: true, size, frames,
    ...(intent ? { reviewTarget: intent } : {}),
  }, { spaces: 2 });
}

describe('platform maintenance v8', () => {
  it.each([[80, 24], [60, 18]] as const)(
    'does not turn source recovery return into uninstall at %ix%i', async (columns, rows) => {
      let activated = false;
      const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => ({
        catalog: { configDigest: 'config', compositeDigest: 'catalog' },
        catalogGeneration: { action: 'activate', configDigest: 'config', candidate: {
          sourceConfigFingerprint: 'config', sourceIdentity: 'identity:official',
          logicalIdentity: 'official', catalogVersion: '1.0.0', channel: 'latest',
          requestedRef: 'local', resolvedCommit: 'local', manifestDigest: 'manifest',
          snapshotDigest: 'snapshot',
        } },
      }));
      const executeIntent = vi.fn(async (intent: OperationIntent) => {
        if (intent.kind === 'catalogGeneration') activated = true;
        return { overallState: 'succeeded', targetResults: [] };
      });
      const controller = new TuiController({ loadStatus: async () => sourceRecoveryStatus(activated),
        captureEvidence, executeIntent });
      await controller.load();
      controller.push({ name: 'platform', pluginId, platform: 'claude' });
      const size = { columns, rows };
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await input(instance, '', '');
      await focusAction(instance, '获取或修复来源');
      const before = checkedFrame(instance, size);
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route).toMatchObject({ name: 'sourceDetail', sourceId: 'official' });
      await focusAction(instance, '恢复来源');
      await input(instance, '\r');
      await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('review'));
      await input(instance, '\r');
      await vi.waitFor(() => expect(controller.snapshot.router.current.route.name).toBe('result'));
      expect(executeIntent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'catalogGeneration',
        action: 'activate', sourceId: 'official' }), expect.anything(), expect.anything());
      await input(instance, '\u001b');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(controller.snapshot.router.current.route.name).toBe('sourceDetail');
      await input(instance, '\u001b');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(controller.snapshot.router.current.route).toMatchObject({ name: 'platform', pluginId,
        platform: 'claude' });
      expect(controller.snapshot.router.current.context.platformSelectedScope).toBe('user');
      const returned = checkedFrame(instance, size);
      expect(returned).toMatch(/╭─ › (?:当前项目|所有项目) \[选定\]/u);
      await input(instance, '\r');
      const afterNextEnter = checkedFrame(instance, size);
      expect(controller.snapshot.router.current.route.name).toBe('platform');
      expect(captureEvidence.mock.calls).toEqual([[expect.objectContaining({ kind: 'catalogGeneration',
        action: 'activate', sourceId: 'official' }), expect.anything()]]);
      expect(executeIntent).toHaveBeenCalledTimes(1);
      await writeAcceptanceTrace('platform-source-recovery-return', size, { before, returned, afterNextEnter });
    },
  );

  it.each([[80, 24], [60, 18]] as const)(
    'keeps a platform detail action when a new action appears before it at %ix%i', async (columns, rows) => {
      const controller = new PlatformControllerStub();
      controller.facts = [placement('user')];
      controller.plugin.installedPlacements[0] = {
        platform, state: 'installed', scope: 'user', health: 'ready', actualState: 'ready',
        revision: { state: 'current', installedVersion: '2.0.0' },
      };
      controller.context = { platformSelectionInitialized: true, platformSelectedScope: 'user' };
      const size = { columns, rows };
      const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController} size={size} />);
      await input(instance, '', '');
      await focusAction(instance, '查看安装详情');
      await input(instance, '\r');
      expect(controller.route).toMatchObject({ name: 'pluginTechnical', pluginId, platform, scope: 'user' });
      controller.plugin.installedPlacements[0]!.revision = {
        state: 'upgradeAvailable', installedVersion: '2.0.0', availableVersion: '3.0.0',
      };
      controller.plugin.update = { pluginId, state: 'upgradeAvailable', sourceIdentity: 'identity:official',
        generationKey: 'gen', targets: [{ platform, scope: 'user', installedVersion: '2.0.0',
          availableVersion: '3.0.0' }] };
      controller.publish();
      await input(instance, '\u001b');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const returned = checkedFrame(instance, size);
      expect(controller.route.name).toBe('platform');
      expect(returned).toContain('› 查看安装详情');
      expect(returned).toContain('更新到 3.0.0');
      expect(returned.indexOf('更新到 3.0.0')).toBeLessThan(returned.indexOf('› 查看安装详情'));
      await input(instance, '\r');
      expect(controller.route).toMatchObject({ name: 'pluginTechnical', pluginId, platform, scope: 'user' });
      expect(controller.intents).toHaveLength(0);
      await writeAcceptanceTrace('platform-detail-action-insert', size, { returned });
    },
  );

  it.each([[80, 24], [60, 18]] as const)(
    'does not select a different scope after the selected one vanishes in a child page at %ix%i', async (columns, rows) => {
      const controller = new PlatformControllerStub();
      const size = { columns, rows };
      const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController} size={size} />);
      await input(instance, '', '', '\u001b[B', '\r');
      expect(controller.context.platformSelectedScope).toBe('user');
      await focusAction(instance, '查看安装详情');
      await input(instance, '\r');
      expect(controller.route.name).toBe('pluginTechnical');
      controller.facts = [placement('project')];
      controller.plugin.installedPlacements[0] = {
        platform, state: 'installed', scope: 'project', health: 'ready',
        revision: { state: 'current', installedVersion: '1.0.0' }, actualState: 'ready',
      };
      controller.publish();
      await input(instance, '\u001b');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const returned = checkedFrame(instance, size);
      expect(controller.route.name).toBe('platform');
      expect(controller.context.platformSelectionInitialized).toBe(true);
      expect(controller.context.platformSelectedScope).toBeUndefined();
      expect(returned).toContain('已选位置不再存在');
      expect(returned).toMatch(/╭─ › (?:当前项目|所有项目) \[选择\]/u);
      await input(instance, '\r');
      expect(controller.route.name).toBe('platform');
      expect(controller.context.platformSelectedScope).toBe('project');
      expect(controller.intents).toHaveLength(0);
      await writeAcceptanceTrace('platform-child-scope-vanish', size, { returned });
    },
  );

  it.each([[80, 24], [60, 18]] as const)(
    'returns to the same platform write action after Review preparation fails at %ix%i', async (columns, rows) => {
      const captureEvidence = vi.fn().mockRejectedValue(new Error('evidence unavailable'));
      const executeIntent = vi.fn();
      const controller = new TuiController({ loadStatus: async () => sourceRecoveryStatus(true),
        captureEvidence, executeIntent });
      await controller.load();
      controller.push({ name: 'platform', pluginId, platform: 'claude' });
      const size = { columns, rows };
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await input(instance, '', '');
      await focusAction(instance, '重新安装所有项目位置');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route.name).toBe('reviewPreparing');
      await vi.waitFor(() => expect(controller.snapshot.reviewPreparation?.state).toBe('failed'));
      await input(instance, '\u001b');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const returned = checkedFrame(instance, size);
      expect(controller.snapshot.router.current.route.name).toBe('platform');
      expect(returned).toContain('› 重新安装所有项目位置');
      await input(instance, '\r');
      expect(controller.snapshot.router.current.route.name).toBe('reviewPreparing');
      await vi.waitFor(() => expect(captureEvidence).toHaveBeenCalledTimes(2));
      expect(captureEvidence.mock.calls.every(([intent]) => intent.kind === 'pluginWrite'
        && intent.action === 'reinstall' && intent.pluginId === pluginId
        && intent.platform === 'claude' && intent.scope === 'user')).toBe(true);
      expect(executeIntent).not.toHaveBeenCalled();
      await writeAcceptanceTrace('platform-review-return', size, { returned });
    },
  );

  it.each([[80, 24], [60, 18]] as const)('shows one platform card with both exact scope facts at %ix%i', async (columns, rows) => {
    const controller = new PlatformControllerStub();
    controller.facts[0]!.expectedVersion = '1.5.0';
    controller.route = { name: 'pluginMore', pluginId };
    const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController}
      size={{ columns, rows }} />);
    await input(instance, '', '');
    const frame = checkedFrame(instance, { columns, rows });
    expect(frame.match(/Codex 平台维护/gu)).toHaveLength(1);
    expect(frame).toContain('╭─ › Codex 平台维护');
    expect(frame).toContain('当前项目');
    expect(frame).toContain('所有项目');
    expect(frame).toContain('1.0.0');
    expect(frame).toContain('2.0.0');
    expect(frame).toContain('声明期望版本 1.5.0');
    expect(frame.match(/╰/gu)).toHaveLength(1);
    await input(instance, '\r');
    expect(controller.route).toEqual({ name: 'platform', pluginId, platform });
    expect(controller.context.platformSelectedScope).toBeUndefined();
    expect(controller.intents).toHaveLength(0);
    await writeAcceptanceTrace('more-platform-card', { columns, rows }, { more: frame,
      maintenance: checkedFrame(instance, { columns, rows }) });
  });

  it.each([[80, 24], [60, 18]] as const)(
    'keeps card focus separate from selected scope and Review target at %ix%i',
    async (columns, rows) => {
      const controller = new PlatformControllerStub();
      const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController}
        size={{ columns, rows }} />);
      await input(instance, '', '');
      const initiallyUnselected = instance.lastFrame() ?? '';
      expect(initiallyUnselected.match(/╭─/gu)).toHaveLength(2);
      expect(initiallyUnselected.match(/╰/gu)).toHaveLength(2);
      expect(controller.context.platformSelectedScope).toBeUndefined();
      expect(instance.lastFrame()).toContain('1.0.0');
      expect(instance.lastFrame()).toContain('2.0.0');
      await input(instance, '\u001b[B');
      expect(controller.context.platformSelectedScope).toBeUndefined();
      await input(instance, '\r');
      expect(controller.context.platformSelectedScope).toBe('user');
      const selectedUser = instance.lastFrame() ?? '';
      await input(instance, '\u001b[A');
      expect(controller.context.platformSelectedScope).toBe('user');
      await focusAction(instance, '从所有项目移除');
      await input(instance, '\r');
      expect(controller.intents).toEqual([expect.objectContaining({
        kind: 'pluginWrite', action: 'uninstall', pluginId, platform, scope: 'user',
      })]);
      expect(controller.intents[0]).not.toHaveProperty('targets');
      expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(rows);
      await writeAcceptanceTrace('platform-user-target', { columns, rows }, {
        initiallyUnselected, selectedUser, focusedReviewAction: instance.lastFrame() ?? '',
      }, controller.intents[0]);
    },
  );

  it.each([[80, 24], [60, 18]] as const)(
    'clears a missing selected scope without selecting the remaining one at %ix%i',
    async (columns, rows) => {
      const controller = new PlatformControllerStub();
      const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController}
        size={{ columns, rows }} />);
      await input(instance, '', '', '\u001b[B', '\r');
      expect(controller.context.platformSelectedScope).toBe('user');
      const beforeScopeDisappears = instance.lastFrame() ?? '';
      controller.facts = [placement('project')];
      controller.plugin.installedPlacements[0] = {
        platform, state: 'installed', scope: 'project', health: 'ready',
        revision: { state: 'current', installedVersion: '1.0.0' }, actualState: 'ready',
      };
      controller.publish();
      await input(instance, '', '');
      expect(controller.context.platformSelectedScope).toBeUndefined();
      expect(controller.context.platformSelectionInitialized).toBe(true);
      expect(instance.lastFrame()).toContain('已选位置不再存在');
      const afterScopeDisappears = instance.lastFrame() ?? '';
      await input(instance, '\u001b[B', '\r');
      expect(controller.intents).toHaveLength(0);
      await writeAcceptanceTrace('platform-scope-disappears', { columns, rows }, {
        beforeScopeDisappears, afterScopeDisappears,
        afterAttemptedAction: instance.lastFrame() ?? '',
      });
    },
  );

  it('keeps technical body within the selected platform and scope', async () => {
    const controller = new PlatformControllerStub();
    const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController}
      size={{ columns: 80, rows: 24 }} />);
    await input(instance, '', '', '\u001b[B', '\r');
    await focusAction(instance, '查看安装详情');
    await input(instance, '\r');
    expect(controller.route).toMatchObject({ name: 'pluginTechnical', pluginId,
      platform, scope: 'user' });
    expect(instance.lastFrame()).toContain('user-component');
    expect(instance.lastFrame()).not.toContain('project-component');
  });

  it.each([[80, 24], [60, 18]] as const)(
    'passes the chosen needsSync scope to the original Review preparation at %ix%i',
    async (columns, rows) => {
      const controller = new PlatformControllerStub();
      const installed = controller.plugin.installedPlacements[0];
      if (installed?.state !== 'installed') throw new Error('测试位置无效');
      installed.scopedPlacements![0] = {
        scope: 'project', health: 'incomplete',
        revision: { state: 'current', installedVersion: '1.0.0' }, actualState: 'needsSync',
      };
      controller.facts[0]!.statusState = 'needsSync';
      const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController}
        size={{ columns, rows }} />);
      await input(instance, '', '');
      const initiallyUnselected = instance.lastFrame() ?? '';
      await input(instance, '\r');
      const selectedProject = instance.lastFrame() ?? '';
      await focusAction(instance, '同步当前项目的使用位置');
      const focusedReviewAction = instance.lastFrame() ?? '';
      await input(instance, '\r');
      expect(controller.intents).toEqual([expect.objectContaining({
        kind: 'pluginWrite', action: 'sync', pluginId, platform, scope: 'project',
      })]);
      await writeAcceptanceTrace('platform-project-target', { columns, rows }, {
        initiallyUnselected, selectedProject, focusedReviewAction,
        afterReviewPreparation: instance.lastFrame() ?? '',
      }, controller.intents[0]);
    },
  );

  it('does not offer ordinary writes for an unobserved selected scope', async () => {
    const controller = new PlatformControllerStub();
    controller.facts = [placement('project', 'unknown'), placement('user')];
    const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController}
      size={{ columns: 80, rows: 24 }} />);
    await input(instance, '', '', '\r');
    expect(controller.context.platformSelectedScope).toBe('project');
    expect(instance.lastFrame()).toContain('未确认');
    expect(instance.lastFrame()).not.toContain('重新安装当前项目位置');
    expect(instance.lastFrame()).not.toContain('从当前项目移除');
    expect(controller.intents).toHaveLength(0);
  });

  it('selects a sole initial scope and does not add a newly observed scope to its target', async () => {
    const controller = new PlatformControllerStub();
    controller.facts = [placement('project')];
    controller.plugin.installedPlacements[0] = {
      platform, state: 'installed', scope: 'project', health: 'ready',
      revision: { state: 'current', installedVersion: '1.0.0' }, actualState: 'ready',
    };
    const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController}
      size={{ columns: 80, rows: 24 }} />);
    await input(instance, '', '');
    expect(controller.context.platformSelectedScope).toBe('project');
    controller.facts = [placement('project'), placement('user')];
    controller.plugin = overview();
    controller.publish();
    await input(instance, '', '');
    expect(controller.context.platformSelectedScope).toBe('project');
    await focusAction(instance, '从当前项目移除');
    await input(instance, '\r');
    expect(controller.intents).toEqual([expect.objectContaining({
      kind: 'pluginWrite', action: 'uninstall', pluginId, platform, scope: 'project',
    })]);
  });

  it('keeps the same platform template when no placement has been confirmed', async () => {
    const controller = new PlatformControllerStub();
    controller.facts = [];
    controller.plugin.installedPlacements[0] = {
      platform, state: 'blocked', supportedScopes: ['project', 'user'], reason: 'artifactCollision',
    };
    const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController}
      size={{ columns: 60, rows: 18 }} />);
    await input(instance, '', '');
    expect(instance.lastFrame()).toContain('使用位置');
    expect(instance.lastFrame()).toContain('0 个');
    expect(instance.lastFrame()).toContain('输出位置已有冲突内容');
    expect(controller.intents).toHaveLength(0);
  });

  it.each([[80, 24], [60, 18]] as const)(
    'keeps the actual cleanup action focused across issue changes at %ix%i',
    async (columns, rows) => {
      const controller = new PlatformControllerStub();
      controller.context = { platformSelectionInitialized: true, platformSelectedScope: 'project' };
      controller.plugin.sourceUnavailable = true;
      controller.plugin.aggregateStatus = 'unavailable';
      controller.plugin.installedPlacements = [{
        platform, state: 'installed', scope: 'project', health: 'incomplete',
        actualState: 'orphaned', revision: { state: 'notChecked' }, recovery: [],
      }];
      controller.facts = [{ ...placement('project'), declared: false,
        statusState: 'orphaned' }];
      const cleanupIssue: UserIssueViewModel = {
        issueId: 'target:official/demo:codex:project', category: 'sourceUnavailable',
        group: 'sourceUnavailable', title: '来源不可用', explanation: '当前来源不可用',
        impact: [], entity: { kind: 'plugin', id: pluginId }, pluginId, platform,
        scope: 'project', actions: [{ id: 'cleanup', label: '清理', pluginId,
          platform, scope: 'project', writeAction: 'cleanup' }], technicalDetails: [],
        diagnostic: { severity: 'warning', title: '来源不可用',
          userMessage: '当前来源不可用', impact: [], nextStep: '检查来源' },
      };
      const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController}
        size={{ columns, rows }} />);
      await input(instance, '', '');
      await focusAction(instance, '检查受限清理');
      controller.issues = [cleanupIssue];
      controller.publish();
      await input(instance, '', '');
      expect(instance.lastFrame()).toContain('› 检查受限清理');
      await input(instance, '\r');
      expect(controller.forceChecks).toBe(1);
      expect(controller.forceTargets).toEqual([{ pluginId, platform, scope: 'project' }]);
      expect(controller.intents).toHaveLength(0);

      await focusAction(instance, '清理当前项目中的遗留内容');
      await input(instance, '\r');
      expect(controller.intents).toEqual([expect.objectContaining({
        kind: 'pluginWrite', action: 'cleanup', pluginId, platform, scope: 'project',
        originIssue: expect.objectContaining({ issueId: cleanupIssue.issueId,
          actionId: 'cleanup' }),
      })]);
      expect(controller.forceChecks).toBe(1);
      await focusAction(instance, '清理当前项目中的遗留内容');
      controller.issues = [];
      controller.publish();
      await input(instance, '', '');
      expect(instance.lastFrame()).toMatch(/╭─ › (?:当前项目|所有项目) \[选定\]/u);
      await input(instance, '\r');
      expect(controller.context.platformSelectedScope).toBe('project');
      expect(controller.forceChecks).toBe(1);
      expect(controller.intents).toHaveLength(1);
    },
  );

  it('returns to the selected card when an unobserved position hides a write action', async () => {
    const controller = new PlatformControllerStub();
    controller.context = { platformSelectionInitialized: true, platformSelectedScope: 'project' };
    const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController}
      size={{ columns: 60, rows: 18 }} />);
    await input(instance, '', '');
    await focusAction(instance, '从当前项目移除');
    controller.facts[0] = placement('project', 'unknown');
    controller.publish();
    await input(instance, '', '');
    expect(instance.lastFrame()).toMatch(/╭─ › (?:当前项目|所有项目) \[选定\]/u);
    await input(instance, '\r');
    expect(controller.intents).toHaveLength(0);
  });
});
