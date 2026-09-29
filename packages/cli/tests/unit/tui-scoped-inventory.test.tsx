import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type TuiStatusLoadResult } from '../../src/tui/controller.js';
import { buildScopedInventory, type ScopedInventoryLoadResult } from '../../src/tui/scoped-inventory.js';
import type { ScopedTuiPlan } from '../../src/tui/scoped-flow.js';
import type { RecoveryReceipt } from '../../src/recovery/receipt.js';
import { prepareRecovery } from '../../src/recovery/coordinator.js';
import { statusFromObservations } from '../../src/recovery/status.js';
import { observePreferences } from '../../src/intent/deployment-preferences.js';
import type { DemandSnapshot } from '../../src/recovery/demand.js';
import type { ScopeContext } from '../../src/intent/scope-context.js';
import * as portableRecovery from '../../src/portable/recovery.js';
import * as clipboard from '../../src/tui/clipboard.js';
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

function recovery(scope: 'user' | 'project'): ScopedInventoryLoadResult {
  return { scope, intent: { state: 'valid' }, selection: { agents: ['codex'], preferences: 'valid' },
    inventory: [{ pluginId: 'official/demo', source: 'official', sourceState: 'ready', blockers: [],
      targetResults: [{ pluginId: 'official/demo', agent: 'codex', scope,
        delivery: { kind: 'native', platform: 'codex' }, execution: 'not-run', observation: 'missing',
        content: 'absent', blockers: [], requiredBy: [] }] }],
    extraObserved: [], errors: [], allSatisfied: false,
    nativeSnapshot: { payload: status.payload, pluginSummaries: status.pluginSummaries, targetRevisions: [], dependencyOverviews: [] } };
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

afterEach(cleanup);

describe('scoped inventory in Ink', () => {
  it.each(sizes)('selects one scope and keeps its inventory within $columns x $rows', async (size) => {
    const loadScopedStatus = vi.fn(async (scope: 'user' | 'project') => recovery(scope));
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status), loadScopedStatus });
    await controller.load();
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await tick();
    expect(checkedFrame(instance, size)).toContain('插件清单');
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

  it('opens the same scoped detail from both inventories, the library, and the dependency graph', async () => {
    const loaded: TuiStatusLoadResult = { ...status, dependencyOverviews: [{
      pluginId: 'official/demo',
      summary: { directCount: 0, transitiveCount: 0, dependentCount: 0, blockedCount: 0 },
      dependencies: [], dependents: [], blockers: [],
    }] };
    const prepareScopedTask = vi.fn().mockRejectedValue(new Error('stopped before write'));
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(loaded),
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
      expect(detail).toContain('个人清单');
      expect(detail).toContain('当前项目清单');
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
    const revisions = [{ pluginId: native.pluginId, platform: native.platform,
      scope: native.scope, revision: { state: 'current' as const, installedVersion: '2.0.0', availableVersion: '2.0.0' } }];
    const initial = { ...status, payload: { ...status.payload, targets: [native] }, targetRevisions: revisions };
    let current = { ...recovery('user'), nativeSnapshot: {
      payload: initial.payload, pluginSummaries: [{ pluginId: native.pluginId, displayName: 'Current Extra' }],
      targetRevisions: revisions, dependencyOverviews: [],
    } };
    current.extraObserved = [{ pluginId: native.pluginId, agent: 'claude-code', scope: 'user',
      delivery: { kind: 'native', platform: 'claude' }, observation: 'verified', content: 'satisfied' }];
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(initial),
      loadScopedStatus: vi.fn(async () => current), loadPluginContent: vi.fn().mockRejectedValue(new Error('unavailable')) });
    await controller.load();
    await controller.refreshScopedInventory('user');
    expect(controller.listScopedInventoryRoots('user', 'extraInstalled')[0]?.displayName).toBe('Current Extra');
    expect(controller.listScopedInventoryRoots('user', 'extraInstalled')[0]?.targets[0])
      .toMatchObject({ installedVersion: '2.0.0', state: 'ready' });
    if (change === 'removed') current = { ...current, extraObserved: [], nativeSnapshot: {
      ...current.nativeSnapshot, payload: { ...status.payload, targets: [] }, targetRevisions: [] } };
    else current = { ...current,
      extraObserved: [{ ...current.extraObserved![0]!, observation: 'unknown', content: change }] };
    await controller.refreshScopedInventory('user');
    const expected = change === 'removed' ? [] : [expect.objectContaining({
      state: change === 'conflict' ? 'blocked' : 'unknown',
    })];
    expect(controller.listScopedInventoryRoots('user', 'extraInstalled')).toEqual(expected);
    await controller.loadPluginContent('official/demo');
    expect(controller.listScopedInventoryRoots('user', 'extraInstalled')).toEqual(expected);
    expect(controller.snapshot.scopedInventoryRefresh.user?.state).toBe('idle');
    controller.dispose();
  });

  it('does not let delayed failure logging replace a newer scoped refresh', async () => {
    let releaseLog!: () => void;
    const logError = vi.fn(() => new Promise<void>((resolve) => { releaseLog = resolve; }));
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status), logError,
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
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status), loadScopedStatus });
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
    project.nativeSnapshot = { payload: { ...status.payload, targets: [{
      pluginId: 'official/demo', pluginName: 'demo', sourceId: 'official', sourceIdentity: 'source',
      platform: 'claude', scope: 'project', cwd: '/tmp/project', version: '2.0.0', state: 'ready',
      components: [{ kind: 'ownership', key: 'demo', state: 'present' },
        { kind: 'dependency', key: 'official/base', state: 'ready',
          metadata: { platform: 'claude', scope: 'user', project: 'none' } }],
      reasons: [], recoveryActions: [],
    }] }, pluginSummaries: status.pluginSummaries, targetRevisions: [{ pluginId: 'official/demo', platform: 'claude', scope: 'project',
      revision: { state: 'upgradeAvailable', availableVersion: '2.0.0', installedVersion: '1.0.0' } }],
    dependencyOverviews: [{ pluginId: 'official/demo',
      summary: { directCount: 1, transitiveCount: 0, dependentCount: 0, blockedCount: 0 },
      dependencies: [{ pluginId: 'official/base', displayName: 'Base', relation: 'direct', depth: 1,
        requiredBy: [], placements: [], aggregateStatus: 'ready' }], dependents: [], blockers: [] }] };
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn(async (scope: 'user' | 'project') => scope === 'project' ? project : recovery('user')) });
    await controller.load();
    await controller.refreshScopedInventory('user');
    const user = controller.snapshot.scopedInventories.user;
    await controller.refreshScopedInventory('project');
    const root = controller.listScopedInventoryRoots('project')[0]!;
    expect(root.targets).toContainEqual(expect.objectContaining({ platform: 'claude',
      installedVersion: '1.0.0', expectedVersion: '2.0.0' }));
    expect(root.dependencies[0]?.targets).toEqual([{ platform: 'claude', scope: 'user',
      location: 'sharedUser', state: 'ready', reasonCodes: [] }]);
    expect(controller.getPluginDetailSubject('official/base')?.placements).toEqual([expect.objectContaining({
      scope: 'user', sharedWithCurrentProject: true, actual: false, observation: 'known', projectState: 'ready',
    })]);
    project.nativeSnapshot.payload.targets[0]!.components[1]!.state = 'error';
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
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status),
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

  it('guards a changed targets draft and keeps retirement config deletion opt-in', async () => {
    const current = recovery('project');
    current.inventory![0]!.blockers = [{ code: 'pluginUnavailable', message: 'removed' }];
    const prepareScopedTask = vi.fn().mockRejectedValue(new Error('prepareStopped'));
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn().mockResolvedValue(current), prepareScopedTask });
    await controller.load();
    controller.push({ name: 'intentInventory', scope: 'project', projectKey: '/tmp/project' });
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
    await tick();
    await focusAction(instance, '停用已移除插件（保留设置）');
    await press(instance, '\r');
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({ kind: 'retire',
      scope: 'project', selector: 'official/demo', deleteConfig: false }), expect.anything());
    await press(instance, '\u001b');
    await focusAction(instance, '选择本机工具');
    await press(instance, '\r');
    await press(instance, '\r');
    await press(instance, '\u001b');
    expect(checkedFrame(instance, sizes[0]!)).toContain('放弃');
    expect(prepareScopedTask).toHaveBeenCalledTimes(1);
    instance.unmount();
  });

  it('retries only two irregular failed pairs and checks unknown targets separately', async () => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd,
      env: isolation.env };
    await writeIntentFixture(location, { roots: [{ pluginId: 'official/demo' },
      { pluginId: 'official/other' }],
      agents: ['cursor'] });
    const previousPreferences = await observePreferences(location);
    const receipt: RecoveryReceipt = { schemaVersion: 1, kind: 'aw-recovery', scope: 'user',
      command: 'sync', ok: false, intent: { state: 'valid', roots: ['official/demo', 'official/other'] },
      requestedRoots: ['official/demo', 'official/other'], requestedTargets: [], selection: {
        agents: ['codex', 'claude-code', 'cursor'], origin: 'preference', preferences: 'valid',
      }, blockers: [], errors: [], targetResults: [
        { pluginId: 'official/demo', agent: 'codex', scope: 'user',
          delivery: { kind: 'native', platform: 'codex' }, execution: 'failed',
          observation: 'missing', blockers: [], requiredBy: ['official/demo'] },
        { pluginId: 'official/demo', agent: 'claude-code', scope: 'user',
          delivery: { kind: 'native', platform: 'claude' }, execution: 'not-run',
          observation: 'unknown', blockers: [], requiredBy: ['official/demo'] },
        { pluginId: 'official/demo', agent: 'cursor', scope: 'user',
          delivery: null, execution: 'not-run', observation: 'unknown',
          blockers: [{ code: 'deliveryUnsupported', message: 'blocked' }], requiredBy: ['official/demo'] },
        { pluginId: 'official/other', agent: 'codex', scope: 'user',
          delivery: { kind: 'native', platform: 'codex' }, execution: 'applied',
          observation: 'verified', blockers: [], requiredBy: ['official/other'] },
        { pluginId: 'official/other', agent: 'claude-code', scope: 'user',
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
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn().mockResolvedValue(recovery('user')), prepareScopedTask,
      executeScopedTask: vi.fn().mockResolvedValue({ kind: 'recovery', receipt }) });
    await controller.load();
    controller.push({ name: 'intentInventory', scope: 'user' });
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
    await tick();
    await press(instance, 'c');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('本次影响'));
    await press(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('重试明确失败项（2）'));
    expect(checkedFrame(instance, sizes[0]!)).toContain('检查未确认项（2）');
    expect(checkedFrame(instance, sizes[0]!)).toContain('重试明确失败项（2）');
    await focusAction(instance, '重试明确失败项（2）');
    await press(instance, '\r');
    await vi.waitFor(() => expect(prepareScopedTask).toHaveBeenCalledTimes(2));
    expect(prepareScopedTask.mock.calls[1]?.[0]).toMatchObject({ kind: 'recovery', scope: 'user',
      command: 'sync', selectors: ['official/demo', 'official/other'],
      targets: ['codex', 'claude-code'], exactTargets: [
        { pluginId: 'official/demo', agent: 'codex' },
        { pluginId: 'official/other', agent: 'claude-code' },
      ] });
    await vi.waitFor(() => expect(retryPlan).toBeDefined());
    expect(retryPlan?.receipt.selection).toMatchObject({
      agents: ['claude-code', 'codex'], origin: 'argument',
    });
    expect(retryPlan?.receipt.requestedTargets).toMatchObject([
      { pluginId: 'official/demo', agent: 'codex' },
      { pluginId: 'official/other', agent: 'claude-code' },
    ]);
    expect(retryPlan?.receipt.blockers.map((entry) => entry.code)).not.toContain('invalidExactTargets');
    expect(await observePreferences(location)).toEqual(previousPreferences);
    instance.unmount();
    await retryPlan?.context.dispose();
  });

  it('offers read-only recheck for diagnosed unknowns and retries only a known missing partial pair', async () => {
    const receipt: RecoveryReceipt = { schemaVersion: 1, kind: 'aw-recovery', scope: 'user',
      command: 'sync', ok: false, intent: { state: 'valid', roots: ['official/demo'] },
      requestedRoots: ['official/demo'], requestedTargets: [], selection: {
        agents: ['codex', 'claude-code', 'cursor'], origin: 'preference', preferences: 'valid',
      }, blockers: [], errors: [], targetResults: [
        { pluginId: 'official/demo', agent: 'codex', scope: 'user',
          delivery: { kind: 'native', platform: 'codex' }, execution: 'failed',
          observation: 'unknown', content: 'unknown',
          blockers: [{ code: 'nativeRecoveryFailed', message: 'diagnosed' }], requiredBy: ['official/demo'] },
        { pluginId: 'official/demo', agent: 'claude-code', scope: 'user',
          delivery: { kind: 'agent-skills', provider: 'skills-cli', agentId: 'claude-code' },
          execution: 'failed', observation: 'unknown', content: 'conflict',
          blockers: [{ code: 'portableOutputConflict', message: 'external content' }], requiredBy: ['official/demo'] },
        { pluginId: 'official/demo', agent: 'cursor', scope: 'user',
          delivery: { kind: 'agent-skills', provider: 'skills-cli', agentId: 'cursor' },
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
    const loadScopedStatus = vi.fn().mockResolvedValue(recovery('user'));
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status),
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
    expect(prepareScopedTask.mock.calls[1]?.[0]).toMatchObject({ kind: 'recovery',
      exactTargets: [{ pluginId: 'official/demo', agent: 'cursor' }] });
    await press(instance, '\u001b');
    await press(instance, 'c');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    await press(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    const reads = loadScopedStatus.mock.calls.length;
    await focusAction(instance, '检查未确认项（2）');
    await press(instance, '\r');
    await vi.waitFor(() => expect(loadScopedStatus.mock.calls.length).toBeGreaterThan(reads));
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
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status),
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
    expect(review).toContain('需求变更（计划）：保存当前范围需求');
    expect(review).toContain('输出变更（计划）：执行所列精确目标');
    await press(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    const result = checkedFrame(instance, sizes[0]!);
    expect(result).toContain('需求变更：无');
    expect(result).toContain('输出可能改变：否');
    instance.unmount();
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
      const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status),
        loadScopedStatus: vi.fn().mockResolvedValue(recovery('project')),
        prepareScopedTask: vi.fn().mockResolvedValue(plan) });
      await controller.load();
      controller.push({ name: 'intentInventory', scope: 'project', projectKey: '/tmp/project' });
      const instance = render(<ConsoleAppV4 controller={controller} size={sizes[1]!} />);
      await tick();
      await press(instance, 'c');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
      expect(checkedFrame(instance, sizes[1]!)).toContain('1 /');
      await press(instance, '\u001b[6~');
      expect(checkedFrame(instance, sizes[1]!)).toContain('2 /');
      instance.rerender(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
      await tick();
      expect(checkedFrame(instance, sizes[0]!)).toContain('本次影响');
      await press(instance, 'y');
      await vi.waitFor(() => expect(copy).toHaveBeenCalledWith(expect.stringContaining('检查说明 18')));
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
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn(async (scope: 'user' | 'project') => scope === 'user' ? personal : project),
      prepareScopedTask });
    await controller.load();
    await controller.refreshScopedInventory('user');
    await controller.refreshScopedInventory('project');
    controller.push({ name: 'pluginDetail', pluginId: 'official/demo' });
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
    await tick();
    const detail = checkedFrame(instance, sizes[0]!);
    expect(detail).toContain('个人清单');
    expect(detail).toContain('已声明');
    expect(detail).toContain('当前项目清单');
    expect(detail).toContain('未声明');
    expect(detail).toContain('使用位置');
    expect(detail).toContain('未确认');
    await focusAction(instance, '移出插件清单（保留安装）');
    await press(instance, '\r');
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({ kind: 'intent',
      action: 'remove', scope: 'user', selector: 'official/demo' }), expect.anything());
    instance.unmount();
  });

  it.each([
    { name: 'User Portable', scope: 'user' as const, kind: 'portable' as const },
    { name: 'shared Native', scope: 'project' as const, kind: 'shared' as const },
    { name: 'retirement config deletion', scope: 'project' as const, kind: 'retire' as const },
    { name: 'User retirement output', scope: 'user' as const, kind: 'retire' as const },
  ])('requires a separate, default-return risk confirmation for $name', async ({ scope, kind }) => {
    const current = recovery(scope);
    if (kind === 'retire') current.inventory![0]!.blockers = [{ code: 'pluginUnavailable', message: 'removed' }];
    const receipt: RecoveryReceipt = { schemaVersion: 1, kind: 'aw-recovery', scope,
      command: kind === 'retire' ? 'intent:retire' : 'sync', ok: true,
      intent: { state: 'valid', roots: ['official/demo'] }, requestedRoots: ['official/demo'],
      requestedTargets: [], selection: { agents: ['codex'], origin: 'preference', preferences: 'valid' },
      blockers: [], errors: [], targetResults: [], remainingTargets: [], recoveryActions: [],
      declarationChanged: false, preferencesChanged: false, configChanged: false,
      outputsMayHaveChanged: false };
    const plan = kind === 'retire' ? { kind: 'retire', scope, plan: {
      receipt, options: { deleteConfig: scope === 'project' },
      plannedImpact: { declaration: true, preferences: true, config: scope === 'project', outputs: true },
      changes: ['删除当前范围声明。'], warnings: [], context: { dispose: async () => {} },
    } } : { kind: 'recovery', scope, plan: { receipt,
      plannedImpact: { declaration: false, preferences: false, config: false, outputs: true },
      changes: [], warnings: [], context: { dispose: async () => {} },
      nativeGroups: kind === 'shared' ? [{ preview: { codexReconcilePlans: [{ review: {
        requiresConfirmation: true, sharedImpact: { warning: '共享内容可能影响其他项目。' },
      } }] } }] : [],
      portableGroups: kind === 'portable' ? [{}] : [],
    } } as unknown as ScopedTuiPlan;
    const executeScopedTask = vi.fn().mockResolvedValue({ kind: 'recovery', receipt });
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn().mockResolvedValue(current),
      prepareScopedTask: vi.fn().mockResolvedValue(plan), executeScopedTask });
    await controller.load();
    controller.push({ name: 'intentInventory', scope,
      ...(scope === 'project' ? { projectKey: '/tmp/project' } : {}) });
    const size = kind === 'portable' ? sizes[1]! : sizes[0]!;
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await tick();
    if (kind === 'retire') await focusAction(instance, scope === 'project'
      ? '停用已移除插件并删除设置' : '停用已移除插件（保留设置）');
    else await press(instance, 'c');
    if (kind === 'retire') await press(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    await press(instance, '\r');
    expect(checkedFrame(instance, size)).toContain('请确认本次风险');
    expect(checkedFrame(instance, size)).toContain('返回检查');
    expect(checkedFrame(instance, size)).toContain('› 返回检查');
    expect(checkedFrame(instance, size)).toContain(kind === 'portable' ? '适用于所有项目'
      : kind === 'shared' ? '共享内容可能影响其他项目'
        : scope === 'user' ? '可能影响其他项目' : '删除所选范围已保存的插件设置');
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

  it.each(['user', 'project'] as const)('allows %s Portable needs-preparation into a new Review', async (scope) => {
    const current = recovery(scope);
    current.selection.agents = ['cursor'];
    current.inventory![0]!.targetResults = [{ pluginId: 'official/demo', agent: 'cursor', scope,
      delivery: { kind: 'agent-skills', provider: 'skills-cli', agentId: 'cursor' },
      execution: 'not-run', observation: 'unknown', content: 'unknown',
      blockers: [{ code: 'needs-preparation', message: 'prepare first' }], requiredBy: ['official/demo'] }];
    const plan = { kind: 'recovery', scope, plan: { receipt: {
      requestedRoots: ['official/demo'], selection: { agents: ['cursor'] }, targetResults: [],
    }, plannedImpact: { declaration: false, preferences: false, config: false, outputs: true },
    changes: ['首次准备后同步'], warnings: [], context: { dispose: async () => {} },
    } } as unknown as ScopedTuiPlan;
    const prepareScopedTask = vi.fn().mockResolvedValue(plan);
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status),
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
      kind: 'recovery', scope, selectors: [],
    }), expect.anything());
    instance.unmount();
  });

  it.each(['user', 'project'] as const)('projects %s readonly Portable needs-preparation from status into Ink', async (scope) => {
    const inspect = vi.spyOn(portableRecovery, 'inspectPortableRecovery')
      .mockResolvedValue({ blockers: ['needs-preparation'], targets: [] } as never);
    try {
      const demand = { scope, intent: { state: 'valid', value: { schemaVersion: 3,
        kind: 'aw-plugin-intents', sources: { official: { logicalIdentity: 'official' } },
        roots: [{ pluginId: 'official/demo' }] }, digest: 'intent', rawDigest: 'intent', rawBytes: Buffer.from('{}') },
      preferences: { state: 'valid', value: { schemaVersion: 1,
        kind: 'aw-deployment-preferences', agents: ['cursor'], dependencyScopeOverrides: [] },
      digest: 'preferences', rawDigest: 'preferences', rawBytes: Buffer.from('{}') },
      roots: [{ pluginId: 'official/demo', sourceId: 'official', sourceState: 'ready', blockers: [],
        plugin: { manifest: { distributions: { agentSkills: {} } } } }], plugins: [], errors: [],
      } as unknown as DemandSnapshot;
      const projected = await statusFromObservations({ scope, cwd: '/tmp/project',
        context: { scope } as ScopeContext, demand, nativeObservations: [] });
      expect(projected.inventory?.[0]?.targetResults[0]).toMatchObject({ agent: 'cursor',
        delivery: { kind: 'agent-skills' }, observation: 'unknown',
        blockers: [{ code: 'needs-preparation' }] });
      const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status),
        loadScopedStatus: vi.fn().mockResolvedValue({ ...projected, nativeSnapshot: recovery(scope).nativeSnapshot }) });
      await controller.load();
      controller.push({ name: 'intentInventory', scope,
        ...(scope === 'project' ? { projectKey: '/tmp/project' } : {}) });
      const instance = render(<ConsoleAppV4 controller={controller} size={sizes[1]!} />);
      await tick();
      expect(checkedFrame(instance, sizes[1]!)).toContain('同步可执行项（1）');
      instance.unmount();
    } finally { inspect.mockRestore(); }
  });

  it.each(['user', 'project'] as const)('keeps explicit Portable drifted %s targets pending and syncable in Ink', async (scope) => {
    const inspect = vi.spyOn(portableRecovery, 'inspectPortableRecovery')
      .mockResolvedValue({ blockers: [], targets: [{ agent: 'cursor', observation: 'drifted' }] } as never);
    try {
      const demand = { scope, intent: { state: 'valid', value: { schemaVersion: 3,
        kind: 'aw-plugin-intents', sources: { official: { logicalIdentity: 'official' } },
        roots: [{ pluginId: 'official/demo' }] }, digest: 'intent', rawDigest: 'intent', rawBytes: Buffer.from('{}') },
      preferences: { state: 'valid', value: { schemaVersion: 1,
        kind: 'aw-deployment-preferences', agents: ['cursor'], dependencyScopeOverrides: [] },
      digest: 'preferences', rawDigest: 'preferences', rawBytes: Buffer.from('{}') },
      roots: [{ pluginId: 'official/demo', sourceId: 'official', sourceState: 'ready', blockers: [],
        plugin: { manifest: { distributions: { agentSkills: {} } } } }], plugins: [], errors: [],
      } as unknown as DemandSnapshot;
      const projected = await statusFromObservations({ scope, cwd: '/tmp/project',
        context: { scope } as ScopeContext, demand, nativeObservations: [] });
      expect(projected.inventory?.[0]?.targetResults[0]).toMatchObject({
        content: 'drifted', observation: 'unknown', blockers: [],
      });
      const view = buildScopedInventory({ recovery: projected, status: status.payload,
        pluginSummaries: status.pluginSummaries });
      expect(view.declaredRoots[0]?.state).toBe('pending');
      expect(view.syncTargets).toEqual([{ pluginId: 'official/demo', agent: 'cursor', scope }]);
      const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status),
        loadScopedStatus: vi.fn().mockResolvedValue({ ...projected, nativeSnapshot: recovery(scope).nativeSnapshot }) });
      await controller.load();
      controller.push({ name: 'intentInventory', scope,
        ...(scope === 'project' ? { projectKey: '/tmp/project' } : {}) });
      const instance = render(<ConsoleAppV4 controller={controller} size={sizes[1]!} />);
      await tick();
      expect(checkedFrame(instance, sizes[1]!)).toContain('同步可执行项（1）');
      instance.unmount();
    } finally { inspect.mockRestore(); }
  });

  it('shows incomplete Portable coverage in the scoped inventory', async () => {
    const current = recovery('project');
    current.coverage = { native: true, portable: false };
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status),
      loadScopedStatus: vi.fn().mockResolvedValue(current) });
    await controller.load();
    controller.push({ name: 'intentInventory', scope: 'project', projectKey: '/tmp/project' });
    const instance = render(<ConsoleAppV4 controller={controller} size={sizes[0]!} />);
    await tick();
    expect(checkedFrame(instance, sizes[0]!)).toContain('通用 Skills 额外安装未完整覆盖');
    instance.unmount();
  });
});
