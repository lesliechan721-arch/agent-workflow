import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PortableReview, PortableInstallReceipt } from '../../src/portable/commands.js';
import { SKILLS_CLI_SUPPORTED_VERSION_LABEL } from '../../src/portable/skills-cli.js';
import type { StatusV8Payload, StatusV8PluginSummary } from '../../src/commands/status-v6.js';
import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
import { SessionConsoleApp } from '../../src/tui/session-console-app.js';
import { SessionHost } from '../../src/tui/session-host.js';
import { attachSafeOperationError } from '../../src/utils/safe-operation-diagnostic.js';
import {
  extractPortableError,
  TuiController,
  TuiOperationBlockedError,
  type OperationEvidence,
  type OperationIntent,
  type TuiControllerDependencies,
  type TuiStatusLoadResult,
} from '../../src/tui/controller.js';

afterEach(() => cleanup());

const candidates: PortableReview['selected'] = [
  { name: 'author-skill', description: '创建 Skill', providerPluginId: 'official/toolkit', providerDisplayName: 'Toolkit', relation: 'requested', dynamic: false, filesDigest: 'sha256:a' },
  { name: 'review-skill', description: '评审 Skill', providerPluginId: 'official/toolkit', providerDisplayName: 'Toolkit', relation: 'requested', dynamic: true, filesDigest: 'sha256:b' },
  { name: 'content-skill', description: '评审内容', providerPluginId: 'official/content', providerDisplayName: 'Content', relation: 'direct', dynamic: false, filesDigest: 'sha256:c' },
];

function status(): TuiStatusLoadResult {
  const summaries: StatusV8PluginSummary[] = [{
    pluginName: 'toolkit', pluginId: 'official/toolkit', displayName: 'Toolkit', description: '工具集',
    version: '1.0.0', supportedTargets: { codex: ['project'], claude: ['project'] }, configFieldCount: 0,
    dependencyDirectCount: 1, dependencyTotalCount: 1, dependencyIssueCount: 0,
  }, {
    pluginName: 'content', pluginId: 'official/content', displayName: 'Content', description: '内容工具',
    version: '1.0.0', supportedTargets: { codex: ['project'], claude: ['project'] }, configFieldCount: 0,
  }];
  const payload: StatusV8Payload = {
    schemaVersion: 8,
    catalog: { primarySourceId: 'official', configDigest: 'sha256:config', compositeDigest: 'sha256:catalog', sources: [{ id: 'official', identity: 'identity:official', type: 'path', primary: true, requestedRef: 'path', freshness: 'active' }] },
    filters: { plugins: [], platform: 'both', cwd: '/workspace' },
    targets: summaries.flatMap((summary) => (['codex', 'claude'] as const).map((platform) => {
      const identity = {
        pluginName: summary.pluginName, pluginId: summary.pluginId, sourceId: 'official',
        sourceIdentity: 'identity:official', version: '1.0.0', platform, cwd: '/workspace',
      };
      const placement = {
        scope: 'project' as const, state: 'absent' as const,
        components: [], reasons: [], recoveryActions: [],
      };
      return platform === 'codex'
        ? { ...identity, state: 'absent' as const, components: [], reasons: [], recoveryActions: [], placements: [placement] }
        : { ...identity, ...placement };
    })),
    errors: [],
  };
  return {
    payload,
    pluginSummaries: summaries,
    portablePluginIds: ['official/toolkit'],
    dependencyOverviews: [{
      pluginId: 'official/toolkit',
      summary: { directCount: 1, transitiveCount: 0, totalCount: 1, readyCount: 0, missingCount: 1, issueCount: 0 },
      dependencies: [{ pluginId: 'official/content', displayName: 'Content', relation: 'direct', depth: 1, requiredBy: [{ pluginId: 'official/toolkit', displayName: 'Toolkit' }], placements: [], aggregateStatus: 'notInstalled' }],
      dependents: [], blockers: [],
    }],
  };
}

function review(intent: Extract<OperationIntent, { kind: 'portableInstall' }>): PortableReview {
  const selected = intent.selectedSkills.length === 0
    ? candidates
    : candidates.filter((candidate) => intent.selectedSkills.includes(candidate.name));
  return {
    pluginId: intent.pluginId, sourceId: 'official', sourceIdentity: 'identity:official', pluginVersion: '1.0.0',
    scope: intent.scope, selected, requestedSkills: intent.selectedSkills,
    agentMode: intent.requestedAgents ? 'explicit' : 'automatic', requestedAgents: intent.requestedAgents ?? [],
    skillsCliVersion: '1.5.23', collisions: selected[0]?.name === 'author-skill' ? [{ name: 'author-skill', requestedName: 'author-skill', agents: ['codex'] }] : [],
    dependencies: ['official/content'], materializationDigest: 'sha256:materialized', configDigest: 'sha256:config',
    evidenceDigest: JSON.stringify({ scope: intent.scope, selected: selected.map((item) => item.name), agents: intent.requestedAgents ?? [] }),
  };
}

function portableController(overrides: Partial<TuiControllerDependencies> = {}): {
  value: TuiController;
  capture: ReturnType<typeof vi.fn>;
  progress: ReturnType<typeof createRebuildProgressFeed>;
} {
  const capture = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
    if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
    const portable = review(intent);
    return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
  });
  const execute = vi.fn(async (intent: OperationIntent): Promise<PortableInstallReceipt> => {
    if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
    const portable = review(intent);
    return {
      receiptSchemaVersion: 5, command: 'skill:install', ok: true, status: 'succeeded',
      plugin: { id: intent.pluginId }, scope: intent.scope, selectedSkills: portable.selected,
      requestedSkills: intent.selectedSkills, agentMode: portable.agentMode, requestedAgents: portable.requestedAgents,
      skillsCliVersion: portable.skillsCliVersion, collisions: portable.collisions, dependencies: portable.dependencies,
      materializationDigest: portable.materializationDigest,
      verification: {
        records: portable.selected.map((skill) => ({
          name: skill.name, scope: intent.scope, agents: portable.requestedAgents.length > 0
            ? portable.requestedAgents : ['codex'],
        })),
        missing: [],
      },
      warnings: [], failures: [],
    };
  });
  const progress = createRebuildProgressFeed();
  return { value: new TuiController({
    loadStatus: vi.fn().mockResolvedValue(status()), checkSource: vi.fn(), captureEvidence: capture,
    executeIntent: execute, now: () => 1_000, reviewTtlMs: 10_000, ...overrides,
  }, progress), capture, progress };
}

async function tick(count = 2): Promise<void> {
  for (let index = 0; index < count; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function send(instance: ReturnType<typeof render>, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    instance.stdin.write(key);
    await tick();
  }
}

async function openPortableFromInstall(instance: ReturnType<typeof render>): Promise<void> {
  for (let index = 0; index < 8 && !instance.lastFrame()?.includes('› 安装'); index += 1) {
    await send(instance, '\u001B[B');
  }
  expect(instance.lastFrame()).toContain('› 安装');
  await send(instance, '\r');
  for (let index = 0; index < 8 && !instance.lastFrame()?.includes('› 通用 Agent Skills →'); index += 1) {
    await send(instance, '\u001B[B');
  }
  expect(instance.lastFrame()).toContain('› 通用 Agent Skills →');
  await send(instance, '\r');
}

async function focusPortableAction(
  instance: ReturnType<typeof render>,
  label: string,
): Promise<void> {
  for (let index = 0; index < 16 && !instance.lastFrame()?.includes(`› ${label}`); index += 1) {
    await send(instance, '\u001B[B');
  }
  expect(instance.lastFrame()).toContain(`› ${label}`);
}

async function openPortableTools(instance: ReturnType<typeof render>): Promise<void> {
  await send(instance, 'a');
  if (!instance.lastFrame()?.includes('› 选择工具')) await send(instance, '\u001B[B');
  expect(instance.lastFrame()).toContain('› 选择工具');
  await send(instance, '\r');
  expect(instance.lastFrame()).toContain('全选当前结果');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((settle) => { resolve = settle; }), resolve };
}

