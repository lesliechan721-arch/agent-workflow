import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type TuiStatusLoadResult } from '../../src/tui/controller.js';
import { buildScopedInventory, type ScopedInventoryLoadResult } from '../../src/tui/scoped-inventory.js';
import { buildPluginDetailSubject } from '../../src/tui/plugin-detail.js';
import { PluginDetailCard, ProjectRootCard } from '../../src/tui/entity-cards.js';
import { buildTuiViewModel } from '../../src/tui/model.js';
import { deploymentPlanLines } from '../../src/tui/deployment-view.js';
import type { FrozenDeploymentPlan, PlannedEffect } from '../../src/platforms/contracts.js';
import type { ScopedTuiPlan } from '../../src/tui/scoped-flow.js';
import type { RecoveryReceipt } from '../../src/recovery/receipt.js';
import { prepareRecovery } from '../../src/recovery/coordinator.js';
import { createOperationPlan } from '../../src/commands/operation-plan.js';
import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import { statusFromObservations } from '../../src/recovery/status.js';
import { observePreferences } from '../../src/intent/deployment-preferences.js';
import type { DemandSnapshot } from '../../src/recovery/demand.js';
import type { ScopeContext } from '../../src/intent/scope-context.js';
import * as portableRecovery from '../../src/portable/recovery.js';
import * as clipboard from '../../src/tui/clipboard.js';
import { escape } from '../helpers/tui-console-app-input.js';
import { agentSettings } from '../helpers/tui-console-app-fixture.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const sizes = [{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }];
const status: TuiStatusLoadResult = {
  projectRoot: '/tmp/project',
  pluginSummaries: [{ pluginId: 'official/demo', pluginName: 'demo', displayName: 'Demo',
    description: 'Demo plugin', version: '1.0.0' }],
  payload: { schemaVersion: 8,
    catalog: { primarySourceId: 'official', configDigest: 'config', compositeDigest: 'catalog',
      sources: [{ id: 'official', identity: 'source', type: 'path', primary: true, requestedRef: 'local' }] },
    filters: { plugins: [], platform: 'both', cwd: '/tmp/project' }, targets: [], errors: [] },
};

function retiredStatus(): TuiStatusLoadResult {
  const result = structuredClone(status);
  result.pluginSummaries = [];
  result.payload.catalog.sources[0]!.freshness = 'active';
  result.catalogGenerations = [{ sourceId: 'official', sourceType: 'path', state: 'ready', active: {
    catalogVersion: '2.0.0', channel: 'latest', requestedRef: 'local', resolvedCommit: 'active',
    storeKey: 'active-store', digestShort: 'snapshot',
  } }];
  result.retirementSourceChecks = { official: 'active-store' };
  return result;
}

function retiredRecovery(scope: 'user' | 'project'): ScopedInventoryLoadResult {
  const result = recovery(scope);
  result.inventory![0]!.blockers = [{ code: 'pluginUnavailable', message: 'removed' }];
  result.inventory![0]!.targetResults = [];
  return result;
}

function retirementDeployment(scope: 'user' | 'project', effects: Array<Pick<PlannedEffect, 'kind' | 'destination' | 'nativeScope'>>,
  platform: 'codex' | 'claude' = 'codex'): FrozenDeploymentPlan {
  return {
    operation: 'cleanup',
    binding: { platform, route: `${platform}-marketplace`, scope: { kind: scope },
      plugin: { pluginId: 'official/demo' }, consumers: [] },
    effects: effects.map((effect, index) => ({ id: String(index), physicalKey: 'shared',
      componentIds: [], destructive: true, ...effect })),
    expected: { components: [], unmet: [], omitted: [] },
    evidence: { layout: { packageRoot: '/package/demo' }, sharedReferences: 'present', confirmedCatalogRetirement: true },
  } as unknown as FrozenDeploymentPlan;
}

function recovery(scope: 'user' | 'project'): ScopedInventoryLoadResult {
  return { scope, intent: { state: 'valid' }, selection: { agents: ['codex'], preferences: 'valid' },
    inventory: [{ pluginId: 'official/demo', source: 'official', sourceState: 'ready', blockers: [],
      targetResults: [{ pluginId: 'official/demo', agent: 'codex', scope,
        delivery: { kind: 'native', platform: 'codex' }, execution: 'not-run', observation: 'missing',
        content: 'absent', blockers: [], requiredBy: [] }] }],
    extraObserved: [], errors: [], allSatisfied: false, dependencyOverviews: [] };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

async function press(instance: ReturnType<typeof render>, value: string): Promise<void> {
  instance.stdin.write(value);
  await tick();
}

async function focusAction(instance: ReturnType<typeof render>, label: string): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    if ((instance.lastFrame() ?? '').split('\n').some((line) => line.includes('›') && line.includes(label))) return;
    await press(instance, '\u001b[B');
  }
  throw new Error(`action not focused: ${label}\n${instance.lastFrame() ?? ''}`);
}

function checkedFrame(instance: ReturnType<typeof render>, size: { columns: number; rows: number }): string {
  const frame = instance.lastFrame() ?? '';
  expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
  expect(frame.split('\n').every((line) => stringWidth(line) <= size.columns)).toBe(true);
  return frame;
}

async function readScopedPages(
  instance: ReturnType<typeof render>,
  size: { columns: number; rows: number },
): Promise<string> {
  const frames: string[] = [];
  for (let page = 0; page < 40; page += 1) {
    const frame = checkedFrame(instance, size);
    if (frames.at(-1) === frame) return frames.join('\n');
    frames.push(frame);
    const pager = frame.match(/(\d+)\s*\/\s*(\d+)/u);
    if (pager && pager[1] === pager[2]) return frames.join('\n');
    await press(instance, '\u001b[C');
  }
  throw new Error('The scoped details did not reach the last page.');
}

afterEach(cleanup);

