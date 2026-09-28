import { cleanup, render } from 'ink-testing-library';
import fs from 'fs-extra';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StatusV8Payload, StatusV8PluginSummary } from '../../src/commands/status-v6.js';
import type { RecoveryReceipt } from '../../src/recovery/receipt.js';
import { prepareRecovery } from '../../src/recovery/coordinator.js';
import { observePreferences, resolvePreferencesPath } from '../../src/intent/deployment-preferences.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type TuiControllerDependencies, type TuiStatusLoadResult } from '../../src/tui/controller.js';
import type { ConfigPageViewModel, UserIssueViewModel } from '../../src/tui/model.js';
import type { ScopedTuiPlan } from '../../src/tui/scoped-flow.js';
import { writeIntentFixture } from '../helpers/plugin-intent-fixture.js';
import { getCurrentSourceTestIsolation } from '../setup/test-isolation.js';

const pluginId = 'official/demo';
const userTarget = { pluginId, platform: 'codex' as const, scope: 'user' as const };
const projectTarget = { pluginId, platform: 'claude' as const, scope: 'project' as const };
const userKey = `${pluginId}\0codex\0user`;
const projectKey = `${pluginId}\0claude\0project`;
afterEach(() => cleanup());

function loaded(): TuiStatusLoadResult {
  const target: StatusV8Payload['targets'][number] = {
    pluginName: 'demo', pluginId, sourceId: 'official', sourceIdentity: 'identity:official',
    version: '2.0.0', platform: 'codex', cwd: '/workspace', state: 'ready',
    components: [], reasons: [], recoveryActions: [], placements: [{
      scope: 'user', state: 'ready', components: [{ kind: 'ownership', key: 'demo', state: 'present' }],
      reasons: [], recoveryActions: [],
    }],
  };
  const summary: StatusV8PluginSummary = {
    pluginName: 'demo', pluginId, displayName: 'Demo', description: '演示插件', version: '2.0.0',
    supportedTargets: { codex: ['user'], claude: ['project'] }, configFieldCount: 0,
  };
  return {
    payload: {
      schemaVersion: 8, catalog: { primarySourceId: 'official', configDigest: 'config',
        compositeDigest: 'catalog', sources: [{ id: 'official', identity: 'identity:official',
          type: 'path', primary: true, requestedRef: 'path', freshness: 'active',
          catalogVersion: '2.0.0' }] },
      filters: { plugins: [], platform: 'both', cwd: '/workspace' }, targets: [target], errors: [],
    },
    pluginSummaries: [summary],
    targetRevisions: [{ pluginId, platform: 'codex', scope: 'user', revision: {
      state: 'upgradeAvailable', installedVersion: '1.0.0', availableVersion: '2.0.0',
    } }],
    catalogGenerations: [{ sourceId: 'official', sourceType: 'path', state: 'ready', active: {
      catalogVersion: '2.0.0', channel: 'latest', requestedRef: 'path', resolvedCommit: 'path',
      storeKey: 'official/active', digestShort: 'official',
    } }],
    projectRoot: '/workspace',
  };
}

type ScopedRequest = Parameters<TuiController['prepareScopedTask']>[0];
function receipt(request: Extract<ScopedRequest, { kind: 'recovery' }>, failed = false): RecoveryReceipt {
  const exactTargets = request.exactTargets ?? [];
  return {
    schemaVersion: 1, kind: 'aw-recovery', scope: request.scope, command: request.command ?? 'sync',
    ok: !failed, intent: { state: 'valid', roots: request.selectors ?? [] },
    requestedRoots: request.selectors ?? [],
    requestedTargets: exactTargets.map((target) => ({ ...target, scope: request.scope,
      delivery: { kind: 'native', platform: target.agent === 'claude-code' ? 'claude' : 'codex' } })),
    selection: { agents: exactTargets.map((target) => target.agent), origin: 'argument',
      preferences: 'valid' }, blockers: [], errors: [],
    targetResults: exactTargets.map((target, index) => ({
      ...target, scope: request.scope, delivery: { kind: 'native' as const,
        platform: target.agent === 'claude-code' ? 'claude' as const : 'codex' as const },
      execution: failed && index === 0 ? 'failed' as const : 'applied' as const,
      observation: failed && index === 0 ? 'missing' as const : 'verified' as const,
      blockers: [], requiredBy: [target.pluginId],
    })),
    remainingTargets: failed ? exactTargets.slice(0, 1).map((target) => ({ ...target,
      scope: request.scope, delivery: { kind: 'native' as const,
        platform: target.agent === 'claude-code' ? 'claude' as const : 'codex' as const } })) : [],
    recoveryActions: [], declarationChanged: false, preferencesChanged: false,
    configChanged: false, outputsMayHaveChanged: true,
  };
}