describe('Portable Skills TUI V1', () => {
  it('uses h in place and H to remount a fresh controller session', async () => {
    const first = portableController();
    const second = portableController();
    const sessions = [first, second];
    const host = new SessionHost({
      createSession: () => {
        const next = sessions.shift();
        if (!next) throw new Error('unexpected session');
        return { controller: next.value, progressFeed: next.progress };
      },
    });
    const instance = render(<SessionConsoleApp host={host} />);
    await tick(4);
    expect(instance.lastFrame()).toContain('插件');
    expect(instance.lastFrame()).toContain('插件来源');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    first.value.push({ name: 'pluginList', mode: 'browse' });

    await send(instance, 'h');
    expect(host.snapshot.epoch).toBe(1);
    expect(first.value.snapshot.router.current.route).toEqual({ name: 'home' });

    first.value.push({ name: 'pluginList', mode: 'browse' });
    await send(instance, 'H');
    expect(host.snapshot.epoch).toBe(2);
    expect(host.snapshot.controller).toBe(second.value);
    expect(first.value.snapshot.phase).toBe('disposed');
    await tick(4);
    expect(second.value.snapshot.phase).toBe('ready');
    host.dispose();
  });

  it('unmounts the old interactive UI while H drains a read', async () => {
    const pending = deferred<TuiStatusLoadResult>();
    const first = portableController({ loadStatus: vi.fn(() => pending.promise) });
    const second = portableController();
    const sessions = [first, second];
    const host = new SessionHost({
      createSession: () => {
        const next = sessions.shift();
        if (!next) throw new Error('unexpected session');
        return { controller: next.value, progressFeed: next.progress };
      },
    });
    const instance = render(<SessionConsoleApp host={host} />);
    await tick(2);

    await send(instance, 'H', '\r');
    expect(instance.lastFrame()).toContain('正在安全结束当前会话');
    expect(host.snapshot.epoch).toBe(1);

    pending.resolve(status());
    await tick(4);
    expect(host.snapshot.epoch).toBe(2);
    expect(host.snapshot.controller).toBe(second.value);
    host.dispose();
  });

  it('offers the same home and reload actions from the help menu', async () => {
    const first = portableController({ now: () => 1_000 });
    const second = portableController({ now: () => 2_000 });
    const sessions = [first, second];
    const host = new SessionHost({
      createSession: () => {
        const next = sessions.shift();
        if (!next) throw new Error('unexpected session');
        return { controller: next.value, progressFeed: next.progress };
      },
    });
    const instance = render(<SessionConsoleApp host={host} />);
    await tick(4);
    first.value.push({ name: 'pluginList', mode: 'browse' });

    await send(instance, '?');
    expect(instance.lastFrame()).toContain('返回首页并重新加载');
    await send(instance, '\u001B[B', '\r');
    expect(first.value.snapshot.router.current.route).toEqual({ name: 'home' });
    expect(first.value.snapshot.statusReadAtMs).toBe(1_000);

    first.value.push({ name: 'pluginList', mode: 'browse' });
    await send(instance, '?', '\u001B[B', '\u001B[B', '\r');
    await tick(4);
    expect(host.snapshot.epoch).toBe(2);
    expect(second.value.snapshot.statusReadAtMs).toBe(2_000);
    host.dispose();
  });

  it('keeps initial and H-reload failure diagnostics reachable through the real SessionHost', async () => {
    const failedSession = (code: string, safeMessage: string) => portableController({
      loadStatus: vi.fn().mockRejectedValue(attachSafeOperationError(
        new Error('Authorization=private-token /Users/private/status.json'),
        { code, stage: 'status.load', safeMessage },
      )),
    });
    const first = failedSession('initialStatusFailed', 'The initial status could not be read.');
    const second = failedSession('reloadStatusFailed', 'The reloaded status could not be read.');
    const sessions = [first, second];
    const host = new SessionHost({
      createSession: () => {
        const next = sessions.shift();
        if (!next) throw new Error('unexpected session');
        return { controller: next.value, progressFeed: next.progress };
      },
    });
    const save = vi.spyOn(second.value, 'saveOperationReport').mockResolvedValue({ path: '/private/report.md' });
    const instance = render(<SessionConsoleApp host={host} />);
    await tick(4);

    expect(first.value.snapshot.phase).toBe('error');
    expect(instance.lastFrame()).toContain('无法读取插件状态');
    expect(instance.lastFrame()).not.toContain('添加插件');
    await send(instance, 'H');
    await tick(4);
    expect(host.snapshot).toMatchObject({ epoch: 2, controller: second.value });
    expect(second.value.snapshot.phase).toBe('error');

    await send(instance, '?', 'o');
    expect(second.value.snapshot.router.current.route).toEqual({ name: 'operationHistory' });
    expect(instance.lastFrame()).toContain('最近操作');
    await send(instance, '\r');
    expect(second.value.snapshot.router.current.route.name).toBe('operationDiagnostic');
    expect(instance.lastFrame()).toContain('reloadStatusFailed');
    await send(instance, '\r', '\u001B[B', '\r');
    await tick(2);
    expect(save).toHaveBeenCalledOnce();
    expect(instance.lastFrame()).toContain('报告已保存到临时目录');

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await tick(2);
    expect(second.value.snapshot.router.current.route.name).toBe('operationDiagnostic');
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 100));
    await tick(2);
    expect(second.value.snapshot.router.current.route).toEqual({ name: 'operationHistory' });
    expect(second.value.snapshot.phase).toBe('error');
    expect(second.value.snapshot.loadError?.code).toBe('reloadStatusFailed');
    expect(JSON.stringify({ snapshot: second.value.snapshot, history: host.history.list() }))
      .not.toContain('private-token');
    host.dispose();
  });

  it('records a safe report-linked diagnostic when Portable preparation fails', async () => {
    const captureEvidence = vi.fn().mockRejectedValue(attachSafeOperationError(
      new Error('Authorization=private-token /Users/private/portable.json'),
      { code: 'portablePrepareFailed', stage: 'prepare-portable', safeMessage: 'Portable preparation failed safely.' },
    ));
    const { value } = portableController({ captureEvidence });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/toolkit' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    await openPortableFromInstall(instance);
    await tick(2);
    const route = value.snapshot.router.current.route;
    expect(route).toMatchObject({ name: 'portableBlocker', operationRecordId: expect.any(String) });
    expect(instance.lastFrame()).toContain('查看诊断与报告');
    expect(JSON.stringify({ route, history: value.listOperationHistory() })).not.toContain('private-token');
  });

  it('keeps h, H, q, and b as characters in Portable agent input', async () => {
    const { value } = portableController();
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.push({ name: 'portableAgentInput', pluginId: 'official/toolkit' });
    const onSessionNavigation = vi.fn().mockResolvedValue('completed');
    const instance = render(<ConsoleAppV4
      controller={value}
      size={{ columns: 80, rows: 24 }}
      onSessionNavigation={onSessionNavigation}
    />);
    await tick();

    await send(instance, 'h', 'H', 'q', 'b');

    expect(instance.lastFrame()).toContain('hHqb');
    expect(onSessionNavigation).not.toHaveBeenCalled();
  });

  it('clears Portable agent input with Ctrl-U without leaving the draft', async () => {
    const { value } = portableController();
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.push({ name: 'portableAgentInput', pluginId: 'official/toolkit' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    await send(instance, 'temporary-agent');
    expect(instance.lastFrame()).toContain('temporary-agent');
    expect(instance.lastFrame()).toContain('Ctrl-U 清空输入');
    await send(instance, '\u0015');

    expect(instance.lastFrame()).not.toContain('temporary-agent');
    expect(value.snapshot.router.current.route.name).toBe('portableAgentInput');
    expect(value.snapshot.portableDraft).toBeDefined();
  });

  it('keeps the Portable draft under read-only operation history routes', async () => {
    const { value } = portableController();
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.push({ name: 'portableAgentMode', pluginId: 'official/toolkit' });
    const selectedCount = value.snapshot.portableDraft?.selectedCount;
    const recordId = value.recordUiFailure(undefined, { code: 'testFailure', stage: 'test' });

    value.push({ name: 'operationHistory' });
    value.push({ name: 'operationDiagnostic', recordId });
    expect(value.snapshot.portableDraft?.selectedCount).toBe(selectedCount);
    value.back();
    value.push({ name: 'operationReportPreview', recordId });
    expect(value.snapshot.portableDraft?.selectedCount).toBe(selectedCount);
    value.back();
    value.back();

    expect(value.snapshot.router.current.route).toEqual({
      name: 'portableAgentMode', pluginId: 'official/toolkit',
    });
    expect(value.snapshot.portableDraft?.selectedCount).toBe(selectedCount);

    value.push({ name: 'home' });
    expect(value.snapshot.portableDraft).toBeUndefined();
  });

  it('returns from help history to the same Portable selection without losing the draft', async () => {
    const { value } = portableController();
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.togglePortableSkill('review-skill');
    value.push({ name: 'portableAgentMode', pluginId: 'official/toolkit' });
    value.recordUiFailure(undefined, { code: 'testFailure', stage: 'test' });
    const selected = value.snapshot.portableDraft?.candidates
      .filter((candidate) => candidate.selected).map((candidate) => candidate.name);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await tick(2);

    await send(instance, '?', 'o');
    expect(value.snapshot.router.current.route).toEqual({ name: 'operationHistory' });
    await send(instance, '\u001B');
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(value.snapshot.router.current.route).toEqual({
      name: 'portableAgentMode', pluginId: 'official/toolkit',
    });
    expect(value.snapshot.portableDraft?.candidates
      .filter((candidate) => candidate.selected).map((candidate) => candidate.name)).toEqual(selected);
    expect(instance.lastFrame()).toContain('安装到哪些 Agent？');
  });

  it.each(['portable', 'dependency'] as const)(
    'keeps the %s draft when h opens the default continue-editing guard',
    async (owner) => {
      const { value } = portableController();
      await value.load();
      if (owner === 'portable') await value.preparePortableInstall('official/toolkit');
      else value.beginInstallFlow('official/toolkit', 'project');
      const onSessionNavigation = vi.fn(async (
        _navigation: 'home' | 'reload',
        options?: { discardDrafts?: boolean },
      ) => value.hasSessionDraft && !options?.discardDrafts ? 'draftBlocked' as const : 'completed' as const);
      const instance = render(<ConsoleAppV4
        controller={value}
        size={{ columns: 80, rows: 24 }}
        onSessionNavigation={onSessionNavigation}
      />);
      await tick();

      await send(instance, 'h');
      expect(instance.lastFrame()).toContain('放弃未保存修改？');
      expect(instance.lastFrame()).toContain('继续编辑');
      await send(instance, '\r');

      expect(value.hasSessionDraft).toBe(true);
      expect(onSessionNavigation).toHaveBeenCalledTimes(1);
    },
  );
  it('returns a completed detail-origin flow to detail without exposing old Portable pages', async () => {
    const { value } = portableController();
    await value.load();
    value.push({ name: 'pluginList', mode: 'installed' });
    value.push({ name: 'pluginDetail', pluginId: 'official/toolkit' });
    await value.preparePortableInstall('official/toolkit');
    const operation = await value.buildPortableInstallReview();
    await value.executeOperation(operation.reviewToken);
    value.leaveResult();
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/toolkit',
    });
    expect(value.snapshot.portableDraft).toBeUndefined();
    value.back();
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginList', mode: 'installed' });
  });

  it('captures the latest same-plugin origin after leaving an earlier Portable flow', async () => {
    const { value } = portableController();
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/toolkit' });
    await value.preparePortableInstall('official/toolkit');
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();
    await send(instance, 'b');
    value.push({ name: 'sourceList' });
    value.push({ name: 'pluginDetail', pluginId: 'official/toolkit' });

    await value.preparePortableInstall('official/toolkit');
    const operation = await value.buildPortableInstallReview();
    await value.executeOperation(operation.reviewToken);
    value.leaveResult();

    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/toolkit' });
    value.back();
    expect(value.snapshot.router.current.route).toEqual({ name: 'sourceList' });
  });

  it('clears a successful result before starting another Portable selection', async () => {
    const { value } = portableController();
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/toolkit' });
    await value.preparePortableInstall('official/toolkit');
    const operation = await value.buildPortableInstallReview();
    await value.executeOperation(operation.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    await focusPortableAction(instance, '再安装其他 Skills');
    await send(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'portableSkillSelect', pluginId: 'official/toolkit',
    });
    await send(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/toolkit' });
  });

  it.each(['blocked', 'partial'] as const)(
    'returns a %s result to modification without offering an inexact retry',
    async (firstState) => {
      let attempt = 0;
      const executeIntent = vi.fn(async (intent: OperationIntent): Promise<PortableInstallReceipt> => {
        if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
        attempt += 1;
        if (attempt === 1 && firstState === 'blocked') {
          throw Object.assign(new Error('安装证据已变化。'), { code: 'portableInstallBlocked' });
        }
        const portable = review(intent);
        return {
          receiptSchemaVersion: 5, command: 'skill:install', ok: attempt > 1,
          status: attempt > 1 ? 'succeeded' : 'failed', plugin: { id: intent.pluginId },
          scope: intent.scope, selectedSkills: portable.selected, requestedSkills: intent.selectedSkills,
          agentMode: portable.agentMode, requestedAgents: portable.requestedAgents,
          skillsCliVersion: portable.skillsCliVersion, collisions: [], dependencies: portable.dependencies,
          materializationDigest: portable.materializationDigest,
          verification: { records: [], missing: [] }, warnings: [],
          failures: attempt > 1 ? [] : [{
            code: 'portableSkillsCliInstallFailed', message: '安装失败。', recovery: '重试。',
          }],
        };
      });
      const { value } = portableController({ executeIntent });
      await value.load();
      value.push({ name: 'pluginDetail', pluginId: 'official/toolkit' });
      await value.preparePortableInstall('official/toolkit');
      const operation = await value.buildPortableInstallReview();
      await value.executeOperation(operation.reviewToken);
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
      await tick();

      expect(instance.lastFrame()).not.toMatch(/› 重试$/mu);
      await send(instance, '\r');
      expect(value.snapshot.router.current.route).toEqual({
        name: 'portableSkillSelect', pluginId: 'official/toolkit',
      });
      value.back();
      expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/toolkit' });
    },
  );

  it('keeps Portable entry available when native dependency installation is blocked', async () => {
    const loaded = status();
    loaded.dependencyOverviews![0]!.summary.issueCount = 1;
    loaded.dependencyOverviews![0]!.blockers = [{
      code: 'dependencyUnavailable', title: '依赖不可用', explanation: '原生依赖当前不可用。',
    }];
    const { value } = portableController({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/toolkit' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    expect(instance.lastFrame()).not.toContain('选择使用位置并确认变化');
    await openPortableFromInstall(instance);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'portableSkillSelect', pluginId: 'official/toolkit',
    });
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
  ])('focuses the unavailable Portable card without executing it at $columns x $rows', async (size) => {
    const loaded = status();
    loaded.portablePluginIds = [];
    const { value, capture } = portableController({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'installTargets', pluginId: 'official/toolkit' });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();

    await send(instance, '\u001B[B', '\u001B[B');
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('› 通用 Agent Skills →');
    expect(frame).toContain('这个插件不提供通用 Agent Skills');
    expect(frame).not.toContain('[Skills 可选]');
    expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);

    await send(instance, '\r', ' ');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'installTargets', pluginId: 'official/toolkit',
    });
    expect(value.snapshot.portableDraft).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
  ])('keeps every unavailable native platform reason readable at $columns x $rows', async (size) => {
    const loaded = status();
    loaded.portablePluginIds = [];
    const toolkit = loaded.pluginSummaries.find((entry) => entry.pluginId === 'official/toolkit')!;
    toolkit.supportedTargets = { codex: [], claude: [] };
    const { value, capture } = portableController({ loadStatus: vi.fn().mockResolvedValue(loaded) });
    await value.load();
    value.push({ name: 'installTargets', pluginId: 'official/toolkit' });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('所选目标平台不可用');
    expect(frame).toContain('Codex');
    expect(frame).toContain('Claude Code');
    expect(frame).toContain('不可选');
    expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
    expect(capture).not.toHaveBeenCalled();
  });

  it('returns a platform-origin Portable blocker to target platforms without losing native choices', async () => {
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind === 'portableInstall') {
        throw new TuiOperationBlockedError('portableValidationFailed', '候选 Skill 校验失败。');
      }
      throw new Error('unexpected intent');
    });
    const { value } = portableController({ captureEvidence });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/toolkit' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    await focusPortableAction(instance, '安装');
    await send(instance, '\r', '\r');
    expect(value.snapshot.installPlacementDraft?.platforms).toEqual(['codex']);
    await focusPortableAction(instance, '通用 Agent Skills →');
    await send(instance, '\r');
    await tick(2);
    expect(value.snapshot.router.current.route).toMatchObject({
      name: 'portableBlocker', pluginId: 'official/toolkit', code: 'portableValidationFailed',
    });
    expect(instance.lastFrame()).toContain('返回目标平台');
    await focusPortableAction(instance, '返回目标平台');
    await send(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'installTargets', pluginId: 'official/toolkit',
    });
    expect(value.snapshot.installPlacementDraft?.platforms).toEqual(['codex']);
    expect(instance.lastFrame()).toContain('[x] Codex');
  });

  it('leaves a successful platform-origin Portable result at stable detail without old install steps', async () => {
    const { value } = portableController();
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/toolkit' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    await focusPortableAction(instance, '安装');
    await send(instance, '\r', '\r');
    await focusPortableAction(instance, '通用 Agent Skills →');
    await send(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('portableSkillSelect'));
    const operation = await value.buildPortableInstallReview();
    await value.executeOperation(operation.reviewToken);
    await tick();
    expect(instance.lastFrame()).not.toContain('返回目标平台');
    await send(instance, '\u001B');
    await vi.waitFor(() => expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/toolkit',
    }));
    await send(instance, 'b');
    expect(value.snapshot.router.current.route.name).not.toBe('installTargets');
    expect(value.snapshot.router.current.route.name).not.toBe('installPlacement');
  });

  it.each([
    {
      label: 'blocked preview flow through Skill selection',
      origin: { name: 'pluginDetail', pluginId: 'official/toolkit' } as const,
      previous: { name: 'home' } as const,
      resultState: 'blocked' as const,
      modificationTarget: 'portableSkillSelect' as const,
      explicitAgents: false,
    },
    {
      label: 'partial detail flow through explicit Agent input',
      origin: { name: 'pluginDetail', pluginId: 'official/toolkit' } as const,
      previous: { name: 'pluginList', mode: 'installed' } as const,
      resultState: 'partial' as const,
      modificationTarget: 'portableAgentInput' as const,
      explicitAgents: true,
    },
  ])('returns a repeated $label to its origin without retaining Portable pages', async ({
    origin, previous, resultState, modificationTarget, explicitAgents,
  }) => {
    let attempt = 0;
    const executeIntent = vi.fn(async (intent: OperationIntent): Promise<PortableInstallReceipt> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      attempt += 1;
      if (attempt === 1 && resultState === 'blocked') {
        throw Object.assign(new Error('安装证据已变化。'), { code: 'portableInstallBlocked' });
      }
      const portable = review(intent);
      if (attempt === 1) {
        return {
          receiptSchemaVersion: 5, command: 'skill:install', ok: false, status: 'failed',
          plugin: { id: intent.pluginId }, scope: intent.scope, selectedSkills: portable.selected,
          requestedSkills: intent.selectedSkills, agentMode: portable.agentMode,
          requestedAgents: portable.requestedAgents, skillsCliVersion: portable.skillsCliVersion,
          collisions: [], dependencies: portable.dependencies,
          materializationDigest: portable.materializationDigest,
          verification: { records: [], missing: [] }, warnings: [], failures: [{
            code: 'portableSkillsCliInstallFailed', message: '安装失败。', recovery: '重试。',
          }],
        };
      }
      return {
        receiptSchemaVersion: 5, command: 'skill:install', ok: true, status: 'succeeded',
        plugin: { id: intent.pluginId }, scope: intent.scope, selectedSkills: portable.selected,
        requestedSkills: intent.selectedSkills, agentMode: portable.agentMode,
        requestedAgents: portable.requestedAgents, skillsCliVersion: portable.skillsCliVersion,
        collisions: [], dependencies: portable.dependencies,
        materializationDigest: portable.materializationDigest,
        verification: { records: [], missing: [] }, warnings: [], failures: [],
      };
    });
    const { value } = portableController({ executeIntent });
    await value.load();
    if (previous.name !== 'home') value.push(previous);
    value.push(origin);
    await value.preparePortableInstall('official/toolkit');
    if (explicitAgents) value.setPortableAgentMode('explicit', ['codex']);
    const firstOperation = await value.buildPortableInstallReview();
    const firstResult = await value.executeOperation(firstOperation.reviewToken);
    expect(firstResult.state).toBe(resultState);

    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();
    await send(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: modificationTarget, pluginId: 'official/toolkit',
    });

    const secondOperation = await value.buildPortableInstallReview();
    const secondResult = await value.executeOperation(secondOperation.reviewToken);
    expect(secondResult.state).toBe('succeeded');
    await tick();
    await send(instance, '\u001B');
    await vi.waitFor(() => expect(value.snapshot.router.current.route).toEqual(origin));
    value.back();
    expect(value.snapshot.router.current.route).toEqual(previous);
  });

  it('renders an expired Portable Review as blocked before any success text', async () => {
    let now = 1_000;
    const { value } = portableController({ now: () => now, reviewTtlMs: 10 });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/toolkit' });
    await value.preparePortableInstall('official/toolkit');
    const operation = await value.buildPortableInstallReview();
    now = 2_000;
    await value.executeOperation(operation.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await tick();
    expect(instance.lastFrame()).toContain('通用 Skills 安装被阻止');
    expect(instance.lastFrame()).toContain('确认信息已过期，写入未开始');
    expect(instance.lastFrame()).not.toContain('通用 Skills 已安装');
    expect(instance.lastFrame()).not.toContain('已通过安装验证');
    for (const label of ['返回修改', '返回插件详情']) {
      await focusPortableAction(instance, label);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 移动');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(18);
    }
  });

  it('resets a Portable result home action to one root frame without a retained flow', async () => {
    const { value } = portableController();
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/toolkit' });
    await value.preparePortableInstall('official/toolkit');
    const operation = await value.buildPortableInstallReview();
    await value.executeOperation(operation.reviewToken);

    value.leaveResult({ name: 'home' });

    expect(value.snapshot.router).toMatchObject({
      depth: 1,
      current: { route: { name: 'home' } },
    });
    expect(value.snapshot.router.currentFlowId).toBeUndefined();
    expect(value.snapshot.portableDraft).toBeUndefined();
    expect(value.snapshot.result).toBeUndefined();
  });

  it('uses typed portable blocker codes before a message prefix fallback', () => {
    expect(extractPortableError(Object.assign(new Error('portableSkillInvalid: detail'), {
      code: 'portableSkillsCliMissing',
    }))).toEqual({ code: 'portableSkillsCliMissing', diagnosticCode: 'portableSkillsCliMissing' });
    expect(extractPortableError(new Error('requiredConfigMissing: detail'))).toEqual({
      code: 'requiredConfigMissing', diagnosticCode: 'requiredConfigMissing',
    });
    expect(extractPortableError(Object.assign(new Error('/private/path'), {
      code: 'portableSkillInvalid',
    }))).toEqual({ code: 'portableValidationFailed', diagnosticCode: 'portableSkillInvalid' });
    expect(extractPortableError(Object.assign(new Error('scope mismatch'), {
      code: 'portableScopeUnavailable',
    }))).toEqual({ code: 'portableScopeUnavailable', diagnosticCode: 'portableScopeUnavailable' });
  });

  it('uses Space and Enter to toggle a Portable Skill without advancing', async () => {
    const { value } = portableController();
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    expect(value.snapshot.portableDraft?.selectedCount).toBe(3);
    await send(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'portableSkillSelect', pluginId: 'official/toolkit',
    });
    expect(value.snapshot.portableDraft?.selectedCount).toBe(2);
    await send(instance, ' ');
    expect(value.snapshot.portableDraft?.selectedCount).toBe(3);
    expect(instance.lastFrame()).toContain('[x] author-skill');
  });

  it.each(['focused continue', 'c shortcut'] as const)(
    'uses the visible Continue action and c as the same Portable selection confirmation for %s',
    async (method) => {
      const { value } = portableController();
      await value.load();
      await value.preparePortableInstall('official/toolkit');
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
      await tick();

      if (method === 'focused continue') {
        await send(instance, 'a');
        expect(instance.lastFrame()).toContain('› 继续（3） [c]');
        await send(instance, '\r');
      } else {
        await send(instance, 'c');
      }
      expect(value.snapshot.router.current.route).toEqual({
        name: 'portableAgentMode', pluginId: 'official/toolkit',
      });
    },
  );

  it.each([
    { columns: 60, rows: 18, method: 'c shortcut' as const, close: 'escape' as const },
    { columns: 80, rows: 24, method: 'focused continue' as const, close: 'enter' as const },
  ])('shows U26 for a zero Portable selection through $method at $columns x $rows', async (fixture) => {
    const { value, capture } = portableController();
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.clearPortableSkills();
    capture.mockClear();
    const executeOperation = vi.spyOn(value, 'executeOperation');
    const instance = render(<ConsoleAppV4 controller={value}
      size={{ columns: fixture.columns, rows: fixture.rows }} />);
    await tick();

    if (fixture.method === 'focused continue') {
      await send(instance, 'a');
      expect(instance.lastFrame()).toContain('› 继续（0） [c]');
      await send(instance, '\r');
    } else {
      expect(instance.lastFrame()).toContain('› [ ] author-skill');
      await send(instance, 'c');
    }
    const blocked = instance.lastFrame() ?? '';
    expect(blocked).toContain('还没有选择 Skill');
    expect(blocked).toContain('用 Space 勾选；也可以打开选择工具。');
    expect(blocked).toContain('› 返回选择');
    expect(blocked).toMatch(/author-skill|review-skill|content-skill/u);
    expect(value.snapshot.portableDraft?.candidates).toHaveLength(3);
    expect(blocked).toContain('Enter 返回选择 · Esc 返回');
    expect(blocked).toContain('╭');
    expect(blocked).toContain('╰');
    expect(blocked.match(/›/gu)).toHaveLength(1);
    expect(blocked.match(/╭/gu)?.length ?? 0).toBeGreaterThan(1);
    expect(blocked.split('\n').length).toBeLessThanOrEqual(fixture.rows);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'portableSkillSelect', pluginId: 'official/toolkit',
    });
    expect(value.snapshot.activeReview).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
    expect(executeOperation).not.toHaveBeenCalled();

    await send(instance, ' ', '\u001B[B', '\t', 'a', 'c', '?');
    expect(instance.lastFrame()).toContain('还没有选择 Skill');
    expect(instance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect(value.snapshot.portableDraft?.selectedCount).toBe(0);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'portableSkillSelect', pluginId: 'official/toolkit',
    });
    expect(capture).not.toHaveBeenCalled();
    expect(executeOperation).not.toHaveBeenCalled();

    if (fixture.close === 'escape') {
      instance.stdin.write('\u001B');
      await new Promise((resolve) => setTimeout(resolve, 550));
    } else {
      await send(instance, '\r');
    }
    expect(value.snapshot.router.current.route).toEqual({
      name: 'portableSkillSelect', pluginId: 'official/toolkit',
    });
    expect(instance.lastFrame()).toContain(fixture.method === 'focused continue'
      ? '› 继续（0） [c]' : '› [ ] author-skill');
    expect(capture).not.toHaveBeenCalled();
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it('filters selected Portable Skills, clears them, and restores all candidates', async () => {
    const { value } = portableController();
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    await openPortableTools(instance);
    await send(instance, '\u001B[B', '\u001B[B', '\r');
    expect(value.snapshot.portableDraft?.selectedCount).toBe(0);
    await openPortableTools(instance);
    await send(instance, '\u001B[B', '\r');
    expect(instance.lastFrame()).toContain('没有已选 Skill');
    await openPortableTools(instance);
    await send(instance, '\u001B[B', '\r');
    await openPortableTools(instance);
    await send(instance, '\r');
    expect(value.snapshot.portableDraft?.selectedCount).toBe(3);
    expect(instance.lastFrame()).toContain('3 / 3 已选择');
  });

  it('advertises only the manifest capability before entry, then selects candidates and executes the reviewed subset', async () => {
    const { value, capture } = portableController();
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/toolkit' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();
    expect(instance.lastFrame()).toContain('[Skills 可选]');
    expect(instance.lastFrame()).toContain('Codex');
    expect(instance.lastFrame()).toContain('Claude Code');
    expect(instance.lastFrame()).toContain('更多操作');
    expect(instance.lastFrame()).toContain('依赖关系');
    expect(instance.lastFrame()).not.toContain('3 个候选');
    expect(capture).not.toHaveBeenCalled();

    await openPortableFromInstall(instance);
    expect(value.snapshot.router.current.route.name).toBe('portableSkillSelect');
    expect(instance.lastFrame()).toContain('3 / 3 已选择');
    expect(instance.lastFrame()).toContain('当前插件');
    await send(instance, '\u001B[B', '\u001B[B');
    expect(instance.lastFrame()).toContain('Content');
    expect(instance.lastFrame()).toContain('直接依赖插件');
    await send(instance, '\u001B[A', '\u001B[A');

    await send(instance, ' ', '\u001B[B', ' ', '\u001B[B', ' ');
    expect(value.snapshot.portableDraft?.selectedCount).toBe(0);
    expect(instance.lastFrame()).toContain('至少选择一个 Skill');
    await openPortableTools(instance);
    await send(instance, '\r', '\u001B[B', '\u001B[B', ' ');
    expect(value.snapshot.portableDraft?.selectedCount).toBe(2);
    await send(instance, 'c', '\r', '\u001B[B', '\u001B[B', '\r');

    expect(value.snapshot.activeReview?.operationKind).toBe('portableInstall');
    expect(value.snapshot.activeReview?.changes.map((change) => change.title)).toEqual(expect.arrayContaining([
      'author-skill', 'review-skill', 'Agent', '范围', '插件依赖',
    ]));
    expect(value.snapshot.activeReview?.changes.map((change) => change.title)).not.toContain('content-skill');
    expect(value.snapshot.activeReview?.changes.find((change) => change.title === 'author-skill')?.description).toContain('Toolkit');
    expect(value.snapshot.activeReview?.changes.some((change) => change.title === '同名覆盖')).toBe(true);

    expect(instance.lastFrame()).toContain('自动选择检测到的 Agent');
    expect(instance.lastFrame()).toContain('当前项目');
    expect(instance.lastFrame()).toContain(`› ${value.snapshot.activeReview!.primaryLabel}`);
    await send(instance, '\r');
    await tick(3);
    expect(value.snapshot.result?.state).toBe('succeeded');
    expect(instance.lastFrame()).toContain('通用 Skills 已安装');
  });

  it('returns portable stale execution to a newly captured Review and keeps the draft', async () => {
    let captureCount = 0;
    const { value } = portableController({
      captureEvidence: vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
        if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
        captureCount += 1;
        const portable = { ...review(intent), evidenceDigest: `evidence-${captureCount}` };
        return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
      }),
      executeIntent: vi.fn().mockRejectedValue(new TuiOperationBlockedError(
        'operationReviewStale',
        'operationReviewStale: changed',
      )),
    });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    const operation = await value.buildPortableInstallReview();
    const result = await value.executeOperation(operation.reviewToken);
    expect(result.state).toBe('stale');
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(value.snapshot.portableDraft?.selectedCount).toBe(3);
    expect(result).not.toHaveProperty('writeMayHaveCompleted');
  });

  it.each([
    ['requiredConfigMissing', 'U09', '完成插件设置'],
    ['portableSkillsCliMissing', 'U10', '查看准备要求'],
    ['portableSkillsCliIncompatible', 'U10', '查看准备要求'],
    ['portableValidationFailed', 'U11', '重新检查'],
  ] as const)('renders typed blocker %s as %s with its recovery action', async (code, screen, action) => {
    const { value } = portableController();
    await value.load();
    value.push({ name: 'portableBlocker', pluginId: 'official/toolkit', code, diagnosticCode: 'portableSkillInvalid' });
    let current: string | undefined;
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} onScreenChange={(next) => { current = next; }} />);
    await tick();
    expect(current).toBe(screen);
    expect(instance.lastFrame()).toContain(action);
    if (code === 'portableValidationFailed') {
      await send(instance, 'd');
      expect(instance.lastFrame()).toContain('portableSkillInvalid');
      expect(instance.lastFrame()).toContain('prepare-portable');
      expect(instance.lastFrame()).not.toContain('/private/');
    }
  });

  it.each([
    { columns: 60, rows: 18, code: 'portableSkillsCliMissing' as const },
    { columns: 80, rows: 24, code: 'portableSkillsCliIncompatible' as const },
  ])('shows safe tool preparation requirements at $columns x $rows for $code', async (size) => {
    const { value } = portableController();
    await value.load();
    value.push({
      name: 'portableBlocker',
      pluginId: 'official/toolkit',
      code: size.code,
      diagnosticCode: size.code,
    });
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();

    expect(instance.lastFrame()).toContain('› 查看准备要求');
    await send(instance, '\r');
    const requirements = instance.lastFrame() ?? '';
    expect(requirements).toContain('准备安装工具');
    expect(requirements).toContain('在 PATH 中提供兼容的 skills 可执行文件');
    expect(requirements).toContain('当前 AW adapter 支持');
    expect(requirements).toContain('不会自动运行 npx latest、sudo');
    expect(requirements).toContain('Portable 草稿保持不变');
    expect(requirements).toContain('› 返回问题摘要');
    expect(requirements.match(/›/gu)).toHaveLength(1);
    expect(requirements.split('\n').length).toBeLessThanOrEqual(size.rows);
    await send(instance, '\r');
    expect(instance.lastFrame()).toContain('› 查看准备要求');
    expect(value.snapshot.router.current.route.name).toBe('portableBlocker');
  });

  it.each([
    { columns: 60, rows: 18, code: 'portableSkillsCliMissing' as const },
    { columns: 80, rows: 24, code: 'portableSkillsCliMissing' as const },
    { columns: 60, rows: 18, code: 'portableSkillsCliIncompatible' as const },
    { columns: 80, rows: 24, code: 'portableSkillsCliIncompatible' as const },
  ])('distinguishes the visible Skills CLI blocker for $code at $columns x $rows', async (fixture) => {
    const { value, capture } = portableController();
    await value.load();
    value.push({
      name: 'portableBlocker', pluginId: 'official/toolkit',
      code: fixture.code, diagnosticCode: fixture.code,
    });
    const executeOperation = vi.spyOn(value, 'executeOperation');
    const instance = render(<ConsoleAppV4 controller={value}
      size={{ columns: fixture.columns, rows: fixture.rows }} />);
    await tick();

    const frame = instance.lastFrame() ?? '';
    if (fixture.code === 'portableSkillsCliMissing') {
      expect(frame).toContain('未安装 Skills CLI');
      expect(frame).toContain('没有找到已安装的 Skills CLI');
      expect(frame).toContain('Skills CLI 尚未安装');
      expect(frame).not.toContain('版本不兼容');
    } else {
      expect(frame).toContain('Skills CLI 版本不兼容');
      expect(frame).toContain(`版本不在支持范围 ${SKILLS_CLI_SUPPORTED_VERSION_LABEL}`);
      expect(frame).toContain('已安装的 Skills CLI 版本不兼容');
      expect(frame).not.toContain('没有找到已安装的 Skills CLI');
    }
    expect(frame).toContain('› 查看准备要求');
    expect(frame.split('\n').length).toBeLessThanOrEqual(fixture.rows);
    expect(capture).not.toHaveBeenCalled();
    expect(executeOperation).not.toHaveBeenCalled();
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
  ])('requires a separate confirmation before a user-scope portable install at $columns x $rows', async (size) => {
    const { value } = portableController();
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.setPortableScope('user');
    const review = await value.buildPortableInstallReview();
    expect(review.requiresConfirmation).toBe(false);
    const executeOperation = vi.spyOn(value, 'executeOperation');
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();

    await send(instance, '\r');
    const confirmation = instance.lastFrame() ?? '';
    expect(confirmation).toContain('确认本次影响');
    expect(confirmation).toContain('本次在所有项目范围安装选定 Skills');
    expect(confirmation).toContain('具体对象和范围以刚才的汇总为准');
    expect(confirmation).toContain('› 返回检查');
    expect(confirmation).toContain('确认并执行');
    expect(confirmation.match(/›/gu)).toHaveLength(1);
    expect(confirmation.split('\n').length).toBeLessThanOrEqual(size.rows);
    expect(executeOperation).not.toHaveBeenCalled();

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(instance.lastFrame()).toContain(`› ${review.primaryLabel}`);
    expect(executeOperation).not.toHaveBeenCalled();

    await send(instance, '\r', '\u001B[B', '\r');
    await vi.waitFor(() => expect(value.snapshot.result?.state).toBe('succeeded'));
    expect(executeOperation).toHaveBeenCalledOnce();
  });

  it.each([
    { diagnosticCode: 'portableSensitiveOutput', risk: '生成的 Skill 内容包含敏感配置值或未解析模板。', columns: 60, rows: 18 },
    { diagnosticCode: 'portableSensitiveOutput', risk: '生成的 Skill 内容包含敏感配置值或未解析模板。', columns: 80, rows: 24 },
    { diagnosticCode: 'portableRuntimeImportMissing', risk: '所需运行时引用未解析、缺失或无效。', columns: 60, rows: 18 },
    { diagnosticCode: 'portableRuntimeImportMissing', risk: '所需运行时引用未解析、缺失或无效。', columns: 80, rows: 24 },
  ] as const)('renders Portable risk $diagnosticCode at $columns x $rows without an install action', async ({ diagnosticCode, risk, columns, rows }) => {
    const { value } = portableController();
    await value.load();
    value.push({
      name: 'portableBlocker',
      pluginId: 'official/toolkit',
      code: 'portableValidationFailed',
      diagnosticCode,
    });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns, rows }} />);
    await tick();

    expect(instance.lastFrame()).toContain(risk);
    expect(instance.lastFrame()).toContain('没有开始写入，也没有调用 Skills CLI。');
    expect(instance.lastFrame()).not.toContain('继续安装');

    await send(instance, 'd');
    expect(instance.lastFrame()).toContain(diagnosticCode);
    expect(instance.lastFrame()).toContain('prepare-portable');
  });

  it.each([
    { diagnosticCode: 'portableSkillCollision', reason: '两个来源提供同名 Skill，无法安全确定写入内容。', next: '移除同名冲突', columns: 60, rows: 18 },
    { diagnosticCode: 'portableSkillCollision', reason: '两个来源提供同名 Skill，无法安全确定写入内容。', next: '移除同名冲突', columns: 80, rows: 24 },
    { diagnosticCode: 'portableDistributionUnavailable', reason: '插件没有可信的通用 Skills 分发定义。', next: '修复插件的通用 Skills 分发定义', columns: 60, rows: 18 },
    { diagnosticCode: 'portableDistributionUnavailable', reason: '插件没有可信的通用 Skills 分发定义。', next: '修复插件的通用 Skills 分发定义', columns: 80, rows: 24 },
  ])('names Portable blocker $diagnosticCode at $columns x $rows', async (fixture) => {
    const { value } = portableController();
    await value.load();
    value.push({
      name: 'portableBlocker', pluginId: 'official/toolkit',
      code: 'portableValidationFailed', diagnosticCode: fixture.diagnosticCode,
    });
    const instance = render(<ConsoleAppV4 controller={value}
      size={{ columns: fixture.columns, rows: fixture.rows }} />);
    await tick();

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain(fixture.reason);
    expect(frame).toContain(fixture.next);
    expect(frame).toContain('没有开始写入，也没有调用 Skills CLI。');
    expect(frame.split('\n').length).toBeLessThanOrEqual(fixture.rows);
  });

  it('discards the transient draft on non-portable navigation but preserves explicit modification paths', async () => {
    const { value } = portableController();
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.push({ name: 'configLayer', pluginId: 'official/toolkit' });
    expect(value.snapshot.portableDraft).toBeUndefined();

    await value.preparePortableInstall('official/toolkit');
    value.replace({ name: 'portableAgentInput', pluginId: 'official/toolkit' });
    expect(value.snapshot.portableDraft?.selectedCount).toBe(3);
    value.replace({ name: 'pluginPreview', pluginId: 'official/toolkit' });
    expect(value.snapshot.portableDraft).toBeUndefined();
  });

  it('single-flights duplicate prepare and Review requests', async () => {
    const pending = deferred<OperationEvidence>();
    const captureEvidence = vi.fn(() => pending.promise);
    const { value } = portableController({ captureEvidence });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/toolkit' });

    const first = value.preparePortableInstall('official/toolkit');
    const second = value.preparePortableInstall('official/toolkit');
    expect(captureEvidence).toHaveBeenCalledTimes(2);
    const portable = review({ kind: 'portableInstall', pluginId: 'official/toolkit', scope: 'project', selectedSkills: [] });
    pending.resolve({ catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable });
    await Promise.all([first, second]);
    expect(value.snapshot.router).toMatchObject({ depth: 3, current: { route: { name: 'portableSkillSelect' } } });

    const reviewPending = deferred<OperationEvidence>();
    captureEvidence.mockImplementation(() => reviewPending.promise);
    const firstReview = value.buildPortableInstallReview();
    const secondReview = value.buildPortableInstallReview();
    expect(captureEvidence).toHaveBeenCalledTimes(3);
    reviewPending.resolve({ catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable });
    await Promise.all([firstReview, secondReview]);
    expect(value.snapshot.router).toMatchObject({ depth: 4, current: { route: { name: 'review' } } });
  });

  it('shows cancellable preparation, restores the native draft, and ignores late evidence', async () => {
    const pending = deferred<OperationEvidence>();
    const captureEvidence = vi.fn(() => pending.promise);
    const { value } = portableController({ captureEvidence });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/toolkit' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await tick();

    await focusPortableAction(instance, '安装');
    await send(instance, '\r', '\r', '\u001B[B', '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'portablePreparing', pluginId: 'official/toolkit',
    });
    expect(instance.lastFrame()).toContain('正在准备可安装的 Skills');
    expect(instance.lastFrame()).toContain('此步骤不会写入文');
    expect(instance.lastFrame()).toContain('件或调用 Skills CLI');
    expect(instance.lastFrame()).toContain('Esc 取消检查并返回目标平台');
    expect(value.snapshot.installPlacementDraft?.platforms).toEqual(['codex']);

    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(value.snapshot.router.current.route).toEqual({
      name: 'installTargets', pluginId: 'official/toolkit',
    });
    expect(value.snapshot.installPlacementDraft?.platforms).toEqual(['codex']);

    const portable = review({ kind: 'portableInstall', pluginId: 'official/toolkit', scope: 'project', selectedSkills: [] });
    pending.resolve({ catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable });
    await tick(3);
    expect(value.snapshot.router.current.route).toEqual({
      name: 'installTargets', pluginId: 'official/toolkit',
    });
    expect(value.snapshot.portableDraft).toBeUndefined();
  });

  it('does not let a cancelled prepare restore its route or draft and aborts it on dispose', async () => {
    const pending = deferred<OperationEvidence>();
    const signals: AbortSignal[] = [];
    const captureEvidence = vi.fn((_intent: OperationIntent, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return pending.promise;
    });
    const { value } = portableController({ captureEvidence });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/toolkit' });
    const preparing = value.preparePortableInstall('official/toolkit');
    value.back();
    const portable = review({ kind: 'portableInstall', pluginId: 'official/toolkit', scope: 'project', selectedSkills: [] });
    pending.resolve({ catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable });
    await expect(preparing).rejects.toMatchObject({ name: 'AbortError' });
    expect(value.snapshot.router.current.route).toEqual({
      name: 'pluginDetail', pluginId: 'official/toolkit',
    });
    expect(value.snapshot.portableDraft).toBeUndefined();
    expect(signals.every((signal) => signal.aborted)).toBe(true);

    const secondPending = deferred<OperationEvidence>();
    captureEvidence.mockImplementation((_intent: OperationIntent, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return secondPending.promise;
    });
    const second = value.preparePortableInstall('official/toolkit');
    value.dispose();
    expect(signals.at(-1)?.aborted).toBe(true);
    secondPending.resolve({ catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps the latest Portable draft when an older request completes last', async () => {
    const older = deferred<OperationEvidence>();
    const newer = deferred<OperationEvidence>();
    let calls = 0;
    const captureEvidence = vi.fn(() => {
      calls += 1;
      return calls <= 2 ? older.promise : newer.promise;
    });
    const { value } = portableController({ captureEvidence });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/toolkit' });
    const oldPrepare = value.preparePortableInstall('official/toolkit');
    value.replace({ name: 'pluginPreview', pluginId: 'official/toolkit' });
    const newPrepare = value.preparePortableInstall('official/toolkit');
    const base = review({ kind: 'portableInstall', pluginId: 'official/toolkit', scope: 'project', selectedSkills: [] });
    newer.resolve({
      catalog: { configDigest: base.configDigest, compositeDigest: 'new' },
      portable: { ...base, evidenceDigest: 'new', selected: [{ ...candidates[0]!, name: 'latest-skill' }] },
    });
    await newPrepare;
    older.resolve({
      catalog: { configDigest: base.configDigest, compositeDigest: 'old' },
      portable: { ...base, evidenceDigest: 'old', selected: [{ ...candidates[0]!, name: 'old-skill' }] },
    });
    await expect(oldPrepare).rejects.toMatchObject({ name: 'AbortError' });
    expect(value.snapshot.portableDraft?.candidates.map((candidate) => candidate.name)).toEqual(['latest-skill']);
    expect(value.snapshot.router.current.route.name).toBe('portableSkillSelect');
  });

  it('replaces repeated blockers and truncates the Portable flow before returning', async () => {
    const captureEvidence = vi.fn().mockRejectedValue(Object.assign(new Error('invalid'), { code: 'portableSkillInvalid' }));
    const { value } = portableController({ captureEvidence });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/toolkit' });
    value.push({ name: 'portableBlocker', pluginId: 'official/toolkit', code: 'portableValidationFailed', diagnosticCode: 'portableSkillInvalid' });
    const depth = value.snapshot.router.depth;
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();
    await send(instance, '\r', '\r');
    expect(value.snapshot.router.depth).toBe(depth);
    expect(value.snapshot.router.current.route.name).toBe('portableBlocker');

    value.resetPortableFlowToPreview(
      'official/toolkit',
      { name: 'portableSkillSelect', pluginId: 'official/toolkit' },
      true,
    );
    expect(value.snapshot.router.depth).toBe(3);
    value.back();
    expect(value.snapshot.router.current.route.name).toBe('pluginDetail');
    expect(value.snapshot.portableDraft).toBeUndefined();
  });

  it('prepares fresh candidates after required settings are saved', async () => {
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind === 'portableInstall') {
        const portable = review(intent);
        return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
      }
      return {
        catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:catalog' },
        config: { scope: intent.scope, projectLayer: intent.projectLayer, storeDigest: 'sha256:store' },
      };
    });
    const executeIntent = vi.fn(async (intent: OperationIntent) => intent.kind === 'configSave'
      ? {
          configWrite: 'succeeded',
          overallState: 'succeeded',
          apply: { state: 'succeeded', targetResults: [] },
        }
      : (() => { throw new Error('unexpected intent'); })());
    const { value } = portableController({ captureEvidence, executeIntent });
    await value.load();
    value.push({
      name: 'portableBlocker', pluginId: 'official/toolkit', code: 'requiredConfigMissing',
      diagnosticCode: 'requiredConfigMissing',
    });
    value.replace({ name: 'configFields', pluginId: 'official/toolkit', layer: { scope: 'effective' } });
    const operation = await value.buildOperationReview({
      kind: 'configSave', pluginId: 'official/toolkit', scope: 'user', projectLayer: 'shared', apply: true,
      updates: { token: 'private' }, privateKeys: ['token'],
    });

    const result = await value.executeOperation(operation.reviewToken);

    expect(result.state).toBe('succeeded');
    expect(value.snapshot.router.current.route.name).toBe('portableSkillSelect');
    expect(value.snapshot.portableDraft?.selectedCount).toBe(3);
    expect(captureEvidence.mock.calls.filter(([intent]) => intent.kind === 'portableInstall')).toHaveLength(2);
  });

  it('keeps a successful settings result when it includes a safe attention message', async () => {
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind === 'portableInstall') {
        const portable = review(intent);
        return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
      }
      if (intent.kind !== 'configSaveBatch') throw new Error('unexpected intent');
      return {
        catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:catalog' },
        configBatch: { groups: intent.groups.map((group) => ({
          scope: group.scope,
          targetFingerprint: `sha256:${group.scope}`,
          config: {
            scope: group.scope, storeDigest: `sha256:store:${group.scope}`,
            impactState: 'known', affectedTargets: [],
          },
        })) },
      };
    });
    const executeIntent = vi.fn(async () => ({
      status: 'succeeded' as const,
      groups: [{
        scope: 'project' as const, status: 'succeeded' as const, configSaved: true,
        applyRequested: true, applyStatus: 'succeeded' as const,
        execution: {
          configWrite: 'succeeded', apply: { state: 'succeeded', targetResults: [] },
          warnings: ['projectConfigShareabilityUnverified: Git visibility was not confirmed.'],
        },
      }, {
        scope: 'user' as const, status: 'succeeded' as const, configSaved: true,
        applyRequested: true, applyStatus: 'succeeded' as const,
        execution: {
          configWrite: 'succeeded', apply: { state: 'succeeded', targetResults: [] },
          otherProjectsMayRequireSync: true,
        },
      }],
    }));
    const { value } = portableController({ captureEvidence, executeIntent });
    await value.load();
    value.push({
      name: 'portableBlocker', pluginId: 'official/toolkit', code: 'requiredConfigMissing',
      diagnosticCode: 'requiredConfigMissing',
    });
    value.replace({
      name: 'configFields', pluginId: 'official/toolkit', layer: { scope: 'effective' },
    });
    const operation = await value.buildOperationReview({
      kind: 'configSaveBatch', pluginId: 'official/toolkit', apply: true,
      groups: [{ scope: 'project', updates: { mode: 'strict' } }, {
        scope: 'user', updates: { token: 'private' }, privateKeys: ['token'],
      }],
    });

    const result = await value.executeOperation(operation.reviewToken);

    expect(result.state).toBe('succeeded');
    expect(value.snapshot.router.current.route.name).toBe('result');
    expect(result.summary.messages).toEqual(expect.arrayContaining([
      '警告：projectConfigShareabilityUnverified: Git visibility was not confirmed.',
      '提示：其它项目没有被扫描，可能需要在对应项目目录中运行 aw sync。',
    ]));
    expect(captureEvidence.mock.calls.filter(([intent]) => intent.kind === 'portableInstall')).toHaveLength(0);
  });

  it('keeps a partial settings result before retrying only the failed layer', async () => {
    const captured: OperationIntent[] = [];
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      captured.push(structuredClone(intent));
      if (intent.kind === 'portableInstall') {
        const portable = review(intent);
        return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
      }
      if (intent.kind === 'configSaveBatch') {
        return {
          catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:catalog' },
          configBatch: { groups: intent.groups.map((group) => ({
            scope: group.scope,
            targetFingerprint: `sha256:${group.scope}`,
            config: {
              scope: group.scope, storeDigest: `sha256:store:${group.scope}`,
              impactState: 'known', affectedTargets: [],
            },
          })) },
        };
      }
      return {
        catalog: { configDigest: 'sha256:config', compositeDigest: 'sha256:catalog' },
        config: { scope: intent.scope, storeDigest: 'sha256:store:user' },
      };
    });
    const executeIntent = vi.fn(async (intent: OperationIntent) => intent.kind === 'configSaveBatch'
      ? {
          status: 'partial' as const,
          groups: [{
            scope: 'project' as const, status: 'failed' as const, configSaved: false,
            applyRequested: true, applyStatus: 'failed' as const, errorCode: 'configWriteFailed',
          }, {
            scope: 'user' as const, status: 'failed' as const, configSaved: true,
            applyRequested: true, applyStatus: 'failed' as const, errorCode: 'targetApplyFailed',
            execution: {
              configWrite: 'succeeded',
              apply: {
                state: 'partial',
                errors: [{ stage: 'apply', code: 'targetApplyFailed' }],
                targetResults: [],
              },
              warnings: ['projectConfigShareabilityUnverified: Git visibility was not confirmed.'],
              otherProjectsMayRequireSync: true,
            },
          }],
        }
      : {
          configWrite: 'succeeded' as const, overallState: 'succeeded' as const,
          apply: { state: 'succeeded' as const, targetResults: [] },
        });
    const { value } = portableController({ captureEvidence, executeIntent });
    await value.load();
    value.push({
      name: 'portableBlocker', pluginId: 'official/toolkit', code: 'requiredConfigMissing',
      diagnosticCode: 'requiredConfigMissing',
    });
    value.replace({
      name: 'configFields', pluginId: 'official/toolkit', layer: { scope: 'effective' },
    });
    const batch = await value.buildOperationReview({
      kind: 'configSaveBatch', pluginId: 'official/toolkit', apply: true,
      groups: [{ scope: 'project', updates: { mode: 'strict' } }, {
        scope: 'user', updates: { token: 'private' }, privateKeys: ['token'],
      }],
    });

    const partial = await value.executeOperation(batch.reviewToken);

    expect(partial.state).toBe('partial');
    expect(value.snapshot.router.current.route.name).toBe('result');
    expect(partial.summary.messages).toContain(
      '警告：projectConfigShareabilityUnverified: Git visibility was not confirmed.',
    );
    expect(partial.summary.messages).toContain(
      '提示：其它项目没有被扫描，可能需要在对应项目目录中运行 aw sync。',
    );
    expect(captured.filter((intent) => intent.kind === 'portableInstall')).toHaveLength(0);
    const detail = value.getOperationDiagnostic(partial.operationRecordId!);
    expect(detail?.summary.effects.configCommit).toBe('partial');
    expect(detail?.diagnostics.map((diagnostic) => diagnostic.code)).toContain('configWriteFailed');

    const retry = await value.buildOperationReview({
      kind: 'configSave', pluginId: 'official/toolkit', scope: 'project', apply: true,
      updates: { mode: 'strict' },
    });
    const retried = await value.executeOperation(retry.reviewToken);

    expect(retried.state).toBe('succeeded');
    expect(value.snapshot.router.current.route.name).toBe('portableSkillSelect');
    expect(captured.filter((intent) => intent.kind === 'configSave')).toHaveLength(2);
    expect(captured.filter((intent) => intent.kind === 'configSaveBatch')).toHaveLength(2);
    expect(captured.filter((intent) => intent.kind === 'portableInstall')).toHaveLength(2);
  });

  it('unions scope candidates before selection and re-prepares the selected user scope for Review', async () => {
    const userCandidate = { ...candidates[0]!, name: 'user-only', description: 'User only.' };
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      if (intent.scope === 'project') throw Object.assign(new Error('no project candidates'), { code: 'portableNoSkills' });
      const portable = { ...review(intent), selected: intent.selectedSkills.length > 0 ? [userCandidate] : [userCandidate] };
      return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
    });
    const { value } = portableController({ captureEvidence });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    expect(value.snapshot.portableDraft?.candidates).toMatchObject([
      { name: 'user-only', availableScopes: ['user'] },
    ]);
    await expect(value.buildPortableInstallReview()).rejects.toMatchObject({ code: 'portableScopeUnavailable' });
    value.setPortableAgentMode('explicit', ['codex', 'cursor']);
    value.setPortableScope('user');
    await expect(value.buildPortableInstallReview()).resolves.toMatchObject({ operationKind: 'portableInstall' });
    expect(captureEvidence.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'portableInstall', scope: 'user', selectedSkills: ['user-only'],
    });
  });

  it('counts a Skill missing from one scope as a range variation without inventing details', async () => {
    const userCandidate = { ...candidates[0]!, description: 'Only available to the user scope.' };
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      if (intent.scope === 'project') throw Object.assign(new Error('unavailable'), { code: 'portableNoSkills' });
      const portable = { ...review(intent), selected: [userCandidate] };
      return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
    });
    const { value } = portableController({ captureEvidence });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    expect(instance.lastFrame()).toContain('! 1 个 Skill 在不同安装范围会生成不同内容');
    await send(instance, 'd');
    expect(instance.lastFrame()).toContain('当前项目：不可用');
    expect(instance.lastFrame()).toContain('所有项目：Only available to the user scope. · Toolkit');
    expect(instance.lastFrame()).not.toContain('当前项目：Only available');
  });

  it('renders Agent choice selection independently from focus', async () => {
    const { value } = portableController();
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.push({ name: 'portableAgentMode', pluginId: 'official/toolkit' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    expect(instance.lastFrame()).toContain('› ● 使用 Skills CLI 默认选择');
    await send(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('● 使用 Skills CLI 默认选择');
    expect(instance.lastFrame()).toContain('› ○ 指定 Agent');
    expect(value.snapshot.portableDraft?.agentMode).toBe('automatic');
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
  ])('renders bounded evidence-derived Portable technical progress at $columns x $rows', async (size) => {
    const gate = deferred<void>();
    const executeIntent = vi.fn(async (intent: OperationIntent): Promise<PortableInstallReceipt> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      await gate.promise;
      const portable = review(intent);
      return {
        receiptSchemaVersion: 5, command: 'skill:install', ok: true, status: 'succeeded',
        plugin: { id: intent.pluginId }, scope: intent.scope, selectedSkills: portable.selected,
        requestedSkills: intent.selectedSkills, agentMode: portable.agentMode,
        requestedAgents: portable.requestedAgents, skillsCliVersion: portable.skillsCliVersion,
        collisions: [], dependencies: portable.dependencies,
        materializationDigest: portable.materializationDigest,
        verification: { records: [], missing: [] }, warnings: [], failures: [],
      };
    });
    const { value, progress } = portableController({ executeIntent });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    await value.buildPortableInstallReview();
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();
    await send(instance, '\r');
    progress.setCurrent({ target: 'Skills CLI', phase: '检查插件依赖并生成候选' });
    await tick();

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('检查插件和依赖');
    expect(frame).toContain('生成已选候选 Skills');
    expect(frame).toContain('安装已选择的 3 个 Skills');
    expect(frame).toContain('验证结果');
    expect(frame).toContain('Toolkit · 1 个直接依赖');
    expect(frame).toContain('2 个来源或依赖插件提供 3 个 Skills');
    expect(frame).toContain('正在生成');
    expect(frame.match(/未开始/gu)).toHaveLength(2);
    expect(frame.match(/[✓●○×] /gu)).toHaveLength(4);

    for (let index = 1; index <= 4; index += 1) {
      progress.addNotice({ level: 'notice', identity: `portable-${index}`, message: `portable technical ${index}` });
    }
    await tick();
    expect(instance.lastFrame()).toContain('d 技术进度');
    await send(instance, 'd');
    const technicalFrame = instance.lastFrame() ?? '';
    for (const title of ['检查插件和依赖', '生成已选候选 Skills', '安装已选择的 3 个 Skills', '验证结果']) {
      expect(technicalFrame).toContain(title);
    }
    expect(technicalFrame).toContain(size.rows === 18 ? '另有 3 条技术消息' : '另有 1 条技术消息');
    expect(technicalFrame).toContain('d 技术进度');
    expect(technicalFrame).toContain('? 帮助');
    expect(technicalFrame.match(/[✓●○×] /gu)).toHaveLength(4);
    expect(technicalFrame.split('\n').length).toBeLessThanOrEqual(size.rows);

    await send(instance, 'd');
    const collapsedFrame = instance.lastFrame() ?? '';
    expect(collapsedFrame).toContain('Toolkit · 1 个直接依赖');
    expect(collapsedFrame).toContain('逐项确认所选 Skill 的安装目标');
    expect(collapsedFrame).not.toContain('另有 1 条技术消息');
    expect(collapsedFrame.split('\n').length).toBeLessThanOrEqual(size.rows);

    gate.resolve(undefined);
    await tick(4);
  });

  it('renders per-Skill result evidence and hides diagnostics until requested', async () => {
    const { value } = portableController();
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/toolkit' });
    await value.preparePortableInstall('official/toolkit');
    const operation = await value.buildPortableInstallReview();
    await value.executeOperation(operation.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('author-skill');
    let resultFrames = frame;
    for (let page = 0; page < candidates.length; page += 1) {
      await send(instance, 'n');
      resultFrames += `\n${instance.lastFrame() ?? ''}`;
    }
    for (const skill of candidates.map((candidate) => candidate.name)) {
      expect(resultFrames).toMatch(new RegExp(`${skill}\\s+已验证 · Agent：codex`, 'u'));
    }
    expect(frame).not.toContain('返回插件详情');
    expect(frame).toContain('Esc 返回');
    expect(frame).not.toContain('sha256:materialized');
    expect(frame).not.toContain('1.5.23');
    expect(frame).not.toContain('elapsed');
    await send(instance, 'd');
    expect(instance.lastFrame()).toContain('Skills CLI version');
    expect(instance.lastFrame()).toContain('1.5.23');
    expect(instance.lastFrame()).toContain('sha256:materialized');
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
  ])('prioritizes a missing Skill and keeps recovery actions visible in a $columns x $rows partial result', async (size) => {
    const manyCandidates: PortableReview['selected'] = Array.from({ length: 10 }, (_, index) => ({
      ...candidates[0]!,
      name: `result-skill-${index}`,
      description: `Result skill ${index}`,
      filesDigest: `sha256:result-${index}`,
    }));
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const selected = intent.selectedSkills.length === 0
        ? manyCandidates
        : manyCandidates.filter((candidate) => intent.selectedSkills.includes(candidate.name));
      const portable = { ...review(intent), selected };
      return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
    });
    const executeIntent = vi.fn(async (intent: OperationIntent): Promise<PortableInstallReceipt> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const portable = { ...review(intent), selected: manyCandidates };
      return {
        receiptSchemaVersion: 5, command: 'skill:install', ok: false, status: 'partial',
        plugin: { id: intent.pluginId }, scope: intent.scope, selectedSkills: manyCandidates,
        requestedSkills: intent.selectedSkills, agentMode: portable.agentMode,
        requestedAgents: portable.requestedAgents, skillsCliVersion: portable.skillsCliVersion,
        collisions: [], dependencies: portable.dependencies,
        materializationDigest: portable.materializationDigest,
        verification: {
          records: manyCandidates.slice(0, 9).map((skill) => ({
            name: skill.name, scope: 'project' as const, agents: ['Codex'],
          })),
          missing: [{ skill: 'result-skill-9' }],
        },
        warnings: [], failures: [{
          code: 'portableSkillsCliVerificationFailed', message: '缺少一个目标。', recovery: '重新运行安装。',
        }],
      };
    });
    const { value } = portableController({ captureEvidence, executeIntent });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    const operation = await value.buildPortableInstallReview();
    await value.executeOperation(operation.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();

    const frame = instance.lastFrame() ?? '';
    expect(frame).toMatch(/result-skill-9\s+确认缺失 · Agent：无法确认/u);
    expect(frame).toContain('第 1–1 项，共 10 项');
    expect(frame).toMatch(/范围\s+当前项目/u);
    expect(frame).toContain('安全恢复');
    if (size.rows === 18) {
      await focusPortableAction(instance, 'n 下一页');
      await send(instance, '\r');
      const middleFrame = instance.lastFrame() ?? '';
      expect(middleFrame).toContain('部分 Skills 未确认');
      expect(middleFrame).toContain('第 2–2 项，共 10 项');
      expect(middleFrame).toContain('安全恢复');
      expect(middleFrame).toContain('› n 下一页');
      instance.rerender(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
      await tick();
      expect(instance.lastFrame()).toMatch(/result-skill-0\s+已验证 · Agent：Codex/u);
      expect(instance.lastFrame()).toContain('› n 下一页');
      instance.rerender(<ConsoleAppV4 controller={value} size={size} />);
      await tick();
      expect(instance.lastFrame()).toContain('第 2–2 项，共 10 项');
      expect(instance.lastFrame()).toContain('› n 下一页');
    } else await send(instance, 'n');
    expect(`${frame}\n${instance.lastFrame() ?? ''}`).toMatch(/result-skill-0\s+已验证 · Agent：Codex/u);
    expect(frame).toContain('› 返回修改');
    expect(frame).toContain('↑↓ 移动');
    expect(frame).toContain('d 技术详情');
    expect(frame).toContain('? 帮助');
    expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);

    for (let page = 0; page < 12; page += 1) await send(instance, '\u001B[6~');
    expect(instance.lastFrame()).toContain('result-skill-8');
    expect(instance.lastFrame()).toContain('第 10–10 项，共 10 项');
    for (let page = 0; page < 12; page += 1) await send(instance, '\u001B[5~');

    for (const label of ['返回插件详情']) {
      await focusPortableAction(instance, label);
      const actionFrame = instance.lastFrame() ?? '';
      expect(actionFrame).toContain(`› ${label}`);
      expect(actionFrame).toContain('↑↓ 移动');
      expect(actionFrame.match(/›/gu)).toHaveLength(1);
      expect(actionFrame.split('\n').length).toBeLessThanOrEqual(size.rows);
    }

    await send(instance, '?');
    const helpFrame = instance.lastFrame() ?? '';
    expect(helpFrame).toContain('当前页快捷键');
    expect(helpFrame).toMatch(/d\s+打开技术详情/u);
    expect(helpFrame.split('\n').length).toBeLessThanOrEqual(size.rows);
    await send(instance, '?', 'd');
    if (size.rows === 18) {
      await focusPortableAction(instance, 'n 下一页');
      await send(instance, '\r');
      const technicalMiddle = instance.lastFrame() ?? '';
      expect(technicalMiddle).toContain('部分 Skills 未确认');
      expect(technicalMiddle).toContain('第 2–2 项，共 10 项');
      expect(technicalMiddle).toContain('安全恢复');
      expect(technicalMiddle).toContain('› n 下一页');
      instance.rerender(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
      await tick();
      expect(instance.lastFrame()).toContain('› n 下一页');
      instance.rerender(<ConsoleAppV4 controller={value} size={size} />);
      await tick();
      await send(instance, 'p');
    }
    for (const label of ['返回修改', '返回插件详情']) {
      await focusPortableAction(instance, label);
      const technicalFrame = instance.lastFrame() ?? '';
      expect(technicalFrame).toContain('技术详情');
      expect(technicalFrame).toContain('failure code');
      expect(technicalFrame).toContain('verification missing');
      expect(technicalFrame).toContain('Skills CLI version');
      expect(technicalFrame).toContain('materialization digest');
      expect(technicalFrame).toContain('elapsed');
      expect(technicalFrame).toMatch(/result-skill-9\s+确认缺失 · Agent：无法确认/u);
      expect(technicalFrame).toContain('第 1–1 项，共 10 项');
      expect(technicalFrame).toMatch(/范围\s+当前项目/u);
      expect(technicalFrame).toContain('安全恢复');
      expect(technicalFrame).toContain(`› ${label}`);
      expect(technicalFrame).toContain('↑↓ 移动');
      expect(technicalFrame.match(/›/gu)).toHaveLength(1);
      expect(technicalFrame.split('\n').length).toBeLessThanOrEqual(size.rows);
    }
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
  ])('keeps blocked Skill evidence, technical summary, and all recovery actions visible at $columns x $rows', async (size) => {
    const manyCandidates: PortableReview['selected'] = Array.from({ length: 10 }, (_, index) => ({
      ...candidates[0]!,
      name: `blocked-skill-${index}`,
      description: `Blocked skill ${index}`,
      filesDigest: `sha256:blocked-${index}`,
    }));
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const portable = { ...review(intent), selected: manyCandidates };
      return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
    });
    const { value } = portableController({
      captureEvidence,
      executeIntent: vi.fn().mockRejectedValue(
        Object.assign(new Error('安装证据已变化。'), { code: 'portableInstallBlocked' }),
      ),
    });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    const operation = await value.buildPortableInstallReview();
    await value.executeOperation(operation.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();

    const initialFrame = instance.lastFrame() ?? '';
    expect(initialFrame).toContain('d 技术详情');
    expect(initialFrame).toMatch(/\?\s+帮助/u);
    expect(initialFrame).toContain('› 返回修改');
    expect(initialFrame.match(/›/gu)).toHaveLength(1);
    expect(initialFrame.split('\n').length).toBeLessThanOrEqual(size.rows);

    await send(instance, '?');
    const helpFrame = instance.lastFrame() ?? '';
    expect(helpFrame).toContain('当前页快捷键');
    expect(helpFrame).toMatch(/d\s+打开技术详情/u);
    expect(helpFrame.split('\n').length).toBeLessThanOrEqual(size.rows);
    await send(instance, '?', 'd');
    for (const label of ['返回修改', '返回插件详情']) {
      await focusPortableAction(instance, label);
      const frame = instance.lastFrame() ?? '';
      expect(frame).toMatch(/blocked-skill-0\s+结果未知 · Agent：无法确认/u);
      expect(frame).toContain('第 1–1 项，共 10 项');
      expect(frame).toMatch(/范围\s+当前项目/u);
      expect(frame).toContain('技术详情');
      expect(frame).toContain('failure code');
      expect(frame).not.toContain('sha256:blocked');
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 移动');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
    }
  });

  it('shows differing scope variants and uses the selected user evidence in Review', async () => {
    const projectCandidate = {
      ...candidates[0]!, description: 'Project description.', filesDigest: 'sha256:project',
    };
    const userCandidate = {
      ...candidates[0]!, description: 'User description.', providerPluginId: 'official/content',
      providerDisplayName: 'Content', relation: 'direct' as const, dynamic: true,
      filesDigest: 'sha256:user',
    };
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const selected = intent.scope === 'project' ? [projectCandidate] : [userCandidate];
      const portable = { ...review(intent), selected };
      return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
    });
    const { value } = portableController({ captureEvidence });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    const stableLineCount = instance.lastFrame()!.split('\n').length;
    await send(instance, '\u001B[B');
    expect(instance.lastFrame()!.split('\n').length).toBe(stableLineCount);
    await send(instance, 'd');
    expect(instance.lastFrame()).toContain('范围变体');
    expect(instance.lastFrame()).toContain('当前项目：Project description. · Toolkit');
    expect(instance.lastFrame()).toContain('所有项目：User description. · Content · 按设置生成');

    value.setPortableScope('user');
    const operation = await value.buildPortableInstallReview();
    expect(operation.changes.find((change) => change.title === 'author-skill')).toMatchObject({
      pluginId: 'official/content',
      description: 'User description. · Content · 按设置生成',
    });
    const reviewInstance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await tick();
    expect(reviewInstance.lastFrame()).toContain('所有项目');
    expect(reviewInstance.lastFrame()).toContain('自动选择检测到的 Agent');
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
  ])('does not offer empty scope-variant details at $columns x $rows', async (size) => {
    const { value } = portableController();
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();

    const initialFrame = instance.lastFrame() ?? '';
    expect(initialFrame).not.toContain('0 个 Skill');
    expect(initialFrame).not.toContain('d 技术详情');
    expect(initialFrame.split('\n').length).toBeLessThanOrEqual(size.rows);

    await send(instance, '?');
    const helpFrame = instance.lastFrame() ?? '';
    expect(helpFrame).toContain('当前页快捷键');
    expect(helpFrame).not.toMatch(/d\s+打开技术详情/u);
    await send(instance, '?');
    expect(instance.lastFrame()).toBe(initialFrame);

    await send(instance, 'd');
    expect(instance.lastFrame()).toBe(initialFrame);
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
  ])('keeps Portable Review controls and bounded technical evidence visible at $columns x $rows', async (size) => {
    const manyCandidates: PortableReview['selected'] = [
      candidates[0]!,
      ...Array.from({ length: 9 }, (_, index) => ({
        ...candidates[0]!,
        name: `review-skill-${index}`,
        description: `Review description ${index}`,
        filesDigest: `sha256:review-${index}`,
      })),
    ];
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const portable = { ...review(intent), selected: manyCandidates };
      return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
    });
    const { value } = portableController({ captureEvidence });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    await value.buildPortableInstallReview();
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();

    const initialFrame = instance.lastFrame() ?? '';
    expect(initialFrame).toContain(`› ${value.snapshot.activeReview!.primaryLabel}`);
    expect(initialFrame).toContain('覆盖冲突 · ! 同名覆盖');
    expect(initialFrame).toContain('安装目标 · ~ Agent');
    expect(initialFrame).toContain('安装目标 · ~ 范围');
    expect(initialFrame.split('\n').length).toBeLessThanOrEqual(size.rows);

    await send(instance, 'd');
    for (const [index, label] of [value.snapshot.activeReview!.primaryLabel, '返回修改'].entries()) {
      if (index > 0) await send(instance, '\u001B[B');
      const frame = instance.lastFrame() ?? '';
      let allPages = frame;
      for (let page = 0; page < 15; page += 1) {
        await send(instance, '\u001B[6~');
        allPages += instance.lastFrame() ?? '';
      }
      expect(allPages).toContain('同名覆盖');
      expect(allPages).toContain('安装目标 · ~ Agent');
      expect(allPages).toContain('安装目标 · ~ 范围');
      expect(frame).toContain('Catalog 配置：config');
      expect(frame).toMatch(/另有 \d+ 项/u);
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('d 技术详情');
      expect(frame).toContain('? 帮助');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
      for (let page = 0; page < 15; page += 1) await send(instance, '\u001B[5~');
    }
  });

  it('refreshes both scope variants after stale evidence and preserves only existing selections', async () => {
    let revision = 1;
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const refreshedCandidates = revision === 1
        ? candidates.slice(0, 2)
        : [
            { ...candidates[0]!, description: `${intent.scope} refreshed ${revision}`, filesDigest: `sha256:${intent.scope}-${revision}` },
            { ...candidates[2]!, name: 'new-skill', description: 'New candidate.' },
          ];
      const selected = intent.selectedSkills.length === 0
        ? refreshedCandidates
        : refreshedCandidates.filter((candidate) => intent.selectedSkills.includes(candidate.name));
      const portable = { ...review(intent), selected, evidenceDigest: `evidence:${revision}:${intent.scope}` };
      return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
    });
    const { value } = portableController({
      captureEvidence,
      executeIntent: vi.fn().mockImplementation(() => {
        revision = 2;
        throw new TuiOperationBlockedError('operationReviewStale', 'operationReviewStale: changed');
      }),
    });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.togglePortableSkill('review-skill');
    value.setPortableAgentMode('explicit', ['codex']);
    value.setPortableScope('user');
    const operation = await value.buildPortableInstallReview();
    const result = await value.executeOperation(operation.reviewToken);

    expect(result.state).toBe('stale');
    expect(value.snapshot.portableDraft?.candidates).toMatchObject([
      {
        name: 'author-skill', selected: true,
        scopeDetails: {
          project: { description: 'project refreshed 2' },
          user: { description: 'user refreshed 2' },
        },
      },
      { name: 'new-skill', selected: false },
    ]);
    expect(value.snapshot.portableDraft).toMatchObject({
      agentMode: 'explicit', requestedAgents: ['codex'], scope: 'user',
    });
    await expect(value.executeOperation(operation.reviewToken)).resolves.toMatchObject({
      state: 'blocked', code: 'reviewTicketInvalid',
    });

    revision = 3;
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();
    await send(
      instance,
      '\u001B[B',
      '\r',
    );
    expect(value.snapshot.router.current.route.name).toBe('portableSkillSelect');
    expect(instance.lastFrame()).toContain('project refreshed 3');
    expect(value.snapshot.portableDraft).toMatchObject({
      agentMode: 'explicit', requestedAgents: ['codex'], scope: 'user',
    });
    await send(instance, 'd');
    expect(instance.lastFrame()).toContain('user refreshed 3');
  });

  it('invalidates an existing Portable ticket when a preserved recheck succeeds', async () => {
    let revision = 1;
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const available = revision === 1 ? candidates.slice(0, 2) : [candidates[0]!, {
        ...candidates[2]!, name: 'new-skill',
      }];
      const selected = intent.selectedSkills.length === 0
        ? available : available.filter((candidate) => intent.selectedSkills.includes(candidate.name));
      const portable = { ...review(intent), selected, evidenceDigest: `evidence:${revision}:${intent.scope}` };
      return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
    });
    const { value } = portableController({ captureEvidence });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.togglePortableSkill('review-skill');
    value.setPortableAgentMode('explicit', ['codex']);
    value.setPortableScope('user');
    const operation = await value.buildPortableInstallReview();

    revision = 2;
    await value.refreshPortableInstallDraft('official/toolkit');

    expect(value.snapshot.portableDraft).toMatchObject({
      candidates: [expect.objectContaining({ name: 'author-skill', selected: true }),
        expect.objectContaining({ name: 'new-skill', selected: false })],
      agentMode: 'explicit', requestedAgents: ['codex'], scope: 'user',
    });
    await expect(value.executeOperation(operation.reviewToken)).resolves.toMatchObject({
      state: 'blocked', code: 'reviewTicketInvalid',
    });
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
  ])('keeps dependency technical actions and Review confirmation visible at $columns x $rows', async (size) => {
    const loaded = status();
    const dependencies = Array.from({ length: 8 }, (_, index) => ({
      pluginId: `official/dependency-${index}`,
      displayName: `Dependency ${index}`,
      relation: index < 4 ? 'direct' as const : 'transitive' as const,
      depth: index < 4 ? 1 : 2,
      requiredBy: [{ pluginId: 'official/toolkit', displayName: 'Toolkit' }],
      placements: [],
      aggregateStatus: 'notInstalled' as const,
    }));
    loaded.dependencyOverviews = [{
      pluginId: 'official/toolkit',
      summary: { directCount: 4, transitiveCount: 4, totalCount: 8, readyCount: 0, missingCount: 8, issueCount: 0 },
      dependencies,
      dependents: [], blockers: [],
    }];
    const manyCandidates: PortableReview['selected'] = [
      ...candidates,
      ...dependencies.map((dependency, index) => ({
        name: `dependency-skill-${index}`,
        description: `Dependency skill ${index}`,
        providerPluginId: dependency.pluginId,
        providerDisplayName: dependency.displayName,
        relation: dependency.relation,
        dynamic: false,
        filesDigest: `sha256:${index}`,
      })),
    ];
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const portable = {
        ...review(intent),
        selected: intent.selectedSkills.length === 0
          ? manyCandidates
          : manyCandidates.filter((candidate) => intent.selectedSkills.includes(candidate.name)),
        collisions: manyCandidates.slice(0, 3).map((candidate) => ({
          name: candidate.name, requestedName: candidate.name, agents: ['codex'],
        })),
        dependencies: dependencies.map((dependency) => dependency.pluginId),
      };
      return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
    });
    const { value } = portableController({ loadStatus: vi.fn().mockResolvedValue(loaded), captureEvidence });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.push({ name: 'portableDependencies', pluginId: 'official/toolkit' });
    const dependencyInstance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();
    await send(dependencyInstance, '\u001B[B');
    expect(dependencyInstance.lastFrame()).toContain('› 技术详情');
    await send(dependencyInstance, '\r');
    let dependencyFrame = dependencyInstance.lastFrame() ?? '';
    expect(dependencyFrame).toContain('Dependency 0');
    expect(dependencyFrame).toContain('› 隐藏技术详情');
    expect(dependencyFrame).toContain('↑↓ 移动');
    expect(dependencyFrame.match(/›/gu)).toHaveLength(1);
    expect(dependencyFrame.split('\n').length).toBeLessThanOrEqual(size.rows);
    await send(dependencyInstance, 'n', 'n', 'n', 'n', 'n', 'n', 'n');
    expect(dependencyInstance.lastFrame()).toContain('Dependency 7');
    dependencyInstance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(value.snapshot.router.current.route.name).toBe('portableSkillSelect');
    expect(dependencyInstance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(size.rows);

    cleanup();
    expect(value.snapshot.portableDraft?.selectedCount).toBe(manyCandidates.length);
    await value.buildPortableInstallReview();
    const reviewInstance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();
    expect(reviewInstance.lastFrame()).toContain(`› ${value.snapshot.activeReview!.primaryLabel}`);
    expect(reviewInstance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect(reviewInstance.lastFrame()).toContain('同名覆');
  });

  it.each([
    { columns: 60, rows: 18, count: 100 },
    { columns: 80, rows: 24, count: 200 },
  ])('moves from a long $columns x $rows Skills list of $count items to its bottom tools with a reversible focus jump', async (size) => {
    const manyCandidates: PortableReview['selected'] = Array.from({ length: size.count }, (_, index) => ({
      name: `portable-skill-${index}`,
      description: `Portable description ${index}`,
      providerPluginId: index < 4 ? 'official/toolkit' : `official/provider-${Math.floor(index / 2)}`,
      providerDisplayName: index < 4 ? 'Toolkit' : `Provider ${Math.floor(index / 2)}`,
      relation: index < 4 ? 'requested' as const : 'direct' as const,
      dynamic: false,
      filesDigest: `sha256:${index}`,
    }));
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const scopedCandidates = manyCandidates.map((candidate) => ({
        ...candidate,
        description: `${candidate.description} ${intent.scope}`,
        filesDigest: `${candidate.filesDigest}-${intent.scope}`,
      }));
      const portable = {
        ...review(intent),
        selected: intent.selectedSkills.length === 0
          ? scopedCandidates
          : scopedCandidates.filter((candidate) => intent.selectedSkills.includes(candidate.name)),
      };
      return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
    });
    const { value } = portableController({ captureEvidence });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();

    const initialFrame = instance.lastFrame() ?? '';
    expect(initialFrame).toContain('d 技术详情');
    expect(initialFrame).toMatch(/\?\s+帮助/u);
    expect(initialFrame).toContain('› [x] portable-skill-0');
    expect(initialFrame).toContain('Portable description 0');
    expect(initialFrame).toContain('Toolkit · 当前插件');
    expect(initialFrame.match(/›/gu)).toHaveLength(1);
    expect(initialFrame.split('\n').length).toBeLessThanOrEqual(size.rows);

    await send(instance, ...Array.from({ length: Math.floor(size.count / 2) }, () => '\u001B[B'));
    await send(instance, 'a');
    expect(instance.lastFrame()).toContain(`› 继续（${size.count}） [c]`);
    await send(instance, 'a');
    expect(instance.lastFrame()).toContain(`› [x] portable-skill-${Math.floor(size.count / 2)}`);
    await send(instance, 'a');
    expect(value.snapshot.portableDraft?.selectedCount).toBe(size.count);
    await send(instance, '\u001B[B');
    expect(instance.lastFrame()).toContain('› 选择工具');
    await send(instance, '\r');
    expect(instance.lastFrame()).toContain('› 全选当前结果');
    expect(instance.lastFrame()).toContain(`只看已选（${size.count}）`);
    expect(instance.lastFrame()).toContain('清空选择');
    expect(instance.lastFrame()?.split('\n').length).toBeLessThanOrEqual(size.rows);
    await send(instance, 'b');
    expect(instance.lastFrame()).toContain('portable-skill-0');
    expect(value.snapshot.portableDraft?.selectedCount).toBe(size.count);
  }, 30_000);

  it('validates explicit Agent IDs and preserves the draft when the terminal is too small', async () => {
    const { value } = portableController();
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.push({ name: 'portableAgentInput', pluginId: 'official/toolkit' });
    const inputInstance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await tick();
    expect(inputInstance.lastFrame()).not.toContain('d 技术详情');
    await send(inputInstance, '\r');
    expect(inputInstance.lastFrame()).toContain('Agent 选择必须包含 1 到 32 项');
    await send(inputInstance, 'd cursor codex cursor', '\r');
    expect(value.snapshot.portableDraft?.requestedAgents).toEqual(['d', 'cursor', 'codex']);
    expect(value.snapshot.router.current.route.name).toBe('portableScope');
    expect(inputInstance.lastFrame()).toContain('● 当前项目');
    await send(inputInstance, '\r');
    expect(value.snapshot.router.current.route.name).toBe('portableScope');
    await send(inputInstance, '\u001B[B', '\r');
    expect(value.snapshot.portableDraft?.scope).toBe('user');
    expect(value.snapshot.router.current.route.name).toBe('portableScope');
    expect(inputInstance.lastFrame()).toContain('● 所有项目');
    expect(inputInstance.lastFrame()).toContain('› ● 所有项目');
    await send(inputInstance, '\u001B[B', '\r');
    await tick();
    expect(value.snapshot.router.current.route.name).toBe('review');
    expect(inputInstance.lastFrame()).toContain('cursor、codex');
    expect(inputInstance.lastFrame()).toContain('所有项目');

    cleanup();
    value.replace({ name: 'portableSkillSelect', pluginId: 'official/toolkit' });
    const selected = value.snapshot.portableDraft?.selectedCount;
    const small = render(<ConsoleAppV4 controller={value} size={{ columns: 59, rows: 17 }} />);
    await tick();
    expect(small.lastFrame()).toContain('至少 60 列 × 18 行');
    await send(small, ' ', '\r');
    expect(value.snapshot.portableDraft?.selectedCount).toBe(selected);
    expect(value.snapshot.router.current.route.name).toBe('portableSkillSelect');
  });

  it.each([
    ['failed', 'partial', 'portableSkillsCliInstallFailed'],
    ['partial', 'partial', undefined],
  ] as const)('projects a %s Skills CLI receipt to the distinct TUI result', async (statusValue, state, code) => {
    const executeIntent = vi.fn(async (intent: OperationIntent): Promise<PortableInstallReceipt> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const portable = review(intent);
      return {
        receiptSchemaVersion: 5, command: 'skill:install', ok: false, status: statusValue,
        plugin: { id: intent.pluginId }, scope: intent.scope, selectedSkills: portable.selected,
        requestedSkills: intent.selectedSkills, agentMode: portable.agentMode, requestedAgents: portable.requestedAgents,
        skillsCliVersion: portable.skillsCliVersion, collisions: [], dependencies: portable.dependencies,
        materializationDigest: portable.materializationDigest,
        verification: { records: [], missing: statusValue === 'partial' ? portable.selected.map((skill) => ({ skill: skill.name })) : [] },
        warnings: [], failures: [{
          code: statusValue === 'partial' ? 'portableSkillsCliVerificationFailed' : 'portableSkillsCliInstallFailed',
          message: statusValue === 'partial' ? '验证缺少目标。' : '安装失败。', recovery: '重试。',
        }],
      };
    });
    const { value } = portableController({ executeIntent });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    const operation = await value.buildPortableInstallReview();
    const result = await value.executeOperation(operation.reviewToken);
    expect(result.state).toBe(state);
    if (code) expect(result).toMatchObject({ summary: { portable: { failureCode: code } } });
    if (statusValue === 'partial') {
      const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
      await tick();
      expect(instance.lastFrame()).toMatch(/author-skill\s+确认缺失 · Agent：无法确认/u);
      expect(instance.lastFrame()).not.toContain('sha256:materialized');
      expect(instance.lastFrame()).not.toContain('1.5.23');
    }
  });

  it.each([
    ['automatic verification failure', 'automatic', ['portableSkillsCliVerificationFailed']],
    ['explicit verification failure', 'explicit', ['portableSkillsCliVerificationFailed']],
    ['add and verification failure', 'automatic', ['portableSkillsCliInstallFailed', 'portableSkillsCliVerificationFailed']],
  ] as const)('renders unknown verification for %s', async (_label, agentMode, failureCodes) => {
    const executeIntent = vi.fn(async (intent: OperationIntent): Promise<PortableInstallReceipt> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const portable = review(intent);
      return {
        receiptSchemaVersion: 5, command: 'skill:install', ok: false, status: 'partial',
        plugin: { id: intent.pluginId }, scope: intent.scope, selectedSkills: portable.selected,
        requestedSkills: intent.selectedSkills, agentMode: portable.agentMode,
        requestedAgents: portable.requestedAgents, skillsCliVersion: portable.skillsCliVersion,
        collisions: [], dependencies: portable.dependencies,
        materializationDigest: portable.materializationDigest,
        verification: { records: [], missing: [] }, warnings: [],
        failures: failureCodes.map((code) => ({ code, message: '无法确认。', recovery: '重试。' })),
      };
    });
    const { value } = portableController({ executeIntent });
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/toolkit' });
    await value.preparePortableInstall('official/toolkit');
    if (agentMode === 'explicit') value.setPortableAgentMode('explicit', ['codex', 'cursor']);
    const operation = await value.buildPortableInstallReview();
    const result = await value.executeOperation(operation.reviewToken);
    expect(result).toMatchObject({ summary: { portable: { verificationUnknown: true } } });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();
    expect(instance.lastFrame()).toContain('结果未知');
    expect(instance.lastFrame()).not.toContain('验证缺项：0');
  });

  it('rechecks an unknown result without running Skills add again', async () => {
    const executeIntent = vi.fn(async (intent: OperationIntent): Promise<PortableInstallReceipt> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const portable = review(intent);
      return {
        receiptSchemaVersion: 5, command: 'skill:install', ok: false, status: 'partial',
        plugin: { id: intent.pluginId }, scope: intent.scope, selectedSkills: portable.selected,
        requestedSkills: intent.selectedSkills, agentMode: portable.agentMode,
        requestedAgents: portable.requestedAgents, skillsCliVersion: portable.skillsCliVersion,
        collisions: [], dependencies: portable.dependencies,
        materializationDigest: portable.materializationDigest,
        verification: {
          records: [], missing: [],
          unknown: portable.selected.map((skill) => ({ skill: skill.name, agent: 'codex' })),
        },
        warnings: [], failures: [{
          code: 'portableSkillsCliVerificationFailed', message: '无法确认。', recovery: '重新检查。',
        }],
      };
    });
    const recheckGate = deferred<PortableInstallReceipt>();
    let receiptForRecheck: PortableInstallReceipt | undefined;
    const recheckPortableInstall = vi.fn((receipt: PortableInstallReceipt) => {
      receiptForRecheck = receipt;
      return recheckGate.promise;
    });
    const { value } = portableController({ executeIntent, recheckPortableInstall });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/toolkit' });
    await value.preparePortableInstall('official/toolkit');
    const operation = await value.buildPortableInstallReview();
    await value.executeOperation(operation.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    expect(instance.lastFrame()).toContain('结果未知');
    expect(instance.lastFrame()).toContain('› 重新检查结果');
    expect(instance.lastFrame()).not.toContain('仅重试确认缺失的目标');
    await send(instance, '\r');
    await tick();
    expect(recheckPortableInstall).toHaveBeenCalledTimes(1);
    expect(executeIntent).toHaveBeenCalledTimes(1);
    expect(instance.lastFrame()).toContain('正在重新检查结果');
    expect(instance.lastFrame()).toContain('只读取 Skills CLI 当前状态，不执行安装');
    expect(instance.lastFrame()).toContain('结果未知');

    recheckGate.resolve({
      ...receiptForRecheck!,
      ok: true,
      status: 'succeeded',
      verification: {
        records: receiptForRecheck!.selectedSkills.map((skill) => ({
          name: skill.name, scope: receiptForRecheck!.scope, agents: ['codex'],
        })),
        missing: [],
        unknown: [],
      },
      warnings: [],
      failures: [],
    });
    await tick(2);
    expect(value.snapshot.result?.state).toBe('succeeded');
    expect(instance.lastFrame()).toContain('通用 Skills 已安装');
  });

  it('shows separate verified and missing Agent rows for one explicitly installed Skill', async () => {
    const executeIntent = vi.fn(async (intent: OperationIntent): Promise<PortableInstallReceipt> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const portable = review(intent);
      return {
        receiptSchemaVersion: 5, command: 'skill:install', ok: false, status: 'partial',
        plugin: { id: intent.pluginId }, scope: intent.scope, selectedSkills: portable.selected,
        requestedSkills: intent.selectedSkills, agentMode: 'explicit', requestedAgents: ['codex', 'cursor'],
        skillsCliVersion: portable.skillsCliVersion, collisions: [], dependencies: portable.dependencies,
        materializationDigest: portable.materializationDigest,
        verification: {
          records: [{ name: 'review-skill', scope: intent.scope, agents: ['codex'] }],
          missing: [{ skill: 'review-skill', agent: 'cursor' }], unknown: [],
        },
        warnings: [], failures: [{
          code: 'portableSkillsCliVerificationFailed', message: '一个目标缺失。', recovery: '精确重试。',
        }],
      };
    });
    const { value } = portableController({ executeIntent });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.togglePortableSkill('author-skill');
    value.togglePortableSkill('content-skill');
    value.setPortableAgentMode('explicit', ['codex', 'cursor']);
    const operation = await value.buildPortableInstallReview();
    await value.executeOperation(operation.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    let frames = instance.lastFrame() ?? '';
    await send(instance, 'n');
    frames += `\n${instance.lastFrame() ?? ''}`;
    expect(frames.match(/review-skill/gu)).toHaveLength(2);
    expect(frames).toMatch(/review-skill\s+确认缺失 · Agent：cursor/u);
    expect(frames).toMatch(/review-skill\s+已验证 · Agent：codex/u);
  });

  it.each([
    { size: { columns: 60, rows: 18 }, agents: ['agent-a', 'agent-b', 'agent-c'], technical: false },
    { size: { columns: 80, rows: 24 }, agents: ['agent-a', 'agent-b'], technical: true },
  ])('reaches every Skill and Agent result row from the shared result pagination at $size.columns x $size.rows', async ({ size, agents, technical }) => {
    const executeIntent = vi.fn(async (intent: OperationIntent): Promise<PortableInstallReceipt> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const portable = review(intent);
      const selected = portable.selected.filter((candidate) => candidate.name === 'review-skill');
      return {
        receiptSchemaVersion: 5, command: 'skill:install', ok: true, status: 'succeeded',
        plugin: { id: intent.pluginId }, scope: intent.scope, selectedSkills: selected,
        requestedSkills: ['review-skill'], agentMode: 'explicit', requestedAgents: agents,
        skillsCliVersion: portable.skillsCliVersion, collisions: [], dependencies: portable.dependencies,
        materializationDigest: portable.materializationDigest,
        verification: {
          records: [{ name: 'review-skill', scope: intent.scope, agents }],
          missing: [], unknown: [],
        },
        warnings: [], failures: [],
      };
    });
    const { value } = portableController({ executeIntent });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.togglePortableSkill('author-skill');
    value.togglePortableSkill('content-skill');
    value.setPortableAgentMode('explicit', agents);
    const operation = await value.buildPortableInstallReview();
    await value.executeOperation(operation.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();
    if (technical) await send(instance, 'd');

    let frames = instance.lastFrame() ?? '';
    expect(frames).toContain('p 上一页');
    expect(frames).toContain('n 下一页');
    for (let page = 0; page < agents.length; page += 1) {
      await send(instance, 'n');
      frames += `\n${instance.lastFrame() ?? ''}`;
    }
    for (const agent of agents) {
      expect(frames).toMatch(new RegExp(`review-skill\\s+已验证 · Agent：${agent}`, 'u'));
    }
    expect(instance.lastFrame()).toContain(`已验证 · Agent：${agents.at(-1)}`);
    expect(instance.lastFrame()).not.toContain('另有 1 个 Skills');
    if (!technical) {
      await send(instance, 'd');
      expect(instance.lastFrame()).toContain(`已验证 · Agent：${agents.at(-1)}`);
      expect(instance.lastFrame()).toMatch(/范围\s+当前项目/u);
      expect(instance.lastFrame()).toContain('verification missing');
      expect(instance.lastFrame()).toContain('Skills CLI version');
      expect(instance.lastFrame()).toContain('materialization digest');
      instance.rerender(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
      await tick();
      expect(instance.lastFrame()).toContain(`已验证 · Agent：${agents.at(-1)}`);
    }
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
  ])('rebuilds complete long result fields from focused detail pages at $columns x $rows', async (size) => {
    const skills = [
      'isolating-work-with-git-branches',
      'isolating-work-with-git-worktrees',
    ];
    const selected = skills.map((name, index) => ({
      ...candidates[0]!, name, description: `Long result ${index}`,
      filesDigest: `sha256:long-result-${index}`,
    }));
    const longAgent = `github-copilot-${'a'.repeat(113)}`;
    const digest = `sha256:${'d'.repeat(64)}`;
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const portable = { ...review(intent), selected };
      return { catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest }, portable };
    });
    const executeIntent = vi.fn(async (intent: OperationIntent): Promise<PortableInstallReceipt> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const portable = { ...review(intent), selected };
      return {
        receiptSchemaVersion: 5, command: 'skill:install', ok: true, status: 'succeeded',
        plugin: { id: intent.pluginId }, scope: intent.scope, selectedSkills: selected,
        requestedSkills: skills, agentMode: portable.agentMode,
        requestedAgents: portable.requestedAgents, skillsCliVersion: '1.5.23',
        collisions: [], dependencies: portable.dependencies, materializationDigest: digest,
        verification: {
          records: skills.map((name) => ({ name, scope: intent.scope, agents: [longAgent] })),
          missing: [], unknown: [],
        },
        warnings: [], failures: [],
      };
    });
    const { value } = portableController({ captureEvidence, executeIntent });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    const operation = await value.buildPortableInstallReview();
    await value.executeOperation(operation.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();

    const readDetail = async (): Promise<string[]> => {
      await focusPortableAction(instance, '查看当前结果完整字段');
      await send(instance, '\r');
      const frames: string[] = [];
      for (let page = 0; page < 20; page += 1) {
        const frame = instance.lastFrame() ?? '';
        frames.push(frame);
        if (frame.includes('已在最后一页')) break;
        await send(instance, 'n');
      }
      return frames;
    };
    const rebuild = (frames: readonly string[], label: string): string => {
      const parts = new Map<number, string>();
      let total = 0;
      for (const line of frames.flatMap((frame) => frame.split('\n'))) {
        const marker = `${label} `;
        const value = line.trim();
        if (!value.startsWith(marker)) continue;
        const match = value.slice(marker.length).match(/^(\d+)\/(\d+) · (.*)$/u);
        if (!match) continue;
        parts.set(Number(match[1]), match[3] ?? '');
        total = Number(match[2]);
      }
      return Array.from({ length: total }, (_, index) => parts.get(index + 1) ?? '').join('');
    };

    expect(instance.lastFrame()).toContain('已验证 · Agent：');
    let frames = await readDetail();
    expect(rebuild(frames, 'Skill')).toBe(skills[0]);
    expect(rebuild(frames, 'Agent')).toBe(longAgent);
    expect(rebuild(frames, 'materialization digest')).toBe(digest);
    expect(frames.join('\n')).toContain('状态 · 已验证');
    instance.stdin.write('\u001B');
    await new Promise((resolve) => setTimeout(resolve, 550));
    await tick();
    expect(instance.lastFrame()).toContain('› 查看当前结果完整字段');
    await send(instance, 'n', 'd');
    expect(instance.lastFrame()).toContain('已验证 · Agent：');
    frames = await readDetail();
    expect(rebuild(frames, 'Skill')).toBe(skills[1]);
    expect(rebuild(frames, 'Agent')).toBe(longAgent);
    expect(rebuild(frames, 'materialization digest')).toBe(digest);
    instance.rerender(<ConsoleAppV4 controller={value} size={
      size.rows === 18 ? { columns: 80, rows: 24 } : { columns: 60, rows: 18 }
    } />);
    await tick();
    expect(instance.lastFrame()).toContain('当前结果完整字段');
    expect((instance.lastFrame() ?? '').split('\n').length).toBeLessThanOrEqual(size.rows === 18 ? 24 : 18);
  });

  it('shows an Agent-less automatic unknown as unknown without a success row', async () => {
    const executeIntent = vi.fn(async (intent: OperationIntent): Promise<PortableInstallReceipt> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const portable = review(intent);
      return {
        receiptSchemaVersion: 5, command: 'skill:install', ok: false, status: 'partial',
        plugin: { id: intent.pluginId }, scope: intent.scope, selectedSkills: portable.selected,
        requestedSkills: intent.selectedSkills, agentMode: 'automatic', requestedAgents: [],
        skillsCliVersion: portable.skillsCliVersion, collisions: [], dependencies: portable.dependencies,
        materializationDigest: portable.materializationDigest,
        verification: { records: [], missing: [], unknown: [{ skill: 'review-skill' }] },
        warnings: [], failures: [{
          code: 'portableSkillsCliVerificationFailed', message: '目标未知。', recovery: '重新检查。',
        }],
      };
    });
    const { value } = portableController({ executeIntent });
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    value.togglePortableSkill('author-skill');
    value.togglePortableSkill('content-skill');
    const operation = await value.buildPortableInstallReview();
    await value.executeOperation(operation.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 60, rows: 18 }} />);
    await tick();

    expect(instance.lastFrame()).toMatch(/review-skill\s+结果未知 · Agent：无法确认/u);
    expect(instance.lastFrame()).not.toContain('已验证');
    expect(instance.lastFrame()).not.toContain('通用 Skills 已安装');
  });

  it('prepares a new Review for only the exact missing Skill and Agent pair', async () => {
    const captureEvidence = vi.fn(async (intent: OperationIntent): Promise<OperationEvidence> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const portable = review(intent);
      const retryPairs = intent.retry?.receipt.verification.missing ?? [];
      return {
        catalog: { configDigest: portable.configDigest, compositeDigest: portable.evidenceDigest },
        portable: intent.retry ? {
          ...portable,
          baseEvidenceDigest: 'sha256:base',
          retryPairs,
          targetGroups: [{ agent: 'cursor', skills: ['review-skill'] }],
        } : portable,
      };
    });
    const executeIntent = vi.fn(async (intent: OperationIntent): Promise<PortableInstallReceipt> => {
      if (intent.kind !== 'portableInstall') throw new Error('unexpected intent');
      const portable = review(intent);
      return {
        receiptSchemaVersion: 5, command: 'skill:install', ok: false, status: 'partial',
        plugin: { id: intent.pluginId }, scope: intent.scope, selectedSkills: portable.selected,
        requestedSkills: intent.selectedSkills, agentMode: portable.agentMode,
        requestedAgents: portable.requestedAgents, skillsCliVersion: portable.skillsCliVersion,
        collisions: [], dependencies: portable.dependencies,
        materializationDigest: portable.materializationDigest,
        verification: {
          records: [{ name: 'author-skill', scope: intent.scope, agents: ['codex'] }],
          missing: [{ skill: 'review-skill', agent: 'cursor' }],
          unknown: [],
        },
        warnings: [], failures: [{
          code: 'portableSkillsCliVerificationFailed', message: '缺少一个目标。', recovery: '精确重试。',
        }],
      };
    });
    const { value } = portableController({ captureEvidence, executeIntent });
    await value.load();
    value.push({ name: 'pluginDetail', pluginId: 'official/toolkit' });
    await value.preparePortableInstall('official/toolkit');
    value.setPortableAgentMode('explicit', ['codex', 'cursor']);
    const operation = await value.buildPortableInstallReview();
    await value.executeOperation(operation.reviewToken);
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    expect(instance.lastFrame()).toContain('› 仅重试确认缺失的目标');
    expect(instance.lastFrame()).not.toMatch(/› 重试$/mu);
    await send(instance, '\r');
    await vi.waitFor(() => expect(value.snapshot.router.current.route.name).toBe('review'));
    expect(captureEvidence).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'portableInstall',
      selectedSkills: ['review-skill'],
      requestedAgents: ['cursor'],
      retry: expect.objectContaining({ receipt: expect.any(Object) }),
    }), expect.any(AbortSignal));
    expect(instance.lastFrame()).toContain('精确重试 · cursor');
    expect(instance.lastFrame()).toContain('review-skill');
  });
});
