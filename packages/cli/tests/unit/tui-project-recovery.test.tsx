import { cleanup, render } from 'ink-testing-library';
import stringWidth from 'string-width';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { TuiController, type TuiStatusLoadResult } from '../../src/tui/controller.js';
import type { ProjectStatusV1, ProjectRecoveryReceiptV1 } from '../../src/project/project-types.js';
import type { ProjectTuiTargetsPlan } from '../../src/tui/project-flow.js';

afterEach(cleanup);

function status(recovery: ProjectStatusV1): TuiStatusLoadResult {
  return {
    projectRoot: '/tmp/project', pluginSummaries: [],
    payload: {
      schemaVersion: 8,
      catalog: { primarySourceId: 'official', configDigest: 'config', compositeDigest: 'catalog', sources: [] },
      filters: { plugins: [], platform: 'both', cwd: '/tmp/project' },
      targets: [], errors: [], projectRecovery: recovery,
    },
  };
}

function recovery(agents: ProjectStatusV1['selection']['agents'] = []): ProjectStatusV1 {
  return {
    schemaVersion: 1, kind: 'aw-project-status', ok: true,
    intent: { state: 'valid', digest: 'sha256:project' },
    selection: { agents, origin: agents.length ? 'preference' : 'none', preferences: 'valid' },
    inventory: [
      { pluginId: 'team/alpha', source: 'team', sourceState: 'ready',
        blockers: agents.length ? [] : [{ code: 'localTargetsRequired', message: '选择本机 Agent' }],
        targetResults: agents.map((agent) => ({
          pluginId: 'team/alpha', agent,
          delivery: agent === 'cursor' ? { kind: 'agent-skills', provider: 'skills-cli' as const }
            : { kind: 'native', platform: 'codex' as const },
          execution: 'not-run' as const,
          observation: agent === 'cursor' ? 'missing' as const : 'verified' as const,
          content: agent === 'cursor' ? 'absent' as const : 'satisfied' as const,
          blockers: [], requiredBy: ['team/alpha'],
        })),
      },
      { pluginId: 'team/beta', source: 'team', sourceState: 'missing',
        blockers: [{ code: 'sourceMissing', message: '来源缺失' }], targetResults: [] },
    ],
    allSatisfied: null, errors: [],
  };
}

async function input(instance: ReturnType<typeof render>, value: string): Promise<void> {
  instance.stdin.write(value);
  await new Promise((resolve) => setTimeout(resolve, 25));
  if (value === '\u001b') await new Promise((resolve) => setTimeout(resolve, 80));
}

function frame(instance: ReturnType<typeof render>, size: { columns: number; rows: number }): string {
  const text = instance.lastFrame() ?? '';
  expect(text.split('\n').length).toBeLessThanOrEqual(size.rows);
  expect(text.split('\n').every((line) => stringWidth(line) <= size.columns)).toBe(true);
  return text;
}

