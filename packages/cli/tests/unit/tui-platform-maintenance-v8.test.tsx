import path from 'node:path';

import fs from 'fs-extra';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import type { OperationIntent, TuiController, TuiControllerSnapshot } from '../../src/tui/controller.js';
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
  it('shows one platform entry with both exact scope facts', async () => {
    const controller = new PlatformControllerStub();
    controller.route = { name: 'pluginMore', pluginId };
    const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController}
      size={{ columns: 80, rows: 24 }} />);
    await input(instance, '', '');
    const frame = instance.lastFrame() ?? '';
    expect(frame.match(/Codex 平台维护/gu)).toHaveLength(1);
    expect(frame).toContain('当前项目');
    expect(frame).toContain('所有项目');
  });

  it.each([[80, 24], [60, 18]] as const)(
    'keeps card focus separate from selected scope and Review target at %ix%i',
    async (columns, rows) => {
      const controller = new PlatformControllerStub();
      const instance = render(<ConsoleAppV4 controller={controller as unknown as TuiController}
        size={{ columns, rows }} />);
      await input(instance, '', '');
      const initiallyUnselected = instance.lastFrame() ?? '';
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
      expect(instance.lastFrame()).toContain('› [选定]');
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
    expect(instance.lastFrame()).toContain('› [选定]');
    await input(instance, '\r');
    expect(controller.intents).toHaveLength(0);
  });
});