function fixture(failed = false, extra: Partial<TuiControllerDependencies> = {}) {
  const requests: ScopedRequest[] = [];
  const plans: ScopedTuiPlan[] = [];
  const disposals: ReturnType<typeof vi.fn>[] = [];
  const prepareScopedTask = vi.fn(async (request: ScopedRequest): Promise<ScopedTuiPlan> => {
    if (request.kind !== 'recovery') throw new Error('unexpected scoped request');
    requests.push(request);
    const dispose = vi.fn(async () => {});
    disposals.push(dispose);
    const plan = { kind: 'recovery', scope: request.scope, plan: {
      changes: [], warnings: [], nativeGroups: [], portableGroups: [],
      context: { dispose }, receipt: receipt(request, failed),
      plannedImpact: { declaration: false, preferences: false, config: false, outputs: true },
    } } as ScopedTuiPlan;
    plans.push(plan);
    return plan;
  });
  const executeScopedTask: NonNullable<TuiControllerDependencies['executeScopedTask']> = vi.fn(
    async (plan) => ({ kind: 'recovery', receipt: plan.kind === 'recovery'
      ? plan.plan.receipt : (() => { throw new Error('unexpected plan'); })() }));
  const value = new TuiController({ loadStatus: async () => loaded(), prepareScopedTask,
    executeScopedTask, ...extra });
  return { value, requests, plans, disposals, prepareScopedTask, executeScopedTask };
}