describe('project recovery TUI', () => {
  it('reminds about mixed Agent states and reviews only the confirmed pair', async () => {
    const size = { columns: 80, rows: 24 };
    const projectRecovery = recovery(['codex', 'claude-code', 'cursor']);
    projectRecovery.inventory = [{ pluginId: 'team/alpha', source: 'team', sourceState: 'ready',
      blockers: [], targetResults: [
        { pluginId: 'team/alpha', agent: 'codex', delivery: { kind: 'native', platform: 'codex' },
          execution: 'not-run', observation: 'missing', content: 'absent',
          blockers: [], requiredBy: ['team/alpha'] },
        { pluginId: 'team/alpha', agent: 'cursor',
          delivery: { kind: 'agent-skills', provider: 'skills-cli', agentId: 'cursor' },
          execution: 'not-run', observation: 'unknown', content: 'conflict',
          blockers: [{ code: 'portableContentConflict', message: '内容冲突' }],
          requiredBy: ['team/alpha'] },
        { pluginId: 'team/alpha', agent: 'claude-code',
          delivery: { kind: 'native', platform: 'claude' }, execution: 'not-run',
          observation: 'unknown', content: 'unknown', blockers: [], requiredBy: ['team/alpha'] },
      ] }];
    const receipt: ProjectRecoveryReceiptV1 = {
      schemaVersion: 1, kind: 'aw-project-recovery', command: 'sync', ok: false,
      intent: { state: 'valid', roots: ['team/alpha'] }, requestedRoots: ['team/alpha'],
      selection: { agents: ['codex'], origin: 'explicit' }, blockers: [],
      targetResults: [], remainingTargets: [], recoveryActions: [],
      declarationChanged: false, preferencesChanged: false, outputsMayHaveChanged: false,
    };
    const prepareProjectTask = vi.fn().mockResolvedValue({ kind: 'recovery',
      plan: { receipt, changes: [], warnings: [] } });
    const executeProjectTask = vi.fn();
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status(projectRecovery)),
      captureEvidence: vi.fn(), executeIntent: vi.fn(), prepareProjectTask, executeProjectTask });
    await controller.load();
    const instance = render(<ConsoleAppV4 controller={controller} size={size}
      onClaimProjectIntentReminder={() => true} />);
    await vi.waitFor(() => expect(frame(instance, size)).toContain('1 个位置可同步'));
    expect(frame(instance, size)).toContain('1 个位置需要先处理');
    expect(frame(instance, size)).toContain('1 个位置未确认');
    await input(instance, '\u001b[B');
    expect(frame(instance, size)).toContain('› 查看并同步 1 个位置');
    await input(instance, '\r');
    expect(prepareProjectTask).toHaveBeenCalled();
    await vi.waitFor(() => expect(frame(instance, size)).toContain('项目恢复 Review'));
    expect(prepareProjectTask).toHaveBeenCalledWith({ kind: 'recovery', command: 'sync',
      selectors: ['team/alpha'], targets: ['codex'],
      exactTargets: [{ pluginId: 'team/alpha', agent: 'codex' }],
    }, expect.anything());
    expect(executeProjectTask).not.toHaveBeenCalled();
    await input(instance, '\u001b');
    controller.push({ name: 'issueList' });
    await input(instance, '');
    expect(frame(instance, size)).toContain('项目插件待处理');
    expect(frame(instance, size)).not.toContain('没有问题');
  });

  it('shows root blockers and target settings when no local Agent is selected', async () => {
    const size = { columns: 80, rows: 24 };
    const prepareProjectTask = vi.fn();
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status(recovery())),
      captureEvidence: vi.fn(), executeIntent: vi.fn(), prepareProjectTask });
    await controller.load();
    const instance = render(<ConsoleAppV4 controller={controller} size={size}
      onClaimProjectIntentReminder={() => true} />);
    await vi.waitFor(() => expect(frame(instance, size)).toContain('0 个位置可同步'));
    expect(controller.snapshot.projectIntentReminder?.blockedTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'team/alpha', reasonCodes: ['localTargetsRequired'] }),
    ]));
    await input(instance, '\u001b[B');
    await input(instance, '\r');
    expect(frame(instance, size)).toContain('设置本机 Agent');
    await input(instance, 't');
    expect(frame(instance, size)).toContain('选择本机 Agent');
    expect(prepareProjectTask).not.toHaveBeenCalled();
  });

  it('does not raise a reminder or project issue for fully satisfied roots', async () => {
    const size = { columns: 80, rows: 24 };
    const projectRecovery = recovery(['codex']);
    projectRecovery.inventory = projectRecovery.inventory!.slice(0, 1);
    const claim = vi.fn(() => true);
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status(projectRecovery)),
      captureEvidence: vi.fn(), executeIntent: vi.fn() });
    await controller.load();
    const instance = render(<ConsoleAppV4 controller={controller} size={size}
      onClaimProjectIntentReminder={claim} />);
    await input(instance, '');
    expect(controller.snapshot.projectIntentReminder).toBeUndefined();
    expect(claim).not.toHaveBeenCalled();
    controller.push({ name: 'issueList' });
    await input(instance, '');
    expect(frame(instance, size)).toContain('当前没有需要处理的问题');
  });

  it.each(['unsupported-version', 'invalid'] as const)(
    'shows %s project declarations as diagnostics without executable pairs', async (state) => {
      const size = { columns: 80, rows: 24 };
      const projectRecovery = recovery(['codex']);
      projectRecovery.intent.state = state;
      projectRecovery.inventory = null;
      projectRecovery.errors = [{ code: 'pluginIntentStateInvalid', message: '声明无效' }];
      const prepareProjectTask = vi.fn();
      const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status(projectRecovery)),
        captureEvidence: vi.fn(), executeIntent: vi.fn(), prepareProjectTask });
      await controller.load();
      const instance = render(<ConsoleAppV4 controller={controller} size={size}
        onClaimProjectIntentReminder={() => true} />);
      await vi.waitFor(() => expect(frame(instance, size)).toContain('0 个位置可同步'));
      expect(controller.snapshot.projectIntentReminder?.actionableTargets).toEqual([]);
      expect(frame(instance, size)).toContain('pluginIntentStateInvalid');
      await input(instance, '\u001b');
      controller.push({ name: 'issueList' });
      await input(instance, '');
      expect(frame(instance, size)).toContain('项目插件待处理');
      expect(frame(instance, size)).not.toContain('没有问题');
      expect(prepareProjectTask).not.toHaveBeenCalled();
    },
  );

  it('keeps a mixed task intact and requires a fresh Review for the other scope', async () => {
    const loaded = status(recovery(['codex']));
    loaded.pluginSummaries = [{ pluginId: 'team/gamma', pluginName: 'gamma', displayName: 'Gamma',
      description: '项目插件', version: '1.0.0',
      supportedTargets: { codex: ['user'], claude: ['project'] }, configFieldCount: 0 }];
    const receipt: ProjectRecoveryReceiptV1 = {
      schemaVersion: 1, kind: 'aw-project-recovery', command: 'sync', ok: true,
      intent: { state: 'valid', roots: ['team/gamma'] }, requestedRoots: ['team/gamma'],
      selection: { agents: ['claude-code'], origin: 'explicit' }, blockers: [],
      targetResults: [{ pluginId: 'team/gamma', agent: 'claude-code',
        delivery: { kind: 'native', platform: 'claude' }, execution: 'applied',
        observation: 'verified', blockers: [], requiredBy: ['team/gamma'] }],
      remainingTargets: [], recoveryActions: [], declarationChanged: false,
      preferencesChanged: false, outputsMayHaveChanged: true,
    };
    const prepareProjectTask = vi.fn().mockResolvedValue({ kind: 'recovery', plan: {
      receipt, changes: ['恢复 Claude Code 项目位置'], warnings: [],
    } });
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence: vi.fn().mockRejectedValue(new Error('userReviewUnavailable')),
      executeIntent: vi.fn(), prepareProjectTask,
      executeProjectTask: vi.fn().mockResolvedValue({ kind: 'recovery', receipt }) });
    const user = { pluginId: 'team/gamma', platform: 'codex' as const, scope: 'user' as const };
    const project = { pluginId: 'team/gamma', platform: 'claude' as const, scope: 'project' as const };
    await controller.load();
    vi.spyOn(controller, 'listPluginWriteTaskCandidates').mockReturnValue([
      { target: user, displayName: 'Gamma', sourceId: 'team', eligible: true,
        recommendedMethod: 'sync', issueIds: [] },
      { target: project, displayName: 'Gamma', sourceId: 'team', eligible: true,
        recommendedMethod: 'sync', issueIds: [] },
    ]);
    const startReviewPreparation = vi.spyOn(controller, 'startReviewPreparation');
    controller.push({ name: 'pluginWriteTask', pluginId: 'team/gamma', goal: 'restore',
      targetKeys: ['team/gamma\0codex\0user', 'team/gamma\0claude\0project'] });
    const size = { columns: 80, rows: 24 };
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await input(instance, '');
    expect(frame(instance, size)).toContain('先处理所有项目 1 个位置');
    expect(frame(instance, size)).toContain('先处理当前项目 1 个位置');
    await input(instance, '\u001b[B');
    await input(instance, '\r');
    expect(prepareProjectTask).toHaveBeenCalledWith({ kind: 'recovery', command: 'sync',
      selectors: ['team/gamma'], targets: ['claude-code'],
      exactTargets: [{ pluginId: 'team/gamma', agent: 'claude-code' }],
    }, expect.anything());
    expect(frame(instance, size)).toContain('完整任务请求：2 个位置');
    expect(frame(instance, size)).toContain('其余范围未处理');
    await input(instance, '\r');
    expect(frame(instance, size)).toContain('另一范围仍需独立 Review');
    await input(instance, '\u001b[B');
    await input(instance, '\r');
    expect(startReviewPreparation).toHaveBeenCalledWith({ kind: 'pluginWriteTask',
      goal: 'restore', targets: [user], executionPolicy: 'all',
    }, expect.anything());
  });

  it('routes a first project install through the shared recovery Review', async () => {
    const loaded = status(recovery(['codex']));
    delete loaded.payload.projectRecovery;
    loaded.projectIntent = { state: 'absent' };
    loaded.pluginSummaries = [{ pluginId: 'team/gamma', pluginName: 'gamma', displayName: 'Gamma',
      description: '项目插件', version: '1.0.0', supportedTargets: { codex: ['project'], claude: [] },
      configFieldCount: 0 }];
    const receipt: ProjectRecoveryReceiptV1 = {
      schemaVersion: 1, kind: 'aw-project-recovery', command: 'install', ok: false,
      intent: { state: 'absent', roots: [] },
      requestedRoots: ['team/gamma'], selection: { agents: ['codex'], origin: 'explicit' },
      blockers: [], targetResults: [{ pluginId: 'team/gamma', agent: 'codex',
        delivery: { kind: 'native', platform: 'codex' }, execution: 'not-run',
        observation: 'missing', blockers: [], requiredBy: ['team/gamma'] }],
      remainingTargets: [], recoveryActions: [], declarationChanged: false,
      preferencesChanged: false, outputsMayHaveChanged: false,
    };
    const prepareProjectTask = vi.fn().mockResolvedValue({ kind: 'recovery',
      plan: { receipt, changes: ['新增项目需求 team/gamma'], warnings: [] } });
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(loaded),
      captureEvidence: vi.fn(), executeIntent: vi.fn(), prepareProjectTask,
      executeProjectTask: vi.fn() });
    await controller.load();
    controller.beginInstallFlow('team/gamma', 'project');
    controller.setInstallPlatforms(['codex']);
    controller.push({ name: 'installPlacement', pluginId: 'team/gamma' });
    const instance = render(<ConsoleAppV4 controller={controller} size={{ columns: 80, rows: 24 }} />);
    await input(instance, '');
    expect(frame(instance, { columns: 80, rows: 24 })).toContain('当前项目');
    await input(instance, '\r');
    expect(prepareProjectTask).toHaveBeenCalledWith({ kind: 'recovery',
      command: 'install', selectors: ['team/gamma'], targets: ['codex'],
      exactTargets: [{ pluginId: 'team/gamma', agent: 'codex' }],
    }, expect.anything());
    expect(frame(instance, { columns: 80, rows: 24 })).toContain('新增项目需求 team/gamma');
  });

  it.each([{ columns: 80, rows: 24 }, { columns: 60, rows: 18 }])(
    'shows all roots without local targets and opens the Agent preference editor at $columns x $rows', async (size) => {
      const loadStatus = vi.fn().mockResolvedValue(status(recovery()));
      const controller = new TuiController({ loadStatus, captureEvidence: vi.fn(), executeIntent: vi.fn() });
      await controller.load(); controller.push({ name: 'projectStatus' });
      const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
      await input(instance, '');
      let seen = frame(instance, size);
      for (let index = 0; index < 12; index += 1) {
        await input(instance, '\u001b[B');
        seen += frame(instance, size);
      }
      expect(seen).toContain('team/alpha');
      expect(seen).toContain('team/beta');
      expect(seen).toContain('本机 Agent：未选择');
      await input(instance, 't');
      expect(frame(instance, size)).toContain('选择本机 Agent');
      expect(loadStatus).toHaveBeenCalledTimes(1);
    },
  );

  it('shows the selected Agents with distinct Native and Portable delivery states', async () => {
    const size = { columns: 80, rows: 24 };
    const projectRecovery = recovery(['codex', 'cursor']);
    projectRecovery.inventory = projectRecovery.inventory!.slice(0, 1);
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(
      status(projectRecovery)), captureEvidence: vi.fn(), executeIntent: vi.fn() });
    await controller.load(); controller.push({ name: 'projectStatus' });
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await input(instance, '');
    let seen = frame(instance, size);
    for (let index = 0; index < 8; index += 1) {
      await input(instance, '\u001b[6~');
      seen += frame(instance, size);
    }
    expect(seen).toContain('codex');
    expect(seen).toContain('Native Codex');
    expect(seen).toContain('cursor');
    expect(seen).toContain('通用 Skills');
  });

  it('reviews a preference-only change and prevents duplicate Enter from starting another write', async () => {
    const size = { columns: 80, rows: 24 };
    const plan: ProjectTuiTargetsPlan = {
      kind: 'targets', action: 'set', agents: ['codex'], previousAgents: [], overrideCount: 1,
      expected: { state: 'valid', value: { schemaVersion: 1, kind: 'aw-project-preferences',
        agents: [], dependencyScopeOverrides: [] }, digest: 'old', rawDigest: 'old' },
      changes: ['本机 Agent：未选择 → codex', '保留已有本机依赖范围覆盖'], warnings: [],
    };
    let resolveWrite!: (value: { kind: 'targets'; changed: boolean; agents: ['codex'] }) => void;
    const executeProjectTask = vi.fn().mockImplementation(() => new Promise((resolve) => { resolveWrite = resolve; }));
    const prepareProjectTask = vi.fn().mockResolvedValue(plan);
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status(recovery())),
      captureEvidence: vi.fn(), executeIntent: vi.fn(), prepareProjectTask, executeProjectTask });
    await controller.load(); controller.push({ name: 'projectStatus' });
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await input(instance, 't');
    await input(instance, '\r');
    for (let index = 0; index < 3; index += 1) await input(instance, '\u001b[B');
    await input(instance, '\r');
    expect(frame(instance, size)).toContain('本次只保存本机偏好');
    expect(executeProjectTask).not.toHaveBeenCalled();
    await input(instance, '\r');
    await input(instance, '\r');
    expect(executeProjectTask).toHaveBeenCalledTimes(1);
    expect(frame(instance, size)).toContain('正在恢复项目插件');
    resolveWrite({ kind: 'targets', changed: true, agents: ['codex'] });
    await input(instance, '');
    expect(frame(instance, size)).toContain('本机偏好已保存');
  });

  it('keeps the full requested roots and blocked pair in Review, then cancels without execution', async () => {
    const size = { columns: 80, rows: 24 };
    const receipt: ProjectRecoveryReceiptV1 = {
      schemaVersion: 1, kind: 'aw-project-recovery', command: 'sync', ok: false,
      intent: { state: 'valid', roots: ['team/alpha', 'team/beta'] },
      requestedRoots: ['team/alpha', 'team/beta'],
      selection: { agents: ['codex'], origin: 'preference' },
      blockers: [{ code: 'sourceMissing', message: '来源缺失' }],
      targetResults: [
        { pluginId: 'team/alpha', agent: 'codex', delivery: { kind: 'native', platform: 'codex' },
          execution: 'not-run', observation: 'missing', blockers: [], requiredBy: ['team/alpha'] },
        { pluginId: 'team/beta', agent: 'codex', delivery: null,
          execution: 'not-run', observation: 'unknown',
          blockers: [{ code: 'sourceMissing', message: '来源缺失' }], requiredBy: ['team/beta'] },
      ],
      remainingTargets: [{ pluginId: 'team/beta', agent: 'codex' }], recoveryActions: [],
      declarationChanged: false, preferencesChanged: false, outputsMayHaveChanged: false,
    };
    const executeProjectTask = vi.fn();
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status(recovery(['codex']))),
      captureEvidence: vi.fn(), executeIntent: vi.fn(),
      prepareProjectTask: vi.fn().mockResolvedValue({ kind: 'recovery', plan: {
        receipt, changes: ['共用原生包会影响其他项目'], warnings: [],
      } }), executeProjectTask });
    await controller.load(); controller.push({ name: 'projectStatus' });
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await input(instance, 'c');
    let seen = frame(instance, size);
    for (let index = 0; index < 12; index += 1) {
      await input(instance, '\u001b[C');
      seen += frame(instance, size);
    }
    expect(seen).toContain('team/alpha');
    expect(seen).toContain('team/beta');
    expect(seen).toContain('sourceMissing');
    expect(seen).toContain('共用原生包会影响其他项目');
    await input(instance, '\u001b');
    expect(frame(instance, size)).toContain('本机 Agent：codex');
    expect(executeProjectTask).not.toHaveBeenCalled();
  });

  it('shows a Portable conflict recovery action in Review and Result', async () => {
    const size = { columns: 80, rows: 24 };
    const actions = [
      'Codex 与 Cursor 共用此项目目录。',
      '人工备份并移开 ./.agents/skills/team-alpha。',
    ];
    const receipt: ProjectRecoveryReceiptV1 = {
      schemaVersion: 1, kind: 'aw-project-recovery', command: 'sync', ok: false,
      intent: { state: 'valid', roots: ['team/alpha'] }, requestedRoots: ['team/alpha'],
      selection: { agents: ['cursor'], origin: 'preference' }, blockers: [],
      targetResults: [{ pluginId: 'team/alpha', agent: 'cursor',
        delivery: { kind: 'agent-skills', provider: 'skills-cli', agentId: 'cursor' },
        execution: 'not-run', observation: 'unknown', content: 'conflict',
        blockers: [{ code: 'portableContentConflict', message: '现有内容冲突' }],
        requiredBy: ['team/alpha'], recoveryActions: actions }],
      remainingTargets: [{ pluginId: 'team/alpha', agent: 'cursor' }],
      recoveryActions: ['同步来源后重试', ...actions], declarationChanged: false,
      preferencesChanged: false, outputsMayHaveChanged: false,
    };
    const executeProjectTask = vi.fn().mockResolvedValue({ kind: 'recovery', receipt });
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status(recovery(['cursor']))),
      captureEvidence: vi.fn(), executeIntent: vi.fn(),
      prepareProjectTask: vi.fn().mockResolvedValue({ kind: 'recovery',
        plan: { receipt, changes: [], warnings: [] } }), executeProjectTask });
    await controller.load(); controller.push({ name: 'projectStatus' });
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await input(instance, 'c');
    let review = frame(instance, size);
    for (let index = 0; index < 12; index += 1) {
      await input(instance, '\u001b[C');
      review += frame(instance, size);
    }
    expect(review).toContain('./.agents/skills/team-alpha');
    expect(review).toContain('Codex 与 Cursor 共用此项目目录');
    expect(review).toContain('人工备份并移开');
    expect(review).not.toContain('同步来源后重试');
    await input(instance, '\r');
    let result = frame(instance, size);
    for (let index = 0; index < 12; index += 1) {
      await input(instance, '\u001b[C');
      result += frame(instance, size);
    }
    expect(result).toContain('人工备份并移开');
    expect(result).toContain('./.agents/skills/team-alpha');
    expect(result).toContain('Codex 与 Cursor 共用此项目目录');
    expect(executeProjectTask).toHaveBeenCalledTimes(1);
  });

  it('shows widened removed-plugin cleanup and retries only the remaining Agent pair', async () => {
    const size = { columns: 80, rows: 24 };
    const projectRecovery = recovery(['codex', 'cursor']);
    projectRecovery.inventory = [{ pluginId: 'team/removed', source: 'team', sourceState: 'ready',
      blockers: [{ code: 'pluginUnavailable', message: '插件已从健康来源删除' }], targetResults: [] }];
    const receipt: ProjectRecoveryReceiptV1 = {
      schemaVersion: 1, kind: 'aw-project-recovery', command: 'cleanup', ok: false,
      intent: { state: 'valid', roots: ['team/removed'] }, requestedRoots: ['team/removed'],
      selection: { agents: ['codex', 'cursor'], origin: 'preference' }, blockers: [],
      targetResults: [
        { pluginId: 'team/removed', agent: 'codex', delivery: { kind: 'native', platform: 'codex' },
          execution: 'applied', observation: 'verified', blockers: [], requiredBy: ['team/removed'] },
        { pluginId: 'team/removed', agent: 'cursor', delivery: { kind: 'agent-skills', provider: 'skills-cli' },
          execution: 'partial', observation: 'unknown',
          blockers: [{ code: 'backend-action-unsupported', message: '无法安全删除' }], requiredBy: ['team/removed'] },
      ],
      remainingTargets: [{ pluginId: 'team/removed', agent: 'cursor' }],
      recoveryActions: ['检查 Cursor 中的剩余 Skill'],
      declarationChanged: true, preferencesChanged: true, outputsMayHaveChanged: true,
    };
    const prepareProjectTask = vi.fn().mockResolvedValue({ kind: 'recovery', plan: {
      receipt, changes: ['删除个人与当前项目的需求和设置', '移除共用原生安装'], warnings: [],
      removedPluginIds: ['team/removed'],
    } });
    const controller = new TuiController({ loadStatus: vi.fn().mockResolvedValue(status(projectRecovery)),
      captureEvidence: vi.fn(), executeIntent: vi.fn(), prepareProjectTask,
      executeProjectTask: vi.fn().mockResolvedValue({ kind: 'recovery', receipt }) });
    await controller.load(); controller.push({ name: 'projectStatus' });
    const instance = render(<ConsoleAppV4 controller={controller} size={size} />);
    await input(instance, 'x');
    expect(prepareProjectTask).toHaveBeenCalledWith({
      kind: 'recovery', command: 'cleanup', selectors: ['team/removed'],
    }, expect.anything());
    let seen = frame(instance, size);
    for (let index = 0; index < 12; index += 1) {
      await input(instance, '\u001b[C');
      seen += frame(instance, size);
    }
    expect(seen).toContain('个人及当前项目');
    expect(seen).toContain('共用原生安装');
    await input(instance, '\r');
    expect(frame(instance, size)).toContain('未完成');
    await input(instance, '\u001b[B');
    await input(instance, '\u001b[B');
    await input(instance, '\r');
    expect(prepareProjectTask).toHaveBeenCalledWith({
      kind: 'recovery', command: 'cleanup', selectors: ['team/removed'],
      exactTargets: [{ pluginId: 'team/removed', agent: 'cursor' }],
    }, expect.anything());
  });
});
