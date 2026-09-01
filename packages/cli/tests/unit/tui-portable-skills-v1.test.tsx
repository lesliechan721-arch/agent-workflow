import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PortableReview, PortableInstallReceipt } from '../../src/portable/commands.js';
import type { StatusV7Payload, StatusV7PluginSummary } from '../../src/commands/status-v6.js';
import { createRebuildProgressFeed } from '../../src/output/rebuild-progress.js';
import { ConsoleAppV4 } from '../../src/tui/console-app-v4.js';
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
  const summaries: StatusV7PluginSummary[] = [{
    pluginName: 'toolkit', pluginId: 'official/toolkit', displayName: 'Toolkit', description: '工具集',
    version: '1.0.0', supportedTargets: { codex: ['project'], claude: ['project'] }, configFieldCount: 0,
    dependencyDirectCount: 1, dependencyTotalCount: 1, dependencyIssueCount: 0,
  }, {
    pluginName: 'content', pluginId: 'official/content', displayName: 'Content', description: '内容工具',
    version: '1.0.0', supportedTargets: { codex: ['project'], claude: ['project'] }, configFieldCount: 0,
  }];
  const payload: StatusV7Payload = {
    schemaVersion: 7,
    catalog: { primarySourceId: 'official', configDigest: 'sha256:config', compositeDigest: 'sha256:catalog', sources: [{ id: 'official', identity: 'identity:official', type: 'path', primary: true, requestedRef: 'path', freshness: 'active' }] },
    filters: { plugins: [], platform: 'both', cwd: '/workspace' },
    targets: summaries.flatMap((summary) => (['codex', 'claude'] as const).map((platform) => ({
      pluginName: summary.pluginName, pluginId: summary.pluginId, sourceId: 'official', sourceIdentity: 'identity:official', version: '1.0.0', platform, scope: 'project' as const, cwd: '/workspace', state: 'absent' as const, components: [], reasons: [], recoveryActions: [],
    }))),
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
      materializationDigest: portable.materializationDigest, verification: { records: [], missing: [] }, warnings: [], failures: [],
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((settle) => { resolve = settle; }), resolve };
}