describe('scoped inventory in Ink', () => {
  // Test Value Gate: an absent entry alone must never authorize retirement; the view and both
  // inventory sections depend on a healthy, resolved Active source, even for residual-only IDs.
  it.each(['healthy', 'deleted', 'inactive', 'error', 'invalidActive', 'unchecked', 'staleCheck', 'listed'] as const)(
    'projects retirement eligibility from the %s catalog snapshot', (state) => {
      const loaded = retiredStatus();
      if (state === 'deleted') loaded.payload.catalog.sources = [];
      if (state === 'inactive') delete loaded.payload.catalog.sources[0]!.freshness;
      if (state === 'error') loaded.payload.catalog.sources[0]!.errorCode = 'catalogReadFailed';
      if (state === 'invalidActive') loaded.catalogGenerations![0]!.state = 'repairRequired';
      if (state === 'unchecked') delete loaded.retirementSourceChecks;
      if (state === 'staleCheck') loaded.retirementSourceChecks = { official: 'previous-store' };
      const current = retiredRecovery('project');
      current.extraObserved = [{ pluginId: 'official/extra', agent: null, scope: 'project',
        delivery: null, observation: 'unknown' }];
      if (state === 'listed') loaded.pluginSummaries = ['demo', 'extra'].map((pluginName) => ({
        pluginId: `official/${pluginName}`, pluginName, displayName: pluginName, description: '',
      }));
      const model = buildTuiViewModel({ status: loaded.payload, pluginSummaries: loaded.pluginSummaries,
        residualPluginIds: ['official/demo', 'official/extra'],
        retirementSourceChecks: loaded.retirementSourceChecks,
        catalogGenerations: new Map(loaded.catalogGenerations!.map((source) => [source.sourceId, source])) });
      const inventory = buildScopedInventory({ recovery: current, status: loaded.payload,
        pluginSummaries: loaded.pluginSummaries,
        retirementSourceChecks: loaded.retirementSourceChecks,
        catalogGenerations: new Map(loaded.catalogGenerations!.map((source) => [source.sourceId, source])) });
      expect(model.plugins).toHaveLength(2);
      expect(inventory.declaredRoots).toHaveLength(1);
      expect(inventory.extraInstalledRoots).toHaveLength(1);
      for (const plugin of [...model.plugins, ...inventory.declaredRoots, ...inventory.extraInstalledRoots]) {
        expect(plugin.retirementCandidate === true).toBe(state === 'healthy');
        expect(plugin.sourceUnavailable === true).toBe(state !== 'healthy' && state !== 'listed');
      }
    });

  // Test Value Gate: selecting the scope is a user decision, not a target heuristic;
  // detail must retire all discovered targets without routing to single-target cleanup/uninstall.
  it.each(['single', 'dual', 'configOnly'] as const)('routes %s retired detail to the correct Review request', async (mode) => {
    const loaded = retiredStatus();
    loaded.scopedRecovery = {};
    if (mode !== 'configOnly') {
      const project = retiredRecovery('project');
      project.existingTargets = [{ pluginId: 'official/demo', agent: 'copilot', scope: 'project' }];
      project.extraObserved = [{ pluginId: 'official/demo', agent: 'copilot', scope: 'project',
        delivery: { kind: 'native', platform: 'copilot' }, observation: 'verified', content: 'satisfied' }];
      project.inventory = [];
      loaded.scopedRecovery.project = project;
      if (mode === 'dual') loaded.scopedRecovery.user = retiredRecovery('user');
    } else loaded.configStoreInventory = [{ pluginId: 'official/demo', pluginName: 'demo', sourceId: 'official', scope: 'user' }];
    const prepareScopedTask = vi.fn().mockRejectedValue(new Error('prepareStopped'));
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(),
      loadStatus: async () => loaded, prepareScopedTask });
    await controller.load();
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 100, rows: 40 }} />);
    await tick();
    const frame = instance.lastFrame() ?? '';
    expect(frame).not.toContain('恢复插件来源');
    expect(frame).not.toContain('卸载');
    await focusAction(instance, mode === 'configOnly' ? '清理已删除插件并删除设置' : '清理已删除插件');
    await press(instance, '\r');
    if (mode === 'dual') {
      expect(instance.lastFrame()).toContain('选择清理范围');
      expect(prepareScopedTask).not.toHaveBeenCalled();
      await press(instance, '\u001b[B');
      await press(instance, '\r');
    }
    expect(prepareScopedTask).toHaveBeenCalledWith({ kind: 'retire', scope: mode === 'configOnly' ? 'user' : 'project',
      selector: 'official/demo', deleteConfig: mode === 'configOnly' }, expect.anything());
    instance.unmount();
    controller.dispose();
  });

  // Test Value Gate: extra installations are retained in all source states; only a confirmed
  // removed entry gets the retirement action. The same page still permits opening details.
  it.each(['healthy', 'listed', 'deleted'] as const)('routes a %s extra installation from inventory', async (state) => {
    const loaded = retiredStatus();
    if (state === 'listed') loaded.pluginSummaries = status.pluginSummaries;
    if (state === 'deleted') loaded.payload.catalog.sources = [];
    const current = retiredRecovery('user');
    current.inventory = [];
    current.extraObserved = [{ pluginId: 'official/demo', agent: null, scope: 'user', delivery: null, observation: 'unknown' }];
    const prepareScopedTask = vi.fn().mockRejectedValue(new Error('prepareStopped'));
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: async () => loaded,
      loadScopedStatus: async () => current, prepareScopedTask });
    await controller.load();
    controller.push({ name: 'intentInventory', scope: 'user' }, { inventorySection: 'extraInstalled' });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 100, rows: 40 }} />);
    await tick();
    expect(controller.listScopedInventoryRoots('user', 'extraInstalled')).toHaveLength(1);
    expect(instance.lastFrame()?.includes('停用已移除插件（保留设置）')).toBe(state === 'healthy');
    if (state === 'healthy') {
      await focusAction(instance, '停用已移除插件（保留设置）');
      await press(instance, '\r');
      expect(prepareScopedTask).toHaveBeenCalledWith({ kind: 'retire', scope: 'user',
        selector: 'official/demo', deleteConfig: false }, expect.anything());
    } else {
      await press(instance, '\r');
      expect(controller.snapshot.router.current.route).toMatchObject({ name: 'pluginDetail', pluginId: 'official/demo' });
      expect(prepareScopedTask).not.toHaveBeenCalled();
    }
    instance.unmount();
    controller.dispose();
  });

  // Test Value Gate: a no-package Claude local-only follow-up must not claim a shared package
  // deletion; a real shared registration withdrawal is disclosed even without a package.
  it('discloses only the shared retirement effects that are actually frozen', () => {
    const local = retirementDeployment('project', [{ kind: 'unregister', nativeScope: 'local', destination: '/market' }], 'claude');
    const shared = retirementDeployment('project', [{ kind: 'unregister', nativeScope: 'user', destination: '/market' }], 'claude');
    expect(deploymentPlanLines([local]).join('\n')).not.toMatch(/删除共享插件包|撤销共享原生登记/);
    const sharedText = deploymentPlanLines([shared]).join('\n');
    expect(sharedText).toContain('撤销共享原生登记');
    expect(sharedText).not.toMatch(/删除共享插件包|保留其他使用位置/);
  });

  it('offers sync on the declared Project root when a usable personal dependency has an old Project copy', () => {
    const pluginId = 'official/demo';
    const provider = 'official/dependency';
    const duplicate = { code: 'projectSkillDuplicatePending', pluginId: provider, message: 'Sync the Project plugin.' };
    const target = { pluginId, agent: 'opencode' as const, scope: 'project' as const,
      delivery: { kind: 'native' as const, platform: 'opencode' as const },
      execution: 'not-run' as const, observation: 'verified' as const, content: 'satisfied' as const,
      requiredBy: [pluginId], blockers: [], reasons: [duplicate] };
    const view = buildScopedInventory({ status: status.payload, pluginSummaries: status.pluginSummaries,
      recovery: { ...recovery('project'), selection: { agents: ['opencode'], preferences: 'valid' },
        inventory: [{ pluginId, source: 'official', sourceState: 'ready', blockers: [], targetResults: [target] }],
        extraObserved: [{ ...target, pluginId: provider }] } });
    expect(view.declaredRoots[0]).toMatchObject({ pluginId, state: 'pending', targets: [{ reasonCodes: [duplicate.code] }] });
    expect(view.extraInstalledRoots.find((item) => item.pluginId === provider)).toMatchObject({ state: 'pending' });
    expect(view.syncTargets).toEqual([{ pluginId, agent: 'opencode', scope: 'project' }]);
  });

  // Test Value Gate: a verified generic Skills target must show the same health in inventory and detail cards.
  it.each([
    { observation: 'verified', content: 'satisfied', state: 'ready', label: '可用', actual: true },
    { observation: 'unknown', content: 'drifted', state: 'pending', label: '待同步', actual: true },
    { observation: 'unknown', content: 'unknown', state: 'unknown', label: '未确认', actual: false },
    { observation: 'unknown', content: 'conflict', state: 'blocked', label: '受阻', actual: false },
  ] as const)('projects generic Skills $content through recovery, inventory, detail and Ink', (caseValue) => {
    const pluginId = 'official/demo';
    const recoveryStatus: ScopedInventoryLoadResult = { ...recovery('user'),
      selection: { agents: ['generic'], preferences: 'valid' },
      inventory: [{ pluginId, source: 'official', sourceState: 'ready', blockers: [], targetResults: [{
        pluginId, agent: 'generic', scope: 'user',
        delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' },
        execution: 'not-run', observation: caseValue.observation, content: caseValue.content,
        blockers: [], requiredBy: [pluginId],
      }] }],
    };
    const inventory = buildScopedInventory({ recovery: recoveryStatus, status: status.payload,
      pluginSummaries: status.pluginSummaries });
    const model = buildTuiViewModel({ status: status.payload, pluginSummaries: status.pluginSummaries });
    const subject = buildPluginDetailSubject({ pluginId, status: status.payload,
      pluginSummaries: status.pluginSummaries, plugins: model.plugins,
      scopedInventories: { user: inventory } });
    expect(subject?.placements).toEqual([expect.objectContaining({
      agent: 'generic', delivery: 'agent-skills', projectState: caseValue.state,
      observation: caseValue.state === 'ready' || caseValue.content === 'drifted'
        || caseValue.content === 'absent' ? 'known' : 'unknown', actual: caseValue.actual,
    })]);
    const rootFrame = render(<ProjectRootCard root={inventory.declaredRoots[0]!} subject={subject!}
      width={80} focused />).lastFrame() ?? '';
    const detailFrame = render(<PluginDetailCard subject={subject!} width={80} />).lastFrame() ?? '';
    expect(rootFrame).toContain(caseValue.label);
    expect(detailFrame).toContain(caseValue.label);
    if (caseValue.state === 'ready') {
      expect(rootFrame).not.toContain('[? 未确认]');
      expect(detailFrame).not.toContain('[? 未确认]');
    }
  });

  it('keeps a generic Skills location through satisfied, drifted and satisfied observations but omits absence', () => {
    const pluginId = 'official/demo';
    for (const [observation, content, actual] of [
      ['verified', 'satisfied', true], ['unknown', 'drifted', true],
      ['verified', 'satisfied', true], ['missing', 'absent', false],
    ] as const) {
      const recoveryStatus: ScopedInventoryLoadResult = { ...recovery('project'),
        selection: { agents: ['generic'], preferences: 'valid' },
        inventory: [{ pluginId, source: 'official', sourceState: 'ready', blockers: [], targetResults: [{
          pluginId, agent: 'generic', scope: 'project',
          delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' },
          execution: 'not-run', observation, content, blockers: [], requiredBy: [pluginId],
        }] }],
      };
      const inventory = buildScopedInventory({ recovery: recoveryStatus, status: status.payload,
        pluginSummaries: status.pluginSummaries });
      expect(inventory.declaredRoots[0]?.targets[0]?.actual).toBe(actual);
      const model = buildTuiViewModel({ status: status.payload, pluginSummaries: status.pluginSummaries });
      const detail = buildPluginDetailSubject({ pluginId, status: status.payload,
        pluginSummaries: status.pluginSummaries, plugins: model.plugins,
        scopedInventories: { project: inventory } });
      expect(detail?.placements.filter((placement) => placement.agent === 'generic')).toHaveLength(actual ? 1 : 0);
      if (actual) expect(detail?.placements[0]?.projectState).toBe(content === 'drifted' ? 'pending' : 'ready');
    }
  });

  it('shows a project card reason and keeps its complete code and plugin ID in technical details', async () => {
    const current = recovery('project');
    current.inventory![0]!.targetResults[0] = {
      ...current.inventory![0]!.targetResults[0]!,
      observation: 'unknown', content: 'conflict',
      blockers: [{ code: 'targetPlacementConflict', message: '/private/project-card-conflict' }],
    };
    const prepareScopedTask = vi.fn();
    const executeScopedTask = vi.fn();
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(),
      loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn().mockResolvedValue(current), prepareScopedTask, executeScopedTask });
    await controller.load();
    controller.push({ name: 'intentInventory', scope: 'project', projectKey: '/tmp/project' });
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[1]!} />);
    await tick();
    let summary = checkedFrame(instance, sizes[1]!);
    for (let step = 0; step < 8 && !summary.includes('Agent 目录冲突'); step += 1) {
      await press(instance, '\u001b[B');
      summary += `\n${checkedFrame(instance, sizes[1]!)}`;
    }
    expect(summary).toContain('Agent 目录冲突');
    expect(summary).not.toContain('targetPlacementConflict');
    expect(summary).not.toContain('/private/project-card-conflict');
    await press(instance, 'd');
    expect(checkedFrame(instance, sizes[1]!)).toContain('清单安全详情');
    const details = await readScopedPages(instance, sizes[1]!);
    expect(details).toContain('official/demo');
    expect(details).toContain('targetPlacementConflict');
    expect(details).not.toContain('/private/project-card-conflict');
    expect(prepareScopedTask).not.toHaveBeenCalled();
    expect(executeScopedTask).not.toHaveBeenCalled();
    instance.unmount();
    controller.dispose();
  });

  it.each(sizes)('selects one scope and keeps its inventory within $columns x $rows', async (size) => {
    const loadScopedStatus = vi.fn(async (scope: 'user' | 'project') => recovery(scope));
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status), loadScopedStatus });
    await controller.load();
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await tick();
    expect(checkedFrame(instance, size)).toContain('项目插件');
    controller.push({ name: 'intentScopes' });
    await tick();
    expect(checkedFrame(instance, size)).toContain('个人');
    instance.stdin.write('\r');
    await tick();
    expect(controller.snapshot.router.current.route).toMatchObject({ name: 'intentInventory', scope: 'user' });
    expect(loadScopedStatus).toHaveBeenCalledWith('user', expect.anything());
    expect(loadScopedStatus).not.toHaveBeenCalledWith('project', expect.anything());
    const frame = checkedFrame(instance, size);
    expect(frame).toContain('个人清单');
    expect(frame).toContain('Demo');
    expect(frame).toContain('待同步');
    instance.unmount();
  });

  // Test Value Gate: session cancellation must invalidate a delayed local inventory refresh without replacing its snapshot or preparing Review.
  it('cancels an Ink inventory refresh and ignores its delayed observation', async () => {
    let finish: ((value: ScopedInventoryLoadResult) => void) | undefined;
    let refreshSignal: AbortSignal | undefined;
    const loadScopedStatus = vi.fn().mockResolvedValueOnce(recovery('user')).mockImplementationOnce(
      async (_scope: 'user' | 'project', signal: AbortSignal) => {
        refreshSignal = signal;
        return new Promise<ScopedInventoryLoadResult>((resolve) => { finish = resolve; });
      });
    const prepareScopedTask = vi.fn();
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status), loadScopedStatus,
      prepareScopedTask });
    await controller.load();
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
    controller.push({ name: 'intentScopes' });
    await tick();
    await press(instance, '\r');
    const previous = controller.snapshot.scopedInventories.user;
    await press(instance, 'r');
    await vi.waitFor(() => expect(loadScopedStatus).toHaveBeenCalledTimes(2));
    expect(controller.snapshot.scopedInventoryRefresh.user).toEqual({ state: 'checking' });
    const cancelled = controller.cancelAndWaitForReads();
    expect(refreshSignal?.aborted).toBe(true);
    finish!({ ...recovery('user'), inventory: [] });
    expect(await cancelled).toBe(true);
    await tick();
    expect(controller.snapshot.scopedInventories.user).toEqual(previous);
    expect(controller.snapshot.router.current.route).toEqual({ name: 'intentInventory', scope: 'user' });
    expect(checkedFrame(instance, sizes[0]!)).toContain('Demo');
    expect(prepareScopedTask).not.toHaveBeenCalled();
    instance.unmount();
    controller.dispose();
  });

  it('opens the same scoped detail from both inventories, the library, and the dependency graph', async () => {
    const loaded: TuiStatusLoadResult = { ...status, dependencyOverviews: [{
      pluginId: 'official/demo',
      summary: { directCount: 0, transitiveCount: 0, dependentCount: 0, blockedCount: 0 },
      dependencies: [], dependents: [], blockers: [],
    }] };
    const prepareScopedTask = vi.fn().mockRejectedValue(new Error('stopped before write'));
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(loaded),
      loadScopedStatus: vi.fn(async (scope: 'user' | 'project') => {
        const value = recovery(scope);
        if (scope === 'project') value.selection.agents = [];
        return value;
      }), prepareScopedTask });
    await controller.load();
    expect(await controller.refreshScopedInventory('user')).toBe(true);
    expect(await controller.refreshScopedInventory('project')).toBe(true);
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
    await tick();

    const detailFacts: Array<ReturnType<TuiController['getPluginDetailSubject']>> = [];
    const enterAndReturn = async (route: Parameters<TuiController['push']>[0], query?: string) => {
      controller.push(route);
      await tick();
      if (query) {
        await press(instance, '/');
        await press(instance, '\u0015');
        await press(instance, query);
        await press(instance, '\r');
      }
      if (route.name === 'intentInventory') {
        for (let index = 0; index < 12 && !checkedFrame(instance, sizes[0]!).includes('› Demo'); index += 1) {
          await press(instance, '\u001b[A');
        }
        const before = checkedFrame(instance, sizes[0]!);
        if (!before.includes('› Demo')) throw new Error(`inventory focus before Enter: ${before}`);
      } else {
        for (let index = 0; index < 12; index += 1) await press(instance, '\u001b[A');
      }
      const originContext = structuredClone(controller.snapshot.router.current.context);
      const originFrame = checkedFrame(instance, sizes[0]!);
      await press(instance, '\r');
      if (controller.snapshot.router.current.route.name !== 'pluginDetail') {
        throw new Error(`failed to open detail from ${route.name}: ${checkedFrame(instance, sizes[0]!)}`);
      }
      expect(controller.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/demo' });
      const subject = controller.getPluginDetailSubject('official/demo');
      expect(subject?.declarations).toMatchObject({
        user: { state: 'declared', targets: 'selected', agents: ['codex'] },
        project: { state: 'declared', targets: 'empty', agents: [] },
      });
      detailFacts.push(subject);
      const detail = checkedFrame(instance, sizes[0]!);
      expect(detail).toContain('Demo');
      expect(detail).toContain('所有项目');
      expect(detail).toContain('当前项目');
      expect(detail).toContain('待安装');
      await press(instance, '\u001b');
      expect(controller.snapshot.router.current.route).toEqual(route);
      expect(controller.snapshot.router.current.context).toMatchObject(originContext);
      expect(controller.snapshot.router.current.context.focusIndex).toBe(0);
      expect(controller.snapshot.router.current.context.scrollOffset).toBe(0);
      if (query) expect(controller.snapshot.router.current.context.query).toBe(query);
      expect(checkedFrame(instance, sizes[0]!)).toBe(originFrame);
    };

    await enterAndReturn({ name: 'intentInventory', scope: 'user' }, 'Demo');
    await enterAndReturn({ name: 'intentInventory', scope: 'project', projectKey: '/tmp/project' }, 'Demo');
    await enterAndReturn({ name: 'pluginList', mode: 'browse' }, 'Demo');
    await enterAndReturn({ name: 'pluginDependencies', pluginId: 'official/demo' });
    expect(detailFacts).toHaveLength(4);
    for (const subject of detailFacts.slice(1)) expect(subject).toEqual(detailFacts[0]);

    controller.push({ name: 'intentInventory', scope: 'user' });
    await tick();
    await press(instance, '\r');
    await focusAction(instance, '移出插件清单（保留安装）');
    await press(instance, '\r');
    expect(checkedFrame(instance, sizes[0]!)).toContain('选择要移出的清单');
    await focusAction(instance, '当前项目');
    await press(instance, '\r');
    await vi.waitFor(() => expect(prepareScopedTask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'intent', action: 'remove', scope: 'project',
        selector: 'official/demo' }), expect.anything()));
    instance.unmount();
  });

  it.each(['removed', 'unknown', 'conflict'] as const)('refreshes current Native evidence after an extra installation becomes %s', async (change) => {
    const native = { pluginId: 'official/extra', pluginName: 'extra', sourceId: 'official',
      sourceIdentity: 'source', platform: 'claude' as const, scope: 'user' as const,
      cwd: '/tmp/project', version: '2.0.0', state: 'ready' as const,
      components: [{ kind: 'ownership' as const, key: 'extra', state: 'present' }],
      reasons: [], recoveryActions: [] };
    const initial: TuiStatusLoadResult = { ...status, pluginSummaries: [...status.pluginSummaries,
      { pluginId: native.pluginId, pluginName: 'extra', displayName: 'Current Extra', description: 'Extra', version: '2.0.0' }],
      payload: { ...status.payload, targets: [] }, targetRevisions: [] };
    let current: ScopedInventoryLoadResult = { ...recovery('user'), dependencyOverviews: [],
      existingTargets: [{ pluginId: native.pluginId, agent: 'claude', scope: 'user' }],
      extraObserved: [{ pluginId: native.pluginId, agent: 'claude', scope: 'user',
        delivery: { kind: 'native', platform: 'claude' }, observation: 'verified', content: 'satisfied',
        expectedVersion: '2.0.0', installedVersion: '2.0.0' }] };
    initial.scopedRecovery = { user: current };
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(initial),
      loadScopedStatus: vi.fn(async () => current), loadPluginContent: vi.fn().mockRejectedValue(new Error('unavailable')) });
    await controller.load();
    await controller.refreshScopedInventory('user');
    expect(controller.listScopedInventoryRoots('user', 'extraInstalled')[0]?.displayName).toBe('Current Extra');
    expect(controller.listScopedInventoryRoots('user', 'extraInstalled')[0]?.targets[0])
      .toMatchObject({ installedVersion: '2.0.0', state: 'ready' });
    if (change === 'removed') current = { ...current, extraObserved: [], existingTargets: [] };
    else current = { ...current,
      existingTargets: [], extraObserved: [{ ...current.extraObserved![0]!, observation: 'unknown', content: change, installedVersion: undefined }] };
    await controller.refreshScopedInventory('user');
    const expected = change === 'removed' ? [] : [expect.objectContaining({
      state: change === 'conflict' ? 'blocked' : 'unknown',
    })];
    expect(controller.listScopedInventoryRoots('user', 'extraInstalled')).toEqual(expected);
    await controller.loadPluginContent('official/demo');
    expect(controller.listScopedInventoryRoots('user', 'extraInstalled')).toEqual(expected);
    if (change !== 'removed') expect(controller.listScopedInventoryRoots('user', 'extraInstalled')[0]?.targets[0]).not.toHaveProperty('installedVersion');
    expect(controller.snapshot.scopedInventoryRefresh.user?.state).toBe('idle');
    controller.dispose();
  });

  it('does not let delayed failure logging replace a newer scoped refresh', async () => {
    let releaseLog!: () => void;
    const logError = vi.fn(() => new Promise<void>((resolve) => { releaseLog = resolve; }));
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status), logError,
      loadScopedStatus: vi.fn().mockRejectedValueOnce(new Error('oldFailure')).mockResolvedValue(recovery('user')) });
    await controller.load();
    const old = controller.refreshScopedInventory('user');
    await vi.waitFor(() => expect(logError).toHaveBeenCalledOnce());
    expect(await controller.refreshScopedInventory('user')).toBe(true);
    releaseLog();
    expect(await old).toBe(false);
    expect(controller.snapshot.scopedInventoryRefresh.user?.state).toBe('idle');
    controller.dispose();
  });

  it('keeps the previous snapshot when local refresh fails', async () => {
    const loadScopedStatus = vi.fn().mockResolvedValueOnce(recovery('user'))
      .mockRejectedValueOnce(new Error('refreshFailed'));
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status), loadScopedStatus });
    await controller.load();
    expect(await controller.refreshScopedInventory('user')).toBe(true);
    const before = controller.listScopedInventoryRoots('user');
    expect(await controller.refreshScopedInventory('user')).toBe(false);
    expect(controller.listScopedInventoryRoots('user')).toEqual(before);
    expect(controller.snapshot.scopedInventoryRefresh.user?.state).toBe('error');
  });

  it('retains Native reasons, versions, and a verified shared User dependency', () => {
    const recoveryStatus = recovery('project');
    const rootId = 'official/demo';
    const dependencyId = 'official/base';
    const projected = buildScopedInventory({
      recovery: recoveryStatus,
      status: { ...status.payload, targets: [
        { pluginId: rootId, pluginName: 'demo', sourceId: 'official', sourceIdentity: 'source',
          platform: 'claude', scope: 'project', cwd: '/tmp/project', version: '1.2.0', state: 'needsSync',
          components: [{ kind: 'intent', key: 'desired', state: 'desired', metadata: {
            enabled: true, scopes: ['project'], relation: 'root',
          } }, { kind: 'dependency', key: dependencyId, state: 'ready', metadata: { scope: 'user' } }],
          reasons: [{ code: 'contentDrift', message: 'drift', severity: 'warning' }], recoveryActions: [] },
        { pluginId: dependencyId, pluginName: 'base', sourceId: 'official', sourceIdentity: 'source',
          platform: 'claude', scope: 'user', cwd: '/tmp/project', version: '1.0.0', state: 'ready',
          components: [{ kind: 'ownership', key: 'base', state: 'present' }],
          reasons: [], recoveryActions: [] },
      ] },
      pluginSummaries: [],
      targetRevisions: [{ pluginId: rootId, platform: 'claude', scope: 'project',
        revision: { state: 'upgradeAvailable', availableVersion: '1.2.0', installedVersion: '1.1.0' } }],
      dependencyOverviews: [{ pluginId: rootId,
        summary: { directCount: 1, transitiveCount: 1, dependentCount: 0, blockedCount: 0 },
        dependencies: [{ pluginId: dependencyId, displayName: 'base', relation: 'direct', depth: 1,
          requiredBy: [], placements: [], aggregateStatus: 'ready' }], dependents: [], blockers: [] }],
    });
    const root = projected.declaredRoots[0]!;
    expect(root.targets).toEqual(expect.arrayContaining([expect.objectContaining({
      platform: 'claude', scope: 'project', expectedVersion: '1.2.0', installedVersion: '1.1.0',
      reasonCodes: expect.arrayContaining(['contentDrift']),
    })]));
    expect(root.dependencies[0]?.targets).toEqual([expect.objectContaining({
      platform: 'claude', scope: 'user', location: 'sharedUser', state: 'ready',
    })]);
    expect(projected.extraInstalledRoots).toEqual([]);
  });

  it('refreshes shared User dependency evidence while preserving the other inventory', async () => {
    const project = recovery('project');
    project.inventory![0]!.targetResults = [{ pluginId: 'official/demo', agent: 'claude', scope: 'project',
      delivery: { kind: 'native', platform: 'claude' }, execution: 'not-run', observation: 'unknown', content: 'drifted',
      blockers: [], requiredBy: ['official/demo'], expectedVersion: '2.0.0', installedVersion: '1.0.0' }];
    project.existingTargets = [{ pluginId: 'official/demo', agent: 'claude', scope: 'project' },
      { pluginId: 'official/base', agent: 'claude', scope: 'user' }];
    project.observedTargets = [{ pluginId: 'official/base', agent: 'claude', scope: 'user', providerScope: 'user',
      delivery: { kind: 'native', platform: 'claude' }, execution: 'not-run', observation: 'verified', content: 'satisfied',
      blockers: [], requiredBy: ['official/demo'], relation: 'dependency',
      contributions: [{ root: 'official/demo', scope: 'project', path: ['official/demo', 'official/base'] }] }];
    project.dependencyOverviews = [{ pluginId: 'official/demo',
      summary: { directCount: 1, transitiveCount: 0, totalCount: 1, readyCount: 1, missingCount: 0, issueCount: 0 },
      dependencies: [{ pluginId: 'official/base', displayName: 'Base', relation: 'direct', depth: 1,
        requiredBy: [], placements: [], aggregateStatus: 'ready' }], dependents: [], blockers: [] }];
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn(async (scope: 'user' | 'project') => scope === 'project' ? project : recovery('user')) });
    await controller.load();
    await controller.refreshScopedInventory('user');
    const user = controller.snapshot.scopedInventories.user;
    await controller.refreshScopedInventory('project');
    const root = controller.listScopedInventoryRoots('project')[0]!;
    expect(root.targets).toContainEqual(expect.objectContaining({ platform: 'claude',
      installedVersion: '1.0.0', expectedVersion: '2.0.0' }));
    expect(root.dependencies[0]?.targets).toEqual([{ platform: 'claude', scope: 'user',
      location: 'sharedUser', state: 'ready', reasonCodes: [], agent: 'claude', delivery: 'native', observation: 'known', actual: true }]);
    expect(controller.getPluginDetailSubject('official/base')?.placements).toEqual([expect.objectContaining({
      scope: 'user', sharedWithCurrentProject: true, actual: true, observation: 'known', projectState: 'ready',
    })]);
    project.observedTargets![0]!.content = 'unknown';
    project.observedTargets![0]!.observation = 'unknown';
    project.existingTargets = project.existingTargets!.filter((entry) => entry.pluginId !== 'official/base');
    await controller.refreshScopedInventory('project');
    expect(controller.listScopedInventoryRoots('project')[0]?.dependencies[0]?.targets[0]?.state).toBe('unknown');
    expect(controller.snapshot.scopedInventories.user).toEqual(user);
    expect(controller.getPluginDetailSubject('official/base')?.placements[0]).toMatchObject({
      actual: false, observation: 'unknown', projectState: 'unknown',
    });
    await controller.refreshScopedInventory('user');
    expect(controller.getPluginDetailSubject('official/base')?.placements).toEqual([]);
    controller.dispose();
  });

  it.each(sizes)('keeps selection and search inside one scope at $columns x $rows', async (size) => {
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn(async (scope: 'user' | 'project') => recovery(scope)) });
    await controller.load();
    controller.push({ name: 'intentInventory', scope: 'user' });
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await tick();
    await press(instance, ' ');
    expect(checkedFrame(instance, size)).toContain('已选 1');
    await press(instance, '/');
    await press(instance, 'no-match');
    await press(instance, '\r');
    expect(controller.snapshot.router.current.context.query).toBe('no-match');
    expect(checkedFrame(instance, size)).toContain('隐藏已选 1');
    const beforeRefresh = controller.snapshot.router.current.context;
    await press(instance, 'r');
    expect(controller.snapshot.router.current.context).toEqual(beforeRefresh);
    expect(checkedFrame(instance, size)).toContain('隐藏已选 1');
    controller.push({ name: 'intentInventory', scope: 'project', projectKey: '/tmp/project' });
    await tick();
    expect(controller.snapshot.router.current.context.query ?? '').toBe('');
    expect(checkedFrame(instance, size)).not.toContain('已选 1');
    controller.back();
    await tick();
    expect(controller.snapshot.router.current.context.query).toBe('no-match');
    expect(checkedFrame(instance, size)).toContain('隐藏已选 1');
    instance.unmount();
  });

  it('keeps unknown separate from retry and does not invent targets without local agents', () => {
    const current = recovery('user');
    current.selection.agents = [];
    current.inventory![0]!.targetResults = [];
    current.inventory![0]!.blockers = [{ code: 'localTargetsRequired', message: 'choose agents' }];
    current.extraObserved = [{ pluginId: 'official/extra', agent: 'codex', scope: 'user',
      delivery: { kind: 'native', platform: 'codex' }, observation: 'unknown', content: 'unknown' }];
    const projected = buildScopedInventory({ recovery: current, status: status.payload,
      pluginSummaries: [] });
    expect(projected.declaredRoots[0]).toMatchObject({ state: 'blocked', targets: [] });
    expect(projected.syncTargets).toEqual([]);
    expect(projected.extraInstalledRoots[0]).toMatchObject({ pluginId: 'official/extra',
      state: 'unknown' });
  });

  it('submits only the pending unblocked plugin and Agent pairs for syncable inventory', async () => {
    const current = recovery('user');
    current.selection.agents = ['codex', 'generic'];
    current.inventory = [
      { pluginId: 'official/ready', source: 'official', sourceState: 'ready', blockers: [],
        targetResults: [{ pluginId: 'official/ready', agent: 'codex', scope: 'user',
          delivery: { kind: 'native', platform: 'codex' }, execution: 'not-run',
          observation: 'verified', content: 'satisfied', blockers: [], requiredBy: [] }] },
      { pluginId: 'official/pending', source: 'official', sourceState: 'ready', blockers: [],
        targetResults: [{ pluginId: 'official/pending', agent: 'generic', scope: 'user',
          delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' }, execution: 'not-run',
          observation: 'missing', content: 'absent', blockers: [], requiredBy: [] }] },
      { pluginId: 'official/blocked', source: 'official', sourceState: 'ready', blockers: [],
        targetResults: [{ pluginId: 'official/blocked', agent: 'codex', scope: 'user',
          delivery: { kind: 'native', platform: 'codex' }, execution: 'not-run',
          observation: 'missing', content: 'absent',
          blockers: [{ code: 'conflict', message: 'blocked' }], requiredBy: [] }] },
      { pluginId: 'official/mixed', source: 'official', sourceState: 'ready', blockers: [],
        targetResults: [
          { pluginId: 'official/mixed', agent: 'codex', scope: 'user',
            delivery: { kind: 'native', platform: 'codex' }, execution: 'not-run',
            observation: 'verified', content: 'satisfied', blockers: [], requiredBy: [] },
          { pluginId: 'official/mixed', agent: 'generic', scope: 'user',
            delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' }, execution: 'not-run',
            observation: 'missing', content: 'absent', blockers: [], requiredBy: [] },
        ] },
    ];
    const receipt = { requestedRoots: ['official/pending', 'official/mixed'],
      selection: { agents: ['generic'] }, targetResults: [], blockers: [], errors: [] };
    const plan = { kind: 'recovery', scope: 'user', plan: { receipt,
      plannedImpact: { declaration: false, preferences: false, config: false, outputs: true },
      changes: [], warnings: [], context: { dispose: async () => {} }, sourceRefreshes: [],
      nativeGroups: [], portableGroups: [],
    } } as unknown as ScopedTuiPlan;
    const prepareScopedTask = vi.fn().mockResolvedValue(plan);
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn().mockResolvedValue(current), prepareScopedTask });
    await controller.load();
    expect(buildScopedInventory({ recovery: current, status: status.payload,
      pluginSummaries: status.pluginSummaries }).syncTargets).toEqual([
      { pluginId: 'official/pending', agent: 'generic', scope: 'user' },
      { pluginId: 'official/mixed', agent: 'generic', scope: 'user' },
    ]);
    controller.push({ name: 'intentInventory', scope: 'user' });
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
    await tick();
    await press(instance, 'c');
    await vi.waitFor(() => expect(prepareScopedTask).toHaveBeenCalledTimes(1));
    expect(prepareScopedTask.mock.calls[0]?.[0]).toMatchObject({
      kind: 'recovery', scope: 'user', selectors: ['official/pending', 'official/mixed'],
      targets: ['generic'], exactTargets: [
        { pluginId: 'official/pending', agent: 'generic' },
        { pluginId: 'official/mixed', agent: 'generic' },
      ],
    });
    instance.unmount();
  });

  it('keeps Native and generic Skills Agent identities separate in inventory and unified detail', async () => {
    const current = recovery('user');
    current.selection.agents = ['codex', 'generic'];
    current.inventory![0]!.targetResults = [
      { pluginId: 'official/demo', agent: 'codex', scope: 'user',
        delivery: { kind: 'native', platform: 'codex' }, execution: 'not-run',
        observation: 'verified', content: 'satisfied', blockers: [], requiredBy: [] },
      { pluginId: 'official/demo', agent: 'generic', scope: 'user',
        delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' }, execution: 'not-run',
        observation: 'verified', content: 'satisfied', blockers: [], requiredBy: [] },
    ];
    current.extraObserved = [{ pluginId: 'official/extra', agent: 'generic', scope: 'user',
      delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' },
      observation: 'verified', content: 'satisfied' }];
    const loaded = { ...status, pluginSummaries: [...status.pluginSummaries,
      { pluginId: 'official/extra', pluginName: 'extra', displayName: 'Extra', version: '1.0.0' }] };
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(loaded),
      loadScopedStatus: vi.fn().mockResolvedValue(current) });
    await controller.load();
    expect(await controller.refreshScopedInventory('user')).toBe(true);
    const root = controller.listScopedInventoryRoots('user')[0]!;
    expect(root.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'codex', agent: 'codex', delivery: 'native', state: 'ready' }),
      expect.objectContaining({ agent: 'generic', delivery: 'agent-skills', state: 'ready' }),
    ]));
    expect(root.targets.find((target) => target.agent === 'generic')?.platform).toBeUndefined();
    const placements = controller.getPluginDetailSubject('official/demo')?.placements ?? [];
    expect(placements).toEqual(expect.arrayContaining([
      expect.objectContaining({ platform: 'codex', agent: 'codex', delivery: 'native' }),
      expect.objectContaining({ agent: 'generic', delivery: 'agent-skills' }),
    ]));
    expect(placements.find((placement) => placement.agent === 'generic')?.platform).toBeUndefined();
    const extra = controller.listScopedInventoryRoots('user', 'extraInstalled')[0]!;
    expect(extra.targets[0]).toMatchObject({ agent: 'generic', delivery: 'agent-skills', state: 'ready' });
    expect(extra.targets[0]?.platform).toBeUndefined();
    expect(controller.getPluginDetailSubject('official/extra')?.placements[0]).toMatchObject({
      agent: 'generic', delivery: 'agent-skills', platformLabel: 'Generic',
    });
    controller.dispose();
  });

  it('guards a changed targets draft and keeps retirement config deletion opt-in', async () => {
    const current = retiredRecovery('project');
    const prepareScopedTask = vi.fn().mockRejectedValue(new Error('prepareStopped'));
    const previewAgentSettings = vi.fn(async () => ({ blocked: false, reasons: [], conflicts: [], counts: {} }));
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(retiredStatus()),
      loadScopedStatus: vi.fn().mockResolvedValue(current), prepareScopedTask, previewAgentSettings });
    await controller.load();
    controller.push({ name: 'intentInventory', scope: 'project', projectKey: '/tmp/project' });
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
    await tick();
    await focusAction(instance, '停用已移除插件（保留设置）');
    await press(instance, '\r');
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({ kind: 'retire',
      scope: 'project', selector: 'official/demo', deleteConfig: false }), expect.anything());
    await escape(instance);
    await focusAction(instance, 'Agent 管理');
    await press(instance, '\r');
    // Wait for the actual Agent settings preview, not merely the first frame.
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('◆ 已选 2 个'));
    await focusAction(instance, '◆ Codex');
    await press(instance, '\r');
    await vi.waitFor(() => {
      expect(instance.lastFrame()).toContain('› ◇ Codex');
      expect(instance.lastFrame()).toContain('◆ 已选 1 个');
    });
    expect(previewAgentSettings).toHaveBeenCalledWith(expect.objectContaining({ targets: ['claude'] }), undefined);
    await escape(instance);
    expect(checkedFrame(instance, sizes[0]!)).toContain('还有未保存的修改');
    expect(prepareScopedTask).toHaveBeenCalledTimes(1);
    instance.unmount();
    controller.dispose();
  });

  it('retries only two irregular failed pairs and checks unknown targets separately', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd,
      env: isolation.env };
    await writeIntentFixture(location, { roots: [{ pluginId: 'official/demo' },
      { pluginId: 'official/other' }],
      agents: ['codex', 'claude', 'generic'] });
    const previousPreferences = await observePreferences(location);
    const targetStale = { code: 'operationReviewStale', message: '确认依据已改变。' };
    const receipt: RecoveryReceipt = { schemaVersion: 1, kind: 'aw-recovery', scope: 'user',
      command: 'sync', ok: false, intent: { state: 'valid', roots: ['official/demo', 'official/other'] },
      requestedRoots: ['official/demo', 'official/other'], requestedTargets: [], selection: {
        agents: ['codex', 'claude', 'generic'], origin: 'preference', preferences: 'valid',
      }, blockers: [], errors: [targetStale], targetResults: [
        { pluginId: 'official/demo', agent: 'codex', scope: 'user',
          delivery: { kind: 'native', platform: 'codex' }, execution: 'failed',
          observation: 'missing', blockers: [], requiredBy: ['official/demo'] },
        { pluginId: 'official/demo', agent: 'claude', scope: 'user',
          delivery: { kind: 'native', platform: 'claude' }, execution: 'not-run',
          observation: 'unknown', blockers: [targetStale], requiredBy: ['official/demo'],
          recoveryActions: ['aw plugin sync official/demo --context user --target claude'] },
        { pluginId: 'official/demo', agent: 'generic', scope: 'user',
          delivery: null, execution: 'not-run', observation: 'unknown',
          blockers: [{ code: 'deliveryUnsupported', message: 'blocked' }], requiredBy: ['official/demo'] },
        { pluginId: 'official/other', agent: 'codex', scope: 'user',
          delivery: { kind: 'native', platform: 'codex' }, execution: 'applied',
          observation: 'verified', blockers: [], requiredBy: ['official/other'] },
        { pluginId: 'official/other', agent: 'claude', scope: 'user',
          delivery: { kind: 'native', platform: 'claude' }, execution: 'failed',
          observation: 'missing', blockers: [], requiredBy: ['official/other'] },
      ], remainingTargets: [], recoveryActions: [], declarationChanged: false,
      preferencesChanged: false, configChanged: false, outputsMayHaveChanged: true };
    const plan = { kind: 'recovery', scope: 'user', plan: { receipt,
      plannedImpact: { declaration: false, preferences: false, config: false, outputs: true },
      changes: [], warnings: [], context: { dispose: async () => {} },
      nativeGroups: [], portableGroups: [] } } as unknown as ScopedTuiPlan;
    let retryPlan: Awaited<ReturnType<typeof prepareRecovery>> | undefined;
    const prepareScopedTask = vi.fn().mockResolvedValueOnce(plan).mockImplementation(async (request) => {
      retryPlan = await prepareRecovery(request.command ?? 'sync', request.selectors, {
        ...location, cliVersion: '0.1.0', targets: request.targets,
        exactTargets: request.exactTargets,
      });
      return { kind: 'recovery', scope: request.scope, plan: retryPlan };
    });
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn().mockResolvedValue(recovery('user')), prepareScopedTask,
      executeScopedTask: vi.fn().mockResolvedValue({ kind: 'recovery', receipt }) });
    await controller.load();
    controller.push({ name: 'intentInventory', scope: 'user' });
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
    await tick();
    await press(instance, 'c');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(controller.dependencies.executeScopedTask).not.toHaveBeenCalled();
    await press(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('重试明确失败项（2）'));
    expect(checkedFrame(instance, sizes[0]!)).toContain('检查未确认项（2）');
    expect(checkedFrame(instance, sizes[0]!)).toContain('重试明确失败项（2）');
    expect(checkedFrame(instance, sizes[0]!)).not.toContain('重新准备本次操作');
    await press(instance, 'd');
    const details = await readScopedPages(instance, sizes[0]!);
    expect(details).toContain('applied · verified');
    expect(details).not.toContain('本次未执行');
    const copy = vi.spyOn(clipboard, 'copyToClipboard').mockResolvedValue();
    try {
      await press(instance, 'y');
      await vi.waitFor(() => expect(copy).toHaveBeenCalled());
      const fullText = copy.mock.calls[0]![0];
      expect(fullText).toContain('受阻 operationReviewStale');
      expect(fullText).toContain('aw plugin sync official/demo --context user --target claude');
      expect(fullText).not.toContain('全局错误：operationReviewStale');
      expect(fullText).not.toContain('本次未执行');
    } finally { copy.mockRestore(); }
    await press(instance, 'd');
    await focusAction(instance, '重试明确失败项（2）');
    await press(instance, '\r');
    await vi.waitFor(() => expect(prepareScopedTask).toHaveBeenCalledTimes(2));
    expect(prepareScopedTask.mock.calls[1]?.[0]).toMatchObject({ kind: 'recovery', scope: 'user',
      command: 'sync', selectors: ['official/demo', 'official/other'],
      targets: ['codex', 'claude'], exactTargets: [
        { pluginId: 'official/demo', agent: 'codex', scope: 'user' },
        { pluginId: 'official/other', agent: 'claude', scope: 'user' },
      ] });
    await vi.waitFor(() => expect(retryPlan).toBeDefined());
    expect(retryPlan?.receipt.selection).toMatchObject({
      agents: ['claude', 'codex'], origin: 'argument',
    });
    expect(retryPlan?.receipt.requestedRoots).toEqual(['official/demo', 'official/other']);
    expect(retryPlan?.receipt.targetResults.every((target) =>
      target.pluginId === 'official/demo' && target.agent === 'codex'
      || target.pluginId === 'official/other' && target.agent === 'claude')).toBe(true);
    expect(retryPlan?.receipt.blockers.map((entry) => entry.code)).not.toContain('invalidExactTargets');
    expect(await observePreferences(location)).toEqual(previousPreferences);
    instance.unmount();
    await retryPlan?.context.dispose();
  });

  it('offers read-only recheck for diagnosed unknowns and retries only a known missing partial pair', async () => {
    const receipt: RecoveryReceipt = { schemaVersion: 1, kind: 'aw-recovery', scope: 'user',
      command: 'sync', ok: false, intent: { state: 'valid', roots: ['official/demo'] },
      coverage: { scopes: ['user', 'project'] },
      requestedRoots: ['official/demo'], requestedTargets: [], selection: {
        agents: ['codex', 'claude', 'generic'], origin: 'preference', preferences: 'valid',
      }, blockers: [], errors: [], targetResults: [
        { pluginId: 'official/demo', agent: 'codex', scope: 'user',
          delivery: { kind: 'native', platform: 'codex' }, execution: 'failed',
          observation: 'unknown', content: 'unknown',
          blockers: [{ code: 'nativeRecoveryFailed', message: 'diagnosed' }], requiredBy: ['official/demo'] },
        { pluginId: 'official/demo', agent: 'claude', scope: 'project',
          delivery: { kind: 'native', platform: 'claude' },
          execution: 'failed', observation: 'unknown', content: 'conflict',
          blockers: [{ code: 'deploymentOwnershipUnconfirmed', message: 'external content' }], requiredBy: ['official/demo'] },
        { pluginId: 'official/demo', agent: 'generic', scope: 'user',
          delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' },
          execution: 'partial', observation: 'unknown', content: 'absent',
          blockers: [], requiredBy: ['official/demo'] },
      ], remainingTargets: [], recoveryActions: [], declarationChanged: false,
      preferencesChanged: false, configChanged: false, outputsMayHaveChanged: true };
    const plan = { kind: 'recovery', scope: 'user', plan: { receipt,
      plannedImpact: { declaration: false, preferences: false, config: false, outputs: true },
      changes: [], warnings: [], context: { dispose: async () => {} },
      nativeGroups: [], portableGroups: [] } } as unknown as ScopedTuiPlan;
    const prepareScopedTask = vi.fn(async () => ({ ...plan,
      plan: { ...plan.plan, context: { dispose: async () => {} } } } as ScopedTuiPlan));
    const loadScopedStatus = vi.fn(async (scope: 'user' | 'project') => recovery(scope));
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus, prepareScopedTask,
      executeScopedTask: vi.fn().mockResolvedValue({ kind: 'recovery', receipt }) });
    await controller.load();
    controller.push({ name: 'intentInventory', scope: 'user' });
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
    await tick();
    await press(instance, 'c');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    await press(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    expect(checkedFrame(instance, sizes[0]!)).toContain('检查未确认项（2）');
    expect(checkedFrame(instance, sizes[0]!)).toContain('重试明确失败项（1）');
    await focusAction(instance, '重试明确失败项（1）');
    await press(instance, '\r');
    await vi.waitFor(() => expect(prepareScopedTask).toHaveBeenCalledTimes(2));
    expect(prepareScopedTask.mock.calls[1]?.[0]).toMatchObject({ kind: 'recovery', scope: 'user',
      exactTargets: [{ pluginId: 'official/demo', agent: 'generic', scope: 'user' }] });
    await press(instance, '\u001b');
    await press(instance, 'c');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    await press(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    const reads = loadScopedStatus.mock.calls.length;
    await focusAction(instance, '检查未确认项（2）');
    await press(instance, '\r');
    await vi.waitFor(() => expect(new Set(loadScopedStatus.mock.calls.slice(reads).map(([scope]) => scope)))
      .toEqual(new Set(['user', 'project'])));
    instance.unmount();
  });

  it('shows planned changes in Review and committed changes in Result', async () => {
    const receipt: RecoveryReceipt = { schemaVersion: 1, kind: 'aw-recovery', scope: 'project',
      command: 'sync', ok: true, intent: { state: 'valid', roots: ['official/demo'] },
      requestedRoots: ['official/demo'], requestedTargets: [],
      selection: { agents: ['codex'], origin: 'preference', preferences: 'valid' },
      blockers: [], errors: [], targetResults: [], remainingTargets: [], recoveryActions: [],
      declarationChanged: false, preferencesChanged: false, configChanged: false,
      outputsMayHaveChanged: false };
    const plan = { kind: 'recovery', scope: 'project', plan: { receipt,
      plannedImpact: { declaration: true, preferences: false, config: false, outputs: true },
      changes: [], warnings: [], context: { dispose: async () => {} },
      nativeGroups: [], portableGroups: [] } } as unknown as ScopedTuiPlan;
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn().mockResolvedValue(recovery('project')),
      prepareScopedTask: vi.fn().mockResolvedValue(plan),
      executeScopedTask: vi.fn().mockResolvedValue({ kind: 'recovery', receipt }) });
    await controller.load();
    controller.push({ name: 'intentInventory', scope: 'project', projectKey: '/tmp/project' });
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
    await tick();
    await press(instance, 'c');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    const review = checkedFrame(instance, sizes[0]!);
    expect(review).toContain('插件清单也将保存本次变化。');
    await press(instance, 'd');
    const reviewDetails = await readScopedPages(instance, sizes[0]!);
    expect(reviewDetails).toContain('需求变更（计划）：保存当前范围需求');
    expect(reviewDetails).toContain('输出变更（计划）：执行所列精确目标');
    expect(controller.dependencies.executeScopedTask).not.toHaveBeenCalled();
    await press(instance, 'd');
    await press(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    const result = checkedFrame(instance, sizes[0]!);
    expect(result).toContain('请求已完成。');
    expect(result).not.toContain('插件清单已保存。');
    await press(instance, 'd');
    const resultDetails = await readScopedPages(instance, sizes[0]!);
    expect(resultDetails).toContain('需求变更：无');
    expect(resultDetails).toContain('输出可能改变：否');
    expect(controller.dependencies.executeScopedTask).toHaveBeenCalledTimes(1);
    instance.unmount();
  });

  it.each([
    { total: 3, partial: false }, { total: 3, partial: true }, { total: 1, partial: false },
  ])('shows live progress for $total confirmed recovery targets (partial: $partial)', async ({ total, partial }) => {
    const targets = (['codex', 'claude', 'generic'] as const).slice(0, total).map((agent) => ({
      pluginId: 'official/demo', agent, scope: 'user' as const, delivery: null,
    }));
    const receipt: RecoveryReceipt = { schemaVersion: 1, kind: 'aw-recovery', scope: 'user',
      command: 'sync', ok: !partial, intent: { state: 'valid', roots: ['official/demo'] },
      requestedRoots: ['official/demo'], requestedTargets: targets,
      selection: { agents: targets.map(({ agent }) => agent), origin: 'preference', preferences: 'valid' },
      blockers: [], errors: [], remainingTargets: partial ? [targets[2]!] : [], recoveryActions: [],
      targetResults: targets.map((target) => partial && target.agent === 'generic'
        ? { ...target, execution: 'partial', observation: 'unknown', content: 'unknown', requiredBy: [],
          blockers: [{ code: 'permissionDenied', message: '/private/backend-details' }] }
        : { ...target, execution: 'applied', observation: 'verified',
          content: 'satisfied', blockers: [], requiredBy: [] }),
      declarationChanged: false, preferencesChanged: false, configChanged: false, outputsMayHaveChanged: true };
    const plan = { kind: 'recovery', scope: 'user', plan: { receipt, command: 'sync',
      plannedImpact: { declaration: false, preferences: false, config: false, outputs: true },
      changes: [], warnings: [], context: { dispose: async () => {} },
      nativeGroups: [], portableGroups: [] } } as unknown as ScopedTuiPlan;
    const execution = Promise.withResolvers<{ kind: 'recovery'; receipt: RecoveryReceipt }>();
    const executeScopedTask = vi.fn(() => execution.promise);
    const feed = createRebuildProgressFeed();
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn().mockResolvedValue(recovery('user')),
      prepareScopedTask: vi.fn().mockResolvedValue(plan), executeScopedTask }, feed);
    await controller.load();
    controller.push({ name: 'intentInventory', scope: 'user' });
    const size = sizes[1]!;
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await tick();
    await press(instance, 'c');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(executeScopedTask).not.toHaveBeenCalled();
    expect(checkedFrame(instance, size)).not.toContain('正在执行 0');
    expect(controller.listOperationHistory()).toHaveLength(0);
    await press(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('正在执行恢复'));
    feed.setInstallProgress({ completed: 0, running: 1, waitingForDependencies: total === 3 ? 1 : 0,
      waiting: total === 3 ? 1 : 0 });
    if (total === 3) {
      await vi.waitFor(() => {
        const frame = checkedFrame(instance, size);
        expect(frame).toContain('已完成 0 · 正在执行 1');
        expect(frame).toContain('等待依赖 1 · 待执行 1');
      });
      feed.setInstallProgress({ completed: 1, running: 2, waitingForDependencies: 0, waiting: 0 });
      feed.setCurrent({ target: 'Demo', phase: '写入平台插件' });
      await vi.waitFor(() => {
        const frame = checkedFrame(instance, size);
        expect(frame).toContain('已完成 1 · 正在执行 2');
        expect(frame).toContain('等待依赖 0 · 待执行 0');
      });
    } else {
      await tick();
      expect(checkedFrame(instance, size)).not.toContain('已完成 0');
      expect(checkedFrame(instance, size)).not.toContain('等待依赖');
    }
    await press(instance, escape);
    expect(checkedFrame(instance, size)).toContain('正在执行恢复');
    expect(controller.listOperationHistory()).toHaveLength(0);
    execution.resolve({ kind: 'recovery', receipt });
    await vi.waitFor(() => expect(checkedFrame(instance, size)).toContain('恢复结果'));
    expect(checkedFrame(instance, size)).not.toContain('待执行 0');
    expect(executeScopedTask).toHaveBeenCalledOnce();
    const history = controller.listOperationHistory();
    expect(history).toHaveLength(total > 1 ? 1 : 0);
    if (history[0]) {
      expect(history[0].state).toBe(partial ? 'partial' : 'succeeded');
      const detail = controller.getOperationDiagnostic(history[0].recordId);
      expect(detail?.targets).toEqual(targets.map(({ agent, pluginId, scope }) => expect.objectContaining({
        platform: agent, pluginId, scope, state: partial && agent === 'generic' ? 'failed' : 'completed',
      })));
      if (partial) {
        expect(detail?.diagnostics).toContainEqual(expect.objectContaining({
          code: 'permissionDenied', target: expect.objectContaining({ platform: 'generic' }),
        }));
        expect(JSON.stringify(detail)).not.toContain('/private/backend-details');
      }
    }
    instance.unmount();
  });

  it('confirms source impact first, then shows a new recovery Review based on the activated source', async () => {
    const receipt: RecoveryReceipt = { schemaVersion: 1, kind: 'aw-recovery', scope: 'project',
      command: 'sync', ok: true, intent: { state: 'valid', roots: ['official/demo'] },
      requestedRoots: ['official/demo'], requestedTargets: [],
      selection: { agents: ['codex'], origin: 'preference', preferences: 'valid' },
      blockers: [], errors: [], targetResults: [], remainingTargets: [], recoveryActions: [],
      declarationChanged: false, preferencesChanged: false, configChanged: false,
      outputsMayHaveChanged: false };
    const sourceReview = { kind: 'recovery', scope: 'project', plan: { receipt,
      plannedImpact: { declaration: false, preferences: false, config: false, outputs: false },
      changes: ['刷新 Catalog 来源 official，确认后激活已检查的候选 generation。'], warnings: [],
      context: { dispose: async () => {} }, nativeGroups: [], portableGroups: [],
      sourceRefreshes: [{ sourceId: 'official', impact: { inventoryComplete: false, affectedReferences: [] } }],
    } } as unknown as ScopedTuiPlan;
    const recoveryReview = { kind: 'recovery', scope: 'project', plan: { receipt,
      plannedImpact: { declaration: false, preferences: false, config: false, outputs: true },
      changes: ['基于新的 Active generation 重新准备恢复。'], warnings: [],
      context: { dispose: async () => {} }, nativeGroups: [], portableGroups: [], sourceRefreshes: [],
    } } as unknown as ScopedTuiPlan;
    const executeScopedTask = vi.fn()
      .mockResolvedValueOnce({ kind: 'recoveryReview', plan: recoveryReview })
      .mockResolvedValueOnce({ kind: 'recovery', receipt });
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn().mockResolvedValue(recovery('project')),
      prepareScopedTask: vi.fn().mockResolvedValue(sourceReview), executeScopedTask });
    await controller.load();
    controller.push({ name: 'intentInventory', scope: 'project', projectKey: '/tmp/project' });
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
    await tick();
    await press(instance, 'c');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    const sourceSummary = checkedFrame(instance, sizes[0]!);
    expect(sourceSummary).toContain('启用来源 official 的候选版本');
    expect(sourceSummary).toContain('来源启用后，将重新准备插件操作汇总；本次不会直接更新插件。');
    expect(sourceSummary).toContain('来源影响清单不完整');
    await press(instance, 'd');
    const sourceDetails = await readScopedPages(instance, sizes[0]!);
    expect(sourceDetails).toContain('刷新 Catalog 来源 official');
    expect(executeScopedTask).not.toHaveBeenCalled();
    await press(instance, 'd');
    await press(instance, '\r');
    expect(checkedFrame(instance, sizes[0]!)).toContain('来源影响清单不完整');
    expect(executeScopedTask).not.toHaveBeenCalled();
    await press(instance, '\u001b[B');
    await press(instance, '\r');
    await vi.waitFor(() => expect(executeScopedTask).toHaveBeenCalledTimes(1));
    expect(checkedFrame(instance, sizes[0]!)).toContain('操作汇总');
    expect(executeScopedTask).toHaveBeenNthCalledWith(1, sourceReview);
    await press(instance, 'd');
    const recoveryDetails = await readScopedPages(instance, sizes[0]!);
    expect(recoveryDetails).toContain('基于新的 Active generation');
    expect(executeScopedTask).toHaveBeenCalledTimes(1);
    await press(instance, 'd');
    await press(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    expect(executeScopedTask).toHaveBeenNthCalledWith(2, recoveryReview);
    instance.unmount();
  });

  it('keeps global blockers in scoped Review and stale execution diagnostics in Result and copy text', async () => {
    const copy = vi.spyOn(clipboard, 'copyToClipboard').mockResolvedValue();
    try {
      const base: RecoveryReceipt = { schemaVersion: 1, kind: 'aw-recovery', scope: 'project',
        command: 'sync', ok: false, intent: { state: 'valid', roots: ['official/demo'] },
        requestedRoots: ['official/demo'], requestedTargets: [],
        selection: { agents: ['codex'], origin: 'preference', preferences: 'valid' },
        blockers: [], errors: [], targetResults: [], remainingTargets: [], recoveryActions: [],
        declarationChanged: false, preferencesChanged: false, configChanged: false,
        outputsMayHaveChanged: false };
      const reviewReceipt = structuredClone(base);
      reviewReceipt.blockers = [{ code: 'declarationInvalid', message: '声明已变化。' }];
      const reviewPlan = { kind: 'recovery', scope: 'project', plan: { receipt: reviewReceipt,
        plannedImpact: { declaration: false, preferences: false, config: false, outputs: false },
        changes: [], warnings: [], context: { dispose: async () => {} }, sourceRefreshes: [],
        nativeGroups: [], portableGroups: [] } } as unknown as ScopedTuiPlan;
      const staleReceipt = structuredClone(base);
      staleReceipt.blockers = [{ code: 'operationReviewStale', message: '确认依据已改变，请重新检查并确认。' }];
      staleReceipt.errors = [...staleReceipt.blockers];
      staleReceipt.targetResults = [{ pluginId: 'official/demo', agent: 'generic', scope: 'project',
        delivery: null, execution: 'no-op', observation: 'verified', satisfaction: 'excluded',
        blockers: [], requiredBy: ['official/demo'] }];
      const cleanPlan = { ...reviewPlan, plan: { ...reviewPlan.plan, receipt: base } } as ScopedTuiPlan;
      const prepareScopedTask = vi.fn().mockResolvedValueOnce(reviewPlan).mockResolvedValue(cleanPlan);
      const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
        loadScopedStatus: vi.fn().mockResolvedValue(recovery('project')), prepareScopedTask,
        executeScopedTask: vi.fn().mockResolvedValue({ kind: 'recovery', receipt: staleReceipt }) });
      await controller.load();
      controller.push({ name: 'intentInventory', scope: 'project', projectKey: '/tmp/project' });
      const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
      await tick();
      await press(instance, 'c');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
      expect(checkedFrame(instance, sizes[0]!)).toContain('当前无法完成，请查看详情');
      await press(instance, 'd');
      expect(await readScopedPages(instance, sizes[0]!)).toContain('全局受阻：declarationInvalid');
      expect(controller.dependencies.executeScopedTask).not.toHaveBeenCalled();
      await escape(instance);
      await press(instance, 'c');
      await vi.waitFor(() => {
        expect(prepareScopedTask).toHaveBeenCalledTimes(2);
        expect(instance.lastFrame()).toContain('确认恢复可执行目标');
      });
      const preparedRequest = prepareScopedTask.mock.calls[1]?.[0];
      await press(instance, '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
      const result = checkedFrame(instance, sizes[0]!);
      expect(result).toContain('状态已变化，请重新准备');
      expect(result).toContain('重新准备本次操作');
      await press(instance, 'd');
      const details = await readScopedPages(instance, sizes[0]!);
      expect(details).toContain('operationReviewStale');
      expect(details).toContain('本次未执行，需要重新准备');
      await press(instance, 'y');
      await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(expect.stringContaining('operationReviewStale')));
      expect(copy).toHaveBeenCalledWith(expect.stringContaining('本次未执行，需要重新准备。'));
      await press(instance, 'd');
      await focusAction(instance, '重新准备本次操作');
      await press(instance, '\r');
      await vi.waitFor(() => expect(prepareScopedTask).toHaveBeenCalledTimes(3));
      expect(prepareScopedTask.mock.calls[2]?.[0]).toEqual(preparedRequest);
      instance.unmount();
    } finally { copy.mockRestore(); }
  });

  it('pages a long scoped Review through resize and copies its complete text', async () => {
    const copy = vi.spyOn(clipboard, 'copyToClipboard').mockResolvedValue();
    try {
      const receipt: RecoveryReceipt = { schemaVersion: 1, kind: 'aw-recovery', scope: 'project',
        command: 'sync', ok: true, intent: { state: 'valid', roots: ['official/demo'] },
        requestedRoots: ['official/demo'], requestedTargets: [],
        selection: { agents: ['codex'], origin: 'preference', preferences: 'valid' },
        blockers: [], errors: [], targetResults: [], remainingTargets: [], recoveryActions: [],
        declarationChanged: false, preferencesChanged: false, configChanged: false,
        outputsMayHaveChanged: false };
      const plan = { kind: 'recovery', scope: 'project', plan: { receipt,
        plannedImpact: { declaration: true, preferences: false, config: false, outputs: true },
        changes: [], warnings: Array.from({ length: 18 }, (_, index) => `检查说明 ${index + 1}`),
        context: { dispose: async () => {} }, nativeGroups: [], portableGroups: [],
      } } as unknown as ScopedTuiPlan;
      const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
        loadScopedStatus: vi.fn().mockResolvedValue(recovery('project')),
        prepareScopedTask: vi.fn().mockResolvedValue(plan), executeScopedTask: vi.fn() });
      await controller.load();
      controller.push({ name: 'intentInventory', scope: 'project', projectKey: '/tmp/project' });
      const instance = render(<ConsoleAppV4 controller={controller} size={sizes[1]!} />);
      await tick();
      await press(instance, 'c');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
      expect(checkedFrame(instance, sizes[1]!)).toContain('插件清单也将保存本次变化。');
      await press(instance, 'd');
      expect(checkedFrame(instance, sizes[1]!)).toContain('1 /');
      await press(instance, '\u001b[6~');
      expect(checkedFrame(instance, sizes[1]!)).toContain('2 /');
      instance.rerender(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
      await tick();
      expect(checkedFrame(instance, sizes[0]!)).toContain('技术详情');
      await press(instance, '\u001b[5~');
      const details = await readScopedPages(instance, sizes[0]!);
      for (let index = 1; index <= 18; index += 1) {
        expect(details).toMatch(new RegExp(`检查说明 ${index}(?!\\d)`, 'u'));
      }
      await press(instance, 'y');
      await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(expect.stringContaining('检查说明 18')));
      expect(controller.dependencies.executeScopedTask).not.toHaveBeenCalled();
      instance.unmount();
    } finally { copy.mockRestore(); }
  });

  it('keeps declaration and removal scope visible without an installed placement', async () => {
    const personal = recovery('user');
    personal.selection.agents = [];
    personal.inventory![0]!.targetResults = [];
    const project: RecoveryInventoryInput = { ...recovery('project'),
      intent: { state: 'absent' }, inventory: [], selection: { agents: [], preferences: 'absent' } };
    const prepareScopedTask = vi.fn().mockRejectedValue(new Error('prepareStopped'));
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn(async (scope: 'user' | 'project') => scope === 'user' ? personal : project),
      prepareScopedTask });
    await controller.load();
    await controller.refreshScopedInventory('user');
    await controller.refreshScopedInventory('project');
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
    await tick();
    const detail = checkedFrame(instance, sizes[0]!);
    expect(detail).toContain('所有项目 待安装');
    expect(detail).not.toContain('当前项目 待安装');
    expect(detail).toContain('本机未启用');
    await focusAction(instance, '移出插件清单（保留安装）');
    await press(instance, '\r');
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({ kind: 'intent',
      action: 'remove', scope: 'user', selector: 'official/demo' }), expect.anything());
    instance.unmount();
  });

  it.each([
    { name: 'User generic Skills', scope: 'user' as const, kind: 'portable' as const },
    { name: 'shared Native', scope: 'project' as const, kind: 'shared' as const },
    { name: 'joint child shared Native', scope: 'project' as const, kind: 'joint-shared' as const },
    { name: 'retirement config deletion', scope: 'project' as const, kind: 'retire' as const, deleteConfig: true },
    { name: 'User retirement output', scope: 'user' as const, kind: 'retire' as const },
    { name: 'Project shared retirement without config deletion', scope: 'project' as const, kind: 'retire' as const, sharedRetirement: true },
    { name: 'User shared retirement without config deletion', scope: 'user' as const, kind: 'retire' as const, sharedRetirement: true },
  ])('requires a separate, default-return risk confirmation for $name', async ({ scope, kind, deleteConfig, sharedRetirement }) => {
    const current = kind === 'retire' ? retiredRecovery(scope) : recovery(scope);
    const receipt: RecoveryReceipt = { schemaVersion: 1, kind: 'aw-recovery', scope,
      command: kind === 'retire' ? 'intent:retire' : 'sync', ok: true,
      intent: { state: 'valid', roots: ['official/demo'] }, requestedRoots: ['official/demo'],
      requestedTargets: [], selection: { agents: ['codex'], origin: 'preference', preferences: 'valid' },
      blockers: [], errors: [], targetResults: [], remainingTargets: [], recoveryActions: [],
      declarationChanged: false, preferencesChanged: false, configChanged: false,
      outputsMayHaveChanged: false };
    const sharedNativeGroups = [{ preview: { codexReconcilePlans: [{ review: {
      requiresConfirmation: true, sharedImpact: { warning: '共享内容可能影响其他项目。' },
    } }] } }];
    const plan = kind === 'retire' ? { kind: 'retire', scope, plan: {
      receipt, options: { deleteConfig: !!deleteConfig },
      plannedImpact: { declaration: true, preferences: true, config: !!deleteConfig, outputs: true },
      changes: ['删除当前范围声明。'], warnings: [], context: { dispose: async () => {} },
      ...(sharedRetirement ? { operationPlan: { deploymentPlans: [retirementDeployment(scope, [
        { kind: 'unregister', destination: '/market' },
        { kind: 'remove-owned', destination: '/package/demo' },
      ])] } } : {}),
    } } : { kind: 'recovery', scope, plan: { receipt,
      plannedImpact: { declaration: false, preferences: false, config: false, outputs: true },
      changes: [], warnings: [], context: { dispose: async () => {} },
      nativeGroups: kind === 'shared' ? sharedNativeGroups : [],
      portableGroups: kind === 'portable' ? [{}] : [],
      ...(kind === 'joint-shared' ? { joint: { children: [{
        receipt: { ...receipt, scope: 'user' },
        plannedImpact: { declaration: false, preferences: false, config: false, outputs: true },
        changes: [], warnings: [], context: { dispose: async () => {} },
        nativeGroups: sharedNativeGroups, portableGroups: [], sourceRefreshes: [],
      }] } } : {}),
    } } as unknown as ScopedTuiPlan;
    const executeScopedTask = vi.fn().mockResolvedValue({ kind: 'recovery', receipt });
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(),
      loadStatus: vi.fn().mockResolvedValue(kind === 'retire' ? retiredStatus() : status),
      loadScopedStatus: vi.fn().mockResolvedValue(current),
      prepareScopedTask: vi.fn().mockResolvedValue(plan), executeScopedTask });
    await controller.load();
    controller.push({ name: 'intentInventory', scope,
      ...(scope === 'project' ? { projectKey: '/tmp/project' } : {}) });
    const size = kind === 'portable' ? sizes[1]! : sizes[0]!;
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await tick();
    if (kind === 'retire') await focusAction(instance, deleteConfig
      ? '停用已移除插件并删除设置' : '停用已移除插件（保留设置）');
    else await press(instance, 'c');
    if (kind === 'retire') await press(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    if (kind === 'shared' || kind === 'joint-shared') {
      expect(checkedFrame(instance, size)).toContain('共享内容可能影响其他项目');
    }
    expect(executeScopedTask).not.toHaveBeenCalled();
    await press(instance, '\r');
    expect(checkedFrame(instance, size)).toContain('请确认本次风险');
    expect(checkedFrame(instance, size)).toContain('返回检查');
    expect(checkedFrame(instance, size)).toContain('› 返回检查');
    const riskFrame = checkedFrame(instance, size);
    if (sharedRetirement) {
      expect(riskFrame).toContain('删除共享插件包');
      expect(riskFrame).not.toContain('保留其他使用位置');
      const reviewText = deploymentPlanLines(plan.kind === 'retire' ? plan.plan.operationPlan!.deploymentPlans : []).join('\n');
      expect(reviewText).toContain('其他项目的该插件将一并失效');
      expect(reviewText).toContain('其他项目的需求声明保留');
    } else if (kind === 'retire' && deleteConfig) {
      expect(riskFrame).toContain('全部本机设置');
      expect(riskFrame).toContain('通用与各');
      expect(riskFrame).toContain('Agent），影响所有项目');
    } else {
      expect(riskFrame).toContain(kind === 'portable' ? '适用于所有项目'
        : kind === 'shared' || kind === 'joint-shared' ? '共享内容可能影响其他项目'
          : '可能影响其他项目');
    }
    expect(executeScopedTask).not.toHaveBeenCalled();
    await press(instance, '\r');
    expect(instance.lastFrame()).toContain('操作汇总');
    expect(instance.lastFrame()).not.toContain('请确认本次风险');
    await press(instance, '\r');
    await press(instance, '\u001b[B');
    await press(instance, '\r');
    await vi.waitFor(() => expect(executeScopedTask).toHaveBeenCalledTimes(1));
    instance.unmount();
  });

  it.each(['user', 'project'] as const)('allows %s generic Skills needs-preparation into a new Review', async (scope) => {
    const current = recovery(scope);
    current.selection.agents = ['generic'];
    current.inventory![0]!.targetResults = [{ pluginId: 'official/demo', agent: 'generic', scope,
      delivery: { kind: 'agent-skills', provider: 'aw', agentId: 'generic' },
      execution: 'not-run', observation: 'unknown', content: 'unknown',
      blockers: [{ code: 'needs-preparation', message: 'prepare first' }], requiredBy: ['official/demo'] }];
    const plan = { kind: 'recovery', scope, plan: { receipt: {
      requestedRoots: ['official/demo'], selection: { agents: ['generic'] }, targetResults: [],
      blockers: [], errors: [],
    }, plannedImpact: { declaration: false, preferences: false, config: false, outputs: true },
    changes: ['首次准备后同步'], warnings: [], context: { dispose: async () => {} },
    nativeGroups: [], portableGroups: [],
    } } as unknown as ScopedTuiPlan;
    const prepareScopedTask = vi.fn().mockResolvedValue(plan);
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn().mockResolvedValue(current), prepareScopedTask });
    await controller.load();
    controller.push({ name: 'intentInventory', scope,
      ...(scope === 'project' ? { projectKey: '/tmp/project' } : {}) });
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[1]!} />);
    await tick();
    expect(checkedFrame(instance, sizes[1]!)).toContain('同步可执行项（1）');
    await press(instance, 'c');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'recovery', scope, selectors: ['official/demo'], targets: ['generic'],
      exactTargets: [{ pluginId: 'official/demo', agent: 'generic' }],
    }), expect.anything());
    instance.unmount();
  });

  it.each(['user', 'project'] as const)('projects %s readonly generic Skills needs-preparation from status into Ink', async (scope) => {
    const inspect = vi.spyOn(portableRecovery, 'inspectPortableRecovery')
      .mockResolvedValue({ blockers: ['needs-preparation'], targets: [] } as never);
    try {
      const demand = { scope, intent: { state: 'valid', value: { schemaVersion: 3,
        kind: 'aw-plugin-intents', sources: { official: { logicalIdentity: 'official' } },
        roots: [{ pluginId: 'official/demo' }] }, digest: 'intent', rawDigest: 'intent', rawBytes: Buffer.from('{}') },
      preferences: { state: 'valid', value: { schemaVersion: 2,
        kind: 'aw-deployment-preferences', targets: ['generic'], exclusions: [] },
      digest: 'preferences', rawDigest: 'preferences', rawBytes: Buffer.from('{}') },
      roots: [{ pluginId: 'official/demo', sourceId: 'official', sourceState: 'ready', blockers: [],
        plugin: { manifest: { platforms: ['generic'], skills: './skills' } } }], plugins: [], errors: [],
      } as unknown as DemandSnapshot;
      const projected = await statusFromObservations({ scope, cwd: '/tmp/project',
        context: { scope } as ScopeContext, demand, nativeObservations: [] });
      expect(projected.inventory?.[0]?.targetResults[0]).toMatchObject({ agent: 'generic',
        delivery: { kind: 'agent-skills' }, observation: 'unknown',
        blockers: [{ code: 'needs-preparation' }] });
      const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
        loadScopedStatus: vi.fn().mockResolvedValue({ ...projected, dependencyOverviews: [] }) });
      await controller.load();
      controller.push({ name: 'intentInventory', scope,
        ...(scope === 'project' ? { projectKey: '/tmp/project' } : {}) });
      const instance = render(<ConsoleAppV4 controller={controller} size={sizes[1]!} />);
      await tick();
      expect(checkedFrame(instance, sizes[1]!)).toContain('同步可执行项（1）');
      instance.unmount();
    } finally { inspect.mockRestore(); }
  });

  it.each(['user', 'project'] as const)('keeps explicit generic Skills drifted %s targets pending and syncable in Ink', async (scope) => {
    const inspect = vi.spyOn(portableRecovery, 'inspectPortableRecovery')
      .mockResolvedValue({ blockers: [], targets: [{ agent: 'generic', observation: 'drifted' }] } as never);
    try {
      const demand = { scope, intent: { state: 'valid', value: { schemaVersion: 3,
        kind: 'aw-plugin-intents', sources: { official: { logicalIdentity: 'official' } },
        roots: [{ pluginId: 'official/demo' }] }, digest: 'intent', rawDigest: 'intent', rawBytes: Buffer.from('{}') },
      preferences: { state: 'valid', value: { schemaVersion: 2,
        kind: 'aw-deployment-preferences', targets: ['generic'], exclusions: [] },
      digest: 'preferences', rawDigest: 'preferences', rawBytes: Buffer.from('{}') },
      roots: [{ pluginId: 'official/demo', sourceId: 'official', sourceState: 'ready', blockers: [],
        plugin: { manifest: { platforms: ['generic'], skills: './skills' } } }], plugins: [], errors: [],
      } as unknown as DemandSnapshot;
      const projected = await statusFromObservations({ scope, cwd: '/tmp/project',
        context: { scope } as ScopeContext, demand, nativeObservations: [] });
      expect(projected.inventory?.[0]?.targetResults[0]).toMatchObject({
        content: 'drifted', observation: 'unknown', blockers: [],
      });
      const view = buildScopedInventory({ recovery: projected, status: status.payload,
        pluginSummaries: status.pluginSummaries });
      expect(view.declaredRoots[0]?.state).toBe('pending');
      expect(view.syncTargets).toEqual([{ pluginId: 'official/demo', agent: 'generic', scope }]);
      const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
        loadScopedStatus: vi.fn().mockResolvedValue({ ...projected, dependencyOverviews: [] }) });
      await controller.load();
      controller.push({ name: 'intentInventory', scope,
        ...(scope === 'project' ? { projectKey: '/tmp/project' } : {}) });
      const instance = render(<ConsoleAppV4 controller={controller} size={sizes[1]!} />);
      await tick();
      expect(checkedFrame(instance, sizes[1]!)).toContain('同步可执行项（1）');
      instance.unmount();
    } finally { inspect.mockRestore(); }
  });

  it('shows incomplete generic Skills coverage in the scoped inventory', async () => {
    const current = recovery('project');
    current.coverage = { native: true, portable: false };
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn().mockResolvedValue(current) });
    await controller.load();
    controller.push({ name: 'intentInventory', scope: 'project', projectKey: '/tmp/project' });
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
    await tick();
    expect(checkedFrame(instance, sizes[0]!)).toContain('通用 Skills 额外安装未完整覆盖');
    instance.unmount();
  });
});