async function write(instance: ReturnType<typeof render>, key: string): Promise<void> {
  instance.stdin.write(key);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
async function focusAction(instance: ReturnType<typeof render>, label: string): Promise<void> {
  for (let index = 0; index < 24; index += 1) {
    if ((instance.lastFrame() ?? '').includes(`› ${label}`)) return;
    await write(instance, '\u001b[B');
  }
  throw new Error(`Action was not reachable: ${label}\n${instance.lastFrame()}`);
}

 describe('TUI plugin write task uses scoped recovery', () => {
  it.each([
    { name: 'empty preferences', savedAgents: [] as const, corrupt: false },
    { name: 'different saved Agent', savedAgents: ['cursor'] as const, corrupt: false },
    { name: 'invalid preferences', savedAgents: ['cursor'] as const, corrupt: true },
  ])('prepares an exact task with $name through the real recovery selector',
    async ({ savedAgents, corrupt }) => {
      const isolation = getCurrentSourceTestIsolation();
      const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd,
        env: isolation.env };
      await writeIntentFixture(location, { roots: [{ pluginId }], agents: savedAgents });
      if (corrupt) await fs.writeFile(await resolvePreferencesPath(location), '{');
      const previousPreferences = await observePreferences(location);
      const prepared: Array<Awaited<ReturnType<typeof prepareRecovery>>> = [];
      const prepareScopedTask = vi.fn(async (request: ScopedRequest): Promise<ScopedTuiPlan> => {
        if (request.kind !== 'recovery') throw new Error('unexpected scoped request');
        const plan = await prepareRecovery(request.command ?? 'sync', request.selectors, {
          ...location, cliVersion: '0.1.0', targets: request.targets,
          exactTargets: request.exactTargets,
        });
        prepared.push(plan);
        return { kind: 'recovery', scope: request.scope, plan };
      });
      const value = new TuiController({ loadStatus: async () => loaded(), prepareScopedTask });
      try {
        await value.load();
        vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([{ target: userTarget,
          displayName: 'Demo', sourceId: 'official', eligible: true,
          recommendedMethod: 'sync', issueIds: [] }]);
        value.push({ name: 'pluginWriteTask', pluginId, goal: 'restore', targetKeys: [userKey] });
        const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
        await vi.waitFor(() => expect(prepared).toHaveLength(1));
        if (corrupt) {
          expect(prepared[0]!.blockExecution).toBe(true);
          expect(prepared[0]!.receipt.selection.preferences).toBe('invalid');
          expect(prepared[0]!.receipt.requestedTargets).toEqual([]);
        } else {
          expect(prepared[0]!.receipt.selection).toMatchObject({ agents: ['codex'], origin: 'argument' });
          expect(prepared[0]!.receipt.requestedTargets).toMatchObject([{ pluginId, agent: 'codex' }]);
          expect(prepared[0]!.receipt.blockers.map((entry) => entry.code))
            .not.toContain('invalidExactTargets');
        }
        expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
          targets: ['codex'], exactTargets: [{ pluginId, agent: 'codex' }],
        }), expect.any(AbortSignal));
        expect(await observePreferences(location)).toEqual(previousPreferences);
        instance.unmount();
      } finally {
        value.dispose();
        await Promise.all(prepared.map((plan) => plan.context.dispose()));
      }
    },
  );

  it.each([
    { command: 'uninstall' as const, action: '卸载所选插件', maintenance: false },
    { command: 'cleanup' as const, action: '清理遗留内容', maintenance: true },
  ])('prepares offline batch $command for its exact observed target without Intent', async (
    { command, action, maintenance },
  ) => {
    const isolation = getCurrentSourceTestIsolation();
    const location = { scope: 'user' as const, cwd: isolation.layout.fixtureCwd,
      env: isolation.env };
    await writeIntentFixture(location, { roots: [], agents: ['cursor'] });
    const previousPreferences = await observePreferences(location);
    const prepared: Array<Awaited<ReturnType<typeof prepareRecovery>>> = [];
    const prepareScopedTask = vi.fn(async (request: ScopedRequest): Promise<ScopedTuiPlan> => {
      if (request.kind !== 'recovery') throw new Error('unexpected scoped request');
      const plan = await prepareRecovery(request.command ?? 'sync', request.selectors, {
        ...location, cliVersion: '0.1.0', targets: request.targets,
        exactTargets: request.exactTargets,
      });
      prepared.push(plan);
      return { kind: 'recovery', scope: request.scope, plan };
    });
    const value = new TuiController({ loadStatus: async () => loaded(), prepareScopedTask });
    try {
      await value.load();
      vi.spyOn(value, 'listPluginWriteBatchTargets').mockReturnValue([userTarget]);
      value.push({ name: 'pluginList', mode: 'installed' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
      await write(instance, 'm');
      await write(instance, ' ');
      await write(instance, 'c');
      if (maintenance) {
        await focusAction(instance, '其他维护方式');
        await write(instance, '\r');
      }
      await focusAction(instance, action);
      await write(instance, '\r');
      await vi.waitFor(() => expect(prepared).toHaveLength(1));
      expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
        command, targets: ['codex'], exactTargets: [{ pluginId, agent: 'codex' }],
      }), expect.any(AbortSignal));
      expect(prepared[0]!.receipt.requestedRoots).toEqual([pluginId]);
      expect(prepared[0]!.receipt.selection).toMatchObject({ agents: ['codex'], origin: 'argument' });
      expect(prepared[0]!.receipt.requestedTargets).toMatchObject([{ pluginId, agent: 'codex' }]);
      expect(prepared[0]!.receipt.blockers.map((entry) => entry.code))
        .not.toContain('syncPluginNotDesired');
      expect(await observePreferences(location)).toEqual(previousPreferences);
      instance.unmount();
    } finally {
      value.dispose();
      await Promise.all(prepared.map((plan) => plan.context.dispose()));
    }
  });

  it('prepares a single exact user update and executes the reviewed plan', async () => {
    const fixtureValue = fixture();
    const { value, requests, executeScopedTask } = fixtureValue;
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await focusAction(instance, '更新 1 个');
    await write(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(requests).toEqual([expect.objectContaining({ kind: 'recovery', command: 'reinstall',
      scope: 'user', selectors: [pluginId], exactTargets: [{ pluginId, agent: 'codex' }] })]);
    expect(instance.lastFrame()).toContain('范围：个人（所有项目）');
    expect(executeScopedTask).not.toHaveBeenCalled();
    await write(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    expect(executeScopedTask).toHaveBeenCalledOnce();
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
    value.dispose();
  });

  it('cancels the scoped restore Review and releases its prepared context', async () => {
    const { value, requests, plans, disposals, executeScopedTask } = fixture();
    await value.load();
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([{ target: userTarget,
      displayName: 'Demo', sourceId: 'official', eligible: true, recommendedMethod: 'sync',
      issueIds: [] }]);
    value.push({ name: 'pluginWriteTask', pluginId, goal: 'restore', targetKeys: [userKey] });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(requests).toEqual([expect.objectContaining({ kind: 'recovery', command: 'sync',
      scope: 'user', exactTargets: [{ pluginId, agent: 'codex' }] })]);
    await write(instance, '\u001b');
    await vi.waitFor(() => expect(disposals[0]).toHaveBeenCalledOnce());
    expect(executeScopedTask).not.toHaveBeenCalled();
    await expect(value.executeScopedTask(plans[0]!)).rejects.toThrow('reviewTicketInvalid');
    expect(value.snapshot.router.current.route.name).toBe('pluginWriteTask');
    value.dispose();
  });

  it('keeps a mixed-scope task out of Review until one scope is selected', async () => {
    const { value, prepareScopedTask } = fixture();
    await value.load();
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([
      { target: userTarget, displayName: 'Demo', sourceId: 'official', eligible: true,
        recommendedMethod: 'sync', issueIds: [] },
      { target: projectTarget, displayName: 'Demo', sourceId: 'official', eligible: true,
        recommendedMethod: 'sync', issueIds: [] },
    ]);
    value.push({ name: 'pluginWriteTask', pluginId, goal: 'restore',
      targetKeys: [userKey, projectKey] });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await write(instance, '');
    expect(instance.lastFrame()).toContain('先处理所有项目 1 个位置');
    expect(prepareScopedTask).not.toHaveBeenCalled();
    await write(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({ kind: 'recovery',
      scope: 'user', exactTargets: [{ pluginId, agent: 'codex' }] }), expect.any(AbortSignal));
    value.dispose();
  });

  it.each([[80, 24], [60, 18]] as const)(
    'requires an explicit subset choice with a blocked target at %ix%i', async (columns, rows) => {
      const { value, requests } = fixture();
      await value.load();
      vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([
        { target: userTarget, displayName: 'Demo', sourceId: 'official', eligible: true,
          recommendedMethod: 'sync', issueIds: [] },
        { target: projectTarget, displayName: 'Demo', sourceId: 'official', eligible: false,
          blockReason: 'manualRecoveryRequired', issueIds: ['manual:demo'] },
      ]);
      value.push({ name: 'pluginWriteTask', pluginId, goal: 'restore' });
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
      await write(instance, '');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('1 个可执行 · 1 个需决定');
      expect(frame).toContain('需要选择手动处理方式');
      expect(frame).toContain('先处理所有项目 1 个位置');
      expect(requests).toHaveLength(0);
      expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
      expect(frame.split('\n').every((line) => stringWidth(line) <= columns)).toBe(true);
      await write(instance, '\r');
      await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
      expect(requests).toEqual([expect.objectContaining({ scope: 'user',
        exactTargets: [{ pluginId, agent: 'codex' }] })]);
      value.dispose();
    },
  );

  it('does not broaden a frozen restore selection when its target disappears', async () => {
    const { value, prepareScopedTask } = fixture();
    await value.load();
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([]);
    value.push({ name: 'pluginWriteTask', pluginId, goal: 'restore', targetKeys: [userKey] });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await write(instance, '');
    expect(instance.lastFrame()).not.toContain('操作汇总');
    expect(prepareScopedTask).not.toHaveBeenCalled();
    value.dispose();
  });

  it('does not silently add a newly discovered target to a frozen update recommendation', async () => {
    const { value, prepareScopedTask } = fixture();
    await value.load();
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([
      { target: userTarget, displayName: 'Demo', sourceId: 'official', eligible: true,
        recommendedMethod: 'sync', issueIds: [] },
      { target: { pluginId, platform: 'claude', scope: 'user' }, displayName: 'Demo',
        sourceId: 'official', eligible: true, recommendedMethod: 'sync', issueIds: [] },
    ]);
    value.push({ name: 'pluginWriteTask', pluginId, goal: 'update',
      targetKeys: [userKey], recommendedPluginIds: [pluginId] });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await write(instance, '');
    expect(instance.lastFrame()).toContain('新位置需要重新确认');
    expect(instance.lastFrame()).not.toContain('确认更新 2 个位置');
    expect(prepareScopedTask).not.toHaveBeenCalled();
    value.dispose();
  });

  it('replaces a cancelled Review with one scoped to the adjusted frozen target', async () => {
    const { value, plans, requests, disposals } = fixture();
    await value.load();
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([
      { target: userTarget, displayName: 'Demo', sourceId: 'official', eligible: true,
        recommendedMethod: 'sync', issueIds: [] },
      { target: { pluginId, platform: 'claude', scope: 'user' }, displayName: 'Demo',
        sourceId: 'official', eligible: true, recommendedMethod: 'sync', issueIds: [] },
    ]);
    value.push({ name: 'pluginWriteTask', pluginId, goal: 'restore', targetKeys: [userKey] });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    await write(instance, '\u001b');
    await vi.waitFor(() => expect(disposals[0]).toHaveBeenCalledOnce());
    await expect(value.executeScopedTask(plans[0]!)).rejects.toThrow('reviewTicketInvalid');
    value.push({ name: 'pluginWriteTask', pluginId, goal: 'restore',
      targetKeys: [`${pluginId}\0claude\0user`] });
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]).toMatchObject({ scope: 'user', exactTargets: [{ pluginId, agent: 'codex' }] });
    expect(requests[1]).toMatchObject({ scope: 'user',
      exactTargets: [{ pluginId, agent: 'claude-code' }] });
    value.dispose();
  });

  it('retries only a confirmed failed target through a fresh Review', async () => {
    const { value, requests, prepareScopedTask } = fixture(true);
    await value.load();
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([
      { target: userTarget, displayName: 'Demo', sourceId: 'official', eligible: true,
        recommendedMethod: 'sync', issueIds: [] },
      { target: { pluginId, platform: 'claude', scope: 'user' }, displayName: 'Demo',
        sourceId: 'official', eligible: true, recommendedMethod: 'sync', issueIds: [] },
    ]);
    value.push({ name: 'pluginWriteTask', pluginId, goal: 'restore',
      targetKeys: [userKey, `${pluginId}\0claude\0user`] });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(requests[0]).toMatchObject({ scope: 'user', exactTargets: [
      { pluginId, agent: 'codex' }, { pluginId, agent: 'claude-code' },
    ] });
    await write(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    await focusAction(instance, '重试明确失败项（1）');
    await write(instance, '\r');
    await vi.waitFor(() => expect(prepareScopedTask).toHaveBeenCalledTimes(2));
    expect(requests[1]).toMatchObject({ kind: 'recovery', command: 'sync', scope: 'user',
      selectors: [pluginId], exactTargets: [{ pluginId, agent: 'codex' }] });
    value.dispose();
  });

  it('keeps a batch-origin task route while a nested update uses scoped Review', async () => {
    const { value, requests } = fixture();
    await value.load();
    const route = { name: 'pluginWriteTask' as const, pluginId, goal: 'update' as const,
      targetKeys: [userKey], batchOrigin: { owner: 'batch-write' as const, flowId: 'batch-1' } };
    value.push(route);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await write(instance, '');
    await focusAction(instance, '确认更新 1 个位置');
    await write(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(requests).toEqual([expect.objectContaining({ command: 'reinstall', scope: 'user',
      exactTargets: [{ pluginId, agent: 'codex' }] })]);
    await write(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    expect(value.snapshot.router.current.route).toMatchObject(route);
    await focusAction(instance, '返回插件任务');
    await write(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'pluginDetail', pluginId });
    value.dispose();
  });

  it('returns from a nested update to the frozen parent restore task', async () => {
    const { value, requests } = fixture();
    await value.load();
    const listCandidates = vi.spyOn(value, 'listPluginWriteTaskCandidates');
    listCandidates.mockImplementation((goal) => goal === 'restore' ? [{
      target: userTarget, displayName: 'Demo', sourceId: 'official', eligible: false,
      blockReason: 'restoreVersionChanged', issueIds: [],
    }] : [{
      target: { ...userTarget, expectedUpdate: { installedVersion: '1.0.0',
        activeVersion: '2.0.0', sourceIdentity: 'identity:official',
        generationKey: 'official/active' } },
      displayName: 'Demo', sourceId: 'official', eligible: true,
      recommendedMethod: 'sync', issueIds: [],
    }]);
    const parent = { name: 'pluginWriteTask' as const, pluginId, goal: 'restore' as const,
      targetKeys: [userKey] };
    value.push(parent);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await focusAction(instance, '更新并恢复 Demo · Codex · 所有项目');
    await write(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'pluginWriteTask', goal: 'update' });
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(requests).toEqual([expect.objectContaining({ command: 'reinstall', scope: 'user',
      exactTargets: [{ pluginId, agent: 'codex' }] })]);
    await write(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    await focusAction(instance, '返回插件任务');
    await write(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject(parent);
    value.dispose();
  });

  it('preserves batch ownership through a nested update and closes the successful batch', async () => {
    const { value, requests } = fixture();
    await value.load();
    let updated = false;
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockImplementation((goal) => goal === 'restore'
      ? [{ target: userTarget, displayName: 'Demo', sourceId: 'official', eligible: updated,
        ...(updated ? { recommendedMethod: 'sync' as const }
          : { blockReason: 'restoreVersionChanged' as const }), issueIds: [] }]
      : [{ target: { ...userTarget, expectedUpdate: { installedVersion: '1.0.0',
          activeVersion: '2.0.0', sourceIdentity: 'identity:official',
          generationKey: 'official/active' } }, displayName: 'Demo', sourceId: 'official',
        eligible: true, recommendedMethod: 'sync', issueIds: [] }]);
    value.push({ name: 'pluginList', mode: 'installed' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await write(instance, 'm');
    await write(instance, ' ');
    await write(instance, 'c');
    await focusAction(instance, '恢复所选中的 1 个插件');
    await write(instance, '\r');
    const parent = value.snapshot.router.current.route;
    expect(parent).toMatchObject({ name: 'pluginWriteTask', goal: 'restore',
      batchOrigin: { owner: 'batch-write', flowId: expect.any(String) } });
    expect(value.hasSessionDraft).toBe(true);
    await focusAction(instance, '更新并恢复 Demo · Codex · 所有项目');
    await write(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'pluginWriteTask',
      goal: 'update', batchOrigin: (parent as Extract<typeof parent,
      { name: 'pluginWriteTask' }>).batchOrigin });
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    await write(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    updated = true;
    await focusAction(instance, '返回插件任务');
    await write(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject(parent);
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ kind: 'recovery', command: 'sync', scope: 'user',
      exactTargets: [{ pluginId, agent: 'codex' }] });
    await write(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('恢复结果'));
    await focusAction(instance, '返回插件列表');
    await write(instance, '\r');
    expect(value.snapshot.router.current.route).toMatchObject({ name: 'pluginList', mode: 'installed' });
    expect(value.hasSessionDraft).toBe(false);
    value.dispose();
  });

  it('confirms source activation separately and rejects changed version evidence', async () => {
    let activated = false;
    const catalogCandidate = {
      sourceId: 'official', sourceConfigFingerprint: 'sha256:source',
      sourceIdentity: 'identity:official', logicalIdentity: 'workspace:official',
      requestedRef: 'path', resolvedCommit: 'path', catalogVersion: '3.0.0',
      channel: 'latest' as const, manifestDigest: `sha256:${'1'.repeat(64)}`,
      snapshotDigest: `sha256:${'2'.repeat(64)}`,
    };
    const { value, prepareScopedTask } = fixture(false, {
      captureEvidence: vi.fn(async () => ({
        catalog: { configDigest: 'sha256:config', compositeDigest: catalogCandidate.snapshotDigest },
        catalogGeneration: { action: 'update', candidate: catalogCandidate,
          activationMode: 'normal', configDigest: 'sha256:config' },
      })),
      executeIntent: vi.fn(async () => { activated = true; return { status: 'succeeded' }; }),
      now: () => 1_000, reviewTtlMs: 10_000,
    });
    await value.load();
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockImplementation(() => [{
      target: activated ? { ...userTarget, expectedUpdate: {
        installedVersion: '1.0.0', activeVersion: '3.0.0',
        sourceIdentity: 'identity:official', generationKey: 'official/active',
      } } : userTarget,
      displayName: 'Demo', sourceId: 'official', eligible: activated,
      ...(activated ? { recommendedMethod: 'sync' as const }
        : { blockReason: 'catalogActivationRequired' as const }), issueIds: [],
    }]);
    const taskRoute = { name: 'pluginWriteTask' as const, pluginId, goal: 'update' as const,
      targetKeys: [userKey], versionEvidence: { [userKey]: '2.0.0' } };
    value.push(taskRoute);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await write(instance, '');
    expect(instance.lastFrame()).toContain('先更新来源目录 official');
    expect(prepareScopedTask).not.toHaveBeenCalled();
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    expect(value.snapshot.activeReview?.operationKind).toBe('catalogGeneration');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('result'));
    await focusAction(instance, '重新准备插件更新');
    await write(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual(taskRoute);
    expect(instance.lastFrame()).toContain('插件目标版本已变化');
    expect(instance.lastFrame()).toContain('使用当前版本重新准备');
    expect(prepareScopedTask).not.toHaveBeenCalled();
    await write(instance, '\r');
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'recovery', command: 'reinstall', scope: 'user',
      exactTargets: [{ pluginId, agent: 'codex' }],
    }), expect.any(AbortSignal));
    value.dispose();
  });

  it.each([
    ['sourceMissing', 'sourceRemoved', 'archive', '重新添加来源 archive', 'issueDetail'],
    ['sourceUnavailable', 'sourceUnavailable', 'official', '核对来源 official', 'sourceDetail'],
  ] as const)('routes %s blockers to source recovery before scoped writes', async (
    category, group, sourceId, actionLabel, expectedRoute,
  ) => {
    const { value, prepareScopedTask } = fixture();
    await value.load();
    const issue = {
      issueId: `source:${sourceId}:${category}`, category, group,
      title: '插件来源不可用', explanation: '当前不能读取插件来源。',
      impact: ['不能恢复插件。'], entity: { kind: 'source', id: sourceId },
      pluginId, sourceId, actions: category === 'sourceMissing'
        ? [{ id: 'reAddSource', label: '重新添加同一来源' }]
        : [{ id: 'editSource', label: '编辑来源' }],
      technicalDetails: [], diagnostic: { severity: 'error', title: '来源不可用',
        userMessage: '当前不能读取插件来源。',
        impact: [{ state: 'blocked', message: '不能恢复插件。' }], nextStep: '处理来源。',
        technical: { code: category, stage: 'resolve-source', sourceId } },
    } as UserIssueViewModel;
    vi.spyOn(value, 'listUserIssues').mockReturnValue([issue]);
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([{ target: userTarget,
      displayName: 'Demo', sourceId, eligible: false,
      blockReason: 'restoreVersionUnverified', issueIds: [] }]);
    value.push({ name: 'pluginWriteTask', pluginId, goal: 'restore' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await focusAction(instance, actionLabel);
    expect(prepareScopedTask).not.toHaveBeenCalled();
    await write(instance, '\r');
    expect(value.snapshot.router.current.route.name).toBe(expectedRoute);
    value.dispose();
  });

  it('returns from a required config save to a freshly prepared restore task', async () => {
    let configured = false;
    const { value, prepareScopedTask } = fixture(false, {
      getConfigPage: vi.fn(async (requestedPluginId, layer): Promise<ConfigPageViewModel> => ({
        pluginId: requestedPluginId, layer, storedCount: configured ? 1 : 0, presets: [],
        groups: [{ id: 'required', title: '必填设置', advanced: false, fields: [{
          key: 'mode', title: '运行模式', type: 'string',
          definition: { type: 'string', choices: { allowCustom: false,
            presets: [{ id: 'safe', title: '安全', value: 'safe' }] } },
          choices: [{ id: 'safe', title: '安全', value: 'safe' }],
          displayValue: configured ? '安全' : '未设置', required: true,
          sensitive: false, writable: true, dirty: false, inherited: !configured,
          configured, sourceLabel: configured ? '个人默认' : '未设置',
          effectiveDisplayValue: configured ? '安全' : '未设置',
          effectiveSourceLabel: configured ? '个人默认' : '未设置',
          ...(configured ? { value: 'safe', draftValue: 'safe', effectiveValue: 'safe' } : {}),
          allowCustom: false, advanced: false,
        }] }],
      })),
      captureEvidence: vi.fn(async (intent) => {
        if (intent.kind !== 'configSaveBatch') throw new Error('unexpected intent');
        return {
          catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:composite' },
          source: { sourceId: 'official', sourceIdentity: 'identity:official',
            snapshotDigest: 'sha256:snapshot', contentDigest: 'sha256:content' },
          targetFingerprint: 'sha256:target',
          configBatch: { groups: intent.groups.map((group) => ({ scope: group.scope,
            targetFingerprint: `sha256:config-${group.scope}`,
            config: { scope: group.scope, storeDigest: `sha256:config-store-${group.scope}`,
              impactState: 'known' as const, affectedTargets: [{ platform: 'codex' as const,
                scope: group.scope }] },
          })) },
        };
      }),
      executeIntent: vi.fn(async (intent) => {
        if (intent.kind !== 'configSaveBatch') throw new Error('unexpected intent');
        configured = true;
        return { status: 'succeeded' as const, groups: intent.groups.map((group) => ({
          scope: group.scope, status: 'succeeded' as const, configSaved: true,
          applyRequested: intent.apply, applyStatus: 'notRequested' as const,
        })) };
      }),
      now: () => 1_000, reviewTtlMs: 10_000,
    });
    await value.load();
    const issue = {
      issueId: 'config:official/demo:mode', category: 'requiredConfigMissing', group: 'config',
      title: '缺少运行模式', explanation: '必须设置运行模式。', impact: ['插件不能恢复。'],
      entity: { kind: 'plugin', id: pluginId }, pluginId, platform: 'codex', scope: 'user',
      requiredFields: [{ key: 'mode', title: '运行模式', type: 'missing-required',
        source: 'missing', scope: 'user' }],
      actions: [{ id: 'openConfig', label: '完成设置' }], technicalDetails: [],
      diagnostic: { severity: 'error', title: '缺少设置', userMessage: '必须设置运行模式。',
        impact: [{ state: 'blocked', message: '插件不能恢复。' }], nextStep: '完成设置。',
        technical: { code: 'requiredConfigMissing', stage: 'read-config' } },
    } as UserIssueViewModel;
    vi.spyOn(value, 'listUserIssues').mockImplementation(() => configured ? [] : [issue]);
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockImplementation(() => [{
      target: userTarget, displayName: 'Demo', sourceId: 'official', eligible: configured,
      ...(configured ? { recommendedMethod: 'sync' as const }
        : { blockReason: 'manualRecoveryRequired' as const }),
      issueIds: configured ? [] : [issue.issueId],
    }]);
    value.push({ name: 'pluginWriteTask', pluginId, goal: 'restore', targetKeys: [userKey] });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await write(instance, '');
    expect(instance.lastFrame()).toContain('完成设置：运行模式');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('configFields'));
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('configFieldEditor'));
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('configLayer'));
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('configFields'));
    await write(instance, 's');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    await focusAction(instance, '改为只保存，稍后应用');
    await write(instance, '\r');
    await write(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('result'));
    await write(instance, 'b');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('pluginWriteTask'));
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    expect(prepareScopedTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'recovery', scope: 'user', command: 'sync',
      exactTargets: [{ pluginId, agent: 'codex' }],
    }), expect.any(AbortSignal));
    value.dispose();
  });

  it.each([[80, 24], [60, 18]] as const)('keeps Review within %ix%i', async (columns, rows) => {
    const { value } = fixture();
    await value.load();
    vi.spyOn(value, 'listPluginWriteTaskCandidates').mockReturnValue([{ target: userTarget,
      displayName: 'Demo', sourceId: 'official', eligible: true, recommendedMethod: 'sync',
      issueIds: [] }]);
    value.push({ name: 'pluginWriteTask', pluginId, goal: 'restore', targetKeys: [userKey] });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await vi.waitFor(() => expect(instance.lastFrame()).toContain('操作汇总'));
    const frame = instance.lastFrame() ?? '';
    expect(frame.split('\n').length).toBeLessThanOrEqual(rows);
    expect(frame.split('\n').every((line) => stringWidth(line) <= columns)).toBe(true);
    value.dispose();
  });
});