describe('Portable Skills TUI V1', () => {
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

    await send(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'portableSkillSelect', pluginId: 'official/toolkit',
    });
    await send(instance, 'b');
    expect(value.snapshot.router.current.route).toEqual({ name: 'pluginDetail', pluginId: 'official/toolkit' });
  });

  it.each(['blocked', 'partial'] as const)(
    'clears a %s result before retrying and does not expose it on Back',
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

      await send(instance, '\u001B[B', '\r');
      expect(value.snapshot.router.current.route.name).toBe('review');
      value.back();
      expect(value.snapshot.router.current.route).toEqual({
        name: 'portableSkillSelect', pluginId: 'official/toolkit',
      });
      value.resetPortableFlowToPreview('official/toolkit');
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
    await send(instance, '\u001B[B');
    await send(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual({
      name: 'portableSkillSelect', pluginId: 'official/toolkit',
    });
  });

  it.each([
    {
      label: 'blocked preview flow through Skill selection',
      origin: { name: 'pluginPreview', pluginId: 'official/toolkit' } as const,
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
    if (origin.name === 'pluginDetail') value.push(previous);
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
    await send(instance, '\r');
    expect(value.snapshot.router.current.route).toEqual(origin);
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
    expect(instance.lastFrame()).toContain('Review 已过期，写入未开始');
    expect(instance.lastFrame()).not.toContain('通用 Skills 已安装');
    expect(instance.lastFrame()).not.toContain('已通过安装验证');
    for (const label of ['返回修改', '重试', '返回插件详情']) {
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 移动');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(18);
      await send(instance, '\u001B[B');
    }
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

  it('keeps Space as the Portable Skill toggle', async () => {
    const { value } = portableController();
    await value.load();
    await value.preparePortableInstall('official/toolkit');
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();

    expect(value.snapshot.portableDraft?.selectedCount).toBe(3);
    await send(instance, ' ');
    expect(value.snapshot.portableDraft?.selectedCount).toBe(2);
    expect(instance.lastFrame()).toContain('◇ author-skill');
  });

  it('advertises only the manifest capability before entry, then selects candidates and executes the reviewed subset', async () => {
    const { value, capture } = portableController();
    await value.load();
    value.push({ name: 'pluginPreview', pluginId: 'official/toolkit' });
    const instance = render(<ConsoleAppV4 controller={value} size={{ columns: 80, rows: 24 }} />);
    await tick();
    expect(instance.lastFrame()).toContain('可安装 · 1 个插件依赖');
    expect(instance.lastFrame()).toContain('选择 Skill 和 Agent 后交给 Skills CLI 安装');
    expect(instance.lastFrame()).not.toContain('3 个候选');
    expect(capture).not.toHaveBeenCalled();

    await send(instance, '\u001B[B', '\r');
    expect(value.snapshot.router.current.route.name).toBe('portableSkillSelect');
    expect(instance.lastFrame()).toContain('3 / 3 已选择');
    expect(instance.lastFrame()).toContain('Content');
    expect(instance.lastFrame()).toContain('当前插件');
    expect(instance.lastFrame()).toContain('直接依赖插件');

    await send(instance, ' ', '\u001B[B', ' ', '\u001B[B', ' ');
    expect(value.snapshot.portableDraft?.selectedCount).toBe(0);
    expect(instance.lastFrame()).toContain('至少选择一个 Skill');
    await send(instance, 'a', ' ');
    expect(value.snapshot.portableDraft?.selectedCount).toBe(2);
    await send(instance, '\u001B[B', '\r', '\r', '\r', '\u001B[B', '\u001B[B', '\r');

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
    ['portableSkillsCliMissing', 'U10', '查看安装说明'],
    ['portableSkillsCliIncompatible', 'U10', '查看安装说明'],
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
    expect(value.snapshot.router.current.route.name).toBe('home');
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
    expect(value.snapshot.router.current.route.name).toBe('pluginPreview');
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
      ? { configWrite: 'succeeded' }
      : (() => { throw new Error('unexpected intent'); })());
    const { value } = portableController({ captureEvidence, executeIntent });
    await value.load();
    value.push({
      name: 'portableBlocker', pluginId: 'official/toolkit', code: 'requiredConfigMissing',
      diagnosticCode: 'requiredConfigMissing',
    });
    value.replace({ name: 'configLayer', pluginId: 'official/toolkit' });
    const operation = await value.buildOperationReview({
      kind: 'configSave', pluginId: 'official/toolkit', scope: 'user', projectLayer: 'shared',
      updates: { token: 'private' }, privateKeys: ['token'],
    });

    const result = await value.executeOperation(operation.reviewToken);

    expect(result.state).toBe('succeeded');
    expect(value.snapshot.router.current.route.name).toBe('portableSkillSelect');
    expect(value.snapshot.portableDraft?.selectedCount).toBe(3);
    expect(captureEvidence.mock.calls.filter(([intent]) => intent.kind === 'portableInstall')).toHaveLength(2);
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
    expect(frame).toContain('2 个 provider 提供 3 个 Skills');
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
    for (const skill of candidates.map((candidate) => candidate.name)) {
      expect(frame).toMatch(new RegExp(`${skill}\\s+已安装`, 'u'));
    }
    expect(frame.match(/返回插件预览/gu)).toHaveLength(1);
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
          records: [{ name: 'result-skill-0', scope: 'project', agents: ['Codex'] }],
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
    expect(frame).toMatch(/result-skill-9\s+未完成 · 缺少目标/u);
    expect(frame).toMatch(/result-skill-0\s+已安装/u);
    expect(frame).toContain(`另有 ${size.rows === 18 ? 8 : 4} 个 Skills`);
    expect(frame).toContain('安全恢复');
    expect(frame).toContain('› 返回修改');
    expect(frame).toContain('↑↓ 移动');
    expect(frame).toContain('d 技术详情');
    expect(frame).toContain('? 帮助');
    expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);

    for (const label of ['重试', '返回插件预览']) {
      await send(instance, '\u001B[B');
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
    await send(instance, '?', 'd', '\u001B[A', '\u001B[A');
    for (const [index, label] of ['返回修改', '重试', '返回插件预览'].entries()) {
      if (index > 0) await send(instance, '\u001B[B');
      const technicalFrame = instance.lastFrame() ?? '';
      expect(technicalFrame).toContain('技术详情');
      expect(technicalFrame).toContain('failure code');
      expect(technicalFrame).toMatch(/result-skill-9\s+未完成 · 缺少目标/u);
      expect(technicalFrame).toContain('另有 9 个 Skills');
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
    expect(initialFrame).toContain('? 帮助');
    expect(initialFrame).toContain('› 返回修改');
    expect(initialFrame.match(/›/gu)).toHaveLength(1);
    expect(initialFrame.split('\n').length).toBeLessThanOrEqual(size.rows);

    await send(instance, '?');
    const helpFrame = instance.lastFrame() ?? '';
    expect(helpFrame).toContain('当前页快捷键');
    expect(helpFrame).toMatch(/d\s+打开技术详情/u);
    expect(helpFrame.split('\n').length).toBeLessThanOrEqual(size.rows);
    await send(instance, '?', 'd');
    for (const [index, label] of ['返回修改', '重试', '返回插件预览'].entries()) {
      if (index > 0) await send(instance, '\u001B[B');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toMatch(/blocked-skill-0\s+结果未知/u);
      expect(frame).toContain('另有 9 个 Skills');
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

    await send(instance, 'd');
    for (const [index, label] of [value.snapshot.activeReview!.primaryLabel, '返回修改'].entries()) {
      if (index > 0) await send(instance, '\u001B[B');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain('同名覆盖');
      expect(frame).toContain('安装目标 · ~ Agent');
      expect(frame).toContain('安装目标 · ~ 范围');
      expect(frame).toContain('Catalog 配置：config');
      expect(frame).toMatch(/另有 \d+ 项/u);
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('d 技术详情');
      expect(frame).toContain('? 帮助');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
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
    await send(instance, 'd');
    expect(instance.lastFrame()).toContain('user refreshed 3');
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
    expect(dependencyFrame).toContain('另有 7 个依赖');
    expect(dependencyFrame).toContain('› 隐藏技术详情');
    expect(dependencyFrame).toContain('↑↓ 移动');
    expect(dependencyFrame.match(/›/gu)).toHaveLength(1);
    expect(dependencyFrame.split('\n').length).toBeLessThanOrEqual(size.rows);
    await send(dependencyInstance, '\u001B[A');
    dependencyFrame = dependencyInstance.lastFrame() ?? '';
    expect(dependencyFrame).toContain('› 返回 Skill 选择');
    expect(dependencyFrame).toContain('↑↓ 移动');
    expect(dependencyFrame.match(/›/gu)).toHaveLength(1);
    expect(dependencyFrame.split('\n').length).toBeLessThanOrEqual(size.rows);

    cleanup();
    value.back();
    await value.buildPortableInstallReview();
    const reviewInstance = render(<ConsoleAppV4 controller={value} size={size} />);
    await tick();
    expect(reviewInstance.lastFrame()).toContain(`› ${value.snapshot.activeReview!.primaryLabel}`);
    expect(reviewInstance.lastFrame()?.match(/›/gu)).toHaveLength(1);
    expect(reviewInstance.lastFrame()).toContain('覆盖冲突');
  });

  it.each([
    { columns: 60, rows: 18 },
    { columns: 80, rows: 24 },
    { columns: 80, rows: 40 },
  ])('keeps the focused portable Skill and Continue visible at $columns x $rows', async (size) => {
    const manyCandidates: PortableReview['selected'] = Array.from({ length: 10 }, (_, index) => ({
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
    expect(initialFrame).toContain('? 帮助');
    expect(initialFrame).toContain('› ◆ portable-skill-0');
    expect(initialFrame.match(/›/gu)).toHaveLength(1);
    expect(initialFrame.split('\n').length).toBeLessThanOrEqual(size.rows);

    for (const [index, label] of [
      ...manyCandidates.map((candidate) => `◆ ${candidate.name}`),
      '继续',
      '查看依赖关系',
    ].entries()) {
      if (index > 0) await send(instance, '\u001B[B');
      const frame = instance.lastFrame() ?? '';
      expect(frame).toContain(`› ${label}`);
      expect(frame).toContain('↑↓ 移动');
      expect(frame.match(/›/gu)).toHaveLength(1);
      expect(frame.split('\n').length).toBeLessThanOrEqual(size.rows);
    }

    await send(instance, '?');
    const helpFrame = instance.lastFrame() ?? '';
    expect(helpFrame).toContain('当前页快捷键');
    expect(helpFrame).toContain('Space  切换当前 Skill');
    expect(helpFrame).toContain('a  全选 Skills');
    expect(helpFrame).toMatch(/d\s+打开技术详情/u);
    expect(helpFrame.split('\n').length).toBeLessThanOrEqual(size.rows);
    await send(instance, '?', 'd');
    const technicalFrame = instance.lastFrame() ?? '';
    expect(technicalFrame).toContain('范围变体');
    expect(technicalFrame).toContain('当前项目：');
    expect(technicalFrame).toContain('所有项目：');
    expect(technicalFrame).toContain('另有 9 个 Skill 的范围变体已折叠');
    expect(technicalFrame).toContain('› 查看依赖关系');
    expect(technicalFrame).toContain('↑↓ 移动');
    expect(technicalFrame.match(/›/gu)).toHaveLength(1);
    expect(technicalFrame.split('\n').length).toBeLessThanOrEqual(size.rows);
  });

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
      expect(instance.lastFrame()).toMatch(/author-skill\s+未完成 · 缺少目标/u);
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
});