// Test Value Gate: scoped recovery must show reviewed command launches, live producer progress,
// producer failures and retained-package removal without switching to the legacy executor.
describe('managed commands in scoped Ink recovery', () => {
  it.each(['sync', 'cleanup'] as const)('keeps command facts through %s Review, Progress and Result', async (command) => {
    const producer = { sourceId: 'official', sourceIdentity: `sha256:${'a'.repeat(64)}`, pluginName: 'provider' };
    const selector = 'official/provider';
    const packageId = `pkg_${'2'.repeat(64)}`;
    const remove = `aw command package remove ${packageId} --yes`;
    const launch = { runner: 'node' as const, entry: 'runtime.mjs', args: ['--fixed', 'value'], env: {}, envFrom: {}, cwd: 'resource' as const };
    const action = command === 'cleanup'
      ? { kind: 'retainManagedCommandPackage' as const, pluginId: 'official/provider', scope: 'user' as const,
          producer, packageId, selector, subcommands: ['worker'], hasFallback: false,
          availability: 'ready' as const, errors: [], recoveryActions: [remove] }
      : { kind: 'syncManagedCommandPackage' as const, pluginId: 'official/provider', scope: 'user' as const,
          producer, record: { schemaVersion: 2 as const, producer, pluginVersion: '1.0.0', sourceContentDigest: `sha256:${'f'.repeat(64)}`,
            runtimeConfigPlatforms: [], routes: { subcommands: [{ name: 'worker', ...launch }] } },
          expectedPackage: null, contentDigest: 'sha256:prepared', runtimeConfigChanges: [],
          routeReview: { routeChanges: [{ argv: ['aw', 'command', 'run', selector, '--', 'worker'], before: null,
            after: { ...launch, route: 'subcommand' as const } }], affectedPermissions: [], permissionReadFailures: [],
            otherProjects: 'unobserved' as const, existingApprovalsMayMatch: false } };
    const receipt: RecoveryReceipt = { schemaVersion: 1, kind: 'aw-recovery', scope: 'user', command,
      ok: command === 'cleanup', intent: { state: 'valid', roots: ['official/demo'] },
      requestedRoots: ['official/demo'], requestedTargets: [],
      selection: { agents: ['codex'], origin: 'preference', preferences: 'valid' },
      blockers: [], errors: [], targetResults: [], remainingTargets: [], recoveryActions: [],
      declarationChanged: false, preferencesChanged: false, configChanged: false, outputsMayHaveChanged: true,
      commandResults: [{ producer, packageId, selector, action: 'unchanged', availability: command === 'cleanup' ? 'ready' : 'unavailable',
        state: command === 'cleanup' ? 'completed' : 'failed', subcommands: command === 'cleanup' ? ['worker'] : [], hasFallback: false,
        errors: command === 'cleanup' ? [] : [{ code: 'commandProducerFailed', message: 'producer failed' }],
        recoveryActions: command === 'cleanup' ? [remove] : ['aw command package sync official/provider'] }],
    };
    const operationPlan = createOperationPlan({ actions: [action], changes: [], warnings: [], intentChanges: [],
      evidence: { catalogDigests: [], configDigests: [], intentDigests: [], targetOwnerFingerprints: [] } });
    const plan = { kind: 'recovery', scope: 'user', plan: { receipt,
      plannedImpact: { declaration: false, preferences: false, config: false, outputs: true },
      changes: [], warnings: [], sourceRefreshes: [], portableGroups: [],
      nativeGroups: [{ preview: { operationPlan } }, { preview: { operationPlan } }],
      context: { dispose: async () => {} },
    } } as unknown as ScopedTuiPlan;
    let finish!: (value: { kind: 'recovery'; receipt: RecoveryReceipt }) => void;
    const executeScopedTask = vi.fn(() => new Promise<{ kind: 'recovery'; receipt: RecoveryReceipt }>((resolve) => { finish = resolve; }));
    const feed = createRebuildProgressFeed();
    const controller = new TuiController({ readAgentSettings: async () => agentSettings(), loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn().mockResolvedValue(recovery('user')),
      prepareScopedTask: vi.fn().mockResolvedValue(plan), executeScopedTask }, feed);
    const copied = vi.spyOn(clipboard, 'copyToClipboard').mockResolvedValue({ ok: true });
    await controller.load();
    controller.push({ name: 'intentInventory', scope: 'user' });
    const size = { columns: 60, rows: 18 };
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await tick();
    await press(instance, 'c');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(executeScopedTask).not.toHaveBeenCalled();
    await press(instance, 'd');
    const reviewPages = await readScopedPages(instance, size);
    expect(reviewPages).toContain('命令包 official/provider');
    await press(instance, 'y');
    await vi.waitFor(() => expect(copied).toHaveBeenCalledTimes(1));
    const review = String(copied.mock.lastCall?.[0]);
    expect(review.match(/命令包 official\/provider/gu)).toHaveLength(1);
    if (command === 'sync') {
      expect(review).toContain('official/provider');
      expect(review).toContain('更新会影响所有引用者');
      expect(review).toContain('aw command run official/provider -- worker');
      expect(review).toContain('["runtime.mjs","--fixed","value"]');
    } else {
      expect(review).toContain('所有项目共用');
      expect(review).toContain(remove);
    }
    expect(executeScopedTask).not.toHaveBeenCalled();
    await press(instance, 'd');
    await press(instance, '\r');
    await vi.waitFor(() => expect(executeScopedTask).toHaveBeenCalledOnce());
    feed.addEvent({ type: 'managed-command:producer', source: { plugin: 'provider', scope: 'user' },
      data: { selector, phase: 'start' } });
    await tick();
    expect(checkedFrame(instance, size)).toContain('刷新命令包');
    await press(instance, 'y');
    expect(String(copied.mock.lastCall?.[0])).toContain(command === 'sync' ? '--fixed' : remove);
    finish({ kind: 'recovery', receipt });
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    expect(checkedFrame(instance, size)).toContain(command === 'sync'
      ? '请求仍有未完成目标' : '请求已完成');
    await press(instance, 'd');
    const resultPages = await readScopedPages(instance, size);
    expect(resultPages).toContain('official/provider');
    await press(instance, 'y');
    await vi.waitFor(() => expect(copied).toHaveBeenCalledTimes(2));
    const result = String(copied.mock.lastCall?.[0]);
    expect(result).toContain('official/provider');
    if (command === 'sync') {
      expect(result).toContain('failed');
      expect(result).toContain('commandProducerFailed');
    } else {
      expect(result).toContain('所有项目共用');
      expect(result).toContain(remove);
    }
    instance.unmount();
    controller.dispose();
    copied.mockRestore();
  });
});
